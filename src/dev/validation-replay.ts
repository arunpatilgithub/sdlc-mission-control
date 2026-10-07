import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  composeCoordinatedPlan,
  discoverRepositoryTestHarness,
  parseCoordinatorDecision,
  parseScoutPlanPacket,
  type RepositoryTestHarness,
  type ScoutPlanPacket,
  validateConfirmationDependencies,
  validateCrossRepositoryContracts,
  validatePreDevelopDecisions,
  validateScoutHandoffOwners,
  validateUnresolvedCrossRepositoryContracts,
} from "../agent/planning-agent.js";
import { classifyValidationMessage, type RuleId } from "../agent/validation-rules.js";

export type ReplayStage = "initial-scout" | "scout-repair" | "scope-out-correction" | "scope-anchor-repair" | "coordinator" | "contract-repair";
export type ReplayOutcome = "valid" | "invalid" | "context-dependent: skipped";

export interface ValidationReplayStage {
  artifact: string;
  jobId: string;
  storyId: number | null;
  provider: string;
  scoutEffort: "low" | "medium" | "high";
  repositoryId: string | null;
  stage: ReplayStage;
  firstPass: boolean;
  outcome: ReplayOutcome;
  ruleId: RuleId | null;
  message: string | null;
  context: "recorded-test-harness" | "current-clone" | "test-harness-unavailable" | "stored-scout-packets" | "missing-scout-packets" | "scope-anchor-baseline";
  repairRan: boolean;
  repairConverged: boolean | null;
}

export interface ValidationReplayReport {
  generatedAt: string;
  runtimeRoot: string;
  stages: ValidationReplayStage[];
  summary: {
    byStage: Array<{ stage: ReplayStage; firstPass: number; valid: number; invalid: number; skipped: number; repairs: number; convergedRepairs: number }>;
    repairTriggers: Array<{ ruleId: RuleId; count: number }>;
    byProvider: Array<{ provider: string; valid: number; invalid: number; skipped: number }>;
    byScoutEffort: Array<{ effort: "low" | "medium" | "high"; valid: number; invalid: number; skipped: number }>;
    byStory: Array<{ storyId: number | null; valid: number; invalid: number; skipped: number }>;
    failedJobs: Array<{ jobId: string; storyId: number | null; ruleId: RuleId; message: string }>;
    skipped: Array<{ context: ValidationReplayStage["context"]; count: number }>;
    unclassified: Array<{ artifact: string; message: string }>;
  };
}

type StoredJob = Record<string, unknown>;
type Artifact = { name: string; path: string; modifiedAt: number; jobId: string; repositoryId: string | null; stage: ReplayStage };

function runtimeRoot(): string {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  return configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function jobIdFromArtifact(name: string): string | null {
  const match = /^([0-9a-f]{8}-[0-9a-f-]{27})\./i.exec(name);
  return match?.[1] ?? null;
}

function artifactStage(name: string): ReplayStage | null {
  if (name.includes(".scope-out-correction")) return "scope-out-correction";
  if (name.includes(".scope-anchor-repair")) return "scope-anchor-repair";
  if (name.includes(".scout-repair.")) return "scout-repair";
  if (name.includes(".scout.")) return "initial-scout";
  if (name.includes(".contract-repair.plan.")) return "contract-repair";
  if (name.includes(".plan.attempt-")) return "coordinator";
  return null;
}

function repositoryIdFromArtifact(jobId: string, name: string, stage: ReplayStage): string | null {
  if (stage === "coordinator" || stage === "contract-repair") return null;
  const marker = stage === "initial-scout" ? ".scout." : stage === "scout-repair" ? ".scout-repair." : `.${stage}`;
  const prefix = `${jobId}.`;
  const end = name.indexOf(marker);
  return name.startsWith(prefix) && end > prefix.length ? name.slice(prefix.length, end) : null;
}

function artifacts(root: string): Artifact[] {
  const directory = resolve(root, "planning-runs");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name): Artifact[] => {
    if (!name.endsWith(".md")) return [];
    const stage = artifactStage(name);
    const jobId = jobIdFromArtifact(name);
    if (!stage || !jobId) return [];
    const path = resolve(directory, name);
    return [{ name, path, modifiedAt: statSync(path).mtimeMs, jobId, repositoryId: repositoryIdFromArtifact(jobId, name, stage), stage }];
  }).sort((left, right) => left.modifiedAt - right.modifiedAt || left.name.localeCompare(right.name));
}

function newestJobs(root: string): Map<string, StoredJob> {
  const directory = resolve(root, "missions");
  if (!existsSync(directory)) return new Map();
  const jobs = new Map<string, { path: string; modifiedAt: number }>();
  for (const missionId of readdirSync(directory)) {
    const missionDirectory = resolve(directory, missionId);
    if (!statSync(missionDirectory).isDirectory()) continue;
    for (const name of readdirSync(missionDirectory).filter((entry) => /^planning-job(?:-v\d+)?\.json$/.test(entry))) {
      const path = resolve(missionDirectory, name);
      const candidate = { path, modifiedAt: statSync(path).mtimeMs };
      const current = jobs.get(missionId);
      if (!current || candidate.modifiedAt > current.modifiedAt) jobs.set(missionId, candidate);
    }
  }
  return new Map([...jobs].flatMap(([id, entry]) => {
    const parsed = readJson(entry.path);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [[id, parsed as StoredJob] as const] : [];
  }));
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function storyId(job: StoredJob): number | null {
  const id = object(object(job.packet).story).id;
  return typeof id === "number" ? id : null;
}

function knownRepositoryIds(job: StoredJob): string[] {
  return strings(object(job.packet).knownRepositoryIds).length > 0
    ? strings(object(job.packet).knownRepositoryIds)
    : strings(job.repositoryIds);
}

function scoutEffort(root: string, job: StoredJob, jobId: string): "low" | "medium" | "high" {
  const value = job.scoutReasoningEffort;
  if (value === "low" || value === "medium" || value === "high") return value;
  const audit = readJsonLines(resolve(root, "planning-runs", `${jobId}.jsonl`));
  const profile = audit.find((record) => record.event === "scout-finished" && record.attempt === "initial")?.profile;
  const effort = object(profile).reasoningEffort;
  return effort === "low" || effort === "high" ? effort : "medium";
}

function readJsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function testHarness(job: StoredJob, repositoryId: string): { value: RepositoryTestHarness; context: ValidationReplayStage["context"] } {
  const stored = object(job.testHarnessSignature)[repositoryId];
  if (stored && typeof stored === "object" && !Array.isArray(stored)) return { value: stored as RepositoryTestHarness, context: "recorded-test-harness" };
  const worktreePath = object(job.worktreePaths)[repositoryId];
  if (typeof worktreePath === "string" && existsSync(worktreePath)) {
    return { value: discoverRepositoryTestHarness(worktreePath), context: "current-clone" };
  }
  return { value: { testPaths: [] }, context: "test-harness-unavailable" };
}

function scoutPackets(job: StoredJob): Record<string, ScoutPlanPacket> | null {
  const packets = job.scoutPackets;
  return packets && typeof packets === "object" && !Array.isArray(packets) ? packets as Record<string, ScoutPlanPacket> : null;
}

function validationMessageForCoordinator(output: string, job: StoredJob): { message: string | null; context: ValidationReplayStage["context"] } {
  const selected = strings(job.repositoryIds);
  const packets = scoutPackets(job);
  if (selected.length === 0 || !packets) return { message: null, context: "missing-scout-packets" };
  const decision = parseCoordinatorDecision(output, selected, knownRepositoryIds(job));
  if (decision.parseError) return { message: decision.parseError, context: "stored-scout-packets" };
  const harnesses = Object.fromEntries(selected.map((id) => [id, testHarness(job, id).value]));
  const plan = composeCoordinatedPlan(decision, packets, selected, harnesses);
  if (plan.parseError) return { message: plan.parseError, context: "stored-scout-packets" };
  return {
    message: validatePreDevelopDecisions(plan.decisionRegister, object(job.scoutFindings) as Record<string, string>)
      ?? validateConfirmationDependencies(plan, strings(job.resolvedConfirmationDependencyIds))
      ?? validateUnresolvedCrossRepositoryContracts(plan)
      ?? validateCrossRepositoryContracts(plan),
    context: "stored-scout-packets",
  };
}

function replayArtifact(root: string, artifact: Artifact, jobs: Map<string, StoredJob>): ValidationReplayStage {
  const job = jobs.get(artifact.jobId) ?? {};
  const provider = typeof job.provider === "string" ? job.provider : "unknown";
  const base = {
    artifact: artifact.name,
    jobId: artifact.jobId,
    storyId: storyId(job),
    provider,
    scoutEffort: scoutEffort(root, job, artifact.jobId),
    repositoryId: artifact.repositoryId,
    stage: artifact.stage,
    firstPass: artifact.stage === "initial-scout" || artifact.stage === "coordinator",
    repairRan: false,
    repairConverged: null,
  } as const;
  if (artifact.stage === "scope-out-correction" || artifact.stage === "scope-anchor-repair") {
    return { ...base, outcome: "context-dependent: skipped", ruleId: null, message: null, context: "scope-anchor-baseline" };
  }
  const output = readFileSync(artifact.path, "utf8");
  if (artifact.stage === "initial-scout" || artifact.stage === "scout-repair") {
    if (!artifact.repositoryId) return { ...base, outcome: "context-dependent: skipped", ruleId: null, message: null, context: "test-harness-unavailable" };
    const harness = testHarness(job, artifact.repositoryId);
    const packet = parseScoutPlanPacket(output, artifact.repositoryId, harness.value);
    const message = packet.parseError ?? validateScoutHandoffOwners(packet, knownRepositoryIds(job));
    return message
      ? { ...base, outcome: "invalid", ruleId: classifyValidationMessage(message), message, context: harness.context }
      : { ...base, outcome: "valid", ruleId: null, message: null, context: harness.context };
  }
  const coordinator = validationMessageForCoordinator(output, job);
  if (coordinator.context === "missing-scout-packets") {
    return { ...base, outcome: "context-dependent: skipped", ruleId: null, message: null, context: coordinator.context };
  }
  return coordinator.message
    ? { ...base, outcome: "invalid", ruleId: classifyValidationMessage(coordinator.message), message: coordinator.message, context: coordinator.context }
    : { ...base, outcome: "valid", ruleId: null, message: null, context: coordinator.context };
}

function group<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(key(value), [...(groups.get(key(value)) ?? []), value]);
  return groups;
}

function countOutcomes(stages: ValidationReplayStage[]): { valid: number; invalid: number; skipped: number } {
  return {
    valid: stages.filter((stage) => stage.outcome === "valid").length,
    invalid: stages.filter((stage) => stage.outcome === "invalid").length,
    skipped: stages.filter((stage) => stage.outcome === "context-dependent: skipped").length,
  };
}

function summarize(stages: ValidationReplayStage[], jobs: Map<string, StoredJob>): ValidationReplayReport["summary"] {
  const firstPass = stages.filter((stage) => stage.firstPass);
  const byStage = (["initial-scout", "scout-repair", "scope-out-correction", "scope-anchor-repair", "coordinator", "contract-repair"] as ReplayStage[]).map((stage) => {
    const matching = firstPass.filter((entry) => entry.stage === stage);
    const outcomes = countOutcomes(matching);
    return { stage, firstPass: matching.length, ...outcomes, repairs: matching.filter((entry) => entry.repairRan).length, convergedRepairs: matching.filter((entry) => entry.repairConverged).length };
  });
  const repairTriggers = [...group(firstPass.filter((stage) => stage.outcome === "invalid" && stage.ruleId !== null), (stage) => stage.ruleId!).entries()]
    .map(([ruleId, entries]) => ({ ruleId: ruleId as RuleId, count: entries.length })).sort((left, right) => right.count - left.count || left.ruleId.localeCompare(right.ruleId));
  const dimension = <T extends string | number | null>(key: (stage: ValidationReplayStage) => T, label: string): Array<Record<string, T | number>> =>
    [...group(firstPass, (stage) => String(key(stage))).entries()].map(([value, entries]) => ({ [label]: value === "null" ? null : value, ...countOutcomes(entries) }));
  const failedJobs = [...jobs.entries()].flatMap(([jobId, job]) => {
    if (job.status !== "failed") return [];
    const message = typeof job.plannedPathsParseError === "string" ? job.plannedPathsParseError
      : typeof job.planRevisionError === "string" ? job.planRevisionError
        : typeof job.error === "string" ? job.error : "Planning failed without a recorded validation message.";
    return [{ jobId, storyId: storyId(job), ruleId: classifyValidationMessage(message), message }];
  });
  const skipped = [...group(stages.filter((stage) => stage.outcome === "context-dependent: skipped"), (stage) => stage.context).entries()]
    .map(([context, entries]) => ({ context: context as ValidationReplayStage["context"], count: entries.length }));
  const unclassified = stages.filter((stage) => stage.outcome === "invalid" && stage.ruleId === "unclassified" && stage.message)
    .map((stage) => ({ artifact: stage.artifact, message: stage.message! }));
  return {
    byStage,
    repairTriggers,
    byProvider: dimension((stage) => stage.provider, "provider") as ValidationReplayReport["summary"]["byProvider"],
    byScoutEffort: dimension((stage) => stage.scoutEffort, "effort") as ValidationReplayReport["summary"]["byScoutEffort"],
    byStory: dimension((stage) => stage.storyId, "storyId") as ValidationReplayReport["summary"]["byStory"],
    failedJobs,
    skipped,
    unclassified,
  };
}

function linkRepairs(stages: ValidationReplayStage[]): ValidationReplayStage[] {
  return stages.map((stage) => {
    if (!stage.firstPass) return stage;
    const repairStage = stage.stage === "initial-scout" ? "scout-repair" : stage.stage === "coordinator" ? "contract-repair" : null;
    const repairs = repairStage ? stages.filter((candidate) => candidate.jobId === stage.jobId && candidate.repositoryId === stage.repositoryId && candidate.stage === repairStage) : [];
    return { ...stage, repairRan: repairs.length > 0, repairConverged: repairs.length > 0 ? repairs.some((repair) => repair.outcome === "valid") : null };
  });
}

export function replayValidationCorpus(root = runtimeRoot()): ValidationReplayReport {
  const jobs = newestJobs(root);
  const stages = linkRepairs(artifacts(root).map((artifact) => replayArtifact(root, artifact, jobs)));
  return { generatedAt: new Date().toISOString(), runtimeRoot: root, stages, summary: summarize(stages, jobs) };
}

export function writeValidationReplayReport(report: ValidationReplayReport): string {
  const directory = resolve(report.runtimeRoot, "validation-replay");
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `report-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

function printReport(report: ValidationReplayReport, path: string): void {
  console.table(report.summary.byStage);
  console.table(report.summary.repairTriggers);
  console.table(report.summary.byProvider);
  console.table(report.summary.byScoutEffort);
  console.table(report.summary.byStory);
  console.log(`Validation replay report: ${path}`);
  console.log(`Context-dependent skips: ${report.summary.skipped.map((entry) => `${entry.context}=${entry.count}`).join(", ") || "none"}`);
  console.log(`Unclassified validation messages: ${report.summary.unclassified.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const report = replayValidationCorpus();
  printReport(report, writeValidationReplayReport(report));
}
