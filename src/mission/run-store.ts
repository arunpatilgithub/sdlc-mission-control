import { randomUUID } from "node:crypto";
import type { LedgerLimits } from "./ledger.js";
import type { OrchestratorConfig, StageName } from "./orchestrator.js";
import { runMission, type MissionRunInput, type MissionRunResult } from "./runner.js";
import type { MergeResult, PublishResult } from "../agent/mission-publish.js";
import { plannedBaselineError, type DevelopActivity } from "../agent/develop-agent.js";
import { runScopeReview, type ScopeReview, type ScopeReviewInput } from "../agent/scope-review.js";
import { runAggregateReview, type AggregateReview, type AggregateReviewInput } from "../agent/aggregate-review.js";
import { buildCrossRepositoryContractContext } from "../agent/mirror-artifact-context.js";
import { readArtifact, writeArtifact } from "./blackboard.js";

export const DEFAULT_LEDGER_LIMITS: LedgerLimits = {
  perStageTokens: {
    develop: 100_000,
    "develop-critic": 100_000,
  },
  // Raised twice now: 1,000,000, then 3,000,000, both still too tight. perStageTokens is only
  // a "minimum remaining budget to attempt this stage" pre-check (see MissionLedger.canAfford)
  // — it does not cap what a single develop turn can actually spend. Observed on this mission:
  // one repository's develop turn alone used 1.47M input tokens (publisher.documentation,
  // touching 5 files with real content), another used 648K (PostbackHandler, which also wrote
  // and ran a real test file) — before any develop-critic or plan-revision cost is counted.
  // A 4-repository mission can plausibly need several times that. Sized generously so a full
  // mission doesn't escalate mid-run with no resume path; still a real ceiling, not unlimited.
  missionCeilingTokens: 15_000_000,
  maxRevisions: 2,
  maxDeveloperPlanRevisions: 5,
};

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  modelTiers: {},
  // An empty selection preserves each provider's locally configured default without inventing a model identifier.
  fallbackModel: "",
};

export interface MissionRunJob {
  id: string;
  /** The planning job this develop run belongs to. */
  planJobId: string;
  storyId: number;
  repositoryId: string;
  repositoryIds: string[];
  executionOrder: string[];
  currentRepositoryId: string;
  runsByRepository: Record<string, RepositoryRunState>;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
  /** Stages that have begun, in order. Grows while the run is in flight. */
  stagesRun: StageName[];
  /** Null until the run finishes. */
  result: MissionRunResult | null;
  publication: PublishResult | null;
  scopeReviewStatus: "idle" | "running" | "completed" | "failed";
  scopeReview: ScopeReview | null;
  scopeReviewError: string | null;
  scopeDecisions: Record<string, "approve" | "reject"> | null;
  error: string | null;
  activity?: DevelopActivity | null;
  aggregateReviewStatus: "pending" | "running" | "completed" | "failed" | "skipped";
  aggregateReview: AggregateReview | null;
  aggregateReviewError: string | null;
  aggregateTokens: number;
  aggregateTokenCeiling: number;
  /** A developer's explicit, justified decision to publish despite an "escalate" (or unresolved "revise") aggregate-review verdict. The reviewer's own objections are never discarded — they're carried into the published PR description so nothing raised is silently lost, even when a human decides it isn't blocking. */
  aggregateReviewOverride: { justification: string; confirmedAt: string } | null;
}

export interface RepositoryRunState {
  repositoryId: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  stagesRun: StageName[];
  result: MissionRunResult | null;
  publication: PublishResult | null;
  scopeReviewStatus: "idle" | "running" | "completed" | "failed";
  scopeReview: ScopeReview | null;
  scopeReviewError: string | null;
  scopeDecisions: Record<string, "approve" | "reject"> | null;
  error: string | null;
  activity?: DevelopActivity | null;
  activityLog: DevelopActivity[];
  workspaceBranch: string | null;
}

export function isMissionPublishReady(job: MissionRunJob): boolean {
  return job.repositoryIds.every((repositoryId) => {
    const result = job.runsByRepository[repositoryId]?.result;
    return result?.outcome === "done"
      && result.gateReport?.passed === true;
  }) && (job.aggregateReviewStatus === "skipped" || job.aggregateReview?.disposition === "accept" || Boolean(job.aggregateReviewOverride));
}

export function hasAcceptedPublishReview(job: MissionRunJob, repositoryId: string): boolean {
  const result = job.runsByRepository[repositoryId]?.result;
  if (result?.verdict?.disposition === "accept") return true;
  return job.aggregateReviewStatus === "completed"
    && (job.aggregateReview?.disposition === "accept" || Boolean(job.aggregateReviewOverride));
}

export class MissionRunStore {
  private readonly jobs = new Map<string, MissionRunJob>();
  private readonly inputs = new Map<string, Record<string, MissionRunInput>>();
  private readonly aggregateInputs = new Map<string, Omit<AggregateReviewInput, "resultsByRepository">>();

  start(input: MissionRunInput, meta: { planJobId: string; repositoryId: string }): MissionRunJob {
    return this.startMulti([{ repositoryId: meta.repositoryId, input }], meta.planJobId);
  }

  startMulti(
    entries: Array<{ repositoryId: string; input: MissionRunInput }>,
    planJobId: string,
    aggregateInput?: Omit<AggregateReviewInput, "resultsByRepository">,
  ): MissionRunJob {
    if (entries.length === 0) throw new Error("At least one repository run is required");
    const repositoryIds = entries.map((entry) => entry.repositoryId);
    if (new Set(repositoryIds).size !== repositoryIds.length) throw new Error("Repository run selection contains duplicates");
    const stalePlanErrors = entries.flatMap(({ input }) => {
      if (!input.plannedBaselineCommit) return [];
      const error = plannedBaselineError(input.repository, input.plannedBaselineCommit);
      return error ? [error] : [];
    });
    if (stalePlanErrors.length > 0) throw new Error(`Plan contract needs regeneration. ${stalePlanErrors.join(" ")}`);
    const first = entries[0]!;
    // A single-repository mission has no cross-repository aggregate review (skipped below), so its
    // Publish gate must be satisfied by a per-repository diff verdict. Turn on the diff critic for it;
    // multi-repository missions keep requireDiffCritic off and rely on the aggregate review.
    const requireDiffCritic = entries.length === 1;
    const runsByRepository = Object.fromEntries(entries.map(({ repositoryId }) => [repositoryId, pendingRepositoryRun(repositoryId)]));
    const job: MissionRunJob = {
      id: randomUUID(),
      planJobId,
      storyId: first.input.packet.story.id,
      repositoryId: first.repositoryId,
      repositoryIds,
      executionOrder: repositoryIds,
      currentRepositoryId: first.repositoryId,
      runsByRepository,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      stagesRun: [],
      result: null,
      publication: null,
      scopeReviewStatus: "idle",
      scopeReview: null,
      scopeReviewError: null,
      scopeDecisions: null,
      error: null,
      activity: null,
      aggregateReviewStatus: entries.length === 1 ? "skipped" : "pending",
      aggregateReview: null,
      aggregateReviewError: null,
      aggregateTokens: 0,
      aggregateTokenCeiling: first.input.limits.missionCeilingTokens,
      aggregateReviewOverride: null,
    };
    this.jobs.set(job.id, job);
    this.inputs.set(job.id, Object.fromEntries(entries.map((entry) => [entry.repositoryId, { ...entry.input, config: { ...entry.input.config, requireDiffCritic } }])));
    if (aggregateInput) this.aggregateInputs.set(job.id, aggregateInput);
    persistRunInputs(job.id, this.inputs.get(job.id)!, aggregateInput);
    persistRunJob(job);
    this.launchRepository(job, first.repositoryId);
    return job;
  }

  startScopeReview(id: string, input: ScopeReviewInput): MissionRunJob | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    const run = job.runsByRepository[job.currentRepositoryId];
    if (!run) return undefined;
    job.scopeReviewStatus = "running";
    run.scopeReviewStatus = "running";
    job.scopeReview = null;
    job.scopeReviewError = null;
    persistRunJob(job);
    void runScopeReview(input).then((review) => {
      job.scopeReview = review;
      job.scopeReviewStatus = "completed";
      run.scopeReview = review;
      run.scopeReviewStatus = "completed";
      persistRunJob(job);
    }).catch((error: unknown) => {
      job.scopeReviewStatus = "failed";
      job.scopeReviewError = error instanceof Error ? error.message : String(error);
      run.scopeReviewStatus = "failed";
      run.scopeReviewError = job.scopeReviewError;
      persistRunJob(job);
    });
    return job;
  }

  resumeAfterScopeDecision(id: string, plannedPaths: string[], decisions: Record<string, "approve" | "reject">): MissionRunJob | undefined {
    const job = this.get(id);
    const original = this.inputs.get(id)?.[job?.currentRepositoryId ?? ""];
    const initialDevelop = job?.result?.develop;
    if (!job || !original || !initialDevelop) return undefined;
    job.status = "running";
    job.completedAt = null;
    job.stagesRun = [];
    job.result = null;
    job.error = null;
    job.scopeDecisions = decisions;
    const run = job.runsByRepository[job.currentRepositoryId];
    if (run) {
      run.status = "running";
      run.completedAt = null;
      run.stagesRun = [];
      run.result = null;
      run.error = null;
      run.scopeDecisions = decisions;
    }
    const resumedInput = {
      ...original,
      plannedPaths,
      initialDevelop,
      scopeDecision: { rejectedPaths: Object.entries(decisions).filter(([, decision]) => decision === "reject").map(([path]) => path) },
    };
    this.inputs.get(id)![job.currentRepositoryId] = resumedInput;
    persistRunInputs(id, this.inputs.get(id)!, this.aggregateInputs.get(id));
    this.launchRepository(job, job.currentRepositoryId);
    return job;
  }

  private launchRepository(job: MissionRunJob, repositoryId: string): void {
    const input = this.inputs.get(job.id)?.[repositoryId];
    const run = job.runsByRepository[repositoryId];
    if (!input || !run) throw new Error(`Repository run input is unavailable for ${repositoryId}`);
    job.currentRepositoryId = repositoryId;
    job.repositoryId = repositoryId;
    job.status = "running";
    run.status = "running";
    run.activity = null;
    run.startedAt ??= new Date().toISOString();
    syncCurrentRun(job, run);
    persistRunJob(job);
    // Resolved fresh at dispatch time, not at plan time: a dependency's worktree only exists
    // once ITS Develop stage has actually completed, which for later repositories in
    // executionOrder is true by now but was not true when this mission started.
    const worktreePathByRepository = Object.fromEntries(
      Object.entries(job.runsByRepository)
        .filter(([, entry]) => entry.result?.develop?.worktreePath)
        .map(([id, entry]) => [id, entry.result!.develop!.worktreePath]),
    );
    const crossRepositoryContractContext = buildCrossRepositoryContractContext(input.crossRepositoryContracts ?? [], worktreePathByRepository);
    void runMission({
      ...input,
      crossRepositoryContractContext,
      onStage: (stage) => {
        run.stagesRun.push(stage);
        job.stagesRun = run.stagesRun;
        recordStageActivity(run, stage);
        persistRunJob(job);
        input.onStage?.(stage);
      },
      onDevelopActivity: (activity) => {
        recordActivity(run, activity);
        if (activity.phase === "preparing-worktree" && activity.branch) run.workspaceBranch = activity.branch;
        persistRunJob(job);
      },
    }).then((result) => {
      run.result = result;
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      completeActiveActivity(run);
      job.result = result;
      job.aggregateTokens = Object.values(job.runsByRepository)
        .reduce((total, entry) => total + (entry.result?.ledger.totalTokens ?? 0), 0);
      syncCurrentRun(job, run);
      persistRunJob(job);
      if (job.aggregateTokens > job.aggregateTokenCeiling) {
        job.status = "failed";
        job.error = `Multi-repository mission exceeded its ${job.aggregateTokenCeiling.toLocaleString()}-token ceiling`;
        job.completedAt = new Date().toISOString();
        persistRunJob(job);
        return;
      }
      const next = result.outcome === "done"
        ? job.executionOrder.slice(job.executionOrder.indexOf(repositoryId) + 1)
          .find((id) => job.runsByRepository[id]?.status === "pending")
        : undefined;
      if (next) {
        this.launchRepository(job, next);
      } else if (result.outcome === "done" && job.repositoryIds.length > 1) {
        this.launchAggregateReview(job);
      } else {
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        persistRunJob(job);
      }
    }).catch((error: unknown) => {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.completedAt = new Date().toISOString();
      completeActiveActivity(run);
      syncCurrentRun(job, run);
      job.status = "failed";
      job.error = run.error;
      job.completedAt = new Date().toISOString();
      persistRunJob(job);
    });
  }

  get(id: string): MissionRunJob | undefined {
    const existing = this.jobs.get(id);
    if (existing) return existing;
    const recovered = readArtifact<MissionRunJob>(id, "run-state");
    if (!recovered) return undefined;
    for (const run of Object.values(recovered.runsByRepository)) run.activityLog ??= legacyActivityLog(run.activity);
    this.jobs.set(id, recovered);
    const recoveredInputs = readArtifact<Record<string, MissionRunInput>>(id, "run-inputs");
    if (recoveredInputs) this.inputs.set(id, recoveredInputs);
    const aggregateInput = readArtifact<Omit<AggregateReviewInput, "resultsByRepository">>(id, "aggregate-review-input");
    if (aggregateInput) this.aggregateInputs.set(id, aggregateInput);
    if (recovered.status === "running") {
      if (recovered.aggregateReviewStatus === "running" && aggregateInput) {
        this.launchAggregateReview(recovered);
      } else {
        recovered.status = "failed";
        recovered.error = "Develop execution was interrupted by a server restart; the preserved worktrees require developer review before retry";
        recovered.completedAt = new Date().toISOString();
        persistRunJob(recovered);
      }
    }
    return recovered;
  }

  retryAfterAggregateReview(id: string, repositoryIds: string[]): MissionRunJob | undefined {
    const job = this.get(id);
    const aggregateInput = this.aggregateInputs.get(id);
    if (!job || !aggregateInput || job.aggregateReview?.disposition !== "revise") return undefined;
    if (repositoryIds.length === 0 || repositoryIds.some((repositoryId) => !job.repositoryIds.includes(repositoryId))) {
      throw new Error("Retry selection must contain only repositories in this mission");
    }
    if (job.aggregateReview.affectedRepositories.some((repositoryId) => !repositoryIds.includes(repositoryId))) {
      throw new Error("Retry selection must include every repository identified by aggregate review");
    }
    const retry = downstreamClosure(repositoryIds, aggregateInput.dependenciesByRepository);
    const feedback = job.aggregateReview.objections.map((objection) => `- ${objection.claim} (${objection.evidence.join(", ")})`).join("\n");
    for (const repositoryId of job.executionOrder) {
      if (!retry.has(repositoryId)) continue;
      const run = job.runsByRepository[repositoryId];
      const input = this.inputs.get(id)?.[repositoryId];
      if (!run?.result?.develop || !input) throw new Error(`Cannot retry ${repositoryId} without an accepted Develop result`);
      this.inputs.get(id)![repositoryId] = {
        ...input,
        plan: `${input.plan}\n\n## Aggregate review feedback\n${feedback}`,
        initialDevelop: run.result.develop,
        scopeDecision: undefined,
      };
      job.runsByRepository[repositoryId] = pendingRepositoryRun(repositoryId);
    }
    job.aggregateReviewStatus = "pending";
    job.aggregateReview = null;
    job.aggregateReviewError = null;
    job.completedAt = null;
    const first = job.executionOrder.find((repositoryId) => retry.has(repositoryId));
    if (!first) throw new Error("Select at least one repository to retry");
    this.launchRepository(job, first);
    persistRunInputs(id, this.inputs.get(id)!, aggregateInput);
    persistRunJob(job);
    return job;
  }

  latestForPlan(planJobId: string): MissionRunJob | undefined {
    return [...this.jobs.values()].filter((job) => job.planJobId === planJobId).at(-1);
  }

  /**
   * Records a developer's explicit decision to publish despite the aggregate review not
   * having accepted — used when a review escalates (no automated retry path exists for that
   * disposition) or when a developer judges a "revise" verdict's objections don't actually
   * block publishing. Requires a real justification; never silently reinterpreted as if the
   * reviewer itself had accepted.
   */
  recordAggregateReviewOverride(id: string, justification: unknown): MissionRunJob {
    const job = this.get(id);
    if (!job) throw new Error("Mission run was not found");
    if (typeof justification !== "string" || justification.trim() === "") {
      throw new Error("A developer override requires a non-empty justification");
    }
    if (job.aggregateReview?.disposition === "accept" || job.aggregateReviewStatus === "skipped") {
      throw new Error("Aggregate review already accepted this mission; no override is needed");
    }
    job.aggregateReviewOverride = { justification: justification.trim(), confirmedAt: new Date().toISOString() };
    persistRunJob(job);
    return job;
  }

  recordPublication(id: string, publication: PublishResult, repositoryId?: string): MissionRunJob | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    const run = job.runsByRepository[repositoryId ?? publication.repositoryId];
    if (!run) return undefined;
    run.publication = publication;
    if (job.currentRepositoryId === run.repositoryId) job.publication = publication;
    persistRunJob(job);
    return job;
  }

  recordMerge(id: string, merge: MergeResult, repositoryId: string): MissionRunJob | undefined {
    const job = this.get(id);
    const publication = job?.runsByRepository[repositoryId]?.publication;
    if (!job || !publication) return undefined;
    publication.merge = merge;
    if (job.currentRepositoryId === repositoryId) job.publication = publication;
    persistRunJob(job);
    return job;
  }

  private launchAggregateReview(job: MissionRunJob): void {
    const input = this.aggregateInputs.get(job.id);
    if (!input) {
      job.aggregateReviewStatus = "failed";
      job.aggregateReviewError = "Aggregate review input is unavailable";
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      persistRunJob(job);
      return;
    }
    const resultsByRepository = Object.fromEntries(job.repositoryIds.flatMap((repositoryId) => {
      const result = job.runsByRepository[repositoryId]?.result;
      return result ? [[repositoryId, result]] : [];
    }));
    job.aggregateReviewStatus = "running";
    job.status = "running";
    persistRunJob(job);
    void runAggregateReview({ ...input, resultsByRepository }).then((review) => {
      job.aggregateReview = review;
      job.aggregateReviewStatus = "completed";
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      persistRunJob(job);
    }).catch((error: unknown) => {
      job.aggregateReviewStatus = "failed";
      job.aggregateReviewError = error instanceof Error ? error.message : String(error);
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      persistRunJob(job);
    });
  }
}

function pendingRepositoryRun(repositoryId: string): RepositoryRunState {
  return {
    repositoryId,
    status: "pending",
    startedAt: null,
    completedAt: null,
    stagesRun: [],
    result: null,
    publication: null,
    scopeReviewStatus: "idle",
    scopeReview: null,
    scopeReviewError: null,
    scopeDecisions: null,
    error: null,
    activity: null,
    activityLog: [],
    workspaceBranch: null,
  };
}

function recordActivity(run: RepositoryRunState, activity: DevelopActivity): void {
  run.activityLog ??= [];
  const index = run.activityLog.findIndex((entry) => entry.id === activity.id);
  if (index >= 0) run.activityLog[index] = activity;
  else run.activityLog.push(activity);
  run.activity = activity.status === "running" ? activity : run.activity?.id === activity.id ? null : run.activity;
}

function legacyActivityLog(activity: RepositoryRunState["activity"]): DevelopActivity[] {
  if (!activity) return [];
  const legacy = activity as Partial<DevelopActivity>;
  const legacyPhase = (activity as { phase?: string }).phase;
  return [{
    id: legacy.id ?? "legacy-active-activity",
    phase: legacyPhase === "worktree-ready" ? "preparing-worktree" : legacyPhase === "baseline-verification" || legacyPhase === "implementation" || legacyPhase === "post-change-verification" || legacyPhase === "committing" ? legacyPhase : "preparing-worktree",
    status: legacy.status ?? "running",
    command: legacy.command ?? null,
    detail: legacy.detail ?? null,
    branch: legacy.branch ?? null,
    startedAt: legacy.startedAt ?? new Date().toISOString(),
    completedAt: legacy.completedAt ?? null,
    activePaths: legacy.activePaths ?? [],
    completedPaths: legacy.completedPaths ?? [],
  }];
}

function completeActiveActivity(run: RepositoryRunState): void {
  if (!run.activity || run.activity.status !== "running") return;
  recordActivity(run, { ...run.activity, status: "completed", completedAt: new Date().toISOString() });
}

function recordStageActivity(run: RepositoryRunState, stage: StageName): void {
  const phase = stage === "gates" ? "deterministic-gates" : stage === "develop-critic" ? "diff-critic" : null;
  if (!phase) return;
  completeActiveActivity(run);
  recordActivity(run, {
    id: `${phase}-${run.stagesRun.filter((entry) => entry === stage).length}`,
    phase,
    status: "running",
    command: null,
    detail: phase === "deterministic-gates" ? "Checking scope, regressions, and required validation" : "Reviewing the implementation diff",
    branch: run.workspaceBranch,
    startedAt: new Date().toISOString(),
    completedAt: null,
    activePaths: [],
    completedPaths: [],
  });
}

function syncCurrentRun(job: MissionRunJob, run: RepositoryRunState): void {
  job.repositoryId = run.repositoryId;
  job.stagesRun = run.stagesRun;
  job.result = run.result;
  job.publication = run.publication;
  job.scopeReviewStatus = run.scopeReviewStatus;
  job.scopeReview = run.scopeReview;
  job.scopeReviewError = run.scopeReviewError;
  job.scopeDecisions = run.scopeDecisions;
  job.error = run.error;
}

function downstreamClosure(repositoryIds: string[], dependencies: Record<string, string[]>): Set<string> {
  const selected = new Set(repositoryIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [repositoryId, dependsOn] of Object.entries(dependencies)) {
      if (!selected.has(repositoryId) && dependsOn.some((dependency) => selected.has(dependency))) {
        selected.add(repositoryId);
        changed = true;
      }
    }
  }
  return selected;
}

function persistRunJob(job: MissionRunJob): void {
  writeArtifact(job.id, "run-state", job);
}

function persistRunInputs(
  runId: string,
  inputs: Record<string, MissionRunInput>,
  aggregateInput?: Omit<AggregateReviewInput, "resultsByRepository">,
): void {
  writeArtifact(runId, "run-inputs", inputs);
  if (aggregateInput) writeArtifact(runId, "aggregate-review-input", aggregateInput);
}
