import { Prisma, RunStatus } from '@prisma/client';

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
  // The runner finalized the session with no end requested: its engine exited.
  'engine_exited',
  // The runner could not import the transcript the session was created from.
  'import_failed',
  // A LANDING container session whose landing settled.
  'landing_settled',
] as const;

export type SessionReleaseCause = (typeof SESSION_RELEASE_CAUSES)[number];

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
 * The cause the runner's finalize records: the requested end's when an end was requested (whose reason
 * also decided the status the finalize writes), else the engine exited by itself.
 */
export function finalizeReleaseCause(current: {
  cancelRequestedAt: Date | null;
  endReason: string | null;
}): SessionReleaseCause {
  return current.cancelRequestedAt ? releaseCauseOfEndReason(current.endReason) : 'engine_exited';
}
