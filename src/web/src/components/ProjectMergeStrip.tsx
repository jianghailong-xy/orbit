import { useEffect, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectPromotionView } from '@orbit/shared';
import { Dialog } from './ui/Dialog';
import { LandingRow, landingLine } from './ProjectPanoramaHeader';
import {
  CANCEL_MERGE,
  MERGE_TO_MAIN,
  NOT_NOW,
  OPEN_COORDINATOR,
  ProjectPromotion,
  ProjectPromotionReceipt,
  decidePromotion,
  promotionHeading,
  resolvingPress,
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
import { encodeId } from '../lib/idCodec';
import { projectIntegrationQuery, projectOpenItemsQuery, projectPromotionQuery } from '../lib/queries';
import { ago } from '../lib/watches';

/** A read the page can draw from: the door answers a candidate or `null`, and anything else is no
 *  candidate rather than one with every field missing. */
function asPromotion(value: unknown): ProjectPromotionView | null {
  return value && typeof value === 'object' && 'promotionId' in value ? (value as ProjectPromotionView) : null;
}

/**
 * The merge into main on the project's sessions view, under the progress strip (owner decision
 * 2026-10-06; mocks in docs/mocks/project-merge-sessions-page). One card at four moments: the merge
 * check running, the candidate asking, merging, or blocked — and nothing at all otherwise; a merge
 * already made is a row on the view's timeline instead (`ProjectMergeTimelineRow`).
 *
 * Its presses are the card's own doors (`decidePromotion`), and Details opens the whole card — the
 * one the project page draws — for anyone who wants every row before pressing. It claims no
 * keyboard chord: ⌘/Ctrl+Enter stays with the card the reader opened.
 */
export function ProjectMergeStrip({
  projectId,
  coordinatorSessionId,
}: {
  projectId: string;
  /** Where a blocked candidate's handling is: the project's coordinator conversation, when listed. */
  coordinatorSessionId: string | null;
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
  const [now, setNow] = useState(() => Date.now());
  const [detailsOpen, setDetailsOpen] = useState(false);
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

  if (shape === null) return null;
  const line = integration.data && isMergeJob(inFlight)
    ? landingLine(integration.data, now, { updatedAt: integration.dataUpdatedAt, failed: integration.isError })
    : null;
  const rows = [...(items.data?.needsYou ?? []), ...(items.data?.withCoordinator ?? [])];
  const item = current ? rows.find((row) => row.promotionId === current.promotionId) ?? null : null;
  const press = (door: 'confirm' | 'decline' | 'cancel'): void => {
    if (current) decide.mutate({ door, candidate: current });
  };

  return (
    <div className={`session-project-merge is-${shape}`} data-shape={shape}>
      {shape === 'checking' && line ? <LandingRow line={line} /> : null}
      {shape === 'asking' && current ? (
        <>
          <div className="session-project-merge-head">
            <span className="session-project-merge-title">{promotionPageTitle(current)}</span>
            <span className="session-project-merge-badge">{NEEDS_YOU}</span>
          </div>
          <div className="session-project-merge-ref" title={current.sourceRef}>{promotionBranchLine(current)}</div>
          <div className="session-project-merge-counts">{promotionPageCounts(current)}</div>
          <TaskTitles promotion={current} />
          <div className={`session-project-merge-checks${promotionChecksSummary(current).clean ? ' is-ok' : ''}`}>
            {promotionChecksSummary(current).text}
          </div>
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
            <span className="promotion-spin" aria-hidden="true" />
            <span className="session-project-merge-title">{promotionPageTitle(current)}</span>
          </div>
          <div className="session-project-merge-status">{promotionMergingStatus(current)}</div>
          {line ? <LandingRow line={line} /> : null}
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
            {coordinatorSessionId ? (
              <Link className="session-project-merge-link" to={`/sessions/${encodeURIComponent(encodeId(coordinatorSessionId))}`}>
                {`${OPEN_COORDINATOR} ›`}
              </Link>
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
        <span className="session-project-merge-row-mark" aria-hidden="true" />
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
