import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replayValidationCorpus } from "../dev/validation-replay.js";
import { credentialLikeString, recordedFixtureCredentials } from "./recorded-validation-fixtures.js";

const fixturesDirectory = resolve(process.cwd(), "src/agent/__fixtures__/recorded");
const temporaryRoots: string[] = [];
const testHarnesses: Record<string, unknown> = {
  "Publisher.MicroService.PostbackHandler": {
    testPaths: ["test.js", "test/ChatGPTConversion.test.js"],
    activeTestPaths: ["test.js"],
    runnerGlobs: [],
    runnerDetected: true,
    sourcePathsByTestPath: {
      "test.js": ["index.js", "testData/prodTestData.js", "testData/testData.js"],
      "test/ChatGPTConversion.test.js": ["src/PixelTypes.js", "src/Handler.js"],
    },
  },
};

type FixtureManifest = {
  excludedStoryIds: number[];
  providerCoverage: { observed: string[]; absent: string[] };
  fixtures: Array<{ artifact: string; expected: string }>;
};

function fixtureRuntimeRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "validation-recorded-fixtures-"));
  temporaryRoots.push(root);
  cpSync(fixturesDirectory, root, { recursive: true });
  for (const missionId of FixtureManifestData().fixtures.map((fixture) => fixture.artifact.slice(0, 36)).filter((id, index, ids) => ids.indexOf(id) === index)) {
    const missionDirectory = resolve(root, "missions", missionId);
    const name = readdirSync(missionDirectory).find((entry) => /^planning-job(?:-v\d+)?\.json$/.test(entry));
    if (!name) throw new Error(`Fixture ${missionId} is missing its planning job context.`);
    const path = resolve(missionDirectory, name);
    const job = JSON.parse(readFileSync(path, "utf8")) as { repositoryIds: string[]; testHarnessSignature?: Record<string, unknown>; worktreePaths?: Record<string, string> };
    job.testHarnessSignature = Object.fromEntries(job.repositoryIds.map((repositoryId) => [repositoryId, testHarnesses[repositoryId] ?? {
      testPaths: [], activeTestPaths: [], runnerDetected: false, sourcePathsByTestPath: {},
    }]));
    job.worktreePaths = {};
    writeFileSync(path, `${JSON.stringify(job)}\n`);
  }
  return root;
}

function FixtureManifestData(): FixtureManifest {
  return JSON.parse(readFileSync(resolve(fixturesDirectory, "manifest.json"), "utf8")) as FixtureManifest;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("recorded validation fixtures", () => {
  it("replays every frozen stage to its recorded outcome", () => {
    const manifest = FixtureManifestData();
    const report = replayValidationCorpus(fixtureRuntimeRoot());
    const outcomes = new Map(report.stages.map((stage) => [stage.artifact, stage.outcome === "invalid" ? stage.ruleId : stage.outcome]));

    expect(manifest.fixtures).toHaveLength(36);
    expect(manifest.excludedStoryIds).toEqual([159636, 162941]);
    expect(manifest.providerCoverage).toEqual(expect.objectContaining({ observed: ["codex"], absent: ["claude"] }));
    expect([...outcomes.entries()].sort()).toEqual(manifest.fixtures.map((fixture) => [fixture.artifact, fixture.expected]).sort());
  });

  it("contains no credential-like material and rejects a planted credential", () => {
    expect(recordedFixtureCredentials(fixturesDirectory)).toEqual([]);
    expect(credentialLikeString("Authorization: Bearer example-token-with-sufficient-length")).toBe("bearer-token");
    expect(credentialLikeString("sk-example_key_value_which_is_long_enough")).toBe("openai-key");
  });
});
