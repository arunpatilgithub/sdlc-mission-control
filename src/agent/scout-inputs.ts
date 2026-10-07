import { createHash } from "node:crypto";
import type { SharedContract } from "./mission-packet.js";

export interface ScoutInputs {
  repositoryId: string;
  baselineCommit: string;
  storyId: string;
  storyText: string;
  focusFiles: string[];
  planningSkill: string;
  testHarnessSignature: string;
  sharedContracts: string;
}

export interface ScoutInputSource extends Omit<ScoutInputs, "sharedContracts"> {
  sharedContracts: SharedContract[];
}

export function createScoutInputs(source: ScoutInputSource): ScoutInputs {
  return {
    ...source,
    focusFiles: [...source.focusFiles],
    sharedContracts: JSON.stringify(source.sharedContracts
      .filter((contract) => !contract.affectedRepositoryIds?.length || contract.affectedRepositoryIds.includes(source.repositoryId))
      .map((contract) => ({ concept: contract.concept, literalKind: contract.literalKind, canonicalLiteral: contract.canonicalLiteral, canonicalLiterals: [...(contract.canonicalLiterals ?? [])].sort() }))
      .sort((left, right) => `${left.concept}\u0000${left.canonicalLiteral}`.localeCompare(`${right.concept}\u0000${right.canonicalLiteral}`))),
  };
}

export function scoutInputFingerprint(inputs: ScoutInputs): string {
  const canonical = JSON.stringify({
    repositoryId: inputs.repositoryId,
    baselineCommit: inputs.baselineCommit,
    storyId: inputs.storyId,
    storyText: inputs.storyText,
    focusFiles: [...inputs.focusFiles].sort(),
    planningSkill: inputs.planningSkill,
    testHarnessSignature: inputs.testHarnessSignature,
    sharedContracts: inputs.sharedContracts,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
