/**
 * A session a contract vector gives (contracts/watch.contract.json) as the row the pg specs insert. A vector states
 * the stored facts (finishedAt, turnState, endReason, lastTurnOutcome; docs/session-status-retirement-plan.md §2.6),
 * and the word the specs still write beside them is the one the projector derives from those facts, so a vector and
 * its row cannot disagree. The column goes with tasks T14 and T15.
 */
import { legacySessionStatus } from '../sessions/session-legacy-words';

export interface VectorSession {
  finishedAt: string | null;
  turnState?: string | null;
  startedAt?: string | null;
  endReason?: string | null;
  lastTurnOutcome?: string | null;
}

export function vectorSessionStatus(given: VectorSession): string {
  return legacySessionStatus({
    // Read only for a held row with no turn state, which is a parked one.
    status: 'AWAITING_INPUT',
    finishedAt: given.finishedAt === null ? null : new Date(),
    turnState: given.turnState ?? null,
    endReason: given.endReason ?? null,
    lastTurnOutcome: given.lastTurnOutcome ?? null,
    startedAt: given.startedAt ? new Date() : null,
    importSourceCwd: null,
    sessionKind: 'CONVERSATION',
  });
}
