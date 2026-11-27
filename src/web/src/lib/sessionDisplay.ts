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

export type SessionStateIcon = 'clock' | 'spinner' | 'circle';

export interface SessionDisplayState {
  phase: SessionPhase;
  word: string;
  icon: SessionStateIcon;
}

const STATES: Record<SessionPhase, { word: string; icon: SessionStateIcon }> = {
  PENDING: { word: 'Queued', icon: 'clock' },
  RUNNING: { word: 'Running', icon: 'spinner' },
  IDLE: { word: 'Idle', icon: 'circle' },
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
  | 'ON_HOLD'
  | 'INTERRUPTED'
  | 'BACKGROUND'
  | 'WILL_RESUME'
  | 'FINISHED'
  | 'ENDED';

/** The only colour a mark may carry: amber = the person has to act, red = a failure nobody is retrying, green = the
 *  work finished, grey = everything else. */
export type SessionMarkTone = 'amber' | 'red' | 'green' | 'grey';

export const SESSION_MARKS: Record<SessionMark, { word: string; tone: SessionMarkTone }> = {
  NEEDS_YOU: { word: 'Needs you', tone: 'amber' },
  FAILED: { word: 'Failed', tone: 'red' },
  RETRYING: { word: 'Retrying', tone: 'grey' },
  ON_HOLD: { word: 'On hold', tone: 'grey' },
  INTERRUPTED: { word: 'Interrupted', tone: 'grey' },
  BACKGROUND: { word: 'Background', tone: 'grey' },
  WILL_RESUME: { word: 'Will resume', tone: 'grey' },
  FINISHED: { word: 'Finished', tone: 'green' },
  ENDED: { word: 'Ended', tone: 'grey' },
};

/** The fields beside the six facts that a mark reads: the approvals count and the background work the server counts. */
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
  const released = session.released === true;
  const failure = releasedByFailure(session);
  const out: SessionMark[] = [];
  if (waitingOn === 'PERSON' || (session.pendingApprovals ?? 0) > 0) out.push('NEEDS_YOU');
  if (failure) out.push(waitingOn === 'WAKE' ? 'RETRYING' : 'FAILED');
  if (waitingOn === 'HOLD') out.push('ON_HOLD');
  if (!released && phaseOf(session) === 'IDLE' && session.lastTurnOutcome === 'INTERRUPTED')
    out.push('INTERRUPTED');
  if (!released && (session.activity === 'BACKGROUND_JOB' || (session.runningBgCount ?? 0) > 0)) out.push('BACKGROUND');
  // An idle session a watch or wake-up will resume is just Idle: no mark (the owner, 2026-11-27).
  if (!released && waitingOn === 'WAKE' && phaseOf(session) !== 'IDLE') out.push('WILL_RESUME');
  if (released && session.workFinished === true) out.push('FINISHED');
  if (released && session.workFinished !== true && !failure && !sessionReleasedByMove(session)) out.push('ENDED');
  return out;
}

/** The state word and the marks as one line of text, separated by " · " (the board's Markdown form: `Idle · Finished`).
 *  Null from an older control plane. */
export function sessionDisplayText(session: SessionMarkSource): string | null {
  const state = sessionDisplayState(session);
  const marks = sessionMarks(session);
  if (!state || !marks) return null;
  return [state.word, ...marks.map((m) => SESSION_MARKS[m].word)].join(' · ');
}
