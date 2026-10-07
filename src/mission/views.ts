import type { MissionPacket } from "../agent/mission-packet.js";
import type { MissionRunResult } from "./runner.js";

export interface PlannerView {
  storyId: number;
  storyTitle: string;
  storyState: string;
  description: string;
  acceptanceCriteria: string;
  repositoryId: string;
  branch: string;
  baselineCommit: string;
  appType: string;
  commands: string[];
  likelyFiles: string[];
  precedents: string[];
  instructions: string[];
  planningSkill: string;
  knownRepositoryIds: string[];
}

export interface CriticPlanView {
  storyId: number;
  storyTitle: string;
  acceptanceCriteria: string;
  repositoryId: string;
  planMarkdown: string;
  /** Repo-relative paths the critic may cite. Derived from the packet's likelyFiles. */
  citableFiles: string[];
}

export interface CriticDiffView {
  storyId: number;
  storyTitle: string;
  acceptanceCriteria: string;
  planMarkdown: string;
  diffStat: string | null;
  filesChanged: string[];
  regressions: string[];
  citableFiles: string[];
}

export interface AggregateCriticView {
  storyId: number;
  storyTitle: string;
  acceptanceCriteria: string;
  planMarkdown: string;
  executionOrder: string[];
  repositories: Array<{
    repositoryId: string;
    dependsOn: string[];
    outcome: MissionRunResult["outcome"] | "missing";
    diffStat: string | null;
    filesChanged: string[];
    regressions: string[];
    criticDisposition: string | null;
  }>;
}

export function plannerView(packet: MissionPacket): PlannerView {
  return {
    storyId: packet.story.id,
    storyTitle: packet.story.title,
    storyState: packet.story.state,
    description: packet.story.description,
    acceptanceCriteria: packet.story.acceptanceCriteria,
    repositoryId: packet.repository.id,
    branch: packet.repository.branch,
    baselineCommit: packet.repository.baselineCommit,
    appType: packet.repository.appType,
    commands: packet.repository.commands,
    likelyFiles: likelyFilePaths(packet),
    precedents: packet.precedents,
    instructions: packet.instructions,
    planningSkill: packet.planningSkill,
    knownRepositoryIds: packet.knownRepositoryIds,
  };
}

export function criticPlanView(packet: MissionPacket, planMarkdown: string): CriticPlanView {
  return {
    storyId: packet.story.id,
    storyTitle: packet.story.title,
    acceptanceCriteria: packet.story.acceptanceCriteria,
    repositoryId: packet.repository.id,
    planMarkdown,
    citableFiles: likelyFilePaths(packet),
  };
}

export function criticDiffView(
  packet: MissionPacket,
  planMarkdown: string,
  develop: { diffStat: string | null; filesChanged: string[]; regressions: string[] },
): CriticDiffView {
  return {
    storyId: packet.story.id,
    storyTitle: packet.story.title,
    acceptanceCriteria: packet.story.acceptanceCriteria,
    planMarkdown,
    diffStat: develop.diffStat,
    filesChanged: develop.filesChanged,
    regressions: develop.regressions,
    // Most of what a diff critic judges is files the plan-time preflight never saw, so
    // citable evidence must cover what the diff actually touched, not only what was
    // guessed at plan time — the plan's guesses stay citable too, for the plan-vs-diff
    // drift check the diff rubric asks for.
    citableFiles: [...new Set([...likelyFilePaths(packet), ...develop.filesChanged])],
  };
}

export function aggregateCriticView(
  packet: MissionPacket,
  planMarkdown: string,
  executionOrder: string[],
  dependenciesByRepository: Record<string, string[]>,
  resultsByRepository: Record<string, MissionRunResult>,
): AggregateCriticView {
  return {
    storyId: packet.story.id,
    storyTitle: packet.story.title,
    acceptanceCriteria: packet.story.acceptanceCriteria,
    planMarkdown,
    executionOrder,
    repositories: executionOrder.map((repositoryId) => {
      const result = resultsByRepository[repositoryId];
      return {
        repositoryId,
        dependsOn: dependenciesByRepository[repositoryId] ?? [],
        outcome: result?.outcome ?? "missing",
        diffStat: result?.develop?.diffStat ?? null,
        filesChanged: result?.develop?.filesChanged ?? [],
        regressions: result?.develop?.regressions ?? [],
        criticDisposition: result?.verdict?.disposition ?? null,
      };
    }),
  };
}

function likelyFilePaths(packet: MissionPacket): string[] {
  return packet.likelyFiles.map((file) => file.path);
}
