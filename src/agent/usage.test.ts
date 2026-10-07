import { describe, expect, it } from "vitest";
import { UsageCollector, summarizeUsage } from "./usage.js";

// These fixtures are copied from real runtime/planning-runs event streams, so the
// parser is tested against the shapes the CLIs actually emit rather than invented ones.
const CODEX_TURN = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 37174, cached_input_tokens: 32256, cache_write_input_tokens: 0, output_tokens: 1595, reasoning_output_tokens: 407 },
});
const codexCommand = (output: string) => JSON.stringify({
  type: "item.completed",
  item: { id: "item_7", type: "command_execution", command: "rg -n subid .", aggregated_output: output, exit_code: 0, status: "completed" },
});
// Copied from the real $0.7846 claude-opus-5 planning run in runtime/planning-runs.
const CLAUDE_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "OK",
  usage: { input_tokens: 180, cache_creation_input_tokens: 45359, cache_read_input_tokens: 152812, output_tokens: 10150 },
  total_cost_usd: 0.784646,
  num_turns: 15,
  duration_ms: 139747,
});

describe("UsageCollector — Codex", () => {
  it("reads tokens from a turn.completed event", () => {
    const collector = new UsageCollector("codex", 4000);
    collector.feed(`${CODEX_TURN}\n`);
    const usage = collector.finish("plan text", 12_000);

    expect(usage).toMatchObject({
      provider: "codex",
      inputTokens: 37174,
      cachedInputTokens: 32256,
      outputTokens: 1595,
      reasoningTokens: 407,
      turns: 1,
      durationMs: 12_000,
      promptBytes: 4000,
    });
    // Codex reports no price, so cost stays null rather than being invented.
    expect(usage.costUSD).toBeNull();
  });

  it("sums tokens across turns, since each turn is billed separately", () => {
    const collector = new UsageCollector("codex", 100);
    collector.feed(`${CODEX_TURN}\n${CODEX_TURN}\n`);
    const usage = collector.finish("", 1);

    expect(usage.turns).toBe(2);
    expect(usage.inputTokens).toBe(37174 * 2);
    expect(usage.outputTokens).toBe(1595 * 2);
  });

  it("counts command output bytes — the dominant cost in real runs", () => {
    const collector = new UsageCollector("codex", 100);
    collector.feed(`${codexCommand("a".repeat(500))}\n${codexCommand("b".repeat(1_500))}\n`);
    const usage = collector.finish("", 1);

    expect(usage.commandCount).toBe(2);
    expect(usage.toolOutputBytes).toBe(2_000);
  });

  it("ignores commands that are only started, not completed", () => {
    const started = JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "rg x", status: "in_progress" } });
    const collector = new UsageCollector("codex", 100);
    collector.feed(`${started}\n`);
    expect(collector.finish("", 1).commandCount).toBe(0);
  });
});

describe("UsageCollector — Claude", () => {
  it("reads tokens, cost and turns from the terminal result event", () => {
    const collector = new UsageCollector("claude", 8_743);
    collector.feed(`${CLAUDE_RESULT}\n`);
    const usage = collector.finish("OK", 139_747);

    expect(usage).toMatchObject({
      provider: "claude",
      cachedInputTokens: 152812,
      cacheWriteTokens: 45359,
      outputTokens: 10150,
      costUSD: 0.784646,
      turns: 15,
    });
  });

  it("sums fresh + cache-read + cache-write into a total input, matching Codex's meaning", () => {
    const collector = new UsageCollector("claude", 0);
    collector.feed(`${CLAUDE_RESULT}\n`);
    const usage = collector.finish("", 1);

    // Claude reports these as three separate additive fields; a bare input_tokens of 180
    // would understate ~198k of billed input by three orders of magnitude.
    expect(usage.inputTokens).toBe(180 + 152812 + 45359);
  });

  it("captures cache-write tokens, the dominant cost line in a measured run", () => {
    const collector = new UsageCollector("claude", 0);
    collector.feed(`${CLAUDE_RESULT}\n`);
    const usage = collector.finish("", 1);

    // 45,359 write tokens at the 1-hour TTL premium accounted for 58% of that run's
    // $0.7846 — dropping this field hides the majority of the spend.
    expect(usage.cacheWriteTokens).toBe(45359);
  });

  it("counts tool_result blocks returned in user messages", () => {
    const toolResult = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "x".repeat(250) }, { type: "text", text: "ignored" }] },
    });
    const collector = new UsageCollector("claude", 100);
    collector.feed(`${toolResult}\n`);
    const usage = collector.finish("", 1);

    expect(usage.commandCount).toBe(1);
    expect(usage.toolOutputBytes).toBe(250);
  });
});

describe("UsageCollector — robustness", () => {
  it("reassembles JSON split across chunk boundaries", () => {
    const collector = new UsageCollector("codex", 100);
    const half = Math.floor(CODEX_TURN.length / 2);
    collector.feed(CODEX_TURN.slice(0, half));
    collector.feed(`${CODEX_TURN.slice(half)}\n`);
    expect(collector.finish("", 1).inputTokens).toBe(37174);
  });

  it("parses a trailing line that never received its newline", () => {
    const collector = new UsageCollector("codex", 100);
    collector.feed(CODEX_TURN); // no trailing \n
    expect(collector.finish("", 1).inputTokens).toBe(37174);
  });

  it("survives malformed and non-JSON lines without throwing", () => {
    const collector = new UsageCollector("codex", 100);
    collector.feed("not json at all\n{broken\n\n");
    collector.feed(`${CODEX_TURN}\n`);
    expect(collector.finish("", 1).inputTokens).toBe(37174);
  });

  it("reports nulls, not zeros, when a run dies before any usage is emitted", () => {
    const usage = new UsageCollector("codex", 100).finish("", 500);
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.cacheWriteTokens).toBeNull();
    expect(usage.costUSD).toBeNull();
    // Byte metrics are always measurable, so they stay numeric.
    expect(usage.promptBytes).toBe(100);
    expect(usage.toolOutputBytes).toBe(0);
  });

  it("measures output bytes in utf8, not character count", () => {
    const usage = new UsageCollector("codex", 0).finish("héllo — ok", 1);
    expect(usage.outputBytes).toBe(Buffer.byteLength("héllo — ok", "utf8"));
    expect(usage.outputBytes).toBeGreaterThan("héllo — ok".length);
  });
});

describe("summarizeUsage", () => {
  it("includes reported figures and omits unreported ones", () => {
    const collector = new UsageCollector("codex", 4000);
    collector.feed(`${CODEX_TURN}\n${codexCommand("x".repeat(100))}\n`);
    const line = summarizeUsage(collector.finish("plan", 20_000));

    expect(line).toContain("codex");
    expect(line).toContain("in=37174");
    expect(line).toContain("toolOutput=100B");
    expect(line).toContain("cmds=1");
    expect(line).not.toContain("$"); // no cost reported for Codex
  });
});
