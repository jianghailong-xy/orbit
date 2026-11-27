import type { Prisma } from '@prisma/client';
import type { TransactionSurface } from '../common/prisma-transaction-surface';

export type WithdrawTurnsTransaction = TransactionSurface<{
  conversationTurn: ['findMany', 'deleteMany'];
  attachment: ['findMany', 'updateMany'];
}>;

/**
 * Delete turns a person took back before anything ran them — a queued or held message withdrawn, a
 * steer dropped unread, the queue Stop empties — keeping their files on the session.
 *
 * An attachment is deleted with its turn (`Attachment.turn`, onDelete: Cascade). Every client hands
 * a withdrawn message's words AND files back to the composer, and the files are staged by id, so a
 * cascade left the resend naming files that no longer existed. Detached first, each file is what an
 * upload staged in the composer is (its session, no turn): sendable again by the same id, and swept
 * with the session like any other.
 *
 * `where` is deleted exactly as given. A turn it matched that is still there afterwards (a runner
 * took it in between) gets its files back. Answers how many turns were deleted.
 */
export async function deleteTurnsKeepingAttachments(
  tx: WithdrawTurnsTransaction,
  where: Prisma.ConversationTurnWhereInput,
): Promise<number> {
  const ids = (await tx.conversationTurn.findMany({ where, select: { id: true } })).map((t) => t.id);
  const files =
    ids.length > 0 ? await tx.attachment.findMany({ where: { turnId: { in: ids } }, select: { id: true, turnId: true } }) : [];
  if (files.length > 0) {
    await tx.attachment.updateMany({ where: { id: { in: files.map((f) => f.id) } }, data: { turnId: null } });
  }
  const { count } = await tx.conversationTurn.deleteMany({ where });
  if (files.length > 0 && count < ids.length) {
    const kept = await tx.conversationTurn.findMany({ where: { id: { in: ids } }, select: { id: true } });
    for (const { id } of kept) {
      const theirs = files.filter((f) => f.turnId === id).map((f) => f.id);
      if (theirs.length > 0) await tx.attachment.updateMany({ where: { id: { in: theirs }, turnId: null }, data: { turnId: id } });
    }
  }
  return count;
}
