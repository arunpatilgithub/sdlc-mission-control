import { useEffect, useState } from "react";
import type { ApprovalResult, DevelopmentApproval, RepoScope, RepoTaskDraft } from "../types";
import { responseError } from "../types";
import { stripFencedBlocks } from "../plan-parser";

function defaultDrafts(storyTitle: string, repositoryIds: string[], planOutput: string | null): RepoTaskDraft[] {
  return repositoryIds.map((id) => ({
    id,
    title: `Implement: ${storyTitle} (${id})`,
    description: planOutput ? `Repository: ${id}\n\n${stripFencedBlocks(planOutput)}` : "",
  }));
}

export function RepoScopeEditor({ planJobId, parentStoryId, storyTitle, repositoryIds, noCodeMission, repoScope, planOutput, developmentApproval, onApprovalRecorded, onBack, onContinue }: {
  planJobId: string;
  parentStoryId: number;
  storyTitle: string;
  repositoryIds: string[];
  noCodeMission: boolean;
  repoScope: RepoScope;
  planOutput: string | null;
  developmentApproval: DevelopmentApproval | null;
  onApprovalRecorded: (approval: DevelopmentApproval) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [drafts, setDrafts] = useState<RepoTaskDraft[]>(() => defaultDrafts(storyTitle, repositoryIds, planOutput));
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ApprovalResult | null>(null);
  const [skipConfirmed, setSkipConfirmed] = useState(false);
  const [developmentApproved, setDevelopmentApproved] = useState(developmentApproval !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts(defaultDrafts(storyTitle, repositoryIds, planOutput));
    setResult(null);
    setSkipConfirmed(false);
    setDevelopmentApproved(developmentApproval !== null);
    setError(null);
  }, [planJobId]);

  const updateDraft = (index: number, patch: Partial<RepoTaskDraft>) => {
    setDrafts((current) => current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  };

  const submit = async () => {
    if (drafts.length === 0) { setError("Confirm at least one repository before approving."); return; }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/missions/plans/${planJobId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repos: drafts, dryRun: false }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to submit the approval."));
      const payload = await response.json() as { result: ApprovalResult; developmentApproval: DevelopmentApproval | null };
      setResult(payload.result);
      if (payload.developmentApproval) {
        setDevelopmentApproved(true);
        onApprovalRecorded(payload.developmentApproval);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const skipTaskCreation = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/missions/plans/${planJobId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipTaskCreation: true }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to approve development without Tasks."));
      const payload = await response.json() as { developmentApproval: DevelopmentApproval };
      setResult(null);
      setDevelopmentApproved(true);
      onApprovalRecorded(payload.developmentApproval);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="step-panel repo-scope">
    <p className="repo-scope-hint">{noCodeMission
      ? "Every selected repository has audit-verified no-change evidence. Record approval to complete this mission without Tasks, development, or publishing."
      : `Each card below becomes one ADO Task, linked as a child of User Story #${parentStoryId}. Review and edit the title/description before approving — this is the exact payload that will be sent.`}</p>
    {repoScope.parseError && <p className="repo-scope-note">Automatic detection did not produce a repository list ({repoScope.parseError}). Add repositories manually below.</p>}

    {drafts.map((draft, index) => {
      return <div className="repo-task-draft" key={`${draft.id}-${index}`}>
        <div className="repo-task-draft-head">
          <span><strong>{draft.id}</strong><span className="tag-primary">coordinated plan</span></span>
        </div>
        <label>Task title<input value={draft.title} onChange={(event) => updateDraft(index, { title: event.target.value })} /></label>
        <label>Task description<textarea value={draft.description} onChange={(event) => updateDraft(index, { description: event.target.value })} rows={8} /></label>
      </div>;
    })}

    {error && <p className="plan-error">{error}</p>}

    <div className="step-footer between">
      <button type="button" className="link-button" onClick={onBack}>← Back to plan</button>
      {!noCodeMission && <button className="primary" onClick={() => void submit()} disabled={submitting || drafts.length === 0}>{submitting ? "Submitting…" : "Approve — create ADO Tasks"}</button>}
    </div>
    {result && <div className="approval-result">
      <p className="approval-result-title">{result.dryRun ? "Dry-run preview — nothing was written to Azure DevOps." : "Approval result:"}</p>
      {result.outcomes.map((outcome) => <div className="approval-outcome" key={outcome.repositoryId}>
        <strong>{outcome.repositoryId}</strong>
        {outcome.task && <span> — <a href={outcome.task.url} target="_blank" rel="noreferrer">Task #{outcome.task.id}</a></span>}
        {outcome.alreadyCreated && <span className="outcome-preview"> — already created by an earlier approval, left untouched</span>}
        {outcome.unlinked && <span className="outcome-warn"> — created but NOT linked to the User Story; link it manually</span>}
        {outcome.error && !outcome.unlinked && <span className="outcome-error"> — {outcome.error}</span>}
        {result.dryRun && <span className="outcome-preview"> — would create "{outcome.title}"</span>}
      </div>)}
    </div>}
    <div className="skip-task-creation">
      <h3>{noCodeMission ? "Confirm no-code mission" : "Continue without ADO Tasks"}</h3>
      <p>{noCodeMission ? "This records the verified no-change result without creating tracking items or entering Develop." : "This records developer approval and unlocks local development, but creates no Azure DevOps tracking item."}</p>
      <label><input type="checkbox" checked={skipConfirmed} onChange={(event) => setSkipConfirmed(event.target.checked)} /> I understand that no ADO Tasks will be created.</label>
      <button type="button" className="secondary" onClick={() => void skipTaskCreation()} disabled={!skipConfirmed || submitting || developmentApproval !== null}>
        {developmentApproval?.mode === "tasks-skipped" ? "Approval recorded" : noCodeMission ? "Approve verified no-change mission" : "Approve without creating ADO Tasks"}
      </button>
    </div>
    {developmentApproved && noCodeMission && <p className="story-loaded-note">Mission complete — no repository changes are required.</p>}
    {developmentApproved && !noCodeMission && <div className="step-footer">
      <button type="button" className="primary" onClick={onContinue}>Continue to develop →</button>
    </div>}
  </div>;
}
