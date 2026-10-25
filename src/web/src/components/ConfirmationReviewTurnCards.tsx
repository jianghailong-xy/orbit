import type { ReactNode } from 'react';
import { AuditOutlined, RollbackOutlined } from '@ant-design/icons';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import type { ConfirmationReturnCard, ConfirmationReviewRequestCard } from '@orbit/shared';
import { routeId } from '../lib/idCodec';
import { AppLink } from './AppLink';
import { Button } from './ui/Button';
import { decisionReceiptTime } from './EvidenceDecisionCard';
import {
  REVIEWER_FALLBACK,
  REVIEW_PROBLEM,
  REVIEW_REQUESTED,
  SENT_BACK_BY_REVIEWER,
  reviewDue,
} from './OwnerConfirmationReview';

/**
 * The two turns a confirmation review puts into a conversation, drawn as the cards they are rather
 * than as the reader's own bubble (docs/owner-confirmation-review-contract.md §2 D7, §8 B6). Nobody
 * typed either: the words are a block Orbit wrote for the agent, which rides at the foot as the
 * control plane's note.
 *
 *  - In the REVIEWER's conversation, `Review requested`: which task's report it is asked to review,
 *    by when, and the way onto the run that reported (`Open task session`, the exception card's own
 *    press).
 *  - In the RUN's conversation, `Sent back by the reviewer`: who sent the report back, why, and each
 *    problem — the reviewer's words, under the reviewer's name, never the owner's.
 */

/** The press onto the run's session — the exception card's words for the same door. */
export const OPEN_TASK_SESSION = 'Open task session';

/**
 * The press itself, where there is a router to route with — a route, so the app does not reload.
 *
 * The hook lives here rather than in the card because `useNavigate` throws outside a router
 * ("may be used only in the context of a <Router> component"), and the card is drawn outside one:
 * the standalone HTML export renders the transcript through `renderToStaticMarkup` into a fresh
 * tree (lib/sessionExport), which is why a reviewer's conversation — the one place a review request
 * appears — could not be exported at all. The card draws this component only inside a router and
 * the whole URL without one, the way AppLink draws every other door on this card.
 */
function OpenTaskSessionPress({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  return (
    <Button size="small" onClick={() => navigate(`/sessions/${encodeURIComponent(sessionId)}`)}>
      {OPEN_TASK_SESSION}
    </Button>
  );
}

export function ReviewRequestedCard({
  card,
  seq,
  ts,
  undelivered = false,
  attached,
  queued,
}: {
  card: ConfirmationReviewRequestCard;
  seq?: number;
  ts?: string;
  undelivered?: boolean;
  /** What delivery appended — the block the reviewer was handed. */
  attached?: ReactNode;
  /** The queue's own line, while the turn still waits behind a running one. */
  queued?: ReactNode;
}) {
  const inRouter = useInRouterContext();
  // Out of a payload read defensively, so through the codec that degrades on a spelling it does not
  // know instead of the one that throws: a card must not take the transcript down with it.
  const task = routeId(card.taskId);
  const run = routeId(card.runSessionId);
  return (
    <div className="crc-wrap">
      <div
        className={`crc${queued ? ' is-queued' : ''}`}
        data-seq={seq}
        data-sticky-label={REVIEW_REQUESTED}
        data-sticky-text={card.title}
      >
        <div className="crc-head">
          <span className="crc-mark"><AuditOutlined /></span>
          <span>{REVIEW_REQUESTED}</span>
        </div>
        <div className="crc-title">
          {task ? <AppLink to={`/tasks/${encodeURIComponent(task)}`}>{card.title}</AppLink> : card.title}
        </div>
        <div className="crc-meta">
          {reviewDue(decisionReceiptTime(card.dueAt))}
          {ts ? ` · ${decisionReceiptTime(ts)}` : ''}
        </div>
        {run ? (
          <div className="crc-actions">
            {inRouter
              ? <OpenTaskSessionPress sessionId={run} />
              : <AppLink to={`/sessions/${encodeURIComponent(run)}`}>{OPEN_TASK_SESSION}</AppLink>}
          </div>
        ) : null}
        {undelivered && <div className="crc-undelivered">The session has not confirmed it received this.</div>}
        {attached}
        {queued && <div className="crc-queued">{queued}</div>}
      </div>
    </div>
  );
}

export function SentBackByReviewerCard({
  card,
  seq,
  ts,
  undelivered = false,
  attached,
  queued,
}: {
  card: ConfirmationReturnCard;
  seq?: number;
  ts?: string;
  undelivered?: boolean;
  attached?: ReactNode;
  queued?: ReactNode;
}) {
  const reviewer = card.reviewerTitle?.trim() || REVIEWER_FALLBACK;
  const reviewerSession = card.reviewerSessionId ? routeId(card.reviewerSessionId) : null;
  return (
    <div className="crc-wrap">
      <div
        className={`crc is-returned${queued ? ' is-queued' : ''}`}
        data-seq={seq}
        data-sticky-label={SENT_BACK_BY_REVIEWER}
        data-sticky-text={card.reason}
      >
        <div className="crc-head">
          <span className="crc-mark"><RollbackOutlined /></span>
          <span>{SENT_BACK_BY_REVIEWER}</span>
          {ts ? <span className="crc-when">{decisionReceiptTime(ts)}</span> : null}
        </div>
        <div className="crc-who">
          {reviewerSession
            ? <AppLink to={`/sessions/${encodeURIComponent(reviewerSession)}`}>{reviewer}</AppLink>
            : reviewer}
        </div>
        {card.reason.trim() !== '' ? <div className="crc-quote">{`“${card.reason}”`}</div> : null}
        {card.problems.length > 0 ? (
          <ul className="crc-problems">
            {card.problems.map((problem, index) => (
              <li key={problem.key || index}>
                <span className="crc-problem-label">{REVIEW_PROBLEM}</span>
                <span>{problem.text}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {undelivered && <div className="crc-undelivered">The session has not confirmed it received this.</div>}
        {attached}
        {queued && <div className="crc-queued">{queued}</div>}
      </div>
    </div>
  );
}
