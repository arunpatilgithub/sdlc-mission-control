import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { Status, Story, StorySummary } from "./types";
import { responseError } from "./types";
import { Backlog } from "./components/Backlog";
import { PlanReview } from "./components/PlanReview";
import { HistoryPanel } from "./components/HistoryPanel";

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [stories, setStories] = useState<StorySummary[]>([]);
  const [selected, setSelected] = useState<Story | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingStoryId, setLoadingStoryId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const storyRequestId = useRef(0);

  const loadStories = async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusResponse, storiesResponse] = await Promise.all([fetch("/api/ado/status"), fetch("/api/ado/stories")]);
      if (!statusResponse.ok) throw new Error(await responseError(statusResponse, "Unable to check the Azure DevOps connection."));
      if (!storiesResponse.ok) throw new Error(await responseError(storiesResponse, "Unable to load Azure DevOps stories."));
      setStatus(await statusResponse.json());
      setStories((await storiesResponse.json()).stories);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadStories(); }, []);

  const selectStory = async (storyId: number) => {
    const requestId = storyRequestId.current + 1;
    storyRequestId.current = requestId;
    setError(null);
    setLoadingStoryId(storyId);
    try {
      const response = await fetch(`/api/ado/stories/${storyId}`);
      if (!response.ok) throw new Error(await responseError(response, "Unable to load User Story."));
      const story = (await response.json()).story as Story;
      if (requestId === storyRequestId.current) setSelected(story);
    } catch (cause) {
      if (requestId === storyRequestId.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId === storyRequestId.current) setLoadingStoryId(null);
    }
  };

  const resetMission = () => {
    storyRequestId.current += 1;
    setLoadingStoryId(null);
    setSelected(null);
  };

  const scope = useMemo(() => status ? `${status.project} / ${status.team}` : "Connecting to Azure DevOps…", [status]);

  return <main>
    <header>
      <div className="brand"><span className="brand-mark">MC</span><div><h1>SDLC Mission Control</h1><p className="scope">{scope}</p></div></div>
      <div className="header-actions">
        <span className="connection-status"><span className={status ? "dot good" : "dot"}></span>{status ? "Azure DevOps connected" : "Connecting…"}</span>
        <button onClick={() => void loadStories()} disabled={loading}>{loading ? "Loading…" : "Refresh backlog"}</button>
      </div>
    </header>

    {error && <div className="error">{error}</div>}

    <section className="app-workspace">
      <Backlog stories={stories} loading={loading} loadingStoryId={loadingStoryId} selected={selected} onSelect={(storyId) => void selectStory(storyId)} />
      <div className="mission-column">
        <PlanReview selectedStory={selected} onStoryLoaded={setSelected} onResetMission={resetMission} onPlanFinished={() => setHistoryKey((key) => key + 1)} />
        <HistoryPanel reloadKey={historyKey} />
      </div>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
