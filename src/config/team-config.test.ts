import { describe, expect, it } from "vitest";
import { azureDevOpsProjectFromRemote, getRepository, loadTeamConfig, resolveFeatureBranchName, validateTeamConfig } from "./team-config.js";

describe("azureDevOpsProjectFromRemote", () => {
  it("uses the repository remote's project for Azure DevOps publication", () => {
    expect(azureDevOpsProjectFromRemote("https://my-org@dev.azure.com/my-org/ITOps/_git/Database.Snowflake.DATA_LAKE"))
      .toBe("ITOps");
  });

  it("rejects a remote that cannot identify an Azure DevOps project", () => {
    expect(() => azureDevOpsProjectFromRemote("https://gitlab.com/my-company/apps/web-analytics/lt-analyticsbootstrap.git"))
      .toThrow(/does not identify a project/i);
  });
});

describe("resolveFeatureBranchName", () => {
  it("resolves the configured developer and work-item placeholders", () => {
    expect(resolveFeatureBranchName("feature/{developer}/PUB-{workItemId}", "arpatil", 162879))
      .toBe("feature/arpatil/PUB-162879");
  });

  it("rejects unresolved placeholders and unsafe git-ref characters", () => {
    expect(() => resolveFeatureBranchName("feature/{developer}/{unknown}-{workItemId}", "arpatil", 42)).toThrow(/invalid branch/i);
    expect(() => resolveFeatureBranchName("feature/{developer}/PUB-{workItemId}:bad", "arpatil", 42)).toThrow(/invalid branch/i);
  });
});

describe("repository verification policy", () => {
  it("runs the Snowflake AST validator after a changed table contract", () => {
    const repository = getRepository(loadTeamConfig(), "Database.Snowflake.DATA_LAKE");

    expect(repository.verification?.commands).toContainEqual({
      command: "python Scripts/Validation/validate_snowflake.py --changed-only --compare-branch origin/master --output-format azure",
      phases: ["post-change"],
      timeoutSeconds: 120,
    });
  });

  it("declares additive scope anchors for the conversion runtime and its per-vendor documentation mirror", () => {
    const config = loadTeamConfig();

    expect(getRepository(config, "MyService.Worker").scopeAnchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "registry", filePath: "src/PixelTypes.js" }),
      expect.objectContaining({ kind: "allowlist", filePath: "src/Handler.js" }),
    ]));
    expect(getRepository(config, "publisher.documentation").scopeAnchors).toEqual([
      expect.objectContaining({ kind: "documentation-pattern", filePath: "docs/external/Integration/Features/Pixels-and-Postbacks/Server-Side.md" }),
    ]);
  });
});

describe("version-bump policy", () => {
  it("exposes the configured version-bump policy for the team", () => {
    expect(loadTeamConfig().team.taskPlanning.versionBump).toEqual({ file: "version.json", field: "version" });
  });

  it("rejects a version-bump policy missing a required field", () => {
    const raw = JSON.parse(JSON.stringify(loadTeamConfig())) as Record<string, any>;
    raw.team.taskPlanning.versionBump = { file: "version.json" };
    expect(() => validateTeamConfig(raw)).toThrow();
  });
});
