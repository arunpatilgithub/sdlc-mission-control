import { spawnSync } from "node:child_process";

const CATALOG_CACHE_MS = 5 * 60_000;
const MODEL_ID = /^[A-Za-z0-9._-]+$/;

export interface PlanningModelOption {
  id: string;
  displayName: string;
  description: string;
  reasoningLevels: string[];
  retirementNotice: string | null;
}

interface CodexCatalogRun {
  stdout: string;
  status: number | null;
  error?: Error;
}

interface CachedCatalog {
  models: PlanningModelOption[];
  expiresAt: number;
}

/**
 * Reads only the signed-in Codex CLI's model metadata. The raw catalog also contains
 * internal model instructions, so callers receive a deliberately narrow projection.
 */
export class CodexModelCatalog {
  private cached: CachedCatalog | null = null;

  constructor(private readonly runner: () => CodexCatalogRun = runCodexModelCatalog) {}

  get(now = Date.now()): PlanningModelOption[] {
    if (this.cached && this.cached.expiresAt > now) return this.cached.models;
    const models = parseCodexModelCatalog(this.runner());
    this.cached = { models, expiresAt: now + CATALOG_CACHE_MS };
    return models;
  }
}

export function parseCodexModelCatalog(result: CodexCatalogRun): PlanningModelOption[] {
  if (result.error) throw new Error(`Unable to read the Codex model catalog: ${result.error.message}`);
  if (result.status !== 0) throw new Error("Unable to read the Codex model catalog");

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Codex returned an invalid model catalog");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) throw new Error("Codex returned an invalid model catalog");

  const models = parsed.models.flatMap((candidate) => {
    if (!isRecord(candidate) || candidate.visibility !== "list") return [];
    const id = stringField(candidate.slug, 120);
    const displayName = stringField(candidate.display_name, 160);
    if (!id || !MODEL_ID.test(id) || !displayName) return [];
    const upgrade = isRecord(candidate.upgrade) ? candidate.upgrade : null;
    return [{
      id,
      displayName,
      description: stringField(candidate.description, 500) ?? "",
      reasoningLevels: Array.isArray(candidate.supported_reasoning_levels)
        ? candidate.supported_reasoning_levels.flatMap((level) => isRecord(level) ? [stringField(level.effort, 40)].filter((value): value is string => value !== undefined) : [])
        : [],
      retirementNotice: upgrade ? stringField(upgrade.migration_markdown, 1_000) ?? null : null,
    }];
  });
  if (models.length === 0) throw new Error("Codex reported no selectable models for the signed-in account");
  return models;
}

function runCodexModelCatalog(): CodexCatalogRun {
  const result = spawnSync("codex", ["debug", "models"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: result.stdout ?? "", status: result.status, ...(result.error ? { error: result.error } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text.slice(0, maximum);
}
