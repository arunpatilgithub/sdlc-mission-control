import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCrossRepositoryContractContext } from "./mirror-artifact-context.js";
import type { CrossRepositoryContract } from "./planning-agent.js";

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function fixture(): string {
  root = mkdtempSync(resolve(tmpdir(), "mirror-artifact-"));
  mkdirSync(resolve(root, "src/components/Campaigns/Detail"), { recursive: true });
  writeFileSync(
    resolve(root, "src/components/Campaigns/Detail/Pixels.js"),
    [
      "const pixelTypes = {",
      "    FacebookConversion: {",
      "        payloadTemplate: 'unrelated',",
      "    },",
      "    ChatGPTConversion: {",
      "        order: 22,",
      "        payloadTemplate: `{",
      '    "timestamp_ms": {event_time_ms}',
      "}`,",
      "        urlTemplate: 'https://bzr.openai.com/v1/events?pid={PIXEL_ID}'",
      "    },",
      "    NextType: {",
      "        payloadTemplate: 'next',",
      "    },",
      "};",
    ].join("\n"),
  );
  return root;
}

const contract: CrossRepositoryContract = {
  concept: "conversion payload",
  literalKind: "event payload",
  sourceRepositoryId: "Publisher.Portal",
  sourcePath: "src/components/Campaigns/Detail/Pixels.js",
  sharedLiteral: "ChatGPTConversion",
  consumerRepositoryId: "publisher.documentation",
  consumerPath: "docs/Server-Side.md",
  reason: "The documented example payload must match what Portal actually ships",
};

describe("buildCrossRepositoryContractContext", () => {
  it("returns an empty string when there are no contracts", () => {
    expect(buildCrossRepositoryContractContext([], {})).toBe("");
  });

  it("says the dependency is not yet available when its worktree is unknown", () => {
    const context = buildCrossRepositoryContractContext([contract], {});
    expect(context).toMatch(/not yet available/);
    expect(context).toMatch(/Publisher\.Portal/);
    expect(context).not.toMatch(/timestamp_ms/);
  });

  it("says the source artifact could not be resolved when it is absent", () => {
    const path = fixture();
    const missing: CrossRepositoryContract = { ...contract, sourcePath: "src/missing.js" };
    const context = buildCrossRepositoryContractContext([missing], { "Publisher.Portal": path });
    expect(context).toMatch(/could not be resolved/);
  });

  it("renders the source-owned artifact and exact shared literal", () => {
    const path = fixture();
    const context = buildCrossRepositoryContractContext([contract], { "Publisher.Portal": path });
    expect(context).toMatch(/timestamp_ms/);
    expect(context).toMatch(/event_time_ms/);
    expect(context).toMatch(/ChatGPTConversion/);
    expect(context).toMatch(/sole source of truth/);
  });
});
