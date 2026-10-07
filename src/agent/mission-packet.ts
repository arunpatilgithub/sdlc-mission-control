import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { UserStory } from "../ado/azure-devops-cli.js";
import type { WorkItemComment } from "../ado/azure-devops-rest.js";
import type { RelatedWorkItemContext } from "../ado/related-work-item-discovery.js";
import type { ContractFunctionRequirement, RepositoryConfig, ScopeAnchorRequirement } from "../config/team-config.js";
import { loadMatchingVendorApiSpecs, type VendorApiSpec } from "../config/vendor-api-specs.js";
import type { PlanningDocumentation } from "./documentation-fetch.js";
import { loadSkill } from "./skills.js";

export type PlanningMode = "fast" | "deep" | "extreme";
export type HistoryPolicy = "none" | "targeted-precedents";
export type RepositoryStrategy = "evaluate" | "existing" | "new-from-reference";
export type PlanningPhase = "repository-decision" | "implementation-plan";

export type RepositoryMissionContext = {
  id: string;
  worktreePath: string;
  branch: string;
  baselineCommit: string;
  appType: string;
  commands: string[];
  instructions: string[];
  planningSkill: string;
  planningSkillTools: string[];
  likelyFiles: Array<{ path: string; sha256: string }>;
  precedents: string[];
  /** Bounded, baseline-ancestor-only Git evidence collected by the harness for Extreme Deep planning. */
  historyDossier: string;
  /** Team-configured contract-defining functions for this repository (see ContractFunctionRequirement). Empty for repositories with no known such pattern. */
  contractFunctions: ContractFunctionRequirement[];
  /** Team-configured non-function extension points that decide additive repository scope. */
  scopeAnchors: ScopeAnchorRequirement[];
};

export type MissionPacket = {
  schemaVersion: 1 | 2 | 3 | 4 | 5;
  missionId: string;
  generatedAt: string;
  mode: PlanningMode;
  historyPolicy: HistoryPolicy;
  repositoryStrategy: RepositoryStrategy;
  phase: PlanningPhase;
  proposedRepositoryName: string | null;
  story: {
    id: number;
    title: string;
    state: string;
    description: string;
    acceptanceCriteria: string;
    comments?: WorkItemComment[];
    commentsTruncated?: boolean;
  };
  /** Developer-selected prior ADO work items. Reference context only; the current story remains authoritative. */
  relatedWorkItems?: Array<{
    id: number;
    title: string;
    description: string;
    acceptanceCriteria: string;
    comments: WorkItemComment[];
    commentsTruncated: boolean;
    url: string;
    pullRequests: RelatedWorkItemContext["pullRequests"];
    gitLabMergeRequests: RelatedWorkItemContext["gitLabMergeRequests"];
  }>;
  repositories?: RepositoryMissionContext[];
  /** Primary repository aliases retained while single-repository mission history remains readable. */
  repository: Pick<RepositoryMissionContext, "id" | "worktreePath" | "branch" | "baselineCommit" | "appType" | "commands">;
  instructions: string[];
  planningSkill: string;
  /** Additional Claude tools the planning skill declared it needs, beyond the fixed read-only baseline. */
  planningSkillTools: string[];
  likelyFiles: Array<{ path: string; sha256: string }>;
  precedents: string[];
  /** Every repository id in the team's allow-list, so the planning agent can only name repos a developer could actually approve. */
  knownRepositoryIds: string[];
  vendorApiSpecs?: VendorApiSpec[];
  documentation?: PlanningDocumentation[];
  /** Human-seeded cross-repository literals every repo's scout must use verbatim, so repos author matching dossiers instead of independently guessing divergent names. */
  sharedContracts?: SharedContract[];
};

/** A cross-repository value (e.g. a table name) decided once for a mission and used identically by every dependent repository. */
export interface SharedContract {
  concept: string;
  literalKind: string;
  canonicalLiteral: string;
  /** A multi-member set (for example every grain table the mission needs). When present, every member must appear; canonicalLiteral holds the first member for scalar-contract compatibility. */
  canonicalLiterals?: string[];
  /** Repositories this contract binds. Empty/absent means it applies to every repository in the mission. */
  affectedRepositoryIds?: string[];
}

/** The full member list of a shared contract: its set members when set-valued, else the single canonical literal. */
export function sharedContractMembers(contract: SharedContract): string[] {
  const members = (contract.canonicalLiterals ?? []).filter((literal) => literal.trim() !== "");
  return members.length > 0 ? [...new Set(members)] : [contract.canonicalLiteral];
}

export function repositoryContexts(packet: MissionPacket): RepositoryMissionContext[] {
  if (packet.repositories?.length) return packet.repositories;
  return [{
    ...packet.repository,
    instructions: packet.instructions,
    planningSkill: packet.planningSkill,
    planningSkillTools: packet.planningSkillTools,
    contractFunctions: [],
    scopeAnchors: [],
    likelyFiles: packet.likelyFiles,
    precedents: packet.precedents,
    historyDossier: "",
  }];
}

export function packetForRepository(packet: MissionPacket, repositoryId: string): MissionPacket {
  const repository = repositoryContexts(packet).find((entry) => entry.id === repositoryId);
  if (!repository) throw new Error(`Repository is not present in the mission packet: ${repositoryId}`);
  const { documentation: _documentation, vendorApiSpecs: _vendorApiSpecs, relatedWorkItems: _relatedWorkItems, ...developPacket } = packet;
  return {
    ...developPacket,
    repository,
    instructions: repository.instructions,
    planningSkill: repository.planningSkill,
    planningSkillTools: repository.planningSkillTools,
    likelyFiles: repository.likelyFiles,
    precedents: repository.precedents,
  };
}

const excludedDirectories = new Set([".git", ".worktrees", "node_modules", "dist", "build", "coverage", ".next"]);

function runtimeRoot(): string {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  return configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
}

export function createMissionPacket(input: {
  missionId: string;
  story: UserStory;
  repository: RepositoryConfig;
  worktreePath: string;
  branch: string;
  mode: PlanningMode;
  historyPolicy: HistoryPolicy;
  repositoryStrategy: RepositoryStrategy;
  phase: PlanningPhase;
  knownRepositoryIds: string[];
  proposedRepositoryName?: string;
  documentation?: PlanningDocumentation[];
  relatedWorkItems?: RelatedWorkItemContext[];
}): MissionPacket {
  return createMultiRepositoryMissionPacket({
    ...input,
    repositories: [{ repository: input.repository, worktreePath: input.worktreePath, branch: input.branch }],
  });
}

export function createMultiRepositoryMissionPacket(input: {
  missionId: string;
  story: UserStory;
  repositories: Array<{ repository: RepositoryConfig; worktreePath: string; branch: string }>;
  mode: PlanningMode;
  historyPolicy: HistoryPolicy;
  repositoryStrategy: RepositoryStrategy;
  phase: PlanningPhase;
  knownRepositoryIds: string[];
  proposedRepositoryName?: string;
  documentation?: PlanningDocumentation[];
  relatedWorkItems?: RelatedWorkItemContext[];
  sharedContracts?: SharedContract[];
}): MissionPacket {
  if (input.repositories.length === 0) throw new Error("At least one repository is required for a mission packet");
  const storyText = `${input.story.title} ${input.story.acceptanceCriteria} ${input.story.description} ${(input.story.comments ?? []).map((comment) => comment.text).join(" ")}`;
  const repositories = input.repositories.map(({ repository, worktreePath, branch }) => {
    const baselineCommit = gitValue(worktreePath, ["rev-parse", "HEAD"]);
    const repositoryContext = loadRepositoryContext(repository.id, worktreePath, baselineCommit);
    const likelyFiles = selectLikelyFiles(worktreePath, storyText, input.mode);
    const planningSkill = loadPlanningSkill(repository.id);
    return {
      id: repository.id,
      worktreePath,
      branch,
      baselineCommit,
      appType: repositoryContext.appType,
      commands: repositoryContext.commands,
      instructions: repositoryContext.instructions,
      planningSkill: planningSkill.instructions,
      planningSkillTools: planningSkill.extraReadTools,
      contractFunctions: repository.contractFunctions ?? [],
      scopeAnchors: repository.scopeAnchors ?? [],
      likelyFiles,
      precedents: input.historyPolicy === "targeted-precedents"
        ? findTargetedPrecedents(worktreePath, likelyFiles.map((file) => file.path))
        : [],
      historyDossier: input.mode === "extreme"
        ? buildExtremeHistoryDossier(worktreePath, baselineCommit, likelyFiles.map((file) => file.path), storyKeywords(storyText))
        : "",
    };
  });
  const primary = repositories[0]!;
  const boundedComments = boundedStoryComments(input.story.comments ?? []);
  const packet: MissionPacket = {
    schemaVersion: 5,
    missionId: input.missionId,
    generatedAt: new Date().toISOString(),
    mode: input.mode,
    historyPolicy: input.historyPolicy,
    repositoryStrategy: input.repositoryStrategy,
    phase: input.phase,
    proposedRepositoryName: input.proposedRepositoryName?.trim() || null,
    story: {
      id: input.story.id,
      title: input.story.title,
      state: input.story.state,
      description: stripHtml(input.story.description),
      acceptanceCriteria: stripHtml(input.story.acceptanceCriteria),
      comments: boundedComments,
      commentsTruncated: boundedComments.length < (input.story.comments?.length ?? 0),
    },
    relatedWorkItems: input.relatedWorkItems?.map((related) => {
      const comments = boundedStoryComments(related.comments);
      return {
        id: related.id,
        title: related.title,
        description: stripHtml(related.description),
        acceptanceCriteria: stripHtml(related.acceptanceCriteria),
        comments,
        commentsTruncated: comments.length < related.comments.length,
        url: related.url,
        pullRequests: related.pullRequests,
        gitLabMergeRequests: related.gitLabMergeRequests,
      };
    }) ?? [],
    repositories,
    repository: primary,
    instructions: primary.instructions,
    planningSkill: primary.planningSkill,
    planningSkillTools: primary.planningSkillTools,
    likelyFiles: primary.likelyFiles,
    precedents: primary.precedents,
    knownRepositoryIds: input.knownRepositoryIds,
    vendorApiSpecs: loadMatchingVendorApiSpecs(storyText),
    documentation: input.documentation ?? [],
    sharedContracts: input.sharedContracts ?? [],
  };

  const missionDirectory = resolve(runtimeRoot(), "missions", packet.missionId);
  mkdirSync(missionDirectory, { recursive: true });
  writeFileSync(resolve(missionDirectory, "packet-v5.json"), `${JSON.stringify(packet, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return packet;
}

function loadPlanningSkill(repositoryId: string): ReturnType<typeof loadSkill> {
  const skill = loadSkill("planning", repositoryId);
  const verificationRule = "Before stating a repository needs no changes, or citing a pattern from another story as applying here, you must have read the current file implementing the relevant mechanism and cite its path. Do not infer scope-out from a similarly-named past ticket without confirming the same code path is involved.\n\nAny implementation step asserting how existing code currently behaves — 'X already handles Y,' 'defaults to Z,' 'no change needed because...' — must cite the specific file:line read to confirm it. If you haven't read the relevant logic, don't state the behavior as fact; mark it as NEEDS VERIFICATION instead.";
  return { ...skill, instructions: `${skill.instructions}\n\n${verificationRule}` };
}

export function boundedStoryComments(comments: WorkItemComment[]): WorkItemComment[] {
  const selected: WorkItemComment[] = [];
  let remainingCharacters = 12_000;
  for (const comment of comments.slice(-50).reverse()) {
    const text = stripHtml(comment.text).trim().slice(0, 2_000);
    if (text === "" || remainingCharacters <= 0) continue;
    const boundedText = text.slice(0, remainingCharacters);
    selected.push({ ...comment, text: boundedText });
    remainingCharacters -= boundedText.length;
  }
  return selected.reverse();
}

function loadRepositoryContext(repositoryId: string, worktreePath: string, baselineCommit: string): { appType: string; commands: string[]; instructions: string[] } {
  const cachePath = resolve(runtimeRoot(), "repo-cache", safePath(repositoryId), baselineCommit, "repository-context-v3.json");
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8")) as { appType: string; commands: string[]; instructions: string[] };

  const packagePath = resolve(worktreePath, "package.json");
  let appType = "unknown";
  const commands: string[] = [];
  if (existsSync(packagePath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
      appType = dependencies.vue ? "Vue / JavaScript portal" : dependencies.react ? "React / JavaScript application" : "Node.js application";
      commands.push(...verificationCommandsFromScripts(packageJson.scripts ?? {}));
    } catch { appType = "Node.js application"; }
  } else if (existsSync(resolve(worktreePath, "pom.xml"))) {
    appType = "Java / Maven application";
    commands.push("mvn test", "mvn verify");
  } else if (isSchemaScriptRepository(worktreePath)) {
    appType = "Snowflake SQL schema repository";
  }

  const instructions: string[] = [];
  for (const candidate of ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", "README.md"]) {
    const path = resolve(worktreePath, candidate);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8").slice(0, 6_000);
    instructions.push(`## ${candidate}\n${content}`);
  }
  const context = { appType, commands, instructions };
  mkdirSync(resolve(cachePath, ".."), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  return context;
}

export function verificationCommandsFromScripts(scripts: Record<string, string>): string[] {
  return ["build", "lint", "test", "typecheck"].flatMap((name) => {
    const script = scripts[name];
    // A verifier must observe the worktree, not repair it; auto-fix scripts corrupt both
    // the baseline comparison and the developer-approved file boundary.
    if (!script || /(?:^|\s)(?:--fix|--write)(?:=|\s|$)/.test(script) || /(?:^|\s)-w(?:\s|$)/.test(script)) return [];
    return [`npm run ${name}`];
  });
}

/**
 * Fast preflight intentionally stays filename-only. Deep preflight reads bounded source
 * snippets and follows direct local imports, which gives the planner both a likely owner
 * and its immediate consumers without turning packet creation into an unbounded code scan.
 */
export function selectLikelyFiles(worktreePath: string, storyText: string, mode: PlanningMode): Array<{ path: string; sha256: string }> {
  const keywords = storyKeywords(storyText);
  const schemaScriptFiles = selectSchemaScriptFiles(worktreePath, keywords);
  if (schemaScriptFiles) return hashLikelyFiles(worktreePath, schemaScriptFiles);
  const files = collectFiles(worktreePath, mode === "fast" ? 600 : mode === "deep" ? 1_800 : 2_400);
  if (mode === "fast") return hashLikelyFiles(worktreePath, selectFilenameMatches(files, keywords, 8));

  const sourceByPath = new Map(files.map((path) => [path, readSourceSnippet(resolve(worktreePath, path))]));
  const scored = files.map((path) => {
    const source = sourceByPath.get(path) ?? "";
    return {
      path,
      score: keywords.reduce((score, keyword) => score
        + (path.toLowerCase().includes(keyword) ? 2 : 0)
        + (source.toLowerCase().includes(keyword) ? 3 : 0), 0),
    };
  })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const seeds = selectFilenameMatches(scored.map(({ path }) => path), [], 12, scored);
  const related = localImportNeighbors(seeds, sourceByPath);
  const selected = [...new Set([...seeds, ...related, ...scored.map(({ path }) => path)])].slice(0, 20);
  return hashLikelyFiles(worktreePath, selected);
}

/**
 * Schema repositories are declarative: the nearest same-kind object and its deployment
 * manifest define the local edit convention, so a broad source traversal only adds noise.
 */
function selectSchemaScriptFiles(worktreePath: string, keywords: string[]): string[] | null {
  if (!isSchemaScriptRepository(worktreePath)) return null;
  const scriptPaths = schemaObjectPaths(worktreePath);
  if (scriptPaths.length === 0) return null;
  const schemaMatchedPaths = scriptPaths.filter((path) => keywords.includes(path.split("/", 1)[0]!.toLowerCase()));
  const selectedScript = selectSchemaObjectMatch(schemaMatchedPaths.length > 0 ? schemaMatchedPaths : scriptPaths, keywords);
  if (!selectedScript) return null;
  const manifests = directoryFiles(worktreePath, join("Scripts", "Manifests"), 600, (path) => path.endsWith(".txt"));
  const selectedManifest = manifests.find((manifest) => readSourceSnippet(resolve(worktreePath, manifest)).includes(`/${selectedScript}`));
  return selectedManifest ? [selectedScript, selectedManifest] : [selectedScript];
}

function selectSchemaObjectMatch(paths: string[], keywords: string[]): string | undefined {
  const objectKind = (path: string): string => path.split("/", 3)[1] ?? "";
  const explicitKinds: Record<string, string[]> = {
    TABLE: ["table", "stored", "storage", "persist", "persistence"],
    VIEW: ["view"],
    STAGE: ["stage", "staging"],
    TASK: ["task", "schedule", "scheduled"],
    PROCEDURE: ["procedure"],
    PIPE: ["pipe"],
    STREAM: ["stream"],
  };
  const scored = paths.map((path) => {
    const kind = objectKind(path);
    const keywordScore = keywords.reduce((score, keyword) => score + (path.toLowerCase().includes(keyword) ? 2 : 0), 0);
    const explicitKindScore = (explicitKinds[kind] ?? []).some((keyword) => keywords.includes(keyword)) ? 3 : 0;
    // Cost facts are persisted as database rows unless the story explicitly names a different object type.
    const persistenceDefault = kind === "TABLE" && keywords.includes("cost") && explicitKindScore === 0 ? 1 : 0;
    return { path, score: keywordScore + explicitKindScore + persistenceDefault };
  }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return scored[0]?.path;
}

function isSchemaScriptRepository(worktreePath: string): boolean {
  return existsSync(resolve(worktreePath, "Schemata")) && existsSync(resolve(worktreePath, "Scripts", "Manifests"));
}

function schemaObjectPaths(worktreePath: string): string[] {
  const objectKinds = ["TABLE", "VIEW", "STAGE", "TASK", "PROCEDURE", "PIPE", "STREAM"];
  let schemaDirectories: string[] = [];
  try {
    schemaDirectories = readdirSync(worktreePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !excludedDirectories.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }
  return schemaDirectories.flatMap((schema) => objectKinds.flatMap((kind) => directoryFiles(worktreePath, join(schema, kind), 160, (path) => path.endsWith(".sql"))));
}

function directoryFiles(worktreePath: string, directory: string, limit: number, include: (path: string) => boolean): string[] {
  const absolute = resolve(worktreePath, directory);
  try {
    return readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(directory, entry.name))
      .filter(include)
      .sort()
      .slice(0, limit);
  } catch { return []; }
}

function storyKeywords(storyText: string): string[] {
  return [...new Set(stripHtml(storyText).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((word) => word.length >= 4 && !["that", "with", "from", "this", "should", "report", "story"].includes(word)))].slice(0, 12);
}

function selectFilenameMatches(files: string[], keywords: string[], limit: number, preScored?: Array<{ path: string; score: number }>): string[] {
  const scored = preScored ?? files.map((path) => ({ path, score: keywords.reduce((score, keyword) => score + (path.toLowerCase().includes(keyword) ? 2 : 0), 0) }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const selected = scored.filter((file) => file.score > 0).slice(0, limit);
  return selected.length > 0 ? selected.map(({ path }) => path) : scored.slice(0, Math.min(5, limit)).map(({ path }) => path);
}

function hashLikelyFiles(worktreePath: string, paths: string[]): Array<{ path: string; sha256: string }> {
  return paths.map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(resolve(worktreePath, path))).digest("hex") }));
}

function readSourceSnippet(path: string): string {
  try {
    const descriptor = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(96_000);
      const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytes).toString("utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return "";
  }
}

function localImportNeighbors(seeds: string[], sourceByPath: Map<string, string>): string[] {
  const paths = new Set(sourceByPath.keys());
  const importsByPath = new Map([...sourceByPath].map(([path, source]) => [path, localImports(path, source, paths)]));
  const neighbors = new Set<string>();
  for (const seed of seeds) {
    for (const dependency of importsByPath.get(seed) ?? []) neighbors.add(dependency);
    for (const [candidate, dependencies] of importsByPath) {
      if (dependencies.includes(seed)) neighbors.add(candidate);
    }
  }
  for (const seed of seeds) neighbors.delete(seed);
  return [...neighbors].sort();
}

function localImports(importer: string, source: string, paths: Set<string>): string[] {
  const specifiers = [
    ...source.matchAll(/\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/\b(?:require|import)\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]).filter((specifier): specifier is string => specifier?.startsWith(".") ?? false);
  return [...new Set(specifiers.flatMap((specifier) => resolveLocalImport(importer, specifier, paths)))];
}

function resolveLocalImport(importer: string, specifier: string, paths: Set<string>): string[] {
  const base = normalize(join(dirname(importer), specifier));
  const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((extension) => `${base}${extension}`), ...["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs"].map((index) => join(base, index))];
  return candidates.filter((candidate) => paths.has(candidate)).slice(0, 1);
}

function collectFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (files.length >= limit) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= limit || excludedDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && statSync(path).size <= 500_000) files.push(relative(root, path));
    }
  };
  visit(root);
  return files;
}

function findTargetedPrecedents(worktreePath: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  // The history query is deterministic and bounded to ancestors of the selected
  // baseline plus the preflight-selected paths. The agent never searches history.
  const result = spawnSync("git", ["-C", worktreePath, "log", "--format=%h %s", "--max-count=8", "HEAD", "--", ...paths], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function buildExtremeHistoryDossier(worktreePath: string, baselineCommit: string, paths: string[], keywords: string[]): string {
  const commits = new Set<string>();
  const collect = (args: string[]): void => {
    const result = spawnSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" });
    if (result.status !== 0) return;
    for (const line of result.stdout.split("\n")) {
      const [commit] = line.split("\u001f");
      if (/^[0-9a-f]{40}$/i.test(commit ?? "")) commits.add(commit!);
      if (commits.size >= 8) return;
    }
  };
  if (paths.length > 0) collect(["log", "--format=%H%x1f%s", "--max-count=8", baselineCommit, "--", ...paths]);
  for (const keyword of keywords.slice(0, 4)) {
    if (commits.size >= 8) break;
    collect(["log", "--format=%H%x1f%s", "--max-count=3", "--fixed-strings", "-S", keyword, baselineCommit, "--", "."]);
  }
  if (commits.size === 0) return "No matching baseline-ancestor history was found.";
  const entries = [...commits].slice(0, 8).flatMap((commit) => {
    const header = spawnSync("git", ["-C", worktreePath, "show", "--no-ext-diff", "--format=%H%n%s", "--stat", "--no-renames", commit], { encoding: "utf8" });
    const diff = spawnSync("git", ["-C", worktreePath, "show", "--no-ext-diff", "--format=", "--unified=2", commit], { encoding: "utf8" });
    if (header.status !== 0 || diff.status !== 0) return [];
    const detail = `${header.stdout.trim()}\n\n${diff.stdout.trim()}`.trim();
    return detail === "" ? [] : [detail.slice(0, 3_000)];
  });
  return entries.join("\n\n---\n\n").slice(0, 16_000) || "No readable baseline-ancestor history was found.";
}

function gitValue(worktreePath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to create mission packet: ${(result.stderr || result.stdout || "Git command failed").trim()}`);
  return result.stdout.trim();
}

function stripHtml(value: string): string { return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(); }
function safePath(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_"); }
