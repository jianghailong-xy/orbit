import { Prisma, RunStatus } from '@prisma/client';
import { deriveSessionLifecycleState, SessionLifecycleState } from '@orbit/shared';

/**
 * "Released" and "held", the release fact of docs/session-three-state-design.md §4.2 (decision D1, plan
 * phase 3). A session is RELEASED when no runner holds it: it holds no task claim and no slot, and its
 * next message must be claimed again. It is HELD otherwise. `session.finished_at` is the release column:
 * set by every write that releases a session (with `release_cause`, migration 1261), cleared by the
 * revive.
 *
 * Both are spelled here twice. On the column: `isReleased` / `isHeld` and the Prisma filters `releasedFilter` /
 * `heldFilter`, which the TypeScript readers read (plan step 4.2). As status sets, the same members every
 * hand-copied live/terminal set held, for the readers phase 4 has not moved yet: the raw SQL fragments below (plan
 * step 4.3), and the Prisma filters whose status list is an index's access path (no index covers `finished_at`).
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
 * Raw SQL: the status column `column`, as the query spells it (for example `s."status"`; a constant, never
 * input), is released. The words are literals in the text, so the statement reads exactly as the
 * hand-written lists did and compares against the run_status enum the same way.
 */
export function releasedSql(column: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(column)} IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`;
}

/** Raw SQL: the status column `column` is held. */
export function heldSql(column: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(column)} IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')`;
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
 * The causes of a release that was a failure. Each cause is a failure or not, never both: the session's status is
 * FAILED exactly when its release cause is one of these (`session_release_failure_chk`, migrations 1406 and 1407),
 * so "did the run fail" is read here and not from the terminal status value.
 */
export const FAILURE_RELEASE_CAUSES = [
  'turn_failed',
  'runner_lost',
  'setup_failed',
  'engine_failed',
  'end_not_honored',
  'import_failed',
] as const satisfies readonly SessionReleaseCause[];

/** Whether a release with this cause was a failure. A held session (no cause) is not. */
export function isFailedRelease(releaseCause: string | null | undefined): boolean {
  return releaseCause != null && (FAILURE_RELEASE_CAUSES as readonly string[]).includes(releaseCause);
}

/** Prisma filter on `session.releaseCause`: the release was a failure. */
export function failedReleaseFilter(): Prisma.StringNullableFilter<'Session'> {
  return { in: [...FAILURE_RELEASE_CAUSES] };
}

/**
 * Raw SQL: the release cause column `column`, as the query spells it (for example `s."release_cause"`; a constant,
 * never input), is a failure. Null (a held session) is not: `IN` answers null, which a WHERE reads as false.
 */
export function failedReleaseSql(column: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(column)} IN ('turn_failed', 'runner_lost', 'setup_failed', 'engine_failed', 'end_not_honored', 'import_failed')`;
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

/** What a machine wake or a credential gate reads of a session to decide whether it has ended. */
export interface SessionEndedRow extends SessionReleaseColumn {
  status: RunStatus | string;
  endReason: string | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
}

/**
 * Whether a session has ended in any of the ways a machine wake must not undo (decision D4: today's rule, kept):
 * filed in Trash or Completed, released (any release cause: a person's end, a failed turn, an engine that
 * exited), or parked interrupted with an end recorded and not yet released. A session still held, whatever
 * end reason it carries while it runs, has not ended: its end is in flight. Whether the release was a failure
 * is not asked here; the scheduled wake-up asks it (`isFailedRelease`) to revive a failed one.
 */
export function sessionHasEnded(session: SessionEndedRow): boolean {
  if (deriveSessionLifecycleState(session) !== SessionLifecycleState.OPEN) return true;
  if (isReleased(session)) return true;
  // INTERRUPTED is a held status: the turn was abandoned. With an end reason, the session itself was ended.
  return session.status === 'INTERRUPTED' && Boolean(session.endReason);
}
