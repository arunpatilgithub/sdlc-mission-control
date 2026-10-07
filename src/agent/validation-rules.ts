export type ValidationStage = "scout" | "coordinator" | "scope-anchor";

export type RuleId =
  | "scout.packet-missing"
  | "scout.json-invalid"
  | "scout.repository-id"
  | "scout.scope-disposition"
  | "scout.planned-paths"
  | "scout.conclusion-required"
  | "scout.applicability-proof"
  | "scout.implementation-steps"
  | "scout.completion"
  | "scout.local-extension-owner"
  | "scout.scope-out-evidence"
  | "scout.scope-out-follow-up"
  | "scout.handoff-owner"
  | "dossier.planned-path"
  | "dossier.concrete-change"
  | "dossier.anchor"
  | "dossier.write-role-missing"
  | "dossier.required-fragment"
  | "dossier.temporal-semantics"
  | "dossier.test-assertions"
  | "dossier.test-write-role"
  | "dossier.test-placement"
  | "dossier.test-harness"
  | "dossier.test-coverage"
  | "dossier.test-relevance"
  | "convention.unknown-id"
  | "convention.carried-literal"
  | "convention.untracked-id"
  | "convention.concatenated-defaults"
  | "convention.default-not-carried"
  | "decision.shared-contract-timing"
  | "decision.external-contract-timing"
  | "decision.unresolved-fact"
  | "decision.fact-provenance"
  | "decision.implementation-block"
  | "decision.operational-block"
  | "decision.impact"
  | "decision.duplicate-resolution"
  | "confirmation.decision-missing"
  | "confirmation.timing"
  | "confirmation.repository"
  | "confirmation.reference"
  | "cross.unresolved-conflict"
  | "cross.repository-link"
  | "cross.dependency-order"
  | "cross.dossier-path"
  | "cross.shared-literal"
  | "cross.literal-shape"
  | "scope-anchor.evidence"
  | "coordinator.repository-evaluations"
  | "contract.canonical-identifier"
  | "dossier.edit-anchor"
  | "decision.scope-conflict"
  | "runtime.timeout"
  | "runtime.spawn"
  | "unclassified";

export interface ValidationRuleDefinition {
  id: Exclude<RuleId, "unclassified">;
  stage: ValidationStage;
  matches: readonly RegExp[];
}

export type ValidationRuleClass = "safety" | "derivable" | "judgment" | "redundant";
export type ValidationRuleObservation = "fired" | "unobserved" | "not-replayable";

export interface ValidationRuleRegistryEntry extends ValidationRuleDefinition {
  class: ValidationRuleClass;
  observed: ValidationRuleObservation;
  rationale: string;
  derivation?: string;
  corpusCount: number;
}

export const VALIDATION_RULES: readonly ValidationRuleDefinition[] = [
  { id: "scout.packet-missing", stage: "scout", matches: [/No fenced JSON scout packet/, /scout packet was not an object/] },
  { id: "scout.json-invalid", stage: "scout", matches: [/scout JSON did not parse/] },
  { id: "scout.repository-id", stage: "scout", matches: [/Scout packet repositoryId must be/] },
  { id: "scout.scope-disposition", stage: "scout", matches: [/Scout scopeDisposition must be/] },
  { id: "scout.planned-paths", stage: "scout", matches: [/plannedPaths must be a non-empty array/, /verified-no-change requires empty planned paths/] },
  { id: "scout.conclusion-required", stage: "scout", matches: [/Scout must reach a changes-required/] },
  { id: "scout.applicability-proof", stage: "scout", matches: [/changes-required requires a non-unknown applicability proof/] },
  { id: "scout.implementation-steps", stage: "scout", matches: [/changes-required requires non-empty implementationSteps/, /implementationSteps must describe executable/] },
  { id: "scout.completion", stage: "scout", matches: [/packet stopped before its direct implementation path/, /verified-no-change cannot be concluded while direct-path/] },
  { id: "scout.local-extension-owner", stage: "scout", matches: [/local-extension-confirmed requires a different owner/] },
  { id: "scout.scope-out-evidence", stage: "scout", matches: [/verified-no-change requires current-source evidence/] },
  { id: "scout.scope-out-follow-up", stage: "scope-anchor", matches: [/verified-no-change does not address configured scope anchor/, /verified-no-change could not be semantically confirmed/] },
  { id: "scout.handoff-owner", stage: "scout", matches: [/local-extension-confirmed.*configured repository owner/] },
  { id: "dossier.planned-path", stage: "scout", matches: [/executionDossier must describe every exact planned path/] },
  { id: "dossier.concrete-change", stage: "scout", matches: [/executionDossier change .*must state a concrete edit/] },
  { id: "dossier.anchor", stage: "scout", matches: [/executionDossier must cite current-source anchors/] },
  { id: "dossier.write-role-missing", stage: "scout", matches: [/executionDossier must classify why planned path/] },
  { id: "dossier.required-fragment", stage: "scout", matches: [/executionDossier must provide exact requiredSourceFragments/] },
  { id: "dossier.temporal-semantics", stage: "scout", matches: [/executionDossier for .*must state fieldSemantics/] },
  { id: "dossier.test-assertions", stage: "scout", matches: [/executionDossier must enumerate expected assertions/] },
  { id: "dossier.test-write-role", stage: "scout", matches: [/executionDossier must classify planned test path/] },
  { id: "dossier.test-placement", stage: "scout", matches: [/executionDossier must place testScenarios/] },
  { id: "dossier.test-harness", stage: "scout", matches: [/executionDossier plans test path .*no executable test harness/] },
  { id: "dossier.test-coverage", stage: "scout", matches: [/executionDossier must include a planned test path/] },
  { id: "dossier.test-relevance", stage: "scout", matches: [/executionDossier test path .*must be source-adjacent/] },
  { id: "convention.unknown-id", stage: "scout", matches: [/adopts unknown established convention ids/] },
  { id: "convention.carried-literal", stage: "scout", matches: [/adopts established convention .*does not carry default literal/] },
  { id: "convention.untracked-id", stage: "scout", matches: [/carries established convention .*without naming it in adoptedConventionIds/] },
  { id: "convention.concatenated-defaults", stage: "scout", matches: [/must not concatenate defaults from multiple established conventions/] },
  { id: "convention.default-not-carried", stage: "scout", matches: [/established convention .*must carry cited default literal/, /established convention .*must be carried into an implementation step/] },
  { id: "decision.shared-contract-timing", stage: "coordinator", matches: [/Shared-contract decision .*must be required before Develop/] },
  { id: "decision.external-contract-timing", stage: "coordinator", matches: [/External-contract decision .*must be required before Develop or Publish/] },
  { id: "decision.unresolved-fact", stage: "coordinator", matches: [/decision .*must cite exactly one unresolved/, /decision .*must resolve exactly one confirmation dependency ID/, /decision .*must resolve one or more confirmation dependency IDs/] },
  { id: "decision.fact-provenance", stage: "coordinator", matches: [/decision .*cites confirmed scout fact/, /decision .*cites unknown unresolved scout fact/] },
  { id: "decision.implementation-block", stage: "coordinator", matches: [/Implementation decision .*cannot block Develop/] },
  { id: "decision.operational-block", stage: "coordinator", matches: [/Operational decision .*cannot block Develop/] },
  { id: "decision.impact", stage: "coordinator", matches: [/Blocking decision .*no valid impact classification/] },
  { id: "decision.duplicate-resolution", stage: "coordinator", matches: [/Blocking decision .*repeats an already resolved/] },
  { id: "confirmation.decision-missing", stage: "coordinator", matches: [/confirmation dependency .*must have an external-contract decision/] },
  { id: "confirmation.timing", stage: "coordinator", matches: [/confirmation dependency .*is required before .*but its decision is timed/] },
  { id: "confirmation.repository", stage: "coordinator", matches: [/confirmation dependency .*must name its affected repository/] },
  { id: "confirmation.reference", stage: "coordinator", matches: [/references unknown confirmation dependency/] },
  { id: "cross.unresolved-conflict", stage: "coordinator", matches: [/Unresolved cross-repository contract/] },
  { id: "cross.repository-link", stage: "coordinator", matches: [/Cross-repository contract .*must connect two changes-required repositories/] },
  { id: "cross.dependency-order", stage: "coordinator", matches: [/cross-repository contract .*must depend on/] },
  { id: "cross.dossier-path", stage: "coordinator", matches: [/cross-repository contract .*requires an existing non-test .* dossier entry/] },
  { id: "cross.shared-literal", stage: "coordinator", matches: [/cross-repository contract .*independently require/, /cross-repository contract .*must name a source dossier path/] },
  { id: "cross.literal-shape", stage: "coordinator", matches: [/Cross-repository contract .*must declare a small shared literal/, /Cross-repository contract .*sharedLiteral is not a table identifier/] },
  { id: "scope-anchor.evidence", stage: "scope-anchor", matches: [/scope anchor/, /Targeted critic did not produce audit-backed file evidence/] },
  { id: "coordinator.repository-evaluations", stage: "coordinator", matches: [/repositoryEvaluations must contain every selected repository/] },
  { id: "contract.canonical-identifier", stage: "coordinator", matches: [/canonical identifier/] },
  { id: "dossier.edit-anchor", stage: "scout", matches: [/executionDossier editAnchor/] },
  { id: "decision.scope-conflict", stage: "coordinator", matches: [/developer decision contradicts a repository.*verified-no-change conclusion/] },
  { id: "runtime.timeout", stage: "coordinator", matches: [/planning timed out after \d+ seconds/] },
  { id: "runtime.spawn", stage: "coordinator", matches: [/exited without writing its required plan result file/] },
];

const RULE_METADATA: Record<ValidationRuleDefinition["id"], Omit<ValidationRuleRegistryEntry, "id" | "stage" | "matches">> = {
  "scout.packet-missing": { class: "safety", observed: "fired", rationale: "A missing packet cannot establish a bounded write decision.", corpusCount: 45 },
  "scout.json-invalid": { class: "safety", observed: "unobserved", rationale: "Malformed model output cannot establish a bounded write decision.", corpusCount: 0 },
  "scout.repository-id": { class: "safety", observed: "unobserved", rationale: "A packet bound to another repository can produce a wrong scope.", corpusCount: 0 },
  "scout.scope-disposition": { class: "safety", observed: "unobserved", rationale: "An invalid scope disposition can approve the wrong repository outcome.", corpusCount: 0 },
  "scout.planned-paths": { class: "safety", observed: "unobserved", rationale: "Missing or extraneous paths can widen or contradict the approved write scope.", corpusCount: 0 },
  "scout.conclusion-required": { class: "safety", observed: "fired", rationale: "An uncertain scope cannot be approved as a write decision.", corpusCount: 50 },
  "scout.applicability-proof": { class: "safety", observed: "fired", rationale: "A local write requires source-backed applicability.", corpusCount: 16 },
  "scout.implementation-steps": { class: "judgment", observed: "fired", rationale: "The model must describe a concrete repository-local implementation.", corpusCount: 20 },
  "scout.completion": { class: "judgment", observed: "fired", rationale: "Completion is a model judgment about the sufficiency of the local investigation.", corpusCount: 32 },
  "scout.local-extension-owner": { class: "safety", observed: "fired", rationale: "An invalid handoff owner can misstate the repository boundary.", corpusCount: 14 },
  "scout.scope-out-evidence": { class: "safety", observed: "unobserved", rationale: "A no-change conclusion without evidence can exclude the correct repository.", corpusCount: 0 },
  "scout.scope-out-follow-up": { class: "safety", observed: "not-replayable", rationale: "A no-change conclusion that misses a configured anchor can exclude the correct repository.", corpusCount: 0 },
  "scout.handoff-owner": { class: "safety", observed: "unobserved", rationale: "An unknown handoff owner can shift scope to the wrong repository.", corpusCount: 0 },
  "dossier.planned-path": { class: "judgment", observed: "fired", rationale: "Dossier coverage is an implementation handoff completeness check.", corpusCount: 34 },
  "dossier.concrete-change": { class: "judgment", observed: "unobserved", rationale: "The model must identify a concrete local edit.", corpusCount: 0 },
  "dossier.anchor": { class: "judgment", observed: "unobserved", rationale: "The model must choose source anchors that explain the local edit.", corpusCount: 0 },
  "dossier.write-role-missing": { class: "judgment", observed: "fired", rationale: "Write-role classification is an implementation handoff completeness check.", corpusCount: 31 },
  "dossier.required-fragment": { class: "judgment", observed: "fired", rationale: "Required fragments are a plan completeness contract for Develop.", corpusCount: 2 },
  "dossier.temporal-semantics": { class: "judgment", observed: "fired", rationale: "The model must state the chosen temporal meaning without inventing it.", corpusCount: 4 },
  "dossier.test-assertions": { class: "judgment", observed: "unobserved", rationale: "Useful regression assertions depend on the local behavior being changed.", corpusCount: 0 },
  "dossier.test-write-role": { class: "judgment", observed: "unobserved", rationale: "Test-write classification is a handoff completeness check.", corpusCount: 0 },
  "dossier.test-placement": { class: "judgment", observed: "fired", rationale: "Test-scenario placement is a handoff format check.", corpusCount: 30 },
  "dossier.test-harness": { class: "judgment", observed: "fired", rationale: "Executable-test availability is a validation completeness check.", corpusCount: 3 },
  "dossier.test-coverage": { class: "judgment", observed: "fired", rationale: "The model must identify regression coverage for new executable behavior.", corpusCount: 1 },
  "dossier.test-relevance": { class: "judgment", observed: "unobserved", rationale: "Test relevance depends on the source behavior and local test topology.", corpusCount: 0 },
  "convention.unknown-id": { class: "safety", observed: "unobserved", rationale: "An unknown convention id can present an unproven default as source-backed fact.", corpusCount: 0 },
  "convention.carried-literal": { class: "judgment", observed: "unobserved", rationale: "Carrying a declared convention literal is an implementation handoff completeness check.", corpusCount: 0 },
  "convention.untracked-id": { class: "derivable", observed: "unobserved", rationale: "Convention ids carried by dossier literals are mechanically discoverable.", derivation: "carryAdoptedConventionDefaults", corpusCount: 0 },
  "convention.concatenated-defaults": { class: "judgment", observed: "unobserved", rationale: "Separating convention literals is a handoff format check.", corpusCount: 0 },
  "convention.default-not-carried": { class: "derivable", observed: "unobserved", rationale: "Missing declared convention defaults can be carried from the cited convention.", derivation: "carryAdoptedConventionDefaults", corpusCount: 0 },
  "decision.shared-contract-timing": { class: "derivable", observed: "unobserved", rationale: "The required timing follows from the decision impact.", derivation: "normalizeDecisionRequiredBefore", corpusCount: 0 },
  "decision.external-contract-timing": { class: "derivable", observed: "fired", rationale: "The required timing follows from the decision impact.", derivation: "normalizeDecisionRequiredBefore", corpusCount: 3 },
  "decision.unresolved-fact": { class: "safety", observed: "unobserved", rationale: "An unsupported blocking decision can fabricate an external source uncertainty.", corpusCount: 0 },
  "decision.fact-provenance": { class: "safety", observed: "fired", rationale: "Decisions must not fabricate or misstate scout evidence.", corpusCount: 19 },
  "decision.implementation-block": { class: "derivable", observed: "unobserved", rationale: "The decision impact determines the non-blocking timing.", derivation: "normalizeDecisionRequiredBefore", corpusCount: 0 },
  "decision.operational-block": { class: "derivable", observed: "unobserved", rationale: "The decision impact determines the non-blocking timing.", derivation: "normalizeDecisionRequiredBefore", corpusCount: 0 },
  "decision.impact": { class: "judgment", observed: "unobserved", rationale: "The model must identify which decision category is actually at stake.", corpusCount: 0 },
  "decision.duplicate-resolution": { class: "judgment", observed: "unobserved", rationale: "Whether a decision repeats an already resolved uncertainty is a plan-consistency judgment.", corpusCount: 0 },
  "confirmation.decision-missing": { class: "safety", observed: "unobserved", rationale: "A missing confirmation decision can allow an unconfirmed external contract into implementation.", corpusCount: 0 },
  "confirmation.timing": { class: "safety", observed: "unobserved", rationale: "Incorrect confirmation timing can allow an unconfirmed external contract into implementation.", corpusCount: 0 },
  "confirmation.repository": { class: "safety", observed: "unobserved", rationale: "A missing affected repository can produce a wrong write boundary.", corpusCount: 0 },
  "confirmation.reference": { class: "safety", observed: "unobserved", rationale: "An unknown confirmation reference can hide an unconfirmed external contract.", corpusCount: 0 },
  "cross.unresolved-conflict": { class: "judgment", observed: "unobserved", rationale: "Reconciling competing shared literals is a cross-plan contract judgment.", corpusCount: 0 },
  "cross.repository-link": { class: "safety", observed: "unobserved", rationale: "A contract linked to a repository without an approved write can create a wrong scope.", corpusCount: 0 },
  "cross.dependency-order": { class: "judgment", observed: "unobserved", rationale: "Dependency ordering is a cross-plan implementation judgment.", corpusCount: 0 },
  "cross.dossier-path": { class: "judgment", observed: "unobserved", rationale: "Dossier-path linkage is a cross-plan handoff completeness check.", corpusCount: 0 },
  "cross.shared-literal": { class: "judgment", observed: "fired", rationale: "Shared-literal agreement is a cross-plan contract completeness check.", corpusCount: 4 },
  "cross.literal-shape": { class: "judgment", observed: "unobserved", rationale: "Literal shape is a cross-plan format check.", corpusCount: 0 },
  "scope-anchor.evidence": { class: "safety", observed: "not-replayable", rationale: "An unaudited no-change conclusion can exclude the correct repository.", corpusCount: 0 },
  "coordinator.repository-evaluations": { class: "safety", observed: "fired", rationale: "The coordinator must account for every selected repository.", corpusCount: 5 },
  "contract.canonical-identifier": { class: "judgment", observed: "unobserved", rationale: "Choosing one canonical identifier is a cross-plan contract judgment.", corpusCount: 0 },
  "dossier.edit-anchor": { class: "judgment", observed: "unobserved", rationale: "A useful edit location depends on the current repository structure.", corpusCount: 0 },
  "decision.scope-conflict": { class: "safety", observed: "unobserved", rationale: "A developer decision that contradicts source evidence can create a wrong scope.", corpusCount: 0 },
  "runtime.timeout": { class: "safety", observed: "not-replayable", rationale: "A timed-out provider has not established a bounded plan.", corpusCount: 0 },
  "runtime.spawn": { class: "safety", observed: "not-replayable", rationale: "A missing provider result has not established a bounded plan.", corpusCount: 0 },
};

export const VALIDATION_RULE_REGISTRY: readonly ValidationRuleRegistryEntry[] = VALIDATION_RULES.map((rule) => ({
  ...rule,
  ...RULE_METADATA[rule.id],
}));

export function classifyValidationMessage(message: string): RuleId {
  const normalized = message.trim();
  return VALIDATION_RULE_REGISTRY.find((rule) => rule.matches.some((pattern) => pattern.test(normalized)))?.id ?? "unclassified";
}
