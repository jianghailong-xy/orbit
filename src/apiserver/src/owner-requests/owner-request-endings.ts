import { CONDITION_STILL_WAITING_KIND, CONDITION_WAITING_KIND } from '@orbit/shared';
import { Prisma } from '@prisma/client';

import { SCHEDULE_ITEM_KINDS } from '../schedules/schedule-attention';

/**
 * What every ending of an owner request writes in its own transaction, beside the ending itself.
 */

/**
 * The delivery of each ending to the session that asked: one OWNER_REQUEST `watch_delivery` row per request (migration
 * 0504), due now, written in the transaction that writes the ending — so an ending that commits has its delivery and
 * one that rolls back has none. The Watch delivery worker turns it into exactly one turn on the asking session, keyed
 * `ownerRequestTurnClientId`, and retries or dead-letters it like any other wake. `watch_delivery_owner_request_key`
 * holds a request to one delivery; the endings are compare-and-sets on PENDING, so a second is never attempted.
 */
export async function enqueueResolutions(tx: Prisma.TransactionClient, requestIds: string[]): Promise<void> {
  if (requestIds.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO "watch_delivery" ("id", "kind", "owner_request_id", "action", "next_attempt_at")
    SELECT gen_random_uuid(), 'OWNER_REQUEST', r."id", 'RESUME_SESSION', now()
      FROM unnest(${requestIds}::uuid[]) AS r("id")`;
}

/**
 * A SECRET request that ends while its key still waits for delivery takes the key with it (design
 * docs/design/owner-request-secrets.md §2: the ciphertext is deleted at once). The secret sweep is the backstop.
 */
export async function endUndeliveredGrants(
  tx: Prisma.TransactionClient,
  requestIds: string[],
  reason: 'EXPIRED' | 'WITHDRAWN' | 'REVOKED',
): Promise<void> {
  if (requestIds.length === 0) return;
  // Fetched but not acknowledged: the runner may hold a copy, so it is REMOVING until the runner confirms (§2).
  await tx.ownerRequestSecret.updateMany({
    where: { requestId: { in: requestIds }, state: 'PENDING_DELIVERY', fetchedAt: { not: null } },
    data: { state: 'REMOVING', endReason: reason, valueEnc: null },
  });
  await tx.ownerRequestSecret.updateMany({
    where: { requestId: { in: requestIds }, state: 'PENDING_DELIVERY', fetchedAt: null },
    data: { state: 'REMOVED', endReason: reason, valueEnc: null, removedAt: new Date() },
  });
}

/**
 * The owner moved these sessions to Completed after confirming that the questions they still ask would go unanswered:
 * every PENDING request they asked ends EXPIRED, as an unanswered card does, with its delivery and its key. The
 * schedule and condition cards a session carries are left alone: they are the schedule's and the watch's, and their own
 * flows end them. Returns the ids it ended.
 */
export async function expirePendingAskedBy(
  tx: Prisma.TransactionClient,
  ownerId: string,
  sessionIds: string[],
  now: Date,
): Promise<string[]> {
  if (sessionIds.length === 0) return [];
  const rows = await tx.ownerRequest.updateManyAndReturn({
    where: {
      ownerId,
      askedBySessionId: { in: sessionIds },
      state: 'PENDING',
      kind: { notIn: [...SCHEDULE_ITEM_KINDS, CONDITION_WAITING_KIND, CONDITION_STILL_WAITING_KIND] },
    },
    data: {
      state: 'EXPIRED',
      resolvedAt: now,
      resolutionNote: 'The owner moved the session to Completed without answering.',
    },
    select: { id: true },
  });
  const ids = rows.map((row) => row.id);
  await enqueueResolutions(tx, ids);
  await endUndeliveredGrants(tx, ids, 'EXPIRED');
  return ids;
}
