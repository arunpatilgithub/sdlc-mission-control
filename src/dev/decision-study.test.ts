import { describe, expect, it } from "vitest";
import { extractionPrompt, knownPositiveChecks, ownerReviewLabelForReport, ownerReviewSample, parseOwnerReview, tallyOwners, verifyExtractionCandidate, type OwnerReviewLabel, type StudyQuestion } from "./decision-study.js";

const documentation = [{
  requestedUrl: "https://developers.example.com/reference",
  finalUrl: "https://developers.example.com/reference",
  hostname: "developers.example.com",
  fetchedAt: "2026-10-05T00:00:00.000Z",
  responseHash: "hash",
  size: 88,
  contentType: "text/plain",
  redirectChain: [],
  wrappedText: "The required event type is order_created.\n{\"data\": {\"amount\": 2599, \"currency\": \"USD\"}}",
}];

describe("verifyExtractionCandidate", () => {
  it("rejects a claimed quote that is absent from fetched documentation", () => {
    expect(verifyExtractionCandidate({
      established: true,
      value: "order_created",
      quote: "The required event type is purchase.",
      url: "https://developers.example.com/reference",
    }, documentation)).toMatchObject({ established: false, reason: "quote-not-found-verbatim" });
  });

  it("rejects a value that does not appear inside the supplied quote", () => {
    expect(verifyExtractionCandidate({
      established: true,
      value: "purchase",
      quote: "The required event type is order_created.",
      url: "https://developers.example.com/reference",
    }, documentation)).toMatchObject({ established: false, reason: "value-not-in-quote" });
  });

  it("accepts only an exact quote and value from the declared fetched URL", () => {
    expect(verifyExtractionCandidate({
      established: true,
      value: "order_created",
      quote: "The required event type is order_created.",
      url: "https://developers.example.com/reference",
    }, documentation)).toMatchObject({ established: true, reason: "established", value: "order_created" });
  });

  it("accepts plural canonical JSON paths only when their exact JSON nesting is quoted", () => {
    expect(verifyExtractionCandidate({
      established: true,
      value: ["data.amount", "data.currency"],
      quote: "{\"data\": {\"amount\": 2599, \"currency\": \"USD\"}}",
      url: "https://developers.example.com/reference",
    }, documentation)).toMatchObject({
      established: true,
      reason: "established",
      values: ["data.amount", "data.currency"],
    });
  });

  it("records when the model does not establish an answer", () => {
    expect(verifyExtractionCandidate({
      established: false,
      value: "",
      quote: "",
      url: "",
    }, documentation)).toMatchObject({ established: false, reason: "model-not-established" });
  });
});

describe("tallyOwners", () => {
  it("preserves every closed owner class, including zero-count classes", () => {
    expect(tallyOwners(["vendor-public", "vendor-public", "repository-fact", "product-intent"])).toEqual({
      "vendor-public": 2,
      "repository-fact": 1,
      "org-config": 0,
      "product-intent": 1,
    });
  });
});

describe("knownPositiveChecks", () => {
  it("tells the extractor how to quote the documented OpenAI positive values", () => {
    const question: StudyQuestion = {
      question: "What exact OpenAI Ads event type identifies a revenue event?",
      recommendation: "",
      rationale: "",
      impact: "external-contract",
      storyId: 999,
      answer: null,
      vendorId: "openai-ads",
    };

    expect(extractionPrompt(question, documentation)).toContain("extract order_created when the documentation lists that literal as a supported type");
  });

  it("verifies the OpenAI revenue event and monetary JSON paths from source-backed extractions", () => {
    const eventType: StudyQuestion = {
      question: "What exact OpenAI Ads event type identifies a revenue event?",
      recommendation: "",
      rationale: "",
      impact: "external-contract",
      storyId: 999,
      answer: null,
      vendorId: "openai-ads",
    };
    const fields: StudyQuestion = {
      question: "What exact JSON field names and nesting carry the monetary amount and currency?",
      recommendation: "",
      rationale: "",
      impact: "external-contract",
      storyId: 999,
      answer: null,
      vendorId: "openai-ads",
    };
    const eventResult = verifyExtractionCandidate({
      established: true,
      value: "order_created",
      quote: "The required event type is order_created.",
      url: "https://developers.example.com/reference",
    }, documentation);
    const fieldResult = verifyExtractionCandidate({
      established: true,
      value: ["data.amount", "data.currency"],
      quote: "{\"data\": {\"amount\": 2599, \"currency\": \"USD\"}}",
      url: "https://developers.example.com/reference",
    }, documentation);

    expect(knownPositiveChecks([eventType, fields], new Map([
      [eventType, eventResult],
      [fields, fieldResult],
    ]))).toMatchObject([
      { id: "openai-revenue-event-type", verifiedQuestions: 1, missingExpectedValues: [] },
      { id: "openai-monetary-field-names", verifiedQuestions: 1, missingExpectedValues: [] },
    ]);
  });
});

describe("parseOwnerReview", () => {
  it("keeps only closed-set, requested labels with a human-review reason", () => {
    const output = JSON.stringify({
      classifications: [
        { id: "sample-1", owner: "repository-fact", reason: "The answer is established by current source." },
        { id: "sample-2", owner: "not-an-owner", reason: "Invalid." },
        { id: "not-requested", owner: "vendor-public", reason: "Ignored." },
      ],
    });

    expect(parseOwnerReview(output, new Set(["sample-1", "sample-2"]))).toEqual([
      { id: "sample-1", owner: "repository-fact", reason: "The answer is established by current source." },
    ]);
  });
});

describe("ownerReviewSample", () => {
  const question = (storyId: number, impact: string, index: number): StudyQuestion => ({
    question: `Question ${storyId}-${index}`,
    recommendation: "",
    rationale: "",
    impact,
    storyId,
    answer: null,
    vendorId: null,
  });

  it("is fixed-seed stratified and includes both protected-story populations", () => {
    const population = [
      ...Array.from({ length: 65 }, (_, index) => question(101, "external-contract", index)),
      ...Array.from({ length: 35 }, (_, index) => question(202, "repository-boundary", index)),
      ...Array.from({ length: 15 }, (_, index) => question(159636, "implementation", index)),
      ...Array.from({ length: 15 }, (_, index) => question(162941, "operational", index)),
    ];

    const first = ownerReviewSample(population);
    const second = ownerReviewSample(population);

    expect(first).toHaveLength(100);
    expect(first.map((entry) => entry.question.question)).toEqual(second.map((entry) => entry.question.question));
    expect([...new Set(first.map((entry) => entry.question.storyId))]).toEqual(expect.arrayContaining([159636, 162941]));
    expect([...new Set(first.map((entry) => entry.question.impact))]).toEqual(expect.arrayContaining(["external-contract", "repository-boundary", "implementation", "operational"]));
  });
});

describe("ownerReviewLabelForReport", () => {
  it("projects protected-story labels without question or reason text", () => {
    const label: OwnerReviewLabel = {
      id: "sample-1",
      question: "Protected question text",
      impact: "external-contract",
      owner: "vendor-public",
      reason: "Protected reason text",
      storyId: 159636,
    };

    const projected = ownerReviewLabelForReport(label);

    expect(projected).toMatchObject({ id: "sample-1", owner: "vendor-public" });
    expect(projected).toHaveProperty("questionHash");
    expect(projected).toHaveProperty("reasonHash");
    expect(projected).not.toHaveProperty("question");
    expect(projected).not.toHaveProperty("reason");
  });
});
