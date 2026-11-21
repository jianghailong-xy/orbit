import { Prisma, RunStatus } from '@prisma/client';
import { deriveSessionLifecycleState, SessionLifecycleState } from '@orbit/shared';

/**
 * "Released" and "held", the release fact of docs/session-three-state-design.md §4.2 (decision D1, plan
 * phase 3). A session is RELEASED when no runner holds it: it holds no task claim and no slot, and its
 * next message must be claimed again. It is HELD otherwise. `session.finished_at` is the release column:
 * set by every write that releases a session (with `release_cause`, migration 1261), cleared by the
 * revive.
 *
 * Both are spelled here twice. On the column: `isReleased` / `isHeld`, the Prisma filters `releasedFilter` /
 * `heldFilter`, which the TypeScript readers read (plan step 4.2), and the raw SQL fragments `sessionReleasedSql` /
 * `sessionHeldSql` (plan step 4.3). As status sets, the same members every hand-copied live/terminal set held, for
 * the readers phase 4 has not moved yet, and the Prisma filters whose status list is an index's access path (the only
 * index that reads `finished_at` is the execution claim's, over `task_id`, migration 1426).
 * session_release_fact_chk (migrations 1401, 1402) makes the two the same rows: a status is terminal exactly when
 * `finished_at` is set.
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

/** Prisma filter on `session.status`: held. */
export function heldStatusFilter(): Prisma.EnumRunStatusFilter<'Session'> {
  return { in: [...HELD_SESSION_STATUSES] };
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

/** Whether a runner holds this session past its claim: held, and not waiting in the queue to be claimed. */
export function isHeldPastClaim(session: SessionReleaseColumn & { status: RunStatus | string }): boolean {
  return isHeld(session) && session.status !== RunStatus.PENDING;
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

/** The held statuses as an SQL list, for the fragment below and nothing else. */
const HELD_STATUS_LIST_SQL = Prisma.raw(`('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')`);

/**
 * Raw SQL: `sessionHeldSql`, for a query whose access path is an index on `status`, alone (`session_status_idx`, the
 * dispatch pause's reads, plan step 4.5) or after another column (`session_assigned_runner_id_status_idx`): the release
 * column decides, and the held statuses are stated beside it, which session_release_fact_chk makes the same rows. The
 * status list decides nothing; it is there because the planner can read it as an index condition and cannot read
 * `finished_at` as one outside the claim index. Without it a runner's query reads every session the runner ever had
 * (measured in plan step 4.3: 44,000 index entries for 73 rows).
 */
export function sessionHeldIndexedSql(sessionAlias: string): Prisma.Sql {
  return Prisma.sql`(${sessionHeldSql(sessionAlias)} AND ${Prisma.raw(sessionAlias)}."status" IN ${HELD_STATUS_LIST_SQL})`;
}

/**
 * Why a session was released: `session.release_cause`, held to these values by
 * `session_release_cause_chk` (migration 1261). Today's end reasons (SessionEndReason in @orbit/shared,
 * and the two legacy ones stored rows still carry), plus the causes no end reason records.
 */
export const SESSION_RELEASE_CAUSES = [
  // The end reasons.
  'task_done',
  'task_cancelled',
  'ended',
  'completed',
  'deleted',
  'cancelled',
  // Legacy end reasons (LEGACY_END_REASONS): no code writes them, old rows carry them.
  'idle',
  'orphaned',
  // The runner reported a failed turn; turn-complete releases the session with it.
  'turn_failed',
  // The runner holding a running turn went offline (the reaper).
  'runner_lost',
  // The run never started: the runner refused its source, or the engine's runtime never initialized.
  'setup_failed',
  // The runner finalized the session with no end requested: its engine exited, and the runner reported no
  // failure (SUCCEEDED or CANCELLED).
  'engine_exited',
  // The runner finalized the session with no end requested and reported it FAILED: its engine failed.
  'engine_failed',
  // An end was asked for and the runner never honoured it: the reaper released the session FAILED once the
  // grace ran out. end_reason still records which end was asked for.
  'end_not_honored',
  // The runner could not import the transcript the session was created from.
  'import_failed',
  // A LANDING container session whose landing settled.
  'landing_settled',
] as const;

export type SessionReleaseCause = (typeof SESSION_RELEASE_CAUSES)[number];

/**
 * The two questions a reader asks of a release (docs/session-three-state-design.md §12.2 and §12.3, decision D9,
 * removal steps R3 and R4): was the session released by a failure, and did the release finish the work. Neither reads
 * `release_cause`: a failure is a fact of the turn, not of the session. Every writer that releases a session after a
 * failure records `FAILED` on the turn that carries it and copies it to `last_turn_outcome` in the release's own write
 * (§12.1, common/carrying-turn.ts), and the session keeps only `finished_at` (released) and `end_reason` (an end was
 * asked for). The readings:
 *
 *   released by a failure  finished_at IS NOT NULL AND end_reason IS NULL
 *                          AND (last_turn_outcome = 'FAILED' OR <the status bridge below>)
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

/**
 * BRIDGE, removed by removal step R7 (task 351QPAh8wuz6nl3n1ghm2, deploy 3); the one place it is spelled. The
 * status FAILED, read beside `last_turn_outcome` as "the last turn failed", for the rows a deploy-1 server releases
 * during deploy 2's hand-over: its reaper, finalize, refused source and import record a failure in the status alone,
 * not on the turn (design §12.6, fact 1). Every writer of deploy 1 and deploy 2 writes FAILED exactly for a failure,
 * so the arm answers for those rows what their turn would have. R6 backfills their turn outcome in deploy 3; R7 then
 * deletes this arm from the three spellings below, re-creates the three triggers of migration 1425 without it (in a
 * migration of its own: 1425 is deployed by then), and lowers the guard allow-list's FAILURE_STATUS_BRIDGE section,
 * which counts it. Read nowhere else.
 */
const FAILED_STATUS_BRIDGE = RunStatus.FAILED;

/** The turn outcome a failure records on its carrying turn and copies to `last_turn_outcome` (migration 1201). */
const FAILED_TURN_OUTCOME = 'FAILED';

/** The end reason of a task that is DONE (SessionEndReason.TASK_DONE): its run finished the work. */
const WORK_FINISHED_END_REASON = 'task_done';

/** The session kind whose release finishes a landing (projects/landing-session.ts). */
const LANDING_KIND = 'LANDING';

/** What "released by a failure" reads of a session row. `status` is read by the bridge alone. */
export interface ReleaseFailureFacts extends SessionReleaseColumn {
  endReason: string | null;
  lastTurnOutcome: string | null;
  status: RunStatus | string;
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
  finishedAt: true,
  endReason: true,
  lastTurnOutcome: true,
  status: true,
} as const;

/** The columns ReleaseWorkFacts reads, for a Prisma `select`. */
export const RELEASE_WORK_SELECT = { finishedAt: true, endReason: true, sessionKind: true } as const;

/** The columns SessionReleaseFacts reads, for a Prisma `select`. */
export const RELEASE_FACTS_SELECT = { ...RELEASE_FAILURE_SELECT, ...RELEASE_WORK_SELECT } as const;

/** Whether the session was released by a failure: released, with no end asked for, and its last turn failed. */
export function releaseWasFailure(session: ReleaseFailureFacts): boolean {
  return isReleased(session)
    && session.endReason == null
    && (session.lastTurnOutcome === FAILED_TURN_OUTCOME || session.status === FAILED_STATUS_BRIDGE);
}

/**
 * Prisma filter on a session: it was released by a failure. Its keys are `finishedAt`, `endReason` and `OR`, so put it
 * in an `AND` or `OR` list, or spread it only into a filter that names none of the three. Never null in SQL, so a
 * `NOT` of it is the rows it does not match: the nullable column is compared only beside its own `IS NOT NULL`.
 */
export function releaseWasFailureFilter(): Prisma.SessionWhereInput {
  return {
    finishedAt: { not: null },
    endReason: null,
    OR: [{ lastTurnOutcome: { not: null, equals: FAILED_TURN_OUTCOME } }, { status: FAILED_STATUS_BRIDGE }],
  };
}

/**
 * Raw SQL: the session row the query names `sessionAlias` (for example `s`, or `NEW` in a trigger; a constant, never
 * input) was released by a failure. Never null, so `NOT` of it reads as it says.
 */
export function releaseWasFailureSql(sessionAlias: string): Prisma.Sql {
  const s = Prisma.raw(sessionAlias);
  return Prisma.sql`(${s}."finished_at" IS NOT NULL AND ${s}."end_reason" IS NULL AND (${s}."last_turn_outcome" IS NOT DISTINCT FROM ${Prisma.raw(`'${FAILED_TURN_OUTCOME}'`)} OR ${s}."status" = ${Prisma.raw(`'${FAILED_STATUS_BRIDGE}'`)}))`;
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
 * The cause of a release somebody asked for: the end reason the request recorded, or `cancelled` when
 * the request recorded none (a cancel with no reason, or a reason this build does not know).
 */
export function releaseCauseOfEndReason(endReason: string | null | undefined): SessionReleaseCause {
  return endReason && (SESSION_RELEASE_CAUSES as readonly string[]).includes(endReason)
    ? (endReason as SessionReleaseCause)
    : 'cancelled';
}

/**
 * The cause the runner's finalize records, from the same inputs that decide the status it writes: the requested
 * end's when an end was requested (whose reason also decided the status: SUCCEEDED or CANCELLED, never FAILED),
 * else the engine exited by itself, failed when the runner reported FAILED. `reported` is the status word the
 * runner sent, the one the finalize writes when no end was requested.
 */
export function finalizeReleaseCause(
  current: {
    cancelRequestedAt: Date | null;
    endReason: string | null;
  },
  reported: string,
): SessionReleaseCause {
  if (current.cancelRequestedAt) return releaseCauseOfEndReason(current.endReason);
  return reported === 'FAILED' ? 'engine_failed' : 'engine_exited';
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
 * Whether the session's run is over: released, or parked interrupted with an end recorded (INTERRUPTED is a held
 * status, the turn was abandoned; with an end reason, the session itself was ended). The SESSION_RUN_TERMINAL watch
 * leaf asks exactly this, and sessionHasEnded asks it after the filing facts. Under session_release_fact_chk it
 * answers, for every stored row, what "the derived run state is SUCCEEDED, FAILED or ENDED" answered.
 */
export function runIsOver(session: SessionReleaseColumn & { status: RunStatus | string; endReason: string | null }): boolean {
  if (isReleased(session)) return true;
  return session.status === 'INTERRUPTED' && Boolean(session.endReason);
}

export interface SessionEndedRow extends SessionReleaseColumn {
  status: RunStatus | string;
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
