/**
 * The legacy wire words (`status`, `runStatus`, and through them `runState` and `sessionState`) derived from a
 * session's facts, so the server no longer needs the stored word to answer deployed apps and runners
 * (docs/session-status-retirement-plan.md §3.1, §6; task T4). One projector (`legacySessionStatus`), its SQL twin
 * (`session_legacy_status`, migrations 1621 and 1671) and the `?status=` condition (`statusWordFilter`). The three are
 * held to each other over every row shape by session-legacy-words.spec.ts and session-legacy-words.pg.spec.ts.
 *
 * Nothing here reads the stored word. A held row (`finished_at` null) reads its turn state, AWAITING_INPUT with none.
 * A released row reads its release facts; first match wins:
 *   P1  no end asked and the last turn failed                                    FAILED
 *   P2  no end asked, no turn outcome, a transcript import still marked pending  FAILED
 *   P3  a LANDING container with no end asked                                    SUCCEEDED or CANCELLED, by its landing
 *   P4  its task ended DONE (`task_done`) and it had started                     SUCCEEDED
 *   P5  anything else                                                            CANCELLED
 * The released kinds that read another word than the one stored before deploy D3 are the plan's §3.4 (C1-C8). No word
 * is stored since deploy D4 (migration 1691): this projector and its SQL twin are where the words come from.
 */
import { Prisma } from '@prisma/client';
import { RunStatus, SessionEndReason } from '@orbit/shared';

import { landingContainerStatus } from '../projects/landing-session';
import { heldSessionWord, turnStateFilter } from './session-turn-state';

/** The session columns the projector reads. */
export interface LegacyStatusFacts {
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
export function withoutWordFacts<T>(row: T): Omit<T, Exclude<keyof LegacyStatusFacts, 'endReason'>> {
  const {
    finishedAt: _finishedAt, turnState: _turnState, lastTurnOutcome: _lastTurnOutcome, startedAt: _startedAt,
    importSourceCwd: _importSourceCwd, sessionKind: _sessionKind, ...rest
  } = row as T & Partial<LegacyStatusFacts>;
  return rest as unknown as Omit<T, Exclude<keyof LegacyStatusFacts, 'endReason'>>;
}

/**
 * Raw SQL: the word legacySessionStatus gives the session row the query names `sessionAlias`, through its SQL twin
 * (the eight-argument form of migration 1671), with a LANDING container's settlement read from its `project_landing`
 * row. Text.
 */
export function legacySessionStatusSql(sessionAlias: string): Prisma.Sql {
  const session = Prisma.raw(sessionAlias);
  return Prisma.sql`session_legacy_status(${session}."finished_at", ${session}."turn_state", ${session}."end_reason",
    ${session}."last_turn_outcome", ${session}."started_at", ${session}."import_source_cwd", ${session}."kind",
    (SELECT landing."settled_as" FROM "project_landing" landing WHERE landing."session_id" = ${session}."id"))`;
}

/**
 * The word a session reads on the wire. `landing` is the `project_landing` row of a LANDING container (null or absent
 * for every other session, and for a landing with no row, which reads as unsettled-without-landing: CANCELLED).
 */
export function legacySessionStatus(facts: LegacyStatusFacts, landing?: LandingSettlement | null): RunStatus {
  if (facts.finishedAt == null) return heldSessionWord(facts);
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
 * conversations only, so the condition never selects one. A held word reads the turn state as heldSessionWord does
 * (turnStateFilter). A word the protocol does not have gives undefined.
 */
export function statusWordFilter(word: string): Prisma.SessionWhereInput | undefined {
  const conversation = (where: Prisma.SessionWhereInput): Prisma.SessionWhereInput =>
    ({ AND: [{ sessionKind: 'CONVERSATION' }, where] });
  const released: Prisma.SessionWhereInput = { finishedAt: { not: null } };
  switch (word) {
    case RunStatus.PENDING:
      return conversation(turnStateFilter(['QUEUED']));
    case RunStatus.RUNNING:
      return conversation(turnStateFilter(['IN_FLIGHT']));
    case RunStatus.INTERRUPTED:
      return conversation(turnStateFilter(['ABANDONED']));
    case RunStatus.AWAITING_INPUT:
      return conversation(turnStateFilter([null]));
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
