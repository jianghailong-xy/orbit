import { useEffect, useId, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Alert } from 'antd';
import { useLocation } from 'react-router-dom';
import { api } from '../api';
import { markdownToPlainText } from '../lib/markdownText';
import { ownerConfirmationQuery } from '../lib/queries';
import { CardActionButton, CardActions } from './CardAction';
import { PROVENANCE_LABEL } from './CriteriaDecisionCard';
import { revealOwnerConfirmationCard } from './DecisionRail';
import { decisionReceiptTime } from './EvidenceDecisionCard';

/**
 * The card that asks the account owner whether an OWNER_CONFIRMED task is done.
 *
 * ONE PLACE TO ANSWER
 * -------------------
 * When a run of the task ends its turn, Orbit draws this card at the end of that run's own session
 * — in whatever project the task is filed under, or none — from `GET /tasks/:id/owner-confirmation`,
 * and its two buttons post straight to the same door with the owner's own sign-in. Nothing else
 * answers it. The session list only lights the row ("Waiting for your confirmation") and the line
 * pinned under the header only points here (`DecisionRail.tsx`); neither carries a button, because a
 * second place to answer is a second answer racing the first. A task no run is waiting on has no
 * card, and is confirmed from its detail panel instead (`TaskDetailPanel.tsx`) — never both at once.
 *
 * WHAT THE OWNER DECIDES FROM
 * ---------------------------
 * The task, what settles it (its acceptance criteria, in its own words), and what the run reported
 * (its last message of the turn that asked). Confirm done records the decision the task's DONE is
 * derived from. Send back… opens a box for what is missing; that reason is sent to this session as
 * the owner's next message, the task stays open, and the next turn that ends asks again.
 *
 * WHAT A DECISION LEAVES
 * ----------------------
 * The card goes, and a receipt (`OwnerDecisionReceipt`) is drawn into the conversation at the moment
 * the decision was made, read back from the decision rows — so a reload or another device shows it
 * too, as the evidence card's receipt is.
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
}

export type OwnerDecision = 'CONFIRM' | 'SEND_BACK';

export const OWNER_CONFIRMATION_HEADING = 'Confirm this task is done?';
export const OWNER_CONFIRM_ACTION = 'Confirm done';
export const OWNER_SEND_BACK_ACTION = 'Send back…';
export const OWNER_SEND_ACTION = 'Send back';
export const OWNER_SEND_BACK_LABEL = "What's missing?";
export const OWNER_SEND_BACK_HINT = 'Sent to this session as your next message. The task stays open.';
export const WHAT_SETTLES_IT = 'WHAT SETTLES IT';
export const WHAT_THE_RUN_REPORTED = 'WHAT THE RUN REPORTED';
export const OWNER_CONFIRMATION_SHOW_ALL = 'Show all';
export const OWNER_CONFIRMATION_SHOW_LESS = 'Show less';
export const OWNER_CONFIRMATION_NO_CRITERIA = 'This task states no acceptance criteria.';
export const OWNER_CONFIRMATION_NO_REPORT = 'The run ended its turn without a message.';
export const OWNER_CONFIRMED_HEADING = 'Confirmed done';
export const OWNER_SENT_BACK_HEADING = 'Sent back';
export const OWNER_SHOW_WHAT_SETTLED_IT = 'Show what settled it';
export const OWNER_HIDE_WHAT_SETTLED_IT = 'Hide what settled it';
/** What a session row and the session header say while one of these cards is waiting. */
export const WAITING_FOR_CONFIRMATION = 'Waiting for your confirmation';

/** What the mark says about itself. */
export const OWNER_CONFIRMATION_PROVENANCE_TITLE =
  'Orbit drew this card because a run of this task ended its turn. The title, what settles it and '
  + 'the report are the record\'s own words; the buttons go straight to Orbit with your own sign-in, '
  + 'and no agent session can press them.';

/** The door's refusals that mean "this card is out of date", in the door's own spelling. */
export const OWNER_CONFIRMATION_STALE_CODES: readonly string[] = [
  'OWNER_CONFIRMATION_STALE',
  'OWNER_CONFIRMATION_NOTHING_TO_SEND_BACK',
  'OWNER_CONFIRMATION_TASK_SETTLED',
];

/** Where the report starts being folded: long enough for a sentence or two, short enough that the
 *  buttons stay on a phone's screen. */
const REPORT_CLAMP = 240;

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

/** The body the door takes. `note` rides with a send-back and with nothing else. */
export interface OwnerDecisionRequestBody {
  decision: OwnerDecision;
  requestId: string | null;
  note?: string;
}

/**
 * The request one press makes, as data, so what goes to the door can be asserted without a network.
 * `requestId` is the report the card was drawn for — the door's compare-and-set — and null from the
 * task panel, which answers "no run is waiting".
 */
export function ownerDecisionRequest(
  taskId: string,
  requestId: string | null,
  decision: OwnerDecision,
  note?: string,
): { path: string; body: OwnerDecisionRequestBody } {
  const reason = note?.trim() ?? '';
  return {
    path: `/tasks/${encodeURIComponent(taskId)}/owner-confirmation`,
    body: {
      decision,
      requestId,
      ...(decision === 'SEND_BACK' && reason !== '' ? { note: reason } : {}),
    },
  };
}

/** The write, with the reader's own credential — no agent between the press and the door. */
export function sendOwnerDecision(
  taskId: string,
  requestId: string | null,
  decision: OwnerDecision,
  note?: string,
): Promise<unknown> {
  const request = ownerDecisionRequest(taskId, requestId, decision, note);
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
}: {
  acceptanceCriteria: string | null;
  report: OwnerConfirmationReport | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const criteria = markdownToPlainText(acceptanceCriteria);
  const said = markdownToPlainText(report?.text);
  const long = said.length > REPORT_CLAMP;
  return (
    <>
      <div className="owner-confirmation-box">
        <div className="owner-confirmation-key">{WHAT_SETTLES_IT}</div>
        <div className="owner-confirmation-value">
          {criteria === '' ? (
            <span className="decision-ask-quiet">{OWNER_CONFIRMATION_NO_CRITERIA}</span>
          ) : (
            criteria
          )}
        </div>
      </div>
      <div className="owner-confirmation-box">
        <div className="owner-confirmation-key">{whatTheRunReported(report)}</div>
        <div className="owner-confirmation-value">
          {said === '' ? (
            <span className="decision-ask-quiet">{OWNER_CONFIRMATION_NO_REPORT}</span>
          ) : long && !open ? (
            `${said.slice(0, REPORT_CLAMP)}…`
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

/**
 * The two answers: confirm on one press, or send back with the reason the door requires. Not
 * deciding yet is simply not pressing.
 */
export function OwnerConfirmationActions({
  disabled,
  onConfirm,
  onSendBack,
}: {
  /** Whether no answer from here could succeed right now. Every control below follows it. */
  disabled: boolean;
  onConfirm: () => void;
  /** Called with the reason, trimmed — and never with an empty one. */
  onSendBack: (note: string) => void;
}): JSX.Element {
  const noteId = useId();
  const boxId = useId();
  const [backOpen, setBackOpen] = useState(false);
  const [note, setNote] = useState('');
  return (
    <CardActions className="decision-ask-actions">
      <CardActionButton tone="primary" disabled={disabled} onClick={onConfirm}>
        {OWNER_CONFIRM_ACTION}
      </CardActionButton>
      <div className="decision-ask-back">
        <CardActionButton
          tone="secondary"
          disabled={disabled}
          expanded={backOpen}
          controls={boxId}
          onClick={() => setBackOpen(!backOpen)}
        >
          {OWNER_SEND_BACK_ACTION}
        </CardActionButton>
        {backOpen && (
          <div className="decision-ask-why" id={boxId}>
            <label className="decision-ask-why-label" htmlFor={noteId}>
              {OWNER_SEND_BACK_LABEL}
            </label>
            <textarea
              id={noteId}
              className="decision-ask-note"
              rows={3}
              value={note}
              disabled={disabled}
              onChange={(event) => setNote(event.target.value)}
            />
            <div className="owner-confirmation-hint">{OWNER_SEND_BACK_HINT}</div>
            {/* The door refuses a send-back with no reason and writes nothing, so the control that
                would send one is not pressable until there is one. */}
            <CardActions className="decision-ask-send">
              <CardActionButton
                tone="secondary"
                disabled={disabled || note.trim() === ''}
                onClick={() => onSendBack(note.trim())}
              >
                {OWNER_SEND_ACTION}
              </CardActionButton>
            </CardActions>
          </div>
        )}
      </div>
    </CardActions>
  );
}

/** The card. Presentational: it takes the read and issues no request. */
export function OwnerConfirmationCard({
  view,
  waiting,
  busy = false,
  error = null,
  onDecide,
}: {
  view: Pick<OwnerConfirmationView, 'taskId' | 'title' | 'acceptanceCriteria'>;
  waiting: OwnerConfirmationWaiting;
  /** A press from this card is on its way to the door. */
  busy?: boolean;
  /** The door's refusal of the last press, when it refused. */
  error?: Error | null;
  onDecide: (decision: OwnerDecision, note?: string) => void;
}): JSX.Element {
  const refusal = error ? ownerDecisionRefusal(error) : null;
  return (
    // Where the pinned line's pointer lands (`revealOwnerConfirmationCard`).
    <div
      className="approval-card decision-ask evidence-decision owner-confirmation"
      data-owner-confirmation={waiting.requestId}
    >
      <div className="approval-head decision-ask-head">
        <span className="evidence-decision-heading">{OWNER_CONFIRMATION_HEADING}</span>
        <span className="criteria-provenance" title={OWNER_CONFIRMATION_PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions decision-ask-body">
        <section className="decision-ask-q">
          <div className="decision-ask-claim owner-confirmation-lead">{view.title}</div>
          <div className="decision-ask-meta">{`${view.taskId} · OWNER_CONFIRMED`}</div>
          <OwnerConfirmationBoxes acceptanceCriteria={view.acceptanceCriteria} report={waiting.report} />
          {error && refusal ? (
            <Alert
              className="evidence-decision-error"
              type={refusal.stale ? 'warning' : 'error'}
              showIcon
              message={refusal.title}
              description={error.message}
            />
          ) : null}
          <OwnerConfirmationActions
            disabled={busy}
            onConfirm={() => onDecide('CONFIRM')}
            onSendBack={(note) => onDecide('SEND_BACK', note)}
          />
        </section>
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
}: {
  sessionId: string;
  /** The task this session runs; an ordinary conversation has none and gets no card. */
  taskId: string | null | undefined;
}): JSX.Element | null {
  const qc = useQueryClient();
  const location = useLocation();
  const read = useQuery({
    ...ownerConfirmationQuery(taskId ?? ''),
    enabled: Boolean(taskId),
    refetchInterval: 20_000,
  });
  const waiting = ownerConfirmationWaitingIn(read.data, sessionId);
  const answer = useMutation({
    mutationFn: (press: { requestId: string; decision: OwnerDecision; note?: string }) =>
      sendOwnerDecision(taskId ?? '', press.requestId, press.decision, press.note),
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

  if (!taskId || !read.data || !waiting) return null;
  return (
    <OwnerConfirmationCard
      key={waiting.requestId}
      view={read.data}
      waiting={waiting}
      busy={answer.isPending}
      error={answer.isError ? answer.error : null}
      onDecide={(decision, note) =>
        answer.mutate({ requestId: waiting.requestId, decision, note })}
    />
  );
}

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
}: {
  view: Pick<OwnerConfirmationView, 'title' | 'acceptanceCriteria'>;
  decided: RecordedOwnerDecision;
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
        <span className="criteria-provenance" title={OWNER_CONFIRMATION_PROVENANCE_TITLE}>
          {PROVENANCE_LABEL}
        </span>
      </div>
      <div className="approval-body is-questions decision-ask-body">
        <section className="decision-ask-q">
          <div className="decision-ask-chip">{view.title}</div>
          <div className="decision-ask-picked">{ownerDecisionReceiptLine(decided)}</div>
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
