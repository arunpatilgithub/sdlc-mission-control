import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AzureDevOpsCli } from "../ado/azure-devops-cli.js";
import { discoverRelatedWorkItems, loadRelatedWorkItemDiscovery } from "../ado/related-work-item-discovery.js";
import { GitLabCli } from "../gitlab/gitlab-cli.js";
import { EXECUTION_DOSSIER_CONTRACT_VERSION, hasBlockingPreDevelopDecision, hasBlockingPublishDecision, implementationRepositoryIds, injectResolvedContractsIntoDossier, parseScoutReasoningEffort, PlanningAgent, resolveSharedContracts, type PlanJob, type Provider } from "../agent/planning-agent.js";
import type { HistoryPolicy, PlanningMode, PlanningPhase, RepositoryStrategy, SharedContract } from "../agent/mission-packet.js";
import { approveMission, createdTasksFrom, type RepoTaskRequest } from "../agent/mission-approval.js";
import { citedReferencePaths, deferredWorkForPullRequest, developReferenceFiles, discardMissionWorktree, plannedBaselineError, siblingReferencePaths } from "../agent/develop-agent.js";
import { resolveVerificationPolicy } from "../agent/verification-policy.js";
import { mergeEligibilityError, mergePublishedMergeRequest, publishMission } from "../agent/mission-publish.js";
import { readPlanningHistory } from "../agent/planning-history.js";
import { azureDevOpsProjectFromRemote, getRepository, loadTeamConfig, resolveFeatureBranchName, type RepositoryConfig } from "../config/team-config.js";
import {
  DEFAULT_LEDGER_LIMITS,
  DEFAULT_ORCHESTRATOR_CONFIG,
  hasAcceptedPublishReview,
  isMissionPublishReady,
  MissionRunStore,
  type MissionRunJob,
} from "../mission/run-store.js";
import { isScopeExpansionAllowed } from "../mission/gates.js";
import { packetForRepository, repositoryContexts } from "../agent/mission-packet.js";
import { extractStoryDocumentationUrls, fetchPlanningDocumentation, loadPlanningDocumentation } from "../agent/documentation-fetch.js";
import { hasBlockingBehavioralClaims } from "../agent/planning-behavior.js";
import { CodexModelCatalog } from "../agent/model-catalog.js";

const port = Number(process.env.PORT ?? 7421);
const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../ui/dist");
const backlogCachePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../runtime/backlog.json");
const planningAgent = new PlanningAgent();
const missionRunStore = new MissionRunStore();
const codexModelCatalog = new CodexModelCatalog();

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function adoClient(repository?: RepositoryConfig): AzureDevOpsCli {
  const scope = loadTeamConfig().team.azureDevOps;
  return new AzureDevOpsCli({
    ...scope,
    project: repository ? azureDevOpsProjectFromRemote(repository.remoteUrl) : scope.project,
  });
}

function gitLabClient(remoteUrl: string): GitLabCli {
  return new GitLabCli(remoteUrl);
}

function json(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function handleApi(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  if (request.method === "GET" && path === "/api/missions/models/codex") {
    json(response, { provider: "codex", models: codexModelCatalog.get() });
    return true;
  }
  if (request.method === "GET" && path === "/api/missions/repositories") {
    const repositories = loadTeamConfig().repositories.map((repository) => ({
      id: repository.id,
      scm: repository.scm,
      integrationBranch: repository.integrationBranch,
    }));
    json(response, { repositories });
    return true;
  }
  const workspaceMatch = path.match(/^\/api\/missions\/repositories\/([^/]+)\/workspaces\/(\d+)$/);
  if (request.method === "GET" && workspaceMatch) {
    const config = loadTeamConfig();
    const repository = getRepository(config, decodeURIComponent(workspaceMatch[1]));
    const branch = resolveFeatureBranchName(
      config.team.taskPlanning.featureBranchPattern,
      config.team.taskPlanning.developerAlias,
      Number(workspaceMatch[2]),
    );
    json(response, missionWorkspace(repository, branch));
    return true;
  }
  const planMatch = path.match(/^\/api\/missions\/plans\/([\w-]+)$/);
  if (request.method === "GET" && planMatch) {
    const job = planningAgent.get(planMatch[1]);
    if (!job) {
      json(response, { error: "Planning job was not found" }, 404);
    } else {
      json(response, { job });
    }
    return true;
  }
  const developRunMatch = path.match(/^\/api\/missions\/develop-runs\/([\w-]+)$/);
  if (request.method === "GET" && developRunMatch) {
    const job = missionRunStore.get(developRunMatch[1]);
    if (!job) {
      json(response, { error: "Develop run was not found" }, 404);
    } else {
      json(response, { job });
    }
    return true;
  }
  const planDevelopRunMatch = path.match(/^\/api\/missions\/plans\/([\w-]+)\/develop-run$/);
  if (request.method === "GET" && planDevelopRunMatch) {
    const plan = planningAgent.get(planDevelopRunMatch[1]);
    const job = plan?.developRunId ? missionRunStore.get(plan.developRunId) : undefined;
    if (!job) json(response, { error: "No develop run is recorded for this plan" }, 404);
    else json(response, { job });
    return true;
  }
  const publishMatch = path.match(/^\/api\/missions\/develop-runs\/([\w-]+)\/publish$/);
  const mergeMatch = path.match(/^\/api\/missions\/develop-runs\/([\w-]+)\/publish\/merge$/);
  if (request.method === "POST" && mergeMatch) {
    const job = missionRunStore.get(mergeMatch[1]);
    if (!job) { json(response, { error: "Develop run was not found" }, 404); return true; }
    const body = await readJson(request);
    const repositoryId = optionalString(body.repositoryId, "repositoryId") ?? job.repositoryId;
    const repositoryRun = job.runsByRepository[repositoryId];
    const publication = repositoryRun?.publication;
    if (!repositoryRun || !publication) {
      json(response, { error: "A published merge request is required before merging" }, 409);
      return true;
    }
    if (!isMissionPublishReady(job)) {
      json(response, { error: "Every repository and the aggregate review must pass before merging" }, 409);
      return true;
    }
    const repository = getRepository(loadTeamConfig(), repositoryId);
    const eligibilityError = mergeEligibilityError(repository, publication, body.confirmed === true);
    if (eligibilityError) {
      json(response, { error: eligibilityError }, 409);
      return true;
    }
    const merge = await mergePublishedMergeRequest(gitLabClient(repository.remoteUrl), repository, publication);
    const updated = missionRunStore.recordMerge(job.id, merge, repositoryId);
    json(response, { result: updated?.runsByRepository[repositoryId]?.publication ?? publication, job: updated ?? job }, merge.merged ? 201 : 200);
    return true;
  }
  if (request.method === "POST" && publishMatch) {
    const job = missionRunStore.get(publishMatch[1]);
    if (!job) { json(response, { error: "Develop run was not found" }, 404); return true; }
    const body = await readJson(request);
    const repositoryId = optionalString(body.repositoryId, "repositoryId") ?? job.repositoryId;
    const repositoryRun = job.runsByRepository[repositoryId];
    if (!repositoryRun || repositoryRun.result?.outcome !== "done" || !repositoryRun.result.develop?.commit) {
      json(response, { error: "Only a successfully completed develop run with a commit can be published" }, 409);
      return true;
    }
    if (repositoryRun.result.gateReport?.passed !== true || !hasAcceptedPublishReview(job, repositoryId)) {
      json(response, { error: "Publish requires passing gates and an accepted critic verdict" }, 409);
      return true;
    }
    if (!isMissionPublishReady(job)) {
      json(response, { error: "Every repository and the aggregate review must pass before publishing" }, 409);
      return true;
    }
    const planJob = planningAgent.get(job.planJobId);
    if (planJob?.developRunId !== job.id) {
      json(response, { error: "A newer develop run exists; publish that reviewed result instead" }, 409);
      return true;
    }
    if (planJob && hasBlockingPublishDecision(planJob.decisionRegister ?? [], planJob.resolvedConfirmationDependencyIds ?? [])) {
      json(response, { error: "Resolve the external-contract decision required before Publish and regenerate the plan before publishing" }, 409);
      return true;
    }
    const dryRun = body.dryRun === true;
    if (!dryRun && body.confirmed !== true) {
      json(response, { error: "Explicit developer confirmation is required to publish" }, 409);
      return true;
    }
    const config = loadTeamConfig();
    const repository = getRepository(config, repositoryId);
    const sourceBranch = resolveFeatureBranchName(
      config.team.taskPlanning.featureBranchPattern,
      config.team.taskPlanning.developerAlias,
      job.storyId,
    );
    if (repositoryRun.result.develop.branch !== sourceBranch) {
      json(response, { error: "Develop branch does not match the configured publish branch" }, 409);
      return true;
    }
    const publisher = repository.scm === "azure-devops" ? adoClient(repository) : gitLabClient(repository.remoteUrl);
    const result = await publishMission(publisher, {
      missionId: job.planJobId,
      developRunId: job.id,
      storyId: job.storyId,
      storyTitle: planJob?.packet.story.title ?? `Work item ${job.storyId}`,
      repository,
      developWorktreePath: repositoryRun.result.develop.worktreePath,
      commit: repositoryRun.result.develop.commit,
      sourceBranch,
      dryRun,
      additionalNotes: publicationNotes(job, repositoryRun.result.develop.output),
    });
    missionRunStore.recordPublication(job.id, result, repositoryId);
    json(response, { result, job }, result.published ? 201 : 200);
    return true;
  }
  const scopeReviewMatch = path.match(/^\/api\/missions\/develop-runs\/([\w-]+)\/scope-review$/);
  if (request.method === "POST" && scopeReviewMatch) {
    const job = missionRunStore.get(scopeReviewMatch[1]);
    const develop = job?.result?.develop;
    const scopeGate = job?.result?.gateReport?.results.find((result) => result.id === "scope");
    if (!job || job.result?.outcome !== "awaiting-scope-decision" || !develop || scopeGate?.status !== "failed") {
      json(response, { error: "This develop run is not awaiting a scope decision" }, 409);
      return true;
    }
    if (job.scopeReviewStatus === "running") {
      json(response, { error: "A scope review is already running" }, 409);
      return true;
    }
    const planJob = planningAgent.get(job.planJobId);
    const approvedRepositoryPaths = planJob?.approvedPathsByRepository?.[job.repositoryId];
    if (!planJob?.output || !approvedRepositoryPaths) {
      json(response, { error: "The approved plan is no longer available for scope review" }, 409);
      return true;
    }
    if (scopeGate.offenders.every((path) => approvedRepositoryPaths.includes(path))) {
      const decisions = Object.fromEntries(scopeGate.offenders.map((path) => [path, "approve" as const]));
      const resumed = missionRunStore.resumeAfterScopeDecision(job.id, approvedRepositoryPaths, decisions);
      if (!resumed) throw new Error("Develop run disappeared before its approved scope could be resumed");
      json(response, { job: resumed }, 202);
      return true;
    }
    missionRunStore.startScopeReview(job.id, {
      provider: planJob.provider,
      worktreePath: develop.worktreePath,
      baselineCommit: develop.baselineCommit,
      storyId: job.storyId,
      storyTitle: planJob.packet.story.title,
      storyDescription: planJob.packet.story.description,
      acceptanceCriteria: planJob.packet.story.acceptanceCriteria,
      approvedPlan: planJob.output,
      approvedPaths: approvedRepositoryPaths,
      offenders: scopeGate.offenders,
    });
    json(response, { job }, 202);
    return true;
  }
  const aggregateRetryMatch = path.match(/^\/api\/missions\/develop-runs\/([\w-]+)\/aggregate-retry$/);
  if (request.method === "POST" && aggregateRetryMatch) {
    const body = await readJson(request);
    const repositoryIds = stringArray(body.repositoryIds, "repositoryIds");
    try {
      const job = missionRunStore.retryAfterAggregateReview(aggregateRetryMatch[1], repositoryIds);
      if (!job) { json(response, { error: "Develop run is not awaiting aggregate-review retry" }, 409); return true; }
      json(response, { job }, 202);
    } catch (error) {
      json(response, { error: error instanceof Error ? error.message : String(error) }, 409);
    }
    return true;
  }
  const aggregateOverrideMatch = path.match(/^\/api\/missions\/develop-runs\/([\w-]+)\/aggregate-override$/);
  if (request.method === "POST" && aggregateOverrideMatch) {
    const body = await readJson(request);
    try {
      const job = missionRunStore.recordAggregateReviewOverride(aggregateOverrideMatch[1], body.justification);
      json(response, { job }, 202);
    } catch (error) {
      json(response, { error: error instanceof Error ? error.message : String(error) }, 409);
    }
    return true;
  }
  const scopeDecisionMatch = path.match(/^\/api\/missions\/develop-runs\/([\w-]+)\/scope-decision$/);
  if (request.method === "POST" && scopeDecisionMatch) {
    const job = missionRunStore.get(scopeDecisionMatch[1]);
    const scopeGate = job?.result?.gateReport?.results.find((result) => result.id === "scope");
    const planJob = job ? planningAgent.get(job.planJobId) : undefined;
    const currentApprovedPaths = planJob?.approvedPathsByRepository?.[job?.repositoryId ?? ""];
    if (!job || job.result?.outcome !== "awaiting-scope-decision" || scopeGate?.status !== "failed" || !currentApprovedPaths) {
      json(response, { error: "This develop run is not awaiting a scope decision" }, 409);
      return true;
    }
    const body = await readJson(request);
    if (typeof body.decisions !== "object" || body.decisions === null || Array.isArray(body.decisions)) {
      json(response, { error: "decisions must map every additional path to approve or reject" }, 409);
      return true;
    }
    const rawDecisions = body.decisions as Record<string, unknown>;
    const offenders = new Set(scopeGate.offenders);
    if (Object.keys(rawDecisions).length !== offenders.size
      || Object.keys(rawDecisions).some((path) => !offenders.has(path))
      || scopeGate.offenders.some((path) => rawDecisions[path] !== "approve" && rawDecisions[path] !== "reject")) {
      json(response, { error: "Every additional path requires an explicit approve or reject decision" }, 409);
      return true;
    }
    const decisions = rawDecisions as Record<string, "approve" | "reject">;
    const protectedApproval = scopeGate.offenders.find((path) => decisions[path] === "approve" && !isScopeExpansionAllowed(path));
    if (protectedApproval) {
      json(response, { error: `${protectedApproval} is permanently excluded from mission scope and must be rejected` }, 409);
      return true;
    }
    const approvedPaths = [
      ...currentApprovedPaths,
      ...scopeGate.offenders.filter((path) => decisions[path] === "approve"),
    ];
    planningAgent.recordApprovedPathsByRepository(planJob.id, {
      ...planJob.approvedPathsByRepository,
      [job.repositoryId]: approvedPaths,
    });
    const resumed = missionRunStore.resumeAfterScopeDecision(job.id, approvedPaths, decisions);
    if (!resumed) throw new Error("Develop run disappeared before the scope decision could be applied");
    json(response, { job: resumed }, 202);
    return true;
  }
  if (request.method === "POST" && path === "/api/missions/documentation/fetch") {
    const input = await readJson(request);
    const workItemId = positiveInteger(input.workItemId, "workItemId");
    const urls = stringArray(input.urls, "urls");
    const batch = await fetchPlanningDocumentation(workItemId, urls);
    json(response, {
      batch: {
        id: batch.id,
        workItemId: batch.workItemId,
        createdAt: batch.createdAt,
        outcomes: batch.outcomes.map((outcome) => ({
          status: outcome.status,
          requestedUrl: outcome.requestedUrl,
          reason: outcome.reason,
          ...(outcome.documentation ? {
            finalUrl: outcome.documentation.finalUrl,
            hostname: outcome.documentation.hostname,
            size: outcome.documentation.size,
            responseHash: outcome.documentation.responseHash,
          } : {}),
        })),
      },
    }, 201);
    return true;
  }
  if (request.method === "POST" && path === "/api/missions/related-work-items/discover") {
    const input = await readJson(request);
    const workItemId = positiveInteger(input.workItemId, "workItemId");
    const discovery = await discoverRelatedWorkItems(workItemId, input.relatedWorkItemIds, loadTeamConfig().repositories, adoClient(), {
      gitLabMergeRequestUrls: input.relatedGitLabMergeRequestUrls,
      gitLabMergeRequestReader: (repository, mergeRequestId) => gitLabClient(repository.remoteUrl).getMergeRequest(mergeRequestId),
    });
    json(response, { discovery }, 201);
    return true;
  }
  if (request.method === "POST" && path === "/api/missions/plans") {
    const input = await readJson(request);
    const workItemId = positiveInteger(input.workItemId, "workItemId");
    const requestedRepositoryIds = parseRepositoryIds(input.repositoryIds, input.repositoryId);
    const provider = parseProvider(input.provider);
    const model = optionalString(input.model, "model");
    if (provider === "codex") {
      if (!model) throw new Error("Select a Codex model before starting planning");
      if (!codexModelCatalog.get().some((candidate) => candidate.id === model)) {
        throw new Error("Selected Codex model is not available to the signed-in account");
      }
    }
    const mode = planningMode(input.mode);
    const historyPolicy = parseHistoryPolicy(input.historyPolicy);
    const repositoryStrategy = parseRepositoryStrategy(input.repositoryStrategy);
    const phase = parsePlanningPhase(input.phase);
    const planningTimeoutSeconds = input.planningTimeoutSeconds === undefined
      ? undefined
      : boundedInteger(input.planningTimeoutSeconds, "planningTimeoutSeconds", 60, 900);
    const scoutReasoningEffort = parseScoutReasoningEffort(input.scoutReasoningEffort);
    const documentationFetchIds = input.documentationFetchIds === undefined ? [] : stringArray(input.documentationFetchIds, "documentationFetchIds");
    const sharedContracts = parseSharedContracts(input.sharedContracts);
    const relatedWorkItems = input.relatedWorkItemDiscoveryId === undefined
      ? []
      : loadRelatedWorkItemDiscovery(requiredString(input.relatedWorkItemDiscoveryId, "relatedWorkItemDiscoveryId"), workItemId).relatedWorkItems;
    const config = loadTeamConfig();
    const repositories = requestedRepositoryIds.map((id) => getRepository(config, id));
    if (requestedRepositoryIds.length > 1 && (repositoryStrategy !== "existing" || phase !== "implementation-plan")) {
      throw new Error("Multi-repository missions support only existing repositories and implementation planning");
    }
    const selections = repositories.map((repository) => ({
      repository,
      worktreePath: repository.localPath,
    }));
    const proposedRepositoryName = optionalString(input.proposedRepositoryName, "proposedRepositoryName");
    const story = await adoClient().getTeamBacklogItem(workItemId);
    const developerDocumentationUrls = new Set(documentationFetchIds.flatMap((id) => loadPlanningDocumentation(id, story.id).map((entry) => entry.requestedUrl)));
    const storyDocumentationUrls = extractStoryDocumentationUrls([
      story.title,
      story.description,
      story.acceptanceCriteria,
      ...(story.comments ?? []).map((comment) => comment.text),
    ].join("\n")).filter((url) => !developerDocumentationUrls.has(url));
    const storyDocumentation = storyDocumentationUrls.length > 0
      ? await fetchPlanningDocumentation(story.id, storyDocumentationUrls)
      : null;
    const attachedDocumentationFetchIds = [
      ...documentationFetchIds,
      ...(storyDocumentation ? [storyDocumentation.id] : []),
    ];
    const knownRepositoryIds = config.repositories.map((candidate) => candidate.id);
    const priorReviewFeedback = optionalString(input.priorReviewFeedback, "priorReviewFeedback");
    const job = planningAgent.startMulti(story, selections, { provider, model, mode, historyPolicy, repositoryStrategy, phase, knownRepositoryIds, proposedRepositoryName, priorReviewFeedback, planningTimeoutSeconds, scoutReasoningEffort, documentationFetchIds: attachedDocumentationFetchIds, relatedWorkItems, sharedContracts });
    json(response, { job }, 202);
    return true;
  }
  const reviewMatch = path.match(/^\/api\/missions\/plans\/([\w-]+)\/review$/);
  if (request.method === "POST" && reviewMatch) {
    const existing = planningAgent.get(reviewMatch[1]);
    if (!existing) { json(response, { error: "Planning job was not found" }, 404); return true; }
    if (existing.status !== "completed") { json(response, { error: `Plan is not ready for review (status: ${existing.status})` }, 409); return true; }
    if (existing.behavioralReviewStatus === "running") { json(response, { error: "Targeted behavioral review is already running" }, 409); return true; }
    if (existing.reviewStatus === "running") { json(response, { error: "A review is already running for this plan" }, 409); return true; }
    const job = planningAgent.startReview(reviewMatch[1]);
    json(response, { job }, 202);
    return true;
  }
  const answerMatch = path.match(/^\/api\/missions\/plans\/([\w-]+)\/answers$/);
  if (request.method === "POST" && answerMatch) {
    const body = await readJson(request);
    try {
      const job = planningAgent.submitDeveloperAnswers(answerMatch[1], body.answers);
      json(response, { job }, 202);
    } catch (error) {
      json(response, { error: error instanceof Error ? error.message : String(error) }, 409);
    }
    return true;
  }
  const scopeMatch = path.match(/^\/api\/missions\/plans\/([\w-]+)\/scope$/);
  if (request.method === "POST" && scopeMatch) {
    const job = planningAgent.get(scopeMatch[1]);
    if (!job) { json(response, { error: "Planning job was not found" }, 404); return true; }
    const body = await readJson(request);
    try {
      if (body.plannedPathsByRepository !== undefined) {
        planningAgent.recordApprovedPathsByRepository(job.id, body.plannedPathsByRepository, body.scopeOverrideJustifications);
      } else {
        planningAgent.recordApprovedPlannedPaths(job.id, body.plannedPaths);
        job.approvedPathsByRepository = { [job.repositoryId]: job.approvedPlannedPaths! };
      }
    } catch (error) {
      json(response, { error: error instanceof Error ? error.message : String(error) }, 409);
      return true;
    }
    json(response, { job });
    return true;
  }
  const approveMatch = path.match(/^\/api\/missions\/plans\/([\w-]+)\/approve$/);
  if (request.method === "POST" && approveMatch) {
    const job = planningAgent.get(approveMatch[1]);
    if (!job) { json(response, { error: "Planning job was not found" }, 404); return true; }
    if (job.status !== "completed") { json(response, { error: `Plan is not ready for approval (status: ${job.status})` }, 409); return true; }
    if (job.planRevisionStatus === "escalated") { json(response, { error: job.planRevisionError ?? "Plan revision requires developer intervention" }, 409); return true; }
    if (job.behavioralReviewStatus === "running" || hasBlockingBehavioralClaims(job.behavioralClaimsByRepository ?? {})) {
      json(response, { error: "Behavioral claims must be confirmed or removed before approval" }, 409);
      return true;
    }
    if (hasBlockingPreDevelopDecision(job.decisionRegister ?? [])) {
      json(response, { error: "Resolve the decision required before Develop and regenerate the plan before approval" }, 409);
      return true;
    }
    if (!job.approvedPathsByRepository || job.repositoryIds.some((repositoryId) => {
      const paths = job.approvedPathsByRepository?.[repositoryId] ?? [];
      return paths.length === 0 && job.scopeOutVerificationByRepository?.[repositoryId]?.status !== "verified";
    })) {
      json(response, { error: "Every repository requires an approved write boundary or audit-verified no-change evidence" }, 409);
      return true;
    }

    const input = await readJson(request);
    if (input.skipTaskCreation === true) {
      const approval = planningAgent.recordTaskCreationSkipped(job.id);
      if (!approval) throw new Error("Planning job disappeared before approval could be recorded");
      json(response, { result: { missionId: job.id, parentStoryId: job.packet.story.id, ...approval }, developmentApproval: approval });
      return true;
    }
    const config = loadTeamConfig();
    const repos = repoTaskRequests(input.repos, config);
    const implementationIds = implementationRepositoryIds(job);
    if (implementationIds.length === 0) {
      json(response, { error: "A verified no-change mission must be approved without creating ADO Tasks" }, 409);
      return true;
    }
    if (!sameMembers(repos.map((repo) => repo.id), implementationIds)) {
      json(response, { error: "ADO Task approval must include every repository with planned changes exactly once" }, 409);
      return true;
    }
    const dryRun = input.dryRun === true;
    const result = await approveMission(adoClient(), {
      missionId: job.id,
      parentStoryId: job.packet.story.id,
      repos,
      dryRun,
      alreadyCreated: job.createdTasks,
    });
    if (!dryRun) planningAgent.recordCreatedTasks(job.id, createdTasksFrom(result.outcomes));
    json(response, { result, developmentApproval: job.developmentApproval }, dryRun ? 200 : 201);
    return true;
  }
  const developMatch = path.match(/^\/api\/missions\/plans\/([\w-]+)\/develop$/);
  if (request.method === "POST" && developMatch) {
    const planJob = planningAgent.get(developMatch[1]);
    if (!planJob) { json(response, { error: "Planning job was not found" }, 404); return true; }
    if (planJob.status !== "completed" || planJob.output === null) {
      json(response, { error: `Plan is not ready for development (status: ${planJob.status})` }, 409);
      return true;
    }
    if (planJob.executionDossierContractVersion !== EXECUTION_DOSSIER_CONTRACT_VERSION) {
      json(response, { error: "This plan uses a prior Plan/Develop contract. Generate a new plan before starting Develop." }, 409);
      return true;
    }
    if (planJob.developmentApproval === null) {
      json(response, { error: "Plan must be approved before development" }, 409);
      return true;
    }
    if (!planJob.approvedPathsByRepository
      || planJob.repositoryIds.some((repositoryId) => {
        const paths = planJob.approvedPathsByRepository?.[repositoryId] ?? [];
        return paths.length === 0 && planJob.scopeOutVerificationByRepository[repositoryId]?.status !== "verified";
      })) {
      json(response, { error: "Review and approve the planned Develop write boundary before development" }, 409);
      return true;
    }
    const config = loadTeamConfig();
    // Optional discard-and-re-run flag. Tolerate an empty/absent body: normal start and
    // retry send none, so the endpoint must not newly require a JSON body.
    let discardStaleWorktree = false;
    try {
      const body = await readJson(request);
      discardStaleWorktree = body.discardStaleWorktree === true;
    } catch {
      discardStaleWorktree = false;
    }
    const implementationOrder = implementationRepositoryIds(planJob);
    if (implementationOrder.length === 0) {
      json(response, { error: "Every selected repository is verified as no-change; no Develop run is needed" }, 409);
      return true;
    }
    const entries = implementationOrder.map((repositoryId) => {
      const repository = getRepository(config, repositoryId);
      const packet = packetForRepository(planJob.packet, repositoryId);
      const verificationCommands = resolveVerificationPolicy(repository, packet.repository.commands, planJob.verificationCommandsByRepository[repositoryId] ?? []);
      const verifyCommands = verificationCommands.map((entry) => entry.command);
      return {
        repositoryId,
        input: {
          missionId: planJob.id,
          packet,
          plan: repositoryPlanSlice(planJob, repositoryId),
          repository,
          plannedBaselineCommit: packet.repository.baselineCommit,
          plannedPaths: planJob.approvedPathsByRepository![repositoryId]!,
          versionBumpPolicy: config.team.taskPlanning.versionBump,
          referenceFiles: developReferenceFiles(planJob.approvedPathsByRepository![repositoryId] ?? [], planJob.evidenceByRepository?.[repositoryId] ?? [], [...citedReferencePaths(planJob.implementationStepsByRepository[repositoryId] ?? []), ...siblingReferencePaths(repository.localPath, planJob.approvedPathsByRepository![repositoryId] ?? [])]),
          discardStaleWorktree,
          executionDossier: injectResolvedContractsIntoDossier(planJob.executionDossierByRepository?.[repositoryId] ?? [], resolveSharedContracts(planJob), repositoryId, planJob.approvedPathsByRepository![repositoryId] ?? []),
          crossRepositoryContracts: planJob.crossRepositoryContracts.filter((contract) => contract.consumerRepositoryId === repositoryId),
          documentation: planJob.packet.documentation ?? [],
          verifyCommands,
          verificationCommands,
          branchName: resolveFeatureBranchName(config.team.taskPlanning.featureBranchPattern, config.team.taskPlanning.developerAlias, planJob.packet.story.id),
          linkFromBase: verifyCommands.some((command) => /(?:^|\s)npm(?:\s|$)/.test(command)) ? ["node_modules"] : undefined,
          limits: DEFAULT_LEDGER_LIMITS,
          config: DEFAULT_ORCHESTRATOR_CONFIG,
        },
      };
    });
    const stalePlanErrors = entries.flatMap(({ input }) => {
      try {
        const error = plannedBaselineError(input.repository, input.plannedBaselineCommit);
        return error ? [error] : [];
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
      }
    });
    if (stalePlanErrors.length > 0) {
      json(response, { error: `Plan contract needs regeneration. ${stalePlanErrors.join(" ")}` }, 409);
      return true;
    }
    const aggregateProvider: Provider = planJob.provider === "claude" ? "codex" : "claude";
    const job = missionRunStore.startMulti(entries, planJob.id, {
      missionId: planJob.id,
      packet: planJob.packet,
      plan: planJob.output,
      provider: aggregateProvider,
      workingDir: planJob.worktreePath,
      executionOrder: implementationOrder,
      dependenciesByRepository: Object.fromEntries(implementationOrder.map((repositoryId) => [
        repositoryId,
        (planJob.dependenciesByRepository[repositoryId] ?? []).filter((dependency) => implementationOrder.includes(dependency)),
      ])),
    });
    planningAgent.recordDevelopRun(planJob.id, job.id);
    json(response, { job }, 202);
    return true;
  }
  const discardMatch = path.match(/^\/api\/missions\/plans\/([\w-]+)\/discard$/);
  if (request.method === "POST" && discardMatch) {
    const planJob = planningAgent.get(discardMatch[1]);
    if (!planJob) { json(response, { error: "Planning job was not found" }, 404); return true; }
    const config = loadTeamConfig();
    const discarded = planJob.repositoryIds.map((repositoryId) => {
      try {
        const repository = getRepository(config, repositoryId);
        const branch = resolveFeatureBranchName(config.team.taskPlanning.featureBranchPattern, config.team.taskPlanning.developerAlias, planJob.packet.story.id);
        const result = discardMissionWorktree(repository.localPath, branch, repository.integrationBranch);
        return { repositoryId, removed: result.removed, skipped: result.skipped ?? null };
      } catch (error) {
        return { repositoryId, removed: null, skipped: error instanceof Error ? error.message : String(error) };
      }
    });
    json(response, { discarded }, 200);
    return true;
  }
  if (request.method !== "GET") return false;
  if (path === "/api/missions/history") {
    json(response, readPlanningHistory());
    return true;
  }
  if (path === "/api/ado/status") {
    const scope = loadTeamConfig().team.azureDevOps;
    const areaPaths = await adoClient().checkConnection();
    json(response, { organizationUrl: scope.organizationUrl, project: scope.project, team: scope.team, areaPaths, backlogCredentialReady: Boolean(process.env.AZURE_DEVOPS_EXT_PAT) });
    return true;
  }
  if (path === "/api/ado/stories") {
    if (!existsSync(backlogCachePath)) throw new Error("Backlog cache is missing. Restart the dashboard with npm run dashboard.");
    const cache: unknown = JSON.parse(readFileSync(backlogCachePath, "utf8"));
    if (typeof cache !== "object" || cache === null || !Array.isArray((cache as { stories?: unknown }).stories)) {
      throw new Error("Backlog cache is invalid. Restart the dashboard with npm run dashboard.");
    }
    json(response, cache);
    return true;
  }
  const match = path.match(/^\/api\/ado\/stories\/(\d+)$/);
  if (match) {
    json(response, { story: await adoClient().getTeamBacklogItem(Number(match[1])) });
    return true;
  }
  return false;
}

function missionWorkspace(repository: ReturnType<typeof getRepository>, expectedBranch: string): { ready: boolean; worktreePath: string | null; branch: string } {
  const result = spawnSync("git", ["-C", repository.localPath, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to inspect mission workspaces for ${repository.id}`);
  const entries = result.stdout.trim().split("\n\n");
  for (const entry of entries) {
    const lines = entry.split("\n");
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    const branchLine = lines.find((line) => line === `branch refs/heads/${expectedBranch}`);
    if (worktreeLine && branchLine) return { ready: true, worktreePath: worktreeLine.slice("worktree ".length), branch: branchLine.slice("branch refs/heads/".length) };
  }
  return { ready: false, worktreePath: null, branch: expectedBranch };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 20_000) throw new Error("Request body is too large");
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Request body must be an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JSON request: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function planningMode(value: unknown): PlanningMode {
  if (value === "fast" || value === "deep" || value === "extreme") return value;
  throw new Error("mode must be fast, deep, or extreme");
}

function parseProvider(value: unknown): Provider {
  if (value === "claude" || value === "codex") return value;
  throw new Error("provider must be claude or codex");
}

function parseHistoryPolicy(value: unknown): HistoryPolicy {
  if (value === "none" || value === "targeted-precedents") return value;
  throw new Error("historyPolicy must be none or targeted-precedents");
}

function parseRepositoryStrategy(value: unknown): RepositoryStrategy {
  if (value === "evaluate" || value === "existing" || value === "new-from-reference") return value;
  throw new Error("repositoryStrategy must be evaluate, existing, or new-from-reference");
}

function parsePlanningPhase(value: unknown): PlanningPhase {
  if (value === "repository-decision" || value === "implementation-plan") return value;
  throw new Error("phase must be repository-decision or implementation-plan");
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, name);
}

function parseRepositoryIds(value: unknown, singular: unknown): string[] {
  const ids = value === undefined ? [requiredString(singular, "repositoryId")] : stringArray(value, "repositoryIds");
  if (ids.length === 0) throw new Error("repositoryIds must contain at least one repository");
  if (new Set(ids).size !== ids.length) throw new Error("repositoryIds must not contain duplicates");
  return ids;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value.map((entry) => (entry as string).trim());
}

function parseSharedContracts(value: unknown): SharedContract[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("sharedContracts must be an array");
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`sharedContracts[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    return {
      concept: requiredString(item.concept, `sharedContracts[${index}].concept`),
      literalKind: requiredString(item.literalKind, `sharedContracts[${index}].literalKind`),
      canonicalLiteral: requiredString(item.canonicalLiteral, `sharedContracts[${index}].canonicalLiteral`),
    };
  });
}

function sameMembers(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length
    && expected.every((entry) => actual.includes(entry));
}

function repositoryPlanSlice(job: PlanJob, repositoryId: string): string {
  const dependencies = job.dependenciesByRepository[repositoryId] ?? [];
  const paths = job.approvedPathsByRepository?.[repositoryId] ?? [];
  const steps = job.implementationStepsByRepository[repositoryId] ?? [];
  return `## Repository execution assignment
Implement only repository ${repositoryId}.
Dependencies already scheduled before this repository: ${dependencies.join(", ") || "none"}.

## Approved implementation steps
${steps.map((step) => `- ${step}`).join("\n") || "- No repository-local implementation steps were recorded."}

## Approved paths
${paths.map((path) => `- ${path}`).join("\n")}`;
}

/** When a mission published under a developer override of the aggregate review, carry the reviewer's objections and the developer's own justification into the PR description — a raised concern must never just disappear because a human judged it non-blocking. */
function aggregateReviewOverrideNote(job: MissionRunJob): string | undefined {
  if (!job.aggregateReviewOverride) return undefined;
  const objections = job.aggregateReview?.objections.map((objection) =>
    `- (${objection.repositories.join(", ")}) ${objection.claim} — evidence: ${objection.evidence.join(", ")}`).join("\n") ?? "(none recorded)";
  return `## Aggregate review override\n\nThis mission published despite an aggregate-review disposition of "${job.aggregateReview?.disposition ?? "unknown"}", overridden by developer decision.\n\nDeveloper justification: ${job.aggregateReviewOverride.justification}\n\nReviewer objections at time of override:\n${objections}`;
}

function publicationNotes(job: MissionRunJob, developOutput: string | null): string | undefined {
  const notes = [aggregateReviewOverrideNote(job), deferredWorkForPullRequest(developOutput)].filter((note): note is string => Boolean(note));
  return notes.length > 0 ? notes.join("\n\n") : undefined;
}

/** Cross-checks every confirmed repo against the team's allow-list — the UI lets a developer edit this list, but the server never trusts a repo id it can't resolve. */
function repoTaskRequests(value: unknown, config: ReturnType<typeof loadTeamConfig>): RepoTaskRequest[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("repos must be a non-empty array");
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`repos[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    const id = requiredString(item.id, `repos[${index}].id`);
    getRepository(config, id);
    return {
      id,
      title: requiredString(item.title, `repos[${index}].title`),
      description: typeof item.description === "string" ? item.description : "",
    };
  });
}

function serveUi(response: ServerResponse, path: string): void {
  const requested = path === "/" ? "index.html" : path.replace(/^\//, "");
  const filePath = resolve(uiDir, requested);
  if (!filePath.startsWith(uiDir)) {
    response.writeHead(400).end("Invalid path");
    return;
  }
  try {
    const file = statSync(filePath).isFile() ? filePath : resolve(uiDir, "index.html");
    const extension = file.slice(file.lastIndexOf("."));
    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] ?? "application/octet-stream",
      // The dashboard is a local development server. Never let a browser keep
      // an old UI bundle after we ship a safety/status fix.
      "Cache-Control": "no-store",
    });
    response.end(readFileSync(file));
  } catch {
    response.writeHead(404).end("Dashboard build not found. Run npm run ui:build.");
  }
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  handleApi(request, response, path)
    .then((handled) => { if (!handled) serveUi(response, path); })
    .catch((error: unknown) => json(response, { error: error instanceof Error ? error.message : String(error) }, 500));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`SDLC Mission Control dashboard: http://127.0.0.1:${port}`);
});
