import { useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Input } from 'antd';
import { CardActionButton, CardActions } from './CardAction';
import { api } from '../api';
import { projectOpenItemsQuery } from '../lib/queries';
import { ago } from '../lib/watches';

/**
 * The question a project's coordinator put to the account owner, as a card (mock 5,
 * `docs/mocks/project-progress/05-exceptions-questions.html`; contract §5.2).
 *
 * WHY A CARD AND NOT A MESSAGE. A coordinator that needs the owner to decide something used to say
 * so in its transcript, where it was a paragraph among the paragraphs it writes itself — the owner
 * had to be reading that conversation at that moment to find it, and nothing recorded that an
 * answer was owed. The question is a durable item with the owner on it (`project_open_item`,
 * kind `COORDINATOR_QUESTION`), so it is drawn where the owner already looks: on the project page
 * beside everything else waiting for them, and in the coordinator's own conversation. Both are this
 * one component reading the one door — a second implementation of the same card is a second place
 * for the wording to drift.
 *
 * WHY IT SAYS WHERE IT CAME FROM. `FROM COORDINATOR`, in the mark the criteria card already uses
 * for the same purpose: an agent's turn can write anything into a conversation, so a card asking
 * the owner to decide has to say that the platform filed it and which coordinator asked.
 *
 * NOTHING HERE DECIDES WHO MAY ANSWER. The answer door takes the owner's own credential and
 * refuses an acting session (§5.2 R10); this draws what that door serves and posts to it.
 */

/** What `ask_owner` filed, as the open-items read serves it (§5.2 R7). */
export interface CoordinatorQuestion {
  question: string;
  options: Array<{ label: string; description?: string }>;
  /** Index into `options`; null when the coordinator recommended nothing. */
  recommendedOption: number | null;
  blocksTaskIds: string[];
  ifUnanswered: string | null;
}

/** One open item. Only the fields this card reads — the rest of the row belongs to its own card. */
export interface ProjectOpenItemRow {
  itemId: string;
  kind: string;
  title: string;
  /** The server's own one-liner: what it blocks, and what happens if nobody answers. */
  detailLine: string;
  assignee: 'OWNER' | 'COORDINATOR';
  waitingSince: string;
  /** Present for a `COORDINATOR_QUESTION` and null for every other kind. */
  question: CoordinatorQuestion | null;
}

/** `GET /projects/:id/open-items`, split by who is expected to act (§4.8). */
export interface ProjectOpenItemsView {
  needsYou: ProjectOpenItemRow[];
  withCoordinator: ProjectOpenItemRow[];
}

/** What the answer door hands back: the item is closed, and where the answer went (§5.2 R10). */
export interface OwnerAnswerReceipt {
  itemId: string;
  state: 'RESOLVED';
  resolution: 'ANSWERED';
  /** Null when no conversation coordinates the project: the answer waits for the next one (R11). */
  delivery: { sessionId: string; turnId: string } | null;
}

export const COORDINATOR_QUESTION_HEADING = 'The coordinator has a question';
export const FROM_COORDINATOR = 'FROM COORDINATOR';
/** Why the mark is there, in its own title rather than in a footnote somebody has to find. */
export const FROM_COORDINATOR_TITLE =
  'Orbit filed this question on behalf of the conversation coordinating this project. '
  + 'It is not something an agent turn wrote into this page.';
export const SEND_ANSWER = 'Send answer';
export const RECOMMENDED = 'Recommended';
export const ANSWERED_HEADING = 'Answered';
/** An answer with nobody to tell yet: R11 tells the next coordinator when one is bound. */
export const WAITING_FOR_COORDINATOR = 'waiting for this project’s next coordinator';
export const DELIVERED_TO_COORDINATOR = 'delivered to the current coordinator';

/**
 * The questions on a project's open items. Only the owner's group: a question is filed with the
 * OWNER on it, so one in the coordinator's group would be a row this card cannot be the answer to.
 */
export function coordinatorQuestions(
  items: ProjectOpenItemsView | null | undefined,
): ProjectOpenItemRow[] {
  return (items?.needsYou ?? []).filter(
    (row) => row.kind === 'COORDINATOR_QUESTION' && row.question !== null,
  );
}

function answerOpenItem(
  projectId: string,
  itemId: string,
  body: { option?: number; text?: string },
): Promise<OwnerAnswerReceipt> {
  return api<OwnerAnswerReceipt>(
    `/projects/${encodeURIComponent(projectId)}/open-items/${encodeURIComponent(itemId)}/answer`,
    { method: 'POST', body },
  );
}

/** What the owner chose, in the words the card showed it in. */
function answerInWords(question: CoordinatorQuestion, option: number | null, text: string): string {
  const chosen = option !== null ? question.options[option]?.label : undefined;
  return [chosen, text.trim()].filter(Boolean).join(' — ');
}

export function CoordinatorQuestionCard({
  projectId,
  row,
  now,
}: {
  projectId: string;
  row: ProjectOpenItemRow;
  /** Passed in so a test reads a fixed clock; the page gives it `Date.now()`. */
  now: number;
}): JSX.Element | null {
  const qc = useQueryClient();
  const question = row.question;
  const [chosen, setChosen] = useState<number | null>(question?.recommendedOption ?? null);
  const [text, setText] = useState('');
  const answer = useMutation({
    mutationFn: (body: { option?: number; text?: string }) =>
      answerOpenItem(projectId, row.itemId, body),
    // Answered or refused, the items are re-read: a question somebody answered in another window
    // leaves this page rather than staying pressable.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectOpenItemsQuery(projectId).queryKey });
    },
  });
  if (!question) return null;

  // The receipt this window drew: the read no longer carries the item, and where the answer went is
  // known only to the press that made it (mock 5, the third stage).
  const receipt = answer.data;
  if (receipt) {
    return (
      <div className="approval-card coordinator-question is-answered" id={`question-${row.itemId}`}>
        <div className="approval-head coordinator-question-head">
          <span className="coordinator-question-heading">{ANSWERED_HEADING}</span>
          <span className="criteria-provenance prov-brand" title={FROM_COORDINATOR_TITLE}>
            {FROM_COORDINATOR}
          </span>
        </div>
        <p className="coordinator-question-receipt">
          <span className="coordinator-question-verdict">
            {`✓ ${answerInWords(question, chosen, text) || '(no answer given)'}`}
          </span>
          <span className="coordinator-question-foot">
            {`by you · ${receipt.delivery ? DELIVERED_TO_COORDINATOR : WAITING_FOR_COORDINATOR}`}
          </span>
        </p>
      </div>
    );
  }

  const free = question.options.length === 0;
  const trimmed = text.trim();
  const sendable = free ? trimmed !== '' : chosen !== null;
  const send = () => {
    if (!sendable || answer.isPending) return;
    answer.mutate(free ? { text: trimmed } : { option: chosen!, ...(trimmed ? { text: trimmed } : {}) });
  };

  return (
    <div className="approval-card coordinator-question" id={`question-${row.itemId}`}>
      <div className="approval-head coordinator-question-head">
        <span className="coordinator-question-heading">{COORDINATOR_QUESTION_HEADING}</span>
        <span className="criteria-provenance prov-brand" title={FROM_COORDINATOR_TITLE}>
          {FROM_COORDINATOR}
        </span>
      </div>
      <div className="approval-body coordinator-question-body">
        <p className="coordinator-question-text">{question.question}</p>
        {/* The options are the answer: one tap, with the recommendation marked where it was made
            rather than as a sentence above them. A question asked without any is prose only. */}
        {question.options.map((option, index) => (
          <label
            key={`${index}-${option.label}`}
            className={`coordinator-question-option${chosen === index ? ' is-chosen' : ''}`}
          >
            <input
              type="radio"
              name={`question-${row.itemId}`}
              checked={chosen === index}
              onChange={() => setChosen(index)}
            />
            <span className="coordinator-question-option-text">
              {option.label}
              {index === question.recommendedOption ? (
                <span className="coordinator-question-recommended">{RECOMMENDED}</span>
              ) : null}
              {option.description ? (
                <span className="coordinator-question-option-why">{option.description}</span>
              ) : null}
            </span>
          </label>
        ))}
        {free ? (
          <Input.TextArea
            className="coordinator-question-free"
            value={text}
            maxLength={2000}
            autoSize={{ minRows: 2, maxRows: 8 }}
            placeholder="Your answer"
            onChange={(event) => setText(event.target.value)}
          />
        ) : null}
        {/* What it holds up and what happens if nobody answers, in the server's own words — the
            same line the item's row carries, so the card and the list cannot say different things. */}
        {row.detailLine ? (
          <p className="coordinator-question-meta">{row.detailLine}</p>
        ) : null}
      </div>
      {answer.isError ? (
        <Alert
          type="error"
          showIcon
          className="coordinator-question-error"
          message="That answer was not recorded"
          description={(answer.error as Error).message}
        />
      ) : null}
      <CardActions className="approval-actions coordinator-question-actions">
        <CardActionButton tone="primary" disabled={!sendable || answer.isPending} onClick={send}>
          {SEND_ANSWER}
        </CardActionButton>
        <span className="coordinator-question-asked">{`asked ${ago(row.waitingSince, now)}`}</span>
      </CardActions>
    </div>
  );
}

/**
 * Every question this project has open, drawn wherever the owner is: the project page and the
 * coordinator's own conversation both mount this.
 *
 * It reads nothing without a project — an ordinary session coordinates none and asks the door
 * nothing — and draws nothing while no question is open, so neither host has to know whether there
 * is one.
 */
export function CoordinatorQuestions({
  projectId,
  now = Date.now(),
}: {
  projectId: string | null | undefined;
  now?: number;
}): JSX.Element | null {
  const items = useQuery({
    ...projectOpenItemsQuery(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: 20_000,
  });
  const questions = coordinatorQuestions(items.data);
  if (!projectId || questions.length === 0) return null;
  return (
    <>
      {questions.map((row) => (
        <CoordinatorQuestionCard key={row.itemId} projectId={projectId} row={row} now={now} />
      ))}
    </>
  );
}
