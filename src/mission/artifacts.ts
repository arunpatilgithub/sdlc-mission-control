import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import type { VerificationResult } from "../agent/develop-agent.js";
import type { RunUsage } from "../agent/usage.js";
import type { GateReport } from "./gates.js";

const nodeRequire = createRequire(import.meta.url);
const Ajv2020 = (nodeRequire("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js")).default;
const addFormats = (nodeRequire("ajv-formats") as typeof import("ajv-formats")).default;

interface ArtifactBase {
  schemaVersion: 1;
  missionId: string;
  storyId: number;
  stage: string;
  createdAt: string;
  producedBy: string;
}

export interface PlanArtifact extends ArtifactBase {
  planMarkdown: string;
  repositories: string[];
  plannedPaths: string[];
  referenceFiles: string[];
  openQuestions: string[];
  usage: RunUsage | null;
}

export interface DevelopArtifact extends ArtifactBase {
  repositoryId?: string;
  worktreePath: string;
  branch: string;
  commit: string | null;
  filesChanged: string[];
  diffStat: string | null;
  baseline: VerificationResult[];
  verification: VerificationResult[];
  regressions: string[];
  gateReport: GateReport;
  usage: RunUsage | null;
}

export interface Objection {
  severity: "blocker" | "major" | "minor";
  claim: string;
  evidence: string[];
}

export interface CriticVerdict extends ArtifactBase {
  disposition: "accept" | "revise" | "replan" | "escalate";
  objections: Objection[];
  usage: RunUsage | null;
}

const stringArraySchema = {
  type: "array",
  items: { type: "string" },
} as const;

const nullableNumberSchema = {
  type: ["number", "null"],
} as const;

const usageSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "provider", "inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens",
        "reasoningTokens", "costUSD", "turns", "durationMs", "promptBytes", "toolOutputBytes",
        "outputBytes", "commandCount",
      ],
      properties: {
        provider: { enum: ["claude", "codex"] },
        inputTokens: nullableNumberSchema,
        cachedInputTokens: nullableNumberSchema,
        cacheWriteTokens: nullableNumberSchema,
        outputTokens: nullableNumberSchema,
        reasoningTokens: nullableNumberSchema,
        costUSD: nullableNumberSchema,
        turns: { type: "number" },
        durationMs: { type: "number" },
        promptBytes: { type: "number" },
        toolOutputBytes: { type: "number" },
        outputBytes: { type: "number" },
        commandCount: { type: "number" },
      },
    },
  ],
} as const;

const verificationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "exitCode", "passed", "output"],
  properties: {
    command: { type: "string" },
    exitCode: { type: "number" },
    passed: { type: "boolean" },
    output: { type: "string" },
  },
} as const;

const gateReportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "results"],
  properties: {
    passed: { type: "boolean" },
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "detail", "offenders"],
        properties: {
          id: { enum: ["scope", "no-regressions", "no-secrets", "todo-markers", "version-bump"] },
          status: { enum: ["passed", "failed", "not-verified"] },
          detail: { type: "string" },
          offenders: stringArraySchema,
        },
      },
    },
  },
} as const;

const baseRequired = ["schemaVersion", "missionId", "storyId", "stage", "createdAt", "producedBy"] as const;
const baseProperties = {
  schemaVersion: { const: 1 },
  missionId: { type: "string", minLength: 1 },
  storyId: { type: "integer" },
  stage: { type: "string", minLength: 1 },
  createdAt: { type: "string", format: "date-time" },
  producedBy: { type: "string", minLength: 1 },
} as const;

const planSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    ...baseRequired, "planMarkdown", "repositories", "plannedPaths",
    "referenceFiles", "openQuestions", "usage",
  ],
  properties: {
    ...baseProperties,
    planMarkdown: { type: "string" },
    repositories: stringArraySchema,
    plannedPaths: stringArraySchema,
    referenceFiles: stringArraySchema,
    openQuestions: stringArraySchema,
    usage: usageSchema,
  },
} as const;

const developSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    ...baseRequired, "worktreePath", "branch", "commit", "filesChanged", "diffStat",
    "baseline", "verification", "regressions", "gateReport", "usage",
  ],
  properties: {
    ...baseProperties,
    repositoryId: { type: "string", minLength: 1 },
    worktreePath: { type: "string" },
    branch: { type: "string" },
    commit: { type: ["string", "null"] },
    filesChanged: stringArraySchema,
    diffStat: { type: ["string", "null"] },
    baseline: { type: "array", items: verificationSchema },
    verification: { type: "array", items: verificationSchema },
    regressions: stringArraySchema,
    gateReport: gateReportSchema,
    usage: usageSchema,
  },
} as const;

const criticSchema = {
  type: "object",
  additionalProperties: false,
  required: [...baseRequired, "disposition", "objections", "usage"],
  properties: {
    ...baseProperties,
    disposition: { enum: ["accept", "revise", "replan", "escalate"] },
    objections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "claim", "evidence"],
        properties: {
          severity: { enum: ["blocker", "major", "minor"] },
          claim: { type: "string", minLength: 1 },
          evidence: { ...stringArraySchema, minItems: 1 },
        },
      },
    },
    usage: usageSchema,
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validatePlan = ajv.compile(planSchema);
const validateDevelop = ajv.compile(developSchema);
const validateCritic = ajv.compile(criticSchema);

export function validatePlanArtifact(value: unknown): PlanArtifact {
  return validateArtifact(validatePlan, value, "Plan artifact");
}

export function validateDevelopArtifact(value: unknown): DevelopArtifact {
  return validateArtifact(validateDevelop, value, "Develop artifact");
}

export function validateCriticVerdict(value: unknown): CriticVerdict {
  return validateArtifact(validateCritic, value, "Critic verdict");
}

function validateArtifact<T>(validator: ValidateFunction, value: unknown, name: string): T {
  if (!validator(value)) {
    throw new Error(`${name} failed schema validation: ${formatErrors(validator.errors)}`);
  }
  return value as T;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unknown validation error";
  return errors.map((error) => `${error.instancePath || "(root)"} ${error.message}`).join("; ");
}
