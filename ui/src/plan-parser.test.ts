import { describe, expect, it } from "vitest";
import { parsePlanSections, parseSpans, stripFencedBlocks } from "./plan-parser";

const PLAN_WITH_SCOPE_BLOCK = [
  "## Relevant code areas",
  "The subid capture happens in `urlTracking.js`.",
  "",
  "## Repository scope (JSON)",
  "```json",
  '{"primaryRepo": "Publisher.Portal", "additionalRepos": []}',
  "```",
].join("\n");

describe("stripFencedBlocks", () => {
  it("removes the repository-scope JSON block and its contents", () => {
    const stripped = stripFencedBlocks(PLAN_WITH_SCOPE_BLOCK);
    expect(stripped).not.toContain("primaryRepo");
    expect(stripped).not.toContain("```");
    expect(stripped).toContain("Relevant code areas");
  });

  it("leaves plans with no fenced block unchanged apart from trimming", () => {
    expect(stripFencedBlocks("## Validation\nRun the suite.")).toBe("## Validation\nRun the suite.");
  });

  it("drops trailing content after an unterminated fence rather than surfacing raw JSON", () => {
    const stripped = stripFencedBlocks('## Scope\n```json\n{"primaryRepo": "X"}');
    expect(stripped).toBe("## Scope");
  });

  it("removes multiple fenced blocks", () => {
    const stripped = stripFencedBlocks("a\n```\none\n```\nb\n```\ntwo\n```\nc");
    expect(stripped).toBe("a\nb\nc");
  });
});

describe("parsePlanSections", () => {
  it("splits on headings and keeps their text", () => {
    const sections = parsePlanSections("## First\nalpha\n## Second\nbeta");
    expect(sections.map((section) => section.heading)).toEqual(["First", "Second"]);
  });

  it("never emits a section containing the fenced scope block", () => {
    const sections = parsePlanSections(PLAN_WITH_SCOPE_BLOCK);
    const rendered = JSON.stringify(sections);
    expect(rendered).not.toContain("primaryRepo");
    // The heading itself survives; only the fenced payload is dropped.
    expect(sections.map((section) => section.heading)).toContain("Repository scope (JSON)");
  });

  it("preserves source numbering when prose separates numbered items", () => {
    const markdown = [
      "## Ordered implementation tasks",
      "1. **Locate ownership:** inspect the config.",
      "Some prose that interrupts the list.",
      "2. **Document the contract:** record the key.",
      "More interrupting prose.",
      "3. **Apply the correction:** change the mapping.",
    ].join("\n");

    const lists = parsePlanSections(markdown)[0].blocks.filter((block) => block.kind === "list");
    const numbers = lists.flatMap((block) => (block.kind === "list" ? block.items.map((item) => item.number) : []));
    expect(numbers).toEqual([1, 2, 3]);
  });

  it("keeps a contiguous numbered list as one block", () => {
    const blocks = parsePlanSections("1. one\n2. two\n3. three")[0].blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind === "list" && blocks[0].ordered).toBe(true);
    expect(blocks[0].kind === "list" && blocks[0].items.map((item) => item.number)).toEqual([1, 2, 3]);
  });

  it("distinguishes bulleted from numbered lists", () => {
    const blocks = parsePlanSections("- alpha\n- beta")[0].blocks;
    expect(blocks[0].kind === "list" && blocks[0].ordered).toBe(false);
    expect(blocks[0].kind === "list" && blocks[0].items.map((item) => item.number)).toEqual([null, null]);
  });

  it("returns no sections for empty input", () => {
    expect(parsePlanSections("")).toEqual([]);
  });
});

describe("parseSpans", () => {
  it("splits inline code and bold out of surrounding text", () => {
    expect(parseSpans("edit `List.js` then **stop**")).toEqual([
      { kind: "text", text: "edit " },
      { kind: "code", text: "List.js" },
      { kind: "text", text: " then " },
      { kind: "strong", text: "stop" },
    ]);
  });

  it("treats plain text as a single span", () => {
    expect(parseSpans("nothing special")).toEqual([{ kind: "text", text: "nothing special" }]);
  });
});
