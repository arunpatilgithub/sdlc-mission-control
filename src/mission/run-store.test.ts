import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionPacket } from "../agent/mission-packet.js";
import type { RunUsage } from "../agent/usage.js";
import type { RepositoryConfig } from "../config/team-config.js";
import type { MissionRunInput } from "./runner.js";

const runWritingAgent = vi.fn();
const runReadOnlyAgent = vi.fn();
vi.mock("../agent/llm-provider.js", () => ({
  runWritingAgent: (...args: unknown[]) => runWritingAgent(...args),
  runReadOnlyAgent: async (options: { skipGitRepoCheck?: boolean; workingDir?: string }, ...args: unknown[]) => {
    if (!options.skipGitRepoCheck) return runReadOnlyAgent(options, ...args);
    const before = new Set(options.workingDir ? readdirSync(options.workingDir) : []);
    const result = await runWritingAgent(options, ...args) as { output: string; usage: RunUsage };
    if (!options.workingDir || result.output.includes("```diff")) return result;
    const generated = readdirSync(options.workingDir).filter((name) => !before.has(name));
    if (generated.length === 0) return result;
    const files = Object.fromEntries(generated.map((name) => {
      const path = resolve(options.workingDir!, name);
      const body = readFileSync(path, "utf8");
      unlinkSync(path);
      return [name, body];
    }));
    return patchResult(files);
  },
}));

const {
  DEFAULT_LEDGER_LIMITS,
  DEFAULT_ORCHESTRATOR_CONFIG,
  hasAcceptedPublishReview,
  isMissionPublishReady,
  MissionRunStore,
} = await import("./run-store.js");

let root: string;
let repoPath: string;
let repository: RepositoryConfig;
let packet: MissionPacket;
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const usage = (provider: "claude" | "codex"): RunUsage => ({
  provider,
  inputTokens: 1_000,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 200,
  reasoningTokens: provider === "codex" ? 100 : null,
  costUSD: provider === "claude" ? 0.01 : null,
  turns: 1,
  durationMs: 1_000,
  promptBytes: 500,
  toolOutputBytes: 200,
  outputBytes: 50,
  commandCount: 1,
});

function patchResult(files: Record<string, string>): { output: string; usage: RunUsage } {
  const patch = Object.entries(files).map(([file, body]) => {
    const lines = body.split("\n").filter(Boolean);
    return `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
  }).join("\n");
  return { output: `\`\`\`diff\n${patch}\n\`\`\`\n\n## Deferred work\nNone.`, usage: usage("codex") };
}

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "mission-run-store-"));
  process.env.MISSION_CONTROL_RUNTIME_ROOT = resolve(root, "runtime");
  repoPath = resolve(root, "repo");
  mkdirSync(repoPath);
  g(repoPath, "init", "-b", "main");
  g(repoPath, "config", "user.email", "t@t.t");
  g(repoPath, "config", "user.name", "t");
  writeFileSync(resolve(repoPath, "base.js"), "export const base = true;\n");
  g(repoPath, "add", "-A");
  g(repoPath, "commit", "-m", "base");
  g(repoPath, "remote", "add", "origin", "https://example.com/test.git");
  repository = {
    id: "TestRepo",
    scm: "gitlab",
    localPath: repoPath,
    remoteUrl: "https://example.com/test.git",
    integrationBranch: "main",
  };
  packet = {
    schemaVersion: 1,
    missionId: "plan-job-42",
    generatedAt: "2026-08-20T18:00:00.000Z",
    mode: "fast",
    historyPolicy: "none",
    repositoryStrategy: "existing",
    phase: "implementation-plan",
    proposedRepositoryName: null,
    story: {
      id: 42,
      title: "Add a feature",
      state: "Active",
      description: "Implement the feature.",
      acceptanceCriteria: "The feature works.",
    },
    repository: {
      id: "TestRepo",
      worktreePath: repoPath,
      branch: "main",
      baselineCommit: g(repoPath, "rev-parse", "HEAD"),
      appType: "Node.js application",
      commands: ["exit 0"],
    },
    instructions: [],
    planningSkill: "Follow existing patterns.",
    planningSkillTools: [],
    likelyFiles: [{ path: "feature.js", sha256: "deadbeef" }],
    precedents: [],
    knownRepositoryIds: ["TestRepo"],
  };
  runWritingAgent.mockReset();
  runReadOnlyAgent.mockReset();
  let patchWasReturned = false;
  runWritingAgent.mockImplementation(async () => {
    if (patchWasReturned) return { output: "No further patch.\n\n## Deferred work\nNone.", usage: usage("codex") };
    patchWasReturned = true;
    return patchResult({ "feature.js": "export const feature = true;\n" });
  });
  runReadOnlyAgent.mockResolvedValue({
    output: "Accepted.\n```json\n{\"disposition\":\"accept\",\"objections\":[]}\n```",
    usage: usage("claude"),
  });
});

afterEach(() => {
  delete process.env.MISSION_CONTROL_RUNTIME_ROOT;
  rmSync(root, { recursive: true, force: true });
});

function input(overrides: Partial<MissionRunInput> = {}): MissionRunInput {
  return {
    missionId: "plan-job-42",
    packet,
    plan: "## Approved plan\nImplement feature.js.",
    repository,
    plannedPaths: ["feature.js"],
    referenceFiles: ["base.js"],
    verifyCommands: ["exit 0"],
    limits: DEFAULT_LEDGER_LIMITS,
    config: DEFAULT_ORCHESTRATOR_CONFIG,
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for mission run");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

describe("MissionRunStore", () => {
  it("returns undefined for an unknown job id", () => {
    expect(new MissionRunStore().get("unknown")).toBeUndefined();
  });

  it("checks every planned baseline before launching any repository", () => {
    const secondPath = resolve(root, "repo-stale");
    mkdirSync(secondPath);
    g(secondPath, "init", "-b", "main");
    g(secondPath, "config", "user.email", "t@t.t");
    g(secondPath, "config", "user.name", "t");
    writeFileSync(resolve(secondPath, "base.js"), "export const base = true;\n");
    g(secondPath, "add", "-A");
    g(secondPath, "commit", "-m", "base");
    g(secondPath, "remote", "add", "origin", "https://example.com/stale.git");
    const secondRepository: RepositoryConfig = { ...repository, id: "StaleRepo", localPath: secondPath, remoteUrl: "https://example.com/stale.git" };
    const secondPacket: MissionPacket = {
      ...packet,
      repository: { ...packet.repository, id: "StaleRepo", worktreePath: secondPath, baselineCommit: "0".repeat(40) },
    };
    const store = new MissionRunStore();

    expect(() => store.startMulti([
      { repositoryId: "TestRepo", input: input({ plannedBaselineCommit: packet.repository.baselineCommit }) },
      { repositoryId: "StaleRepo", input: input({ repository: secondRepository, packet: secondPacket, plannedBaselineCommit: secondPacket.repository.baselineCommit }) },
    ], "plan-job-42")).toThrow(/Plan contract needs regeneration.*StaleRepo/);
    expect(runWritingAgent).not.toHaveBeenCalled();
  });

  it("records publication only on the requested develop run", async () => {
    const store = new MissionRunStore();
    const job = store.start(input(), { planJobId: "plan-job-42", repositoryId: "TestRepo" });
    await waitUntil(() => job.status !== "running");
    const publication = {
      missionId: "plan-job-42", developRunId: job.id, storyId: 42, repositoryId: "TestRepo",
      scm: "azure-devops" as const, dryRun: false, sourceBranch: "feature/arpatil/PUB-42", targetBranch: "main",
      commit: "a".repeat(40), push: "pushed" as const, pullRequest: { id: 1, title: "PR", url: "https://example/pr/1" },
      merge: null, published: true, error: null, completedAt: new Date().toISOString(),
    };

    expect(store.recordPublication(job.id, publication)?.publication).toBe(publication);
    expect(store.recordPublication("unknown", publication)).toBeUndefined();
    expect(store.latestForPlan("plan-job-42")).toBe(job);
  });

  it("rejects an unauthorized patch before a scope-review record can be created", async () => {
    runWritingAgent.mockImplementation(async (options: { workingDir: string }) => {
      writeFileSync(resolve(options.workingDir, "feature.js"), "export const feature = true;\n");
      writeFileSync(resolve(options.workingDir, "helper.js"), "export const helper = true;\n");
      writeFileSync(resolve(options.workingDir, "README.md"), "# unrelated\n");
      return { output: "implemented", usage: usage("codex") };
    });
    const store = new MissionRunStore();
    const job = store.start(input(), { planJobId: "plan-job-42", repositoryId: "TestRepo" });
    await waitUntil(() => job.status !== "running");
    expect(job.result?.outcome).toBe("escalated");
    expect(job.result?.reason).toContain("outside the approved write boundary");
    expect(job.scopeReview).toBeNull();
    expect(runWritingAgent).toHaveBeenCalledTimes(1);
  });

  it("returns a running job immediately and makes it retrievable", async () => {
    let release!: () => void;
    runWritingAgent.mockImplementation(async (options: { workingDir: string }) => {
      writeFileSync(resolve(options.workingDir, "feature.js"), "export const feature = true;\n");
      await new Promise<void>((resolvePromise) => { release = resolvePromise; });
      return { output: "implemented feature", usage: usage("codex") };
    });
    const store = new MissionRunStore();

    const job = store.start(input(), { planJobId: "plan-job-42", repositoryId: "TestRepo" });

    expect(job.status).toBe("running");
    expect(store.get(job.id)).toBe(job);
    await waitUntil(() => typeof release === "function");
    release();
    await waitUntil(() => job.status !== "running");
  });

  it("completes a clean mission with its result", async () => {
    const store = new MissionRunStore();

    const job = store.start(input(), { planJobId: "plan-job-42", repositoryId: "TestRepo" });
    await waitUntil(() => job.status !== "running");

    expect(job.status).toBe("completed");
    expect(job.result).not.toBeNull();
    expect(job.result?.outcome).toBe("done");
    // A single-repository mission runs the diff critic after gates, producing the accepted verdict
    // Publish requires (no aggregate review exists for it).
    expect(job.result?.verdict?.disposition).toBe("accept");
    expect(job.stagesRun).toContain("develop-critic");
    expect(hasAcceptedPublishReview(job, "TestRepo")).toBe(true);
    expect(isMissionPublishReady(job)).toBe(true);
  });

  it("retains completed harness operations for the repository after Develop finishes", async () => {
    runWritingAgent.mockImplementation(async (options: { workingDir: string; onFileActivity?: (event: { status: "started" | "completed"; paths: string[] }) => void }) => {
      const path = resolve(options.workingDir, "feature.js");
      options.onFileActivity?.({ status: "started", paths: [path] });
      writeFileSync(path, "export const feature = true;\n");
      options.onFileActivity?.({ status: "completed", paths: [path] });
      return { output: "implemented feature", usage: usage("codex") };
    });
    const store = new MissionRunStore();
    const job = store.start(input(), { planJobId: "plan-job-42", repositoryId: "TestRepo" });

    await waitUntil(() => job.status !== "running");

    const activity = job.runsByRepository.TestRepo.activityLog;
    expect(activity.map((entry) => entry.phase)).toEqual([
      "preparing-worktree",
      "baseline-verification",
      "implementation",
      "post-change-verification",
      "committing",
      "deterministic-gates",
      "diff-critic",
    ]);
    expect(activity.every((entry) => entry.status === "completed" && entry.completedAt !== null)).toBe(true);
    expect(activity.find((entry) => entry.phase === "baseline-verification")).toMatchObject({ command: "exit 0", detail: "Passed on untouched baseline" });
    expect(activity.find((entry) => entry.phase === "implementation")?.completedPaths).toEqual(["feature.js"]);
    expect(new MissionRunStore().get(job.id)?.runsByRepository.TestRepo.activityLog).toEqual(activity);
  });

  it("develops repositories sequentially and waits for aggregate acceptance", async () => {
    const secondPath = resolve(root, "repo-two");
    mkdirSync(secondPath);
    g(secondPath, "init", "-b", "main");
    g(secondPath, "config", "user.email", "t@t.t");
    g(secondPath, "config", "user.name", "t");
    writeFileSync(resolve(secondPath, "base.js"), "export const base = true;\n");
    g(secondPath, "add", "-A");
    g(secondPath, "commit", "-m", "base");
    g(secondPath, "remote", "add", "origin", "https://example.com/two.git");
    const secondRepository: RepositoryConfig = { ...repository, id: "RepoTwo", localPath: secondPath, remoteUrl: "https://example.com/two.git" };
    const secondPacket: MissionPacket = {
      ...packet,
      repository: { ...packet.repository, id: "RepoTwo", worktreePath: secondPath, baselineCommit: g(secondPath, "rev-parse", "HEAD") },
    };
    const writeOrder: string[] = [];
    runWritingAgent.mockImplementation(async (options: { workingDir: string }) => {
      writeOrder.push(options.workingDir);
      writeFileSync(resolve(options.workingDir, "feature.js"), "export const feature = true;\n");
      return { output: "implemented", usage: usage("codex") };
    });
    runReadOnlyAgent.mockImplementation(async (options: { prompt: string }) => ({
      output: options.prompt.includes("final read-only cross-repository critic")
        ? '```json\n{"disposition":"accept","affectedRepositories":[],"objections":[]}\n```'
        : '```json\n{"disposition":"accept","objections":[]}\n```',
      usage: usage("claude"),
    }));
    const store = new MissionRunStore();
    const job = store.startMulti([
      { repositoryId: "TestRepo", input: input() },
      { repositoryId: "RepoTwo", input: input({ packet: secondPacket, repository: secondRepository }) },
    ], "plan-job-42", {
      missionId: "plan-job-42",
      packet,
      plan: "Change both repositories.",
      provider: "claude",
      workingDir: repoPath,
      executionOrder: ["TestRepo", "RepoTwo"],
      dependenciesByRepository: { TestRepo: [], RepoTwo: ["TestRepo"] },
    });

    await waitUntil(() => job.status !== "running");
    expect(job.runsByRepository.TestRepo.result?.outcome).toBe("done");
    expect(job.runsByRepository.RepoTwo.result?.outcome).toBe("done");
    expect(job.aggregateReview?.disposition).toBe("accept");
    expect(writeOrder).toHaveLength(2);
    // Multi-repo regression: the diff critic is NOT wired for multi-repo missions; acceptance comes
    // from the aggregate review, and no per-repository develop-critic stage runs.
    expect(job.stagesRun).not.toContain("develop-critic");
    expect(job.runsByRepository.TestRepo.result?.verdict).toBeNull();
    expect(job.runsByRepository.RepoTwo.result?.verdict).toBeNull();
    const recovered = new MissionRunStore().get(job.id);
    expect(recovered?.executionOrder).toEqual(["TestRepo", "RepoTwo"]);
    expect(recovered?.aggregateReview?.disposition).toBe("accept");
  });

  it("reopens affected repositories and transitive downstream dependents", async () => {
    const secondPath = resolve(root, "repo-dependent");
    mkdirSync(secondPath);
    g(secondPath, "init", "-b", "main");
    g(secondPath, "config", "user.email", "t@t.t");
    g(secondPath, "config", "user.name", "t");
    writeFileSync(resolve(secondPath, "base.js"), "export const base = true;\n");
    g(secondPath, "add", "-A");
    g(secondPath, "commit", "-m", "base");
    g(secondPath, "remote", "add", "origin", "https://example.com/dependent.git");
    const dependentRepository: RepositoryConfig = { ...repository, id: "Dependent", localPath: secondPath, remoteUrl: "https://example.com/dependent.git" };
    const dependentPacket: MissionPacket = {
      ...packet,
      repository: { ...packet.repository, id: "Dependent", worktreePath: secondPath, baselineCommit: g(secondPath, "rev-parse", "HEAD") },
    };
    let aggregateCalls = 0;
    runReadOnlyAgent.mockImplementation(async (options: { prompt: string }) => {
      if (!options.prompt.includes("final read-only cross-repository critic")) {
        return { output: '```json\n{"disposition":"accept","objections":[]}\n```', usage: usage("claude") };
      }
      aggregateCalls += 1;
      return {
        output: aggregateCalls === 1
          ? '```json\n{"disposition":"revise","affectedRepositories":["TestRepo"],"objections":[{"claim":"Contract mismatch","evidence":["TestRepo:feature.js"],"repositories":["TestRepo"]}]}\n```'
          : '```json\n{"disposition":"accept","affectedRepositories":[],"objections":[]}\n```',
        usage: usage("claude"),
      };
    });
    const store = new MissionRunStore();
    const job = store.startMulti([
      { repositoryId: "TestRepo", input: input() },
      { repositoryId: "Dependent", input: input({ packet: dependentPacket, repository: dependentRepository }) },
    ], "plan-job-42", {
      missionId: "plan-job-42",
      packet,
      plan: "Change both repositories.",
      provider: "claude",
      workingDir: repoPath,
      executionOrder: ["TestRepo", "Dependent"],
      dependenciesByRepository: { TestRepo: [], Dependent: ["TestRepo"] },
    });
    await waitUntil(() => job.status !== "running");
    expect(isMissionPublishReady(job)).toBe(false);
    expect(job.aggregateReview?.disposition).toBe("revise");

    store.retryAfterAggregateReview(job.id, ["TestRepo"]);
    await waitUntil(() => job.status !== "running");

    expect(runWritingAgent).toHaveBeenCalledTimes(4);
    expect(job.aggregateReview?.disposition).toBe("accept");
    expect(isMissionPublishReady(job)).toBe(true);
  });

  it("lets a developer override an escalated aggregate review with a justification, carrying the objections forward rather than discarding them", async () => {
    const secondPath = resolve(root, "repo-escalate");
    mkdirSync(secondPath);
    g(secondPath, "init", "-b", "main");
    g(secondPath, "config", "user.email", "t@t.t");
    g(secondPath, "config", "user.name", "t");
    writeFileSync(resolve(secondPath, "base.js"), "export const base = true;\n");
    g(secondPath, "add", "-A");
    g(secondPath, "commit", "-m", "base");
    g(secondPath, "remote", "add", "origin", "https://example.com/escalate.git");
    const secondRepository: RepositoryConfig = { ...repository, id: "RepoTwo", localPath: secondPath, remoteUrl: "https://example.com/escalate.git" };
    const secondPacket: MissionPacket = {
      ...packet,
      repository: { ...packet.repository, id: "RepoTwo", worktreePath: secondPath, baselineCommit: g(secondPath, "rev-parse", "HEAD") },
    };
    runReadOnlyAgent.mockImplementation(async (options: { prompt: string }) => ({
      output: options.prompt.includes("final read-only cross-repository critic")
        ? '```json\n{"disposition":"escalate","affectedRepositories":[],"objections":[{"claim":"Cross-repo naming mismatch","evidence":["TestRepo:feature.js:1"],"repositories":["TestRepo","RepoTwo"]}]}\n```'
        : '```json\n{"disposition":"accept","objections":[]}\n```',
      usage: usage("claude"),
    }));
    const store = new MissionRunStore();
    const job = store.startMulti([
      { repositoryId: "TestRepo", input: input() },
      { repositoryId: "RepoTwo", input: input({ packet: secondPacket, repository: secondRepository }) },
    ], "plan-job-43", {
      missionId: "plan-job-43",
      packet,
      plan: "Change both repositories.",
      provider: "claude",
      workingDir: repoPath,
      executionOrder: ["TestRepo", "RepoTwo"],
      dependenciesByRepository: { TestRepo: [], RepoTwo: ["TestRepo"] },
    });
    await waitUntil(() => job.status !== "running");
    expect(job.aggregateReview?.disposition).toBe("escalate");
    expect(isMissionPublishReady(job)).toBe(false);

    expect(() => store.recordAggregateReviewOverride(job.id, "   ")).toThrow(/non-empty justification/);
    expect(isMissionPublishReady(job)).toBe(false);

    const updated = store.recordAggregateReviewOverride(job.id, "Objection is about docs wording only; code is correct.");
    expect(updated.aggregateReviewOverride?.justification).toBe("Objection is about docs wording only; code is correct.");
    expect(isMissionPublishReady(job)).toBe(true);
    // The objections that triggered escalation are still present, not cleared by the override.
    expect(job.aggregateReview?.objections).toHaveLength(1);

    expect(() => store.recordAggregateReviewOverride(job.id, "second attempt")).not.toThrow();
  });

  it("grows stagesRun as stages begin and retains the final sequence", async () => {
    let releaseDevelop!: () => void;
    runWritingAgent.mockImplementation(async (options: { workingDir: string }) => {
      writeFileSync(resolve(options.workingDir, "feature.js"), "export const feature = true;\n");
      await new Promise<void>((resolvePromise) => { releaseDevelop = resolvePromise; });
      return { output: "implemented feature", usage: usage("codex") };
    });
    const store = new MissionRunStore();

    const job = store.start(input(), { planJobId: "plan-job-42", repositoryId: "TestRepo" });
    expect(job.stagesRun).toEqual(["develop"]);
    await waitUntil(() => typeof releaseDevelop === "function");
    releaseDevelop();
    await waitUntil(() => job.stagesRun.length === 3);
    await waitUntil(() => job.status !== "running");

    // Single-repository missions now run the diff critic after gates to produce the Publish verdict.
    expect(job.stagesRun).toEqual(["develop", "gates", "develop-critic"]);
  });

  it("records an escalated mission as completed", async () => {
    const store = new MissionRunStore();
    const exhausted = {
      perStageTokens: {},
      missionCeilingTokens: 0,
      maxRevisions: 2,
    };

    const job = store.start(input({ limits: exhausted }), {
      planJobId: "plan-job-42",
      repositoryId: "TestRepo",
    });
    await waitUntil(() => job.status !== "running");

    expect(job.status).toBe("completed");
    expect(job.result?.outcome).toBe("escalated");
    expect(job.result?.reason).toContain("Mission token ceiling");
    expect(job.error).toBeNull();
  });

  it("marks a missing integration branch as a failed harness run", async () => {
    const store = new MissionRunStore();
    const missingBranch = { ...repository, integrationBranch: "missing-branch" };

    const job = store.start(input({ repository: missingBranch }), {
      planJobId: "plan-job-42",
      repositoryId: "TestRepo",
    });
    await waitUntil(() => job.status !== "running");

    expect(job.status).toBe("failed");
    expect(job.error).toContain("Integration branch 'missing-branch' not found");
    expect(job.result).toBeNull();
  });
});

describe("isMissionPublishReady", () => {
  function readyRepoResult() {
    return { outcome: "done", gateReport: { passed: true }, verdict: { disposition: "accept" } };
  }

  it("is not publish-ready on an escalated aggregate review with no override", () => {
    const job = {
      repositoryIds: ["TestRepo"],
      runsByRepository: { TestRepo: { result: readyRepoResult() } },
      aggregateReviewStatus: "completed",
      aggregateReview: { disposition: "escalate" },
      aggregateReviewOverride: null,
      // eslint-disable-next-line
    } as any;
    expect(isMissionPublishReady(job)).toBe(false);
  });

  it("is publish-ready once a developer override is recorded on an escalated review", () => {
    const job = {
      repositoryIds: ["TestRepo"],
      runsByRepository: { TestRepo: { result: readyRepoResult() } },
      aggregateReviewStatus: "completed",
      aggregateReview: { disposition: "escalate" },
      aggregateReviewOverride: { justification: "reviewed and accepted", confirmedAt: "2026-01-01T00:00:00.000Z" },
      // eslint-disable-next-line
    } as any;
    expect(isMissionPublishReady(job)).toBe(true);
  });

  it("is not publish-ready when aggregateReviewOverride is simply absent from an older persisted job, not explicitly null", () => {
    // Regression guard: a strict `!== null` check would wrongly treat a genuinely missing
    // field (undefined, e.g. from a job persisted before this field existed) as "overridden",
    // since `undefined !== null` is true in JS. The check must treat missing and null the same.
    const job = {
      repositoryIds: ["TestRepo"],
      runsByRepository: { TestRepo: { result: readyRepoResult() } },
      aggregateReviewStatus: "completed",
      aggregateReview: { disposition: "escalate" },
      // aggregateReviewOverride intentionally omitted
      // eslint-disable-next-line
    } as any;
    expect(isMissionPublishReady(job)).toBe(false);
  });
});

describe("hasAcceptedPublishReview", () => {
  it("uses an accepted aggregate review for a multi-repository run when repository critics did not run", () => {
    const job = {
      repositoryIds: ["TestRepo", "RepoTwo"],
      runsByRepository: {
        TestRepo: { result: { outcome: "done", gateReport: { passed: true }, verdict: null } },
        RepoTwo: { result: { outcome: "done", gateReport: { passed: true }, verdict: null } },
      },
      aggregateReviewStatus: "completed",
      aggregateReview: { disposition: "accept" },
      aggregateReviewOverride: null,
      // eslint-disable-next-line
    } as any;

    expect(hasAcceptedPublishReview(job, "TestRepo")).toBe(true);
  });

  it("requires the repository critic verdict when aggregate review is skipped", () => {
    const job = {
      repositoryIds: ["TestRepo"],
      runsByRepository: { TestRepo: { result: { outcome: "done", gateReport: { passed: true }, verdict: null } } },
      aggregateReviewStatus: "skipped",
      aggregateReview: null,
      aggregateReviewOverride: null,
      // eslint-disable-next-line
    } as any;

    expect(hasAcceptedPublishReview(job, "TestRepo")).toBe(false);
  });
});
