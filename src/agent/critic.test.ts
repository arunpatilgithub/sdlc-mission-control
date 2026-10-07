import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateCriticVerdict } from "../mission/artifacts.js";

// The model is stubbed: these tests cover the harness's citation discipline and
// prompt-building, not any actual provider's judgement. runWritingAgent is spied on,
// not just omitted, so a regression that reached for it would fail loudly.
const runReadOnlyAgent = vi.fn();
const runWritingAgent = vi.fn();
vi.mock("./llm-provider.js", () => ({
  runReadOnlyAgent: (...args: unknown[]) => runReadOnlyAgent(...args),
  runWritingAgent: (...args: unknown[]) => runWritingAgent(...args),
}));

const { runCritic } = await import("./critic.js");
type CriticInput = Parameters<typeof runCritic>[0];

let root: string;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "critic-"));
  process.env.MISSION_CONTROL_RUNTIME_ROOT = root;
  runReadOnlyAgent.mockReset();
  runWritingAgent.mockReset();
});

afterEach(() => {
  delete process.env.MISSION_CONTROL_RUNTIME_ROOT;
  rmSync(root, { recursive: true, force: true });
});

const usage = () => ({
  provider: "claude" as const, inputTokens: 2000, cachedInputTokens: 0, cacheWriteTokens: 0,
  outputTokens: 200, reasoningTokens: null, costUSD: 0.01, turns: 1, durationMs: 1500,
  promptBytes: 1000, toolOutputBytes: 0, outputBytes: 300, commandCount: 0,
});
const respond = (output: string) => runReadOnlyAgent.mockResolvedValue({ output, usage: usage() });
const jsonReply = (payload: unknown) => `Some critique prose.\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;

function input(over: Partial<CriticInput> = {}): CriticInput {
  return {
    stage: "diff",
    missionId: "mission-1",
    storyId: 42,
    subject: "The change adds a new worker file.",
    citableFiles: ["src/foo.ts"],
    worktreePath: "/repos/publisher-api",
    ...over,
  };
}

describe("runCritic — citation discipline", () => {
  it("drops an objection with no evidence but keeps a properly cited one", async () => {
    respond(jsonReply({
      disposition: "revise",
      objections: [
        { severity: "blocker", claim: "Unfounded claim", evidence: [] },
        { severity: "major", claim: "Field name is unconfirmed", evidence: ["src/foo.ts:12"] },
      ],
    }));

    const verdict = await runCritic(input());

    expect(verdict.objections).toHaveLength(1);
    expect(verdict.objections[0]).toEqual({ severity: "major", claim: "Field name is unconfirmed", evidence: ["src/foo.ts:12"] });
  });

  it("drops an objection citing a path outside citableFiles and falls back to accept", async () => {
    respond(jsonReply({
      disposition: "revise",
      objections: [
        { severity: "minor", claim: "Style nit", evidence: ["src/nonexistent.ts:5"] },
      ],
    }));

    const verdict = await runCritic(input({ citableFiles: ["src/foo.ts"] }));

    expect(verdict.objections).toEqual([]);
    expect(verdict.disposition).toBe("accept");
  });

  it("degrades to escalate with zero objections on garbage model output, never throwing", async () => {
    respond("This is not JSON at all, just prose the model produced instead of a verdict.");

    const verdict = await runCritic(input());

    expect(verdict.disposition).toBe("escalate");
    expect(verdict.objections).toEqual([]);
  });

  it("passes the positive path through intact: same objections, same disposition", async () => {
    const objections = [
      { severity: "blocker", claim: "Verification no longer exercises the failure path.", evidence: ["src/foo.ts:52"] },
      { severity: "minor", claim: "Error message is inconsistent with the sibling worker.", evidence: ["src/foo.ts:31"] },
    ];
    respond(jsonReply({ disposition: "revise", objections }));

    const verdict = await runCritic(input({ citableFiles: ["src/foo.ts"] }));

    expect(verdict.disposition).toBe("revise");
    expect(verdict.objections).toEqual(objections);
  });

  it("validates against the critic verdict schema Task 2 defined", async () => {
    respond(jsonReply({
      disposition: "revise",
      objections: [{ severity: "major", claim: "Field name is unconfirmed", evidence: ["src/foo.ts:12"] }],
    }));

    const verdict = await runCritic(input());

    expect(validateCriticVerdict(verdict)).toEqual(verdict);
  });
});

describe("runCritic — read-only enforcement", () => {
  it("reaches the read-only entry point and never the writing one", async () => {
    respond(jsonReply({ disposition: "accept", objections: [] }));

    await runCritic(input());

    expect(runReadOnlyAgent).toHaveBeenCalledTimes(1);
    expect(runWritingAgent).not.toHaveBeenCalled();
  });
});

describe("runCritic — rubric tool declarations reach the provider call", () => {
  it("passes an empty extraReadTools when the rubric declares none, rather than dropping the field", async () => {
    respond(jsonReply({ disposition: "accept", objections: [] }));

    await runCritic(input());

    expect(runReadOnlyAgent).toHaveBeenCalledWith(expect.objectContaining({ extraReadTools: [] }));
  });
});

describe("runCritic — the returned verdict carries the input's values", () => {
  it("reflects missionId, storyId, and stage from the input, and usage from the agent result", async () => {
    const agentUsage = usage();
    runReadOnlyAgent.mockResolvedValue({ output: jsonReply({ disposition: "accept", objections: [] }), usage: agentUsage });

    const verdict = await runCritic(input({ missionId: "mission-77", storyId: 123, stage: "plan" }));

    expect(verdict.missionId).toBe("mission-77");
    expect(verdict.storyId).toBe(123);
    expect(verdict.stage).toBe("plan");
    expect(verdict.usage).toEqual(agentUsage);
  });
});

describe("runCritic — reads the repository under review, not this one", () => {
  it("passes the given worktreePath as workingDir, not process.cwd()", async () => {
    respond(jsonReply({ disposition: "accept", objections: [] }));
    const worktreePath = "/repos/some-other-checkout";

    await runCritic(input({ worktreePath }));

    const passedWorkingDir = (runReadOnlyAgent.mock.calls[0][0] as { workingDir: string }).workingDir;
    expect(passedWorkingDir).toBe(worktreePath);
    expect(passedWorkingDir).not.toBe(process.cwd());
  });
});

describe("runCritic — rubric loading is independent of the process working directory", () => {
  it("still finds the rubric when cwd is not the repository root", async () => {
    respond(jsonReply({ disposition: "accept", objections: [] }));
    const originalCwd = process.cwd();
    const elsewhere = mkdtempSync(resolve(tmpdir(), "critic-cwd-"));
    process.chdir(elsewhere);
    try {
      await runCritic(input({ stage: "plan" }));
      const prompt = (runReadOnlyAgent.mock.calls[0][0] as { prompt: string }).prompt;
      expect(prompt).toMatch(/Do the named paths exist\?/);
    } finally {
      process.chdir(originalCwd);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("runCritic — the rubric is actually used", () => {
  it("embeds a distinctive phrase from the stage's rubric file in the prompt", async () => {
    respond(jsonReply({ disposition: "accept", objections: [] }));
    await runCritic(input({ stage: "plan" }));
    const planPrompt = (runReadOnlyAgent.mock.calls[0][0] as { prompt: string }).prompt;
    expect(planPrompt).toMatch(/Do the named paths exist\?/);

    runReadOnlyAgent.mockClear();
    respond(jsonReply({ disposition: "accept", objections: [] }));
    await runCritic(input({ stage: "diff" }));
    const diffPrompt = (runReadOnlyAgent.mock.calls[0][0] as { prompt: string }).prompt;
    expect(diffPrompt).toMatch(/Does the diff implement the plan\?/);

    expect(planPrompt).not.toBe(diffPrompt);
    expect(planPrompt).not.toMatch(/Does the diff implement the plan\?/);
    expect(diffPrompt).not.toMatch(/Do the named paths exist\?/);
  });
});
