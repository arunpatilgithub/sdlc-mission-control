import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CrossRepositoryContract } from "./planning-agent.js";

/**
 * Given a validated source-to-consumer contract, read the source artifact after its Develop
 * run and render it for the dependent repository's Develop prompt.
 *
 * This exists so a documentation/config repository writes examples grounded in what another
 * repository in this same mission actually ships, instead of a third-party vendor's published
 * API spec or the model's own general knowledge of the convention — the two are not always the
 * same, and only the former is true of this specific deployment.
 */
const MAX_WHOLE_FILE_LINES = 400;

export function buildCrossRepositoryContractContext(
  contracts: CrossRepositoryContract[],
  worktreePathByRepository: Record<string, string>,
): string {
  if (contracts.length === 0) return "";
  const sections = contracts.map((contract) => renderContract(contract, worktreePathByRepository[contract.sourceRepositoryId]));
  return [
    "",
    "## Cross-repository ground truth",
    "The following is the actual, current, already-implemented content this mission's plan identified as what you must mirror. Treat it as the sole source of truth for anything you write describing this behavior. Do not substitute a third-party vendor's published spec, an illustrative example, or your own general knowledge of the convention — only this exact shipped content.",
    ...sections,
  ].join("\n\n");
}

function renderContract(contract: CrossRepositoryContract, sourceWorktreePath: string | undefined): string {
  const label = `${contract.sourceRepositoryId}/${contract.sourcePath} → ${contract.consumerRepositoryId}/${contract.consumerPath}`;
  if (!sourceWorktreePath) {
    return `### ${label} (not yet available)\n${contract.reason}\n\nThe source repository has not completed its Develop stage in this mission run yet, so its real content cannot be shown here. Do not guess or reconstruct it from outside knowledge — if you need it, say so explicitly in your output instead of proceeding on an assumption.`;
  }
  const snippet = readContractSourceSnippet(sourceWorktreePath, contract.sourcePath);
  if (!snippet) {
    return `### ${label} (could not be resolved)\n${contract.reason}\n\nExpected to find this planned source artifact but could not. Do not guess its content — flag this discrepancy instead of writing an example based on assumption.`;
  }
  return `### ${label}\n${contract.reason}\nRequired shared literal: \`${contract.sharedLiteral}\`\n\n\`\`\`\n${snippet}\n\`\`\``;
}

function readContractSourceSnippet(worktreePath: string, sourcePath: string): string | null {
  const absolutePath = resolve(worktreePath, sourcePath);
  if (!existsSync(absolutePath)) return null;
  const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
  return lines.slice(0, MAX_WHOLE_FILE_LINES).join("\n");
}
