import type { StorySummary } from "./types";

export type BacklogFilters = {
  query: string;
  state: string;
  assignee: string;
  tag: string;
};

export function backlogTags(stories: StorySummary[]): string[] {
  const labels = new Map<string, string>();
  for (const story of stories) {
    for (const tag of story.tags ?? []) {
      const trimmed = tag.trim();
      const key = trimmed.toLocaleLowerCase();
      if (trimmed !== "" && !labels.has(key)) labels.set(key, trimmed);
    }
  }
  return [...labels.values()].sort((left, right) => left.localeCompare(right));
}

export function filterBacklog(stories: StorySummary[], filters: BacklogFilters): StorySummary[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const selectedTag = filters.tag.toLocaleLowerCase();
  return stories.filter((story) =>
    (query === "" || `${story.id} ${story.title}`.toLocaleLowerCase().includes(query))
    && (filters.state === "All" || story.state === filters.state)
    && (filters.assignee === "All" || (story.assignedTo ?? "Unassigned") === filters.assignee)
    && (filters.tag === "All" || (story.tags ?? []).some((tag) => tag.toLocaleLowerCase() === selectedTag)),
  );
}
