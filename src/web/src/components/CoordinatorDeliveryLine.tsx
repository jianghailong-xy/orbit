import type { ReactNode } from 'react';
import { ArrowRightOutlined } from '@ant-design/icons';
import type { CoordinatorDeliveryCard } from '@orbit/shared';
import { AppLink } from './AppLink';
import { decisionReceiptTime, sentToCoordinatorLine } from './EvidenceDecisionCard';
import { OWNER_ANSWER_TOLD } from './OwnerAnswerLine';
import {
  COORDINATOR_DELIVERY_ITS_TASK,
  COORDINATOR_DELIVERY_SENT_TO_SESSION,
  COORDINATOR_DELIVERY_SESSION_TOLD,
  coordinatorDeliverySentence,
} from '../lib/coordinatorDelivery';
import { routeId } from '../lib/idCodec';

/**
 * A turn Orbit wrote to tell a session about a committed fact — a fact a project's coordinator is told,
 * or the answer to a session's criteria proposal — drawn as one line instead of the owner's own bubble
 * (design: docs/mocks/coordinator-delivery-line/, approved 2026-10-31):
 *
 *   → Evidence revision 1 submitted: <task> · Sent to the coordinator · 07:30 PM ›
 *
 * The words under it are written for the AGENT — a headline, then paragraphs of protocol — and drawn
 * as the owner's bubble they filled a screen with words the owner never wrote. What the reader needs
 * from the turn is what happened and when it was sent; the words stay one press away, behind the line,
 * under the heading the owner's answer uses, with the task the fact names linked at their foot.
 *
 * The pill is the owner's answer's (`OwnerAnswerLine`): the same classes under a root of its own, dashed
 * while the turn still waits on the queue, with the queue's own line under it. The sentence gives way with an ellipsis and
 * `Sent to the coordinator · 07:30 PM` does not (`sentToCoordinatorLine`, the receipt clock); at phone
 * width the two take a row each, the sentence first.
 *
 * Unlike the owner's answer, this line heads a round (`data-orbit-round`): the reply under it answers
 * it, so once it is scrolled past the sticky bar hides rather than naming an earlier question — and
 * never names this line either, which nobody typed. A queued twin is skipped like any queued turn.
 *
 * Undelivered, it says so in the words every Orbit card uses and offers nothing to put back in the
 * composer: the words are the platform's, not the reader's.
 *
 * Where this conversation is not the project's coordinator (`toCoordinator: false`) — the owner's
 * answer to a criteria proposal a task's run filed — the line says `Sent to this session · 07:30 PM`
 * and opens to `What this session was told`, on the same clock: it went to the conversation the
 * reader is looking at, and saying the coordinator would be false.
 */
export function CoordinatorDeliveryLine({
  card,
  text,
  seq,
  undelivered = false,
  attached,
  queued,
}: {
  card: CoordinatorDeliveryCard;
  /** The words the agent was handed, verbatim — what the line opens to. */
  text: string;
  seq?: number;
  undelivered?: boolean;
  /** What delivery appended to the same turn, as its own folded entry under the words. */
  attached?: ReactNode;
  /** The queue's own line, while the turn still waits behind a running one. */
  queued?: ReactNode;
}) {
  const sentence = coordinatorDeliverySentence(card);
  const taskPublic = card.task ? routeId(card.task.id) : null;
  return (
    <div
      className={`coordinator-delivery${queued ? ' is-queued' : ''}`}
      data-seq={seq}
      data-coordinator-delivery={card.kind}
      data-orbit-round
    >
      <details className="owner-answer-fold">
        <summary className="owner-answer-line" title={sentence}>
          <ArrowRightOutlined aria-hidden="true" />
          <span className="coordinator-delivery-words">
            <span className="owner-answer-text coordinator-delivery-sentence">{sentence}</span>
            <span className="coordinator-delivery-sep" aria-hidden="true">·</span>
            <span className="coordinator-delivery-sent">{sentLine(card)}</span>
          </span>
          <span className="owner-answer-chev" aria-hidden="true">›</span>
        </summary>
        <div className="owner-answer-told">
          <div className="owner-answer-told-head">
            {card.toCoordinator ? OWNER_ANSWER_TOLD : COORDINATOR_DELIVERY_SESSION_TOLD}
          </div>
          <pre>{text}</pre>
          {attached}
          {taskPublic && (
            <AppLink className="coordinator-delivery-task" to={`/tasks/${encodeURIComponent(taskPublic)}`}>
              {COORDINATOR_DELIVERY_ITS_TASK}
            </AppLink>
          )}
        </div>
      </details>
      {undelivered && (
        <div className="owner-answer-undelivered">The session has not confirmed it received this.</div>
      )}
      {queued && <div className="owner-answer-queued">{queued}</div>}
    </div>
  );
}

/** Where it was sent, then when: the coordinator, or this session where the conversation is not one. */
function sentLine(card: CoordinatorDeliveryCard): string {
  return card.toCoordinator
    ? sentToCoordinatorLine(card.deliveredAt)
    : `${COORDINATOR_DELIVERY_SENT_TO_SESSION} · ${decisionReceiptTime(card.deliveredAt)}`;
}
