import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv/dist/2020.js";

const nodeRequire = createRequire(import.meta.url);
const Ajv2020 = (nodeRequire("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js")).default;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultPath = resolve(projectRoot, "config/allowed-fetch-domains.json");
const schemaPath = resolve(projectRoot, "config/allowed-fetch-domains.schema.json");
let validator: ValidateFunction | null = null;

export function loadAllowedFetchDomains(path = defaultPath): string[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  validator ??= new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  if (!validator(raw)) throw new Error(`Allowed fetch domains failed schema validation: ${validator.errors?.map((error) => error.message).join("; ")}`);
  return (raw as { hostnames: string[] }).hostnames;
}
