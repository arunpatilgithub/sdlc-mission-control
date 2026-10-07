import { describe, expect, it } from "vitest";
import { developerAnswerToObjection } from "../agent/plan-revision.js";
import { evaluatePlanRevisionClassifier } from "./plan-revision-classifier.js";

describe("plan revision classifier evaluation", () => {
  it("matches every labeled historical planning case before the heuristic is used", () => {
    const scorecard = evaluatePlanRevisionClassifier();

    expect(scorecard.total).toBeGreaterThanOrEqual(4);
    expect(scorecard.accuracy).toBe(1);
    expect(scorecard.results.every((result) => result.passed)).toBe(true);
  });

  it("adapts developer answers with an honest human-decision evidence marker", () => {
    expect(developerAnswerToObjection({
      question: "Which name should be canonical?",
      answer: "Use ChatGPTConversion",
    })).toEqual({
      severity: "major",
      claim: 'Developer decision for "Which name should be canonical?": Use ChatGPTConversion',
      evidence: ["human decision — Mission Control developer input"],
    });
  });
});
