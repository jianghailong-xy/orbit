import type { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { orderedIds } from '../common/lock-order';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import { SESSION_KIND_LANDING } from './engine-session';

/**
 * Bring the conversations a question for the owner was just filed on back to Open.
 *
 * A request (`request_owner_action`) or a task move is answered from its card in a session, and the
 * needs-you signal only lights a session in Open (`owner-decision-signal.ts`). So when one becomes
 * pending on a session the owner filed in Completed or threw in Trash — the session that asked, or
 * the coordinator of the project a move goes into — that session comes back to Open, the way
 * `SessionsService.restore` brings it back: the three filing columns cleared, nothing else. A
 * landing session is the platform's and is never filed by a person, so it is left alone.
 *
 * Its own transaction, after the one that filed the question has committed: the session lock is
 * rank 30, below everything a filing holds, so it cannot be taken inside one. A session completed
 * after this runs is the owner's own act and stays where they put it.
 *
 * Returns the sessions it moved, for the caller to announce (`publishSessionCreated`, which is what
 * a restore says).
 */
export async function returnSessionsToOpen(
  prisma: PrismaService,
  ownerId: string,
  sessionIds: Iterable<string | null | undefined>,
  logger: Logger,
): Promise<string[]> {
  const ids = orderedIds([...sessionIds]);
  if (ids.length === 0) return [];
  return withTransactionRetry(prisma, async (tx) => {
    // Locked in id order, as restore and purge lock one: a purge that won leaves no row here.
    const filed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "session"
       WHERE "id" = ANY(${ids}::uuid[])
         AND "owner_id" = ${ownerId}::uuid
         AND "kind" <> ${SESSION_KIND_LANDING}
         AND ("completed_at" IS NOT NULL OR "archived_at" IS NOT NULL OR "deleted_at" IS NOT NULL)
       ORDER BY "id"
       FOR UPDATE`);
    if (filed.length === 0) return [];
    const moved = filed.map((row) => row.id);
    await tx.session.updateMany({
      where: { id: { in: moved }, ownerId },
      data: { completedAt: null, archivedAt: null, deletedAt: null },
    });
    return moved;
  }, loggedRetry(logger, 'sessions.returnToOpen'));
}
