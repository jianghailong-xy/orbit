import type { Prisma } from '@prisma/client';

/**
 * The keys a wake's turn is queued under, exactly as the delivery worker writes them: `watch:<watchId>:`
 * and a suffix. A number is a Match's generation (`watchTurnClientId`); any other suffix is how the watch
 * ended — `expired` (`watchExpiryTurnClientId`), `revoked` or `unresolvable` (`watchEndTurnClientId`).
 */
const WAKE_TURN_KEY = /^watch:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$/;

/** What took a queued wake off its observer's queue before any runner took it. The code heads its dead letter. */
export type UnrunWake =
  /** The observer's run ended, and the drain that ended its queue answered the wake. */
  | { code: 'OBSERVER_SESSION_ENDED'; ending: string }
  /** The observer was interrupted, and the interrupt deleted everything queued behind the turn it stopped. */
  | { code: 'OBSERVER_TURN_INTERRUPTED' }
  /** The owner withdrew this one queued turn. */
  | { code: 'WAKE_WITHDRAWN'; turnId: string };

/**
 * A Watch wake taken off its observer's queue before any runner took it (docs/watch-contract.md §3, §5, §6).
 *
 * The delivery worker queues a RESUME_SESSION wake as one turn, keyed `watch:<watchId>:<generation>` for
 * a Match and `watch:<watchId>:expired`, `:revoked` or `:unresolvable` for a watch that ended unmatched,
 * and acknowledges the delivery DELIVERED in that same transaction: from then on the wake waits on the
 * observer's queue like any sent message. Every way that run can end with the wake still waiting — its
 * running turn fails, the reaper finalizes it after its runner went quiet, the runner finalizes it, an
 * end is requested — drains the queue so nothing can be leased afterwards, and answers the wake away
 * unrun. Nothing else would ever say so: neither a Match nor a watch's end changes, the watch is already
 * terminal, a retry would replay the drained turn under the same key, and AutoRetryService re-sends only
 * the last message a person sent.
 *
 * So each of those drains calls this first, inside its own transaction and under the observer's Session
 * row lock it already holds. A delivery whose wake turn is still PENDING there becomes a DEAD_LETTER
 * with `OBSERVER_SESSION_ENDED` first in `last_error` — the answer the worker gives a wake whose observer
 * ended before it was queued, reached later. Nothing is revived, and a session that is revived does not
 * get the wake back: the watch's read says it was not delivered.
 *
 * An observer that lives on can lose a queued wake as well, and there the turn is deleted rather than
 * answered. Interrupting means stop: `SessionsService.interrupt` deletes every follow-up queued behind
 * the turn it stops, a wake among them — `OBSERVER_TURN_INTERRUPTED` — because a wake kept queued, or
 * queued again, would start the session its owner just stopped. `SessionsService.cancelQueuedTurn`
 * withdraws a wake like any queued message, and only the one it names — `WAKE_WITHDRAWN`. Each calls
 * this first in the same way. The deleted turn frees its key, but nothing queues the wake under it
 * again: no worker claims a dead letter.
 *
 * A wake a runner already took — IN_FLIGHT, or ANSWERED by its own completion — stays DELIVERED. It
 * reached the observer's engine; what that run came to is the session's to say.
 *
 * The read is the same shape as the statement that takes the turns off the queue, and a session with no
 * wake queued writes nothing. Lock order: the caller holds the Session row (rank 30); the write takes
 * only the delivery rows of that session's own wakes, and nothing holding a delivery row waits on a
 * session.
 */
export async function deadLetterQueuedWatchWakes(
  tx: Prisma.TransactionClient,
  sessionId: string,
  unrun: UnrunWake,
): Promise<void> {
  const queued = await tx.conversationTurn.findMany({
    where: {
      sessionId,
      ...('turnId' in unrun ? { id: unrun.turnId } : {}),
      status: 'PENDING',
      clientTurnId: { startsWith: 'watch:' },
    },
    select: { clientTurnId: true },
  });
  const wakes = queued.flatMap(({ clientTurnId }): Prisma.WatchDeliveryWhereInput[] => {
    const key = WAKE_TURN_KEY.exec(clientTurnId);
    if (!key) return [];
    // A Match's delivery names its watch through the Match. Any other suffix is the watch's end, whose
    // delivery names the watch itself whichever end it was; a watch ends once, so that is at most one row.
    return /^\d+$/.test(key[2])
      ? [{ match: { watchId: key[1], generation: Number(key[2]), watch: { observerSessionId: sessionId } } }]
      : [{ kind: { not: 'MATCH' }, watchId: key[1], watch: { observerSessionId: sessionId } }];
  });
  if (wakes.length === 0) return;
  await tx.watchDelivery.updateMany({
    where: { action: 'RESUME_SESSION', state: 'DELIVERED', OR: wakes },
    data: {
      state: 'DEAD_LETTER',
      deliveredAt: null,
      deadLetteredAt: new Date(),
      lastError: lastErrorOf(unrun),
    },
  });
}

function lastErrorOf(unrun: UnrunWake): string {
  switch (unrun.code) {
    case 'OBSERVER_SESSION_ENDED':
      return `OBSERVER_SESSION_ENDED: the observer session's run ended (${unrun.ending}) before a runner took its queued wake, `
        + 'and a watch does not revive it';
    case 'OBSERVER_TURN_INTERRUPTED':
      return 'OBSERVER_TURN_INTERRUPTED: the observer session was interrupted before a runner took its queued wake, '
        + 'and an interrupt drops what is queued behind the turn it stops';
    case 'WAKE_WITHDRAWN':
      return "WAKE_WITHDRAWN: the wake was withdrawn from the observer session's queue before a runner took it";
  }
}
