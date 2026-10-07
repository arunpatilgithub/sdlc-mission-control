import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { CreatedPullRequest, PullRequestCreationRequest } from "../ado/azure-devops-cli.js";
import type { RepositoryConfig } from "../config/team-config.js";

const PUSH_DISABLED_URL = "DISABLED-mission-control-never-pushes";

export interface PullRequestPublisher {
  findActivePullRequest(request: Pick<PullRequestCreationRequest, "repositoryId" | "sourceBranch" | "targetBranch">): Promise<CreatedPullRequest | null>;
  createPullRequest(request: PullRequestCreationRequest): Promise<CreatedPullRequest>;
}

export interface MergeRequestPublisher {
  mergePullRequest(id: number): Promise<CreatedPullRequest>;
}

export interface GitPublisher {
  assertPublishableCommit(repositoryPath: string, worktreePath: string, commit: string): void;
  remoteCommit(repositoryPath: string, remoteUrl: string, branch: string): string | null;
  pushCommit(repositoryPath: string, remoteUrl: string, commit: string, branch: string): void;
}

export interface PublishMissionInput {
  missionId: string;
  developRunId: string;
  storyId: number;
  storyTitle: string;
  repository: RepositoryConfig;
  developWorktreePath: string;
  commit: string;
  sourceBranch: string;
  dryRun: boolean;
  /** Carried into the PR description verbatim — e.g. an aggregate-review developer override and the reviewer's own objections, so a raised concern is never silently lost even when a human judges it non-blocking. */
  additionalNotes?: string;
}

export interface PublishResult {
  missionId: string;
  developRunId: string;
  storyId: number;
  repositoryId: string;
  scm: RepositoryConfig["scm"];
  dryRun: boolean;
  sourceBranch: string;
  targetBranch: string;
  commit: string;
  push: "planned" | "pushed" | "already-present" | "failed";
  pullRequest: CreatedPullRequest | null;
  merge: MergeResult | null;
  published: boolean;
  error: string | null;
  completedAt: string;
}

export interface MergeResult {
  pullRequest: CreatedPullRequest;
  merged: boolean;
  error: string | null;
  completedAt: string;
}

export function mergeEligibilityError(repository: RepositoryConfig, publication: PublishResult | null | undefined, confirmed: boolean): string | null {
  if (repository.scm !== "gitlab") return "Merge currently supports GitLab repositories only";
  if (!publication?.published || publication.pullRequest === null || publication.dryRun) return "A published merge request is required before merging";
  if (!confirmed) return "Explicit developer confirmation is required to merge";
  return null;
}

export async function publishMission(
  client: PullRequestPublisher,
  input: PublishMissionInput,
  gitPublisher: GitPublisher = localGitPublisher,
): Promise<PublishResult> {
  const result: PublishResult = {
    missionId: input.missionId,
    developRunId: input.developRunId,
    storyId: input.storyId,
    repositoryId: input.repository.id,
    scm: input.repository.scm,
    dryRun: input.dryRun,
    sourceBranch: input.sourceBranch,
    targetBranch: input.repository.integrationBranch,
    commit: input.commit,
    push: "planned",
    pullRequest: null,
    merge: null,
    published: false,
    error: null,
    completedAt: new Date().toISOString(),
  };

  try {
    gitPublisher.assertPublishableCommit(input.repository.localPath, input.developWorktreePath, input.commit);
    if (input.dryRun) return finish(result);
    const remoteCommit = gitPublisher.remoteCommit(input.repository.localPath, input.repository.remoteUrl, input.sourceBranch);
    if (remoteCommit !== null && remoteCommit !== input.commit) {
      throw new Error(`Remote branch '${input.sourceBranch}' points to a different commit; refusing to force-push`);
    }
    if (remoteCommit === input.commit) {
      result.push = "already-present";
    } else {
      gitPublisher.pushCommit(input.repository.localPath, input.repository.remoteUrl, input.commit, input.sourceBranch);
      result.push = "pushed";
    }

    const request: PullRequestCreationRequest = {
      repositoryId: input.repository.id,
      sourceBranch: input.sourceBranch,
      targetBranch: input.repository.integrationBranch,
      title: `PUB-${input.storyId}: ${input.storyTitle}`,
      description: `Mission ${input.missionId}\n\nDevelop run: ${input.developRunId}\nCommit: ${input.commit}${input.additionalNotes ? `\n\n${input.additionalNotes}` : ""}`,
      workItemId: input.storyId,
    };
    result.pullRequest = await client.findActivePullRequest(request) ?? await client.createPullRequest(request);
    result.published = true;
  } catch (error) {
    if (result.push === "planned") result.push = "failed";
    result.error = error instanceof Error ? error.message : String(error);
  }
  return finish(result);
}

export async function mergePublishedMergeRequest(
  client: MergeRequestPublisher,
  repository: RepositoryConfig,
  publication: PublishResult,
): Promise<MergeResult> {
  const result: MergeResult = {
    pullRequest: publication.pullRequest ?? { id: 0, title: "Unavailable merge request", url: "" },
    merged: false,
    error: null,
    completedAt: new Date().toISOString(),
  };
  const eligibilityError = mergeEligibilityError(repository, publication, true);
  if (eligibilityError) {
    result.error = eligibilityError;
  } else {
    try {
      const pullRequest = publication.pullRequest;
      if (pullRequest === null) throw new Error("A published merge request is required before merging");
      result.pullRequest = await client.mergePullRequest(pullRequest.id);
      result.merged = true;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
  }
  result.completedAt = new Date().toISOString();
  writeMergeAudit(publication.missionId, publication.developRunId, repository.id, result);
  return result;
}

const localGitPublisher: GitPublisher = {
  assertPublishableCommit(repositoryPath, worktreePath, commit) {
    const resolved = git(repositoryPath, ["rev-parse", `${commit}^{commit}`]);
    if (resolved !== commit) throw new Error("Develop commit is not available in the approved repository");
    if (git(worktreePath, ["remote", "get-url", "--push", "origin"]) !== PUSH_DISABLED_URL) {
      throw new Error("Refusing to publish from a Develop worktree whose push protection is missing");
    }
  },
  remoteCommit(repositoryPath, remoteUrl, branch) {
    const output = git(repositoryPath, ["ls-remote", "--heads", remoteUrl, `refs/heads/${branch}`]);
    if (output === "") return null;
    const [commit] = output.split(/\s+/);
    return commit || null;
  },
  pushCommit(repositoryPath, remoteUrl, commit, branch) {
    git(repositoryPath, ["push", remoteUrl, `${commit}:refs/heads/${branch}`]);
  },
};

function finish(result: PublishResult): PublishResult {
  result.completedAt = new Date().toISOString();
  writePublishAudit(result);
  return result;
}

function writePublishAudit(result: PublishResult): void {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  const root = configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
  const directory = resolve(root, "missions", result.missionId);
  mkdirSync(directory, { recursive: true });
  const timestamp = result.completedAt.replace(/[:.]/g, "-");
  writeFileSync(resolve(directory, `publish-${timestamp}-${randomUUID().slice(0, 8)}.json`), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
}

function writeMergeAudit(missionId: string, developRunId: string, repositoryId: string, result: MergeResult): void {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  const root = configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
  const directory = resolve(root, "missions", missionId);
  mkdirSync(directory, { recursive: true });
  const timestamp = result.completedAt.replace(/[:.]/g, "-");
  writeFileSync(resolve(directory, `merge-${timestamp}-${randomUUID().slice(0, 8)}.json`), `${JSON.stringify({ developRunId, repositoryId, ...result }, null, 2)}\n`, { flag: "wx" });
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}
