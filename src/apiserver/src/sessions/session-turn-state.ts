/**
 * A held session's turn state, the explicit fact for runner slots and claims (docs/session-status-retirement-plan.md
 * §1.3, §2.1), read NULL-safely for the readers that move off `session.status` (tasks T7 to T12).
 *
 * `session.turn_state` is QUEUED, IN_FLIGHT, ABANDONED or null, one for one with the held words PENDING, RUNNING,
 * INTERRUPTED and AWAITING_INPUT. Migration 1611's trigger keeps it from the word on every write of the word, but a
 * held row nothing has written since that migration has none until the backfill (task T3) fills it, and readers may
 * reach production before the backfill has run (project rule, 2026-11-25). So a held row with no turn state reads its
 * STORED word: here (`heldSessionWord`, which legacySessionStatus in session-legacy-words.ts reads too, the Prisma
 * filter and the SQL fragment below) and in that projector's SQL twin, and nowhere else. That read goes with the column's writers (task T14).
 *
 * A leaf: it imports nothing of the projects or tasks modules, so every one of them can import it.
 */
import { Prisma } from '@prisma/client';
import { RunStatus } from '@orbit/shared';

import { isHeldStatus } from '../common/session-release';

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

/** The columns turnStateOf reads. `status` is the fallback the header describes, read for nothing else. */
export const TURN_STATE_SELECT = { status: true, finishedAt: true, turnState: true } as const;

/** What turnStateOf reads. A row with no `turnState` key reads as one not yet backfilled: its stored word decides. */
export interface TurnStateFacts {
  status: string;
  finishedAt: Date | string | null;
  turnState?: string | null;
}

/** The word of a held row: its turn state's, or with none its stored word. legacySessionStatus's held branch. */
export function heldSessionWord(facts: TurnStateFacts): RunStatus {
  if (facts.turnState != null) {
    return HELD_WORD_OF_TURN_STATE[facts.turnState as TurnState] ?? RunStatus.AWAITING_INPUT;
  }
  // No turn state: parked, or not yet backfilled. A parked row stores AWAITING_INPUT, so both read the stored word.
  const session = facts;
  return isHeldStatus(session.status) ? session.status as RunStatus : RunStatus.AWAITING_INPUT;
}

/**
 * The session's turn state (plan §2.1: Q, F, I), null when it is parked or released: the word legacySessionStatus
 * gives a held row, read as a turn state, so a reader moved onto it decides what it decided from the stored word.
 */
export function turnStateOf(facts: TurnStateFacts): TurnState | null {
  if (facts.finishedAt != null) return null;
  return TURN_STATE_OF_HELD_WORD[heldSessionWord(facts)] ?? null;
}

/** Held with no turn queued, in flight or abandoned: what AWAITING_INPUT said (plan §2.1: A). */
export function isParked(facts: TurnStateFacts): boolean {
  return facts.finishedAt == null && turnStateOf(facts) === null;
}

/**
 * Prisma filter: held, and its turn state is one of `states` (null for parked), as turnStateOf reads it. Its keys are
 * `finishedAt` and `OR`, so spread it only into a filter that names neither, or put it in an `AND` list.
 */
export function turnStateFilter(states: ReadonlyArray<TurnState | null>): Prisma.SessionWhereInput {
  const named = states.filter((state): state is TurnState => state !== null);
  const words: string[] = named.map((state) => HELD_WORD_OF_TURN_STATE[state]);
  // A row with no turn state reads its stored word: the words of the named states, and for parked every word that
  // names no turn state, as heldSessionWord reads it.
  const turnWords = Object.keys(TURN_STATE_OF_HELD_WORD) as RunStatus[];
  const session: Prisma.SessionWhereInput = states.includes(null)
    ? { turnState: null, status: { notIn: turnWords.filter((word) => !words.includes(word)) } }
    : { turnState: null, status: { in: turnWords.filter((word) => words.includes(word)) } };
  return {
    finishedAt: null,
    OR: [...(named.length > 0 ? [{ turnState: { in: named } }] : []), session],
  };
}

/**
 * Raw SQL: the turn state of the session row the query names `sessionAlias` (a constant, never input), as turnStateOf
 * reads it: NULL when the row is released or parked. Compare it with `=` for a state, `IS NULL` beside `finished_at IS
 * NULL` for parked, and `IS DISTINCT FROM` for a negation. `session_turn_state_of_status` is migration 1611's.
 */
export function sessionTurnStateSql(sessionAlias: string): Prisma.Sql {
  const session = Prisma.raw(sessionAlias);
  return Prisma.sql`(CASE WHEN ${session}."finished_at" IS NULL THEN COALESCE(${session}."turn_state", session_turn_state_of_status(${session}."status")) END)`;
}
