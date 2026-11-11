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

/** One session `returnWaitingSessionsToOpen` brought back, and whose it is. */
export interface ReturnedSession {
  id: string;
  ownerId: string;
}

/**
 * Bring back to Open every session in Completed or Trash that still has a question waiting on the
 * owner, whatever filed it there.
 *
 * "Waiting" is what the needs-you signal counts (`owner-decision-signal.ts`): an owner request the
 * session asked that is PENDING and not past its deadline, a PENDING MOVE_TASK it asked, or a PENDING
 * MOVE_TASK into a project it coordinates. Such a session never sits in Completed or Trash, because
 * its card has nowhere else to be seen.
 *
 * Called after commit by the writers that file a session (Complete, Trash, a finished project's
 * Complete, the reaper filing a done task's run), so the session comes straight back; and by a
 * periodic sweep over every account (`scope` empty), which also catches any other writer and, on its
 * first run after boot, every session filed away before this existed. Its own transaction, the
 * session rows FOR UPDATE (rank 30) in id order, at most `limit` per call.
 */
export async function returnWaitingSessionsToOpen(
  prisma: PrismaService,
  logger: Logger,
  scope: { ownerId?: string; sessionIds?: readonly string[] } = {},
  limit = 500,
): Promise<ReturnedSession[]> {
  const ids = scope.sessionIds ? orderedIds([...scope.sessionIds]) : null;
  if (ids && ids.length === 0) return [];
  return withTransactionRetry(prisma, async (tx) => {
    const waiting = await tx.$queryRaw<ReturnedSession[]>(Prisma.sql`
      SELECT s."id", s."owner_id" AS "ownerId" FROM "session" s
       WHERE s."kind" <> ${SESSION_KIND_LANDING}
         AND (s."completed_at" IS NOT NULL OR s."archived_at" IS NOT NULL OR s."deleted_at" IS NOT NULL)
         ${scope.ownerId ? Prisma.sql`AND s."owner_id" = ${scope.ownerId}::uuid` : Prisma.empty}
         ${ids ? Prisma.sql`AND s."id" = ANY(${ids}::uuid[])` : Prisma.empty}
         AND (
           EXISTS (SELECT 1 FROM "owner_request" r
                    WHERE r."asked_by_session_id" = s."id" AND r."owner_id" = s."owner_id"
                      AND r."state" = 'PENDING' AND (r."expires_at" IS NULL OR r."expires_at" > now()))
           OR EXISTS (SELECT 1 FROM "project_handoff_approval" h
                       WHERE h."requested_by_session_id" = s."id" AND h."owner_id" = s."owner_id"
                         AND h."kind" = 'MOVE_TASK' AND h."state" = 'PENDING')
           OR EXISTS (SELECT 1 FROM "project_handoff_approval" h
                        JOIN "project" p ON p."id" = h."to_project_id"
                       WHERE p."coordinator_session_id" = s."id" AND h."owner_id" = s."owner_id"
                         AND h."kind" = 'MOVE_TASK' AND h."state" = 'PENDING')
         )
       ORDER BY s."id"
       LIMIT ${limit}
       FOR UPDATE OF s SKIP LOCKED`);
    if (waiting.length === 0) return [];
    await tx.session.updateMany({
      where: { id: { in: waiting.map((row) => row.id) } },
      data: { completedAt: null, archivedAt: null, deletedAt: null },
    });
    return waiting;
  }, loggedRetry(logger, 'sessions.returnWaitingToOpen'));
}
