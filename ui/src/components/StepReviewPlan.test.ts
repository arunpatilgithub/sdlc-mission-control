import { describe, expect, it } from "vitest";
import type { PlanJob } from "../types";
import { acceptAllRecommendationChoices, answeredDeveloperDecisions, externalReviewPacket, formatDeveloperDecisionAnswer } from "./StepReviewPlan";

const decision = {
  question: "Which identifier should be used?",
  recommendation: "Use sessionid.",
  alternatives: ["sessionid", "Use externalidentifier only if the retry source is stable."],
};

describe("externalReviewPacket", () => {
  it("exports a self-contained read-only review prompt with repository-qualified scope", () => {
    const plan = {
      id: "12345678-plan",
      provider: "codex",
      repositoryIds: ["Api", "Portal"],
      worktreePaths: { Api: "/work/Api", Portal: "/work/Portal" },
      branches: { Api: "main", Portal: "develop" },
      dependenciesByRepository: { Api: [], Portal: ["Api"] },
      questionsOrClarifications: ["Confirm whether Portal must remain backward compatible during rollout."],
      startedAt: "2026-09-15T12:00:00.000Z",
      completedAt: "2026-09-15T12:05:00.000Z",
      output: "## Ordered implementation tasks\n1. Update the shared contract.",
      packet: {
        story: {
          id: 162879,
          title: "Coordinate delivery",
          comments: [{ id: 4, author: "Product owner", createdDate: "2026-09-15T11:00:00Z", modifiedDate: null, text: "Keep both repositories compatible." }],
        },
        mode: "deep",
        documentation: [{
          requestedUrl: "https://developers.openai.com/ads/conversions-api",
          finalUrl: "https://developers.openai.com/ads/conversions-api",
          hostname: "developers.openai.com",
          fetchedAt: "2026-09-15T12:00:00Z",
          responseHash: "abc",
          size: 20,
          contentType: "text/html",
          redirectChain: [],
          wrappedText: "--- BEGIN UNTRUSTED EXTERNAL DOCUMENTATION ---\nReference contract\n--- END UNTRUSTED EXTERNAL DOCUMENTATION ---",
        }],
      },
    } as unknown as PlanJob;

    const packet = externalReviewPacket(plan, {
      Api: ["src/contract.ts"],
      Portal: ["src/client.ts"],
    });

    expect(packet).toContain("independent, read-only implementation-plan reviewer");
    expect(packet).toContain("### 1. Api");
    expect(packet).toContain("`src/contract.ts`");
    expect(packet).toContain("Depends on: Api");
    expect(packet).toContain("Product owner: Keep both repositories compatible.");
    expect(packet).toContain("BEGIN UNTRUSTED EXTERNAL DOCUMENTATION");
    expect(packet).toContain("Confirm whether Portal must remain backward compatible during rollout.");
    expect(packet).toContain("## Ordered implementation tasks");
  });
});

describe("developer decision answers", () => {
  it("formats recommendation, identifier alternative, prose alternative, and Other choices", () => {
    expect(formatDeveloperDecisionAnswer(decision, "recommendation", "")).toBe("Accept the recommendation: Use sessionid.");
    expect(formatDeveloperDecisionAnswer(decision, "alternative:0", "")).toBe("Use sessionid");
    expect(formatDeveloperDecisionAnswer(decision, "alternative:1", "")).toBe("Use alternative: Use externalidentifier only if the retry source is stable.");
    expect(formatDeveloperDecisionAnswer(decision, "other", "Use the source event ID.")).toBe("Use the source event ID.");
  });

  it("omits undecided cards when preparing submitted answers", () => {
    const unanswered = { ...decision, question: "Which cadence should be used?" };
    expect(answeredDeveloperDecisions(
      [decision, unanswered],
      { [decision.question]: "alternative:0" },
      {},
      { [decision.question]: "https://dev.azure.com/example/comment" },
    )).toEqual([{
      question: decision.question,
      answer: "Use sessionid",
      evidence: "https://dev.azure.com/example/comment",
    }]);
  });

  it("selects every planning recommendation at once", () => {
    const second = { ...decision, question: "Which cadence should be used?" };
    expect(acceptAllRecommendationChoices([decision, second])).toEqual({
      [decision.question]: "recommendation",
      [second.question]: "recommendation",
    });
  });
});
