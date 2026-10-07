import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { runReadOnlyAgent, type Provider } from "./llm-provider.js";
import type { RunUsage } from "./usage.js";
import { isScopeExpansionAllowed } from "../mission/gates.js";

export type ScopeClassification = "required" | "unnecessary" | "uncertain";

export interface ScopeRecommendation {
  path: string;
  classification: ScopeClassification;
  rationale: string;
  evidence: string[];
  approvalAllowed: boolean;
}

export interface ScopeReview {
  provider: Provider;
  status: "completed";
  recommendations: ScopeRecommendation[];
  parseError: string | null;
  output: string;
  usage: RunUsage | null;
  createdAt: string;
}

export interface ScopeReviewInput {
  provider: Provider;
  worktreePath: string;
  baselineCommit: string;
  storyId: number;
  storyTitle: string;
  storyDescription: string;
  acceptanceCriteria: string;
  approvedPlan: string;
  approvedPaths: string[];
  offenders: string[];
}

export async function runScopeReview(input: ScopeReviewInput): Promise<ScopeReview> {
  const reviewId = randomUUID();
  const diff = git(input.worktreePath, ["diff", "--unified=3", `${input.baselineCommit}..HEAD`, "--", ...input.offenders]);
  const result = await runReadOnlyAgent({
    provider: input.provider,
    workingDir: input.worktreePath,
    prompt: scopeReviewPrompt(input, diff),
    timeoutMs: 3 * 60_000,
    eventsPath: resolve(auditRoot(), `${reviewId}.events.jsonl`),
    stderrPath: resolve(auditRoot(), `${reviewId}.stderr.log`),
    resultPath: resolve(auditRoot(), `${reviewId}.md`),
  });
  const parsed = parseScopeRecommendations(result.output, input.offenders);
  return {
    provider: input.provider,
    status: "completed",
    recommendations: parsed.recommendations,
    parseError: parsed.parseError,
    output: result.output,
    usage: result.usage,
    createdAt: new Date().toISOString(),
  };
}

export function parseScopeRecommendations(output: string, offenders: string[]): Pick<ScopeReview, "recommendations" | "parseError"> {
  const uncertain = (parseError: string): Pick<ScopeReview, "recommendations" | "parseError"> => ({
    recommendations: offenders.map((path) => ({
      path,
      classification: "uncertain",
      rationale: "The scope advisor did not return a usable recommendation.",
      evidence: [],
      approvalAllowed: isScopeExpansionAllowed(path),
    })),
    parseError,
  });
  const matches = [...output.matchAll(/```json\s*([\s\S]*?)```/g)];
  const candidate = matches.at(-1)?.[1];
  if (!candidate) return uncertain("No fenced JSON scope recommendation was found.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return uncertain(`The scope recommendation did not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { recommendations?: unknown }).recommendations)) {
    return uncertain("The scope recommendation did not contain a recommendations array.");
  }
  const allowed = new Set(offenders);
  const recommendations = new Map<string, ScopeRecommendation>();
  for (const raw of (parsed as { recommendations: unknown[] }).recommendations) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.path !== "string" || !allowed.has(item.path) || recommendations.has(item.path)) continue;
    if (item.classification !== "required" && item.classification !== "unnecessary" && item.classification !== "uncertain") continue;
    recommendations.set(item.path, {
      path: item.path,
      classification: item.classification,
      rationale: typeof item.rationale === "string" && item.rationale.trim() !== "" ? item.rationale : "No rationale was provided.",
      evidence: Array.isArray(item.evidence) ? item.evidence.filter((entry): entry is string => typeof entry === "string") : [],
      approvalAllowed: isScopeExpansionAllowed(item.path),
    });
  }
  const missing = offenders.filter((path) => !recommendations.has(path));
  for (const path of missing) {
    recommendations.set(path, {
      path, classification: "uncertain", rationale: "The scope advisor omitted this path.", evidence: [],
      approvalAllowed: isScopeExpansionAllowed(path),
    });
  }
  return {
    recommendations: offenders.map((path) => recommendations.get(path)!),
    parseError: missing.length > 0 ? `The scope advisor omitted ${missing.length} changed path(s).` : null,
  };
}

function scopeReviewPrompt(input: ScopeReviewInput, diff: string): string {
  return `You are the same read-only planning role revisiting a scope decision after Develop. Do not edit files or run write commands. Advise the developer; never authorize scope yourself.

## Story ${input.storyId} — ${input.storyTitle}
${input.storyDescription}

Acceptance criteria:
${input.acceptanceCriteria}

## Approved plan
${input.approvedPlan}

## Approved write boundary
${input.approvedPaths.map((path) => `- ${path}`).join("\n")}

## Additional changed files
${input.offenders.map((path) => `- ${path}`).join("\n")}

## Exact additional-file diff
\`\`\`diff
${diff}
\`\`\`

Classify every additional path as required, unnecessary, or uncertain. A required path must be tied to a specific implementation task or acceptance criterion. Formatting, cleanup, unrelated warning fixes, and speculative improvements are unnecessary. Cite concrete diff lines or repository paths in evidence.

End with exactly one fenced JSON block:
\`\`\`json
{"recommendations":[{"path":"<exact additional path>","classification":"required|unnecessary|uncertain","rationale":"<why>","evidence":["<path or diff evidence>"]}]}
\`\`\``;
}

function auditRoot(): string {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  const root = configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
  const directory = resolve(root, "scope-reviews");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`Unable to prepare scope review: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}
