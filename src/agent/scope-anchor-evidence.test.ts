import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readScopeAnchorSnippet, verifyScopeAnchorEvidence } from "./scope-anchor-evidence.js";

const REGISTRY = {
  kind: "registry" as const,
  filePath: "src/PixelTypes.js",
  marker: "module.exports = [",
  description: "Registered event pixel types.",
};

const DOCUMENTATION = {
  kind: "documentation-pattern" as const,
  filePath: "docs/Server-Side.md",
  marker: "## Platform API Integrations",
  description: "Per-vendor API examples.",
};

describe("scope-anchor evidence", () => {
  it("requires a no-change conclusion to cite the configured registry rather than unrelated dispatch evidence", () => {
    const root = mkdtempSync(resolve(tmpdir(), "scope-anchor-evidence-"));
    try {
      mkdirSync(resolve(root, "src"), { recursive: true });
      writeFileSync(resolve(root, "src/PixelTypes.js"), "module.exports = [\n  { type: 'FacebookConversion' }\n];\n");
      writeFileSync(resolve(root, "src/Handler.js"), "function dispatch() {}\n");

      expect(verifyScopeAnchorEvidence([REGISTRY], ["src/Handler.js:1"], root)).toMatchObject({
        status: "unverified",
        unresolvedRequirements: [REGISTRY],
      });
      expect(verifyScopeAnchorEvidence([REGISTRY], ["src/PixelTypes.js:1"], root)).toMatchObject({
        status: "verified",
        matchedEvidence: ["src/PixelTypes.js:1"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes a bounded per-vendor documentation pattern as an extension anchor", () => {
    const root = mkdtempSync(resolve(tmpdir(), "scope-anchor-evidence-"));
    try {
      mkdirSync(resolve(root, "docs"), { recursive: true });
      writeFileSync(resolve(root, "docs/Server-Side.md"), [
        "# Server side",
        "## Platform API Integrations",
        "### Facebook Conversion API",
        "Example setup",
      ].join("\n"));

      expect(readScopeAnchorSnippet(root, DOCUMENTATION)).toMatchObject({
        range: [1, 4],
        text: expect.stringContaining("Facebook Conversion API"),
      });
      expect(verifyScopeAnchorEvidence([DOCUMENTATION], ["docs/Server-Side.md:2"], root).status).toBe("verified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
