import { spawn } from "node:child_process";
import type { CreatedPullRequest, PullRequestCreationRequest } from "../ado/azure-devops-cli.js";
import type { MergeRequestPublisher, PullRequestPublisher } from "../agent/mission-publish.js";

const GLAB_TIMEOUT_MS = 30_000;

interface GitLabMergeRequest {
  iid: number;
  title: string;
  web_url: string;
}

export type GitLabMergeRequestDetails = {
  id: number;
  title: string;
  status: string;
  targetBranch: string;
  url: string;
};

export class GitLabCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitLabCliError";
  }
}

export class GitLabCli implements PullRequestPublisher, MergeRequestPublisher {
  private readonly host: string;
  private readonly project: string;

  constructor(remoteUrl: string, private readonly run: (args: string[]) => Promise<string> = runGlab) {
    const parsed = projectFromRemote(remoteUrl);
    this.host = parsed.host;
    this.project = parsed.project;
  }

  async findActivePullRequest(request: Pick<PullRequestCreationRequest, "repositoryId" | "sourceBranch" | "targetBranch">): Promise<CreatedPullRequest | null> {
    const query = new URLSearchParams({ state: "opened", source_branch: request.sourceBranch, target_branch: request.targetBranch });
    const raw = await this.api(`merge_requests?${query.toString()}`);
    if (!Array.isArray(raw)) throw new GitLabCliError("GitLab merge-request list response must be an array");
    return raw.length === 0 ? null : mapMergeRequest(raw[0], "Existing merge request");
  }

  async getMergeRequest(id: number): Promise<GitLabMergeRequestDetails> {
    if (!Number.isInteger(id) || id <= 0) throw new GitLabCliError("GitLab merge-request id must be a positive integer");
    return mapMergeRequestDetails(await this.api(`merge_requests/${id}`));
  }

  async createPullRequest(request: PullRequestCreationRequest): Promise<CreatedPullRequest> {
    const raw = await this.api("merge_requests", [
      "--method", "POST",
      "--raw-field", `source_branch=${request.sourceBranch}`,
      "--raw-field", `target_branch=${request.targetBranch}`,
      "--raw-field", `title=${request.title}`,
      "--raw-field", `description=${request.description}`,
    ]);
    return mapMergeRequest(raw, request.title);
  }

  async mergePullRequest(id: number): Promise<CreatedPullRequest> {
    if (!Number.isInteger(id) || id <= 0) throw new GitLabCliError("GitLab merge-request id must be a positive integer");
    const raw = await this.api(`merge_requests/${id}/merge`, [
      "--method", "PUT",
      "--field", "merge_when_pipeline_succeeds=false",
      "--field", "should_remove_source_branch=false",
    ]);
    if (!isRecord(raw) || raw.state !== "merged") throw new GitLabCliError(`GitLab merge request !${id} was not merged`);
    return mapMergeRequest(raw, `Merge request !${id}`);
  }

  private async api(path: string, extra: string[] = []): Promise<unknown> {
    const output = await this.run([
      "api",
      "--hostname", this.host,
      ...extra,
      `projects/${encodeURIComponent(this.project)}/${path}`,
    ]);
    try {
      return JSON.parse(output);
    } catch {
      throw new GitLabCliError("GitLab CLI returned invalid JSON");
    }
  }
}

function projectFromRemote(remoteUrl: string): { host: string; project: string } {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    throw new GitLabCliError("GitLab repository remote must be an HTTPS URL");
  }
  if (url.protocol !== "https:" || url.hostname === "") throw new GitLabCliError("GitLab repository remote must be an HTTPS URL");
  const project = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (project.split("/").length < 2) throw new GitLabCliError("GitLab repository remote must include a namespace and project");
  return { host: url.hostname, project };
}

function mapMergeRequest(raw: unknown, fallbackTitle: string): CreatedPullRequest {
  if (!isRecord(raw) || !isPositiveInteger(raw.iid) || typeof raw.web_url !== "string" || raw.web_url === "") {
    throw new GitLabCliError("GitLab merge-request response is missing iid or web_url");
  }
  return { id: raw.iid, title: typeof raw.title === "string" && raw.title !== "" ? raw.title : fallbackTitle, url: raw.web_url };
}

function mapMergeRequestDetails(raw: unknown): GitLabMergeRequestDetails {
  if (!isRecord(raw) || !isPositiveInteger(raw.iid) || typeof raw.web_url !== "string" || raw.web_url === ""
    || typeof raw.state !== "string" || raw.state === "" || typeof raw.target_branch !== "string" || raw.target_branch === "") {
    throw new GitLabCliError("GitLab merge-request response is missing iid, state, target_branch, or web_url");
  }
  return {
    id: raw.iid,
    title: typeof raw.title === "string" && raw.title !== "" ? raw.title : `Merge request !${raw.iid}`,
    status: raw.state,
    targetBranch: raw.target_branch,
    url: raw.web_url,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function runGlab(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("glab", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, GLAB_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new GitLabCliError(`Unable to start GitLab CLI: ${error.message}`));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) reject(new GitLabCliError(`GitLab CLI timed out after ${GLAB_TIMEOUT_MS / 1000} seconds`));
      else if (exitCode !== 0) reject(new GitLabCliError(`GitLab CLI failed: ${(stderr || stdout).trim()}`));
      else resolve(stdout);
    });
  });
}
