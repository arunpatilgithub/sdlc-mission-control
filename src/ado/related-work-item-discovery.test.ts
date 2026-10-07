import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverRelatedWorkItems, loadRelatedWorkItemDiscovery } from "./related-work-item-discovery.js";

const previousRuntimeRoot = process.env.MISSION_CONTROL_RUNTIME_ROOT;

afterEach(() => {
  if (previousRuntimeRoot === undefined) delete process.env.MISSION_CONTROL_RUNTIME_ROOT;
  else process.env.MISSION_CONTROL_RUNTIME_ROOT = previousRuntimeRoot;
});

describe("discoverRelatedWorkItems", () => {
  it("proposes only a configured repository with a completed PR into its integration branch", async () => {
    const runtime = mkdtempSync(resolve(tmpdir(), "related-work-items-"));
    process.env.MISSION_CONTROL_RUNTIME_ROOT = runtime;
    const story = {
      id: 157105, backlogOrder: 1, title: "Earlier implementation", state: "Done", workItemType: "User Story",
      assignedTo: null, areaPath: "Publisher", changedDate: null, tags: [], description: "Prior work", acceptanceCriteria: "Works",
      iterationPath: "", attachments: [], linkedWorkItems: [], comments: [], url: "https://dev.azure.com/example/157105",
    };
    const client = {
      getTeamBacklogItem: async () => story,
      getLinkedPullRequests: async () => [
        { id: 65732, repositoryId: "repo-guid", repositoryName: "MyService.API", title: "Prior", status: "completed", targetBranch: "releases", url: "https://dev.azure.com/example/pr/65732" },
        { id: 65733, repositoryId: "other", repositoryName: "Other", title: "Other", status: "active", targetBranch: "releases", url: "" },
      ],
    };
    try {
      const discovery = await discoverRelatedWorkItems(162941, [157105], [{
        id: "MyService.API", scm: "azure-devops", localPath: "/tmp/portal",
        remoteUrl: "https://dev.azure.com/example/Development/_git/MyService.API", integrationBranch: "releases",
      }], client);

      expect(discovery.proposedRepositories).toEqual([{
        repositoryId: "MyService.API", confidence: "high",
        evidence: [{ workItemId: 157105, pullRequestId: 65732, scm: "azure-devops", targetBranch: "releases", url: "https://dev.azure.com/example/pr/65732" }],
      }]);
      expect(discovery.unmappedPullRequests).toEqual([]);
      expect(loadRelatedWorkItemDiscovery(discovery.id, 162941)).toMatchObject({ id: discovery.id, relatedWorkItems: [{ id: 157105 }] });
      expect(JSON.parse(readFileSync(resolve(runtime, "related-work-item-discoveries", `${discovery.id}.json`), "utf8"))).toMatchObject({ workItemId: 162941 });
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  it("does not turn an active PR or a wrong target branch into a repository proposal", async () => {
    const story = {
      id: 159636, backlogOrder: 1, title: "Follow-up", state: "Done", workItemType: "User Story",
      assignedTo: null, areaPath: "Publisher", changedDate: null, tags: [], description: "Prior work", acceptanceCriteria: "Works",
      iterationPath: "", attachments: [], linkedWorkItems: [], comments: [], url: "",
    };
    const client = {
      getTeamBacklogItem: async () => story,
      getLinkedPullRequests: async () => [{ id: 1, repositoryId: "repo", repositoryName: "MyService.API", title: "Prior", status: "completed", targetBranch: "main", url: "" }],
    };
    const runtime = mkdtempSync(resolve(tmpdir(), "related-work-items-"));
    process.env.MISSION_CONTROL_RUNTIME_ROOT = runtime;
    try {
      const discovery = await discoverRelatedWorkItems(162941, [159636], [{
        id: "MyService.API", scm: "azure-devops", localPath: "/tmp/portal",
        remoteUrl: "https://dev.azure.com/example/Development/_git/MyService.API", integrationBranch: "releases",
      }], client);
      expect(discovery.proposedRepositories).toEqual([]);
      expect(discovery.unmappedPullRequests).toMatchObject([{ workItemId: 159636, pullRequestId: 1, reason: expect.stringContaining("integration branch") }]);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  it("discovers a configured merged GitLab MR linked from a related work item without searching GitLab", async () => {
    const runtime = mkdtempSync(resolve(tmpdir(), "related-work-items-"));
    process.env.MISSION_CONTROL_RUNTIME_ROOT = runtime;
    const gitLabUrl = "https://gitlab.com/my-company/apps/my-team/MyDownloader/-/merge_requests/22";
    const story = {
      id: 157105, backlogOrder: 1, title: "Earlier GitLab implementation", state: "Done", workItemType: "User Story",
      assignedTo: null, areaPath: "Publisher", changedDate: null, tags: [], description: `Merged implementation: ${gitLabUrl}`,
      acceptanceCriteria: "Works", iterationPath: "", attachments: [], linkedWorkItems: [], comments: [], url: "https://dev.azure.com/example/157105",
    };
    const client = { getTeamBacklogItem: async () => story, getLinkedPullRequests: async () => [] };
    const reader = vi.fn().mockResolvedValue({ id: 22, title: "Prior GitLab implementation", status: "merged", targetBranch: "main", url: gitLabUrl });
    try {
      const discovery = await discoverRelatedWorkItems(162941, [157105], [{
        id: "MyDownloader", scm: "gitlab", localPath: "/tmp/moneybadger",
        remoteUrl: "https://gitlab.com/my-company/apps/my-team/MyDownloader.git", integrationBranch: "main",
      }], client, { gitLabMergeRequestReader: reader });

      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader).toHaveBeenCalledWith(expect.objectContaining({ id: "MyDownloader" }), 22);
      expect(discovery.proposedRepositories).toEqual([{
        repositoryId: "MyDownloader", confidence: "high",
        evidence: [{ workItemId: 157105, pullRequestId: 22, scm: "gitlab", targetBranch: "main", url: gitLabUrl }],
      }]);
      expect(discovery.relatedWorkItems[0]?.gitLabMergeRequests).toEqual([{
        id: 22, repositoryPath: "my-company/apps/my-team/MyDownloader", status: "merged", targetBranch: "main", url: gitLabUrl, title: "Prior GitLab implementation",
      }]);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  it("does not call GitLab for an unconfigured merge-request URL", async () => {
    const runtime = mkdtempSync(resolve(tmpdir(), "related-work-items-"));
    process.env.MISSION_CONTROL_RUNTIME_ROOT = runtime;
    const reader = vi.fn();
    const client = { getTeamBacklogItem: vi.fn(), getLinkedPullRequests: vi.fn() };
    try {
      const discovery = await discoverRelatedWorkItems(162941, [], [], client, {
        gitLabMergeRequestUrls: ["https://gitlab.com/my-company/apps/my-team/Unknown/-/merge_requests/22"],
        gitLabMergeRequestReader: reader,
      });
      expect(reader).not.toHaveBeenCalled();
      expect(client.getTeamBacklogItem).not.toHaveBeenCalled();
      expect(discovery.proposedRepositories).toEqual([]);
      expect(discovery.unmappedPullRequests).toMatchObject([{ scm: "gitlab", repositoryName: "my-company/apps/my-team/Unknown" }]);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  it("resolves distinct configured GitLab merge requests concurrently while preserving their evidence order", async () => {
    const runtime = mkdtempSync(resolve(tmpdir(), "related-work-items-"));
    process.env.MISSION_CONTROL_RUNTIME_ROOT = runtime;
    const releases: Array<() => void> = [];
    const reader = vi.fn((_repository, id: number) => new Promise<{
      id: number; title: string; status: string; targetBranch: string; url: string;
    }>((resolveReader) => {
      releases.push(() => resolveReader({ id, title: `MR ${id}`, status: "merged", targetBranch: "main", url: `https://gitlab.com/my-company/apps/my-team/MyDownloader/-/merge_requests/${id}` }));
    }));
    const client = { getTeamBacklogItem: vi.fn(), getLinkedPullRequests: vi.fn() };
    try {
      const pending = discoverRelatedWorkItems(162941, [], [{
        id: "MyDownloader", scm: "gitlab", localPath: "/tmp/moneybadger",
        remoteUrl: "https://gitlab.com/my-company/apps/my-team/MyDownloader.git", integrationBranch: "main",
      }], client, {
        gitLabMergeRequestUrls: [22, 23, 24, 25, 26].map((id) => `https://gitlab.com/my-company/apps/my-team/MyDownloader/-/merge_requests/${id}`),
        gitLabMergeRequestReader: reader,
      });

      for (let attempt = 0; attempt < 10 && releases.length === 0; attempt += 1) await Promise.resolve();
      const callsBeforeAnyResponse = reader.mock.calls.length;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        releases.splice(0).forEach((release) => release());
        await Promise.resolve();
      }
      const discovery = await pending;

      expect(callsBeforeAnyResponse).toBe(4);
      expect(discovery.proposedRepositories[0]?.evidence.map((evidence) => evidence.pullRequestId)).toEqual([22, 23, 24, 25, 26]);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});
