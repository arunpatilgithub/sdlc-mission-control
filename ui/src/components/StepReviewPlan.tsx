import { useEffect, useState } from "react";
import type { PlanJob, Provider } from "../types";
import { planSections } from "../markdown";

const DECISION_HEADING = /questions (?:requiring developer decision|or clarifications? worth checking)/i;
const SINGLE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface DeveloperDecisionChoice {
  question: string;
  recommendation: string;
  alternatives: string[];
}

export type DeveloperDecisionAnswerChoice = "recommendation" | "other" | `alternative:${number}`;

export function formatDeveloperDecisionAnswer(
  decision: DeveloperDecisionChoice,
  choice: DeveloperDecisionAnswerChoice | undefined,
  otherAnswer: string,
): string | null {
  if (choice === "recommendation") return `Accept the recommendation: ${decision.recommendation}`;
  if (choice === "other") return otherAnswer.trim() || null;
  if (!choice?.startsWith("alternative:")) return null;
  const alternative = decision.alternatives[Number(choice.slice("alternative:".length))];
  if (!alternative) return null;
  return SINGLE_IDENTIFIER.test(alternative) ? `Use ${alternative}` : `Use alternative: ${alternative}`;
}

export function answeredDeveloperDecisions(
  decisions: DeveloperDecisionChoice[],
  choices: Record<string, DeveloperDecisionAnswerChoice | undefined>,
  otherAnswers: Record<string, string>,
  evidence: Record<string, string>,
): Array<{ question: string; answer: string; evidence?: string }> {
  return decisions.flatMap((decision) => {
    const answer = formatDeveloperDecisionAnswer(decision, choices[decision.question], otherAnswers[decision.question] ?? "");
    if (!answer) return [];
    const comment = evidence[decision.question]?.trim();
    return [{ question: decision.question, answer, ...(comment ? { evidence: comment } : {}) }];
  });
}

export function acceptAllRecommendationChoices(decisions: DeveloperDecisionChoice[]): Record<string, DeveloperDecisionAnswerChoice> {
  return Object.fromEntries(decisions.map((decision) => [decision.question, "recommendation" as const]));
}

function providerLabel(provider: Provider): string {
  return provider === "claude" ? "Claude Code CLI" : "Codex CLI";
}

function otherProvider(provider: Provider): Provider {
  return provider === "claude" ? "codex" : "claude";
}

function elapsedSince(timestamp: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1_000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function HarnessPlanDuration({ planJob }: { planJob: PlanJob }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (planJob.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [planJob.status]);
  const completedAt = planJob.completedAt ? Date.parse(planJob.completedAt) : now;
  const elapsed = elapsedSince(planJob.startedAt, completedAt);
  const label = planJob.status === "completed"
    ? "Harness plan generation"
    : planJob.status === "failed"
      ? "Harness planning stopped after"
      : "Harness plan generation";
  return <p className="usage-bar"><span>{label}: {elapsed}{planJob.status === "running" ? " elapsed" : ""}</span></p>;
}

function planningPhaseLabel(phase: NonNullable<PlanJob["planningProgress"]>["phase"]): string {
  return {
    preparing: "Preparing bounded packet",
    scouting: "Repository discovery",
    coordinating: "Coordinating implementation plan",
    validating: "Validating plan contract",
    "behavioral-review": "Checking behavioral claims",
    complete: "Plan complete",
    failed: "Planning stopped",
  }[phase];
}

function PlanningTimeline({ planJob }: { planJob: PlanJob }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (planJob.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [planJob.status]);
  const progress = planJob.planningProgress;
  const phase = progress?.phase ?? "preparing";
  const hasScouts = planJob.repositoryIds.length > 1 || planJob.packet.mode !== "fast";
  const hasBehavioralReview = phase === "behavioral-review" || (progress?.phaseTimings ?? []).some((entry) => entry.phase === "behavioral-review");
  const phaseDuration = elapsedSince(progress?.phaseStartedAt ?? planJob.startedAt, now);
  const totalDuration = elapsedSince(planJob.startedAt, now);
  const timeoutMinutes = planJob.planningTimeoutSeconds / 60;
  const scoutLabel = (status: "pending" | "running" | "completed" | "failed") => ({
    pending: "waiting",
    running: "reading current source",
    completed: "findings ready",
    failed: "stopped",
  })[status];
  const stageState = (stage: "preparing" | "scouting" | "coordinating" | "validating" | "behavioral-review") => {
    const order = ["preparing", "scouting", "coordinating", "validating", "behavioral-review"];
    const current = order.indexOf(phase);
    const index = order.indexOf(stage);
    return phase === "failed" ? "pending" : index < current || phase === "complete" ? "completed" : index === current ? "running" : "pending";
  };

  return <section className="planning-timeline" aria-label="Planning progress">
    <div className="planning-timeline-heading"><strong>Planning progress</strong><span>{totalDuration} elapsed · {timeoutMinutes} min per stage</span></div>
    <ol>
      <li data-state={stageState("preparing")}>Preparing bounded packet</li>
      {hasScouts && <li data-state={stageState("scouting")}>Repository discovery {planJob.repositoryIds.length > 1 ? "(parallel)" : ""}
        <ul>{planJob.repositoryIds.map((repositoryId) => {
          const scout = progress?.scouts[repositoryId] ?? { status: "pending" as const, startedAt: null, completedAt: null };
          return <li className="planning-scout" key={repositoryId}><span data-state={scout.status}>{scoutLabel(scout.status)}</span>{repositoryId}</li>;
        })}</ul>
      </li>}
      <li data-state={stageState("coordinating")}>Coordinating implementation plan</li>
      <li data-state={stageState("validating")}>Validating plan contract</li>
      {hasBehavioralReview && <li data-state={stageState("behavioral-review")}>Checking behavioral claims</li>}
    </ol>
    <p className="plan-meta-detail">Current stage: {planningPhaseLabel(phase)} · {phaseDuration} in this stage. Activity labels are lifecycle milestones, not estimated completion percentages.</p>
  </section>;
}

function PlanningStageTimings({ planJob }: { planJob: PlanJob }) {
  const now = Date.now();
  const timings = (planJob.planningProgress?.phaseTimings ?? []).filter((entry) => entry.phase !== "complete" && entry.phase !== "failed");
  if (timings.length === 0) return null;
  return <section className="planning-timeline" aria-label="Planning stage timings">
    <div className="planning-timeline-heading"><strong>Planning stage timings</strong><span>Actual harness time</span></div>
    <ol className="planning-stage-timings">
      {timings.map((entry, index) => <li data-state={entry.completedAt ? "completed" : "running"} key={`${entry.phase}-${entry.startedAt}-${index}`}>
        <span>{planningPhaseLabel(entry.phase)}</span>
        <span className="planning-stage-duration">{elapsedSince(entry.startedAt, entry.completedAt ? Date.parse(entry.completedAt) : now)}</span>
      </li>)}
    </ol>
  </section>;
}

export function externalReviewPacket(planJob: PlanJob, plannedPathsByRepository: Record<string, string[]>): string {
  const repositories = planJob.repositoryIds.map((repositoryId, index) => [
    `### ${index + 1}. ${repositoryId}`,
    `- Local checkout: \`${planJob.worktreePaths[repositoryId] ?? "not recorded"}\``,
    `- Baseline branch: \`${planJob.branches[repositoryId] ?? "not recorded"}\``,
    `- Planned write boundary: ${(plannedPathsByRepository[repositoryId] ?? []).map((path) => `\`${path}\``).join(", ") || "none"}`,
    `- Scope disposition: ${planJob.scopeDispositionByRepository?.[repositoryId] ?? "unverified"}`,
    `- Scope evidence: ${(planJob.evidenceByRepository?.[repositoryId] ?? []).join(", ") || "none"}`,
    `- Scope-out verification: ${planJob.scopeOutVerificationByRepository?.[repositoryId]?.status ?? "unverified"}`,
    `- Depends on: ${planJob.dependenciesByRepository[repositoryId]?.join(", ") || "none"}`,
  ].join("\n")).join("\n\n");
  const comments = planJob.packet.story.comments?.length
    ? planJob.packet.story.comments.map((comment) => `- [${comment.createdDate}] ${comment.author}: ${comment.text}`).join("\n")
    : "No ADO discussion comments were available.";

  return [
    "# Mission plan external review",
    "",
    "Act as an independent, read-only implementation-plan reviewer. Inspect the listed local checkouts when useful. Do not modify files, create commits, or push branches. Identify correctness gaps, missing work, unsafe assumptions, cross-repository contract mismatches, and inadequate verification. Cite repository-qualified paths as evidence. End with a verdict of `sound`, `needs-revision`, or `off-track`.",
    "",
    "## Mission",
    `- Work item: ${planJob.packet.story.id}`,
    `- Title: ${planJob.packet.story.title}`,
    `- Plan provider: ${providerLabel(planJob.provider)}`,
    `- Plan model: ${planJob.model ?? "signed-in CLI default"}`,
    `- Planning mode: ${planJob.packet.mode}`,
    `- Generated: ${planJob.completedAt ?? planJob.startedAt}`,
    "",
    "## ADO discussion comments",
    comments,
    ...(planJob.packet.story.commentsTruncated ? ["", "_Earlier or oversized comments were omitted by the bounded mission-packet policy._"] : []),
    "",
    "## Cached vendor API contracts",
    planJob.packet.vendorApiSpecs?.map((spec) => spec.content).join("\n\n---\n\n") || "No matching cached vendor API contract was attached.",
    "",
    "## Developer-fetched external documentation",
    planJob.packet.documentation?.map((entry) => entry.wrappedText).join("\n\n") || "No external documentation was attached.",
    "",
    "## Repositories",
    repositories,
    "",
    "## Decisions needed before implementation",
    planJob.questionsOrClarifications?.map((question) => `- ${question}`).join("\n") || "No plan-changing decisions identified.",
    "",
    "## Operational follow-ups",
    planJob.operationalFollowUps?.map((followUp) => `- ${followUp}`).join("\n") || "No operational follow-ups identified.",
    "",
    "## Outside this mission",
    planJob.outOfScopeFollowUps?.map((followUp) => `- ${followUp}`).join("\n") || "No separately scoped work identified.",
    "",
    "## Generated implementation plan",
    planJob.output ?? "No plan output was recorded.",
    "",
  ].join("\n");
}

function verdictLabel(value: string | null, goodValue: string): "good" | "warn" | "neutral" {
  if (value === null) return "neutral";
  return value === goodValue ? "good" : "warn";
}

/**
 * The cross-provider review panel: a second, differently-blind model's critique of the
 * same plan, plus its own opinion on the repository-scope call. Purely informational —
 * the developer decides what to do with it via the two actions below, not an automatic gate.
 */
function ReviewPanel({ planJob, onRegenerate }: { planJob: PlanJob; onRegenerate: () => void }) {
  const review = planJob.review;
  if (!review) return null;
  const sections = planSections(review.output);

  return <div className="review-panel">
    <div className="plan-meta">
      <span className="badge">{providerLabel(review.provider)} review</span>
      {review.verdict.overallAssessment && (
        <span className={`badge verdict-${verdictLabel(review.verdict.overallAssessment, "sound")}`}>{review.verdict.overallAssessment}</span>
      )}
      {review.verdict.repoScopeAgreement && (
        <span className={`badge verdict-${verdictLabel(review.verdict.repoScopeAgreement, "agrees")}`}>repo scope: {review.verdict.repoScopeAgreement}</span>
      )}
    </div>
    {review.verdict.parseError && <p className="repo-scope-note">Verdict badges unavailable ({review.verdict.parseError}) — the critique text below is still complete.</p>}
    {sections.map((section, index) => (
      <div className={`plan-section ${section.heading && DECISION_HEADING.test(section.heading) ? "warn" : ""}`} key={index}>
        {section.heading && <h3>{section.heading}</h3>}
        {section.content}
      </div>
    ))}
    <div className="review-actions">
      <button type="button" className="secondary" onClick={onRegenerate}>↻ Regenerate plan with this feedback</button>
      <span className="repo-scope-hint">Or ignore this and continue to approval with the current plan unchanged.</span>
    </div>
  </div>;
}

export function StepReviewPlan({ planJob, scopeError, onBack, onContinue, onRequestReview, onRegenerateWithFeedback, onSubmitAnswers }: {
  planJob: PlanJob;
  scopeError: string | null;
  onBack: () => void;
  onContinue: (plannedPathsByRepository: Record<string, string[]>, scopeOverrideJustifications?: Record<string, string>) => void | Promise<void>;
  onRequestReview: () => void;
  onRegenerateWithFeedback: (feedback: string) => void;
  onSubmitAnswers: (answers: Array<{ question: string; answer: string; evidence?: string }>) => void;
}) {
  const sections = planJob.status === "completed" && planJob.output ? planSections(planJob.output) : [];
  const hasStructuredClarifications = planJob.questionsOrClarifications !== undefined;
  const contractFailure = planJob.planRevisionStatus === "failed" && planJob.plannedPathsParseError !== null;
  const visibleSections = hasStructuredClarifications
    ? sections.filter((section) => !section.heading || !DECISION_HEADING.test(section.heading))
    : sections;
  const canReview = planJob.status === "completed" && !contractFailure && planJob.reviewStatus === "idle"
    && planJob.behavioralReviewStatus !== "running";
  const initialPaths = Object.keys(planJob.plannedPathsByRepository).length > 0
    ? planJob.plannedPathsByRepository
    : { [planJob.repositoryId]: planJob.plannedPaths };
  const [plannedPathsByRepository, setPlannedPathsByRepository] = useState(initialPaths);
  const [newPaths, setNewPaths] = useState<Record<string, string>>({});
  const [answerChoices, setAnswerChoices] = useState<Record<string, DeveloperDecisionAnswerChoice | undefined>>({});
  const [otherAnswerDrafts, setOtherAnswerDrafts] = useState<Record<string, string>>({});
  const [evidenceDrafts, setEvidenceDrafts] = useState<Record<string, string>>({});
  const [scopeOverrideJustifications, setScopeOverrideJustifications] = useState<Record<string, string>>({});

  useEffect(() => {
    setPlannedPathsByRepository(initialPaths);
    setNewPaths({});
    setAnswerChoices({});
    setOtherAnswerDrafts({});
    setEvidenceDrafts({});
    setScopeOverrideJustifications({});
  }, [planJob.id, planJob.developerPlanRevisionCount, JSON.stringify(planJob.plannedPathsByRepository)]);

  const addPath = (repositoryId: string) => {
    const path = (newPaths[repositoryId] ?? "").trim();
    if (path === "" || plannedPathsByRepository[repositoryId]?.includes(path)) return;
    setPlannedPathsByRepository((current) => ({ ...current, [repositoryId]: [...(current[repositoryId] ?? []), path] }));
    setNewPaths((current) => ({ ...current, [repositoryId]: "" }));
  };
  const approvedPathsByRepository = Object.fromEntries(planJob.repositoryIds.map((repositoryId) => [
    repositoryId,
    [...new Set((plannedPathsByRepository[repositoryId] ?? []).map((path) => path.trim()).filter(Boolean))],
  ]));
  const hasOverrideJustification = (repositoryId: string) => (scopeOverrideJustifications[repositoryId] ?? "").trim() !== "";
  const decisionRegister = planJob.decisionRegister ?? [];
  const isBlockingDecision = (decision: typeof decisionRegister[number]) =>
    (decision.requiredBefore === "plan" || decision.requiredBefore === "develop")
    && (decision.impact === "repository-boundary" || decision.impact === "external-contract" || decision.impact === "shared-contract" || decision.impact === "unknown");
  const preDevelopDecisionPending = decisionRegister.some(isBlockingDecision);
  const earlyDecisions = decisionRegister.length > 0
    ? decisionRegister.filter(isBlockingDecision)
    : (planJob.questionsOrClarifications ?? []).map((question) => ({
      question,
      recommendation: "No recommendation was recorded for this older plan.",
      alternatives: [],
      requiredBefore: "develop" as const,
      rationale: "The answer can change the implementation boundary or behavior.",
    }));
  const questionsNeedingEarlyAnswer = earlyDecisions.map((decision) => decision.question);
  const decidedEarlyAnswers = answeredDeveloperDecisions(earlyDecisions, answerChoices, otherAnswerDrafts, evidenceDrafts);
  const publishDecisions = decisionRegister.filter((decision) => decision.requiredBefore === "publish" && decision.impact === "external-contract");
  const everyRepositoryScoped = planJob.repositoryIds.every((repositoryId) =>
    approvedPathsByRepository[repositoryId]?.length
    || (planJob.scopeDispositionByRepository?.[repositoryId] === "verified-no-change"
      && planJob.scopeOutVerificationByRepository?.[repositoryId]?.status === "verified")
    || hasOverrideJustification(repositoryId),
  );
  const behavioralClaims = Object.entries(planJob.behavioralClaimsByRepository ?? {}).flatMap(([repositoryId, claims]) =>
    claims.map((claim) => ({ repositoryId, ...claim })),
  );
  const behavioralClaimsBlocking = behavioralClaims.some((claim) =>
    (claim.status === "unverified" || claim.status === "refuted")
    && !(approvedPathsByRepository[claim.repositoryId]?.length === 0 && hasOverrideJustification(claim.repositoryId)));
  const evidenceRepairClaims = behavioralClaims.filter((claim) =>
    (claim.status === "unverified" || claim.status === "refuted")
    && (initialPaths[claim.repositoryId]?.length ?? 0) > 0);
  const evidenceRepairRepositoryIds = [...new Set(evidenceRepairClaims.map((claim) => claim.repositoryId))];
  const evidenceRepairFeedback = evidenceRepairClaims.map((claim) =>
    `Repair the repository-inclusion evidence for ${claim.repositoryId}. Re-check the current source for this claim: ${claim.step}. ${claim.explanation ?? "The targeted critic did not confirm it."} Retain the repository only if current-source evidence proves the stated route or dependency.`,
  ).join("\n\n");
  const downloadExternalReviewPacket = () => {
    const blob = new Blob([externalReviewPacket(planJob, approvedPathsByRepository)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mission-plan-${planJob.packet.story.id}-${planJob.id.slice(0, 8)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return <div className="step-panel">
    <div className="plan-meta">
      <span className={`badge ${planJob.status === "completed" ? "ok" : planJob.status === "failed" ? "bad" : ""}`}>{planJob.status}</span>
      <span className="badge">{providerLabel(planJob.provider)}</span>
      <span className="badge">{planJob.model ?? "CLI default"}</span>
      <span className="plan-meta-detail">{planJob.packet.mode} · history: {planJob.packet.historyPolicy} · baseline {planJob.packet.repository.baselineCommit.slice(0, 8)} · {planJob.packet.likelyFiles.length} preflight candidates</span>
    </div>
    {(planJob.packet.relatedWorkItems?.length ?? 0) > 0 && <p className="repo-scope-note">Related work-item reference included: {planJob.packet.relatedWorkItems.map((item) => `#${item.id} ${item.title}`).join(" · ")}</p>}
    {planJob.priorReviewFeedback && <p className="repo-scope-note" style={{ color: "#a8c0c0" }}>This plan was regenerated to address an earlier review's feedback.</p>}
    <HarnessPlanDuration planJob={planJob} />

    {planJob.status === "running" && <PlanningTimeline planJob={planJob} />}
    {planJob.status !== "running" && <PlanningStageTimings planJob={planJob} />}
    {planJob.status === "running" && <div className="activity-line" role="status">
      <span className="activity-spinner" aria-hidden="true" />
      <span><strong>Planning in progress</strong><br />{planJob.provider === "codex" ? "Codex" : "Claude"} is working read-only. You can cancel the run safely from this stage; no repository changes have been made.</span>
    </div>}
    {planJob.status === "failed" && <p className="plan-error">{planJob.error}</p>}
    {planJob.planRevisionStatus === "running" && <div className="activity-line" role="status">
      <span className="activity-spinner" aria-hidden="true" />
      <span><strong>Revising the plan</strong><br />Developer answers or critic objections are being incorporated into a new append-only plan version.</span>
    </div>}
    {(planJob.planRevisionStatus === "escalated" || planJob.planRevisionStatus === "failed") && <p className="plan-error">{planJob.planRevisionError}</p>}
    {contractFailure && <div className="plan-section warn">
      <h3>Plan contract needs regeneration</h3>
      <p>The plan prose is available below, but its repository write-boundary contract is invalid. Nothing can be approved or developed from this result.</p>
      <p className="plan-error">{planJob.plannedPathsParseError}</p>
      <button type="button" className="secondary" onClick={() => onRegenerateWithFeedback(`Repair the repository write-boundary contract. The prior contract error was: ${planJob.plannedPathsParseError}`)}>↻ Regenerate valid plan contract</button>
    </div>}
    {planJob.status === "completed" && hasStructuredClarifications && <div className={`plan-section ${questionsNeedingEarlyAnswer.length > 0 ? "warn" : ""}`}>
      <h3>Developer input needed before this plan can proceed</h3>
      {questionsNeedingEarlyAnswer.length > 0
        ? <>
          <div className="decision-actions">
            <button type="button" className="secondary" onClick={() => setAnswerChoices(acceptAllRecommendationChoices(earlyDecisions))}>Accept all recommendations</button>
            <span className="repo-scope-hint">{decidedEarlyAnswers.length} of {earlyDecisions.length} decided</span>
          </div>
          {earlyDecisions.map((decision, decisionIndex) => {
            const choice = answerChoices[decision.question];
            const radioName = `decision-${decisionIndex}`;
            return <div className="repository-scope-card" key={decision.question}>
            <p><strong>{decision.question}</strong></p>
            <p className="repo-scope-hint"><strong>Why your decision is needed:</strong> {decision.rationale}</p>
            <fieldset className="decision-choices">
              <legend>Choose an answer</legend>
              <label className="decision-choice">
                <input type="radio" name={radioName} checked={choice === "recommendation"} onChange={() => setAnswerChoices((current) => ({ ...current, [decision.question]: "recommendation" }))} />
                <span>Use the planning recommendation: {decision.recommendation}</span>
              </label>
              {decision.alternatives.map((alternative, alternativeIndex) => {
                const alternativeChoice = `alternative:${alternativeIndex}` as const;
                return <label className="decision-choice" key={`${decision.question}-${alternativeIndex}`}>
                  <input type="radio" name={radioName} checked={choice === alternativeChoice} onChange={() => setAnswerChoices((current) => ({ ...current, [decision.question]: alternativeChoice }))} />
                  <span>{alternative}</span>
                </label>;
              })}
              <label className="decision-choice">
                <input type="radio" name={radioName} checked={choice === "other"} onChange={() => setAnswerChoices((current) => ({ ...current, [decision.question]: "other" }))} />
                <span>Other</span>
              </label>
            </fieldset>
            {choice === "other" && <textarea
              className="decision-other-answer"
              value={otherAnswerDrafts[decision.question] ?? ""}
              onChange={(event) => setOtherAnswerDrafts((current) => ({ ...current, [decision.question]: event.target.value }))}
              placeholder="State the decision"
              rows={2}
            />}
            <input
              className="decision-evidence-input"
              value={evidenceDrafts[decision.question] ?? ""}
              onChange={(event) => setEvidenceDrafts((current) => ({ ...current, [decision.question]: event.target.value }))}
              placeholder="Optional ADO comment link"
            />
          </div>;
          })}
          <button type="button" className="secondary" disabled={decidedEarlyAnswers.length === 0} onClick={() => onSubmitAnswers(decidedEarlyAnswers)}>Revise plan with answered questions</button>
          <p className="repo-scope-hint">Developer revisions used: {planJob.developerPlanRevisionCount ?? 0} of 5. Naming confirmations may be patched deterministically; scope or behavior answers trigger a read-only planning rerun.</p>
        </>
        : <p>No decision requires developer input before planning or Develop.</p>}
    </div>}
    {planJob.status === "completed" && (planJob.operationalFollowUps?.length ?? 0) > 0 && <div className="plan-section">
      <h3>Operational follow-ups</h3>
      <p className="repo-scope-hint">These items do not change the approved code plan and are not plan-revision inputs.</p>
      <ul>{planJob.operationalFollowUps!.map((followUp) => <li key={followUp}>{followUp}</li>)}</ul>
    </div>}
    {planJob.status === "completed" && publishDecisions.length > 0 && <div className="plan-section">
      <h3>Required before Publish</h3>
      <p className="repo-scope-hint">These external-contract confirmations do not block Develop, but Publish will remain gated until they are answered and the plan is regenerated.</p>
      {publishDecisions.map((decision) => <div className="repository-scope-card" key={decision.question}>
        <p><strong>{decision.question}</strong></p>
        <p className="repo-scope-hint"><strong>Why this is required:</strong> {decision.rationale}</p>
        <p className="repo-scope-hint"><strong>Planning recommendation:</strong> {decision.recommendation}</p>
      </div>)}
    </div>}
    {planJob.status === "completed" && (planJob.outOfScopeFollowUps?.length ?? 0) > 0 && <div className="plan-section">
      <h3>Outside this mission</h3>
      <p className="repo-scope-hint">Track these in their owning work item; they are deliberately excluded from Develop.</p>
      <ul>{planJob.outOfScopeFollowUps!.map((followUp) => <li key={followUp}>{followUp}</li>)}</ul>
    </div>}
    {(planJob.planRevisionHistory?.length ?? 0) > 0 && <details>
      <summary>Plan revision audit ({planJob.planRevisionHistory.length})</summary>
      <ul>{planJob.planRevisionHistory.map((entry, index) => <li key={`${entry.createdAt}-${index}`}>{entry.source}: {entry.path} — {entry.summary}</li>)}</ul>
    </details>}
    {planJob.behavioralReviewStatus === "running" && <div className="activity-line" role="status">
      <span className="activity-spinner" aria-hidden="true" />
      <span><strong>Targeted plan critic is checking behavioral claims</strong><br />The reviewer is opening the relevant current files before this plan can be approved.</span>
    </div>}
    {planJob.behavioralReviewStatus === "failed" && <p className="plan-error">Behavioral claim review failed: {planJob.behavioralReviewError}</p>}
    {evidenceRepairRepositoryIds.length > 0 && <div className="plan-section warn">
      <h3>Repository evidence repair required</h3>
      <p>The targeted critic could not verify why {evidenceRepairRepositoryIds.join(", ")} belongs in this mission. Its draft write boundary is withheld and cannot be approved or sent to Develop.</p>
      <button type="button" className="secondary" onClick={() => onRegenerateWithFeedback(evidenceRepairFeedback)}>Regenerate with targeted evidence repair</button>
    </div>}
    {behavioralClaims.length > 0 && <div className="plan-section">
      <h3>Existing-behavior claim verification</h3>
      {behavioralClaims.map((claim) => <div className={`review-panel ${claim.status === "refuted" || claim.status === "unverified" ? "warn" : ""}`} key={`${claim.repositoryId}-${claim.stepIndex}`}>
        <p><span className={`badge ${claim.status === "verified" || claim.status === "confirmed" ? "ok" : "bad"}`}>{claim.status}</span> <strong>{claim.repositoryId} · step {claim.stepIndex + 1}</strong></p>
        <p>{claim.step}</p>
        <p>Evidence: {claim.citations.join(", ") || "No adjacent file:line citation"}</p>
        {claim.explanation && <p>{claim.explanation}</p>}
      </div>)}
    </div>}
    {planJob.status === "completed" && visibleSections.map((section, index) => (
      <div className={`plan-section ${section.heading && DECISION_HEADING.test(section.heading) ? "warn" : ""}`} key={index}>
        {section.heading && <h3>{section.heading}</h3>}
        {section.content}
      </div>
    ))}

    {planJob.status === "completed" && !contractFailure && <div className="plan-section scope-review">
      <h3>Planned Develop write boundaries</h3>
      <p>Review each repository-local boundary. Develop cannot modify paths outside its repository's approved list.</p>
      {scopeError && <p className="plan-error">{scopeError}</p>}
      {planJob.executionOrder.map((repositoryId, order) => {
        const blockedClaims = evidenceRepairClaims.filter((claim) => claim.repositoryId === repositoryId);
        if (blockedClaims.length > 0) return <div className="repository-scope-card" key={repositoryId}>
          <h4>{order + 1}. {repositoryId}</h4>
          <p className="plan-error">Evidence repair required — the proposed write boundary is provisional and cannot be approved or sent to Develop.</p>
          <ul>{blockedClaims.map((claim) => <li key={`${claim.stepIndex}-${claim.phrase}`}>{claim.explanation ?? claim.step}</li>)}</ul>
        </div>;
        return <div className="repository-scope-card" key={repositoryId}>
          <h4>{order + 1}. {repositoryId}</h4>
        {plannedPathsByRepository[repositoryId]?.length === 0 && planJob.scopeDispositionByRepository?.[repositoryId] === "verified-no-change" && planJob.scopeOutVerificationByRepository?.[repositoryId]?.status === "verified" && (
          <p className="story-loaded-note">Verified no change — this repository will skip Task, Develop, review, and Publish.</p>
        )}
        {plannedPathsByRepository[repositoryId]?.length === 0 && (planJob.scopeDispositionByRepository?.[repositoryId] !== "verified-no-change" || planJob.scopeOutVerificationByRepository?.[repositoryId]?.status !== "verified") && (
          <>
            <p className="plan-error">Unverified scope-out — the plan must explicitly mark this repository verified-no-change and support it with audit-backed current-file evidence. Add a real write boundary, regenerate the plan, or record a developer override below with your own reasoning.</p>
            <textarea
              value={scopeOverrideJustifications[repositoryId] ?? ""}
              onChange={(event) => setScopeOverrideJustifications((current) => ({ ...current, [repositoryId]: event.target.value }))}
              placeholder="Developer override justification (e.g. cite the specific current-file evidence for why this repository needs no changes)"
              rows={2}
            />
            {hasOverrideJustification(repositoryId) && (
              <p className="story-loaded-note">Developer override recorded — will be saved as verified-no-change with your stated justification when you continue.</p>
            )}
          </>
        )}
        {planJob.applicabilityByRepository?.[repositoryId]?.role !== "unknown" && <p><strong>Applicability:</strong> {planJob.applicabilityByRepository[repositoryId].role} — {planJob.applicabilityByRepository[repositoryId].storyBinding}. {planJob.applicabilityByRepository[repositoryId].routeOrDependency}</p>}
        {(planJob.evidenceByRepository?.[repositoryId]?.length ?? 0) > 0 && <p>Scope evidence: {planJob.evidenceByRepository[repositoryId].join(", ")}</p>}
        {(planJob.dependenciesByRepository[repositoryId]?.length ?? 0) > 0 && <p>Depends on: {planJob.dependenciesByRepository[repositoryId].join(", ")}</p>}
        {(planJob.verificationCommandsByRepository?.[repositoryId]?.length ?? 0) > 0 && <p>Mission-specific post-change checks: {planJob.verificationCommandsByRepository[repositoryId].map((entry) => `${entry.command}${entry.timeoutSeconds ? ` (max ${entry.timeoutSeconds}s)` : ""}`).join(", ")}</p>}
        {planJob.plannedPathsParseErrorsByRepository[repositoryId] && <p className="plan-error">{planJob.plannedPathsParseErrorsByRepository[repositoryId]}</p>}
        {(plannedPathsByRepository[repositoryId] ?? []).map((path, index) => <div className="repo-task-add" key={`${repositoryId}-${path}-${index}`}>
          <input value={path} onChange={(event) => setPlannedPathsByRepository((current) => ({
            ...current,
            [repositoryId]: current[repositoryId].map((entry, i) => i === index ? event.target.value : entry),
          }))} />
          <button type="button" className="link-button" onClick={() => setPlannedPathsByRepository((current) => ({
            ...current,
            [repositoryId]: current[repositoryId].filter((_, i) => i !== index),
          }))}>Remove</button>
        </div>)}
        <div className="repo-task-add">
          <input value={newPaths[repositoryId] ?? ""} onChange={(event) => setNewPaths((current) => ({ ...current, [repositoryId]: event.target.value }))} placeholder="Add exact file or scoped directory/" />
          <button type="button" className="secondary" onClick={() => addPath(repositoryId)} disabled={(newPaths[repositoryId] ?? "").trim() === ""}>Add</button>
        </div>
        </div>;
      })}
      {planJob.suggestedRepositories.length > 0 && <p className="repo-scope-note">Planner suggestions are not in execution scope: {planJob.suggestedRepositories.map((entry) => `${entry.id} (${entry.reason})`).join("; ")}. Return to setup and regenerate to include one.</p>}
    </div>}

    {planJob.status === "completed" && (
      <div className="review-request">
        <button type="button" className="secondary" onClick={downloadExternalReviewPacket}>Download external review packet</button>
        {canReview && <button type="button" className="secondary" onClick={onRequestReview}>Review with {providerLabel(otherProvider(planJob.provider))} →</button>}
        {planJob.reviewStatus === "running" && <p className="plan-meta-detail">Reviewing with {providerLabel(otherProvider(planJob.provider))}, read-only…</p>}
        {planJob.reviewStatus === "failed" && <p className="plan-error">Review failed: {planJob.reviewError}</p>}
        {planJob.reviewStatus === "completed" && <ReviewPanel planJob={planJob} onRegenerate={() => onRegenerateWithFeedback(planJob.review?.output ?? "")} />}
      </div>
    )}

    <div className="step-footer between">
      <button type="button" className="link-button" onClick={onBack}>← Back to story &amp; repo</button>
      <button className="primary" onClick={() => void onContinue(approvedPathsByRepository, scopeOverrideJustifications)} disabled={!planJob.repoScope || !everyRepositoryScoped || preDevelopDecisionPending || planJob.behavioralReviewStatus === "running" || behavioralClaimsBlocking || planJob.planRevisionStatus === "running" || planJob.planRevisionStatus === "escalated"}>Continue to approval →</button>
    </div>
  </div>;
}
