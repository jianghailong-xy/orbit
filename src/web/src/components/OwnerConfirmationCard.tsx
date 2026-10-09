import { useEffect, useRef, useState, type JSX, type ReactNode, type Ref } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  BranchesOutlined,
  CaretRightFilled,
  DownOutlined,
  MergeOutlined,
  PoweroffOutlined,
  RightOutlined,
} from '@ant-design/icons';
import type {
  OwnerConfirmationAnswer,
  OwnerConfirmationIfConfirmed,
  OwnerConfirmationReviewView,
  OwnerConfirmationStart,
} from '@orbit/shared';
import { Alert } from './ui/Alert';
import { useLocation } from 'react-router-dom';
import { api } from '../api';
import { markdownToPlainLines } from '../lib/markdownText';
import { ownerConfirmationQuery } from '../lib/queries';
import { CardActionButton, CardActions } from './CardAction';
import { ENTER_HINT, useDecisionCardKeys } from './CardHotkey';
import { ReviewCard } from './ReviewCard';
import { useIsMobile } from '../lib/useMediaQuery';
import { PROVENANCE_LABEL } from './CriteriaDecisionCard';
import { revealOwnerConfirmationCard } from './DecisionRail';
import { decisionReceiptTime } from './EvidenceDecisionCard';
import {
  BEFORE_REVIEW,
  OwnerAnswers,
  OwnerConfirmationReviewBar,
  reviewAnswered,
  reviewAnswersComplete,
  reviewCameInAfter,
  type OwnerAnswerBody,
  type ReviewChoice,
  type ReviewChoices,
} from './OwnerConfirmationReview';

/**
 * The card that asks the account owner whether an OWNER_CONFIRMED task is done.
 *
 * ONE PLACE TO ANSWER
 * -------------------
 * When a run of the task declares its work finished and then stops working — nothing queued behind
 * that turn, no job of its own in flight, no wake-up it asked for — Orbit draws this card at the end
 * of that run's own session, in whatever project the task is filed under, or none, from
 * `GET /tasks/:id/owner-confirmation`, and its two buttons post straight to the same door with the
 * owner's own sign-in. Nothing else answers it. The session list only lights the row ("Waiting for
 * your confirmation") and the line pinned under the header only points here (`DecisionRail.tsx`);
 * neither carries a button, because a second place to answer is a second answer racing the first. A
 * run that never declared is never carded, and a task no run is waiting on has no card either: both
 * are confirmed from their detail panel instead (`TaskDetailPanel.tsx`) — never both at once.
 *
 * WHAT THE OWNER DECIDES FROM
 * ---------------------------
 * The task, what settles it (its acceptance criteria, in its own words, folded to one row until
 * opened), what the run reported (its last message of the turn that asked), and — right above the
 * buttons, because the card is taller than a phone's screen and that is what is in view at the
 * press — what confirming sets off, as the read computes it (`ifConfirmed`). Confirm done records the
 * decision the task's DONE is derived from. Chat about this asks for what is missing; that reason is
 * sent to this session as owner's next message, the task stays open, and the next turn that ends
 * asks again.
 *
 * AND ONE PLACE TO TYPE
 * ---------------------
 * The reason is an ordinary message to this session, and the composer at the bottom of the screen
 * already is one. So Chat about this opens no box here: it arms the composer (`WorkspaceView`'s
 * `replyTo`), the bar there names what the next send answers, and that send goes to the door as
 * SEND_BACK + note instead of starting a turn. Two places on screen taking the same sentence is
 * what that avoids — and it is the same handoff a question card's "Chat about this" makes.
 *
 * WHAT A DECISION LEAVES
 * ----------------------
 * The card goes, and a receipt (`OwnerDecisionReceipt`) is drawn into the conversation at the moment
 * the decision was made, read back from the decision rows — so a reload or another device shows it
 * too, as the evidence card's receipt is.
 *
 * AND WHAT A REVIEW ADDS
 * ----------------------
 * A run's report goes to its reviewer before its owner (docs/owner-confirmation-review-contract.md),
 * and the review bar between the report and If you confirm says how far that got
 * (`OwnerConfirmationReview.tsx`). It locks nothing: the buttons are the same in every state, and a
 * review's questions only add answers that ride with Confirm done. A review that comes in after the
 * decision is drawn under the receipt, with Reopen task when it found a problem; a report the
 * reviewer sent back is drawn as the record it became (`ReviewerReturnRecord`).
 */

export interface OwnerConfirmationReport {
  text: string;
  reportedAt: string;
}

export interface OwnerConfirmationWaiting {
  /** The run report being asked about, as the door takes it back. */
  requestId: string;
  /** The session whose run reported: where this card is drawn. */
  sessionId: string;
  requestedAt: string;
  report: OwnerConfirmationReport | null;
  /** Its review; null when it has no reviewer, absent from an older server. */
  review?: OwnerConfirmationReviewView | null;
}

export interface RecordedOwnerDecision {
  id: string;
  decision: OwnerDecision;
  note: string | null;
  decidedAt: string;
  decidedByType: string;
  requestId: string | null;
  /** The session whose run the decision answered — where its receipt is drawn; null for a
   *  confirmation pressed while no run was waiting. */
  sessionId: string | null;
  report: OwnerConfirmationReport | null;
  /** The answered request's review as it stands now, drawn under the receipt (§9 L3). */
  review?: OwnerConfirmationReviewView | null;
  /** The review's state when the owner decided; null for a panel confirmation. */
  reviewStateAtDecision?: string | null;
  /** The REVIEW record the decision was made against. */
  reviewRecordId?: string | null;
  /** The owner's answers to that review's questions. */
  answers?: OwnerConfirmationAnswer[];
}

/** A report its reviewer sent back to the run: no decision answers it (§8 B6). */
export interface ReviewerReturnedRequest {
  requestId: string;
  sessionId: string;
  requestedAt: string;
  review: OwnerConfirmationReviewView;
}

/** `GET /tasks/:taskId/owner-confirmation`. */
export interface OwnerConfirmationView {
  taskId: string;
  title: string;
  status: string;
  projectId: string | null;
  completionCriterion: string;
  acceptanceCriteria: string | null;
  waiting: OwnerConfirmationWaiting | null;
  decisions: RecordedOwnerDecision[];
  /** What confirming sets off, while a run is waiting; null otherwise, absent from an older server. */
  ifConfirmed?: OwnerConfirmationIfConfirmed | null;
  /** The reports a reviewer sent back to the run, oldest first; absent from an older server. */
  reviewerReturns?: ReviewerReturnedRequest[];
}

export type OwnerDecision = 'CONFIRM' | 'SEND_BACK';

export const OWNER_CONFIRMATION_HEADING = 'Confirm this task is done?';
export const OWNER_CONFIRM_ACTION = 'Confirm done';
/** The other answer, and the same words the question card and Orbit's own asks use for it: three
 *  cards, one control, because all three do the same thing — hand the reply to the main composer,
 *  where the next send carries it to that card's door. */
export const OWNER_SEND_BACK_ACTION = 'Chat about this';
/** What the composer asks for while it is armed: the reason's label, as the card used to print it
 *  over its own box. */
export const OWNER_SEND_BACK_LABEL = "What's missing?";
/** What the action promises, printed under the buttons rather than hidden in the second one's
 *  tooltip: the door refuses a send-back carrying no note and writes nothing at all, and a
 *  confirmation sent back is not a task closed. A promise a phone cannot show is a promise the
 *  reader does not have — and this is the one that says pressing it does not close anything. */
export const OWNER_SEND_BACK_HINT = 'Your next message goes to this agent. The task stays open.';
/** What the composer says it is about to answer while armed, ahead of the task's own title. */
export const OWNER_SENDING_BACK_PREFIX = 'Replying to: ';
/** The two boxes' keys, in the words somebody who has never read Orbit's source would use for
 *  them: what the task is measured against, and what the thing that did the work said about it.
 *  "Settles" and "the run reported" are this system's vocabulary, not a reader's. */
export const WHAT_SETTLES_IT = 'WHAT COUNTS AS DONE';
export const WHAT_THE_RUN_REPORTED = 'WHAT THE AGENT SAID';
export const OWNER_CONFIRMATION_SHOW_ALL = 'Show all';
export const OWNER_CONFIRMATION_SHOW_LESS = 'Show less';
export const OWNER_CONFIRMATION_NO_CRITERIA = 'Nobody wrote down what counts as done.';
export const OWNER_CONFIRMATION_NO_REPORT = 'The agent finished without saying anything.';
/** What the line under the title says now: which completion criterion this task carries, as the
 *  fact it is about the reader rather than as the enum `OWNER_CONFIRMED`. The id stays beside it,
 *  quieter, because it is an address somebody occasionally copies and never reads. */
export const OWNER_CONFIRMATION_YOURS = 'You decide when this is done';
export const OWNER_CONFIRMED_HEADING = 'Confirmed done';
export const OWNER_SENT_BACK_HEADING = 'Asked for more';
export const OWNER_SHOW_WHAT_SETTLED_IT = 'Show what counted as done';
export const OWNER_HIDE_WHAT_SETTLED_IT = 'Hide what counted as done';
/** What a session row and the session header say while one of these cards is waiting. */
export const WAITING_FOR_CONFIRMATION = 'Waiting for your confirmation';

/** What the mark says about itself, now that an agent's words can stand on the card twice — the
 *  report and the review — each in a box naming who wrote it (contract §10 G3). */
export const OWNER_CONFIRMATION_AUTHORSHIP_TITLE =
  'Orbit composed this card and authorised its buttons. Anything an agent wrote is shown in a box '
  + 'that names who wrote it.';

/** The door's refusals that mean "this card is out of date", in the door's own spelling — the two a
 *  review adds among them (§7 Q3): the review the card drew is not the one waiting now, or its
 *  questions were not all answered. Read again, the card draws the review and its questions as they
 *  are now. */
export const OWNER_CONFIRMATION_STALE_CODES: readonly string[] = [
  'OWNER_CONFIRMATION_STALE',
  'OWNER_CONFIRMATION_NOTHING_TO_SEND_BACK',
  'OWNER_CONFIRMATION_TASK_SETTLED',
  'OWNER_CONFIRMATION_REVIEW_STALE',
  'OWNER_CONFIRMATION_ANSWERS_REQUIRED',
];

/** Where the report starts being folded: long enough for a sentence or two, short enough that the
 *  buttons stay on a phone's screen. The single-create card folds a task's acceptance criteria at
 *  the same ceiling — the same kind of field, read by the same person, on a card with the same
 *  reason to keep its buttons in view. */
export const REPORT_CLAMP = 240;

/** What the folded criteria row counts: `6 items`. Top-level list items when the criteria are a list,
 *  paragraphs when they are not; null when nobody wrote any, and the box says so instead of folding.
 *  Counted on the plain lines, which keep a bullet as `•` and an ordered item's number. */
export function criteriaItemsLabel(acceptanceCriteria: string | null | undefined): string | null {
  const lines = markdownToPlainLines(acceptanceCriteria).split('\n');
  let items = lines.filter((line) => /^(?:• |[0-9]{1,9}[.)][ \t]|[0-9]{1,9}[、）])/u.test(line)).length;
  if (items === 0) {
    items = lines.filter((line, i) => line.trim() !== '' && (i === 0 || lines[i - 1].trim() === '')).length;
  }
  return items === 0 ? null : counted(items, 'item', 'items');
}

/** The block right above Confirm done: what the press sets off, as Orbit computed it from its own
 *  records. It wears no author — the two boxes above it quote the task and the agent, this does not. */
export const IF_YOU_CONFIRM = 'IF YOU CONFIRM';
export const IF_CONFIRMED_NOT_ON_MAIN = 'Not on main yet';
export const IF_CONFIRMED_NO_RECORD_ON_MAIN = 'No record of this branch on main';
export const IF_CONFIRMED_DOES_NOT_MERGE = 'confirming doesn’t merge it';
export const IF_CONFIRMED_LINE_THEN_OWNER = 'Goes onto the integration line; merging into main asks you again';
export const IF_CONFIRMED_AUTO_MAIN = 'Lands on main by itself if the checks pass';
export const IF_CONFIRMED_ENDS_SESSION = 'Ends this session';

/** One row of the block: its symbol, its first line, the branch's added lines said after it in the
 *  diff's green, and a quieter second line. */
export interface IfConfirmedRow {
  kind: 'START' | 'BRANCH' | 'LANDING' | 'ENDS_SESSION';
  lead: string;
  added: string | null;
  detail: string | null;
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The line for the tasks of one tier — and when the project holds them until the work lands, that
 *  they start then and not at the press. */
function startsLine(starts: OwnerConfirmationStart, n: number, afterLanding: boolean): string {
  const tasks = counted(n, 'task', 'tasks');
  if (starts === 'NOW') return afterLanding ? `Starts ${tasks} once this lands` : `Starts ${tasks} waiting on this one`;
  if (starts === 'WHEN_SLOT_FREES') {
    const start = n === 1 ? 'starts' : 'start';
    return afterLanding ? `${tasks} ${start} once this lands and a slot frees` : `${tasks} ${start} when a slot frees`;
  }
  const become = n === 1 ? 'becomes' : 'become';
  return afterLanding ? `${tasks} ${become} ready to start once this lands` : `${tasks} ${become} ready to start`;
}

const START_TIERS: readonly OwnerConfirmationStart[] = ['NOW', 'WHEN_SLOT_FREES', 'MANUAL'];

/**
 * The block's rows, in its order: the tasks it starts (one row per tier, their titles under it), the
 * branch while it is not known to be on main, how the work lands, and the run it ends. An item the
 * read left out draws no row; no rows, no block.
 *
 * The branch row says confirming does not merge it only where the landing is read and is not
 * Automatic's — there the DONE does lead to main, as the landing row says.
 */
export function ifConfirmedRows(ifConfirmed: OwnerConfirmationIfConfirmed | null | undefined): IfConfirmedRow[] {
  if (!ifConfirmed) return [];
  const rows: IfConfirmedRow[] = [];
  for (const starts of START_TIERS) {
    const tasks = (ifConfirmed.startsTasks ?? []).filter((task) => task.starts === starts);
    if (tasks.length === 0) continue;
    rows.push({
      kind: 'START',
      lead: startsLine(starts, tasks.length, ifConfirmed.startsAfterLanding === true),
      added: null,
      detail: tasks.map((task) => task.title).join(' · '),
    });
  }
  const { branch, landing, endsSession } = ifConfirmed;
  if (branch && (branch.onMain === 'NO' || branch.onMain === 'UNKNOWN')) {
    rows.push({
      kind: 'BRANCH',
      lead: branch.onMain === 'NO' ? IF_CONFIRMED_NOT_ON_MAIN : IF_CONFIRMED_NO_RECORD_ON_MAIN,
      added: branch.onMain === 'NO' && branch.linesAdded > 0 ? `+${branch.linesAdded.toLocaleString('en-US')}` : null,
      detail: landing === 'NONE' || landing === 'LINE_THEN_OWNER'
        ? `${branch.name} — ${IF_CONFIRMED_DOES_NOT_MERGE}`
        : branch.name,
    });
  }
  if (landing === 'LINE_THEN_OWNER' || landing === 'AUTO_MAIN') {
    rows.push({
      kind: 'LANDING',
      lead: landing === 'LINE_THEN_OWNER' ? IF_CONFIRMED_LINE_THEN_OWNER : IF_CONFIRMED_AUTO_MAIN,
      added: null,
      detail: null,
    });
  }
  if (endsSession) {
    const jobs = endsSession.runningBgJobs;
    rows.push({
      kind: 'ENDS_SESSION',
      lead: jobs > 0
        ? `${IF_CONFIRMED_ENDS_SESSION} · ${counted(jobs, 'background job', 'background jobs')} ${jobs === 1 ? 'stops' : 'stop'}`
        : IF_CONFIRMED_ENDS_SESSION,
      added: null,
      detail: null,
    });
  }
  return rows;
}

/** The run waiting in THIS session, or null — the card is drawn in the session that reported, only. */
export function ownerConfirmationWaitingIn(
  view: OwnerConfirmationView | null | undefined,
  sessionId: string | null | undefined,
): OwnerConfirmationWaiting | null {
  if (!view?.waiting || !sessionId) return null;
  return view.waiting.sessionId === sessionId ? view.waiting : null;
}

/** The decisions whose receipts belong in this session: the ones that answered its run. */
export function ownerDecisionReceiptsIn(
  view: OwnerConfirmationView | null | undefined,
  sessionId: string | null | undefined,
): RecordedOwnerDecision[] {
  if (!view || !sessionId) return [];
  return view.decisions.filter((decided) => decided.sessionId === sessionId);
}

/** The reports of this session's run that its reviewer sent back: each was a card here, and is drawn
 *  as the record it became, at the moment it was sent back (contract §8 B6). */
export function reviewerReturnsIn(
  view: OwnerConfirmationView | null | undefined,
  sessionId: string | null | undefined,
): ReviewerReturnedRequest[] {
  if (!view || !sessionId) return [];
  return (view.reviewerReturns ?? []).filter((returned) => returned.sessionId === sessionId);
}

/** The body the door takes. `note` rides with a send-back and with nothing else; `reviewRecordId`
 *  and `answers` with a confirmation and with nothing else. */
export interface OwnerDecisionRequestBody {
  decision: OwnerDecision;
  requestId: string | null;
  note?: string;
  reviewRecordId?: string | null;
  answers?: OwnerAnswerBody[];
}

/** What a confirmation says about the review the card drew (`reviewAnswered`). */
export interface OwnerDecisionReview {
  reviewRecordId: string | null;
  answers: OwnerAnswerBody[];
}

/**
 * The request one press makes, as data, so what goes to the door can be asserted without a network.
 * `requestId` is the report the card was drawn for — the door's compare-and-set — and null from the
 * task panel, which answers "no run is waiting".
 *
 * A confirmation always names the review record it was drawn with, as null when it drew none: the
 * key being there is how the door knows this client knows about reviews (contract §7 Q3), and holds
 * its answers to the review's questions. A send-back carries neither.
 */
export function ownerDecisionRequest(
  taskId: string,
  requestId: string | null,
  decision: OwnerDecision,
  note?: string,
  review?: OwnerDecisionReview,
): { path: string; body: OwnerDecisionRequestBody } {
  const reason = note?.trim() ?? '';
  const answers = review?.answers ?? [];
  return {
    path: `/tasks/${encodeURIComponent(taskId)}/owner-confirmation`,
    body: {
      decision,
      requestId,
      ...(decision === 'SEND_BACK' && reason !== '' ? { note: reason } : {}),
      ...(decision === 'CONFIRM'
        ? { reviewRecordId: review?.reviewRecordId ?? null, ...(answers.length > 0 ? { answers } : {}) }
        : {}),
    },
  };
}

/** The write, with the reader's own credential — no agent between the press and the door. */
export function sendOwnerDecision(
  taskId: string,
  requestId: string | null,
  decision: OwnerDecision,
  note?: string,
  review?: OwnerDecisionReview,
): Promise<unknown> {
  const request = ownerDecisionRequest(taskId, requestId, decision, note, review);
  return api(request.path, { method: 'POST', body: request.body });
}

/** Re-read everything a decision changes: this read, the task's detail, and the task lists. */
export function refreshOwnerConfirmationViews(qc: QueryClient, taskId: string): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['task', taskId] }),
    qc.invalidateQueries({ queryKey: ['tasks'] }),
  ]);
}

/** A refusal of a press, said as staleness when that is what the door's code means. */
export function ownerDecisionRefusal(error: Error): { stale: boolean; title: string } {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && OWNER_CONFIRMATION_STALE_CODES.includes(code)) {
    return { stale: true, title: 'Not recorded: this card is out of date' };
  }
  return { stale: false, title: 'Not recorded' };
}

/** The receipt's line: which answer, by whom, and when. */
export function ownerDecisionReceiptLine(decided: RecordedOwnerDecision, now?: Date): string {
  const action = decided.decision === 'CONFIRM' ? OWNER_CONFIRMED_HEADING : OWNER_SENT_BACK_HEADING;
  return `${action} by you · ${decisionReceiptTime(decided.decidedAt, now)}`;
}

/** A box's heading for the report: when the run said it, when it said anything. */
export function whatTheRunReported(report: OwnerConfirmationReport | null, now?: Date): string {
  return report ? `${WHAT_THE_RUN_REPORTED} · ${decisionReceiptTime(report.reportedAt, now)}` : WHAT_THE_RUN_REPORTED;
}

/** The two things a person decides from, each in its own box. */
function OwnerConfirmationBoxes({
  acceptanceCriteria,
  report,
  foldCriteria = false,
}: {
  acceptanceCriteria: string | null;
  report: OwnerConfirmationReport | null;
  /** Fold the criteria to one row that opens in place — the card's, whose buttons need the height. */
  foldCriteria?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const criteria = markdownToPlainLines(acceptanceCriteria);
  const items = foldCriteria ? criteriaItemsLabel(acceptanceCriteria) : null;
  const said = markdownToPlainLines(report?.text);
  const long = said.length > REPORT_CLAMP;
  return (
    <>
      <div className="owner-confirmation-box">
        {items !== null ? (
          <button
            type="button"
            className="owner-confirmation-fold"
            aria-expanded={criteriaOpen}
            onClick={() => setCriteriaOpen(!criteriaOpen)}
          >
            <span className="owner-confirmation-key">{WHAT_SETTLES_IT}</span>
            <span className="owner-confirmation-count">{items}</span>
            {criteriaOpen ? <DownOutlined /> : <RightOutlined />}
          </button>
        ) : (
          <div className="owner-confirmation-key">{WHAT_SETTLES_IT}</div>
        )}
        {items === null || criteriaOpen ? (
          <div className="owner-confirmation-value">
            {criteria === '' ? (
              <span className="decision-ask-quiet">{OWNER_CONFIRMATION_NO_CRITERIA}</span>
            ) : (
              criteria
            )}
          </div>
        ) : null}
      </div>
      <div className="owner-confirmation-box">
        <div className="owner-confirmation-key">{whatTheRunReported(report)}</div>
        <div className="owner-confirmation-value">
          {said === '' ? (
            <span className="decision-ask-quiet">{OWNER_CONFIRMATION_NO_REPORT}</span>
          ) : long && !open ? (
            `${said.slice(0, REPORT_CLAMP).trimEnd()}…`
          ) : (
            said
          )}
        </div>
        {long && (
          <button
            type="button"
            className="decision-ask-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? OWNER_CONFIRMATION_SHOW_LESS : OWNER_CONFIRMATION_SHOW_ALL}
          </button>
        )}
      </div>
    </>
  );
}

const IF_CONFIRMED_SYMBOL: Record<IfConfirmedRow['kind'], JSX.Element> = {
  START: <CaretRightFilled />,
  BRANCH: <BranchesOutlined />,
  LANDING: <MergeOutlined />,
  ENDS_SESSION: <PoweroffOutlined />,
};

/** What confirming sets off, right above Confirm done — or nothing, when the read says nothing. */
function OwnerConfirmationIfYouConfirm({
  ifConfirmed,
}: {
  ifConfirmed: OwnerConfirmationIfConfirmed | null | undefined;
}): JSX.Element | null {
  const rows = ifConfirmedRows(ifConfirmed);
  if (rows.length === 0) return null;
  return (
    <div className="owner-confirmation-if">
      <div className="owner-confirmation-key">{IF_YOU_CONFIRM}</div>
      {rows.map((row) => (
        <div key={`${row.kind}:${row.lead}`} className={`owner-confirmation-if-row is-${row.kind.toLowerCase()}`}>
          <span className="owner-confirmation-if-symbol" aria-hidden="true">
            {IF_CONFIRMED_SYMBOL[row.kind]}
          </span>
          <div className="owner-confirmation-if-text">
            <div className="owner-confirmation-if-lead">
              {row.lead}
              {row.added !== null ? (
                <>
                  {' · '}
                  <span className="owner-confirmation-if-added">{row.added}</span>
                </>
              ) : null}
            </div>
            {row.detail !== null ? (
              <div className="owner-confirmation-if-detail" title={row.detail}>{row.detail}</div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The two answers: confirm on one press, or send the report back with a reason. Not deciding yet is
 * simply not pressing.
 *
 * The reason does not get a box here. It is an ordinary message to this session — which is what the
 * composer at the bottom of the screen already is — so the press arms that instead, and the door's
 * "no reason, no write" rule becomes the composer's own refusal to send an empty line. Two places
 * taking the same sentence is what this avoids.
 */
export function OwnerConfirmationActions({
  disabled,
  confirmDisabled = false,
  keys = false,
  onConfirm,
  onSendBack,
}: {
  /** Whether no answer from here could succeed right now. Every control below follows it. */
  disabled: boolean;
  /** Whether Confirm done alone would be refused as it stands: an Other the owner picked for one of
   *  the review's questions and has not written yet (contract §6 H4). Chat about this stays live. */
  confirmDisabled?: boolean;
  /** Whether this card holds the keyboard, and so shows the two keys on its buttons. Both buttons
   *  are one `disabled` here, so both keys come and go with it. */
  keys?: boolean;
  onConfirm: () => void;
  /** Hand the reply to the composer; the reason is whatever is sent next. */
  onSendBack: () => void;
}): JSX.Element {
  return (
    <>
      <CardActions className="decision-ask-actions">
        <CardActionButton tone="primary" disabled={disabled || confirmDisabled} onClick={onConfirm}>
          {OWNER_CONFIRM_ACTION}
          {keys && !disabled && !confirmDisabled && <span className="approval-kbd">{ENTER_HINT}</span>}
        </CardActionButton>
        <CardActionButton tone="secondary" disabled={disabled} onClick={onSendBack}>
          {OWNER_SEND_BACK_ACTION}
        </CardActionButton>
      </CardActions>
      {/* Under the buttons and not inside the second one's tooltip: a touch screen has no hover,
          so the only sentence saying the task stays open was unreadable on a phone. */}
      <div className="owner-confirmation-hint">{OWNER_SEND_BACK_HINT}</div>
    </>
  );
}

/** The card. Presentational: it takes the read and issues no request. */
export function OwnerConfirmationCard({
  ref,
  view,
  waiting,
  busy = false,
  error = null,
  keys = false,
  choices = {},
  onChoose = () => {},
  onDecide,
  onSendBack,
}: {
  /** The card's own element, which is where its keyboard claim says it is drawn (`CardHotkey.ts`). */
  ref?: Ref<HTMLDivElement>;
  view: Pick<OwnerConfirmationView, 'taskId' | 'title' | 'acceptanceCriteria' | 'ifConfirmed'>;
  waiting: OwnerConfirmationWaiting;
  /** A press from this card is on its way to the door. */
  busy?: boolean;
  /** The door's refusal of the last press, when it refused. */
  error?: Error | null;
  /** Whether this card holds the keyboard — see `CardHotkey.ts`. A static render never does. */
  keys?: boolean;
  /** The owner's answers so far to the review's questions; a question absent here keeps its
   *  recommendation. */
  choices?: ReviewChoices;
  onChoose?: (key: string, choice: ReviewChoice) => void;
  onDecide: (decision: OwnerDecision, note?: string) => void;
  /** Hand the send-back to the composer. The door is pressed by the send that follows, not here. */
  onSendBack: () => void;
}): JSX.Element {
  const refusal = error ? ownerDecisionRefusal(error) : null;
  return (
    // Where the pinned line's pointer lands (`revealOwnerConfirmationCard`).
    <div
      ref={ref}
      className="approval-card decision-ask evidence-decision owner-confirmation"
      data-owner-confirmation={waiting.requestId}
    >
      <div className="approval-head decision-ask-head">
        <span className="evidence-decision-heading">{OWNER_CONFIRMATION_HEADING}</span>
        <span className="criteria-provenance" title={OWNER_CONFIRMATION_AUTHORSHIP_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions decision-ask-body">
        <section className="decision-ask-q">
          <div className="decision-ask-claim owner-confirmation-lead">{view.title}</div>
          <div className="owner-confirmation-yours">
            {OWNER_CONFIRMATION_YOURS}
            <span className="owner-confirmation-id">{view.taskId}</span>
          </div>
          <OwnerConfirmationBoxes acceptanceCriteria={view.acceptanceCriteria} report={waiting.report} foldCriteria />
          {/* The reviewer's box, between what the agent said and what confirming sets off (contract
              §6 H1): where the review stands, and its questions for the owner when it asks any. */}
          {waiting.review ? (
            <OwnerConfirmationReviewBar review={waiting.review} place="CARD" choices={choices} onChoose={onChoose} />
          ) : null}
          {/* Right above the buttons: the card is taller than a phone's screen, and this is what is
              in view at the press. A refused press says why between it and the buttons. */}
          <OwnerConfirmationIfYouConfirm ifConfirmed={view.ifConfirmed} />
          {error && refusal ? (
            <Alert
              className="evidence-decision-error"
              type={refusal.stale ? 'warning' : 'error'}
              title={refusal.title}
              description={error.message}
            />
          ) : null}
        </section>
      </div>
      <div className="owner-confirmation-footer">
        <OwnerConfirmationActions
          disabled={busy}
          confirmDisabled={!reviewAnswersComplete(waiting.review, choices)}
          keys={keys}
          onConfirm={() => onDecide('CONFIRM')}
          onSendBack={onSendBack}
        />
      </div>
    </div>
  );
}

/**
 * The wired card for one session: drawn when a run of this session's task is waiting on its owner,
 * and pressed straight at the door.
 *
 * Arriving from the task's panel carries `revealOwnerConfirmation` in the navigation state, which
 * takes the reader to the card once it is on screen, as the pinned line does.
 */
export function SessionOwnerConfirmationCard({
  sessionId,
  taskId,
  onSendBack,
}: {
  sessionId: string;
  /** The task this session runs; an ordinary conversation has none and gets no card. */
  taskId: string | null | undefined;
  /** Arm the composer to send this report back: it is handed the waiting request and the task's
   *  title, and the send that follows presses the door. */
  onSendBack: (waiting: OwnerConfirmationWaiting, title: string) => void;
}): JSX.Element | null {
  const [reviewOpen, setReviewOpen] = useState(false);
  const narrow = useIsMobile();
  const qc = useQueryClient();
  const location = useLocation();
  const read = useQuery({
    ...ownerConfirmationQuery(taskId ?? ''),
    enabled: Boolean(taskId),
    refetchInterval: 20_000,
  });
  const waiting = ownerConfirmationWaitingIn(read.data, sessionId);
  const answer = useMutation({
    mutationFn: (press: { requestId: string; decision: OwnerDecision; note?: string; review?: OwnerDecisionReview }) =>
      sendOwnerDecision(taskId ?? '', press.requestId, press.decision, press.note, press.review),
    // Re-read whichever way the door answered: a recorded decision takes the card away, and a
    // refusal for staleness means what is waiting has moved.
    onSettled: () => (taskId ? refreshOwnerConfirmationViews(qc, taskId) : undefined),
  });
  const reveal = Boolean(
    (location.state as { revealOwnerConfirmation?: unknown } | null)?.revealOwnerConfirmation,
  );
  const shownRequest = waiting?.requestId ?? null;
  useEffect(() => {
    if (reveal && shownRequest) revealOwnerConfirmationCard();
  }, [reveal, shownRequest]);

  // The owner's answers to the review's questions, kept for the record they answer: a newer review
  // asks its own questions, and answers chosen for the old one are not carried over to it.
  const review = waiting?.review ?? null;
  const recordId = review?.review?.recordId ?? null;
  const [answering, setAnswering] = useState<{ recordId: string | null; choices: ReviewChoices }>({
    recordId: null,
    choices: {},
  });
  const choices = answering.recordId === recordId ? answering.choices : {};
  const choose = (key: string, choice: ReviewChoice): void =>
    setAnswering({ recordId, choices: { ...choices, [key]: choice } });
  const answered = reviewAnswersComplete(review, choices);

  // Nothing on the server moves a review out of "under review" when its window runs out — it reads
  // as not reviewed from then on (contract §5 N5). So a card showing one reads again a second after
  // it is due, rather than at its next poll.
  const dueAt = review?.state === 'UNDER_REVIEW' ? review.dueAt : null;
  useEffect(() => {
    if (!dueAt || !taskId) return;
    const wait = Date.parse(dueAt) + 1_000 - Date.now();
    if (Number.isNaN(wait) || wait > MAX_TIMER_MS) return;
    const timer = setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ownerConfirmationQuery(taskId).queryKey });
    }, Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [qc, dueAt, taskId]);

  // The confirmation button and Enter make the same write; Chat about this arms the composer.
  // A card that cannot confirm holds no keys (`CardHotkey.ts`).
  const decide = (decision: OwnerDecision): void => {
    if (!waiting) return;
    if (decision === 'CONFIRM' && !answered) return;
    answer.mutate({ requestId: waiting.requestId, decision, review: reviewAnswered(review, choices) });
  };
  const chatAbout = (): void => {
    if (!read.data || !waiting) return;
    setReviewOpen(false);
    onSendBack(waiting, read.data.title);
  };
  const asking = waiting !== null && read.data !== undefined && !answer.isPending;
  const anchor = useRef<HTMLDivElement>(null);
  const keys = useDecisionCardKeys({
    confirmEnabled: (!narrow || reviewOpen) && asking && answered,
    onConfirm: () => decide('CONFIRM'),
    anchor,
  });

  if (!taskId || !read.data || !waiting) return null;
  return (
    <ReviewCard id="owner-confirmation-preview" title={OWNER_CONFIRMATION_HEADING} summary={read.data.title}
      meta="Review the report and what confirming changes"
      open={reviewOpen} onOpenChange={setReviewOpen}>
    <OwnerConfirmationCard
      ref={anchor}
      key={waiting.requestId}
      view={read.data}
      waiting={waiting}
      busy={answer.isPending}
      error={answer.isError ? answer.error : null}
      keys={keys}
      choices={choices}
      onChoose={choose}
      onDecide={decide}
      onSendBack={chatAbout}
    />
    </ReviewCard>
  );
}

/** The longest delay a browser timer keeps: a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * What a decision about this session's run leaves in its conversation, drawn where it was made.
 *
 * Folded to one line, because it is a record now and not a question; a confirmation opens to what
 * settled it — the task's acceptance criteria and the report the owner confirmed. A send-back needs
 * no fold: its reason is the owner's own message, right after it.
 */
export function OwnerDecisionReceipt({
  view,
  decided,
  reopen,
}: {
  view: Pick<OwnerConfirmationView, 'title' | 'acceptanceCriteria'>;
  decided: RecordedOwnerDecision;
  /** Reopen task, drawn when the review that came in after the decision found problems (§9 L4). */
  reopen?: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const confirmed = decided.decision === 'CONFIRM';
  return (
    <div
      className="approval-card decision-ask evidence-decision evidence-decision-receipt owner-confirmation"
      data-owner-decision-receipt={decided.id}
    >
      <div className="approval-head decision-ask-head">
        {confirmed && (
          <span className="evidence-decision-receipt-mark" aria-hidden="true">✓</span>
        )}
        <span className="evidence-decision-heading">
          {confirmed ? OWNER_CONFIRMED_HEADING : OWNER_SENT_BACK_HEADING}
        </span>
        <span className="criteria-provenance" title={OWNER_CONFIRMATION_AUTHORSHIP_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions decision-ask-body">
        <section className="decision-ask-q">
          <div className="decision-ask-chip">{view.title}</div>
          <div className="decision-ask-picked">{ownerDecisionReceiptLine(decided)}</div>
          {reviewCameInAfter(decided) ? (
            <div className="owner-confirmation-before-review">{BEFORE_REVIEW}</div>
          ) : null}
          {/* The answered report's review as it stands now — including one that came in after the
              decision — and what the owner answered its questions with (contract §9 L3). */}
          {decided.review ? (
            <OwnerConfirmationReviewBar review={decided.review} place="RECEIPT" reopen={reopen} />
          ) : null}
          <OwnerAnswers decided={decided} />
          {confirmed && (
            <button
              type="button"
              className="decision-ask-toggle"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? `${OWNER_HIDE_WHAT_SETTLED_IT} ▴` : `${OWNER_SHOW_WHAT_SETTLED_IT} ▾`}
            </button>
          )}
          {confirmed && open ? (
            <OwnerConfirmationBoxes acceptanceCriteria={view.acceptanceCriteria} report={decided.report} />
          ) : null}
        </section>
      </div>
    </div>
  );
}

/**
 * What a card becomes when its reviewer sends the report back to the run (contract §8 B6): a record,
 * not a question. The owner was not asked, so there is nothing to press — the buttons are gone
 * rather than disabled — and the review bar says who sent it back, why, and what is wrong. The
 * reason reached the run as its next message, which the conversation draws as `Sent back by the
 * reviewer`.
 */
export function ReviewerReturnRecord({
  view,
  returned,
}: {
  view: Pick<OwnerConfirmationView, 'title'>;
  returned: ReviewerReturnedRequest;
}): JSX.Element {
  return (
    <div
      className="approval-card decision-ask evidence-decision evidence-decision-receipt owner-confirmation"
      data-owner-confirmation-returned={returned.requestId}
    >
      <div className="approval-head decision-ask-head">
        <span className="evidence-decision-heading">{OWNER_CONFIRMATION_HEADING}</span>
        <span className="criteria-provenance" title={OWNER_CONFIRMATION_AUTHORSHIP_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions decision-ask-body">
        <section className="decision-ask-q">
          <div className="decision-ask-chip">{view.title}</div>
          <OwnerConfirmationReviewBar review={returned.review} place="CARD" />
        </section>
      </div>
    </div>
  );
}
