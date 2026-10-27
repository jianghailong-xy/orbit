import { createContext, useContext, type ReactNode } from 'react';
import { ArrowRightOutlined } from '@ant-design/icons';
import type { OwnerAnswerCard, ProjectClosedQuestion } from '@orbit/shared';
import { AnsweredQuestionCard } from './CoordinatorQuestionCard';
import { sentToCoordinatorLine } from './EvidenceDecisionCard';
import { answeredItemKey } from '../lib/ownerAnswer';

/**
 * The turn telling a coordinator the owner's answer. Where this conversation can draw the question it
 * answers, the turn is that question's own card, Answered, and nothing else (design:
 * docs/mocks/owner-answer-sent-card/merged.html). Otherwise it is one line — `Sent to the coordinator
 * · 08:29` — instead of the owner's own bubble (docs/mocks/coordinator-question-answered/board.html,
 * 「落地」第 4 条 and 5-landing.png).
 *
 * The owner already reads what they answered on the question's own card. The turn under it is the
 * platform handing that answer on, in words written for the AGENT — the question replayed in full,
 * the answer, an ISO moment — and it used to be drawn as the owner's bubble: the question asked twice,
 * signed with the reader's name. What the reader needs from it is that it was sent and when; the
 * words stay one press away, behind the line, for whoever wants to check what the coordinator read.
 *
 * WHY THE CARD AND NOT A SECOND ONE. The owner reads "Answered" as "the agent has my answer", so a
 * line under the card saying it was sent said the same thing twice. The card is drawn once, by this
 * turn: where the coordinator was handed the answer, which is where its next turn starts, rather than
 * at the moment the owner answered, which falls inside whatever the coordinator was doing then and
 * reads as if it had the answer already. Still on the queue, the card says so; unconfirmed, it says
 * that; the words the agent read are folded at the foot of its review.
 *
 * The line is for what the card cannot be: a question older than the ended ones the open-items read
 * carries, a Not yet… to a request to record the project done (which has no card), and anywhere that
 * reads no open items. It is the pill a version that waited for its coordinator leaves once it is
 * handed over, and says it in the same words and the same clock (`sentToCoordinatorLine`), so a
 * reader sees one sentence for one thing. A native disclosure rather than a dialog, so it still opens
 * in a static export. The native clients draw the same line (OrbitKit `OwnerAnswer`), and
 * `OwnerAnswerCopyParityTests.swift` holds their words to this file's.
 */

/** The heading over the words the coordinator was handed, once the line is opened. */
export const OWNER_ANSWER_TOLD = 'What the coordinator was told';

/**
 * The ended questions this conversation draws, by item key (`answeredItemKey`): the open-items read's `closedQuestions`,
 * handed down by the conversation (WorkspaceView). Without them every such turn is the line.
 */
export const AnsweredQuestionsCtx = createContext<ReadonlyMap<string, ProjectClosedQuestion> | null>(null);

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
  const record = useContext(AnsweredQuestionsCtx)?.get(answeredItemKey(card.itemId));
  if (card.kind === 'COORDINATOR_QUESTION' && record) {
    return (
      <div className="owner-answer-card" data-seq={seq} data-owner-answer={card.itemId}>
        <AnsweredQuestionCard
          record={record}
          handover={{
            queued: Boolean(queued) && !undelivered,
            notice: undelivered ? 'The session has not confirmed it received this.' : null,
            told: (
              <details className="answered-question-told">
                <summary>{OWNER_ANSWER_TOLD}</summary>
                <pre>{text}</pre>
                {attached}
              </details>
            ),
          }}
        />
        {/* No way out of the queue for an answer the owner has already given: Cancel would leave the
            coordinator never told. A delivery that settled undelivered keeps the queue's line, which
            says why. */}
        {undelivered && queued && <div className="owner-answer-queued">{queued}</div>}
      </div>
    );
  }
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
