import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export interface VendorApiSpec {
  id: string;
  keywords: string[];
  lastVerified: string;
  content: string;
}

export interface VendorSpecValidation {
  specs: VendorApiSpec[];
  warnings: string[];
}

export function loadMatchingVendorApiSpecs(storyText: string, directory = defaultDirectory()): VendorApiSpec[] {
  const normalizedStory = normalize(storyText);
  return validateVendorApiSpecs(directory).specs.filter((spec) =>
    spec.keywords.some((keyword) => normalizedStory.includes(normalize(keyword))),
  );
}

export function validateVendorApiSpecs(directory = defaultDirectory(), now = new Date()): VendorSpecValidation {
  if (!existsSync(directory)) return { specs: [], warnings: [] };
  const specs = readdirSync(directory).filter((name) => name.endsWith(".md")).sort().map((name) =>
    parseVendorApiSpec(name.slice(0, -3), readFileSync(resolve(directory, name), "utf8")),
  );
  const staleBefore = new Date(now);
  staleBefore.setUTCDate(staleBefore.getUTCDate() - 180);
  const warnings = specs.flatMap((spec) =>
    new Date(`${spec.lastVerified}T00:00:00Z`) < staleBefore
      ? [`Vendor API spec ${spec.id}.md was last verified on ${spec.lastVerified}, more than 180 days ago.`]
      : [],
  );
  return { specs, warnings };
}

export function parseVendorApiSpec(id: string, content: string): VendorApiSpec {
  const keywords = /^keywords:\s*(.+)$/m.exec(content)?.[1]?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const lastVerified = /^last_verified:\s*(\d{4}-\d{2}-\d{2})$/m.exec(content)?.[1];
  if (!keywords?.length || !lastVerified || Number.isNaN(Date.parse(`${lastVerified}T00:00:00Z`))) {
    throw new Error(`Vendor API spec ${id}.md requires valid keywords and last_verified metadata`);
  }
  for (const heading of ["Endpoint", "Authentication", "Required fields", "Optional fields", "Example request"]) {
    if (!content.includes(`## ${heading}`)) throw new Error(`Vendor API spec ${id}.md is missing ## ${heading}`);
  }
  return { id, keywords: [...new Set([id, ...keywords])], lastVerified, content: content.trim().slice(0, 32_000) };
}

function defaultDirectory(): string {
  return resolve(process.cwd(), "config", "vendor-api-specs");
}

function normalize(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}
