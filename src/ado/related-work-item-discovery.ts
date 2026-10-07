import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AzureDevOpsCli, UserStory } from "./azure-devops-cli.js";
import type { AzureDevOpsPullRequest, WorkItemComment } from "./azure-devops-rest.js";
import type { RepositoryConfig } from "../config/team-config.js";

export type GitLabMergeRequestReference = {
  id: number;
  title: string;
  repositoryPath: string;
  status: string;
  targetBranch: string;
  url: string;
};

export type GitLabMergeRequestReader = (repository: RepositoryConfig, mergeRequestId: number) => Promise<Omit<GitLabMergeRequestReference, "repositoryPath">>;

export type RelatedWorkItemDiscoveryOptions = {
  gitLabMergeRequestUrls?: unknown;
  gitLabMergeRequestReader?: GitLabMergeRequestReader;
};

export type RelatedWorkItemContext = {
  id: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: WorkItemComment[];
  url: string;
  gitLabMergeRequests: GitLabMergeRequestReference[];
  pullRequests: Array<{
    id: number;
    repositoryName: string;
    status: string;
    targetBranch: string;
    url: string;
  }>;
};

export type DiscoveredRepository = {
  repositoryId: string;
  confidence: "high";
  evidence: Array<{
    workItemId: number;
    pullRequestId: number;
    scm: "azure-devops" | "gitlab";
    targetBranch: string;
    url: string;
  }>;
};

export type UnmappedPullRequest = {
  workItemId: number;
  pullRequestId: number;
  scm: "azure-devops" | "gitlab";
  repositoryName: string;
  targetBranch: string;
  reason: string;
};

export type RelatedWorkItemDiscovery = {
  id: string;
  workItemId: number;
  createdAt: string;
  relatedWorkItems: RelatedWorkItemContext[];
  proposedRepositories: DiscoveredRepository[];
  unmappedPullRequests: UnmappedPullRequest[];
};

type RelatedWorkItemClient = Pick<AzureDevOpsCli, "getTeamBacklogItem" | "getLinkedPullRequests">;

export async function discoverRelatedWorkItems(
  workItemId: number,
  rawRelatedWorkItemIds: unknown,
  repositories: RepositoryConfig[],
  client: RelatedWorkItemClient,
  options: RelatedWorkItemDiscoveryOptions = {},
): Promise<RelatedWorkItemDiscovery> {
  const ids = optionalRelatedWorkItemIds(rawRelatedWorkItemIds, workItemId);
  const suppliedGitLabUrls = gitLabMergeRequestUrls(options.gitLabMergeRequestUrls);
  if (ids.length === 0 && suppliedGitLabUrls.length === 0) {
    throw new Error("Provide at least one related Azure DevOps work-item ID or GitLab merge-request URL");
  }
  const stories = await Promise.all(ids.map((id) => client.getTeamBacklogItem(id)));
  const relatedWorkItems = await Promise.all(stories.map(async (story) => {
    const pullRequests = await client.getLinkedPullRequests(story);
    return relatedContext(story, pullRequests, []);
  }));
  const proposed = new Map<string, DiscoveredRepository>();
  const unmappedPullRequests: UnmappedPullRequest[] = [];
  for (const context of relatedWorkItems) {
    for (const pullRequest of context.pullRequests) {
      if (pullRequest.status.toLowerCase() !== "completed") continue;
      const repository = configuredRepository(pullRequest, repositories);
      if (!repository) {
        unmappedPullRequests.push({
          workItemId: context.id, pullRequestId: pullRequest.id, repositoryName: pullRequest.repositoryName,
          scm: "azure-devops", targetBranch: pullRequest.targetBranch, reason: "No configured Azure DevOps repository has this repository name and integration branch",
        });
        continue;
      }
      const existing = proposed.get(repository.id) ?? { repositoryId: repository.id, confidence: "high" as const, evidence: [] };
      existing.evidence.push({ workItemId: context.id, pullRequestId: pullRequest.id, scm: "azure-devops", targetBranch: pullRequest.targetBranch, url: pullRequest.url });
      proposed.set(repository.id, existing);
    }
  }
  const gitLabReferences = [
    ...suppliedGitLabUrls.map((reference) => ({ ...reference, workItemId })),
    ...stories.flatMap((story) => gitLabMergeRequestUrlsFromStory(story).map((reference) => ({ ...reference, workItemId: story.id }))),
  ];
  const resolvedGitLabReferences = await resolveGitLabMergeRequests(
    [...new Map(gitLabReferences.map((reference) => [`${reference.workItemId}:${reference.url}`, reference])).values()],
    repositories, options.gitLabMergeRequestReader, unmappedPullRequests,
  );
  for (const resolved of resolvedGitLabReferences) {
    const context = relatedWorkItems.find((candidate) => candidate.id === resolved.workItemId);
    if (context && !context.gitLabMergeRequests.some((candidate) => candidate.url === resolved.mergeRequest.url)) {
      context.gitLabMergeRequests.push(resolved.mergeRequest);
    }
    if (resolved.mergeRequest.status.toLowerCase() !== "merged" || resolved.repository.integrationBranch !== resolved.mergeRequest.targetBranch) continue;
    const existing = proposed.get(resolved.repository.id) ?? { repositoryId: resolved.repository.id, confidence: "high" as const, evidence: [] };
    existing.evidence.push({
      workItemId: resolved.workItemId, pullRequestId: resolved.mergeRequest.id, scm: "gitlab",
      targetBranch: resolved.mergeRequest.targetBranch, url: resolved.mergeRequest.url,
    });
    proposed.set(resolved.repository.id, existing);
  }
  const discovery: RelatedWorkItemDiscovery = {
    id: randomUUID(), workItemId, createdAt: new Date().toISOString(), relatedWorkItems,
    proposedRepositories: [...proposed.values()], unmappedPullRequests,
  };
  persistDiscovery(discovery);
  return discovery;
}

export function loadRelatedWorkItemDiscovery(id: string, workItemId: number): RelatedWorkItemDiscovery {
  if (!/^[\w-]+$/.test(id)) throw new Error("Invalid related work-item discovery id");
  const path = resolve(discoveryDirectory(), `${id}.json`);
  if (!existsSync(path)) throw new Error("Related work-item discovery was not found");
  const discovery = JSON.parse(readFileSync(path, "utf8")) as RelatedWorkItemDiscovery;
  if (discovery.workItemId !== workItemId) throw new Error("Related work-item discovery belongs to a different work item");
  return discovery;
}

export function relatedWorkItemIds(raw: unknown, currentWorkItemId: number): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) throw new Error("Provide between one and ten related Azure DevOps work-item IDs");
  const ids = raw.map((value) => typeof value === "number" ? value : Number(value));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error("Related Azure DevOps work-item IDs must be positive integers");
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw new Error("Related Azure DevOps work-item IDs must be unique");
  if (unique.includes(currentWorkItemId)) throw new Error("The current work item cannot also be a related work item");
  return unique;
}

function optionalRelatedWorkItemIds(raw: unknown, currentWorkItemId: number): number[] {
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) return [];
  return relatedWorkItemIds(raw, currentWorkItemId);
}

function relatedContext(story: UserStory, pullRequests: AzureDevOpsPullRequest[], gitLabMergeRequests: GitLabMergeRequestReference[]): RelatedWorkItemContext {
  return {
    id: story.id, title: story.title, description: story.description, acceptanceCriteria: story.acceptanceCriteria,
    comments: story.comments ?? [], url: story.url,
    gitLabMergeRequests,
    pullRequests: pullRequests.map((pullRequest) => ({
      id: pullRequest.id, repositoryName: pullRequest.repositoryName, status: pullRequest.status,
      targetBranch: pullRequest.targetBranch, url: pullRequest.url,
    })),
  };
}

type GitLabMergeRequestUrl = {
  host: string;
  repositoryPath: string;
  id: number;
  url: string;
};

type GitLabMergeRequestCandidate = GitLabMergeRequestUrl & { workItemId: number };

const MAX_CONCURRENT_GITLAB_MERGE_REQUEST_LOOKUPS = 4;

type ResolvedGitLabMergeRequest = {
  repository: RepositoryConfig;
  mergeRequest: GitLabMergeRequestReference;
};

async function resolveGitLabMergeRequests(
  candidates: GitLabMergeRequestCandidate[],
  repositories: RepositoryConfig[],
  reader: GitLabMergeRequestReader | undefined,
  unmappedPullRequests: UnmappedPullRequest[],
): Promise<Array<{ workItemId: number; repository: RepositoryConfig; mergeRequest: GitLabMergeRequestReference }>> {
  const configured = candidates.flatMap((candidate) => {
    const repository = configuredGitLabRepository(candidate, repositories);
    if (repository) return [{ candidate, repository }];
    unmappedPullRequests.push({
      workItemId: candidate.workItemId, pullRequestId: candidate.id, scm: "gitlab", repositoryName: candidate.repositoryPath,
      targetBranch: "unknown", reason: "No configured GitLab repository matches this merge-request URL",
    });
    return [];
  });
  if (configured.length === 0) return [];
  if (!reader) throw new Error("GitLab merge-request discovery is not configured");
  const uniqueLookups = new Map<string, { candidate: GitLabMergeRequestCandidate; repository: RepositoryConfig }>();
  for (const item of configured) {
    const key = `${item.repository.id}:${item.candidate.id}`;
    if (!uniqueLookups.has(key)) uniqueLookups.set(key, item);
  }
  const resolved = new Map(await mapWithConcurrency([...uniqueLookups.entries()], MAX_CONCURRENT_GITLAB_MERGE_REQUEST_LOOKUPS, async ([key, item]): Promise<[string, ResolvedGitLabMergeRequest]> => {
    const detail = await reader(item.repository, item.candidate.id);
    return [key, {
      repository: item.repository,
      mergeRequest: { ...detail, repositoryPath: item.candidate.repositoryPath },
    }];
  }));
  const results: Array<{ workItemId: number; repository: RepositoryConfig; mergeRequest: GitLabMergeRequestReference }> = [];
  for (const { candidate, repository } of configured) {
    const found = resolved.get(`${repository.id}:${candidate.id}`)!;
    if (found.mergeRequest.status.toLowerCase() !== "merged" || repository.integrationBranch !== found.mergeRequest.targetBranch) {
      unmappedPullRequests.push({
        workItemId: candidate.workItemId, pullRequestId: found.mergeRequest.id, scm: "gitlab", repositoryName: candidate.repositoryPath,
        targetBranch: found.mergeRequest.targetBranch,
        reason: found.mergeRequest.status.toLowerCase() !== "merged"
          ? "GitLab merge request is not merged"
          : "GitLab merge request does not target the configured integration branch",
      });
      continue;
    }
    results.push({ workItemId: candidate.workItemId, ...found });
  }
  return results;
}

async function mapWithConcurrency<T, U>(values: T[], limit: number, mapper: (value: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function gitLabMergeRequestUrlsFromStory(story: UserStory): GitLabMergeRequestUrl[] {
  return gitLabMergeRequestUrls([
    story.description,
    story.acceptanceCriteria,
    story.url,
    ...(story.comments ?? []).map((comment) => comment.text),
    ...story.attachments.flatMap((attachment) => [attachment.url, attachment.comment ?? ""]),
    ...story.linkedWorkItems.flatMap((link) => [link.url, link.title ?? ""]),
  ]);
}

function gitLabMergeRequestUrls(raw: unknown): GitLabMergeRequestUrl[] {
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const urls = values.flatMap((value) => typeof value === "string" ? gitLabMergeRequestUrlsIn(value) : []);
  const unique = new Map(urls.map((url) => [url.url, url]));
  return [...unique.values()];
}

function gitLabMergeRequestUrlsIn(value: string): GitLabMergeRequestUrl[] {
  const matches = value.match(/https:\/\/[a-z0-9.-]+\/[^\s<>"')]+\/-\/merge_requests\/\d+(?:[?#][^\s<>"')]+)?/gi) ?? [];
  return matches.flatMap(parseGitLabMergeRequestUrl);
}

function parseGitLabMergeRequestUrl(value: string): GitLabMergeRequestUrl[] {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return [];
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const separator = segments.lastIndexOf("-");
    if (separator < 1 || segments[separator + 1] !== "merge_requests" || !/^\d+$/.test(segments[separator + 2] ?? "") || separator + 3 !== segments.length) return [];
    const id = Number(segments[separator + 2]);
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    return [{ host: url.hostname.toLowerCase(), repositoryPath: segments.slice(0, separator).join("/"), id, url: url.toString() }];
  } catch {
    return [];
  }
}

function configuredRepository(pullRequest: RelatedWorkItemContext["pullRequests"][number], repositories: RepositoryConfig[]): RepositoryConfig | null {
  return repositories.find((repository) => repository.scm === "azure-devops"
    && repositoryName(repository.remoteUrl) === pullRequest.repositoryName.toLowerCase()
    && repository.integrationBranch === pullRequest.targetBranch) ?? null;
}

function configuredGitLabRepository(reference: GitLabMergeRequestUrl, repositories: RepositoryConfig[]): RepositoryConfig | null {
  return repositories.find((repository) => {
    const identity = repository.scm === "gitlab" ? gitLabRepositoryIdentity(repository.remoteUrl) : null;
    return identity?.host === reference.host && identity.project === reference.repositoryPath.toLowerCase();
  }) ?? null;
}

function repositoryName(remoteUrl: string): string {
  const marker = "_git/";
  const index = remoteUrl.toLowerCase().lastIndexOf(marker);
  return index < 0 ? "" : decodeURIComponent(remoteUrl.slice(index + marker.length)).replace(/\.git$/, "").toLowerCase();
}

function gitLabRepositoryIdentity(remoteUrl: string): { host: string; project: string } | null {
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== "https:") return null;
    return {
      host: url.hostname.toLowerCase(),
      project: url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").map(decodeURIComponent).join("/").toLowerCase(),
    };
  } catch {
    return null;
  }
}

function persistDiscovery(discovery: RelatedWorkItemDiscovery): void {
  const directory = discoveryDirectory();
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `${discovery.id}.json`), `${JSON.stringify(discovery, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function discoveryDirectory(): string {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  const root = configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
  return resolve(root, "related-work-item-discoveries");
}
