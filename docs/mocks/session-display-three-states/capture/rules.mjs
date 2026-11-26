// The board's proposal as code: what each client draws AFTER the change, from the six session facts
// (contracts/session-state.contract.json). One function decides the state, one decides the marks.
// This is a design prototype for the board, not product code; each client implements the same two
// functions in its own language. A payload without `phase` / `released` (an older control plane)
// returns null from both: the client then draws exactly what it draws today.

/** The three states. Icon names are the board's own; each client maps them to its icon set. */
export const STATES = {
  PENDING: { word: 'Queued', icon: 'clock' },
  RUNNING: { word: 'Running', icon: 'spinner' },
  IDLE: { word: 'Idle', icon: 'circle' },
};

const hasFacts = (p) => typeof p.phase === 'string' && p.phase in STATES && typeof p.released === 'boolean';

/** The state: `phase` alone. Null from an older control plane. */
export function sessionState(p) {
  return hasFacts(p) ? { phase: p.phase, ...STATES[p.phase] } : null;
}

/** A release the server counts as a failure (decision D9): released, the last turn failed, no end was asked. */
export const releasedByFailure = (p) => p.released === true && !p.endReason && p.lastTurnOutcome === 'FAILED';

/**
 * The marks, in the order they are drawn (left to right after the state word; on a phone row, the first
 * two). Each reads one fact. `tone` is the only colour a mark may carry:
 *   amber = the person has to act, red = a failure nobody is retrying, green = the work finished,
 *   grey = everything else.
 */
export const MARKS = {
  NEEDS_YOU: { word: 'Needs you', icon: 'hand', tone: 'amber', fact: 'waitingOn PERSON' },
  FAILED: { word: 'Failed', icon: 'cross', tone: 'red', fact: 'released, lastTurnOutcome FAILED, no endReason' },
  RETRYING: { word: 'Retrying', icon: 'retry', tone: 'grey', fact: 'a released failure with waitingOn WAKE (retry armed)' },
  DISCONNECTED: { word: 'Disconnected', icon: 'unplug', tone: 'grey', fact: 'a released failure whose error says the runner went offline' },
  ON_HOLD: { word: 'On hold', icon: 'pause', tone: 'grey', fact: 'waitingOn HOLD' },
  INTERRUPTED: { word: 'Interrupted', icon: 'minus', tone: 'grey', fact: 'held, phase IDLE, lastTurnOutcome INTERRUPTED' },
  BACKGROUND: { word: 'Background', icon: 'terminal', tone: 'grey', fact: 'activity BACKGROUND_JOB, or background processes left up' },
  WILL_RESUME: { word: 'Will resume', icon: 'eye', tone: 'grey', fact: 'held, waitingOn WAKE (a watch or wake-up)' },
  FINISHED: { word: 'Finished', icon: 'check', tone: 'green', fact: 'workFinished' },
  ENDED: { word: 'Ended', icon: 'stop', tone: 'grey', fact: 'released, not finished, not a failure' },
};

/** The marks of one session, in drawing order. Null from an older control plane. */
export function sessionMarks(p) {
  if (!hasFacts(p)) return null;
  const out = [];
  if (p.waitingOn === 'PERSON' || (p.pendingApprovals ?? 0) > 0) out.push('NEEDS_YOU');
  if (releasedByFailure(p)) {
    if (p.waitingOn === 'WAKE') out.push('RETRYING');
    else if (String(p.error ?? '').toLowerCase().includes('offline')) out.push('DISCONNECTED');
    else out.push('FAILED');
  }
  if (p.waitingOn === 'HOLD') out.push('ON_HOLD');
  if (!p.released && p.phase === 'IDLE' && p.lastTurnOutcome === 'INTERRUPTED') out.push('INTERRUPTED');
  if (!p.released && (p.activity === 'BACKGROUND_JOB' || (p.runningBgCount ?? 0) > 0)) out.push('BACKGROUND');
  if (!p.released && p.waitingOn === 'WAKE') out.push('WILL_RESUME');
  if (p.released && p.workFinished === true) out.push('FINISHED');
  if (p.released && p.workFinished !== true && !releasedByFailure(p)) out.push('ENDED');
  return out;
}

/** The fixture's rows, by number, in the order the board draws them (one per case; the facts-absent twin
 *  of each case is drawn as "older server" and must equal today's drawing). */
export const BOARD_CASES = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35];
