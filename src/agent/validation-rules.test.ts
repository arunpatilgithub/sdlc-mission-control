import { describe, expect, it } from "vitest";
import { classifyValidationMessage, VALIDATION_RULE_REGISTRY, VALIDATION_RULES } from "./validation-rules.js";

describe("classifyValidationMessage", () => {
  it("assigns stable ids to representative validator messages", () => {
    expect(classifyValidationMessage("executionDossier must classify why planned path src/Handler.js is a required write; observer-only files are not executable scope."))
      .toBe("dossier.write-role-missing");
    expect(classifyValidationMessage("External-contract decision 'Which value?' must be required before Develop or Publish."))
      .toBe("decision.external-contract-timing");
    expect(classifyValidationMessage("Unresolved cross-repository contract 'table' (table name): Source requires 'A' but Consumer requires 'B'. Reconcile both packets to one literal before planning can finalize."))
      .toBe("cross.unresolved-conflict");
  });

  it("leaves an unknown message visibly unclassified", () => {
    expect(classifyValidationMessage("A future validator message.")).toBe("unclassified");
  });

  it("classifies every replay rule with a rationale and its observed corpus count", () => {
    expect(VALIDATION_RULE_REGISTRY.map((rule) => rule.id)).toEqual(VALIDATION_RULES.map((rule) => rule.id));
    expect(VALIDATION_RULE_REGISTRY.every((rule) => rule.class && rule.observed && rule.rationale.length > 0 && Number.isInteger(rule.corpusCount) && rule.corpusCount >= 0)).toBe(true);
    expect(VALIDATION_RULE_REGISTRY.filter((rule) => rule.class === "derivable").map((rule) => rule.derivation)).toEqual([
      "carryAdoptedConventionDefaults",
      "carryAdoptedConventionDefaults",
      "normalizeDecisionRequiredBefore",
      "normalizeDecisionRequiredBefore",
      "normalizeDecisionRequiredBefore",
      "normalizeDecisionRequiredBefore",
    ]);
    expect(VALIDATION_RULE_REGISTRY.filter((rule) => rule.corpusCount === 0 && rule.observed !== "not-replayable").every((rule) => rule.observed === "unobserved")).toBe(true);
    expect(VALIDATION_RULE_REGISTRY.filter((rule) => rule.observed === "not-replayable").map((rule) => rule.id)).toEqual([
      "scout.scope-out-follow-up",
      "scope-anchor.evidence",
      "runtime.timeout",
      "runtime.spawn",
    ]);
    expect(VALIDATION_RULE_REGISTRY.filter((rule) => rule.class === "redundant")).toHaveLength(0);
    expect(Object.fromEntries(["safety", "judgment", "derivable", "redundant"].map((classification) => [classification, Object.fromEntries(
      ["fired", "unobserved", "not-replayable"].map((observed) => [observed, VALIDATION_RULE_REGISTRY.filter((rule) => rule.class === classification && rule.observed === observed).length]),
    )]))).toEqual({
      safety: { fired: 6, unobserved: 14, "not-replayable": 4 },
      judgment: { fired: 10, unobserved: 15, "not-replayable": 0 },
      derivable: { fired: 1, unobserved: 5, "not-replayable": 0 },
      redundant: { fired: 0, unobserved: 0, "not-replayable": 0 },
    });
    expect(VALIDATION_RULE_REGISTRY.reduce((total, rule) => total + rule.corpusCount, 0)).toBe(313);
  });
});
