import { useState } from "react";
import type { DocumentationFetchBatch, HistoryPolicy, MissionRepository, MissionWorkspace, PlanningMode, PlanningModelOption, Provider, RelatedWorkItemDiscovery, RepositoryStrategy, ScoutReasoningEffort } from "../types";

export function repositoryOptionLabel(repository: MissionRepository): string {
  const provider = repository.scm === "gitlab" ? "GitLab" : "Azure DevOps";
  return `${provider} · ${repository.integrationBranch}`;
}

export function StepStoryAndRepo({
  missionStoryId, onMissionStoryIdChange,
  missionRepositories, missionRepositoryIds, onMissionRepositoryIdsChange,
  missionWorkspaces, storyTitle,
  provider, onProviderChange,
  planningModel, planningModels, modelCatalogLoading, modelCatalogError, onPlanningModelChange,
  scoutReasoningEffort, onScoutReasoningEffortChange,
  planningMode, onPlanningModeChange,
  planningTimeoutMinutes, onPlanningTimeoutMinutesChange,
  documentationUrls, onDocumentationUrlsChange, documentationBatch, documentationFetching, onFetchDocumentation,
  relatedWorkItemIds, onRelatedWorkItemIdsChange, relatedGitLabMergeRequestUrls, onRelatedGitLabMergeRequestUrlsChange, relatedWorkItemDiscovery, relatedWorkItemsDiscovering, onDiscoverRelatedWorkItems,
  historyPolicy, onHistoryPolicyChange,
  repositoryStrategy, onRepositoryStrategyChange,
  proposedRepositoryName, onProposedRepositoryNameChange,
  storyLocked,
  generating, error, onLoadStory, onGeneratePlan,
}: {
  missionStoryId: string;
  onMissionStoryIdChange: (value: string) => void;
  missionRepositories: MissionRepository[];
  missionRepositoryIds: string[];
  onMissionRepositoryIdsChange: (value: string[]) => void;
  missionWorkspaces: Record<string, MissionWorkspace>;
  storyTitle: string;
  provider: Provider;
  onProviderChange: (value: Provider) => void;
  planningModel: string;
  planningModels: PlanningModelOption[];
  modelCatalogLoading: boolean;
  modelCatalogError: string | null;
  onPlanningModelChange: (value: string) => void;
  scoutReasoningEffort: ScoutReasoningEffort;
  onScoutReasoningEffortChange: (value: ScoutReasoningEffort) => void;
  planningMode: PlanningMode;
  onPlanningModeChange: (value: PlanningMode) => void;
  planningTimeoutMinutes: string;
  onPlanningTimeoutMinutesChange: (value: string) => void;
  documentationUrls: string;
  onDocumentationUrlsChange: (value: string) => void;
  documentationBatch: DocumentationFetchBatch | null;
  documentationFetching: boolean;
  onFetchDocumentation: () => void;
  relatedWorkItemIds: string;
  onRelatedWorkItemIdsChange: (value: string) => void;
  relatedGitLabMergeRequestUrls: string;
  onRelatedGitLabMergeRequestUrlsChange: (value: string) => void;
  relatedWorkItemDiscovery: RelatedWorkItemDiscovery | null;
  relatedWorkItemsDiscovering: boolean;
  onDiscoverRelatedWorkItems: () => void;
  historyPolicy: HistoryPolicy;
  onHistoryPolicyChange: (value: HistoryPolicy) => void;
  repositoryStrategy: RepositoryStrategy;
  onRepositoryStrategyChange: (value: RepositoryStrategy) => void;
  proposedRepositoryName: string;
  onProposedRepositoryNameChange: (value: string) => void;
  storyLocked: boolean;
  generating: boolean;
  error: string | null;
  onLoadStory: () => void;
  onGeneratePlan: () => void;
}) {
  const [repositoryCandidate, setRepositoryCandidate] = useState("");
  const needsWorkspace = repositoryStrategy === "existing";
  const hasSelectedCodexModel = planningModels.some((model) => model.id === planningModel);
  const generateDisabled = missionRepositoryIds.length === 0 || generating || (provider === "codex" && (modelCatalogLoading || !hasSelectedCodexModel));
  const generateLabel = generating ? "Planning…" : provider === "codex" && modelCatalogLoading ? "Loading planning models…" : needsWorkspace ? "Generate implementation plan" : "Generate decision plan";
  const defaultTimeoutMinutes = planningMode === "extreme" ? "15" : planningMode === "deep" ? "10" : missionRepositoryIds.length > 1 ? "5" : "3";
  const addRepository = () => {
    if (!repositoryCandidate || missionRepositoryIds.includes(repositoryCandidate)) return;
    onMissionRepositoryIdsChange([...missionRepositoryIds, repositoryCandidate]);
    setRepositoryCandidate("");
  };
  const moveRepository = (index: number, offset: number) => {
    const next = [...missionRepositoryIds];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onMissionRepositoryIdsChange(next);
  };

  return <div className="step-panel">
    <div className="primary-fields">
      <label>ADO work item<input value={missionStoryId} onChange={(event) => onMissionStoryIdChange(event.target.value)} placeholder="Work item ID or URL" readOnly={storyLocked} /></label>
      <label>Repositories<input list="mission-repositories" value={repositoryCandidate} onChange={(event) => setRepositoryCandidate(event.target.value)} placeholder="Add configured repository" /><datalist id="mission-repositories">{missionRepositories.map((repository) => <option key={repository.id} value={repository.id}>{repositoryOptionLabel(repository)}</option>)}</datalist></label>
      <button type="button" onClick={addRepository} disabled={!repositoryCandidate}>Add repository</button>
      {!storyLocked && <button type="button" onClick={onLoadStory}>Load story</button>}
    </div>

    {storyTitle && <p className="story-loaded-note">✓ {storyTitle}</p>}
    {error && <p className="plan-error">{error}</p>}
    {generating && <div className="activity-line" role="status">
      <span className="activity-spinner" aria-hidden="true" />
      <span><strong>Planning in progress</strong><br />The planning agent is reading the selected repositories and building a coordinated implementation plan.</span>
    </div>}

    {missionRepositoryIds.length > 0 && <div className="repository-selection-list">
      {missionRepositoryIds.map((repositoryId, index) => {
        const repository = missionRepositories.find((entry) => entry.id === repositoryId);
        const workspace = missionWorkspaces[repositoryId];
        return <div className="repository-selection-row" key={repositoryId}>
          <span><strong>{repositoryId}</strong>{index === 0 ? " · first" : ""}<br /><code>{workspace?.branch ?? "resolving branch…"}</code> → {repository?.integrationBranch}{repository ? ` · ${repository.scm === "gitlab" ? "GitLab" : "Azure DevOps"}` : ""}</span>
          <span>
            <button type="button" className="link-button" onClick={() => moveRepository(index, -1)} disabled={index === 0}>↑</button>
            <button type="button" className="link-button" onClick={() => moveRepository(index, 1)} disabled={index === missionRepositoryIds.length - 1}>↓</button>
            <button type="button" className="link-button" onClick={() => onMissionRepositoryIdsChange(missionRepositoryIds.filter((id) => id !== repositoryId))}>Remove</button>
          </span>
        </div>;
      })}
    </div>}
    <section className="related-work-items">
      <label><span>Related ADO work items</span><input value={relatedWorkItemIds} onChange={(event) => onRelatedWorkItemIdsChange(event.target.value)} placeholder="157105, 159636" /><small>Optional. Mission Control reads their linked merged PRs and bounded reference context.</small></label>
      <label><span>Related GitLab merge requests</span><textarea value={relatedGitLabMergeRequestUrls} onChange={(event) => onRelatedGitLabMergeRequestUrlsChange(event.target.value)} rows={2} placeholder="Optional GitLab MR URL, one per line" /><small>Optional fallback when an ADO work item does not expose a GitLab MR link. Only configured GitLab repositories are read.</small></label>
      <button type="button" className="secondary" onClick={onDiscoverRelatedWorkItems} disabled={relatedWorkItemsDiscovering || (relatedWorkItemIds.trim() === "" && relatedGitLabMergeRequestUrls.trim() === "")}>{relatedWorkItemsDiscovering ? "Discovering…" : "Discover related repositories"}</button>
      {relatedWorkItemDiscovery && <div className="related-work-item-results">
        <p className="story-loaded-note">✓ Read {relatedWorkItemDiscovery.relatedWorkItems.map((item) => `#${item.id} ${item.title}`).join(" · ")}</p>
        {relatedWorkItemDiscovery.proposedRepositories.map((candidate) => <div key={candidate.repositoryId} className="repository-selection-row">
          <span><strong>{candidate.repositoryId}</strong><br /><small>High confidence: {candidate.evidence.map((entry) => `#${entry.workItemId} ${entry.scm === "gitlab" ? "GitLab MR" : "ADO PR"} ${entry.scm === "gitlab" ? "!" : ""}${entry.pullRequestId} → ${entry.targetBranch}`).join("; ")}</small></span>
          <button type="button" className="secondary" disabled={missionRepositoryIds.includes(candidate.repositoryId)} onClick={() => onMissionRepositoryIdsChange([...missionRepositoryIds, candidate.repositoryId])}>{missionRepositoryIds.includes(candidate.repositoryId) ? "Added" : "Add repository"}</button>
        </div>)}
        {relatedWorkItemDiscovery.proposedRepositories.length === 0 && <p className="mission-meta">No linked merged ADO PR or GitLab MR matched a configured repository and its integration branch.</p>}
        {relatedWorkItemDiscovery.unmappedPullRequests.map((pullRequest) => <p className="mission-meta" key={`${pullRequest.scm}-${pullRequest.workItemId}-${pullRequest.pullRequestId}`}>{pullRequest.scm === "gitlab" ? "GitLab MR" : "ADO PR"} {pullRequest.scm === "gitlab" ? "!" : ""}{pullRequest.pullRequestId} from #{pullRequest.workItemId} was not proposed: {pullRequest.reason}.</p>)}
      </div>}
    </section>
    {needsWorkspace && missionRepositoryIds.some((repositoryId) => missionWorkspaces[repositoryId]?.ready) && <p className="mission-meta">Existing mission worktrees shown above will be reused only for read-only planning. Develop always enforces its own isolated, push-disabled worktree.</p>}
    {!needsWorkspace && missionRepositoryIds.length > 0 && <p className="mission-meta">Repository decision modes support only one repository. Multi-repository missions use existing repositories.</p>}

    <details className="advanced" open>
      <summary>Advanced options — provider, planning depth, history</summary>
      <div className="advanced-grid">
        <label>Repository approach<select value={repositoryStrategy} onChange={(event) => onRepositoryStrategyChange(event.target.value as RepositoryStrategy)} disabled={missionRepositoryIds.length > 1}><option value="evaluate">Evaluate existing vs new</option><option value="existing">Plan existing repositories</option><option value="new-from-reference">Plan a new repository from reference</option></select></label>
        {repositoryStrategy === "new-from-reference" && <label>Proposed repository name<input value={proposedRepositoryName} onChange={(event) => onProposedRepositoryNameChange(event.target.value)} placeholder="Enter proposed repository name" /></label>}
        <label>Provider<select value={provider} onChange={(event) => onProviderChange(event.target.value as Provider)}><option value="codex">Codex CLI</option><option value="claude">Claude Code CLI</option></select></label>
        {provider === "codex" && <label>Codex model<select value={planningModel} onChange={(event) => onPlanningModelChange(event.target.value)} disabled={modelCatalogLoading || planningModels.length === 0}>
          <option value="" disabled>{modelCatalogLoading ? "Loading Codex models…" : modelCatalogError ?? "Select an available Codex model"}</option>
          {!modelCatalogLoading && planningModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}{model.retirementNotice ? " — retirement notice" : ""}</option>)}
        </select><small>{modelCatalogError ?? "Available to the signed-in Codex account. The selected model is used for planning and plan revisions."}</small></label>}
        {provider === "codex" && <label>Scout reasoning effort<select value={scoutReasoningEffort} onChange={(event) => onScoutReasoningEffortChange(event.target.value as ScoutReasoningEffort)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><small>Applies only to the initial repository scouts.</small></label>}
        <label>Planning mode<select value={planningMode} onChange={(event) => onPlanningModeChange(event.target.value as PlanningMode)}><option value="fast">Fast — targeted inspection</option><option value="deep">Deep — wider source inspection</option><option value="extreme">Extreme deep — source + Git history</option></select></label>
        <label>Planning timeout<select value={planningTimeoutMinutes || defaultTimeoutMinutes} onChange={(event) => onPlanningTimeoutMinutesChange(event.target.value)}><option value="3">3 minutes</option><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="15">15 minutes</option></select><small>Per scout and coordinator. Deep defaults to 10 minutes; Extreme deep defaults to 15 minutes.</small></label>
        <label>History<select value={historyPolicy} onChange={(event) => onHistoryPolicyChange(event.target.value as HistoryPolicy)}><option value="none">None — source baseline only</option><option value="targeted-precedents">Targeted precedents</option></select></label>
        <label>External documentation URLs<textarea value={documentationUrls} onChange={(event) => onDocumentationUrlsChange(event.target.value)} rows={3} placeholder={"Optional allowlisted HTTPS URLs\nOne URL per line, maximum 3"} /><small>Fetched by the harness before planning; agents retain no network access.</small></label>
        <div>
          <button type="button" className="secondary" onClick={onFetchDocumentation} disabled={documentationFetching || documentationUrls.trim() === ""}>{documentationFetching ? "Fetching…" : "Fetch documentation"}</button>
          {documentationBatch?.outcomes.map((outcome) => <p className={outcome.status === "ok" ? "story-loaded-note" : "plan-error"} key={outcome.requestedUrl}>
            {outcome.status === "ok" ? `✓ ${outcome.hostname} · ${outcome.size} bytes` : `Rejected: ${outcome.reason}`}
          </p>)}
        </div>
      </div>
    </details>

    <div className="step-footer">
      <button className="primary" onClick={onGeneratePlan} disabled={generateDisabled}>{generateLabel} →</button>
    </div>
  </div>;
}
