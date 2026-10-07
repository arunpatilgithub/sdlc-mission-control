import { useMemo, useState } from "react";
import type { Story, StorySummary } from "../types";
import { backlogTags, filterBacklog } from "../backlog-filter";

export function Backlog({ stories, loading, loadingStoryId, selected, onSelect }: {
  stories: StorySummary[];
  loading: boolean;
  loadingStoryId: number | null;
  selected: Story | null;
  onSelect: (storyId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("All");
  const [assigneeFilter, setAssigneeFilter] = useState("All");
  const [tagFilter, setTagFilter] = useState("All");

  const states = useMemo(() => [...new Set(stories.map((item) => item.state))].sort(), [stories]);
  const assignees = useMemo(() => [...new Set(stories.map((item) => item.assignedTo ?? "Unassigned"))].sort(), [stories]);
  const tags = useMemo(() => backlogTags(stories), [stories]);
  const filteredStories = useMemo(() => filterBacklog(stories, {
    query,
    state: stateFilter,
    assignee: assigneeFilter,
    tag: tagFilter,
  }), [stories, query, stateFilter, assigneeFilter, tagFilter]);

  return <aside className="backlog-panel">
      <div className="section-title"><h2>Publisher backlog</h2><span>{filteredStories.length} / {stories.length}</span></div>
      <div className="filters">
        <label className="filter-search">Search<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ID or title" /></label>
        <label>Status<select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}><option>All</option>{states.map((state) => <option key={state}>{state}</option>)}</select></label>
        <label>Assigned to<select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)}><option>All</option>{assignees.map((assignee) => <option key={assignee}>{assignee}</option>)}</select></label>
        <label>Tags<select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option>All</option>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select></label>
      </div>
      <div className="story-list">
        {filteredStories.map((story) => {
          const storyLoading = loadingStoryId === story.id;
          const storyActive = storyLoading || (loadingStoryId === null && selected?.id === story.id);
          return <button key={story.id} className={`story${storyActive ? " active" : ""}${storyLoading ? " loading" : ""}`} onClick={() => onSelect(story.id)}>
            <span className="story-id">Order {story.backlogOrder} · #{story.id} · {story.workItemType} · {story.state}</span>
            <strong>{story.title}</strong>
            <small>{story.assignedTo ?? "Unassigned"}</small>
            {storyLoading && <span className="story-loading" role="status"><span className="activity-spinner" aria-hidden="true" />Loading story…</span>}
            {(story.tags ?? []).length > 0 && <span className="story-tags">{story.tags.map((tag) => <span key={tag}>{tag}</span>)}</span>}
          </button>;
        })}
        {!loading && filteredStories.length === 0 && <p className="no-results">No backlog items match these filters.</p>}
      </div>
    </aside>;
}
