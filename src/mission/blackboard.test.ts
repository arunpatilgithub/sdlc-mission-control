import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listArtifacts, readArtifact, writeArtifact } from "./blackboard.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "mission-blackboard-"));
  process.env.MISSION_CONTROL_RUNTIME_ROOT = root;
});

afterEach(() => {
  delete process.env.MISSION_CONTROL_RUNTIME_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe("mission blackboard", () => {
  it("preserves every revision and reads the latest", () => {
    const first = writeArtifact("mission-42", "plan", { revision: 1 });
    const second = writeArtifact("mission-42", "plan", { revision: 2 });
    const third = writeArtifact("mission-42", "plan", { revision: 3 });

    expect(first).toBe(resolve(root, "missions", "mission-42", "plan.json"));
    expect(second).toBe(resolve(root, "missions", "mission-42", "plan-v2.json"));
    expect(third).toBe(resolve(root, "missions", "mission-42", "plan-v3.json"));
    expect([first, second, third].every((path) => existsSync(path))).toBe(true);
    expect(listArtifacts("mission-42")).toEqual(["plan-v2.json", "plan-v3.json", "plan.json"]);
    expect(readArtifact<{ revision: number }>("mission-42", "plan")).toEqual({ revision: 3 });
  });

  it("writes beneath the configured runtime root", () => {
    const path = writeArtifact("isolated-mission", "develop", { status: "complete" });

    expect(path).toBe(resolve(root, "missions", "isolated-mission", "develop.json"));
    expect(existsSync(resolve(root, "missions", "isolated-mission", "develop.json"))).toBe(true);
  });
});
