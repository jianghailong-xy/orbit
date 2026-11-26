import { HttpException, HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { DriveWriter } from './drive.service';

/**
 * What a Drive chat's drive writes leave behind (owner decision Q2 A, board docs/mocks/drive-chat/01-board.html frames ③
 * ④; migration 1700): every change the chat's agent makes is recorded, in the write's own transaction, into the change
 * group of the turn it made it in, which the owner sees as one card and reverses with one Undo
 * (drive-chat-changes.ts). This file is what the name layer (drive.service.ts) calls from inside its transactions; it
 * takes the group row FOR UPDATE after every drive row the write holds, and nothing after it.
 *
 *   - A write is a Drive chat's when its writer is an agent whose session — the owner's, on the runner the write came
 *     through, as `checkedWriter` keeps it — was opened by DRIVE_CHAT. A write through a runner's mount that names no
 *     session is the chat's when the chat is the runner's only live session (driveChatOfUnattributedMountWrite). Its turn is the message the session is working
 *     on (the one IN_FLIGHT, of which the inbox hands out one at a time), else its last message.
 *   - A turn makes at most 200 changes (DRIVE_CHAT_TURN_CHANGES_MAX). The write that would be the 201st, and every one
 *     after it in that turn, throws DriveChatTurnFull here, which rolls the write back: the runner door then holds a
 *     new folder, a move, a rename or a move to Trash in the turn's PENDING group, and refuses a new file or new content,
 *     which have no bytes to wait with.
 *   - A write made by the owner's Apply carries the group (`DriveWriter.changeGroupId`) and is recorded into it, with no
 *     limit: it is the owner's press.
 */

/** How many changes one turn of a Drive chat makes before the rest wait for the owner's Apply. */
export const DRIVE_CHAT_TURN_CHANGES_MAX = 200;

export const DRIVE_CHAT_TURN_FULL = 'DRIVE_CHAT_TURN_FULL';

/** What a change did, as the card counts it. */
export type DriveChatChangeKind = 'NEW_FOLDER' | 'NEW_FILE' | 'MOVE' | 'RENAME' | 'TRASH' | 'EDIT';

/** The turn of a Drive chat a write belongs to. */
export interface DriveChatTurn {
  ownerId: string;
  sessionId: string;
  turnId: string;
}

/** One change as the name layer made it: the entry, where it was and is (parent, name), and its seq after. */
export interface DriveChatChangeInput {
  kind: DriveChatChangeKind;
  entryId: string;
  entryKind: string;
  beforeParentId: string | null;
  beforeName: string | null;
  afterParentId: string | null;
  afterName: string;
  afterSeq: bigint | number;
  trashGroupId?: string | null;
  versionId?: string | null;
  replacedVersionId?: string | null;
}

/**
 * Thrown inside a Drive chat's write when its turn already made DRIVE_CHAT_TURN_CHANGES_MAX changes, or already holds
 * some for Apply: the write is rolled back. Its own text is the refusal of a write that cannot be held (a new file, new
 * content); the runner door answers a held one with its own.
 */
export class DriveChatTurnFull extends HttpException {
  constructor(readonly turn: DriveChatTurn) {
    super({
      code: DRIVE_CHAT_TURN_FULL,
      message: `Not written: this turn has already made ${DRIVE_CHAT_TURN_CHANGES_MAX} changes in the owner's Drive, and a `
        + 'new file or new content cannot wait for their Apply, so nothing was written. Stop here and tell the owner what is '
        + 'left; they can ask for it in their next message.',
    }, HttpStatus.CONFLICT);
  }
}

type Db = Pick<Prisma.TransactionClient, 'session' | 'conversationTurn'>;

/**
 * The Drive-chat turn a write of `writer` belongs to, or null: an agent's write whose session is a Drive chat of this
 * owner's (and, when the writer names its runner, runs on it). Read without locks.
 */
export async function driveChatTurnOf(db: Db, ownerId: string, writer: DriveWriter): Promise<DriveChatTurn | null> {
  if (writer.kind !== 'AGENT' || !writer.sessionId) return null;
  const session = await db.session.findFirst({
    where: {
      id: writer.sessionId, ownerId, openedBy: 'DRIVE_CHAT',
      ...(writer.runnerId ? { assignedRunnerId: writer.runnerId } : {}),
    },
    select: { id: true },
  });
  if (!session) return null;
  const turn = await db.conversationTurn.findFirst({
    where: { sessionId: session.id, status: 'IN_FLIGHT', kind: { in: ['message', 'shell'] } },
    orderBy: { seq: 'desc' },
    select: { id: true },
  }) ?? await db.conversationTurn.findFirst({
    where: { sessionId: session.id, kind: 'message' },
    orderBy: { seq: 'desc' },
    select: { id: true },
  });
  return turn ? { ownerId, sessionId: session.id, turnId: turn.id } : null;
}

/**
 * The Drive chat an unattributed write through a runner's mount is counted as (docs/drive-technical-design.md §5.8): on
 * a mount that cannot tell its callers apart (Docker's mounter keeps its own pid namespace, so every pid reads 0), a
 * write that names no session comes from a process of one of the runner's live sessions. When the only live session
 * on the runner — not ended, and with a turn in flight or a background process still running — is a Drive chat of this
 * owner's, the write is that chat's, and its rules apply to it as to the chat's drive tools. With any other session
 * live, or none, it is nobody's: null. Read without locks, over the runner's held sessions (session_runner_held_idx).
 */
export async function driveChatOfUnattributedMountWrite(
  db: Pick<Prisma.TransactionClient, 'session'>,
  ownerId: string,
  runnerId: string,
): Promise<string | null> {
  const live = await db.session.findMany({
    where: {
      assignedRunnerId: runnerId, finishedAt: null,
      OR: [{ turnState: 'IN_FLIGHT' }, { runningBgShells: { isEmpty: false } }],
    },
    select: { id: true, ownerId: true, openedBy: true },
    take: 2,
  });
  if (live.length !== 1) return null;
  const [only] = live;
  return only.ownerId === ownerId && only.openedBy === 'DRIVE_CHAT' ? only.id : null;
}

/** The turn's group collecting changes as they are made, made here when it has none, held FOR UPDATE. */
async function collectingGroup(tx: Prisma.TransactionClient, turn: DriveChatTurn): Promise<string> {
  await tx.$executeRaw`
    INSERT INTO "drive_chat_change_group" ("id", "owner_id", "session_id", "turn_id", "status")
    VALUES (gen_random_uuid(), ${turn.ownerId}::uuid, ${turn.sessionId}::uuid, ${turn.turnId}::uuid, 'DONE')
    ON CONFLICT ("session_id", "turn_id") WHERE "status" = 'DONE' AND NOT "held" DO NOTHING`;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "drive_chat_change_group"
     WHERE "session_id" = ${turn.sessionId}::uuid AND "turn_id" = ${turn.turnId}::uuid AND "status" = 'DONE' AND NOT "held"
     FOR UPDATE`;
  return rows[0].id;
}

/**
 * Whether the turn takes no more changes: it made DRIVE_CHAT_TURN_CHANGES_MAX, or already holds some for Apply (so what
 * comes after waits behind them, in order). Read under the collecting group's lock by the recorder, unlocked by the door.
 */
export async function driveChatTurnIsFull(db: Pick<Prisma.TransactionClient, '$queryRaw'>, turn: DriveChatTurn): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ made: bigint; waiting: boolean }>>`
    SELECT (SELECT count(*) FROM "drive_chat_change" c JOIN "drive_chat_change_group" g ON g."id" = c."group_id"
             WHERE g."session_id" = ${turn.sessionId}::uuid AND g."turn_id" = ${turn.turnId}::uuid AND NOT g."held") AS "made",
           EXISTS (SELECT 1 FROM "drive_chat_change_group" g
                    WHERE g."session_id" = ${turn.sessionId}::uuid AND g."turn_id" = ${turn.turnId}::uuid
                      AND g."status" IN ('PENDING', 'APPLYING')) AS "waiting"`;
  return rows[0].waiting || Number(rows[0].made) >= DRIVE_CHAT_TURN_CHANGES_MAX;
}

async function insertChange(tx: Prisma.TransactionClient, ownerId: string, groupId: string, change: DriveChatChangeInput): Promise<void> {
  await tx.driveChatChange.create({
    data: {
      groupId, ownerId, kind: change.kind, entryId: change.entryId, entryKind: change.entryKind,
      beforeParentId: change.beforeParentId, beforeName: change.beforeName, afterParentId: change.afterParentId,
      afterName: change.afterName, afterSeq: BigInt(change.afterSeq), trashGroupId: change.trashGroupId ?? null,
      versionId: change.versionId ?? null, replacedVersionId: change.replacedVersionId ?? null,
    },
  });
}

/**
 * The group a write is recorded into, locked: Apply's own (no turn: the owner's press has no limit), or its Drive-chat
 * turn's collecting group; null for any other write.
 */
async function groupFor(
  tx: Prisma.TransactionClient,
  ownerId: string,
  writer: DriveWriter,
): Promise<{ groupId: string; turn: DriveChatTurn | null } | null> {
  if (writer.changeGroupId) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "drive_chat_change_group" WHERE "id" = ${writer.changeGroupId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
    return rows.length ? { groupId: rows[0].id, turn: null } : null;
  }
  const turn = await driveChatTurnOf(tx, ownerId, writer);
  return turn ? { groupId: await collectingGroup(tx, turn), turn } : null;
}

/** A change about to be counted: refused DriveChatTurnFull when its turn takes no more. */
async function admit(tx: Prisma.TransactionClient, turn: DriveChatTurn | null): Promise<void> {
  if (turn && (await driveChatTurnIsFull(tx, turn))) throw new DriveChatTurnFull(turn);
}

/** One change of a Drive chat's write recorded into its turn's group, in the write's transaction; nothing for any other write. */
export async function recordDriveChatChange(
  tx: Prisma.TransactionClient,
  ownerId: string,
  writer: DriveWriter,
  change: DriveChatChangeInput,
): Promise<void> {
  const group = await groupFor(tx, ownerId, writer);
  if (!group) return;
  await admit(tx, group.turn);
  await insertChange(tx, ownerId, group.groupId, change);
}

/**
 * A later write to an entry the group already holds a change of (a new file's content, the mtime a batch sets after its
 * commit, a second edit): that change follows it — its seq, and the version it made current — rather than counting as
 * one more. An entry the group has no change of is recorded as `otherwise`, when given.
 */
export async function followDriveChatChange(
  tx: Prisma.TransactionClient,
  ownerId: string,
  writer: DriveWriter,
  entryId: string,
  after: { seq: bigint | number; versionId?: string | null },
  otherwise?: DriveChatChangeInput,
): Promise<void> {
  const group = await groupFor(tx, ownerId, writer);
  if (!group) return;
  const last = await tx.driveChatChange.findFirst({
    where: { groupId: group.groupId, entryId, state: 'DONE' }, orderBy: { ord: 'desc' }, select: { id: true, kind: true },
  });
  if (last) {
    await tx.driveChatChange.update({
      where: { id: last.id },
      data: {
        afterSeq: BigInt(after.seq), updatedAt: new Date(),
        ...(after.versionId && (last.kind === 'EDIT' || last.kind === 'NEW_FILE') ? { versionId: after.versionId } : {}),
      },
    });
    return;
  }
  if (!otherwise) return;
  await admit(tx, group.turn);
  await insertChange(tx, ownerId, group.groupId, otherwise);
}
