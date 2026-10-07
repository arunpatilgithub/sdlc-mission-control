import type { MissionRunJobView } from "./develop-view";
import type { PlanJob } from "./types";

export type PipelineStageId =
  | "plan" | "plan-critic" | "approval" | "develop" | "gates" | "develop-critic";

export type PipelineNodeStatus = "pending" | "active" | "completed" | "failed" | "skipped";

export interface PipelineNode {
  id: PipelineStageId;
  status: PipelineNodeStatus;
  /** How this node's state was obtained: reported by the runner, or inferred by the UI. */
  source: "reported" | "derived";
  /** How many times the stage ran. Above 1 only for reported stages that repeated. */
  attempt: number;
}

export type UserStageId = "plan" | "review" | "approve" | "develop" | "verify" | "publish" | "complete";

export interface UserProgressStage {
  id: UserStageId;
  status: PipelineNodeStatus;
}

export interface MissionGuidance {
  stage: UserStageId;
  title: string;
  detail: string;
  action: string;
}

export interface UserProgress {
  stages: UserProgressStage[];
  guidance: MissionGuidance;
}

export function isMissionActivityRunning(plan: PlanJob | null, develop: MissionRunJobView | null): boolean {
  return plan?.status === "running"
    || plan?.planRevisionStatus === "running"
    || plan?.behavioralReviewStatus === "running"
    || plan?.reviewStatus === "running"
    || develop?.status === "running"
    || develop?.scopeReviewStatus === "running";
}

export function stageAgentLabel(
  stage: UserStageId,
  plan: PlanJob | null,
  develop: MissionRunJobView | null,
): string | null {
  if (stage === "plan") return plan ? providerLabel(plan.provider) : null;
  if (stage === "review" && plan?.behavioralReviewStatus === "running") {
    return providerLabel(plan.provider === "claude" ? "codex" : "claude");
  }
  if (stage === "review" && plan && plan.reviewStatus !== "idle") {
    return providerLabel(plan.review?.provider ?? (plan.provider === "claude" ? "codex" : "claude"));
  }
  if (stage === "develop" && develop) {
    return providerLabel(develop.result?.develop?.usage?.provider ?? "codex");
  }
  if (stage !== "verify" || !develop) return null;
  if (develop.scopeReviewStatus === "running" || develop.scopeReviewStatus === "completed") {
    return `${providerLabel(develop.scopeReview?.provider ?? plan?.provider ?? "codex")} advisor`;
  }
  if (develop.stagesRun.includes("develop-critic")) {
    return `${providerLabel(develop.result?.verdict?.usage?.provider ?? "claude")} + gates`;
  }
  return develop.stagesRun.includes("gates") ? "Deterministic gates" : null;
}

const REPORTED_STAGES = ["develop", "gates", "develop-critic"] as const;

export function buildPipeline(
  plan: PlanJob | null,
  develop: MissionRunJobView | null,
): PipelineNode[] {
  const approved = plan?.developmentApproval !== null && plan?.developmentApproval !== undefined;
  const derived: PipelineNode[] = [
    { id: "plan", status: planStatus(plan), source: "derived", attempt: 1 },
    { id: "plan-critic", status: criticStatus(plan, approved), source: "derived", attempt: 1 },
    {
      id: "approval",
      status: approved ? "completed" : plan?.status === "failed" ? "skipped" : plan?.status === "completed" ? "active" : "pending",
      source: "derived",
      attempt: 1,
    },
  ];
  const reported = REPORTED_STAGES.map((stage): PipelineNode => {
    const attempt = develop?.stagesRun.filter((entry) => entry === stage).length ?? 0;
    const isLast = develop?.stagesRun.at(-1) === stage;
    let status: PipelineNodeStatus;
    if (attempt > 0) {
      if (isLast && develop?.status === "running") status = "active";
      else if (isLast && develop?.status === "failed") status = "failed";
      else status = "completed";
    } else {
      status = develop === null || develop.status === "running" ? "pending" : "skipped";
    }
    return { id: stage, status, source: "reported", attempt };
  });
  return [...derived, ...reported];
}

export function canDevelop(plan: PlanJob | null, develop: MissionRunJobView | null): boolean {
  return ((plan?.developmentApproval !== null && plan?.developmentApproval !== undefined) && !isNoCodeMission(plan)) || develop !== null;
}

export function buildUserProgress(plan: PlanJob | null, develop: MissionRunJobView | null): UserProgress {
  const internal = buildPipeline(plan, develop);
  const node = (id: PipelineStageId): PipelineNode => internal.find((entry) => entry.id === id)!;
  const approved = plan?.developmentApproval !== null && plan?.developmentApproval !== undefined;
  const noCodeMission = approved && isNoCodeMission(plan);
  const gates = node("gates");
  const critic = node("develop-critic");
  const verify = verificationStatus(gates.status, critic.status, develop);
  const publish = publicationStatus(develop);
  const complete = completionStatus(develop);
  const review = plan?.status === "completed" && !approved && plan.reviewStatus === "idle" && (plan.behavioralReviewStatus ?? "idle") === "idle"
    ? "active"
    : node("plan-critic").status;

  const stages: UserProgressStage[] = [
    { id: "plan", status: plan === null ? "active" : node("plan").status },
    { id: "review", status: review },
    {
      id: "approve",
      status: review === "active" ? "pending" : node("approval").status,
    },
    {
      id: "develop",
      status: noCodeMission ? "skipped" : approved && develop === null ? "active" : node("develop").status,
    },
    { id: "verify", status: noCodeMission ? "skipped" : verify },
    { id: "publish", status: noCodeMission ? "skipped" : publish },
    { id: "complete", status: noCodeMission ? "completed" : complete },
  ];

  return { stages, guidance: missionGuidance(plan, develop) };
}

function verificationStatus(
  gates: PipelineNodeStatus,
  critic: PipelineNodeStatus,
  develop: MissionRunJobView | null,
): PipelineNodeStatus {
  if (develop?.result?.outcome === "awaiting-scope-decision") return "failed";
  if (gates === "failed" || critic === "failed") return "failed";
  if (gates === "active" || critic === "active") return "active";
  if (gates === "completed" && critic === "completed") return "completed";
  if (develop?.status === "running" && gates === "completed") return "active";
  if (develop?.status === "completed" && (gates === "skipped" || critic === "skipped")) return "skipped";
  return "pending";
}

function completionStatus(develop: MissionRunJobView | null): PipelineNodeStatus {
  if (develop?.status === "failed" || develop?.result?.outcome === "escalated") return "failed";
  if (develop?.publication?.error) return "failed";
  if (develop && allRepositoriesPublished(develop)) return "completed";
  return "pending";
}

function publicationStatus(develop: MissionRunJobView | null): PipelineNodeStatus {
  if (develop?.status === "failed" || develop?.result?.outcome === "escalated") return "skipped";
  // A recorded developer override supersedes an otherwise-blocking "revise"/"escalate" verdict —
  // the developer has explicitly judged those objections don't block publishing (see
  // StepAggregateReview's override action), so this must not still read as failed/blocked.
  if (!develop?.aggregateReviewOverride
    && (develop?.aggregateReviewStatus === "failed" || develop?.aggregateReview?.disposition === "revise" || develop?.aggregateReview?.disposition === "escalate")) return "failed";
  if (develop && allRepositoriesPublished(develop)) return "completed";
  if (develop && repositoryIds(develop).some((repositoryId) => develop.runsByRepository?.[repositoryId]?.publication?.error)) return "failed";
  if (develop && (develop.aggregateReviewStatus === "skipped" || develop.aggregateReview?.disposition === "accept" || Boolean(develop.aggregateReviewOverride))
    && repositoryIds(develop).every((repositoryId) => develop.runsByRepository?.[repositoryId]?.result?.outcome === "done")) return "active";
  if (develop?.status === "completed" && develop.result?.outcome === "done" && !develop.repositoryIds) return "active";
  return "pending";
}

function missionGuidance(plan: PlanJob | null, develop: MissionRunJobView | null): MissionGuidance {
  if (plan === null) return {
    stage: "plan",
    title: "Prepare the mission",
    detail: "Confirm the selected story, repository, and planning options.",
    action: "Open mission setup",
  };
  if (plan.status === "running") return {
    stage: "plan",
    title: "Planning in progress",
    detail: `${plan.provider === "codex" ? "Codex" : "Claude"} is actively reading ${(plan.repositoryIds ?? [plan.repositoryId]).length} selected ${(plan.repositoryIds ?? [plan.repositoryId]).length === 1 ? "repository" : "repositories"} and building the implementation plan. This can take several minutes.`,
    action: "View live status",
  };
  if (plan.status === "failed") return {
    stage: "plan",
    title: "Planning needs attention",
    detail: plan.error ?? "The planning run failed before producing a plan.",
    action: "Return to mission setup",
  };
  if (plan.behavioralReviewStatus === "running") return {
    stage: "review",
    title: "Targeted behavioral review is running",
    detail: "The independent critic is opening current files to confirm or refute unsupported behavior claims.",
    action: "View claim verification",
  };
  if (Object.values(plan.behavioralClaimsByRepository ?? {}).flat().some((claim) => claim.status === "unverified" || claim.status === "refuted")) return {
    stage: "review",
    title: "Behavioral claims need revision",
    detail: "At least one implementation step makes an unverified or refuted claim about current code behavior.",
    action: "Review flagged claims",
  };
  if (plan.reviewStatus === "running") return {
    stage: "review",
    title: "Independent review is running",
    detail: "The other provider is challenging the plan without changing it.",
    action: "View review activity",
  };
  if (plan.developmentApproval === null) return {
    stage: plan.reviewStatus === "completed" ? "approve" : "review",
    title: plan.reviewStatus === "failed" ? "Review failed; the plan is still available" : "Review the proposed plan",
    detail: plan.reviewStatus === "completed"
      ? "Review feedback is available. Continue when the Task drafts are ready for approval."
      : "Cross-provider review is optional. Inspect the plan before continuing to approval.",
    action: plan.reviewStatus === "completed" ? "Open approval" : "Open plan review",
  };
  if (isNoCodeMission(plan)) return {
    stage: "complete",
    title: "Mission complete — no changes required",
    detail: "Every selected repository was scoped out using evidence backed by the planning tool-call audit.",
    action: "View verified evidence",
  };
  if (develop === null) return {
    stage: "develop",
    title: "Development is approved",
    detail: "Review the scope boundary, then start implementation in an isolated worktree.",
    action: "Open development",
  };
  if (develop.status === "failed") return {
    stage: "develop",
    title: "The develop harness needs attention",
    detail: develop.error ?? "The develop run failed before returning a mission result.",
    action: "View failure and retry",
  };
  if (develop.status === "running") {
    if (develop.aggregateReviewStatus === "running") return {
      stage: "verify",
      title: "Cross-repository consistency review is running",
      detail: "The independent reviewer is checking contracts and dependencies across every accepted repository.",
      action: "View aggregate review",
    };
    const last = develop.stagesRun.at(-1);
    if (last === "gates" || last === "develop-critic") return {
      stage: "verify",
      title: last === "gates" ? "Deterministic verification is running" : "The diff critic is reviewing the implementation",
      detail: last === "gates"
        ? "Checking scope, regressions, secrets, and unfinished markers."
        : "Reviewing the approved plan and diff for evidence-backed objections.",
      action: "View live verification",
    };
    return {
      stage: "develop",
      title: "Development is running",
      detail: "The approved plan is being implemented in an isolated worktree.",
      action: "View develop activity",
    };
  }
  if (develop.result?.outcome === "escalated") return {
    stage: "complete",
    title: "Developer attention is required",
    detail: develop.result.reason ?? "The mission escalated instead of completing.",
    action: "Review escalation",
  };
  if (develop.result?.outcome === "awaiting-scope-decision") return {
    stage: "verify",
    title: develop.scopeReviewStatus === "running" ? "Planning agent is reviewing scope" : "Developer scope decision required",
    detail: develop.scopeReviewStatus === "running"
      ? "The planning role is comparing the additional-file diff with the approved plan and acceptance criteria."
      : "Review recommendations for files outside the approved write boundary, then approve or reject each path.",
    action: "Review additional files",
  };
  if (develop.aggregateReview?.disposition === "revise" && !develop.aggregateReviewOverride) return {
    stage: "verify",
    title: "Cross-repository revisions are required",
    detail: "Confirm the affected repositories. Their downstream dependents will be reopened automatically.",
    action: "Review aggregate objections",
  };
  if (allRepositoriesPublished(develop)) return {
    stage: "complete",
    title: "Publication is complete",
    detail: "Every repository has completed its configured publication flow.",
    action: "Open code review",
  };
  if (develop.publication?.error) return {
    stage: "publish",
    title: "Publish needs attention",
    detail: develop.publication.error,
    action: "Review and retry publish",
  };
  return {
    stage: "publish",
    title: develop.publication?.dryRun ? "Publish preview is ready" : "Ready for developer review and publish",
    detail: develop.publication?.dryRun
      ? "The branch, target, and commit were validated without making an external change."
      : "Verification and criticism completed. Review the implementation before approving the branch push and code review.",
    action: "Review and publish",
  };
}

function isNoCodeMission(plan: PlanJob | null): boolean {
  if (!plan) return false;
  const ids = plan.repositoryIds ?? [plan.repositoryId];
  if (ids.length === 0) return false;
  return ids.every((repositoryId) =>
    (plan.approvedPathsByRepository?.[repositoryId] ?? plan.plannedPathsByRepository?.[repositoryId] ?? plan.approvedPlannedPaths ?? plan.plannedPaths ?? []).length === 0
    && (plan.scopeDispositionByRepository?.[repositoryId] ?? "verified-no-change") === "verified-no-change"
    && plan.applicabilityByRepository?.[repositoryId]?.role !== "unknown"
    && plan.scopeOutVerificationByRepository?.[repositoryId]?.status === "verified",
  );
}

function repositoryIds(develop: MissionRunJobView): string[] {
  return develop.repositoryIds ?? (develop.repositoryId ? [develop.repositoryId] : []);
}

function allRepositoriesPublished(develop: MissionRunJobView): boolean {
  const ids = repositoryIds(develop);
  return ids.length > 0
    ? ids.every((repositoryId) => {
      const publication = develop.runsByRepository?.[repositoryId]?.publication;
      return publication?.published === true && (publication.scm !== "gitlab" || publication.merge?.merged === true);
    })
    : develop.publication?.published === true && (develop.publication.scm !== "gitlab" || develop.publication.merge?.merged === true);
}

function planStatus(plan: PlanJob | null): PipelineNodeStatus {
  if (plan === null) return "pending";
  if (plan.status === "running") return "active";
  if (plan.status === "failed") return "failed";
  return "completed";
}

function criticStatus(plan: PlanJob | null, approved: boolean): PipelineNodeStatus {
  if (plan?.status === "failed") return "skipped";
  if (plan?.behavioralReviewStatus === "running") return "active";
  if (plan?.behavioralReviewStatus === "failed") return "failed";
  if (Object.values(plan?.behavioralClaimsByRepository ?? {}).flat().some((claim) => claim.status === "unverified" || claim.status === "refuted")) return "failed";
  if (plan?.behavioralReviewStatus === "completed") return "completed";
  if (plan?.reviewStatus === "running") return "active";
  if (plan?.reviewStatus === "completed") return "completed";
  if (plan?.reviewStatus === "failed") return "failed";
  return approved ? "skipped" : "pending";
}

function providerLabel(provider: "claude" | "codex"): string {
  return provider === "claude" ? "Claude" : "Codex";
}
