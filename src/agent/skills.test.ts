import { describe, expect, it } from "vitest";
import { loadSkill, parseSkill } from "./skills.js";

describe("loadSkill", () => {
  it("finds a repository-specific planning skill by slugifying the repository id", () => {
    const skill = loadSkill("planning", "Publisher.Portal");
    expect(skill.instructions).toContain("Publisher.Portal planning guidance");
    expect(skill.instructions).toContain("legacy JavaScript/Vue portal");
  });

  it("falls back to generic.md when no file is named for this repository", () => {
    const skill = loadSkill("planning", "Some.Other.Repo");
    expect(skill.instructions).toContain("Generic planning guidance");
  });

  it("falls back per stage — a develop skill for Publisher.Portal has no repo-specific file yet", () => {
    const skill = loadSkill("develop", "Publisher.Portal");
    expect(skill.instructions).toContain("Generic development guidance");
  });
});

describe("parseSkill", () => {
  it("returns the raw text as instructions with no extra tools when there is no frontmatter", () => {
    const skill = parseSkill("# Some guidance\n\n- Do the thing.\n");
    expect(skill.instructions).toBe("# Some guidance\n\n- Do the thing.");
    expect(skill.extraReadTools).toEqual([]);
  });

  it("parses a declared tools list out of the frontmatter and strips it from the instructions", () => {
    const skill = parseSkill("---\ntools: WebFetch, Grep\n---\n# Guidance\nBody text.\n");
    expect(skill.extraReadTools).toEqual(["WebFetch", "Grep"]);
    expect(skill.instructions).toBe("# Guidance\nBody text.");
  });

  it("returns no extra tools when the frontmatter has no tools line", () => {
    const skill = parseSkill("---\nauthor: someone\n---\nBody text.\n");
    expect(skill.extraReadTools).toEqual([]);
    expect(skill.instructions).toBe("Body text.");
  });
});
