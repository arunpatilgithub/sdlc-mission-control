import { readFileSync } from "node:fs";
import { AzureDevOpsCli } from "./src/ado/azure-devops-cli.js";
import { getRepository, loadTeamConfig } from "./src/config/team-config.js";
import { runDevelopMission } from "./src/agent/develop-agent.js";

const strip = (h?: string) => (h || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const config = loadTeamConfig();
const story = await new AzureDevOpsCli(config.team.azureDevOps).getTeamBacklogItem(157105);

// Reuse the richest existing plan for this story (Opus, recommended extending this repo).
const plan = readFileSync("runtime/planning-runs/ade20195-ca41-4362-a0b1-1b047b36e565.result.txt", "utf8");

const run = await runDevelopMission({
  storyId: story.id,
  storyTitle: story.title,
  storyDescription: strip(story.description),
  acceptanceCriteria: strip(story.acceptanceCriteria),
  repository: getRepository(config, "google-cost-downloader"),
  plan,
  referenceFiles: ["src/PlatformManager.js", "src/workers/GoogleWorker.js", "integrations/unit/googleWorker.test.js", "integrations/unit/manualRun.test.js"],
  verifyCommands: ["npm run lint", "npm test"],
  linkFromBase: ["node_modules"],
});

console.log("\n================ DEVELOP RUN ================");
console.log("status   :", run.status, run.error ? `(${run.error})` : "");
console.log("branch   :", run.branch, "off", run.baseBranch, `@ ${run.baselineCommit.slice(0, 8)}`);
console.log("worktree :", run.worktreePath);
console.log("commit   :", run.commit?.slice(0, 12) ?? "(none)");
console.log("files    :", run.filesChanged.join(", ") || "(none)");
console.log("diffstat :\n" + (run.diffStat ?? ""));
for (const v of run.baseline) console.log(`baseline : ${v.passed ? "PASS" : "FAIL"}  ${v.command}  (exit ${v.exitCode})`);
for (const v of run.verification) console.log(`after    : ${v.passed ? "PASS" : "FAIL"}  ${v.command}  (exit ${v.exitCode})`);
console.log("regress  :", run.regressions.length ? run.regressions.join(", ") : "none");
console.log("usage    :", run.usage ? `${run.usage.inputTokens} in / ${run.usage.outputTokens} out, ${Math.round(run.usage.durationMs/1000)}s, ${run.usage.commandCount} cmds` : "(none)");
