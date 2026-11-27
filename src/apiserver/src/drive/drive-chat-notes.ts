import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  DRIVE_CHAT_NOTE_TAG,
  driveChatContextErrors,
  driveChatGuidance,
  uuidToBase62,
  wikiChatNoteAttribute,
  type DriveChatContext,
} from '@orbit/shared';

/**
 * What delivery appends to a Drive chat's message (drive/drive-chat.ts; modelled on wiki/wiki-chat-notes.ts): one
 * `<orbit_drive_chat>` block after the owner's words, so the turn's content stays those words alone and the runner's
 * echo records the rest as the note a client draws as "Orbit attached:". It holds
 *
 *   - the standing guidance (@orbit/shared `driveChatGuidance`), on the chat's first message and on the first message
 *     after its text changed — the digest of what was sent is kept on the session (`drive_chat_prompt_digest`), written
 *     in this delivery's transaction, so a claim rolled back sends it again;
 *   - the folder the owner had open and the items they selected, read NOW from the ids the message door kept
 *     (`conversation_turn.drive_context`): each item's path, kind, size and last writer as the drive holds them when the
 *     turn is handed out. An item in Trash, or gone, is left out and said so: Trash is invisible to agents.
 *
 * No text the client sent is read — only ids. Ids are written as public ids, as the drive tools take them.
 */

/** One Drive-chat turn being handed to its runner. */
export interface DriveChatDelivery {
  ownerId: string;
  sessionId: string;
  /** The runner the session is assigned: an Orbit Cloud runner mounts the drive at ~/Files. */
  runnerId: string | null;
  turn: { seq: number; kind: string; driveContext: unknown };
}

/** The digest of a guidance text, as the session keeps it. */
export function driveChatGuidanceDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The delivered text with `<orbit_drive_chat>` after the owner's words, or `content` as it was when the turn carries
 * nothing to say: no folder or selection, and guidance the agent already has (or a steer, which joins a turn whose
 * message had it).
 */
export async function appendDriveChatNotes(
  tx: Prisma.TransactionClient,
  delivery: DriveChatDelivery,
  content: string | undefined,
): Promise<string | undefined> {
  let guidance: string[] | null = null;
  if (delivery.turn.kind === 'message') {
    const lines = driveChatGuidance(await onOrbitCloud(tx, delivery));
    const digest = driveChatGuidanceDigest(lines.join('\n'));
    const told = await tx.session.findUnique({ where: { id: delivery.sessionId }, select: { driveChatPromptDigest: true } });
    if (told?.driveChatPromptDigest !== digest || (await opensTheChat(tx, delivery.sessionId, delivery.turn.seq))) {
      guidance = lines;
      await tx.session.updateMany({ where: { id: delivery.sessionId }, data: { driveChatPromptDigest: digest } });
    }
  }
  const context = storedContext(delivery.turn.driveContext);
  if (!guidance && !context) return content;
  const attributes: Array<readonly [string, string | number]> = [];
  const body: string[] = [];
  if (guidance) body.push('How to work in this chat:', ...guidance.map((line) => `- ${line}`));
  if (context) {
    const where = await contextLines(tx, delivery, context);
    attributes.push(...where.attributes);
    if (body.length > 0) body.push('');
    body.push(...where.lines);
  }
  const head = attributes.length === 0
    ? `<${DRIVE_CHAT_NOTE_TAG}>`
    : `<${DRIVE_CHAT_NOTE_TAG} ${attributes.map(([name, value]) => wikiChatNoteAttribute(name, value)).join(' ')}>`;
  return [content ?? '', [head, ...body, `</${DRIVE_CHAT_NOTE_TAG}>`].join('\n')].join('\n\n');
}

/** Whether the session runs on the account's Orbit Cloud runner, which mounts the drive at ~/Files. */
async function onOrbitCloud(tx: Prisma.TransactionClient, delivery: DriveChatDelivery): Promise<boolean> {
  if (!delivery.runnerId) return false;
  const managed = await tx.managedRunner.findFirst({
    where: { runnerId: delivery.runnerId, ownerId: delivery.ownerId, desiredState: { not: 'DELETED' } },
    select: { id: true },
  });
  return managed !== null;
}

/** Whether this is the chat's first message: no message or steer of the session comes before it. */
async function opensTheChat(tx: Prisma.TransactionClient, sessionId: string, seq: number): Promise<boolean> {
  const earlier = await tx.conversationTurn.findFirst({
    where: { sessionId, seq: { lt: seq }, kind: { in: ['message', 'steer'] } },
    select: { id: true },
  });
  return earlier === null;
}

/** The stored context, held to the shape its door held it to; anything else is read as none. */
function storedContext(value: unknown): DriveChatContext | null {
  if (value === null || value === undefined || driveChatContextErrors(value).length > 0) return null;
  const context = value as Partial<DriveChatContext>;
  return { folderId: context.folderId ?? null, entryIds: context.entryIds ?? [] };
}

interface EntryFacts {
  id: string;
  /** From the root, `/` for the root itself. */
  path: string;
  /** The entry or a folder above it is in Trash. */
  trashed: boolean;
  kind: string;
  sizeBytes: bigint;
  lastWriterKind: string;
  lastWriterSessionId: string | null;
  lastWrittenAt: Date;
}

/** The entries of `ids` the owner has, each with its path and whether it or a folder above it is in Trash. */
async function entryFacts(tx: Prisma.TransactionClient, ownerId: string, ids: readonly string[]): Promise<Map<string, EntryFacts>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<EntryFacts[]>`
    WITH RECURSIVE "up" AS (
      SELECT e."id" AS "start", e."id", e."parent_id", e."name", e."trashed_at", 0 AS "depth"
        FROM "drive_entry" e
       WHERE e."owner_id" = ${ownerId}::uuid AND e."id" = ANY(${[...ids]}::uuid[])
      UNION ALL
      SELECT "up"."start", p."id", p."parent_id", p."name", p."trashed_at", "up"."depth" + 1
        FROM "drive_entry" p JOIN "up" ON p."id" = "up"."parent_id"
       WHERE p."owner_id" = ${ownerId}::uuid
    ), "paths" AS (
      SELECT "start",
             '/' || COALESCE(string_agg("name", '/' ORDER BY "depth" DESC) FILTER (WHERE "parent_id" IS NOT NULL), '') AS "path",
             bool_or("trashed_at" IS NOT NULL) AS "trashed"
        FROM "up" GROUP BY "start"
    )
    SELECT e."id"::text AS "id", "paths"."path", "paths"."trashed", e."kind", e."size_bytes" AS "sizeBytes",
           e."last_writer_kind" AS "lastWriterKind", e."last_writer_session_id"::text AS "lastWriterSessionId",
           e."last_written_at" AS "lastWrittenAt"
      FROM "paths" JOIN "drive_entry" e ON e."id" = "paths"."start"`;
  return new Map(rows.map((row) => [row.id, row]));
}

/** A size as people read it, with the exact bytes beside it past a kilobyte. */
export function driveSizeLabel(bytes: bigint): string {
  const n = Number(bytes);
  if (n < 1024) return n === 1 ? '1 byte' : `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]} (${n.toLocaleString('en-US')} bytes)`;
}

/** Who wrote an entry last, and when, as the agent is told. */
function lastWriterLabel(entry: EntryFacts, sessionId: string): string {
  const who = entry.lastWriterKind === 'OWNER'
    ? 'the owner'
    : entry.lastWriterSessionId === sessionId
      ? 'you, in this chat'
      : entry.lastWriterSessionId
        ? `an agent, in session ${uuidToBase62(entry.lastWriterSessionId)}`
        : 'an agent';
  return `last written by ${who}, ${entry.lastWrittenAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The folder line and the selection's lines, with the block's attributes. */
async function contextLines(
  tx: Prisma.TransactionClient,
  delivery: DriveChatDelivery,
  context: DriveChatContext,
): Promise<{ attributes: Array<readonly [string, string | number]>; lines: string[] }> {
  const facts = await entryFacts(tx, delivery.ownerId, [...(context.folderId ? [context.folderId] : []), ...context.entryIds]);
  const lines: string[] = [];
  const attributes: Array<readonly [string, string | number]> = [];
  if (context.folderId === null) {
    attributes.push(['folder', '/']);
    lines.push("The owner has the drive's top level (/) open.");
  } else {
    const folder = facts.get(context.folderId);
    if (folder && !folder.trashed && folder.kind === 'FOLDER') {
      attributes.push(['folder', folder.path]);
      lines.push(`The owner has the folder ${folder.path} open (id ${uuidToBase62(folder.id)}).`);
    } else {
      lines.push('The folder the owner had open is not in the drive any more, so it is not named here.');
    }
  }
  const live = context.entryIds.map((id) => facts.get(id)).filter((entry): entry is EntryFacts => !!entry && !entry.trashed);
  const missing = context.entryIds.length - live.length;
  attributes.push(['selected', live.length]);
  if (live.length > 0) {
    lines.push(`Selected (${live.length}):`);
    for (const entry of live) {
      const kind = entry.kind === 'FOLDER' ? 'folder' : 'file';
      const size = entry.kind === 'FOLDER' ? '' : ` · ${driveSizeLabel(entry.sizeBytes)}`;
      lines.push(`- ${entry.path} · ${kind}${size} · ${lastWriterLabel(entry, delivery.sessionId)} · id ${uuidToBase62(entry.id)}`);
    }
  } else if (context.entryIds.length === 0) {
    lines.push('Nothing is selected.');
  }
  if (missing > 0) {
    lines.push(`Left out: ${missing === 1 ? 'a selected item that is' : `${missing} selected items that are`} not in the drive any more.`);
  }
  return { attributes, lines };
}
