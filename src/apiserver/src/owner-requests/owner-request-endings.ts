import { Prisma } from '@prisma/client';

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
