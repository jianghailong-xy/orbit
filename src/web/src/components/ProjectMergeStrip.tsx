import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectPromotionView } from '@orbit/shared';
import { api } from '../api';
import { Dialog } from './ui/Dialog';
import { LandingJobsSheet } from './LandingJobsSheet';
import { LandingRow, LandingRowButton, landingLine } from './ProjectPanoramaHeader';
import {
  CANCEL_MERGE,
  MERGE_TO_MAIN,
  NOT_NOW,
  OPEN_COORDINATOR,
  ProjectPromotion,
  ProjectPromotionReceipt,
  decidePromotion,
  promotionCriteriaLine,
  promotionHeading,
  resolvingPress,
  type PromotionProjectView,
} from './ProjectPromotionCard';
import {
  DETAILS,
  NEEDS_YOU,
  PAGE_NOTHING_TO_DO,
  isMergeJob,
  mergeCardShape,
  moreTasks,
  promotionBlockedLine,
  promotionBranchLine,
  promotionChecksSummary,
  promotionMergingStatus,
  promotionPageCounts,
  promotionPageTitle,
  promotionTaskTitles,
  promotionTimelineDetail,
  promotionTimelineTitle,
} from '../lib/projectMerge';
import { projectIntegrationQuery, projectOpenItemsQuery, projectPromotionQuery } from '../lib/queries';
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
 * row on the view's timeline instead (`ProjectMergeTimelineRow`).
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
  if (shape === null) return <>{null}{jobs}</>;
  const line = integration.data && isMergeJob(inFlight)
    ? landingLine(integration.data, now, { updatedAt: integration.dataUpdatedAt, failed: integration.isError })
    : null;
  const landing = line
    ? listed ? <LandingRowButton line={line} onPress={() => setJobsOpen(true)} /> : <LandingRow line={line} />
    : null;
  const rows = [...(items.data?.needsYou ?? []), ...(items.data?.withCoordinator ?? [])];
  const item = current ? rows.find((row) => row.promotionId === current.promotionId) ?? null : null;
  const press = (door: 'confirm' | 'decline' | 'cancel'): void => {
    if (current) decide.mutate({ door, candidate: current });
  };

  return (
    <div className={`session-project-merge is-${shape}`} data-shape={shape}>
      {shape === 'checking' ? landing : null}
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
              onClick={() => press('confirm')}>{MERGE_TO_MAIN}</button>
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
            <span className="session-project-merge-title">{promotionPageTitle(current)}</span>
          </div>
          <div className="session-project-merge-status">{promotionMergingStatus(current)}</div>
          {landing}
          <div className="session-project-merge-note">{PAGE_NOTHING_TO_DO}</div>
          <div className="session-project-merge-foot">
            <button type="button" className="session-project-merge-link" onClick={() => setDetailsOpen(true)}>
              {`${DETAILS} ›`}
            </button>
            <button type="button" disabled={decide.isPending || current.execution?.phase === 'PUSH'}
              onClick={() => press('cancel')}>{CANCEL_MERGE}</button>
          </div>
        </>
      ) : null}
      {shape === 'blocked' && current ? (
        <>
          <div className="session-project-merge-head">
            <span className="session-project-merge-title">{promotionPageTitle(current)}</span>
          </div>
          <div className="session-project-merge-status">{promotionBlockedLine(current)}</div>
          <div className={`session-project-merge-press${item && item.assignee !== 'COORDINATOR' ? ' is-yours' : ''}`}>
            {resolvingPress(item, now).spinning ? <span className="promotion-spin" aria-hidden="true" /> : null}
            {resolvingPress(item, now).label}
          </div>
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

/**
 * A merge already made, as a row on the project's timeline at the instant it happened: what went
 * onto main and who merged it. Shaped unlike a session row, because it is not one, and a press
 * opens its receipt — the record the conversation's line opens too.
 */
export function ProjectMergeTimelineRow({
  promotion,
  time,
}: {
  promotion: ProjectPromotionView;
  /** The row's time, in the list's own format. */
  time: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="session-row session-project-merge-row" data-promotion={promotion.promotionId}
        onClick={() => setOpen(true)}>
        <span className="session-project-merge-row-mark" aria-hidden="true"><MergeGlyph size={15} /></span>
        <span className="session-project-merge-row-body">
          <span className="session-project-merge-row-head">
            <span className="session-project-merge-row-title">{promotionTimelineTitle(promotion)}</span>
            <span className="session-time">{time}</span>
          </span>
          <span className="session-project-merge-row-detail">{promotionTimelineDetail(promotion)}</span>
        </span>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={promotionHeading(promotion)}
        className="review-card-dialog" width={720}>
        {open ? (
          <div className="review-card-content" data-review-open>
            <ProjectPromotionReceipt promotion={promotion} />
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
