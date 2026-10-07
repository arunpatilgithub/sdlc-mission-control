import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ScopeAnchorRequirement } from "../config/team-config.js";

export interface ScopeAnchorSnippet {
  requirement: ScopeAnchorRequirement;
  range: [number, number];
  text: string;
}

export interface ScopeAnchorVerification {
  status: "not-applicable" | "verified" | "unverified";
  unresolvedRequirements: ScopeAnchorRequirement[];
  matchedEvidence: string[];
}

const CONTEXT_LINES = 18;

/**
 * Scope anchors turn a team-maintained extension seam into source-grounded planning context.
 * They deliberately identify a current pattern, not a future vendor literal that is absent
 * precisely because the requested change has not been made yet.
 */
export function readScopeAnchorSnippet(worktreePath: string, requirement: ScopeAnchorRequirement): ScopeAnchorSnippet | null {
  const path = resolve(worktreePath, requirement.filePath);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.includes(requirement.marker));
  if (markerIndex === -1) return null;
  const startIndex = Math.max(0, markerIndex - 2);
  const endIndex = Math.min(lines.length, markerIndex + CONTEXT_LINES);
  return {
    requirement,
    range: [startIndex + 1, endIndex],
    text: lines.slice(startIndex, endIndex).join("\n"),
  };
}

/**
 * A no-change conclusion must directly address every configured additive seam. Provenance
 * alone is not enough: unrelated evidence cannot establish that an extensible registry,
 * allowlist, or documented vendor pattern has no local work for the named capability.
 */
export function verifyScopeAnchorEvidence(
  requirements: ScopeAnchorRequirement[],
  evidence: string[],
  worktreePath: string,
): ScopeAnchorVerification {
  if (requirements.length === 0) return { status: "not-applicable", unresolvedRequirements: [], matchedEvidence: [] };
  const resolved = requirements.flatMap((requirement) => {
    const snippet = readScopeAnchorSnippet(worktreePath, requirement);
    return snippet ? [snippet] : [];
  });
  if (resolved.length === 0) return { status: "not-applicable", unresolvedRequirements: [], matchedEvidence: [] };
  const matchedEvidence = evidence.filter((citation) => resolved.some((snippet) => citationOverlapsRange(citation, snippet.requirement.filePath, snippet.range)));
  const unresolvedRequirements = resolved
    .filter((snippet) => !evidence.some((citation) => citationOverlapsRange(citation, snippet.requirement.filePath, snippet.range)))
    .map((snippet) => snippet.requirement);
  return {
    status: unresolvedRequirements.length === 0 ? "verified" : "unverified",
    unresolvedRequirements,
    matchedEvidence,
  };
}

function citationOverlapsRange(citation: string, expectedFilePath: string, range: [number, number]): boolean {
  const match = /^(.*?):(\d+)(?:-(\d+))?$/.exec(citation.trim());
  if (!match) return false;
  const [, filePart, startLineRaw, endLineRaw] = match;
  const normalizedFilePart = filePart.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalizedFilePart.endsWith(expectedFilePath)) return false;
  const startLine = Number(startLineRaw);
  const endLine = endLineRaw ? Number(endLineRaw) : startLine;
  return endLine >= range[0] && startLine <= range[1];
}
