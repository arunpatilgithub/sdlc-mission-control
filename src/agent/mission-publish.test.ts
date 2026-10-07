import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryConfig } from "../config/team-config.js";
import { mergeEligibilityError, mergePublishedMergeRequest, publishMission, type GitPublisher, type MergeRequestPublisher, type PullRequestPublisher, type PublishMissionInput } from "./mission-publish.js";

let root: string;
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "mission-publish-"));
  process.env.MISSION_CONTROL_RUNTIME_ROOT = resolve(root, "runtime");
});

afterEach(() => {
  delete process.env.MISSION_CONTROL_RUNTIME_ROOT;
  rmSync(root, { recursive: true, force: true });
});

function input(overrides: Partial<PublishMissionInput> = {}): PublishMissionInput {
  const repository: RepositoryConfig = {
    id: "Publisher.Portal",
    scm: "azure-devops",
    localPath: resolve(root, "repo"),
    remoteUrl: "https://example.com/Publisher.Portal",
    integrationBranch: "main",
  };
  return {
    missionId: "mission-42",
    developRunId: "develop-42",
    storyId: 42,
    storyTitle: "Add feature",
    repository,
    developWorktreePath: resolve(root, ".worktrees", "develop-42"),
    commit: "a".repeat(40),
    sourceBranch: "feature/arpatil/PUB-42",
    dryRun: false,
    ...overrides,
  };
}

function client(overrides: Partial<PullRequestPublisher> = {}): PullRequestPublisher {
  return {
    findActivePullRequest: vi.fn().mockResolvedValue(null),
    createPullRequest: vi.fn().mockResolvedValue({ id: 701, title: "PUB-42: Add feature", url: "https://example/pr/701" }),
    ...overrides,
  };
}

describe("publishMission", () => {
  it("dry run validates locally and writes an audit without touching a remote or Azure DevOps", async () => {
    const gitPublisher: GitPublisher = {
      assertPublishableCommit: vi.fn(),
      remoteCommit: vi.fn(() => { throw new Error("must not run"); }),
      pushCommit: vi.fn(() => { throw new Error("must not run"); }),
    };
    const ado = client();

    const result = await publishMission(ado, input({ dryRun: true }), gitPublisher);

    expect(result).toMatchObject({ dryRun: true, push: "planned", published: false, error: null });
    expect(gitPublisher.assertPublishableCommit).toHaveBeenCalledOnce();
    expect(gitPublisher.remoteCommit).not.toHaveBeenCalled();
    expect(gitPublisher.pushCommit).not.toHaveBeenCalled();
    expect(ado.findActivePullRequest).not.toHaveBeenCalled();
    expect(readdirSync(resolve(root, "runtime", "missions", "mission-42"))).toHaveLength(1);
  });

  it("refuses a conflicting remote branch without pushing or creating a PR", async () => {
    const gitPublisher: GitPublisher = {
      assertPublishableCommit: vi.fn(),
      remoteCommit: vi.fn(() => "b".repeat(40)),
      pushCommit: vi.fn(),
    };
    const ado = client();

    const result = await publishMission(ado, input(), gitPublisher);

    expect(result.error).toMatch(/refusing to force-push/i);
    expect(gitPublisher.pushCommit).not.toHaveBeenCalled();
    expect(ado.createPullRequest).not.toHaveBeenCalled();
  });

  it("retries PR creation after a successful push without pushing twice", async () => {
    let remoteCommit: string | null = null;
    const gitPublisher: GitPublisher = {
      assertPublishableCommit: vi.fn(),
      remoteCommit: vi.fn(() => remoteCommit),
      pushCommit: vi.fn((_path, _url, commit) => { remoteCommit = commit; }),
    };
    const createPullRequest = vi.fn()
      .mockRejectedValueOnce(new Error("ADO temporarily unavailable"))
      .mockResolvedValueOnce({ id: 702, title: "PUB-42: Add feature", url: "https://example/pr/702" });
    const ado = client({ createPullRequest });

    const first = await publishMission(ado, input(), gitPublisher);
    const retry = await publishMission(ado, input(), gitPublisher);

    expect(first).toMatchObject({ push: "pushed", published: false, error: "ADO temporarily unavailable" });
    expect(retry).toMatchObject({ push: "already-present", published: true, error: null });
    expect(gitPublisher.pushCommit).toHaveBeenCalledTimes(1);
    expect(createPullRequest).toHaveBeenCalledTimes(2);
  });

  it("reuses an active pull request when the branch already has the reviewed commit", async () => {
    const gitPublisher: GitPublisher = {
      assertPublishableCommit: vi.fn(),
      remoteCommit: vi.fn(() => "a".repeat(40)),
      pushCommit: vi.fn(),
    };
    const existing = { id: 703, title: "Existing PR", url: "https://example/pr/703" };
    const ado = client({ findActivePullRequest: vi.fn().mockResolvedValue(existing) });

    const result = await publishMission(ado, input(), gitPublisher);

    expect(result).toMatchObject({ push: "already-present", pullRequest: existing, published: true });
    expect(gitPublisher.pushCommit).not.toHaveBeenCalled();
    expect(ado.createPullRequest).not.toHaveBeenCalled();
  });

  it("publishes a GitLab repository through the same reviewed-commit path", async () => {
    const gitPublisher: GitPublisher = {
      assertPublishableCommit: vi.fn(),
      remoteCommit: vi.fn(() => null),
      pushCommit: vi.fn(),
    };
    const gitlab = client();

    const result = await publishMission(gitlab, input({ repository: { ...input().repository, scm: "gitlab" } }), gitPublisher);

    expect(result).toMatchObject({ scm: "gitlab", push: "pushed", published: true, error: null });
    expect(gitlab.createPullRequest).toHaveBeenCalledOnce();
  });

  it("merges only an already published GitLab merge request", async () => {
    const mergePullRequest = vi.fn().mockResolvedValue({ id: 702, title: "Merged", url: "https://gitlab.example/mr/702" });
    const client: MergeRequestPublisher = { mergePullRequest };
    const publication = {
      missionId: "mission-42", developRunId: "develop-42", storyId: 42, repositoryId: "Publisher.Portal", scm: "gitlab" as const,
      dryRun: false, sourceBranch: "feature/arpatil/PUB-42", targetBranch: "main", commit: "a".repeat(40), push: "pushed" as const,
      pullRequest: { id: 702, title: "MR", url: "https://gitlab.example/mr/702" }, merge: null, published: true, error: null, completedAt: new Date().toISOString(),
    };

    await expect(mergePublishedMergeRequest(client, { ...input().repository, scm: "gitlab" }, publication)).resolves.toMatchObject({ merged: true, error: null });
    expect(mergePullRequest).toHaveBeenCalledWith(702);
  });

  it("does not call GitLab when a merge request was not published", async () => {
    const mergePullRequest = vi.fn();
    const client: MergeRequestPublisher = { mergePullRequest };
    const publication = {
      missionId: "mission-42", developRunId: "develop-42", storyId: 42, repositoryId: "Publisher.Portal", scm: "gitlab" as const,
      dryRun: true, sourceBranch: "feature/arpatil/PUB-42", targetBranch: "main", commit: "a".repeat(40), push: "planned" as const,
      pullRequest: null, merge: null, published: false, error: null, completedAt: new Date().toISOString(),
    };

    await expect(mergePublishedMergeRequest(client, { ...input().repository, scm: "gitlab" }, publication)).resolves.toMatchObject({ merged: false, error: expect.stringMatching(/published merge request/i) });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("requires explicit developer confirmation before a GitLab merge becomes eligible", () => {
    const publication = {
      missionId: "mission-42", developRunId: "develop-42", storyId: 42, repositoryId: "Publisher.Portal", scm: "gitlab" as const,
      dryRun: false, sourceBranch: "feature/arpatil/PUB-42", targetBranch: "main", commit: "a".repeat(40), push: "pushed" as const,
      pullRequest: { id: 702, title: "MR", url: "https://gitlab.example/mr/702" }, merge: null, published: true, error: null, completedAt: new Date().toISOString(),
    };

    expect(mergeEligibilityError({ ...input().repository, scm: "gitlab" }, publication, false)).toMatch(/explicit developer confirmation/i);
    expect(mergeEligibilityError({ ...input().repository, scm: "gitlab" }, publication, true)).toBeNull();
  });

  it("adds approved deferred work to the pull-request description instead of source comments", async () => {
    const gitPublisher: GitPublisher = {
      assertPublishableCommit: vi.fn(),
      remoteCommit: vi.fn(() => null),
      pushCommit: vi.fn(),
    };
    const ado = client();

    await publishMission(ado, input({ additionalNotes: "## Deferred work\n\n- Spencer: confirm the vendor field name." }), gitPublisher);

    expect(ado.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("## Deferred work\n\n- Spencer: confirm the vendor field name."),
    }));
  });

  it("pushes the exact commit by URL while the Develop worktree remains unable to push", async () => {
    const remote = resolve(root, "remote.git");
    const repositoryPath = resolve(root, "repo");
    const worktreePath = resolve(root, ".worktrees", "develop-42");
    mkdirSync(repositoryPath);
    g(root, "init", "--bare", remote);
    g(repositoryPath, "init", "-b", "main");
    g(repositoryPath, "config", "user.email", "t@t.t");
    g(repositoryPath, "config", "user.name", "t");
    writeFileSync(resolve(repositoryPath, "base.txt"), "base\n");
    g(repositoryPath, "add", "-A");
    g(repositoryPath, "commit", "-m", "base");
    g(repositoryPath, "remote", "add", "origin", remote);
    g(repositoryPath, "push", remote, "main:main");
    mkdirSync(resolve(root, ".worktrees"));
    g(repositoryPath, "worktree", "add", "-b", "feature/arpatil/PUB-42", worktreePath, "main");
    g(worktreePath, "remote", "set-url", "--push", "origin", "DISABLED-mission-control-never-pushes");
    writeFileSync(resolve(worktreePath, "feature.txt"), "implemented\n");
    g(worktreePath, "add", "-A");
    g(worktreePath, "commit", "-m", "implementation");
    const commit = g(worktreePath, "rev-parse", "HEAD");

    const result = await publishMission(client(), input({
      repository: { ...input().repository, localPath: repositoryPath, remoteUrl: remote },
      developWorktreePath: worktreePath,
      commit,
    }));

    expect(result).toMatchObject({ push: "pushed", published: true, error: null });
    expect(g(remote, "rev-parse", "refs/heads/feature/arpatil/PUB-42")).toBe(commit);
    expect(g(worktreePath, "remote", "get-url", "--push", "origin")).toBe("DISABLED-mission-control-never-pushes");
    expect(() => g(worktreePath, "push", "origin", "HEAD")).toThrow();
  });
});
