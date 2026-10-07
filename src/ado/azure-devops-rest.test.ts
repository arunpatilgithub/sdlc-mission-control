import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureDevOpsRest } from "./azure-devops-rest.js";

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

afterEach(() => vi.unstubAllEnvs());

describe("AzureDevOpsRest.getPullRequest", () => {
  it("uses the project GUID carried by the work-item PR artifact", async () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "test-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      pullRequestId: 65732,
      title: "Prior implementation",
      status: "completed",
      targetRefName: "refs/heads/releases",
      repository: { id: "repository-guid", name: "MyService.API" },
      url: "https://dev.azure.com/my-org/project-guid/_apis/git/pullRequests/65732",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AzureDevOpsRest(scope).getPullRequest("project-guid", "repository-guid", 65732)).resolves.toMatchObject({
      id: 65732, repositoryName: "MyService.API", targetBranch: "releases",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/project-guid/_apis/git/repositories/repository-guid/pullRequests/65732");
  });
});
