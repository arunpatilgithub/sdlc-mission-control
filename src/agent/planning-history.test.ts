import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPlanningHistory } from "./planning-history.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "planning-history-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const usage = (over: Partial<Record<string, unknown>> = {}) => ({
  provider: "codex", inputTokens: 32342, cachedInputTokens: 19968, outputTokens: 1517,
  reasoningTokens: 404, costUSD: null, turns: 1, durationMs: 47033,
  promptBytes: 5667, toolOutputBytes: 7565, outputBytes: 4988, commandCount: 1, ...over,
});

function writeRun(jobId: string, events: Array<Record<string, unknown>>): void {
  writeFileSync(resolve(dir, `${jobId}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

function completedRun(jobId: string, startedAt: string, over: Partial<Record<string, unknown>> = {}): void {
  writeRun(jobId, [
    { timestamp: startedAt, event: "started", jobId, status: "running", provider: "codex", repositoryId: "Publisher.Content", workItemId: 161723, title: "Found Performance subid URL string", mode: "fast", phase: "repository-decision" },
    { timestamp: startedAt, event: "spawned", jobId, status: "running", provider: "codex", repositoryId: "Publisher.Content" },
    { timestamp: startedAt, event: "finished", jobId, status: "completed", provider: "codex", repositoryId: "Publisher.Content", usage: usage(over) },
  ]);
}

describe("readPlanningHistory", () => {
  it("returns nothing for a missing directory instead of throwing", () => {
    const history = readPlanningHistory(resolve(dir, "does-not-exist"));
    expect(history.runs).toEqual([]);
    expect(history.totals.runs).toBe(0);
  });

  it("merges a run's facts from across its lifecycle events", () => {
    completedRun("job-a", "2026-07-31T10:00:00.000Z");
    const [row] = readPlanningHistory(dir).runs;

    expect(row).toMatchObject({
      jobId: "job-a",
      status: "completed",
      provider: "codex",
      repositoryId: "Publisher.Content",
      workItemId: 161723,
      title: "Found Performance subid URL string",
      mode: "fast",
      phase: "repository-decision",
      tasksCreated: 0,
    });
    expect(row.usage?.inputTokens).toBe(32342);
    expect(row.finishedAt).toBe("2026-07-31T10:00:00.000Z");
  });

  it("ignores the large .events.jsonl transcripts alongside the audit logs", () => {
    completedRun("job-a", "2026-07-31T10:00:00.000Z");
    writeFileSync(resolve(dir, "job-a.events.jsonl"), `${JSON.stringify({ type: "turn.completed" })}\n`, "utf8");

    expect(readPlanningHistory(dir).runs.map((r) => r.jobId)).toEqual(["job-a"]);
  });

  it("sorts newest first", () => {
    completedRun("older", "2026-07-30T09:00:00.000Z");
    completedRun("newer", "2026-07-31T09:00:00.000Z");

    expect(readPlanningHistory(dir).runs.map((r) => r.jobId)).toEqual(["newer", "older"]);
  });

  it("counts ADO Tasks a mission created", () => {
    writeRun("job-t", [
      { timestamp: "2026-07-31T10:00:00.000Z", event: "started", status: "running", provider: "codex", repositoryId: "RepoA", workItemId: 1, title: "t" },
      { timestamp: "2026-07-31T10:01:00.000Z", event: "finished", status: "completed", provider: "codex", repositoryId: "RepoA", usage: usage() },
      { timestamp: "2026-07-31T10:02:00.000Z", event: "tasks-created", status: "completed", provider: "codex", repositoryId: "RepoA", repositories: ["RepoA", "RepoB"], taskIds: [11, 12] },
    ]);

    expect(readPlanningHistory(dir).runs[0].tasksCreated).toBe(2);
  });

  it("records a watchdog timeout as failed", () => {
    writeRun("job-f", [
      { timestamp: "2026-07-31T10:00:00.000Z", event: "started", status: "running", provider: "codex", repositoryId: "RepoA", workItemId: 1, title: "t" },
      { timestamp: "2026-07-31T10:03:15.000Z", event: "watchdog-failed", status: "failed", provider: "codex", repositoryId: "RepoA" },
    ]);

    const [row] = readPlanningHistory(dir).runs;
    expect(row.status).toBe("failed");
    expect(row.usage).toBeNull();
    expect(row.finishedAt).toBe("2026-07-31T10:03:15.000Z");
  });

  it("sums totals across runs and counts runs that reported no usage", () => {
    completedRun("job-a", "2026-07-31T10:00:00.000Z");
    completedRun("job-b", "2026-07-31T11:00:00.000Z");
    writeRun("job-c", [
      { timestamp: "2026-07-31T12:00:00.000Z", event: "started", status: "running", provider: "codex", repositoryId: "RepoA", workItemId: 1, title: "t" },
      { timestamp: "2026-07-31T12:01:00.000Z", event: "watchdog-failed", status: "failed", provider: "codex", repositoryId: "RepoA" },
    ]);

    const { totals } = readPlanningHistory(dir);
    expect(totals).toMatchObject({
      runs: 3, completed: 2, failed: 1,
      inputTokens: 32342 * 2,
      outputTokens: 1517 * 2,
      toolOutputBytes: 7565 * 2,
      runsWithoutUsage: 1,
    });
  });

  it("reports cost as null when no provider priced the run, and sums it when they do", () => {
    completedRun("job-a", "2026-07-31T10:00:00.000Z");
    expect(readPlanningHistory(dir).totals.costUSD).toBeNull();

    completedRun("job-b", "2026-07-31T11:00:00.000Z", { provider: "claude", costUSD: 0.0123 });
    completedRun("job-c", "2026-07-31T12:00:00.000Z", { provider: "claude", costUSD: 0.0077 });
    expect(readPlanningHistory(dir).totals.costUSD).toBeCloseTo(0.02, 5);
  });

  it("keeps earlier events when the final line is truncated mid-write", () => {
    writeFileSync(resolve(dir, "job-x.jsonl"),
      `${JSON.stringify({ timestamp: "2026-07-31T10:00:00.000Z", event: "started", status: "running", provider: "codex", repositoryId: "RepoA", workItemId: 9, title: "partial" })}\n{"event":"fini`,
      "utf8");

    const [row] = readPlanningHistory(dir).runs;
    expect(row.workItemId).toBe(9);
    expect(row.status).toBe("running");
  });

  it("limits returned rows but still totals every run", () => {
    for (let i = 0; i < 5; i++) completedRun(`job-${i}`, `2026-07-3${i}T10:00:00.000Z`);

    const history = readPlanningHistory(dir, 2);
    expect(history.runs).toHaveLength(2);
    expect(history.totals.runs).toBe(5);
  });
});
