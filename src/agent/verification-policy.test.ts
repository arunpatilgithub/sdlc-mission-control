import { describe, expect, it } from "vitest";
import type { RepositoryConfig } from "../config/team-config.js";
import { resolveVerificationPolicy } from "./verification-policy.js";

const repository = (): RepositoryConfig => ({
  id: "PostbackHandler", scm: "azure-devops", localPath: "/repo", remoteUrl: "https://example.com/repo", integrationBranch: "main",
  verification: {
    excludeDetectedCommands: ["npm run test"],
    manualOnlyCommands: [{ command: "npm run test", reason: "waits for a debugger" }],
    commands: [{ command: "npm run build:verify", phases: ["baseline", "post-change"], timeoutSeconds: 120 }],
  },
});

describe("resolveVerificationPolicy", () => {
  it("does not run a repository-declared manual command while retaining a stable unattended check", () => {
    expect(resolveVerificationPolicy(repository(), ["npm run test", "npm run lint"])).toEqual([
      { command: "npm run lint", phases: ["baseline", "post-change"], source: "repository" },
      { command: "npm run build:verify", phases: ["baseline", "post-change"], timeoutSeconds: 120, source: "repository" },
    ]);
  });

  it("runs a developer-approved story-specific check only after implementation", () => {
    expect(resolveVerificationPolicy(repository(), [], [{ command: "npm run test:openai", timeoutSeconds: 90 }])).toContainEqual({
      command: "npm run test:openai", phases: ["post-change"], timeoutSeconds: 90, source: "mission",
    });
  });
});
