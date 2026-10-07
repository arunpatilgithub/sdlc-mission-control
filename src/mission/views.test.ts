import { describe, expect, it } from "vitest";
import type { MissionPacket } from "../agent/mission-packet.js";
import { aggregateCriticView, criticDiffView, criticPlanView, plannerView } from "./views.js";
import type { MissionRunResult } from "./runner.js";

const INSTRUCTIONS_SENTINEL = "SENTINEL-INSTRUCTIONS-7f2a";
const SKILL_SENTINEL = "SENTINEL-SKILL-91cd";
const PRECEDENT_SENTINEL = "sentinel-precedent-33bd";
const KNOWN_REPO_SENTINEL = "Sentinel.KnownRepo.55ee";
const BASELINE_SENTINEL = "sentinel-baseline-66aa";
const APP_TYPE_SENTINEL = "Sentinel AppType Node 77cc";
const COMMANDS_SENTINEL = "npm run sentinel-command-88dd";
const WORKTREE_PATH_SENTINEL = "/tmp/sentinel-worktree-path";

function buildPacket(overrides: Partial<MissionPacket> = {}): MissionPacket {
  return {
    schemaVersion: 1,
    missionId: "mission-1",
    generatedAt: "2026-08-20T12:00:00.000Z",
    mode: "fast",
    historyPolicy: "none",
    repositoryStrategy: "existing",
    phase: "implementation-plan",
    proposedRepositoryName: null,
    story: { id: 42, title: "Add a widget", state: "Active", description: "Add a configurable widget.", acceptanceCriteria: "Widget renders on the dashboard." },
    repository: {
      id: "Publisher.Api",
      worktreePath: WORKTREE_PATH_SENTINEL,
      branch: "mission/42-abcdef",
      baselineCommit: BASELINE_SENTINEL,
      appType: APP_TYPE_SENTINEL,
      commands: [COMMANDS_SENTINEL],
    },
    instructions: [`## AGENTS.md\n${INSTRUCTIONS_SENTINEL}`],
    planningSkill: `${SKILL_SENTINEL} planning guidance`,
    planningSkillTools: [],
    likelyFiles: [
      { path: "src/widgets/Widget.ts", sha256: "deadbeef" },
      { path: "src/widgets/Widget.test.ts", sha256: "beadfeed" },
    ],
    precedents: [PRECEDENT_SENTINEL],
    knownRepositoryIds: ["Publisher.Api", KNOWN_REPO_SENTINEL],
    ...overrides,
  };
}

function assertExcluded(view: unknown, field: string, sentinel: string): void {
  expect(view).not.toHaveProperty(field);
  expect(JSON.stringify(view)).not.toContain(sentinel);
}

it("projects aggregate review evidence without leaking worktree paths or agent output", () => {
  const result = {
    outcome: "done",
    develop: {
      worktreePath: WORKTREE_PATH_SENTINEL,
      diffStat: "src/a.ts | 1 +",
      filesChanged: ["src/a.ts"],
      regressions: [],
      output: "SENTINEL-AGENT-OUTPUT",
    },
    verdict: { disposition: "accept" },
  } as unknown as MissionRunResult;

  const view = aggregateCriticView(buildPacket(), "plan", ["Publisher.Api"], { "Publisher.Api": [] }, { "Publisher.Api": result });

  expect(view.repositories[0]).toMatchObject({ repositoryId: "Publisher.Api", filesChanged: ["src/a.ts"], criticDisposition: "accept" });
  expect(JSON.stringify(view)).not.toContain(WORKTREE_PATH_SENTINEL);
  expect(JSON.stringify(view)).not.toContain("SENTINEL-AGENT-OUTPUT");
});

function assertFileMetadataExcluded(view: unknown): void {
  const serialised = JSON.stringify(view);
  expect(serialised).not.toContain("deadbeef");
  expect(serialised).not.toContain("beadfeed");
  expect(serialised).not.toContain(WORKTREE_PATH_SENTINEL);
}

const EXCLUDED_FIELDS: Array<[string, string]> = [
  ["instructions", INSTRUCTIONS_SENTINEL],
  ["planningSkill", SKILL_SENTINEL],
  ["precedents", PRECEDENT_SENTINEL],
  ["knownRepositoryIds", KNOWN_REPO_SENTINEL],
  ["baselineCommit", BASELINE_SENTINEL],
  ["appType", APP_TYPE_SENTINEL],
  ["commands", COMMANDS_SENTINEL],
];

describe("plannerView", () => {
  it("retains instructions and planningSkill — excluding them everywhere would silently degrade planning", () => {
    const view = plannerView(buildPacket());

    expect(view.instructions).toEqual([`## AGENTS.md\n${INSTRUCTIONS_SENTINEL}`]);
    expect(view.planningSkill).toBe(`${SKILL_SENTINEL} planning guidance`);
    expect(JSON.stringify(view)).toContain(INSTRUCTIONS_SENTINEL);
    expect(JSON.stringify(view)).toContain(SKILL_SENTINEL);
  });

  it("carries the story, repository, and file fields the planner needs", () => {
    const view = plannerView(buildPacket());

    expect(view).toMatchObject({
      storyId: 42,
      storyTitle: "Add a widget",
      storyState: "Active",
      description: "Add a configurable widget.",
      acceptanceCriteria: "Widget renders on the dashboard.",
      repositoryId: "Publisher.Api",
      branch: "mission/42-abcdef",
      baselineCommit: BASELINE_SENTINEL,
      appType: APP_TYPE_SENTINEL,
      commands: [COMMANDS_SENTINEL],
      precedents: [PRECEDENT_SENTINEL],
      knownRepositoryIds: ["Publisher.Api", KNOWN_REPO_SENTINEL],
    });
  });

  it("exposes only the path of each likely file, not the integrity hash", () => {
    const view = plannerView(buildPacket());

    expect(view.likelyFiles).toEqual(["src/widgets/Widget.ts", "src/widgets/Widget.test.ts"]);
    assertFileMetadataExcluded(view);
  });

  it("omits packet metadata that the planner does not consume", () => {
    const view = plannerView(buildPacket());
    for (const field of [
      "schemaVersion", "missionId", "generatedAt", "mode", "historyPolicy",
      "repositoryStrategy", "phase", "proposedRepositoryName", "repository.worktreePath",
    ]) {
      expect(view).not.toHaveProperty(field);
    }
    expect(JSON.stringify(view)).not.toContain(WORKTREE_PATH_SENTINEL);
  });
});

describe("criticPlanView", () => {
  it("includes the story, repository id, and the supplied plan markdown", () => {
    const view = criticPlanView(buildPacket(), "## Plan\nDo the thing.");

    expect(view).toMatchObject({
      storyId: 42,
      storyTitle: "Add a widget",
      acceptanceCriteria: "Widget renders on the dashboard.",
      repositoryId: "Publisher.Api",
      planMarkdown: "## Plan\nDo the thing.",
    });
  });

  it("derives citableFiles from the packet's likelyFiles", () => {
    const view = criticPlanView(buildPacket(), "## Plan");

    expect(view.citableFiles).toEqual(["src/widgets/Widget.ts", "src/widgets/Widget.test.ts"]);
    assertFileMetadataExcluded(view);
  });

  it.each(EXCLUDED_FIELDS)("excludes %s, both as a property and from the serialised view", (field, sentinel) => {
    const view = criticPlanView(buildPacket(), "## Plan\nDo the thing.");
    assertExcluded(view, field, sentinel);
  });
});

describe("criticDiffView", () => {
  const develop = { diffStat: "2 files changed, 40 insertions(+)", filesChanged: ["src/widgets/Widget.ts", "src/widgets/NewHelper.ts"], regressions: ["npm test"] };

  it("includes the story, plan markdown, and develop-stage results", () => {
    const view = criticDiffView(buildPacket(), "## Plan\nDo the thing.", develop);

    expect(view).toMatchObject({
      storyId: 42,
      storyTitle: "Add a widget",
      acceptanceCriteria: "Widget renders on the dashboard.",
      planMarkdown: "## Plan\nDo the thing.",
      diffStat: "2 files changed, 40 insertions(+)",
      filesChanged: ["src/widgets/Widget.ts", "src/widgets/NewHelper.ts"],
      regressions: ["npm test"],
    });
    expect(view.diffStat).toBe(develop.diffStat);
  });

  it("preserves a null diffStat without substituting a placeholder", () => {
    const view = criticDiffView(buildPacket(), "## Plan", { ...develop, diffStat: null });
    expect(view.diffStat).toBeNull();
    expect(JSON.stringify(view)).not.toContain("no diff stat available");
  });

  it("derives citableFiles from the union of likelyFiles and filesChanged, deduplicated", () => {
    const view = criticDiffView(buildPacket(), "## Plan", develop);

    // src/widgets/Widget.ts is in both likelyFiles and filesChanged, and must not be duplicated.
    expect(view.citableFiles).toEqual(["src/widgets/Widget.ts", "src/widgets/Widget.test.ts", "src/widgets/NewHelper.ts"]);
    assertFileMetadataExcluded(view);
  });

  it.each(EXCLUDED_FIELDS)("excludes %s, both as a property and from the serialised view", (field, sentinel) => {
    const view = criticDiffView(buildPacket(), "## Plan\nDo the thing.", develop);
    assertExcluded(view, field, sentinel);
  });
});
