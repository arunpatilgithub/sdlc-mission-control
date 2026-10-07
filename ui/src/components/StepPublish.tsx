import { useState } from "react";
import type { MissionRunJobView, PublishResultView } from "../develop-view";
import { responseError } from "../types";

export function StepPublish({ job, onPublished }: {
  job: MissionRunJobView;
  onPublished: (publication: PublishResultView) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  const [busy, setBusy] = useState<"dry-run" | "publish" | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localResult, setLocalResult] = useState<PublishResultView | null>(null);
  const develop = job.result?.develop;
  const publication = localResult ?? job.publication ?? null;
  if (job.result?.outcome !== "done" || !develop?.commit) return null;

  const submit = async (dryRun: boolean) => {
    setBusy(dryRun ? "dry-run" : "publish");
    setError(null);
    try {
      const response = await fetch(`/api/missions/develop-runs/${job.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun, confirmed: !dryRun && confirmed, repositoryId: job.repositoryId }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to publish the implementation."));
      const body = await response.json() as { result: PublishResultView };
      setLocalResult(body.result);
      onPublished(body.result);
      if (body.result.error) setError(body.result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const submitMerge = async () => {
    setMerging(true);
    setError(null);
    try {
      const response = await fetch(`/api/missions/develop-runs/${job.id}/publish/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: mergeConfirmed, repositoryId: job.repositoryId }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to merge the merge request."));
      const body = await response.json() as { result: PublishResultView };
      setLocalResult(body.result);
      onPublished(body.result);
      if (body.result.merge?.error) setError(body.result.merge.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMerging(false);
    }
  };

  return <div className="plan-section publish-section">
    <h3>Publish branch and create code review — {job.repositoryId}</h3>
    <p>This is a separate external-write stage. It pushes only the reviewed commit and creates or reuses the repository’s pull request or merge request.</p>
    <dl className="publish-summary">
      <div><dt>Repository</dt><dd><code>{job.repositoryId}</code></dd></div>
      <div><dt>Branch</dt><dd><code>{develop.branch}</code></dd></div>
      <div><dt>Commit</dt><dd><code>{develop.commit.slice(0, 12)}</code></dd></div>
    </dl>

    {publication?.dryRun && !publication.error && <div className="publish-preview-success" role="status">
      <strong>Preview passed — no remote changes were made.</strong>
      <span>Ready to push <code>{publication.commit.slice(0, 12)}</code> to <code>{publication.sourceBranch}</code> and open a code review into <code>{publication.targetBranch}</code>.</span>
    </div>}
    {publication?.published && publication.pullRequest && <p className="story-loaded-note">
      Published successfully. <a href={publication.pullRequest.url} target="_blank" rel="noreferrer">Open {publication.scm === "gitlab" ? "MR" : "PR"} #{publication.pullRequest.id}</a>
    </p>}
    {publication?.scm === "gitlab" && publication.merge?.merged && <p className="story-loaded-note">
      Merged successfully into <code>{publication.targetBranch}</code>.
    </p>}
    {error && <p className="plan-error">Publish stopped: {error}</p>}

    {!publication?.published && <label className="skip-confirm">
      <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
      I reviewed the diff, verification, target branch, and commit. Push this commit and create or reuse the PR.
    </label>}
    {!publication?.published && <div className="approval-actions">
      <button type="button" className="secondary" onClick={() => void submit(true)} disabled={busy !== null}>
        {busy === "dry-run" ? "Checking…" : publication?.dryRun && !publication.error ? "Preview passed ✓" : "Preview publish"}
      </button>
      <button type="button" className="primary" onClick={() => void submit(false)} disabled={!confirmed || busy !== null}>
        {busy === "publish" ? "Publishing…" : publication?.error ? "Retry publish" : "Publish and create PR"}
      </button>
    </div>}
    {publication?.scm === "gitlab" && publication.published && !publication.merge?.merged && <>
      <label className="skip-confirm">
        <input type="checkbox" checked={mergeConfirmed} onChange={(event) => setMergeConfirmed(event.target.checked)} />
        I reviewed the GitLab merge request, target branch, and required approvals. Merge it now.
      </label>
      <div className="approval-actions">
        <button type="button" className="primary" onClick={() => void submitMerge()} disabled={!mergeConfirmed || merging}>
          {merging ? "Merging…" : publication.merge?.error ? "Retry merge" : "Merge into target branch"}
        </button>
      </div>
    </>}
  </div>;
}
