import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

// Runner process owners and inbox generations are UUID v4. A terminal revive
// uses a fresh UUID carrying the v5 tag as an out-of-band handoff marker. The
// remaining 122 random bits keep every resume epoch CAS-unique; the version tag
// lets claim/reclaim reject the row for runners that lack handoff support.
export function newTerminalResumeHandoffOwner(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}5${id.slice(15)}`;
}

export function isTerminalResumeHandoffOwner(owner: string | null | undefined): boolean {
  return owner?.[14]?.toLowerCase() === '5';
}

/**
 * How long a claimed pending Git operation may fence its session. The clock is
 * `merge_requested_at`/`commit_requested_at`, which heartbeat delivery restamps at
 * claim time, so it measures time since the owning process last advanced the
 * operation. Execution is seconds of git work and a live owner is redelivered
 * every heartbeat; five minutes also clears the longest window in which an old
 * process could still be finishing an operation while its successor comes up —
 * the runner's whole drain envelope (`shutdownSupervisorTimeout`) is under three
 * minutes, and it joins outstanding heartbeat work before replacing its image.
 * This is only a backstop: a draining runner neither claims new operations nor
 * keeps the ones it will not execute (it releases them back to unclaimed).
 */
export const WORKTREE_OPERATION_STALE_MS = 5 * 60_000;

/**
 * The same fence as `pendingWorktreeOperationMayBeExecuting`, as SQL: true while a merge or
 * commit still executing on this session's checkout must hold its turn back.
 *
 * Two callers must agree on it exactly — the claim queue, which refuses to hand the session a
 * slot while it holds, and the session list, which uses it to tell a waiting user that a git
 * operation (not capacity) is what they are waiting on. Written twice they drift, and a UI that
 * confidently names the wrong gate is worse than one that names none; the spawn-tree caps are
 * shared for the same reason (see session-tree-sql.ts).
 *
 * NULL-safe equality throughout: plain `= 'pending'` is SQL NULL for the common case of a session
 * that never merged, and `NOT(NULL)` is NULL too — which a WHERE clause treats as non-matching,
 * excluding the row from every claim forever.
 *
 * `sessionAlias` is however the calling query names the session table.
 */
export function worktreeOperationFenceSql(sessionAlias: string): Prisma.Sql {
  const s = Prisma.raw(sessionAlias);
  return Prisma.sql`(
    (
      ${s}."merge_status" IS NOT DISTINCT FROM 'pending'
      AND (
        ${s}."merge_requested_at" IS NULL
        OR ${s}."merge_requested_at" > now() - (${WORKTREE_OPERATION_STALE_MS} * interval '1 millisecond')
      )
    )
    OR (
      ${s}."commit_status" IS NOT DISTINCT FROM 'pending'
      AND (
        ${s}."commit_requested_at" IS NULL
        OR ${s}."commit_requested_at" > now() - (${WORKTREE_OPERATION_STALE_MS} * interval '1 millisecond')
      )
    )
  )`;
}

/**
 * Whether a pending heartbeat-delivered Git operation may already have local
 * side effects. Modern rows carry both an operation UUID and an owner; a row
 * that has neither is a stale orphan (not an in-flight operation) and must
 * not block takeover indefinitely. Only an owner-bearing row can have a
 * runner process that is still executing the operation:
 *   - owner + id    → modern, executing
 *   - owner, no id  → legacy (pre-operation-id), treat as executing
 *   - no owner + id → modern, completed or orphaned → free
 *   - no owner, no id → stale orphan → free
 *
 * An owner-bearing row additionally stops fencing once it is stale: the owner is a
 * process epoch, and a process that died between claiming and reporting (e.g. a
 * self-update restart) leaves the row pending forever. Treating it as executing
 * made takeover 409 indefinitely, which livelocked the runner's reclaim loop and
 * starved every queued session on the machine ("Waiting for a free slot").
 */
export function pendingWorktreeOperationMayBeExecuting(
  status: string | null | undefined,
  operationId: string | null | undefined,
  operationOwner: string | null | undefined,
  requestedAt?: Date | null,
): boolean {
  if (status !== 'pending' || !operationOwner) return false;
  return !requestedAt || Date.now() - requestedAt.getTime() < WORKTREE_OPERATION_STALE_MS;
}

/**
 * Tombstone the concrete inbox engine generation currently attached to a Session.
 *
 * Callers must already hold the Session row lock and invoke this while the row is
 * terminal: either in the transaction that terminalizes it or as a revive preflight.
 * The Session keeps pointing at the tombstone so a later activation can prove the
 * prior engine is retired before installing its replacement.
 */
export async function retireSessionInboxGeneration(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "inbox_lease_generation" AS generation
    SET "retired_at" = COALESCE(generation."retired_at", now())
    FROM "session" AS session
    WHERE session.id = ${sessionId}::uuid
      AND session.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
      AND generation."session_id" = session.id
      AND generation.generation = session."inbox_lease_generation"
  `;
}
