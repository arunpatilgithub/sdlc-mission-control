import type { RunUsage } from "./types";

export type DevelopStageName = "develop" | "gates" | "develop-critic";

export interface StageDisplay {
  stage: DevelopStageName;
  attempt: number;
  status: "completed" | "active" | "pending";
}

export interface LedgerView {
  totalTokens: number;
  costUSD: number | null;
  unreportedStages: string[];
}

export interface CostDisplay {
  tokens: string;
  cost: string;
  incomplete: boolean;
}

export interface VerificationResultView {
  command: string;
  exitCode: number;
  passed: boolean;
  output: string;
}

export interface VerificationDisplay {
  command: string;
  baseline: VerificationResultView | null;
  verification: VerificationResultView | null;
  classification: "passed" | "pre-existing-failure" | "regression" | "failed" | "not-run";
}

export interface VerificationSummary {
  rows: VerificationDisplay[];
  notVerifiedReason: string | null;
}

export interface MissionRunResultView {
  outcome: "done" | "escalated" | "awaiting-scope-decision" | "awaiting-plan-approval";
  reason: string | null;
  stagesRun: DevelopStageName[];
  develop: {
    worktreePath: string;
    branch: string;
    commit: string | null;
    diffStat: string | null;
    filesChanged: string[];
    baseline: VerificationResultView[];
    verification: VerificationResultView[];
    regressions: string[];
    usage: RunUsage | null;
  } | null;
  gateReport: {
    passed: boolean;
    results: Array<{
      id: string;
      status: "passed" | "failed" | "not-verified";
      detail: string;
      offenders: string[];
    }>;
  } | null;
  verdict: {
    disposition: "accept" | "revise" | "replan" | "escalate";
    objections: Array<{ severity: "blocker" | "major" | "minor"; claim: string; evidence: string[] }>;
    usage: RunUsage | null;
  } | null;
  ledger: LedgerView;
}

export interface MissionRunJobView {
  id: string;
  status: "running" | "completed" | "failed";
  stagesRun: DevelopStageName[];
  result: MissionRunResultView | null;
  publication: PublishResultView | null;
  scopeReviewStatus: "idle" | "running" | "completed" | "failed";
  scopeReview: ScopeReviewView | null;
  scopeReviewError: string | null;
  scopeDecisions: Record<string, "approve" | "reject"> | null;
  error: string | null;
  repositoryId: string;
  repositoryIds: string[];
  executionOrder: string[];
  currentRepositoryId: string;
  runsByRepository: Record<string, RepositoryRunStateView>;
  aggregateReviewStatus: "pending" | "running" | "completed" | "failed" | "skipped";
  aggregateReview: AggregateReviewView | null;
  aggregateReviewError: string | null;
  aggregateTokens: number;
  aggregateTokenCeiling: number;
  aggregateReviewOverride: { justification: string; confirmedAt: string } | null;
  startedAt: string;
  completedAt: string | null;
}

export interface RepositoryRunStateView {
  repositoryId: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  stagesRun: DevelopStageName[];
  result: MissionRunResultView | null;
  publication: PublishResultView | null;
  scopeReviewStatus: "idle" | "running" | "completed" | "failed";
  scopeReview: ScopeReviewView | null;
  scopeReviewError: string | null;
  scopeDecisions: Record<string, "approve" | "reject"> | null;
  error: string | null;
  workspaceBranch: string | null;
  activity?: {
    id: string;
    phase: "preparing-worktree" | "baseline-verification" | "implementation" | "post-change-verification" | "committing" | "deterministic-gates" | "diff-critic";
    status: "running" | "completed";
    command: string | null;
    detail: string | null;
    branch: string | null;
    startedAt: string;
    completedAt: string | null;
    activePaths: string[];
    completedPaths: string[];
  } | null;
  activityLog: Array<{
    id: string;
    phase: "preparing-worktree" | "baseline-verification" | "implementation" | "post-change-verification" | "committing" | "deterministic-gates" | "diff-critic";
    status: "running" | "completed";
    command: string | null;
    detail: string | null;
    branch: string | null;
    startedAt: string;
    completedAt: string | null;
    activePaths: string[];
    completedPaths: string[];
  }>;
}

export interface AggregateReviewView {
  disposition: "accept" | "revise" | "escalate" | "not-detected";
  affectedRepositories: string[];
  objections: Array<{ claim: string; evidence: string[]; repositories: string[] }>;
  parseError: string | null;
  output: string;
  createdAt: string;
}

export interface ScopeReviewView {
  provider: "claude" | "codex";
  status: "completed";
  recommendations: Array<{
    path: string;
    classification: "required" | "unnecessary" | "uncertain";
    rationale: string;
    evidence: string[];
    approvalAllowed: boolean;
  }>;
  parseError: string | null;
  output: string;
  createdAt: string;
}

export interface PublishResultView {
  missionId: string;
  developRunId: string;
  storyId: number;
  repositoryId: string;
  scm: "azure-devops" | "gitlab";
  dryRun: boolean;
  sourceBranch: string;
  targetBranch: string;
  commit: string;
  push: "planned" | "pushed" | "already-present" | "failed";
  pullRequest: { id: number; title: string; url: string } | null;
  merge: { pullRequest: { id: number; title: string; url: string }; merged: boolean; error: string | null; completedAt: string } | null;
  published: boolean;
  error: string | null;
  completedAt: string;
}

const PIPELINE: DevelopStageName[] = ["develop", "gates", "develop-critic"];

export function buildStageDisplay(stagesRun: DevelopStageName[], running: boolean): StageDisplay[] {
  const attempts = new Map<DevelopStageName, number>();
  const display = stagesRun.map((stage, index): StageDisplay => {
    const attempt = (attempts.get(stage) ?? 0) + 1;
    attempts.set(stage, attempt);
    return {
      stage,
      attempt,
      status: running && index === stagesRun.length - 1 ? "active" : "completed",
    };
  });
  const last = stagesRun.at(-1);
  const pending = last === undefined
    ? PIPELINE
    : last === "develop"
      ? PIPELINE.slice(1)
      : last === "gates"
        ? PIPELINE.slice(2)
        : [];
  for (const stage of pending) {
    display.push({ stage, attempt: (attempts.get(stage) ?? 0) + 1, status: "pending" });
  }
  return display;
}

export function formatMissionCost(ledger: LedgerView): CostDisplay {
  const incompleteStages = [...new Set(ledger.unreportedStages)];
  const incomplete = ledger.costUSD === null || incompleteStages.length > 0;
  const knownCost = ledger.costUSD === null ? null : `$${ledger.costUSD.toFixed(4)}`;
  const cause = incompleteStages.length > 0
    ? `unreported stages: ${incompleteStages.join(", ")}`
    : "model cost was not reported";
  return {
    tokens: `${ledger.totalTokens.toLocaleString()} tokens`,
    cost: incomplete ? `Cost incomplete${knownCost ? ` (${knownCost} reported)` : ""} — ${cause}` : knownCost ?? "Cost incomplete",
    incomplete,
  };
}

export function classifyVerification(
  baseline: VerificationResultView[],
  verification: VerificationResultView[],
  regressions: string[],
): VerificationSummary {
  if (baseline.length === 0 && verification.length === 0) {
    return {
      rows: [],
      notVerifiedReason: "Regressions were not verified because no verification commands are configured for this repository.",
    };
  }
  const baselineByCommand = new Map(baseline.map((result) => [result.command, result]));
  const verificationByCommand = new Map(verification.map((result) => [result.command, result]));
  const commands = [...new Set([...baselineByCommand.keys(), ...verificationByCommand.keys()])];
  const regressionSet = new Set(regressions);
  const rows = commands.map((command) => {
    const before = baselineByCommand.get(command) ?? null;
    const after = verificationByCommand.get(command) ?? null;
    let classification: VerificationDisplay["classification"];
    if (before && !before.passed && after && !after.passed) classification = "pre-existing-failure";
    else if (after?.passed) classification = "passed";
    else if ((before?.passed && after && !after.passed) || regressionSet.has(command)) classification = "regression";
    else if (after && !after.passed) classification = "failed";
    else classification = "not-run";
    return { command, baseline: before, verification: after, classification };
  });
  return { rows, notVerifiedReason: null };
}
