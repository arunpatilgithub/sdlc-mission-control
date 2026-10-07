import { describe, expect, it } from "vitest";
import { buildStageDisplay, classifyVerification, formatMissionCost } from "./develop-view";

const failed = (command: string) => ({ command, exitCode: 1, passed: false, output: "failed" });

describe("buildStageDisplay", () => {
  it("keeps a repeated develop stage as a second attempt", () => {
    const display = buildStageDisplay(["develop", "gates", "develop"], true);

    expect(display.filter((entry) => entry.stage === "develop")).toEqual([
      { stage: "develop", attempt: 1, status: "completed" },
      { stage: "develop", attempt: 2, status: "active" },
    ]);
  });
});

describe("formatMissionCost", () => {
  it("does not render a null cost as zero", () => {
    const display = formatMissionCost({ totalTokens: 1_200, costUSD: null, unreportedStages: [] });

    expect(display.incomplete).toBe(true);
    expect(display.cost).toContain("Cost incomplete");
    expect(display.cost).not.toContain("$0");
  });

  it("names stages whose costs were not reported", () => {
    const display = formatMissionCost({
      totalTokens: 2_400,
      costUSD: 0.25,
      unreportedStages: ["develop", "develop-critic"],
    });

    expect(display.incomplete).toBe(true);
    expect(display.cost).toContain("develop");
    expect(display.cost).toContain("develop-critic");
  });
});

describe("classifyVerification", () => {
  it("classifies a command failing before and after as pre-existing breakage", () => {
    const summary = classifyVerification(
      [failed("npm test")],
      [failed("npm test")],
      [],
    );

    expect(summary.rows).toEqual([expect.objectContaining({
      command: "npm test",
      classification: "pre-existing-failure",
    })]);
    expect(summary.rows[0].classification).not.toBe("regression");
    expect(summary.notVerifiedReason).toBeNull();
  });

  it("explains that regressions were not verified when no commands exist", () => {
    const summary = classifyVerification([], [], []);

    expect(summary.rows).toEqual([]);
    expect(summary.notVerifiedReason).toMatch(/not verified.*no verification commands/i);
  });
});
