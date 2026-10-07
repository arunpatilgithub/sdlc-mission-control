import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replayValidationCorpus } from "./validation-replay.js";

const temporaryRoots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "validation-replay-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "planning-runs"), { recursive: true });
  mkdirSync(join(root, "missions", "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"), { recursive: true });
  writeFileSync(join(root, "missions", "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "planning-job.json"), JSON.stringify({
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    provider: "codex",
    repositoryIds: ["Repo"],
    worktreePaths: {},
    packet: { story: { id: 700001 }, knownRepositoryIds: ["Repo"] },
  }));
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("replayValidationCorpus", () => {
  it("degrades malformed recorded output to a typed invalid result without changing missions", () => {
    const root = fixtureRoot();
    const missionsPath = join(root, "missions", "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "planning-job.json");
    const before = readFileSync(missionsPath, "utf8");
    writeFileSync(join(root, "planning-runs", "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.Repo.scout.attempt-one.md"), "not json");

    const report = replayValidationCorpus(root);

    expect(report.stages).toEqual([expect.objectContaining({
      outcome: "invalid",
      ruleId: "scout.packet-missing",
      message: "No fenced JSON scout packet was found.",
    })]);
    expect(readFileSync(missionsPath, "utf8")).toBe(before);
  });

  it("counts scope-anchor artifacts as context-dependent skips", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "planning-runs", "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.Repo.scope-anchor-repair.attempt-one.md"), "```json\n{}\n```");

    const report = replayValidationCorpus(root);

    expect(report.stages).toEqual([expect.objectContaining({ outcome: "context-dependent: skipped", context: "scope-anchor-baseline" })]);
  });
});
