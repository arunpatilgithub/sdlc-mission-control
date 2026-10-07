import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TaskLinkError, type AzureDevOpsCli, type CreatedTask } from "../ado/azure-devops-cli.js";

export interface RepoTaskRequest {
  id: string;
  title: string;
  description: string;
}

export interface RepoTaskOutcome {
  repositoryId: string;
  title: string;
  description: string;
  /** Set whenever a Task exists in ADO for this repo — including when linking it failed. */
  task: CreatedTask | null;
  error: string | null;
  /** True when this repo already had a Task from an earlier approval, so nothing was re-created. */
  alreadyCreated: boolean;
  /** True when the Task exists but is not linked to the parent User Story. */
  unlinked: boolean;
}

export interface ApprovalResult {
  missionId: string;
  parentStoryId: number;
  dryRun: boolean;
  outcomes: RepoTaskOutcome[];
  auditPath: string;
}

/**
 * Where approval audit records are written. Defaults to ./runtime — the override
 * exists so tests don't deposit fake approval history next to real missions, and is
 * resolved per call rather than at import so it can be set by a test harness.
 */
function runtimeRoot(): string {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  return configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
}

/**
 * Creates one ADO Task per confirmed repository, linked under the parent User
 * Story. Never touches the User Story's own state.
 *
 * Idempotent per repository: any repo present in `alreadyCreated` is reported back
 * untouched rather than created again. That makes re-approving safe (a second click
 * can't duplicate Tasks) while still allowing a retry to pick up only the repos that
 * failed the first time.
 *
 * When `dryRun` is set, builds the same outcome shape without calling ADO at all.
 */
export async function approveMission(
  client: AzureDevOpsCli,
  input: {
    missionId: string;
    parentStoryId: number;
    repos: RepoTaskRequest[];
    dryRun: boolean;
    alreadyCreated?: Record<string, CreatedTask>;
  },
): Promise<ApprovalResult> {
  if (input.repos.length === 0) throw new Error("At least one repository must be confirmed before approval");
  const alreadyCreated = input.alreadyCreated ?? {};

  const outcomes: RepoTaskOutcome[] = [];
  for (const repo of input.repos) {
    const base = { repositoryId: repo.id, title: repo.title, description: repo.description };

    const existing = alreadyCreated[repo.id];
    if (existing && !input.dryRun) {
      outcomes.push({ ...base, task: existing, error: null, alreadyCreated: true, unlinked: false });
      continue;
    }
    if (input.dryRun) {
      outcomes.push({ ...base, task: null, error: null, alreadyCreated: Boolean(existing), unlinked: false });
      continue;
    }

    try {
      const task = await client.createTask({ parentStoryId: input.parentStoryId, title: repo.title, description: repo.description });
      outcomes.push({ ...base, task, error: null, alreadyCreated: false, unlinked: false });
    } catch (error) {
      // A link failure still produced a Task, so report it as existing-but-unlinked.
      if (error instanceof TaskLinkError) {
        outcomes.push({ ...base, task: error.task, error: error.message, alreadyCreated: false, unlinked: true });
        continue;
      }
      outcomes.push({ ...base, task: null, error: error instanceof Error ? error.message : String(error), alreadyCreated: false, unlinked: false });
    }
  }

  const auditPath = writeApprovalAudit(input.missionId, input.parentStoryId, input.dryRun, outcomes);
  return { missionId: input.missionId, parentStoryId: input.parentStoryId, dryRun: input.dryRun, outcomes, auditPath };
}

/** Every repo that now has a Task in ADO, for the caller to remember against the mission. */
export function createdTasksFrom(outcomes: RepoTaskOutcome[]): Record<string, CreatedTask> {
  const created: Record<string, CreatedTask> = {};
  for (const outcome of outcomes) {
    if (outcome.task) created[outcome.repositoryId] = outcome.task;
  }
  return created;
}

function writeApprovalAudit(missionId: string, parentStoryId: number, dryRun: boolean, outcomes: RepoTaskOutcome[]): string {
  const missionDirectory = resolve(runtimeRoot(), "missions", missionId);
  mkdirSync(missionDirectory, { recursive: true });
  const timestamp = new Date().toISOString();
  // Real approvals get one immutable file per attempt: overwriting a single file would
  // erase the record of Tasks a previous attempt actually created. Dry runs have no
  // external effect, so a single rewritten preview file is fine.
  const fileName = dryRun ? "tasks-simulated.json" : `tasks-created-${timestamp.replace(/[:.]/g, "-")}.json`;
  const path = resolve(missionDirectory, fileName);
  const record = { timestamp, missionId, parentStoryId, dryRun, outcomes };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}
