import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Where a wake goes when the session it was owed to ended by a coordinator handoff
 * (docs/coordinator-handoff-v2-design.md §1).
 *
 * A `delegate` run or a `bg_run` job keeps running where its coordinator started it; the swap moves no row of
 * it. What changes is its wake: a session that ended because its handoff COMPLETED forwards the wake to the
 * successor (`coordinator_handoff.to_session_id`), following the chain when that one was handed over too. A
 * session that ended any other way still drops it.
 */

/** How the forwarded wake names its origin, ahead of the run's or the job's own description. */
export const PREVIOUS_COORDINATOR_PREFIX = 'Started by the previous coordinator: ';

/** How many handoffs a chain is followed through, as a guard against a cycle nobody should be able to write. */
const MAX_HANDOFF_CHAIN = 32;

/**
 * A handoff of this session was HANDING_OVER when its wake came: the outgoing coordinator is completed before
 * the swap that makes the handoff COMPLETED, so the successor is not settled yet. Answered 503, which the
 * runner asks again for, and thrown from the SubAgent wake path so its sweep files it again.
 */
export class HandoffInFlight extends ServiceUnavailableException {
  constructor(sessionId: string) {
    super(`session ${sessionId} is being handed over to a new coordinator — ask again`);
  }
}

type Reader = Pick<PrismaClient | Prisma.TransactionClient, 'coordinatorHandoff'>;

/**
 * The last successor of the chain of COMPLETED handoffs starting at this session, or null when it was not
 * handed over. Throws HandoffInFlight while a handoff of a session on the chain is still HANDING_OVER.
 */
export async function handoffSuccessorOf(prisma: Reader, sessionId: string): Promise<string | null> {
  let current = sessionId;
  let successor: string | null = null;
  const seen = new Set<string>([sessionId]);
  for (let hop = 0; hop < MAX_HANDOFF_CHAIN; hop++) {
    const handoff = await prisma.coordinatorHandoff.findFirst({
      where: { fromSessionId: current, state: { in: ['COMPLETED', 'HANDING_OVER'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { state: true, toSessionId: true },
    });
    if (!handoff) return successor;
    if (handoff.state === 'HANDING_OVER' || !handoff.toSessionId) throw new HandoffInFlight(current);
    if (seen.has(handoff.toSessionId)) return successor;
    seen.add(handoff.toSessionId);
    successor = handoff.toSessionId;
    current = handoff.toSessionId;
  }
  return successor;
}

/** The forwarded wake's description: "Started by the previous coordinator: <what it was>". */
export function forwardedDescription(description: string | null | undefined, command: string): string {
  const what = (description ?? '').trim() || command.trim() || 'background work';
  return `${PREVIOUS_COORDINATOR_PREFIX}${what}`.slice(0, 1_000);
}
