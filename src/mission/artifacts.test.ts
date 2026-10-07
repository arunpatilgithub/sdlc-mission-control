import { describe, expect, it } from "vitest";
import { validateCriticVerdict, validateDevelopArtifact, validatePlanArtifact } from "./artifacts.js";

const usage = () => ({
  provider: "codex",
  inputTokens: 12_500,
  cachedInputTokens: 4_000,
  cacheWriteTokens: 750,
  outputTokens: 1_200,
  reasoningTokens: 300,
  costUSD: null,
  turns: 4,
  durationMs: 18_500,
  promptBytes: 8_200,
  toolOutputBytes: 15_400,
  outputBytes: 3_100,
  commandCount: 7,
});

const base = (stage: string) => ({
  schemaVersion: 1,
  missionId: "mission-42",
  storyId: 42,
  stage,
  createdAt: "2026-08-20T18:00:00.000Z",
  producedBy: "test-model",
});

const plan = () => ({
  ...base("plan"),
  planMarkdown: "## Plan\nImplement and verify the mission.",
  repositories: ["Publisher.Api"],
  plannedPaths: ["src/workers/"],
  referenceFiles: ["src/workers/ExistingWorker.ts"],
  openQuestions: ["Confirm the vendor field name."],
  usage: usage(),
});

const develop = () => ({
  ...base("develop"),
  worktreePath: "/tmp/worktrees/publisher-api-42",
  branch: "mission/42-abcdef12",
  commit: "0123456789abcdef0123456789abcdef01234567",
  filesChanged: ["src/workers/NewWorker.ts", "src/workers/NewWorker.test.ts"],
  diffStat: "2 files changed, 80 insertions(+)",
  baseline: [{ command: "npm test", exitCode: 0, passed: true, output: "84 tests passed" }],
  verification: [{ command: "npm test", exitCode: 0, passed: true, output: "90 tests passed" }],
  regressions: [],
  gateReport: {
    passed: true,
    results: [
      { id: "scope", status: "passed", detail: "All files are in scope", offenders: [] },
      { id: "no-regressions", status: "not-verified", detail: "No verification commands are configured", offenders: [] },
      { id: "no-secrets", status: "passed", detail: "No secrets detected", offenders: [] },
      { id: "todo-markers", status: "passed", detail: "All TODO markers are scoped", offenders: [] },
    ],
  },
  usage: usage(),
});

const critic = () => ({
  ...base("diff"),
  disposition: "revise",
  objections: [
    {
      severity: "blocker",
      claim: "Verification no longer exercises the failure path.",
      evidence: ["src/workers/NewWorker.test.ts:52"],
    },
    {
      severity: "minor",
      claim: "The error message is inconsistent with the existing worker.",
      evidence: ["src/workers/NewWorker.ts:31", "src/workers/ExistingWorker.ts:28"],
    },
  ],
  usage: usage(),
});

describe("artifact contracts", () => {
  it("rejects a critic objection without evidence and names the missing field", () => {
    const verdict = {
      schemaVersion: 1,
      missionId: "mission-42",
      storyId: 42,
      stage: "plan",
      createdAt: "2026-08-20T18:00:00.000Z",
      producedBy: "test-model",
      disposition: "revise",
      objections: [{ severity: "major", claim: "The plan omits verification" }],
      usage: null,
    };

    expect(() => validateCriticVerdict(verdict)).toThrow(/evidence/);
  });

  it("accepts and returns a complete plan artifact", () => {
    const artifact = plan();

    expect(validatePlanArtifact(artifact)).toEqual(artifact);
  });

  it("accepts and returns a complete develop artifact", () => {
    const artifact = develop();

    expect(validateDevelopArtifact(artifact)).toEqual(artifact);
  });

  it("accepts and returns a complete critic verdict", () => {
    const artifact = critic();

    expect(validateCriticVerdict(artifact)).toEqual(artifact);
  });

  it("accepts a plan artifact with null usage", () => {
    const artifact = { ...plan(), usage: null };

    expect(validatePlanArtifact(artifact)).toEqual(artifact);
  });

  it("accepts a develop artifact with null usage", () => {
    const artifact = { ...develop(), usage: null };

    expect(validateDevelopArtifact(artifact)).toEqual(artifact);
  });

  it("accepts a critic verdict with null usage", () => {
    const artifact = { ...critic(), usage: null };

    expect(validateCriticVerdict(artifact)).toEqual(artifact);
  });
});
