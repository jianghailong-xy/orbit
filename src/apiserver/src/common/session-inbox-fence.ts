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
 * Whether a pending heartbeat-delivered Git operation may already have local
 * side effects. Modern rows carry both an operation UUID and an owner; a row
 * that has neither is a stale orphan (not an in-flight operation) and must
 * not block takeover indefinitely. Only an owner-bearing row can have a
 * runner process that is still executing the operation:
 *   - owner + id    → modern, executing
 *   - owner, no id  → legacy (pre-operation-id), treat as executing
 *   - no owner + id → modern, completed or orphaned → free
 *   - no owner, no id → stale orphan → free
 */
export function pendingWorktreeOperationMayBeExecuting(
  status: string | null | undefined,
  operationId: string | null | undefined,
  operationOwner: string | null | undefined,
): boolean {
  return status === 'pending' && !!operationOwner;
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
