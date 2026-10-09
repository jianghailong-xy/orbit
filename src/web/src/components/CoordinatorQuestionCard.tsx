import { useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Input } from 'antd';
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  QuestionCircleFilled,
  RightOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  CoordinatorQuestion,
  ProjectClosedQuestion,
  ProjectOpenItemRow,
  ProjectOpenItemsView,
} from '@orbit/shared';
import { CardActionButton, CardActions } from './CardAction';
import { decisionReceiptTime } from './EvidenceDecisionCard';
import { ReviewCard } from './ReviewCard';
import { api } from '../api';
import { decisionReceiptAnchor, type ReceiptPlacement } from '../lib/decisionReceipt';
import { ReferenceLink, referenceUrlTransform } from '../lib/markdownLinks';
import { markdownToPlainText } from '../lib/markdownText';
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
 *
 * WHY THE OPTIONS END WITH "OTHER". The door has always taken words alone, and the box beside the
 * options has always been able to carry them — but a box beside a CHOSEN option reads as a note on
 * it, and that is how a coordinator received "none of these fits" as agreement with the
 * recommendation plus a caveat, and went on to act on it. Naming the row that means "my own words"
 * makes answering in prose a choice the owner makes rather than something this card infers from
 * where the text happened to be typed. It also replaces the gesture this card used to hide here —
 * pressing the chosen option again to take the choice back — which nothing on the card said.
 * (The two shapes it was chosen over: `docs/mocks/coordinator-question-other.html`.)
 */

/**
 * What `ask_owner` filed and the row that carries it, from the one declaration every client reads
 * (`@orbit/shared`, §7.0). Re-exported here because this card was the first reader of the door and
 * the page, the workspace view and the tests import them through it — one shape, one home, and the
 * partial copy this file used to keep cannot drift from the read model any more.
 */
export type {
  CoordinatorQuestion,
  ProjectClosedQuestion,
  ProjectOpenItemRow,
  ProjectOpenItemsView,
} from '@orbit/shared';

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
/** The box beside the options says what its text will be: a note on the choice, or the answer. */
export const NOTE_PROMPT = 'Add a note (optional)';
export const OWN_ANSWER_PROMPT = 'Or type your own answer…';
/** The row this card adds after the coordinator's own: the words are the answer, not a note. */
export const OTHER_OPTION = 'Other — say it in my own words';
export const RECOMMENDED = 'Recommended';
export const ANSWERED_HEADING = 'Answered';
/** An answer with nobody to tell yet: R11 tells the next coordinator when one is bound. */
export const WAITING_FOR_COORDINATOR = 'Waiting for this project’s next coordinator';
export const DELIVERED_TO_COORDINATOR = 'Delivered to the current coordinator';
/** The box a question asked without options is answered in, and the record's read-only copy of it. */
export const YOUR_ANSWER = 'Your answer';

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

/**
 * What the owner settled on: one of the coordinator's options by index, the Other row this card
 * adds — where the words in the box are the answer rather than a note — or, on a question that
 * recommended none of its options, nothing at all.
 */
const OTHER = 'other';
type Choice = number | typeof OTHER | null;

/** The option an answer names, or null when the answer is words alone. */
function optionIndex(chosen: Choice): number | null {
  return typeof chosen === 'number' ? chosen : null;
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
  const [reviewOpen, setReviewOpen] = useState(false);
  const question = row.question;
  const [chosen, setChosen] = useState<Choice>(question?.recommendedOption ?? null);
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

  // Answered from this window: until the read publishes the record (`closedQuestions`) — and drops
  // this row, which unmounts the card — the card is the record of what was sent, built from the
  // question it was sent about, so nothing stands empty in between (§5.2 R10).
  if (answer.data && answer.variables) {
    return (
      <AnsweredQuestionCard
        record={answeredHere(row, question, answer.variables, answer.data, new Date(answer.submittedAt))}
      />
    );
  }

  const free = question.options.length === 0;
  const trimmed = text.trim();
  const chosenOption = optionIndex(chosen);
  // A choice, some text, or both — the door takes any of them. Beside a choice the text is a note on
  // it; on its own it is the answer, which is what the Other row is for. That row with an empty box
  // is not an answer, and the door refuses it (`an answer needs an option or some text`), so the
  // press stays disabled exactly while there is nothing to take.
  const sendable = chosenOption !== null || trimmed !== '';
  const send = () => {
    if (!sendable || answer.isPending) return;
    answer.mutate({
      ...(chosenOption !== null ? { option: chosenOption } : {}),
      ...(trimmed ? { text: trimmed } : {}),
    });
  };

  return (
    <ReviewCard title={COORDINATOR_QUESTION_HEADING} summary={question.question}
      meta={`${question.options.length} options · asked ${ago(row.waitingSince, now)}`}
      id={`question-${row.itemId}`} open={reviewOpen} onOpenChange={setReviewOpen}>
    <div className="approval-card coordinator-question">
      <div className="approval-head coordinator-question-head">
        <span className="coordinator-question-heading">{COORDINATOR_QUESTION_HEADING}</span>
        <span className="criteria-provenance prov-brand" title={FROM_COORDINATOR_TITLE}>
          {FROM_COORDINATOR}
        </span>
      </div>
      <div className="approval-body is-questions coordinator-question-body">
        {/* The question as the coordinator wrote it — the same Markdown the approval cards render
            (`ApprovalPanel`), so bullets and emphasis do not arrive as their raw spelling. */}
        <div className="coordinator-question-text md">
          <Markdown
            remarkPlugins={[remarkGfm]}
            urlTransform={referenceUrlTransform}
            components={{ a: ReferenceLink }}
          >
            {question.question}
          </Markdown>
        </div>
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
        {/* The last row is this card's own, and it is a row rather than a hint because the owner
            has to be able to SEE that answering in their own words is allowed before they type
            them. Choosing it takes the choice off the recommendation: from there the box is the
            answer, and the receipt carries the words with no option in front of them. */}
        {free ? null : (
          <label
            className={`coordinator-question-option${chosen === OTHER ? ' is-chosen' : ''}`}
          >
            <input
              type="radio"
              name={`question-${row.itemId}`}
              checked={chosen === OTHER}
              onChange={() => setChosen(OTHER)}
            />
            <span className="coordinator-question-option-text">{OTHER_OPTION}</span>
          </label>
        )}
        {/* Always there: none of the options may be what the owner wants, and one that is may
            still need a condition said with it. */}
        <Input.TextArea
          className="coordinator-question-free"
          value={text}
          maxLength={2000}
          autoSize={{ minRows: 2, maxRows: 8 }}
          placeholder={
            free ? YOUR_ANSWER : chosenOption !== null ? NOTE_PROMPT : OWN_ANSWER_PROMPT
          }
          onChange={(event) => setText(event.target.value)}
        />
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
    </ReviewCard>
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

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE RECORD A QUESTION BECOMES (§5.2 R10, R12; `docs/mocks/coordinator-question-answered/`)
   ─────────────────────────────────────────────────────────────────────────────────────────────

   Answered — here, at another end, on another device — or withdrawn, a question is no longer drawn
   as a question: the read carries it as a record (`closedQuestions`), and the coordinator's
   conversation draws that record at the moment it ended (`closedQuestionRows`), the way every other
   receipt there is placed (`decisionReceiptAnchor`). The card says what was asked and how it ended;
   its review replays the question and every option as they were asked, with the answer ticked, and
   says who answered, when, and where the answer went where Send answer used to be. The project page
   draws none of these: it lists only the questions still waiting for the owner.

   The words are OrbitKit's too (`CoordinatorQuestions`), held to these declarations by
   `OwnerItemCardsTests`. */

export const WITHDRAWN_HEADING = 'Withdrawn';
/** The review's footer, first line, before its time. */
export const ANSWERED_BY_YOU = 'Answered by you';
export const WITHDRAWN_BY_COORDINATOR = 'Withdrawn by the coordinator';
export const WITHDRAWN_BY_YOU = 'Withdrawn by you';
/** The withdrawn card's line above its reason. */
export const COORDINATOR_WITHDREW = 'The coordinator withdrew it';
export const YOU_WITHDREW = 'You withdrew it';
/** Over the words the owner wrote beside the option they chose. */
export const YOUR_NOTE = 'Your note';
/** The card's last row. */
export const VIEW_DETAILS = 'View details';

const withdrawn = (record: ProjectClosedQuestion): boolean => record.resolution === 'WITHDRAWN';

/** The option the owner chose, when it is one the question offered. */
function chosenOptionOf(record: ProjectClosedQuestion): number | null {
  const option = record.answer?.option;
  return typeof option === 'number' && option >= 0 && option < record.question.options.length
    ? option
    : null;
}

/** What the owner wrote, trimmed; null when they wrote nothing. */
function wordsOf(record: ProjectClosedQuestion): string | null {
  const text = record.answer?.text?.trim();
  return text ? text : null;
}

const quoted = (text: string): string => `“${text}”`;

/** The question's opening as one run of plain text, which the card cuts at two lines. */
export function closedQuestionLead(question: CoordinatorQuestion): string {
  return markdownToPlainText(question.question);
}

/**
 * The card's lines under the lead: the option chosen — or, with no option (the Other row, or a
 * question asked without options), the owner's own words in quotes; the note beside a chosen
 * option, in quotes; an answer no coordinator has had yet (R11); or who withdrew it and why.
 */
export function closedQuestionLines(record: ProjectClosedQuestion): {
  answer: string | null;
  note: string | null;
  waiting: string | null;
  withdrew: string | null;
  reason: string | null;
} {
  if (withdrawn(record)) {
    const reason = record.withdrawReason?.trim();
    return {
      answer: null,
      note: null,
      waiting: null,
      withdrew: record.resolvedBy === 'USER' ? YOU_WITHDREW : COORDINATOR_WITHDREW,
      reason: reason ? quoted(reason) : null,
    };
  }
  const option = chosenOptionOf(record);
  const said = wordsOf(record);
  return {
    answer: option !== null ? record.question.options[option]!.label : said ? quoted(said) : null,
    note: option !== null && said ? quoted(said) : null,
    waiting: record.delivery ? null : WAITING_FOR_COORDINATOR,
    withdrew: null,
    reason: null,
  };
}

/** The review's footer, where Send answer was: who ended it and when, then where the answer went —
 *  or the reason it was withdrawn with. `waiting` marks the line that is still owed somewhere. */
export function closedQuestionFooter(
  record: ProjectClosedQuestion,
  now: Date = new Date(),
): { line: string; detail: string | null; waiting: boolean } {
  const who = withdrawn(record)
    ? record.resolvedBy === 'USER' ? WITHDRAWN_BY_YOU : WITHDRAWN_BY_COORDINATOR
    : ANSWERED_BY_YOU;
  const line = `${who} · ${decisionReceiptTime(record.resolvedAt, now)}`;
  if (withdrawn(record)) return { line, detail: closedQuestionLines(record).reason, waiting: false };
  return {
    line,
    detail: record.delivery ? DELIVERED_TO_COORDINATOR : WAITING_FOR_COORDINATOR,
    waiting: !record.delivery,
  };
}

/**
 * The answer THIS window just sent, as the record the read will publish: the question it was sent
 * about, what was chosen and written, and where the door says it went. Drawn from the press until
 * the read comes back with its own copy.
 */
export function answeredHere(
  row: ProjectOpenItemRow,
  question: CoordinatorQuestion,
  body: { option?: number; text?: string },
  receipt: OwnerAnswerReceipt,
  at: Date = new Date(),
): ProjectClosedQuestion {
  const moment = at.toISOString();
  return {
    itemId: row.itemId,
    question,
    askedAt: row.waitingSince,
    resolution: 'ANSWERED',
    resolvedBy: 'USER',
    resolvedAt: moment,
    answer: { option: body.option ?? null, text: body.text ?? null },
    delivery: receipt.delivery ? { sessionId: receipt.delivery.sessionId, at: moment } : null,
    withdrawReason: null,
  };
}

/** One ended question the coordinator's conversation draws, and where in its flow it goes. */
export interface ClosedQuestionRow {
  record: ProjectClosedQuestion;
  placement: ReceiptPlacement;
}

/** The records an open coordinator conversation draws: every ended question the read carries, at
 *  the moment it ended. A stamp nothing can place is not drawn in the wrong place. */
export function closedQuestionRows(
  items: ProjectOpenItemsView | null | undefined,
  events: ReadonlyArray<{ seq: number; ts?: string }>,
): ClosedQuestionRow[] {
  return (items?.closedQuestions ?? []).flatMap((record) => {
    const placement = decisionReceiptAnchor(events, record.resolvedAt);
    return placement === null ? [] : [{ record, placement }];
  });
}

/** One option as it was offered, ticked when it is the answer, with the owner's words inside. */
function RecordOption({ label, why, recommended, chosen, said, saidLabel }: {
  label: string;
  why?: string;
  recommended: boolean;
  chosen: boolean;
  said: string | null;
  saidLabel: string | null;
}): JSX.Element {
  return (
    <div className={`answered-question-option${chosen ? ' is-chosen' : ''}`}>
      <span className="answered-question-mark" aria-hidden="true">
        {chosen ? <CheckCircleFilled /> : null}
      </span>
      <span className="answered-question-option-text">
        <span className="answered-question-option-label">{label}</span>
        {recommended ? <span className="answered-question-recommended">{RECOMMENDED}</span> : null}
        {why ? <span className="coordinator-question-option-why">{why}</span> : null}
        {said ? (
          <span className="answered-question-words">
            {saidLabel ? <span className="answered-question-words-label">{saidLabel}</span> : null}
            {said}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * An ended question, as the conversation draws it: the card, and the review it opens. `now` is
 * passed in so a test reads a fixed clock.
 */
export function AnsweredQuestionCard({
  record,
  now = new Date(),
}: {
  record: ProjectClosedQuestion;
  now?: Date;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const isWithdrawn = withdrawn(record);
  const heading = isWithdrawn ? WITHDRAWN_HEADING : ANSWERED_HEADING;
  const lead = closedQuestionLead(record.question);
  const lines = closedQuestionLines(record);
  const footer = closedQuestionFooter(record, now);
  const option = isWithdrawn ? null : chosenOptionOf(record);
  const said = isWithdrawn ? null : wordsOf(record);
  const { question } = record;
  const choseOther = option === null && said !== null && question.options.length > 0;
  return (
    <ReviewCard
      title={heading}
      summary={lead}
      id={`question-record-${record.itemId}`}
      open={open}
      onOpenChange={setOpen}
      preview={{
        className: `answered-question-card${isWithdrawn ? ' is-withdrawn' : ''}`,
        content: (
          <>
            <span className="answered-question-head">
              <span className="answered-question-icon" aria-hidden="true"><QuestionCircleFilled /></span>
              <span className="answered-question-heading">{heading}</span>
              <span className="answered-question-time">{decisionReceiptTime(record.resolvedAt, now)}</span>
            </span>
            <span className="answered-question-lead">{lead}</span>
            {lines.answer ? (
              <span className="answered-question-answer">
                <span className="answered-question-tick" aria-hidden="true"><CheckCircleFilled /></span>
                <span>{lines.answer}</span>
              </span>
            ) : null}
            {lines.note ? <span className="answered-question-note">{lines.note}</span> : null}
            {lines.waiting ? (
              <span className="answered-question-waiting">
                <ClockCircleOutlined aria-hidden="true" /> {lines.waiting}
              </span>
            ) : null}
            {lines.withdrew ? <span className="answered-question-withdrew">{lines.withdrew}</span> : null}
            {lines.reason ? <span className="answered-question-reason">{lines.reason}</span> : null}
            <span className="answered-question-open">
              {VIEW_DETAILS}
              <RightOutlined aria-hidden="true" />
            </span>
          </>
        ),
      }}
    >
      <div className="approval-card coordinator-question answered-question" data-question-record={record.itemId}>
        <div className="approval-body is-questions coordinator-question-body">
          <div className="answered-question-provenance">
            <span className="criteria-provenance prov-brand" title={FROM_COORDINATOR_TITLE}>
              {FROM_COORDINATOR}
            </span>
            <span className="answered-question-asked">{`asked ${decisionReceiptTime(record.askedAt, now)}`}</span>
          </div>
          {/* The question as it was asked, in the Markdown the open card renders it in. */}
          <div className="coordinator-question-text md">
            <Markdown
              remarkPlugins={[remarkGfm]}
              urlTransform={referenceUrlTransform}
              components={{ a: ReferenceLink }}
            >
              {question.question}
            </Markdown>
          </div>
          {question.options.map((offered, index) => (
            <RecordOption
              key={`${index}-${offered.label}`}
              label={offered.label}
              why={offered.description}
              recommended={index === question.recommendedOption}
              chosen={option === index}
              said={option === index ? said : null}
              saidLabel={YOUR_NOTE}
            />
          ))}
          {choseOther ? (
            <RecordOption label={OTHER_OPTION} recommended={false} chosen said={said} saidLabel={null} />
          ) : null}
          {question.options.length === 0 && said ? (
            <span className="answered-question-words is-free">
              <span className="answered-question-words-label">{YOUR_ANSWER}</span>
              {said}
            </span>
          ) : null}
        </div>
        <div className="card-actions approval-actions answered-question-footer">
          <span className="answered-question-footer-line">
            {isWithdrawn ? <RollbackOutlined aria-hidden="true" /> : <CheckCircleFilled aria-hidden="true" />}
            {footer.line}
          </span>
          {footer.detail ? (
            <span className={`answered-question-footer-detail${footer.waiting ? ' is-waiting' : ''}`}>
              {footer.detail}
            </span>
          ) : null}
        </div>
      </div>
    </ReviewCard>
  );
}
