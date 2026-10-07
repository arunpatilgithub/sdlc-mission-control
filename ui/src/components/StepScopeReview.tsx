import { useEffect, useState } from "react";
import type { MissionRunJobView } from "../develop-view";
import { responseError } from "../types";

export function StepScopeReview({ job, onJobUpdate }: {
  job: MissionRunJobView;
  onJobUpdate: (job: MissionRunJobView) => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, "approve" | "reject" | "">>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeGate = job.result?.gateReport?.results.find((gate) => gate.id === "scope");
  const offenders = scopeGate?.offenders ?? [];

  useEffect(() => {
    setDecisions(Object.fromEntries(offenders.map((path) => [path, ""])));
  }, [offenders.join("\0")]);

  if (job.result?.outcome !== "awaiting-scope-decision" || offenders.length === 0) return null;

  const startReview = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/missions/develop-runs/${job.id}/scope-review`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response, "Unable to start scope review."));
      onJobUpdate((await response.json() as { job: MissionRunJobView }).job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submitDecisions = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/missions/develop-runs/${job.id}/scope-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to apply scope decisions."));
      onJobUpdate((await response.json() as { job: MissionRunJobView }).job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const complete = offenders.every((path) => decisions[path] === "approve" || decisions[path] === "reject");
  return <div className="plan-section warn scope-decision" aria-live="polite">
    <h3>Developer scope decision required</h3>
    <p>Develop changed files outside the approved boundary. The planning agent can advise, but cannot approve them.</p>
    {job.scopeReviewStatus === "idle" && <button type="button" className="secondary" onClick={() => void startReview()} disabled={busy}>
      {busy ? "Starting review…" : "Ask planning agent to review additional files"}
    </button>}
    {job.scopeReviewStatus === "running" && <p className="activity-line"><span className="activity-spinner" />Planning agent is reviewing the additional-file diff…</p>}
    {job.scopeReviewStatus === "failed" && <>
      <p className="plan-error">Scope review failed: {job.scopeReviewError}</p>
      <button type="button" className="secondary" onClick={() => void startReview()} disabled={busy}>Retry scope review</button>
    </>}
    {job.scopeReview && <>
      {job.scopeReview.parseError && <p className="repo-scope-note">{job.scopeReview.parseError}</p>}
      {job.scopeReview.recommendations.map((recommendation) => <div className="scope-recommendation" key={recommendation.path}>
        <p><code>{recommendation.path}</code> <span className={`badge scope-${recommendation.classification}`}>{recommendation.classification}</span></p>
        <p>{recommendation.rationale}</p>
        {!recommendation.approvalAllowed && <p className="plan-error">This protected path cannot be added to mission scope; reject it or stop the mission.</p>}
        {recommendation.evidence.length > 0 && <p className="plan-meta-detail">Evidence: {recommendation.evidence.join(", ")}</p>}
        <label>Developer decision
          <select value={decisions[recommendation.path] ?? ""} onChange={(event) => setDecisions((current) => ({
            ...current,
            [recommendation.path]: event.target.value as "approve" | "reject" | "",
          }))}>
            <option value="">Choose…</option>
            <option value="approve" disabled={!recommendation.approvalAllowed}>Approve scope expansion</option>
            <option value="reject">Reject and restore this file</option>
          </select>
        </label>
      </div>)}
      <button type="button" className="primary" onClick={() => void submitDecisions()} disabled={!complete || busy}>
        {busy ? "Applying decisions…" : "Apply decisions and resume verification"}
      </button>
    </>}
    {error && <p className="plan-error">{error}</p>}
  </div>;
}
