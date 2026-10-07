import { verifyScopeOutEvidence } from "./planning-evidence.js";

const BEHAVIORAL_CLAIM_PATTERNS = [
  /\balready handles?\b/i,
  /\bdefaults? to\b/i,
  /\bno changes? (?:is |are )?needed\b/i,
  /\bworks? as[- ]is\b/i,
  /\bno additional\b.{0,80}\bneeded\b/i,
  /\bdoes not require\b/i,
  /\bno backend coordination\b/i,
];

const FILE_LINE_CITATION = /(?:^|[\s(`])((?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_@+-]+\.[A-Za-z0-9_.+-]+:\d+(?::\d+)?)(?=$|[\s),.;`])/g;

export interface BehavioralClaimVerification {
  stepIndex: number;
  step: string;
  phrase: string;
  citations: string[];
  status: "verified" | "unverified" | "confirmed" | "refuted" | "developer-override";
  explanation: string | null;
}

export interface BehavioralReviewJudgment {
  stepIndex: number;
  disposition: "confirmed" | "refuted";
  evidence: string[];
  explanation: string;
}

export function scanBehavioralClaims(
  implementationSteps: string[],
  eventPaths: string[],
  worktreePath: string,
): BehavioralClaimVerification[] {
  return implementationSteps.flatMap((step, stepIndex) => {
    const pattern = BEHAVIORAL_CLAIM_PATTERNS.find((candidate) => candidate.test(step));
    if (!pattern) return [];
    const phraseMatch = pattern.exec(step);
    const phrase = phraseMatch?.[0] ?? "behavioral claim";
    const phraseIndex = phraseMatch?.index ?? 0;
    const citations = [...step.matchAll(FILE_LINE_CITATION)]
      .filter((match) => Math.abs((match.index ?? 0) - phraseIndex) <= 160)
      .map((match) => match[1]!);
    const verification = verifyScopeOutEvidence([], citations, eventPaths, worktreePath);
    return [{
      stepIndex,
      step,
      phrase,
      citations,
      status: verification.status === "verified" ? "verified" as const : "unverified" as const,
      explanation: verification.status === "verified"
        ? null
        : citations.length === 0
          ? "Behavioral claim has no adjacent file:line citation."
          : `Citation was not backed by the planning tool-call audit: ${verification.unmatchedEvidence.join(", ")}`,
    }];
  });
}

export function hasBlockingBehavioralClaims(claimsByRepository: Record<string, BehavioralClaimVerification[]>): boolean {
  return Object.values(claimsByRepository).flat().some((claim) => claim.status === "unverified" || claim.status === "refuted");
}

export function applyBehavioralReviewJudgments(
  claims: BehavioralClaimVerification[],
  judgments: BehavioralReviewJudgment[],
  eventPaths: string[],
  worktreePath: string,
): BehavioralClaimVerification[] {
  return claims.map((claim) => {
    if (claim.status !== "unverified") return claim;
    const judgment = judgments.find((entry) => entry.stepIndex === claim.stepIndex);
    if (!judgment) return claim;
    const evidence = verifyScopeOutEvidence([], judgment.evidence, eventPaths, worktreePath);
    if (evidence.status !== "verified") return { ...claim, explanation: "Targeted critic did not produce audit-backed file evidence." };
    return { ...claim, citations: judgment.evidence, status: judgment.disposition, explanation: judgment.explanation };
  });
}
