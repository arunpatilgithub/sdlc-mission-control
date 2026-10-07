import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ContractFunctionRequirement } from "../config/team-config.js";

/**
 * Generic, team-agnostic check: given a repository's team-configured contract-defining
 * functions (see ContractFunctionRequirement in team-config.ts), does the planner's cited
 * evidence for including this repository actually fall within one of those functions'
 * current line range — as opposed to citing any other line in the same file?
 *
 * This module knows nothing about any specific repository, team, or story. Which functions
 * matter for which repository is team-specific knowledge that belongs in that team's own
 * config file, not hardcoded here — this is deliberately just the generic mechanism.
 */
export type { ContractFunctionRequirement };

const FUNCTION_WINDOW_LINES = 80;

export interface ContractFunctionVerification {
  status: "not-applicable" | "verified" | "unverified";
  matchedRequirement: ContractFunctionRequirement | null;
  functionRange: [number, number] | null;
  matchedEvidence: string[];
}

export function verifyContractFunctionEvidence(
  requirements: ContractFunctionRequirement[],
  plannedPaths: string[],
  evidence: string[],
  worktreePath: string,
  options: { requireEvidenceWithoutChanges?: boolean } = {},
): ContractFunctionVerification {
  if (requirements.length === 0 || (plannedPaths.length === 0 && !options.requireEvidenceWithoutChanges)) {
    return { status: "not-applicable", matchedRequirement: null, functionRange: null, matchedEvidence: [] };
  }

  for (const requirement of requirements) {
    const range = resolveFunctionRange(worktreePath, requirement);
    if (!range) continue;
    const matchedEvidence = evidence.filter((citation) => citationOverlapsRange(citation, requirement.filePath, range));
    if (matchedEvidence.length > 0) {
      return { status: "verified", matchedRequirement: requirement, functionRange: range, matchedEvidence };
    }
  }

  // None of the configured requirements could even be resolved against the current worktree
  // (e.g. the function was renamed/moved and the config wasn't updated) — that's a config
  // problem to surface separately, not grounds to flag every inclusion as unverified.
  const firstResolvable = requirements
    .map((requirement) => ({ requirement, range: resolveFunctionRange(worktreePath, requirement) }))
    .find((entry) => entry.range !== null);
  if (!firstResolvable) {
    return { status: "not-applicable", matchedRequirement: null, functionRange: null, matchedEvidence: [] };
  }

  return { status: "unverified", matchedRequirement: null, functionRange: firstResolvable.range, matchedEvidence: [] };
}

function resolveFunctionRange(worktreePath: string, requirement: ContractFunctionRequirement): [number, number] | null {
  const lines = readSourceLines(worktreePath, requirement.filePath);
  if (!lines) return null;
  const startIndex = findFunctionDefinitionLineIndex(lines, requirement.functionName);
  if (startIndex === -1) return null;
  const start = startIndex + 1; // 1-indexed to match citation convention
  const end = Math.min(lines.length, start + FUNCTION_WINDOW_LINES);
  return [start, end];
}

function readSourceLines(worktreePath: string, filePath: string): string[] | null {
  const absolutePath = resolve(worktreePath, filePath);
  if (!existsSync(absolutePath)) return null;
  return readFileSync(absolutePath, "utf8").split(/\r?\n/);
}

// Anchored to the start of the (trimmed) line so this matches a method *definition*
// (`getPublisherPixels(msg, event) {`) and not a call site (`this.getPublisherPixels(...)`
// or `= this.getPublisherPixels(...)`), which would otherwise match first and point the
// whole verification at the wrong, unrelated line range.
function findFunctionDefinitionLineIndex(lines: string[], functionName: string): number {
  const pattern = new RegExp(`^\\s*${functionName}\\s*\\(`);
  return lines.findIndex((line) => pattern.test(line));
}

/**
 * Reads the actual current text of a configured contract function, for injecting directly
 * into a planning prompt as ground truth — so the model reasons from the real, current
 * definition instead of from pattern-similarity to some other repository, and isn't relied
 * upon to go find and read the right thing entirely on its own initiative.
 */
export function readContractFunctionSnippet(worktreePath: string, requirement: ContractFunctionRequirement): { range: [number, number]; text: string } | null {
  const lines = readSourceLines(worktreePath, requirement.filePath);
  if (!lines) return null;
  const startIndex = findFunctionDefinitionLineIndex(lines, requirement.functionName);
  if (startIndex === -1) return null;
  const start = startIndex + 1;
  const maxEnd = Math.min(lines.length, start + FUNCTION_WINDOW_LINES);
  // Trim at the next sibling method definition (same indentation as the opening line),
  // if one appears within the window, so the snippet is the function itself rather than
  // the function plus however much of the next unrelated method the fixed window happens
  // to include.
  const indentMatch = /^(\s*)/.exec(lines[startIndex]!);
  const indent = indentMatch ? indentMatch[1]! : "";
  const siblingPattern = new RegExp(`^${indent}\\w+\\s*\\(`);
  let end = maxEnd;
  for (let i = startIndex + 1; i < maxEnd; i += 1) {
    if (siblingPattern.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { range: [start, end], text: lines.slice(startIndex, end).join("\n") };
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
