/**
 * The legacy wire words (`status`, `runStatus`, and through them `runState` and `sessionState`) derived from a
 * session's facts, so the server no longer needs the stored word to answer deployed apps and runners
 * (docs/session-status-retirement-plan.md §3.1, §6; task T4). One projector (`legacySessionStatus`), its SQL twin
 * (`session_legacy_status`, migration 1621) and the `?status=` condition (`statusWordFilter`). The three are held to
 * each other over every row shape by session-legacy-words.spec.ts and session-legacy-words.pg.spec.ts.
 *
 * A held row (`finished_at` null) reads its turn state. A released row reads, first match wins:
 *   P1  no end asked and the last turn failed                                    FAILED
 *   P2  no end asked, no turn outcome, a transcript import still marked pending  FAILED
 *   P3  a LANDING container with no end asked                                    SUCCEEDED or CANCELLED, by its landing
 *   P4  its task ended DONE (`task_done`) and it had started                     SUCCEEDED
 *   P5  anything else                                                            CANCELLED
 * The released kinds that read another word than the one stored are the plan's §3.4 (C1-C7).
 */
import { Prisma } from '@prisma/client';
import { RunStatus, SessionEndReason } from '@orbit/shared';

import { landingContainerStatus } from '../projects/landing-session';

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

const HELD_WORD_OF_TURN_STATE: Record<string, RunStatus> = {
  QUEUED: RunStatus.PENDING,
  IN_FLIGHT: RunStatus.RUNNING,
  ABANDONED: RunStatus.INTERRUPTED,
};

/**
 * The word a session reads on the wire. `landing` is the `project_landing` row of a LANDING container (null or absent
 * for every other session, and for a landing with no row, which reads as unsettled-without-landing: CANCELLED).
 */
export function legacySessionStatus(facts: LegacyStatusFacts, landing?: LandingSettlement | null): RunStatus {
  if (facts.finishedAt == null) {
    return (facts.turnState == null ? undefined : HELD_WORD_OF_TURN_STATE[facts.turnState]) ?? RunStatus.AWAITING_INPUT;
  }
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
