import { describe, expect, it } from "vitest";
import { classifyDeveloperPlanAnswer } from "./plan-revision.js";

describe("classifyDeveloperPlanAnswer", () => {
  it("deterministically applies a lowercase identifier selected from explicit alternatives", () => {
    expect(classifyDeveloperPlanAnswer({
      question: "Which event identifier should be used: externalidentifier, wizsid, or sessionid?",
      answer: "Use sessionid.",
    })).toEqual({
      path: "deterministic-patch",
      replacements: [
        { from: "externalidentifier", to: "sessionid" },
        { from: "wizsid", to: "sessionid" },
      ],
      reason: "The answer selects one exact identifier from the alternatives stated in the question.",
    });
  });

  it("deterministically patches an exact identifier selected by the decision form", () => {
    expect(classifyDeveloperPlanAnswer({
      question: "Which shared identifier should be used: ChatGPTRevenue or OpenAIRevenue?",
      answer: "Use ChatGPTRevenue",
    })).toMatchObject({
      path: "deterministic-patch",
      replacements: [{ from: "OpenAIRevenue", to: "ChatGPTRevenue" }],
    });
  });
});
