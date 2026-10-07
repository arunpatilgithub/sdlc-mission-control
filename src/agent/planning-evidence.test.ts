import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyScopeOutEvidence } from "./planning-evidence.js";

describe("verifyScopeOutEvidence", () => {
  it("verifies a no-change claim only when its cited current file was actually read", () => {
    const root = mkdtempSync(resolve(tmpdir(), "planning-evidence-"));
    try {
      mkdirSync(resolve(root, "src"));
      writeFileSync(resolve(root, "src/PixelTypes.js"), "module.exports = [];\n");
      const events = resolve(root, "events.jsonl");
      writeFileSync(events, `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: resolve(root, "src/PixelTypes.js") } }] },
      })}\n${JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "module.exports = [];" }] },
      })}\n`);

      expect(verifyScopeOutEvidence([], ["src/PixelTypes.js:1"], [events], root)).toEqual({
        status: "verified",
        evidence: ["src/PixelTypes.js:1"],
        unmatchedEvidence: [],
      });
      expect(verifyScopeOutEvidence([], ["src/PixelTypes.js:1-1", "src/PixelTypes.js:1:1"], [events], root).status).toBe("verified");
      expect(verifyScopeOutEvidence([], ["src/Other.js:4"], [events], root).status).toBe("unverified");
      expect(verifyScopeOutEvidence([], [], [events], root).status).toBe("unverified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("credits a Glob result so an enumerated (not individually read) sibling counts as inspected", () => {
    const root = mkdtempSync(resolve(tmpdir(), "planning-evidence-glob-"));
    try {
      mkdirSync(resolve(root, "MEDIA/TABLE"), { recursive: true });
      writeFileSync(resolve(root, "MEDIA/TABLE/TRAFFIC_GOOGLE_CAMPAIGN_COST.sql"), "CREATE TABLE MEDIA.TRAFFIC_GOOGLE_CAMPAIGN_COST (ID VARCHAR);\n");
      writeFileSync(resolve(root, "MEDIA/TABLE/TRAFFIC_GOOGLE_ADGROUP_COST.sql"), "CREATE TABLE MEDIA.TRAFFIC_GOOGLE_ADGROUP_COST (ID VARCHAR);\n");
      const events = resolve(root, "events.jsonl");
      writeFileSync(events, `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "glob-1", name: "Glob", input: { pattern: "MEDIA/TABLE/*.sql" } }] },
      })}\n${JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "glob-1", content: "MEDIA/TABLE/TRAFFIC_GOOGLE_CAMPAIGN_COST.sql\nMEDIA/TABLE/TRAFFIC_GOOGLE_ADGROUP_COST.sql" }] },
      })}\n`);

      expect(verifyScopeOutEvidence([], ["MEDIA/TABLE/TRAFFIC_GOOGLE_CAMPAIGN_COST.sql:1", "MEDIA/TABLE/TRAFFIC_GOOGLE_ADGROUP_COST.sql:1"], [events], root).status).toBe("verified");
      // A file that never appeared in any tool result stays unmatched.
      expect(verifyScopeOutEvidence([], ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql:1"], [events], root).status).toBe("unverified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not require scope-out evidence when changes are planned", () => {
    expect(verifyScopeOutEvidence(["src/change.ts"], [], [], "/unused")).toEqual({
      status: "not-applicable",
      evidence: [],
      unmatchedEvidence: [],
    });
  });

  it("does not let provenance for an unrelated file prove a configured registry has no additive work", () => {
    const root = mkdtempSync(resolve(tmpdir(), "planning-evidence-"));
    try {
      mkdirSync(resolve(root, "src"));
      writeFileSync(resolve(root, "src/Handler.js"), "function dispatch() {}\n");
      writeFileSync(resolve(root, "src/PixelTypes.js"), "module.exports = [];\n");
      const events = resolve(root, "events.jsonl");
      writeFileSync(events, `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: resolve(root, "src/Handler.js") } }] },
      })}\n${JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "function dispatch() {}" }] },
      })}\n`);

      expect(verifyScopeOutEvidence([], ["src/Handler.js:1"], [events], root, [{
        kind: "registry",
        filePath: "src/PixelTypes.js",
        marker: "module.exports = [",
        description: "Registered pixel types.",
      }])).toEqual({
        status: "unverified",
        evidence: ["src/Handler.js:1"],
        unmatchedEvidence: ["src/PixelTypes.js"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
