import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { COORDINATOR_PAUSE_SELECT, conversationIsPaused } from '../projects/coordinator-evidence-queue';
import { conversationIsOver } from '../projects/project-open-item';
import type { SessionsService } from '../sessions/sessions.service';

/** Source records remain the queue until their turn is taken up. Never wake a scheduled retry. */
export async function deliverOwedTaskTurn(
  db: Prisma.TransactionClient,
  sessions: SessionsService,
  ownerId: string,
  sessionId: string,
  baseKey: string,
  content: string,
): Promise<void> {
  const available = async (tx: Prisma.TransactionClient) => {
    const session = await tx.session.findFirst({ where: { id: sessionId, ownerId }, select: COORDINATOR_PAUSE_SELECT });
    return session && !conversationIsOver(session) && !conversationIsPaused(session);
  };
  // Read-only preflight: ended and paused conversations never open a send transaction.
  if (!await available(db)) return;
  const previous = await db.conversationTurn.findFirst({
    where: { sessionId, clientTurnId: { startsWith: baseKey } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (previous && (previous.deliveredAt || previous.status !== 'ANSWERED')) return;
  const clientTurnId = previous ? `${baseKey}:retry:${previous.id}` : baseKey;
  try {
    await sessions.createTurn(ownerId, sessionId, { clientTurnId, content: previous?.content ?? content, intent: 'NEXT_TURN' }, {
      participateSendTransaction: async (tx) => {
        // createTurn holds the session lock: a pause racing the preflight must not clear retryAt.
        if (!await available(tx)) throw new ConflictException('the recipient is temporarily unavailable');
      },
    });
  } catch (error) {
    if (error instanceof NotFoundException || error instanceof ConflictException
      || error instanceof ForbiddenException || error instanceof BadRequestException) return;
    throw error;
  }
}
