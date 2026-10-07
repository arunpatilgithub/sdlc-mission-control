import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";

// ajv and ajv-formats are CJS; their ESM type declarations don't resolve cleanly
// under NodeNext's default-export interop, so load them via createRequire and
// keep only the type imports above going through the normal ESM path.
const nodeRequire = createRequire(import.meta.url);
const Ajv2020 = (nodeRequire("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js")).default;
const addFormats = (nodeRequire("ajv-formats") as typeof import("ajv-formats")).default;

export type ScmType = "azure-devops" | "gitlab";

/** A function whose current behavior decides whether this repository is genuinely in scope for a story (e.g. a dispatch/selection function), as opposed to any other line in the file. Team-specific knowledge belongs here, in the team's own config, not hardcoded into shared planning code. */
export interface ContractFunctionRequirement {
  filePath: string;
  functionName: string;
}

/** A non-function extension point whose current shape decides whether a repository owns an additive change. */
export interface ScopeAnchorRequirement {
  kind: "registry" | "allowlist" | "documentation-pattern";
  filePath: string;
  marker: string;
  description: string;
}

export type VerificationPhase = "baseline" | "post-change";

export interface RepositoryVerificationCommand {
  command: string;
  phases: VerificationPhase[];
  timeoutSeconds?: number;
}

export interface ManualVerificationCommand {
  command: string;
  reason: string;
}

/** Stable, human-maintained verification policy. Story-created test commands belong in the approved plan instead. */
export interface RepositoryVerificationConfig {
  commands?: RepositoryVerificationCommand[];
  excludeDetectedCommands?: string[];
  manualOnlyCommands?: ManualVerificationCommand[];
}

export interface RepositoryConfig {
  id: string;
  scm: ScmType;
  /** Resolved absolute path — always absolute in memory, regardless of how it was stored on disk. */
  localPath: string;
  remoteUrl: string;
  integrationBranch: string;
  /** Optional. See ContractFunctionRequirement. Empty/absent for repositories with no known such pattern. */
  contractFunctions?: ContractFunctionRequirement[];
  /** Optional. Team-configured additive extension points that cannot be represented as a function. */
  scopeAnchors?: ScopeAnchorRequirement[];
  verification?: RepositoryVerificationConfig;
}

/** Team-wide policy: repositories that contain `file` must have `field` incremented whenever the Develop stage changes other code. Presence-detected per repository; repositories without the file are unaffected. */
export interface VersionBumpPolicy {
  file: string;
  field: string;
}

export interface AzureDevOpsScope {
  organizationUrl: string;
  project: string;
  team: string;
  workItemTypes: string[];
  eligibleStates: string[];
  includeAttachments: boolean;
  includeLinkedWorkItems: boolean;
  userStoryCompletion: "never";
}

export interface TeamConfig {
  schemaVersion: 1;
  team: {
    id: string;
    azureDevOps: AzureDevOpsScope;
    taskPlanning: {
      developerApprovalRequired: true;
      autoStartMissionAfterApproval: false;
      developerAlias: string;
      featureBranchPattern: string;
      /** Optional, defaults to false. When every selected repository comes back changes-required, spawn a second model to holistically review the whole plan and auto-revise on a needs-revision/off-track verdict. Off by default: it's the heaviest and most expensive of the automatic review passes. */
      scopeMinimalityReviewEnabled?: boolean;
      /** Optional. When set, any repository containing `versionBump.file` must have `versionBump.field` incremented alongside other code changes during Develop. Absent = feature off. */
      versionBump?: VersionBumpPolicy;
    };
  };
  repositories: RepositoryConfig[];
}

/** Shape as stored on disk: identical to TeamConfig except localPath may be relative. */
type RawTeamConfig = Omit<TeamConfig, "repositories"> & {
  repositories: Array<Omit<RepositoryConfig, "localPath"> & { localPath: string }>;
};

export class TeamConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamConfigError";
  }
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_TEAM_CONFIG_PATH = resolve(projectRoot, "config/team-config.json");
const SCHEMA_PATH = resolve(projectRoot, "config/team-config.schema.json");

let validator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (!validator) {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validator = ajv.compile(schema);
  }
  return validator;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unknown validation error";
  return errors.map((error) => `${error.instancePath || "(root)"} ${error.message}`).join("; ");
}

export function loadTeamConfig(configPath = DEFAULT_TEAM_CONFIG_PATH): TeamConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TeamConfigError(`Unable to load team configuration at ${configPath}: ${detail}`);
  }
  return validateTeamConfig(raw, configPath);
}

/**
 * The JSON Schema (config/team-config.schema.json) is the single source of truth for
 * shape, enums, and formats. What's left here are relational/cross-field invariants a
 * standalone schema can't express: duplicate detection across array items and
 * HTTPS-only URLs.
 */
export function validateTeamConfig(raw: unknown, source = "team configuration"): TeamConfig {
  const validate = getValidator();
  if (!validate(raw)) {
    throw new TeamConfigError(`${source} failed schema validation: ${formatErrors(validate.errors)}`);
  }

  const config = raw as RawTeamConfig;
  assertHttps(config.team.azureDevOps.organizationUrl, `${source}.team.azureDevOps.organizationUrl`);

  const ids = new Set<string>();
  const remotes = new Set<string>();
  const paths = new Set<string>();
  const repositories: RepositoryConfig[] = config.repositories.map((repo, index) => {
    const entryName = `${source}.repositories[${index}]`;
    assert(!ids.has(repo.id), `${entryName} duplicates repository id: ${repo.id}`);
    ids.add(repo.id);

    assertHttps(repo.remoteUrl, `${entryName}.remoteUrl`);
    if (repo.scm === "azure-devops") azureDevOpsProjectFromRemote(repo.remoteUrl);
    const normalizedRemote = normalizeRemoteUrl(repo.remoteUrl);
    assert(!remotes.has(normalizedRemote), `${entryName} duplicates remote URL: ${repo.remoteUrl}`);
    remotes.add(normalizedRemote);

    assert(isAbsolute(repo.localPath), `${entryName}.localPath must be an absolute path`);
    const localPath = resolve(repo.localPath);
    assert(!paths.has(localPath), `${entryName} duplicates local path: ${localPath}`);
    paths.add(localPath);

    return { ...repo, localPath };
  });

  assert(config.team.azureDevOps.workItemTypes.includes("User Story"), `${source} must include the User Story work-item type`);

  return { ...config, repositories };
}

export function getRepository(config: TeamConfig, repositoryId: string): RepositoryConfig {
  const repository = config.repositories.find((candidate) => candidate.id === repositoryId);
  if (!repository) throw new TeamConfigError(`Repository is not in the configured allow-list: ${repositoryId}`);
  return repository;
}

export function azureDevOpsProjectFromRemote(remoteUrl: string): string {
  const segments = new URL(remoteUrl).pathname.split("/").filter(Boolean);
  const gitSegment = segments.findIndex((segment) => segment === "_git");
  if (gitSegment < 1) throw new TeamConfigError(`Azure DevOps remote URL does not identify a project: ${remoteUrl}`);
  return decodeURIComponent(segments[gitSegment - 1]!);
}

export function resolveFeatureBranchName(pattern: string, developer: string, workItemId: number): string {
  const branch = pattern
    .replaceAll("{developer}", developer)
    .replaceAll("{workItemId}", String(workItemId));
  if (branch.includes("{") || branch.includes("}") || !/^feature\/[A-Za-z0-9._/-]+$/.test(branch)
    || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".")) {
    throw new TeamConfigError(`Feature branch pattern resolved to an invalid branch name: ${branch}`);
  }
  return branch;
}

export function assertApprovedRepository(
  config: TeamConfig,
  repositoryId: string,
  localPath: string,
  remoteUrl: string,
): RepositoryConfig {
  const repository = getRepository(config, repositoryId);
  assert(resolve(localPath) === repository.localPath, `Repository path is not approved for ${repositoryId}`);
  assert(normalizeRemoteUrl(remoteUrl) === normalizeRemoteUrl(repository.remoteUrl), `Repository remote is not approved for ${repositoryId}`);
  return repository;
}

function assertHttps(candidate: string, name: string): void {
  assert(new URL(candidate).protocol === "https:", `${name} must use HTTPS`);
}

function normalizeRemoteUrl(remoteUrl: string): string {
  return remoteUrl.replace(/\/$/, "").replace(/\.git$/, "").toLowerCase();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TeamConfigError(message);
}
