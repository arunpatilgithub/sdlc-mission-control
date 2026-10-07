import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { RepositoryConfig, VersionBumpPolicy } from "../config/team-config.js";
import type { MissionPacket } from "../agent/mission-packet.js";
import type { CrossRepositoryContract, ExecutionDossierEntry } from "../agent/planning-agent.js";
import type { PlanningDocumentation } from "../agent/documentation-fetch.js";
import { runDevelopMission, withVersionBumpBoundary, type DevelopActivity, type DevelopRun, type VerificationCommand } from "../agent/develop-agent.js";
import { runCritic } from "../agent/critic.js";
import { runReadOnlyAgent, type Provider } from "../agent/llm-provider.js";
import type { RunUsage } from "../agent/usage.js";
import { loadSkill } from "../agent/skills.js";
import { applyDeterministicPlanPatch, classifyDeveloperPlanAnswer, developerAnswerToObjection, type DeveloperPlanAnswer } from "../agent/plan-revision.js";
import { type CriticVerdict, type DevelopArtifact, type Objection, type PlanArtifact } from "./artifacts.js";
import { writeArtifact } from "./blackboard.js";
import { runGates, type GateReport } from "./gates.js";
import { MissionLedger, type LedgerLimits, type LedgerSummary } from "./ledger.js";
import {
  nextAction,
  type MissionState,
  type OrchestratorConfig,
  type StageName,
} from "./orchestrator.js";
import { criticDiffView, criticPlanView } from "./views.js";

const MAX_ITERATIONS = 20;

export interface MissionRunInput {
  missionId: string;
  /** Carries the story and repository context. PlanJob already holds one. */
  packet: MissionPacket;
  /** The approved plan text. */
  plan: string;
  /** Needed for localPath and integrationBranch, which MissionPacket does not carry. */
  repository: RepositoryConfig;
  /** Exact integration-branch commit captured by the approved planning packet. */
  plannedBaselineCommit?: string;
  /** Repo-relative paths and directory prefixes the approved plan named. Passed to the scope gate. */
  plannedPaths: string[];
  /** Team policy: if the repository contains `versionBump.file`, its `field` must be incremented alongside other code changes. */
  versionBumpPolicy?: VersionBumpPolicy;
  referenceFiles: string[];
  /** Planner-cited source locations rendered by Develop from its own baseline. */
  executionDossier?: ExecutionDossierEntry[];
  /** Validated source-to-consumer contracts resolved into Develop context after the source worktree exists. */
  crossRepositoryContracts?: CrossRepositoryContract[];
  /** Pre-rendered ground truth read from another in-scope repository's real artifact. See DevelopInput. */
  crossRepositoryContractContext?: string;
  /** Developer-attached external API/reference documentation carried from the plan packet to the Develop patch author. */
  documentation?: PlanningDocumentation[];
  verifyCommands: string[];
  verificationCommands?: VerificationCommand[];
  linkFromBase?: string[];
  branchName?: string;
  /** Developer-initiated discard: force-remove a disposable worktree (committed or uncommitted) before recreating it. */
  discardStaleWorktree?: boolean;
  initialDevelop?: DevelopRun;
  scopeDecision?: { rejectedPaths: string[] };
  initialPlanVerdict?: CriticVerdict;
  developerPlanAnswers?: DeveloperPlanAnswer[];
  initialDeveloperPlanRevisionCount?: number;
  openQuestions?: string[];
  planProvider?: Provider;
  limits: LedgerLimits;
  config: OrchestratorConfig;
  /** Called as each stage begins, so a poller can render live progress. */
  onStage?: (stage: StageName) => void;
  onDevelopActivity?: (activity: DevelopActivity) => void;
}

export interface MissionRunResult {
  missionId: string;
  storyId: number;
  outcome: "done" | "escalated" | "awaiting-scope-decision" | "awaiting-plan-approval";
  /** Null when done. Set to the terminating reason when escalated. */
  reason: string | null;
  /** Stages executed, in order. The audit trail of what the loop actually did. */
  stagesRun: StageName[];
  develop: DevelopRun | null;
  gateReport: GateReport | null;
  verdict: CriticVerdict | null;
  plan: string;
  developerPlanRevisionCount: number;
  ledger: LedgerSummary;
}

export async function runMission(input: MissionRunInput): Promise<MissionRunResult> {
  const ledger = new MissionLedger(input.limits);
  // Single source of truth for the write boundary: when a version-bump policy applies and the repo
  // has the version file, it is authorized here so the Develop author boundary AND the scope gate
  // agree — otherwise the version-bump gate would demand an edit the scope gate rejects.
  const effectivePlannedPaths = withVersionBumpBoundary(input.plannedPaths, input.repository.localPath, input.versionBumpPolicy);
  const state: MissionState = {
    missionId: input.missionId,
    storyId: input.packet.story.id,
    stage: input.initialPlanVerdict ? "plan-critic" : input.developerPlanAnswers?.length ? "plan" : input.initialDevelop ? "develop" : "approval",
    approved: true,
    verdict: input.initialPlanVerdict ?? null,
    gateReport: null,
    escalationReason: null,
  };
  const stagesRun: StageName[] = [];
  let develop: DevelopRun | null = input.initialDevelop ?? null;
  let gateReport: GateReport | null = null;
  let verdict: CriticVerdict | null = null;
  let developModel = input.config.fallbackModel;
  let currentFeedback: string | null = null;
  let pendingScopeDecision = input.scopeDecision;
  let currentPlan = input.plan;
  let developerPlanRevisionCount = input.initialDeveloperPlanRevisionCount ?? 0;
  let planFeedback: string | null = null;
  let initialPlanArtifactWritten = false;

  const finish = (outcome: MissionRunResult["outcome"], reason: string | null): MissionRunResult => ({
    missionId: input.missionId,
    storyId: input.packet.story.id,
    outcome,
    reason,
    stagesRun,
    develop,
    gateReport,
    verdict,
    plan: currentPlan,
    developerPlanRevisionCount,
    ledger: ledger.summary(),
  });

  try {
    if (input.initialPlanVerdict || input.developerPlanAnswers?.length) {
      writePlanArtifact(input, currentPlan, input.openQuestions ?? [], null);
      initialPlanArtifactWritten = true;
    }
    if (input.developerPlanAnswers?.length) {
      if (!ledger.canDeveloperRevisePlan()) {
        return finish("escalated", "Developer plan revision limit reached independently of critic revisions");
      }
      ledger.noteDeveloperPlanRevision();
      developerPlanRevisionCount += 1;
      const classified = input.developerPlanAnswers.map((answer) => ({ answer, classification: classifyDeveloperPlanAnswer(answer) }));
      for (const entry of classified) {
        writeArtifact(input.missionId, "plan-revision-audit", {
          source: "developer",
          path: entry.classification.path,
          objection: developerAnswerToObjection(entry.answer),
          createdAt: new Date().toISOString(),
        });
      }
      if (classified.every((entry) => entry.classification.path === "deterministic-patch")) {
        currentPlan = classified.reduce((plan, entry) => applyDeterministicPlanPatch(plan, entry.answer, entry.classification), currentPlan);
        writePlanArtifact(input, currentPlan, [], null);
        return finish("awaiting-plan-approval", "The deterministically revised plan requires developer approval");
      }
      planFeedback = revisionFeedback(input.developerPlanAnswers.map(developerAnswerToObjection), null);
    }
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      const action = nextAction(state, ledger, input.config);
      if (action.type === "done") return finish("done", null);
      if (action.type === "escalate") return finish("escalated", action.reason);
      if (action.type === "await-approval") {
        return finish("awaiting-plan-approval", "The critiqued plan requires developer re-approval");
      }

      if (action.type === "run-gates") {
        if (develop === null) return finish("escalated", "Cannot run gates before the develop stage");
        stageStarted(input, stagesRun, "gates");
        gateReport = runGates({
          worktreePath: develop.worktreePath,
          filesChanged: develop.filesChanged,
          plannedPaths: effectivePlannedPaths,
          baseline: develop.baseline,
          verification: develop.verification,
          storyId: input.packet.story.id,
          baselineCommit: develop.baselineCommit,
          versionBumpPolicy: input.versionBumpPolicy,
        });
        state.gateReport = gateReport;
        writeDevelopArtifact(input, develop, gateReport, developModel);
        const scopeGate = gateReport.results.find((result) => result.id === "scope");
        if (scopeGate?.status === "failed") {
          return finish("awaiting-scope-decision", `${scopeGate.offenders.length} changed path(s) require developer scope review`);
        }
        continue;
      }

      if (action.type === "revise") {
        if (action.stage === "plan") {
          if (!initialPlanArtifactWritten) {
            writePlanArtifact(input, currentPlan, input.openQuestions ?? [], null);
            initialPlanArtifactWritten = true;
          }
          ledger.noteRevision("plan");
          planFeedback = revisionFeedback(action.objections, null);
          writeArtifact(input.missionId, "plan-revision-audit", {
            source: "critic",
            path: "scoped-rerun",
            objections: action.objections,
            createdAt: new Date().toISOString(),
          });
          transition(state, "plan");
          continue;
        }
        if (action.stage !== "develop") {
          return finish("escalated", `Unexpected revision stage '${action.stage}'`);
        }
        const feedback = revisionFeedback(action.objections, state.gateReport);
        ledger.noteRevision("develop");
        currentFeedback = feedback;
        transition(state, "develop");
        continue;
      }

      if (action.stage === "plan") {
        stageStarted(input, stagesRun, "plan");
        const audit = planRevisionAuditPaths(input.missionId, ledger.revisionCount("plan") + developerPlanRevisionCount);
        const revised = await runReadOnlyAgent({
          provider: input.planProvider ?? "codex",
          prompt: planRevisionPrompt(input, currentPlan, planFeedback),
          workingDir: input.packet.repository.worktreePath,
          timeoutMs: 300_000,
          eventsPath: audit.eventsPath,
          stderrPath: audit.stderrPath,
          resultPath: audit.resultPath,
          extraReadTools: input.packet.planningSkillTools,
          model: action.model || undefined,
        });
        ledger.record("plan", revised.usage);
        currentPlan = revised.output;
        writePlanArtifact(input, currentPlan, [], revised.usage);
        transition(state, "plan-critic");
        continue;
      }

      if (action.stage === "plan-critic") {
        stageStarted(input, stagesRun, "plan-critic");
        const view = criticPlanView(input.packet, currentPlan);
        verdict = await runCritic({
          stage: "plan",
          missionId: input.missionId,
          storyId: input.packet.story.id,
          subject: JSON.stringify(view),
          citableFiles: view.citableFiles,
          worktreePath: input.packet.repository.worktreePath,
          model: action.model || undefined,
        });
        ledger.record("plan-critic", verdict.usage);
        writeArtifact(input.missionId, "critic-plan", verdict);
        transition(state, "plan-critic");
        state.verdict = verdict;
        continue;
      }

      if (action.stage === "develop") {
        stageStarted(input, stagesRun, "develop");
        developModel = action.model;
        const priorDevelop = develop;
        develop = await runDevelopMission({
          storyId: input.packet.story.id,
          storyTitle: input.packet.story.title,
          storyDescription: input.packet.story.description,
          acceptanceCriteria: input.packet.story.acceptanceCriteria,
          repository: input.repository,
          plannedBaselineCommit: input.packet.repository.baselineCommit,
          plan: developPlan(currentPlan, currentFeedback),
          plannedPaths: effectivePlannedPaths,
          referenceFiles: input.referenceFiles,
          executionDossier: input.executionDossier,
          crossRepositoryContractContext: input.crossRepositoryContractContext,
          documentation: input.documentation,
          verifyCommands: input.verifyCommands,
          verificationCommands: input.verificationCommands,
          linkFromBase: input.linkFromBase,
          developSkill: loadSkill("develop", input.repository.id).instructions,
          versionBumpPolicy: input.versionBumpPolicy,
          branchName: input.branchName,
          discardStaleWorktree: input.discardStaleWorktree,
          workspace: priorDevelop ? {
            worktreePath: priorDevelop.worktreePath,
            branch: priorDevelop.branch,
            baselineCommit: priorDevelop.baselineCommit,
            baseline: priorDevelop.baseline,
          } : undefined,
          scopeDecision: pendingScopeDecision,
          model: action.model || undefined,
          onActivity: input.onDevelopActivity,
        });
        pendingScopeDecision = undefined;
        ledger.record("develop", develop.usage);
        if (develop.status === "failed") {
          return finish("escalated", develop.error ?? "Develop stage failed");
        }
        transition(state, "gates");
        continue;
      }

      if (action.stage === "develop-critic") {
        if (develop === null) return finish("escalated", "Cannot run the develop critic before the develop stage");
        stageStarted(input, stagesRun, "develop-critic");
        const view = criticDiffView(input.packet, currentPlan, develop);
        const nextVerdict = await runCritic({
          stage: "diff",
          missionId: input.missionId,
          storyId: input.packet.story.id,
          subject: JSON.stringify(view),
          citableFiles: view.citableFiles,
          worktreePath: develop.worktreePath,
          model: action.model || undefined,
        });
        ledger.record("develop-critic", nextVerdict.usage);
        verdict = nextVerdict;
        writeArtifact(input.missionId, `critic-${safeArtifactName(input.repository.id)}`, nextVerdict);
        transition(state, "develop-critic");
        state.verdict = nextVerdict;
        continue;
      }

      return finish("escalated", `Unexpected run stage '${action.stage}'`);
    }

    return finish("escalated", `Mission iteration limit of ${MAX_ITERATIONS} reached`);
  } catch (error) {
    if (develop === null) throw error;
    const stage = stagesRun.at(-1) ?? state.stage;
    const message = error instanceof Error ? error.message : String(error);
    return finish("escalated", `Stage '${stage}' failed: ${message}`);
  }
}

function stageStarted(input: MissionRunInput, stagesRun: StageName[], stage: StageName): void {
  stagesRun.push(stage);
  try {
    input.onStage?.(stage);
  } catch (error) {
    console.log(`[mission ${input.missionId}] stage callback failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function transition(state: MissionState, stage: StageName): void {
  state.stage = stage;
  state.gateReport = null;
  state.verdict = null;
}

function developPlan(approvedPlan: string, feedback: string | null): string {
  return feedback === null
    ? approvedPlan
    : `${approvedPlan}\n\n## Mission revision feedback\n${feedback}`;
}

function revisionFeedback(objections: Objection[], report: GateReport | null): string {
  if (objections.length > 0) {
    return objections.map((objection) => [
      `- [${objection.severity}] ${objection.claim}`,
      `  Evidence: ${objection.evidence.join(", ")}`,
    ].join("\n")).join("\n");
  }
  const failures = report?.results.filter((result) => result.status === "failed") ?? [];
  if (failures.length === 0) return "- Deterministic gates failed without diagnostic details.";
  return failures.map((failure) => [
    `- ${failure.detail}`,
    `  Offenders: ${failure.offenders.length > 0 ? failure.offenders.join(", ") : "(none listed)"}`,
  ].join("\n")).join("\n");
}

function planRevisionPrompt(input: MissionRunInput, currentPlan: string, feedback: string | null): string {
  return `You are revising an implementation plan in read-only mode. Do not modify files. Inspect current files needed to resolve the objections, then return a complete replacement plan with repository-relative paths, validation, risks, and remaining open questions.

Story: ${input.packet.story.id} — ${input.packet.story.title}
Acceptance criteria: ${input.packet.story.acceptanceCriteria}

## Current plan
${currentPlan}

## Revision feedback
${feedback ?? "No diagnostic details were supplied."}

Repository planning guidance:
${input.packet.planningSkill}`;
}

function writePlanArtifact(
  input: MissionRunInput,
  planMarkdown: string,
  openQuestions: string[],
  usage: RunUsage | null,
): string {
  const artifact: PlanArtifact = {
    schemaVersion: 1,
    missionId: input.missionId,
    storyId: input.packet.story.id,
    stage: "plan",
    createdAt: new Date().toISOString(),
    producedBy: usage?.provider ?? input.planProvider ?? "developer",
    planMarkdown,
    repositories: [input.repository.id],
    plannedPaths: input.plannedPaths,
    referenceFiles: input.referenceFiles,
    openQuestions,
    usage,
  };
  return writeArtifact(input.missionId, "plan", artifact);
}

function planRevisionAuditPaths(missionId: string, revision: number): {
  eventsPath: string;
  stderrPath: string;
  resultPath: string;
} {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  const root = configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
  const directory = resolve(root, "planning-runs");
  mkdirSync(directory, { recursive: true });
  return {
    eventsPath: resolve(directory, `${missionId}.runner-plan-v${revision}.events.jsonl`),
    stderrPath: resolve(directory, `${missionId}.runner-plan-v${revision}.stderr.log`),
    resultPath: resolve(directory, `${missionId}.runner-plan-v${revision}.md`),
  };
}

function writeDevelopArtifact(
  input: MissionRunInput,
  develop: DevelopRun,
  gateReport: GateReport,
  model: string,
): void {
  const artifact: DevelopArtifact = {
    schemaVersion: 1,
    missionId: input.missionId,
    storyId: input.packet.story.id,
    stage: "develop",
    createdAt: develop.completedAt ?? new Date().toISOString(),
    producedBy: model || develop.usage?.provider || "codex",
    repositoryId: input.repository.id,
    worktreePath: develop.worktreePath,
    branch: develop.branch,
    commit: develop.commit,
    filesChanged: develop.filesChanged,
    diffStat: develop.diffStat,
    baseline: develop.baseline,
    verification: develop.verification,
    regressions: develop.regressions,
    gateReport,
    usage: develop.usage,
  };
  writeArtifact(input.missionId, `develop-${safeArtifactName(input.repository.id)}`, artifact);
}

function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
