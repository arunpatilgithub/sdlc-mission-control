import { describe, expect, it } from "vitest";
import { createScoutInputs, scoutInputFingerprint, type ScoutInputSource } from "./scout-inputs.js";

const base: ScoutInputSource = {
  repositoryId: "Database.Snowflake.DATA_LAKE",
  baselineCommit: "abc123",
  storyId: "162941",
  storyText: "Add ChatGPT ad cost table",
  focusFiles: ["MEDIA/TABLE/TRAFFIC_FACEBOOK_AD_COST.sql", "azure-pipelines.yml"],
  planningSkill: "snowflake",
  testHarnessSignature: "validate_snowflake.py",
  sharedContracts: [
    { concept: "cost table", literalKind: "table name", canonicalLiteral: "TRAFFIC_OPENAI_AD_COST" },
    { concept: "vendor", literalKind: "column value", canonicalLiteral: "CHATGPT", affectedRepositoryIds: ["Database.Snowflake.DATA_LAKE"] },
  ],
};

describe("scoutInputFingerprint", () => {
  it("is stable for equivalent focus files and repository-local contracts regardless of order", () => {
    const original = scoutInputFingerprint(createScoutInputs(base));
    const reordered = scoutInputFingerprint(createScoutInputs({
      ...base,
      focusFiles: [...base.focusFiles].reverse(),
      sharedContracts: [...base.sharedContracts].reverse(),
    }));

    expect(reordered).toBe(original);
  });

  it("changes when any scout input that can alter the reading changes", () => {
    const fingerprint = scoutInputFingerprint(createScoutInputs(base));
    const variants: ScoutInputSource[] = [
      { ...base, repositoryId: "MoneyBadgerDownloader" },
      { ...base, baselineCommit: "def456" },
      { ...base, storyId: "162942" },
      { ...base, storyText: "Different story" },
      { ...base, focusFiles: ["only-one.sql"] },
      { ...base, planningSkill: "other" },
      { ...base, testHarnessSignature: "jest" },
      { ...base, sharedContracts: [{ concept: "cost table", literalKind: "table name", canonicalLiteral: "TRAFFIC_CHATGPT_AD_COST" }] },
      { ...base, sharedContracts: [{ concept: "cost table", literalKind: "table name", canonicalLiteral: "TRAFFIC_OPENAI_AD_COST", canonicalLiterals: ["TRAFFIC_OPENAI_AD_COST", "TRAFFIC_OPENAI_ADGROUP_COST"] }] },
    ];

    for (const variant of variants) expect(scoutInputFingerprint(createScoutInputs(variant))).not.toBe(fingerprint);
  });

  it("does not change when a shared contract belongs only to another repository", () => {
    const original = scoutInputFingerprint(createScoutInputs(base));
    const withOtherRepositoryContract = scoutInputFingerprint(createScoutInputs({
      ...base,
      sharedContracts: [...base.sharedContracts, { concept: "other", literalKind: "table name", canonicalLiteral: "TRAFFIC_OTHER", affectedRepositoryIds: ["OtherRepository"] }],
    }));

    expect(withOtherRepositoryContract).toBe(original);
  });
});
