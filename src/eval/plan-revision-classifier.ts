import { classifyDeveloperPlanAnswer, type DeveloperPlanAnswer, type PlanRevisionClassification } from "../agent/plan-revision.js";

export interface PlanRevisionClassifierFixture {
  source: string;
  answer: DeveloperPlanAnswer;
  expected: PlanRevisionClassification["path"];
}

export const PLAN_REVISION_CLASSIFIER_FIXTURES: PlanRevisionClassifierFixture[] = [
  {
    source: "PUB-159636 planning run 21d03ddd: unresolved conversion type",
    answer: {
      question: "Confirm the canonical type name: ChatGPTConversion vs OpenAiConversion.",
      answer: "Use ChatGPTConversion",
    },
    expected: "deterministic-patch",
  },
  {
    source: "PUB-159636 Publisher.Portal scout: legacy report compatibility",
    answer: {
      question: "Does retained compatibility require updating Reports/PixelHistory.js?",
      answer: "Yes, add Reports/PixelHistory.js to the implementation scope.",
    },
    expected: "scoped-rerun",
  },
  {
    source: "PUB-159636 coordinated plan: event mapping decision",
    answer: {
      question: "Which business events map to lead_created and registration_completed?",
      answer: "Map quote completion to lead_created and account completion to registration_completed.",
    },
    expected: "scoped-rerun",
  },
  {
    source: "PUB-159636 coordinated plan: account ownership contract",
    answer: {
      question: "May one campaign use multiple ChatGPT Ads accounts?",
      answer: "Yes, selected per conversion configuration.",
    },
    expected: "scoped-rerun",
  },
];

export function evaluatePlanRevisionClassifier(fixtures = PLAN_REVISION_CLASSIFIER_FIXTURES): {
  total: number;
  correct: number;
  accuracy: number;
  results: Array<{ source: string; expected: string; actual: string; passed: boolean }>;
} {
  const results = fixtures.map((fixture) => {
    const actual = classifyDeveloperPlanAnswer(fixture.answer).path;
    return { source: fixture.source, expected: fixture.expected, actual, passed: actual === fixture.expected };
  });
  const correct = results.filter((result) => result.passed).length;
  return { total: results.length, correct, accuracy: fixtures.length === 0 ? 1 : correct / fixtures.length, results };
}
