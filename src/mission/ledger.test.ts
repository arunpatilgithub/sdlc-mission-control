import { describe, expect, it } from "vitest";
import type { RunUsage } from "../agent/usage.js";
import { MissionLedger, resolveStageModel, type LedgerLimits } from "./ledger.js";

const usage = (overrides: Partial<RunUsage> = {}): RunUsage => ({
  provider: "codex",
  inputTokens: 1_000,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 200,
  reasoningTokens: null,
  costUSD: null,
  turns: 1,
  durationMs: 1_000,
  promptBytes: 500,
  toolOutputBytes: 200,
  outputBytes: 50,
  commandCount: 1,
  ...overrides,
});

const limits = (overrides: Partial<LedgerLimits> = {}): LedgerLimits => ({
  perStageTokens: {},
  missionCeilingTokens: 10_000,
  maxRevisions: 2,
  ...overrides,
});

describe("MissionLedger", () => {
  it("sums two reported stages and preserves their per-stage entries", () => {
    const ledger = new MissionLedger(limits());
    ledger.record("plan", usage({ inputTokens: 1_000, outputTokens: 200 }));
    ledger.record("critic", usage({ inputTokens: 500, outputTokens: 100 }));

    expect(ledger.summary()).toMatchObject({
      totalTokens: 1_800,
      perStage: [
        { stage: "plan", tokens: 1_200, reported: true },
        { stage: "critic", tokens: 600, reported: true },
      ],
    });
  });

  it("keeps a null-usage stage visible and marks its cost unreported", () => {
    const ledger = new MissionLedger(limits());
    ledger.record("critic", null);

    const summary = ledger.summary();
    expect(summary.totalTokens).toBe(0);
    expect(summary.unreportedStages).toContain("critic");
    expect(summary.perStage).toContainEqual({ stage: "critic", tokens: 0, reported: false });
  });

  it("counts reported output while marking a null input token count unreported", () => {
    const ledger = new MissionLedger(limits());
    ledger.record("develop", usage({ inputTokens: null, outputTokens: 500 }));

    const summary = ledger.summary();
    expect(summary.totalTokens).toBe(500);
    expect(summary.unreportedStages).toContain("develop");
    expect(summary.perStage).toContainEqual({ stage: "develop", tokens: 500, reported: false });
  });

  it("accepts a capped stage when enough budget remains and refuses it when too little remains", () => {
    const ledger = new MissionLedger(limits({
      perStageTokens: { develop: 600 },
      missionCeilingTokens: 1_000,
    }));
    ledger.record("plan", usage({ inputTokens: 200, outputTokens: 100 }));

    expect(ledger.canAfford("develop")).toEqual({ affordable: true, reason: "" });

    ledger.record("critic", usage({ inputTokens: 200, outputTokens: 100 }));
    const refused = ledger.canAfford("develop");
    expect(refused.affordable).toBe(false);
    expect(refused.reason).not.toBe("");
  });

  it("allows an uncapped stage while budget remains and refuses it at the mission ceiling", () => {
    const ledger = new MissionLedger(limits({ missionCeilingTokens: 1_000 }));

    expect(ledger.canAfford("unlisted")).toEqual({ affordable: true, reason: "" });

    ledger.record("plan", usage({ inputTokens: 800, outputTokens: 200 }));
    const refused = ledger.canAfford("unlisted");
    expect(refused.affordable).toBe(false);
    expect(refused.reason).not.toBe("");
  });

  it("permits exactly two revisions when maxRevisions is two", () => {
    const ledger = new MissionLedger(limits({ maxRevisions: 2 }));

    expect(ledger.canRevise("critic")).toBe(true);
    ledger.noteRevision("critic");
    expect(ledger.canRevise("critic")).toBe(true);
    ledger.noteRevision("critic");
    expect(ledger.canRevise("critic")).toBe(false);
    expect(ledger.revisionCount("critic")).toBe(2);
  });

  it("counts developer plan revisions independently from critic plan revisions", () => {
    const ledger = new MissionLedger(limits({ maxRevisions: 1, maxDeveloperPlanRevisions: 2 }));
    ledger.noteRevision("plan");

    expect(ledger.canRevise("plan")).toBe(false);
    expect(ledger.canDeveloperRevisePlan()).toBe(true);
    ledger.noteDeveloperPlanRevision();
    expect(ledger.canDeveloperRevisePlan()).toBe(true);
    ledger.noteDeveloperPlanRevision();
    expect(ledger.canDeveloperRevisePlan()).toBe(false);
    expect(ledger.revisionCount("plan")).toBe(1);
    expect(ledger.developerPlanRevisionCount()).toBe(2);
  });

  it("keeps cost null when absent and sums only reported provider costs", () => {
    const noCost = new MissionLedger(limits());
    noCost.record("develop", usage());
    expect(noCost.summary().costUSD).toBeNull();

    const mixed = new MissionLedger(limits());
    mixed.record("plan", usage({ provider: "claude", costUSD: 0.42 }));
    mixed.record("develop", usage({ provider: "codex", costUSD: null }));
    expect(mixed.summary().costUSD).toBe(0.42);
  });
});

describe("resolveStageModel", () => {
  it("uses the configured stage tier without inferring a model for unlisted stages", () => {
    const tiers = { plan: "claude-sonnet", critic: "claude-haiku" };

    expect(resolveStageModel("critic", tiers, "fallback-model")).toBe("claude-haiku");
    expect(resolveStageModel("develop", tiers, "fallback-model")).toBe("fallback-model");
  });
});
