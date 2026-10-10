import type { ReactNode } from 'react';
import { ArrowRightOutlined } from '@ant-design/icons';
import type { OwnerAnswerCard } from '@orbit/shared';
import { sentToCoordinatorLine } from './EvidenceDecisionCard';

/**
 * The turn telling a coordinator the owner's answer, drawn as one line — `Sent to the coordinator ·
 * 08:29` — instead of the owner's own bubble (design: docs/mocks/coordinator-question-answered/
 * board.html, 「落地」第 4 条 and 5-landing.png).
 *
 * The owner already reads what they answered on the question's own card. The turn under it is the
 * platform handing that answer on, in words written for the AGENT — the question replayed in full,
 * the answer, an ISO moment — and it used to be drawn as the owner's bubble: the question asked twice,
 * signed with the reader's name. What the reader needs from it is that it was sent and when; the
 * words stay one press away, behind the line, for whoever wants to check what the coordinator read.
 *
 * The line is the pill a version that waited for its coordinator leaves once it is handed over, and
 * says it in the same words and the same clock (`sentToCoordinatorLine`), so a reader sees one
 * sentence for one thing. A native disclosure rather than a dialog, so it still opens in a static
 * export. The native clients draw the same line (OrbitKit `OwnerAnswer`), and
 * `OwnerAnswerCopyParityTests.swift` holds their words to this file's.
 */

/** The heading over the words the coordinator was handed, once the line is opened. */
export const OWNER_ANSWER_TOLD = 'What the coordinator was told';

export function OwnerAnswerLine({
  card,
  text,
  seq,
  undelivered = false,
  attached,
  queued,
}: {
  card: OwnerAnswerCard;
  /** The words the agent was handed, verbatim — what the line opens to. */
  text: string;
  seq?: number;
  undelivered?: boolean;
  /** What delivery appended to the same turn, as its own folded entry under the words. */
  attached?: ReactNode;
  /** The queue's own line, while the turn still waits behind a running one. */
  queued?: ReactNode;
}) {
  return (
    <div className={`owner-answer${queued ? ' is-queued' : ''}`} data-seq={seq} data-owner-answer={card.itemId}>
      <details className="owner-answer-fold">
        <summary className="owner-answer-line">
          <ArrowRightOutlined aria-hidden="true" />
          <span className="owner-answer-text">{sentToCoordinatorLine(card.deliveredAt)}</span>
          <span className="owner-answer-chev" aria-hidden="true">›</span>
        </summary>
        <div className="owner-answer-told">
          <div className="owner-answer-told-head">{OWNER_ANSWER_TOLD}</div>
          <pre>{text}</pre>
          {attached}
        </div>
      </details>
      {undelivered && (
        <div className="owner-answer-undelivered">The session has not confirmed it received this.</div>
      )}
      {queued && <div className="owner-answer-queued">{queued}</div>}
    </div>
  );
}
