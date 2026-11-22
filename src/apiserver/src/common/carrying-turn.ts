import type { Prisma } from '@prisma/client';

import type { TurnOutcome } from '../runner-api/turn-outcome';

/** The kinds that get an outcome: a turn of work (runner-api/turn-outcome.ts). */
const WORK_TURN_KINDS = ['message', 'shell'];

/**
 * The turn that carries a session's failure (docs/session-three-state-design.md §12.1, decision D9): the work
 * turn IN_FLIGHT, else the oldest PENDING work turn, which the claim being released was for. `orLatest` adds the
 * last resort two writers have, the latest work turn whatever its status: the runner's finalize of a session
 * with nothing in flight (the events its link gave up were that turn's), and the reaper's API-error backstop,
 * whose last turn was answered by the error. Null when the session has no such turn.
 *
 * Read under the Session row lock the release holds, so no completion or lease moves a turn between this read
 * and the release's write.
 */
export async function carryingTurnOf(
  tx: Prisma.TransactionClient,
  sessionId: string,
  opts: { orLatest: boolean },
): Promise<string | null> {
  for (const status of ['IN_FLIGHT', 'PENDING']) {
    const turn = await tx.conversationTurn.findFirst({
      where: { sessionId, kind: { in: WORK_TURN_KINDS }, status },
      orderBy: { seq: 'asc' },
      select: { id: true },
    });
    if (turn) return turn.id;
  }
  if (!opts.orLatest) return null;
  const latest = await tx.conversationTurn.findFirst({
    where: { sessionId, kind: { in: WORK_TURN_KINDS } },
    orderBy: { seq: 'desc' },
    select: { id: true },
  });
  return latest?.id ?? null;
}

/**
 * Record how the carrying turn ended, with the words it ended with, in the transaction that releases its session.
 * Only the outcome and the error: where the turn is in the queue is the release's drain to write.
 */
export async function recordCarryingTurnOutcome(
  tx: Prisma.TransactionClient,
  turnId: string,
  outcome: TurnOutcome,
  error: string | null,
): Promise<void> {
  await tx.conversationTurn.updateMany({ where: { id: turnId }, data: { outcome, error } });
}
