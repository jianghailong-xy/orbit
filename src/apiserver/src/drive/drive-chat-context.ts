import { BadRequestException } from '@nestjs/common';
import { DRIVE_CHAT_RULES, driveChatContextErrors, toUuid, type DriveChatContext } from '@orbit/shared';

/**
 * The folder and the selection a Drive chat's message carries, as the doors that take one read it: the chat's create,
 * and the session's own message door for its later messages. Small and free of the drive service on purpose: the
 * session doors import it.
 */

/** An id as the UUID it names, public id or UUID alike, or null for anything that names no row. */
function uuidOf(id: string): string | null {
  try {
    return toUuid(id);
  } catch {
    return null;
  }
}

/**
 * A message's driveContext, ids written as UUIDs, or null when it carries none. Anything that is not
 * `{ folderId?, entryIds? }` — a folder id or an item id that names no row, more than selectionMax items — is a 400 that
 * says what it takes, before anything is filed. Each item is kept once, in the order sent.
 */
export function readDriveChatContext(value: unknown): DriveChatContext | null {
  if (value === undefined || value === null) return null;
  const refuse = (paths: string[]) => new BadRequestException({
    code: 'DRIVE_CHAT_CONTEXT_INVALID',
    message: 'driveContext is { folderId?, entryIds? }: the id of the folder the owner has open (null for the drive\'s top '
      + `level) and the ids of at most ${DRIVE_CHAT_RULES.selectionMax} items they selected`,
    errors: paths.map((path) => ({ path, message: 'is not what a Drive chat message carries here' })),
  });
  const paths = driveChatContextErrors(value);
  if (paths.length > 0) throw refuse(paths);
  const record = value as { folderId?: string | null; entryIds?: string[] };
  const folderId = record.folderId == null ? null : uuidOf(record.folderId);
  if (record.folderId != null && folderId === null) throw refuse(['folderId']);
  const entryIds: string[] = [];
  const bad: string[] = [];
  (record.entryIds ?? []).forEach((id, index) => {
    const uuid = uuidOf(id);
    if (uuid === null) bad.push(`entryIds.${index}`);
    else if (!entryIds.includes(uuid)) entryIds.push(uuid);
  });
  if (bad.length > 0) throw refuse(bad);
  return { folderId, entryIds };
}

/** A message carrying a driveContext to a session that is no Drive chat: 400, nothing filed. */
export function driveContextOutsideChat(): BadRequestException {
  return new BadRequestException(
    'driveContext rides only on a message to a Drive chat, and this session is not one: send the message without it',
  );
}

/** Whether a replayed clientTurnId carries the context its turn was filed with (absent and null are one). */
export function sameDriveChatContext(stored: unknown, sent: DriveChatContext | null): boolean {
  const norm = (value: unknown) => {
    if (value === null || value === undefined) return 'null';
    const context = value as Partial<DriveChatContext>;
    return JSON.stringify([context.folderId ?? null, context.entryIds ?? []]);
  };
  return norm(stored) === norm(sent);
}
