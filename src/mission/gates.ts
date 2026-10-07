import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import type { VersionBumpPolicy } from "../config/team-config.js";
import type { VerificationResult } from "../agent/develop-agent.js";

export interface GateResult {
  /** Stable identifier, used in artifacts and the UI. */
  id: "scope" | "no-regressions" | "no-secrets" | "todo-markers" | "version-bump";
  status: "passed" | "failed" | "not-verified";
  /** One line, safe to show a developer verbatim. */
  detail: string;
  /** Specific files or `file:line` locations that caused a failure. Empty otherwise. */
  offenders: string[];
}

export interface GateInput {
  worktreePath: string;
  filesChanged: string[];
  /** Repo-relative paths and directory prefixes the approved plan named. */
  plannedPaths: string[];
  baseline: VerificationResult[];
  verification: VerificationResult[];
  storyId: number;
  /** Integration-branch commit the worktree was cut from. Needed to read the pre-change version file. */
  baselineCommit?: string;
  /** Team policy: repositories containing `file` must have `field` incremented alongside other code changes. */
  versionBumpPolicy?: VersionBumpPolicy;
}

export interface GateReport {
  passed: boolean;
  results: GateResult[];
}

interface AddedLine {
  path: string;
  line: number;
  content: string;
}

const ALWAYS_OUT_OF_SCOPE = [
  "README.md", "CHANGELOG.md", "CONTRIBUTING.md",
  "eslint.config.js", "eslint.config.mjs", ".eslintrc", ".eslintrc.js", ".eslintrc.json",
  ".prettierrc", "Dockerfile", "docker-compose.yml",
];
const MANIFEST_FILES = ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"];
const ALWAYS_OUT_OF_SCOPE_PREFIXES = [".github/", ".vscode/", ".husky/"];

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["aws-access-key", /AKIA[0-9A-Z]{16}/],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["assigned-credential", /(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|bearer)\s*[:=]\s*["'][^"']{8,}["']/i],
  ["connection-string", /(?:server|data source)\s*=[^;]+;.*(?:password|pwd)\s*=/i],
];

export function checkScope(filesChanged: string[], plannedPaths: string[]): GateResult {
  const offenders = filesChanged.filter((file) => !isPlanned(file, plannedPaths) || (isAlwaysOutOfScope(file) && !isManifestFile(file)));
  return {
    id: "scope",
    status: offenders.length === 0 ? "passed" : "failed",
    detail: offenders.length === 0
      ? `All ${filesChanged.length} changed files are within the planned scope`
      : `${offenders.length} of ${filesChanged.length} changed files are outside the planned scope`,
    offenders,
  };
}

export function isScopeExpansionAllowed(file: string): boolean {
  return !isAlwaysOutOfScope(file) && !isManifestFile(file);
}

export function checkNoRegressions(
  baseline: VerificationResult[],
  verification: VerificationResult[],
): GateResult {
  if (baseline.length === 0) {
    return {
      id: "no-regressions",
      status: "not-verified",
      detail: "No verification commands are configured for the repository",
      offenders: [],
    };
  }
  const baselinePassed = new Set(baseline.filter((result) => result.passed).map((result) => result.command));
  const offenders = [...new Set(
    verification.filter((result) => !result.passed && baselinePassed.has(result.command)).map((result) => result.command),
  )];
  return {
    id: "no-regressions",
    status: offenders.length === 0 ? "passed" : "failed",
    detail: offenders.length === 0
      ? "No verification regressions detected"
      : `${offenders.length} verification commands regressed`,
    offenders,
  };
}

export function checkNoSecrets(worktreePath: string, filesChanged: string[]): GateResult {
  try {
    const offenders: string[] = [];
    for (const added of collectAddedLines(worktreePath, filesChanged)) {
      if (usesEnvironmentCredential(added.content)) continue;
      for (const [name, pattern] of SECRET_PATTERNS) {
        if (pattern.test(added.content) && !hasPlaceholderCredential(added.content, name)) {
          offenders.push(`${added.path}:${added.line} (${name})`);
        }
      }
    }
    return {
      id: "no-secrets",
      status: offenders.length === 0 ? "passed" : "failed",
      detail: offenders.length === 0
        ? "No secrets detected in added lines"
        : `${offenders.length} possible secrets detected in added lines`,
      offenders,
    };
  } catch (error) {
    return failedGate("no-secrets", error);
  }
}

export function checkTodoMarkers(worktreePath: string, filesChanged: string[]): GateResult {
  try {
    const offenders = collectAddedLines(worktreePath, filesChanged)
      .filter((added) => /TODO|FIXME/.test(added.content))
      .map((added) => `${added.path}:${added.line}`);
    return {
      id: "todo-markers",
      status: offenders.length === 0 ? "passed" : "failed",
      detail: offenders.length === 0
        ? "No TODO or FIXME markers were added"
        : `${offenders.length} TODO or FIXME markers detected in added lines`,
      offenders,
    };
  } catch (error) {
    return failedGate("todo-markers", error);
  }
}

export function runGates(input: GateInput): GateReport {
  const results = [
    checkScope(input.filesChanged, input.plannedPaths),
    checkNoRegressions(input.baseline, input.verification),
    checkNoSecrets(input.worktreePath, input.filesChanged),
    checkTodoMarkers(input.worktreePath, input.filesChanged),
    checkVersionBump(input),
  ];
  return { passed: results.every((result) => result.status !== "failed"), results };
}

/**
 * Team policy: when a repository contains the configured version file, its version field must be
 * incremented whenever the mission changes other code. Self-disables (not-verified) when no policy
 * is configured, the file is absent, or nothing but the version file itself changed — so it never
 * blocks repositories the rule does not apply to.
 */
export function checkVersionBump(input: GateInput): GateResult {
  const policy = input.versionBumpPolicy;
  if (!policy) return notVerifiedVersionBump("No version-bump policy is configured");
  const relFile = policy.file.trim();
  const worktreeFile = resolve(input.worktreePath, relFile);
  if (!existsSync(worktreeFile)) return notVerifiedVersionBump(`Repository has no ${relFile}`);
  const otherChanged = input.filesChanged.filter((file) => file !== relFile);
  if (otherChanged.length === 0) return notVerifiedVersionBump(`No code changes require a ${relFile} bump`);
  try {
    const current = readVersionField(readFileSync(worktreeFile, "utf8"), policy.field);
    if (current === null) {
      return failedVersionBump(`${relFile} has no "${policy.field}" field to increment`, [relFile]);
    }
    const baselineRaw = input.baselineCommit
      ? gitShow(input.worktreePath, input.baselineCommit, relFile)
      : null;
    // A newly added version file (no baseline copy) is itself a valid bump.
    if (baselineRaw === null) {
      return passedVersionBump(`${relFile} added with "${policy.field}" ${current}`);
    }
    const baseline = readVersionField(baselineRaw, policy.field);
    if (baseline !== null && !isVersionIncrement(baseline, current)) {
      return failedVersionBump(
        `${relFile} "${policy.field}" was not incremented (${baseline} -> ${current}) despite ${otherChanged.length} other changed file(s)`,
        [relFile],
      );
    }
    return passedVersionBump(`${relFile} "${policy.field}" incremented ${baseline ?? "(none)"} -> ${current}`);
  } catch (error) {
    return failedVersionBump(`Version-bump gate could not run: ${error instanceof Error ? error.message : String(error)}`, [relFile]);
  }
}

function notVerifiedVersionBump(detail: string): GateResult {
  return { id: "version-bump", status: "not-verified", detail, offenders: [] };
}

function passedVersionBump(detail: string): GateResult {
  return { id: "version-bump", status: "passed", detail, offenders: [] };
}

function failedVersionBump(detail: string, offenders: string[]): GateResult {
  return { id: "version-bump", status: "failed", detail, offenders };
}

/** Reads a top-level field from a JSON document and returns it as a trimmed string, or null if absent. */
function readVersionField(raw: string, field: string): string | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const value = parsed[field];
  if (value === undefined || value === null) return null;
  return String(value).trim();
}

/** git show <commit>:<path>; returns null when the path does not exist at that commit. */
function gitShow(cwd: string, commit: string, relPath: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "show", `${commit}:${relPath}`], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout;
}

/**
 * True when `current` is a valid increment over `baseline`. Dotted-numeric versions (0.0.376 style)
 * must be strictly greater component-wise; any other format only needs to differ (a change is a bump).
 */
export function isVersionIncrement(baseline: string, current: string): boolean {
  if (current === baseline) return false;
  const a = parseNumericVersion(baseline);
  const b = parseNumericVersion(current);
  if (a === null || b === null) return true; // non-semver: any change counts
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return y > x;
  }
  return false;
}

function parseNumericVersion(value: string): number[] | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)*$/.test(trimmed)) return null;
  return trimmed.split(".").map(Number);
}

function isAlwaysOutOfScope(file: string): boolean {
  return ALWAYS_OUT_OF_SCOPE.includes(file)
    || ALWAYS_OUT_OF_SCOPE.includes(posix.basename(file))
    || ALWAYS_OUT_OF_SCOPE_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function isManifestFile(file: string): boolean {
  return MANIFEST_FILES.includes(file) || MANIFEST_FILES.includes(posix.basename(file));
}

function isPlanned(file: string, plannedPaths: string[]): boolean {
  return plannedPaths.some((planned) => file === planned
    || (planned.endsWith("/") && file.startsWith(planned)));
}

function collectAddedLines(worktreePath: string, filesChanged: string[]): AddedLine[] {
  const untracked = new Set(
    git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean),
  );
  return filesChanged.flatMap((file) => untracked.has(file)
    ? untrackedLines(worktreePath, file)
    : trackedAddedLines(worktreePath, file));
}

function untrackedLines(worktreePath: string, file: string): AddedLine[] {
  const lines = readFileSync(resolve(worktreePath, file), "utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((content, index) => ({ path: file, line: index + 1, content }));
}

function trackedAddedLines(worktreePath: string, file: string): AddedLine[] {
  const diff = git(worktreePath, ["diff", "--unified=0", "HEAD", "--", file]);
  const added: AddedLine[] = [];
  let newLine: number | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
    } else if (newLine !== null && line.startsWith("+") && !line.startsWith("+++")) {
      added.push({ path: file, line: newLine, content: line.slice(1) });
      newLine += 1;
    } else if (newLine !== null && !line.startsWith("-") && !line.startsWith("\\")) {
      newLine += 1;
    }
  }
  return added;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
}

function usesEnvironmentCredential(line: string): boolean {
  return ["process.env", "getenv", "os.environ", "import.meta.env"].some((marker) => line.includes(marker));
}

function hasPlaceholderCredential(line: string, patternName: string): boolean {
  let literal: string | null = null;
  if (patternName === "assigned-credential") {
    literal = /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|bearer)\s*[:=]\s*["']([^"']+)["']/i.exec(line)?.[1] ?? null;
  } else if (patternName === "connection-string") {
    literal = /(?:password|pwd)\s*=\s*["']?([^;"']+)/i.exec(line)?.[1] ?? null;
  }
  if (literal === null) return false;
  const normalized = literal.trim().toLowerCase();
  return ["changeme", "your-", "xxx", "example", "redacted"].some((marker) => normalized.includes(marker))
    || (normalized.startsWith("<") && normalized.endsWith(">"))
    || /^([^\s])\1+$/.test(normalized);
}

function failedGate(id: "no-secrets" | "todo-markers", error: unknown): GateResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id,
    status: "failed",
    detail: `Gate could not run: ${message.replace(/\s+/g, " ").trim()}`,
    offenders: [],
  };
}
