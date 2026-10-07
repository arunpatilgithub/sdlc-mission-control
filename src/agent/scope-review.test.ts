import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runReadOnlyAgent = vi.fn();
vi.mock("./llm-provider.js", () => ({ runReadOnlyAgent: (...args: unknown[]) => runReadOnlyAgent(...args) }));
const { parseScopeRecommendations, runScopeReview } = await import("./scope-review.js");

let root: string;
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "scope-review-"));
  process.env.MISSION_CONTROL_RUNTIME_ROOT = resolve(root, "runtime");
  runReadOnlyAgent.mockReset();
});

afterEach(() => {
  delete process.env.MISSION_CONTROL_RUNTIME_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe("scope review", () => {
  it("gives the planning role the exact additional-file diff and maps its recommendation", async () => {
    const repo = resolve(root, "repo");
    mkdirSync(repo);
    g(repo, "init", "-b", "main");
    g(repo, "config", "user.email", "t@t.t");
    g(repo, "config", "user.name", "t");
    writeFileSync(resolve(repo, "extra.js"), "before\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-m", "base");
    const baseline = g(repo, "rev-parse", "HEAD");
    writeFileSync(resolve(repo, "extra.js"), "unrelated cleanup\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-m", "develop");
    runReadOnlyAgent.mockResolvedValue({
      output: 'Unrelated.\n```json\n{"recommendations":[{"path":"extra.js","classification":"unnecessary","rationale":"No acceptance criterion requires it.","evidence":["extra.js:1"]}]}\n```',
      usage: null,
    });

    const review = await runScopeReview({
      provider: "codex", worktreePath: repo, baselineCommit: baseline,
      storyId: 42, storyTitle: "Rename label", storyDescription: "Rename one label.",
      acceptanceCriteria: "Only the label changes.", approvedPlan: "Edit template.html.",
      approvedPaths: ["template.html"], offenders: ["extra.js"],
    });

    expect(review.recommendations).toEqual([{
      path: "extra.js", classification: "unnecessary",
      rationale: "No acceptance criterion requires it.", evidence: ["extra.js:1"], approvalAllowed: true,
    }]);
    const prompt = (runReadOnlyAgent.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("-before");
    expect(prompt).toContain("+unrelated cleanup");
    expect(prompt).toContain("never authorize scope yourself");
  });

  it("degrades omitted paths to uncertain rather than approving them", () => {
    const parsed = parseScopeRecommendations(
      '```json\n{"recommendations":[{"path":"one.js","classification":"required","rationale":"Needed","evidence":[]}]}\n```',
      ["one.js", "two.js"],
    );

    expect(parsed.recommendations).toEqual([
      { path: "one.js", classification: "required", rationale: "Needed", evidence: [], approvalAllowed: true },
      { path: "two.js", classification: "uncertain", rationale: "The scope advisor omitted this path.", evidence: [], approvalAllowed: true },
    ]);
    expect(parsed.parseError).toMatch(/omitted 1/);
  });

  it("marks permanent safety exclusions as non-approvable even when the advisor calls them required", () => {
    const parsed = parseScopeRecommendations(
      '```json\n{"recommendations":[{"path":"README.md","classification":"required","rationale":"Claimed requirement","evidence":[]}]}\n```',
      ["README.md"],
    );

    expect(parsed.recommendations[0]).toMatchObject({ path: "README.md", classification: "required", approvalAllowed: false });
  });
});
