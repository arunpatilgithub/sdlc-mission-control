import type { RunUsage } from "../agent/usage.js";

export interface LedgerSummary {
  totalTokens: number;
  perStage: Array<{ stage: string; tokens: number; reported: boolean }>;
  /** Stages whose usage was null or had null token fields. Their true cost is unknown. */
  unreportedStages: string[];
  costUSD: number | null;
}

export interface LedgerLimits {
  /** Per-stage token cap, keyed by stage name. A stage with no entry is uncapped. */
  perStageTokens: Record<string, number>;
  missionCeilingTokens: number;
  /** Revisions permitted per stage before escalating to the developer. */
  maxRevisions: number;
  /** Human-answer revisions are bounded independently from automatic critic loops. */
  maxDeveloperPlanRevisions?: number;
}

export interface Affordability {
  affordable: boolean;
  /** Empty when affordable. Otherwise a single line naming the limit that would be breached. */
  reason: string;
}

interface StageUsage {
  stage: string;
  tokens: number;
  reported: boolean;
  costUSD: number | null;
}

export class MissionLedger {
  private readonly entries: StageUsage[] = [];
  private readonly revisions = new Map<string, number>();

  constructor(private readonly limits: LedgerLimits) {}

  record(stage: string, usage: RunUsage | null): void {
    this.entries.push({
      stage,
      tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
      reported: usage !== null && usage.inputTokens !== null && usage.outputTokens !== null,
      costUSD: usage?.costUSD ?? null,
    });
  }

  canAfford(stage: string): Affordability {
    const remaining = this.limits.missionCeilingTokens - this.totalTokens();
    const cap = this.limits.perStageTokens[stage];
    if (cap === undefined) {
      return remaining > 0
        ? { affordable: true, reason: "" }
        : { affordable: false, reason: `Mission token ceiling of ${this.limits.missionCeilingTokens} has been reached` };
    }
    return remaining >= cap
      ? { affordable: true, reason: "" }
      : { affordable: false, reason: `Stage '${stage}' requires ${cap} tokens but only ${Math.max(0, remaining)} remain` };
  }

  noteRevision(stage: string): void {
    this.revisions.set(stage, this.revisionCount(stage) + 1);
  }

  revisionCount(stage: string): number {
    return this.revisions.get(stage) ?? 0;
  }

  canRevise(stage: string): boolean {
    return this.revisionCount(stage) < this.limits.maxRevisions;
  }

  noteDeveloperPlanRevision(): void {
    this.noteRevision("developer-plan");
  }

  developerPlanRevisionCount(): number {
    return this.revisionCount("developer-plan");
  }

  canDeveloperRevisePlan(): boolean {
    return this.developerPlanRevisionCount() < (this.limits.maxDeveloperPlanRevisions ?? 5);
  }

  summary(): LedgerSummary {
    const reportedCosts = this.entries
      .map((entry) => entry.costUSD)
      .filter((cost): cost is number => cost !== null);
    return {
      totalTokens: this.totalTokens(),
      perStage: this.entries.map(({ stage, tokens, reported }) => ({ stage, tokens, reported })),
      unreportedStages: this.entries.filter((entry) => !entry.reported).map((entry) => entry.stage),
      costUSD: reportedCosts.length === 0 ? null : reportedCosts.reduce((total, cost) => total + cost, 0),
    };
  }

  private totalTokens(): number {
    return this.entries.reduce((total, entry) => total + entry.tokens, 0);
  }
}

export function resolveStageModel(stage: string, tiers: Record<string, string>, fallback: string): string {
  return Object.hasOwn(tiers, stage) ? tiers[stage] : fallback;
}
