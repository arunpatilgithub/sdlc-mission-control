import { AzureDevOpsCli, AzureDevOpsCliError } from "./ado/azure-devops-cli.js";
import { DEFAULT_TEAM_CONFIG_PATH, TeamConfigError, loadTeamConfig } from "./config/team-config.js";
import { validateVendorApiSpecs } from "./config/vendor-api-specs.js";
import { loadAllowedFetchDomains } from "./config/allowed-fetch-domains.js";

function printUsage(): void {
  console.log("Usage:");
  console.log("  sdlc-mission-control config validate [path]");
  console.log("  sdlc-mission-control ado check");
  console.log("  sdlc-mission-control ado backlog [limit]");
  console.log("  sdlc-mission-control ado item <id>");
}

function adoClient(): AzureDevOpsCli {
  return new AzureDevOpsCli(loadTeamConfig().team.azureDevOps);
}

async function runAdo(action: string | undefined, argument: string | undefined): Promise<void> {
  const client = adoClient();
  if (action === "check") {
    const areaPaths = await client.checkConnection();
    console.log("Azure DevOps connection is valid.");
    console.log(`Publisher area paths: ${areaPaths.map((area) => `${area.value}${area.includeChildren ? " (including children)" : ""}`).join(", ")}`);
    return;
  }
  if (action === "backlog" || action === "stories") {
    const limit = argument === undefined ? 1_000 : Number(argument);
    const stories = await client.listTeamBacklogItems(limit);
    console.log(JSON.stringify(stories, null, 2));
    return;
  }
  if (action === "item" || action === "story") {
    const story = await client.getTeamBacklogItem(Number(argument));
    console.log(JSON.stringify(story, null, 2));
    return;
  }
  printUsage();
  process.exitCode = 1;
}

function validateConfig(configPath?: string): void {
  const config = loadTeamConfig(configPath);
  console.log("Configuration is valid.");
  console.log(`Team: ${config.team.azureDevOps.organizationUrl} / ${config.team.azureDevOps.project} / ${config.team.azureDevOps.team}`);
  console.log(`Eligible states: ${config.team.azureDevOps.eligibleStates.join(", ")}`);
  console.log(`Repositories: ${config.repositories.length}`);
  console.log(`Config: ${configPath ?? DEFAULT_TEAM_CONFIG_PATH}`);
  console.log(`Allowed documentation hosts: ${loadAllowedFetchDomains().length}`);
  for (const warning of validateVendorApiSpecs().warnings) console.warn(`Warning: ${warning}`);
}

const [command, action, argument] = process.argv.slice(2);

try {
  if (command === "config" && action === "validate") {
    validateConfig(argument);
  } else if (command === "ado") {
    await runAdo(action, argument);
  } else {
    printUsage();
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof TeamConfigError || error instanceof AzureDevOpsCliError || error instanceof Error ? error.message : String(error);
  console.error(`Mission Control failed: ${message}`);
  process.exitCode = 1;
}
