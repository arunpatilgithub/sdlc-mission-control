import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { AzureDevOpsCli, TaskLinkError, mapPullRequestArtifactLink } = await import("./azure-devops-cli.js");

const scope = {
  organizationUrl: "https://dev.azure.com/my-org",
  project: "Development",
  team: "Publisher",
  workItemTypes: ["User Story"],
  eligibleStates: ["New"],
  includeAttachments: true,
  includeLinkedWorkItems: true,
  userStoryCompletion: "never" as const,
};

function fakeAzProcess(stdout: string, stderr: string, exitCode: number) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

describe("AzureDevOpsCli.createTask", () => {
  beforeEach(() => spawnMock.mockReset());

  it("creates a Task, links it under the parent User Story, and never sends a state-changing arg", async () => {
    const created = { id: 501, url: "https://dev.azure.com/my-org/_apis/wit/workItems/501", fields: { "System.Title": "Implement: Foo (RepoA)" } };
    spawnMock
      .mockImplementationOnce(() => fakeAzProcess(JSON.stringify(created), "", 0))
      .mockImplementationOnce(() => fakeAzProcess("", "", 0));

    const client = new AzureDevOpsCli(scope);
    const task = await client.createTask({ parentStoryId: 42, title: "Implement: Foo (RepoA)", description: "desc" });

    expect(task).toEqual({ id: 501, title: "Implement: Foo (RepoA)", url: "https://dev.azure.com/my-org/Development/_workitems/edit/501" });
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const [createCommand, createArgs] = spawnMock.mock.calls[0] as [string, string[]];
    expect(createCommand).toBe("az");
    expect(createArgs).toEqual(expect.arrayContaining(["boards", "work-item", "create", "--type", "Task", "--title", "Implement: Foo (RepoA)", "--description", "desc"]));
    expect(createArgs).not.toContain("--state");
    expect(createArgs.join(" ")).not.toMatch(/work-item update/);

    const [, linkArgs] = spawnMock.mock.calls[1] as [string, string[]];
    expect(linkArgs).toEqual(expect.arrayContaining(["boards", "work-item", "relation", "add", "--id", "501", "--relation-type", "parent", "--target-id", "42"]));
  });

  it("propagates az CLI failures instead of returning a fabricated task", async () => {
    spawnMock.mockImplementationOnce(() => fakeAzProcess("", "permission denied for this organization", 1));

    const client = new AzureDevOpsCli(scope);
    await expect(client.createTask({ parentStoryId: 1, title: "t", description: "" })).rejects.toThrow(/permission denied/);
    expect(spawnMock).toHaveBeenCalledTimes(1); // never attempts the parent-link call after a failed create
  });

  it("throws TaskLinkError carrying the created Task when only the parent link fails", async () => {
    const created = { id: 501, url: "…/501", fields: { "System.Title": "Implement: Foo (RepoA)" } };
    spawnMock
      .mockImplementationOnce(() => fakeAzProcess(JSON.stringify(created), "", 0))
      .mockImplementationOnce(() => fakeAzProcess("", "relation add failed", 1));

    const client = new AzureDevOpsCli(scope);
    // The Task exists in ADO at this point, so the error has to carry its identity out.
    await expect(client.createTask({ parentStoryId: 42, title: "Implement: Foo (RepoA)", description: "" }))
      .rejects.toBeInstanceOf(TaskLinkError);

    spawnMock.mockReset();
    spawnMock
      .mockImplementationOnce(() => fakeAzProcess(JSON.stringify(created), "", 0))
      .mockImplementationOnce(() => fakeAzProcess("", "relation add failed", 1));
    const error = await client.createTask({ parentStoryId: 42, title: "Implement: Foo (RepoA)", description: "" }).catch((e: unknown) => e);
    expect((error as InstanceType<typeof TaskLinkError>).task).toEqual({
      id: 501, title: "Implement: Foo (RepoA)", url: "https://dev.azure.com/my-org/Development/_workitems/edit/501",
    });
  });

  it("falls back to the requested title when the response omits one, rather than losing the Task", async () => {
    spawnMock
      .mockImplementationOnce(() => fakeAzProcess(JSON.stringify({ id: 777 }), "", 0))
      .mockImplementationOnce(() => fakeAzProcess("", "", 0));

    const client = new AzureDevOpsCli(scope);
    const task = await client.createTask({ parentStoryId: 42, title: "Requested title", description: "" });
    expect(task).toMatchObject({ id: 777, title: "Requested title" });
  });
});

describe("AzureDevOpsCli pull requests", () => {
  beforeEach(() => spawnMock.mockReset());

  it("finds and maps an active pull request for the exact source and target", async () => {
    spawnMock.mockImplementationOnce(() => fakeAzProcess(JSON.stringify([
      { pullRequestId: 701, title: "PUB-42: Add feature" },
    ]), "", 0));

    const pullRequest = await new AzureDevOpsCli(scope).findActivePullRequest({
      repositoryId: "MyService.API",
      sourceBranch: "feature/arpatil/PUB-42",
      targetBranch: "main",
    });

    expect(pullRequest).toEqual({
      id: 701,
      title: "PUB-42: Add feature",
      url: "https://dev.azure.com/my-org/Development/_git/MyService.API/pullrequest/701",
    });
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(expect.arrayContaining([
      "repos", "pr", "list", "--repository", "MyService.API",
      "--source-branch", "feature/arpatil/PUB-42", "--target-branch", "main", "--status", "active",
    ]));
  });

  it("creates a linked PR without transition, completion, merge, or policy-bypass flags", async () => {
    spawnMock.mockImplementationOnce(() => fakeAzProcess(JSON.stringify({
      pullRequestId: 702,
      title: "PUB-42: Add feature",
    }), "", 0));

    const pullRequest = await new AzureDevOpsCli(scope).createPullRequest({
      repositoryId: "MyService.API",
      sourceBranch: "feature/arpatil/PUB-42",
      targetBranch: "main",
      title: "PUB-42: Add feature",
      description: "Mission plan-job-42",
      workItemId: 42,
    });

    expect(pullRequest.id).toBe(702);
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(expect.arrayContaining([
      "repos", "pr", "create", "--work-items", "42", "--description", "Mission plan-job-42",
    ]));
    for (const forbidden of ["--transition-work-items", "--auto-complete", "--bypass-policy", "--delete-source-branch"]) {
      expect(args).not.toContain(forbidden);
    }
  });
});

describe("AzureDevOpsCli.getTeamBacklogItem", () => {
  beforeEach(() => spawnMock.mockReset());

  it("maps tags and retrieves normalized discussion comments", async () => {
    const item = {
      id: 42,
      fields: {
        "System.Title": "Tagged story",
        "System.State": "New",
        "System.WorkItemType": "User Story",
        "System.AreaPath": "Development\\Publisher",
        "System.Tags": " Agent ; Portal;Agent ",
      },
      relations: [{
        rel: "ArtifactLink",
        url: "vstfs:///Git/PullRequestId/project-guid%2Frepository-guid%2F65732",
        attributes: { name: "Pull Request" },
      }],
    };
    const teamFields = {
      field: { referenceName: "System.AreaPath" },
      values: [{ value: "Development\\Publisher", includeChildren: true }],
    };
    spawnMock
      .mockImplementationOnce(() => fakeAzProcess(JSON.stringify(item), "", 0))
      .mockImplementationOnce(() => fakeAzProcess(JSON.stringify(teamFields), "", 0));
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "test-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      comments: [{
        commentId: 7,
        text: "Use the clarified label.",
        createdBy: { displayName: "Reviewer" },
        createdDate: "2026-09-15T12:00:00Z",
        modifiedDate: "2026-09-15T12:01:00Z",
        isDeleted: false,
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new AzureDevOpsCli(scope);
    await expect(client.getTeamBacklogItem(42)).resolves.toMatchObject({
      tags: ["Agent", "Portal"],
      comments: [{ id: 7, author: "Reviewer", text: "Use the clarified label." }],
      pullRequestLinks: [{ projectId: "project-guid", repositoryId: "repository-guid", pullRequestId: 65732 }],
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/workItems/42/comments?"), expect.any(Object));
  });
});

describe("mapPullRequestArtifactLink", () => {
  it("parses a linked Azure DevOps pull request without accepting unrelated artifacts", () => {
    expect(mapPullRequestArtifactLink({
      rel: "ArtifactLink",
      url: "vstfs:///Git/PullRequestId/project-guid%2Frepository-guid%2F65732",
      attributes: { name: "Pull Request" },
    })).toEqual([{ projectId: "project-guid", repositoryId: "repository-guid", pullRequestId: 65732, url: "vstfs:///Git/PullRequestId/project-guid%2Frepository-guid%2F65732" }]);
    expect(mapPullRequestArtifactLink({ rel: "ArtifactLink", url: "vstfs:///Git/Commit/anything", attributes: { name: "Pull Request" } })).toEqual([]);
  });
});
