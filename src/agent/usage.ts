/**
 * Measures what a planning run actually cost.
 *
 * Two kinds of number are collected, deliberately:
 *
 *  - Provider-reported tokens/cost, parsed from each CLI's own event stream. Accurate,
 *    but shaped differently per provider and absent if a run dies early.
 *  - Provider-agnostic byte counts (prompt in, tool output fed back, final answer out).
 *    Always available and directly comparable across providers and across changes to
 *    the harness — this is the baseline for judging whether an optimisation worked.
 *
 * The byte counts matter because tool output dominates: a measured run put 344,605
 * bytes of shell output in front of the model to produce an 8,835-byte plan. Any
 * claim about efficiency should be checkable against these numbers rather than argued.
 */

export type UsageProvider = "claude" | "codex";

export interface RunUsage {
  provider: UsageProvider;
  /**
   * Total input tokens billed, across every category (fresh + cache reads + cache
   * writes). Normalised deliberately: Codex nests the cached portion inside its
   * input_tokens, whereas Claude reports fresh/read/written as three separate additive
   * fields. Without normalising, the same number would mean different things per
   * provider and the two could not be compared.
   */
  inputTokens: number | null;
  /** Portion of inputTokens served from cache — billed at roughly a tenth of input rate. */
  cachedInputTokens: number | null;
  /**
   * Portion of inputTokens written to cache — billed at a PREMIUM over base input
   * (1.25x at the 5-minute TTL, 2x at one hour), which routinely makes this the single
   * largest line in a run's cost even though it is the smallest token count.
   */
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  /** Codex reports reasoning tokens separately; Claude does not. */
  reasoningTokens: number | null;
  /** Only Claude reports a cost; left null rather than inventing a price for Codex. */
  costUSD: number | null;
  turns: number;
  durationMs: number;
  promptBytes: number;
  /** Bytes of tool/command output fed back into the model — usually the largest cost. */
  toolOutputBytes: number;
  outputBytes: number;
  commandCount: number;
}

export class UsageCollector {
  private inputTokens: number | null = null;
  private cachedInputTokens: number | null = null;
  private cacheWriteTokens: number | null = null;
  private outputTokens: number | null = null;
  private reasoningTokens: number | null = null;
  private costUSD: number | null = null;
  private turns = 0;
  private toolOutputBytes = 0;
  private commandCount = 0;
  private buffer = "";

  constructor(private readonly provider: UsageProvider, private readonly promptBytes: number) {}

  /** Accepts raw stdout, which may split JSON lines across chunk boundaries. */
  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.consumeLine(line);
  }

  /**
   * Tokens seen so far, for enforcing a budget mid-run. Providers only report usage at
   * turn boundaries, so this lags the true figure within a turn — it is a runaway
   * backstop, not an exact meter.
   */
  totalTokensSoFar(): number {
    return (this.inputTokens ?? 0) + (this.outputTokens ?? 0);
  }

  finish(output: string, durationMs: number): RunUsage {
    if (this.buffer.trim() !== "") {
      this.consumeLine(this.buffer);
      this.buffer = "";
    }
    return {
      provider: this.provider,
      inputTokens: this.inputTokens,
      cachedInputTokens: this.cachedInputTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      costUSD: this.costUSD,
      turns: this.turns,
      durationMs,
      promptBytes: this.promptBytes,
      toolOutputBytes: this.toolOutputBytes,
      outputBytes: Buffer.byteLength(output, "utf8"),
      commandCount: this.commandCount,
    };
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // a partial or non-JSON line is not worth failing a run over
    }
    this.collectCodexTurn(event);
    this.collectCodexCommand(event);
    this.collectClaudeResult(event);
    this.collectClaudeToolResult(event);
  }

  /**
   * Codex emits one `turn.completed` per turn; billed input accumulates across them.
   * Codex's input_tokens already includes the cached portion, so it is the total as-is.
   */
  private collectCodexTurn(event: Record<string, unknown>): void {
    if (event.type !== "turn.completed") return;
    const usage = asRecord(event.usage);
    if (!usage) return;
    this.turns += 1;
    this.inputTokens = add(this.inputTokens, asNumber(usage.input_tokens));
    this.cachedInputTokens = add(this.cachedInputTokens, asNumber(usage.cached_input_tokens));
    this.cacheWriteTokens = add(this.cacheWriteTokens, asNumber(usage.cache_write_input_tokens));
    this.outputTokens = add(this.outputTokens, asNumber(usage.output_tokens));
    this.reasoningTokens = add(this.reasoningTokens, asNumber(usage.reasoning_output_tokens));
  }

  private collectCodexCommand(event: Record<string, unknown>): void {
    if (event.type !== "item.completed") return;
    const item = asRecord(event.item);
    if (!item || item.type !== "command_execution") return;
    this.commandCount += 1;
    if (typeof item.aggregated_output === "string") {
      this.toolOutputBytes += Buffer.byteLength(item.aggregated_output, "utf8");
    }
  }

  /**
   * Claude reports totals once, in its terminal result event — and reports fresh input,
   * cache reads, and cache writes as three SEPARATE additive fields. They are summed
   * into inputTokens so the figure means the same thing as Codex's.
   */
  private collectClaudeResult(event: Record<string, unknown>): void {
    if (event.type !== "result") return;
    const usage = asRecord(event.usage);
    if (usage) {
      const fresh = asNumber(usage.input_tokens);
      const cacheRead = asNumber(usage.cache_read_input_tokens);
      const cacheWrite = asNumber(usage.cache_creation_input_tokens);
      for (const part of [fresh, cacheRead, cacheWrite]) {
        this.inputTokens = add(this.inputTokens, part);
      }
      if (cacheRead !== null) this.cachedInputTokens = add(this.cachedInputTokens, cacheRead);
      if (cacheWrite !== null) this.cacheWriteTokens = add(this.cacheWriteTokens, cacheWrite);
      this.outputTokens = add(this.outputTokens, asNumber(usage.output_tokens));
    }
    const cost = asNumber(event.total_cost_usd);
    if (cost !== null) this.costUSD = cost;
    const numTurns = asNumber(event.num_turns);
    if (numTurns !== null) this.turns = numTurns;
  }

  /** Claude returns tool output inside user-role messages as tool_result blocks. */
  private collectClaudeToolResult(event: Record<string, unknown>): void {
    if (event.type !== "user") return;
    const message = asRecord(event.message);
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const entry of content) {
      const block = asRecord(entry);
      if (!block || block.type !== "tool_result") continue;
      this.commandCount += 1;
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      this.toolOutputBytes += Buffer.byteLength(text, "utf8");
    }
  }
}

/** Compact one-line summary for logs and audit records. */
export function summarizeUsage(usage: RunUsage): string {
  const parts = [
    `${usage.provider}`,
    usage.inputTokens !== null ? `in=${usage.inputTokens}` : null,
    usage.cachedInputTokens !== null ? `cached=${usage.cachedInputTokens}` : null,
    usage.cacheWriteTokens !== null ? `cacheWrite=${usage.cacheWriteTokens}` : null,
    usage.outputTokens !== null ? `out=${usage.outputTokens}` : null,
    usage.costUSD !== null ? `$${usage.costUSD.toFixed(4)}` : null,
    `turns=${usage.turns}`,
    `${Math.round(usage.durationMs / 1000)}s`,
    `prompt=${usage.promptBytes}B`,
    `toolOutput=${usage.toolOutputBytes}B`,
    `answer=${usage.outputBytes}B`,
    `cmds=${usage.commandCount}`,
  ];
  return parts.filter((part) => part !== null).join(" ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Sums while preserving null as "never reported", so absent data isn't shown as 0. */
function add(current: number | null, addition: number | null): number | null {
  if (addition === null) return current;
  return (current ?? 0) + addition;
}
