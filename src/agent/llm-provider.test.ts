import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunTimeline, agentRunTiming, claudeReadOnlyArgs, readOnlyAttemptResultPath, readOnlyAgentArgs, resolveClaudeReadTools, writingAgentArgs } from "./llm-provider.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("resolveClaudeReadTools", () => {
  it("returns the fixed read-only baseline when no skill declares extra tools", () => {
    expect(resolveClaudeReadTools()).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
    expect(resolveClaudeReadTools()).toHaveLength(3);
  });

  it("adds a skill's declared extra tool to the baseline", () => {
    expect(resolveClaudeReadTools(["TodoWrite"])).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "TodoWrite"]));
  });

  it("never grants a denied tool, even if a skill declares it", () => {
    const resolved = resolveClaudeReadTools(["Bash", "Write", "Task"]);
    expect(resolved).not.toContain("Bash");
    expect(resolved).not.toContain("Write");
    expect(resolved).not.toContain("Task");
  });

  it("de-duplicates a declared tool that is already in the baseline", () => {
    expect(resolveClaudeReadTools(["Read"])).toHaveLength(3);
  });
});

describe("writingAgentArgs", () => {
  it("disables native web research and sandbox command networking for Develop", () => {
    const args = writingAgentArgs({ workingDir: "/worktree", resultPath: "/tmp/result.md", prompt: "implement" });

    expect(args).toEqual(expect.arrayContaining([
      "web_search=\"disabled\"",
      "sandbox_workspace_write.network_access=false",
    ]));
  });
});

describe("readOnlyAgentArgs", () => {
  it("preserves the read-only default when no reasoning override is supplied", () => {
    const args = readOnlyAgentArgs({ workingDir: "/worktree", resultPath: "/tmp/result.md", prompt: "plan" });

    expect(args).toEqual([
      "exec", "--sandbox", "read-only", "--ephemeral", "--color", "never",
      "--json", "--output-last-message", "/tmp/result.md", "--cd", "/worktree",
      "-c", "web_search=\"disabled\"", "plan",
    ]);
    expect(args.join(" ")).not.toContain("model_reasoning_effort");
  });

  it("adds a Codex reasoning override without weakening the read-only constraints", () => {
    const args = readOnlyAgentArgs({ workingDir: "/worktree", resultPath: "/tmp/result.md", prompt: "plan", reasoningEffort: "low" });

    expect(args).toEqual(expect.arrayContaining([
      "--sandbox", "read-only", "web_search=\"disabled\"", "-c", "model_reasoning_effort=\"low\"",
    ]));
  });
});

describe("claudeReadOnlyArgs", () => {
  it("can make a data-only turn without widening the fixed read-only baseline", () => {
    const args = claudeReadOnlyArgs({ noTools: true });

    expect(args).toEqual(expect.arrayContaining(["--allowedTools", "", "--disallowedTools"]));
    expect(args.join(",")).toContain("Bash");
    expect(args.join(",")).toContain("WebFetch");
  });
});

describe("readOnlyAttemptResultPath", () => {
  it("gives every Codex read-only attempt an isolated artifact instead of reusing a stale result", () => {
    const requested = "/tmp/planning/mission.canonical-identifier-repair.md";
    const first = readOnlyAttemptResultPath(requested);
    const second = readOnlyAttemptResultPath(requested);

    expect(first).not.toBe(requested);
    expect(second).not.toBe(requested);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^\/tmp\/planning\/mission\.canonical-identifier-repair\.attempt-[0-9a-f-]+\.md$/);
  });
});

describe("RunTimeline", () => {
  it("writes an isolated timing sidecar without changing the raw event stream", () => {
    const directory = mkdtempSync(join(tmpdir(), "run-timeline-"));
    temporaryPaths.push(directory);
    const eventsPath = join(directory, "job.repo.scout.events.jsonl");
    writeFileSync(eventsPath, "raw provider event\n", "utf8");
    let wallMs = 1_000;
    let monotonicNs = 0n;
    const timeline = new RunTimeline(eventsPath, {
      wallNow: () => wallMs,
      monotonicNow: () => monotonicNs,
    });

    wallMs += 10;
    monotonicNs += 10_000_000n;
    timeline.recordChunk("stdout", Buffer.from("first"));
    wallMs += 40;
    monotonicNs += 35_000_000n;
    timeline.recordChunk("stderr", Buffer.from("xy"));
    wallMs += 50;
    monotonicNs += 50_000_000n;
    const timing = timeline.finish("exit", 0);

    expect(readFileSync(eventsPath, "utf8")).toBe("raw provider event\n");
    expect(timing).toEqual({
      wallMs: 100,
      monotonicMs: 95,
      sleepDriftMs: 5,
      firstOutputMs: 10,
      maxGapMs: 35,
      chunkCount: 2,
      endedBy: "exit",
    });
    const records = readFileSync(join(directory, "job.repo.scout.timing.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => record.event)).toEqual(["spawned", "chunk", "chunk", "terminal"]);
    expect(records[1]).toMatchObject({ stream: "stdout", bytes: 5, monotonicMs: 10, gapMs: 0 });
    expect(records[2]).toMatchObject({ stream: "stderr", bytes: 2, monotonicMs: 45, gapMs: 35 });
    expect(records[3]).toMatchObject({ terminal: "exit", endedBy: "exit", exitCode: 0, timing });
  });

  it("records monotonic drift when wall time advances while the process is paused", () => {
    const directory = mkdtempSync(join(tmpdir(), "run-timeline-drift-"));
    temporaryPaths.push(directory);
    let wallMs = 10_000;
    let monotonicNs = 0n;
    const timeline = new RunTimeline(join(directory, "job.events.jsonl"), {
      wallNow: () => wallMs,
      monotonicNow: () => monotonicNs,
    });

    wallMs += 6_000;
    monotonicNs += 100_000_000n;

    expect(timeline.finish("timeout")).toMatchObject({ wallMs: 6_000, monotonicMs: 100, sleepDriftMs: 5_900, endedBy: "timeout" });
  });

  it("records spawn errors distinctly and ignores chunks after its terminal record", () => {
    const directory = mkdtempSync(join(tmpdir(), "run-timeline-terminal-"));
    temporaryPaths.push(directory);
    const eventsPath = join(directory, "job.events.jsonl");
    const timeline = new RunTimeline(eventsPath);

    const timing = timeline.finish("spawn-error");
    timeline.recordChunk("stdout", Buffer.from("late output"));

    expect(timing.endedBy).toBe("spawn-error");
    const records = readFileSync(join(directory, "job.timing.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ event: "terminal", terminal: "spawn-error", endedBy: "spawn-error" });
  });

  it("makes timing available to a caller when a read-only run fails", () => {
    const timing = { wallMs: 19, monotonicMs: 17, sleepDriftMs: 2, firstOutputMs: null, maxGapMs: 9, chunkCount: 1, endedBy: "token-budget" as const };
    const error = Object.assign(new Error("token budget exceeded"), { timing });

    expect(agentRunTiming(error)).toEqual(timing);
    expect(agentRunTiming(new Error("without timing"))).toBeNull();
  });

  it("never lets diagnostic persistence change an agent result", () => {
    const directory = mkdtempSync(join(tmpdir(), "run-timeline-unwritable-"));
    temporaryPaths.push(directory);
    const file = join(directory, "not-a-directory");
    writeFileSync(file, "block timing output", "utf8");

    expect(() => {
      const timeline = new RunTimeline(join(file, "job.events.jsonl"));
      timeline.recordChunk("stdout", Buffer.from("output"));
      timeline.finish("token-budget");
    }).not.toThrow();
  });
});
