import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function writeArtifact(missionId: string, name: string, artifact: unknown): string {
  const directory = missionDirectory(missionId);
  assertPathSegment(name, "artifact name");
  mkdirSync(directory, { recursive: true });
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  for (let version = 1; ; version += 1) {
    const path = resolve(directory, version === 1 ? `${name}.json` : `${name}-v${version}.json`);
    try {
      writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }
  }
}

export function readArtifact<T>(missionId: string, name: string): T | null {
  const directory = missionDirectory(missionId);
  assertPathSegment(name, "artifact name");
  if (!existsSync(directory)) return null;
  const escapedName = escapeRegExp(name);
  const versionPattern = new RegExp(`^${escapedName}(?:-v(\\d+))?\\.json$`);
  const versions = readdirSync(directory)
    .map((file) => ({ file, match: versionPattern.exec(file) }))
    .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ file, match }) => ({ file, version: match[1] ? Number(match[1]) : 1 }))
    .sort((left, right) => right.version - left.version);
  if (versions.length === 0) return null;
  return JSON.parse(readFileSync(resolve(directory, versions[0].file), "utf8")) as T;
}

export function listArtifacts(missionId: string): string[] {
  const directory = missionDirectory(missionId);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith(".json")).sort();
}

function runtimeRoot(): string {
  const configured = process.env.MISSION_CONTROL_RUNTIME_ROOT;
  return configured && configured.trim() !== "" ? resolve(configured) : resolve(process.cwd(), "runtime");
}

function missionDirectory(missionId: string): string {
  assertPathSegment(missionId, "mission id");
  return resolve(runtimeRoot(), "missions", missionId);
}

function assertPathSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
