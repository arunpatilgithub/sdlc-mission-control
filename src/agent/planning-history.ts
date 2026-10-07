import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { RunUsage } from "./usage.js";

/**
 * Reconstructs past planning runs from the append-only audit logs in
 * runtime/planning-runs, so cost history survives a dashboard restart without needing
 * a database. Each run's facts are spread across its lifecycle events — the story and
 * settings arrive with "started", the usage figures with "finished" — so a row is the
 * merge of one file's events.
 */

export interface HistoryRow {
  jobId: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: "running" | "completed" | "failed";
  provider: string | null;
  repositoryId: string | null;
  workItemId: number | null;
  title: string | null;
  mode: string | null;
  phase: string | null;
  usage: RunUsage | null;
  /** How many ADO Tasks this mission went on to create, if any. */
  tasksCreated: number;
}

export interface HistoryTotals {
  runs: number;
  completed: number;
  failed: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  toolOutputBytes: number;
  costUSD: number | null;
  durationMs: number;
  /** Runs whose provider never reported token counts, so the totals understate reality. */
  runsWithoutUsage: number;
}

export interface PlanningHistory {
  runs: HistoryRow[];
  totals: HistoryTotals;
}

export function defaultAuditDirectory(): string {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  const root = configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
  return resolve(root, "planning-runs");
}

export function readPlanningHistory(directory = defaultAuditDirectory(), limit = 100): PlanningHistory {
  if (!existsSync(directory)) return { runs: [], totals: emptyTotals() };

  const rows: HistoryRow[] = [];
  for (const name of readdirSync(directory)) {
    // Only the small per-run audit logs. The sibling *.events.jsonl files hold the full
    // agent transcript and can be hundreds of KB — reading those here would be wasteful.
    if (!name.endsWith(".jsonl") || name.endsWith(".events.jsonl")) continue;
    const row = readRun(resolve(directory, name), name.replace(/\.jsonl$/, ""));
    if (row) rows.push(row);
  }

  rows.sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
  const limited = rows.slice(0, limit);
  return { runs: limited, totals: totalsFor(rows) };
}

function readRun(path: string, jobId: string): HistoryRow | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const row: HistoryRow = {
    jobId, startedAt: null, finishedAt: null, status: "running",
    provider: null, repositoryId: null, workItemId: null, title: null,
    mode: null, phase: null, usage: null, tasksCreated: 0,
  };
  let sawAnyEvent = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // a truncated final line shouldn't discard the rest of the run
    }
    sawAnyEvent = true;

    const name = event.event;
    const timestamp = asString(event.timestamp);
    if (name === "started") {
      row.startedAt = timestamp;
      row.workItemId = asNumber(event.workItemId);
      row.title = asString(event.title);
      row.mode = asString(event.mode);
      row.phase = asString(event.phase);
    }
    if (name === "finished" || name === "watchdog-failed") row.finishedAt = timestamp;
    if (name === "tasks-created") {
      const repositories = event.repositories;
      row.tasksCreated += Array.isArray(repositories) ? repositories.length : 0;
    }

    // These are stamped on every event, so the latest wins.
    row.provider = asString(event.provider) ?? row.provider;
    row.repositoryId = asString(event.repositoryId) ?? row.repositoryId;
    const status = asString(event.status);
    if (status === "running" || status === "completed" || status === "failed") row.status = status;
    const usage = event.usage;
    if (typeof usage === "object" && usage !== null && !Array.isArray(usage)) row.usage = usage as unknown as RunUsage;
  }

  if (!sawAnyEvent) return null;
  if (row.startedAt === null) row.startedAt = row.finishedAt;
  return row;
}

function totalsFor(rows: HistoryRow[]): HistoryTotals {
  const totals = emptyTotals();
  let anyCost = false;
  for (const row of rows) {
    totals.runs += 1;
    if (row.status === "completed") totals.completed += 1;
    if (row.status === "failed") totals.failed += 1;
    if (!row.usage) { totals.runsWithoutUsage += 1; continue; }
    totals.inputTokens += row.usage.inputTokens ?? 0;
    totals.cachedInputTokens += row.usage.cachedInputTokens ?? 0;
    totals.cacheWriteTokens += row.usage.cacheWriteTokens ?? 0;
    totals.outputTokens += row.usage.outputTokens ?? 0;
    totals.toolOutputBytes += row.usage.toolOutputBytes ?? 0;
    totals.durationMs += row.usage.durationMs ?? 0;
    if (row.usage.costUSD !== null && row.usage.costUSD !== undefined) {
      totals.costUSD = (totals.costUSD ?? 0) + row.usage.costUSD;
      anyCost = true;
    }
  }
  // Left null rather than 0 when no provider reported a price, so "we don't know" is
  // not displayed as "it was free".
  if (!anyCost) totals.costUSD = null;
  return totals;
}

function emptyTotals(): HistoryTotals {
  return {
    runs: 0, completed: 0, failed: 0,
    inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    toolOutputBytes: 0, costUSD: null, durationMs: 0, runsWithoutUsage: 0,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
