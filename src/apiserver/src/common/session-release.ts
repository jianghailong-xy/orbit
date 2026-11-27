import { Prisma } from '@prisma/client';
import { deriveSessionLifecycleState, RunStatus, SessionLifecycleState } from '@orbit/shared';

import { TURN_STATE_SELECT, turnStateOf, type TurnStateFacts } from '../sessions/session-turn-state';

/**
 * "Released" and "held", the release fact of docs/session-three-state-design.md §4.2 (decision D1, plan
 * phase 3). A session is RELEASED when no runner holds it: it holds no task claim and no slot, and its
 * next message must be claimed again. It is HELD otherwise. `session.finished_at` is the release column:
 * set by every write that releases a session, cleared by the
 * revive.
 *
 * Both are spelled here twice. On the column: `isReleased` / `isHeld`, the Prisma filters `releasedFilter` /
 * `heldFilter`, which the TypeScript readers read (plan step 4.2), and the raw SQL fragments `sessionReleasedSql` /
 * `sessionHeldSql` (plan step 4.3). As status sets, the same members every hand-copied live/terminal set held, for
 * the readers that have not moved onto the facts yet (docs/session-status-retirement-plan.md, tasks T10 to T12).
 * The two are the same rows: a projected word is terminal exactly when `finished_at` is set (the database held the
 * stored word to that until deploy D4 dropped it, migration 1711). The partial indexes on `finished_at IS NULL` (migrations 1628, 1633) are the held rows' access
 * paths, so no reader states the held statuses beside the column for the planner any more.
 */

/** Held: a runner holds the session, or a message waits for one to claim it. */
export const HELD_SESSION_STATUSES: readonly RunStatus[] = [
  RunStatus.PENDING,
  RunStatus.RUNNING,
  RunStatus.AWAITING_INPUT,
  RunStatus.INTERRUPTED,
];

/** Released: no runner holds the session. */
export const RELEASED_SESSION_STATUSES: readonly RunStatus[] = [
  RunStatus.SUCCEEDED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
];

/** Whether a session with this status is released. Accepts the bare words a raw row carries. */
export function isReleasedStatus(status: RunStatus | string): boolean {
  return (RELEASED_SESSION_STATUSES as readonly string[]).includes(status);
}

/** Whether a session with this status is held. */
export function isHeldStatus(status: RunStatus | string): boolean {
  return (HELD_SESSION_STATUSES as readonly string[]).includes(status);
}

/** The release column, as a row read with it carries it. */
export interface SessionReleaseColumn {
  finishedAt: Date | string | null;
}

/** Whether this session is released: its release column is set. */
export function isReleased(session: SessionReleaseColumn): boolean {
  return session.finishedAt != null;
}

/** Whether this session is held: its release column is not set. */
export function isHeld(session: SessionReleaseColumn): boolean {
  return session.finishedAt == null;
}

/**
 * Whether a runner holds this session past its claim: held, and not waiting in the queue to be claimed (plan §2.1: L,
 * its turn state is not QUEUED).
 */
export function isHeldPastClaim(session: TurnStateFacts): boolean {
  return isHeld(session) && turnStateOf(session) !== 'QUEUED';
}

/** Prisma filter on a session: released, `finished_at IS NOT NULL`. */
export function releasedFilter(): Prisma.SessionWhereInput {
  return { finishedAt: { not: null } };
}

/** Prisma filter on a session: held, `finished_at IS NULL`. */
export function heldFilter(): Prisma.SessionWhereInput {
  return { finishedAt: null };
}

/**
 * Raw SQL: the session row the query names `sessionAlias` (for example `s`; a constant, never input) is released:
 * its release column is set. Plan step 4.3.
 */
export function sessionReleasedSql(sessionAlias: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(sessionAlias)}."finished_at" IS NOT NULL`;
}

/** Raw SQL: the session row the query names `sessionAlias` is held: its release column is not set. */
export function sessionHeldSql(sessionAlias: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(sessionAlias)}."finished_at" IS NULL`;
}


/**
 * The two questions a reader asks of a release (docs/session-three-state-design.md §12.2 and §12.3, decision D9,
 * removal steps R3 and R4): was the session released by a failure, and did the release finish the work. Neither reads
 * a cause on the session: a failure is a fact of the turn, not of the session. Every writer that releases a session after a
 * failure records `FAILED` on the turn that carries it and copies it to `last_turn_outcome` in the release's own write
 * (§12.1, common/carrying-turn.ts), and the session keeps only `finished_at` (released) and `end_reason` (an end was
 * asked for). The readings:
 *
 *   released by a failure  finished_at IS NOT NULL AND end_reason IS NULL AND last_turn_outcome = 'FAILED'
 *   the work finished      finished_at IS NOT NULL
 *                          AND (end_reason = 'task_done' OR (kind = 'LANDING' AND end_reason IS NULL))
 *
 * "No end asked" is `end_reason IS NULL`: every end request writes its reason beside `cancel_requested_at`, which
 * turn-complete and the reaper also set on the rows they release, so `cancel_requested_at` cannot be read as "asked".
 * An end that was asked for and not honoured (the reaper's `end_not_honored`) is therefore no failure: it is a stop.
 * The work finished when its task ended DONE (`task_done` is written exactly as the end reason) or a LANDING
 * container's landing settled (its writer records no end reason, projects/landing-session.ts); every other release
 * that is no failure is a stop, one somebody asked for (its end reason says which) or, with none, one nobody did.
 *
 * Each question is a predicate over a row read with RELEASE_FACTS_SELECT (or the narrower selects beside it), a Prisma
 * filter and a raw SQL fragment over the session row a query names. A reader asks by the question's name; which columns
 * answer it is this module's to know.
 */

/** The turn outcome a failure records on its carrying turn and copies to `last_turn_outcome` (migration 1201). */
const FAILED_TURN_OUTCOME = 'FAILED';

/** The end reason of a task that is DONE (SessionEndReason.TASK_DONE): its run finished the work. */
const WORK_FINISHED_END_REASON = 'task_done';

/** The session kind whose release finishes a landing (projects/landing-session.ts). */
const LANDING_KIND = 'LANDING';

/**
 * What "released by a failure" reads of a session row, and the turn state's columns beside it. The question reads no
 * status: the status bridge that read FAILED beside the turn outcome, for the rows a deploy-1 server released during
 * deploy 2's hand-over, went with removal step R7 (design §12.6, deploy 3), after migration 1441 wrote the turn outcome
 * of every such row. The turn state's columns (TURN_STATE_SELECT, sessions/session-turn-state.ts) stay in the row, and
 * in RELEASE_FAILURE_SELECT, for the readers that select these columns and ask more of the row: sessionHasEnded's
 * abandoned turn, a held turn state, the word they publish.
 */
export interface ReleaseFailureFacts extends SessionReleaseColumn, TurnStateFacts {
  endReason: string | null;
  lastTurnOutcome: string | null;
}

/** What "the work finished" reads of a session row. */
export interface ReleaseWorkFacts extends SessionReleaseColumn {
  endReason: string | null;
  sessionKind: string;
}

/** The release facts of a session row, as both questions read them (plan step 4.8, design §12.3). */
export type SessionReleaseFacts = ReleaseFailureFacts & ReleaseWorkFacts;

/** The columns ReleaseFailureFacts reads, for a Prisma `select`. */
export const RELEASE_FAILURE_SELECT = {
  ...TURN_STATE_SELECT,
  finishedAt: true,
  endReason: true,
  lastTurnOutcome: true,
} as const;

/** The columns ReleaseWorkFacts reads, for a Prisma `select`. */
export const RELEASE_WORK_SELECT = { finishedAt: true, endReason: true, sessionKind: true } as const;

/** The columns SessionReleaseFacts reads, for a Prisma `select`. */
export const RELEASE_FACTS_SELECT = { ...RELEASE_FAILURE_SELECT, ...RELEASE_WORK_SELECT } as const;

/** Whether the session was released by a failure: released, with no end asked for, and its last turn failed. */
export function releaseWasFailure(session: ReleaseFailureFacts): boolean {
  return isReleased(session)
    && session.endReason == null
    && session.lastTurnOutcome === FAILED_TURN_OUTCOME;
}

/**
 * Prisma filter on a session: it was released by a failure. Its keys are `finishedAt`, `endReason` and
 * `lastTurnOutcome`, so put it in an `AND` or `OR` list, or spread it only into a filter that names none of the three. Never null in SQL, so a
 * `NOT` of it is the rows it does not match: the nullable column is compared only beside its own `IS NOT NULL`.
 */
export function releaseWasFailureFilter(): Prisma.SessionWhereInput {
  return {
    finishedAt: { not: null },
    endReason: null,
    lastTurnOutcome: { not: null, equals: FAILED_TURN_OUTCOME },
  };
}

/**
 * Raw SQL: the session row the query names `sessionAlias` (for example `s`, or `NEW` in a trigger; a constant, never
 * input) was released by a failure. Never null, so `NOT` of it reads as it says.
 */
export function releaseWasFailureSql(sessionAlias: string): Prisma.Sql {
  const s = Prisma.raw(sessionAlias);
  return Prisma.sql`(${s}."finished_at" IS NOT NULL AND ${s}."end_reason" IS NULL AND ${s}."last_turn_outcome" IS NOT DISTINCT FROM ${Prisma.raw(`'${FAILED_TURN_OUTCOME}'`)})`;
}

/** Whether the session was released having finished its work: its task ended DONE, or its landing settled. */
export function releaseFinishedTheWork(session: ReleaseWorkFacts): boolean {
  return isReleased(session)
    && (session.endReason === WORK_FINISHED_END_REASON
      || (session.sessionKind === LANDING_KIND && session.endReason == null));
}

/**
 * Prisma filter on a session: it was released having finished its work. Its keys are `finishedAt` and `OR`, so put it
 * in an `AND` or `OR` list, or spread it only into a filter that names neither. Never null in SQL, as the one above.
 */
export function releaseFinishedTheWorkFilter(): Prisma.SessionWhereInput {
  return {
    finishedAt: { not: null },
    OR: [
      { endReason: { not: null, equals: WORK_FINISHED_END_REASON } },
      { sessionKind: LANDING_KIND, endReason: null },
    ],
  };
}

/** Raw SQL: the session row the query names `sessionAlias` was released having finished its work. Never null. */
export function releaseFinishedTheWorkSql(sessionAlias: string): Prisma.Sql {
  const s = Prisma.raw(sessionAlias);
  return Prisma.sql`(${s}."finished_at" IS NOT NULL AND (${s}."end_reason" IS NOT DISTINCT FROM ${Prisma.raw(`'${WORK_FINISHED_END_REASON}'`)} OR (${s}."kind" = ${Prisma.raw(`'${LANDING_KIND}'`)} AND ${s}."end_reason" IS NULL)))`;
}

/**
 * Whether this finalize is a runner reporting success with no end requested: released `engine_exited`, which is a
 * stop and not finished work (releaseFinishedTheWork: no end reason), whatever the runner said. No runner the server
 * accepts reports it: a finalize needs runner-link v1 (runner 0.1.238 and later), and every engine supervisor since
 * then says SUCCEEDED only for an inbox `end` turn, which the server writes together with the end request (traced
 * 2026-11-21; the one-shot mode that reported success on its own went with 463f89061d, 2026-06-16). The finalize logs
 * it, so one in the field is seen.
 */
export function reportsSuccessWithNoEnd(current: { cancelRequestedAt: Date | null }, reported: string): boolean {
  return !current.cancelRequestedAt && reported === 'SUCCEEDED';
}

/** What a machine wake or a credential gate reads of a session to decide whether it has ended. */
/**
 * Whether the session's run is over: released, or held with its turn abandoned and an end recorded (ABANDONED, what
 * INTERRUPTED said: the runner was stopped under the turn; with an end reason, the session itself was ended; plan
 * §2.1: E). The SESSION_RUN_TERMINAL watch leaf asks exactly this, and sessionHasEnded asks it after the filing facts.
 * It answers, for every row, what "the derived run state is SUCCEEDED, FAILED or
 * ENDED" answered. A row read with TURN_STATE_SELECT; one not yet backfilled reads its stored word there.
 */
export function runIsOver(session: TurnStateFacts & { endReason: string | null }): boolean {
  if (isReleased(session)) return true;
  return turnStateOf(session) === 'ABANDONED' && Boolean(session.endReason);
}

export interface SessionEndedRow extends TurnStateFacts {
  endReason: string | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
}

/**
 * Whether a session has ended in any of the ways a machine wake must not undo (decision D4: today's rule, kept):
 * filed in Trash or Completed, released (however: a person's end, a failed turn, an engine that exited), or
 * parked interrupted with an end recorded and not yet released. A session still held, whatever end reason it
 * carries while it runs, has not ended: its end is in flight. Whether the release was a failure is not asked
 * here; the scheduled wake-up asks it (`releaseWasFailure`) to revive a failed one.
 */
export function sessionHasEnded(session: SessionEndedRow): boolean {
  if (deriveSessionLifecycleState(session) !== SessionLifecycleState.OPEN) return true;
  return runIsOver(session);
}
