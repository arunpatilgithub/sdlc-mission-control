import { describe, expect, it, vi } from "vitest";
import { GitLabCli, GitLabCliError } from "./gitlab-cli.js";

const mergeRequest = { iid: 42, title: "PUB-42: Add feature", web_url: "https://gitlab.com/group/project/-/merge_requests/42" };

describe("GitLabCli", () => {
  it("finds an opened merge request using the encoded project path and branch filters", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify([mergeRequest]));
    const client = new GitLabCli("https://gitlab.com/group/subgroup/project.git", run);

    await expect(client.findActivePullRequest({ repositoryId: "project", sourceBranch: "feature/arpatil/PUB-42", targetBranch: "main" }))
      .resolves.toEqual({ id: 42, title: "PUB-42: Add feature", url: mergeRequest.web_url });
    expect(run).toHaveBeenCalledWith(expect.arrayContaining([
      "api",
      "--hostname",
      "gitlab.com",
      "projects/group%2Fsubgroup%2Fproject/merge_requests?state=opened&source_branch=feature%2Farpatil%2FPUB-42&target_branch=main",
    ]));
  });

  it("creates a merge request without interpolating request fields into a shell", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify(mergeRequest));
    const client = new GitLabCli("https://gitlab.com/group/project.git", run);

    await expect(client.createPullRequest({
      repositoryId: "project",
      sourceBranch: "feature/arpatil/PUB-42",
      targetBranch: "main",
      title: "PUB-42: Add feature",
      description: "Reviewed commit",
      workItemId: 42,
    })).resolves.toEqual({ id: 42, title: "PUB-42: Add feature", url: mergeRequest.web_url });
    expect(run).toHaveBeenCalledWith(expect.arrayContaining([
      "--method",
      "POST",
      "--raw-field",
      "source_branch=feature/arpatil/PUB-42",
      "target_branch=main",
      "title=PUB-42: Add feature",
      "description=Reviewed commit",
      "projects/group%2Fproject/merge_requests",
    ]));
  });

  it("merges only when GitLab confirms the merge request state", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({ ...mergeRequest, state: "merged" }));
    const client = new GitLabCli("https://gitlab.com/group/project.git", run);

    await expect(client.mergePullRequest(42)).resolves.toEqual({ id: 42, title: "PUB-42: Add feature", url: mergeRequest.web_url });
    expect(run).toHaveBeenCalledWith(expect.arrayContaining([
      "--method",
      "PUT",
      "--field",
      "merge_when_pipeline_succeeds=false",
      "should_remove_source_branch=false",
      "projects/group%2Fproject/merge_requests/42/merge",
    ]));
  });

  it("reads a merge request without issuing a write method", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({ ...mergeRequest, state: "merged", target_branch: "main" }));
    const client = new GitLabCli("https://gitlab.com/group/project.git", run);

    await expect(client.getMergeRequest(42)).resolves.toEqual({
      id: 42, title: "PUB-42: Add feature", status: "merged", targetBranch: "main", url: mergeRequest.web_url,
    });
    expect(run).toHaveBeenCalledWith(expect.arrayContaining([
      "api",
      "--hostname",
      "gitlab.com",
      "projects/group%2Fproject/merge_requests/42",
    ]));
    expect(run.mock.calls[0]![0]).not.toContain("--method");
  });

  it("fails closed for a malformed remote or an unmerged response", async () => {
    expect(() => new GitLabCli("git@gitlab.com:group/project.git")).toThrow(GitLabCliError);
    const client = new GitLabCli("https://gitlab.com/group/project.git", vi.fn().mockResolvedValue(JSON.stringify({ ...mergeRequest, state: "opened" })));
    await expect(client.mergePullRequest(42)).rejects.toThrow(/was not merged/);
  });
});
