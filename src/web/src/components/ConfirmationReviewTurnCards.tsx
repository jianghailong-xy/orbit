import type { ReactNode } from 'react';
import { AuditOutlined, CheckCircleFilled, RollbackOutlined } from '@ant-design/icons';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import type {
  ConfirmationAnswersCard,
  ConfirmationReturnCard,
  ConfirmationReviewRequestCard,
} from '@orbit/shared';
import { routeId } from '../lib/idCodec';
import { AppLink } from './AppLink';
import { Button } from './ui/Button';
import { decisionReceiptTime } from './EvidenceDecisionCard';
import {
  ANSWERS_SENT_TO_REVIEWER,
  ANSWER_NOT_SHOWN,
  REVIEWER_FALLBACK,
  REVIEWER_WAS_TOLD,
  REVIEW_PROBLEM,
  REVIEW_REQUESTED,
  SENT_BACK_BY_REVIEWER,
  YOU_CONFIRMED,
  reviewDue,
} from './OwnerConfirmationReview';

/**
 * The three turns a confirmation review puts into a conversation, drawn as the cards they are rather
 * than as the reader's own bubble (docs/owner-confirmation-review-contract.md §2 D7, §8 B6). Nobody
 * typed either: the words are a block Orbit wrote for the agent, which rides at the foot as the
 * control plane's note.
 *
 *  - In the REVIEWER's conversation, `Review requested`: which task's report it is asked to review,
 *    by when, and the way onto the run that reported (`Open task session`, the exception card's own
 *    press).
 *  - In the RUN's conversation, `Sent back by the reviewer`: who sent the report back, why, and each
 *    problem — the reviewer's words, under the reviewer's name, never the owner's.
 *  - In the REVIEWER's conversation again, `You confirmed`: the owner's answers to the reviewer's
 *    questions, handed to it once the owner confirmed (§7 Q5). The words the agent read fold away.
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
          {card.dueAt ? reviewDue(decisionReceiptTime(card.dueAt)) : null}
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

/** One answer as the owner gave it: the option's label, or their own words in quotes. */
export function confirmationAnswerText(answer: ConfirmationAnswersCard['answers'][number]): string {
  return answer.choice ?? `“${answer.text ?? ''}”`;
}

export function YouConfirmedCard({
  card,
  text,
  seq,
  undelivered = false,
  attached,
  queued,
}: {
  card: ConfirmationAnswersCard;
  /** The block the reviewer was handed — the turn's own words, folded at the foot. */
  text: string;
  seq?: number;
  undelivered?: boolean;
  /** Anything delivery appended to the turn, as the control plane's note. */
  attached?: ReactNode;
  queued?: ReactNode;
}) {
  const task = routeId(card.taskId);
  return (
    <div className="crc-wrap">
      <div
        className={`crc is-confirmed${queued ? ' is-queued' : ''}`}
        data-seq={seq}
        data-sticky-label={YOU_CONFIRMED}
        data-sticky-text={card.title}
      >
        <div className="crc-head">
          <span className="crc-mark"><CheckCircleFilled /></span>
          <span>{YOU_CONFIRMED}</span>
          <span className="crc-when">{decisionReceiptTime(card.decidedAt)}</span>
        </div>
        <div className="crc-title">
          {task ? <AppLink to={`/tasks/${encodeURIComponent(task)}`}>{card.title}</AppLink> : card.title}
        </div>
        <div className="crc-lead">{ANSWERS_SENT_TO_REVIEWER}</div>
        <ul className="crc-answers">
          {card.answers.map((answer, index) => (
            <li key={answer.key || index}>
              <div className="crc-answer-question">{answer.question}</div>
              <div className="crc-answer">{confirmationAnswerText(answer)}</div>
              {answer.notShown ? <div className="crc-answer-note">{ANSWER_NOT_SHOWN}</div> : null}
            </li>
          ))}
        </ul>
        {undelivered && <div className="crc-undelivered">The session has not confirmed it received this.</div>}
        {text.trim() !== '' ? (
          <details className="crc-raw">
            <summary>{REVIEWER_WAS_TOLD}</summary>
            <pre>{text}</pre>
          </details>
        ) : null}
        {attached}
        {queued && <div className="crc-queued">{queued}</div>}
      </div>
    </div>
  );
}
