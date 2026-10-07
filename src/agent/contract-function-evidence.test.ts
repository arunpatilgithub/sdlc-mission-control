import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readContractFunctionSnippet, verifyContractFunctionEvidence } from "./contract-function-evidence.js";

const GET_PUBLISHER_PIXELS = { filePath: "src/Handler.js", functionName: "getPublisherPixels" };

function writeHandlerFixture(root: string): void {
  mkdirSync(resolve(root, "src"), { recursive: true });
  const lines: string[] = [];
  lines.push("        event.publisherPixels = this.getPublisherPixels(msg, event);"); // line 1: a call site, not the definition
  for (let i = 0; i < 729; i += 1) lines.push(`// filler line ${i}`);
  lines.push("    getPublisherPixels(msg, event) {"); // line 731
  lines.push("        const types = event.pixelTypes.map(a => a.type);");
  lines.push("        return event.adminDocumentCache.pixels;");
  lines.push("    }");
  for (let i = 0; i < 100; i += 1) lines.push(`// trailing filler line ${i}`);
  writeFileSync(resolve(root, "src/Handler.js"), lines.join("\n"));
}

describe("verifyContractFunctionEvidence", () => {
  it("is not-applicable when the repository has no configured contract functions", () => {
    expect(verifyContractFunctionEvidence([], ["src/x.js"], ["src/x.js:1"], "/unused")).toEqual({
      status: "not-applicable",
      matchedRequirement: null,
      functionRange: null,
      matchedEvidence: [],
    });
  });

  it("is not-applicable when no changes are planned for the repository", () => {
    expect(verifyContractFunctionEvidence([GET_PUBLISHER_PIXELS], [], ["src/Handler.js:735"], "/unused").status)
      .toBe("not-applicable");
  });

  it("checks configured route evidence before accepting a no-change conclusion when requested", () => {
    const root = mkdtempSync(resolve(tmpdir(), "contract-function-evidence-"));
    try {
      writeHandlerFixture(root);
      expect(verifyContractFunctionEvidence(
        [GET_PUBLISHER_PIXELS], [], ["src/Handler.js:141"], root, { requireEvidenceWithoutChanges: true },
      ).status).toBe("unverified");
      expect(verifyContractFunctionEvidence(
        [GET_PUBLISHER_PIXELS], [], ["src/Handler.js:735"], root, { requireEvidenceWithoutChanges: true },
      ).status).toBe("verified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags inclusion as unverified when cited evidence never touches any configured contract function", () => {
    const root = mkdtempSync(resolve(tmpdir(), "contract-function-evidence-"));
    try {
      writeHandlerFixture(root);
      const verification = verifyContractFunctionEvidence(
        [GET_PUBLISHER_PIXELS],
        ["src/Handler.js"],
        ["src/Handler.js:141", "src/Handler.js:334"],
        root,
      );
      expect(verification.status).toBe("unverified");
      expect(verification.matchedEvidence).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies inclusion when cited evidence falls within a configured contract function's range", () => {
    const root = mkdtempSync(resolve(tmpdir(), "contract-function-evidence-"));
    try {
      writeHandlerFixture(root);
      const verification = verifyContractFunctionEvidence(
        [GET_PUBLISHER_PIXELS],
        ["src/Handler.js"],
        ["src/Handler.js:735-759"],
        root,
      );
      expect(verification.status).toBe("verified");
      expect(verification.matchedEvidence).toEqual(["src/Handler.js:735-759"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the method definition, not an earlier call site referencing the same name", () => {
    const root = mkdtempSync(resolve(tmpdir(), "contract-function-evidence-"));
    try {
      writeHandlerFixture(root);
      const verification = verifyContractFunctionEvidence(
        [GET_PUBLISHER_PIXELS],
        ["src/Handler.js"],
        ["src/Handler.js:1"], // the call site's own line — must NOT count as the definition
        root,
      );
      expect(verification.functionRange).toEqual([731, 811]);
      expect(verification.status).toBe("unverified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is not-applicable when none of the configured functions can be found in the worktree", () => {
    const root = mkdtempSync(resolve(tmpdir(), "contract-function-evidence-"));
    try {
      const verification = verifyContractFunctionEvidence(
        [GET_PUBLISHER_PIXELS],
        ["src/Handler.js"],
        ["src/Handler.js:842"],
        root,
      );
      expect(verification.status).toBe("not-applicable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks each configured requirement independently and verifies on any match", () => {
    const root = mkdtempSync(resolve(tmpdir(), "contract-function-evidence-"));
    try {
      writeHandlerFixture(root);
      const verification = verifyContractFunctionEvidence(
        [{ filePath: "src/DoesNotExist.js", functionName: "irrelevant" }, GET_PUBLISHER_PIXELS],
        ["src/Handler.js"],
        ["src/Handler.js:740"],
        root,
      );
      expect(verification.status).toBe("verified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readContractFunctionSnippet", () => {
  it("returns null when the file or function cannot be found", () => {
    const root = mkdtempSync(resolve(tmpdir(), "contract-function-evidence-"));
    try {
      expect(readContractFunctionSnippet(root, GET_PUBLISHER_PIXELS)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts exactly the function body, trimmed at the next sibling method, not a fixed line window", () => {
    const root = mkdtempSync(resolve(tmpdir(), "contract-function-evidence-"));
    try {
      mkdirSync(resolve(root, "src"), { recursive: true });
      const lines = [
        "class Handler {",
        "    getPublisherPixels(msg, event) {",
        "        return event.adminDocumentCache.pixels;",
        "    }",
        "    createSHA256Hash(str) {",
        "        return hash(str);",
        "    }",
        "}",
      ];
      writeFileSync(resolve(root, "src/Handler.js"), lines.join("\n"));
      const snippet = readContractFunctionSnippet(root, GET_PUBLISHER_PIXELS);
      expect(snippet?.range).toEqual([2, 4]);
      expect(snippet?.text).toBe([
        "    getPublisherPixels(msg, event) {",
        "        return event.adminDocumentCache.pixels;",
        "    }",
      ].join("\n"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
