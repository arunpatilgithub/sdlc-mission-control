import type { AzureDevOpsScope } from "../config/team-config.js";

const REQUIREMENT_BACKLOG_ID = "Microsoft.RequirementCategory";
const SUMMARY_FIELDS = [
  "System.Id",
  "System.Title",
  "System.WorkItemType",
  "System.State",
  "System.AssignedTo",
  "System.AreaPath",
  "System.ChangedDate",
  "System.Tags",
];

export interface WorkItemComment {
  id: number;
  author: string;
  createdDate: string;
  modifiedDate: string | null;
  text: string;
}

export interface AzureDevOpsPullRequest {
  id: number;
  repositoryId: string;
  repositoryName: string;
  title: string;
  status: string;
  targetBranch: string;
  url: string;
}

export class AzureDevOpsRestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureDevOpsRestError";
  }
}

/**
 * Small REST adapter for endpoints whose team-specific behavior is not exposed
 * consistently by the Azure DevOps CLI. The PAT is read only at runtime from
 * AZURE_DEVOPS_EXT_PAT and is never persisted or logged.
 */
export class AzureDevOpsRest {
  constructor(
    private readonly scope: AzureDevOpsScope,
    private readonly token = process.env.AZURE_DEVOPS_EXT_PAT,
  ) {}

  async getPublisherStoryBacklogOrder(): Promise<Map<number, number>> {
    this.assertToken();
    const base = `${this.scope.organizationUrl}/${encodeURIComponent(this.scope.project)}/${encodeURIComponent(this.scope.team)}`;
    const endpoint = `${base}/_apis/work/backlogs/${REQUIREMENT_BACKLOG_ID}/workItems?api-version=7.1`;
    const response = await fetch(endpoint, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new AzureDevOpsRestError(`Azure DevOps backlog-order request failed with HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { workItems?: unknown }).workItems)) {
      throw new AzureDevOpsRestError("Azure DevOps returned an unexpected backlog-order response");
    }

    const order = new Map<number, number>();
    for (const [index, item] of (payload as { workItems: unknown[] }).workItems.entries()) {
      const target = typeof item === "object" && item !== null ? (item as { target?: unknown }).target : undefined;
      const id = typeof target === "object" && target !== null ? (target as { id?: unknown }).id : undefined;
      if (typeof id === "number" && Number.isInteger(id) && id > 0) order.set(id, index + 1);
    }
    return order;
  }

  async getWorkItemSummaries(ids: number[]): Promise<unknown[]> {
    this.assertToken();
    const batches = chunk(ids, 200);
    const results: unknown[][] = [];
    for (const batch of batches) {
      const endpoint = `${this.scope.organizationUrl}/${encodeURIComponent(this.scope.project)}/_apis/wit/workitemsbatch?api-version=7.1`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ ids: batch, fields: SUMMARY_FIELDS }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new AzureDevOpsRestError(`Azure DevOps work-item batch request failed with HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { value?: unknown }).value)) {
        throw new AzureDevOpsRestError("Azure DevOps returned an unexpected work-item batch response");
      }
      results.push((payload as { value: unknown[] }).value);
    }
    return results.flat();
  }

  async getWorkItemComments(workItemId: number): Promise<WorkItemComment[]> {
    if (!Number.isInteger(workItemId) || workItemId <= 0) throw new AzureDevOpsRestError("workItemId must be a positive integer");
    this.assertToken();
    const endpoint = `${this.scope.organizationUrl}/${encodeURIComponent(this.scope.project)}/_apis/wit/workItems/${workItemId}/comments?$top=200&order=desc&includeDeleted=false&api-version=7.1-preview.4`;
    const response = await fetch(endpoint, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new AzureDevOpsRestError(`Azure DevOps comments request failed with HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { comments?: unknown }).comments)) {
      throw new AzureDevOpsRestError("Azure DevOps returned an unexpected comments response");
    }
    return (payload as { comments: unknown[] }).comments.flatMap(mapWorkItemComment).reverse();
  }

  async getPullRequest(projectId: string, repositoryId: string, pullRequestId: number): Promise<AzureDevOpsPullRequest> {
    if (projectId.trim() === "") throw new AzureDevOpsRestError("projectId is required to retrieve an Azure DevOps pull request");
    if (repositoryId.trim() === "") throw new AzureDevOpsRestError("repositoryId is required to retrieve an Azure DevOps pull request");
    if (!Number.isInteger(pullRequestId) || pullRequestId <= 0) throw new AzureDevOpsRestError("pullRequestId must be a positive integer");
    this.assertToken();
    const endpoint = `${this.scope.organizationUrl}/${encodeURIComponent(projectId)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}?api-version=7.1`;
    const response = await fetch(endpoint, { headers: this.headers(), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new AzureDevOpsRestError(`Azure DevOps pull-request request failed with HTTP ${response.status}`);
    return mapPullRequest(await response.json());
  }

  private assertToken(): void {
    if (!this.token) throw new AzureDevOpsRestError("AZURE_DEVOPS_EXT_PAT is required to retrieve Azure DevOps backlog data");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`:${this.token}`).toString("base64")}`,
      Accept: "application/json",
    };
  }
}

function mapWorkItemComment(raw: unknown): WorkItemComment[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const comment = raw as Record<string, unknown>;
  if (comment.isDeleted === true || typeof comment.text !== "string" || typeof comment.createdDate !== "string") return [];
  const createdBy = typeof comment.createdBy === "object" && comment.createdBy !== null
    ? comment.createdBy as Record<string, unknown>
    : {};
  const rawId = comment.commentId ?? comment.id;
  return [{
    id: typeof rawId === "number" && Number.isInteger(rawId) ? rawId : 0,
    author: typeof createdBy.displayName === "string" && createdBy.displayName.trim() !== "" ? createdBy.displayName : "Unknown author",
    createdDate: comment.createdDate,
    modifiedDate: typeof comment.modifiedDate === "string" ? comment.modifiedDate : null,
    text: comment.text,
  }];
}

function mapPullRequest(raw: unknown): AzureDevOpsPullRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AzureDevOpsRestError("Azure DevOps returned an unexpected pull-request response");
  const value = raw as Record<string, unknown>;
  const repository = typeof value.repository === "object" && value.repository !== null && !Array.isArray(value.repository)
    ? value.repository as Record<string, unknown>
    : null;
  if (typeof value.pullRequestId !== "number" || !Number.isInteger(value.pullRequestId) || value.pullRequestId <= 0
    || !repository || typeof repository.id !== "string" || repository.id.trim() === "" || typeof repository.name !== "string" || repository.name.trim() === ""
    || typeof value.status !== "string" || typeof value.targetRefName !== "string") {
    throw new AzureDevOpsRestError("Azure DevOps returned an incomplete pull-request response");
  }
  return {
    id: value.pullRequestId,
    repositoryId: repository.id,
    repositoryName: repository.name,
    title: typeof value.title === "string" ? value.title : `Pull request ${value.pullRequestId}`,
    status: value.status,
    targetBranch: value.targetRefName.replace(/^refs\/heads\//, ""),
    url: typeof value.url === "string" ? value.url : "",
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}
