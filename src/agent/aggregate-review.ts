import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { runReadOnlyAgent, type Provider } from "./llm-provider.js";
import type { RunUsage } from "./usage.js";
import type { MissionRunResult } from "../mission/runner.js";
import { writeArtifact } from "../mission/blackboard.js";
import type { MissionPacket } from "./mission-packet.js";
import { aggregateCriticView } from "../mission/views.js";

export interface AggregateReviewInput {
  missionId: string;
  packet: MissionPacket;
  plan: string;
  provider: Provider;
  workingDir: string;
  executionOrder: string[];
  dependenciesByRepository: Record<string, string[]>;
  resultsByRepository: Record<string, MissionRunResult>;
}

export interface AggregateReview {
  disposition: "accept" | "revise" | "escalate" | "not-detected";
  affectedRepositories: string[];
  objections: Array<{ claim: string; evidence: string[]; repositories: string[] }>;
  parseError: string | null;
  output: string;
  usage: RunUsage | null;
  createdAt: string;
}

export async function runAggregateReview(input: AggregateReviewInput): Promise<AggregateReview> {
  const root = runtimeRoot();
  mkdirSync(resolve(root, "planning-runs"), { recursive: true });
  const result = await runReadOnlyAgent({
    provider: input.provider,
    prompt: aggregateReviewPrompt(input),
    // The critic receives the committed mission diff below. Running it from a neutral
    // audit directory prevents a stale integration checkout from being mistaken for the
    // implementation it is reviewing.
    workingDir: resolve(root, "planning-runs"),
    timeoutMs: 3 * 60_000,
    eventsPath: resolve(root, "planning-runs", `${input.missionId}.aggregate-review.events.jsonl`),
    stderrPath: resolve(root, "planning-runs", `${input.missionId}.aggregate-review.stderr.log`),
    resultPath: resolve(root, "planning-runs", `${input.missionId}.aggregate-review.md`),
  });
  const parsed = parseAggregateReview(result.output, input.executionOrder);
  const review: AggregateReview = {
    ...parsed,
    output: result.output,
    usage: result.usage,
    createdAt: new Date().toISOString(),
  };
  writeArtifact(input.missionId, "aggregate-review", {
    schemaVersion: 1,
    missionId: input.missionId,
    storyId: input.packet.story.id,
    stage: "aggregate-review",
    producedBy: input.provider,
    ...review,
  });
  return review;
}

export function parseAggregateReview(
  output: string,
  repositoryIds: string[],
): Pick<AggregateReview, "disposition" | "affectedRepositories" | "objections" | "parseError"> {
  const fallback = (parseError: string) => ({
    disposition: "not-detected" as const,
    affectedRepositories: [],
    objections: [],
    parseError,
  });
  const candidate = [...output.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  if (!candidate) return fallback("No fenced JSON aggregate verdict was found.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return fallback(`Aggregate verdict JSON did not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback("Aggregate verdict was not an object.");
  const record = parsed as Record<string, unknown>;
  const disposition = record.disposition === "accept" || record.disposition === "revise" || record.disposition === "escalate"
    ? record.disposition
    : null;
  if (!disposition) return fallback("Aggregate verdict did not contain a recognized disposition.");
  const affectedRepositories = validRepositories(record.affectedRepositories, repositoryIds);
  if (disposition === "revise" && affectedRepositories.length === 0) {
    return fallback("A revise verdict must identify at least one affected repository.");
  }
  const objections = Array.isArray(record.objections) ? record.objections.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const repositories = validRepositories(item.repositories, repositoryIds);
    const evidence = stringArray(item.evidence);
    return typeof item.claim === "string" && item.claim.trim() && repositories.length > 0 && evidence.length > 0
      ? [{ claim: item.claim.trim(), evidence, repositories }]
      : [];
  }) : [];
  if (disposition === "revise" && objections.length === 0) {
    return fallback("A revise verdict must include at least one repository-qualified objection with evidence.");
  }
  return { disposition, affectedRepositories, objections, parseError: null };
}

export function aggregateReviewPrompt(input: AggregateReviewInput): string {
  const view = aggregateCriticView(input.packet, input.plan, input.executionOrder, input.dependenciesByRepository, input.resultsByRepository);
  const summaries = view.repositories.map((repository) => {
    const repositoryId = repository.repositoryId;
    return `## ${repositoryId}
Depends on: ${repository.dependsOn.join(", ") || "none"}
Outcome: ${repository.outcome}
Changed files: ${repository.filesChanged.join(", ") || "none"}
Diff: ${repository.diffStat ?? "unavailable"}
Regressions: ${repository.regressions.join(", ") || "none"}
Critic: ${repository.criticDisposition ?? "missing"}`;
  }).join("\n\n");
  const reviewedDiffs = input.executionOrder.map((repositoryId) => {
    const result = input.resultsByRepository[repositoryId];
    return `## ${repositoryId}\n${result ? committedDiff(result) : "No mission result was available."}`;
  }).join("\n\n");
  return `You are the final read-only cross-repository critic. Review whether the independently accepted repository changes form one consistent implementation of the story. Do not modify files or perform external actions.

Story: ${view.storyId} — ${view.storyTitle}
Acceptance criteria: ${view.acceptanceCriteria}
Execution order: ${input.executionOrder.join(" -> ")}

Coordinated plan:
${input.plan}

Repository evidence:
${summaries}

Authoritative reviewed patches:
${reviewedDiffs}

Check cross-repository contracts, dependency ordering, naming, compatibility, and whether the combined result satisfies the acceptance criteria. The reviewed patches above are the only source of implementation truth. Do not inspect a repository checkout or claim a file lacks a change when its reviewed patch shows that change. Every objection must identify affected repositories and concrete evidence. Do not invent an objection.

End with exactly one fenced JSON block:
\`\`\`json
{"disposition":"accept"|"revise"|"escalate","affectedRepositories":["<selected repository id>"],"objections":[{"claim":"<specific issue>","evidence":["<repository-qualified evidence>"],"repositories":["<selected repository id>"]}]}
\`\`\``;
}

function committedDiff(result: MissionRunResult): string {
  const develop = result.develop;
  if (!develop?.commit || !develop.worktreePath || !develop.baselineCommit) return "No committed implementation diff.";
  const diff = spawnSync(
    "git",
    ["-C", develop.worktreePath, "diff", "--no-ext-diff", "--unified=3", `${develop.baselineCommit}..${develop.commit}`],
    { encoding: "utf8", maxBuffer: 1_000_000 },
  );
  if (diff.status !== 0) return `Reviewed diff unavailable: ${(diff.stderr || diff.stdout || "git diff failed").trim()}`;
  const output = diff.stdout.trim();
  return output === "" ? "No committed implementation diff." : output;
}

function validRepositories(raw: unknown, allowed: string[]): string[] {
  return stringArray(raw).filter((id) => allowed.includes(id));
}

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
}

function runtimeRoot(): string {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  return configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
}
