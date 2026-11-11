import type { ReactNode } from 'react';
import type { RunQuestion } from '../lib/runQuestion';

/** A record for the coordinator; answering remains an agent tool operation. */
export function RunQuestionCard({ card, attached, queued }: { card: RunQuestion; attached?: ReactNode; queued?: ReactNode }) {
  const pending = card.state === 'PENDING' && card.approvalStatus === 'PENDING';
  return <div className={`owner-confirmation-review run-question-card${queued ? ' is-queued' : ''}`} data-run-question={card.requestId}>
    <div className="owner-confirmation-key">Run question</div>
    <strong>{card.taskTitle}</strong>
    <div>{pending ? 'Waiting for the coordinator' : 'No longer waiting for the coordinator'}</div>
    {pending ? <div>Reply by {card.replyBy}</div> : null}
    {card.questions.map((question, index) => <section key={index}>
      <strong>{question.question}</strong>
      <div>{question.multiSelect ? 'Choose any that apply' : 'Choose one'}</div>
      <ul>{question.options?.map((option, optionIndex) => <li key={optionIndex}>{option.label}{option.description ? ` — ${option.description}` : ''}</li>)}</ul>
    </section>)}
    {queued ? <div className="run-question-queued">{queued}</div> : null}{attached}
  </div>;
}
