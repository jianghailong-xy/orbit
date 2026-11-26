/**
 * A held session's turn state, the explicit fact for runner slots and claims (docs/session-status-retirement-plan.md
 * §1.3, §2.1), which the readers moved off `session.status` read (tasks T7 to T12).
 *
 * `session.turn_state` is QUEUED, IN_FLIGHT, ABANDONED or null, one for one with the held words PENDING, RUNNING,
 * INTERRUPTED and AWAITING_INPUT. The writers write it (deploy D3, task T14) and nothing reads the stored word: every
 * row has been backfilled (task T3) and migration 1652 holds the two spellings equal, so a held row with no turn state
 * is parked.
 *
 * A leaf: it imports nothing of the projects or tasks modules, nor of common/, so every one of them can import it
 * (common/session-release.ts and the slot helpers beside it read their turn states here).
 */
import { Prisma } from '@prisma/client';
import { RunStatus } from '@orbit/shared';

/**
 * Where a held session's turn stands for the runner (plan §1.3): it waits for a claim, a dispatched turn holds a
 * runner slot, or its runner was stopped under it. A parked or released session has none.
 */
export type TurnState = 'QUEUED' | 'IN_FLIGHT' | 'ABANDONED';

const HELD_WORD_OF_TURN_STATE: Readonly<Record<TurnState, RunStatus>> = {
  QUEUED: RunStatus.PENDING,
  IN_FLIGHT: RunStatus.RUNNING,
  ABANDONED: RunStatus.INTERRUPTED,
};

const TURN_STATE_OF_HELD_WORD: Readonly<Record<string, TurnState>> = Object.fromEntries(
  Object.entries(HELD_WORD_OF_TURN_STATE).map(([state, word]) => [word, state as TurnState]),
);

/**
 * `statusAfterTurnEnqueued` (common/session-scheduling.ts) on the turn state of a held session: a parked or abandoned
 * session's new turn waits for a claim (QUEUED), and one queued or in flight stays where it is.
 */
export function turnStateAfterTurnEnqueued(turn: TurnState | null): TurnState {
  return turn === 'QUEUED' || turn === 'IN_FLIGHT' ? turn : 'QUEUED';
}

/** The columns turnStateOf reads. */
export const TURN_STATE_SELECT = { finishedAt: true, turnState: true } as const;

/** What turnStateOf reads. */
export interface TurnStateFacts {
  finishedAt: Date | string | null;
  turnState: string | null;
}

/** The word of a held row: its turn state's, AWAITING_INPUT with none. legacySessionStatus's held branch. */
export function heldSessionWord(facts: TurnStateFacts): RunStatus {
  return (facts.turnState != null ? HELD_WORD_OF_TURN_STATE[facts.turnState as TurnState] : undefined)
    ?? RunStatus.AWAITING_INPUT;
}

/**
 * The session's turn state (plan §2.1: Q, F, I), null when it is parked or released: the word legacySessionStatus
 * gives a held row, read as a turn state, so a reader moved onto it decides what it decided from the stored word.
 */
export function turnStateOf(facts: TurnStateFacts): TurnState | null {
  if (facts.finishedAt != null) return null;
  return TURN_STATE_OF_HELD_WORD[heldSessionWord(facts)] ?? null;
}

/**
 * The turn state of a held word, one for one, null for AWAITING_INPUT and every released word: what a writer that
 * decides in words (the runner's turn-complete and finalize, plan §3.2) stores. The mapping the dropped column's
 * backfill and its agreement CHECK held (migrations 1611 and 1652).
 */
export function turnStateOfWord(word: string): TurnState | null {
  return TURN_STATE_OF_HELD_WORD[word] ?? null;
}

/** Held with no turn queued, in flight or abandoned: what AWAITING_INPUT said (plan §2.1: A). */
export function isParked(facts: TurnStateFacts): boolean {
  return facts.finishedAt == null && turnStateOf(facts) === null;
}

/**
 * Prisma filter: held, and its turn state is one of `states` (null for parked), as turnStateOf reads it. Its keys are
 * `finishedAt` and `OR`, so spread it only into a filter that names neither, or put it in an `AND` list. Never null in
 * SQL (the `IN` is asked only beside `turn_state IS NOT NULL`), so a `NOT` of it is the rows it does not match.
 */
export function turnStateFilter(states: ReadonlyArray<TurnState | null>): Prisma.SessionWhereInput {
  const named = states.filter((state): state is TurnState => state !== null);
  return {
    finishedAt: null,
    OR: [
      ...(named.length > 0 ? [{ turnState: { not: null, in: named } }] : []),
      ...(states.includes(null) ? [{ turnState: null }] : []),
    ],
  };
}

/**
 * Raw SQL: the turn state of the session row the query names `sessionAlias` (a constant, never input), as turnStateOf
 * reads it: NULL when the row is released or parked. Compare it with `=` for a state, `IS NULL` beside `finished_at IS
 * NULL` for parked, and `IS DISTINCT FROM` for a negation. The SQL twin of session_held_turn_state (migration 1671).
 */
export function sessionTurnStateSql(sessionAlias: string): Prisma.Sql {
  const session = Prisma.raw(sessionAlias);
  return Prisma.sql`(CASE WHEN ${session}."finished_at" IS NULL THEN ${session}."turn_state" END)`;
}
