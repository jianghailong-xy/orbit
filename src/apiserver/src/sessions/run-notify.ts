import type { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { attribute, readBlockSender } from './session-message';

export const RUN_NOTIFY_TURN_PREFIX = 'run-notify:v1:';

export function isRunNotifyTurn(key: string | null | undefined): boolean {
  return !!key?.startsWith(RUN_NOTIFY_TURN_PREFIX);
}

/** M3: platform content is read from the request, including on a failed turn's re-send. */
export async function runNotifyContent(
  db: Prisma.TransactionClient,
  recipientSessionId: string,
  key: string | null | undefined,
): Promise<string | null> {
  if (!isRunNotifyTurn(key)) return null;
  const id = key!.slice(RUN_NOTIFY_TURN_PREFIX.length).split(':')[0];
  const request = await db.sessionRequest.findFirst({
    where: { id, toSessionId: recipientSessionId, kind: 'RUN_NOTIFY' },
  });
  if (!request) return null;
  const run = await db.session.findFirst({
    where: { id: request.fromSessionId, ownerId: request.ownerId },
    select: { task: { select: { id: true, title: true } } },
  });
  const sender = await readBlockSender(db, request.ownerId, request.fromSessionId, recipientSessionId);
  const closed = request.state !== 'OPEN' && request.state !== 'READ';
  return [
    `<orbit-run-notice task="${run?.task ? uuidToBase62(run.task.id) : ''}" run-session="${uuidToBase62(request.fromSessionId)}" ${sender?.attributes.join(' ') ?? ''}>`,
    ...(sender?.lines ?? []),
    `A run of the task “${attribute(run?.task?.title ?? 'Unknown task')}” used notify. It did not reach the account owner.`,
    `Message: ${request.requestPreview}`,
    closed ? `This notice is closed (${request.state}). Nothing to answer; end your turn.`
      : 'Nothing is waiting for your reply. If the owner should know or decide, use ask_owner with your recommendation.',
    '</orbit-run-notice>',
  ].join('\n');
}

/** M3: called only while createTurn holds the recipient session lock. */
export async function recordRunNotify(tx: Prisma.TransactionClient, data: Prisma.SessionRequestUncheckedCreateInput): Promise<void> {
  await tx.sessionRequest.create({ data });
}
