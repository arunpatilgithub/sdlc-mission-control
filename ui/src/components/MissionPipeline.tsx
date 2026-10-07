import type { MissionRunJobView } from "../develop-view";
import {
  buildUserProgress,
  isMissionActivityRunning,
  stageAgentLabel,
  type UserStageId,
} from "../mission-pipeline";
import type { PlanJob } from "../types";

const userLabels: Record<UserStageId, string> = {
  plan: "Plan",
  review: "Review",
  approve: "Approve",
  develop: "Develop",
  verify: "Verify",
  publish: "Publish",
  complete: "Complete",
};

export function MissionPipeline({ plan, develop, featureBranch, onNavigate, onResetMission, resetDisabled }: {
  plan: PlanJob | null;
  develop: MissionRunJobView | null;
  featureBranch: string | null;
  onNavigate: (stage: UserStageId) => void;
  onResetMission: () => void;
  resetDisabled: boolean;
}) {
  const progress = buildUserProgress(plan, develop);
  const guidanceStatus = progress.stages.find((stage) => stage.id === progress.guidance.stage)?.status ?? "pending";
  const activityRunning = isMissionActivityRunning(plan, develop);
  return <>
    <div className="mission-progress-wrap">
      <div className="mission-progress-heading">
        <h3>Mission progress</h3>
        <div className="mission-progress-actions">
          <span>{progress.guidance.title}</span>
          <button type="button" className="primary" onClick={onResetMission} disabled={resetDisabled}>Reset mission workspace</button>
        </div>
      </div>
      <div className="mission-progress" aria-label="Mission progress">
        {progress.stages.map((stage, index) => <div className={`mission-stage mission-stage-${stage.status}${activityRunning && stage.id === progress.guidance.stage ? " mission-stage-working" : ""}`} key={stage.id}>
          <span className="mission-stage-marker">{stage.status === "completed" ? "✓" : index + 1}</span>
          <span className="mission-stage-label">{userLabels[stage.id]}</span>
          <span className="mission-stage-state">{stage.status === "active" ? "Current" : stage.status}</span>
          {stageAgentLabel(stage.id, plan, develop) && <span className="mission-stage-agent">
            {stageAgentLabel(stage.id, plan, develop)}
          </span>}
          {stage.id === "develop" && featureBranch && <span className="mission-stage-branch">
            Creates <code>{featureBranch}</code>
          </span>}
        </div>)}
      </div>
      {(plan?.repositoryIds.length ?? 0) > 1 && <div className="mission-repository-progress">
        {plan!.executionOrder.map((repositoryId, index) => {
          const run = develop?.runsByRepository[repositoryId];
          const verifiedNoChange = (plan!.plannedPathsByRepository[repositoryId]?.length ?? 0) === 0
            && plan!.scopeOutVerificationByRepository?.[repositoryId]?.status === "verified";
          return <span key={repositoryId}>
            <strong>{index + 1}. {repositoryId}</strong>
            <small>{verifiedNoChange ? "verified no change" : run?.status ?? "waiting"}{run?.result?.outcome === "done" ? " · verified" : ""}</small>
            <code>{verifiedNoChange ? "No branch required" : run?.result?.develop?.branch ?? (index === 0 ? featureBranch : "feature branch pending")}</code>
          </span>;
        })}
      </div>}
    </div>
    <div className={`current-action current-action-${guidanceStatus}`}>
      {activityRunning && <span className="activity-spinner current-action-spinner" aria-hidden="true" />}
      <div role={activityRunning ? "status" : undefined}><strong>{progress.guidance.title}</strong><span>{progress.guidance.detail}</span></div>
      <button type="button" className="primary" onClick={() => onNavigate(progress.guidance.stage)}>{progress.guidance.action}</button>
    </div>
  </>;
}
