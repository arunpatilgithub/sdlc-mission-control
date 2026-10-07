import { describe, expect, it } from "vitest";
import type { MissionRunJobView } from "./develop-view";
import { buildPipeline, buildUserProgress, canDevelop, isMissionActivityRunning, stageAgentLabel } from "./mission-pipeline";
import type { PlanJob } from "./types";

const createdTask = { id: 1, title: "Implement story", url: "https://example.com/task/1" };

function plan(overrides: Partial<PlanJob> = {}): PlanJob {
  return {
    id: "plan-1",
    status: "completed",
    provider: "codex",
    repositoryId: "Repo",
    worktreePath: "/tmp/repo",
    branch: "main",
    startedAt: "2026-08-20T18:00:00.000Z",
    completedAt: "2026-08-20T18:01:00.000Z",
    output: "Plan",
    error: null,
    repoScope: { primaryRepo: "Repo", additionalRepos: [], parseError: null },
    plannedPaths: ["src/feature.js"],
    plannedPathsParseError: null,
    approvedPlannedPaths: null,
    usage: null,
    priorReviewFeedback: null,
    reviewStatus: "idle",
    review: null,
    reviewError: null,
    packet: {
      mode: "fast",
      historyPolicy: "none",
      repositoryStrategy: "existing",
      phase: "implementation-plan",
      proposedRepositoryName: null,
      story: { id: 42, title: "Story" },
      repository: { baselineCommit: "abc", appType: "Node" },
      likelyFiles: [],
    },
    createdTasks: {},
    developmentApproval: null,
    ...overrides,
  };
}

function develop(
  status: MissionRunJobView["status"],
  stagesRun: MissionRunJobView["stagesRun"],
): MissionRunJobView {
  return {
    id: "run-1", status, stagesRun, result: null, publication: null,
    scopeReviewStatus: "idle", scopeReview: null, scopeReviewError: null, scopeDecisions: null,
    error: status === "failed" ? "failed" : null,
  };
}

function completedRun(outcome: "done" | "escalated"): MissionRunJobView {
  return {
    id: "run-1",
    status: "completed",
    stagesRun: outcome === "done" ? ["develop", "gates", "develop-critic"] : ["develop", "gates"],
    publication: null,
    scopeReviewStatus: "idle",
    scopeReview: null,
    scopeReviewError: null,
    scopeDecisions: null,
    error: null,
    result: {
      outcome,
      reason: outcome === "escalated" ? "Revision cap reached" : null,
      stagesRun: outcome === "done" ? ["develop", "gates", "develop-critic"] : ["develop", "gates"],
      develop: null,
      gateReport: null,
      verdict: null,
      ledger: { totalTokens: 0, costUSD: null, unreportedStages: [] },
    },
  };
}

describe("buildPipeline", () => {
  it("returns six pending nodes in order with the correct source when no jobs exist", () => {
    const nodes = buildPipeline(null, null);

    expect(nodes.map((node) => node.id)).toEqual([
      "plan", "plan-critic", "approval", "develop", "gates", "develop-critic",
    ]);
    expect(nodes[0].status).toBe("pending");
    expect(nodes.map((node) => node.source)).toEqual([
      "derived", "derived", "derived", "reported", "reported", "reported",
    ]);
  });

  it("marks a running plan active and all later nodes pending", () => {
    const nodes = buildPipeline(plan({ status: "running", completedAt: null, output: null }), null);

    expect(nodes[0].status).toBe("active");
    expect(nodes.slice(1).every((node) => node.status === "pending")).toBe(true);
  });

  it("marks an optional review skipped after tasks are created", () => {
    const nodes = buildPipeline(plan({
      reviewStatus: "idle",
      createdTasks: { Repo: createdTask },
      developmentApproval: { mode: "ado-tasks", approvedAt: "2026-08-20T18:02:00.000Z" },
    }), null);

    expect(nodes.find((node) => node.id === "plan-critic")?.status).toBe("skipped");
    expect(nodes.find((node) => node.id === "approval")?.status).toBe("completed");
  });

  it("preserves repeated reported stages as attempt counts", () => {
    const nodes = buildPipeline(
      plan({ createdTasks: { Repo: createdTask }, developmentApproval: { mode: "ado-tasks", approvedAt: "2026-08-20T18:02:00.000Z" } }),
      develop("completed", ["develop", "gates", "develop", "gates", "develop-critic"]),
    );

    expect(nodes.find((node) => node.id === "develop")).toMatchObject({ attempt: 2, status: "completed" });
    expect(nodes.find((node) => node.id === "gates")).toMatchObject({ attempt: 2, status: "completed" });
    expect(nodes.find((node) => node.id === "develop-critic")).toMatchObject({ attempt: 1, status: "completed" });
  });

  it("marks a critic skipped when an escalated mission finishes at gates", () => {
    const nodes = buildPipeline(
      plan({ createdTasks: { Repo: createdTask }, developmentApproval: { mode: "ado-tasks", approvedAt: "2026-08-20T18:02:00.000Z" } }),
      develop("completed", ["develop", "gates"]),
    );

    expect(nodes.find((node) => node.id === "develop-critic")?.status).toBe("skipped");
  });

  it("marks the last reported stage failed after a harness failure", () => {
    const nodes = buildPipeline(
      plan({ createdTasks: { Repo: createdTask }, developmentApproval: { mode: "ado-tasks", approvedAt: "2026-08-20T18:02:00.000Z" } }),
      develop("failed", ["develop"]),
    );

    expect(nodes.find((node) => node.id === "develop")?.status).toBe("failed");
    expect(nodes.find((node) => node.id === "gates")?.status).toBe("skipped");
    expect(nodes.find((node) => node.id === "develop-critic")?.status).toBe("skipped");
  });

  it("keeps planning provenance derived and runner provenance reported", () => {
    const nodes = buildPipeline(plan(), develop("running", ["develop"]));

    expect(nodes.slice(0, 3).every((node) => node.source === "derived")).toBe(true);
    expect(nodes.slice(3).every((node) => node.source === "reported")).toBe(true);
  });

  it("restores approval and develop reachability from a reloaded plan job", () => {
    const reloaded: PlanJob = JSON.parse(JSON.stringify(plan({
      reviewStatus: "idle",
      createdTasks: { Repo: createdTask },
      developmentApproval: { mode: "ado-tasks", approvedAt: "2026-08-20T18:02:00.000Z" },
    })));
    const nodes = buildPipeline(reloaded, null);

    expect(nodes.find((node) => node.id === "approval")?.status).toBe("completed");
    expect(nodes.find((node) => node.id === "plan-critic")?.status).toBe("skipped");
    expect(canDevelop(reloaded, null)).toBe(true);
  });

  it("restores skipped Task creation as an approved Develop path without fabricating Tasks", () => {
    const reloaded: PlanJob = JSON.parse(JSON.stringify(plan({
      createdTasks: {},
      developmentApproval: { mode: "tasks-skipped", approvedAt: "2026-08-20T18:02:00.000Z" },
    })));
    const nodes = buildPipeline(reloaded, null);

    expect(reloaded.createdTasks).toEqual({});
    expect(nodes.find((node) => node.id === "approval")?.status).toBe("completed");
    expect(nodes.find((node) => node.id === "develop")?.status).toBe("pending");
    expect(canDevelop(reloaded, null)).toBe(true);
  });

  it("skips review and approval when planning fails", () => {
    const nodes = buildPipeline(plan({
      status: "failed",
      completedAt: "2026-08-20T18:01:00.000Z",
      output: null,
      error: "planner failed",
    }), null);

    expect(nodes.find((node) => node.id === "plan")?.status).toBe("failed");
    expect(nodes.find((node) => node.id === "plan-critic")?.status).toBe("skipped");
    expect(nodes.find((node) => node.id === "approval")?.status).toBe("skipped");
  });
});

describe("verified no-change mission", () => {
  it("skips implementation stages and completes after approval", () => {
    const noChange = plan({
      repositoryIds: ["Repo"],
      plannedPaths: [],
      plannedPathsByRepository: { Repo: [] },
      approvedPlannedPaths: [],
      approvedPathsByRepository: { Repo: [] },
      scopeOutVerificationByRepository: {
        Repo: { status: "verified", evidence: ["src/current.ts:4"], unmatchedEvidence: [] },
      },
      developmentApproval: { mode: "tasks-skipped", approvedAt: "2026-09-15T12:00:00Z" },
    });

    expect(canDevelop(noChange, null)).toBe(false);
    expect(buildUserProgress(noChange, null).stages.slice(3).map((stage) => stage.status))
      .toEqual(["skipped", "skipped", "skipped", "completed"]);
  });
});

describe("buildUserProgress", () => {
  it("does not report work as running while mission setup awaits the developer", () => {
    expect(isMissionActivityRunning(null, null)).toBe(false);
    expect(isMissionActivityRunning(plan(), null)).toBe(false);
  });

  it("reports a spinner only for a dispatched planning or Develop operation", () => {
    expect(isMissionActivityRunning(plan({ status: "running", completedAt: null, output: null }), null)).toBe(true);
    expect(isMissionActivityRunning(plan(), develop("running", ["develop"]))).toBe(true);
  });

  it("starts with Plan as the single current user stage", () => {
    const progress = buildUserProgress(null, null);

    expect(progress.stages.find(({ id }) => id === "plan")?.status).toBe("active");
    expect(progress.guidance.stage).toBe("plan");
  });

  it("makes optional review current after planning without claiming approval occurred", () => {
    const progress = buildUserProgress(plan(), null);

    expect(progress.stages.find(({ id }) => id === "review")?.status).toBe("active");
    expect(progress.stages.find(({ id }) => id === "approve")?.status).toBe("pending");
    expect(progress.guidance.stage).toBe("review");
  });

  it("moves to Develop after approval and preserves a skipped optional review", () => {
    const progress = buildUserProgress(plan({
      createdTasks: { Repo: createdTask },
      developmentApproval: { mode: "ado-tasks", approvedAt: "2026-08-20T18:02:00.000Z" },
    }), null);

    expect(progress.stages.find(({ id }) => id === "review")?.status).toBe("skipped");
    expect(progress.stages.find(({ id }) => id === "approve")?.status).toBe("completed");
    expect(progress.stages.find(({ id }) => id === "develop")?.status).toBe("active");
  });

  it("aggregates gates and critic activity into Verify", () => {
    const progress = buildUserProgress(
      plan({ createdTasks: { Repo: createdTask }, developmentApproval: { mode: "ado-tasks", approvedAt: "2026-08-20T18:02:00.000Z" } }),
      develop("running", ["develop", "gates"]),
    );

    expect(progress.stages.find(({ id }) => id === "verify")?.status).toBe("active");
    expect(progress.guidance.stage).toBe("verify");
  });

  it("keeps Verify actionable while the planning agent advises on additional files", () => {
    const awaiting = completedRun("escalated");
    awaiting.result = {
      ...awaiting.result!,
      outcome: "awaiting-scope-decision",
      reason: "2 changed paths require developer scope review",
    };
    awaiting.scopeReviewStatus = "running";
    const progress = buildUserProgress(
      plan({ developmentApproval: { mode: "tasks-skipped", approvedAt: "2026-08-20T18:02:00.000Z" } }),
      awaiting,
    );

    expect(progress.stages.find(({ id }) => id === "verify")?.status).toBe("failed");
    expect(progress.guidance).toMatchObject({ stage: "verify", title: "Planning agent is reviewing scope" });
  });

  it("moves a verified result to Publish and completes only after a PR exists", () => {
    const approved = plan({
      createdTasks: { Repo: createdTask },
      developmentApproval: { mode: "ado-tasks", approvedAt: "2026-08-20T18:02:00.000Z" },
    });
    const ready = completedRun("done");
    const published: MissionRunJobView = {
      ...ready,
      publication: {
        missionId: "plan-1", developRunId: "run-1", storyId: 42, repositoryId: "Repo",
        dryRun: false, sourceBranch: "feature/arpatil/PUB-42", targetBranch: "main",
        commit: "abc", push: "pushed", pullRequest: { id: 701, title: "PR", url: "https://example/pr/701" },
        published: true, error: null, completedAt: "2026-08-20T18:03:00.000Z",
      },
    };

    expect(buildUserProgress(approved, ready).stages.find(({ id }) => id === "publish")?.status).toBe("active");
    expect(buildUserProgress(approved, ready).stages.find(({ id }) => id === "complete")?.status).toBe("pending");
    expect(buildUserProgress(approved, ready).guidance.stage).toBe("publish");
    expect(buildUserProgress(approved, published).stages.find(({ id }) => id === "publish")?.status).toBe("completed");
    expect(buildUserProgress(approved, published).stages.find(({ id }) => id === "complete")?.status).toBe("completed");
    expect(buildUserProgress(approved, published).guidance.stage).toBe("complete");
    expect(buildUserProgress(approved, completedRun("escalated")).stages.find(({ id }) => id === "complete")?.status).toBe("failed");
    expect(buildUserProgress(approved, completedRun("escalated")).guidance.title).toMatch(/attention/i);
  });

  it("does not present a failed develop harness as verification or completion", () => {
    const progress = buildUserProgress(
      plan({ createdTasks: { Repo: createdTask }, developmentApproval: { mode: "ado-tasks", approvedAt: "2026-08-20T18:02:00.000Z" } }),
      develop("failed", ["develop"]),
    );

    expect(progress.stages.find(({ id }) => id === "develop")?.status).toBe("failed");
    expect(progress.stages.find(({ id }) => id === "complete")?.status).toBe("failed");
    expect(progress.guidance.stage).toBe("develop");
  });

  it("keeps multi-repository Publish locked until aggregate review accepts", () => {
    const base = completedRun("done");
    const runState = {
      repositoryId: "Api",
      status: "completed" as const,
      stagesRun: ["develop", "gates", "develop-critic"] as const,
      result: base.result,
      publication: null,
      scopeReviewStatus: "idle" as const,
      scopeReview: null,
      scopeReviewError: null,
      scopeDecisions: null,
      error: null,
    };
    const multi = {
      ...base,
      repositoryId: "Ui",
      repositoryIds: ["Api", "Ui"],
      executionOrder: ["Api", "Ui"],
      currentRepositoryId: "Ui",
      runsByRepository: {
        Api: { ...runState, repositoryId: "Api" },
        Ui: { ...runState, repositoryId: "Ui" },
      },
      aggregateReviewStatus: "running" as const,
      aggregateReview: null,
      aggregateReviewError: null,
      aggregateTokens: 1_000,
      aggregateTokenCeiling: 1_000_000,
    } satisfies MissionRunJobView;

    expect(buildUserProgress(plan(), multi).stages.find(({ id }) => id === "publish")?.status).toBe("pending");
    const accepted: MissionRunJobView = {
      ...multi,
      aggregateReviewStatus: "completed",
      aggregateReview: {
        disposition: "accept", affectedRepositories: [], objections: [], parseError: null,
        output: "accepted", createdAt: "2026-08-20T18:03:00.000Z",
      },
    };
    expect(buildUserProgress(plan(), accepted).stages.find(({ id }) => id === "publish")?.status).toBe("active");
  });
});

describe("stageAgentLabel", () => {
  it("returns no provider before a mission starts", () => {
    expect(stageAgentLabel("review", null, null)).toBeNull();
  });

  it("shows recorded providers and distinguishes deterministic verification", () => {
    const planning = plan({ provider: "codex", reviewStatus: "running" });
    const gates = develop("running", ["develop", "gates"]);
    const critic = develop("running", ["develop", "gates", "develop-critic"]);

    expect(stageAgentLabel("plan", planning, null)).toBe("Codex");
    expect(stageAgentLabel("review", planning, null)).toBe("Claude");
    expect(stageAgentLabel("develop", planning, develop("running", ["develop"]))).toBe("Codex");
    expect(stageAgentLabel("verify", planning, gates)).toBe("Deterministic gates");
    expect(stageAgentLabel("verify", planning, critic)).toBe("Claude + gates");
    expect(stageAgentLabel("publish", planning, critic)).toBeNull();
  });
});
