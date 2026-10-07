import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type SkillStage = "planning" | "develop";

export interface Skill {
  instructions: string;
  /**
   * Additional Claude tool names this skill needs beyond the fixed read-only baseline.
   * Only consulted on the Claude read-only path — Codex has no tool identity to grant;
   * its enforcement is the OS sandbox regardless of what a skill declares.
   */
  extraReadTools: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Loads repository-specific guidance for a pipeline stage, falling back to that stage's
 * generic.md when no file is named for this repository. A repository id becomes a filename
 * by lowercasing it and collapsing every run of non letter/digit characters to a single
 * hyphen, so "Publisher.Portal" resolves to "publisher-portal.md" — no hardcoded
 * per-repository list to maintain as repositories are added.
 */
export function loadSkill(stage: SkillStage, repositoryId: string): Skill {
  const named = resolve(process.cwd(), "skills", stage, `${slugify(repositoryId)}.md`);
  const path = existsSync(named) ? named : resolve(process.cwd(), "skills", stage, "generic.md");
  return parseSkill(readFileSync(path, "utf8"));
}

/**
 * Parses a skill's optional frontmatter block, e.g.:
 * ---
 * tools: WebFetch, Grep
 * ---
 * Guidance text.
 *
 * Exported so callers with guidance text from elsewhere (e.g. a critic rubric file) get
 * the same convention without going through the filesystem lookup above.
 */
export function parseSkill(raw: string): Skill {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { instructions: raw.trim(), extraReadTools: [] };
  const toolsLine = /^tools:\s*(.+)$/m.exec(match[1]);
  const extraReadTools = toolsLine ? toolsLine[1].split(",").map((tool) => tool.trim()).filter(Boolean) : [];
  return { instructions: raw.slice(match[0].length).trim(), extraReadTools };
}

function slugify(repositoryId: string): string {
  return repositoryId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
