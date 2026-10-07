import { useEffect, useState } from "react";
import type { MissionRunJobView } from "../develop-view";
import { responseError } from "../types";

export function StepAggregateReview({ job, onJobUpdate }: {
  job: MissionRunJobView;
  onJobUpdate: (job: MissionRunJobView) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrideJustification, setOverrideJustification] = useState("");
  useEffect(() => {
    setSelected(job.aggregateReview?.affectedRepositories ?? []);
  }, [job.aggregateReview?.createdAt]);

  if (job.aggregateReviewStatus === "skipped" || job.repositoryIds.length < 2) return null;
  if (job.aggregateReviewStatus === "pending" || job.aggregateReviewStatus === "running") {
    return <p className="activity-line"><span className="activity-spinner" />Reviewing cross-repository consistency…</p>;
  }
  if (job.aggregateReviewStatus === "failed") {
    return <p className="plan-error">Aggregate review failed: {job.aggregateReviewError ?? "No verdict was returned."}</p>;
  }
  const review = job.aggregateReview;
  if (!review) return null;

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/missions/develop-runs/${job.id}/aggregate-retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryIds: selected }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to retry affected repositories."));
      onJobUpdate((await response.json() as { job: MissionRunJobView }).job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submitOverride = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/missions/develop-runs/${job.id}/aggregate-override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ justification: overrideJustification }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to record the override."));
      onJobUpdate((await response.json() as { job: MissionRunJobView }).job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <div className={`plan-section ${review.disposition === "accept" ? "" : "warn"}`}>
    <h3>Cross-repository consistency review</h3>
    <p><span className={`badge ${review.disposition === "accept" ? "ok" : "bad"}`}>{review.disposition}</span></p>
    {review.parseError && <p className="plan-error">{review.parseError}</p>}
    {review.objections.map((objection, index) => <div className="review-panel" key={`${objection.claim}-${index}`}>
      <p><strong>{objection.repositories.join(", ")}</strong> — {objection.claim}</p>
      <p>Evidence: {objection.evidence.join(", ")}</p>
    </div>)}
    {review.disposition === "revise" && <>
      <p>Select affected repositories to reopen. Downstream dependents are added by the server.</p>
      {job.repositoryIds.map((repositoryId) => <label className="skip-confirm" key={repositoryId}>
        <input
          type="checkbox"
          checked={selected.includes(repositoryId)}
          disabled={review.affectedRepositories.includes(repositoryId)}
          onChange={(event) => setSelected((current) => event.target.checked
            ? [...current, repositoryId]
            : current.filter((id) => id !== repositoryId))}
        />
        {repositoryId}{review.affectedRepositories.includes(repositoryId) ? " · required by review" : ""}
      </label>)}
      {error && <p className="plan-error">{error}</p>}
      <button type="button" className="primary" onClick={() => void retry()} disabled={busy || selected.length === 0}>
        {busy ? "Reopening…" : "Reopen affected repositories"}
      </button>
    </>}
    {review.disposition !== "accept" && (job.aggregateReviewOverride
      ? <p className="story-loaded-note">Developer override recorded: {job.aggregateReviewOverride.justification}</p>
      : <>
        <p>If you judge these objections don't actually block publishing, record why below. The reviewer's objections are carried into the published PR description regardless — nothing raised here is discarded.</p>
        <textarea
          value={overrideJustification}
          onChange={(event) => setOverrideJustification(event.target.value)}
          placeholder="Developer override justification (required)"
          rows={2}
        />
        {error && <p className="plan-error">{error}</p>}
        <button type="button" className="secondary" onClick={() => void submitOverride()} disabled={busy || overrideJustification.trim() === ""}>
          {busy ? "Recording…" : "Accept and continue (developer override)"}
        </button>
      </>)}
  </div>;
}
