import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectPromotionView } from '@orbit/shared';
import { api } from '../api';
import { Dialog } from './ui/Dialog';
import { LandingJobsSheet } from './LandingJobsSheet';
import { LandingLink } from './LandingLink';
import {
  LANDING_ALL_JOBS,
  LandingHead,
  landingHead,
  landingJobLines,
  landingLine,
} from './ProjectPanoramaHeader';
import {
  CANCEL_MERGE,
  NOT_NOW,
  OPEN_COORDINATOR,
  ProjectPromotion,
  decidePromotion,
  mergeTo,
  promotionCriteriaLine,
  promotionHeading,
  promotionItem,
  resolvingPress,
  type PromotionProjectView,
} from './ProjectPromotionCard';
import {
  ABANDON,
  CANCEL_MAY_STILL_MERGE,
  CANCEL_REQUESTED,
  CANCEL_STOPS_SOON,
  CANCELLING_THE_MERGE,
  DETAILS,
  NEEDS_YOU,
  PAGE_NOTHING_TO_DO,
  RERUN_THE_CHECK,
  STOP_REQUESTED,
  TOO_LATE_TO_CANCEL,
  abandonJob,
  isMergeJob,
  mergeCardShape,
  moreJobsQueued,
  moreTasks,
  promotionBlockedBy,
  promotionBlockedLine,
  promotionBranchLine,
  promotionChecksSummary,
  promotionLandingSessionId,
  promotionMergingStatus,
  promotionOnPassLine,
  promotionPageCounts,
  promotionPageTitle,
  promotionTaskTitles,
  recheckPromotion,
} from '../lib/projectMerge';
import { projectIntegrationQuery, projectOpenItemsQuery, projectPromotionQuery } from '../lib/queries';
import { mainBranchName } from '../lib/projectStart';
import { ago } from '../lib/watches';

/** A read the page can draw from: the door answers a candidate or `null`, and anything else is no
 *  candidate rather than one with every field missing. */
function asPromotion(value: unknown): ProjectPromotionView | null {
  return value && typeof value === 'object' && 'promotionId' in value ? (value as ProjectPromotionView) : null;
}

/** The merge into main's mark (iOS `arrow.triangle.merge`), on the asking card and the timeline. */
function MergeGlyph({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2.2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 7l4-4 4 4" />
      <path d="M12 3v8" />
      <path d="M12 11c0 3.5-5 4.5-5 9.5" />
      <path d="M12 11c0 3.5 5 4.5 5 9.5" />
    </svg>
  );
}

/**
 * The merge into main on the project's sessions view, in the list under the progress card (owner
 * decisions 2026-10-06; mocks in docs/mocks/project-merge-sessions-page and
 * docs/mocks/project-sessions-page-web). One card at four moments: the merge check running, the
 * candidate asking, merging, or blocked — and nothing at all otherwise; a merge already made is a
 * row of the project's Landings window instead (owner 2026-10-27).
 *
 * Its presses are the card's own doors (`decidePromotion`), and Details opens the whole card — the
 * one the project page draws — for anyone who wants every row before pressing. It claims no
 * keyboard chord: ⌘/Ctrl+Enter stays with the card the reader opened.
 */
export function ProjectMergeStrip({
  projectId,
  onOpenCoordinator,
}: {
  projectId: string;
  /** Where a blocked candidate's handling is: the project's coordinator conversation, opened over
   *  this page the way its row opens it. Null when the page lists no coordinator. */
  onOpenCoordinator: (() => void) | null;
}): JSX.Element | null {
  const qc = useQueryClient();
  const promotion = useQuery({ ...projectPromotionQuery(projectId), refetchInterval: 15_000 });
  const integration = useQuery(projectIntegrationQuery(projectId));
  const current = asPromotion(promotion.data);
  const inFlight = integration.data && typeof integration.data === 'object' ? integration.data.inFlight ?? null : null;
  const shape = mergeCardShape(current, inFlight);
  const items = useQuery({
    ...projectOpenItemsQuery(projectId),
    enabled: shape === 'blocked',
    refetchInterval: 20_000,
  });
  // How far the criteria have got, for the asking card's line — the project document's own words.
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<PromotionProjectView>(`/projects/${encodeURIComponent(projectId)}`),
    enabled: shape === 'asking',
  });
  const criteriaLine = project.isError ? null : promotionCriteriaLine(project.data ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [detailsOpen, setDetailsOpen] = useState(false);
  // A server that lists the jobs in flight is one whose landing row opens that list.
  const listed = integration.data && typeof integration.data === 'object' && integration.data.inFlightJobs !== undefined;
  const [jobsOpen, setJobsOpen] = useState(false);
  // The clocks move while a job runs, once a second and only then.
  const ticking = shape === 'checking' || shape === 'merging';
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  const decide = useMutation({
    mutationFn: ({ door, candidate }: { door: 'confirm' | 'decline' | 'cancel'; candidate: ProjectPromotionView }) =>
      decidePromotion(projectId, candidate.promotionId, door, door === 'confirm' ? { sourceSha: candidate.sourceSha } : {}),
    // Everything the card is drawn from is read again: the candidate, the item holding it, and the
    // project (the merges on record and the line live under its key).
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: projectPromotionQuery(projectId).queryKey }),
        qc.invalidateQueries({ queryKey: projectOpenItemsQuery(projectId).queryKey }),
        qc.invalidateQueries({ queryKey: ['project', projectId] }),
      ]),
  });

  // Kept while open even when the card goes, so a list being read does not vanish under the reader
  // when the merge job it was opened from finishes — and in the same place either way, beside the
  // card, so going does not remount it.
  const jobs = listed || jobsOpen
    ? <LandingJobsSheet projectId={projectId} open={jobsOpen} onClose={() => setJobsOpen(false)} />
    : null;
  // The round's landing session (contract §2.9 LS6): the candidate's own, or the merge job's while
  // the candidate row does not carry one. The whole merge row is this round's way in.
  const roundLanding = promotionLandingSessionId(current, integration.data);
  const mergeJob = (integration.data?.inFlightJobs ?? []).find((job) => isMergeJob(job)) ?? null;
  const mergeJobDetail = integration.data && mergeJob
    ? landingJobLines(integration.data, now, {
        updatedAt: integration.dataUpdatedAt, failed: integration.isError,
      }).find((job) => job.jobId === mergeJob.jobId)?.detail ?? null
    : null;
  // How many jobs this round stands for: the merge's own plus everything queued beside it. The card
  // keeps the others out of sight, so their way in is its foot — "+N job queued · All jobs ›".
  const jobCount = integration.data
    ? integration.data.integratingCount + integration.data.queuedCount
    : 0;
  const queuedLine = listed ? moreJobsQueued(jobCount) : null;
  // §3.3 M-T10: a stop has been asked for and the job has not answered, or the ask came after the
  // push boundary. Both are the card's own facts, never read off the job's phase here.
  const cancelling = current?.cancelRequested === true;
  const tooLate = current?.pushBoundaryPassed === true;
  const abandon = useMutation({
    mutationFn: (jobId: string) => abandonJob(projectId, jobId),
    // The job is over: the card, the item holding it and the round all read again.
    onSettled: () => Promise.all([
      qc.invalidateQueries({ queryKey: projectIntegrationQuery(projectId).queryKey }),
      qc.invalidateQueries({ queryKey: projectOpenItemsQuery(projectId).queryKey }),
      qc.invalidateQueries({ queryKey: projectPromotionQuery(projectId).queryKey }),
      qc.invalidateQueries({ queryKey: ['project', projectId] }),
    ]).then(() => undefined),
  });
  const recheck = useMutation({
    mutationFn: (candidate: ProjectPromotionView) => recheckPromotion(projectId, candidate.promotionId),
    onSettled: () => Promise.all([
      qc.invalidateQueries({ queryKey: projectIntegrationQuery(projectId).queryKey }),
      qc.invalidateQueries({ queryKey: projectOpenItemsQuery(projectId).queryKey }),
      qc.invalidateQueries({ queryKey: projectPromotionQuery(projectId).queryKey }),
      qc.invalidateQueries({ queryKey: ['project', projectId] }),
    ]).then(() => undefined),
  });
  if (shape === null) return <>{null}{jobs}</>;
  const line = integration.data && isMergeJob(inFlight)
    ? landingLine(integration.data, now, { updatedAt: integration.dataUpdatedAt, failed: integration.isError })
    : null;
  // The merge job's live row, in the merged line's own anatomy (owner decision 2026-10-11, board
  // docs/mocks/project-merge-check-row): the head, and — where the server lists the jobs — the whole
  // row as a press. Since 2026-10-19 (方案 A, board v4 04) that press opens THIS ROUND's landing
  // session; a server that names none keeps main's press, the jobs list. No chevron either way.
  const headShape = line ? landingHead(line) : null;
  const head = line && headShape
    ? <LandingHead title={line.word}
        head={cancelling ? { ...headShape, detail: `${headShape.detail} · ${STOP_REQUESTED}` } : headShape}
        running={line.running} timedOut={line.timedOut} />
    : null;
  const landing = line
    ? roundLanding
      ? <LandingLink className="landing-head-press" sessionId={roundLanding}>{head}</LandingLink>
      : listed ? <button type="button" className="landing-head-press" aria-haspopup="dialog"
          onClick={() => setJobsOpen(true)}>{head}</button> : head
    : null;
  const openLanding = roundLanding
    ? <LandingLink className="session-project-merge-link" sessionId={roundLanding} />
    : null;
  // The two doors a TIMED-OUT round offers (board v4 04 c5, c6): a check can be run again — the
  // candidate re-check door, J-T9 through revision 16 — while a merge that stopped at the push has
  // no retry, only the end (J-T10). Both are the owner's; neither is drawn on a live card.
  const timedOut = line?.timedOut === true;
  const timedOutDoors = timedOut ? (
    <div className="session-project-merge-foot">
      {mergeJob?.kind === 'CHECK_PROMOTION' && current ? (
        <button type="button" className="session-project-merge-rerun" disabled={recheck.isPending}
          onClick={() => recheck.mutate(current)}>
          {RERUN_THE_CHECK}
        </button>
      ) : null}
      <span className="spl-spacer" />
      <button type="button" className="session-project-merge-abandon" disabled={abandon.isPending}
        onClick={() => { if (mergeJob) abandon.mutate(mergeJob.jobId); }}>
        {ABANDON}
      </button>
    </div>
  ) : null;
  const item = current ? promotionItem(items.data, current.promotionId) : undefined;
  // Who has it, or null when the read came back and nobody does — then there is no press to draw.
  const resolving = resolvingPress(item, now);
  const inFront = current ? promotionBlockedBy(current, integration.data?.landTasks ?? null) : null;
  const press = (door: 'confirm' | 'decline' | 'cancel'): void => {
    if (current) decide.mutate({ door, candidate: current });
  };
  // What the check running now leads to: the Automatic setting's merge, or the asking card.
  const onPass = shape === 'checking' ? promotionOnPassLine(current) : null;

  return (
    <div className={`session-project-merge is-${shape}${line?.timedOut ? ' is-timed-out' : ''}`} data-shape={shape}>
      {shape === 'checking' ? landing : null}
      {shape === 'checking' && timedOut ? (
        <>
          {/* Where the runner stopped, and — for a check — that nothing could have been pushed. */}
          {mergeJobDetail ? <div className="session-project-merge-note">{mergeJobDetail}</div> : null}
          {timedOutDoors}
        </>
      ) : null}
      {onPass && !(shape === 'checking' && timedOut) ? (
        <div className="session-project-merge-note">{onPass}</div>
      ) : null}
      {shape === 'checking' && !timedOut && queuedLine ? (
        <div className="session-project-merge-foot">
          <span className="session-project-merge-queued">{queuedLine}</span>
          <span className="spl-spacer" />
          <button type="button" className="session-project-merge-link" onClick={() => setJobsOpen(true)}>
            {`${LANDING_ALL_JOBS} ›`}
          </button>
        </div>
      ) : null}
      {shape === 'asking' && current ? (
        <>
          <div className="session-project-merge-head">
            <span className="session-project-merge-tile"><MergeGlyph /></span>
            <span className="session-project-merge-title">{promotionPageTitle(current)}</span>
            <span className="session-project-merge-badge">{NEEDS_YOU}</span>
          </div>
          <div className="session-project-merge-ref" title={current.sourceRef}>{promotionBranchLine(current)}</div>
          <div className="session-project-merge-rule" />
          <div className="session-project-merge-counts">{promotionPageCounts(current)}</div>
          <TaskTitles promotion={current} />
          <div className={`session-project-merge-checks${promotionChecksSummary(current).clean ? ' is-ok' : ''}`}>
            {promotionChecksSummary(current).text}
          </div>
          {criteriaLine ? <div className="session-project-merge-criteria">{criteriaLine}</div> : null}
          <div className="session-project-merge-actions">
            <button type="button" className="session-project-merge-primary" disabled={decide.isPending}
              onClick={() => press('confirm')}>{mergeTo(mainBranchName(current.upstreamRef))}</button>
            <button type="button" disabled={decide.isPending} onClick={() => press('decline')}>{NOT_NOW}</button>
          </div>
          <div className="session-project-merge-foot">
            {current.askedAt ? <span>{`asked ${ago(current.askedAt, now)}`}</span> : <span />}
            <button type="button" className="session-project-merge-link" onClick={() => setDetailsOpen(true)}>
              {`${DETAILS} ›`}
            </button>
          </div>
        </>
      ) : null}
      {shape === 'merging' && current ? (
        <>
          <div className="session-project-merge-head">
            <span className="session-project-merge-tile"><MergeGlyph /></span>
            <span className="session-project-merge-title">
              {cancelling ? (tooLate ? TOO_LATE_TO_CANCEL : CANCELLING_THE_MERGE) : promotionPageTitle(current)}
            </span>
          </div>
          <div className="session-project-merge-status">
            {cancelling && !tooLate ? CANCEL_STOPS_SOON : promotionMergingStatus(current)}
          </div>
          {landing}
          {timedOut ? (
            <>
              {mergeJobDetail ? <div className="session-project-merge-note">{mergeJobDetail}</div> : null}
              {timedOutDoors}
            </>
          ) : (
            <>
              <div className="session-project-merge-note">
                {cancelling ? CANCEL_MAY_STILL_MERGE : PAGE_NOTHING_TO_DO}
              </div>
              {/* While a merge job leads, the Landing card is not drawn (it is the merge's own):
                  the landings queued behind it keep their way in here, the same line the checking
                  card uses. */}
              {!cancelling && queuedLine ? (
                <div className="session-project-merge-foot">
                  <span className="session-project-merge-queued">{queuedLine}</span>
                  <span className="spl-spacer" />
                  <button type="button" className="session-project-merge-link" onClick={() => setJobsOpen(true)}>
                    {`${LANDING_ALL_JOBS} ›`}
                  </button>
                </div>
              ) : null}
              <div className="session-project-merge-foot">
                {cancelling ? (
                  <>
                    {openLanding}
                    <span className="spl-spacer" />
                    <button type="button" disabled>{CANCEL_REQUESTED}</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="session-project-merge-link" onClick={() => setDetailsOpen(true)}>
                      {`${DETAILS} ›`}
                    </button>
                    {openLanding}
                    <span className="spl-spacer" />
                    <button type="button" disabled={decide.isPending || current.execution?.phase === 'PUSH'}
                      onClick={() => press('cancel')}>{CANCEL_MERGE}</button>
                  </>
                )}
              </div>
            </>
          )}
        </>
      ) : null}
      {shape === 'blocked' && current ? (
        <>
          <div className="session-project-merge-head">
            <span className="session-project-merge-title">{promotionPageTitle(current)}</span>
          </div>
          <div className="session-project-merge-status">{promotionBlockedLine(current)}</div>
          {/* Who is in front of it, off the same project read this strip already holds. */}
          {inFront ? <div className="session-project-merge-blocked-by">{inFront}</div> : null}
          {resolving ? (
            <div className={`session-project-merge-press${item && item.assignee !== 'COORDINATOR' ? ' is-yours' : ''}`}>
              {resolving.spinning ? <span className="promotion-spin" aria-hidden="true" /> : null}
              {resolving.label}
            </div>
          ) : null}
          <div className="session-project-merge-foot">
            <button type="button" className="session-project-merge-link" onClick={() => setDetailsOpen(true)}>
              {`${DETAILS} ›`}
            </button>
            {onOpenCoordinator ? (
              <button type="button" className="session-project-merge-link" onClick={onOpenCoordinator}>
                {`${OPEN_COORDINATOR} ›`}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {decide.isError && current ? (
        <div className="session-project-merge-error" role="alert">
          {`${current.sourceRef.replace(/^refs\/heads\//, '')} was not merged — ${(decide.error as Error).message}`}
        </div>
      ) : null}
      {abandon.isError ? (
        <div className="session-project-merge-error" role="alert">
          {`The attempt was not ended — ${(abandon.error as Error).message}`}
        </div>
      ) : null}
      {recheck.isError ? (
        <div className="session-project-merge-error" role="alert">
          {`The check was not re-run — ${(recheck.error as Error).message}`}
        </div>
      ) : null}
      {current ? (
        <Dialog open={detailsOpen} onClose={() => setDetailsOpen(false)} title={promotionHeading(current)}
          className="review-card-dialog" width={720}>
          {/* The project page's card, whole: every row, the criteria tally and the doors. */}
          {detailsOpen ? (
            <div className="review-card-content" data-review-open>
              <ProjectPromotion projectId={projectId} bare />
            </div>
          ) : null}
        </Dialog>
      ) : null}
      {jobs}
    </div>
  );
}

/** The tasks the candidate carries, by name — three at most, then how many more. */
function TaskTitles({ promotion }: { promotion: ProjectPromotionView }): JSX.Element | null {
  const { shown, more } = promotionTaskTitles(promotion);
  const rest = moreTasks(more);
  if (shown.length === 0 && rest === null) return null;
  return (
    <ul className="session-project-merge-tasks">
      {shown.map((title, index) => (
        <li key={`${index}-${title}`}>{title}</li>
      ))}
      {rest ? <li className="is-more">{rest}</li> : null}
    </ul>
  );
}
