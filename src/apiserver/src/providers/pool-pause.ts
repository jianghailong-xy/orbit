import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/** An already delivered turn finishes; a pause never authorizes a later turn on a warm gateway token. */
export async function poolPauseBlocksRequest(
  db: Prisma.TransactionClient | PrismaService,
  sessionId: string,
  pause: { pausedAt?: Date | null; pausedUntil?: Date | null },
  now: Date,
): Promise<boolean> {
  if (!pause.pausedUntil || pause.pausedUntil <= now) return false;
  if (!pause.pausedAt) return true;
  const turns = await db.conversationTurn.findMany({
    where: {
      sessionId,
      kind: { in: ['message', 'shell'] },
      status: 'IN_FLIGHT',
      deliveredAt: { lte: pause.pausedAt },
      session: { status: 'RUNNING', deletedAt: null, completedAt: null },
    },
    select: {
      leaseGeneration: true,
      leaseDeadlineAt: true,
      session: { select: { inboxLeaseGeneration: true, inboxLeaseOwner: true } },
    },
  });
  for (const turn of turns) {
    const { inboxLeaseGeneration, inboxLeaseOwner } = turn.session;
    if (turn.leaseGeneration !== inboxLeaseGeneration) continue;
    if (turn.leaseGeneration) {
      // A delivery deadline is not a run timeout: it is never renewed and long turns exceed it.
      // The current, unretired engine generation is the authority; takeover/release removes it.
      const active = await db.inboxLeaseGeneration.findFirst({
        where: { generation: turn.leaseGeneration, sessionId, leaseOwner: inboxLeaseOwner, retiredAt: null },
        select: { generation: true },
      });
      if (active && inboxLeaseOwner) return false;
    } else if (!inboxLeaseOwner && turn.leaseDeadlineAt && turn.leaseDeadlineAt > now) {
      // Old runners have no durable engine identity with which to vouch for an expired delivery.
      return false;
    }
  }
  return true;
}
