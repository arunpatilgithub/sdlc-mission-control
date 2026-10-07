import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const CREDENTIAL_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "openai-key", pattern: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: "bearer-token", pattern: /Bearer\s+[A-Za-z0-9._-]{16,}/i },
  { name: "private-key", pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/ },
  { name: "credential-assignment", pattern: /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*["'][^"']{12,}/i },
];

export function credentialLikeString(text: string): string | null {
  return CREDENTIAL_PATTERNS.find((candidate) => candidate.pattern.test(text))?.name ?? null;
}

export function recordedFixtureCredentials(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) return recordedFixtureCredentials(path);
    const kind = credentialLikeString(readFileSync(path, "utf8"));
    return kind ? [`${path}: ${kind}`] : [];
  });
}
