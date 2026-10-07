import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMatchingVendorApiSpecs, validateVendorApiSpecs } from "./vendor-api-specs.js";

const body = (date: string) => `keywords: openai, chatgpt
last_verified: ${date}
# Contract
## Endpoint
x
## Authentication
x
## Required fields
x
## Optional fields
x
## Example request
x`;

describe("vendor API specs", () => {
  it("matches OpenAI aliases and attaches nothing for unknown vendors", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "vendor-spec-"));
    try {
      writeFileSync(resolve(directory, "openai-ads.md"), body("2026-09-15"));
      expect(loadMatchingVendorApiSpecs("Add ChatGPT conversion reporting", directory).map((spec) => spec.id)).toEqual(["openai-ads"]);
      expect(loadMatchingVendorApiSpecs("Rename a portal label", directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("warns non-fatally only when last_verified is over 180 days old", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "vendor-spec-age-"));
    try {
      writeFileSync(resolve(directory, "openai-ads.md"), body("2026-01-01"));
      expect(validateVendorApiSpecs(directory, new Date("2026-09-15T00:00:00Z")).warnings).toHaveLength(1);
      writeFileSync(resolve(directory, "openai-ads.md"), body("2026-09-01"));
      expect(validateVendorApiSpecs(directory, new Date("2026-09-15T00:00:00Z")).warnings).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
