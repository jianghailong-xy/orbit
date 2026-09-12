import type { Prisma } from '@prisma/client';

/** The key a wake's turn is queued under, `watch:<watchId>:<generation>`, as `watchTurnClientId` writes it. */
const WAKE_TURN_KEY = /^watch:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/i;

/**
 * A Watch wake whose observer's run ended before any runner took it (docs/watch-contract.md §3, §6).
 *
 * The delivery worker queues a RESUME_SESSION wake as one turn keyed `watch:<watchId>:<generation>`
 * and acknowledges the delivery DELIVERED in that same transaction: from then on the wake waits on the
 * observer's queue like any sent message. Every way that run can end with the wake still waiting — its
 * running turn fails, the reaper finalizes it after its runner went quiet, the runner finalizes it, an
 * end is requested — drains the queue so nothing can be leased afterwards, and answers the wake away
 * unrun. Nothing else would ever say so: the Match never changes, the watch is already terminal, a
 * retry would replay the drained turn under the same key, and AutoRetryService re-sends only the last
 * message a person sent.
 *
 * So each of those drains calls this first, inside its own transaction and under the observer's Session
 * row lock it already holds. A delivery whose wake turn is still PENDING there becomes a DEAD_LETTER
 * with `OBSERVER_SESSION_ENDED` first in `last_error` — the answer the worker gives a wake whose observer
 * ended before it was queued, reached later. Nothing is revived, and a session that is revived does not
 * get the wake back: the watch's read says it was not delivered.
 *
 * A wake a runner already took — IN_FLIGHT, or ANSWERED by its own completion — stays DELIVERED. It
 * reached the observer's engine; what that run came to is the session's to say.
 *
 * The read is the same shape as the drain's own statement, and a session with no wake queued writes
 * nothing. Lock order: the caller holds the Session row (rank 30); the write takes only the delivery
 * rows of that session's own wakes, and nothing holding a delivery row waits on a session.
 */
export async function deadLetterQueuedWatchWakes(
  tx: Prisma.TransactionClient,
  sessionId: string,
  ending: string,
): Promise<void> {
  const queued = await tx.conversationTurn.findMany({
    where: { sessionId, status: 'PENDING', clientTurnId: { startsWith: 'watch:' } },
    select: { clientTurnId: true },
  });
  const wakes = queued.flatMap(({ clientTurnId }) => {
    const key = WAKE_TURN_KEY.exec(clientTurnId);
    return key ? [{ watchId: key[1], generation: Number(key[2]) }] : [];
  });
  if (wakes.length === 0) return;
  await tx.watchDelivery.updateMany({
    where: {
      action: 'RESUME_SESSION',
      state: 'DELIVERED',
      match: { OR: wakes, watch: { observerSessionId: sessionId } },
    },
    data: {
      state: 'DEAD_LETTER',
      deliveredAt: null,
      deadLetteredAt: new Date(),
      lastError:
        `OBSERVER_SESSION_ENDED: the observer session's run ended (${ending}) before a runner took its queued wake, `
        + 'and a watch does not revive it',
    },
  });
}
