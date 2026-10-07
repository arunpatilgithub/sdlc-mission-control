import { useEffect, useState } from "react";
import type { DocumentationFetchBatch, HistoryPolicy, MissionRepository, MissionWorkspace, PlanJob, PlanningMode, PlanningModelOption, Provider, RelatedWorkItemDiscovery, RepositoryStrategy, ScoutReasoningEffort, Story } from "../types";
import { parseWorkItemId, responseError, textFromHtml } from "../types";
import { StepStoryAndRepo } from "./StepStoryAndRepo";
import { StepReviewPlan } from "./StepReviewPlan";
import { RepoScopeEditor } from "./RepoScopeEditor";
import { StepDevelop } from "./StepDevelop";
import type { MissionRunJobView } from "../develop-view";
import { MissionPipeline } from "./MissionPipeline";
import { canDevelop, type UserStageId } from "../mission-pipeline";

type Step = 1 | 2 | 3 | 4;

const TESTING_DEFAULT_MISSION = {
  workItemId: "163732",
  repositoryIds: ["Publisher.MicroService.PostbackHandler", "Publisher.Portal", "publisher.documentation"],
  relatedWorkItemIds: "",
  relatedGitLabMergeRequestUrls: "",
  planningTimeoutMinutes: "10",
};
const DEFAULT_CODEX_PLANNING_MODEL = "gpt-5.6-sol";

export function defaultPlanningModel(provider: Provider, models: PlanningModelOption[] = []): string {
  if (provider !== "codex") return "";
  return models.find((model) => model.id === DEFAULT_CODEX_PLANNING_MODEL)?.id ?? models[0]?.id ?? DEFAULT_CODEX_PLANNING_MODEL;
}

export function scoutReasoningEffortRequest(provider: Provider, scoutReasoningEffort: ScoutReasoningEffort): { scoutReasoningEffort?: ScoutReasoningEffort } {
  return provider === "codex" ? { scoutReasoningEffort } : {};
}

export function PlanReview({ selectedStory, onStoryLoaded, onResetMission, onPlanFinished }: {
  selectedStory: Story | null;
  onStoryLoaded: (story: Story) => void;
  onResetMission: () => void;
  onPlanFinished: () => void;
}) {
  const [step, setStep] = useState<Step>(1);
  const [missionStoryId, setMissionStoryId] = useState(TESTING_DEFAULT_MISSION.workItemId);
  const [missionRepositories, setMissionRepositories] = useState<MissionRepository[]>([]);
  const [missionRepositoryIds, setMissionRepositoryIds] = useState<string[]>(TESTING_DEFAULT_MISSION.repositoryIds);
  const [missionWorkspaces, setMissionWorkspaces] = useState<Record<string, MissionWorkspace>>({});
  const [planJob, setPlanJob] = useState<PlanJob | null>(null);
  const [developJob, setDevelopJob] = useState<MissionRunJobView | null>(null);
  const [approvedPathsByRepository, setApprovedPathsByRepository] = useState<Record<string, string[]>>({});
  const [provider, setProvider] = useState<Provider>("codex");
  const [planningModel, setPlanningModel] = useState("");
  const [planningModels, setPlanningModels] = useState<PlanningModelOption[]>([]);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [scoutReasoningEffort, setScoutReasoningEffort] = useState<ScoutReasoningEffort>("low");
  const [planningMode, setPlanningMode] = useState<PlanningMode>("fast");
  const [planningTimeoutMinutes, setPlanningTimeoutMinutes] = useState(TESTING_DEFAULT_MISSION.planningTimeoutMinutes);
  const [documentationUrls, setDocumentationUrls] = useState("");
  const [documentationBatch, setDocumentationBatch] = useState<DocumentationFetchBatch | null>(null);
  const [documentationFetching, setDocumentationFetching] = useState(false);
  const [relatedWorkItemIds, setRelatedWorkItemIds] = useState(TESTING_DEFAULT_MISSION.relatedWorkItemIds);
  const [relatedGitLabMergeRequestUrls, setRelatedGitLabMergeRequestUrls] = useState(TESTING_DEFAULT_MISSION.relatedGitLabMergeRequestUrls);
  const [relatedWorkItemDiscovery, setRelatedWorkItemDiscovery] = useState<RelatedWorkItemDiscovery | null>(null);
  const [relatedWorkItemsDiscovering, setRelatedWorkItemsDiscovering] = useState(false);
  const [historyPolicy, setHistoryPolicy] = useState<HistoryPolicy>("none");
  const [repositoryStrategy, setRepositoryStrategy] = useState<RepositoryStrategy>("existing");
  const [proposedRepositoryName, setProposedRepositoryName] = useState("");
  const [storyTitle, setStoryTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [planStarting, setPlanStarting] = useState(false);
  const [developError, setDevelopError] = useState<string | null>(null);
  const [developStarting, setDevelopStarting] = useState(false);

  useEffect(() => {
    const planId = window.localStorage.getItem("mission-control.active-plan");
    if (!planId) return;
    fetch(`/api/missions/plans/${planId}`).then(async (response) => {
      if (!response.ok) return;
      const job = (await response.json() as { job: PlanJob }).job;
      if (job.status === "failed") {
        window.localStorage.removeItem("mission-control.active-plan");
        return;
      }
      setPlanJob(job);
      setMissionStoryId(String(job.packet.story.id));
      setStoryTitle(job.packet.story.title);
      setMissionRepositoryIds(job.repositoryIds ?? [job.repositoryId]);
      setProvider(job.provider);
      setPlanningModel(job.model ?? "");
      setScoutReasoningEffort(job.scoutReasoningEffort ?? "low");
      setPlanningMode(job.packet.mode);
      setPlanningTimeoutMinutes(String(job.planningTimeoutSeconds / 60));
      setApprovedPathsByRepository(job.approvedPathsByRepository ?? (job.approvedPlannedPaths ? { [job.repositoryId]: job.approvedPlannedPaths } : {}));
      setStep(job.developmentApproval ? 4 : job.approvedPathsByRepository ? 3 : 2);
      if (!job.developRunId) return;
      const developResponse = await fetch(`/api/missions/develop-runs/${job.developRunId}`);
      if (developResponse.ok) {
        setDevelopJob((await developResponse.json() as { job: MissionRunJobView }).job);
        setStep(4);
      }
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selectedStory) return;
    const useTestingDefaults = selectedStory.id === Number(TESTING_DEFAULT_MISSION.workItemId);
    setMissionStoryId(String(selectedStory.id));
    setStoryTitle(selectedStory.title);
    setPlanJob(null);
    setDevelopJob(null);
    setApprovedPathsByRepository({});
    setScoutReasoningEffort("low");
    setMissionRepositoryIds(useTestingDefaults ? TESTING_DEFAULT_MISSION.repositoryIds : []);
    setPlanningTimeoutMinutes(useTestingDefaults ? TESTING_DEFAULT_MISSION.planningTimeoutMinutes : "");
    setDocumentationUrls("");
    setDocumentationBatch(null);
    setRelatedWorkItemIds(useTestingDefaults ? TESTING_DEFAULT_MISSION.relatedWorkItemIds : "");
    setRelatedGitLabMergeRequestUrls(useTestingDefaults ? TESTING_DEFAULT_MISSION.relatedGitLabMergeRequestUrls : "");
    setRelatedWorkItemDiscovery(null);
    setDevelopError(null);
    setError(null);
    setRepositoryStrategy(useTestingDefaults ? "existing" : "evaluate");
    setStep(1);
  }, [selectedStory?.id]);

  useEffect(() => {
    fetch("/api/missions/repositories")
      .then(async (response) => response.ok ? (await response.json() as { repositories: MissionRepository[] }).repositories : [])
      .then(setMissionRepositories)
      .catch(() => setMissionRepositories([]));
  }, []);

  useEffect(() => {
    if (provider !== "codex") {
      setPlanningModel("");
      setPlanningModels([]);
      setModelCatalogLoading(false);
      setModelCatalogError(null);
      return;
    }
    let cancelled = false;
    setModelCatalogLoading(true);
    setModelCatalogError(null);
    setPlanningModels([]);
    setPlanningModel("");
    fetch("/api/missions/models/codex")
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response, "Unable to load Codex models."));
        return (await response.json() as { models: PlanningModelOption[] }).models;
      })
      .then((models) => {
        if (cancelled) return;
        setPlanningModels(models);
        setPlanningModel((current) => models.some((model) => model.id === current)
          ? current
          : defaultPlanningModel("codex", models));
        if (models.length === 0) setModelCatalogError("No Codex planning models are available for the signed-in account.");
      })
      .catch((cause) => {
        if (!cancelled) {
          setPlanningModels([]);
          setPlanningModel("");
          setModelCatalogError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => { if (!cancelled) setModelCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [provider]);

  useEffect(() => {
    const workItemId = parseWorkItemId(missionStoryId);
    if (missionRepositoryIds.length === 0 || workItemId === null || workItemId <= 0) { setMissionWorkspaces({}); return; }
    void Promise.all(missionRepositoryIds.map(async (repositoryId) => {
      const response = await fetch(`/api/missions/repositories/${encodeURIComponent(repositoryId)}/workspaces/${workItemId}`);
      return [repositoryId, response.ok ? await response.json() as MissionWorkspace : null] as const;
    })).then((entries) => setMissionWorkspaces(Object.fromEntries(entries.filter((entry): entry is readonly [string, MissionWorkspace] => entry[1] !== null))))
      .catch(() => setMissionWorkspaces({}));
    if (missionRepositoryIds.length > 1) setRepositoryStrategy("existing");
  }, [missionRepositoryIds.join("\0"), missionStoryId]);

  useEffect(() => {
    if (planJob?.status !== "running" && planJob?.reviewStatus !== "running" && planJob?.behavioralReviewStatus !== "running") return;
    const timer = window.setInterval(() => {
      fetch(`/api/missions/plans/${planJob.id}`).then(async (response) => {
        const body = await response.json() as { job?: PlanJob; error?: string };
        if (response.ok && body.job) {
          setPlanJob(body.job);
          if (body.job.status === "failed") window.localStorage.removeItem("mission-control.active-plan");
          // The run just left "running", so its cost is now on disk and history can reload.
          if (body.job.status !== "running") onPlanFinished();
          return;
        }
        window.localStorage.removeItem("mission-control.active-plan");
        setPlanJob((current) => current ? { ...current, status: "failed", completedAt: new Date().toISOString(), error: body.error ?? "Planning job is no longer available. Start a new plan run." } : current);
      }).catch(() => {
        window.localStorage.removeItem("mission-control.active-plan");
        setPlanJob((current) => current ? { ...current, status: "failed", completedAt: new Date().toISOString(), error: "Unable to check the planning job. Start a new plan run." } : current);
      });
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [planJob?.id, planJob?.status, planJob?.reviewStatus, planJob?.behavioralReviewStatus]);

  useEffect(() => {
    if (developJob?.status !== "running" && developJob?.scopeReviewStatus !== "running") return;
    const timer = window.setInterval(() => {
      fetch(`/api/missions/develop-runs/${developJob.id}`).then(async (response) => {
        const body = await response.json() as { job?: MissionRunJobView; error?: string };
        if (response.ok && body.job) {
          setDevelopJob(body.job);
          return;
        }
        setDevelopJob((current) => current ? { ...current, status: "failed", error: body.error ?? "Develop run is no longer available. Start a new run." } : current);
      }).catch(() => setDevelopJob((current) => current ? { ...current, status: "failed", error: "Unable to check the develop run. Start a new run." } : current));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [developJob?.id, developJob?.status, developJob?.scopeReviewStatus]);

  const loadStoryTitle = async () => {
    const workItemId = parseWorkItemId(missionStoryId);
    if (workItemId === null || workItemId <= 0) { setError("Enter a valid ADO work item ID or URL."); return; }
    setError(null);
    try {
      const response = await fetch(`/api/ado/stories/${workItemId}`);
      if (!response.ok) throw new Error(await responseError(response, "Unable to load User Story."));
      const story = (await response.json()).story as Story;
      setStoryTitle(story.title);
      onStoryLoaded(story);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const startPlan = async (priorReviewFeedback?: string) => {
    if (missionRepositoryIds.length === 0) return;
    if (provider === "codex" && planningModel === "") { setError("Select an available Codex model before starting planning."); return; }
    const workItemId = parseWorkItemId(missionStoryId);
    if (workItemId === null || workItemId <= 0) { setError("Enter a valid ADO work item ID or URL."); return; }
    const defaultTimeoutMinutes = planningMode === "extreme" ? 15 : planningMode === "deep" ? 10 : missionRepositoryIds.length > 1 ? 5 : 3;
    const timeoutMinutes = planningTimeoutMinutes === "" ? defaultTimeoutMinutes : Number(planningTimeoutMinutes);
    if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 15) {
      setError("Planning timeout must be a whole number from 1 to 15 minutes.");
      return;
    }
    if (documentationUrls.trim() !== "" && !documentationBatch) {
      setError("Fetch the entered documentation URLs before generating the plan.");
      return;
    }
    if ((relatedWorkItemIds.trim() !== "" || relatedGitLabMergeRequestUrls.trim() !== "") && !relatedWorkItemDiscovery) {
      setError("Discover the entered related work items or GitLab merge requests before generating the plan.");
      return;
    }
    setError(null);
    setPlanStarting(true);
    try {
      const phase = repositoryStrategy === "existing" ? "implementation-plan" : "repository-decision";
      const response = await fetch("/api/missions/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workItemId,
          repositoryIds: missionRepositoryIds,
          worktreePaths: Object.fromEntries(Object.entries(missionWorkspaces).flatMap(([id, workspace]) => workspace.worktreePath ? [[id, workspace.worktreePath]] : [])),
          provider,
          model: provider === "codex" ? planningModel : undefined,
          ...scoutReasoningEffortRequest(provider, scoutReasoningEffort),
          mode: planningMode,
          planningTimeoutSeconds: timeoutMinutes * 60,
          documentationFetchIds: documentationBatch ? [documentationBatch.id] : [],
          relatedWorkItemDiscoveryId: relatedWorkItemDiscovery?.id,
          historyPolicy,
          repositoryStrategy,
          phase,
          proposedRepositoryName,
          priorReviewFeedback,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to start the planning agent."));
      const payload = await response.json() as { job: PlanJob };
      setPlanJob(payload.job);
      window.localStorage.setItem("mission-control.active-plan", payload.job.id);
      setDevelopJob(null);
      setApprovedPathsByRepository({});
      setStep(2);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPlanStarting(false);
    }
  };

  const generatePlan = () => startPlan();

  const fetchDocumentation = async () => {
    const workItemId = parseWorkItemId(missionStoryId);
    const urls = documentationUrls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
    if (workItemId === null || workItemId <= 0) { setError("Enter a valid ADO work item before fetching documentation."); return; }
    if (urls.length === 0 || urls.length > 3) { setError("Enter between 1 and 3 documentation URLs, one per line."); return; }
    setDocumentationFetching(true);
    setError(null);
    try {
      const response = await fetch("/api/missions/documentation/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workItemId, urls }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to fetch documentation."));
      setDocumentationBatch((await response.json() as { batch: DocumentationFetchBatch }).batch);
    } catch (cause) {
      setDocumentationBatch(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDocumentationFetching(false);
    }
  };

  const discoverRelatedWorkItems = async () => {
    const workItemId = parseWorkItemId(missionStoryId);
    const ids = relatedWorkItemIds.split(/[\s,]+/).map((value) => parseWorkItemId(value)).filter((value): value is number => value !== null);
    if (workItemId === null || workItemId <= 0) { setError("Enter a valid ADO work item before discovering related work."); return; }
    if (relatedWorkItemIds.trim() !== "" && (ids.length === 0 || ids.length !== relatedWorkItemIds.split(/[\s,]+/).filter(Boolean).length)) { setError("Enter related ADO work-item IDs or URLs, separated by commas or lines."); return; }
    if (ids.length === 0 && relatedGitLabMergeRequestUrls.trim() === "") { setError("Enter a related ADO work item or GitLab merge-request URL."); return; }
    setRelatedWorkItemsDiscovering(true);
    setError(null);
    try {
      const response = await fetch("/api/missions/related-work-items/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workItemId, relatedWorkItemIds: ids, relatedGitLabMergeRequestUrls: relatedGitLabMergeRequestUrls.split(/\n+/).map((value) => value.trim()).filter(Boolean) }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to discover related work items."));
      setRelatedWorkItemDiscovery((await response.json() as { discovery: RelatedWorkItemDiscovery }).discovery);
    } catch (cause) {
      setRelatedWorkItemDiscovery(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRelatedWorkItemsDiscovering(false);
    }
  };

  const requestReview = async () => {
    if (!planJob) return;
    setError(null);
    try {
      const response = await fetch(`/api/missions/plans/${planJob.id}/review`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response, "Unable to start the review."));
      setPlanJob((await response.json()).job);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const submitPlanAnswers = async (answers: Array<{ question: string; answer: string; evidence?: string }>) => {
    if (!planJob) return;
    setError(null);
    try {
      const response = await fetch(`/api/missions/plans/${planJob.id}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to revise the plan with these answers."));
      setPlanJob((await response.json() as { job: PlanJob }).job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const canReviewPlan = planJob !== null;
  const behavioralClaimsBlocking = Object.values(planJob?.behavioralClaimsByRepository ?? {}).flat()
    .some((claim) => claim.status === "unverified" || claim.status === "refuted");
  const canApprove = planJob?.status === "completed" && planJob.repoScope !== null && planJob.approvedPlannedPaths !== null
    && planJob.behavioralReviewStatus !== "running" && planJob.planRevisionStatus !== "escalated" && planJob.planRevisionStatus !== "failed" && !behavioralClaimsBlocking;
  const canOpenDevelop = canDevelop(planJob, developJob);
  const implementationRepositoryIds = planJob?.repositoryIds.filter((repositoryId) =>
    (planJob.approvedPathsByRepository?.[repositoryId]?.length ?? 0) > 0,
  ) ?? [];
  const noCodeMission = Boolean(planJob?.developmentApproval && planJob.repositoryIds.length > 0 && implementationRepositoryIds.length === 0);

  const resetMissionWorkspace = () => {
    window.localStorage.removeItem("mission-control.active-plan");
    setPlanJob(null);
    setDevelopJob(null);
    setApprovedPathsByRepository({});
    setMissionStoryId(TESTING_DEFAULT_MISSION.workItemId);
    setMissionRepositoryIds(TESTING_DEFAULT_MISSION.repositoryIds);
    setMissionWorkspaces({});
    setStoryTitle("");
    setProvider("codex");
    setPlanningModel(defaultPlanningModel("codex"));
    setPlanningMode("fast");
    setPlanningTimeoutMinutes(TESTING_DEFAULT_MISSION.planningTimeoutMinutes);
    setDocumentationUrls("");
    setDocumentationBatch(null);
    setRelatedWorkItemIds(TESTING_DEFAULT_MISSION.relatedWorkItemIds);
    setRelatedGitLabMergeRequestUrls(TESTING_DEFAULT_MISSION.relatedGitLabMergeRequestUrls);
    setRelatedWorkItemDiscovery(null);
    setHistoryPolicy("none");
    setRepositoryStrategy("existing");
    setProposedRepositoryName("");
    setDevelopError(null);
    setError(null);
    setStep(1);
    onResetMission();
  };

  const navigateToStage = (stage: UserStageId) => {
    if (stage === "plan" && planJob?.status === "failed") {
      window.localStorage.removeItem("mission-control.active-plan");
      setPlanJob(null);
      setDevelopJob(null);
      setApprovedPathsByRepository({});
      setError(null);
      setStep(1);
    } else if (stage === "plan") setStep(1);
    else if (stage === "review" && canReviewPlan) setStep(2);
    else if (stage === "approve" && canApprove) setStep(3);
    else if (stage === "complete" && noCodeMission) setStep(2);
    else if ((stage === "develop" || stage === "verify" || stage === "publish" || stage === "complete") && canOpenDevelop) setStep(4);
  };

  const approvePlannedPaths = async (plannedPathsByRepository: Record<string, string[]>, scopeOverrideJustifications?: Record<string, string>) => {
    if (!planJob) return;
    setError(null);
    try {
      const response = await fetch(`/api/missions/plans/${planJob.id}/scope`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plannedPathsByRepository, scopeOverrideJustifications }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to approve the planned write boundary."));
      const job = (await response.json() as { job: PlanJob }).job;
      setPlanJob(job);
      setApprovedPathsByRepository(job.approvedPathsByRepository ?? {});
      setStep(3);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const startDevelop = async (discardStaleWorktree = false) => {
    if (!planJob) return;
    setDevelopError(null);
    setDevelopStarting(true);
    try {
      const response = await fetch(`/api/missions/plans/${planJob.id}/develop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discardStaleWorktree }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to start the develop run."));
      setDevelopJob((await response.json() as { job: MissionRunJobView }).job);
    } catch (cause) {
      setDevelopError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDevelopStarting(false);
    }
  };

  const discardMission = async () => {
    if (!planJob) return;
    setDevelopError(null);
    try {
      const response = await fetch(`/api/missions/plans/${planJob.id}/discard`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response, "Unable to discard the mission worktrees."));
      const { discarded } = await response.json() as { discarded: Array<{ repositoryId: string; removed: string | null; skipped: string | null }> };
      const skipped = discarded.filter((entry) => entry.skipped);
      if (skipped.length > 0) {
        // A worktree could not be safely torn down (absolute guard). Surface it and stay so the
        // developer can resolve it before re-planning, rather than silently leaving a conflict.
        setDevelopError(`Could not fully discard: ${skipped.map((entry) => `${entry.repositoryId} — ${entry.skipped}`).join("; ")}`);
        return;
      }
      // Torn down cleanly. Keep the story selection and return to the planning step to re-plan.
      window.localStorage.removeItem("mission-control.active-plan");
      setPlanJob(null);
      setDevelopJob(null);
      setApprovedPathsByRepository({});
      setMissionWorkspaces({});
      setStep(1);
    } catch (cause) {
      setDevelopError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return <section className="mission-panel">
    <div className="story-context">
      <p className="eyebrow">{selectedStory ? `${selectedStory.workItemType} · #${selectedStory.id}` : "Mission workspace"}</p>
      <h2>{selectedStory?.title ?? (storyTitle || "Select a Publisher backlog item")}</h2>
      <p>{selectedStory ? textFromHtml(selectedStory.description) || "No description provided." : "Choose a story from the backlog or enter an ADO work item below to prepare a mission."}</p>
      {selectedStory && <div className="story-context-meta">
        <span>{selectedStory.state}</span>
        <span>{selectedStory.assignedTo ?? "Unassigned"}</span>
        {selectedStory.tags.map((tag) => <span key={tag}>{tag}</span>)}
      </div>}
    </div>

    <MissionPipeline
      plan={planJob}
      develop={developJob}
      featureBranch={developJob?.result?.develop?.branch ?? missionWorkspaces[missionRepositoryIds[0] ?? ""]?.branch ?? null}
      onNavigate={navigateToStage}
      onResetMission={resetMissionWorkspace}
      resetDisabled={planJob?.status === "running" || developJob?.status === "running"}
    />

    {step === 1 && <StepStoryAndRepo
      missionStoryId={missionStoryId} onMissionStoryIdChange={setMissionStoryId}
      missionRepositories={missionRepositories} missionRepositoryIds={missionRepositoryIds} onMissionRepositoryIdsChange={setMissionRepositoryIds}
      missionWorkspaces={missionWorkspaces} storyTitle={storyTitle}
      provider={provider} onProviderChange={setProvider}
      planningModel={planningModel} planningModels={planningModels} modelCatalogLoading={modelCatalogLoading} modelCatalogError={modelCatalogError} onPlanningModelChange={setPlanningModel}
      scoutReasoningEffort={scoutReasoningEffort} onScoutReasoningEffortChange={setScoutReasoningEffort}
      planningMode={planningMode} onPlanningModeChange={setPlanningMode}
      planningTimeoutMinutes={planningTimeoutMinutes} onPlanningTimeoutMinutesChange={setPlanningTimeoutMinutes}
      documentationUrls={documentationUrls} onDocumentationUrlsChange={(value) => { setDocumentationUrls(value); setDocumentationBatch(null); }}
      documentationBatch={documentationBatch} documentationFetching={documentationFetching} onFetchDocumentation={() => void fetchDocumentation()}
      relatedWorkItemIds={relatedWorkItemIds} onRelatedWorkItemIdsChange={(value) => { setRelatedWorkItemIds(value); setRelatedWorkItemDiscovery(null); }}
      relatedGitLabMergeRequestUrls={relatedGitLabMergeRequestUrls} onRelatedGitLabMergeRequestUrlsChange={(value) => { setRelatedGitLabMergeRequestUrls(value); setRelatedWorkItemDiscovery(null); }}
      relatedWorkItemDiscovery={relatedWorkItemDiscovery} relatedWorkItemsDiscovering={relatedWorkItemsDiscovering} onDiscoverRelatedWorkItems={() => void discoverRelatedWorkItems()}
      historyPolicy={historyPolicy} onHistoryPolicyChange={setHistoryPolicy}
      repositoryStrategy={repositoryStrategy} onRepositoryStrategyChange={setRepositoryStrategy}
      proposedRepositoryName={proposedRepositoryName} onProposedRepositoryNameChange={setProposedRepositoryName}
      storyLocked={selectedStory !== null}
      generating={planStarting || planJob?.status === "running"} error={error}
      onLoadStory={() => void loadStoryTitle()} onGeneratePlan={() => void generatePlan()}
    />}

    {step === 2 && planJob && <StepReviewPlan
      planJob={planJob}
      scopeError={error}
      onBack={() => setStep(1)}
      onContinue={(plannedPaths, scopeOverrideJustifications) => approvePlannedPaths(plannedPaths, scopeOverrideJustifications)}
      onRequestReview={() => void requestReview()}
      onRegenerateWithFeedback={(feedback) => void startPlan(feedback)}
      onSubmitAnswers={(answers) => void submitPlanAnswers(answers)}
    />}

    {step === 3 && planJob?.repoScope && <RepoScopeEditor
      planJobId={planJob.id}
      parentStoryId={planJob.packet.story.id}
      storyTitle={storyTitle || planJob.packet.story.title}
      repositoryIds={implementationRepositoryIds}
      noCodeMission={noCodeMission}
      repoScope={planJob.repoScope}
      planOutput={planJob.output}
      developmentApproval={planJob.developmentApproval}
      onApprovalRecorded={(approval) => setPlanJob((current) => current ? { ...current, developmentApproval: approval } : current)}
      onBack={() => setStep(2)}
      onContinue={() => setStep(4)}
    />}

    {step === 4 && planJob && <StepDevelop
      approvedPathsByRepository={approvedPathsByRepository}
      executionOrder={planJob.executionOrder}
      job={developJob}
      starting={developStarting}
      error={developError}
      onStart={() => void startDevelop()}
      onDiscardAndReRun={() => void startDevelop(true)}
      onDiscardMission={() => void discardMission()}
      onPublished={(publication) => setDevelopJob((current) => {
        if (!current) return current;
        const run = current.runsByRepository[publication.repositoryId];
        return {
          ...current,
          publication: current.currentRepositoryId === publication.repositoryId ? publication : current.publication,
          runsByRepository: run ? {
            ...current.runsByRepository,
            [publication.repositoryId]: { ...run, publication },
          } : current.runsByRepository,
        };
      })}
      onJobUpdate={setDevelopJob}
      onBack={() => setStep(3)}
      onStartNewPlan={resetMissionWorkspace}
    />}
  </section>;
}
