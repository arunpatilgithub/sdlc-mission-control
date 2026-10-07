import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { additiveExtensionEvidence, applicabilityClaim, buildBehavioralReviewPrompt, canonicalizeContractLiteral, compactScoutFinding, composeCoordinatedPlan, composeCrossRepositoryContracts, detectDestinationColumnGaps, detectDestinationTableGaps, detectDivergentCrossRepositoryContracts, seedDerivedRequirementDecisions, dropResolvedDeveloperDecisions, hasBlockingPreDevelopDecision, hasBlockingPublishDecision, hasBlockingRepositoryBoundaryDecision, implementationRepositoryIds, normalizeNonBlockingCoordinatorDecisions, parseCoordinatorDecision, parseScoutPlanPacket, planDecisionKey, PlanningAgent, surfaceUnresolvedContractsAsDecisions, resolveSharedContracts, buildSharedContractFromAnswer, externalContractFromAnswer, injectResolvedContractsIntoDossier, registerColumnSetExtractor, parseBehavioralReview, parseCoordinatedPlan, parsePlannedPaths, parseRepoScope, parseReviewVerdict, recordApprovedPathsByRepository, recordApprovedPlannedPaths, recordSkippedTaskApproval, renderCoordinatedPlanOutput, resolvePlanningTimeoutSeconds, scanConfirmationDependencies, selectScoutFocusFiles, validateBlockingDecisionFacts, validateCrossRepositoryContracts, validateUnresolvedCrossRepositoryContracts, validateConfirmationDependencies, validatePlanningWorkspace, sharedContractContext, validatePreDevelopDecisions, type CoordinatedPlanContract, type CoordinatedRepositoryPlan, type PlanDecision, type ExecutionDossierEntry, type PlanJob } from "./planning-agent.js";
import { classifyDeveloperPlanAnswer } from "./plan-revision.js";

let runtimeRoot: string;
let previousRuntimeRoot: string | undefined;

beforeAll(() => {
  previousRuntimeRoot = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  runtimeRoot = mkdtempSync(join(tmpdir(), "planning-agent-approval-"));
  process.env.MISSION_CONTROL_RUNTIME_ROOT = runtimeRoot;
});

afterAll(() => {
  if (previousRuntimeRoot === undefined) delete process.env.MISSION_CONTROL_RUNTIME_ROOT;
  else process.env.MISSION_CONTROL_RUNTIME_ROOT = previousRuntimeRoot;
  rmSync(runtimeRoot, { recursive: true, force: true });
});

describe("resolvePlanningTimeoutSeconds", () => {
  it("uses longer defaults for coordinated multi-repository planning", () => {
    expect(resolvePlanningTimeoutSeconds(undefined, 1)).toBe(180);
    expect(resolvePlanningTimeoutSeconds(undefined, 2)).toBe(300);
    expect(resolvePlanningTimeoutSeconds(undefined, 1, "deep")).toBe(600);
    expect(resolvePlanningTimeoutSeconds(undefined, 3, "deep")).toBe(600);
    expect(resolvePlanningTimeoutSeconds(undefined, 1, "extreme")).toBe(900);
  });

  it("accepts bounded overrides and rejects unsafe values", () => {
    expect(resolvePlanningTimeoutSeconds(600, 2)).toBe(600);
    expect(() => resolvePlanningTimeoutSeconds(59, 1)).toThrow(/between 60 and 900/);
    expect(() => resolvePlanningTimeoutSeconds(901, 1)).toThrow(/between 60 and 900/);
  });
});

describe("planning watchdog attempts", () => {
  it("does not allow an initial attempt deadline to terminate a later revision", () => {
    vi.useFakeTimers();
    try {
      const job = {
        id: "revision-watchdog",
        status: "running",
        provider: "codex",
        planningTimeoutSeconds: 60,
        planningAttempt: 0,
        repositoryIds: ["Runtime", "Portal"],
      } as unknown as PlanJob;
      const agent = new PlanningAgent() as unknown as { armPlanningWatchdog(job: PlanJob): number };

      expect(agent.armPlanningWatchdog(job)).toBe(1);
      vi.advanceTimersByTime(30_000);
      expect(agent.armPlanningWatchdog(job)).toBe(2);

      vi.advanceTimersByTime(105_000);
      expect(job.status).toBe("running");
      expect(job.planningAttempt).toBe(2);

      vi.advanceTimersByTime(30_000);
      expect(job.status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("validatePlanningWorkspace", () => {
  it("refuses a disposable Develop worktree as Planning input", () => {
    expect(() => validatePlanningWorkspace({ id: "Portal", scm: "azure-devops", localPath: "/tmp/integration", remoteUrl: "https://example.test/portal", integrationBranch: "main" }, "/tmp/.worktrees/portal-feature", "implementation-plan"))
      .toThrow("Planning must use the configured integration checkout");
  });
});

describe("compactScoutFinding", () => {
  it("passes only the bounded structured scout contract to coordination", () => {
    const output = `notes\n\`\`\`json\n${JSON.stringify({ repositoryId: "Publisher.Portal", scopeDisposition: "changes-required", evidence: Array.from({ length: 12 }, (_, index) => `src/file${index}.js:${index}`), plannedPaths: ["src/Pixels.js"], implementationSteps: ["Add the pixel type"], contracts: ["Use the same discriminator as the handler"] })}\n\`\`\``;
    const compact = JSON.parse(compactScoutFinding(output)) as { evidence: string[]; plannedPaths: string[]; implementationSteps: string[] };

    expect(compact.evidence).toHaveLength(4);
    expect(compact.plannedPaths).toEqual(["src/Pixels.js"]);
    expect(compact.implementationSteps).toEqual(["Add the pixel type"]);
  });

  it("excludes completion prose and local dossiers from coordinator input", () => {
    const output = `\`\`\`json
${JSON.stringify({ repositoryId: "Publisher.Portal", completion: { outcome: "direct-path-confirmed", basis: "Campaign Pixels owns the template." }, executionDossier: [{ path: "src/Pixels.js" }], unresolved: ["Confirm one direct dispatch edge"], contracts: ["discarded"], risks: ["discarded"] })}
\`\`\``;
    const compact = JSON.parse(compactScoutFinding(output)) as { completion?: unknown; executionDossier?: unknown; unresolved?: unknown; contracts?: unknown; risks?: unknown };

    expect(compact).not.toHaveProperty("completion");
    expect(compact).not.toHaveProperty("executionDossier");
    expect(compact).not.toHaveProperty("unresolved");
    expect(compact).not.toHaveProperty("contracts");
    expect(compact).not.toHaveProperty("risks");
  });

  it("bounds a legacy prose scout instead of forwarding its full report", () => {
    expect(compactScoutFinding("x".repeat(9_000))).toHaveLength(2_000);
  });

  it("preserves source-confirmed and source-unresolved facts for coordination", () => {
    const output = '```json\n{"repositoryId":"Publisher.MicroService.PostbackHandler","confirmedFacts":[{"id":"timestamp-token","statement":"The token is milliseconds.","evidence":["src/Handler.js:471"]}],"unresolvedFacts":[{"id":"event-id","statement":"The stable identifier is not established.","evidence":["src/Handler.js:457"]}]}\n```';
    const compact = JSON.parse(compactScoutFinding(output)) as { confirmedFacts: Array<{ id: string }>; unresolvedFacts: Array<{ id: string }> };

    expect(compact.confirmedFacts).toEqual([expect.objectContaining({ id: "timestamp-token" })]);
    expect(compact.unresolvedFacts).toEqual([expect.objectContaining({ id: "event-id" })]);
  });

  it("preserves bounded source-backed sibling conventions without leaking local dossiers", () => {
    const output = '```json\n{"repositoryId":"Runtime","establishedConventions":[{"id":"scheduled-loader-cadence","subject":"scheduled loader cadence","value":"rate(5 minutes)","evidence":["template.yaml:42","template.yaml:96"]}],"executionDossier":[{"path":"template.yaml","requiredSourceFragments":["rate(5 minutes)"]}]}\n```';
    const compact = JSON.parse(compactScoutFinding(output)) as { establishedConventions: Array<{ id: string; value: string }>; executionDossier?: unknown };

    expect(compact.establishedConventions).toEqual([{ id: "scheduled-loader-cadence", subject: "scheduled loader cadence", value: "rate(5 minutes)", evidence: ["template.yaml:42", "template.yaml:96"] }]);
    expect(compact).not.toHaveProperty("executionDossier");
  });
});

describe("coordinated scout-packet composition", () => {
  const scout = (repositoryId: string, path: string, role: "runtime-owner" | "contract-mirror", extra: Record<string, unknown> = {}) => parseScoutPlanPacket(`\`\`\`json
${JSON.stringify({
    repositoryId,
    scopeDisposition: "changes-required",
    applicability: { role, storyBinding: "The requested contract", routeOrDependency: "The current extension point owns the requested behavior.", evidence: [`${path}:1`] },
    evidence: [`${path}:1`],
    confirmedFacts: [{ id: "owner", statement: "The extension point owns the requested behavior.", evidence: [`${path}:1`] }],
    unresolvedFacts: [],
    plannedPaths: [path],
    implementationSteps: ["Extend the current implementation with the requested contract."],
    executionDossier: [{ path, change: "Extend the current implementation with the requested contract.", anchors: [`${path}:1`], requiredSourceFragments: ["required literal"], writeRole: role, newFile: false, testScenarios: [] }],
    ...extra,
  })}
\`\`\``, repositoryId);

  it("rejects a scout packet that omits regression coverage for runtime behavior", () => {
    const packet = parseScoutPlanPacket(`\`\`\`json
${JSON.stringify({
      repositoryId: "Runtime",
      completion: { outcome: "direct-path-confirmed", basis: "The registry owns the requested behavior.", handoffDependencies: [] },
      scopeDisposition: "changes-required",
      applicability: { role: "runtime-owner", storyBinding: "The requested vendor event", routeOrDependency: "The registry selects dispatched event types.", evidence: ["src/PixelTypes.js:11"] },
      evidence: ["src/PixelTypes.js:11"],
      confirmedFacts: [],
      unresolvedFacts: [],
      establishedConventions: [],
      plannedPaths: ["src/PixelTypes.js"],
      implementationSteps: ["Register the requested vendor event type."],
      executionDossier: [{ path: "src/PixelTypes.js", change: "Register the requested vendor event type.", anchors: ["src/PixelTypes.js:11"], requiredSourceFragments: ["VendorConversion"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
      validationCommands: [],
    })}
\`\`\``, "Runtime", { testPaths: ["test/runtime.test.js"] });

    expect(packet.parseError).toContain("must include a planned test path with expected assertions");
  });

  it("rejects unresolved ownership prose from an executable implementation step", () => {
    const packet = scout("Runtime", "src/PixelTypes.js", "runtime-owner", {
      implementationSteps: ["NEEDS VERIFICATION: identify the configuration-owning repository before registering the event type."],
    });

    expect(packet.parseError).toContain("implementationSteps must describe executable repository-local changes");
  });

  it("routes an incomplete direct-path scout to its repository-local repair before coordination", () => {
    const packet = scout("Runtime", "src/runtime.js", "runtime-owner", {
      completion: { outcome: "needs-targeted-follow-up", basis: "Read the direct worker mapping before defining the local handoff." },
    });

    expect(packet.parseError).toMatch(/stopped before its direct implementation path was confirmed/);
    expect(packet.plannedPaths).toEqual(["src/runtime.js"]);
  });

  it("keeps a proven local extension when a different repository owns the remaining configuration", () => {
    const packet = scout("PostbackHandler", "src/PixelTypes.js", "runtime-owner", {
      completion: {
        outcome: "local-extension-confirmed",
        basis: "The registry and payload allowlist own the local event-type extension.",
        handoffDependencies: [{
          ownerRepositoryId: "Publisher.Portal",
          unresolvedFactId: "campaign-pixel-provisioning",
          reason: "Campaign pixel configuration is persisted by the portal.",
        }],
      },
      unresolvedFacts: [{
        id: "campaign-pixel-provisioning",
        statement: "Current service source does not own campaign pixel persistence.",
        evidence: ["src/Handler.js:1"],
      }],
    });

    expect(packet.parseError).toBeNull();
    expect(packet.scopeDisposition).toBe("changes-required");
    expect(packet.completion).toMatchObject({
      outcome: "local-extension-confirmed",
      handoffDependencies: [{ ownerRepositoryId: "Publisher.Portal", unresolvedFactId: "campaign-pixel-provisioning" }],
    });
  });

  it("rejects a local-extension handoff that does not name a different repository-owned unresolved fact", () => {
    const packet = scout("PostbackHandler", "src/PixelTypes.js", "runtime-owner", {
      completion: {
        outcome: "local-extension-confirmed",
        basis: "The registry is locally owned.",
        handoffDependencies: [{ ownerRepositoryId: "PostbackHandler", unresolvedFactId: "missing", reason: "Invalid self handoff." }],
      },
    });

    expect(packet.parseError).toMatch(/different owner and a cited unresolved fact/);
  });

  it("keeps validated file-level contracts from scouts while coordination adds only dependency decisions", () => {
    const packets = {
      Runtime: scout("Runtime", "src/runtime.js", "runtime-owner"),
      Documentation: scout("Documentation", "docs/openai.md", "contract-mirror"),
    };
    const decision = parseCoordinatorDecision(`\`\`\`json
${JSON.stringify({
      repositoryEvaluations: [
        { id: "Runtime", scopeDisposition: "changes-required", applicability: packets.Runtime.applicability, evidence: ["src/runtime.js:1"], rationale: "Owns dispatch.", dependsOn: [] },
        { id: "Documentation", scopeDisposition: "changes-required", applicability: packets.Documentation.applicability, evidence: ["docs/openai.md:1"], rationale: "Mirrors the shipped contract.", dependsOn: ["Runtime"] },
      ],
      implementationOrder: ["Runtime", "Documentation"],
      crossRepositoryContracts: [{ concept: "event type", literalKind: "event type", sourceRepositoryId: "Runtime", sourcePath: "src/runtime.js", sharedLiteral: "required literal", consumerRepositoryId: "Documentation", consumerPath: "docs/openai.md", reason: "Documentation mirrors the runtime contract." }],
      suggestedRepositories: [], decisionRequests: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
    })}
\`\`\``, ["Runtime", "Documentation"]);

    const composed = composeCoordinatedPlan(decision, packets, ["Runtime", "Documentation"]);

    expect(composed.parseError).toBeNull();
    expect(composed.repositories[0]).toMatchObject({
      id: "Runtime",
      plannedPaths: ["src/runtime.js"],
      executionDossier: [{ path: "src/runtime.js", requiredSourceFragments: ["required literal"] }],
    });
    expect(composed.repositories[1]).toMatchObject({
      id: "Documentation",
      dependsOn: ["Runtime"],
      executionDossier: [{ path: "docs/openai.md", requiredSourceFragments: ["required literal"] }],
    });
  });

  it("preserves scout-owned route evidence when coordination compresses its evaluation", () => {
    const packet = scout("Runtime", "src/PixelTypes.js", "runtime-owner", {
      applicability: {
        role: "runtime-owner",
        storyBinding: "The named conversion event.",
        routeOrDependency: "The configured pixel selection function loads matching campaign pixels.",
        evidence: ["src/Handler.js:842-875"],
      },
      evidence: ["src/PixelTypes.js:11", "src/Handler.js:842-875"],
    });
    const decision = parseCoordinatorDecision(`\`\`\`json
${JSON.stringify({
      repositoryEvaluations: [{
        id: "Runtime",
        scopeDisposition: "changes-required",
        applicability: {
          role: "runtime-owner",
          storyBinding: "The named conversion event.",
          routeOrDependency: "The configured pixel selection function loads matching campaign pixels.",
          evidence: ["test/runtime.test.js:1"],
        },
        evidence: ["test/runtime.test.js:1"],
        rationale: "Owns dispatch.",
        dependsOn: [],
      }],
      implementationOrder: ["Runtime"], crossRepositoryContracts: [], suggestedRepositories: [], decisionRequests: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
    })}
\`\`\``, ["Runtime"]);

    const composed = composeCoordinatedPlan(decision, { Runtime: packet }, ["Runtime"]);

    expect(composed.repositories[0]).toMatchObject({
      evidence: ["src/PixelTypes.js:11", "src/Handler.js:842-875"],
      applicability: { evidence: ["src/Handler.js:842-875"] },
    });
  });

  it("rejects a coordinator scope that conflicts with the validated repository-local conclusion", () => {
    const packet = scout("Runtime", "src/runtime.js", "runtime-owner");
    const decision = parseCoordinatorDecision(`\`\`\`json
${JSON.stringify({
      repositoryEvaluations: [{ id: "Runtime", scopeDisposition: "verified-no-change", applicability: packet.applicability, evidence: ["src/runtime.js:1"], rationale: "Incorrectly scoped out.", dependsOn: [] }],
      implementationOrder: [], suggestedRepositories: [], decisionRequests: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
    })}
\`\`\``, ["Runtime"]);

    const composed = composeCoordinatedPlan(decision, { Runtime: packet }, ["Runtime"]);

    expect(composed.parseError).toMatch(/conflicts with validated scout scope/);
    expect(composed.repositories[0]?.scopeDisposition).toBe("unverified");
  });

  it("keeps an evidence-backed scope-out non-executable when a scout includes exploratory follow-up steps", () => {
    const packet = parseScoutPlanPacket(`\`\`\`json
${JSON.stringify({
      repositoryId: "Publisher.Portal.MoneyBadger",
      scopeDisposition: "verified-no-change",
      applicability: {
        role: "capability-only",
        storyBinding: "The repository is a UI-only candidate, not the scheduled ingestion owner.",
        routeOrDependency: "The current source has no runtime ingestion or persistence route.",
        evidence: ["README.md:3"],
      },
      evidence: ["README.md:3", "Pipeline/template.yml:1"],
      plannedPaths: ["README.md"],
      implementationSteps: ["Inspect the runtime repository for the implementation owner."],
      executionDossier: [{ path: "README.md", change: "Do not write this file." }],
      verificationCommands: [{ command: "npm test", purpose: "Exploratory validation" }],
      confirmedFacts: [{ id: "ui-only", statement: "The repository is UI-only.", evidence: ["README.md:3"] }],
      unresolvedFacts: [],
    })}
\`\`\``, "Publisher.Portal.MoneyBadger");

    expect(packet).toMatchObject({
      scopeDisposition: "verified-no-change",
      plannedPaths: [],
      implementationSteps: [],
      executionDossier: [],
      verificationCommands: [],
      parseError: null,
    });
    expect(packet.normalizationNotes).toEqual([expect.stringContaining("implementationSteps")]);
  });

  it("still rejects a scope-out that lacks current-source evidence", () => {
    const packet = parseScoutPlanPacket(`\`\`\`json
${JSON.stringify({
      repositoryId: "Placeholder",
      scopeDisposition: "verified-no-change",
      applicability: { role: "unknown", storyBinding: "", routeOrDependency: "", evidence: [] },
      evidence: [],
      plannedPaths: [],
      implementationSteps: [],
      executionDossier: [],
      verificationCommands: [],
      confirmedFacts: [],
      unresolvedFacts: [],
    })}
\`\`\``, "Placeholder");

    expect(packet.parseError).toBe("verified-no-change requires current-source evidence.");
  });

  it("carries a repeated sibling default into the executable packet", () => {
    const packet = scout("Runtime", "template.yaml", "runtime-owner", {
      implementationSteps: ["Create the scheduled loader using rate(5 minutes)."],
      executionDossier: [{ path: "template.yaml", change: "Create the scheduled loader using the established rate(5 minutes) default.", anchors: ["template.yaml:1"], requiredSourceFragments: ["rate(5 minutes)"], adoptedConventionIds: ["scheduled-loader-cadence"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
      establishedConventions: [{ id: "scheduled-loader-cadence", subject: "scheduled loader cadence", value: "rate(5 minutes)", evidence: ["template.yaml:42", "template.yaml:96"] }],
    });

    expect(packet.parseError).toBeNull();
    expect(packet.establishedConventions).toEqual([expect.objectContaining({ id: "scheduled-loader-cadence", value: "rate(5 minutes)" })]);
  });

  it("records a carried platform documentation convention without a repair", () => {
    const packet = scout("Documentation", "index.md", "contract-mirror", {
      implementationSteps: ["Add the platform summary beside the existing vendor entries."],
      executionDossier: [{ path: "index.md", change: "Add the platform summary using the established API section shape.", anchors: ["index.md:148"], requiredSourceFragments: ["- **HTTP Method:** POST"], writeRole: "contract-mirror", newFile: false, testScenarios: [] }],
      establishedConventions: [{ id: "platform-api-section-shape", subject: "per-type server-side vendor documentation structure", value: "- **HTTP Method:** POST; #### 💻 Implementation Examples; **JSON Payload:**", evidence: ["Server-Side.md:133", "Server-Side.md:245"] }],
    });

    expect(packet.parseError).toBeNull();
    expect(packet.executionDossier[0]?.adoptedConventionIds).toEqual(["platform-api-section-shape"]);
    expect(packet.normalizationNotes).toContain("Recorded adopted established convention for index.md: platform-api-section-shape.");
  });

  it("records a carried revenue event-hub convention for its regression test", () => {
    const packet = scout("PostbackHandler", "test/ChatGPTConversion.test.js", "runtime-owner", {
      implementationSteps: ["Extend the ChatGPT conversion regression coverage for the revenue registrations."],
      executionDossier: [{ path: "test/ChatGPTConversion.test.js", change: "Add the ChatGPT revenue regression coverage.", anchors: ["test/ChatGPTConversion.test.js:4"], requiredSourceFragments: ["ChatGPTRevenue", "POST", "publisherrevenue", "unaccountedrevenue", "exchangerevenue"], writeRole: "test", newFile: false, testScenarios: [{ name: "Assert the registered revenue routes.", fixtures: [], assertions: ["Assert the registered revenue routes."] }] }],
      establishedConventions: [{ id: "revenue-eventhub-registration", subject: "revenue pixel routing", value: "POST; publisherrevenue; unaccountedrevenue; exchangerevenue", evidence: ["src/PixelTypes.js:126", "src/PixelTypes.js:146"] }],
    });

    expect(packet.parseError).toBeNull();
    expect(packet.executionDossier[0]?.adoptedConventionIds).toEqual(["revenue-eventhub-registration"]);
    expect(packet.normalizationNotes).toContain("Recorded adopted established convention for test/ChatGPTConversion.test.js: revenue-eventhub-registration.");
  });

  it("leaves a fragment without a declared convention unchanged", () => {
    const packet = scout("Runtime", "template.yaml", "runtime-owner", {
      executionDossier: [{ path: "template.yaml", change: "Add the requested vendor schedule.", anchors: ["template.yaml:1"], requiredSourceFragments: ["vendorLabel: ChatGPT"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
      establishedConventions: [{ id: "scheduled-loader-cadence", subject: "scheduled loader cadence", value: "rate(5 minutes)", evidence: ["template.yaml:42", "template.yaml:96"] }],
    });

    expect(packet.parseError).toMatch(/must carry cited default literal/);
    expect(packet.executionDossier[0]?.requiredSourceFragments).toEqual(["vendorLabel: ChatGPT"]);
    expect(packet.executionDossier[0]?.adoptedConventionIds).toBeUndefined();
    expect(packet.normalizationNotes).not.toContain(expect.stringContaining("Recorded adopted established convention"));
  });

  it("accepts an aligned unquoted SQL convention literal", () => {
    const packet = scout("Data", "MEDIA/TABLE/TRAFFIC_OPENAI_AD_COST.sql", "contract-mirror", {
      implementationSteps: ["Add the shared vendor column."],
      executionDossier: [{ path: "MEDIA/TABLE/TRAFFIC_OPENAI_AD_COST.sql", change: "Add the shared vendor column.", anchors: ["MEDIA/TABLE/TRAFFIC_OPENAI_AD_COST.sql:1"], requiredSourceFragments: ["QW_VENDOR               VARCHAR(50)"], adoptedConventionIds: ["vendor-column"], writeRole: "contract-mirror", newFile: true, testScenarios: [] }],
      establishedConventions: [{ id: "vendor-column", subject: "shared platform cost-table vendor column", value: "QW_VENDOR VARCHAR(50)", evidence: ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1", "MEDIA/TABLE/TRAFFIC_GOOGLE_ADGROUP_COST.sql:1"] }],
    });

    expect(packet.parseError).toBeNull();
  });

  it("does not normalize whitespace in a quoted scalar convention", () => {
    const packet = scout("Runtime", "template.yaml", "runtime-owner", {
      implementationSteps: ["Configure the vendor label."],
      executionDossier: [{ path: "template.yaml", change: "Configure the vendor label.", anchors: ["template.yaml:1"], requiredSourceFragments: ["vendorLabel: 'ChatGPT  Ads'"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
      establishedConventions: [{ id: "vendor-label", subject: "vendor label", value: "vendorLabel: 'ChatGPT Ads'", evidence: ["template.yaml:42", "template.yaml:96"] }],
    });

    expect(packet.parseError).toMatch(/must carry cited default literal/);
  });

  it("accepts an equivalent JSON key/value fragment for a YAML-style convention", () => {
    const packet = scout("Runtime", "template.yaml", "runtime-owner", {
      implementationSteps: ["Create the scheduled loader."],
      executionDossier: [{ path: "template.yaml", change: "Add the incremental event input.", anchors: ["template.yaml:1"], requiredSourceFragments: ["\"lookbackDays\":7"], adoptedConventionIds: ["scheduled-incremental-lookback"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
      establishedConventions: [{ id: "scheduled-incremental-lookback", subject: "scheduled incremental lookback", value: "lookbackDays: 7", evidence: ["template.yaml:42", "template.yaml:96"] }],
    });

    expect(packet.parseError).toBeNull();
  });

  it("does not accept a different convention value through formatting normalization", () => {
    const packet = scout("Runtime", "template.yaml", "runtime-owner", {
      implementationSteps: ["Create the scheduled loader."],
      executionDossier: [{ path: "template.yaml", change: "Add the incremental event input.", anchors: ["template.yaml:1"], requiredSourceFragments: ["\"lookbackDays\":70"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
      establishedConventions: [{ id: "scheduled-incremental-lookback", subject: "scheduled incremental lookback", value: "lookbackDays: 7", evidence: ["template.yaml:42", "template.yaml:96"] }],
    });

    expect(packet.parseError).toMatch(/must carry cited default literal/);
  });

  it("carries every source literal in a compound sibling convention", () => {
    const packet = scout("Runtime", "template.yaml", "runtime-owner", {
      implementationSteps: ["Create the scheduled loader."],
      executionDossier: [{ path: "template.yaml", change: "Add the incremental event input.", anchors: ["template.yaml:1"], requiredSourceFragments: ["RECORD_ID VARCHAR(64) NOT NULL", "UPDATED_TIMESTAMP TIMESTAMP_NTZ"], adoptedConventionIds: ["audit-columns"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
      establishedConventions: [{ id: "audit-columns", subject: "shared audit columns", value: "RECORD_ID VARCHAR(64) NOT NULL; UPDATED_TIMESTAMP TIMESTAMP_NTZ", evidence: ["template.yaml:42", "template.yaml:96"] }],
    });

    expect(packet.parseError).toBeNull();
  });

  it("carries a missing non-conflicting compound default into Develop's handoff", () => {
    const packet = scout("Runtime", "template.yaml", "runtime-owner", {
      implementationSteps: ["Create the scheduled loader."],
      executionDossier: [{ path: "template.yaml", change: "Add the incremental event input.", anchors: ["template.yaml:1"], requiredSourceFragments: ["RECORD_ID VARCHAR(64) NOT NULL"], adoptedConventionIds: ["audit-columns"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
      establishedConventions: [{ id: "audit-columns", subject: "shared audit columns", value: "RECORD_ID VARCHAR(64) NOT NULL; UPDATED_TIMESTAMP TIMESTAMP_NTZ", evidence: ["template.yaml:42", "template.yaml:96"] }],
    });

    expect(packet.parseError).toBeNull();
    expect(packet.executionDossier[0]?.requiredSourceFragments).toContain("UPDATED_TIMESTAMP TIMESTAMP_NTZ");
    expect(packet.normalizationNotes).toContain("Carried 1 source-cited convention default into template.yaml.");
  });

  it("carries each missing boolean from an adopted bearer JSON convention", () => {
    const packet = scout("Portal", "src/Pixels.js", "runtime-owner", {
      implementationSteps: ["Add the ChatGPT conversion template."],
      executionDossier: [{
        path: "src/Pixels.js",
        change: "Add the ChatGPT conversion template using the bearer JSON postback convention.",
        anchors: ["src/Pixels.js:1"],
        requiredSourceFragments: ["ChatGPTConversion", "{ \"Content-Type\": \"application/json\", \"Authorization\": \"Bearer {TOKEN}\" }"],
        adoptedConventionIds: ["bearer-json-postback"],
        writeRole: "runtime-owner",
        newFile: false,
        testScenarios: [],
      }],
      establishedConventions: [{
        id: "bearer-json-postback",
        subject: "Bearer-authenticated server-side conversion template",
        value: "headerRequired: true; payloadRequired: true; postbackPixel: true; { \"Content-Type\": \"application/json\", \"Authorization\": \"Bearer {TOKEN}\" }",
        evidence: ["src/Pixels.js:11", "src/Pixels.js:22"],
      }],
    });

    expect(packet.parseError).toBeNull();
    expect(packet.executionDossier[0]?.requiredSourceFragments).toEqual(expect.arrayContaining([
      "headerRequired: true",
      "payloadRequired: true",
      "postbackPixel: true",
    ]));
  });

  it("rejects a required fragment that glues defaults from separate established conventions", () => {
    const packet = scout("Data", "MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql", "contract-mirror", {
      implementationSteps: ["Create the platform cost table."],
      executionDossier: [{
        path: "MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql",
        change: "Create the platform cost table using established columns and ownership comment.",
        anchors: ["MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql:1"],
        requiredSourceFragments: ["UPDATED_TIMESTAMP TIMESTAMP_NTZ; CREATED_TIMESTAMP TIMESTAMP_NTZ(9) DEFAULT SYSDATE(); Owned by Money Badger/Publisher."],
        adoptedConventionIds: ["audit-columns", "ownership-comment"],
        writeRole: "contract-mirror",
        newFile: true,
        testScenarios: [],
      }],
      establishedConventions: [
        { id: "audit-columns", subject: "shared audit columns", value: "UPDATED_TIMESTAMP TIMESTAMP_NTZ; CREATED_TIMESTAMP TIMESTAMP_NTZ(9) DEFAULT SYSDATE()", evidence: ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1", "MEDIA/TABLE/TRAFFIC_GOOGLE_AD_COST.sql:1"] },
        { id: "ownership-comment", subject: "scheduled platform cost-loader ownership", value: "Owned by Money Badger/Publisher.", evidence: ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:2", "MEDIA/TABLE/TRAFFIC_GOOGLE_AD_COST.sql:2"] },
      ],
    });

    expect(packet.parseError).toMatch(/must not concatenate defaults from multiple established conventions/);
  });

  it("rejects a dossier entry that names an unknown established convention", () => {
    const packet = scout("Runtime", "template.yaml", "runtime-owner", {
      executionDossier: [{ path: "template.yaml", change: "Create the scheduled loader with the source default.", anchors: ["template.yaml:1"], requiredSourceFragments: ["rate(5 minutes)"], adoptedConventionIds: ["missing-convention"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
    });

    expect(packet.parseError).toMatch(/adopts unknown established convention ids/);
  });

  it("requires explicit semantics when a planned contract persists a temporal bucket", () => {
    const packet = scout("Data", "MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql", "contract-mirror", {
      executionDossier: [{
        path: "MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql",
        change: "Create the daily advertising-cost table with a reporting-hour column.",
        anchors: ["MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql:1"],
        requiredSourceFragments: ["HOUR NUMBER"],
        writeRole: "contract-mirror",
        newFile: true,
        testScenarios: [],
      }],
    });

    expect(packet.parseError).toMatch(/must state fieldSemantics for temporal bucket fields: HOUR/);
  });

  it("accepts an explicit temporal-bucket semantic in the repository-local handoff", () => {
    const packet = scout("Data", "MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql", "contract-mirror", {
      executionDossier: [{
        path: "MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql",
        change: "Create the daily advertising-cost table with a reporting-hour column.",
        anchors: ["MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql:1"],
        requiredSourceFragments: ["HOUR NUMBER"],
        fieldSemantics: [{ field: "HOUR", behavior: "Daily rows persist HOUR as zero." }],
        writeRole: "contract-mirror",
        newFile: true,
        testScenarios: [],
      }],
    });

    expect(packet.parseError).toBeNull();
  });

  it("rejects a sibling default that is not passed to Develop", () => {
    const packet = scout("Runtime", "template.yaml", "runtime-owner", {
      establishedConventions: [{ id: "scheduled-loader-cadence", subject: "scheduled loader cadence", value: "rate(5 minutes)", evidence: ["template.yaml:42", "template.yaml:96"] }],
    });

    expect(packet.parseError).toMatch(/must carry cited default literal/);
  });

  it("gates an unbound cross-repository handoff onto an in-mission owner as a blocking shared-contract decision", () => {
    const owner = scout("Data", "MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql", "contract-mirror", {
      executionDossier: [{ path: "MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql", change: "Create the advertising-cost table.", anchors: ["MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql:1"], requiredSourceFragments: ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST"], writeRole: "contract-mirror", newFile: true, testScenarios: [] }],
    });
    const consumer = scout("Loader", "src/registry.js", "runtime-owner", {
      completion: { outcome: "local-extension-confirmed", basis: "The registry owns local platform selection.", handoffDependencies: [{ ownerRepositoryId: "Data", unresolvedFactId: "snowflake-table-identifier", reason: "The registry tableName must exactly match the MEDIA table deployed by Data." }] },
      unresolvedFacts: [{ id: "snowflake-table-identifier", statement: "destination table", evidence: ["src/registry.js:1"] }],
      executionDossier: [{ path: "src/registry.js", change: "Use the destination table.", anchors: ["src/registry.js:1"], requiredSourceFragments: ["MEDIA.TRAFFIC_CHATGPT_AD_COST"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
    });
    const decision = parseCoordinatorDecision(`\`\`\`json
${JSON.stringify({
      repositoryEvaluations: [
        { id: "Data", scopeDisposition: "changes-required", applicability: owner.applicability, evidence: ["MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql:1"], rationale: "Deploys the table.", dependsOn: [] },
        { id: "Loader", scopeDisposition: "changes-required", applicability: consumer.applicability, evidence: ["src/registry.js:1"], rationale: "Loads into the table.", dependsOn: ["Data"] },
      ],
      implementationOrder: ["Data", "Loader"], crossRepositoryContracts: [], suggestedRepositories: [], decisionRequests: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
    })}
\`\`\``, ["Data", "Loader"]);

    const composed = composeCoordinatedPlan(decision, { Data: owner, Loader: consumer }, ["Data", "Loader"]);
    const gate = composed.decisionRegister.find((entry) => entry.impact === "shared-contract");

    expect(composed.parseError).toBeNull();
    expect(gate).toBeDefined();
    expect(gate?.alternatives).toEqual(["MEDIA.TRAFFIC_CHATGPT_AD_COST"]);
    expect(gate?.unresolvedFactRefs).toEqual(["Loader#snowflake-table-identifier"]);
    expect(gate?.affectedRepositoryIds).toEqual(["Data", "Loader"]);
    expect(gate?.sharedContractSlot?.literalKind).toBe("table name");
    expect(hasBlockingPreDevelopDecision(composed.decisionRegister)).toBe(true);
    expect(hasBlockingPreDevelopDecision(normalizeNonBlockingCoordinatorDecisions(composed).decisionRegister)).toBe(true);
  });

  it("leaves a sentence-like handoff fact unresolved instead of creating a shared-contract decision", () => {
    const owner = scout("Publisher.MicroService.PostbackHandler", "src/PixelTypes.js", "runtime-owner", {
      executionDossier: [{ path: "src/PixelTypes.js", change: "Register the revenue event type.", anchors: ["src/PixelTypes.js:1"], requiredSourceFragments: ["ChatGPTRevenue"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
    });
    const consumer = scout("Publisher.Portal", "src/components/Campaigns/Detail/Pixels.js", "runtime-owner", {
      completion: { outcome: "local-extension-confirmed", basis: "The campaign pixel template owns local configuration.", handoffDependencies: [{ ownerRepositoryId: "Publisher.MicroService.PostbackHandler", unresolvedFactId: "portal-revenue-template-identifier", reason: "Portal revenue templates expose the runtime revenue identifier." }] },
      unresolvedFacts: [{ id: "portal-revenue-template-identifier", statement: "Portal revenue templates expose\n… [bounded for coordination] …\nthe runtime identifier selected by the conversion handler.", evidence: ["src/components/Campaigns/Detail/Pixels.js:1"] }],
    });
    const decision = parseCoordinatorDecision(`\`\`\`json
${JSON.stringify({
      repositoryEvaluations: [
        { id: "Publisher.MicroService.PostbackHandler", scopeDisposition: "changes-required", applicability: owner.applicability, evidence: ["src/PixelTypes.js:1"], rationale: "Registers the runtime event type.", dependsOn: [] },
        { id: "Publisher.Portal", scopeDisposition: "changes-required", applicability: consumer.applicability, evidence: ["src/components/Campaigns/Detail/Pixels.js:1"], rationale: "Persists the campaign template.", dependsOn: ["Publisher.MicroService.PostbackHandler"] },
      ],
      implementationOrder: ["Publisher.MicroService.PostbackHandler", "Publisher.Portal"], crossRepositoryContracts: [], suggestedRepositories: [], decisionRequests: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
    })}
\`\`\``, ["Publisher.MicroService.PostbackHandler", "Publisher.Portal"]);

    const composed = composeCoordinatedPlan(decision, {
      "Publisher.MicroService.PostbackHandler": owner,
      "Publisher.Portal": consumer,
    }, ["Publisher.MicroService.PostbackHandler", "Publisher.Portal"]);
    const gate = composed.decisionRegister.find((entry) => entry.impact === "shared-contract");

    expect(gate).toBeUndefined();
    expect(consumer.unresolvedFacts).toEqual([expect.objectContaining({ id: "portal-revenue-template-identifier" })]);
  });

  it("retains the two monetary decisions while omitting the two sentence-like shared-contract cards", () => {
    const runtime = scout("Publisher.MicroService.PostbackHandler", "src/PixelTypes.js", "runtime-owner", {
      executionDossier: [{ path: "src/PixelTypes.js", change: "Register the revenue event type.", anchors: ["src/PixelTypes.js:1"], requiredSourceFragments: ["ChatGPTRevenue", "publisherrevenue", "unaccountedrevenue", "exchangerevenue"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
      unresolvedFacts: [
        { id: "minor-unit-value-source", statement: "Current source does not establish an integer minor-unit revenue source.", evidence: ["src/Handler.js:457"] },
        { id: "currency-value-source", statement: "Current source does not establish a currency source.", evidence: ["src/Handler.js:473"] },
      ],
    });
    const portal = scout("Publisher.Portal", "src/components/Campaigns/Detail/Pixels.js", "runtime-owner", {
      completion: { outcome: "local-extension-confirmed", basis: "The campaign registry owns the local entry.", handoffDependencies: [{ ownerRepositoryId: "Publisher.MicroService.PostbackHandler", unresolvedFactId: "monetary-token-contract", reason: "The runtime owner must establish how publisher revenue and currency become the OpenAI-required integer amount and ISO currency." }] },
      unresolvedFacts: [{ id: "monetary-token-contract", statement: "Current Portal revenue templates expose publisherrevenue but do not establish the required integer minor-unit amount and currency contract.", evidence: ["src/components/Campaigns/Detail/Pixels.js:190"] }],
    });
    const documentation = scout("publisher.documentation", "docs/Server-Side.md", "contract-mirror", {
      completion: { outcome: "local-extension-confirmed", basis: "The guide mirrors the runtime contract.", handoffDependencies: [{ ownerRepositoryId: "Publisher.MicroService.PostbackHandler", unresolvedFactId: "minor-unit-token-source", reason: "The runtime owner must establish the configured token or conversion before documentation can name it." }] },
      unresolvedFacts: [{ id: "minor-unit-token-source", statement: "Current documentation exposes publisherrevenue as an amount but does not establish an integer minor-unit token or conversion rule.", evidence: ["docs/Server-Side.md:92"] }],
    });
    const decision = parseCoordinatorDecision(`\`\`\`json
${JSON.stringify({
      repositoryEvaluations: [
        { id: "Publisher.MicroService.PostbackHandler", scopeDisposition: "changes-required", applicability: runtime.applicability, evidence: ["src/PixelTypes.js:1"], rationale: "Owns runtime dispatch.", dependsOn: [] },
        { id: "Publisher.Portal", scopeDisposition: "changes-required", applicability: portal.applicability, evidence: ["src/components/Campaigns/Detail/Pixels.js:1"], rationale: "Owns campaign configuration.", dependsOn: ["Publisher.MicroService.PostbackHandler"] },
        { id: "publisher.documentation", scopeDisposition: "changes-required", applicability: documentation.applicability, evidence: ["docs/Server-Side.md:1"], rationale: "Mirrors the delivered contract.", dependsOn: ["Publisher.MicroService.PostbackHandler"] },
      ],
      implementationOrder: ["Publisher.MicroService.PostbackHandler", "Publisher.Portal", "publisher.documentation"], crossRepositoryContracts: [], suggestedRepositories: [], decisionRequests: [],
      decisionRegister: [
        { question: "What configured token or upstream field supplies data.amount as an integer in the currency's standard minor unit?", recommendation: "Use an existing upstream-owned integer minor-unit value.", alternatives: [], requiredBefore: "develop", impact: "external-contract", affectedRepositoryIds: ["Publisher.MicroService.PostbackHandler", "Publisher.Portal", "publisher.documentation"], unresolvedFactRefs: ["Publisher.MicroService.PostbackHandler#minor-unit-value-source"], rationale: "Current source exposes only an unconverted revenue value." },
        { question: "What configured token or upstream field supplies data.currency for ChatGPT revenue events?", recommendation: "Use an existing upstream-owned ISO 4217 currency value.", alternatives: [], requiredBefore: "develop", impact: "external-contract", affectedRepositoryIds: ["Publisher.MicroService.PostbackHandler", "Publisher.Portal", "publisher.documentation"], unresolvedFactRefs: ["Publisher.MicroService.PostbackHandler#currency-value-source"], rationale: "Current source does not establish a currency source." },
      ], operationalFollowUps: [], outOfScopeFollowUps: [],
    })}
\`\`\``, ["Publisher.MicroService.PostbackHandler", "Publisher.Portal", "publisher.documentation"]);

    const composed = composeCoordinatedPlan(decision, {
      "Publisher.MicroService.PostbackHandler": runtime,
      "Publisher.Portal": portal,
      "publisher.documentation": documentation,
    }, ["Publisher.MicroService.PostbackHandler", "Publisher.Portal", "publisher.documentation"]);

    expect(composed.decisionRegister.map((entry) => entry.question)).toEqual([
      "What configured token or upstream field supplies data.amount as an integer in the currency's standard minor unit?",
      "What configured token or upstream field supplies data.currency for ChatGPT revenue events?",
    ]);
    expect(composed.decisionRegister.some((entry) => entry.impact === "shared-contract")).toBe(false);
    expect(portal.unresolvedFacts).toEqual([expect.objectContaining({ id: "monetary-token-contract" })]);
    expect(documentation.unresolvedFacts).toEqual([expect.objectContaining({ id: "minor-unit-token-source" })]);
  });

  it("groups shared-contract cards that cite the same unresolved fact", () => {
    const registry = (repositoryId: string) => scout(repositoryId, "src/registry.js", "runtime-owner", {
      executionDossier: [{ path: "src/registry.js", change: "Carry the shared event.", anchors: ["src/registry.js:1"], requiredSourceFragments: ["SharedEvent"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
    });
    const runtimeA = registry("RuntimeA");
    const runtimeB = registry("RuntimeB");
    const consumer = registry("Consumer");
    consumer.completion = { outcome: "local-extension-confirmed", basis: "The consumer carries the event.", handoffDependencies: [
      { ownerRepositoryId: "RuntimeA", unresolvedFactId: "event-type", reason: "event type" },
      { ownerRepositoryId: "RuntimeB", unresolvedFactId: "event-type", reason: "event type" },
    ] };
    consumer.unresolvedFacts = [{ id: "event-type", statement: "event type", evidence: ["src/registry.js:1"] }];
    const decision = parseCoordinatorDecision(`\`\`\`json
${JSON.stringify({
      repositoryEvaluations: [
        { id: "RuntimeA", scopeDisposition: "changes-required", applicability: runtimeA.applicability, evidence: ["src/registry.js:1"], rationale: "Owns an event registration.", dependsOn: [] },
        { id: "RuntimeB", scopeDisposition: "changes-required", applicability: runtimeB.applicability, evidence: ["src/registry.js:1"], rationale: "Owns an event registration.", dependsOn: [] },
        { id: "Consumer", scopeDisposition: "changes-required", applicability: consumer.applicability, evidence: ["src/registry.js:1"], rationale: "Consumes both registrations.", dependsOn: ["RuntimeA", "RuntimeB"] },
      ],
      implementationOrder: ["RuntimeA", "RuntimeB", "Consumer"], crossRepositoryContracts: [], suggestedRepositories: [], decisionRequests: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
    })}
\`\`\``, ["RuntimeA", "RuntimeB", "Consumer"]);

    const composed = composeCoordinatedPlan(decision, { RuntimeA: runtimeA, RuntimeB: runtimeB, Consumer: consumer }, ["RuntimeA", "RuntimeB", "Consumer"]);
    const cards = composed.decisionRegister.filter((entry) => entry.impact === "shared-contract");

    expect(cards).toHaveLength(1);
    expect(cards[0]?.unresolvedFactRefs).toEqual(["Consumer#event-type"]);
    expect(cards[0]?.affectedRepositoryIds).toEqual(["RuntimeA", "Consumer", "RuntimeB"]);
    expect(cards[0]?.alternatives).toEqual(["SharedEvent"]);
  });

  it("leaves a handoff onto an out-of-mission owner as separate work, not a gate", () => {
    const consumer = scout("Runtime", "src/registry.js", "runtime-owner", {
      completion: { outcome: "local-extension-confirmed", basis: "The registry owns local selection.", handoffDependencies: [{ ownerRepositoryId: "Publisher.Portal", unresolvedFactId: "campaign-pixel", reason: "Portal persists campaign pixel configuration." }] },
      unresolvedFacts: [{ id: "campaign-pixel", statement: "Service source does not own campaign pixel persistence.", evidence: ["src/registry.js:1"] }],
    });
    const decision = parseCoordinatorDecision(`\`\`\`json
${JSON.stringify({
      repositoryEvaluations: [{ id: "Runtime", scopeDisposition: "changes-required", applicability: consumer.applicability, evidence: ["src/registry.js:1"], rationale: "Owns local selection.", dependsOn: [] }],
      implementationOrder: ["Runtime"], crossRepositoryContracts: [], suggestedRepositories: [], decisionRequests: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
    })}
\`\`\``, ["Runtime"]);

    const composed = composeCoordinatedPlan(decision, { Runtime: consumer }, ["Runtime"]);

    expect(composed.decisionRegister.some((entry) => entry.impact === "shared-contract")).toBe(false);
  });

  it("flags loader columns absent from the destination DDL as a blocking shared-contract decision", () => {
    const repo = (over: Partial<CoordinatedRepositoryPlan> & { id: string }): CoordinatedRepositoryPlan => ({
      scopeDisposition: "changes-required",
      applicability: { role: "runtime-owner", storyBinding: "cost ingestion", routeOrDependency: "loader", evidence: ["a:1"] },
      plannedPaths: [], evidence: [], dependsOn: [], implementationSteps: [], executionDossier: [], verificationCommands: [], ...over,
    });
    const plan = (repositories: CoordinatedRepositoryPlan[]): CoordinatedPlanContract => ({
      repositories, executionOrder: repositories.map((entry) => entry.id), suggestedRepositories: [],
      questionsOrClarifications: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
      crossRepositoryContracts: [], repositoryParseErrors: {}, parseError: null,
    });
    const owner = repo({ id: "Data", executionDossier: [{ path: "MEDIA/TABLE/T.sql", change: "create the approved cost table", anchors: ["MEDIA/TABLE/T.sql:1"], requiredSourceFragments: ["CREATE TABLE MEDIA.T (\n  RECORD_ID VARCHAR(64) NOT NULL,\n  CAMPAIGN_ID VARCHAR(256),\n  SPEND NUMBER(18,3)\n)"], writeRole: "contract-mirror", newFile: true, testScenarios: [] }] });
    const loader = repo({ id: "Loader", dependsOn: ["Data"], executionDossier: [{ path: "src/models/x/schema.js", change: "declare the loader columns to write", anchors: ["src/models/x/schema.js:1"], requiredSourceFragments: ["columns: [{ name: 'RECORD_ID' }, { name: 'CAMPAIGN_ID' }, { name: 'ACCOUNT_NAME' }]"], writeRole: "runtime-owner", newFile: true, testScenarios: [] }] });

    const gate = detectDestinationColumnGaps(plan([owner, loader])).decisionRegister.find((entry) => entry.impact === "shared-contract");

    expect(gate).toBeDefined();
    expect(gate?.question).toContain("ACCOUNT_NAME");
    expect(gate?.question).not.toContain("RECORD_ID");
    expect(gate?.affectedRepositoryIds).toEqual(["Data", "Loader"]);
    expect(gate?.requiredBefore).toBe("develop");
  });

  it("emits no column decision when every loader column exists in the DDL (DDL-only columns do not flag)", () => {
    const repo = (over: Partial<CoordinatedRepositoryPlan> & { id: string }): CoordinatedRepositoryPlan => ({
      scopeDisposition: "changes-required",
      applicability: { role: "runtime-owner", storyBinding: "cost ingestion", routeOrDependency: "loader", evidence: ["a:1"] },
      plannedPaths: [], evidence: [], dependsOn: [], implementationSteps: [], executionDossier: [], verificationCommands: [], ...over,
    });
    const plan = (repositories: CoordinatedRepositoryPlan[]): CoordinatedPlanContract => ({
      repositories, executionOrder: repositories.map((entry) => entry.id), suggestedRepositories: [],
      questionsOrClarifications: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
      crossRepositoryContracts: [], repositoryParseErrors: {}, parseError: null,
    });
    // DDL has an extra column (SPEND) the loader does not write; that must NOT flag (directional).
    const owner = repo({ id: "Data", executionDossier: [{ path: "MEDIA/TABLE/T.sql", change: "create the approved cost table", anchors: ["MEDIA/TABLE/T.sql:1"], requiredSourceFragments: ["CREATE TABLE MEDIA.T (\n  RECORD_ID VARCHAR(64) NOT NULL,\n  ACCOUNT_NAME VARCHAR(512),\n  SPEND NUMBER(18,3)\n)"], writeRole: "contract-mirror", newFile: true, testScenarios: [] }] });
    const loader = repo({ id: "Loader", dependsOn: ["Data"], executionDossier: [{ path: "src/models/x/schema.js", change: "declare the loader columns to write", anchors: ["src/models/x/schema.js:1"], requiredSourceFragments: ["columns: [{ name: 'RECORD_ID' }, { name: 'ACCOUNT_NAME' }]"], writeRole: "runtime-owner", newFile: true, testScenarios: [] }] });

    expect(detectDestinationColumnGaps(plan([owner, loader])).decisionRegister).toEqual([]);
  });

  it("uses a registered per-stack extractor to flag a gap the built-in adapter cannot parse", () => {
    const repo = (over: Partial<CoordinatedRepositoryPlan> & { id: string }): CoordinatedRepositoryPlan => ({
      scopeDisposition: "changes-required",
      applicability: { role: "runtime-owner", storyBinding: "cost ingestion", routeOrDependency: "loader", evidence: ["a:1"] },
      plannedPaths: [], evidence: [], dependsOn: [], implementationSteps: [], executionDossier: [], verificationCommands: [], ...over,
    });
    const plan = (repositories: CoordinatedRepositoryPlan[]): CoordinatedPlanContract => ({
      repositories, executionOrder: repositories.map((entry) => entry.id), suggestedRepositories: [],
      questionsOrClarifications: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
      crossRepositoryContracts: [], repositoryParseErrors: {}, parseError: null,
    });
    // A different-stack contract the built-in Snowflake/JS adapter does not recognize.
    const owner = repo({ id: "Data", executionDossier: [{ path: "schema.py", change: "declare the destination columns", anchors: ["schema.py:1"], requiredSourceFragments: ["Column('RECORD_ID')"], writeRole: "contract-mirror", newFile: true, testScenarios: [] }] });
    const loader = repo({ id: "Loader", dependsOn: ["Data"], executionDossier: [{ path: "loader.py", change: "declare the written columns", anchors: ["loader.py:1"], requiredSourceFragments: ["write_field('RECORD_ID')\nwrite_field('EXTRA_COL')"], writeRole: "runtime-owner", newFile: true, testScenarios: [] }] });

    // Without a matching adapter, no gap is flagged (aggregate review is the backstop).
    expect(detectDestinationColumnGaps(plan([owner, loader])).decisionRegister).toEqual([]);

    registerColumnSetExtractor({
      id: "py-test-adapter",
      definedColumns: (fragments) => fragments.flatMap((fragment) => [...fragment.matchAll(/Column\('([A-Z_]+)'\)/g)].map((match) => match[1]!)),
      usedColumns: (fragments) => fragments.flatMap((fragment) => [...fragment.matchAll(/write_field\('([A-Z_]+)'\)/g)].map((match) => match[1]!)),
    });

    const gate = detectDestinationColumnGaps(plan([owner, loader])).decisionRegister.find((entry) => entry.impact === "shared-contract");
    expect(gate?.question).toContain("EXTRA_COL");
    expect(gate?.question).not.toContain("RECORD_ID");
  });

  it("does not double-gate a handoff the coordinator already surfaced as a decision", () => {
    const owner = scout("Data", "MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql", "contract-mirror", {
      executionDossier: [{ path: "MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql", change: "Create the table.", anchors: ["MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql:1"], requiredSourceFragments: ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST"], writeRole: "contract-mirror", newFile: true, testScenarios: [] }],
    });
    const consumer = scout("Loader", "src/registry.js", "runtime-owner", {
      completion: { outcome: "local-extension-confirmed", basis: "The registry owns local selection.", handoffDependencies: [{ ownerRepositoryId: "Data", unresolvedFactId: "snowflake-table-identifier", reason: "The registry tableName must match the deployed table." }] },
      unresolvedFacts: [{ id: "snowflake-table-identifier", statement: "Cannot determine the cross-repository table identifier.", evidence: ["src/registry.js:1"] }],
    });
    const decision = parseCoordinatorDecision(`\`\`\`json
${JSON.stringify({
      repositoryEvaluations: [
        { id: "Data", scopeDisposition: "changes-required", applicability: owner.applicability, evidence: ["MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql:1"], rationale: "Deploys the table.", dependsOn: [] },
        { id: "Loader", scopeDisposition: "changes-required", applicability: consumer.applicability, evidence: ["src/registry.js:1"], rationale: "Loads into the table.", dependsOn: ["Data"] },
      ],
      implementationOrder: ["Data", "Loader"], crossRepositoryContracts: [], suggestedRepositories: [],
      decisionRequests: [], decisionRegister: [{ question: "Which table identifier?", recommendation: "Confirm the deployed literal.", alternatives: [], requiredBefore: "develop", impact: "external-contract", affectedRepositoryIds: ["Loader"], unresolvedFactRefs: ["Loader#snowflake-table-identifier"], rationale: "Unknown." }],
      operationalFollowUps: [], outOfScopeFollowUps: [],
    })}
\`\`\``, ["Data", "Loader"]);

    const composed = composeCoordinatedPlan(decision, { Data: owner, Loader: consumer }, ["Data", "Loader"]);

    expect(composed.decisionRegister.filter((entry) => entry.impact === "shared-contract")).toEqual([]);
  });

  it("infers a shared-identifier kind when the owner is not a DDL repository", () => {
    const owner = scout("Runtime", "src/PlatformRegistry.js", "runtime-owner", {
      executionDossier: [{ path: "src/PlatformRegistry.js", change: "Register the OpenAI platform in the explicit map.", anchors: ["src/PlatformRegistry.js:1"], requiredSourceFragments: ["OpenAIPlatform"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
    });
    const consumer = scout("Worker", "src/worker.js", "runtime-owner", {
      completion: { outcome: "local-extension-confirmed", basis: "The worker depends on the registry identifier.", handoffDependencies: [{ ownerRepositoryId: "Runtime", unresolvedFactId: "platform-identifier", reason: "The worker must use the exact platform identifier the registry owns." }] },
      unresolvedFacts: [{ id: "platform-identifier", statement: "platform identifier", evidence: ["src/worker.js:1"] }],
      executionDossier: [{ path: "src/worker.js", change: "Use the platform identifier.", anchors: ["src/worker.js:1"], requiredSourceFragments: ["OpenAIPlatform"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }],
    });
    const decision = parseCoordinatorDecision(`\`\`\`json
${JSON.stringify({
      repositoryEvaluations: [
        { id: "Runtime", scopeDisposition: "changes-required", applicability: owner.applicability, evidence: ["src/PlatformRegistry.js:1"], rationale: "Owns the registry.", dependsOn: [] },
        { id: "Worker", scopeDisposition: "changes-required", applicability: consumer.applicability, evidence: ["src/worker.js:1"], rationale: "Uses the identifier.", dependsOn: ["Runtime"] },
      ],
      implementationOrder: ["Runtime", "Worker"], crossRepositoryContracts: [], suggestedRepositories: [], decisionRequests: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
    })}
\`\`\``, ["Runtime", "Worker"]);

    const composed = composeCoordinatedPlan(decision, { Runtime: owner, Worker: consumer }, ["Runtime", "Worker"]);
    const gate = composed.decisionRegister.find((entry) => entry.impact === "shared-contract");

    expect(composed.parseError).toBeNull();
    expect(gate?.alternatives).toEqual(["OpenAIPlatform"]);
    expect(gate?.sharedContractSlot?.literalKind).toBe("shared identifier");
  });
});

describe("coordinated packet rendering", () => {
  const plan: CoordinatedPlanContract = {
    repositories: [{
      id: "Database.Snowflake.DATA_LAKE",
      scopeDisposition: "changes-required",
      applicability: {
        role: "configuration-owner",
        storyBinding: "Advertising-cost persistence.",
        routeOrDependency: "The deployment manifest provisions MEDIA table DDL.",
        evidence: ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1"],
      },
      plannedPaths: ["MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql"],
      evidence: ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1"],
      dependsOn: [],
      implementationSteps: ["Add the approved table definition."],
      executionDossier: [{
        path: "MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql",
        change: "Add the approved table definition.",
        anchors: ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1"],
        requiredSourceFragments: ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST"],
        writeRole: "configuration-owner",
        newFile: true,
        testScenarios: [],
      }],
      verificationCommands: [],
    }],
    executionOrder: ["Database.Snowflake.DATA_LAKE"],
    suggestedRepositories: [],
    questionsOrClarifications: [],
    decisionRegister: [],
    operationalFollowUps: [],
    outOfScopeFollowUps: [],
    crossRepositoryContracts: [],
    repositoryParseErrors: { "Database.Snowflake.DATA_LAKE": null },
    parseError: null,
  };

  it("withholds a draft implementation packet when the targeted critic leaves its inclusion unverified", () => {
    const output = renderCoordinatedPlanOutput("## Plan\nDraft.", plan, {
      "Database.Snowflake.DATA_LAKE": [{
        stepIndex: -1,
        step: "Repository inclusion: Database.Snowflake.DATA_LAKE",
        phrase: "story applicability",
        citations: ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1"],
        status: "unverified",
        explanation: "Targeted critic did not produce audit-backed file evidence.",
      }],
    });

    expect(output).toContain("## Repository-local packets awaiting evidence repair");
    expect(output).toContain("it cannot be approved or sent to Develop");
    expect(output).not.toContain("Repository-local implementation packet:");
    expect(output).not.toContain("Add the approved table definition.");
  });

  it("renders the implementation packet after the targeted critic confirms its inclusion", () => {
    const output = renderCoordinatedPlanOutput("## Plan\nDraft.", plan, {
      "Database.Snowflake.DATA_LAKE": [{
        stepIndex: -1,
        step: "Repository inclusion: Database.Snowflake.DATA_LAKE",
        phrase: "story applicability",
        citations: ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1"],
        status: "confirmed",
        explanation: null,
      }],
    });

    expect(output).toContain("## Repository-local implementation packets");
    expect(output).toContain("Repository-local implementation packet:");
    expect(output).toContain("Add the approved table definition.");
    expect(output).not.toContain("awaiting evidence repair");
  });
});

describe("blocking coordinator decisions", () => {
  const scoutFindings = {
    Runtime: '```json\n{"confirmedFacts":[{"id":"timestamp-token","statement":"Milliseconds are supported.","evidence":["src/Handler.js:471"]}],"unresolvedFacts":[{"id":"event-id","statement":"The vendor event ID is not established.","evidence":["src/Handler.js:457"]}]}\n```',
  };

  it("rejects an implementation question about a source-confirmed fact", () => {
    expect(validateBlockingDecisionFacts([{
      question: "Is the timestamp token supported?", recommendation: "Check the runtime.", alternatives: [], requiredBefore: "develop", impact: "implementation", affectedRepositoryIds: ["Runtime"], rationale: "Unknown.", unresolvedFactRefs: ["Runtime#timestamp-token"],
    }], scoutFindings)).toMatch(/cannot block Develop/);
  });

  it("rejects an implementation question even when it cites a scout's exact unresolved fact", () => {
    expect(validateBlockingDecisionFacts([{
      question: "Which ID is stable?", recommendation: "Use the documented vendor value.", alternatives: [], requiredBefore: "develop", impact: "implementation", affectedRepositoryIds: ["Runtime"], rationale: "Source exposes several values.", unresolvedFactRefs: ["Runtime#event-id"],
    }], scoutFindings)).toMatch(/cannot block Develop/);
  });

  it("rejects an untraceable implementation decision", () => {
    expect(validateBlockingDecisionFacts([{
      question: "Choose a value.", recommendation: "Ask the developer.", alternatives: [], requiredBefore: "develop", impact: "implementation", affectedRepositoryIds: ["Runtime"], rationale: "Unknown.", unresolvedFactRefs: [],
    }], scoutFindings)).toMatch(/cannot block Develop/);
  });

  it("rejects a repository-boundary question that repeats a durable developer decision", () => {
    const answered: PlanDecision = {
      question: "Which runtime owns dispatch?", recommendation: "Use Runtime.", alternatives: [], requiredBefore: "develop", impact: "repository-boundary", affectedRepositoryIds: ["Runtime"], rationale: "Route owner.", unresolvedFactRefs: ["Runtime#event-id"],
    };
    const rephrased = { ...answered, question: "Should the Runtime service own the event route?" };
    expect(planDecisionKey(rephrased)).toBe(planDecisionKey(answered));
    expect(validatePreDevelopDecisions([rephrased], scoutFindings, [{ key: planDecisionKey(answered), question: answered.question, answer: "Runtime", resolvedAt: "2026-09-18T00:00:00.000Z" }])).toMatch(/already resolved/);
  });

  it("keeps implementation uncertainty visible without sending the entire coordinator through repair", () => {
    const contract: CoordinatedPlanContract = {
      repositories: [], executionOrder: [], suggestedRepositories: [], questionsOrClarifications: [],
      decisionRegister: [{
        question: "Which response field should the worker map?", recommendation: "Use the source-cited local pattern.", alternatives: [],
        requiredBefore: "develop", impact: "implementation", affectedRepositoryIds: ["Runtime"], rationale: "The local packet has the bounded implementation.",
      }],
      operationalFollowUps: [], outOfScopeFollowUps: [], crossRepositoryContracts: [], repositoryParseErrors: {}, parseError: null,
    };

    const normalized = normalizeNonBlockingCoordinatorDecisions(contract);

    expect(normalized.decisionRegister).toEqual([]);
    expect(normalized.questionsOrClarifications).toEqual(["Which response field should the worker map? Planning recommendation: Use the source-cited local pattern."]);
  });

  it("moves a boundary question outside the mission when every named repository is already changes-required", () => {
    const repository = {
      id: "Runtime", scopeDisposition: "changes-required" as const, applicability: {
        role: "runtime-owner" as const, storyBinding: "The selected runtime change.", routeOrDependency: "The registered route owns it.", evidence: ["src/runtime.js:1"],
      }, plannedPaths: ["src/runtime.js"], evidence: ["src/runtime.js:1"], dependsOn: [], implementationSteps: ["Register the selected runtime behavior."],
      executionDossier: [{ path: "src/runtime.js", change: "Register the selected runtime behavior.", anchors: ["src/runtime.js:1"], requiredSourceFragments: ["RuntimeBehavior"], writeRole: "runtime-owner" as const, newFile: false, testScenarios: [] }], verificationCommands: [],
    };
    const contract: CoordinatedPlanContract = {
      repositories: [repository], executionOrder: ["Runtime"], suggestedRepositories: [], questionsOrClarifications: ["Which other service owns cost ingestion?"],
      decisionRegister: [{
        question: "Which other service owns cost ingestion?", recommendation: "Scope the unselected ingestion owner separately.", alternatives: [],
        requiredBefore: "develop", impact: "repository-boundary", affectedRepositoryIds: ["Runtime"], rationale: "Runtime has no ingestion path.", unresolvedFactRefs: ["Runtime#cost-owner"],
      }],
      operationalFollowUps: [], outOfScopeFollowUps: [], crossRepositoryContracts: [], repositoryParseErrors: { Runtime: null }, parseError: null,
    };

    const normalized = normalizeNonBlockingCoordinatorDecisions(contract);

    expect(normalized.decisionRegister).toEqual([]);
    expect(normalized.questionsOrClarifications).toEqual([]);
    expect(normalized.outOfScopeFollowUps).toEqual(["Which other service owns cost ingestion? Planning recommendation: Scope the unselected ingestion owner separately."]);
  });

  it("keeps a boundary decision reconciling a shared literal between two changes-required repos as a blocking gate", () => {
    const producer = {
      id: "Database", scopeDisposition: "changes-required" as const, applicability: {
        role: "contract-mirror" as const, storyBinding: "The persistence object.", routeOrDependency: "A manifest deploys the table.", evidence: ["MEDIA/TABLE/T.sql:1"],
      }, plannedPaths: ["MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql"], evidence: ["MEDIA/TABLE/T.sql:1"], dependsOn: [], implementationSteps: ["Create the table."],
      executionDossier: [{ path: "MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql", change: "Add the persistence contract.", anchors: ["MEDIA/TABLE/T.sql:1"], requiredSourceFragments: ["TRAFFIC_CHATGPT_AD_COST"], writeRole: "contract-mirror" as const, newFile: true, testScenarios: [] }], verificationCommands: [],
    };
    const consumer = {
      id: "Loader", scopeDisposition: "changes-required" as const, applicability: {
        role: "runtime-owner" as const, storyBinding: "The loader.", routeOrDependency: "The worker merges into the table.", evidence: ["src/worker.js:1"],
      }, plannedPaths: ["src/worker.js"], evidence: ["src/worker.js:1"], dependsOn: ["Database"], implementationSteps: ["Merge into the target table."],
      executionDossier: [{ path: "src/worker.js", change: "Map rows into TRAFFIC_OPENAI_AD_COST.", anchors: ["src/worker.js:1"], requiredSourceFragments: ["TRAFFIC_OPENAI_AD_COST"], writeRole: "runtime-owner" as const, newFile: false, testScenarios: [] }], verificationCommands: [],
    };
    const decision: PlanDecision = {
      question: "What exact target table identifier must both repositories use?", recommendation: "Use TRAFFIC_OPENAI_AD_COST because the loader mapping requires that exact literal.", alternatives: [],
      requiredBefore: "plan", impact: "repository-boundary", affectedRepositoryIds: ["Database", "Loader"], rationale: "The two packets require different exact literals, so no shared contract can be declared.", unresolvedFactRefs: ["Database#chatgpt-cost-table-contract"],
    };
    const contract: CoordinatedPlanContract = {
      repositories: [producer, consumer], executionOrder: ["Database", "Loader"], suggestedRepositories: [], questionsOrClarifications: [],
      decisionRegister: [decision], operationalFollowUps: [], outOfScopeFollowUps: [], crossRepositoryContracts: [], repositoryParseErrors: { Database: null, Loader: null }, parseError: null,
    };

    const normalized = normalizeNonBlockingCoordinatorDecisions(contract);

    expect(normalized.decisionRegister).toEqual([decision]);
    expect(normalized.outOfScopeFollowUps).toEqual([]);
    expect(hasBlockingPreDevelopDecision(normalized.decisionRegister)).toBe(true);
  });
});

describe("confirmation dependencies and cross-repository contracts", () => {
  const repository = (id: string, steps: string[], fragments: string[], dependsOn: string[] = []): CoordinatedRepositoryPlan => ({
    id,
    scopeDisposition: "changes-required",
    applicability: {
      role: "runtime-owner",
      storyBinding: "The requested shared integration.",
      routeOrDependency: "The current extension point owns its local side of the contract.",
      evidence: ["src/current.js:1"],
    },
    plannedPaths: ["src/current.js"],
    evidence: ["src/current.js:1"],
    dependsOn,
    implementationSteps: steps,
    executionDossier: [{
      path: "src/current.js",
      change: "Extend the current contract with the approved shared literal.",
      anchors: ["src/current.js:1"],
      requiredSourceFragments: fragments,
      writeRole: "runtime-owner",
      newFile: false,
      testScenarios: [],
    }],
    verificationCommands: [],
  });
  const contract = (repositories: CoordinatedRepositoryPlan[], decisionRegister: PlanDecision[] = [], crossRepositoryContracts: CoordinatedPlanContract["crossRepositoryContracts"] = []): CoordinatedPlanContract => ({
    repositories,
    executionOrder: repositories.map((entry) => entry.id),
    suggestedRepositories: [],
    questionsOrClarifications: [],
    decisionRegister,
    operationalFollowUps: [],
    outOfScopeFollowUps: [],
    crossRepositoryContracts,
    repositoryParseErrors: Object.fromEntries(repositories.map((entry) => [entry.id, null])),
    parseError: null,
  });

  it("turns a buried pre-Develop confirmation into a stable external-contract requirement", () => {
    const steps = ["Resolve the reporting grain with the data owner before freezing the database contract."];
    const dependencies = scanConfirmationDependencies("Data", steps, []);
    const dependency = dependencies[0]!;
    const plan = contract([repository("Data", steps, ["TRAFFIC_VENDOR_COST"])]);

    expect(dependency).toMatchObject({ repositoryId: "Data", requiredBefore: "develop", source: "implementation-step" });
    expect(validateConfirmationDependencies(plan)).toMatch(/must have an external-contract decision/);

    plan.decisionRegister = [{
      question: "Which reporting grain and fields did the data owner approve?",
      recommendation: "Use the approved reporting contract in the deployment record.",
      alternatives: [],
      requiredBefore: "develop",
      impact: "external-contract",
      affectedRepositoryIds: ["Data"],
      resolvesConfirmationDependencyIds: [dependency.id],
      rationale: "Current source establishes the table pattern but not the business grain.",
    }];

    expect(validateConfirmationDependencies(plan)).toBeNull();
    expect(hasBlockingPreDevelopDecision(plan.decisionRegister)).toBe(true);
  });

  it("keeps deterministic verification out of human confirmation dependencies", () => {
    const dependencies = scanConfirmationDependencies("Data", [
      "Run the configured AST validator and confirm the new table passes initial-table, comment, identifier, datatype, and timestamp rules.",
    ], []);

    expect(dependencies).toEqual([]);
  });

  it("retains an explicit human confirmation after a deterministic check in the same step", () => {
    const dependencies = scanConfirmationDependencies("Data", [
      "Run the configured AST validator, then confirm with the data owner that the approved reporting grain remains correct.",
    ], []);

    expect(dependencies).toEqual([expect.objectContaining({
      repositoryId: "Data",
      requiredBefore: "develop",
      source: "implementation-step",
    })]);
  });

  it("retains production sign-off as a Publish dependency", () => {
    const dependencies = scanConfirmationDependencies("Data", ["Obtain production sign-off before publishing."], []);

    expect(dependencies).toEqual([expect.objectContaining({
      repositoryId: "Data",
      requiredBefore: "publish",
      source: "implementation-step",
    })]);
  });

  it("allows a vendor-contract gate grounded in an audited unresolved scout fact", () => {
    const plan = contract([repository("Runtime", ["Implement the scheduled export with the approved vendor contract."], ["OPENAI_INSIGHTS"])], [{
      question: "What exact OpenAI Insights API contract must the scheduled runtime implement?",
      recommendation: "Use the vendor contract once its request and response semantics are confirmed.",
      alternatives: ["Do not implement the scheduled export until the vendor contract is available."],
      requiredBefore: "develop",
      impact: "external-contract",
      affectedRepositoryIds: ["Runtime"],
      unresolvedFactRefs: ["Runtime#openai-insights-contract"],
      rationale: "Current source has no audited evidence for the vendor API request and response contract.",
    }]);
    const scoutFindings = {
      Runtime: '```json\n{"confirmedFacts":[],"unresolvedFacts":[{"id":"openai-insights-contract","statement":"The vendor request and response contract is not established in current source.","evidence":["src/insights.ts:1"]}]}\n```',
    };

    expect(validateConfirmationDependencies(plan)).toBeNull();
    expect(validatePreDevelopDecisions(plan.decisionRegister, scoutFindings)).toBeNull();
    expect(hasBlockingPreDevelopDecision(plan.decisionRegister)).toBe(true);

    const publishGate = { ...plan.decisionRegister[0]!, requiredBefore: "publish" as const };
    expect(validatePreDevelopDecisions([publishGate], scoutFindings)).toBeNull();
    expect(hasBlockingPublishDecision([publishGate])).toBe(true);
  });

  it("rejects an external-contract decision with neither a confirmation nor an audited source gap", () => {
    const plan = contract([repository("Runtime", ["Implement the scheduled export."], ["OPENAI_INSIGHTS"])], [{
      question: "What should the external API do?",
      recommendation: "Confirm the API contract.",
      alternatives: [],
      requiredBefore: "develop",
      impact: "external-contract",
      affectedRepositoryIds: ["Runtime"],
      rationale: "The contract is unknown.",
    }]);

    expect(validateConfirmationDependencies(plan)).toMatch(/exactly one confirmation dependency ID or cite exactly one unresolved scout fact/);
  });

  it("requires a blocking source-contract decision to represent one uncertainty", () => {
    const plan = contract([repository("Runtime", ["Implement the scheduled export."], ["OPENAI_INSIGHTS"])], [{
      question: "What vendor contract and reporting grain should the loader use?",
      recommendation: "Confirm both requirements.",
      alternatives: [],
      requiredBefore: "develop",
      impact: "external-contract",
      affectedRepositoryIds: ["Runtime"],
      unresolvedFactRefs: ["Runtime#vendor-contract", "Runtime#reporting-grain"],
      rationale: "Current source does not establish either requirement.",
    }]);
    const scoutFindings = {
      Runtime: '```json\n{"confirmedFacts":[],"unresolvedFacts":[{"id":"vendor-contract","statement":"The vendor contract is not established.","evidence":["src/worker.ts:1"]},{"id":"reporting-grain","statement":"The reporting grain is not established.","evidence":["src/worker.ts:2"]}]}\n```',
    };

    expect(validatePreDevelopDecisions(plan.decisionRegister, scoutFindings)).toMatch(/exactly one unresolved scout fact/);
    expect(validateConfirmationDependencies(plan)).toMatch(/exactly one confirmation dependency ID or cite exactly one unresolved scout fact/);
  });

  it("rejects a decision that combines a human confirmation with a separate source gap", () => {
    const steps = ["Confirm the reporting grain with the data owner before freezing the database contract."];
    const dependency = scanConfirmationDependencies("Data", steps, [])[0]!;
    const plan = contract([repository("Data", steps, ["TRAFFIC_VENDOR_COST"])], [{
      question: "What reporting grain and vendor response mapping should the loader use?",
      recommendation: "Confirm both requirements.",
      alternatives: [],
      requiredBefore: "develop",
      impact: "external-contract",
      affectedRepositoryIds: ["Data"],
      unresolvedFactRefs: ["Data#vendor-response"],
      resolvesConfirmationDependencyIds: [dependency.id],
      rationale: "The stakeholder choice and vendor mapping are separate uncertainties.",
    }]);

    expect(validateConfirmationDependencies(plan)).toMatch(/exactly one confirmation dependency ID or cite exactly one unresolved scout fact/);
  });

  it("keeps a confirmation required only before Publish out of the Develop gate", () => {
    const steps = ["Obtain stakeholder sign-off before publishing the representative production load."];
    const dependency = scanConfirmationDependencies("Runtime", steps, [])[0]!;
    const plan = contract([repository("Runtime", steps, ["TRAFFIC_VENDOR_COST"])]);
    plan.decisionRegister = [{
      question: "Has the representative production load been accepted?",
      recommendation: "Collect stakeholder sign-off after deployment validation.",
      alternatives: [],
      requiredBefore: "publish",
      impact: "external-contract",
      affectedRepositoryIds: ["Runtime"],
      resolvesConfirmationDependencyIds: [dependency.id],
      rationale: "The source change can be implemented before an operational acceptance check.",
    }];

    expect(validateConfirmationDependencies(plan)).toBeNull();
    expect(hasBlockingPreDevelopDecision(plan.decisionRegister)).toBe(false);
    expect(hasBlockingPublishDecision(plan.decisionRegister)).toBe(true);
    expect(hasBlockingPublishDecision(plan.decisionRegister, [dependency.id])).toBe(false);
  });

  it("uses one source-to-consumer link for an exact shared literal without conflating local names", () => {
    const data = repository("Data", ["Create TRAFFIC_VENDOR_COST."], ["CREATE TABLE MEDIA.TRAFFIC_VENDOR_COST", "TRAFFIC_VENDOR_COST"]);
    const runtime = repository("Runtime", ["Register VendorWorker against TRAFFIC_VENDOR_COST."], ["class VendorWorker", "TRAFFIC_VENDOR_COST"], ["Data"]);
    runtime.executionDossier[0]!.writeRole = "contract-mirror";
    const plan = contract([data, runtime], [], [{
      concept: "advertising-cost target table",
      literalKind: "database table",
      sourceRepositoryId: "Data",
      sourcePath: "src/current.js",
      sharedLiteral: "TRAFFIC_VENDOR_COST",
      consumerRepositoryId: "Runtime",
      consumerPath: "src/current.js",
      reason: "The runtime must use the deployed target table.",
    }]);

    const composed = composeCrossRepositoryContracts(plan);

    expect(composed.crossRepositoryContracts[0]?.sharedLiteral).toBe("TRAFFIC_VENDOR_COST");
    expect(composed.repositories.find((entry) => entry.id === "Runtime")?.executionDossier[0]?.requiredSourceFragments).toContain("TRAFFIC_VENDOR_COST");
    expect(validateCrossRepositoryContracts(composed)).toBeNull();
  });

  it("never accepts a test dossier as the source of a production cross-repository contract", () => {
    const runtime = repository("Runtime", ["Register ChatGPTConversion."], ["type: \"ChatGPTConversion\""]);
    runtime.executionDossier.push({
      path: "test/ChatGPTConversion.test.js",
      change: "Cover the conversion contract.",
      anchors: ["test/ChatGPTConversion.test.js:1"],
      requiredSourceFragments: ["ChatGPTConversion"],
      writeRole: "test",
      newFile: false,
      testScenarios: [{ name: "Covers ChatGPTConversion", fixtures: [], assertions: ["The registry selects ChatGPTConversion"] }],
    });
    const portal = repository("Portal", ["Persist ChatGPTConversion."], ["ChatGPTConversion"], ["Runtime"]);
    portal.applicability = { ...portal.applicability, role: "configuration-owner" };
    portal.executionDossier[0]!.writeRole = "configuration-owner";
    const plan = contract([runtime, portal], [], [{
      concept: "pixel type",
      literalKind: "config key",
      sourceRepositoryId: "Runtime",
      sourcePath: "test/ChatGPTConversion.test.js",
      sharedLiteral: "ChatGPTConversion",
      consumerRepositoryId: "Portal",
      consumerPath: "src/current.js",
      reason: "Portal persists the runtime type.",
    }]);

    expect(validateCrossRepositoryContracts(plan)).toMatch(/non-test source dossier entry/);
    const composed = composeCrossRepositoryContracts(plan);

    expect(composed.crossRepositoryContracts).toEqual([expect.objectContaining({
      sourceRepositoryId: "Runtime",
      sourcePath: "src/current.js",
      sharedLiteral: "ChatGPTConversion",
      consumerRepositoryId: "Portal",
    })]);
    expect(validateCrossRepositoryContracts(composed)).toBeNull();
  });

  it("rejects a link whose consumer packet lacks an existing non-test dossier entry", () => {
    const data = repository("Data", ["Create TRAFFIC_VENDOR_COST."], ["CREATE TABLE MEDIA.TRAFFIC_VENDOR_COST", "TRAFFIC_VENDOR_COST"]);
    const runtime = repository("Runtime", ["Register VendorWorker."], ["class VendorWorker"], ["Data"]);
    const plan = contract([data, runtime], [], [{
      concept: "advertising-cost target table",
      literalKind: "database table",
      sourceRepositoryId: "Data",
      sourcePath: "src/current.js",
      sharedLiteral: "TRAFFIC_VENDOR_COST",
      consumerRepositoryId: "Runtime",
      consumerPath: "src/current.js",
      reason: "The runtime must use the deployed target table.",
    }]);

    expect(validateCrossRepositoryContracts(composeCrossRepositoryContracts(plan))).toMatch(/did not independently require 'TRAFFIC_VENDOR_COST'/);
  });

  it("never widens a packet when an unsupported contract link cannot be composed", () => {
    const data = repository("Data", ["Create TRAFFIC_VENDOR_COST."], ["CREATE TABLE MEDIA.TRAFFIC_VENDOR_COST", "MEDIA"]);
    const runtime = repository("Runtime", ["Register VendorWorker."], ["class VendorWorker"], ["Data"]);
    const plan = contract([data, runtime], [], [{
      concept: "destination schema",
      literalKind: "schema name",
      sourceRepositoryId: "Data",
      sourcePath: "src/current.js",
      sharedLiteral: "MEDIA",
      consumerRepositoryId: "Runtime",
      consumerPath: "src/missing.js",
      reason: "The runtime must use the source schema.",
    }]);

    const composed = composeCrossRepositoryContracts(plan);

    expect(composed.repositories).toEqual(plan.repositories);
    expect(validateCrossRepositoryContracts(composed)).toMatch(/non-test consumer dossier entry at src\/missing\.js/);
  });

  it("derives one unambiguous shared identifier between a runtime and configuration owner", () => {
    const runtime = repository("Runtime", ["Register ChatGPTConversion."], ["ChatGPTConversion"]);
    const portal = repository("Portal", ["Persist ChatGPTConversion."], ["ChatGPTConversion"], ["Runtime"]);
    portal.applicability = { ...portal.applicability, role: "configuration-owner" };
    portal.executionDossier[0]!.writeRole = "configuration-owner";
    const plan = contract([runtime, portal]);

    const composed = composeCrossRepositoryContracts(plan);

    expect(composed.crossRepositoryContracts).toEqual([expect.objectContaining({
      sharedLiteral: "ChatGPTConversion",
      sourceRepositoryId: "Runtime",
      consumerRepositoryId: "Portal",
      consumerPath: "src/current.js",
    })]);
    expect(validateCrossRepositoryContracts(composed)).toBeNull();
  });

  it("never manufactures a consumer requirement while composing a cross-repository contract", () => {
    const data = repository("Data", ["Create TRAFFIC_CHATGPT_AD_COST."], ["TRAFFIC_CHATGPT_AD_COST"]);
    const runtime = repository("Runtime", ["Map the scheduled rows."], ["TRAFFIC_OPENAI_AD_COST"], ["Data"]);
    runtime.executionDossier[0]!.writeRole = "contract-mirror";
    const plan = contract([data, runtime], [], [{
      concept: "advertising-cost target table",
      literalKind: "table name",
      sourceRepositoryId: "Data",
      sourcePath: "src/current.js",
      sharedLiteral: "TRAFFIC_CHATGPT_AD_COST",
      consumerRepositoryId: "Runtime",
      consumerPath: "src/current.js",
      reason: "The runtime must map into the deployed target table.",
    }]);

    const composed = composeCrossRepositoryContracts(plan);

    expect(composed.repositories.find((entry) => entry.id === "Runtime")?.executionDossier[0]?.requiredSourceFragments)
      .toEqual(["TRAFFIC_OPENAI_AD_COST"]);
    expect(validateCrossRepositoryContracts(composed)).toMatch(/did not independently require 'TRAFFIC_CHATGPT_AD_COST'/);
  });

  it("validates a table contract where the DDL owner qualifies and the registry consumer does not", () => {
    const data = repository("Data", ["Create the target table."], ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST"]);
    data.executionDossier[0]!.writeRole = "contract-mirror";
    const loader = repository("Loader", ["Map rows into the target table."], ["tableName: 'TRAFFIC_CHATGPT_AD_COST'"], ["Data"]);
    const makeContract = (sharedLiteral: string) => contract([data, loader], [], [{
      concept: "advertising-cost target table",
      literalKind: "table name",
      sourceRepositoryId: "Data",
      sourcePath: "src/current.js",
      sharedLiteral,
      consumerRepositoryId: "Loader",
      consumerPath: "src/current.js",
      reason: "The loader must merge into the deployed target table.",
    }]);

    expect(validateCrossRepositoryContracts(makeContract("TRAFFIC_CHATGPT_AD_COST"))).toBeNull();
    expect(validateCrossRepositoryContracts(makeContract("MEDIA.TRAFFIC_CHATGPT_AD_COST"))).toBeNull();
  });

  it("still rejects a table contract when the two repositories name genuinely different tables", () => {
    const data = repository("Data", ["Create the target table."], ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST"]);
    data.executionDossier[0]!.writeRole = "contract-mirror";
    const loader = repository("Loader", ["Map rows."], ["tableName: 'TRAFFIC_BING_AD_COST'"], ["Data"]);
    const plan = contract([data, loader], [], [{
      concept: "advertising-cost target table",
      literalKind: "table name",
      sourceRepositoryId: "Data",
      sourcePath: "src/current.js",
      sharedLiteral: "TRAFFIC_CHATGPT_AD_COST",
      consumerRepositoryId: "Loader",
      consumerPath: "src/current.js",
      reason: "The loader must merge into the deployed target table.",
    }]);

    expect(validateCrossRepositoryContracts(plan)).toMatch(/did not independently require 'TRAFFIC_CHATGPT_AD_COST'/);
  });

  it("rejects a statement where a table-name shared literal is required", () => {
    const data = repository("Data", ["Create the target table."], ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST"]);
    const runtime = repository("Runtime", ["Map the target table."], ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST"], ["Data"]);
    runtime.executionDossier[0]!.writeRole = "contract-mirror";
    const plan = contract([data, runtime], [], [{
      concept: "advertising-cost target table",
      literalKind: "table name",
      sourceRepositoryId: "Data",
      sourcePath: "src/current.js",
      sharedLiteral: "CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST",
      consumerRepositoryId: "Runtime",
      consumerPath: "src/current.js",
      reason: "The runtime must map into the deployed target table.",
    }]);

    expect(validateCrossRepositoryContracts(plan)).toMatch(/small shared literal, not a statement or block/);
  });

  it("retains contract direction only from a consumer to its declared dependency", () => {
    const applicability = {
      role: "contract-mirror",
      storyBinding: "The requested shared contract.",
      routeOrDependency: "The current extension point owns its local side of the contract.",
      evidence: ["src/current.js:1"],
    };
    const decision = parseCoordinatorDecision(`\`\`\`json
${JSON.stringify({
      repositoryEvaluations: [
        { id: "Data", scopeDisposition: "changes-required", applicability, evidence: ["src/data.js:1"], rationale: "Owns the source contract.", dependsOn: [] },
        { id: "Runtime", scopeDisposition: "changes-required", applicability, evidence: ["src/runtime.js:1"], rationale: "Consumes the source contract.", dependsOn: ["Data"] },
      ],
      implementationOrder: ["Data", "Runtime"], crossRepositoryContracts: [{ concept: "invalid", literalKind: "table", sourceRepositoryId: "Runtime", sourcePath: "src/runtime.js", sharedLiteral: "TRAFFIC_VENDOR_COST", consumerRepositoryId: "Data", consumerPath: "src/data.js", reason: "Invalid reverse contract." }], suggestedRepositories: [], decisionRequests: [], decisionRegister: [], operationalFollowUps: [], outOfScopeFollowUps: [],
    })}
\`\`\``, ["Data", "Runtime"]);

    expect(decision.crossRepositoryContracts).toEqual([]);
  });

  it("flags a sibling-divergent literal across a dependency edge even when the coordinator emitted none", () => {
    const data = repository("Data", ["Create TRAFFIC_CHATGPT_AD_COST."], ["TRAFFIC_CHATGPT_AD_COST"]);
    const loader = repository("Loader", ["Merge into the target table."], ["TRAFFIC_OPENAI_AD_COST"], ["Data"]);
    const plan = contract([data, loader]);

    const detected = detectDivergentCrossRepositoryContracts(plan);

    expect(detected.unresolvedCrossRepositoryContracts).toEqual([expect.objectContaining({
      concept: "shared literal TRAFFIC_*_AD_COST",
      literalKind: "table name",
      sourceRepositoryId: "Data",
      sourceLiteral: "TRAFFIC_CHATGPT_AD_COST",
      consumerRepositoryId: "Loader",
      consumerLiteral: "TRAFFIC_OPENAI_AD_COST",
    })]);
    expect(validateUnresolvedCrossRepositoryContracts(detected)).toMatch(/Data requires 'TRAFFIC_CHATGPT_AD_COST' but Loader requires 'TRAFFIC_OPENAI_AD_COST'/);
  });

  it("detects a sibling divergence when one literal carries a schema qualifier", () => {
    const data = repository("Data", ["Create the qualified table."], ["MEDIA.TRAFFIC_CHATGPT_AD_COST"]);
    const loader = repository("Loader", ["Merge into the unqualified table."], ["TRAFFIC_OPENAI_AD_COST"], ["Data"]);

    const detected = detectDivergentCrossRepositoryContracts(contract([data, loader]));

    expect(detected.unresolvedCrossRepositoryContracts).toEqual([expect.objectContaining({
      concept: "shared literal TRAFFIC_*_AD_COST",
      sourceLiteral: "MEDIA.TRAFFIC_CHATGPT_AD_COST",
      consumerLiteral: "TRAFFIC_OPENAI_AD_COST",
    })]);
  });

  it("does not flag unrelated literals as a divergence", () => {
    const data = repository("Data", ["Create ORDERS."], ["ORDERS"]);
    const loader = repository("Loader", ["Read CUSTOMERS."], ["CUSTOMERS"], ["Data"]);

    expect((detectDivergentCrossRepositoryContracts(contract([data, loader])).unresolvedCrossRepositoryContracts ?? [])).toEqual([]);
  });

  it("does not flag two-segment near-misses that lack a real shared skeleton", () => {
    const data = repository("Data", ["Create FOO_BAR."], ["FOO_BAR"]);
    const loader = repository("Loader", ["Read BAZ_QUX."], ["BAZ_QUX"], ["Data"]);

    expect((detectDivergentCrossRepositoryContracts(contract([data, loader])).unresolvedCrossRepositoryContracts ?? [])).toEqual([]);
  });

  it("leaves an agreed shared literal unflagged", () => {
    const data = repository("Data", ["Create TRAFFIC_OPENAI_AD_COST."], ["TRAFFIC_OPENAI_AD_COST"]);
    const loader = repository("Loader", ["Merge into TRAFFIC_OPENAI_AD_COST."], ["TRAFFIC_OPENAI_AD_COST"], ["Data"]);

    expect((detectDivergentCrossRepositoryContracts(contract([data, loader])).unresolvedCrossRepositoryContracts ?? [])).toEqual([]);
  });

  it("does not duplicate a divergence the coordinator already recorded", () => {
    const data = repository("Data", ["Create TRAFFIC_CHATGPT_AD_COST."], ["TRAFFIC_CHATGPT_AD_COST"]);
    const loader = repository("Loader", ["Merge into the target table."], ["TRAFFIC_OPENAI_AD_COST"], ["Data"]);
    const plan: CoordinatedPlanContract = {
      ...contract([data, loader]),
      unresolvedCrossRepositoryContracts: [{
        concept: "advertising-cost target table",
        literalKind: "table name",
        sourceRepositoryId: "Data",
        sourceLiteral: "MEDIA.TRAFFIC_CHATGPT_AD_COST",
        consumerRepositoryId: "Loader",
        consumerLiteral: "TRAFFIC_OPENAI_AD_COST",
        reason: "The coordinator already recorded the conflict.",
      }],
    };

    expect(detectDivergentCrossRepositoryContracts(plan).unresolvedCrossRepositoryContracts).toHaveLength(1);
  });

  it("ignores a divergent literal that appears only in a test dossier entry", () => {
    const data = repository("Data", ["Create TRAFFIC_CHATGPT_AD_COST."], ["TRAFFIC_CHATGPT_AD_COST"]);
    const loader = repository("Loader", ["Assert the target table."], ["TRAFFIC_OPENAI_AD_COST"], ["Data"]);
    loader.executionDossier[0]!.writeRole = "test";

    expect((detectDivergentCrossRepositoryContracts(contract([data, loader])).unresolvedCrossRepositoryContracts ?? [])).toEqual([]);
  });

  it("surfaces a dossier divergence as a blocking shared-contract decision even when the coordinator declared none", () => {
    const data = repository("Data", ["Create TRAFFIC_CHATGPT_AD_COST."], ["TRAFFIC_CHATGPT_AD_COST"]);
    const loader = repository("Loader", ["Merge into the target table."], ["TRAFFIC_OPENAI_AD_COST"], ["Data"]);

    const surfaced = surfaceUnresolvedContractsAsDecisions(detectDivergentCrossRepositoryContracts(contract([data, loader])));
    const decision = surfaced.decisionRegister.find((entry) => entry.impact === "shared-contract");

    expect(decision).toBeDefined();
    expect(decision?.alternatives).toEqual(["TRAFFIC_CHATGPT_AD_COST", "TRAFFIC_OPENAI_AD_COST"]);
    expect(decision?.sharedContractSlot).toEqual({
      concept: "shared literal TRAFFIC_*_AD_COST",
      literalKind: "table name",
      affectedRepositoryIds: ["Data", "Loader"],
    });
    expect(surfaced.unresolvedCrossRepositoryContracts).toEqual([]);
    expect(hasBlockingPreDevelopDecision(surfaced.decisionRegister)).toBe(true);
  });

  it("does not flag a divergence when the consumer carries a multi-member table set the owner partially covers", () => {
    const data = repository("Data", ["Create the ad-level table."], ["TRAFFIC_CHATGPT_AD_COST"]);
    const loader = repository("Loader", ["Load all three grains."], ["TRAFFIC_CHATGPT_AD_COST", "TRAFFIC_CHATGPT_CAMPAIGN_COST", "TRAFFIC_CHATGPT_ADGROUP_COST"], ["Data"]);

    expect((detectDivergentCrossRepositoryContracts(contract([data, loader])).unresolvedCrossRepositoryContracts ?? [])).toEqual([]);
  });

  it("still flags a genuine single-vs-single sibling divergence", () => {
    const data = repository("Data", ["Create TRAFFIC_CHATGPT_AD_COST."], ["TRAFFIC_CHATGPT_AD_COST"]);
    const loader = repository("Loader", ["Merge into TRAFFIC_OPENAI_AD_COST."], ["TRAFFIC_OPENAI_AD_COST"], ["Data"]);

    expect(detectDivergentCrossRepositoryContracts(contract([data, loader])).unresolvedCrossRepositoryContracts).toHaveLength(1);
  });

  it("surfaces a destination-table-set coverage gap as one set-valued shared-contract decision", () => {
    const data = repository("Data", ["Define the ad-level table."], ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST"]);
    const loader = repository("Loader", ["Load all three grains."], ["tableName: 'TRAFFIC_CHATGPT_AD_COST'", "tableName: 'TRAFFIC_CHATGPT_CAMPAIGN_COST'", "tableName: 'TRAFFIC_CHATGPT_ADGROUP_COST'"], ["Data"]);

    const decision = detectDestinationTableGaps(contract([data, loader])).decisionRegister.find((entry) => entry.impact === "shared-contract");

    expect(decision).toBeDefined();
    expect(decision?.question).toContain("TRAFFIC_CHATGPT_CAMPAIGN_COST");
    expect(decision?.question).toContain("TRAFFIC_CHATGPT_ADGROUP_COST");
    expect(decision?.question).not.toContain("does not define TRAFFIC_CHATGPT_AD_COST");
    expect(decision?.requiredBefore).toBe("develop");
    expect(decision?.affectedRepositoryIds).toEqual(["Data", "Loader"]);
    expect(decision?.sharedContractSlot?.members).toEqual(["TRAFFIC_CHATGPT_ADGROUP_COST", "TRAFFIC_CHATGPT_AD_COST", "TRAFFIC_CHATGPT_CAMPAIGN_COST"]);
  });

  it("emits no table-set gap when the owner defines every table the consumer writes", () => {
    const data = repository("Data", ["Define both tables."], ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST", "CREATE TABLE MEDIA.TRAFFIC_CHATGPT_CAMPAIGN_COST"]);
    const loader = repository("Loader", ["Load both."], ["tableName: 'TRAFFIC_CHATGPT_AD_COST'", "tableName: 'TRAFFIC_CHATGPT_CAMPAIGN_COST'"], ["Data"]);

    expect(detectDestinationTableGaps(contract([data, loader])).decisionRegister).toEqual([]);
  });

  it("does not flag an owner-only extra table (directional)", () => {
    const data = repository("Data", ["Define two tables."], ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST", "CREATE TABLE MEDIA.TRAFFIC_CHATGPT_CAMPAIGN_COST"]);
    const loader = repository("Loader", ["Load only the ad table."], ["tableName: 'TRAFFIC_CHATGPT_AD_COST'"], ["Data"]);

    expect(detectDestinationTableGaps(contract([data, loader])).decisionRegister).toEqual([]);
  });
});

describe("selectScoutFocusFiles", () => {
  it("prefers the story-matching campaign implementation file over adjacent observer files", () => {
    const focused = selectScoutFocusFiles({
      title: "OpenAI campaign conversion",
      description: "Configure campaign pixel conversion tracking.",
      acceptanceCriteria: "Campaign conversion data is received.",
    }, {
      likelyFiles: [
        { path: "src/components/Admin/Pixels/Pixels.js", sha256: "a" },
        { path: "src/components/Reports/Pixels.js", sha256: "b" },
        { path: "src/components/Campaigns/Detail/Pixels.js", sha256: "c" },
      ],
      contractFunctions: [],
    });

    expect(focused[0]).toBe("src/components/Campaigns/Detail/Pixels.js");
  });

  it("prioritizes a configured ownership function even when its path lacks story terms", () => {
    const focused = selectScoutFocusFiles({
      title: "OpenAI conversion",
      description: "Send the conversion.",
      acceptanceCriteria: "Conversion is received.",
    }, {
      likelyFiles: [
        { path: "src/PixelTypes.js", sha256: "a" },
        { path: "src/Handler.js", sha256: "b" },
      ],
      contractFunctions: [{ filePath: "src/Handler.js", functionName: "getPublisherPixels" }],
    });

    expect(focused[0]).toBe("src/Handler.js");
  });

  it("includes configured additive anchors even when Fast preflight did not filename-match them", () => {
    const focused = selectScoutFocusFiles({
      title: "Add a named vendor conversion",
      description: "Create the integration.",
      acceptanceCriteria: "It is available.",
    }, {
      likelyFiles: [{ path: "testData/testData.js", sha256: "a" }],
      contractFunctions: [],
      scopeAnchors: [{ kind: "registry", filePath: "src/PixelTypes.js", marker: "module.exports = [", description: "Registered pixel types." }],
    });

    expect(focused).toEqual(expect.arrayContaining(["src/PixelTypes.js", "testData/testData.js"]));
    expect(focused[0]).toBe("src/PixelTypes.js");
  });
});

describe("repository applicability", () => {
  const changesRequired = (role: CoordinatedRepositoryPlan["applicability"]["role"]): CoordinatedRepositoryPlan => ({
    id: "Handler",
    scopeDisposition: "changes-required",
    applicability: {
      role,
      storyBinding: "campaign C123 events",
      routeOrDependency: "campaignKey selects configured pixels",
      evidence: ["src/Handler.js:42-58"],
    },
    plannedPaths: ["src/Handler.js"],
    evidence: ["src/Handler.js:42-58"],
    dependsOn: [],
    implementationSteps: ["Register the conversion type"],
    executionDossier: [],
    verificationCommands: [],
  });

  it("refuses to treat a generic capability as authority to write", () => {
    expect(applicabilityClaim(changesRequired("capability-only"))).toMatchObject({
      status: "refuted",
      phrase: "story applicability",
    });
  });

  it("routes a claimed runtime path to independent confirmation", () => {
    expect(applicabilityClaim(changesRequired("runtime-owner"))).toMatchObject({
      status: "unverified",
      phrase: "story applicability",
      citations: ["src/Handler.js:42-58"],
    });
  });

  it("recognizes a new contract mirror only when audited current siblings share its directory", () => {
    const entry = changesRequired("contract-mirror");
    entry.plannedPaths = ["MEDIA/TABLE/TRAFFIC_OPENAI_AD_COST.sql"];
    entry.executionDossier = [{
      path: "MEDIA/TABLE/TRAFFIC_OPENAI_AD_COST.sql",
      change: "Add the platform-specific advertising-cost table.",
      anchors: [],
      requiredSourceFragments: ["CREATE TABLE MEDIA.TRAFFIC_OPENAI_AD_COST"],
      writeRole: "contract-mirror",
      newFile: true,
      testScenarios: [],
    }];
    const packet = parseScoutPlanPacket(`\`\`\`json
${JSON.stringify({
      repositoryId: "Data",
      scopeDisposition: "changes-required",
      applicability: entry.applicability,
      evidence: ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1"],
      plannedPaths: entry.plannedPaths,
      implementationSteps: ["Add the platform-specific advertising-cost table."],
      executionDossier: entry.executionDossier,
      confirmedFacts: [],
      unresolvedFacts: [],
      establishedConventions: [],
      validationCommands: [],
    })}
\`\`\``, "Data");

    expect(additiveExtensionEvidence(entry, packet)).toEqual(["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1"]);
  });

  it("recognizes a new configuration-owner artifact created beside an audited current sibling", () => {
    const entry = changesRequired("configuration-owner");
    entry.plannedPaths = ["MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql"];
    entry.executionDossier = [{
      path: "MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql",
      change: "Add the ChatGPT advertising-cost table beside its siblings.",
      anchors: [],
      requiredSourceFragments: ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST"],
      writeRole: "configuration-owner",
      newFile: true,
      testScenarios: [],
    }];
    const packet = parseScoutPlanPacket(`\`\`\`json
${JSON.stringify({
      repositoryId: "Data",
      scopeDisposition: "changes-required",
      applicability: entry.applicability,
      evidence: ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1"],
      plannedPaths: entry.plannedPaths,
      implementationSteps: ["Add the ChatGPT advertising-cost table beside its siblings."],
      executionDossier: entry.executionDossier,
      confirmedFacts: [],
      unresolvedFacts: [],
      establishedConventions: [],
      validationCommands: [],
    })}
\`\`\``, "Data");

    expect(additiveExtensionEvidence(entry, packet)).toEqual(["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1"]);
  });

  it("does not treat a configuration-owner edit of an existing file as additive extension evidence", () => {
    const entry = changesRequired("configuration-owner");
    entry.plannedPaths = ["Scripts/Manifests/deployment_162941.txt"];
    entry.executionDossier = [{
      path: "Scripts/Manifests/deployment_162941.txt",
      change: "Append the new table path to the existing manifest.",
      anchors: ["Scripts/Manifests/deployment_162941.txt:1"],
      requiredSourceFragments: ["/MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql"],
      writeRole: "configuration-owner",
      newFile: false,
      testScenarios: [],
    }];
    const packet = parseScoutPlanPacket(`\`\`\`json
${JSON.stringify({
      repositoryId: "Data",
      scopeDisposition: "changes-required",
      applicability: entry.applicability,
      evidence: ["Scripts/Manifests/deployment_162941.txt:1"],
      plannedPaths: entry.plannedPaths,
      implementationSteps: ["Append the new table path to the existing manifest."],
      executionDossier: entry.executionDossier,
      confirmedFacts: [],
      unresolvedFacts: [],
      establishedConventions: [],
      validationCommands: [],
    })}
\`\`\``, "Data");

    expect(additiveExtensionEvidence(entry, packet)).toEqual([]);
  });

  it("does not anchor a new artifact whose only citation is in a different directory", () => {
    const entry = changesRequired("configuration-owner");
    entry.plannedPaths = ["MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql"];
    entry.executionDossier = [{
      path: "MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql",
      change: "Add the ChatGPT advertising-cost table with no sibling nearby.",
      anchors: [],
      requiredSourceFragments: ["CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST"],
      writeRole: "configuration-owner",
      newFile: true,
      testScenarios: [],
    }];
    const packet = parseScoutPlanPacket(`\`\`\`json
${JSON.stringify({
      repositoryId: "Data",
      scopeDisposition: "changes-required",
      applicability: { ...entry.applicability, evidence: ["Scripts/Manifests/deployment_157105.txt:1"] },
      evidence: ["Scripts/Manifests/deployment_157105.txt:1"],
      plannedPaths: entry.plannedPaths,
      implementationSteps: ["Add the ChatGPT advertising-cost table with no sibling nearby."],
      executionDossier: entry.executionDossier,
      confirmedFacts: [],
      unresolvedFacts: [],
      establishedConventions: [],
      validationCommands: [],
    })}
\`\`\``, "Data");

    expect(additiveExtensionEvidence(entry, packet)).toEqual([]);
  });
});

describe("buildBehavioralReviewPrompt", () => {
  it("instructs the critic that a parallel current entry confirms additive work and absence never refutes", () => {
    const job = { packet: { repositories: [{ id: "Data", baselineCommit: "abc123", likelyFiles: [] }] } } as unknown as PlanJob;
    const prompt = buildBehavioralReviewPrompt(job, "Data", [{
      stepIndex: -1, step: "Repository inclusion: Data", phrase: "story applicability", citations: [], status: "unverified", explanation: null,
    }]);

    expect(prompt).toContain("a cited parallel current entry IS the confirmation");
    expect(prompt).toContain("its absence is never grounds to refute when such a parallel current entry exists");
  });
});

describe("parseRepoScope", () => {
  it("parses a well-formed repository-scope block", () => {
    const output = [
      "## Ordered implementation tasks",
      "1. Do the thing.",
      "",
      "## Repository scope (JSON)",
      "```json",
      '{"primaryRepo": "Publisher.Portal", "additionalRepos": [{"id": "Publisher.Utils", "reason": "shared helper needs a new export"}]}',
      "```",
    ].join("\n");

    const scope = parseRepoScope(output, "Publisher.Portal");

    expect(scope.parseError).toBeNull();
    expect(scope.primaryRepo).toBe("Publisher.Portal");
    expect(scope.additionalRepos).toEqual([{ id: "Publisher.Utils", reason: "shared helper needs a new export" }]);
  });

  it("falls back to the primary repo with no additional repos when no repository is affected", () => {
    const output = "## Repository scope (JSON)\n```json\n{\"primaryRepo\": \"Publisher.Portal\", \"additionalRepos\": []}\n```";
    const scope = parseRepoScope(output, "Publisher.Portal");
    expect(scope).toEqual({ primaryRepo: "Publisher.Portal", additionalRepos: [], parseError: null });
  });

  it("degrades to a safe fallback, never throwing, when no JSON block is present", () => {
    const scope = parseRepoScope("Just some prose with no fenced block at all.", "Publisher.Portal");
    expect(scope.parseError).not.toBeNull();
    expect(scope.primaryRepo).toBe("Publisher.Portal");
    expect(scope.additionalRepos).toEqual([]);
  });

  it("degrades to a safe fallback when the JSON block is malformed", () => {
    const output = "## Repository scope (JSON)\n```json\n{not valid json\n```";
    const scope = parseRepoScope(output, "Publisher.Portal");
    expect(scope.parseError).toMatch(/did not parse/);
    expect(scope.primaryRepo).toBe("Publisher.Portal");
  });

  it("degrades to a safe fallback when an additionalRepos entry is missing an id", () => {
    const output = '## Repository scope (JSON)\n```json\n{"primaryRepo": "Publisher.Portal", "additionalRepos": [{"reason": "no id given"}]}\n```';
    const scope = parseRepoScope(output, "Publisher.Portal");
    expect(scope.parseError).toMatch(/missing id/);
  });

  it("uses the last fenced JSON block when the plan output contains more than one", () => {
    const output = [
      "```json",
      '{"unrelated": true}',
      "```",
      "## Repository scope (JSON)",
      "```json",
      '{"primaryRepo": "Publisher.Portal", "additionalRepos": []}',
      "```",
    ].join("\n");
    const scope = parseRepoScope(output, "Publisher.Portal");
    expect(scope.parseError).toBeNull();
    expect(scope.primaryRepo).toBe("Publisher.Portal");
  });
});

describe("parsePlannedPaths", () => {
  it("returns a distinct structured write boundary from the final planning contract", () => {
    const output = [
      "```json",
      '{"unrelated": true}',
      "```",
      "```json",
      '{"primaryRepo":"Publisher.Portal","additionalRepos":[],"plannedPaths":["src/app.js","src/components/Admin/Reports/","src/app.js"]}',
      "```",
    ].join("\n");

    expect(parsePlannedPaths(output)).toEqual({
      paths: ["src/app.js", "src/components/Admin/Reports/"],
      parseError: null,
    });
  });

  it("degrades to an empty unapprovable scope when plannedPaths is absent", () => {
    const parsed = parsePlannedPaths('```json\n{"primaryRepo":"Publisher.Portal","additionalRepos":[]}\n```');
    expect(parsed.paths).toEqual([]);
    expect(parsed.parseError).toMatch(/non-empty array/);
  });

  it("rejects globs, absolute paths, and parent traversal", () => {
    for (const path of ["src/**/*.ts", "/etc/passwd", "C:/Windows/System32", "../outside.ts"]) {
      const parsed = parsePlannedPaths(`\`\`\`json\n{"plannedPaths":[${JSON.stringify(path)}]}\n\`\`\``);
      expect(parsed.paths).toEqual([]);
      expect(parsed.parseError).toMatch(/unsafe or unsupported/);
    }
  });
});

describe("parseCoordinatedPlan", () => {
  const completeTestExecutionDossier = (output: string): string => output.replace(/```json\n([\s\S]*?)\n```/, (_match, json: string) => {
    const contract = JSON.parse(json) as Record<string, unknown>;
    const complete = (entry: Record<string, unknown>): void => {
      const paths = Array.isArray(entry.plannedPaths) ? entry.plannedPaths.filter((path): path is string => typeof path === "string" && !path.endsWith("/")) : [];
      const existing = new Map((Array.isArray(entry.executionDossier) ? entry.executionDossier : [])
        .filter((dossier): dossier is Record<string, unknown> => typeof dossier === "object" && dossier !== null && !Array.isArray(dossier))
        .flatMap((dossier) => typeof dossier.path === "string" ? [[dossier.path, dossier] as const] : []));
      entry.executionDossier = paths.map((path) => ({
        path,
        change: "Update the planned behavior in this file.",
        anchors: [`${path}:1`],
        requiredSourceFragments: ["requested behavior"],
        newFile: false,
        testScenarios: [],
        writeRole: /(?:^|\/)(?:test|tests)(?:\/|$)|(?:^|\.)test\./i.test(path) ? "test" : "configuration-owner",
        requiredBy: ["The requested story behavior must be delivered."],
        causalPath: `story request -> ${path} -> requested behavior`,
        necessity: "Leaving this required file unchanged prevents the requested behavior from being delivered.",
        ...existing.get(path),
      }));
    };
    if (Array.isArray(contract.repositories)) contract.repositories.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)).forEach(complete);
    else complete(contract);
    return `\`\`\`json\n${JSON.stringify(contract)}\n\`\`\``;
  });

  it("requires an applicability proof for a single-repository write boundary", () => {
    const withoutProof = '```json\n{"scopeDisposition":"changes-required","plannedPaths":["src/ReportDelivery.html"],"evidence":["src/ReportDelivery.html:103"],"implementationSteps":["Rename the label"]}\n```';
    expect(parseCoordinatedPlan(withoutProof, ["Portal"]).parseError).toMatch(/applicability proof/);

    const withProof = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"configuration-owner","storyBinding":"Report Delivery authentication label","routeOrDependency":"the ReportDelivery template renders the selected authentication method","evidence":["src/ReportDelivery.html:99-107"]},"plannedPaths":["src/ReportDelivery.html"],"evidence":["src/ReportDelivery.html:99-107"],"implementationSteps":["Rename the label"]}\n```';
    expect(parseCoordinatedPlan(completeTestExecutionDossier(withProof), ["Portal"]).repositories[0]).toMatchObject({
      scopeDisposition: "changes-required",
      applicability: { role: "configuration-owner" },
    });
  });

  it("rejects a source handoff that omits enforceable final-source fragments", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"configuration-owner","storyBinding":"campaign conversion setup","routeOrDependency":"the editor persists the selected type","evidence":["src/Pixels.js:12"]},"plannedPaths":["src/Pixels.js"],"evidence":["src/Pixels.js:12"],"implementationSteps":["Add the conversion template"],"executionDossier":[{"path":"src/Pixels.js","change":"Add the configured conversion template.","anchors":["src/Pixels.js:12"],"writeRole":"configuration-owner"}]}\n```';

    expect(parseCoordinatedPlan(output, ["Portal"]).parseError).toMatch(/requiredSourceFragments/);
  });

  it("keeps only approved, source-cited execution handoff entries", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"configuration-owner","storyBinding":"Report Delivery authentication label","routeOrDependency":"the ReportDelivery template renders the selected authentication method","evidence":["src/ReportDelivery.html:99-107"]},"plannedPaths":["src/ReportDelivery.html","test/ReportDelivery.test.js"],"evidence":["src/ReportDelivery.html:99-107"],"implementationSteps":["Rename the label"],"executionDossier":[{"path":"src/ReportDelivery.html","change":"Replace the rendered label.","anchors":["src/ReportDelivery.html:99-107","README.md:1"]},{"path":"test/ReportDelivery.test.js","change":"Assert the renamed label.","anchors":[],"newFile":true,"testScenarios":["renders Private Key"]},{"path":"README.md","change":"Unapproved cleanup.","anchors":["README.md:1"]}]}\n```';
    const parsed = parseCoordinatedPlan(completeTestExecutionDossier(output), ["Portal"]);

    expect(parsed.repositories[0]?.executionDossier).toMatchObject([
      { path: "src/ReportDelivery.html", change: "Replace the rendered label.", anchors: ["src/ReportDelivery.html:99-107"], newFile: false, testScenarios: [] },
      { path: "test/ReportDelivery.test.js", change: "Assert the renamed label.", anchors: [], newFile: true, testScenarios: [{ name: "renders Private Key", fixtures: [], assertions: ["renders Private Key"] }] },
    ]);
  });

  it("preserves structured test scenarios with their fixtures and assertions", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"configuration-owner","storyBinding":"Report Delivery authentication label","routeOrDependency":"the ReportDelivery template renders the selected authentication method","evidence":["src/ReportDelivery.html:99-107"]},"plannedPaths":["test/ReportDelivery.test.js"],"evidence":["src/ReportDelivery.html:99-107"],"implementationSteps":["Add the requested label coverage"],"executionDossier":[{"path":"test/ReportDelivery.test.js","change":"Add a regression for the rendered label.","anchors":[],"newFile":true,"testScenarios":[{"name":"Renders the renamed credential label","fixtures":["A report-delivery authentication form"],"assertions":["The form displays Private Key","The form does not display Public Key"]}]}]}\n```';

    expect(parseCoordinatedPlan(completeTestExecutionDossier(output), ["Portal"]).repositories[0]?.executionDossier[0]?.testScenarios).toEqual([
      {
        name: "Renders the renamed credential label",
        fixtures: ["A report-delivery authentication form"],
        assertions: ["The form displays Private Key", "The form does not display Public Key"],
      },
    ]);
  });

  it("accepts a minimal source-cited handoff without redundant traceability fields", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"configuration-owner","storyBinding":"Report Delivery authentication label","routeOrDependency":"the template renders the selected authentication method","evidence":["src/ReportDelivery.html:99"]},"plannedPaths":["src/ReportDelivery.html"],"evidence":["src/ReportDelivery.html:99"],"implementationSteps":["Rename the rendered label"],"executionDossier":[{"path":"src/ReportDelivery.html","change":"Replace the rendered Public Key label with Private Key.","anchors":["src/ReportDelivery.html:99"],"requiredSourceFragments":["Private Key"],"writeRole":"configuration-owner"}]}\n```';

    expect(parseCoordinatedPlan(output, ["Portal"]).parseError).toBeNull();
  });

  it("rejects a plan that names a test file without an executable test handoff", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"configuration-owner","storyBinding":"Report Delivery authentication label","routeOrDependency":"the ReportDelivery template renders the selected authentication method","evidence":["src/ReportDelivery.html:99-107"]},"plannedPaths":["src/ReportDelivery.html","test/ReportDelivery.test.js"],"evidence":["src/ReportDelivery.html:99-107"],"implementationSteps":["Rename the label"],"executionDossier":[{"path":"src/ReportDelivery.html","change":"Replace the rendered label.","anchors":["src/ReportDelivery.html:99-107"]},{"path":"test/ReportDelivery.test.js","change":"Add the requested label coverage.","anchors":[],"newFile":true}]}\n```';

    expect(parseCoordinatedPlan(completeTestExecutionDossier(output), ["Portal"]).parseError)
      .toContain("must enumerate expected assertions");
  });

  it("rejects test scenarios attached to production source without an approved test boundary", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"server conversion","routeOrDependency":"the type registry dispatches the configured event","evidence":["src/PixelTypes.js:11"]},"plannedPaths":["src/PixelTypes.js"],"evidence":["src/PixelTypes.js:11"],"implementationSteps":["Register the server conversion type"],"executionDossier":[{"path":"src/PixelTypes.js","change":"Register the server conversion type.","anchors":["src/PixelTypes.js:11"],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"runtime-owner","newFile":false,"testScenarios":[{"name":"The type is registered","fixtures":[],"assertions":["The registry includes ChatGPTConversion"]}]}]}\n```';

    expect(parseCoordinatedPlan(output, ["Runtime"]).parseError)
      .toContain("must place testScenarios in a planned test path");
  });

  it("rejects a runtime handoff that omits tests when the baseline has a test harness", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"server conversion","routeOrDependency":"the type registry dispatches the configured event","evidence":["src/PixelTypes.js:11"]},"plannedPaths":["src/PixelTypes.js"],"evidence":["src/PixelTypes.js:11"],"implementationSteps":["Register the server conversion type"],"executionDossier":[{"path":"src/PixelTypes.js","change":"Register the server conversion type.","anchors":["src/PixelTypes.js:11"],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"runtime-owner","newFile":false,"testScenarios":[]}]}\n```';

    expect(parseCoordinatedPlan(output, ["Runtime"], ["Runtime"], { Runtime: { testPaths: ["test/runtime.test.js"] } }).parseError)
      .toContain("must include a planned test path with expected assertions");
  });

  it("accepts a runtime handoff with a planned test and concrete assertions", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"server conversion","routeOrDependency":"the type registry dispatches the configured event","evidence":["src/PixelTypes.js:11"]},"plannedPaths":["src/PixelTypes.js","test/ChatGPTConversion.test.js"],"evidence":["src/PixelTypes.js:11"],"implementationSteps":["Register the server conversion type and its regression coverage"],"executionDossier":[{"path":"src/PixelTypes.js","change":"Register the server conversion type.","anchors":["src/PixelTypes.js:11"],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"runtime-owner","newFile":false,"testScenarios":[]},{"path":"test/ChatGPTConversion.test.js","change":"Cover registered ChatGPT conversion dispatch.","anchors":[],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"test","newFile":true,"testScenarios":[{"name":"Dispatches the registered ChatGPT conversion","fixtures":["An audited conversion event with ChatGPTConversion"],"assertions":["The registered event type is selected","The configured payload is dispatched"]}]}]}\n```';

    expect(parseCoordinatedPlan(output, ["Runtime"], ["Runtime"], { Runtime: { testPaths: ["test/runtime.test.js"] } }).parseError).toBeNull();
  });

  it("rejects an unrelated tracked test file as coverage for a component change", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"configuration-owner","storyBinding":"campaign conversion setup","routeOrDependency":"the campaign pixel registry persists the selected conversion","evidence":["src/components/Campaigns/Detail/Pixels.js:316"]},"plannedPaths":["src/components/Campaigns/Detail/Pixels.js","src/config/config.test.js"],"evidence":["src/components/Campaigns/Detail/Pixels.js:316"],"implementationSteps":["Add the campaign conversion definition and its regression coverage."],"executionDossier":[{"path":"src/components/Campaigns/Detail/Pixels.js","change":"Add the ChatGPT conversion registry definition.","anchors":["src/components/Campaigns/Detail/Pixels.js:316"],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"configuration-owner","newFile":false,"testScenarios":[]},{"path":"src/config/config.test.js","change":"Cover the ChatGPT conversion definition.","anchors":["src/config/config.test.js:1"],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"test","newFile":false,"testScenarios":[{"name":"Shows the ChatGPT conversion","fixtures":[],"assertions":["The registry includes ChatGPTConversion"]}]}]}\n```';

    expect(parseCoordinatedPlan(output, ["Portal"], ["Portal"], {
      Portal: { testPaths: ["src/config/config.test.js"], runnerDetected: true, sourcePathsByTestPath: { "src/config/config.test.js": [] } },
    }).parseError).toContain("generic test filename alone does not establish coverage");
  });

  it("accepts a source-adjacent component test under a configured runner", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"configuration-owner","storyBinding":"campaign conversion setup","routeOrDependency":"the campaign pixel registry persists the selected conversion","evidence":["src/components/Campaigns/Detail/Pixels.js:316"]},"plannedPaths":["src/components/Campaigns/Detail/Pixels.js","src/components/Campaigns/Detail/Pixels.test.js"],"evidence":["src/components/Campaigns/Detail/Pixels.js:316"],"implementationSteps":["Add the campaign conversion definition and its regression coverage."],"executionDossier":[{"path":"src/components/Campaigns/Detail/Pixels.js","change":"Add the ChatGPT conversion registry definition.","anchors":["src/components/Campaigns/Detail/Pixels.js:316"],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"configuration-owner","newFile":false,"testScenarios":[]},{"path":"src/components/Campaigns/Detail/Pixels.test.js","change":"Cover the ChatGPT conversion definition.","anchors":[],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"test","newFile":true,"testScenarios":[{"name":"Shows the ChatGPT conversion","fixtures":[],"assertions":["The registry includes ChatGPTConversion"]}]}]}\n```';

    expect(parseCoordinatedPlan(output, ["Portal"], ["Portal"], {
      Portal: { testPaths: ["src/config/config.test.js"], runnerDetected: true, sourcePathsByTestPath: { "src/config/config.test.js": [] } },
    }).parseError).toBeNull();
  });

  it("accepts an active repository-wide test entry point for runtime coverage", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"server conversion","routeOrDependency":"the pixel registry dispatches configured event types","evidence":["src/PixelTypes.js:11"]},"plannedPaths":["src/PixelTypes.js","test.js"],"evidence":["src/PixelTypes.js:11"],"implementationSteps":["Register the server conversion type and extend the active test entry point."],"executionDossier":[{"path":"src/PixelTypes.js","change":"Register the ChatGPT conversion type.","anchors":["src/PixelTypes.js:11"],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"runtime-owner","newFile":false,"testScenarios":[]},{"path":"test.js","change":"Cover the ChatGPT conversion dispatch.","anchors":["test.js:1"],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"test","newFile":false,"testScenarios":[{"name":"Dispatches ChatGPT conversion","fixtures":[],"assertions":["The registry selects ChatGPTConversion"]}]}]}\n```';

    expect(parseCoordinatedPlan(output, ["Runtime"], ["Runtime"], {
      Runtime: { testPaths: ["test.js"], activeTestPaths: ["test.js"], runnerDetected: true, sourcePathsByTestPath: { "test.js": [] } },
    }).parseError).toBeNull();
  });

  it("accepts a new test in the repository's own test tree that names the changed file", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"OpenAI Ads cost ingestion","routeOrDependency":"the platform registry dispatches the configured platform worker","evidence":["src/workers/OpenAIWorker.js:1"]},"plannedPaths":["src/workers/OpenAIWorker.js","integrations/unit/openaiWorker.test.js"],"evidence":["src/workers/OpenAIWorker.js:1"],"implementationSteps":["Add the OpenAI worker and its regression coverage."],"executionDossier":[{"path":"src/workers/OpenAIWorker.js","change":"Implement the OpenAI Ads insights worker.","anchors":["src/workers/OpenAIWorker.js:1"],"requiredSourceFragments":["registerOpenAIWorker"],"writeRole":"runtime-owner","newFile":true,"testScenarios":[]},{"path":"integrations/unit/openaiWorker.test.js","change":"Cover the OpenAI worker request and transformation.","anchors":[],"requiredSourceFragments":["import { OpenAIWorker } from \'../../src/workers/OpenAIWorker.js\';"],"writeRole":"test","newFile":true,"testScenarios":[{"name":"Requests OpenAI insights","fixtures":["A mock OpenAI account config"],"assertions":["The worker authenticates with a Bearer token"]}]}]}\n```';

    // The test imports the changed file via a differently-rooted path, so the strict
    // exact-fragment match cannot accept it; only the baseline-test-directory signal can.
    expect(parseCoordinatedPlan(output, ["MoneyBadger"], ["MoneyBadger"], {
      MoneyBadger: { testPaths: ["integrations/unit/facebookWorker.test.js", "integrations/unit/platformRegistry.test.js"], runnerDetected: true, sourcePathsByTestPath: { "integrations/unit/facebookWorker.test.js": ["src/workers/FacebookWorker.js"] } },
    }).parseError).toBeNull();
  });

  it("rejects a new test in a directory the baseline never uses for tests", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"OpenAI Ads cost ingestion","routeOrDependency":"the platform registry dispatches the configured platform worker","evidence":["src/workers/OpenAIWorker.js:1"]},"plannedPaths":["src/workers/OpenAIWorker.js","integrations/e2e/openaiWorker.test.js"],"evidence":["src/workers/OpenAIWorker.js:1"],"implementationSteps":["Add the OpenAI worker and its regression coverage."],"executionDossier":[{"path":"src/workers/OpenAIWorker.js","change":"Implement the OpenAI Ads insights worker.","anchors":["src/workers/OpenAIWorker.js:1"],"requiredSourceFragments":["registerOpenAIWorker"],"writeRole":"runtime-owner","newFile":true,"testScenarios":[]},{"path":"integrations/e2e/openaiWorker.test.js","change":"Cover the OpenAI worker request and transformation.","anchors":[],"requiredSourceFragments":["import { OpenAIWorker } from \'../../src/workers/OpenAIWorker.js\';"],"writeRole":"test","newFile":true,"testScenarios":[{"name":"Requests OpenAI insights","fixtures":["A mock OpenAI account config"],"assertions":["The worker authenticates with a Bearer token"]}]}]}\n```';

    expect(parseCoordinatedPlan(output, ["MoneyBadger"], ["MoneyBadger"], {
      MoneyBadger: { testPaths: ["integrations/unit/facebookWorker.test.js"], runnerDetected: true, sourcePathsByTestPath: { "integrations/unit/facebookWorker.test.js": ["src/workers/FacebookWorker.js"] } },
    }).parseError).toContain("generic test filename alone does not establish coverage");
  });

  it("accepts a new test that matches the configured runner's glob even with no co-located baseline test", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"OpenAI Ads cost ingestion","routeOrDependency":"the platform registry dispatches the configured platform worker","evidence":["src/workers/OpenAIWorker.js:1"]},"plannedPaths":["src/workers/OpenAIWorker.js","integrations/unit/openaiWorker.test.js"],"evidence":["src/workers/OpenAIWorker.js:1"],"implementationSteps":["Add the OpenAI worker and its regression coverage."],"executionDossier":[{"path":"src/workers/OpenAIWorker.js","change":"Implement the OpenAI Ads insights worker.","anchors":["src/workers/OpenAIWorker.js:1"],"requiredSourceFragments":["registerOpenAIWorker"],"writeRole":"runtime-owner","newFile":true,"testScenarios":[]},{"path":"integrations/unit/openaiWorker.test.js","change":"Cover the OpenAI worker request and transformation.","anchors":[],"requiredSourceFragments":["import { OpenAIWorker } from \'../../src/workers/OpenAIWorker.js\';"],"writeRole":"test","newFile":true,"testScenarios":[{"name":"Requests OpenAI insights","fixtures":["A mock OpenAI account config"],"assertions":["The worker authenticates with a Bearer token"]}]}]}\n```';

    // The runner executes a glob (node --test 'integrations/unit/*.test.js'); a new file matching it
    // is an active entry point even with no co-located baseline test path recorded.
    expect(parseCoordinatedPlan(output, ["MoneyBadger"], ["MoneyBadger"], {
      MoneyBadger: { testPaths: [], runnerGlobs: ["integrations/unit/*.test.js"], runnerDetected: true },
    }).parseError).toBeNull();
  });

  it("still rejects a new test that matches no runner glob and no baseline test directory", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"OpenAI Ads cost ingestion","routeOrDependency":"the platform registry dispatches the configured platform worker","evidence":["src/workers/OpenAIWorker.js:1"]},"plannedPaths":["src/workers/OpenAIWorker.js","integrations/e2e/openaiWorker.test.js"],"evidence":["src/workers/OpenAIWorker.js:1"],"implementationSteps":["Add the OpenAI worker and its regression coverage."],"executionDossier":[{"path":"src/workers/OpenAIWorker.js","change":"Implement the OpenAI Ads insights worker.","anchors":["src/workers/OpenAIWorker.js:1"],"requiredSourceFragments":["registerOpenAIWorker"],"writeRole":"runtime-owner","newFile":true,"testScenarios":[]},{"path":"integrations/e2e/openaiWorker.test.js","change":"Cover the OpenAI worker request and transformation.","anchors":[],"requiredSourceFragments":["import { OpenAIWorker } from \'../../src/workers/OpenAIWorker.js\';"],"writeRole":"test","newFile":true,"testScenarios":[{"name":"Requests OpenAI insights","fixtures":["A mock OpenAI account config"],"assertions":["The worker authenticates with a Bearer token"]}]}]}\n```';

    expect(parseCoordinatedPlan(output, ["MoneyBadger"], ["MoneyBadger"], {
      MoneyBadger: { testPaths: [], runnerGlobs: ["integrations/unit/*.test.js"], runnerDetected: true },
    }).parseError).toContain("generic test filename alone does not establish coverage");
  });

  it("rejects a planned test when the baseline has no executable test harness", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"configuration-owner","storyBinding":"campaign conversion setup","routeOrDependency":"the campaign pixel registry persists the selected conversion","evidence":["src/components/Campaigns/Detail/Pixels.js:316"]},"plannedPaths":["src/components/Campaigns/Detail/Pixels.js","src/config/config.test.js"],"evidence":["src/components/Campaigns/Detail/Pixels.js:316"],"implementationSteps":["Add the campaign conversion definition and its regression coverage."],"executionDossier":[{"path":"src/components/Campaigns/Detail/Pixels.js","change":"Add the ChatGPT conversion registry definition.","anchors":["src/components/Campaigns/Detail/Pixels.js:316"],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"configuration-owner","newFile":false,"testScenarios":[]},{"path":"src/config/config.test.js","change":"Cover the ChatGPT conversion definition.","anchors":["src/config/config.test.js:1"],"requiredSourceFragments":["ChatGPTConversion"],"writeRole":"test","newFile":false,"testScenarios":[{"name":"Shows the ChatGPT conversion","fixtures":[],"assertions":["The registry includes ChatGPTConversion"]}]}]}\n```';

    expect(parseCoordinatedPlan(output, ["Portal"], ["Portal"], {
      Portal: { testPaths: [], activeTestPaths: [], runnerDetected: false, sourcePathsByTestPath: {} },
    }).parseError).toContain("no executable test harness");
  });

  it("does not require a regression test for a contract-mirror-only packet", () => {
    const output = '```json\n{"repositoryId":"Schema","completion":{"outcome":"direct-path-confirmed","basis":"The schema directory owns this table extension.","handoffDependencies":[]},"scopeDisposition":"changes-required","applicability":{"role":"contract-mirror","storyBinding":"warehouse persistence","routeOrDependency":"the deployment manifest applies table DDL","evidence":["MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql:1"]},"evidence":["MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql:1"],"confirmedFacts":[],"unresolvedFacts":[],"establishedConventions":[],"plannedPaths":["MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql"],"implementationSteps":["Add the approved table contract."],"executionDossier":[{"path":"MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql","change":"Add the approved table contract.","anchors":["MEDIA/TABLE/TRAFFIC_VENDOR_COST.sql:1"],"requiredSourceFragments":["TRAFFIC_VENDOR_COST"],"writeRole":"contract-mirror","newFile":false,"testScenarios":[]}],"validationCommands":[]}\n```';

    expect(parseScoutPlanPacket(output, "Schema", { testPaths: ["test/schema.test.js"] }).parseError).toBeNull();
  });

  it("accepts a planned test path whose literals live in its assertions, without production-source fragments", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"OpenAI Ads cost ingestion","routeOrDependency":"the platform registry dispatches the configured platform worker","evidence":["src/workers/OpenAIWorker.js:1"]},"plannedPaths":["src/workers/OpenAIWorker.js","integrations/unit/openaiWorker.test.js"],"evidence":["src/workers/OpenAIWorker.js:1"],"implementationSteps":["Add the OpenAI worker and its regression coverage."],"executionDossier":[{"path":"src/workers/OpenAIWorker.js","change":"Implement the OpenAI Ads insights worker.","anchors":["src/workers/OpenAIWorker.js:1"],"requiredSourceFragments":["registerOpenAIWorker"],"writeRole":"runtime-owner","newFile":true,"testScenarios":[]},{"path":"integrations/unit/openaiWorker.test.js","change":"Cover the OpenAI worker request and transformation.","anchors":[],"requiredSourceFragments":[],"writeRole":"test","newFile":true,"testScenarios":[{"name":"Requests OpenAI insights","fixtures":["A mock OpenAI account config"],"assertions":["The worker authenticates with a Bearer token"]}]}]}\n```';

    // A test path's exact literals are its assertions (required separately); it need not also
    // duplicate production-source requiredSourceFragments. This is the config.test.js block fix.
    expect(parseCoordinatedPlan(output, ["MoneyBadger"], ["MoneyBadger"], {
      MoneyBadger: { testPaths: [], runnerGlobs: ["integrations/unit/*.test.js"], runnerDetected: true },
    }).parseError).toBeNull();
  });

  it("still requires requiredSourceFragments on a non-test planned path", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"OpenAI Ads cost ingestion","routeOrDependency":"the platform registry dispatches the configured platform worker","evidence":["src/workers/OpenAIWorker.js:1"]},"plannedPaths":["src/workers/OpenAIWorker.js"],"evidence":["src/workers/OpenAIWorker.js:1"],"implementationSteps":["Add the OpenAI worker."],"executionDossier":[{"path":"src/workers/OpenAIWorker.js","change":"Implement the OpenAI Ads insights worker.","anchors":["src/workers/OpenAIWorker.js:1"],"requiredSourceFragments":[],"writeRole":"runtime-owner","newFile":true,"testScenarios":[]}]}\n```';

    expect(parseCoordinatedPlan(output, ["MoneyBadger"], ["MoneyBadger"]).parseError)
      .toContain("must provide exact requiredSourceFragments");
  });

  it("rejects an observer-only file from the executable write boundary", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"configuration-owner","storyBinding":"Campaign conversion setup","routeOrDependency":"the campaign editor persists the selected pixel","evidence":["src/CampaignPixels.js:12"]},"plannedPaths":["src/ReportsPixels.js"],"evidence":["src/ReportsPixels.js:44"],"implementationSteps":["Add the conversion type"],"executionDossier":[{"path":"src/ReportsPixels.js","change":"Add the conversion label to the report filter.","anchors":["src/ReportsPixels.js:44"],"writeRole":"observer","requiredBy":["Campaign conversion can be configured"],"causalPath":"campaign configuration -> report filter -> displayed label","necessity":"The report is useful for operational visibility after a conversion is configured."}]}\n```';

    expect(parseCoordinatedPlan(output, ["Portal"]).parseError)
      .toContain("must classify why planned path src/ReportsPixels.js is a required write");
  });

  it("qualifies paths and dependencies by selected repository", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"Api","scopeDisposition":"changes-required","evidence":[],"rationale":"Owns API"},{"id":"Ui","scopeDisposition":"changes-required","evidence":["src/ui.ts:4"],"rationale":"Consumes API"}],"repositories":[{"id":"Api","plannedPaths":["src/api.ts"],"dependsOn":[],"implementationSteps":["Add contract"]},{"id":"Ui","plannedPaths":["src/ui.ts"],"dependsOn":["Api"],"implementationSteps":["Consume contract"]}],"implementationOrder":["Api","Ui"],"suggestedRepositories":[],"questionsOrClarifications":["Confirm which team owns the shared contract rollout."]}\n```';
    const parsed = parseCoordinatedPlan(completeTestExecutionDossier(output), ["Api", "Ui"]);

    expect(parsed.parseError).toBeNull();
    expect(parsed.executionOrder).toEqual(["Api", "Ui"]);
    expect(parsed.questionsOrClarifications).toEqual(["Confirm which team owns the shared contract rollout."]);
    expect(parsed.repositories[1]).toMatchObject({ id: "Ui", plannedPaths: ["src/ui.ts"], evidence: ["src/ui.ts:4"], dependsOn: ["Api"] });
  });

  it("blocks approval for an explicit repository-boundary decision without manufacturing a behavioral claim", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"PixelHandler","scopeDisposition":"verified-no-change","applicability":{"role":"capability-only","storyBinding":"campaign conversion","routeOrDependency":"does not select campaign pixels","evidence":["src/Handler.js:735-759"]},"evidence":["src/Handler.js:735-759"],"rationale":"The configured campaign never reaches this handler."},{"id":"PostbackHandler","scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"campaign conversion","routeOrDependency":"selects configured campaign pixels","evidence":["src/Handler.js:167"]},"evidence":["src/Handler.js:167"],"rationale":"Owns the selected route."}],"repositories":[{"id":"PostbackHandler","plannedPaths":["src/Handler.js"],"dependsOn":[],"implementationSteps":["Add the conversion"]}],"implementationOrder":["PostbackHandler"],"decisionRequests":["Should PixelHandler or PostbackHandler deliver the conversion?"],"decisionRegister":[{"question":"Should PixelHandler or PostbackHandler deliver the conversion?","recommendation":"Use PostbackHandler.","alternatives":["Use PixelHandler only if routing evidence changes."],"requiredBefore":"develop","impact":"repository-boundary","affectedRepositoryIds":["PixelHandler","PostbackHandler"],"rationale":"The owner is unclear."}]}\n```';
    const parsed = parseCoordinatedPlan(completeTestExecutionDossier(output), ["PixelHandler", "PostbackHandler"]);
    expect(parsed.parseError).toBeNull();
    expect(hasBlockingRepositoryBoundaryDecision(parsed.decisionRegister)).toBe(true);
  });

  it("does not treat an implementation decision as a pre-Develop gate", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"PixelHandler","scopeDisposition":"verified-no-change","applicability":{"role":"capability-only","storyBinding":"campaign conversion","routeOrDependency":"does not select campaign pixels","evidence":["src/Handler.js:735-759"]},"evidence":["src/Handler.js:735-759"],"rationale":"The configured campaign never reaches this handler."},{"id":"PostbackHandler","scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"campaign conversion","routeOrDependency":"selects configured campaign pixels","evidence":["src/Handler.js:167"]},"evidence":["src/Handler.js:167"],"rationale":"Owns the selected route."}],"repositories":[{"id":"PostbackHandler","plannedPaths":["src/Handler.js"],"dependsOn":[],"implementationSteps":["Add the conversion"]}],"implementationOrder":["PostbackHandler"],"decisionRequests":["Choose the exact identifier registered by PostbackHandler. This decision does not add work to PixelHandler."],"decisionRegister":[{"question":"Choose the exact identifier registered by PostbackHandler. This decision does not add work to PixelHandler.","recommendation":"Use the existing naming convention.","alternatives":[],"requiredBefore":"develop","impact":"implementation","affectedRepositoryIds":["PostbackHandler"],"rationale":"Only the PostbackHandler registry changes."}]}\n```';
    const parsed = parseCoordinatedPlan(completeTestExecutionDossier(output), ["PixelHandler", "PostbackHandler"]);
    expect(parsed.parseError).toBeNull();
    expect(hasBlockingRepositoryBoundaryDecision(parsed.decisionRegister)).toBe(false);
    expect(hasBlockingPreDevelopDecision(parsed.decisionRegister)).toBe(false);
  });

  it("keeps structured applicability separate from a repository's generic capability", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"GlobalHandler","scopeDisposition":"verified-no-change","applicability":{"role":"capability-only","storyBinding":"campaign C123","routeOrDependency":"reads an admin-global list","evidence":["src/Handler.js:70-84"]},"evidence":["src/Handler.js:70-84"],"rationale":"The campaign is not selected here."},{"id":"CampaignHandler","scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"campaign C123","routeOrDependency":"campaignKey selects configured pixels","evidence":["src/Handler.js:101-120"]},"evidence":["src/Handler.js:101-120"],"rationale":"The campaign reaches this handler."}],"repositories":[{"id":"CampaignHandler","plannedPaths":["src/Handler.js"],"dependsOn":[],"implementationSteps":["Register the conversion type"]}],"implementationOrder":["CampaignHandler"],"suggestedRepositories":[],"questionsOrClarifications":[]}\n```';

    const parsed = parseCoordinatedPlan(completeTestExecutionDossier(output), ["GlobalHandler", "CampaignHandler"]);

    expect(parsed.parseError).toBeNull();
    expect(parsed.repositories.find((entry) => entry.id === "GlobalHandler")?.applicability.role).toBe("capability-only");
    expect(parsed.repositories.find((entry) => entry.id === "CampaignHandler")?.applicability).toMatchObject({
      role: "runtime-owner",
      storyBinding: "campaign C123",
      routeOrDependency: "campaignKey selects configured pixels",
    });
  });

  it("separates plan-changing decisions from operational and separately scoped follow-ups", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"Api","scopeDisposition":"changes-required","evidence":["src/api.ts:1"],"rationale":"Owns delivery"}],"repositories":[{"id":"Api","plannedPaths":["src/api.ts"],"dependsOn":[],"implementationSteps":["Implement delivery"]}],"implementationOrder":["Api"],"suggestedRepositories":[],"decisionRequests":["Which event identifier is stable across retries?"],"operationalFollowUps":["Provision the deployment-managed credential."],"outOfScopeFollowUps":["Track the separate warehouse ingestion task elsewhere."]}\n```';
    const parsed = parseCoordinatedPlan(completeTestExecutionDossier(output), ["Api"]);

    expect(parsed.questionsOrClarifications).toEqual(["Which event identifier is stable across retries?"]);
    expect(parsed.operationalFollowUps).toEqual(["Provision the deployment-managed credential."]);
    expect(parsed.outOfScopeFollowUps).toEqual(["Track the separate warehouse ingestion task elsewhere."]);
  });

  it("uses the decision contract instead of inferring repository ownership from question wording", () => {
    expect(hasBlockingRepositoryBoundaryDecision([{
      question: "Approve OpenAIConversion as the canonical discriminator shared by Publisher.MicroService.PostbackHandler and Publisher.Portal.",
      recommendation: "Use OpenAIConversion.",
      alternatives: ["Use ChatGPTConversion only if the runtime owner requires it."],
      requiredBefore: "develop",
      impact: "implementation",
      affectedRepositoryIds: ["Publisher.MicroService.PostbackHandler", "Publisher.Portal"],
      rationale: "The answer changes existing source edits but not the owning repositories.",
    }])).toBe(false);
    expect(hasBlockingPreDevelopDecision([{
      question: "Approve OpenAIConversion as the canonical discriminator shared by Publisher.MicroService.PostbackHandler and Publisher.Portal.",
      recommendation: "Use OpenAIConversion.",
      alternatives: ["Use ChatGPTConversion only if the runtime owner requires it."],
      requiredBefore: "develop",
      impact: "implementation",
      affectedRepositoryIds: ["Publisher.MicroService.PostbackHandler", "Publisher.Portal"],
      rationale: "The answer changes existing source edits but not the owning repositories.",
    }])).toBe(false);
    expect(hasBlockingRepositoryBoundaryDecision([{
      question: "Should Publisher.Portal or Publisher.MicroService.PostbackHandler deliver this conversion?",
      recommendation: "Use Publisher.MicroService.PostbackHandler.",
      alternatives: ["Use Publisher.Portal if the route evidence changes."],
      requiredBefore: "develop",
      impact: "repository-boundary",
      affectedRepositoryIds: ["Publisher.Portal", "Publisher.MicroService.PostbackHandler"],
      rationale: "The answer chooses the implementation owner.",
    }])).toBe(true);
  });

  it("blocks early approval when a planner omits a decision impact classification", () => {
    const output = '```json\n{"scopeDisposition":"changes-required","applicability":{"role":"configuration-owner","storyBinding":"campaign conversion setup","routeOrDependency":"the editor persists the selected type","evidence":["src/Pixels.js:12"]},"plannedPaths":["src/Pixels.js"],"evidence":["src/Pixels.js:12"],"implementationSteps":["Add the selected conversion type"],"decisionRegister":[{"question":"Which conversion type should be selected?","recommendation":"Use the documented type.","alternatives":[],"requiredBefore":"develop","rationale":"The selected type changes the implementation."}]}\n```';
    const parsed = parseCoordinatedPlan(completeTestExecutionDossier(output), ["Portal"]);

    expect(parsed.decisionRegister[0]?.impact).toBe("unknown");
    expect(hasBlockingRepositoryBoundaryDecision(parsed.decisionRegister)).toBe(true);
  });

  it("accepts a bounded story-specific npm check only when package.json is approved", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"Api","scopeDisposition":"changes-required","evidence":[],"rationale":"Owns API"}],"repositories":[{"id":"Api","plannedPaths":["package.json","integration/api.test.js"],"dependsOn":[],"implementationSteps":["Add an unattended API test script"],"executionDossier":[{"path":"package.json","change":"Register the story-specific test command.","anchors":["package.json:8"]},{"path":"integration/api.test.js","change":"Cover the approved API behavior.","anchors":[],"newFile":true,"testScenarios":["success response"]}],"verificationCommands":[{"command":"npm run test:api","timeoutSeconds":90}]}],"implementationOrder":["Api"],"suggestedRepositories":[],"questionsOrClarifications":[]}\n```';

    expect(parseCoordinatedPlan(completeTestExecutionDossier(output), ["Api"]).repositories[0]?.verificationCommands).toEqual([
      { command: "npm run test:api", timeoutSeconds: 90 },
    ]);
  });

  it("does not allow a model to add an unselected repository or violate dependency order", () => {
    const added = '```json\n{"repositoryEvaluations":[{"id":"Other","scopeDisposition":"changes-required","evidence":[],"rationale":"Other"}],"repositories":[],"implementationOrder":[]}\n```';
    expect(parseCoordinatedPlan(added, ["Api"]).parseError).toMatch(/unselected/);

    const reversed = '```json\n{"repositoryEvaluations":[{"id":"Api","scopeDisposition":"changes-required","evidence":[],"rationale":"API"},{"id":"Ui","scopeDisposition":"changes-required","evidence":[],"rationale":"UI"}],"repositories":[{"id":"Api","plannedPaths":["a.ts"],"dependsOn":[],"implementationSteps":["a"]},{"id":"Ui","plannedPaths":["b.ts"],"dependsOn":["Api"],"implementationSteps":["b"]}],"implementationOrder":["Ui","Api"]}\n```';
    expect(parseCoordinatedPlan(completeTestExecutionDossier(reversed), ["Api", "Ui"]).parseError).toMatch(/before one of its dependencies/);
  });

  it("preserves valid lanes and localizes the error when a selected no-change repository is omitted", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"Api","scopeDisposition":"changes-required","evidence":[],"rationale":"API"},{"id":"Ui","scopeDisposition":"changes-required","evidence":[],"rationale":"UI"}],"repositories":[{"id":"Api","plannedPaths":["src/api.ts"],"dependsOn":[],"implementationSteps":["Add contract"]},{"id":"Ui","plannedPaths":["src/ui.ts"],"dependsOn":["Api"],"implementationSteps":["Use contract"]}],"implementationOrder":["Api","Ui"],"suggestedRepositories":[{"id":"Worker","reason":"Planner incorrectly treated selected no-change repo as unselected"}],"questionsOrClarifications":[]}\n```';
    const parsed = parseCoordinatedPlan(output, ["Worker", "Api", "Ui"]);

    expect(parsed.parseError).toMatch(/omitted selected repositories: Worker/);
    expect(parsed.repositories.find((entry) => entry.id === "Api")?.plannedPaths).toEqual(["src/api.ts"]);
    expect(parsed.repositories.find((entry) => entry.id === "Ui")?.plannedPaths).toEqual(["src/ui.ts"]);
    expect(parsed.repositories.find((entry) => entry.id === "Worker")?.plannedPaths).toEqual([]);
    expect(parsed.repositoryParseErrors).toEqual({
      Worker: "Worker was omitted from the coordinated plan contract",
      Api: null,
      Ui: null,
    });
    expect(parsed.suggestedRepositories).toEqual([]);
  });

  it("represents PUB-159636 PixelHandler as verified no-change without inventing implementation work", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"Publisher.MicroService.PixelHandler","scopeDisposition":"verified-no-change","applicability":{"role":"capability-only","storyBinding":"campaign-specific pixels","routeOrDependency":"selects admin-global pixels","evidence":["src/Handler.js:735-759"]},"evidence":["src/Handler.js:735-759"],"rationale":"Global admin pixels are not the campaign path"},{"id":"Publisher.MicroService.PostbackHandler","scopeDisposition":"changes-required","evidence":[],"rationale":"Executes campaign pixels"},{"id":"Publisher.Portal","scopeDisposition":"changes-required","evidence":[],"rationale":"Configures campaign pixels"}],"repositories":[{"id":"Publisher.MicroService.PostbackHandler","plannedPaths":["src/PixelTypes.js"],"dependsOn":[],"implementationSteps":["Register ChatGPTConversion"]},{"id":"Publisher.Portal","plannedPaths":["src/components/Campaigns/Detail/Pixels.js"],"dependsOn":["Publisher.MicroService.PostbackHandler"],"implementationSteps":["Add campaign-scoped option"]}],"implementationOrder":["Publisher.MicroService.PostbackHandler","Publisher.Portal"],"suggestedRepositories":[],"questionsOrClarifications":[]}\n```';
    const parsed = parseCoordinatedPlan(completeTestExecutionDossier(output), [
      "Publisher.MicroService.PixelHandler",
      "Publisher.MicroService.PostbackHandler",
      "Publisher.Portal",
    ]);

    expect(parsed.parseError).toBeNull();
    expect(parsed.repositories.find((entry) => entry.id === "Publisher.MicroService.PixelHandler")).toMatchObject({
      id: "Publisher.MicroService.PixelHandler",
      scopeDisposition: "verified-no-change",
      plannedPaths: [],
      implementationSteps: [],
      evidence: ["src/Handler.js:735-759"],
    });
  });

  it("keeps an unknown no-change evaluation unverified instead of treating it as scope-out", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"Runtime","scopeDisposition":"verified-no-change","applicability":{"role":"unknown","storyBinding":"campaign C123","routeOrDependency":"production route not established","evidence":["src/Handler.js:42"]},"evidence":["src/Handler.js:42"],"rationale":"Current source does not resolve the owner."}],"repositories":[],"implementationOrder":[],"suggestedRepositories":[],"decisionRequests":["Choose the runtime owner."]}\n```';
    const parsed = parseCoordinatedPlan(output, ["Runtime"]);
    expect(parsed.parseError).toBeNull();
    expect(parsed.repositories[0]).toMatchObject({ scopeDisposition: "unverified", plannedPaths: [], implementationSteps: [] });
  });

  it("retains a recommendation while timing the decision at the stage where it matters", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"Api","scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"server conversion","routeOrDependency":"configured event route","evidence":["src/api.ts:12"]},"evidence":["src/api.ts:12"],"rationale":"Owns the selected route."}],"repositories":[{"id":"Api","plannedPaths":["src/api.ts"],"dependsOn":[],"implementationSteps":["Add the integration"]}],"implementationOrder":["Api"],"suggestedRepositories":[],"decisionRequests":["Confirm deployed event routing."],"decisionRegister":[{"question":"Confirm deployed event routing.","recommendation":"Use the configured event route in Api.","alternatives":["Switch to Worker only if deployment routing proves it owns the event."],"requiredBefore":"publish","impact":"operational","affectedRepositoryIds":["Api"],"rationale":"The source change is bounded; deployment ownership is validated before sharing the result."}]}\n```';
    const parsed = parseCoordinatedPlan(completeTestExecutionDossier(output), ["Api"]);

    expect(parsed.repositories[0]?.plannedPaths).toEqual(["src/api.ts"]);
    expect(parsed.decisionRegister).toEqual([expect.objectContaining({ requiredBefore: "publish", recommendation: "Use the configured event route in Api." })]);
  });

  it("rejects invented steps on a verified-no-change repository", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"PixelHandler","scopeDisposition":"verified-no-change","evidence":["src/Handler.js:735"],"rationale":"Not on runtime path"}],"repositories":[{"id":"PixelHandler","plannedPaths":["src/Handler.js"],"dependsOn":[],"implementationSteps":["Add a type anyway"]}],"implementationOrder":["PixelHandler"],"suggestedRepositories":[],"questionsOrClarifications":[]}\n```';
    expect(parseCoordinatedPlan(output, ["PixelHandler"]).parseError).toMatch(/no verified-no-change repository/);
  });

});

describe("parseReviewVerdict", () => {
  it("parses a well-formed verdict block", () => {
    const output = [
      "The plan looks reasonable but misses one risk.",
      "```json",
      '{"repoScopeAgreement": "agrees", "overallAssessment": "needs-revision"}',
      "```",
    ].join("\n");
    const verdict = parseReviewVerdict(output);
    expect(verdict).toEqual({ repoScopeAgreement: "agrees", overallAssessment: "needs-revision", objections: [], parseError: null });
  });

  it("parses repository-evidenced objections for automatic plan revision", () => {
    const verdict = parseReviewVerdict('```json\n{"overallAssessment":"needs-revision","objections":[{"severity":"major","claim":"Include the legacy report catalog.","evidence":["Reports/PixelHistory.js:10"]}]}\n```');
    expect(verdict.objections).toEqual([{
      severity: "major",
      claim: "Include the legacy report catalog.",
      evidence: ["Reports/PixelHistory.js:10"],
    }]);
  });

  it("degrades to nulls, never throwing, when no JSON block is present", () => {
    const verdict = parseReviewVerdict("Just prose critique, no fenced block.");
    expect(verdict.parseError).not.toBeNull();
    expect(verdict.repoScopeAgreement).toBeNull();
    expect(verdict.overallAssessment).toBeNull();
  });

  it("degrades to nulls when the JSON block is malformed", () => {
    const verdict = parseReviewVerdict("```json\n{not valid\n```");
    expect(verdict.parseError).toMatch(/did not parse/);
  });

  it("rejects a value outside the enum for each field", () => {
    const verdict = parseReviewVerdict('```json\n{"repoScopeAgreement": "maybe", "overallAssessment": "great"}\n```');
    expect(verdict.parseError).toMatch(/did not contain a recognized/);
  });

  it("accepts a partial verdict — only one field present", () => {
    const verdict = parseReviewVerdict('```json\n{"overallAssessment": "sound"}\n```');
    expect(verdict).toEqual({ repoScopeAgreement: null, overallAssessment: "sound", objections: [], parseError: null });
  });

  it("uses the last fenced JSON block when the review contains more than one", () => {
    const output = [
      "```json",
      '{"unrelated": true}',
      "```",
      '```json',
      '{"repoScopeAgreement": "disagrees", "overallAssessment": "off-track"}',
      "```",
    ].join("\n");
    const verdict = parseReviewVerdict(output);
    expect(verdict.repoScopeAgreement).toBe("disagrees");
  });
});

describe("parseBehavioralReview", () => {
  it("parses only evidence-backed-shaped critic judgments", () => {
    const output = '```json\n{"claims":[{"stepIndex":2,"disposition":"refuted","evidence":["Campaigns/Detail/Pixels.js:316"],"explanation":"The current code defaults to allow."}]}\n```';
    expect(parseBehavioralReview(output)).toEqual([{
      stepIndex: 2,
      disposition: "refuted",
      evidence: ["Campaigns/Detail/Pixels.js:316"],
      explanation: "The current code defaults to allow.",
    }]);
  });

  it("preserves the synthetic repository-inclusion step identifier", () => {
    const output = '```json\n{"claims":[{"stepIndex":-1,"disposition":"confirmed","evidence":["src/Handler.js:842-878"],"explanation":"The campaign selector is the extension point."}]}\n```';
    expect(parseBehavioralReview(output)[0]?.stepIndex).toBe(-1);
  });
});

describe("recordSkippedTaskApproval", () => {
  it("records one idempotent approval without fabricating an ADO Task", () => {
    const job = {
      id: "skip-task-approval",
      status: "completed",
      provider: "codex",
      repositoryId: "Publisher.Portal",
      worktreePath: "/tmp/worktree",
      branch: "main",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      output: "Plan",
      error: null,
      repoScope: null,
      plannedPaths: ["src/app.js"],
      plannedPathsParseError: null,
      approvedPlannedPaths: null,
      usage: null,
      priorReviewFeedback: null,
      reviewStatus: "idle",
      review: null,
      reviewError: null,
      packet: {},
      createdTasks: {},
      developmentApproval: null,
    } as unknown as PlanJob;

    const first = recordSkippedTaskApproval(job);
    const second = recordSkippedTaskApproval(job);

    expect(first).toEqual({ mode: "tasks-skipped", approvedAt: expect.any(String) });
    expect(second).toBe(first);
    expect(job.createdTasks).toEqual({});
    const records = readFileSync(join(runtimeRoot, "planning-runs", `${job.id}.jsonl`), "utf8").trim().split("\n");
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0])).toMatchObject({ event: "task-creation-skipped", approval: first });
  });
});

describe("recordApprovedPlannedPaths", () => {
  it("stores and audits the developer-reviewed scope while rejecting unsafe replacement paths", () => {
    const job = {
      id: "planned-path-approval",
      status: "completed",
      provider: "codex",
      repositoryId: "Publisher.Portal",
      worktreePath: "/tmp/worktree",
      branch: "main",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      output: "Plan",
      error: null,
      repoScope: null,
      plannedPaths: ["src/app.js"],
      plannedPathsParseError: null,
      approvedPlannedPaths: null,
      usage: null,
      priorReviewFeedback: null,
      reviewStatus: "idle",
      review: null,
      reviewError: null,
      packet: {},
      createdTasks: {},
      developmentApproval: null,
    } as PlanJob;

    expect(recordApprovedPlannedPaths(job, ["src/app.js", "src/components/Admin/Reports/"]))
      .toEqual(["src/app.js", "src/components/Admin/Reports/"]);
    expect(job.approvedPlannedPaths).toEqual(["src/app.js", "src/components/Admin/Reports/"]);
    expect(new PlanningAgent().get(job.id)?.approvedPlannedPaths).toEqual(job.approvedPlannedPaths);
    expect(() => recordApprovedPlannedPaths(job, ["../outside.ts"])).toThrow(/unsafe or unsupported/);
    expect(job.approvedPlannedPaths).toEqual(["src/app.js", "src/components/Admin/Reports/"]);
    const record = JSON.parse(readFileSync(join(runtimeRoot, "planning-runs", `${job.id}.jsonl`), "utf8").trim());
    expect(record).toMatchObject({ event: "planned-paths-approved", plannedPaths: job.approvedPlannedPaths });
  });
});

describe("recordApprovedPathsByRepository", () => {
  it("requires a safe boundary for every selected repository", () => {
    const job = {
      id: "multi-scope-approval",
      status: "completed",
      provider: "codex",
      repositoryId: "Api",
      repositoryIds: ["Api", "Ui"],
      startedAt: new Date().toISOString(),
      packet: {},
      approvedPlannedPaths: null,
      approvedPathsByRepository: null,
    } as PlanJob;

    expect(recordApprovedPathsByRepository(job, { Api: ["src/api.ts"], Ui: ["src/ui.ts"] }))
      .toEqual({ Api: ["src/api.ts"], Ui: ["src/ui.ts"] });
    expect(job.approvedPlannedPaths).toEqual(["src/api.ts"]);
    expect(() => recordApprovedPathsByRepository(job, { Api: ["src/api.ts"] })).toThrow(/every selected repository/i);
    expect(() => recordApprovedPathsByRepository(job, { Api: ["src/api.ts"], Ui: ["../ui.ts"] })).toThrow(/unsafe/i);
  });

  it("accepts an empty boundary only for an audit-verified scope-out", () => {
    const job = {
      id: "verified-scope-out",
      status: "completed",
      provider: "codex",
      repositoryId: "Api",
      repositoryIds: ["Api", "Ui"],
      startedAt: new Date().toISOString(),
      packet: {},
      approvedPlannedPaths: null,
      approvedPathsByRepository: null,
      scopeOutVerificationByRepository: {
        Api: { status: "not-applicable", evidence: [], unmatchedEvidence: [] },
        Ui: { status: "verified", evidence: ["src/ui.ts:4"], unmatchedEvidence: [] },
      },
    } as unknown as PlanJob;

    expect(recordApprovedPathsByRepository(job, { Api: ["src/api.ts"], Ui: [] }))
      .toEqual({ Api: ["src/api.ts"], Ui: [] });
    job.executionOrder = ["Ui", "Api"];
    expect(implementationRepositoryIds(job)).toEqual(["Api"]);
    job.scopeOutVerificationByRepository.Ui.status = "unverified";
    expect(() => recordApprovedPathsByRepository(job, { Api: ["src/api.ts"], Ui: [] })).toThrow(/audit-backed/);
  });

  it("still refuses an unverified empty boundary without a developer override", () => {
    const job = {
      id: "unverified-scope",
      status: "completed",
      provider: "codex",
      repositoryId: "Runtime",
      repositoryIds: ["Runtime"],
      startedAt: new Date().toISOString(),
      packet: {},
      approvedPlannedPaths: null,
      approvedPathsByRepository: null,
      scopeDispositionByRepository: { Runtime: "unverified" },
      scopeOutVerificationByRepository: { Runtime: { status: "not-applicable", evidence: [], unmatchedEvidence: [] } },
    } as unknown as PlanJob;

    expect(() => recordApprovedPathsByRepository(job, { Runtime: [] })).toThrow(/audit-backed/);
  });

  it("accepts an empty boundary via a developer override justification, and records it distinctly from a model-verified scope-out", () => {
    const job = {
      id: "developer-override",
      status: "completed",
      provider: "codex",
      repositoryId: "Api",
      repositoryIds: ["Api", "Ui"],
      startedAt: new Date().toISOString(),
      packet: {},
      approvedPlannedPaths: null,
      approvedPathsByRepository: null,
      scopeDispositionByRepository: { Api: "changes-required", Ui: "changes-required" },
      scopeOutVerificationByRepository: {
        Api: { status: "not-applicable", evidence: [], unmatchedEvidence: [] },
        Ui: { status: "unverified", evidence: [], unmatchedEvidence: [] },
      },
      developerScopeOverrideByRepository: {},
      behavioralClaimsByRepository: {
        Ui: [{ stepIndex: -1, step: "Repository inclusion: Ui", phrase: "contract-function evidence", citations: [], status: "unverified", explanation: "old explanation" }],
      },
    } as unknown as PlanJob;

    // Without a justification, an empty boundary for a changes-required, unverified repo is still rejected.
    expect(() => recordApprovedPathsByRepository(job, { Api: ["src/api.ts"], Ui: [] })).toThrow(/audit-backed evidence, or a developer override justification/);

    // With a justification, it's accepted, and the plan's own record is updated to stay consistent.
    expect(recordApprovedPathsByRepository(job, { Api: ["src/api.ts"], Ui: [] }, { Ui: "  Ui only fires an admin-global pixel list, verified at Handler.js:842-880; out of scope for this campaign-restricted story." }))
      .toEqual({ Api: ["src/api.ts"], Ui: [] });
    expect(job.developerScopeOverrideByRepository.Ui.justification).toMatch(/admin-global pixel list/);
    expect(job.scopeDispositionByRepository.Ui).toBe("verified-no-change");
    expect(job.scopeOutVerificationByRepository.Ui.status).toBe("verified");
    expect(job.behavioralClaimsByRepository.Ui[0].status).toBe("developer-override");

    job.executionOrder = ["Ui", "Api"];
    expect(implementationRepositoryIds(job)).toEqual(["Api"]);
  });

  it("still rejects an empty boundary with a blank or whitespace-only override justification", () => {
    const job = {
      id: "developer-override-blank",
      status: "completed",
      provider: "codex",
      repositoryId: "Api",
      repositoryIds: ["Api", "Ui"],
      startedAt: new Date().toISOString(),
      packet: {},
      approvedPlannedPaths: null,
      approvedPathsByRepository: null,
      scopeDispositionByRepository: { Api: "changes-required", Ui: "changes-required" },
      scopeOutVerificationByRepository: {
        Api: { status: "not-applicable", evidence: [], unmatchedEvidence: [] },
        Ui: { status: "unverified", evidence: [], unmatchedEvidence: [] },
      },
      developerScopeOverrideByRepository: {},
      behavioralClaimsByRepository: {},
    } as unknown as PlanJob;

    expect(() => recordApprovedPathsByRepository(job, { Api: ["src/api.ts"], Ui: [] }, { Ui: "   " }))
      .toThrow(/audit-backed evidence, or a developer override justification/);
  });
});

describe("unresolved cross-repository literal conflicts", () => {
  const changesRequired = (id: string, dependsOn: string[] = []): CoordinatedRepositoryPlan => ({
    id, scopeDisposition: "changes-required", applicability: {
      role: "runtime-owner", storyBinding: "The change.", routeOrDependency: "The route.", evidence: ["src/x.js:1"],
    }, plannedPaths: ["src/x.js"], evidence: ["src/x.js:1"], dependsOn, implementationSteps: ["Do it."],
    executionDossier: [{ path: "src/x.js", change: "Edit.", anchors: ["src/x.js:1"], requiredSourceFragments: ["X"], writeRole: "runtime-owner", newFile: false, testScenarios: [] }], verificationCommands: [],
  });
  const planWith = (unresolved: CoordinatedPlanContract["unresolvedCrossRepositoryContracts"], decisionRegister: PlanDecision[] = []): CoordinatedPlanContract => ({
    repositories: [changesRequired("Database"), changesRequired("Loader", ["Database"])],
    executionOrder: ["Database", "Loader"], suggestedRepositories: [], questionsOrClarifications: [],
    decisionRegister, operationalFollowUps: [], outOfScopeFollowUps: [], crossRepositoryContracts: [],
    unresolvedCrossRepositoryContracts: unresolved,
    repositoryParseErrors: { Database: null, Loader: null }, parseError: null,
  });
  const conflict = {
    concept: "ChatGPT cost table", literalKind: "table name",
    sourceRepositoryId: "Database", sourceLiteral: "TRAFFIC_CHATGPT_AD_COST",
    consumerRepositoryId: "Loader", consumerLiteral: "TRAFFIC_OPENAI_AD_COST",
    reason: "The loader merges into the target the Snowflake object creates.",
  };

  it("hard-blocks a plan whose two repos require different literals for the same concept", () => {
    expect(validateUnresolvedCrossRepositoryContracts(planWith([conflict])))
      .toMatch(/TRAFFIC_CHATGPT_AD_COST[\s\S]*TRAFFIC_OPENAI_AD_COST/);
  });

  it("stays blocking after decision normalization, proving correctness does not depend on decision classification", () => {
    const contract = planWith([conflict]);
    const normalized = normalizeNonBlockingCoordinatorDecisions(contract);
    expect(normalized.unresolvedCrossRepositoryContracts).toEqual([conflict]);
    expect(validateUnresolvedCrossRepositoryContracts(normalized)).not.toBeNull();
  });

  it("does not over-fire on a dependency edge that carries no unresolved conflict", () => {
    expect(validateUnresolvedCrossRepositoryContracts(planWith([]))).toBeNull();
  });

  it("surfaces an unresolved conflict as a blocking, answerable shared-contract decision (not a hard-fail)", () => {
    const surfaced = surfaceUnresolvedContractsAsDecisions(planWith([conflict]));
    expect(surfaced.unresolvedCrossRepositoryContracts).toEqual([]);
    expect(surfaced.decisionRegister).toHaveLength(1);
    const decision = surfaced.decisionRegister[0]!;
    expect(decision.impact).toBe("shared-contract");
    expect(decision.requiredBefore).toBe("develop");
    expect(decision.affectedRepositoryIds).toEqual(["Database", "Loader"]);
    expect(decision.sharedContractSlot).toEqual({ concept: "ChatGPT cost table", literalKind: "table name", affectedRepositoryIds: ["Database", "Loader"] });
    expect(decision.question).toContain("TRAFFIC_CHATGPT_AD_COST");
    expect(decision.question).toContain("TRAFFIC_OPENAI_AD_COST");
    // It blocks develop, is allowed by the pre-develop validators without a scout fact-ref, and no longer trips the unresolved-contract validator.
    expect(hasBlockingPreDevelopDecision(surfaced.decisionRegister)).toBe(true);
    expect(validatePreDevelopDecisions(surfaced.decisionRegister, {})).toBeNull();
    expect(validateUnresolvedCrossRepositoryContracts(surfaced)).toBeNull();
  });

  it("frames the shared-contract question so a candidate choice classifies as an instant deterministic patch", () => {
    const decision = surfaceUnresolvedContractsAsDecisions(planWith([conflict])).decisionRegister[0]!;
    expect(classifyDeveloperPlanAnswer({ question: decision.question, answer: "TRAFFIC_OPENAI_AD_COST" }).path).toBe("deterministic-patch");
  });

  it("parses leniently: a malformed unresolved entry degrades to omitted without throwing", () => {
    const output = '```json\n{"repositoryEvaluations":[{"id":"Api","scopeDisposition":"changes-required","applicability":{"role":"runtime-owner","storyBinding":"Owns the table","routeOrDependency":"writes the table","evidence":["src/api.ts:1"]},"evidence":["src/api.ts:1"],"rationale":"Owns","dependsOn":[]},{"id":"Ui","scopeDisposition":"changes-required","applicability":{"role":"contract-mirror","storyBinding":"reads the table","routeOrDependency":"reads what Api writes","evidence":["src/ui.ts:1"]},"evidence":["src/ui.ts:1"],"rationale":"Consumes","dependsOn":["Api"]}],"repositories":[{"id":"Api","plannedPaths":["src/api.ts"],"dependsOn":[],"implementationSteps":["Add"]},{"id":"Ui","plannedPaths":["src/ui.ts"],"dependsOn":["Api"],"implementationSteps":["Use"]}],"implementationOrder":["Api","Ui"],"unresolvedCrossRepositoryContracts":[{"concept":"shared table","literalKind":"table name","sourceRepositoryId":"Api","sourceLiteral":"TBL_A","consumerRepositoryId":"Ui","consumerLiteral":"TBL_B","reason":"Ui reads what Api writes."},{"concept":"broken"}]}\n```';
    const decision = parseCoordinatorDecision(output, ["Api", "Ui"], ["Api", "Ui"]);
    expect(decision.parseError).toBeNull();
    expect(decision.unresolvedCrossRepositoryContracts).toEqual([{
      concept: "shared table", literalKind: "table name",
      sourceRepositoryId: "Api", sourceLiteral: "TBL_A",
      consumerRepositoryId: "Ui", consumerLiteral: "TBL_B",
      reason: "Ui reads what Api writes.",
    }]);
  });
});

describe("shared contract injection", () => {
  it("renders nothing when no shared contract is seeded", () => {
    expect(sharedContractContext([], "Repo")).toBe("");
  });

  it("injects the canonical literal and a convention-binding instruction when seeded", () => {
    const rendered = sharedContractContext([
      { concept: "ChatGPT cost table", literalKind: "table name", canonicalLiteral: "TRAFFIC_OPENAI_AD_COST" },
    ], "Repo");
    expect(rendered).toContain("Shared cross-repository contract");
    expect(rendered).toContain("established convention");
    expect(rendered).toContain("ChatGPT cost table (table name): TRAFFIC_OPENAI_AD_COST");
  });

  it("injects a contract only into the repositories it affects", () => {
    const contracts = [{ concept: "cost table", literalKind: "table name", canonicalLiteral: "TRAFFIC_OPENAI_AD_COST", affectedRepositoryIds: ["Loader", "Warehouse"] }];
    expect(sharedContractContext(contracts, "Loader")).toContain("TRAFFIC_OPENAI_AD_COST");
    expect(sharedContractContext(contracts, "Unrelated")).toBe("");
  });
});

describe("shared contract from developer answer", () => {
  const decision: PlanDecision = {
    question: "Which canonical value should Database and Loader share for cost table (table name): TRAFFIC_CHATGPT_AD_COST or TRAFFIC_OPENAI_AD_COST?",
    recommendation: "Pick one.", alternatives: ["TRAFFIC_CHATGPT_AD_COST", "TRAFFIC_OPENAI_AD_COST"],
    requiredBefore: "develop", impact: "shared-contract", affectedRepositoryIds: ["Database", "Loader"], rationale: "The packets disagree.",
    sharedContractSlot: { concept: "cost table", literalKind: "table name", affectedRepositoryIds: ["Database", "Loader"] },
  };

  it("maps a candidate-choice answer to the chosen canonical literal", () => {
    expect(buildSharedContractFromAnswer(decision, "use TRAFFIC_OPENAI_AD_COST")).toEqual({
      concept: "cost table", literalKind: "table name", canonicalLiteral: "TRAFFIC_OPENAI_AD_COST", affectedRepositoryIds: ["Database", "Loader"],
    });
  });

  it("distributes a qualified table answer as its unqualified canonical core", () => {
    const qualifiedDecision: PlanDecision = { ...decision, alternatives: ["MEDIA.TRAFFIC_CHATGPT_AD_COST", "TRAFFIC_OPENAI_AD_COST"] };
    expect(buildSharedContractFromAnswer(qualifiedDecision, "MEDIA.TRAFFIC_CHATGPT_AD_COST").canonicalLiteral).toBe("TRAFFIC_CHATGPT_AD_COST");
  });

  it("binds the full set from a set-valued slot when the answer is to define it", () => {
    const setDecision: PlanDecision = {
      question: "Reconcile the destination table set between Loader and Data.",
      recommendation: "Define the full set in Data.",
      alternatives: ["Define the full table set { TRAFFIC_CHATGPT_AD_COST, TRAFFIC_CHATGPT_CAMPAIGN_COST } in Data", "Drop TRAFFIC_CHATGPT_CAMPAIGN_COST from Loader"],
      requiredBefore: "develop", impact: "shared-contract", affectedRepositoryIds: ["Data", "Loader"], rationale: "The loader writes tables the warehouse lacks.",
      sharedContractSlot: { concept: "destination table set", literalKind: "table name", affectedRepositoryIds: ["Data", "Loader"], members: ["TRAFFIC_CHATGPT_AD_COST", "TRAFFIC_CHATGPT_CAMPAIGN_COST"] },
    };
    const built = buildSharedContractFromAnswer(setDecision, "Define the full table set { TRAFFIC_CHATGPT_AD_COST, TRAFFIC_CHATGPT_CAMPAIGN_COST } in Data");
    expect(built.canonicalLiterals).toEqual(["TRAFFIC_CHATGPT_AD_COST", "TRAFFIC_CHATGPT_CAMPAIGN_COST"]);
    expect(built.affectedRepositoryIds).toEqual(["Data", "Loader"]);
  });

  it("resolveSharedContracts merges packet seeds with answered decisions, answer overriding the same slot", () => {
    const job = {
      packet: { sharedContracts: [{ concept: "cost table", literalKind: "table name", canonicalLiteral: "TRAFFIC_CHATGPT_AD_COST" }] },
      resolvedDeveloperDecisions: [{ key: "k", question: decision.question, answer: "TRAFFIC_OPENAI_AD_COST", resolvedAt: "t", sharedContract: buildSharedContractFromAnswer(decision, "TRAFFIC_OPENAI_AD_COST") }],
    } as unknown as PlanJob;
    expect(resolveSharedContracts(job)).toEqual([
      { concept: "cost table", literalKind: "table name", canonicalLiteral: "TRAFFIC_OPENAI_AD_COST", affectedRepositoryIds: ["Database", "Loader"] },
    ]);
  });
});

describe("external-contract literal becomes a shared contract (DEFINE)", () => {
  const externalDecision: PlanDecision = {
    question: "What QW_VENDOR literal is approved for OpenAI/ChatGPT cost rows?",
    recommendation: "Use CHATGPT, matching the stakeholder note and the platform-brand convention.",
    alternatives: ["Use a different literal only if the QW attribution-code owner identifies an existing canonical code."],
    requiredBefore: "develop", impact: "external-contract", affectedRepositoryIds: ["MoneyBadgerDownloader"], rationale: "The vendor code must be consistent.",
  };

  it("captures the literal named in a prose recommendation answer", () => {
    expect(externalContractFromAnswer(externalDecision, "Use CHATGPT, matching the stakeholder note.")).toEqual({
      concept: externalDecision.question.trim(), literalKind: "value", canonicalLiteral: "CHATGPT", affectedRepositoryIds: ["MoneyBadgerDownloader"],
    });
  });

  it("captures a bare literal answer the developer typed directly", () => {
    expect(externalContractFromAnswer(externalDecision, "CHATGPT")?.canonicalLiteral).toBe("CHATGPT");
  });

  it("does not define a symbol when the answer carries no clean literal", () => {
    expect(externalContractFromAnswer(externalDecision, "Use a different literal only if required.")).toBeUndefined();
  });

  it("does not define a symbol for a non-external-contract impact", () => {
    expect(externalContractFromAnswer({ ...externalDecision, impact: "implementation" }, "CHATGPT")).toBeUndefined();
  });

  it("does not define a symbol when no repositories are bound", () => {
    expect(externalContractFromAnswer({ ...externalDecision, affectedRepositoryIds: [] }, "CHATGPT")).toBeUndefined();
  });
});

describe("injectResolvedContractsIntoDossier (RESOLVE)", () => {
  const dossier: ExecutionDossierEntry[] = [
    { path: "src/models/openai/schema.js", change: "Add the OpenAI loader schema.", anchors: [], requiredSourceFragments: ["QW_VENDOR"], writeRole: "runtime-owner", newFile: true, testScenarios: [] },
    { path: "integrations/unit/config.test.js", change: "Cover the OpenAI config.", anchors: [], requiredSourceFragments: ["OpenAIWorker"], writeRole: "test", newFile: true, testScenarios: [] },
  ];
  const vendorContract = { concept: "QW_VENDOR", literalKind: "value", canonicalLiteral: "CHATGPT", affectedRepositoryIds: ["MoneyBadgerDownloader"] };

  it("injects the canonical literal into a non-test approved-path entry", () => {
    const result = injectResolvedContractsIntoDossier(dossier, [vendorContract], "MoneyBadgerDownloader", ["src/models/openai/schema.js", "integrations/unit/config.test.js"]);
    expect(result[0]!.requiredSourceFragments).toEqual(["QW_VENDOR", "CHATGPT"]);
    expect(result[1]!.requiredSourceFragments).toEqual(["OpenAIWorker"]);
  });

  it("does not inject into a repository the contract does not bind", () => {
    const result = injectResolvedContractsIntoDossier(dossier, [vendorContract], "Database.Snowflake.DATA_LAKE", ["src/models/openai/schema.js"]);
    expect(result[0]!.requiredSourceFragments).toEqual(["QW_VENDOR"]);
  });

  it("does not inject when no approved-path entry exists", () => {
    const result = injectResolvedContractsIntoDossier(dossier, [vendorContract], "MoneyBadgerDownloader", ["some/other/path.js"]);
    expect(result[0]!.requiredSourceFragments).toEqual(["QW_VENDOR"]);
  });

  it("does not duplicate a literal the dossier already carries", () => {
    const already: ExecutionDossierEntry[] = [{ ...dossier[0]!, requiredSourceFragments: ["QW_VENDOR: () => 'CHATGPT'"] }];
    const result = injectResolvedContractsIntoDossier(already, [vendorContract], "MoneyBadgerDownloader", ["src/models/openai/schema.js"]);
    expect(result[0]!.requiredSourceFragments).toEqual(["QW_VENDOR: () => 'CHATGPT'"]);
  });

  it("skips a non-token literal rather than injecting prose", () => {
    const prose = { ...vendorContract, canonicalLiteral: "use the vendor code" };
    const result = injectResolvedContractsIntoDossier(dossier, [prose], "MoneyBadgerDownloader", ["src/models/openai/schema.js"]);
    expect(result[0]!.requiredSourceFragments).toEqual(["QW_VENDOR"]);
  });

  it("injects every member of a set-valued contract", () => {
    const setContract = { concept: "destination table set", literalKind: "table name", canonicalLiteral: "TRAFFIC_CHATGPT_AD_COST", canonicalLiterals: ["TRAFFIC_CHATGPT_AD_COST", "TRAFFIC_CHATGPT_CAMPAIGN_COST"], affectedRepositoryIds: ["MoneyBadgerDownloader"] };
    const result = injectResolvedContractsIntoDossier(dossier, [setContract], "MoneyBadgerDownloader", ["src/models/openai/schema.js"]);
    expect(result[0]!.requiredSourceFragments).toEqual(["QW_VENDOR", "TRAFFIC_CHATGPT_AD_COST", "TRAFFIC_CHATGPT_CAMPAIGN_COST"]);
  });
});describe("canonicalizeContractLiteral", () => {
  it("extracts a table identifier from a CREATE TABLE statement and strips the schema", () => {
    expect(canonicalizeContractLiteral("CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST", "table name")).toBe("TRAFFIC_CHATGPT_AD_COST");
    expect(canonicalizeContractLiteral("CREATE TABLE IF NOT EXISTS MEDIA.TRAFFIC_CHATGPT_AD_COST", "table name")).toBe("TRAFFIC_CHATGPT_AD_COST");
  });

  it("unwraps a registry assignment and strips the schema for table names", () => {
    expect(canonicalizeContractLiteral("tableName: 'TRAFFIC_CHATGPT_AD_COST'", "table name")).toBe("TRAFFIC_CHATGPT_AD_COST");
    expect(canonicalizeContractLiteral("MEDIA.TRAFFIC_CHATGPT_AD_COST", "table name")).toBe("TRAFFIC_CHATGPT_AD_COST");
  });

  it("leaves a non-table literal kind unqualified-normalized", () => {
    expect(canonicalizeContractLiteral("ChatGPTConversion", "event type")).toBe("ChatGPTConversion");
    expect(canonicalizeContractLiteral("pixelType: 'ChatGPTConversion'", "event type")).toBe("ChatGPTConversion");
  });
});

describe("seedDerivedRequirementDecisions", () => {
  const plan = (overrides: Partial<CoordinatedPlanContract> = {}): CoordinatedPlanContract => ({
    repositories: [],
    executionOrder: [],
    suggestedRepositories: [],
    questionsOrClarifications: [],
    decisionRegister: [],
    operationalFollowUps: [],
    outOfScopeFollowUps: [],
    crossRepositoryContracts: [],
    repositoryParseErrors: {},
    parseError: null,
    ...overrides,
  });
  const members = ["TRAFFIC_CHATGPT_CAMPAIGN_COST", "TRAFFIC_CHATGPT_ADGROUP_COST", "TRAFFIC_CHATGPT_AD_COST"];
  const tableSet = {
    kind: "table-set" as const,
    concept: "destination grain tables",
    literalKind: "table name",
    recommendation: "Define all three grain tables",
    alternatives: ["Only the ad-level table"],
    members,
    citations: ["[2] three separate tables like Google"],
  };

  it("is a no-op when there are no derived requirements", () => {
    const base = plan();
    expect(seedDerivedRequirementDecisions(base, [])).toBe(base);
  });

  it("surfaces a table-set requirement as a blocking shared-contract decision carrying the full member set", () => {
    const seeded = seedDerivedRequirementDecisions(plan(), [tableSet]);
    expect(seeded.decisionRegister).toHaveLength(1);
    const decision = seeded.decisionRegister[0]!;
    expect(decision.impact).toBe("shared-contract");
    expect(decision.requiredBefore).toBe("develop");
    expect(hasBlockingPreDevelopDecision(seeded.decisionRegister)).toBe(true);
    // The slot carries the full set (sorted) so answering "confirm" seeds every member into the owner re-scout.
    expect(decision.sharedContractSlot?.members).toEqual([...members].sort());
    expect(decision.sharedContractSlot?.affectedRepositoryIds).toEqual([]);
    expect(decision.rationale).toContain("recommendation to confirm, not an applied fact");
  });

  it("the seeded decision resolves to a full-set shared contract when the developer confirms", () => {
    const seeded = seedDerivedRequirementDecisions(plan(), [tableSet]);
    const contract = buildSharedContractFromAnswer(seeded.decisionRegister[0]!, "Yes, define all of them");
    expect(contract.canonicalLiterals).toEqual([...members].sort());
  });

  it("surfaces a value requirement as a scalar shared-contract slot the answer binds", () => {
    const seeded = seedDerivedRequirementDecisions(plan(), [{
      kind: "value", concept: "vendor code", literalKind: "value", recommendation: "CHATGPT", alternatives: [], citations: ["[1] QW_VENDOR = CHATGPT"],
    }]);
    expect(seeded.decisionRegister).toHaveLength(1);
    expect(seeded.decisionRegister[0]?.sharedContractSlot).toMatchObject({ concept: "vendor code", literalKind: "value" });
    expect(seeded.decisionRegister[0]?.sharedContractSlot?.members).toBeUndefined();
    const contract = buildSharedContractFromAnswer(seeded.decisionRegister[0]!, "CHATGPT");
    expect(contract.canonicalLiteral).toBe("CHATGPT");
  });

  it("does not double-ask when a detector already raised a shared-contract decision for the same table family", () => {
    const existing = plan({
      decisionRegister: [{
        question: "Reconcile the destination table set between Loader and Warehouse: Loader writes to table(s) TRAFFIC_CHATGPT_AD_COST that Warehouse does not define.",
        recommendation: "Define the full table set",
        alternatives: [],
        requiredBefore: "develop",
        impact: "shared-contract",
        affectedRepositoryIds: ["Warehouse", "Loader"],
        rationale: "Deterministic table-set check.",
        sharedContractSlot: { concept: "destination table set for Loader -> Warehouse", literalKind: "table name", affectedRepositoryIds: ["Warehouse", "Loader"], members: ["TRAFFIC_CHATGPT_AD_COST"] },
      }],
    });
    const seeded = seedDerivedRequirementDecisions(existing, [tableSet]);
    expect(seeded.decisionRegister).toHaveLength(1);
  });

  it("drops an operational follow-up that re-narrows a derived scope, but keeps unrelated follow-ups", () => {
    const base = plan({
      operationalFollowUps: [
        "Confirm whether additional grain tables beyond TRAFFIC_CHATGPT_AD_COST are needed.",
        "Notify the reporting team once the pipeline is live.",
      ],
    });
    const seeded = seedDerivedRequirementDecisions(base, [tableSet]);
    expect(seeded.operationalFollowUps).toEqual(["Notify the reporting team once the pipeline is live."]);
  });

  it("does not touch follow-ups that never mention a derived token", () => {
    const base = plan({ operationalFollowUps: ["Confirm whether the dashboard needs a new tile."] });
    const seeded = seedDerivedRequirementDecisions(base, [tableSet]);
    expect(seeded.operationalFollowUps).toEqual(["Confirm whether the dashboard needs a new tile."]);
  });

  it("prunes a re-seeded derived decision the developer already answered, so a re-plan does not loop", () => {
    const decision = seedDerivedRequirementDecisions(plan(), [tableSet]).decisionRegister[0]!;
    const resolved = [{ key: planDecisionKey(decision), question: decision.question, answer: "Define all three", resolvedAt: "2026-01-01T00:00:00Z" }];
    // A re-plan re-runs the deterministic seeder, re-adding the same decision; the prune removes it.
    const reseeded = seedDerivedRequirementDecisions(plan(), [tableSet]);
    expect(dropResolvedDeveloperDecisions(reseeded, resolved).decisionRegister).toEqual([]);
  });

  it("retains a decision whose key was not resolved", () => {
    const seeded = seedDerivedRequirementDecisions(plan(), [tableSet]);
    const pruned = dropResolvedDeveloperDecisions(seeded, [{ key: "shared-contract::unrelated", question: "x", answer: "y", resolvedAt: "2026-01-01T00:00:00Z" }]);
    expect(pruned.decisionRegister).toHaveLength(1);
  });
});
