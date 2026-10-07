import { spawn } from "node:child_process";
import type { AzureDevOpsScope } from "../config/team-config.js";
import { AzureDevOpsRest, AzureDevOpsRestError, type AzureDevOpsPullRequest, type WorkItemComment } from "./azure-devops-rest.js";

const AZ_TIMEOUT_MS = 30_000;

export interface TeamAreaPath {
  value: string;
  includeChildren: boolean;
}

export interface UserStorySummary {
  id: number;
  backlogOrder: number;
  title: string;
  state: string;
  workItemType: string;
  assignedTo: string | null;
  areaPath: string;
  changedDate: string | null;
  tags: string[];
}

export interface Attachment {
  name: string;
  url: string;
  comment: string | null;
}

export interface WorkItemLink {
  relation: string;
  url: string;
  title: string | null;
}

export interface PullRequestArtifactLink {
  projectId: string;
  repositoryId: string;
  pullRequestId: number;
  url: string;
}

export interface UserStory extends UserStorySummary {
  description: string;
  acceptanceCriteria: string;
  workItemType: string;
  iterationPath: string;
  attachments: Attachment[];
  linkedWorkItems: WorkItemLink[];
  pullRequestLinks?: PullRequestArtifactLink[];
  comments?: WorkItemComment[];
  url: string;
}

export interface TaskCreationRequest {
  parentStoryId: number;
  title: string;
  description: string;
}

export interface CreatedTask {
  id: number;
  title: string;
  /** Browsable ADO web URL, not the REST resource URL the CLI returns. */
  url: string;
}

export interface PullRequestCreationRequest {
  repositoryId: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  workItemId: number;
}

export interface CreatedPullRequest {
  id: number;
  title: string;
  url: string;
}

export class AzureDevOpsCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureDevOpsCliError";
  }
}

/**
 * Thrown when the Task was created in Azure DevOps but could not be linked to its
 * parent User Story. Carries the created task so callers can report the truth — an
 * orphaned Task that exists — rather than "nothing was created".
 */
export class TaskLinkError extends AzureDevOpsCliError {
  constructor(readonly task: CreatedTask, message: string) {
    super(message);
    this.name = "TaskLinkError";
  }
}

export class AzureDevOpsCli {
  constructor(private readonly scope: AzureDevOpsScope) {}

  /**
   * Creates a Task work item and links it as a child of the given User Story.
   * This is the only write path in this class — it never transitions the User
   * Story's own state, matching the `userStoryCompletion: "never"` contract in
   * team-config.schema.json.
   */
  async createTask(request: TaskCreationRequest): Promise<CreatedTask> {
    assertPositiveInteger(request.parentStoryId, "parent story id");
    const title = nonEmptyString(request.title, "task title");
    const description = typeof request.description === "string" ? request.description : "";

    const created = await this.runJson([
      "boards", "work-item", "create",
      "--org", this.scope.organizationUrl,
      "--project", this.scope.project,
      "--type", "Task",
      "--title", title,
      "--description", description,
    ]);
    // Past this point a Task exists in Azure DevOps, so every failure has to carry
    // its identity out rather than surfacing as a plain error.
    const task = mapCreatedTask(created, this.scope, title);

    try {
      await runAz([
        "boards", "work-item", "relation", "add",
        "--org", this.scope.organizationUrl,
        "--id", String(task.id),
        "--relation-type", "parent",
        "--target-id", String(request.parentStoryId),
        "--output", "none",
      ]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TaskLinkError(task, `Task ${task.id} was created but could not be linked to User Story ${request.parentStoryId}: ${detail}`);
    }

    return task;
  }

  async findActivePullRequest(request: Pick<PullRequestCreationRequest, "repositoryId" | "sourceBranch" | "targetBranch">): Promise<CreatedPullRequest | null> {
    const repositoryId = nonEmptyString(request.repositoryId, "repository id");
    const sourceBranch = nonEmptyString(request.sourceBranch, "source branch");
    const targetBranch = nonEmptyString(request.targetBranch, "target branch");
    const raw = await this.runJson([
      "repos", "pr", "list",
      "--org", this.scope.organizationUrl,
      "--project", this.scope.project,
      "--repository", repositoryId,
      "--source-branch", sourceBranch,
      "--target-branch", targetBranch,
      "--status", "active",
    ]);
    if (!Array.isArray(raw)) throw new AzureDevOpsCliError("Azure DevOps pull-request list response must be an array");
    return raw.length === 0 ? null : mapCreatedPullRequest(raw[0], this.scope, repositoryId, "Existing pull request");
  }

  async createPullRequest(request: PullRequestCreationRequest): Promise<CreatedPullRequest> {
    const repositoryId = nonEmptyString(request.repositoryId, "repository id");
    const sourceBranch = nonEmptyString(request.sourceBranch, "source branch");
    const targetBranch = nonEmptyString(request.targetBranch, "target branch");
    const title = nonEmptyString(request.title, "pull-request title");
    assertPositiveInteger(request.workItemId, "work item id");
    const raw = await this.runJson([
      "repos", "pr", "create",
      "--org", this.scope.organizationUrl,
      "--project", this.scope.project,
      "--repository", repositoryId,
      "--source-branch", sourceBranch,
      "--target-branch", targetBranch,
      "--title", title,
      "--description", request.description,
      "--work-items", String(request.workItemId),
    ]);
    return mapCreatedPullRequest(raw, this.scope, repositoryId, title);
  }

  async checkConnection(): Promise<TeamAreaPath[]> {
    return this.getTeamAreaPaths();
  }

  async listTeamBacklogItems(limit = 1_000): Promise<UserStorySummary[]> {
    assertPositiveInteger(limit, "limit");
    let backlogOrder: Map<number, number>;
    let raw: unknown[];
    try {
      const rest = new AzureDevOpsRest(this.scope);
      backlogOrder = await rest.getPublisherStoryBacklogOrder();
      raw = await rest.getWorkItemSummaries([...backlogOrder.keys()]);
    } catch (error) {
      const message = error instanceof AzureDevOpsRestError || error instanceof Error ? error.message : String(error);
      throw new AzureDevOpsCliError(message);
    }

    const summaries = raw.map(mapStorySummary).filter((item) => item.workItemType === "User Story" || item.workItemType === "Spike");

    const byId = new Map(summaries.map((story) => [story.id, story]));
    return [...backlogOrder.entries()]
      .flatMap(([id, order]) => {
        const story = byId.get(id);
        return story ? [{ ...story, backlogOrder: order }] : [];
      })
      .slice(0, limit);
  }

  async getTeamBacklogItem(id: number): Promise<UserStory> {
    assertPositiveInteger(id, "work item id");
    const raw = await this.runJson([
      "boards", "work-item", "show",
      "--org", this.scope.organizationUrl,
      "--id", String(id),
      "--expand", "relations",
    ]);
    const story = mapUserStory(raw);
    const areaPaths = await this.getTeamAreaPaths();
    this.assertTeamBacklogItem(story, areaPaths);
    try {
      const comments = await new AzureDevOpsRest(this.scope).getWorkItemComments(id);
      return { ...story, comments };
    } catch (error) {
      const message = error instanceof AzureDevOpsRestError || error instanceof Error ? error.message : String(error);
      throw new AzureDevOpsCliError(message);
    }
  }

  async getLinkedPullRequests(story: UserStory): Promise<AzureDevOpsPullRequest[]> {
    const links = uniquePullRequestLinks(story.pullRequestLinks ?? []);
    const rest = new AzureDevOpsRest(this.scope);
    return Promise.all(links.map((link) => rest.getPullRequest(link.projectId, link.repositoryId, link.pullRequestId)));
  }

  async getTeamAreaPaths(): Promise<TeamAreaPath[]> {
    const raw = await this.runJson([
      "devops", "invoke",
      "--org", this.scope.organizationUrl,
      "--area", "work",
      "--resource", "teamfieldvalues",
      "--route-parameters", `project=${this.scope.project}`, `team=${this.scope.team}`,
      "--api-version", "7.1",
    ]);
    const response = object(raw, "Azure DevOps team-field-values response");
    const field = object(response.field, "Azure DevOps team-field-values field");
    if (field.referenceName !== "System.AreaPath") {
      throw new AzureDevOpsCliError("Publisher team scope is not configured with System.AreaPath");
    }
    if (!Array.isArray(response.values) || response.values.length === 0) {
      throw new AzureDevOpsCliError("Publisher team has no configured area paths");
    }

    return response.values.map((value, index) => {
      const entry = object(value, `Azure DevOps team area path ${index}`);
      return {
        value: nonEmptyString(entry.value, `Azure DevOps team area path ${index}.value`),
        includeChildren: entry.includeChildren === true,
      };
    });
  }

  private assertTeamBacklogItem(story: UserStory, areaPaths: TeamAreaPath[]): void {
    if (story.workItemType !== "User Story" && story.workItemType !== "Spike") {
      throw new AzureDevOpsCliError(`Work item ${story.id} is not a supported Publisher backlog item`);
    }
    const isInTeamArea = areaPaths.some((area) => story.areaPath === area.value || (area.includeChildren && story.areaPath.startsWith(`${area.value}\\`)));
    if (!isInTeamArea) {
      throw new AzureDevOpsCliError(`User Story ${story.id} is outside the configured Publisher team area`);
    }
  }

  private async runJson(command: string[]): Promise<unknown> {
    const args = [...command, "--output", "json", "--only-show-errors"];
    const { stdout } = await runAz(args);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new AzureDevOpsCliError("Azure DevOps CLI returned invalid JSON");
    }
  }
}

function runAz(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("az", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, AZ_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new AzureDevOpsCliError(`Unable to start Azure DevOps CLI: ${error.message}`));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new AzureDevOpsCliError(`Azure DevOps CLI timed out after ${AZ_TIMEOUT_MS / 1000} seconds`));
      } else if (exitCode !== 0) {
        reject(new AzureDevOpsCliError(`Azure DevOps CLI failed: ${(stderr || stdout).trim()}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function mapStorySummary(raw: unknown): UserStorySummary {
  const item = object(raw, "Azure DevOps User Story summary");
  const fields = object(item.fields, "Azure DevOps User Story summary fields");
  return {
    id: number(item.id, "Azure DevOps User Story id"),
    backlogOrder: 0,
    title: nonEmptyString(fields["System.Title"], "Azure DevOps User Story title"),
    state: nonEmptyString(fields["System.State"], "Azure DevOps User Story state"),
    workItemType: nonEmptyString(fields["System.WorkItemType"], "Azure DevOps User Story work-item type"),
    assignedTo: displayName(fields["System.AssignedTo"]),
    areaPath: nonEmptyString(fields["System.AreaPath"], "Azure DevOps User Story area path"),
    changedDate: optionalString(fields["System.ChangedDate"]),
    tags: workItemTags(fields["System.Tags"]),
  };
}

function mapUserStory(raw: unknown): UserStory {
  const item = object(raw, "Azure DevOps User Story");
  const fields = object(item.fields, "Azure DevOps User Story fields");
  const summary = mapStorySummary(raw);
  const relations = Array.isArray(item.relations) ? item.relations : [];

  return {
    ...summary,
    description: optionalString(fields["System.Description"]) ?? "",
    acceptanceCriteria: optionalString(fields["Microsoft.VSTS.Common.AcceptanceCriteria"]) ?? "",
    workItemType: nonEmptyString(fields["System.WorkItemType"], "Azure DevOps User Story work-item type"),
    iterationPath: optionalString(fields["System.IterationPath"]) ?? "",
    attachments: relations.flatMap(mapAttachment),
    linkedWorkItems: relations.flatMap(mapWorkItemLink),
    pullRequestLinks: relations.flatMap(mapPullRequestArtifactLink),
    comments: [],
    url: optionalString(item.url) ?? "",
  };
}

function workItemTags(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(";").map((tag) => tag.trim()).filter(Boolean))];
}

/**
 * The id is the only field worth failing over: it's what makes a created Task
 * findable. The echoed title is treated as optional and falls back to the requested
 * one, so an unexpected response shape can't turn a real Task into a lost Task.
 */
function mapCreatedTask(raw: unknown, scope: AzureDevOpsScope, requestedTitle: string): CreatedTask {
  const item = object(raw, "Azure DevOps Task creation response");
  const id = number(item.id, "Azure DevOps Task id");
  const fields = typeof item.fields === "object" && item.fields !== null ? item.fields as Record<string, unknown> : {};
  const echoedTitle = fields["System.Title"];
  return {
    id,
    title: typeof echoedTitle === "string" && echoedTitle.trim() !== "" ? echoedTitle : requestedTitle,
    url: `${scope.organizationUrl}/${encodeURIComponent(scope.project)}/_workitems/edit/${id}`,
  };
}

function mapCreatedPullRequest(raw: unknown, scope: AzureDevOpsScope, repositoryId: string, requestedTitle: string): CreatedPullRequest {
  const item = object(raw, "Azure DevOps pull-request response");
  const id = number(item.pullRequestId, "Azure DevOps pull-request id");
  const echoedTitle = item.title;
  return {
    id,
    title: typeof echoedTitle === "string" && echoedTitle.trim() !== "" ? echoedTitle : requestedTitle,
    url: `${scope.organizationUrl}/${encodeURIComponent(scope.project)}/_git/${encodeURIComponent(repositoryId)}/pullrequest/${id}`,
  };
}

function mapAttachment(raw: unknown): Attachment[] {
  const relation = object(raw, "Azure DevOps relation");
  if (relation.rel !== "AttachedFile") return [];
  const attributes = object(relation.attributes, "Azure DevOps attachment attributes");
  return [{
    name: nonEmptyString(attributes.name, "Azure DevOps attachment name"),
    url: nonEmptyString(relation.url, "Azure DevOps attachment URL"),
    comment: optionalString(attributes.comment),
  }];
}

function mapWorkItemLink(raw: unknown): WorkItemLink[] {
  const relation = object(raw, "Azure DevOps relation");
  if (relation.rel === "AttachedFile" || typeof relation.url !== "string" || !relation.url.includes("/workItems/")) return [];
  const attributes = typeof relation.attributes === "object" && relation.attributes !== null ? relation.attributes as Record<string, unknown> : {};
  return [{
    relation: nonEmptyString(relation.rel, "Azure DevOps linked work-item relation"),
    url: relation.url,
    title: optionalString(attributes.name),
  }];
}

export function mapPullRequestArtifactLink(raw: unknown): PullRequestArtifactLink[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const relation = raw as Record<string, unknown>;
  if (relation.rel !== "ArtifactLink" || typeof relation.url !== "string") return [];
  const attributes = typeof relation.attributes === "object" && relation.attributes !== null ? relation.attributes as Record<string, unknown> : {};
  if (attributes.name !== "Pull Request") return [];
  const decoded = safeDecode(relation.url);
  const marker = "/PullRequestId/";
  const index = decoded.lastIndexOf(marker);
  if (index < 0) return [];
  const parts = decoded.slice(index + marker.length).split("/");
  const projectId = parts.at(-3)?.trim() ?? "";
  const repositoryId = parts.at(-2)?.trim() ?? "";
  const pullRequestId = Number(parts.at(-1));
  if (projectId === "" || repositoryId === "" || !Number.isInteger(pullRequestId) || pullRequestId <= 0) return [];
  return [{ projectId, repositoryId, pullRequestId, url: relation.url }];
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function uniquePullRequestLinks(links: PullRequestArtifactLink[]): PullRequestArtifactLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.projectId}:${link.repositoryId}:${link.pullRequestId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AzureDevOpsCliError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new AzureDevOpsCliError(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "displayName" in value && typeof value.displayName === "string") return value.displayName;
  return null;
}

function displayName(value: unknown): string | null {
  return optionalString(value);
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new AzureDevOpsCliError(`${name} must be a positive integer`);
  return value;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new AzureDevOpsCliError(`${name} must be a positive integer`);
}
