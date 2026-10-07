import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryConfig } from "../config/team-config.js";
import type { MissionPacket } from "../agent/mission-packet.js";
import type { RunUsage } from "../agent/usage.js";
import { validateDevelopArtifact } from "./artifacts.js";
import { listArtifacts, readArtifact } from "./blackboard.js";

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

const { runMission } = await import("./runner.js");

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

const criticOutput = (
  disposition: "accept" | "revise" | "replan" | "escalate",
  objections: Array<{ severity: string; claim: string; evidence: string[] }> = [],
): string => `Critique complete.
\`\`\`json
${JSON.stringify({ disposition, objections })}
\`\`\``;

function patchResult(files: Record<string, string>): { output: string; usage: RunUsage } {
  const patch = Object.entries(files).map(([file, body]) => {
    const lines = body.split("\n").filter(Boolean);
    return `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
  }).join("\n");
  return { output: `\`\`\`diff\n${patch}\n\`\`\`\n\n## Deferred work\nNone.`, usage: usage("codex") };
}

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "mission-runner-"));
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
    missionId: "mission-42",
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
    output: criticOutput("accept"),
    usage: usage("claude"),
  });
});

afterEach(() => {
  delete process.env.MISSION_CONTROL_RUNTIME_ROOT;
  rmSync(root, { recursive: true, force: true });
});

function input(overrides: Record<string, unknown> = {}) {
  return {
    missionId: "mission-42",
    packet,
    plan: "## Approved plan\nImplement feature.js.",
    repository,
    plannedPaths: ["feature.js"],
    referenceFiles: ["base.js"],
    verifyCommands: ["exit 0"],
    branchName: "feature/arpatil/PUB-42",
    limits: {
      perStageTokens: { develop: 100_000, "develop-critic": 100_000 },
      missionCeilingTokens: 1_000_000,
      maxRevisions: 2,
    },
    config: {
      modelTiers: { develop: "develop-model", "develop-critic": "critic-model" },
      fallbackModel: "fallback-model",
    },
    ...overrides,
  } as Parameters<typeof runMission>[0];
}

function writeOutOfScope(): { output: string; usage: RunUsage } {
  return patchResult({ "README.md": "# Out of scope\n" });
}

describe("runMission", () => {
  it("runs one Develop pass followed by deterministic gates", async () => {
    const result = await runMission(input());

    expect(result.outcome).toBe("done");
    expect(result.reason).toBeNull();
    expect(result.stagesRun).toEqual(["develop", "gates"]);
    expect(result.ledger.unreportedStages).not.toContain("gates");
    expect(result.ledger.perStage.map(({ stage }) => stage)).not.toContain("gates");
  });

  it("threads discardStaleWorktree so a committed stale worktree is reclaimed on re-run", async () => {
    // Always author the same patch so each mission has real work to commit.
    runWritingAgent.mockImplementation(async () => patchResult({ "feature.js": "export const feature = true;\n" }));

    // First mission commits feature.js, leaving a committed worktree on the deterministic branch.
    expect((await runMission(input())).outcome).toBe("done");

    // Without the flag, the reconcile guard blocks the re-run (proves the guard still holds).
    const blocked = await runMission(input());
    expect(blocked.outcome).toBe("escalated");
    expect(blocked.reason).toMatch(/commits beyond/);

    // With the flag, runMission must pass it to runDevelopMission -> reconcile discards and completes.
    expect((await runMission(input({ discardStaleWorktree: true }))).outcome).toBe("done");
  });

  it("loads the develop skill for the repository and includes it in the develop prompt", async () => {
    await runMission(input());

    const prompt = (runWritingAgent.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("Generic development guidance");
  });

  it("threads developer-attached documentation through runMission into the patch-author prompt", async () => {
    // Guards the hand-built runDevelopMission input: a new field is silently dropped unless listed there.
    await runMission(input({
      documentation: [{ requestedUrl: "https://developers.openai.com/ads/api-reference/insights", hostname: "developers.openai.com", wrappedText: "--- BEGIN UNTRUSTED EXTERNAL DOCUMENTATION ---\nGET /ads/{ad_id}/insights\n--- END ---" }],
    }));

    const prompt = (runWritingAgent.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("## External API contract (reference)");
    expect(prompt).toContain("GET /ads/{ad_id}/insights");
  });

  it("reports each stage as it begins", async () => {
    const stages: string[] = [];

    const result = await runMission(input({ onStage: (stage: string) => stages.push(stage) }));

    expect(result.outcome).toBe("done");
    expect(stages).toEqual(["develop", "gates"]);
  });

  it("contains a throwing stage callback without losing stage records", async () => {
    const result = await runMission(input({
      onStage: () => { throw new Error("poller failed"); },
    }));

    expect(result.outcome).toBe("done");
    expect(result.stagesRun).toEqual(["develop", "gates"]);
  });

  it("escalates when the develop stage fails", async () => {
    runWritingAgent.mockRejectedValue(new Error("model process failed"));

    const result = await runMission(input());

    expect(result.outcome).toBe("escalated");
    expect(result.reason).toContain("model process failed");
  });

  it("rejects an unauthorized patch before it can expand scope", async () => {
    runWritingAgent.mockImplementation(async () => writeOutOfScope());

    const result = await runMission(input());

    expect(result.outcome).toBe("escalated");
    expect(result.reason).toContain("outside the approved write boundary");
    expect(runWritingAgent).toHaveBeenCalledTimes(1);
    expect(result.stagesRun).toEqual(["develop"]);
  });

  it("does not retain an approved-file patch when it is bundled with an unauthorized path", async () => {
    runWritingAgent.mockImplementation(async () => patchResult({
      "README.md": "# Out of scope\n",
      "feature.js": "export const feature = true;\n",
    }));
    const result = await runMission(input());

    expect(result.outcome).toBe("escalated");
    expect(result.develop?.filesChanged).toEqual([]);
    expect(runWritingAgent).toHaveBeenCalledTimes(1);
  });

  it("turns a plan-critic replan verdict into a versioned plan revision", async () => {
    const objection = {
      severity: "major",
      claim: "The plan targets the wrong component.",
      evidence: ["feature.js:1"],
    };
    runReadOnlyAgent
      .mockResolvedValueOnce({
        output: "## Revised plan\nImplement feature.js in the verified component.",
        usage: usage("codex"),
      })
      .mockResolvedValueOnce({
        output: criticOutput("accept"),
        usage: usage("claude"),
      });

    const result = await runMission(input({
      initialPlanVerdict: {
        schemaVersion: 1,
        missionId: "mission-42",
        storyId: 42,
        stage: "plan",
        createdAt: new Date().toISOString(),
        producedBy: "critic",
        disposition: "replan",
        objections: [objection],
        usage: usage("claude"),
      },
    }));

    expect(result.outcome).toBe("awaiting-plan-approval");
    expect(result.plan).toContain("Revised plan");
    expect(result.ledger.perStage.filter((entry) => entry.stage === "plan")).toHaveLength(1);
    expect(listArtifacts("mission-42")).toContain("plan-v2.json");
    expect(listArtifacts("mission-42")).toContain("plan.json");
  });

  it("keeps the critic plan-revision cap independent and unchanged", async () => {
    const initialPlanVerdict = {
      schemaVersion: 1,
      missionId: "mission-42",
      storyId: 42,
      stage: "plan",
      createdAt: new Date().toISOString(),
      producedBy: "critic",
      disposition: "replan",
      objections: [{
        severity: "major",
        claim: "The plan targets the wrong component.",
        evidence: ["feature.js:1"],
      }],
      usage: usage("claude"),
    } as const;

    const result = await runMission(input({
      initialPlanVerdict,
      limits: { ...input().limits, maxRevisions: 0 },
    }));

    expect(result.outcome).toBe("escalated");
    expect(result.reason).toBe("Revision limit reached for stage 'plan'");
    expect(runReadOnlyAgent).not.toHaveBeenCalled();
  });

  it("patches a developer naming confirmation without an LLM call and audits it as human input", async () => {
    const result = await runMission(input({
      plan: "Use OpenAiConversion in the portal and handler.",
      developerPlanAnswers: [{
        question: "Confirm the canonical type name: ChatGPTConversion vs OpenAiConversion.",
        answer: "Use ChatGPTConversion",
        evidence: "https://dev.azure.com/example/_workitems/edit/159636#comment-8",
      }],
    }));

    expect(result.outcome).toBe("awaiting-plan-approval");
    expect(result.plan).toContain("Use ChatGPTConversion in the portal and handler.");
    expect(runReadOnlyAgent).not.toHaveBeenCalled();
    const audit = readArtifact<{ source: string; path: string; objection: { evidence: string[] } }>("mission-42", "plan-revision-audit");
    expect(audit).toMatchObject({ source: "developer", path: "deterministic-patch" });
    expect(audit?.objection.evidence[0]).toContain("human decision — ADO comment");
  });

  it("routes a PixelHistory scope answer through a scoped plan rerun and audits that path", async () => {
    runReadOnlyAgent
      .mockResolvedValueOnce({
        output: "## Revised plan\nInclude Reports/PixelHistory.js after inspecting compatibility.",
        usage: usage("codex"),
      })
      .mockResolvedValueOnce({ output: criticOutput("accept"), usage: usage("claude") });

    const result = await runMission(input({
      developerPlanAnswers: [{
        question: "Does retained compatibility require updating Reports/PixelHistory.js?",
        answer: "Yes, add Reports/PixelHistory.js to the implementation scope.",
      }],
    }));

    expect(result.outcome).toBe("awaiting-plan-approval");
    expect(runReadOnlyAgent).toHaveBeenCalledTimes(2);
    const audit = readArtifact<{ source: string; path: string; objection: { evidence: string[] } }>("mission-42", "plan-revision-audit");
    expect(audit).toMatchObject({ source: "developer", path: "scoped-rerun" });
    expect(audit?.objection.evidence).toEqual(["human decision — Mission Control developer input"]);
  });

  it("enforces the independent developer plan-revision limit without consuming critic revisions", async () => {
    const result = await runMission(input({
      developerPlanAnswers: [{ question: "Should PixelHistory.js be included?", answer: "Yes, include it." }],
      limits: { ...input().limits, maxRevisions: 2, maxDeveloperPlanRevisions: 0 },
    }));

    expect(result.outcome).toBe("escalated");
    expect(result.reason).toMatch(/developer plan revision limit/i);
    expect(runReadOnlyAgent).not.toHaveBeenCalled();
  });

  it("refuses an exhausted mission budget before creating a worktree", async () => {
    const result = await runMission(input({
      limits: {
        perStageTokens: {},
        missionCeilingTokens: 0,
        maxRevisions: 2,
      },
    }));

    expect(result.outcome).toBe("escalated");
    expect(runWritingAgent).not.toHaveBeenCalled();
  });

  it("still applies affordability checks before the gates stage", async () => {
    const result = await runMission(input({
      limits: {
        perStageTokens: { develop: 1_200 },
        missionCeilingTokens: 1_200,
        maxRevisions: 2,
      },
    }));

    expect(result.outcome).toBe("escalated");
    expect(result.reason).toContain("Mission token ceiling");
    expect(result.stagesRun).toEqual(["develop"]);
    expect(runReadOnlyAgent).not.toHaveBeenCalled();
  });

  it("writes one valid develop artifact after passing gates", async () => {
    const result = await runMission(input());

    expect(result.outcome).toBe("done");
    expect(listArtifacts("mission-42")).toEqual(["develop-TestRepo.json"]);
    const artifact = readArtifact<unknown>("mission-42", "develop-TestRepo");
    expect(validateDevelopArtifact(artifact)).toEqual(artifact);
  });

  it("still rejects when the repository cannot start a develop run", async () => {
    const missingBranch = { ...repository, integrationBranch: "missing-branch" };

    await expect(runMission(input({ repository: missingBranch })))
      .rejects.toThrow("Integration branch 'missing-branch' not found");
    expect(runWritingAgent).not.toHaveBeenCalled();
  });
});
