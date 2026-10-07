import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CriticVerdict, Objection } from "../mission/artifacts.js";
import { runReadOnlyAgent } from "./llm-provider.js";
import { parseSkill } from "./skills.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CRITIC_TIMEOUT_MS = 3 * 60_000;
// See the fixed-provider note on runCritic below for why this is never Codex.
const CRITIC_PROVIDER = "claude" as const;

const SEVERITIES = new Set(["blocker", "major", "minor"]);
const DISPOSITIONS = new Set(["accept", "revise", "replan", "escalate"]);

export interface CriticInput {
  stage: "plan" | "diff";
  missionId: string;
  storyId: number;
  /** The artifact under review, already projected to what the critic needs. */
  subject: string;
  /** Repo-relative paths the critic may cite. Anything outside is uncitable. */
  citableFiles: string[];
  /** Checkout the critic reads to verify citations. Must be the repository under review. */
  worktreePath: string;
  model?: string;
}

interface RawObjection {
  severity?: unknown;
  claim?: unknown;
  evidence?: unknown;
}

interface RawVerdict {
  disposition?: unknown;
  objections?: unknown;
}

/**
 * Runs a single read-only critique turn against a fixed rubric and returns a verdict
 * that already satisfies the artifact schema Task 2 defined — the caller never has to
 * re-shape or re-validate it.
 *
 * Always runs on Claude, never Codex: Claude's read-only guarantee is a discrete tool
 * allow and deny list a caller can reason about and this module asserts against,
 * whereas Codex's is an OS-level sandbox with no tool identity to check. The critic
 * therefore cannot run on Codex.
 */
export async function runCritic(input: CriticInput): Promise<CriticVerdict> {
  const rubric = loadRubric(input.stage);
  const prompt = buildCriticPrompt(input, rubric.instructions);

  const directory = auditDirectory();
  mkdirSync(directory, { recursive: true });
  const slug = `${input.missionId}-${input.stage}-${randomUUID()}`;

  const result = await runReadOnlyAgent({
    provider: CRITIC_PROVIDER,
    prompt,
    // Must be the repository under review, not this one: the critic verifies
    // citations — e.g. the plan rubric's "does this path exist" check — by reading
    // this directory with Read/Glob/Grep, and a wrong directory would let it confirm
    // a path against an unrelated same-named file. A confident wrong answer here is
    // worse than no check at all.
    workingDir: input.worktreePath,
    timeoutMs: CRITIC_TIMEOUT_MS,
    model: input.model,
    extraReadTools: rubric.extraReadTools,
    eventsPath: resolve(directory, `${slug}.events.jsonl`),
    stderrPath: resolve(directory, `${slug}.stderr.log`),
    resultPath: resolve(directory, `${slug}.result.txt`),
  });

  const raw = parseRawVerdict(result.output);
  const { kept, dropped } = filterCitedObjections(raw.objections, input.citableFiles);
  if (dropped > 0) {
    console.log(`[mission ${input.missionId} critic:${input.stage}] dropped ${dropped} of ${raw.objections.length} objection(s): missing evidence or citing a path outside citableFiles`);
  }
  const disposition = raw.objections.length > 0 && kept.length === 0 ? "accept" : raw.disposition;

  return {
    schemaVersion: 1,
    missionId: input.missionId,
    storyId: input.storyId,
    stage: input.stage,
    createdAt: new Date().toISOString(),
    producedBy: input.model ?? CRITIC_PROVIDER,
    disposition,
    objections: kept,
    usage: result.usage,
  };
}

function auditDirectory(): string {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  const root = configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
  return resolve(root, "critic-runs");
}

function loadRubric(stage: CriticInput["stage"]) {
  return parseSkill(readFileSync(resolve(projectRoot, "src", "agent", "rubrics", `${stage}.md`), "utf8"));
}

function buildCriticPrompt(input: CriticInput, rubric: string): string {
  const stageLabel = input.stage === "plan" ? "a proposed plan" : "a completed diff";
  const citableList = input.citableFiles.length > 0
    ? input.citableFiles.map((path) => `- ${path}`).join("\n")
    : "(none named — you have nothing to cite, so raise no objections)";

  return `You are a read-only critic reviewing ${stageLabel} for a gated Mission Control mission. You are judging, not fixing — you never modify anything.

Work only as a read-only analyst. Do not modify files, run write commands, create branches, commit, push, install dependencies, or run builds/tests.

## Rubric
${rubric}

## Story
Work item: ${input.storyId}
Mission: ${input.missionId}

## Subject under review
${input.subject}

## Locations you may cite as evidence
${citableList}

Every objection you raise MUST cite at least one location from the list above, using \`path\` or \`path:line\` form. An objection with no evidence, or evidence pointing outside that list, will be discarded before a developer ever sees it — so do not raise a claim you cannot point at.

End your response with exactly one fenced JSON block, matching this shape and nothing else inside the fence:
\`\`\`json
{"disposition": "accept" | "revise" | "replan" | "escalate", "objections": [{"severity": "blocker" | "major" | "minor", "claim": "<what is wrong>", "evidence": ["<path or path:line>"]}]}
\`\`\``;
}

/** Never throws — unparseable or missing verdict output degrades to escalate with no objections. */
function parseRawVerdict(output: string): { disposition: CriticVerdict["disposition"]; objections: Objection[] } {
  const fallback = { disposition: "escalate" as const, objections: [] as Objection[] };
  const matches = [...output.matchAll(/```json\s*([\s\S]*?)```/g)];
  const candidate = matches.at(-1)?.[1];
  if (!candidate) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback;
  const record = parsed as RawVerdict;

  const disposition = typeof record.disposition === "string" && DISPOSITIONS.has(record.disposition)
    ? (record.disposition as CriticVerdict["disposition"])
    : null;
  if (disposition === null) return fallback;

  return { disposition, objections: parseObjections(record.objections) };
}

function parseObjections(raw: unknown): Objection[] {
  if (!Array.isArray(raw)) return [];
  const objections: Objection[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as RawObjection;
    if (typeof item.severity !== "string" || !SEVERITIES.has(item.severity)) continue;
    if (typeof item.claim !== "string" || item.claim.trim() === "") continue;
    if (!Array.isArray(item.evidence) || !item.evidence.every((entry) => typeof entry === "string")) continue;
    objections.push({ severity: item.severity as Objection["severity"], claim: item.claim, evidence: item.evidence as string[] });
  }
  return objections;
}

/** Drops an objection whose evidence is empty, or where any citation names a path the critic was not given. */
function filterCitedObjections(objections: Objection[], citableFiles: string[]): { kept: Objection[]; dropped: number } {
  const citable = new Set(citableFiles);
  const kept = objections.filter((objection) => objection.evidence.length > 0 && objection.evidence.every((entry) => citable.has(evidencePath(entry))));
  return { kept, dropped: objections.length - kept.length };
}

function evidencePath(entry: string): string {
  const match = /^(.*):(\d+)$/.exec(entry);
  return match ? match[1] : entry;
}
