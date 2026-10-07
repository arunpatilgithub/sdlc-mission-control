import { describe, expect, it } from "vitest";
import type { CriticVerdict, Objection } from "./artifacts.js";
import type { GateReport } from "./gates.js";
import { MissionLedger, type LedgerLimits } from "./ledger.js";
import { nextAction, type MissionState, type OrchestratorConfig, type StageName } from "./orchestrator.js";

const config: OrchestratorConfig = {
  modelTiers: {
    plan: "plan-model",
    "plan-critic": "plan-critic-model",
    "develop-critic": "develop-critic-model",
  },
  fallbackModel: "fallback-model",
};

const limits = (overrides: Partial<LedgerLimits> = {}): LedgerLimits => ({
  perStageTokens: {},
  missionCeilingTokens: 10_000,
  maxRevisions: 2,
  ...overrides,
});

const ledger = (overrides: Partial<LedgerLimits> = {}): MissionLedger =>
  new MissionLedger(limits(overrides));

const state = (overrides: Partial<MissionState> = {}): MissionState => ({
  missionId: "mission-42",
  storyId: 42,
  stage: "plan",
  approved: false,
  verdict: null,
  gateReport: null,
  escalationReason: null,
  ...overrides,
});

const objections: Objection[] = [{
  severity: "major",
  claim: "The plan omits verification.",
  evidence: ["src/worker.ts:20"],
}];

const verdict = (disposition: CriticVerdict["disposition"]): CriticVerdict => ({
  schemaVersion: 1,
  missionId: "mission-42",
  storyId: 42,
  stage: "plan",
  createdAt: "2026-08-20T18:00:00.000Z",
  producedBy: "test-model",
  disposition,
  objections,
  usage: null,
});

const gateReport = (passed: boolean): GateReport => ({ passed, results: [] });

describe("nextAction", () => {
  const runCases: Array<[StageName, string]> = [
    ["plan", "plan-model"],
    ["plan-critic", "plan-critic-model"],
    ["develop", "fallback-model"],
    ["develop-critic", "develop-critic-model"],
  ];

  it.each(runCases)("runs a clean %s stage with its resolved model", (stage, model) => {
    expect(nextAction(state({ stage }), ledger(), config)).toEqual({ type: "run", stage, model });
  });

  it("runs deterministic gates without selecting a model", () => {
    expect(nextAction(state({ stage: "gates" }), ledger(), config)).toEqual({ type: "run-gates" });
  });

  it("routes every plan critic disposition", () => {
    expect(nextAction(state({ stage: "plan-critic", verdict: verdict("accept") }), ledger(), config))
      .toEqual({ type: "await-approval" });
    expect(nextAction(state({ stage: "plan-critic", verdict: verdict("revise") }), ledger(), config))
      .toEqual({ type: "revise", stage: "plan", objections });
    expect(nextAction(state({ stage: "plan-critic", verdict: verdict("replan") }), ledger(), config))
      .toEqual({ type: "revise", stage: "plan", objections });
    const escalated = nextAction(state({ stage: "plan-critic", verdict: verdict("escalate") }), ledger(), config);
    expect(escalated.type).toBe("escalate");
    expect(escalated).toMatchObject({ reason: expect.stringContaining("plan-critic") });
  });

  it("re-presents approval when approval predates the accepted critic verdict", () => {
    expect(nextAction(state({
      stage: "plan-critic",
      approved: true,
      verdict: verdict("accept"),
    }), ledger(), config)).toEqual({ type: "await-approval" });
  });

  it("revises before the cap and escalates after the cap is spent", () => {
    const revisions = ledger({ maxRevisions: 2 });
    const current = state({ stage: "plan-critic", verdict: verdict("revise") });

    expect(nextAction(current, revisions, config)).toEqual({
      type: "revise", stage: "plan", objections,
    });

    revisions.noteRevision("plan");
    revisions.noteRevision("plan");
    const escalated = nextAction(current, revisions, config);
    expect(escalated).toEqual({
      type: "escalate", reason: "Revision limit reached for stage 'plan'",
    });
  });

  it("escalates a legacy develop-critic revision instead of retrying Develop", () => {
    expect(nextAction(
      state({ stage: "develop-critic", verdict: verdict("revise") }),
      ledger(),
      config,
    )).toEqual({
      type: "escalate", reason: "Diff review requires a developer decision; automatic Develop retries are disabled",
    });
  });

  it("escalates before a run when the stage budget is unaffordable", () => {
    const budget = ledger({
      perStageTokens: { plan: 1_000 },
      missionCeilingTokens: 800,
    });
    const reason = budget.canAfford("plan").reason;

    expect(nextAction(state(), budget, config)).toEqual({ type: "escalate", reason });
  });

  it("escalates a failed gate report rather than retrying Develop", () => {
    const action = nextAction(
      state({ stage: "gates", gateReport: gateReport(false) }),
      ledger(),
      config,
    );

    expect(action).toEqual({
      type: "escalate", reason: "Deterministic Develop gates failed; revise and re-approve the plan before another implementation attempt",
    });
  });

  it("finishes after a passing gate report", () => {
    expect(nextAction(
      state({ stage: "gates", gateReport: gateReport(true) }),
      ledger(),
      config,
    )).toEqual({ type: "done" });
  });

  it("hands a passing gate to the diff critic when a per-repository verdict is required", () => {
    expect(nextAction(
      state({ stage: "gates", gateReport: gateReport(true) }),
      ledger(),
      { ...config, requireDiffCritic: true },
    )).toEqual({ type: "run", stage: "develop-critic", model: "develop-critic-model" });
  });

  it("does not re-run the diff critic once its verdict exists", () => {
    expect(nextAction(
      state({ stage: "gates", gateReport: gateReport(true), verdict: verdict("accept") }),
      ledger(),
      { ...config, requireDiffCritic: true },
    )).toEqual({ type: "done" });
  });

  it("awaits explicit approval and advances only after the developer approves", () => {
    expect(nextAction(state({ stage: "approval", approved: false }), ledger(), config))
      .toEqual({ type: "await-approval" });
    expect(nextAction(state({ stage: "approval", approved: true }), ledger(), config))
      .toEqual({ type: "run", stage: "develop", model: "fallback-model" });
  });

  it("keeps done and escalated states terminal regardless of other state", () => {
    expect(nextAction(state({
      stage: "done",
      approved: true,
      verdict: verdict("revise"),
      gateReport: gateReport(false),
    }), ledger({ missionCeilingTokens: 0 }), config)).toEqual({ type: "done" });

    expect(nextAction(state({
      stage: "escalated",
      approved: true,
      verdict: verdict("accept"),
      gateReport: gateReport(true),
      escalationReason: "Developer intervention required",
    }), ledger({ missionCeilingTokens: 0 }), config)).toEqual({
      type: "escalate", reason: "Developer intervention required",
    });

    const generic = nextAction(
      state({ stage: "escalated" }),
      ledger({ missionCeilingTokens: 0 }),
      config,
    );
    expect(generic.type).toBe("escalate");
    expect(generic).toMatchObject({ reason: expect.any(String) });
  });

  it("applies budget precedence before a failed gate report", () => {
    const budget = ledger({
      perStageTokens: { gates: 1_000 },
      missionCeilingTokens: 800,
    });
    const reason = budget.canAfford("gates").reason;

    expect(nextAction(
      state({ stage: "gates", gateReport: gateReport(false) }),
      budget,
      config,
    )).toEqual({ type: "escalate", reason });
  });
});
