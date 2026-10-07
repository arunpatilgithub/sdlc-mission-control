import type { RepositoryConfig, VerificationPhase } from "../config/team-config.js";
import type { VerificationCommand } from "./develop-agent.js";

export interface MissionVerificationCommand {
  command: string;
  timeoutSeconds?: number;
}

/** Combines stable repository checks with post-change checks explicitly approved in this mission's plan. */
export function resolveVerificationPolicy(
  repository: RepositoryConfig,
  detectedCommands: string[],
  missionCommands: MissionVerificationCommand[] = [],
): VerificationCommand[] {
  const excluded = new Set([
    ...(repository.verification?.excludeDetectedCommands ?? []),
    ...(repository.verification?.manualOnlyCommands ?? []).map((entry) => entry.command),
  ]);
  const commands: VerificationCommand[] = [
    ...detectedCommands.filter((command) => !excluded.has(command)).map((command) => ({
      command,
      phases: ["baseline", "post-change"] as VerificationPhase[],
      source: "repository" as const,
    })),
    ...(repository.verification?.commands ?? []).map((entry) => ({ ...entry, source: "repository" as const })),
    ...missionCommands.map((entry) => ({
      command: entry.command,
      phases: ["post-change"] as VerificationPhase[],
      timeoutSeconds: entry.timeoutSeconds,
      source: "mission" as const,
    })),
  ];
  const seen = new Set<string>();
  return commands.filter((entry) => {
    const key = `${entry.command}\u0000${entry.phases.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
