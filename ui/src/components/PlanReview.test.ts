import { describe, expect, it } from "vitest";
import { defaultPlanningModel, scoutReasoningEffortRequest } from "./PlanReview";

describe("defaultPlanningModel", () => {
  it("restores the Codex planning default after a workspace reset", () => {
    expect(defaultPlanningModel("codex")).toBe("gpt-5.6-sol");
  });

  it("does not select a Codex model for Claude", () => {
    expect(defaultPlanningModel("claude")).toBe("");
  });
});

describe("scoutReasoningEffortRequest", () => {
  it("carries the selected effort in a Codex planning request", () => {
    expect(scoutReasoningEffortRequest("codex", "high")).toEqual({ scoutReasoningEffort: "high" });
  });

  it("omits the Codex-only option for Claude", () => {
    expect(scoutReasoningEffortRequest("claude", "low")).toEqual({});
  });
});
