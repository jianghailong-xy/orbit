/**
 * The legacy wire words (`status`, `runStatus`, and through them `runState` and `sessionState`) derived from a
 * session's facts, so the server no longer needs the stored word to answer deployed apps and runners
 * (docs/session-status-retirement-plan.md §3.1, §6; task T4). One projector (`legacySessionStatus`), its SQL twin
 * (`session_legacy_status`, migration 1621) and the `?status=` condition (`statusWordFilter`). The three are held to
 * each other over every row shape by session-legacy-words.spec.ts and session-legacy-words.pg.spec.ts.
 *
 * A held row (`finished_at` null) reads its turn state. One with no turn state reads its STORED word: a held row
 * that nothing has written since migration 1611 added the column has none until the backfill (task T3) fills it, and
 * deploy 1 and this projector can reach production together. That one read of `session.status` is made here and in
 * the SQL twin only, and goes with the column's writers (task T14). A released row reads no stored word; first match
 * wins:
 *   P1  no end asked and the last turn failed                                    FAILED
 *   P2  no end asked, no turn outcome, a transcript import still marked pending  FAILED
 *   P3  a LANDING container with no end asked                                    SUCCEEDED or CANCELLED, by its landing
 *   P4  its task ended DONE (`task_done`) and it had started                     SUCCEEDED
 *   P5  anything else                                                            CANCELLED
 * The released kinds that read another word than the one stored are the plan's §3.4 (C1-C7).
 */
import { Prisma } from '@prisma/client';
import { RunStatus, SessionEndReason } from '@orbit/shared';

import { isHeldStatus } from '../common/session-release';
import { landingContainerStatus } from '../projects/landing-session';

/** The session columns the projector reads. */
export interface LegacyStatusFacts {
  /** The stored word, read only for a held row with no turn state (see above). Task T14 removes it. */
  status: string;
  finishedAt: Date | string | null;
  turnState: string | null;
  endReason: string | null;
  lastTurnOutcome: string | null;
  startedAt: Date | string | null;
  importSourceCwd: string | null;
  sessionKind: string;
}

/** The columns LegacyStatusFacts reads, for a Prisma `select`. */
export const LEGACY_STATUS_SELECT = {
  status: true,
  finishedAt: true,
  turnState: true,
  endReason: true,
  lastTurnOutcome: true,
  startedAt: true,
  importSourceCwd: true,
  sessionKind: true,
} as const;

/** The settlement of a LANDING container's `project_landing` row, which P3 reads. */
export interface LandingSettlement {
  settledAt: Date | string | null;
  settledAs: string | null;
}

/**
 * The settlements P3 needs for these rows, by session id. Reads only when a row is a released LANDING container with
 * no end asked, so conversations cost nothing.
 */
export async function readLandingSettlements(
  db: Pick<Prisma.TransactionClient, 'projectLanding'>,
  rows: ReadonlyArray<{ id: string; sessionKind: string; finishedAt: Date | string | null; endReason: string | null }>,
): Promise<Map<string, LandingSettlement>> {
  const ids = rows
    .filter((row) => row.sessionKind === 'LANDING' && row.finishedAt != null && row.endReason == null)
    .map((row) => row.id);
  if (ids.length === 0) return new Map();
  const landings = await db.projectLanding.findMany({
    where: { sessionId: { in: ids } },
    select: { sessionId: true, settledAt: true, settledAs: true },
  });
  return new Map(landings.map(({ sessionId, ...settlement }) => [sessionId, settlement]));
}

/**
 * The row without the facts a narrow select read only for the projector, so a payload built from it carries the keys
 * it carried before (`endReason` stays: every such payload had it). A payload's own facts are session-phase.ts's.
 */
export function withoutWordFacts<T>(row: T): Omit<T, Exclude<keyof LegacyStatusFacts, 'endReason' | 'status'>> {
  const {
    finishedAt: _finishedAt, turnState: _turnState, lastTurnOutcome: _lastTurnOutcome, startedAt: _startedAt,
    importSourceCwd: _importSourceCwd, sessionKind: _sessionKind, ...rest
  } = row as T & Partial<LegacyStatusFacts>;
  return rest as unknown as Omit<T, Exclude<keyof LegacyStatusFacts, 'endReason' | 'status'>>;
}

const HELD_WORD_OF_TURN_STATE: Record<HeldTurnState, RunStatus> = {
  QUEUED: RunStatus.PENDING,
  IN_FLIGHT: RunStatus.RUNNING,
  ABANDONED: RunStatus.INTERRUPTED,
};

/** The columns a held row's word and turn state read. */
export type HeldTurnFacts = Pick<LegacyStatusFacts, 'status' | 'finishedAt' | 'turnState'>;

/** The word of a held row: its turn state's, or with none its stored word (parked, or not yet backfilled). */
function heldWord(facts: HeldTurnFacts): RunStatus {
  if (facts.turnState != null) return HELD_WORD_OF_TURN_STATE[facts.turnState as HeldTurnState] ?? RunStatus.AWAITING_INPUT;
  // No turn state: parked, or not yet backfilled. A parked row stores AWAITING_INPUT, so both read the stored word.
  const session = facts;
  return isHeldStatus(session.status) ? session.status as RunStatus : RunStatus.AWAITING_INPUT;
}

/**
 * The word a session reads on the wire. `landing` is the `project_landing` row of a LANDING container (null or absent
 * for every other session, and for a landing with no row, which reads as unsettled-without-landing: CANCELLED).
 */
export function legacySessionStatus(facts: LegacyStatusFacts, landing?: LandingSettlement | null): RunStatus {
  if (facts.finishedAt == null) return heldWord(facts);
  if (facts.endReason == null) {
    if (facts.lastTurnOutcome === 'FAILED') return RunStatus.FAILED;
    if (facts.lastTurnOutcome == null && facts.importSourceCwd != null) return RunStatus.FAILED;
    if (facts.sessionKind === 'LANDING') {
      // A released container is settled; its row's writer rule says which word (landing-session.ts).
      const settled = landingContainerStatus({ settledAt: facts.finishedAt, settledAs: landing?.settledAs ?? null });
      return settled as string as RunStatus;
    }
  }
  if (facts.endReason === SessionEndReason.TASK_DONE && facts.startedAt != null) return RunStatus.SUCCEEDED;
  return RunStatus.CANCELLED;
}

/** P1 or P2, as a Prisma condition. Never null in SQL, so `NOT` of it is the rows it does not match. */
const releasedByAFailure: Prisma.SessionWhereInput[] = [
  { endReason: null, lastTurnOutcome: { not: null, equals: 'FAILED' } },
  { endReason: null, lastTurnOutcome: null, importSourceCwd: { not: null } },
];

/** P4, as a Prisma condition. Never null in SQL. */
const releasedFinished: Prisma.SessionWhereInput = {
  endReason: { not: null, equals: SessionEndReason.TASK_DONE },
  startedAt: { not: null },
};

/**
 * The condition that selects exactly the CONVERSATION sessions the projector gives `word`: what `?status=` means
 * (plan §6). A LANDING container's word comes from another table (P3) and the lists that filter by status show
 * conversations only, so the condition never selects one. A word the protocol does not have gives undefined.
 */
export function statusWordFilter(word: string): Prisma.SessionWhereInput | undefined {
  const conversation = (where: Prisma.SessionWhereInput): Prisma.SessionWhereInput =>
    ({ AND: [{ sessionKind: 'CONVERSATION' }, where] });
  const released: Prisma.SessionWhereInput = { finishedAt: { not: null } };
  switch (word) {
    case RunStatus.PENDING:
      return conversation({ finishedAt: null, turnState: 'QUEUED' });
    case RunStatus.RUNNING:
      return conversation({ finishedAt: null, turnState: 'IN_FLIGHT' });
    case RunStatus.INTERRUPTED:
      return conversation({ finishedAt: null, turnState: 'ABANDONED' });
    case RunStatus.AWAITING_INPUT:
      return conversation({ finishedAt: null, turnState: null });
    case RunStatus.FAILED:
      return conversation({ AND: [released, { OR: releasedByAFailure }] });
    case RunStatus.SUCCEEDED:
      return conversation({ AND: [released, releasedFinished] });
    case RunStatus.CANCELLED:
      return conversation({ AND: [released, { NOT: { OR: [...releasedByAFailure, releasedFinished] } }] });
    default:
      return undefined;
  }
}

/**
 * Where a held session's turn stands for the runner (plan §1.3): QUEUED waits for a claim, IN_FLIGHT is a dispatched
 * turn holding a runner slot, ABANDONED had its runner stopped under it; null is parked. The readers that decided on
 * PENDING, RUNNING or INTERRUPTED ask these instead, one for one (plan §2.1, Q, F, I; A is null on a held row).
 */
export type HeldTurnState = 'QUEUED' | 'IN_FLIGHT' | 'ABANDONED';

/** The held word each turn state reads. */
const HELD_WORD_OF = HELD_WORD_OF_TURN_STATE;

/** The held words that name a turn state; a held row stored with any other (AWAITING_INPUT) has none. */
const WORDS_WITH_A_TURN: RunStatus[] = Object.values(HELD_WORD_OF_TURN_STATE);

/**
 * A session's turn state: null when it is released or parked. A held row with no `turn_state` (not yet backfilled,
 * task T3) reads its stored word's, through the projector, so this answers exactly what the word answered.
 */
export function sessionTurnState(facts: HeldTurnFacts): HeldTurnState | null {
  if (facts.finishedAt != null) return null;
  return TURN_STATE_OF_HELD_WORD[heldWord(facts)] ?? null;
}

/** HELD_WORD_OF_TURN_STATE read the other way. */
const TURN_STATE_OF_HELD_WORD: Partial<Record<string, HeldTurnState>> = Object.fromEntries(
  (Object.entries(HELD_WORD_OF_TURN_STATE) as Array<[HeldTurnState, RunStatus]>).map(([state, word]) => [word, state]),
);

/**
 * The turn state a writer stores beside the word it writes (deploy 2 writes both, plan §2.2): the word's own, one for
 * one, null for AWAITING_INPUT and every released word. The same mapping as `session_turn_state_of_status`
 * (migration 1611), whose trigger derives it from the word in the same row and the CHECK of 1622 holds it to.
 */
export function turnStateOfWord(word: RunStatus | string): HeldTurnState | null {
  return TURN_STATE_OF_HELD_WORD[word] ?? null;
}

/**
 * The held word a session reads, or null when it is released: `legacySessionStatus` for a held row, from the three
 * columns that decide it. For the readers that branch on the held words only; a released row's word needs the
 * release facts (`legacySessionStatus`).
 */
export function heldSessionWord(facts: HeldTurnFacts): RunStatus | null {
  return facts.finishedAt == null ? heldWord(facts) : null;
}

/** The columns `sessionTurnState` and `heldSessionWord` read, for a Prisma `select`. */
export const TURN_STATE_SELECT = {
  status: true,
  finishedAt: true,
  turnState: true,
} as const;

/**
 * Raw SQL: TURN_STATE_SELECT for a raw statement over the session row it names `sessionAlias` (a constant, never
 * input; `"session"` for a statement with no alias), as the columns `status` and `turnState`, for `heldSessionWord`
 * and `sessionTurnState` to read.
 */
export function turnStateColumnsSql(sessionAlias: string): Prisma.Sql {
  const alias = Prisma.raw(sessionAlias);
  return Prisma.sql`${alias}."status"::text AS "status", ${alias}."turn_state" AS "turnState"`;
}

/**
 * Prisma: held sessions in one of these turn states (null: parked), exactly the rows `sessionTurnState` gives them.
 * A row with `turn_state` set reads it; one with none reads its stored word's, as `sessionTurnState` does, until the
 * backfill has filled every row (then the second arm selects nothing).
 */
export function turnStateWhere(...states: Array<HeldTurnState | null>): Prisma.SessionWhereInput {
  const set = states.filter((state): state is HeldTurnState => state != null);
  const parked = states.includes(null);
  const words = set.map((state) => HELD_WORD_OF[state]);
  const unfilled: Prisma.SessionWhereInput = {
    turnState: null,
    status: parked ? { notIn: WORDS_WITH_A_TURN.filter((word) => !words.includes(word)) } : { in: words },
  };
  return {
    finishedAt: null,
    OR: [...(set.length > 0 ? [{ turnState: { in: set } }] : []), unfilled],
  };
}

/**
 * Raw SQL: the session row the query names `sessionAlias` (a constant, never input) is held in one of these turn
 * states (null: parked): `turnStateWhere` for a raw statement. The `turn_state` arm is the partial indexes' access
 * path (migrations 1627-1633); the stored word's arm reads a row not yet backfilled, as `sessionTurnState` does.
 */
export function sessionTurnStateSql(sessionAlias: string, ...states: Array<HeldTurnState | null>): Prisma.Sql {
  const alias = Prisma.raw(sessionAlias);
  const set = states.filter((state): state is HeldTurnState => state != null);
  const parked = states.includes(null);
  const words = set.map((state) => HELD_WORD_OF[state]);
  // Constants of this module written as literals, not parameters: the planner proves a partial index's predicate, and
  // matches the stored word's index, only against a constant of the column's own type.
  const list = (values: string[]) => Prisma.raw(values.map((value) => `'${value}'`).join(', '));
  const unfilledWords = parked ? WORDS_WITH_A_TURN.filter((word) => !words.includes(word)) : words;
  const unfilled = !parked
    ? Prisma.sql`${alias}."status" IN (${list(unfilledWords)})`
    : unfilledWords.length > 0 ? Prisma.sql`${alias}."status" NOT IN (${list(unfilledWords)})` : Prisma.sql`TRUE`;
  const filled = set.length > 0 ? Prisma.sql`${alias}."turn_state" IN (${list(set)}) OR ` : Prisma.empty;
  return Prisma.sql`(${alias}."finished_at" IS NULL AND (${filled}(${alias}."turn_state" IS NULL AND ${unfilled})))`;
}
