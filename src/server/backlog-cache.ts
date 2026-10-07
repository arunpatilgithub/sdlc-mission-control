import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AzureDevOpsCli } from "../ado/azure-devops-cli.js";
import { loadTeamConfig } from "../config/team-config.js";

const cachePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../runtime/backlog.json");
const config = loadTeamConfig();
const stories = await new AzureDevOpsCli(config.team.azureDevOps).listTeamBacklogItems();

await mkdir(dirname(cachePath), { recursive: true });
await writeFile(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), stories }), "utf8");
console.log(`Fetched ${stories.length} Publisher backlog items for the local dashboard.`);
