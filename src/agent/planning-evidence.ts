import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ScopeAnchorRequirement } from "../config/team-config.js";
import { verifyScopeAnchorEvidence } from "./scope-anchor-evidence.js";

export interface ScopeOutVerification {
  status: "not-applicable" | "verified" | "unverified";
  evidence: string[];
  unmatchedEvidence: string[];
}

export function verifyScopeOutEvidence(
  plannedPaths: string[],
  evidence: string[],
  eventPaths: string[],
  worktreePath: string,
  scopeAnchors: ScopeAnchorRequirement[] = [],
): ScopeOutVerification {
  if (plannedPaths.length > 0) return { status: "not-applicable", evidence, unmatchedEvidence: [] };
  const inspected = new Set(eventPaths.flatMap((path) => inspectedPathsFromEvents(path, worktreePath)));
  const normalizedEvidence = evidence.flatMap((citation) => {
    const normalized = normalizeEvidencePath(citation, worktreePath);
    return normalized ? [normalized] : [];
  });
  const unmatchedEvidence = normalizedEvidence.filter((path) => !inspected.has(path));
  const anchorVerification = verifyScopeAnchorEvidence(scopeAnchors, evidence, worktreePath);
  const unresolvedAnchorPaths = anchorVerification.unresolvedRequirements.map((requirement) => requirement.filePath);
  return {
    status: normalizedEvidence.length > 0 && unmatchedEvidence.length === 0 && anchorVerification.status !== "unverified" ? "verified" : "unverified",
    evidence,
    unmatchedEvidence: evidence.length === 0 ? [] : [...new Set([...unmatchedEvidence, ...unresolvedAnchorPaths])],
  };
}

export function inspectedPathsFromEvents(eventsPath: string, worktreePath: string): string[] {
  if (!existsSync(eventsPath)) return [];
  const inspected = new Set<string>();
  const claudeTools = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    collectCodexPaths(event, worktreePath, inspected);
    collectClaudePaths(event, worktreePath, inspected, claudeTools);
  }
  return [...inspected];
}

export function normalizeEvidencePath(citation: string, worktreePath: string): string | null {
  const raw = citation.trim().replace(/#L\d+(?:-L?\d+)?$/, "").replace(/:\d+(?:(?::|-)\d+)?$/, "");
  if (raw === "") return null;
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(worktreePath, raw.replace(/^\.\//, ""));
  const root = resolve(worktreePath);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return null;
  const repositoryRelative = relative(root, absolute).split(sep).join("/");
  return repositoryRelative && fileExists(absolute) ? repositoryRelative : null;
}

function collectCodexPaths(event: Record<string, unknown>, worktreePath: string, inspected: Set<string>): void {
  if (event.type !== "item.completed" || typeof event.item !== "object" || event.item === null) return;
  const item = event.item as Record<string, unknown>;
  if (item.type !== "command_execution" || item.status !== "completed" || item.exit_code !== 0 || typeof item.command !== "string") return;
  if (!/(?:^|[\s/'"])(?:rg|grep|cat|sed|nl|awk)(?:\s|$)/.test(item.command)) return;
  collectExistingFileTokens(item.command, worktreePath, inspected);
  if (typeof item.aggregated_output === "string") collectExistingFileTokens(item.aggregated_output, worktreePath, inspected);
}

function collectClaudePaths(
  event: Record<string, unknown>,
  worktreePath: string,
  inspected: Set<string>,
  tools: Map<string, { name: string; input: Record<string, unknown> }>,
): void {
  if (typeof event.message !== "object" || event.message === null) return;
  const content = (event.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    if (typeof rawBlock !== "object" || rawBlock === null) continue;
    const block = rawBlock as Record<string, unknown>;
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      const input = typeof block.input === "object" && block.input !== null ? block.input as Record<string, unknown> : {};
      tools.set(block.id, { name: block.name, input });
    }
    if (block.type === "tool_result" && block.is_error !== true && typeof block.tool_use_id === "string") {
      const tool = tools.get(block.tool_use_id);
      if (tool?.name === "Read" && typeof tool.input.file_path === "string") addCandidate(tool.input.file_path, worktreePath, inspected);
      if (tool?.name === "Grep" && typeof tool.input.path === "string") addCandidate(tool.input.path, worktreePath, inspected);
      if (tool?.name === "Grep" && typeof block.content === "string") {
        collectExistingFileTokens(block.content, worktreePath, inspected);
      }
      // A Glob result is a tool-call record of files that provably exist and were observed. Credit
      // each returned path (one per line) as inspected so citing an enumerated sibling (e.g. the
      // parallel MEDIA/TABLE/*.sql files that prove an additive extension point exists) counts as
      // audit-backed evidence. Split on lines rather than the token regex, which needs a trailing
      // delimiter a bare path at end-of-line lacks.
      if (tool?.name === "Glob" && typeof block.content === "string") {
        for (const line of block.content.split(/\r?\n/)) {
          const candidate = line.trim();
          if (candidate) addCandidate(candidate, worktreePath, inspected);
        }
      }
    }
  }
}

function collectExistingFileTokens(text: string, worktreePath: string, inspected: Set<string>): void {
  for (const match of text.matchAll(/(?:^|[\s"'`(])((?:\.{0,2}\/|\/)?(?:[A-Za-z0-9_.@+ -]+\/)*[A-Za-z0-9_@+-]+\.[A-Za-z0-9_.+-]+)(?=[:#,\s"'`)])/gm)) {
    if (match[1]) addCandidate(match[1], worktreePath, inspected);
  }
}

function addCandidate(candidate: string, worktreePath: string, inspected: Set<string>): void {
  const normalized = normalizeEvidencePath(candidate, worktreePath);
  if (normalized) inspected.add(normalized);
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
