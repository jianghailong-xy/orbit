import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type DriveChatChangeGroup,
  type DriveChatChangeItem,
  type DriveChatChangeKind,
  type DriveChatHeldItem,
  type DriveChatQuestion,
  type DriveChatQuestionFile,
} from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { DRIVE_CHAT_TURN_CHANGES_MAX, driveChatTurnIsFull, driveChatTurnOf, type DriveChatTurn } from './drive-chat-change-record';
import { driveSizeLabel } from './drive-chat-notes';
import {
  DRIVE_CHANGED_SINCE,
  DRIVE_NAME_TAKEN,
  DRIVE_PARENT_GONE,
  drivePathSegments,
  drivePathsOf,
  DriveService,
  OWNER_WRITER,
  suffixedName,
  type DriveEntryRow,
  type DriveWriter,
} from './drive.service';

/**
 * A Drive chat's changes, as the owner sees and reverses them (owner decision Q2 A, 2026-11-26; board
 * docs/mocks/drive-chat/01-board.html frames ③ ④; migration 1700). The recording itself is the name layer's, in each
 * write's own transaction (drive-chat-change-record.ts); this is the rest:
 *
 *   - The owner's reads: a chat's change groups, each with its status (DONE, PENDING, UNDONE, and APPLYING or UNDOING
 *     while those run), its counts per kind and every item for "Show all"; and its overwrite questions.
 *   - Undo: a DONE group reversed, last change first, each in a drive transaction of its own that re-checks the entry
 *     has not changed since (`ifSeq`): a move or rename goes back, a new folder is removed while it is empty, a new file
 *     goes to Trash, an edit's replaced version is current again, an item in Trash comes back by the Trash's own
 *     restore. An item changed since — by anyone, or because a later change to it could not be undone — is skipped and
 *     reported, never clobbered.
 *   - The hold: past the turn's 200th change, the runner door files each new folder, move, rename and move to Trash here
 *     as a held write of the turn's PENDING group, which changes nothing until the owner presses Apply; Apply makes them
 *     in order, as the owner, recording what it made into the group, which Undo then reverses like any other.
 *   - No overwrite: a Drive chat's move or rename onto a live file is refused with both files named, and kept as a
 *     question the owner answers Keep both (the incoming file takes the first free suffix) or Replace (the file there
 *     keeps its id and its old content as a version in Trash, the drive's own replacing rename).
 *
 * Every owner route refuses an acting session (DRIVE_CHAT_OWNER_CHANNEL_ONLY), and another account's chat is not found.
 */

export const DRIVE_CHAT_HELD = 'DRIVE_CHAT_HELD';
export const DRIVE_CHAT_NO_OVERWRITE = 'DRIVE_CHAT_NO_OVERWRITE';
export const DRIVE_CHAT_NOT_FOUND = 'DRIVE_CHAT_NOT_FOUND';
export const DRIVE_CHAT_GROUP_NOT_FOUND = 'DRIVE_CHAT_GROUP_NOT_FOUND';
export const DRIVE_CHAT_GROUP_STATE = 'DRIVE_CHAT_GROUP_STATE';
export const DRIVE_CHAT_QUESTION_NOT_FOUND = 'DRIVE_CHAT_QUESTION_NOT_FOUND';
export const DRIVE_CHAT_QUESTION_STATE = 'DRIVE_CHAT_QUESTION_STATE';

/** A press still marked APPLYING, UNDOING or ANSWERING this long after it last moved was cut off: another press takes it over. */
const PRESS_STALE_MS = 2 * 60 * 1000;

/** A write the runner door held for Apply, as the agent asked for it. */
export type DriveChatHeldOp =
  | { op: 'MKDIR'; path: string; parents: boolean }
  | { op: 'RENAME'; entryId: string; to: string }
  | { op: 'TRASH'; entryId: string };

type GroupRow = NonNullable<Awaited<ReturnType<PrismaService['driveChatChangeGroup']['findFirst']>>>;
type ChangeRow = NonNullable<Awaited<ReturnType<PrismaService['driveChatChange']['findFirst']>>>;
type HeldRow = NonNullable<Awaited<ReturnType<PrismaService['driveChatHeldChange']['findFirst']>>>;
type QuestionRow = NonNullable<Awaited<ReturnType<PrismaService['driveChatQuestion']['findFirst']>>>;

const refusal = (status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}) =>
  new HttpException({ code, message, ...extra }, status);

/** A drive path as one form: `/A/b.pdf`. */
const normalPath = (path: string) => '/' + drivePathSegments(path).join('/');
const parentPathOf = (path: string) => '/' + drivePathSegments(path).slice(0, -1).join('/');
const quoted = (name: string) => `"${name}"`;

/** When a file was last changed, as the agent's text reads it: `2026-09-30 10:12 UTC`. */
const whenLabel = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

function readableMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse() as { message?: unknown } | string;
    if (typeof body === 'string') return body;
    if (typeof body.message === 'string') return body.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null ? ((body as { code?: unknown }).code as string | undefined) ?? null : null;
}

@Injectable()
export class DriveChatChanges {
  private readonly logger = new Logger(DriveChatChanges.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly drive: DriveService,
  ) {}

  // ── the runner door's ───────────────────────────────────────────────────────────────────────

  /** The Drive-chat turn a runner write of `writer` belongs to, or null (drive-chat-change-record.ts). */
  turnOf(ownerId: string, writer: DriveWriter): Promise<DriveChatTurn | null> {
    return driveChatTurnOf(this.prisma, ownerId, writer);
  }

  /** Whether the turn takes no more changes: what comes now is held. */
  isFull(turn: DriveChatTurn): Promise<boolean> {
    return driveChatTurnIsFull(this.prisma, turn);
  }

  /**
   * A write of a full turn filed as a held write of its PENDING group, and the agent told so: always throws the 409
   * DRIVE_CHAT_HELD. Nothing in Drive changes.
   */
  async hold(turn: DriveChatTurn, op: DriveChatHeldOp): Promise<never> {
    const shown = await this.heldDisplay(turn.ownerId, op);
    const held = await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "drive_chat_change_group" ("id", "owner_id", "session_id", "turn_id", "status", "held")
        VALUES (gen_random_uuid(), ${turn.ownerId}::uuid, ${turn.sessionId}::uuid, ${turn.turnId}::uuid, 'PENDING', true)
        ON CONFLICT ("session_id", "turn_id") WHERE "status" IN ('PENDING', 'APPLYING') DO NOTHING`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "drive_chat_change_group"
         WHERE "session_id" = ${turn.sessionId}::uuid AND "turn_id" = ${turn.turnId}::uuid AND "status" IN ('PENDING', 'APPLYING')
         FOR UPDATE`;
      const groupId = rows[0].id;
      await tx.driveChatHeldChange.create({
        data: { groupId, ownerId: turn.ownerId, op: op as unknown as Prisma.InputJsonValue, ...shown },
      });
      await tx.driveChatChangeGroup.update({ where: { id: groupId }, data: { updatedAt: new Date() } });
      return { groupId, count: await tx.driveChatHeldChange.count({ where: { groupId } }) };
    }, loggedRetry(this.logger, 'driveChat.hold'));
    throw refusal(HttpStatus.CONFLICT, DRIVE_CHAT_HELD,
      `Held for the owner, not done: this turn has already made ${DRIVE_CHAT_TURN_CHANGES_MAX} changes in their Drive, so from `
      + `the ${DRIVE_CHAT_TURN_CHANGES_MAX + 1}st on each change waits on one card in this chat until the owner presses Apply `
      + `(${held.count} waiting now). Nothing was changed. Do not retry it: finish the turn by telling the owner what is `
      + 'waiting for their Apply.',
      { groupId: held.groupId, held: held.count });
  }

  /**
   * The refusal of a Drive chat's move or rename of `source` onto a live file named `name` in `folder`, with both files
   * named, after keeping it as a question for the owner; null when what is there is no file the chat would replace.
   */
  async overwriteRefusal(turn: DriveChatTurn, source: DriveEntryRow, folder: DriveEntryRow, name: string): Promise<HttpException | null> {
    const { ownerId } = turn;
    const target = await this.prisma.driveEntry.findFirst({ where: { ownerId, parentId: folder.id, name, trashedAt: null } });
    if (!target || target.kind !== 'FILE' || source.kind !== 'FILE' || target.id === source.id) return null;
    const moving = await this.fileFacts(ownerId, source);
    const existing = await this.fileFacts(ownerId, target);
    const asked = await this.prisma.driveChatQuestion.findFirst({
      where: { ownerId, sessionId: turn.sessionId, status: 'OPEN', sourceEntryId: source.id, destParentId: folder.id, destName: name },
      select: { id: true },
    }) ?? await this.prisma.driveChatQuestion.create({
      data: {
        ownerId, sessionId: turn.sessionId, turnId: turn.turnId, sourceEntryId: source.id, targetEntryId: target.id,
        destParentId: folder.id, destName: name,
        moving: moving as unknown as Prisma.InputJsonValue, existing: existing as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    const who = (file: DriveChatQuestionFile) =>
      file.lastWriter.kind === 'OWNER' ? 'the owner'
        : file.lastWriter.sessionId === turn.sessionId ? 'you, in this chat'
          : file.lastWriter.sessionTitle ? `an agent in ${quoted(file.lastWriter.sessionTitle)}` : 'an agent';
    const describe = (file: DriveChatQuestionFile) =>
      `${file.path} (${driveSizeLabel(BigInt(file.sizeBytes))}, last written by ${who(file)}, modified ${whenLabel(new Date(file.modifiedAt))})`;
    return refusal(HttpStatus.CONFLICT, DRIVE_CHAT_NO_OVERWRITE,
      `Not moved: ${existing.path} is already there, and a Drive chat never replaces a file. Moving: ${describe(moving)}. `
      + `Already there: ${describe(existing)}. The owner is asked on a card in this chat whether to keep both (the moving `
      + 'file gets a numbered name) or replace the one there (its content is kept as an earlier version). Tell them which '
      + 'you recommend and why, and do not retry this move.',
      { questionId: asked.id, moving, existing });
  }

  // ── the owner's ─────────────────────────────────────────────────────────────────────────────

  /** `GET /api/drive/chats/:sessionId/groups`: the chat's change groups, oldest first, each with every item. */
  async groups(ownerId: string, sessionId: string, actingSessionId: string | null): Promise<{ groups: DriveChatChangeGroup[] }> {
    refuseActingSession(actingSessionId);
    await this.chat(ownerId, sessionId);
    const rows = await this.prisma.driveChatChangeGroup.findMany({
      where: { ownerId, sessionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { groups: await this.views(ownerId, rows) };
  }

  /** `GET /api/drive/chats/:sessionId/groups/:id`: one group, every item. */
  async group(ownerId: string, sessionId: string, groupId: string, actingSessionId: string | null): Promise<DriveChatChangeGroup> {
    refuseActingSession(actingSessionId);
    await this.chat(ownerId, sessionId);
    return (await this.views(ownerId, [await this.groupRow(ownerId, sessionId, groupId)]))[0];
  }

  /**
   * `POST .../groups/:id/undo`: the group's changes reversed, last first. An item changed since is skipped and reported
   * (`state` SKIPPED, `reason`), and so is every earlier change of the same entry, whose state the skip left unreached.
   */
  async undo(ownerId: string, sessionId: string, groupId: string, actingSessionId: string | null): Promise<DriveChatChangeGroup> {
    refuseActingSession(actingSessionId);
    await this.chat(ownerId, sessionId);
    const claimed = await this.claim(ownerId, sessionId, groupId, 'DONE', 'UNDOING');
    if (!claimed) {
      const group = await this.groupRow(ownerId, sessionId, groupId);
      throw refusal(HttpStatus.CONFLICT, DRIVE_CHAT_GROUP_STATE, group.status === 'UNDONE'
        ? 'These changes are already undone.'
        : group.status === 'PENDING' || group.status === 'APPLYING'
          ? 'Nothing of these changes was made yet: they wait for Apply.'
          : 'These changes are being undone already.', { status: group.status });
    }
    const changes = await this.prisma.driveChatChange.findMany({ where: { groupId }, orderBy: { ord: 'desc' } });
    // The seq each entry is expected at: what the latest change of it left, then what each undo of it leaves.
    const expected = new Map<string, bigint | null>();
    const blocked = new Set<string>();
    for (const change of changes) {
      if (change.state === 'SKIPPED') blocked.add(change.entryId);
      // Taken over from a cut-off Undo: what it undid is trusted at the seq the entry has now.
      if (change.state === 'UNDONE' && !expected.has(change.entryId)) expected.set(change.entryId, null);
    }
    for (const change of changes) {
      if (change.state !== 'DONE') continue;
      const outcome = blocked.has(change.entryId)
        ? { undone: false as const, reason: `${quoted(change.afterName)} was left as it is: a later change to it could not be undone.` }
        : await this.undoOne(ownerId, change, expected);
      if (outcome.undone) {
        const now = await this.prisma.driveEntry.findFirst({ where: { id: change.entryId, ownerId }, select: { seq: true } });
        expected.set(change.entryId, now?.seq ?? null);
      } else {
        blocked.add(change.entryId);
      }
      await this.prisma.driveChatChange.update({
        where: { id: change.id },
        data: { state: outcome.undone ? 'UNDONE' : 'SKIPPED', reason: outcome.undone ? null : outcome.reason, updatedAt: new Date() },
      });
      await this.prisma.driveChatChangeGroup.update({ where: { id: groupId }, data: { updatedAt: new Date() } });
    }
    const now = new Date();
    await this.prisma.driveChatChangeGroup.update({ where: { id: groupId }, data: { status: 'UNDONE', undoneAt: now, updatedAt: now } });
    return this.group(ownerId, sessionId, groupId, null);
  }

  /**
   * `POST .../groups/:id/apply`: a PENDING group's held writes made, in the order the agent asked for them, as the owner,
   * what each makes recorded into the group; one that cannot be made now is skipped and says why. The group is DONE
   * after, and Undo reverses what Apply made.
   */
  async apply(ownerId: string, sessionId: string, groupId: string, actingSessionId: string | null): Promise<DriveChatChangeGroup> {
    refuseActingSession(actingSessionId);
    await this.chat(ownerId, sessionId);
    const claimed = await this.claim(ownerId, sessionId, groupId, 'PENDING', 'APPLYING');
    if (!claimed) {
      const group = await this.groupRow(ownerId, sessionId, groupId);
      throw refusal(HttpStatus.CONFLICT, DRIVE_CHAT_GROUP_STATE, group.status === 'APPLYING'
        ? 'These changes are being applied already.'
        : 'Only changes waiting for Apply can be applied; these were made already.', { status: group.status });
    }
    const writer: DriveWriter = { ...OWNER_WRITER, changeGroupId: groupId };
    for (;;) {
      const next = await this.prisma.driveChatHeldChange.findFirst({ where: { groupId, state: 'PENDING' }, orderBy: { ord: 'asc' } });
      if (!next) {
        // Done only when no held write came in meanwhile: one that did is taken next.
        const finished = await withTransactionRetry(this.prisma, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "drive_chat_change_group" WHERE "id" = ${groupId}::uuid FOR UPDATE`;
          if (await tx.driveChatHeldChange.count({ where: { groupId, state: 'PENDING' } })) return false;
          const now = new Date();
          await tx.driveChatChangeGroup.update({ where: { id: groupId }, data: { status: 'DONE', appliedAt: now, updatedAt: now } });
          return true;
        }, loggedRetry(this.logger, 'driveChat.apply'));
        if (finished) break;
        continue;
      }
      let reason: string | null = null;
      try {
        await this.applyOne(ownerId, next, writer);
      } catch (error) {
        if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
        reason = readableMessage(error);
      }
      await this.prisma.driveChatHeldChange.update({
        where: { id: next.id }, data: { state: reason === null ? 'APPLIED' : 'SKIPPED', reason, updatedAt: new Date() },
      });
      await this.prisma.driveChatChangeGroup.update({ where: { id: groupId }, data: { updatedAt: new Date() } });
    }
    return this.group(ownerId, sessionId, groupId, null);
  }

  /** `GET /api/drive/chats/:sessionId/questions`: the chat's overwrite questions, oldest first. */
  async questions(ownerId: string, sessionId: string, actingSessionId: string | null): Promise<{ questions: DriveChatQuestion[] }> {
    refuseActingSession(actingSessionId);
    await this.chat(ownerId, sessionId);
    const rows = await this.prisma.driveChatQuestion.findMany({ where: { ownerId, sessionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return { questions: rows.map(questionView) };
  }

  /**
   * `POST /api/drive/chats/:sessionId/questions/:id { choice }`: the owner's answer. KEEP_BOTH moves the incoming file
   * under the first free numbered name; REPLACE moves it onto the file there, which keeps its id and its old content as a
   * version in Trash. A file that went meanwhile makes the question STALE, saying why.
   */
  async answer(
    ownerId: string,
    sessionId: string,
    questionId: string,
    choice: 'KEEP_BOTH' | 'REPLACE',
    actingSessionId: string | null,
  ): Promise<DriveChatQuestion> {
    refuseActingSession(actingSessionId);
    await this.chat(ownerId, sessionId);
    const stale = new Date(Date.now() - PRESS_STALE_MS);
    const claimed = await this.prisma.driveChatQuestion.updateMany({
      where: { id: questionId, ownerId, sessionId, OR: [{ status: 'OPEN' }, { status: 'ANSWERING', updatedAt: { lt: stale } }] },
      data: { status: 'ANSWERING', choice, updatedAt: new Date() },
    });
    if (!claimed.count) {
      const question = await this.prisma.driveChatQuestion.findFirst({ where: { id: questionId, ownerId, sessionId } });
      if (!question) throw refusal(HttpStatus.NOT_FOUND, DRIVE_CHAT_QUESTION_NOT_FOUND, 'No such question in this chat.');
      throw refusal(HttpStatus.CONFLICT, DRIVE_CHAT_QUESTION_STATE, question.status === 'STALE'
        ? `This can no longer be answered: ${question.reason ?? 'the files changed since.'}`
        : 'This question is answered already.', { status: question.status });
    }
    const question = await this.prisma.driveChatQuestion.findFirstOrThrow({ where: { id: questionId } });
    let outcome: { entryId: string; path: string; name: string };
    try {
      outcome = await this.answerOne(ownerId, question, choice);
    } catch (error) {
      if (!(error instanceof HttpException) || error.getStatus() >= 500) {
        await this.prisma.driveChatQuestion.update({ where: { id: questionId }, data: { status: 'OPEN', choice: null, updatedAt: new Date() } });
        throw error;
      }
      const reason = codeOf(error) === DRIVE_NAME_TAKEN
        ? `the name ${quoted(question.destName)} could not be had in its folder`
        : readableMessage(error).replace(/\.$/u, '');
      await this.prisma.driveChatQuestion.update({ where: { id: questionId }, data: { status: 'STALE', reason: `${reason}.`, updatedAt: new Date() } });
      throw refusal(HttpStatus.CONFLICT, DRIVE_CHAT_QUESTION_STATE, `This can no longer be answered: ${reason}.`, { status: 'STALE' });
    }
    const now = new Date();
    const answered = await this.prisma.driveChatQuestion.update({
      where: { id: questionId },
      data: { status: 'ANSWERED', outcome: outcome as unknown as Prisma.InputJsonValue, answeredAt: now, updatedAt: now },
    });
    return questionView(answered);
  }

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────

  /** The owner's Drive chat, or 404. */
  private async chat(ownerId: string, sessionId: string): Promise<void> {
    const found = await this.prisma.session.findFirst({ where: { id: sessionId, ownerId, openedBy: 'DRIVE_CHAT' }, select: { id: true } });
    if (!found) throw new NotFoundException({ code: DRIVE_CHAT_NOT_FOUND, message: 'No such Drive chat.' });
  }

  private async groupRow(ownerId: string, sessionId: string, groupId: string): Promise<GroupRow> {
    const group = await this.prisma.driveChatChangeGroup.findFirst({ where: { id: groupId, ownerId, sessionId } });
    if (!group) throw refusal(HttpStatus.NOT_FOUND, DRIVE_CHAT_GROUP_NOT_FOUND, 'No such changes in this chat.');
    return group;
  }

  /** The group moved from `from` to `to` for this press, or taken over from one cut off; false when it is in neither. */
  private async claim(ownerId: string, sessionId: string, groupId: string, from: string, to: string): Promise<boolean> {
    const stale = new Date(Date.now() - PRESS_STALE_MS);
    const claimed = await this.prisma.driveChatChangeGroup.updateMany({
      where: { id: groupId, ownerId, sessionId, OR: [{ status: from }, { status: to, updatedAt: { lt: stale } }] },
      data: { status: to, updatedAt: new Date() },
    });
    return claimed.count > 0;
  }

  /** One change reversed, if the entry is still as the change (or the undo of a later one) left it. */
  private async undoOne(
    ownerId: string,
    change: ChangeRow,
    expected: Map<string, bigint | null>,
  ): Promise<{ undone: true } | { undone: false; reason: string }> {
    const name = quoted(change.afterName);
    const skip = (reason: string) => ({ undone: false as const, reason });
    const entry = await this.prisma.driveEntry.findFirst({ where: { id: change.entryId, ownerId } });
    if (change.kind === 'TRASH') {
      if (!entry || !entry.trashedAt || entry.trashGroupId !== change.trashGroupId) {
        return skip(`${name} is no longer in Trash, so it was left as it is.`);
      }
      await this.drive.restoreItem(ownerId, change.trashGroupId!, change.entryId, OWNER_WRITER);
      return { undone: true };
    }
    if (!entry) return skip(`${name} is gone, so it was left as it is.`);
    if (entry.trashedAt) return skip(`${name} is in Trash now, so it was left as it is.`);
    const ifSeq = expected.has(change.entryId) ? expected.get(change.entryId) ?? entry.seq : change.afterSeq;
    const changedSince = () => skip(`${name} changed after this chat changed it, so it was left as it is.`);
    if (entry.seq !== ifSeq) return changedSince();
    try {
      switch (change.kind) {
        case 'MOVE':
        case 'RENAME':
          await this.drive.rename(ownerId, entry.id, {
            name: change.beforeName!, parentId: change.beforeParentId!, writer: OWNER_WRITER, replace: false, ifSeq,
          });
          return { undone: true };
        case 'NEW_FOLDER': {
          const removed = await this.drive.removeEmptyFolder(ownerId, entry.id, ifSeq);
          // Removed outright, or, holding items in Trash, moved to Trash with them.
          if (removed === 'NOT_EMPTY') return skip(`${name} is not empty any more, so it was kept.`);
          return removed === 'CHANGED' ? changedSince() : { undone: true };
        }
        case 'NEW_FILE':
          await this.drive.moveToTrash(ownerId, entry.id, { writer: OWNER_WRITER, ifSeq });
          return { undone: true };
        case 'EDIT': {
          if (!change.replacedVersionId) return skip(`${name} was added to in place, so there is no earlier version to go back to.`);
          const version = await this.prisma.driveVersion.findFirst({
            where: { id: change.replacedVersionId, ownerId, entryId: entry.id }, select: { replacedAt: true },
          });
          if (!version?.replacedAt) return skip(`The earlier version of ${name} is gone, so it was left as it is.`);
          if (entry.currentVersionId !== change.versionId) return changedSince();
          await this.drive.restoreVersion(ownerId, change.replacedVersionId, 'CURRENT', OWNER_WRITER, { ifSeq });
          return { undone: true };
        }
        default:
          return skip(`${name} was left as it is.`);
      }
    } catch (error) {
      if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
      const code = codeOf(error);
      if (code === DRIVE_CHANGED_SINCE) return changedSince();
      if (code === DRIVE_NAME_TAKEN) {
        const where = change.beforeParentId ? await this.pathOrNull(ownerId, change.beforeParentId) : null;
        return skip(`${name} could not go back${where ? ` to ${where}` : ''}: something named ${quoted(change.beforeName ?? '')} is there now.`);
      }
      if (code === DRIVE_PARENT_GONE) return skip(`${name} could not go back: the folder it was in is gone or in Trash.`);
      return skip(`${name} was left as it is: ${readableMessage(error).replace(/\.$/u, '')}.`);
    }
  }

  /** One held write made as the owner, recorded into the group by its writer. */
  private async applyOne(ownerId: string, held: HeldRow, writer: DriveWriter): Promise<void> {
    const op = held.op as unknown as DriveChatHeldOp;
    if (op.op === 'MKDIR') {
      await this.drive.mkdirPath(ownerId, op.path, { parents: op.parents, writer });
      return;
    }
    if (op.op === 'TRASH') {
      await this.drive.moveToTrash(ownerId, op.entryId, { writer });
      return;
    }
    const segments = drivePathSegments(op.to);
    if (!segments.length) throw refusal(HttpStatus.CONFLICT, 'DRIVE_ROOT', 'The root folder cannot be named here.');
    const folder = await this.drive.liveAt(ownerId, parentPathOf(op.to));
    await this.drive.rename(ownerId, op.entryId, { name: segments[segments.length - 1], parentId: folder.id, writer, replace: false });
  }

  /** The owner's answer made: the incoming file moved under a free numbered name, or onto the file there. */
  private async answerOne(ownerId: string, question: QuestionRow, choice: 'KEEP_BOTH' | 'REPLACE') {
    const source = await this.prisma.driveEntry.findFirst({ where: { id: question.sourceEntryId, ownerId } });
    if (!source || source.trashedAt) {
      throw refusal(HttpStatus.CONFLICT, 'DRIVE_ENTRY_NOT_FOUND', 'the file being moved is gone or in Trash now.');
    }
    let view;
    if (choice === 'REPLACE') {
      view = await this.drive.rename(ownerId, source.id, {
        name: question.destName, parentId: question.destParentId, writer: OWNER_WRITER, replace: true,
      });
    } else {
      for (let attempt = 1; ; attempt += 1) {
        const name = await this.freeName(ownerId, question.destParentId, question.destName);
        try {
          view = await this.drive.rename(ownerId, source.id, { name, parentId: question.destParentId, writer: OWNER_WRITER, replace: false });
          break;
        } catch (error) {
          // Another write took the name between the look and the move: look again.
          if (codeOf(error) !== DRIVE_NAME_TAKEN || attempt >= 5) throw error;
        }
      }
    }
    const moved = await this.drive.liveById(ownerId, view.id);
    return { entryId: moved.id, path: (await this.drive.stat(ownerId, moved)).path, name: moved.name };
  }

  /** `name` with the first free number in the folder: `lease-2026 (2).pdf`. */
  private async freeName(ownerId: string, parentId: string, name: string): Promise<string> {
    for (let n = 2; ; n += 1) {
      const candidate = suffixedName(name, n, 'FILE');
      const taken = await this.prisma.driveEntry.findFirst({ where: { ownerId, parentId, name: candidate, trashedAt: null }, select: { id: true } });
      if (!taken) return candidate;
    }
  }

  /** What the card shows of a held write, read when it is held. */
  private async heldDisplay(ownerId: string, op: DriveChatHeldOp) {
    if (op.op === 'MKDIR') {
      const path = normalPath(op.path);
      return { kind: 'NEW_FOLDER', entryId: null, name: drivePathSegments(path).at(-1) ?? '', fromPath: null, toPath: path };
    }
    const source = await this.drive.liveById(ownerId, op.entryId);
    const fromPath = (await this.drive.stat(ownerId, source)).path;
    if (op.op === 'TRASH') return { kind: 'TRASH', entryId: source.id, name: source.name, fromPath, toPath: null };
    const toPath = normalPath(op.to);
    return {
      kind: parentPathOf(toPath) === parentPathOf(fromPath) ? 'RENAME' : 'MOVE',
      entryId: source.id, name: source.name, fromPath, toPath,
    };
  }

  /** One side of a question: the file as it is now. */
  private async fileFacts(ownerId: string, entry: DriveEntryRow): Promise<DriveChatQuestionFile> {
    const title = entry.lastWriterSessionId
      ? (await this.prisma.session.findFirst({ where: { id: entry.lastWriterSessionId, ownerId }, select: { title: true } }))?.title ?? null
      : null;
    return {
      entryId: entry.id,
      path: (await this.drive.stat(ownerId, entry)).path,
      sizeBytes: Number(entry.sizeBytes),
      modifiedAt: entry.mtime.toISOString(),
      lastWriter: { kind: entry.lastWriterKind, sessionId: entry.lastWriterSessionId, sessionTitle: title },
    };
  }

  private async pathOrNull(ownerId: string, id: string): Promise<string | null> {
    return (await this.paths(ownerId, [id])).get(id) ?? null;
  }

  /** The paths of folders `ids` from the root, whether or not they are in Trash; one gone is left out. */
  private async paths(ownerId: string, ids: readonly string[]): Promise<Map<string, string>> {
    return drivePathsOf(this.prisma, ownerId, ids);
  }

  private async views(ownerId: string, groups: GroupRow[]): Promise<DriveChatChangeGroup[]> {
    const ids = groups.map((g) => g.id);
    const changes = ids.length ? await this.prisma.driveChatChange.findMany({ where: { groupId: { in: ids } }, orderBy: { ord: 'asc' } }) : [];
    const held = ids.length ? await this.prisma.driveChatHeldChange.findMany({ where: { groupId: { in: ids } }, orderBy: { ord: 'asc' } }) : [];
    const parents = new Set<string>();
    for (const c of changes) {
      if (c.beforeParentId) parents.add(c.beforeParentId);
      if (c.afterParentId) parents.add(c.afterParentId);
    }
    const paths = await this.paths(ownerId, [...parents]);
    return groups.map((group) => {
      const items: DriveChatChangeItem[] = changes.filter((c) => c.groupId === group.id).map((c) => ({
        id: c.id,
        kind: c.kind as DriveChatChangeKind,
        entryId: c.entryId,
        entryKind: c.entryKind,
        before: {
          parentId: c.beforeParentId, parentPath: c.beforeParentId ? paths.get(c.beforeParentId) ?? null : null, name: c.beforeName,
        },
        after: { parentId: c.afterParentId, parentPath: c.afterParentId ? paths.get(c.afterParentId) ?? null : null, name: c.afterName },
        state: c.state as DriveChatChangeItem['state'],
        reason: c.reason,
      }));
      const heldItems: DriveChatHeldItem[] = held.filter((h) => h.groupId === group.id).map((h) => ({
        id: h.id,
        kind: h.kind as DriveChatHeldItem['kind'],
        entryId: h.entryId,
        name: h.name,
        fromPath: h.fromPath,
        toPath: h.toPath,
        state: h.state as DriveChatHeldItem['state'],
        reason: h.reason,
      }));
      // A group waiting for Apply counts what it holds; any other counts what was made.
      const counted: Array<{ kind: string }> = group.status === 'PENDING' || group.status === 'APPLYING'
        ? heldItems.filter((h) => h.state === 'PENDING')
        : items;
      const counts: Partial<Record<DriveChatChangeKind, number>> = {};
      for (const item of counted) counts[item.kind as DriveChatChangeKind] = (counts[item.kind as DriveChatChangeKind] ?? 0) + 1;
      return {
        id: group.id,
        sessionId: group.sessionId,
        turnId: group.turnId,
        status: group.status as DriveChatChangeGroup['status'],
        held: group.held,
        createdAt: group.createdAt.toISOString(),
        appliedAt: group.appliedAt?.toISOString() ?? null,
        undoneAt: group.undoneAt?.toISOString() ?? null,
        counts,
        total: counted.length,
        skipped: items.filter((i) => i.state === 'SKIPPED').length,
        items,
        heldItems,
      };
    });
  }
}

function questionView(row: QuestionRow): DriveChatQuestion {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    status: row.status as DriveChatQuestion['status'],
    choice: row.choice as DriveChatQuestion['choice'],
    moving: row.moving as unknown as DriveChatQuestionFile,
    existing: row.existing as unknown as DriveChatQuestionFile,
    destination: { parentId: row.destParentId, name: row.destName },
    outcome: row.outcome as unknown as DriveChatQuestion['outcome'],
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
  };
}

function refuseActingSession(actingSessionId: string | null): void {
  if (!actingSessionId) return;
  throw new ForbiddenException({
    code: 'DRIVE_CHAT_OWNER_CHANNEL_ONLY',
    message: "A Drive chat's changes and questions are the account owner's, through an owner channel with no acting session: "
      + 'a session neither reads, undoes, applies nor answers them.',
  });
}
