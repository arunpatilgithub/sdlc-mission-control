import {
  classifyVerification,
  formatMissionCost,
  type MissionRunJobView,
} from "../develop-view";
import type { PublishResultView } from "../develop-view";
import { StepPublish } from "./StepPublish";
import { StepScopeReview } from "./StepScopeReview";
import { StepAggregateReview } from "./StepAggregateReview";

export function firstExecutableRepository(executionOrder: string[], approvedPathsByRepository: Record<string, string[]>): string {
  return executionOrder.find((repositoryId) => (approvedPathsByRepository[repositoryId] ?? []).length > 0)
    ?? Object.keys(approvedPathsByRepository).find((repositoryId) => (approvedPathsByRepository[repositoryId] ?? []).length > 0)
    ?? "";
}

function developAnyPublished(job: MissionRunJobView, executionOrder: string[]): boolean {
  if (job.publication?.published) return true;
  return executionOrder.some((repositoryId) => job.runsByRepository[repositoryId]?.publication?.published === true);
}

function elapsedSince(startedAt: string | null, now: number): string {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1_000));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function activityLabel(activity: MissionRunJobView["runsByRepository"][string]["activity"]): string {
  if (!activity) return "Waiting";
  if (activity.phase === "preparing-worktree") return "Creating isolated worktree";
  if (activity.phase === "baseline-verification") return `Baseline verification: ${activity.command ?? "configured check"}`;
  if (activity.phase === "post-change-verification") return `Post-change verification: ${activity.command ?? "configured check"}`;
  if (activity.phase === "committing") return "Creating reviewed local commit";
  if (activity.phase === "deterministic-gates") return "Running deterministic gates";
  if (activity.phase === "diff-critic") return "Reviewing implementation diff";
  if (activity.activePaths.length > 0) return `Updating ${activity.activePaths.join(", ")}`;
  return activity.detail ?? "Implementation agent starting";
}

function activityTitle(activity: MissionRunJobView["runsByRepository"][string]["activityLog"][number]): string {
  if (activity.phase === "preparing-worktree") return "Create isolated worktree and local feature branch";
  if (activity.phase === "baseline-verification") return "Run baseline validation";
  if (activity.phase === "implementation") return "Implement approved changes";
  if (activity.phase === "post-change-verification") return "Run post-change validation";
  if (activity.phase === "committing") return "Create reviewed local commit";
  if (activity.phase === "deterministic-gates") return "Run deterministic gates";
  return "Review implementation diff";
}

function activityDuration(activity: MissionRunJobView["runsByRepository"][string]["activityLog"][number], now: number): string {
  return elapsedSince(activity.startedAt, activity.completedAt ? new Date(activity.completedAt).getTime() : now);
}

function pathStatus(path: string, run: MissionRunJobView["runsByRepository"][string] | undefined): "changed" | "in-progress" | "updated" | "pending" {
  if (run?.result?.develop?.filesChanged.includes(path)) return "changed";
  if (run?.activity?.activePaths.includes(path)) return "in-progress";
  if (run?.activity?.completedPaths.includes(path)) return "updated";
  return "pending";
}

export function StepDevelop({ approvedPathsByRepository, executionOrder, job, starting, error, onStart, onDiscardAndReRun, onDiscardMission, onPublished, onJobUpdate, onBack, onStartNewPlan }: {
  approvedPathsByRepository: Record<string, string[]>;
  executionOrder: string[];
  job: MissionRunJobView | null;
  starting: boolean;
  error: string | null;
  onStart: () => void;
  onDiscardAndReRun: () => void;
  onDiscardMission: () => void;
  onPublished: (publication: PublishResultView) => void;
  onJobUpdate: (job: MissionRunJobView) => void;
  onBack: () => void;
  onStartNewPlan: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (job?.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [job?.status]);
  const result = job?.result ?? null;
  const currentRepositoryId = job?.currentRepositoryId ?? firstExecutableRepository(executionOrder, approvedPathsByRepository);
  const initialPlannedPaths = approvedPathsByRepository[currentRepositoryId] ?? [];
  const currentRun = job?.runsByRepository[currentRepositoryId];
  const cost = result ? formatMissionCost(result.ledger) : null;
  const verification = result?.develop
    ? classifyVerification(result.develop.baseline, result.develop.verification, result.develop.regressions)
    : { rows: [], notVerifiedReason: null };
  const activeStage = job?.stagesRun.at(-1);
  const activity = starting
    ? "Starting Develop and preparing the isolated worktree…"
    : currentRun?.activity
      ? activityLabel(currentRun.activity)
    : activeStage === "gates"
      ? "Running deterministic gates…"
      : activeStage === "develop-critic"
        ? "The critic is reviewing the implementation diff…"
        : "The implementation agent is writing code in the isolated worktree…";

  return <div className="step-panel">
    {job && <div className="repository-run-lanes">
      {job.executionOrder.map((repositoryId, index) => {
        const run = job.runsByRepository[repositoryId];
        const develop = run?.result?.develop;
        return <div className={`repository-run-lane repository-run-${run?.status ?? "pending"}`} key={repositoryId}>
          <span className="mission-stage-marker">{run?.result?.outcome === "done" ? "✓" : index + 1}</span>
          <span><strong>{repositoryId}</strong><br />{run?.status ?? "pending"}{job.currentRepositoryId === repositoryId && job.status === "running" ? " · current" : ""}</span>
          <span>{develop?.branch ? <code>{develop.branch}</code> : run?.workspaceBranch ? <code>{run.workspaceBranch}</code> : "Branch pending"}</span>
          <span>{run?.activity ? activityLabel(run.activity) : develop ? `${develop.filesChanged.length} files · ${run.result?.verdict?.disposition ?? "not reviewed"}` : activityLabel(null)}<br /><small>{run?.status === "running" ? elapsedSince(run.startedAt, now) : run?.completedAt && run.startedAt ? elapsedSince(run.startedAt, new Date(run.completedAt).getTime()) : ""}</small></span>
        </div>;
      })}
    </div>}
    {job && <p className="plan-meta-detail">Overall Develop elapsed: {elapsedSince(job.startedAt, job.completedAt ? new Date(job.completedAt).getTime() : now)}</p>}
    {job && job.executionOrder.some((repositoryId) => (job.runsByRepository[repositoryId]?.activityLog.length ?? 0) > 0) && <div className="plan-section">
      <h3>Develop activity</h3>
      <p className="repo-scope-note">Harness operations are retained for this run. Raw model output remains in the run audit artifact.</p>
      {job.executionOrder.map((repositoryId) => {
        const run = job.runsByRepository[repositoryId];
        const entries = run?.activityLog ?? [];
        if (entries.length === 0) return null;
        return <div className="history-table-wrap" key={repositoryId}>
          <h4>{repositoryId}</h4>
          <table className="history-table">
            <thead><tr><th>Operation</th><th>Status</th><th>Duration</th><th>Details</th></tr></thead>
            <tbody>{entries.map((entry) => <tr key={entry.id}>
              <td>{activityTitle(entry)}{entry.command && <><br /><code>{entry.command}</code></>}</td>
              <td><span className={`badge ${entry.status === "completed" ? "ok" : "verdict-neutral"}`}>{entry.status === "completed" ? "completed" : "in progress"}</span></td>
              <td>{activityDuration(entry, now)}</td>
              <td>{entry.detail ?? (entry.activePaths.length > 0 ? `Updating ${entry.activePaths.join(", ")}` : "—")}</td>
            </tr>)}</tbody>
          </table>
        </div>;
      })}
    </div>}
    <div className="plan-section">
      <h3>Approved scope boundary · {currentRepositoryId}</h3>
      <p>Only these paths approved during plan review are allowed by the scope gate. Return to plan review to change this boundary.</p>
      <table className="history-table develop-paths"><thead><tr><th>Planned file</th><th>Status</th></tr></thead><tbody>{initialPlannedPaths.map((path) => {
        const status = pathStatus(path, currentRun);
        return <tr key={path}><td><code>{path}</code></td><td><span className={`badge ${status === "changed" ? "ok" : status === "in-progress" ? "verdict-neutral" : ""}`}>{status.replaceAll("-", " ")}</span></td></tr>;
      })}</tbody></table>
    </div>

    {(starting || job?.status === "running") && <p className="activity-line" aria-live="polite"><span className="activity-spinner" />{activity}</p>}
    {job?.status === "failed" && <p className="plan-error">Harness failure: {job.error ?? "The mission runner failed without an error message."}</p>}
    {result?.outcome === "escalated" && <div className="plan-section warn"><h3>Mission escalated</h3><p>{result.reason}</p></div>}
    {result?.outcome === "done" && <p className="story-loaded-note">Mission completed successfully.</p>}
    {job && <StepScopeReview job={job} onJobUpdate={onJobUpdate} />}

    {result?.develop && <div className="plan-section">
      <h3>Diff</h3>
      <p>{result.develop.filesChanged.length} changed file{result.develop.filesChanged.length === 1 ? "" : "s"}: {result.develop.filesChanged.join(", ") || "none"}</p>
      <pre className="usage-bar">{result.develop.diffStat ?? "Diff statistics unavailable."}</pre>
    </div>}

    {result?.gateReport && <div className="plan-section">
      <h3>Deterministic gates</h3>
      {result.gateReport.results.map((gate) => <div className="review-panel" key={gate.id}>
        <p><span className={`badge ${gate.status === "passed" ? "ok" : gate.status === "failed" ? "bad" : "verdict-neutral"}`}>{gate.status}</span> <strong>{gate.id}</strong></p>
        <p>{gate.detail}</p>
        {gate.status === "failed" && gate.offenders.length > 0 && <p className="plan-error">Offenders: {gate.offenders.join(", ")}</p>}
      </div>)}
    </div>}

    {result?.verdict && <div className="plan-section">
      <h3>Critic verdict</h3>
      <p><span className={`badge ${result.verdict.disposition === "accept" ? "ok" : "bad"}`}>{result.verdict.disposition}</span></p>
      {result.verdict.objections.map((objection, index) => <div className="review-panel" key={`${objection.claim}-${index}`}>
        <p><strong>{objection.severity}</strong> — {objection.claim}</p>
        <p>Evidence: {objection.evidence.join(", ")}</p>
      </div>)}
    </div>}

    {result?.develop && (verification.rows.length > 0 || verification.notVerifiedReason !== null) && <div className="plan-section">
      <h3>Verification against baseline</h3>
      {verification.notVerifiedReason && <p className="repo-scope-note">{verification.notVerifiedReason}</p>}
      {verification.rows.length > 0 && <div className="history-table-wrap">
        <table className="history-table">
          <thead><tr><th>Command</th><th>Baseline</th><th>After develop</th><th>Classification</th></tr></thead>
          <tbody>{verification.rows.map((entry) => <tr key={entry.command}>
            <td><code>{entry.command}</code></td>
            <td>{entry.baseline ? entry.baseline.passed ? "passed" : `failed (${entry.baseline.exitCode})` : "not run"}</td>
            <td>{entry.verification ? entry.verification.passed ? "passed" : `failed (${entry.verification.exitCode})` : "not run"}</td>
            <td><span className={`badge ${entry.classification === "passed" ? "ok" : entry.classification === "pre-existing-failure" ? "" : "bad"}`}>{entry.classification.replaceAll("-", " ")}</span></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </div>}

    {cost && <p className="usage-bar">
      <span>{cost.tokens}</span>
      <span className={cost.incomplete ? "usage-hot" : ""}>{cost.cost}</span>
    </p>}

    {job && <StepAggregateReview job={job} onJobUpdate={onJobUpdate} />}
    {job && (job.aggregateReviewStatus === "skipped" || job.aggregateReview?.disposition === "accept" || Boolean(job.aggregateReviewOverride))
      && job.executionOrder.map((repositoryId) => {
        const run = job.runsByRepository[repositoryId];
        if (run?.result?.outcome !== "done") return null;
        const repositoryJob: MissionRunJobView = {
          ...job,
          repositoryId,
          currentRepositoryId: repositoryId,
          stagesRun: run.stagesRun,
          result: run.result,
          publication: run.publication,
          scopeReviewStatus: run.scopeReviewStatus,
          scopeReview: run.scopeReview,
          scopeReviewError: run.scopeReviewError,
          scopeDecisions: run.scopeDecisions,
          error: run.error,
        };
        return <StepPublish job={repositoryJob} onPublished={onPublished} key={repositoryId} />;
      })}

    {(error || (!job && initialPlannedPaths.length === 0)) && <div className="plan-section warn">
      <p className="plan-error">{error ?? "This saved plan has no runnable approved scope."}</p>
      {!job && initialPlannedPaths.length === 0 && <button type="button" className="secondary" onClick={onStartNewPlan}>Start a new plan</button>}
    </div>}
    <div className="step-footer between">
      <button type="button" className="link-button" onClick={onBack}>← Back to approval</button>
      <div className="develop-footer-actions">
        {(!job || job.status === "failed" || job.result?.outcome === "escalated") && <button type="button" className="primary" onClick={onStart} disabled={initialPlannedPaths.length === 0 || starting}>{starting ? "Starting develop…" : job ? "Retry develop run" : "Start develop run"}</button>}
        {job && (job.status === "failed" || job.result?.outcome === "escalated") && <button type="button" className="secondary" onClick={() => { if (window.confirm("Discard the uncommitted partial patch in the disposable worktree and retry the develop run?")) onDiscardAndReRun(); }} disabled={initialPlannedPaths.length === 0 || starting} title="Force-remove the uncommitted partial patch left in the disposable worktree, then retry.">{starting ? "Discarding…" : "Discard partial patch & retry"}</button>}
        {job?.result?.outcome === "done" && <div className="develop-discard-rerun">
          {developAnyPublished(job, executionOrder) && <p className="outcome-warn">A code review already exists on the remote for this run. Discarding here removes only the local worktree and branch — the remote branch and PR are left in place, and re-publishing a different commit to the same branch will be refused until you remove that remote branch/PR.</p>}
          <button type="button" className="secondary" onClick={() => {
            if (!job) return;
            const message = "Discard this completed develop output and re-run from scratch? The disposable worktree and feature branch for this run will be force-removed."
              + (developAnyPublished(job, executionOrder) ? "\n\nA published code review already exists: this removes ONLY the local worktree and branch. The remote branch and PR are left in place, and re-publishing a different commit to the same branch will be refused until you remove that remote branch/PR." : "");
            if (window.confirm(message)) onDiscardAndReRun();
          }} disabled={initialPlannedPaths.length === 0 || starting} title="Force-remove the disposable worktree and feature branch for this completed run, then start a fresh develop run.">{starting ? "Discarding…" : "Discard develop output & re-run"}</button>
        </div>}
        {job && (job.status === "failed" || job.result?.outcome === "escalated" || job.result?.outcome === "done") && <button type="button" className="secondary" onClick={() => { if (window.confirm("Discard this attempt and go back to planning? All disposable worktrees and feature branches for this mission's repositories will be removed (including any committed develop output). Remote branches and PRs are not affected.")) onDiscardMission(); }} disabled={starting} title="Tear down every disposable worktree and feature branch for this mission, then return to the planning step (your story stays selected).">Discard &amp; re-plan</button>}
      </div>
    </div>
  </div>;
}
import { useEffect, useState } from "react";
