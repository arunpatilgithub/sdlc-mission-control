export type StorySummary = { id: number; backlogOrder: number; title: string; state: string; workItemType: string; assignedTo: string | null; areaPath: string; changedDate: string | null; tags: string[] };
export type Story = StorySummary & { description: string; acceptanceCriteria: string; iterationPath: string; attachments: Array<{ name: string }>; linkedWorkItems: Array<{ relation: string; title: string | null }> };
export type Status = { organizationUrl: string; project: string; team: string; areaPaths: Array<{ value: string; includeChildren: boolean }> };

export type MissionRepository = { id: string; scm: "azure-devops" | "gitlab"; integrationBranch: string };
export type MissionWorkspace = { ready: boolean; worktreePath: string | null; branch: string };
export type RelatedWorkItemDiscovery = {
  id: string;
  workItemId: number;
  createdAt: string;
  relatedWorkItems: Array<{
    id: number;
    title: string;
    pullRequests: Array<{ id: number; repositoryName: string; status: string; targetBranch: string; url: string }>;
    gitLabMergeRequests: Array<{ id: number; title: string; repositoryPath: string; status: string; targetBranch: string; url: string }>;
  }>;
  proposedRepositories: Array<{ repositoryId: string; confidence: "high"; evidence: Array<{ workItemId: number; pullRequestId: number; scm: "azure-devops" | "gitlab"; targetBranch: string; url: string }> }>;
  unmappedPullRequests: Array<{ workItemId: number; pullRequestId: number; scm: "azure-devops" | "gitlab"; repositoryName: string; targetBranch: string; reason: string }>;
};

export type Provider = "claude" | "codex";
export type ScoutReasoningEffort = "low" | "medium" | "high";
export type PlanningModelOption = {
  id: string;
  displayName: string;
  description: string;
  reasoningLevels: string[];
  retirementNotice: string | null;
};
export type PlanningMode = "fast" | "deep" | "extreme";
export type HistoryPolicy = "none" | "targeted-precedents";
export type RepositoryStrategy = "evaluate" | "existing" | "new-from-reference";
export type PlanningPhase = "repository-decision" | "implementation-plan";

export type RunUsage = {
  provider: Provider;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUSD: number | null;
  turns: number;
  durationMs: number;
  promptBytes: number;
  toolOutputBytes: number;
  outputBytes: number;
  commandCount: number;
};

export type RepoScopeCandidate = { id: string; reason: string };
export type RepoScope = { primaryRepo: string; additionalRepos: RepoScopeCandidate[]; parseError: string | null };

export type ReviewVerdict = {
  repoScopeAgreement: "agrees" | "disagrees" | null;
  overallAssessment: "sound" | "needs-revision" | "off-track" | null;
  objections: Array<{ severity: "blocker" | "major" | "minor"; claim: string; evidence: string[] }>;
  parseError: string | null;
};

export type PlanReview = {
  provider: Provider;
  output: string;
  verdict: ReviewVerdict;
  usage: RunUsage | null;
  createdAt: string;
};

export type DevelopmentApproval = {
  mode: "ado-tasks" | "tasks-skipped";
  approvedAt: string;
};

export type PlanJob = {
  id: string;
  status: "running" | "completed" | "failed";
  provider: Provider;
  model: string | null;
  scoutReasoningEffort?: ScoutReasoningEffort;
  planningTimeoutSeconds: number;
  planningProgress?: {
    phase: "preparing" | "scouting" | "coordinating" | "validating" | "behavioral-review" | "complete" | "failed";
    phaseStartedAt: string;
    phaseTimings: Array<{
      phase: "preparing" | "scouting" | "coordinating" | "validating" | "behavioral-review" | "complete" | "failed";
      startedAt: string;
      completedAt: string | null;
    }>;
    scouts: Record<string, { status: "pending" | "running" | "completed" | "failed"; startedAt: string | null; completedAt: string | null }>;
  };
  repositoryId: string;
  repositoryIds: string[];
  worktreePath: string;
  worktreePaths: Record<string, string>;
  branch: string;
  branches: Record<string, string>;
  startedAt: string;
  completedAt: string | null;
  output: string | null;
  error: string | null;
  repoScope: RepoScope | null;
  plannedPaths: string[];
  plannedPathsByRepository: Record<string, string[]>;
  scopeDispositionByRepository: Record<string, "changes-required" | "verified-no-change" | "unverified">;
  applicabilityByRepository: Record<string, {
    role: "runtime-owner" | "configuration-owner" | "contract-mirror" | "explicit-request" | "capability-only" | "unknown";
    storyBinding: string;
    routeOrDependency: string;
    evidence: string[];
  }>;
  evidenceByRepository: Record<string, string[]>;
  scopeOutVerificationByRepository: Record<string, {
    status: "not-applicable" | "verified" | "unverified";
    evidence: string[];
    unmatchedEvidence: string[];
  }>;
  behavioralClaimsByRepository: Record<string, Array<{
    stepIndex: number;
    step: string;
    phrase: string;
    citations: string[];
    status: "verified" | "unverified" | "confirmed" | "refuted";
    explanation: string | null;
  }>>;
  behavioralReviewStatus: "idle" | "running" | "completed" | "failed";
  behavioralReviewError: string | null;
  plannedPathsParseError: string | null;
  plannedPathsParseErrorsByRepository: Record<string, string | null>;
  approvedPlannedPaths: string[] | null;
  approvedPathsByRepository: Record<string, string[]> | null;
  executionOrder: string[];
  dependenciesByRepository: Record<string, string[]>;
  verificationCommandsByRepository: Record<string, Array<{ command: string; timeoutSeconds?: number }>>;
  suggestedRepositories: RepoScopeCandidate[];
  questionsOrClarifications?: string[];
  decisionRegister?: Array<{
    question: string;
    recommendation: string;
    alternatives: string[];
    requiredBefore: "plan" | "develop" | "publish" | "complete";
    impact: "implementation" | "repository-boundary" | "external-contract" | "operational" | "shared-contract" | "unknown";
    affectedRepositoryIds: string[];
    rationale: string;
  }>;
  operationalFollowUps?: string[];
  outOfScopeFollowUps?: string[];
  criticPlanRevisionCount: number;
  developerPlanRevisionCount: number;
  planRevisionStatus: "idle" | "running" | "completed" | "escalated" | "failed";
  planRevisionError: string | null;
  planRevisionHistory: Array<{
    source: "critic" | "developer" | "validator";
    path: "scoped-rerun" | "deterministic-patch";
    summary: string;
    createdAt: string;
  }>;
  scoutFindings: Record<string, string>;
  scoutUsageByRepository: Record<string, RunUsage>;
  developRunId: string | null;
  usage: RunUsage | null;
  priorReviewFeedback: string | null;
  reviewStatus: "idle" | "running" | "completed" | "failed";
  review: PlanReview | null;
  reviewError: string | null;
  createdTasks: Record<string, { id: number; title: string; url: string }>;
  developmentApproval: DevelopmentApproval | null;
  packet: {
    mode: PlanningMode;
    historyPolicy: HistoryPolicy;
    repositoryStrategy: RepositoryStrategy;
    phase: PlanningPhase;
    proposedRepositoryName: string | null;
    story: {
      id: number;
      title: string;
      comments?: Array<{ id: number; author: string; createdDate: string; modifiedDate: string | null; text: string }>;
      commentsTruncated?: boolean;
    };
    relatedWorkItems: Array<{
      id: number;
      title: string;
      url: string;
      pullRequests: Array<{ id: number; repositoryName: string; status: string; targetBranch: string; url: string }>;
      gitLabMergeRequests: Array<{ id: number; title: string; repositoryPath: string; status: string; targetBranch: string; url: string }>;
    }>;
    repository: { baselineCommit: string; appType: string };
    likelyFiles: Array<{ path: string }>;
    vendorApiSpecs?: Array<{ id: string; keywords: string[]; lastVerified: string; content: string }>;
    documentation?: Array<{ requestedUrl: string; finalUrl: string; hostname: string; fetchedAt: string; responseHash: string; size: number; contentType: string; redirectChain: string[]; wrappedText: string }>;
  };
};

export type HistoryRow = {
  jobId: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: "running" | "completed" | "failed";
  provider: string | null;
  repositoryId: string | null;
  workItemId: number | null;
  title: string | null;
  mode: string | null;
  phase: string | null;
  usage: RunUsage | null;
  tasksCreated: number;
};

export type HistoryTotals = {
  runs: number;
  completed: number;
  failed: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  toolOutputBytes: number;
  costUSD: number | null;
  durationMs: number;
  runsWithoutUsage: number;
};

export type PlanningHistory = { runs: HistoryRow[]; totals: HistoryTotals };

export type RepoTaskDraft = { id: string; title: string; description: string };

export type RepoTaskOutcome = {
  repositoryId: string;
  title: string;
  description: string;
  task: { id: number; title: string; url: string } | null;
  error: string | null;
  alreadyCreated: boolean;
  unlinked: boolean;
};

export type ApprovalResult = {
  missionId: string;
  parentStoryId: number;
  dryRun: boolean;
  outcomes: RepoTaskOutcome[];
  auditPath: string;
};

export type DocumentationFetchBatch = {
  id: string;
  workItemId: number;
  createdAt: string;
  outcomes: Array<{
    status: "ok" | "rejected";
    requestedUrl: string;
    reason?: string;
    finalUrl?: string;
    hostname?: string;
    size?: number;
    responseHash?: string;
  }>;
};

export async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

/** Accepts a bare work item id ("12345") or a pasted ADO URL (edit link, REST link, or anything else containing the id). */
export function parseWorkItemId(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const editLink = trimmed.match(/_workitems\/edit\/(\d+)/i);
  if (editLink) return Number(editLink[1]);
  const restLink = trimmed.match(/workitems\/(\d+)(?:[/?]|$)/i);
  if (restLink) return Number(restLink[1]);
  const anyDigits = trimmed.match(/(\d+)/);
  return anyDigits ? Number(anyDigits[1]) : null;
}

export function textFromHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
