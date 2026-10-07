import type { CriticVerdict, Objection } from "./artifacts.js";
import type { GateReport } from "./gates.js";
import { MissionLedger, resolveStageModel } from "./ledger.js";

export type StageName =
  | "plan" | "plan-critic" | "approval"
  | "develop" | "gates" | "develop-critic"
  | "done" | "escalated";

export interface MissionState {
  missionId: string;
  storyId: number;
  stage: StageName;
  /** Set once the developer has approved the plan. Only the developer sets this. */
  approved: boolean;
  /** Most recent verdict for the current stage, or null if the critic has not run. */
  verdict: CriticVerdict | null;
  /** Most recent gate report, or null if gates have not run. */
  gateReport: GateReport | null;
  /** Preserved reason for a terminal escalation, or null when none was recorded. */
  escalationReason: string | null;
}

export interface OrchestratorConfig {
  /** Stage name to model identifier. Passed to resolveStageModel. */
  modelTiers: Record<string, string>;
  fallbackModel: string;
  /**
   * When true, a passing Develop gate transitions to the diff critic (develop-critic) instead of
   * completing, so a per-repository verdict is produced. Set only for single-repository missions,
   * where there is no cross-repository aggregate review to gate Publish. Off by default: multi-repo
   * missions rely on the aggregate review and keep the gates -> done behavior unchanged.
   */
  requireDiffCritic?: boolean;
}

export type Action =
  | { type: "run"; stage: StageName; model: string }
  | { type: "run-gates" }
  | { type: "await-approval" }
  | { type: "revise"; stage: StageName; objections: Objection[] }
  | { type: "escalate"; reason: string }
  | { type: "done" };

export function nextAction(
  state: MissionState,
  ledger: MissionLedger,
  config: OrchestratorConfig,
): Action {
  if (state.stage === "done") return { type: "done" };
  if (state.stage === "escalated") {
    return { type: "escalate", reason: state.escalationReason ?? "Mission is escalated" };
  }

  if (state.stage === "approval") {
    return state.approved ? runStage("develop", ledger, config) : { type: "await-approval" };
  }

  const affordability = ledger.canAfford(state.stage);
  if (!affordability.affordable) return { type: "escalate", reason: affordability.reason };

  if (state.stage === "gates") {
    if (state.gateReport === null) return { type: "run-gates" };
    if (!state.gateReport.passed) {
      return { type: "escalate", reason: "Deterministic Develop gates failed; revise and re-approve the plan before another implementation attempt" };
    }
    // Single-repository missions have no aggregate review to gate Publish, so a passing gate hands
    // off to the diff critic to produce the verdict Publish requires. The critic's own accept/revise
    // verdict is then routed by criticAction below (accept -> done, revise -> developer decision).
    if (config.requireDiffCritic && state.verdict === null) {
      return runStage("develop-critic", ledger, config);
    }
    return { type: "done" };
  }

  if ((state.stage === "plan-critic" || state.stage === "develop-critic") && state.verdict !== null) {
    return criticAction(state.stage, state.verdict, ledger);
  }

  return runStage(state.stage, ledger, config);
}

function criticAction(
  stage: "plan-critic" | "develop-critic",
  verdict: CriticVerdict,
  ledger: MissionLedger,
): Action {
  switch (verdict.disposition) {
    case "accept": {
      // Approval granted before the critic's verdict existed is not consent to the
      // critiqued plan, so the developer must be presented with the gate again.
      if (stage === "plan-critic") return { type: "await-approval" };
      return { type: "done" };
    }
    case "revise": {
      if (stage === "develop-critic") {
        return { type: "escalate", reason: "Diff review requires a developer decision; automatic Develop retries are disabled" };
      }
      const target = stage === "plan-critic" ? "plan" : "develop";
      return ledger.canRevise(target)
        ? { type: "revise", stage: target, objections: verdict.objections }
        : { type: "escalate", reason: `Revision limit reached for stage '${target}'` };
    }
    case "replan":
      return ledger.canRevise("plan")
        ? { type: "revise", stage: "plan", objections: verdict.objections }
        : { type: "escalate", reason: "Revision limit reached for stage 'plan'" };
    case "escalate":
      return { type: "escalate", reason: `Critic escalated at stage '${stage}'` };
  }
}

function runStage(stage: StageName, ledger: MissionLedger, config: OrchestratorConfig): Action {
  const affordability = ledger.canAfford(stage);
  if (!affordability.affordable) return { type: "escalate", reason: affordability.reason };
  return {
    type: "run",
    stage,
    model: resolveStageModel(stage, config.modelTiers, config.fallbackModel),
  };
}
