import { describe, expect, it } from "vitest";
import { CodexModelCatalog, parseCodexModelCatalog } from "./model-catalog.js";

const catalog = JSON.stringify({
  models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      description: "Reliable coding model",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
    },
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Retiring model",
      visibility: "list",
      supported_reasoning_levels: [],
      upgrade: { migration_markdown: "Switch to GPT-5.6 Sol." },
    },
    {
      slug: "hidden-model",
      display_name: "Hidden model",
      visibility: "hidden",
    },
    {
      slug: "bad id with spaces",
      display_name: "Unsafe",
      visibility: "list",
    },
  ],
});

describe("parseCodexModelCatalog", () => {
  it("returns only selectable, safe model metadata", () => {
    expect(parseCodexModelCatalog({ stdout: catalog, status: 0 })).toEqual([
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Reliable coding model",
        reasoningLevels: ["medium", "high"],
        retirementNotice: null,
      },
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Retiring model",
        reasoningLevels: [],
        retirementNotice: "Switch to GPT-5.6 Sol.",
      },
    ]);
  });

  it("rejects malformed or unavailable catalogs", () => {
    expect(() => parseCodexModelCatalog({ stdout: "not json", status: 0 })).toThrow(/invalid model catalog/);
    expect(() => parseCodexModelCatalog({ stdout: catalog, status: 1 })).toThrow(/Unable to read/);
  });
});

describe("CodexModelCatalog", () => {
  it("caches the discovered catalog for five minutes", () => {
    let calls = 0;
    const catalogStore = new CodexModelCatalog(() => {
      calls += 1;
      return { stdout: catalog, status: 0 };
    });

    expect(catalogStore.get(1_000)).toHaveLength(2);
    expect(catalogStore.get(1_001)).toHaveLength(2);
    expect(calls).toBe(1);
    expect(catalogStore.get(301_001)).toHaveLength(2);
    expect(calls).toBe(2);
  });
});
