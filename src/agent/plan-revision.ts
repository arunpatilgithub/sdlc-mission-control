import type { Objection } from "../mission/artifacts.js";

export const MAX_DEVELOPER_PLAN_REVISIONS = 5;

export interface DeveloperPlanAnswer {
  question: string;
  answer: string;
  evidence?: string;
}

export interface PlanRevisionClassification {
  path: "deterministic-patch" | "scoped-rerun";
  replacements: Array<{ from: string; to: string }>;
  reason: string;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const IDENTIFIER_IN_TEXT = /\b[A-Z][A-Za-z0-9_$]{2,}\b/g;

export function developerAnswerToObjection(answer: DeveloperPlanAnswer): Objection {
  const question = answer.question.trim();
  const decision = answer.answer.trim();
  if (question === "" || decision === "") throw new Error("Developer answers require both a question and an answer");
  const suppliedEvidence = answer.evidence?.trim();
  if (suppliedEvidence && !isAzureDevOpsCommentUrl(suppliedEvidence)) {
    throw new Error("Developer answer evidence must be an HTTPS Azure DevOps comment link");
  }
  return {
    severity: "major",
    claim: `Developer decision for "${question}": ${decision}`,
    evidence: [suppliedEvidence
      ? `human decision — ADO comment ${suppliedEvidence}`
      : "human decision — Mission Control developer input"],
  };
}

function isAzureDevOpsCommentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "dev.azure.com" || url.hostname.endsWith(".visualstudio.com"));
  } catch {
    return false;
  }
}

export function classifyDeveloperPlanAnswer(answer: DeveloperPlanAnswer): PlanRevisionClassification {
  const question = answer.question.trim();
  const decisionIdentifiers = [...answer.answer.matchAll(IDENTIFIER_IN_TEXT)].map((match) => match[0]!);
  const directDecision = answer.answer.trim().replace(/^(?:use|choose|confirm|confirmed:?)\s+/i, "").replace(/[.!]$/, "");
  const chosen = IDENTIFIER.test(directDecision) ? directDecision : decisionIdentifiers.length === 1 ? decisionIdentifiers[0]! : null;
  const optionClause = question.match(/:\s*([^?]+)\??$/)?.[1] ?? "";
  const listedOptions = [...optionClause.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)]
    .map((match) => match[0]!)
    .filter((candidate) => !["and", "or"].includes(candidate.toLowerCase()));
  if (chosen && listedOptions.includes(chosen) && listedOptions.length >= 2) {
    return {
      path: "deterministic-patch",
      replacements: listedOptions.filter((candidate) => candidate !== chosen).map((from) => ({ from, to: chosen })),
      reason: "The answer selects one exact identifier from the alternatives stated in the question.",
    };
  }
  const questionIdentifiers = [...new Set([...question.matchAll(IDENTIFIER_IN_TEXT)]
    .map((match) => match[0]!)
    .filter((candidate) => /[a-z][A-Z]|[A-Z].*[A-Z]|(?:Conversion|Handler|Service|Controller)$/.test(candidate)))];
  const names = questionIdentifiers.filter((candidate) => /(?:name|naming|called|type|identifier|\bvs\.?\b)/i.test(question));
  if (chosen && names.includes(chosen) && names.some((candidate) => candidate !== chosen)) {
    return {
      path: "deterministic-patch",
      replacements: names.filter((candidate) => candidate !== chosen).map((from) => ({ from, to: chosen })),
      reason: "The answer selects one of the explicit identifier alternatives in a naming question.",
    };
  }
  return {
    path: "scoped-rerun",
    replacements: [],
    reason: "The answer may change scope, behavior, contracts, or validation and requires read-only planning reasoning.",
  };
}

export function applyDeterministicPlanPatch(
  plan: string,
  answer: DeveloperPlanAnswer,
  classification: PlanRevisionClassification,
): string {
  if (classification.path !== "deterministic-patch") throw new Error("Only deterministic-patch classifications can patch a plan");
  const patched = applyRevisionReplacements(plan, classification);
  return `${patched.trim()}\n\n## Resolved developer decisions\n- ${answer.question.trim()}: ${answer.answer.trim()}\n`;
}

export function applyRevisionReplacements(value: string, classification: PlanRevisionClassification): string {
  return classification.replacements.reduce((current, replacement) =>
    current.replace(new RegExp(`\\b${escapeRegExp(replacement.from)}\\b`, "g"), replacement.to), value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
