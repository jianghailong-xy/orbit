import { SESSION_PHASES, type SessionPhase } from '@orbit/shared';
import type { SessionStateSource } from './sessionState';

/**
 * What every web surface draws for a session's state (the approved board, docs/mocks/session-display-three-states,
 * capture/rules.mjs minus its Disconnected mark: the owner's approval of 2026-11-25). Two functions and nothing else:
 *
 * - sessionDisplayState: the state icon and word, from `phase` alone. Exactly three.
 * - sessionMarks: everything that is not activity, one mark per fact the server sends, in drawing order.
 *
 * Both answer null for a payload from a control plane too old to send `phase` and `released`: the surface then draws
 * exactly what it drew before (its legacy reading, pinned by legacyBaseline.test.ts). No surface turns the facts back
 * into the seven run states to pick an icon or a word; sessionDisplayGuard.test.ts holds every surface to that.
 */

export type SessionStateIcon = 'clock' | 'spinner' | 'message';

export interface SessionDisplayState {
  phase: SessionPhase;
  word: string;
  icon: SessionStateIcon;
}

const STATES: Record<SessionPhase, { word: string; icon: SessionStateIcon }> = {
  PENDING: { word: 'Queued', icon: 'clock' },
  RUNNING: { word: 'Running', icon: 'spinner' },
  IDLE: { word: 'Idle', icon: 'message' },
};

// Read here rather than through sessionState's readers, which import this module: the same rule (a value this client
// does not know reads as absent, since the contract's lists can grow).
const PHASES: ReadonlySet<string> = new Set(SESSION_PHASES);
const phaseOf = (session: SessionStateSource): SessionPhase | null =>
  typeof session.phase === 'string' && PHASES.has(session.phase) ? (session.phase as SessionPhase) : null;

/** Whether the payload carries the facts (contracts/session-state.contract.json); an older server sends neither. */
const hasFacts = (session: SessionStateSource): boolean =>
  phaseOf(session) !== null && typeof session.released === 'boolean';

/** The state: `phase` alone. Null from an older control plane. */
export function sessionDisplayState(session: SessionStateSource): SessionDisplayState | null {
  const phase = phaseOf(session);
  if (!phase || !hasFacts(session)) return null;
  return { phase, ...STATES[phase] };
}

export type SessionMark =
  | 'NEEDS_YOU'
  | 'FAILED'
  | 'RETRYING'
  | 'ON_HOLD';

/** The only colour a mark may carry: amber = the person has to act, red = a failure nobody is retrying, grey = everything
 *  else. */
export type SessionMarkTone = 'amber' | 'red' | 'grey';

export const SESSION_MARKS: Record<SessionMark, { word: string; tone: SessionMarkTone }> = {
  NEEDS_YOU: { word: 'Needs you', tone: 'amber' },
  FAILED: { word: 'Failed', tone: 'red' },
  RETRYING: { word: 'Retrying', tone: 'grey' },
  ON_HOLD: { word: 'On hold', tone: 'grey' },
};

/** The fields beside the six facts that a mark reads: the approvals count, and the background work the server counts
 *  (read by sessionRowIcons). */
export type SessionMarkSource = SessionStateSource & {
  pendingApprovals?: number | null;
  runningBgCount?: number | null;
};

/** Released by a move to another workspace (`endReason` moved): the server let it go so its runner could commit what it
 *  left, which the person who moved it is not told about. Every surface draws it as a held idle session: no Ended mark,
 *  its idle word and icon, no ended banner; sending to it still resumes it (board docs/mocks/session-move-released). */
export const sessionReleasedByMove = (session: SessionStateSource): boolean =>
  session.released === true && session.endReason === 'moved';

/** A release the server counts as a failure (decision D9): released, the last turn failed, and nobody asked for an end. */
const releasedByFailure = (session: SessionStateSource): boolean =>
  session.released === true && !session.endReason && session.lastTurnOutcome === 'FAILED';

/**
 * The marks of one session, in the order they are drawn after the state word. Each reads one fact as the server sent
 * it. A released failure is red Failed whatever its error says (no client matches error text); one the server will
 * retry (`waitingOn` WAKE) is grey Retrying instead. Null from an older control plane.
 */
export function sessionMarks(session: SessionMarkSource): SessionMark[] | null {
  if (!hasFacts(session)) return null;
  const waitingOn = session.waitingOn;
  const failure = releasedByFailure(session);
  const out: SessionMark[] = [];
  if (waitingOn === 'PERSON' || (session.pendingApprovals ?? 0) > 0) out.push('NEEDS_YOU');
  if (failure) out.push(waitingOn === 'WAKE' ? 'RETRYING' : 'FAILED');
  if (waitingOn === 'HOLD') out.push('ON_HOLD');
  return out;
}

/** A fact a list row draws as an icon on its title line instead of a chip (the owner, 2026-11-27): a release by a
 *  failure (Failed, or Retrying when the server will retry it) and a held queued turn (On hold), which every other
 *  surface still draws as marks; background work still running and a wake (a watch, a scheduled wake-up or an armed
 *  retry) that will resume a held session, which no other surface draws. */
export type SessionRowIcon = 'FAILED' | 'RETRYING' | 'ON_HOLD' | 'BACKGROUND' | 'WILL_RESUME';

export const SESSION_ROW_ICON_TIPS: Record<SessionRowIcon, string> = {
  FAILED: 'Failed',
  RETRYING: 'Retrying',
  ON_HOLD: 'On hold',
  BACKGROUND: 'Background work running',
  WILL_RESUME: 'Will resume',
};

/** The tasks a session created that are running or queued now, as its list row carries them (`createdTasksActive`). */
export interface SessionCreatedTasksActive {
  running: number;
  queued: number;
}

/**
 * The count a list row draws beside its title for the tasks its session created that are being worked on now
 * (docs/mocks/session-row-running-tasks, the owner's choices 2026-11-28): running and queued together, null when none
 * or from an older control plane. Drawn whatever the session itself is doing, Completed rows included: the session
 * may be done while its tasks still run. Failed tasks and tasks waiting on you are not counted.
 */
export function sessionCreatedTasksCount(active: SessionCreatedTasksActive | null | undefined): number | null {
  const count = (active?.running ?? 0) + (active?.queued ?? 0);
  return count > 0 ? count : null;
}

/** The count's tip: `2 tasks running · 1 queued`, `1 task queued`, leaving out what is none. */
export function sessionCreatedTasksTip(active: SessionCreatedTasksActive): string {
  const running = active.running > 0 ? `${active.running} ${active.running === 1 ? 'task' : 'tasks'} running` : '';
  if (!active.queued) return running;
  return running ? `${running} · ${active.queued} queued` : `${active.queued} ${active.queued === 1 ? 'task' : 'tasks'} queued`;
}

/** The marks a list row draws as icons rather than chips. */
const ROW_ICON_MARKS: ReadonlySet<SessionMark> = new Set<SessionMark>(['FAILED', 'RETRYING', 'ON_HOLD']);

/** The chips a list row draws after its line: the marks less those it draws as title-line icons, so Needs you alone.
 *  Null from an older control plane. */
export function sessionRowMarks(session: SessionMarkSource): SessionMark[] | null {
  return sessionMarks(session)?.filter((mark) => !ROW_ICON_MARKS.has(mark)) ?? null;
}

/** The title-line icons of a list row, in drawing order: Failed / Retrying and On hold (the marks of those names), then
 *  Background and Will resume for a held session. Interrupted, Finished and Ended are not drawn at all. */
export function sessionRowIcons(session: SessionMarkSource): SessionRowIcon[] {
  const out: SessionRowIcon[] = (sessionMarks(session) ?? []).filter((mark): mark is SessionRowIcon & SessionMark =>
    ROW_ICON_MARKS.has(mark));
  if (!hasFacts(session) || session.released === true) return out;
  if (session.activity === 'BACKGROUND_JOB' || (session.runningBgCount ?? 0) > 0) out.push('BACKGROUND');
  if (session.waitingOn === 'WAKE') out.push('WILL_RESUME');
  return out;
}

/** The state word and the marks as one line of text, separated by " · " (the board's Markdown form: `Idle · Needs you`).
 *  Null from an older control plane. */
export function sessionDisplayText(session: SessionMarkSource): string | null {
  const state = sessionDisplayState(session);
  const marks = sessionMarks(session);
  if (!state || !marks) return null;
  return [state.word, ...marks.map((m) => SESSION_MARKS[m].word)].join(' · ');
}
