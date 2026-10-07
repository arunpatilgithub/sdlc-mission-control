import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkNoRegressions, checkNoSecrets, checkScope, checkTodoMarkers, checkVersionBump, isScopeExpansionAllowed, isVersionIncrement, runGates } from "./gates.js";

let runtimeRoot: string;
const temporaryRoots: string[] = [];
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

beforeAll(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), "mission-gates-runtime-"));
  process.env.MISSION_CONTROL_RUNTIME_ROOT = runtimeRoot;
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.MISSION_CONTROL_RUNTIME_ROOT;
  rmSync(runtimeRoot, { recursive: true, force: true });
});

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "mission-gates-repo-"));
  temporaryRoots.push(root);
  const repoPath = resolve(root, "repo");
  mkdirSync(repoPath);
  g(repoPath, "init", "-b", "main");
  g(repoPath, "config", "user.email", "t@t.t");
  g(repoPath, "config", "user.name", "t");
  return repoPath;
}

function greenGateInput(): Parameters<typeof runGates>[0] {
  const repoPath = createRepository();
  mkdirSync(resolve(repoPath, "src"));
  const file = resolve(repoPath, "src", "feature.js");
  writeFileSync(file, "export const feature = true;\n");
  g(repoPath, "add", "src/feature.js");
  g(repoPath, "commit", "-m", "base");
  writeFileSync(file, [
    "export const feature = true;",
    "// The vendor field name was confirmed before implementation.",
    "",
  ].join("\n"));
  const baseline = [{ command: "npm test", exitCode: 0, passed: true, output: "" }];
  return {
    worktreePath: repoPath,
    filesChanged: ["src/feature.js"],
    plannedPaths: ["src/feature.js"],
    baseline,
    verification: structuredClone(baseline),
    storyId: 4242,
  };
}

describe("deterministic mission gates", () => {
  it("catches files outside the scope recorded for the Google Ads run", () => {
    const run1Files = [
      "EADME.md", "integrations/googleAds.test.js", "integrations/unit/campaigns.test.js",
      "integrations/unit/concurrency.test.js", "integrations/unit/config.test.js",
      "integrations/unit/configurationService.test.js", "integrations/unit/handler.test.js",
      "integrations/unit/insertOnly.test.js", "integrations/unit/manualRun.test.js",
      "src/PlatformManager.js", "src/configLoader.js", "src/models/google/queries.js",
      "src/workers/GoogleWorker.js", "eslint.config.js", "src/workers/FacebookWorker.js",
    ];
    const run1Planned = ["src/models/google/", "src/workers/GoogleWorker.js", "src/configLoader.js", "src/PlatformManager.js"];

    const result = checkScope(run1Files, run1Planned);

    expect(result.status).toBe("failed");
    expect(result.offenders).toContain("eslint.config.js");
    expect(result.offenders).toContain("src/workers/FacebookWorker.js");
  });

  it("does not implicitly authorize a test file omitted from the approved scope", () => {
    const result = checkScope(
      ["src/feature.ts", "src/feature.test.ts"],
      ["src/feature.ts"],
    );

    expect(result.status).toBe("failed");
    expect(result.offenders).toEqual(["src/feature.test.ts"]);
  });

  it("allows an explicitly approved source expansion but never a permanent safety exclusion", () => {
    expect(checkScope(["src/helper.ts"], ["src/helper.ts"]).status).toBe("passed");
    expect(checkScope(["README.md"], ["README.md"])).toMatchObject({
      status: "failed",
      offenders: ["README.md"],
    });
  });

  it("allows an explicitly approved package manifest but never implicitly expands to one", () => {
    expect(checkScope(["package.json"], ["package.json"]).status).toBe("passed");
    expect(checkScope(["package.json"], ["src/feature.ts"])).toMatchObject({
      status: "failed",
      offenders: ["package.json"],
    });
    expect(isScopeExpansionAllowed("package.json")).toBe(false);
  });

  it("ignores pre-existing failures but catches a genuine regression", () => {
    const baseline = [
      { command: "npm run lint", exitCode: 1, passed: false, output: "" },
      { command: "npm test", exitCode: 0, passed: true, output: "" },
    ];
    const verification = structuredClone(baseline);

    const unchanged = checkNoRegressions(baseline, verification);
    expect(unchanged.status).toBe("passed");
    expect(unchanged.offenders).toEqual([]);

    verification[1] = { command: "npm test", exitCode: 1, passed: false, output: "" };
    const regressed = checkNoRegressions(baseline, verification);
    expect(regressed.status).toBe("failed");
    expect(regressed.offenders).toEqual(["npm test"]);
  });

  it("reports missing verification commands as not verified", () => {
    const result = checkNoRegressions([], []);

    expect(result.status).toBe("not-verified");
    expect(result.detail).toMatch(/no verification commands.*configured/i);
    expect(result.offenders).toEqual([]);
  });

  it("flags a newly added credential without blaming committed content or environment access", () => {
    const repoPath = createRepository();
    const file = resolve(repoPath, "secrets.js");
    writeFileSync(file, 'const password = "hunter2000";\n');
    g(repoPath, "add", "secrets.js");
    g(repoPath, "commit", "-m", "base");
    writeFileSync(file, [
      'const password = "hunter2000";',
      'const apiKey = "sk-live-9f3b2a7c41";',
      "const key = process.env.API_KEY;",
      "",
    ].join("\n"));

    const result = checkNoSecrets(repoPath, ["secrets.js"]);

    expect(result.status).toBe("failed");
    expect(result.offenders).toEqual(["secrets.js:2 (assigned-credential)"]);
    expect(result.offenders.some((offender) => offender.startsWith("secrets.js:1"))).toBe(false);
    expect(result.offenders.some((offender) => offender.startsWith("secrets.js:3"))).toBe(false);
  });

  it("rejects every added TODO and FIXME marker, including a mission-scoped marker", () => {
    const repoPath = createRepository();
    writeFileSync(resolve(repoPath, "work.js"), [
      "// TODO(mission-4242): confirm field name with the vendor",
      "// TODO: fix later",
      "// FIXME",
      "",
    ].join("\n"));

    const result = checkTodoMarkers(repoPath, ["work.js"]);

    expect(result.status).toBe("failed");
    expect(result.offenders).toEqual(["work.js:1", "work.js:2", "work.js:3"]);
  });

  it("reports all five gates in order when they are green", () => {
    const report = runGates(greenGateInput());

    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(5);
    expect(report.results.map((result) => result.id)).toEqual([
      "scope", "no-regressions", "no-secrets", "todo-markers", "version-bump",
    ]);
  });

  it("passes the aggregate when regressions are not verified and no gate failed", () => {
    const input = greenGateInput();
    input.baseline = [];
    input.verification = [];

    const report = runGates(input);

    expect(report.results.find((result) => result.id === "no-regressions")?.status).toBe("not-verified");
    expect(report.results.filter((result) => result.id !== "no-regressions" && result.id !== "version-bump").every((result) => result.status === "passed")).toBe(true);
    expect(report.passed).toBe(true);
  });

  it("reports every gate when scope fails", () => {
    const input = greenGateInput();
    writeFileSync(resolve(input.worktreePath, "README.md"), "# Out of scope\n");
    input.filesChanged.push("README.md");

    const report = runGates(input);

    expect(report.passed).toBe(false);
    expect(report.results).toHaveLength(5);
    expect(report.results.find((result) => result.id === "scope")?.status).toBe("failed");
    expect(report.results.filter((result) => result.id !== "scope" && result.id !== "version-bump").every((result) => result.status === "passed")).toBe(true);
  });
});

describe("version-bump gate", () => {
  const policy = { file: "version.json", field: "version" };

  function versionRepo(baselineVersion = "0.0.1"): { repoPath: string; baselineCommit: string } {
    const repoPath = createRepository();
    mkdirSync(resolve(repoPath, "src"));
    writeFileSync(resolve(repoPath, "src", "feature.js"), "export const feature = 1;\n");
    writeFileSync(resolve(repoPath, "version.json"), `${JSON.stringify({ name: "svc", version: baselineVersion }, null, 2)}\n`);
    g(repoPath, "add", "-A");
    g(repoPath, "commit", "-m", "base");
    return { repoPath, baselineCommit: g(repoPath, "rev-parse", "HEAD") };
  }

  function bumpInput(repoPath: string, baselineCommit: string, filesChanged: string[]): Parameters<typeof checkVersionBump>[0] {
    return {
      worktreePath: repoPath,
      filesChanged,
      plannedPaths: ["src/feature.js", "version.json"],
      baseline: [],
      verification: [],
      storyId: 1,
      baselineCommit,
      versionBumpPolicy: policy,
    };
  }

  it("is not-verified when no policy is configured", () => {
    const { repoPath, baselineCommit } = versionRepo();
    const input = bumpInput(repoPath, baselineCommit, ["src/feature.js"]);
    input.versionBumpPolicy = undefined;
    expect(checkVersionBump(input).status).toBe("not-verified");
  });

  it("is not-verified when the repository has no version file", () => {
    const repoPath = createRepository();
    writeFileSync(resolve(repoPath, "app.js"), "export const a = 1;\n");
    g(repoPath, "add", "-A");
    g(repoPath, "commit", "-m", "base");
    const result = checkVersionBump(bumpInput(repoPath, g(repoPath, "rev-parse", "HEAD"), ["app.js"]));
    expect(result.status).toBe("not-verified");
    expect(result.detail).toMatch(/no version\.json/i);
  });

  it("is not-verified when only the version file itself changed", () => {
    const { repoPath, baselineCommit } = versionRepo();
    writeFileSync(resolve(repoPath, "version.json"), `${JSON.stringify({ name: "svc", version: "0.0.2" }, null, 2)}\n`);
    expect(checkVersionBump(bumpInput(repoPath, baselineCommit, ["version.json"])).status).toBe("not-verified");
  });

  it("fails when other code changed but the version was not incremented", () => {
    const { repoPath, baselineCommit } = versionRepo("0.0.1");
    writeFileSync(resolve(repoPath, "src", "feature.js"), "export const feature = 2;\n");
    const result = checkVersionBump(bumpInput(repoPath, baselineCommit, ["src/feature.js"]));
    expect(result.status).toBe("failed");
    expect(result.offenders).toEqual(["version.json"]);
  });

  it("fails when the version was decremented", () => {
    const { repoPath, baselineCommit } = versionRepo("0.0.5");
    writeFileSync(resolve(repoPath, "src", "feature.js"), "export const feature = 2;\n");
    writeFileSync(resolve(repoPath, "version.json"), `${JSON.stringify({ name: "svc", version: "0.0.4" }, null, 2)}\n`);
    expect(checkVersionBump(bumpInput(repoPath, baselineCommit, ["src/feature.js", "version.json"])).status).toBe("failed");
  });

  it("passes when the version is incremented alongside a code change", () => {
    const { repoPath, baselineCommit } = versionRepo("0.0.376");
    writeFileSync(resolve(repoPath, "src", "feature.js"), "export const feature = 2;\n");
    writeFileSync(resolve(repoPath, "version.json"), `${JSON.stringify({ name: "svc", version: "0.0.377" }, null, 2)}\n`);
    const result = checkVersionBump(bumpInput(repoPath, baselineCommit, ["src/feature.js", "version.json"]));
    expect(result.status).toBe("passed");
  });

  it("treats a newly added version file as a valid bump", () => {
    const repoPath = createRepository();
    writeFileSync(resolve(repoPath, "src.js"), "export const a = 1;\n");
    g(repoPath, "add", "-A");
    g(repoPath, "commit", "-m", "base");
    const baselineCommit = g(repoPath, "rev-parse", "HEAD");
    writeFileSync(resolve(repoPath, "version.json"), `${JSON.stringify({ version: "0.0.1" }, null, 2)}\n`);
    writeFileSync(resolve(repoPath, "src.js"), "export const a = 2;\n");
    expect(checkVersionBump(bumpInput(repoPath, baselineCommit, ["src.js", "version.json"])).status).toBe("passed");
  });
});

describe("isVersionIncrement", () => {
  it("requires a strictly greater dotted-numeric version", () => {
    expect(isVersionIncrement("0.0.376", "0.0.377")).toBe(true);
    expect(isVersionIncrement("0.1.65", "0.2.0")).toBe(true);
    expect(isVersionIncrement("0.0.5", "0.0.4")).toBe(false);
    expect(isVersionIncrement("1.2.3", "1.2.3")).toBe(false);
  });

  it("treats any change as a bump for non-numeric versions", () => {
    expect(isVersionIncrement("2024-01-01", "2024-02-01")).toBe(true);
    expect(isVersionIncrement("alpha", "alpha")).toBe(false);
  });
});
