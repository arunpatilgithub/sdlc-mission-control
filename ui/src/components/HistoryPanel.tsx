import { useEffect, useState } from "react";
import type { PlanningHistory } from "../types";

function kb(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function num(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString();
}

function seconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.round(ms / 1000)}s`;
}

function when(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 16);
}

/**
 * Past planning runs and what they cost, read from the audit logs on disk.
 *
 * Exists so the cost of planning is visible without digging through runtime/ — in
 * particular the "read by agent" column, which is how much file and command output the
 * agent pulled into its own context and is normally the dominant driver of token spend.
 */
export function HistoryPanel({ reloadKey }: { reloadKey: number }) {
  const [history, setHistory] = useState<PlanningHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/missions/history")
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load planning history.");
        return await response.json() as PlanningHistory;
      })
      .then((loaded) => { setHistory(loaded); setError(null); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [reloadKey]);

  if (error) return <section className="history-panel"><p className="plan-error">{error}</p></section>;
  if (!history || history.totals.runs === 0) return null;

  const { totals, runs } = history;

  return <details className="history-panel">
    <summary>Planning history · {runs.length} run{runs.length === 1 ? "" : "s"}</summary>
    <div className="history-content">
      <div className="history-totals">
        <Stat label="Runs" value={`${totals.runs}`} sub={`${totals.completed} ok · ${totals.failed} failed`} />
        <Stat label="Input tokens" value={num(totals.inputTokens)} sub={`${num(totals.cachedInputTokens)} cached`} />
        {totals.cacheWriteTokens > 0 && <Stat label="Cache writes" value={num(totals.cacheWriteTokens)} sub="billed at a premium" hot />}
        <Stat label="Output tokens" value={num(totals.outputTokens)} />
        <Stat label="Read by agent" value={kb(totals.toolOutputBytes)} sub="file & command output" hot={totals.toolOutputBytes > 500_000} />
        <Stat label="Time in planning" value={seconds(totals.durationMs)} />
        {totals.costUSD !== null && <Stat label="Reported cost" value={`$${totals.costUSD.toFixed(4)}`} />}
      </div>

      {totals.runsWithoutUsage > 0 && <p className="history-note">
        {totals.runsWithoutUsage} of {totals.runs} runs reported no token usage (they ran before usage was recorded, or ended early), so these totals understate the real figures.
      </p>}

      <div className="history-table-wrap">
      <table className="history-table">
        <thead>
          <tr>
            <th>When</th><th>Story</th><th>Repository</th><th>Provider</th><th>Status</th>
            <th className="right">Time</th><th className="right">In</th><th className="right">Out</th>
            <th className="right">Read</th><th className="right">Tasks</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => <tr key={run.jobId}>
            <td className="nowrap">{when(run.startedAt)}</td>
            <td className="history-story" title={run.title ?? ""}>{run.workItemId ? `#${run.workItemId}` : "—"} {run.title ?? ""}</td>
            <td className="nowrap">{run.repositoryId ?? "—"}</td>
            <td className="nowrap">{run.provider ?? "—"}{run.mode ? ` · ${run.mode}` : ""}</td>
            <td><span className={`history-status ${run.status}`}>{run.status}</span></td>
            <td className="right">{seconds(run.usage?.durationMs ?? null)}</td>
            <td className="right">{num(run.usage?.inputTokens)}</td>
            <td className="right">{num(run.usage?.outputTokens)}</td>
            <td className={`right ${(run.usage?.toolOutputBytes ?? 0) > 100_000 ? "usage-hot" : ""}`}>
              {run.usage ? kb(run.usage.toolOutputBytes) : "—"}
            </td>
            <td className="right">{run.tasksCreated > 0 ? run.tasksCreated : ""}</td>
          </tr>)}
        </tbody>
      </table>
      </div>
    </div>
  </details>;
}

function Stat({ label, value, sub, hot }: { label: string; value: string; sub?: string; hot?: boolean }) {
  return <div className="history-stat">
    <span className="history-stat-label">{label}</span>
    <strong className={hot ? "usage-hot" : ""}>{value}</strong>
    {sub && <span className="history-stat-sub">{sub}</span>}
  </div>;
}
