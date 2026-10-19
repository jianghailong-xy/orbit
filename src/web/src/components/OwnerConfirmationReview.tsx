import { useState, type JSX, type ReactNode } from 'react';
import { ClockCircleOutlined, DownOutlined, MinusCircleOutlined, RightOutlined } from '@ant-design/icons';
import type {
  ConfirmationNeedsYouItem,
  ConfirmationReviewHeadline,
  ConfirmationReviewItem,
  ConfirmationReviewLists,
  OwnerConfirmationAnswer,
  OwnerConfirmationNotReviewedReason,
  OwnerConfirmationReviewView,
} from '@orbit/shared';
import { OTHER_OPTION, RECOMMENDED } from './CoordinatorQuestionCard';
import { decisionReceiptTime } from './EvidenceDecisionCard';
import { Textarea } from './ui/Textarea';

/**
 * The review bar of the owner-confirmation card (docs/owner-confirmation-review-contract.md §6–§9).
 *
 * WHO WROTE WHAT
 * --------------
 * A run that declares its work finished is reviewed before its owner is asked: the project's
 * coordinator conversation, or the conversation the task was filed from. What that reviewer hands
 * back is drawn here, between what the agent said and If you confirm, in a box that names it —
 * `REVIEW · <reviewer> · <time>` and the commit it read. Everything inside the box under the first
 * line is the reviewer's own words, as written; the first line is Orbit's, worked out from the
 * reviewer's lists rather than written by it (option B: what is left, before what the reviewer
 * thinks), so a sentence of the reviewer's can never stand where "1 not checked" should.
 *
 * NOTHING HERE LOCKS THE DOOR
 * ---------------------------
 * Under review, not reviewed or out of date, the buttons below are the same buttons. The one thing
 * a review adds to the press is the owner's answers to the questions only they can decide, which
 * ride with Confirm done; the card preselects each recommendation, so a press is never blocked by a
 * review — only by an Other the owner picked and has not written yet (§6 H4).
 *
 * The bar's lines are data before they are elements (`reviewBar`), and that data is proved against
 * `src/shared/src/owner-confirmation-review.fixture.json` here and in OrbitKit, so the browser, the
 * Mac and the phone say the same sentences. `OwnerConfirmationCopyParityTests` reads the words below.
 */

/** What a run's session row, its header and its task's pointer say while its report is still with
 *  its reviewer (§5 N3): the card is there and can be pressed, but nobody is asking the owner yet. */
export const UNDER_REVIEW = 'Under review';
/** The review bar's label, ahead of who wrote it: a box key like WHAT THE AGENT SAID. */
export const REVIEW_HEADING = 'REVIEW';
/** The reviewer's name when its conversation's title cannot be read (§1 S5). */
export const REVIEWER_FALLBACK = 'Reviewer';
export const REVIEWING_SINCE = 'Reviewing since';
export const REVIEW_WILL_ASK = 'Orbit will ask you once the review is in. You can still confirm now.';
/** Under a receipt the decision is made, so "Orbit will ask you" no longer holds (§9 L3). */
export const REVIEW_WILL_SHOW_HERE = 'It will show here when it comes in.';
export const REVIEW_NEEDS_YOU = 'Needs you: ';
export const REVIEW_NOTHING_NEEDS_YOU = 'nothing needs you';
export const REVIEW_CHECKED = 'Checked';
export const REVIEW_NOT_CHECKED = 'Not checked';
export const REVIEW_LEFT_OPEN = 'Left open';
export const REVIEW_PROBLEM = 'Problem';
export const NOT_REVIEWED = 'Not reviewed';
export const NOT_REVIEWED_TAIL = ' Only the agent that did the work has checked this.';
/** Why nobody reviewed it, one sentence per reason (§6 H3); a window that ran out says its length. */
export const NOT_REVIEWED_REVIEWER_ENDED = 'The reviewer’s session ended before it answered.';
export const NOT_REVIEWED_REVIEWER_STOPPED = 'The reviewer stopped without answering.';
export const NOT_REVIEWED_COORDINATOR_PAUSED = 'This project’s coordinator is paused.';
export const NOT_REVIEWED_AUTOMATIC_OFF = 'Automatic was switched off for this project.';
export const NOT_REVIEWED_NO_COORDINATOR = 'This project has no coordinator conversation.';
export const NOT_REVIEWED_UNREACHABLE = 'The reviewer could not be reached.';
export const REVIEW_OUTDATED = 'Outdated';
export const REVIEW_EARLIER_REPORT = 'Written for an earlier report.';
export const SHOW_OLD_REVIEW = 'Show the old review';
/** A reviewer sent the report back to the run: the card is a record now (§8 B6). */
export const RETURNED_TO_AGENT = 'Returned to the agent';
export const RETURNED_FOOTER = 'The agent got this as its next message. You were not asked.';
/** The card the return draws in the run's own conversation (§8 B6). */
export const SENT_BACK_BY_REVIEWER = 'Sent back by the reviewer';
/** The fold over a question's evidence (§7 Q2). */
export const REVIEW_EVIDENCE = 'Evidence';
export const ANSWERS_SENT_WITH_CONFIRM = 'Your answers are sent with Confirm done.';
/** What a receipt lists the owner's answers under (§7 Q5). */
export const YOUR_ANSWERS = 'Your answers';
export const ANSWER_NOT_SHOWN = 'Not shown to you — the recommended answer was recorded.';
export const BEFORE_REVIEW = 'Before the review came in';
/** The card the reviewer's own conversation draws for the turn that asks it to review (§2 D7). */
export const REVIEW_REQUESTED = 'Review requested';

export function reviewingSince(time: string): string {
  return `${REVIEWING_SINCE} ${time}`;
}

export function reviewNeedsYouLine(text: string, more: number): string {
  return more > 0 ? `${REVIEW_NEEDS_YOU}${text} (+${more} more)` : `${REVIEW_NEEDS_YOU}${text}`;
}

export function reviewNothingNeedsYouLine(notChecked: number): string {
  return `${notChecked} not checked · ${REVIEW_NOTHING_NEEDS_YOU}`;
}

/** The first line under a receipt once the reviewer found problems after the confirmation (§9). */
export function problemsFoundLine(problems: number): string {
  return problems === 1
    ? '1 problem found after you confirmed'
    : `${problems} problems found after you confirmed`;
}

export function noAnswerWithin(window: string): string {
  return `No answer within ${window}.`;
}

export function writtenFor(reviewed: string, now: string): string {
  return `Written for ${reviewed}. The branch is at ${now} now, so this says nothing about the last commit.`;
}

export function reviewDue(time: string): string {
  return `Due ${time}`;
}

/** The session row's line while its report is with its reviewer (§5 N3). */
export function underReviewLine(reviewerTitle: string | null | undefined): string {
  return `${UNDER_REVIEW} · ${reviewerName(reviewerTitle)}`;
}

/** A review window, as `No answer within <window>.` says it: `30 min`, `2 h`, `1 h 30 min`. */
export function reviewWindowWords(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const NOT_REVIEWED_SENTENCE: Record<Exclude<OwnerConfirmationNotReviewedReason, 'TIMED_OUT'>, string> = {
  REVIEWER_ENDED: NOT_REVIEWED_REVIEWER_ENDED,
  REVIEWER_STOPPED: NOT_REVIEWED_REVIEWER_STOPPED,
  COORDINATOR_PAUSED: NOT_REVIEWED_COORDINATOR_PAUSED,
  AUTOMATIC_OFF: NOT_REVIEWED_AUTOMATIC_OFF,
  NO_COORDINATOR: NOT_REVIEWED_NO_COORDINATOR,
  UNREACHABLE: NOT_REVIEWED_UNREACHABLE,
};

/** Why nobody reviewed it, then who has checked it. A reason this build does not know says the
 *  second half alone rather than a guess at the first. */
export function notReviewedNote(
  reason: OwnerConfirmationNotReviewedReason | null,
  windowSeconds: number,
): string {
  const why = reason === 'TIMED_OUT'
    ? noAnswerWithin(reviewWindowWords(windowSeconds))
    : (reason && NOT_REVIEWED_SENTENCE[reason]) || '';
  return `${why}${NOT_REVIEWED_TAIL}`.trim();
}

function reviewerName(title: string | null | undefined): string {
  return title?.trim() || REVIEWER_FALLBACK;
}

function shortSha(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 7) : null;
}

// ── The bar, as data ────────────────────────────────────────────────────────────────────────────

/** Where a review is drawn: on the card that asks, or under the receipt a decision left. */
export type ReviewPlace = 'CARD' | 'RECEIPT';
export type ReviewRowKind = 'CHECKED' | 'NOT_CHECKED' | 'LEFT_OPEN' | 'PROBLEM';

/**
 * One line of the bar, in the order it is drawn. STATUS is a state word with its symbol, NOTE the
 * quieter sentence under it, HEADLINE Orbit's first line, ANSWERS the place the card draws its
 * answer blocks, ROW one of the reviewer's lists (the items it stands for are `keys`), QUOTE the
 * reviewer's own sentence and FOOTER what Orbit says last.
 */
export type ReviewBarLine =
  | { kind: 'STATUS'; icon?: 'CLOCK' | 'DASH'; text: string; warn: boolean }
  | { kind: 'NOTE'; text: string }
  | { kind: 'HEADLINE'; text: string; warn: boolean }
  | { kind: 'ANSWERS'; text: '' }
  | { kind: 'ROW'; row: ReviewRowKind; label: string; text: string; keys: string[] }
  | { kind: 'QUOTE'; text: string }
  | { kind: 'FOOTER'; text: string };

export interface ReviewBar {
  /** The reviewer's name: `REVIEW · <reviewer>`. */
  reviewer: string;
  /** When the record drawn was written; null while there is none. */
  time: string | null;
  /** The commit that record was written for, first 7; null when it named none. */
  sha: string | null;
  /** Struck through: the record no longer describes what is waiting. */
  shaStruck: boolean;
  lines: ReviewBarLine[];
  /** The old review, behind `Show the old review`. */
  folded: ReviewBarLine[];
  /** The bar offers Reopen task, once the task has settled (§9 L4). */
  reopen: boolean;
}

const ROW_LABEL: Record<ReviewRowKind, string> = {
  CHECKED: REVIEW_CHECKED,
  NOT_CHECKED: REVIEW_NOT_CHECKED,
  LEFT_OPEN: REVIEW_LEFT_OPEN,
  PROBLEM: REVIEW_PROBLEM,
};

/** Orbit's first line, from the headline the server worked out of the reviewer's lists (§6 H2). */
export function reviewHeadlineLine(headline: ConfirmationReviewHeadline): { text: string; warn: boolean } {
  switch (headline.kind) {
    case 'NEEDS_YOU':
      return { text: reviewNeedsYouLine(headline.text, headline.more), warn: true };
    case 'NOTHING_NEEDS_YOU':
      return { text: reviewNothingNeedsYouLine(headline.notChecked), warn: false };
    case 'PROBLEMS_AFTER_CONFIRM':
      return { text: problemsFoundLine(headline.problems), warn: true };
  }
}

/** A REVIEW record's own headline: the server's, unless that one is about problems found later. */
function recordHeadline(review: OwnerConfirmationReviewView): ConfirmationReviewHeadline | null {
  const record = review.review;
  if (!record) return null;
  if (review.headline && review.headline.kind !== 'PROBLEMS_AFTER_CONFIRM') return review.headline;
  const [first] = record.needsYou;
  return first
    ? { kind: 'NEEDS_YOU', text: first.text, more: record.needsYou.length - 1 }
    : { kind: 'NOTHING_NEEDS_YOU', notChecked: record.notChecked.length };
}

/** Checked / Not checked / Left open, each one row of its lines joined; a list with none, no row. */
function listRows(lists: ConfirmationReviewLists): ReviewBarLine[] {
  const rows: Array<[ReviewRowKind, ConfirmationReviewItem[]]> = [
    ['CHECKED', lists.checked],
    ['NOT_CHECKED', lists.notChecked],
    ['LEFT_OPEN', lists.leftOpen],
  ];
  return rows.flatMap(([row, items]) => (items.length === 0
    ? []
    : [{
        kind: 'ROW' as const,
        row,
        label: ROW_LABEL[row],
        text: items.map((item) => item.text).join(' · '),
        keys: items.map((item) => item.key),
      }]));
}

/** One row per problem: each is a thing to fix, not one of a list. */
function problemRows(problems: ConfirmationReviewItem[]): ReviewBarLine[] {
  return problems.map((item) => ({
    kind: 'ROW' as const,
    row: 'PROBLEM' as const,
    label: REVIEW_PROBLEM,
    text: item.text,
    keys: [item.key],
  }));
}

/** The record's lines in their order: Orbit's first line, the card's answers, the lists, the quote. */
function recordLines(review: OwnerConfirmationReviewView, answers: boolean): ReviewBarLine[] {
  const record = review.review;
  if (!record) return [];
  const headline = recordHeadline(review);
  return [
    ...(headline ? [{ kind: 'HEADLINE' as const, ...reviewHeadlineLine(headline) }] : []),
    ...(answers && record.needsYou.length > 0 ? [{ kind: 'ANSWERS' as const, text: '' as const }] : []),
    ...listRows(record),
    ...(record.judgment.trim() !== '' ? [{ kind: 'QUOTE' as const, text: record.judgment }] : []),
  ];
}

/**
 * What the bar draws for one review, where it is drawn (§6 H3, §8 B6, §9 L3). `clock` writes an
 * instant as the card writes its times; it answers null for one it cannot read.
 */
export function reviewBar(
  review: OwnerConfirmationReviewView,
  place: ReviewPlace,
  clock: (iso: string) => string | null,
): ReviewBar {
  const bar = (time: string | null, sha: string | null, lines: ReviewBarLine[], more: Partial<ReviewBar> = {}): ReviewBar => ({
    reviewer: reviewerName(review.reviewer.title),
    time,
    sha: shortSha(sha),
    shaStruck: false,
    lines,
    folded: [],
    reopen: false,
    ...more,
  });
  // Under a receipt, problems the reviewer found after the confirmation outrank whatever state the
  // review is in: they are what the owner has to act on, and Reopen task is how.
  if (place === 'RECEIPT' && review.problems) {
    const found = review.problems;
    return bar(clock(found.recordedAt), found.reviewedSha, [
      { kind: 'HEADLINE', text: problemsFoundLine(found.problems.length), warn: true },
      ...problemRows(found.problems),
    ], { reopen: true });
  }
  switch (review.state) {
    case 'UNDER_REVIEW': {
      const since = clock(review.since);
      return bar(null, null, [
        { kind: 'STATUS', icon: 'CLOCK', text: since ? reviewingSince(since) : UNDER_REVIEW, warn: false },
        { kind: 'NOTE', text: place === 'CARD' ? REVIEW_WILL_ASK : REVIEW_WILL_SHOW_HERE },
      ]);
    }
    case 'NOT_REVIEWED':
      return bar(null, null, [
        { kind: 'STATUS', icon: 'DASH', text: NOT_REVIEWED, warn: false },
        { kind: 'NOTE', text: notReviewedNote(review.notReviewedReason, review.windowSeconds) },
      ]);
    case 'RETURNED': {
      const returned = review.returned;
      return bar(returned ? clock(returned.recordedAt) : null, returned?.reviewedSha ?? null, [
        { kind: 'STATUS', text: RETURNED_TO_AGENT, warn: false },
        ...(returned && returned.reason.trim() !== '' ? [{ kind: 'QUOTE' as const, text: returned.reason }] : []),
        ...problemRows(returned?.problems ?? []),
        { kind: 'FOOTER', text: RETURNED_FOOTER },
      ]);
    }
    case 'OUTDATED': {
      const record = review.review;
      const outdated = review.outdated;
      const note = outdated?.cause === 'NEWER_REPORT'
        ? REVIEW_EARLIER_REPORT
        : record?.reviewedSha && outdated?.branchSha
          ? writtenFor(shortSha(record.reviewedSha)!, shortSha(outdated.branchSha)!)
          : null;
      return bar(record ? clock(record.recordedAt) : null, record?.reviewedSha ?? null, [
        { kind: 'STATUS', text: REVIEW_OUTDATED, warn: true },
        ...(note ? [{ kind: 'NOTE' as const, text: note }] : []),
      ], { shaStruck: true, folded: recordLines(review, false) });
    }
    case 'REVIEWED': {
      const record = review.review;
      return bar(record ? clock(record.recordedAt) : null, record?.reviewedSha ?? null,
        recordLines(review, place === 'CARD'));
    }
  }
}

/** Every item the bar's rows can name, by key: the review's lists and the problems of either kind. */
function itemsByKey(review: OwnerConfirmationReviewView): Map<string, ConfirmationReviewItem> {
  const record = review.review;
  const items = [
    ...(record ? [...record.checked, ...record.notChecked, ...record.needsYou, ...record.leftOpen] : []),
    ...(review.returned?.problems ?? []),
    ...(review.problems?.problems ?? []),
  ];
  return new Map(items.map((item) => [item.key, item]));
}

// ── The owner's answers (§7) ────────────────────────────────────────────────────────────────────

/** One question's answer on the card: an option's index, or the owner's own words. */
export type ReviewChoice = number | { other: string };
export type ReviewChoices = Readonly<Record<string, ReviewChoice>>;

/** One answer as the door takes it (§7 Q3). */
export interface OwnerAnswerBody {
  key: string;
  option?: number;
  text?: string;
}

/** The questions the card asks: those of a review it draws as REVIEWED. An outdated review's old
 *  questions are not answerable (§6 H3), and nothing else has any. */
export function reviewQuestions(review: OwnerConfirmationReviewView | null | undefined): ConfirmationNeedsYouItem[] {
  return review?.state === 'REVIEWED' ? review.review?.needsYou ?? [] : [];
}

/** What a question is answered with now: the owner's choice, or its recommendation untouched. */
export function reviewChoiceOf(item: ConfirmationNeedsYouItem, choices: ReviewChoices): ReviewChoice {
  return choices[item.key] ?? item.recommendedOption;
}

/**
 * What a confirmation from the card says about the review it drew (§7 Q3): the record it showed
 * (null when it showed none) and an answer to each of that record's questions.
 */
export function reviewAnswered(
  review: OwnerConfirmationReviewView | null | undefined,
  choices: ReviewChoices,
): { reviewRecordId: string | null; answers: OwnerAnswerBody[] } {
  if (!review || (review.state !== 'REVIEWED' && review.state !== 'OUTDATED')) {
    return { reviewRecordId: null, answers: [] };
  }
  return {
    reviewRecordId: review.review?.recordId ?? null,
    answers: reviewQuestions(review).map((item) => {
      const choice = reviewChoiceOf(item, choices);
      return typeof choice === 'number' ? { key: item.key, option: choice } : { key: item.key, text: choice.other.trim() };
    }),
  };
}

/** Whether every question has an answer the door would take: an Other with no words has none, and
 *  Confirm done is disabled while one stands (§6 H4). */
export function reviewAnswersComplete(
  review: OwnerConfirmationReviewView | null | undefined,
  choices: ReviewChoices,
): boolean {
  return reviewQuestions(review).every((item) => {
    const choice = reviewChoiceOf(item, choices);
    return typeof choice === 'number' || choice.other.trim() !== '';
  });
}

/** A decision as its receipt reads it here. */
export interface ReviewedDecision {
  decidedAt: string;
  review?: OwnerConfirmationReviewView | null;
  answers?: OwnerConfirmationAnswer[];
}

/** The receipt's `Your answers`: each question, then what was chosen or said (§7 Q5). */
export function ownerAnswerLines(decided: ReviewedDecision): Array<{ text: string; notShown: boolean }> {
  const questions = new Map((decided.review?.review?.needsYou ?? []).map((item) => [item.key, item]));
  return (decided.answers ?? []).map((answer) => {
    const question = questions.get(answer.key);
    const said = answer.option !== null && answer.option !== undefined
      ? question?.options[answer.option]?.label ?? String(answer.option + 1)
      : answer.text ?? '';
    return { text: `${question?.text ?? answer.key} — ${said}`, notShown: answer.source === 'NOT_SHOWN' };
  });
}

/** Whether the review's first record came in after the decision: `Before the review came in`. */
export function reviewCameInAfter(decided: ReviewedDecision): boolean {
  const review = decided.review;
  if (!review) return false;
  const moments = [review.review?.recordedAt, review.returned?.recordedAt, review.problems?.recordedAt]
    .flatMap((at) => (at ? [Date.parse(at)] : []))
    .filter((at) => !Number.isNaN(at));
  if (moments.length === 0) return false;
  return Math.min(...moments) > Date.parse(decided.decidedAt);
}

// ── The bar, drawn ──────────────────────────────────────────────────────────────────────────────

/**
 * The review bar: in the card between what the agent said and If you confirm, and under a receipt.
 * On the card it carries the answer blocks for the reviewer's questions; under a receipt it offers
 * `reopen`, the control for Reopen task, once the reviewer found problems after the confirmation.
 */
export function OwnerConfirmationReviewBar({
  review,
  place,
  choices = {},
  onChoose,
  reopen,
}: {
  review: OwnerConfirmationReviewView;
  place: ReviewPlace;
  choices?: ReviewChoices;
  onChoose?: (key: string, choice: ReviewChoice) => void;
  /** Drawn when the bar offers Reopen task; the host decides whether the task can be reopened. */
  reopen?: ReactNode;
}): JSX.Element {
  const bar = reviewBar(review, place, (iso) => decisionReceiptTime(iso));
  const items = itemsByKey(review);
  const [oldOpen, setOldOpen] = useState(false);
  const draw = (line: ReviewBarLine, index: number): ReactNode => (
    <ReviewLine
      key={`${line.kind}:${index}`}
      line={line}
      items={items}
      questions={reviewQuestions(review)}
      recordId={review.review?.recordId ?? review.reviewId}
      choices={choices}
      onChoose={onChoose}
    />
  );
  return (
    <div className="owner-confirmation-review" data-review-state={review.state}>
      <div className="owner-confirmation-review-head">
        <span className="owner-confirmation-review-who">
          <span className="owner-confirmation-key">{`${REVIEW_HEADING} · `}</span>
          <span className="owner-confirmation-review-name" title={bar.reviewer}>{bar.reviewer}</span>
          {bar.time ? <span className="owner-confirmation-key">{` · ${bar.time}`}</span> : null}
        </span>
        {bar.sha ? (
          <span className={`owner-confirmation-review-sha${bar.shaStruck ? ' is-struck' : ''}`}>{bar.sha}</span>
        ) : null}
      </div>
      {bar.lines.map(draw)}
      {bar.folded.length > 0 ? (
        <>
          <button
            type="button"
            className="decision-ask-toggle owner-confirmation-review-old"
            aria-expanded={oldOpen}
            onClick={() => setOldOpen(!oldOpen)}
          >
            {SHOW_OLD_REVIEW}
            {oldOpen ? <DownOutlined /> : <RightOutlined />}
          </button>
          {oldOpen ? <div className="owner-confirmation-review-old-body">{bar.folded.map(draw)}</div> : null}
        </>
      ) : null}
      {bar.reopen && reopen ? <div className="owner-confirmation-review-reopen">{reopen}</div> : null}
    </div>
  );
}

function ReviewLine({
  line,
  items,
  questions,
  recordId,
  choices,
  onChoose,
}: {
  line: ReviewBarLine;
  items: Map<string, ConfirmationReviewItem>;
  questions: ConfirmationNeedsYouItem[];
  recordId: string;
  choices: ReviewChoices;
  onChoose?: (key: string, choice: ReviewChoice) => void;
}): JSX.Element | null {
  switch (line.kind) {
    case 'STATUS':
      return (
        <div className={`owner-confirmation-review-status${line.warn ? ' is-warn' : ''}`}>
          {line.icon === 'CLOCK' ? <ClockCircleOutlined /> : line.icon === 'DASH' ? <MinusCircleOutlined /> : null}
          <span>{line.text}</span>
        </div>
      );
    case 'NOTE':
      return <div className="owner-confirmation-review-note">{line.text}</div>;
    case 'HEADLINE':
      return (
        <div className={`owner-confirmation-review-headline${line.warn ? ' is-warn' : ''}`} title={line.text}>
          {line.text}
        </div>
      );
    case 'ANSWERS':
      return onChoose ? (
        <ReviewAnswerBlocks questions={questions} recordId={recordId} choices={choices} onChoose={onChoose} />
      ) : null;
    case 'ROW':
      return <ReviewRow line={line} items={line.keys.flatMap((key) => items.get(key) ?? [])} />;
    case 'QUOTE':
      return <div className="owner-confirmation-review-quote">{`“${line.text}”`}</div>;
    case 'FOOTER':
      return <div className="owner-confirmation-review-note">{line.text}</div>;
  }
}

/** One of the reviewer's lists: its lines joined, two lines at most, opening in place to each line
 *  with what it rests on (§6 H3). */
function ReviewRow({
  line,
  items,
}: {
  line: Extract<ReviewBarLine, { kind: 'ROW' }>;
  items: ConfirmationReviewItem[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const toggle = (): void => setOpen(!open);
  return (
    <div
      className={`owner-confirmation-review-row is-${line.row.toLowerCase().replace('_', '-')}`}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
      }}
    >
      <span className="owner-confirmation-review-row-label">{line.label}</span>
      {open ? (
        <ul className="owner-confirmation-review-items">
          {items.map((item) => (
            <li key={item.key}>
              <div>{item.text}</div>
              {item.whyNotProven ? <div className="owner-confirmation-review-why">{item.whyNotProven}</div> : null}
              {item.coordinatorChecked ? (
                <div className="owner-confirmation-review-why">{item.coordinatorChecked}</div>
              ) : null}
              {(item.evidenceRefs ?? []).map((ref) => (
                <div key={ref} className="owner-confirmation-review-ref">{ref}</div>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <span className="owner-confirmation-review-row-text">{line.text}</span>
      )}
    </div>
  );
}

/**
 * One block per question only the owner can decide (§7 Q2): its options with the recommendation
 * chosen and marked, then a row for the owner's own words. The first question's words are the bar's
 * first line already, so its block starts at its options. The answers ride with Confirm done.
 */
function ReviewAnswerBlocks({
  questions,
  recordId,
  choices,
  onChoose,
}: {
  questions: ConfirmationNeedsYouItem[];
  recordId: string;
  choices: ReviewChoices;
  onChoose: (key: string, choice: ReviewChoice) => void;
}): JSX.Element {
  return (
    <div className="owner-confirmation-review-answers">
      {questions.map((item, index) => {
        const choice = reviewChoiceOf(item, choices);
        const name = `review-${recordId}-${item.key}`;
        return (
          <div key={item.key} className="owner-confirmation-review-question">
            {index > 0 ? <div className="owner-confirmation-review-question-text">{item.text}</div> : null}
            <ReviewEvidence refs={item.evidenceRefs ?? []} />
            {item.options.map((option, optionIndex) => (
              <label
                key={`${optionIndex}-${option.label}`}
                className={`coordinator-question-option${choice === optionIndex ? ' is-chosen' : ''}`}
              >
                <input
                  type="radio"
                  name={name}
                  checked={choice === optionIndex}
                  onChange={() => onChoose(item.key, optionIndex)}
                />
                <span className="coordinator-question-option-text">
                  {option.label}
                  {optionIndex === item.recommendedOption ? (
                    <span className="coordinator-question-recommended">{RECOMMENDED}</span>
                  ) : null}
                  {option.description ? (
                    <span className="coordinator-question-option-why">{option.description}</span>
                  ) : null}
                </span>
              </label>
            ))}
            <label className={`coordinator-question-option${typeof choice === 'number' ? '' : ' is-chosen'}`}>
              <input
                type="radio"
                name={name}
                checked={typeof choice !== 'number'}
                onChange={() => onChoose(item.key, { other: typeof choice === 'number' ? '' : choice.other })}
              />
              <span className="coordinator-question-option-text">{OTHER_OPTION}</span>
            </label>
            {typeof choice === 'number' ? null : (
              <Textarea
                className="coordinator-question-free"
                value={choice.other}
                maxLength={2000}
                autoSize={{ minRows: 2, maxRows: 8 }}
                aria-label={item.text}
                onChange={(event) => onChoose(item.key, { other: event.target.value })}
              />
            )}
          </div>
        );
      })}
      <div className="owner-confirmation-review-note">{ANSWERS_SENT_WITH_CONFIRM}</div>
    </div>
  );
}

/** A question's evidence, folded under it. */
function ReviewEvidence({ refs }: { refs: string[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (refs.length === 0) return null;
  return (
    <div className="owner-confirmation-review-evidence">
      <button type="button" className="decision-ask-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {REVIEW_EVIDENCE}
        {open ? <DownOutlined /> : <RightOutlined />}
      </button>
      {open ? refs.map((ref) => <div key={ref} className="owner-confirmation-review-ref">{ref}</div>) : null}
    </div>
  );
}

/** The receipt's `Your answers`, when the decision recorded any (§7 Q5, §9 L3). */
export function OwnerAnswers({ decided }: { decided: ReviewedDecision }): JSX.Element | null {
  const lines = ownerAnswerLines(decided);
  if (lines.length === 0) return null;
  return (
    <div className="owner-confirmation-answers">
      <div className="owner-confirmation-answers-head">{YOUR_ANSWERS}</div>
      {lines.map((line, index) => (
        <div key={index} className="owner-confirmation-answer">
          <div>{line.text}</div>
          {line.notShown ? <div className="owner-confirmation-review-note">{ANSWER_NOT_SHOWN}</div> : null}
        </div>
      ))}
    </div>
  );
}
