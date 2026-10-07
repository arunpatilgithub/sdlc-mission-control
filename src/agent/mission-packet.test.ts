import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { boundedStoryComments, createMissionPacket, packetForRepository, selectLikelyFiles, verificationCommandsFromScripts, type MissionPacket } from "./mission-packet.js";

describe("boundedStoryComments", () => {
  it("keeps recent comments in chronological order and strips markup", () => {
    const comments = Array.from({ length: 52 }, (_, index) => ({
      id: index + 1,
      author: `Author ${index + 1}`,
      createdDate: `2026-09-15T12:${String(index).padStart(2, "0")}:00Z`,
      modifiedDate: null,
      text: `<p>Decision ${index + 1}</p>`,
    }));

    const bounded = boundedStoryComments(comments);

    expect(bounded).toHaveLength(50);
    expect(bounded[0]).toMatchObject({ id: 3, text: "Decision 3" });
    expect(bounded[49]).toMatchObject({ id: 52, text: "Decision 52" });
  });
});

describe("packetForRepository", () => {
  it("excludes planning-only vendor and fetched documentation from Develop packets", () => {
    const packet = {
      repository: { id: "Repo" },
      repositories: [{ id: "Repo" }],
      documentation: [{ wrappedText: "UNTRUSTED SENTINEL" }],
      vendorApiSpecs: [{ content: "VENDOR SENTINEL" }],
      relatedWorkItems: [{ title: "RELATED SENTINEL" }],
    } as unknown as MissionPacket;

    const developPacket = packetForRepository(packet, "Repo");

    expect(developPacket).not.toHaveProperty("documentation");
    expect(developPacket).not.toHaveProperty("vendorApiSpecs");
    expect(developPacket).not.toHaveProperty("relatedWorkItems");
    expect(JSON.stringify(developPacket)).not.toContain("SENTINEL");
  });
});

describe("verificationCommandsFromScripts", () => {
  it("keeps observational scripts and excludes commands that rewrite the worktree", () => {
    expect(verificationCommandsFromScripts({
      build: "vite build",
      lint: "eslint --ext .js,.vue --fix src",
      test: "vitest run",
      typecheck: "prettier -w src",
    })).toEqual(["npm run build", "npm run test"]);
  });

  it("does not mistake eslint fix-dry-run for the mutating fix flag", () => {
    expect(verificationCommandsFromScripts({ lint: "eslint --fix-dry-run src" })).toEqual(["npm run lint"]);
  });

  it("writes packet and versioned repository context under the configured runtime root", () => {
    const root = mkdtempSync(resolve(tmpdir(), "mission-packet-root-"));
    const repo = resolve(root, "repo");
    const runtime = resolve(root, "custom-runtime");
    const previous = process.env.MISSION_CONTROL_RUNTIME_ROOT;
    try {
      mkdirSync(repo);
      execFileSync("git", ["-C", repo, "init", "-b", "main"]);
      execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
      execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
      writeFileSync(resolve(repo, "package.json"), JSON.stringify({
        scripts: { build: "vite build", lint: "eslint --fix src" },
        dependencies: { vue: "3.0.0" },
      }));
      execFileSync("git", ["-C", repo, "add", "-A"]);
      execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
      const baseline = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      process.env.MISSION_CONTROL_RUNTIME_ROOT = runtime;

      createMissionPacket({
        missionId: "mission-root-test",
        story: {
          id: 42, backlogOrder: 1, title: "Add OpenAI conversion", state: "Active", workItemType: "User Story",
          assignedTo: null, areaPath: "Publisher", changedDate: null, tags: [], description: "Update it",
          acceptanceCriteria: "It works", iterationPath: "", attachments: [], linkedWorkItems: [],
          comments: [{ id: 1, author: "Reviewer", createdDate: "2026-09-15T12:00:00Z", modifiedDate: null, text: "<p>Use the clarified label.</p>" }],
          url: "",
        },
        repository: {
          id: "Repo", scm: "gitlab", localPath: repo,
          remoteUrl: "https://example.com/repo.git", integrationBranch: "main",
        },
        worktreePath: repo,
        branch: "main",
        knownRepositoryIds: ["Repo"],
        mode: "fast",
        historyPolicy: "none",
        repositoryStrategy: "existing",
        phase: "implementation-plan",
      });

      const packetPath = resolve(runtime, "missions", "mission-root-test", "packet-v5.json");
      expect(existsSync(packetPath)).toBe(true);
      const storedPacket = JSON.parse(readFileSync(packetPath, "utf8"));
      expect(storedPacket.story.comments).toEqual([
        { id: 1, author: "Reviewer", createdDate: "2026-09-15T12:00:00Z", modifiedDate: null, text: "Use the clarified label." },
      ]);
      expect(storedPacket.vendorApiSpecs.map((spec: { id: string }) => spec.id)).toEqual(["openai-ads"]);
      expect(existsSync(resolve(runtime, "repo-cache", "Repo", baseline, "repository-context-v3.json"))).toBe(true);
      expect(existsSync(resolve(runtime, "repo-cache", "Repo", baseline, "repository-context-v2.json"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.MISSION_CONTROL_RUNTIME_ROOT;
      else process.env.MISSION_CONTROL_RUNTIME_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("selectLikelyFiles", () => {
  it("uses Deep source matches and direct local imports without changing Fast filename matching", () => {
    const root = mkdtempSync(resolve(tmpdir(), "mission-packet-files-"));
    try {
      mkdirSync(resolve(root, "src"));
      mkdirSync(resolve(root, ".worktrees"));
      writeFileSync(resolve(root, "src", "handler.ts"), "import { registry } from './registry';\nexport const activate = () => registry.nimbusConversion;\n");
      writeFileSync(resolve(root, "src", "registry.ts"), "export const registry = { nimbusConversion: true };\n");
      writeFileSync(resolve(root, ".worktrees", "manual.ts"), "export const nimbusConversion = true;\n");
      for (let index = 0; index < 6; index += 1) writeFileSync(resolve(root, "src", `a${index}.ts`), "export const other = true;\n");

      const fast = selectLikelyFiles(root, "Activate Nimbus conversion", "fast").map((file) => file.path);
      const deep = selectLikelyFiles(root, "Activate Nimbus conversion", "deep").map((file) => file.path);

      expect(fast).not.toContain("src/handler.ts");
      expect(deep).toEqual(expect.arrayContaining(["src/handler.ts", "src/registry.ts"]));
      expect(deep).not.toContain(".worktrees/manual.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds schema-script repositories to the nearest matching object and its manifest", () => {
    const root = mkdtempSync(resolve(tmpdir(), "mission-packet-schema-"));
    try {
      mkdirSync(resolve(root, "Schemata"));
      mkdirSync(resolve(root, "MEDIA", "TABLE"), { recursive: true });
      mkdirSync(resolve(root, "MEDIA", "STAGE"), { recursive: true });
      mkdirSync(resolve(root, "CALLS_TAZ", "VIEW"), { recursive: true });
      mkdirSync(resolve(root, "Scripts", "Manifests"), { recursive: true });
      writeFileSync(resolve(root, "MEDIA", "TABLE", "TRAFFIC_FACEBOOK_AD_COST.sql"), "CREATE TABLE MEDIA.TRAFFIC_FACEBOOK_AD_COST ();\n");
      writeFileSync(resolve(root, "MEDIA", "TABLE", "TRAFFIC_GOOGLE_AD_COST.sql"), "CREATE TABLE MEDIA.TRAFFIC_GOOGLE_AD_COST ();\n");
      writeFileSync(resolve(root, "MEDIA", "STAGE", "TRAFFIC_GOOGLE_COST_STAGE.sql"), "CREATE STAGE MEDIA.TRAFFIC_GOOGLE_COST_STAGE;\n");
      writeFileSync(resolve(root, "CALLS_TAZ", "VIEW", "AFFILIATE_CALL_COSTS_V.sql"), "CREATE VIEW CALLS_TAZ.AFFILIATE_CALL_COSTS_V AS SELECT 1;\n");
      writeFileSync(resolve(root, "Scripts", "Manifests", "deployment_157105.txt"), "/MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql\n");
      writeFileSync(resolve(root, "Scripts", "Manifests", "deployment_999999.txt"), "/MEDIA/TABLE/TRAFFIC_GOOGLE_AD_COST.sql\n");

      const selected = selectLikelyFiles(root, "Add ChatGPT advertising cost reporting. All media costs belong in the MEDIA schema.", "deep").map((file) => file.path);

      expect(selected).toEqual([
        "MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql",
        "Scripts/Manifests/deployment_157105.txt",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes ADO markup before selecting a schema precedent", () => {
    const root = mkdtempSync(resolve(tmpdir(), "mission-packet-schema-markup-"));
    try {
      mkdirSync(resolve(root, "Schemata"));
      mkdirSync(resolve(root, "MEDIA", "TABLE"), { recursive: true });
      mkdirSync(resolve(root, "ADVERTISER", "TASK"), { recursive: true });
      mkdirSync(resolve(root, "Scripts", "Manifests"), { recursive: true });
      writeFileSync(resolve(root, "MEDIA", "TABLE", "TRAFFIC_FACEBOOK_AD_COST.sql"), "CREATE TABLE MEDIA.TRAFFIC_FACEBOOK_AD_COST ();\n");
      writeFileSync(resolve(root, "ADVERTISER", "TASK", "TASK_EXPORT_TRAINING_DATA.sql"), "CREATE TASK ADVERTISER.TASK_EXPORT_TRAINING_DATA;\n");
      writeFileSync(resolve(root, "Scripts", "Manifests", "deployment_157105.txt"), "/MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql\n");

      const selected = selectLikelyFiles(root, '<div style="font-family:Arial">Cost data is ingested on a scheduled basis.&nbsp;All media costs belong in the MEDIA schema.</div>', "fast").map((file) => file.path);

      expect(selected).toEqual([
        "MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql",
        "Scripts/Manifests/deployment_157105.txt",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects an existing schema object directly instead of treating a sibling as the target", () => {
    const root = mkdtempSync(resolve(tmpdir(), "mission-packet-schema-existing-"));
    try {
      mkdirSync(resolve(root, "Schemata"));
      mkdirSync(resolve(root, "MEDIA", "TABLE"), { recursive: true });
      mkdirSync(resolve(root, "Scripts", "Manifests"), { recursive: true });
      writeFileSync(resolve(root, "MEDIA", "TABLE", "TRAFFIC_CHATGPT_AD_COST.sql"), "CREATE TABLE MEDIA.TRAFFIC_CHATGPT_AD_COST ();\n");
      writeFileSync(resolve(root, "MEDIA", "TABLE", "TRAFFIC_FACEBOOK_AD_COST.sql"), "CREATE TABLE MEDIA.TRAFFIC_FACEBOOK_AD_COST ();\n");
      writeFileSync(resolve(root, "Scripts", "Manifests", "deployment_162941.txt"), "/MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql\n");

      const selected = selectLikelyFiles(root, "Modify ChatGPT advertising cost table", "fast").map((file) => file.path);

      expect(selected).toEqual([
        "MEDIA/TABLE/TRAFFIC_CHATGPT_AD_COST.sql",
        "Scripts/Manifests/deployment_162941.txt",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
