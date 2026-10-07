import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskLinkError, type AzureDevOpsCli, type CreatedTask } from "../ado/azure-devops-cli.js";
import { approveMission, createdTasksFrom } from "./mission-approval.js";

// Audit records go to a throwaway root so test runs never leave fake approval
// history in the real ./runtime/missions directory.
let runtimeRoot: string;
beforeAll(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), "mission-control-test-"));
  process.env.MISSION_CONTROL_RUNTIME_ROOT = runtimeRoot;
});
afterAll(() => {
  delete process.env.MISSION_CONTROL_RUNTIME_ROOT;
  rmSync(runtimeRoot, { recursive: true, force: true });
});

function task(id: number, title = `Task ${id}`): CreatedTask {
  return { id, title, url: `https://dev.azure.com/org/Project/_workitems/edit/${id}` };
}

/** Minimal stand-in: approveMission only ever calls createTask. */
function fakeClient(createTask: ReturnType<typeof vi.fn>): AzureDevOpsCli {
  return { createTask } as unknown as AzureDevOpsCli;
}

const repos = [
  { id: "RepoA", title: "Implement in RepoA", description: "do A" },
  { id: "RepoB", title: "Implement in RepoB", description: "do B" },
];

describe("approveMission", () => {
  it("never touches Azure DevOps on a dry run", async () => {
    const createTask = vi.fn();
    const result = await approveMission(fakeClient(createTask), {
      missionId: "dry-1", parentStoryId: 42, repos, dryRun: true,
    });

    expect(createTask).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.task)).toEqual([null, null]);
    expect(result.auditPath).toMatch(/tasks-simulated\.json$/);
  });

  it("creates one Task per repo under the parent story", async () => {
    const createTask = vi.fn()
      .mockResolvedValueOnce(task(101))
      .mockResolvedValueOnce(task(102));

    const result = await approveMission(fakeClient(createTask), {
      missionId: "real-1", parentStoryId: 42, repos, dryRun: false,
    });

    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask).toHaveBeenCalledWith({ parentStoryId: 42, title: "Implement in RepoA", description: "do A" });
    expect(result.outcomes.map((outcome) => outcome.task?.id)).toEqual([101, 102]);
    expect(result.outcomes.every((outcome) => outcome.error === null)).toBe(true);
    // Real approvals must not share a filename, or a retry would erase this record.
    expect(result.auditPath).toMatch(/tasks-created-.*\.json$/);
  });

  it("skips repos an earlier approval already created, so re-approving cannot duplicate Tasks", async () => {
    const createTask = vi.fn().mockResolvedValueOnce(task(102));

    const result = await approveMission(fakeClient(createTask), {
      missionId: "retry-1", parentStoryId: 42, repos, dryRun: false,
      alreadyCreated: { RepoA: task(101) },
    });

    // Only the not-yet-created repo hits ADO.
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "Implement in RepoB" }));

    const [a, b] = result.outcomes;
    expect(a).toMatchObject({ repositoryId: "RepoA", alreadyCreated: true, error: null });
    expect(a.task?.id).toBe(101);
    expect(b).toMatchObject({ repositoryId: "RepoB", alreadyCreated: false });
    expect(b.task?.id).toBe(102);
  });

  it("records a per-repo failure without aborting the remaining repos", async () => {
    const createTask = vi.fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce(task(102));

    const result = await approveMission(fakeClient(createTask), {
      missionId: "partial-1", parentStoryId: 42, repos, dryRun: false,
    });

    expect(result.outcomes[0]).toMatchObject({ repositoryId: "RepoA", task: null, unlinked: false });
    expect(result.outcomes[0].error).toMatch(/permission denied/);
    expect(result.outcomes[1].task?.id).toBe(102);
    // Only the succeeded repo is remembered, so a retry re-attempts RepoA.
    expect(Object.keys(createdTasksFrom(result.outcomes))).toEqual(["RepoB"]);
  });

  it("reports a created-but-unlinked Task instead of claiming nothing was created", async () => {
    const orphan = task(101);
    const createTask = vi.fn()
      .mockRejectedValueOnce(new TaskLinkError(orphan, "Task 101 was created but could not be linked to User Story 42: boom"))
      .mockResolvedValueOnce(task(102));

    const result = await approveMission(fakeClient(createTask), {
      missionId: "orphan-1", parentStoryId: 42, repos, dryRun: false,
    });

    const [a] = result.outcomes;
    expect(a.task).toEqual(orphan); // the Task exists — must not be reported as null
    expect(a.unlinked).toBe(true);
    expect(a.error).toMatch(/could not be linked/);
    // It still counts as created, so a retry won't make a second orphan.
    expect(Object.keys(createdTasksFrom(result.outcomes)).sort()).toEqual(["RepoA", "RepoB"]);
  });

  it("rejects an empty repo list", async () => {
    await expect(approveMission(fakeClient(vi.fn()), {
      missionId: "empty-1", parentStoryId: 42, repos: [], dryRun: true,
    })).rejects.toThrow(/at least one repository/i);
  });

  it("writes an audit record matching the outcomes", async () => {
    const createTask = vi.fn().mockResolvedValueOnce(task(101));
    const result = await approveMission(fakeClient(createTask), {
      missionId: "audit-1", parentStoryId: 42, repos: [repos[0]], dryRun: false,
    });

    const audit = JSON.parse(readFileSync(result.auditPath, "utf8"));
    expect(audit).toMatchObject({ missionId: "audit-1", parentStoryId: 42, dryRun: false });
    expect(audit.outcomes[0].task.id).toBe(101);
  });
});
