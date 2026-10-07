import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyBehavioralReviewJudgments, scanBehavioralClaims } from "./planning-behavior.js";

function readEvent(filePath: string): string {
  return [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: filePath } }] },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "current logic" }] },
    }),
  ].join("\n");
}

describe("scanBehavioralClaims", () => {
  it("accepts an audit-backed adjacent citation and flags the same claim without one", () => {
    const root = mkdtempSync(resolve(tmpdir(), "behavioral-claim-"));
    try {
      mkdirSync(resolve(root, "src"));
      writeFileSync(resolve(root, "src/config.ts"), "export const mode = 'safe';\n");
      const events = resolve(root, "events.jsonl");
      writeFileSync(events, readEvent(resolve(root, "src/config.ts")));

      expect(scanBehavioralClaims(["The service defaults to safe (src/config.ts:1)."], [events], root)[0]?.status).toBe("verified");
      expect(scanBehavioralClaims(["The service defaults to safe."], [events], root)[0]).toMatchObject({
        status: "unverified",
        explanation: "Behavioral claim has no adjacent file:line citation.",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a targeted critic read to refute the restrictedPixels coordination claim", () => {
    const root = mkdtempSync(resolve(tmpdir(), "restricted-pixels-"));
    try {
      const relativePath = "Campaigns/Detail/Pixels.js";
      mkdirSync(resolve(root, "Campaigns/Detail"), { recursive: true });
      writeFileSync(resolve(root, relativePath), `${Array.from({ length: 315 }, () => "// fixture").join("\n")}\nconst allowed = !restrictedPixels.includes(pixelType);\n`);
      const initial = scanBehavioralClaims(
        ["No backend coordination needed because restrictedPixels already handles the new type."],
        [],
        root,
      );
      const criticEvents = resolve(root, "critic.events.jsonl");
      writeFileSync(criticEvents, readEvent(resolve(root, relativePath)));

      const reviewed = applyBehavioralReviewJudgments(initial, [{
        stepIndex: 0,
        disposition: "refuted",
        evidence: [`${relativePath}:316`],
        explanation: "The current logic is default-allow for types absent from restrictedPixels.",
      }], [criticEvents], root);

      expect(reviewed[0]).toMatchObject({
        status: "refuted",
        explanation: expect.stringContaining("default-allow"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies a confirmed judgment whose sibling evidence was enumerated via Glob, not individually read", () => {
    const root = mkdtempSync(resolve(tmpdir(), "behavioral-glob-"));
    try {
      mkdirSync(resolve(root, "MEDIA/TABLE"), { recursive: true });
      writeFileSync(resolve(root, "MEDIA/TABLE/SIBLING.sql"), "CREATE TABLE MEDIA.SIBLING (ID VARCHAR);\n");
      const criticEvents = resolve(root, "critic.events.jsonl");
      writeFileSync(criticEvents, [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "glob-1", name: "Glob", input: { pattern: "MEDIA/TABLE/*.sql" } }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "glob-1", content: "MEDIA/TABLE/SIBLING.sql" }] } }),
      ].join("\n"));
      const initial = [{ stepIndex: 0, step: "Repository inclusion", phrase: "story applicability", citations: [], status: "unverified" as const, explanation: null }];

      const reviewed = applyBehavioralReviewJudgments(initial, [{
        stepIndex: 0,
        disposition: "confirmed",
        evidence: ["MEDIA/TABLE/SIBLING.sql:1"],
        explanation: "The parallel sibling table exists; this repository owns the extension point.",
      }], [criticEvents], root);

      // Previously this confirmation was discarded because the sibling was globbed (not read),
      // leaving an unmatched citation. Crediting Glob results lets the confirmation stand.
      expect(reviewed[0]).toMatchObject({ status: "confirmed", explanation: expect.stringContaining("extension point") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
