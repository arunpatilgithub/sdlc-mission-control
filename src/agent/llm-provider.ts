import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { UsageCollector, type RunUsage } from "./usage.js";

export type Provider = "claude" | "codex";

export type AgentRunEnd = "exit" | "timeout" | "stall" | "token-budget" | "spawn-error";

export interface AgentRunTiming {
  wallMs: number;
  monotonicMs: number;
  sleepDriftMs: number;
  firstOutputMs: number | null;
  maxGapMs: number;
  chunkCount: number;
  endedBy: AgentRunEnd;
}

export interface RunTimelineClock {
  wallNow(): number;
  monotonicNow(): bigint;
}

export interface AgentRunResult {
  output: string;
  usage: RunUsage;
  timing?: AgentRunTiming;
}

export interface AgentRunFailure extends Error {
  timing: AgentRunTiming;
}

export interface ReadOnlyRunOptions {
  provider: Provider;
  prompt: string;
  workingDir: string;
  timeoutMs: number;
  /** Aborts a read-only turn that reports more tokens than this runaway backstop. */
  maxTokens?: number;
  model?: string;
  /** Absolute paths for this run's audit log files. */
  eventsPath: string;
  stderrPath: string;
  /** Requested result-artifact basename; a Codex read-only turn derives an immutable attempt path from it. */
  resultPath: string;
  /** Codex-only: permits a read-only synthesis turn to run outside a Git checkout. */
  skipGitRepoCheck?: boolean;
  /** Codex-only: an explicit per-run override for the model's reasoning effort. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Claude-only: suppresses even the fixed read-only tool baseline for data-only extraction. */
  noTools?: boolean;
  /**
   * Additional Claude tools a skill declared it needs, beyond the fixed read-only baseline.
   * Only consulted on the Claude path — Codex has no tool identity to grant, its enforcement
   * is the OS sandbox regardless of what a skill declares. See resolveClaudeReadTools.
   */
  extraReadTools?: string[];
  onSpawn?: (pid: number | null) => void;
}

// Deliberately excludes Bash: a shell is an arbitrary write vector (redirection,
// git commit, curl), so allowing it would make the read-only promise unenforceable.
// Claude's native Read/Glob/Grep cover everything planning needs — only Codex needs
// a shell, and there it runs inside an OS-level read-only sandbox.
const CLAUDE_READ_TOOLS = ["Read", "Glob", "Grep"];
// The allow list alone is NOT sufficient: an allow-listed session was observed to still
// have ToolSearch and delegation tools available, and a subagent could carry write tools
// the parent was denied. So the write and delegation vectors are named explicitly —
// Task/Agent/Workflow because delegation launders permissions, WebFetch because a
// planning agent has no reason to send story content off the machine.
const CLAUDE_DENIED_TOOLS = [
  "Bash", "Write", "Edit", "NotebookEdit",
  "Task", "Agent", "Workflow",
  "WebFetch", "WebSearch",
];

/**
 * Runs a single planning turn on either provider, with no write-capable code path.
 *
 * The two providers are constrained by different mechanisms, which is worth being
 * precise about rather than calling both "sandboxed":
 *   - Codex: `--sandbox read-only`, enforced by the OS regardless of what the model does.
 *   - Claude: a tool allow/deny list enforced by the CLI — no shell and no edit tools.
 * Neither relies on the prompt's read-only instructions for enforcement.
 */
export function runReadOnlyAgent(options: ReadOnlyRunOptions): Promise<AgentRunResult> {
  return options.provider === "claude" ? runClaude(options) : runCodex(options);
}

/**
 * Merges a skill's declared extra tools into the fixed read-only baseline. The deny list
 * always wins — a skill can widen what it may read, never what it is forbidden to do —
 * so this is the only place the two lists are allowed to interact.
 */
export function resolveClaudeReadTools(extra: string[] = []): string[] {
  const merged = new Set([...CLAUDE_READ_TOOLS, ...extra]);
  for (const denied of CLAUDE_DENIED_TOOLS) merged.delete(denied);
  return [...merged];
}

/**
 * A prior result must never satisfy a new Codex invocation. Attempts get distinct artifacts
 * so a retry cannot settle from a stale --output-last-message file before its child finishes.
 */
export function readOnlyAttemptResultPath(resultPath: string): string {
  const extension = extname(resultPath);
  const stem = basename(resultPath, extension);
  return resolve(dirname(resultPath), `${stem}.attempt-${randomUUID()}${extension}`);
}

type TimelineStream = "stdout" | "stderr";

interface RunTimelineSnapshot {
  at: string;
  wallMs: number;
  monotonicMs: number;
  driftMs: number;
}

/**
 * The wall/monotonic delta distinguishes a silent provider from a machine that was asleep;
 * timing persistence must never change a planning result when its audit directory is unavailable.
 */
export class RunTimeline {
  private readonly sidecarPath: string;
  private readonly startedWallMs: number;
  private readonly startedMonotonicNs: bigint;
  private previousChunkMs: number | null = null;
  private firstOutputMs: number | null = null;
  private maxGapMs = 0;
  private chunkCount = 0;
  private terminal: AgentRunTiming | null = null;

  constructor(
    eventsPath: string,
    private readonly clock: RunTimelineClock = { wallNow: Date.now, monotonicNow: process.hrtime.bigint },
  ) {
    this.sidecarPath = timingSidecarPath(eventsPath);
    this.startedWallMs = this.clock.wallNow();
    this.startedMonotonicNs = this.clock.monotonicNow();
    this.write({ event: "spawned", spawnedAt: new Date(this.startedWallMs).toISOString(), monotonicStartNs: this.startedMonotonicNs.toString(), wallMs: 0, monotonicMs: 0, driftMs: 0 });
  }

  recordChunk(stream: TimelineStream, chunk: Buffer): void {
    if (this.terminal) return;
    const snapshot = this.snapshot();
    const gapMs = this.previousChunkMs === null ? 0 : Math.max(0, snapshot.monotonicMs - this.previousChunkMs);
    this.previousChunkMs = snapshot.monotonicMs;
    if (stream === "stdout" && this.firstOutputMs === null) this.firstOutputMs = snapshot.monotonicMs;
    this.maxGapMs = Math.max(this.maxGapMs, gapMs);
    this.chunkCount += 1;
    this.write({ event: "chunk", stream, ...snapshot, bytes: chunk.byteLength, gapMs });
  }

  finish(endedBy: AgentRunEnd, exitCode?: number | null): AgentRunTiming {
    if (this.terminal) return this.terminal;
    const snapshot = this.snapshot();
    this.terminal = {
      wallMs: Math.max(0, snapshot.wallMs),
      monotonicMs: snapshot.monotonicMs,
      sleepDriftMs: snapshot.driftMs,
      firstOutputMs: this.firstOutputMs,
      maxGapMs: this.maxGapMs,
      chunkCount: this.chunkCount,
      endedBy,
    };
    this.write({ event: "terminal", terminal: timelineTerminal(endedBy), endedBy, exitCode: exitCode ?? null, ...snapshot, timing: this.terminal });
    return this.terminal;
  }

  private snapshot(): RunTimelineSnapshot {
    const wallMs = this.clock.wallNow();
    const wallElapsedMs = wallMs - this.startedWallMs;
    const monotonicMs = Number((this.clock.monotonicNow() - this.startedMonotonicNs) / 1_000_000n);
    return { at: new Date(wallMs).toISOString(), wallMs: wallElapsedMs, monotonicMs, driftMs: wallElapsedMs - monotonicMs };
  }

  private write(record: Record<string, unknown>): void {
    try { appendFileSync(this.sidecarPath, `${JSON.stringify(record)}\n`); } catch { /* Timing is diagnostic only. */ }
  }
}

function timingSidecarPath(eventsPath: string): string {
  return eventsPath.endsWith(".events.jsonl")
    ? `${eventsPath.slice(0, -".events.jsonl".length)}.timing.jsonl`
    : `${eventsPath}.timing.jsonl`;
}

function timelineTerminal(endedBy: AgentRunEnd): "exit" | "timeout-kill" | "stall-kill" | "token-budget-kill" | "spawn-error" {
  if (endedBy === "timeout") return "timeout-kill";
  if (endedBy === "stall") return "stall-kill";
  if (endedBy === "token-budget") return "token-budget-kill";
  if (endedBy === "spawn-error") return "spawn-error";
  return "exit";
}

function agentRunFailure(error: Error, timing: AgentRunTiming): AgentRunFailure {
  return Object.assign(error, { timing });
}

export function agentRunTiming(error: unknown): AgentRunTiming | null {
  if (!(error instanceof Error)) return null;
  const timing = (error as Partial<AgentRunFailure>).timing;
  return timing && typeof timing.wallMs === "number" && typeof timing.monotonicMs === "number" && typeof timing.sleepDriftMs === "number"
    && (typeof timing.firstOutputMs === "number" || timing.firstOutputMs === null) && typeof timing.maxGapMs === "number"
    && typeof timing.chunkCount === "number" && ["exit", "timeout", "stall", "token-budget", "spawn-error"].includes(timing.endedBy)
    ? timing
    : null;
}

export interface WritingRunOptions extends Omit<ReadOnlyRunOptions, "provider"> {
  /**
   * Aborts the run once reported tokens exceed this budget. Providers report usage only
   * at turn boundaries, so this is a runaway backstop rather than a precise ceiling.
   */
  maxTokens?: number;
  /** File activity from Codex's structured stream, projected to paths by the Develop harness. */
  onFileActivity?: (event: { status: "started" | "completed"; paths: string[] }) => void;
  /** Safe summary of a structured agent tool event; raw commands and output remain audit-only. */
  onCommandActivity?: (event: { status: "started" | "completed"; detail: string }) => void;
  /** Rejects a command that would exceed the stage's authorized inspection boundary. */
  forbiddenCommand?: (command: string) => string | null;
}

export function writingAgentArgs(options: Pick<WritingRunOptions, "workingDir" | "resultPath" | "model" | "prompt">): string[] {
  const args = [
    "exec", "--sandbox", "workspace-write", "--ephemeral", "--color", "never",
    "--json", "--output-last-message", options.resultPath, "--cd", options.workingDir,
    "-c", "web_search=\"disabled\"",
    "-c", "sandbox_workspace_write.network_access=false",
  ];
  if (options.model) args.push("--model", options.model);
  args.push(options.prompt);
  return args;
}

/**
 * Runs an agent that is ALLOWED TO MODIFY FILES, confined to `workingDir`.
 *
 * Deliberately a separate function rather than a flag on runReadOnlyAgent: that one's
 * no-write guarantee was established and verified empirically, and a shared code path
 * with a boolean would put it one typo away from being lost.
 *
 * Codex-only, on purpose. `--sandbox workspace-write` confines writes to the working
 * directory at the OS level. The Claude equivalent would require re-enabling `Bash`,
 * which has no comparable confinement — the provider asymmetry documented above cuts
 * the other way once writing is the goal.
 *
 * Caller responsibilities this function does NOT cover: the working directory should be
 * a disposable worktree, and push should be disabled at the git level — a sandbox that
 * permits writes also permits `git push`.
 */
export function runWritingAgent(options: WritingRunOptions): Promise<AgentRunResult> {
  return new Promise((resolvePromise, reject) => {
    const args = writingAgentArgs(options);

    const child = spawn("codex", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    options.onSpawn?.(child.pid ?? null);

    const usage = new UsageCollector("codex", Buffer.byteLength(options.prompt, "utf8"));
    const startedAt = Date.now();
    let settled = false;
    let stopped: string | null = null;
    let stopIsFailure = false;
    let eventBuffer = "";

    const finish = (output: string | null, error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { reject(error); return; }
      const text = output ?? "";
      resolvePromise({ output: text, usage: usage.finish(text, Date.now() - startedAt) });
    };
    const halt = (reason: string, failure = false): void => {
      if (stopped) return;
      stopped = reason;
      stopIsFailure = failure;
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, 5_000);
    };

    const timer = setTimeout(() => halt(`timed out after ${Math.round(options.timeoutMs / 1000)}s`, true), options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      appendFileSync(options.eventsPath, chunk);
      usage.feed(chunk.toString());
      eventBuffer += chunk.toString();
      const lines = eventBuffer.split("\n");
      eventBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const prohibited = prohibitedWritingCommand(line, options);
        if (prohibited) halt(prohibited, true);
        notifyWritingActivity(line, options);
      }
      if (options.maxTokens && !stopped && usage.totalTokensSoFar() > options.maxTokens) {
        halt(`exceeded the ${options.maxTokens.toLocaleString()}-token budget`, true);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => appendFileSync(options.stderrPath, chunk));
    child.once("error", (error) => finish(null, new Error(`Unable to start Codex CLI: ${error.message}`)));

    // Unlike the read-only path, this waits for process exit instead of polling for the
    // result file: a writing run's file edits must be flushed before the caller inspects
    // the worktree, so finishing early on a result-file sighting would race the diff.
    child.once("exit", (code) => {
      const output = existsSync(options.resultPath) ? readFileSync(options.resultPath, "utf8").trim() : "";
      if (stopped) {
        if (stopIsFailure) {
          finish(null, new Error(`Codex Develop run stopped: ${stopped}`));
          return;
        }
        // Work already done on disk is kept and reported — the caller decides what to do
        // with a partial change set, rather than it being silently discarded here.
        finish(output || `Run halted: ${stopped}. Any changes already written are still in the worktree.`, null);
        return;
      }
      if (code !== 0 && output === "") {
        const stderr = existsSync(options.stderrPath) ? readFileSync(options.stderrPath, "utf8").trim() : "";
        finish(null, new Error(stderr || `Codex exited with code ${code}`));
        return;
      }
      finish(output, null);
    });
  });
}

function prohibitedWritingCommand(line: string, options: WritingRunOptions): string | null {
  if (!options.forbiddenCommand) return null;
  try {
    const event = JSON.parse(line) as { type?: string; item?: { type?: string; command?: string } };
    if (event.type !== "item.started" || event.item?.type !== "command_execution" || typeof event.item.command !== "string") return null;
    return options.forbiddenCommand(event.item.command);
  } catch { return null; }
}

type WritingActivity = { kind: "file-change" | "command" | "web-search"; status: "started" | "completed" };

function notifyWritingActivity(line: string, options: WritingRunOptions): WritingActivity | null {
  try {
    const event = JSON.parse(line) as { type?: string; item?: { type?: string; status?: string; changes?: Array<{ path?: string }>; command?: string } };
    if (event.type !== "item.started" && event.type !== "item.completed") return null;
    const status = event.type === "item.started" ? "started" : "completed";
    if (event.item?.type === "file_change" && Array.isArray(event.item.changes)) {
      const paths = event.item.changes.map((change) => change.path).filter((path): path is string => typeof path === "string");
      if (paths.length > 0) options.onFileActivity?.({ status, paths });
      return { kind: "file-change", status };
    }
    if (event.item?.type === "command_execution") {
      options.onCommandActivity?.({ status, detail: commandActivityDetail(event.item.command, status) });
      return { kind: "command", status };
    }
    if (event.item?.type === "web_search") return { kind: "web-search", status };
    return null;
  } catch { return null; /* non-JSON stream fragments are already preserved in the audit log */ }
}

function commandActivityDetail(command: string | undefined, status: "started" | "completed"): string {
  const prefix = status === "started" ? "Running" : "Completed";
  const npm = /\bnpm\s+(?:run\s+)?([\w:-]+)/.exec(command ?? "");
  if (npm) return `${prefix} npm ${npm[1]}`;
  if (/\bgit\s+diff\b/.test(command ?? "")) return `${prefix} diff inspection`;
  if (/\bnode\s+--check\b/.test(command ?? "")) return `${prefix} syntax checks`;
  if (/\b(?:rg|sed|find|cat)\b/.test(command ?? "")) return `${prefix} source and test inspection`;
  return `${prefix} implementation command`;
}

function runCodex(options: ReadOnlyRunOptions): Promise<AgentRunResult> {
  return new Promise((resolvePromise, reject) => {
    const resultPath = readOnlyAttemptResultPath(options.resultPath);
    const args = readOnlyAgentArgs({ ...options, resultPath });

    const timeline = new RunTimeline(options.eventsPath);
    const child = spawn("codex", args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    options.onSpawn?.(child.pid ?? null);
    child.stdin.end(options.prompt, "utf8");

    const usage = new UsageCollector("codex", Buffer.byteLength(options.prompt, "utf8"));
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let tokenBudgetExceeded = false;
    const finish = (output: string | null, error: Error | null, endedBy: AgentRunEnd, exitCode?: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(resultPoll);
      const timing = timeline.finish(endedBy, exitCode);
      if (error) { reject(agentRunFailure(error, timing)); return; }
      const text = output || "Codex completed without a plan response.";
      resolvePromise({ output: text, usage: usage.finish(text, Date.now() - startedAt), timing });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, 5_000);
      finish(null, new Error(`Codex planning timed out after ${Math.round(options.timeoutMs / 1000)} seconds`), "timeout");
    }, options.timeoutMs);
    const resultPoll = setInterval(() => {
      if (!existsSync(resultPath)) return;
      const output = readFileSync(resultPath, "utf8").trim();
      if (output !== "") finish(output, null, "exit");
    }, 500);

    child.stdout.on("data", (chunk: Buffer) => {
      appendFileSync(options.eventsPath, chunk);
      timeline.recordChunk("stdout", chunk);
      usage.feed(chunk.toString());
      if (options.maxTokens && !tokenBudgetExceeded && usage.totalTokensSoFar() > options.maxTokens) {
        tokenBudgetExceeded = true;
        child.kill("SIGTERM");
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, 5_000);
        finish(null, new Error(`Codex read-only run exceeded its ${options.maxTokens.toLocaleString()} token budget`), "token-budget");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { appendFileSync(options.stderrPath, chunk); timeline.recordChunk("stderr", chunk); });
    child.once("error", (error) => finish(null, new Error(`Unable to start Codex CLI: ${error.message}`), "spawn-error"));
    child.once("exit", (code) => {
      if (timedOut) return;
      if (existsSync(resultPath)) {
        const output = readFileSync(resultPath, "utf8").trim();
        finish(output, null, "exit", code);
      } else if (code !== 0) {
        const stderr = existsSync(options.stderrPath) ? readFileSync(options.stderrPath, "utf8").trim() : "";
        finish(null, new Error(stderr || `Codex exited with code ${code}`), "exit", code);
      } else {
        finish(null, new Error("Codex exited without writing its required plan result file."), "exit", code);
      }
    });
  });
}

export function readOnlyAgentArgs(options: Pick<ReadOnlyRunOptions, "workingDir" | "resultPath" | "model" | "prompt" | "skipGitRepoCheck" | "reasoningEffort">): string[] {
  const args = [
    "exec", "--sandbox", "read-only", "--ephemeral", "--color", "never",
    "--json", "--output-last-message", options.resultPath, "--cd", options.workingDir,
    "-c", "web_search=\"disabled\"",
  ];
  if (options.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (options.reasoningEffort) args.push("-c", `model_reasoning_effort=\"${options.reasoningEffort}\"`);
  if (options.model) args.push("--model", options.model);
  args.push(options.prompt);
  return args;
}

function runClaude(options: ReadOnlyRunOptions): Promise<AgentRunResult> {
  return new Promise((resolvePromise, reject) => {
    const args = claudeReadOnlyArgs(options);
    const timeline = new RunTimeline(options.eventsPath);
    const child = spawn("claude", args, { cwd: options.workingDir, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    options.onSpawn?.(child.pid ?? null);

    const usage = new UsageCollector("claude", Buffer.byteLength(options.prompt, "utf8"));
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    const chunks: string[] = [];
    const finish = (output: string | null, error: Error | null, endedBy: AgentRunEnd, exitCode?: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timing = timeline.finish(endedBy, exitCode);
      if (error) { reject(agentRunFailure(error, timing)); return; }
      const text = output ?? "Claude completed without a plan response.";
      resolvePromise({ output: text, usage: usage.finish(text, Date.now() - startedAt), timing });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, 5_000);
      finish(null, new Error(`Claude planning timed out after ${Math.round(options.timeoutMs / 1000)} seconds`), "timeout");
    }, options.timeoutMs);

    child.stdin.write(options.prompt, "utf-8");
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk.toString()); appendFileSync(options.eventsPath, chunk); timeline.recordChunk("stdout", chunk); usage.feed(chunk.toString()); });
    child.stderr.on("data", (chunk: Buffer) => { appendFileSync(options.stderrPath, chunk); timeline.recordChunk("stderr", chunk); });
    child.once("error", (error) => finish(null, new Error(`Unable to start Claude Code CLI: ${error.message}`), "spawn-error"));
    child.once("exit", (code) => {
      if (timedOut) return;
      const raw = chunks.join("");
      let result: string | null = null;
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(trimmed) as { type?: string; result?: string };
          if (parsed.type === "result") { result = parsed.result ?? ""; break; }
        } catch { /* not every stream-json line is the terminal result event */ }
      }
      if (result !== null) { finish(result, null, "exit", code); return; }
      if (code === 0) { finish("Claude completed without a plan response.", null, "exit", code); return; }
      const stderr = existsSync(options.stderrPath) ? readFileSync(options.stderrPath, "utf8").trim() : "";
      finish(null, new Error(stderr || `Claude Code CLI exited with code ${code}`), "exit", code);
    });
  });
}

export function claudeReadOnlyArgs(options: Pick<ReadOnlyRunOptions, "model" | "extraReadTools" | "noTools">): string[] {
  const args = ["--print", "--output-format", "stream-json", "--verbose"];
  if (options.model) args.push("--model", options.model);
  // Comma-joined rather than spread: --allowedTools is variadic, so passing bare
  // words risks the parser swallowing whatever argument follows.
  args.push("--allowedTools", options.noTools ? "" : resolveClaudeReadTools(options.extraReadTools).join(","));
  args.push("--disallowedTools", CLAUDE_DENIED_TOOLS.join(","));
  return args;
}
