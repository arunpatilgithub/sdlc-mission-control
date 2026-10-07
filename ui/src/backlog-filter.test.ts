import { describe, expect, it } from "vitest";
import type { StorySummary } from "./types";
import { backlogTags, filterBacklog } from "./backlog-filter";

function story(id: number, tags: string[], overrides: Partial<StorySummary> = {}): StorySummary {
  return {
    id,
    backlogOrder: id,
    title: `Story ${id}`,
    state: "New",
    workItemType: "User Story",
    assignedTo: null,
    areaPath: "Development\\Publisher",
    changedDate: null,
    tags,
    ...overrides,
  };
}

describe("backlog tag filtering", () => {
  const stories = [
    story(1, ["Agent", "Portal"]),
    story(2, ["agent"], { state: "Active", assignedTo: "Dev One" }),
    story(3, []),
  ];

  it("lists distinct tags without treating case variants as separate filters", () => {
    expect(backlogTags(stories)).toEqual(["Agent", "Portal"]);
  });

  it("combines the tag filter with status and assignee filters", () => {
    expect(filterBacklog(stories, { query: "", state: "Active", assignee: "Dev One", tag: "Agent" }).map(({ id }) => id)).toEqual([2]);
    expect(filterBacklog(stories, { query: "", state: "All", assignee: "All", tag: "All" }).map(({ id }) => id)).toEqual([1, 2, 3]);
  });

  it("searches by work item id or title without case sensitivity", () => {
    expect(filterBacklog(stories, { query: "story 2", state: "All", assignee: "All", tag: "All" }).map(({ id }) => id)).toEqual([2]);
    expect(filterBacklog(stories, { query: "3", state: "All", assignee: "All", tag: "All" }).map(({ id }) => id)).toEqual([3]);
  });

  it("tolerates an older cached story that has no tags field", () => {
    const cached = { ...story(4, []), tags: undefined } as unknown as StorySummary;
    expect(backlogTags([cached])).toEqual([]);
    expect(filterBacklog([cached], { query: "", state: "All", assignee: "All", tag: "Agent" })).toEqual([]);
  });
});
