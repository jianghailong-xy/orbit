import { HttpException, HttpStatus, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { classifyTransactionFault, loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { DRIVE_CHUNK_MAX } from './drive-chunks.service';
import { driveChatTurnOf, followDriveChatChange, recordDriveChatChange } from './drive-chat-change-record';

/**
 * The drive's name layer (docs/drive-technical-design.md §1, §3, §5.4): folders and files over the chunk
 * store, versions, Trash and the change feed. Every rule here holds whichever door a write came through: the owner's
 * routes (drive.controller.ts), and the runner drive door and the mount daemon, which belong to their own tasks.
 *
 *   - An overwrite makes a version and puts the previous one in Trash, in a VERSION group of its own; an append grows the
 *     current version in place and makes none (§3.2).
 *   - A delete moves an entry, and everything under a folder, to Trash in one DELETE group; deletes carrying the same burst
 *     key within 10 s join one group, so an `rm -rf` through the mount is one group (§3.3, §3.4). A folder is hidden by
 *     the first transaction and what is under it is marked a batch per transaction, so no folder is too big to delete.
 *   - A group restores whole, under the owner's lock, a batch per transaction, recreating missing folders, and a name a
 *     live entry took meanwhile gets the first free `name (n).ext` (§3.5).
 *   - Folder trash, folder move, restore and delete for good take a per-account advisory lock; a write into a folder holds
 *     that folder FOR SHARE and re-checks it is live (§1.4). Every transaction is bounded: 10 s a statement, 20 s in all;
 *     one cut off by a bound answers 503 DRIVE_LIMIT_HIT, not a bare 500.
 *   - Every change writes one drive_change row and moves the entry's `seq`; the feed re-reads 60 s back so a row whose
 *     transaction committed late is never skipped (§5.4). Each committed change is announced as `drive.changed`.
 *   - A Drive chat's change is recorded, in the same transaction, into its turn's change group, which one Undo reverses;
 *     a Drive chat never replaces a file by a rename (drive-chat-change-record.ts, drive-chat-changes.ts).
 *
 * The owner is always the caller's, from its credential; another account's entry, version or group is not found.
 */

/** The advisory-lock namespace of the per-account folder lock (§1.4), and of a burst key's group (§3.4). */
const DRIVE_LOCK_NAMESPACE = 4001327;
const DRIVE_BURST_LOCK_NAMESPACE = 4001328;
/** A delete with the same burst key joins the open group it was last added to less than this long ago (§3.4). */
export const DRIVE_BURST_WINDOW_MS = 10_000;
/** How far back each feed poll re-reads, before the previous poll began (§5.4). */
export const DRIVE_FEED_LOOK_BACK_MS = 60_000;
/** How long change rows and commit answers are kept; the retention sweep's step 0 prunes older ones. */
export const DRIVE_FEED_KEEP_MS = 24 * 60 * 60 * 1000;
const PAGE_MAX = 1000;
const PAGE_DEFAULT = 200;
const FEED_PAGE = 1000;
const TRANSACTION = { timeout: 20_000, maxWait: 5_000 };
/** How many entries a Trash batch moves, restores or permanently deletes at most (§1.4, §3.3, §3.5). */
export const DRIVE_TRASH_BATCH = 1000;
/** How many top-level items whose folder is not live one restore transaction makes a place for (liveDestination). */
const ORPHAN_BATCH = 100;
/** A group still marking that has not been added to for this long is taken up by the drive's timer (finishStoppedTrash). */
export const STOPPED_MARKING_MS = 10 * 60 * 1000;
const STOPPED_MARKING_SWEEP_MS = 10 * 60 * 1000;

export const DRIVE_ENTRY_NOT_FOUND = 'DRIVE_ENTRY_NOT_FOUND';
export const DRIVE_PARENT_GONE = 'DRIVE_PARENT_GONE';
export const DRIVE_NOT_A_FOLDER = 'DRIVE_NOT_A_FOLDER';
export const DRIVE_NOT_A_FILE = 'DRIVE_NOT_A_FILE';
export const DRIVE_NAME_INVALID = 'DRIVE_NAME_INVALID';
export const DRIVE_NAME_TAKEN = 'DRIVE_NAME_TAKEN';
export const DRIVE_MOVE_INTO_ITSELF = 'DRIVE_MOVE_INTO_ITSELF';
export const DRIVE_ROOT = 'DRIVE_ROOT';
export const DRIVE_IN_TRASH = 'DRIVE_IN_TRASH';
export const DRIVE_COMMIT_INVALID = 'DRIVE_COMMIT_INVALID';
export const DRIVE_CHUNK_NOT_HELD = 'DRIVE_CHUNK_NOT_HELD';
export const DRIVE_TAIL_MOVED = 'DRIVE_TAIL_MOVED';
export const DRIVE_BASE_GONE = 'DRIVE_BASE_GONE';
export const DRIVE_VERSION_NOT_FOUND = 'DRIVE_VERSION_NOT_FOUND';
export const DRIVE_VERSION_CURRENT = 'DRIVE_VERSION_CURRENT';
export const DRIVE_TRASH_GROUP_NOT_FOUND = 'DRIVE_TRASH_GROUP_NOT_FOUND';
export const DRIVE_CURSOR_INVALID = 'DRIVE_CURSOR_INVALID';
export const DRIVE_LIMIT_HIT = 'DRIVE_LIMIT_HIT';
/** A write that names the state it expects (`ifSeq`) found the entry changed since. */
export const DRIVE_CHANGED_SINCE = 'DRIVE_CHANGED_SINCE';

type Tx = Prisma.TransactionClient;
export type DriveEntryRow = EntryRow;
type EntryRow = NonNullable<Awaited<ReturnType<Tx['driveEntry']['findFirst']>>>;
type VersionRow = NonNullable<Awaited<ReturnType<Tx['driveVersion']['findFirst']>>>;
type GroupRow = NonNullable<Awaited<ReturnType<Tx['driveTrashGroup']['findFirst']>>>;
type ChangeRecord = NonNullable<Awaited<ReturnType<Tx['driveChange']['findFirst']>>>;

/** Who made a change (§3.6). An agent's session is kept only when it is the owner's and runs on the runner it came through. */
export interface DriveWriter {
  kind: 'OWNER' | 'AGENT';
  sessionId?: string | null;
  runnerId?: string | null;
  /** The owner's Apply of a Drive chat's held changes: what it makes is recorded into this change group. */
  changeGroupId?: string | null;
}
export const OWNER_WRITER: DriveWriter = { kind: 'OWNER' };

/** What a name clash does: an owner's new folder gets a suffix (board choice d); a door's create is refused. */
export type DriveOnClash = 'SUFFIX' | 'REFUSE';

export interface DriveChunkRef {
  idx: number;
  sha256: string;
  size: number;
}

export interface DriveCommitInput {
  /** The writer's own key, kept across its retries: a retried commit is answered as the first and never applied twice. */
  commitId: string;
  entryId: string;
  handleId?: string | null;
  mode: 'OVERWRITE' | 'APPEND' | 'CONTINUE';
  baseVersionId?: string | null;
  baseSize?: number | null;
  /** OVERWRITE and CONTINUE: the whole chunk list from 0. APPEND: the new tail, from the replaced tail's index or the end. */
  chunks: DriveChunkRef[];
  replaceTail?: { idx: number; oldSha256: string } | null;
  /** The staging whose chunk rows this commit takes; they are deleted, the version's rows holding the bytes now. */
  stagingId?: string | null;
  writer: DriveWriter;
}

export interface DriveCommitResult {
  entryId: string;
  versionId: string;
  /** False for an append, and for a handle continuing the version it is writing. */
  newVersion: boolean;
  replacedVersionId: string | null;
  trashGroupId: string | null;
  sizeBytes: number;
  seq: number;
  /** Absent on receipts saved before commits returned the entry's mtime. */
  mtime?: string;
}

export interface DriveEntryView {
  id: string;
  parentId: string | null;
  kind: string;
  name: string;
  sizeBytes: number;
  mtime: Date;
  currentVersionId: string | null;
  seq: number;
  createdAt: Date;
  updatedAt: Date;
  lastWriter: { kind: string; sessionId: string | null; runnerId: string | null; at: Date };
  trashedAt: Date | null;
  trashGroupId: string | null;
}

function refusal(status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}): HttpException {
  return new HttpException({ code, message, ...extra }, status);
}
const notFound = () => refusal(HttpStatus.NOT_FOUND, DRIVE_ENTRY_NOT_FOUND, 'No such file or folder.');
const parentGone = () => refusal(HttpStatus.NOT_FOUND, DRIVE_PARENT_GONE, 'The folder is gone or in Trash.');
const nameTaken = (name: string) => refusal(HttpStatus.CONFLICT, DRIVE_NAME_TAKEN, `"${name}" is already taken in that folder.`);
const changedSince = () => refusal(HttpStatus.CONFLICT, DRIVE_CHANGED_SINCE, 'The file or folder changed since.');

/**
 * A drive transaction cut off by a bound of §1.4 (a statement past 10 s, the transaction past 20 s), or turned away by the
 * database, answered 503 DRIVE_LIMIT_HIT rather than a bare 500. What committed before it stays, and a Trash request
 * sent again carries on from there.
 */
function limitHit(error: unknown): never {
  if (!(error instanceof HttpException) && classifyTransactionFault(error).family === 'RESOURCE') {
    throw new HttpException(
      { statusCode: 503, code: DRIVE_LIMIT_HIT, message: 'The drive could not finish this in time. What was done is kept; try again.', retryable: true },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  throw error;
}

/** A version 7 UUID, as the schema's own ids are, for rows written with an id chosen first. */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const now = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((now >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A UTF-16 surrogate with no partner: a string that is not valid UTF-8 once encoded. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A name the drive keeps (§1.1): valid UTF-8 of 1-255 bytes, no '/', no NUL, not '.' or '..'. Kept exactly, never normalised. */
export function assertDriveName(name: unknown): string {
  if (
    typeof name !== 'string'
    || name.length === 0
    || Buffer.byteLength(name, 'utf8') > 255
    || name.includes('/')
    || name.includes('\0')
    || name === '.'
    || name === '..'
    || LONE_SURROGATE.test(name)
  ) {
    throw refusal(
      HttpStatus.BAD_REQUEST,
      DRIVE_NAME_INVALID,
      "A name is 1 to 255 bytes of UTF-8, with no '/' and no NUL, and is not '.' or '..'.",
    );
  }
  return name;
}

/**
 * The `n`th name for `name` when it is taken (§3.5): `report (2).pdf`, `report (3).pdf`; a folder, or a name with no
 * extension, gets the suffix at the end. Trimmed so it stays within 255 bytes.
 */
export function suffixedName(name: string, n: number, kind: string): string {
  const dot = name.lastIndexOf('.');
  const split = kind === 'FILE' && dot > 0;
  let stem = split ? name.slice(0, dot) : name;
  const ext = split ? name.slice(dot) : '';
  const suffix = ` (${n})`;
  while (stem.length > 1 && Buffer.byteLength(stem + suffix + ext, 'utf8') > 255) stem = [...stem].slice(0, -1).join('');
  return `${stem}${suffix}${ext}`;
}

const num = (value: bigint | number) => Number(value);

/**
 * A drive path's names, from the root: `/Proj/r.md` and `Proj/r.md` alike; empty for the root. Each must be a name the
 * drive keeps, so `.` and `..` are refused rather than walked.
 */
export function drivePathSegments(path: unknown): string[] {
  if (typeof path !== 'string') throw refusal(HttpStatus.BAD_REQUEST, DRIVE_NAME_INVALID, 'A drive path is a string.');
  return path.split('/').filter((s) => s !== '').map(assertDriveName);
}

function entryView(e: EntryRow): DriveEntryView {
  return {
    id: e.id,
    parentId: e.parentId,
    kind: e.kind,
    name: e.name,
    sizeBytes: num(e.sizeBytes),
    mtime: e.mtime,
    currentVersionId: e.currentVersionId,
    seq: num(e.seq),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    lastWriter: { kind: e.lastWriterKind, sessionId: e.lastWriterSessionId, runnerId: e.lastWriterRunnerId, at: e.lastWrittenAt },
    trashedAt: e.trashedAt,
    trashGroupId: e.trashGroupId,
  };
}

function versionView(v: VersionRow, currentId: string | null) {
  return {
    id: v.id,
    entryId: v.entryId,
    sizeBytes: num(v.sizeBytes),
    chunkCount: v.chunkCount,
    createdAt: v.createdAt,
    current: v.id === currentId,
    writer: { kind: v.writerKind, sessionId: v.writerSessionId, runnerId: v.writerRunnerId },
    replacedAt: v.replacedAt,
    trashGroupId: v.trashGroupId,
  };
}

const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor<T>(cursor: string | undefined, valid: (v: unknown) => v is T): T | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (valid(value)) return value;
  } catch {
    // Falls through to the refusal.
  }
  throw refusal(HttpStatus.BAD_REQUEST, DRIVE_CURSOR_INVALID, 'That cursor is not one this list answered.');
}
const pageSize = (limit?: number) =>
  Math.min(PAGE_MAX, Math.max(1, Number.isFinite(limit) && limit ? Math.floor(limit) : PAGE_DEFAULT));

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

@Injectable()
export class DriveService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DriveService.name);
  private finisher?: ReturnType<typeof setInterval>;
  private finishing?: Promise<unknown>;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  /** The timer that finishes a folder's trash left part-way (finishStoppedTrash). Racing a live marking is safe: both mark under the account's lock. */
  onApplicationBootstrap(): void {
    this.finisher = setInterval(() => {
      if (this.finishing) return;
      this.finishing = this.finishStoppedTrash()
        .catch((error) => this.logger.error(`finishing a folder trash left part-way failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.finishing = undefined;
        });
    }, STOPPED_MARKING_SWEEP_MS);
    this.finisher.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.finisher);
    await this.finishing;
  }

  /** `drive.changed` after a commit: an accelerant, which a client may miss and reads the feed for anyway. */
  private announce(ownerId: string, seq: number | null): void {
    if (seq !== null && seq > 0) this.realtime?.publishDriveChanged(ownerId, seq);
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────

  /** The account's root folder, made by the first drive call that needs it. */
  async ensureRoot(ownerId: string): Promise<EntryRow> {
    const found = await this.prisma.driveEntry.findFirst({ where: { ownerId, parentId: null } });
    if (found) return found;
    return withTransactionRetry(this.prisma, async (tx) => {
      await bound(tx);
      return rootIn(tx, ownerId);
    }, loggedRetry(this.logger, 'drive.ensureRoot', { transaction: TRANSACTION }));
  }

  /** Children of a live folder (the root when none is named), live ones only, paged by name. */
  async list(ownerId: string, options: { parentId?: string; cursor?: string; limit?: number } = {}) {
    const folder = options.parentId
      ? await this.prisma.driveEntry.findFirst({ where: { id: options.parentId, ownerId, trashedAt: null } })
      : await this.ensureRoot(ownerId);
    if (!folder) throw notFound();
    if (folder.kind !== 'FOLDER') throw refusal(HttpStatus.CONFLICT, DRIVE_NOT_A_FOLDER, 'That is a file, not a folder.');
    const after = decodeCursor(options.cursor, (v): v is { name: string } => typeof (v as { name?: unknown })?.name === 'string');
    const take = pageSize(options.limit);
    const rows = await this.prisma.driveEntry.findMany({
      where: { ownerId, parentId: folder.id, trashedAt: null, ...(after ? { name: { gt: after.name } } : {}) },
      orderBy: { name: 'asc' },
      take: take + 1,
    });
    const page = rows.slice(0, take);
    return {
      folder: entryView(folder),
      entries: page.map(entryView),
      nextCursor: rows.length > take ? encodeCursor({ name: page[page.length - 1].name }) : null,
    };
  }

  /**
   * Live entries (the root excepted) whose name contains `q`, case-insensitively, anywhere in the account's drive, by
   * name. Each carries its own path and its folder's path. Trash is never searched.
   */
  async search(ownerId: string, options: { q?: string; cursor?: string; limit?: number } = {}) {
    const q = (options.q ?? '').trim();
    if (q === '') return { entries: [], nextCursor: null };
    const after = decodeCursor(
      options.cursor,
      (v): v is { name: string; id: string } =>
        typeof (v as { name?: unknown })?.name === 'string' && typeof (v as { id?: unknown })?.id === 'string',
    );
    const take = pageSize(options.limit);
    const rows = await this.prisma.driveEntry.findMany({
      where: {
        ownerId,
        trashedAt: null,
        parentId: { not: null },
        name: { contains: q.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' },
        ...(after ? { OR: [{ name: { gt: after.name } }, { name: after.name, id: { gt: after.id } }] } : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: take + 1,
    });
    const page = rows.slice(0, take);
    const entries = await Promise.all(
      page.map(async (e) => {
        const path = await pathOf(this.prisma, ownerId, e.id);
        return { ...entryView(e), path, folderPath: path.slice(0, path.lastIndexOf('/')) || '/' };
      }),
    );
    const last = page[page.length - 1];
    return { entries, nextCursor: rows.length > take ? encodeCursor({ name: last.name, id: last.id }) : null };
  }

  /** One entry of the account's, live or in Trash, with its path. */
  async get(ownerId: string, id: string) {
    const entry = await this.prisma.driveEntry.findFirst({ where: { id, ownerId } });
    if (!entry) throw notFound();
    return { ...entryView(entry), path: await pathOf(this.prisma, ownerId, entry.id) };
  }

  /** A path to its live entry, one segment at a time over live entries; nothing in Trash is reached by a path (§3.3). */
  async resolve(ownerId: string, path: string) {
    let current = await this.ensureRoot(ownerId);
    for (const segment of String(path ?? '').split('/').filter((s) => s !== '')) {
      if (current.kind !== 'FOLDER') throw notFound();
      const next = await this.prisma.driveEntry.findFirst({
        where: { ownerId, parentId: current.id, name: segment, trashedAt: null },
      });
      if (!next) throw notFound();
      current = next;
    }
    return { ...entryView(current), path: await pathOf(this.prisma, ownerId, current.id) };
  }

  /** The current version of a live file of the account's — what a share link pins — or the entry's own refusal. */
  async shareableVersion(ownerId: string, entryId: string): Promise<{ id: string; sizeBytes: number }> {
    const entry = await this.prisma.driveEntry.findFirst({ where: { id: entryId, ownerId, trashedAt: null } });
    if (!entry) throw notFound();
    if (entry.kind !== 'FILE' || !entry.currentVersionId) throw refusal(HttpStatus.CONFLICT, DRIVE_NOT_A_FILE, 'Only a file can be shared.');
    return { id: entry.currentVersionId, sizeBytes: Number(entry.sizeBytes) };
  }

  /** A file's current and replaced versions, newest first. */
  async versions(ownerId: string, entryId: string) {
    const entry = await this.prisma.driveEntry.findFirst({ where: { id: entryId, ownerId } });
    if (!entry) throw notFound();
    if (entry.kind !== 'FILE') throw refusal(HttpStatus.CONFLICT, DRIVE_NOT_A_FILE, 'A folder has no versions.');
    const rows = await this.prisma.driveVersion.findMany({
      where: { ownerId, entryId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { entry: entryView(entry), versions: rows.map((v) => versionView(v, entry.currentVersionId)) };
  }

  /**
   * Trash, newest group first: each group with what it holds at its top (a deletion's top-level items, or the replaced
   * version and its file). The owner's door only: the runner door has no Trash route, so no agent lists it (D11).
   */
  async trash(ownerId: string, options: { cursor?: string; limit?: number } = {}) {
    const after = decodeCursor(
      options.cursor,
      (v): v is { at: string; id: string } => typeof (v as { at?: unknown })?.at === 'string' && typeof (v as { id?: unknown })?.id === 'string',
    );
    const take = pageSize(options.limit);
    const groups = await this.prisma.driveTrashGroup.findMany({
      where: {
        ownerId,
        ...(after ? { OR: [{ createdAt: { lt: new Date(after.at) } }, { createdAt: new Date(after.at), id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      include: {
        entries: { where: { trashTop: true }, orderBy: { name: 'asc' }, take: 20 },
        versions: { include: { entry: true }, take: 1 },
      },
    });
    const page = groups.slice(0, take);
    return {
      groups: page.map((g) => this.groupView(g, g.entries, g.versions)),
      nextCursor: groups.length > take
        ? encodeCursor({ at: page[page.length - 1].createdAt.toISOString(), id: page[page.length - 1].id })
        : null,
    };
  }

  /** One Trash group: its top-level items, or the children of one of its folders, paged by name. */
  async trashGroup(ownerId: string, groupId: string, options: { parentId?: string; cursor?: string; limit?: number } = {}) {
    const group = await this.prisma.driveTrashGroup.findFirst({
      where: { id: groupId, ownerId },
      include: { versions: { include: { entry: true }, take: 1 } },
    });
    if (!group) throw refusal(HttpStatus.NOT_FOUND, DRIVE_TRASH_GROUP_NOT_FOUND, 'No such group in Trash.');
    const after = decodeCursor(options.cursor, (v): v is { name: string } => typeof (v as { name?: unknown })?.name === 'string');
    const take = pageSize(options.limit);
    const rows = await this.prisma.driveEntry.findMany({
      where: {
        ownerId,
        trashGroupId: group.id,
        ...(options.parentId ? { parentId: options.parentId } : { trashTop: true }),
        ...(after ? { name: { gt: after.name } } : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: take + 1,
    });
    const page = rows.slice(0, take);
    return {
      group: this.groupView(group, [], group.versions),
      entries: page.map(entryView),
      nextCursor: rows.length > take ? encodeCursor({ name: page[page.length - 1].name }) : null,
    };
  }

  private groupView(
    g: GroupRow,
    tops: EntryRow[],
    versions: Array<VersionRow & { entry: EntryRow }>,
  ) {
    return {
      id: g.id,
      kind: g.kind,
      folderId: g.folderId,
      folderPath: g.folderPath,
      createdAt: g.createdAt,
      itemCount: g.itemCount,
      sizeBytes: num(g.sizeBytes),
      actor: { kind: g.actorKind, sessionId: g.actorSessionId, runnerId: g.actorRunnerId },
      items: tops.map(entryView),
      version: versions[0] ? { ...versionView(versions[0], versions[0].entry.currentVersionId), entry: entryView(versions[0].entry) } : null,
    };
  }

  /**
   * The change feed (§5.4). `since` is the cursor the previous poll answered (`<seq>:<ms>`, the ms when that poll began),
   * or a bare seq. Besides every row after that seq, it answers every row inserted within the 60 s before that poll began,
   * so a row whose transaction committed after a higher seq was read is still delivered; the reader drops what it has
   * applied. A cursor older than the kept feed, or past the feed's end (the database was restored), answers `resync`.
   */
  async changes(ownerId: string, since?: string) {
    const clock = await this.prisma.$queryRaw<Array<{ now: Date; last: bigint }>>`
      SELECT clock_timestamp() AS "now", (SELECT last_value FROM "drive_change_seq_seq") AS "last"`;
    const startedAt = clock[0].now.getTime();
    const last = num(clock[0].last);
    const cursorOf = (seq: number) => `${seq}:${startedAt}`;
    if (since === undefined || since === '') return { changes: [], cursor: cursorOf(last), more: false, resync: false };
    const parsed = /^(\d+)(?::(\d+))?$/.exec(since);
    if (!parsed) throw refusal(HttpStatus.BAD_REQUEST, DRIVE_CURSOR_INVALID, 'That cursor is not one the feed answered.');
    const seq = Number(parsed[1]);
    const polledAt = parsed[2] === undefined ? startedAt : Number(parsed[2]);
    if (seq > last || polledAt < startedAt - DRIVE_FEED_KEEP_MS + DRIVE_FEED_LOOK_BACK_MS) {
      return { changes: [], cursor: cursorOf(last), more: false, resync: true };
    }
    const lookFrom = new Date(polledAt - DRIVE_FEED_LOOK_BACK_MS);
    const [after, back] = await Promise.all([
      this.prisma.driveChange.findMany({ where: { ownerId, seq: { gt: BigInt(seq) } }, orderBy: { seq: 'asc' }, take: FEED_PAGE + 1 }),
      this.prisma.driveChange.findMany({
        where: { ownerId, seq: { lte: BigInt(seq) }, at: { gte: lookFrom } },
        orderBy: { seq: 'asc' },
        take: FEED_PAGE * 5,
      }),
    ]);
    const more = after.length > FEED_PAGE;
    const forward = after.slice(0, FEED_PAGE);
    const view = (c: ChangeRecord) => ({
      seq: num(c.seq), entryId: c.entryId, parentId: c.parentId, op: c.op, at: c.at,
    });
    return {
      changes: [...back, ...forward].map(view),
      cursor: cursorOf(forward.length ? num(forward[forward.length - 1].seq) : seq),
      more,
      resync: false,
    };
  }

  // ── what the runner drive door reads (§4.2) ───────────────────────────────────────────────────

  /** The live entry at `path`, walked one segment at a time; nothing in Trash is reached (§3.3). */
  async liveAt(ownerId: string, path: string): Promise<EntryRow> {
    let current = await this.ensureRoot(ownerId);
    for (const segment of drivePathSegments(path)) {
      if (current.kind !== 'FOLDER') throw notFound();
      const next = await this.prisma.driveEntry.findFirst({
        where: { ownerId, parentId: current.id, name: segment, trashedAt: null },
      });
      if (!next) throw notFound();
      current = next;
    }
    return current;
  }

  /** A live entry by its id: one in Trash is not found, as no agent sees Trash (D11). */
  async liveById(ownerId: string, id: string): Promise<EntryRow> {
    const entry = await this.prisma.driveEntry.findFirst({ where: { id, ownerId, trashedAt: null } });
    if (!entry) throw notFound();
    return entry;
  }

  /** One live entry with its path, as the door answers it. */
  async stat(ownerId: string, entry: EntryRow) {
    return { ...entryView(entry), path: await pathOf(this.prisma, ownerId, entry.id) };
  }

  /**
   * A live folder's children with their attributes, paged (§4.2, §5.4); a file of one chunk carries that chunk's sha256,
   * so a reader of small files needs no manifest call.
   */
  async listWithChunks(ownerId: string, folder: EntryRow, options: { cursor?: string; limit?: number } = {}) {
    const page = await this.list(ownerId, { parentId: folder.id, cursor: options.cursor, limit: options.limit });
    const single = await this.prisma.driveVersion.findMany({
      where: {
        ownerId,
        chunkCount: 1,
        id: { in: page.entries.map((e) => e.currentVersionId).filter((v): v is string => v !== null) },
      },
      select: { id: true, chunks: { select: { sha256: true }, take: 1 } },
    });
    const sha = new Map(single.map((v) => [v.id, v.chunks[0]?.sha256 ?? null]));
    const folderPath = await pathOf(this.prisma, ownerId, folder.id);
    const pathIn = (name: string) => (folderPath === '/' ? `/${name}` : `${folderPath}/${name}`);
    return {
      ...page,
      folder: { ...page.folder, path: folderPath },
      entries: page.entries.map((e) => ({
        ...e,
        path: pathIn(e.name),
        sha256: e.currentVersionId ? sha.get(e.currentVersionId) ?? null : null,
      })),
    };
  }

  /** A live file's current version: its chunk list, each chunk with its offset (§4.2). */
  async manifest(ownerId: string, entry: EntryRow) {
    if (entry.kind !== 'FILE') throw refusal(HttpStatus.CONFLICT, DRIVE_NOT_A_FILE, 'A folder has no content.');
    const version = await this.prisma.driveVersion.findFirstOrThrow({
      where: { id: entry.currentVersionId!, ownerId },
      include: { chunks: { orderBy: { idx: 'asc' } } },
    });
    return {
      entryId: entry.id,
      versionId: version.id,
      sizeBytes: num(version.sizeBytes),
      seq: num(entry.seq),
      chunks: version.chunks.map((c) => ({ idx: c.idx, offset: num(c.offset), size: c.sizeBytes, sha256: c.sha256 })),
    };
  }

  /**
   * Whether `ownerId` may read the chunk `sha256`: only one its own versions or stagings name (§4.4). Content addressing
   * is not authorisation, so another account's chunk is not found however its sha256 was learnt.
   */
  async namesChunk(ownerId: string, sha256: string): Promise<boolean> {
    const [version, staging] = await Promise.all([
      this.prisma.driveVersionChunk.findFirst({ where: { ownerId, sha256 }, select: { sha256: true } }),
      this.prisma.driveStagingChunk.findFirst({ where: { ownerId, sha256 }, select: { sha256: true } }),
    ]);
    return Boolean(version ?? staging);
  }

  /** The bytes of the account's live files, their current versions: what the mount's `df` shows as used (§5.6). */
  async usage(ownerId: string): Promise<{ driveBytes: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ bytes: bigint | null }>>`
      SELECT coalesce(sum("size_bytes"), 0) AS "bytes" FROM "drive_entry"
       WHERE "owner_id" = ${ownerId}::uuid AND "kind" = 'FILE' AND "trashed_at" IS NULL`;
    return { driveBytes: num(rows[0]?.bytes ?? 0n) };
  }

  /** The answer a commit got, by the writer's own commit id within its owner (§5.7): whether it applied. */
  async commitStatus(ownerId: string, commitId: string) {
    const answered = await this.prisma.driveCommit.findUnique({ where: { ownerId_commitId: { ownerId, commitId } } });
    return answered ? { applied: true, result: answered.result as unknown as DriveCommitResult } : { applied: false, result: null };
  }

  /**
   * `mkdir` by path: the folder at `path`, made in its live parent. With `parents`, every missing folder on the way is
   * made and a folder already there is answered (`mkdir -p`); without, a taken name is refused 409 DRIVE_NAME_TAKEN.
   */
  async mkdirPath(ownerId: string, path: string, options: { parents?: boolean; writer?: DriveWriter } = {}): Promise<DriveEntryView> {
    const segments = drivePathSegments(path);
    if (!segments.length) {
      if (options.parents) return entryView(await this.ensureRoot(ownerId));
      throw refusal(HttpStatus.CONFLICT, DRIVE_ROOT, 'The root folder is already there.');
    }
    let folder = await this.ensureRoot(ownerId);
    for (const [index, segment] of segments.entries()) {
      const last = index === segments.length - 1;
      const found = await this.prisma.driveEntry.findFirst({ where: { ownerId, parentId: folder.id, name: segment, trashedAt: null } });
      if (found) {
        if (found.kind !== 'FOLDER') throw refusal(HttpStatus.CONFLICT, DRIVE_NOT_A_FOLDER, `"${segment}" is a file, not a folder.`);
        if (last && !options.parents) throw nameTaken(segment);
        folder = found;
        continue;
      }
      if (!last && !options.parents) throw parentGone();
      let made: DriveEntryView;
      try {
        made = await this.createFolder(ownerId, { parentId: folder.id, name: segment, writer: options.writer, onClash: 'REFUSE' });
      } catch (error) {
        // Another writer made it meanwhile: with parents, theirs is used.
        if (!(options.parents && error instanceof HttpException && error.getStatus() === HttpStatus.CONFLICT)) throw error;
        const raced = await this.prisma.driveEntry.findFirst({ where: { ownerId, parentId: folder.id, name: segment, trashedAt: null } });
        if (!raced || raced.kind !== 'FOLDER') throw error;
        folder = raced;
        continue;
      }
      folder = await this.prisma.driveEntry.findUniqueOrThrow({ where: { id: made.id } });
    }
    return entryView(folder);
  }

  /** `utimens` (§5.6): a live entry's mtime, as `touch -d`, `cp -p` and `tar x` set it. */
  async setMtime(ownerId: string, id: string, mtime: Date, writer: DriveWriter = OWNER_WRITER): Promise<DriveEntryView> {
    if (Number.isNaN(mtime.getTime())) throw refusal(HttpStatus.BAD_REQUEST, DRIVE_COMMIT_INVALID, 'mtime is not a time.');
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      await bound(tx);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "drive_entry"
         WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid AND "trashed_at" IS NULL FOR UPDATE`;
      if (!locked.length) throw notFound();
      const checked = await checkedWriter(tx, ownerId, writer);
      const now = new Date();
      const updated = await tx.driveEntry.update({
        where: { id },
        data: { mtime, updatedAt: now, ...lastWriterFields(checked, now) },
      });
      const seq = await recordChanges(tx, ownerId, [{ entryId: id, parentId: updated.parentId, op: 'UPSERT' }]);
      await followDriveChatChange(tx, ownerId, checked, id, { seq });
      return { entry: { ...updated, seq: BigInt(seq) }, seq };
    }, loggedRetry(this.logger, 'drive.setMtime', { transaction: TRANSACTION }));
    this.announce(ownerId, outcome.seq);
    return entryView(outcome.entry);
  }

  // ── writes ───────────────────────────────────────────────────────────────────────────────────

  /** A new folder in a live folder (the root when none is named). An owner's clashing name gets a suffix (§3.5). */
  async createFolder(
    ownerId: string,
    input: { parentId?: string | null; name: string; writer?: DriveWriter; onClash?: DriveOnClash },
  ): Promise<DriveEntryView> {
    const name = assertDriveName(input.name);
    const onClash = input.onClash ?? 'SUFFIX';
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { entry, seq } = await withTransactionRetry(this.prisma, async (tx) => {
          await bound(tx);
          const parent = input.parentId ? await lockLiveFolder(tx, ownerId, input.parentId) : await rootIn(tx, ownerId);
          const writer = await checkedWriter(tx, ownerId, input.writer ?? OWNER_WRITER);
          const free = await freeName(tx, ownerId, parent.id, name, 'FOLDER', onClash);
          const now = new Date();
          const created = await tx.driveEntry.create({
            data: {
              id: uuidv7(), ownerId, parentId: parent.id, kind: 'FOLDER', name: free, mtime: now, createdAt: now, updatedAt: now,
              ...lastWriterFields(writer, now),
            },
          });
          const changed = await recordChanges(tx, ownerId, [{ entryId: created.id, parentId: parent.id, op: 'UPSERT' }]);
          await recordDriveChatChange(tx, ownerId, writer, {
            kind: 'NEW_FOLDER', entryId: created.id, entryKind: 'FOLDER', beforeParentId: null, beforeName: null,
            afterParentId: parent.id, afterName: free, afterSeq: changed,
          });
          return { entry: { ...created, seq: BigInt(changed) }, seq: changed };
        }, loggedRetry(this.logger, 'drive.createFolder', { transaction: TRANSACTION }));
        this.announce(ownerId, seq);
        return entryView(entry);
      } catch (error) {
        // Another create took the name between the look and the insert: a suffix looks again, a refusal says so.
        if (!isUniqueViolation(error)) throw error;
        if (onClash === 'REFUSE') throw nameTaken(name);
        if (attempt >= 5) throw error;
      }
    }
  }

  /**
   * The live folder at `segments` below `parentId` (the root when none), each missing folder made: what a dropped folder's
   * files are placed by (§4.1). A folder already there is used, not suffixed; a file of the same name refuses 409.
   */
  async ensureFolderPath(ownerId: string, parentId: string | null, segments: string[]): Promise<EntryRow> {
    let current: EntryRow | null = parentId
      ? await this.prisma.driveEntry.findFirst({ where: { id: parentId, ownerId, kind: 'FOLDER', trashedAt: null } })
      : await this.ensureRoot(ownerId);
    if (!current) throw parentGone();
    for (const raw of segments) {
      const name = assertDriveName(raw);
      const find = () =>
        this.prisma.driveEntry.findFirst({ where: { ownerId, parentId: current!.id, name, kind: 'FOLDER', trashedAt: null } });
      let next = await find();
      if (!next) {
        try {
          const made = await this.createFolder(ownerId, { parentId: current.id, name, onClash: 'REFUSE' });
          next = await this.prisma.driveEntry.findFirst({ where: { id: made.id, ownerId } });
        } catch (error) {
          // A concurrent file of the drop made it first.
          next = await find();
          if (!next) throw error;
        }
      }
      current = next;
      if (!current) throw parentGone();
    }
    return current;
  }

  /**
   * A new file with an empty first version written by `handleId` (§3.1), so the handle's first commit (CONTINUE) fills
   * it. What the mount's `open(O_CREAT)`, a drive tool's `put` of a new path and an upload's completion begin with.
   */
  async createFile(
    ownerId: string,
    input: { parentId?: string | null; name: string; handleId?: string | null; writer?: DriveWriter; onClash?: DriveOnClash },
  ): Promise<DriveEntryView> {
    const name = assertDriveName(input.name);
    const onClash = input.onClash ?? 'REFUSE';
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { entry, seq } = await withTransactionRetry(this.prisma, async (tx) => {
          await bound(tx);
          const parent = input.parentId ? await lockLiveFolder(tx, ownerId, input.parentId) : await rootIn(tx, ownerId);
          const writer = await checkedWriter(tx, ownerId, input.writer ?? OWNER_WRITER);
          const free = await freeName(tx, ownerId, parent.id, name, 'FILE', onClash);
          const now = new Date();
          const entryId = uuidv7();
          const versionId = uuidv7();
          // The entry names its first version before the version exists: that foreign key is checked at commit.
          const created = await tx.driveEntry.create({
            data: {
              id: entryId, ownerId, parentId: parent.id, kind: 'FILE', name: free, currentVersionId: versionId,
              mtime: now, createdAt: now, updatedAt: now, ...lastWriterFields(writer, now),
            },
          });
          await tx.driveVersion.create({
            data: { id: versionId, ownerId, entryId, createdAt: now, handleId: input.handleId ?? null, ...versionWriterFields(writer) },
          });
          const changed = await recordChanges(tx, ownerId, [{ entryId, parentId: parent.id, op: 'UPSERT' }]);
          await recordDriveChatChange(tx, ownerId, writer, {
            kind: 'NEW_FILE', entryId, entryKind: 'FILE', beforeParentId: null, beforeName: null,
            afterParentId: parent.id, afterName: free, afterSeq: changed, versionId,
          });
          return { entry: { ...created, seq: BigInt(changed) }, seq: changed };
        }, loggedRetry(this.logger, 'drive.createFile', { transaction: TRANSACTION }));
        this.announce(ownerId, seq);
        return entryView(entry);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (onClash === 'REFUSE') throw nameTaken(name);
        if (attempt >= 5) throw error;
      }
    }
  }

  /**
   * One commit of a write (§3.1, §3.2), in one short transaction with no store I/O. A commit id already answered is
   * answered again and applies nothing. Every chunk must be this account's to name: held by one of its stagings or
   * named by one of its versions, with its bytes still kept (§4.4).
   *
   *   OVERWRITE  a new version becomes current; the previous one goes to Trash in a VERSION group of its own.
   *   CONTINUE   the handle's own current version gets the new chunk list, no new version; if the version is no longer
   *              current, or not this handle's, it is an OVERWRITE.
   *   APPEND     the current version grows in place, no new version. A tail that moved answers 409 DRIVE_TAIL_MOVED
   *              with the tail as it is; a base that was overwritten meanwhile makes the append an OVERWRITE of the
   *              base's content plus the appended bytes, the newer content going to Trash (last write wins, nothing lost).
   *
   * A commit lands on its entry wherever it is now, in Trash included (§3.1).
   */
  /**
   * Which of these chunks the account already holds (docs/drive-directory-sync-design.md, "Sending what is not there
   * yet"): the content a commit would accept without the bytes being sent again, by the very rule a commit checks
   * (assertChunksHeld): bytes still kept, of the same size, named by a staging or a version of this account's. Another
   * account's content is never counted, so the answer says nothing about what anyone else keeps.
   */
  async heldChunks(ownerId: string, chunks: Array<{ sha256: string; size: number }>): Promise<string[]> {
    const wanted = [...new Set(chunks.map((c) => c.sha256).filter((sha) => /^[0-9a-f]{64}$/.test(sha)))];
    if (!wanted.length) return [];
    const held = await this.prisma.$queryRaw<Array<{ sha256: string; size_bytes: number | bigint }>>`
      SELECT b."sha256", b."size_bytes" FROM "file_blob" b
       WHERE b."sha256" = ANY(${wanted}::text[]) AND b."bytes_deleted_at" IS NULL
         AND (EXISTS (SELECT 1 FROM "drive_staging_chunk" s WHERE s."sha256" = b."sha256" AND s."owner_id" = ${ownerId}::uuid)
           OR EXISTS (SELECT 1 FROM "drive_version_chunk" v WHERE v."sha256" = b."sha256" AND v."owner_id" = ${ownerId}::uuid))`;
    const sizes = new Map(held.map((h) => [h.sha256, Number(h.size_bytes)]));
    return [...new Set(chunks.filter((c) => sizes.get(c.sha256) === c.size).map((c) => c.sha256))];
  }

  async commit(
    ownerId: string,
    input: DriveCommitInput,
    options: { fence?: (tx: Tx) => Promise<void> } = {},
  ): Promise<DriveCommitResult & { replayed: boolean }> {
    validateCommit(input);
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      await bound(tx);
      // A managed runner's commit re-checks its instance in this transaction (§8.2): one racing a generation change lands
      // before it or is refused.
      if (options.fence) await options.fence(tx);
      const answered = await tx.driveCommit.findUnique({ where: { ownerId_commitId: { ownerId, commitId: input.commitId } } });
      if (answered) return { result: answered.result as unknown as DriveCommitResult, replayed: true };
      const lockEntry = async (entryId: string) => (await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "drive_entry" WHERE "id" = ${entryId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`).length > 0;
      const writer = await checkedWriter(tx, ownerId, input.writer);
      const now = new Date();
      let entryId = input.entryId;
      // A handle still writing a file a replacing rename removed (§3.2) lands in a new file in Trash named after it.
      let fresh: { groupId: string } | null = null;
      if (!(await lockEntry(entryId))) {
        const removed = await tx.$queryRaw<Array<{ parent_id: string; name: string; successor_id: string | null }>>`
          SELECT "parent_id", "name", "successor_id" FROM "drive_removed_entry"
           WHERE "owner_id" = ${ownerId}::uuid AND "entry_id" = ${input.entryId}::uuid FOR UPDATE`;
        if (!removed.length) throw notFound();
        const { parent_id: parentId, name, successor_id: successor } = removed[0];
        if (successor && (await lockEntry(successor))) {
          entryId = successor;
        } else {
          await assertChunksHeld(tx, ownerId, input.chunks);
          const created = await createInTrash(tx, ownerId, parentId, name, input.handleId ?? null, writer, now);
          await tx.driveRemovedEntry.update({
            where: { ownerId_entryId: { ownerId, entryId: input.entryId } },
            data: { successorId: created.entryId },
          });
          entryId = created.entryId;
          fresh = { groupId: created.groupId };
        }
      }
      const entry = await tx.driveEntry.findUniqueOrThrow({ where: { id: entryId } });
      if (entry.kind !== 'FILE') throw refusal(HttpStatus.CONFLICT, DRIVE_NOT_A_FILE, 'A folder has no content to commit.');
      if (!fresh) await assertChunksHeld(tx, ownerId, input.chunks);
      const current = await tx.driveVersion.findUniqueOrThrow({ where: { id: entry.currentVersionId! } });

      let mode = input.mode;
      if (mode === 'CONTINUE' && !(input.baseVersionId === current.id && current.handleId !== null && current.handleId === input.handleId)) {
        mode = 'OVERWRITE';
      }
      let chunks: Array<{ sha256: string; size: number }>;
      if (mode === 'APPEND') {
        const sorted = [...input.chunks].sort((a, b) => a.idx - b.idx);
        if (input.baseVersionId === current.id) {
          const tail = await tx.driveVersionChunk.findFirst({ where: { versionId: current.id }, orderBy: { idx: 'desc' } });
          const tailMoved = () => refusal(HttpStatus.CONFLICT, DRIVE_TAIL_MOVED, 'The file grew since this append was built.', {
            versionId: current.id,
            sizeBytes: num(current.sizeBytes),
            tail: tail ? { idx: tail.idx, sha256: tail.sha256, size: tail.sizeBytes, offset: num(tail.offset) } : null,
          });
          let firstIdx: number;
          let firstOffset: number;
          if (input.replaceTail) {
            if (!tail || tail.idx !== input.replaceTail.idx || tail.sha256 !== input.replaceTail.oldSha256) throw tailMoved();
            firstIdx = tail.idx;
            firstOffset = num(tail.offset);
          } else {
            if (input.baseSize !== undefined && input.baseSize !== null && input.baseSize !== num(current.sizeBytes)) throw tailMoved();
            firstIdx = current.chunkCount;
            firstOffset = num(current.sizeBytes);
          }
          assertContiguous(sorted, firstIdx);
          if (input.replaceTail) await tx.driveVersionChunk.delete({ where: { versionId_idx: { versionId: current.id, idx: firstIdx } } });
          let offset = firstOffset;
          await tx.driveVersionChunk.createMany({
            data: sorted.map((c) => {
              const row = { versionId: current.id, idx: c.idx, ownerId, offset: BigInt(offset), sizeBytes: c.size, sha256: c.sha256 };
              offset += c.size;
              return row;
            }),
          });
          await tx.driveVersion.update({
            where: { id: current.id },
            data: { sizeBytes: BigInt(offset), chunkCount: firstIdx + sorted.length, handleId: input.handleId ?? current.handleId, ...versionWriterFields(writer) },
          });
          const seq = await this.finishCommit(tx, ownerId, entry, writer, now, BigInt(offset), input, {
            entryId: entry.id, versionId: current.id, newVersion: false, replacedVersionId: null, trashGroupId: null, sizeBytes: offset,
          });
          return seq;
        }
        // Overwritten since the append was built: the base's content plus the appended bytes become a new version.
        // A new file in Trash appends to the version its removed source had, which the rename gave the target.
        const base = input.baseVersionId
          ? await tx.driveVersion.findFirst({
            where: { id: input.baseVersionId, ownerId, ...(fresh ? {} : { entryId: entry.id }) },
            include: { chunks: { orderBy: { idx: 'asc' } } },
          })
          : null;
        if (!base) throw refusal(HttpStatus.CONFLICT, DRIVE_BASE_GONE, 'The version this append was built on is gone; write the file again.');
        const keep = input.replaceTail ? input.replaceTail.idx : base.chunkCount;
        if (input.replaceTail && base.chunks[keep]?.sha256 !== input.replaceTail.oldSha256) {
          throw refusal(HttpStatus.BAD_REQUEST, DRIVE_COMMIT_INVALID, 'replaceTail does not name the base version\'s last chunk.');
        }
        assertContiguous(sorted, keep);
        chunks = [...base.chunks.slice(0, keep).map((c) => ({ sha256: c.sha256, size: c.sizeBytes })), ...sorted.map((c) => ({ sha256: c.sha256, size: c.size }))];
        mode = 'OVERWRITE';
      } else {
        const sorted = [...input.chunks].sort((a, b) => a.idx - b.idx);
        assertContiguous(sorted, 0);
        chunks = sorted.map((c) => ({ sha256: c.sha256, size: c.size }));
      }

      const size = chunks.reduce((sum, c) => sum + c.size, 0);
      if (mode === 'CONTINUE' || fresh) {
        // A new file in Trash: whatever the mode, the commit's content fills its empty first version.
        await tx.driveVersionChunk.deleteMany({ where: { versionId: current.id } });
        await insertChunks(tx, ownerId, current.id, chunks);
        await tx.driveVersion.update({
          where: { id: current.id },
          data: { sizeBytes: BigInt(size), chunkCount: chunks.length, ...versionWriterFields(writer) },
        });
        if (fresh) await tx.driveTrashGroup.update({ where: { id: fresh.groupId }, data: { itemCount: 1, sizeBytes: BigInt(size) } });
        return this.finishCommit(tx, ownerId, entry, writer, now, BigInt(size), input, {
          entryId: entry.id, versionId: current.id, newVersion: false, replacedVersionId: null, trashGroupId: null, sizeBytes: size,
        });
      }
      // OVERWRITE: a new current version; the previous one to Trash in a VERSION group of its own.
      const versionId = uuidv7();
      await tx.driveVersion.create({
        data: {
          id: versionId, ownerId, entryId: entry.id, sizeBytes: BigInt(size), chunkCount: chunks.length, createdAt: now,
          handleId: input.handleId ?? null, ...versionWriterFields(writer),
        },
      });
      await insertChunks(tx, ownerId, versionId, chunks);
      const groupId = await replaceVersion(tx, ownerId, entry, current, writer, now);
      await tx.driveEntry.update({ where: { id: entry.id }, data: { currentVersionId: versionId } });
      return this.finishCommit(tx, ownerId, entry, writer, now, BigInt(size), input, {
        entryId: entry.id, versionId, newVersion: true, replacedVersionId: current.id, trashGroupId: groupId, sizeBytes: size,
      });
    }, loggedRetry(this.logger, 'drive.commit', { transaction: TRANSACTION }));
    if (!outcome.replayed) this.announce(ownerId, outcome.result.seq);
    return { ...outcome.result, replayed: outcome.replayed };
  }

  /** What every commit ends with: the entry's size, mtime and last writer, one change row, the staging let go, the answer kept. */
  private async finishCommit(
    tx: Tx,
    ownerId: string,
    entry: EntryRow,
    writer: DriveWriter,
    now: Date,
    size: bigint,
    input: DriveCommitInput,
    result: Omit<DriveCommitResult, 'seq' | 'mtime'>,
  ): Promise<{ result: DriveCommitResult; replayed: boolean }> {
    await tx.driveEntry.update({
      where: { id: entry.id },
      data: { sizeBytes: size, mtime: now, updatedAt: now, ...lastWriterFields(writer, now) },
    });
    const seq = await recordChanges(tx, ownerId, [{ entryId: entry.id, parentId: entry.parentId, op: 'UPSERT' }]);
    // A Drive chat's content: its new file's change follows it, else it is an edit, which Undo reverses to the version
    // it replaced (none when it grew the current one in place).
    if (!entry.trashedAt) {
      await followDriveChatChange(tx, ownerId, writer, entry.id, { seq, versionId: result.versionId }, {
        kind: 'EDIT', entryId: entry.id, entryKind: 'FILE', beforeParentId: entry.parentId, beforeName: entry.name,
        afterParentId: entry.parentId, afterName: entry.name, afterSeq: seq, versionId: result.versionId,
        replacedVersionId: result.replacedVersionId,
      });
    }
    if (input.stagingId) {
      await tx.driveStagingChunk.deleteMany({ where: { stagingId: input.stagingId, ownerId } });
      await tx.driveStaging.updateMany({ where: { id: input.stagingId, ownerId }, data: { touchedAt: now, dirty: false } });
    }
    const answer = { ...result, seq, mtime: now.toISOString() };
    await tx.driveCommit.create({
      data: { ownerId, commitId: input.commitId, entryId: entry.id, result: answer as unknown as Prisma.InputJsonValue, createdAt: now },
    });
    return { result: answer, replayed: false };
  }

  /**
   * Rename and/or move a live entry (§3.2, §4.1). A taken name is refused 409 DRIVE_NAME_TAKEN unless `replace` (the
   * door's rename, a write-then-`os.replace` save): then a file onto a file is renameOnto, which answers the target, its
   * id kept. A folder moved into itself, or below itself, is refused 409 DRIVE_MOVE_INTO_ITSELF; a folder move takes the
   * account's lock, so no two moves can interleave into a cycle (§1.4). So does a replacing rename, before any row lock:
   * when a target appears only after the unlocked look, the transaction runs again with the lock.
   */
  async rename(
    ownerId: string,
    id: string,
    input: { name?: string; parentId?: string; writer?: DriveWriter; replace?: boolean; ifSeq?: bigint },
  ): Promise<DriveEntryView> {
    const newName = input.name === undefined ? undefined : assertDriveName(input.name);
    let lockFirst = false;
    for (;;) {
      const outcome = await withTransactionRetry(this.prisma, async (tx) => {
        await bound(tx);
        const seen = await tx.driveEntry.findFirst({ where: { id, ownerId } });
        if (!seen || seen.trashedAt) throw notFound();
        if (seen.parentId === null) throw refusal(HttpStatus.CONFLICT, DRIVE_ROOT, 'The root folder cannot be renamed or moved.');
        const moving = input.parentId !== undefined && input.parentId !== seen.parentId;
        const replacing = input.replace === true && seen.kind === 'FILE' && (lockFirst || await tx.driveEntry.count({
          where: { ownerId, parentId: moving ? input.parentId! : seen.parentId, name: newName ?? seen.name, kind: 'FILE', trashedAt: null, NOT: { id } },
        }) > 0);
        const locked = (moving && seen.kind === 'FOLDER') || replacing;
        if (locked) await lockAccount(tx, ownerId);
        // Folders before files: the destination first, as a folder trash locks its folders before it marks any file.
        const dest = await lockLiveFolder(tx, ownerId, moving ? input.parentId! : seen.parentId);
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "drive_entry"
           WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid AND "trashed_at" IS NULL FOR UPDATE`;
        if (!rows.length) throw notFound();
        const entry = await tx.driveEntry.findUniqueOrThrow({ where: { id } });
        if (input.ifSeq !== undefined && entry.seq !== input.ifSeq) throw changedSince();
        if (moving && entry.kind === 'FOLDER' && (await isWithin(tx, ownerId, dest.id, entry.id))) {
          throw refusal(HttpStatus.CONFLICT, DRIVE_MOVE_INTO_ITSELF, 'A folder cannot be moved into itself.');
        }
        const name = newName ?? entry.name;
        if (dest.id === entry.parentId && name === entry.name) return { entry, seq: null };
        const writer = await checkedWriter(tx, ownerId, input.writer ?? OWNER_WRITER);
        const now = new Date();
        const target = await tx.driveEntry.findFirst({ where: { ownerId, parentId: dest.id, name, trashedAt: null, NOT: { id } } });
        if (target) {
          if (!input.replace || target.kind !== 'FILE' || entry.kind !== 'FILE') throw nameTaken(name);
          // A Drive chat never replaces a file (owner decision Q2 A): its runner door asks the owner instead.
          if (await driveChatTurnOf(tx, ownerId, writer)) throw nameTaken(name);
          if (!locked) return { again: true as const };
          return this.renameOnto(tx, ownerId, entry, target, writer, now);
        }
        const updated = await tx.driveEntry.update({
          where: { id },
          data: { parentId: dest.id, name, updatedAt: now, ...lastWriterFields(writer, now) },
        });
        const changes: ChangeRow[] = moving
          ? [{ entryId: id, parentId: entry.parentId, op: 'REMOVE' }, { entryId: id, parentId: dest.id, op: 'UPSERT' }]
          : [{ entryId: id, parentId: dest.id, op: 'UPSERT' }];
        const seq = await recordChanges(tx, ownerId, changes);
        await recordDriveChatChange(tx, ownerId, writer, {
          kind: moving ? 'MOVE' : 'RENAME', entryId: id, entryKind: entry.kind, beforeParentId: entry.parentId,
          beforeName: entry.name, afterParentId: dest.id, afterName: name, afterSeq: seq,
        });
        return { entry: { ...updated, seq: BigInt(seq) }, seq };
      }, loggedRetry(this.logger, 'drive.rename', { transaction: TRANSACTION }));
      if ('again' in outcome) {
        lockFirst = true;
        continue;
      }
      this.announce(ownerId, outcome.seq);
      return entryView(outcome.entry);
    }
  }

  /**
   * A file renamed onto a live file (§3.2), under the account's lock. The **target** keeps its id: the source's current
   * version becomes its current version, chunk rows and all, and the target's previous one goes to Trash in a VERSION
   * group, so a share link pinned to it still serves it. The source entry is removed outright, not put in Trash: its
   * content lives on as the target's version, and so do its replaced versions, which move to the target with it. What
   * still names the source moves to the target or lets go of it first: its commit answers (a retried commit is answered,
   * never applied twice), its stagings (kept, bound to no entry). Its name and folder are kept in drive_removed_entry, so
   * a handle still writing the source commits as a new file in Trash named after it (§3.1, commit).
   */
  private async renameOnto(tx: Tx, ownerId: string, source: EntryRow, target: EntryRow, writer: DriveWriter, now: Date) {
    await tx.$queryRaw`SELECT "id" FROM "drive_entry" WHERE "id" = ${target.id}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
    const replaced = await tx.driveVersion.findUniqueOrThrow({ where: { id: target.currentVersionId! } });
    const content = await tx.driveVersion.findUniqueOrThrow({ where: { id: source.currentVersionId! } });
    await replaceVersion(tx, ownerId, target, replaced, writer, now);
    await tx.driveVersion.updateMany({ where: { ownerId, entryId: source.id }, data: { entryId: target.id } });
    await tx.driveVersion.update({ where: { id: content.id }, data: { handleId: null } });
    const updated = await tx.driveEntry.update({
      where: { id: target.id },
      data: {
        currentVersionId: content.id, sizeBytes: content.sizeBytes, mtime: source.mtime, updatedAt: now, ...lastWriterFields(writer, now),
      },
    });
    await tx.driveCommit.updateMany({ where: { ownerId, entryId: source.id }, data: { entryId: target.id } });
    await tx.driveStaging.updateMany({ where: { ownerId, entryId: source.id }, data: { entryId: null } });
    await tx.driveRemovedEntry.upsert({
      where: { ownerId_entryId: { ownerId, entryId: source.id } },
      create: { ownerId, entryId: source.id, parentId: source.parentId!, name: source.name, removedAt: now },
      update: { parentId: source.parentId!, name: source.name, removedAt: now, successorId: null },
    });
    await tx.driveEntry.delete({ where: { id: source.id } });
    const seq = await recordChanges(tx, ownerId, [
      { entryId: source.id, parentId: source.parentId, op: 'REMOVE' },
      { entryId: target.id, parentId: target.parentId, op: 'UPSERT' },
    ]);
    return { entry: { ...updated, seq: BigInt(seq) }, seq };
  }

  /**
   * Move a live entry to Trash (§3.3), a folder with everything under it, and answer the group that holds it. With a burst
   * key (a delete through the mount) it joins the open DELETE group of the same key last added to less than 10 s ago, so
   * the many deletes of one `rm -rf` are one group whose top item is the folder (§3.4). The owner's own delete is a
   * group of its own, closed at once, which the web's undo restores.
   *
   * A folder is hidden at once: the first transaction marks it, and as much under it as one batch holds. What is left is
   * marked into the same group a batch per transaction (finishTrash), so a folder of any size stays inside §1.4's bounds.
   * A folder whose marking stopped part-way (a bound hit, the process gone) is finished by deleting it again, which then
   * answers its group, or by the drive's timer (finishStoppedTrash).
   */
  async moveToTrash(
    ownerId: string,
    id: string,
    options: { writer?: DriveWriter; burstKey?: string | null; burstWindowMs?: number; ifSeq?: bigint } = {},
  ) {
    const first = await withTransactionRetry(this.prisma, async (tx) => {
      await bound(tx);
      const seen = await tx.driveEntry.findFirst({ where: { id, ownerId } });
      if (!seen) throw notFound();
      if (seen.trashedAt) {
        const stopped = seen.kind === 'FOLDER' && seen.trashTop
          && (await tx.driveTrashGroup.count({ where: { id: seen.trashGroupId!, ownerId, marking: true } })) > 0;
        if (!stopped) throw notFound();
        return { groupId: seen.trashGroupId!, seq: 0, open: null };
      }
      if (seen.parentId === null) throw refusal(HttpStatus.CONFLICT, DRIVE_ROOT, 'The root folder cannot be moved to Trash.');
      if (seen.kind === 'FOLDER') await lockAccount(tx, ownerId);
      // The entry FOR UPDATE: for a folder this waits out any create holding it FOR SHARE and stops new ones (§1.4).
      await tx.$queryRaw`SELECT "id" FROM "drive_entry" WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
      const entry = await tx.driveEntry.findUniqueOrThrow({ where: { id } });
      if (entry.trashedAt) throw notFound();
      if (options.ifSeq !== undefined && entry.seq !== options.ifSeq) throw changedSince();
      const writer = await checkedWriter(tx, ownerId, options.writer ?? OWNER_WRITER);
      const now = new Date();
      const groupId = await deleteGroupFor(tx, ownerId, entry, writer, now, options.burstKey ?? null, options.burstWindowMs);
      const top = await tx.$queryRaw<MarkedRow[]>`
        UPDATE "drive_entry"
           SET "trashed_at" = ${now}, "trash_group_id" = ${groupId}::uuid, "trash_top" = true, "updated_at" = ${now}
         WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid AND "trashed_at" IS NULL
        RETURNING "id", "parent_id", "kind", "size_bytes"`;
      // Items of the same burst already in the group hang under this folder now: it is their top.
      await tx.driveEntry.updateMany({
        where: { ownerId, trashGroupId: groupId, parentId: id, trashTop: true },
        data: { trashTop: false },
      });
      // Then, in statements of their own and so on snapshots that see every create that committed meanwhile, what is
      // live under it, up to a batch.
      const under = entry.kind === 'FOLDER'
        ? await markUnder(tx, ownerId, groupId, [id], now, DRIVE_TRASH_BATCH)
        : { marked: [], open: [], verified: false };
      const marked = [...top, ...under.marked];
      await tx.driveTrashGroup.update({
        where: { id: groupId },
        data: { lastAddedAt: now, ...countsOf(marked), ...(under.open.length ? { marking: true } : {}) },
      });
      const seq = await recordChanges(tx, ownerId, marked.map((m) => ({ entryId: m.id, parentId: m.parent_id, op: 'REMOVE' as const })));
      const after = await tx.driveEntry.findUniqueOrThrow({ where: { id }, select: { seq: true } });
      await recordDriveChatChange(tx, ownerId, writer, {
        kind: 'TRASH', entryId: id, entryKind: entry.kind, beforeParentId: entry.parentId, beforeName: entry.name,
        afterParentId: entry.parentId, afterName: entry.name, afterSeq: after.seq, trashGroupId: groupId,
      });
      return { groupId, seq, open: under.open as string[] | null };
    }, loggedRetry(this.logger, 'drive.moveToTrash', { transaction: TRANSACTION })).catch(limitHit);
    this.announce(ownerId, first.seq);
    if (first.open === null || first.open.length) await this.finishTrash(ownerId, first.groupId, first.open);
    return { trashGroupId: first.groupId };
  }

  /**
   * A folder a Drive chat made, removed outright by the owner's Undo (drive-chat-changes.ts): only while it is live, has
   * not changed since `ifSeq`, holds no live entry and no upload is going into it. One that holds items in Trash is
   * moved to Trash instead, in a DELETE group of its own (TRASHED), so those items keep a folder to come back to. Under
   * the account's lock, as a folder trash is (§1.4). Anything else answers what it found, changing nothing.
   */
  async removeEmptyFolder(ownerId: string, id: string, ifSeq: bigint): Promise<'REMOVED' | 'TRASHED' | 'CHANGED' | 'NOT_EMPTY'> {
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      await bound(tx);
      await lockAccount(tx, ownerId);
      // FOR UPDATE: a create or a restore into the folder holds it FOR SHARE, so it waits for this, or this for it.
      const rows = await tx.$queryRaw<Array<{ kind: string; parent_id: string | null; trashed_at: Date | null; seq: bigint }>>`
        SELECT "kind", "parent_id", "trashed_at", "seq" FROM "drive_entry"
         WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
      const folder = rows[0];
      if (!folder || folder.kind !== 'FOLDER' || folder.trashed_at || folder.parent_id === null || folder.seq !== ifSeq) {
        return { result: 'CHANGED' as const, seq: null };
      }
      const live = await tx.driveEntry.findFirst({ where: { ownerId, parentId: id, trashedAt: null }, select: { id: true } })
        ?? await tx.driveStaging.findFirst({ where: { ownerId, parentId: id, committedAt: null }, select: { id: true } });
      if (live) return { result: 'NOT_EMPTY' as const, seq: null };
      if (await tx.driveEntry.findFirst({ where: { ownerId, parentId: id }, select: { id: true } })) {
        const entry = await tx.driveEntry.findUniqueOrThrow({ where: { id } });
        const now = new Date();
        const groupId = await deleteGroupFor(tx, ownerId, entry, OWNER_WRITER, now, null);
        await tx.driveEntry.update({ where: { id }, data: { trashedAt: now, trashGroupId: groupId, trashTop: true, updatedAt: now } });
        await tx.driveTrashGroup.update({ where: { id: groupId }, data: { itemCount: 1, lastAddedAt: now } });
        const seq = await recordChanges(tx, ownerId, [{ entryId: id, parentId: folder.parent_id, op: 'REMOVE' }]);
        return { result: 'TRASHED' as const, seq };
      }
      await tx.driveEntry.delete({ where: { id } });
      const seq = await recordChanges(tx, ownerId, [{ entryId: id, parentId: folder.parent_id, op: 'REMOVE' }]);
      return { result: 'REMOVED' as const, seq };
    }, loggedRetry(this.logger, 'drive.removeEmptyFolder', { transaction: TRANSACTION }));
    this.announce(ownerId, outcome.seq);
    return outcome.result;
  }

  /**
   * What is still live under the folders of a group, marked into it a batch per transaction under the account's lock
   * (§1.4): from `open`, the folders whose children are still to mark, or with null from a look over the whole group. A
   * marking that ran out of open folders looks the group over once more when the group says its marking is under way, as
   * another folder of a burst may still be marking into it; a look that finds nothing lifts the mark. Stops when the group
   * is gone, restored or deleted for good meanwhile: what was not marked yet was never in Trash.
   */
  private async finishTrash(ownerId: string, groupId: string, open: string[] | null): Promise<void> {
    for (let from = open; ;) {
      const step = await withTransactionRetry(this.prisma, async (tx) => {
        await bound(tx);
        await lockAccount(tx, ownerId);
        const group = await tx.driveTrashGroup.findFirst({ where: { id: groupId, ownerId }, select: { marking: true } });
        if (!group) return null;
        const now = new Date();
        const under = await markUnder(tx, ownerId, groupId, from, now, DRIVE_TRASH_BATCH);
        const done = under.verified || (!under.open.length && !group.marking);
        await tx.driveTrashGroup.update({
          where: { id: groupId },
          data: { ...countsOf(under.marked), ...(under.verified ? { marking: false } : {}) },
        });
        const seq = await recordChanges(tx, ownerId, under.marked.map((m) => ({ entryId: m.id, parentId: m.parent_id, op: 'REMOVE' as const })));
        return { seq, open: under.open, done };
      }, loggedRetry(this.logger, 'drive.finishTrash', { transaction: TRANSACTION })).catch(limitHit);
      if (!step) return;
      this.announce(ownerId, step.seq);
      if (step.done) return;
      from = step.open.length ? step.open : null;
    }
  }

  /**
   * Every group whose folder marking stopped part-way and has not moved for STOPPED_MARKING_MS, finished (finishTrash):
   * the drive timer's run, and a spec's. Answers how many it took up.
   */
  async finishStoppedTrash(now: Date = new Date()): Promise<number> {
    const stopped = await this.prisma.driveTrashGroup.findMany({
      where: { marking: true, lastAddedAt: { lt: new Date(now.getTime() - STOPPED_MARKING_MS) } },
      select: { id: true, ownerId: true },
      orderBy: { lastAddedAt: 'asc' },
      take: 100,
    });
    for (const group of stopped) await this.finishTrash(group.ownerId, group.id, null);
    return stopped.length;
  }

  /**
   * Restore one Trash group whole (§3.5), under the account's lock, in transactions of at most DRIVE_TRASH_BATCH entries.
   * Each top-level item goes back to its folder if that folder is live; otherwise the missing folders of its path are made
   * again (a live folder of the same name is used). A name a live entry took meanwhile gets the first free `name (n).ext`;
   * descendants come back with their item and keep their names, but for one a live entry took, or one a second entry of
   * the group shares in the same folder, which gets the suffix too. A VERSION group restores its version as the current
   * one. Sent again after a bound was hit, it carries on with what is still in the group.
   */
  async restoreGroup(ownerId: string, groupId: string, writer: DriveWriter = OWNER_WRITER) {
    const restored: string[] = [];
    let open: string[] | null = null;
    let orphansLeft = true;
    for (let first = true; ; first = false) {
      const step = await withTransactionRetry(this.prisma, async (tx) => {
        await bound(tx);
        await lockAccount(tx, ownerId);
        const found = await tx.$queryRaw<Array<{ id: string; kind: string }>>`
          SELECT "id", "kind" FROM "drive_trash_group" WHERE "id" = ${groupId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
        if (!found.length) {
          if (first) throw refusal(HttpStatus.NOT_FOUND, DRIVE_TRASH_GROUP_NOT_FOUND, 'No such group in Trash.');
          return null;
        }
        const checked = await checkedWriter(tx, ownerId, writer);
        const now = new Date();
        if (found[0].kind === 'VERSION') {
          const version = await tx.driveVersion.findFirst({ where: { ownerId, trashGroupId: groupId } });
          if (!version) throw refusal(HttpStatus.NOT_FOUND, DRIVE_TRASH_GROUP_NOT_FOUND, 'No such group in Trash.');
          const { entry, seq } = await restoreAsCurrent(tx, ownerId, version, checked, now);
          return { ids: [entry.id], seq, open: [] as string[], orphansLeft: false, done: true };
        }
        const changes: ChangeRow[] = [];
        const ids: string[] = [];
        // Top-level items whose folder is not live: theirs is made again or reused (liveDestination), a few at a time.
        const orphans = orphansLeft
          ? await tx.$queryRaw<Array<{ id: string; parent_id: string; name: string; kind: string }>>`
              SELECT e."id", e."parent_id", e."name", e."kind" FROM "drive_entry" e JOIN "drive_entry" p ON p."id" = e."parent_id"
               WHERE e."owner_id" = ${ownerId}::uuid AND e."trash_group_id" = ${groupId}::uuid AND e."trash_top"
                 AND p."trashed_at" IS NOT NULL
               ORDER BY e."trashed_at" ASC, e."id" ASC LIMIT ${ORPHAN_BATCH}`
          : [];
        const reopened: string[] = [];
        for (const top of orphans) {
          const dest = await liveDestination(tx, ownerId, top.parent_id, checked, now, changes);
          const name = await freeName(tx, ownerId, dest, top.name, top.kind, 'SUFFIX');
          await tx.driveEntry.update({
            where: { id: top.id },
            data: { parentId: dest, name, trashedAt: null, trashGroupId: null, trashTop: false, updatedAt: now, ...lastWriterFields(checked, now) },
          });
          changes.push({ entryId: top.id, parentId: dest, op: 'UPSERT' });
          ids.push(top.id);
          if (top.kind === 'FOLDER') reopened.push(top.id);
        }
        // The rest come back folder by folder from the live folders they hang in: on the first pass every live folder
        // an item of the group is in, top-level items included.
        const from = open ?? (await tx.$queryRaw<Array<{ id: string }>>`
          SELECT DISTINCT e."parent_id" AS "id" FROM "drive_entry" e JOIN "drive_entry" p ON p."id" = e."parent_id"
           WHERE e."owner_id" = ${ownerId}::uuid AND e."trash_group_id" = ${groupId}::uuid AND p."trashed_at" IS NULL`).map((r) => r.id);
        const next = await restoreUnder(tx, ownerId, groupId, [...from, ...reopened], checked, now, DRIVE_TRASH_BATCH - ids.length, changes, ids);
        const left = orphans.length === ORPHAN_BATCH;
        const done = !left && !next.length;
        if (done) await deleteEmptyGroups(tx, ownerId, [groupId]);
        const seq = await recordChanges(tx, ownerId, changes);
        return { ids, seq, open: next, orphansLeft: left, done };
      }, loggedRetry(this.logger, 'drive.restoreGroup', { transaction: TRANSACTION })).catch(limitHit);
      if (!step) break;
      restored.push(...step.ids);
      this.announce(ownerId, step.seq);
      if (step.done) break;
      open = step.open;
      orphansLeft = step.orphansLeft;
    }
    return { entryIds: restored };
  }

  /**
   * Restore ONE item out of a DELETE group (board frame 6, rule 3: one file back from an agent's `rm -rf` without the
   * rest), under the account's lock like the whole group. The item is any entry of the group: a top item, or one under a
   * folder of the group. It goes back to its folder if that folder is live; otherwise the missing folders of its path are
   * made again, as a group restore makes them (liveDestination), and the group's own folders stay in Trash. A name a live
   * entry took meanwhile gets the first free suffix. What hangs under the item comes back with it and keeps its names, in
   * transactions of at most DRIVE_TRASH_BATCH entries. The group keeps the rest; it is deleted once nothing is in it, its
   * counts recounted otherwise.
   */
  async restoreItem(ownerId: string, groupId: string, entryId: string, writer: DriveWriter = OWNER_WRITER) {
    const restored: string[] = [];
    let open: string[] | null = null;
    for (;;) {
      const step = await withTransactionRetry(this.prisma, async (tx) => {
        await bound(tx);
        await lockAccount(tx, ownerId);
        const found = await tx.$queryRaw<Array<{ id: string; kind: string }>>`
          SELECT "id", "kind" FROM "drive_trash_group" WHERE "id" = ${groupId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
        if (!found.length) {
          if (open === null) throw refusal(HttpStatus.NOT_FOUND, DRIVE_TRASH_GROUP_NOT_FOUND, 'No such group in Trash.');
          return null;
        }
        const checked = await checkedWriter(tx, ownerId, writer);
        const now = new Date();
        const changes: ChangeRow[] = [];
        const ids: string[] = [];
        let from = open;
        if (from === null) {
          const item = await tx.driveEntry.findFirst({ where: { id: entryId, ownerId, trashGroupId: groupId } });
          if (!item) throw notFound();
          const dest = await liveDestination(tx, ownerId, item.parentId!, checked, now, changes);
          const name = await freeName(tx, ownerId, dest, item.name, item.kind, 'SUFFIX');
          await tx.driveEntry.update({
            where: { id: item.id },
            data: { parentId: dest, name, trashedAt: null, trashGroupId: null, trashTop: false, updatedAt: now, ...lastWriterFields(checked, now) },
          });
          changes.push({ entryId: item.id, parentId: dest, op: 'UPSERT' });
          ids.push(item.id);
          from = item.kind === 'FOLDER' ? [item.id] : [];
        }
        // What hangs under it in the group comes back with it, under the names it had.
        const next = await restoreUnder(tx, ownerId, groupId, from, checked, now, DRIVE_TRASH_BATCH - ids.length, changes, ids);
        if (!next.length) await deleteEmptyGroups(tx, ownerId, [groupId]);
        const seq = await recordChanges(tx, ownerId, changes);
        return { ids, seq, open: next };
      }, loggedRetry(this.logger, 'drive.restoreItem', { transaction: TRANSACTION })).catch(limitHit);
      if (!step) break;
      restored.push(...step.ids);
      this.announce(ownerId, step.seq);
      if (!step.open.length) break;
      open = step.open;
    }
    return { entryIds: restored };
  }

  /**
   * Restore a replaced version (board choice c): as the current version (the current one goes to Trash in a VERSION group;
   * the file must be live), or as a copy beside the file named by the suffix rule, the chosen version staying in Trash.
   */
  async restoreVersion(
    ownerId: string,
    versionId: string,
    as: 'CURRENT' | 'COPY',
    writer: DriveWriter = OWNER_WRITER,
    options: { ifSeq?: bigint } = {},
  ) {
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      await bound(tx);
      const version = await tx.driveVersion.findFirst({ where: { id: versionId, ownerId } });
      if (!version) throw refusal(HttpStatus.NOT_FOUND, DRIVE_VERSION_NOT_FOUND, 'No such version.');
      if (!version.replacedAt) throw refusal(HttpStatus.CONFLICT, DRIVE_VERSION_CURRENT, 'That is already the current version.');
      if (options.ifSeq !== undefined) {
        const held = await tx.$queryRaw<Array<{ seq: bigint }>>`
          SELECT "seq" FROM "drive_entry" WHERE "id" = ${version.entryId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
        if (held[0]?.seq !== options.ifSeq) throw changedSince();
      }
      const checked = await checkedWriter(tx, ownerId, writer);
      const now = new Date();
      if (as === 'CURRENT') return restoreAsCurrent(tx, ownerId, version, checked, now);
      const source = await tx.driveEntry.findUniqueOrThrow({ where: { id: version.entryId } });
      if (source.trashedAt) throw refusal(HttpStatus.CONFLICT, DRIVE_IN_TRASH, 'The file is in Trash; restore it first.');
      const parent = await lockLiveFolder(tx, ownerId, source.parentId!);
      const name = await freeName(tx, ownerId, parent.id, source.name, 'FILE', 'SUFFIX');
      const entryId = uuidv7();
      const copyId = uuidv7();
      const created = await tx.driveEntry.create({
        data: {
          id: entryId, ownerId, parentId: parent.id, kind: 'FILE', name, currentVersionId: copyId, sizeBytes: version.sizeBytes,
          mtime: now, createdAt: now, updatedAt: now, ...lastWriterFields(checked, now),
        },
      });
      await tx.driveVersion.create({
        data: { id: copyId, ownerId, entryId, sizeBytes: version.sizeBytes, chunkCount: version.chunkCount, createdAt: now, ...versionWriterFields(checked) },
      });
      await tx.$executeRaw`
        INSERT INTO "drive_version_chunk" ("version_id", "idx", "owner_id", "offset", "size_bytes", "sha256")
        SELECT ${copyId}::uuid, "idx", "owner_id", "offset", "size_bytes", "sha256"
          FROM "drive_version_chunk" WHERE "version_id" = ${version.id}::uuid AND "owner_id" = ${ownerId}::uuid`;
      const seq = await recordChanges(tx, ownerId, [{ entryId, parentId: parent.id, op: 'UPSERT' }]);
      return { entry: { ...created, seq: BigInt(seq) }, seq };
    }, loggedRetry(this.logger, 'drive.restoreVersion', { transaction: TRANSACTION }));
    this.announce(ownerId, outcome.seq);
    return entryView(outcome.entry);
  }

  /** Delete a Trash group for good: its entries (and everything under them) or its version. Their chunk rows go with them. */
  async deleteGroup(ownerId: string, groupId: string): Promise<{ deleted: true }> {
    for (let first = true; ; first = false) {
      const more = await withTransactionRetry(this.prisma, async (tx) => {
        await bound(tx);
        await lockAccount(tx, ownerId);
        const [group] = await tx.$queryRaw<Array<{ kind: string }>>`
          SELECT "kind" FROM "drive_trash_group" WHERE "id" = ${groupId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
        if (!group) {
          if (first) throw refusal(HttpStatus.NOT_FOUND, DRIVE_TRASH_GROUP_NOT_FOUND, 'No such group in Trash.');
          return false;
        }
        const picked = group.kind === 'VERSION'
          ? await deleteTrashVersions(tx, ownerId, groupId)
          : await deleteTrashLeaves(tx, ownerId, groupId);
        if (!picked) await deleteEmptyGroups(tx, ownerId, [groupId]);
        return picked && (await tx.driveTrashGroup.count({ where: { id: groupId, ownerId } })) > 0;
      }, loggedRetry(this.logger, 'drive.deleteGroup', { transaction: TRANSACTION })).catch(limitHit);
      if (!more) return { deleted: true };
    }
  }

  /** Delete one replaced version for good. The current version is not in Trash and is refused. */
  async deleteVersion(ownerId: string, versionId: string): Promise<{ deleted: true }> {
    await withTransactionRetry(this.prisma, async (tx) => {
      await bound(tx);
      await lockAccount(tx, ownerId);
      const version = await tx.driveVersion.findFirst({ where: { id: versionId, ownerId } });
      if (!version) throw refusal(HttpStatus.NOT_FOUND, DRIVE_VERSION_NOT_FOUND, 'No such version.');
      if (!version.replacedAt) throw refusal(HttpStatus.CONFLICT, DRIVE_VERSION_CURRENT, 'The current version is not in Trash.');
      await tx.driveVersion.delete({ where: { id: version.id } });
      if (version.trashGroupId) await deleteEmptyGroups(tx, ownerId, [version.trashGroupId]);
    }, loggedRetry(this.logger, 'drive.deleteVersion', { transaction: TRANSACTION }));
    return { deleted: true };
  }

  /** Empty Trash: every trashed entry and every replaced version of the account, for good, and every group. */
  async emptyTrash(ownerId: string): Promise<{ deleted: true }> {
    for (;;) {
      const more = await withTransactionRetry(this.prisma, async (tx) => {
        await bound(tx);
        await lockAccount(tx, ownerId);
        if (await deleteTrashLeaves(tx, ownerId)) return true;
        if (await deleteTrashVersions(tx, ownerId)) return true;
        const empty = await tx.driveTrashGroup.deleteMany({
          where: { ownerId, entries: { none: {} }, versions: { none: {} } }, limit: DRIVE_TRASH_BATCH,
        });
        return empty.count > 0;
      }, loggedRetry(this.logger, 'drive.emptyTrash', { transaction: TRANSACTION })).catch(limitHit);
      if (!more) return { deleted: true };
    }
  }
}

// ── participants: each runs inside its caller's transaction ─────────────────────────────────────

interface ChangeRow {
  entryId: string;
  parentId: string | null;
  op: 'UPSERT' | 'REMOVE';
}

/** Every drive transaction is short (§1.4): a statement that waits 10 s is cancelled, and the transaction with it. */
async function bound(tx: Tx): Promise<void> {
  await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
}

/** The account's folder lock (§1.4): folder trash, folder move, restore and delete for good run one at a time per account. */
async function lockAccount(tx: Tx, ownerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DRIVE_LOCK_NAMESPACE}::int, hashtext(${ownerId}))`;
}

/** The account's root, made here if it is not there yet (one per account, drive_entry_root_key). */
async function rootIn(tx: Tx, ownerId: string): Promise<EntryRow> {
  const found = await tx.driveEntry.findFirst({ where: { ownerId, parentId: null } });
  if (found) return found;
  await tx.$executeRaw`
    INSERT INTO "drive_entry" ("id", "owner_id", "parent_id", "kind", "name", "last_writer_kind")
    VALUES (${uuidv7()}::uuid, ${ownerId}::uuid, NULL, 'FOLDER', '', 'OWNER')
    ON CONFLICT ("owner_id") WHERE "parent_id" IS NULL DO NOTHING`;
  return tx.driveEntry.findFirstOrThrow({ where: { ownerId, parentId: null } });
}

/**
 * A folder a write goes into, held FOR SHARE so a folder trash waits for the write and the write sees the folder's state
 * after any trash that came first (§1.4): gone or in Trash answers 404 DRIVE_PARENT_GONE.
 */
async function lockLiveFolder(tx: Tx, ownerId: string, folderId: string | null): Promise<EntryRow> {
  if (folderId === null) return rootIn(tx, ownerId);
  const rows = await tx.$queryRaw<Array<{ id: string; kind: string; trashed_at: Date | null }>>`
    SELECT "id", "kind", "trashed_at" FROM "drive_entry"
     WHERE "id" = ${folderId}::uuid AND "owner_id" = ${ownerId}::uuid FOR SHARE`;
  if (!rows.length || rows[0].trashed_at) throw parentGone();
  if (rows[0].kind !== 'FOLDER') throw refusal(HttpStatus.CONFLICT, DRIVE_NOT_A_FOLDER, 'That is a file, not a folder.');
  return tx.driveEntry.findUniqueOrThrow({ where: { id: folderId } });
}

/** `name` if no live entry of `parentId` has it; otherwise the first free suffixed name, or a refusal. */
async function freeName(tx: Tx, ownerId: string, parentId: string, name: string, kind: string, onClash: DriveOnClash): Promise<string> {
  const taken = (candidate: string) =>
    tx.driveEntry.findFirst({ where: { ownerId, parentId, name: candidate, trashedAt: null }, select: { id: true } });
  if (!(await taken(name))) return name;
  if (onClash === 'REFUSE') throw nameTaken(name);
  for (let n = 2; ; n += 1) {
    const candidate = suffixedName(name, n, kind);
    if (!(await taken(candidate))) return candidate;
  }
}

/** Whether `folderId` is `ancestorId` or lies below it: the walk up a folder move checks under the account's lock. */
async function isWithin(tx: Tx, ownerId: string, folderId: string, ancestorId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ hit: boolean }>>`
    WITH RECURSIVE "up" AS (
      SELECT "id", "parent_id" FROM "drive_entry" WHERE "id" = ${folderId}::uuid AND "owner_id" = ${ownerId}::uuid
      UNION ALL
      SELECT e."id", e."parent_id" FROM "drive_entry" e JOIN "up" ON e."id" = "up"."parent_id" WHERE e."owner_id" = ${ownerId}::uuid
    )
    SELECT EXISTS (SELECT 1 FROM "up" WHERE "id" = ${ancestorId}::uuid) AS "hit"`;
  return rows[0]?.hit === true;
}

/** An entry's path from the root, `/` for the root itself, whether or not it is in Trash. */
async function pathOf(db: Tx | PrismaService, ownerId: string, entryId: string): Promise<string> {
  const rows = await db.$queryRaw<Array<{ name: string }>>`
    WITH RECURSIVE "up" AS (
      SELECT "id", "parent_id", "name", 0 AS "depth" FROM "drive_entry" WHERE "id" = ${entryId}::uuid AND "owner_id" = ${ownerId}::uuid
      UNION ALL
      SELECT e."id", e."parent_id", e."name", "up"."depth" + 1 FROM "drive_entry" e JOIN "up" ON e."id" = "up"."parent_id"
       WHERE e."owner_id" = ${ownerId}::uuid
    )
    SELECT "name" FROM "up" WHERE "parent_id" IS NOT NULL ORDER BY "depth" DESC`;
  return '/' + rows.map((r) => r.name).join('/');
}

/** The writer as recorded (§3.6): an agent's session only when it is the owner's and runs on the runner the write came through. */
async function checkedWriter(tx: Tx, ownerId: string, writer: DriveWriter): Promise<DriveWriter> {
  if (writer.kind === 'OWNER') {
    return { kind: 'OWNER', sessionId: null, runnerId: null, ...(writer.changeGroupId ? { changeGroupId: writer.changeGroupId } : {}) };
  }
  const runnerId = writer.runnerId ?? null;
  if (!writer.sessionId || !runnerId) return { kind: 'AGENT', sessionId: null, runnerId };
  const session = await tx.session.findFirst({ where: { id: writer.sessionId, ownerId, assignedRunnerId: runnerId }, select: { id: true } });
  return { kind: 'AGENT', sessionId: session ? session.id : null, runnerId };
}

function lastWriterFields(writer: DriveWriter, now: Date) {
  return {
    lastWriterKind: writer.kind,
    lastWriterSessionId: writer.sessionId ?? null,
    lastWriterRunnerId: writer.runnerId ?? null,
    lastWrittenAt: now,
  };
}

function versionWriterFields(writer: DriveWriter) {
  return { writerKind: writer.kind, writerSessionId: writer.sessionId ?? null, writerRunnerId: writer.runnerId ?? null };
}

/**
 * One drive_change row per change, and each entry's `seq` moved to its own last row, in one statement. Answers the
 * highest seq written, what `drive.changed` announces.
 */
async function recordChanges(tx: Tx, ownerId: string, rows: ChangeRow[]): Promise<number> {
  if (!rows.length) return 0;
  const written = await tx.$queryRaw<Array<{ seq: bigint | null }>>`
    WITH "ins" AS (
      INSERT INTO "drive_change" ("owner_id", "entry_id", "parent_id", "op")
      SELECT ${ownerId}::uuid, t."e", t."p", t."o"
        FROM unnest(${rows.map((r) => r.entryId)}::uuid[], ${rows.map((r) => r.parentId)}::uuid[], ${rows.map((r) => r.op)}::text[])
          WITH ORDINALITY AS t("e", "p", "o", "n")
       ORDER BY t."n"
      RETURNING "entry_id", "seq"
    ), "moved" AS (
      UPDATE "drive_entry" d SET "seq" = m."seq"
        FROM (SELECT "entry_id", max("seq") AS "seq" FROM "ins" GROUP BY "entry_id") m
       WHERE d."id" = m."entry_id" AND d."owner_id" = ${ownerId}::uuid
      RETURNING 1
    )
    SELECT max("seq") AS "seq" FROM "ins"`;
  return num(written[0]?.seq ?? 0n);
}

/** The chunk rows of a version, from index 0, each at the offset the ones before it end at. */
async function insertChunks(tx: Tx, ownerId: string, versionId: string, chunks: Array<{ sha256: string; size: number }>): Promise<void> {
  if (!chunks.length) return;
  let offset = 0;
  await tx.driveVersionChunk.createMany({
    data: chunks.map((c, idx) => {
      const row = { versionId, idx, ownerId, offset: BigInt(offset), sizeBytes: c.size, sha256: c.sha256 };
      offset += c.size;
      return row;
    }),
  });
}

/** A current version stops being current and goes to Trash in a VERSION group of its own, from the file's folder. */
async function replaceVersion(tx: Tx, ownerId: string, entry: EntryRow, version: VersionRow, writer: DriveWriter, now: Date): Promise<string> {
  const group = await tx.driveTrashGroup.create({
    data: {
      id: uuidv7(), ownerId, kind: 'VERSION', folderId: entry.parentId,
      folderPath: entry.parentId ? await pathOf(tx, ownerId, entry.parentId) : '/',
      createdAt: now, lastAddedAt: now, closedAt: now, actorKind: writer.kind, actorSessionId: writer.sessionId ?? null,
      actorRunnerId: writer.runnerId ?? null, itemCount: 1, sizeBytes: version.sizeBytes,
    },
  });
  await tx.driveVersion.update({ where: { id: version.id }, data: { replacedAt: now, trashGroupId: group.id, handleId: null } });
  return group.id;
}

/** A replaced version made current again; the current one goes to Trash in its place. The file must be live. */
async function restoreAsCurrent(tx: Tx, ownerId: string, version: VersionRow, writer: DriveWriter, now: Date) {
  await tx.$queryRaw`SELECT "id" FROM "drive_entry" WHERE "id" = ${version.entryId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
  const entry = await tx.driveEntry.findUniqueOrThrow({ where: { id: version.entryId } });
  if (entry.trashedAt) throw refusal(HttpStatus.CONFLICT, DRIVE_IN_TRASH, 'The file is in Trash; restore it first.');
  const current = await tx.driveVersion.findUniqueOrThrow({ where: { id: entry.currentVersionId! } });
  await replaceVersion(tx, ownerId, entry, current, writer, now);
  const oldGroup = version.trashGroupId;
  await tx.driveVersion.update({ where: { id: version.id }, data: { replacedAt: null, trashGroupId: null, handleId: null } });
  if (oldGroup) await deleteEmptyGroups(tx, ownerId, [oldGroup]);
  const updated = await tx.driveEntry.update({
    where: { id: entry.id },
    data: { currentVersionId: version.id, sizeBytes: version.sizeBytes, mtime: now, updatedAt: now, ...lastWriterFields(writer, now) },
  });
  const seq = await recordChanges(tx, ownerId, [{ entryId: entry.id, parentId: entry.parentId, op: 'UPSERT' }]);
  return { entry: { ...updated, seq: BigInt(seq) }, seq };
}

/**
 * A new file in Trash named `name`, in folder `parentId` when that folder is still there (live or in Trash), else in the
 * root, in a DELETE group of its own, with an empty first version written by `handleId`: where a handle still writing a
 * file a replacing rename removed commits (§3.2). Its commit fills the version.
 */
async function createInTrash(
  tx: Tx,
  ownerId: string,
  parentId: string,
  name: string,
  handleId: string | null,
  writer: DriveWriter,
  now: Date,
): Promise<{ entryId: string; groupId: string }> {
  const folder = await tx.driveEntry.findFirst({ where: { id: parentId, ownerId, kind: 'FOLDER' }, select: { id: true } });
  const parent = folder?.id ?? (await rootIn(tx, ownerId)).id;
  const group = await tx.driveTrashGroup.create({
    data: {
      id: uuidv7(), ownerId, kind: 'DELETE', folderId: parent, folderPath: await pathOf(tx, ownerId, parent),
      createdAt: now, lastAddedAt: now, closedAt: now, actorKind: writer.kind, actorSessionId: writer.sessionId ?? null,
      actorRunnerId: writer.runnerId ?? null, itemCount: 1,
    },
  });
  const entryId = uuidv7();
  const versionId = uuidv7();
  await tx.driveEntry.create({
    data: {
      id: entryId, ownerId, parentId: parent, kind: 'FILE', name, currentVersionId: versionId, mtime: now, createdAt: now,
      updatedAt: now, trashedAt: now, trashGroupId: group.id, trashTop: true, ...lastWriterFields(writer, now),
    },
  });
  await tx.driveVersion.create({ data: { id: versionId, ownerId, entryId, createdAt: now, handleId, ...versionWriterFields(writer) } });
  return { entryId, groupId: group.id };
}

/**
 * The DELETE group a delete goes into (§3.4): with a burst key, the open group of that key last added to within the window,
 * else a new one. A folder deleted after its contents in one burst becomes the group's top, and the group's folder becomes
 * the folder it was deleted from.
 */
async function deleteGroupFor(
  tx: Tx,
  ownerId: string,
  entry: EntryRow,
  writer: DriveWriter,
  now: Date,
  burstKey: string | null,
  windowMs: number = DRIVE_BURST_WINDOW_MS,
): Promise<string> {
  if (burstKey) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DRIVE_BURST_LOCK_NAMESPACE}::int, hashtext(${ownerId} || ':' || ${burstKey}))`;
    const open = await tx.$queryRaw<Array<{ id: string; folder_id: string | null }>>`
      SELECT "id", "folder_id" FROM "drive_trash_group"
       WHERE "owner_id" = ${ownerId}::uuid AND "kind" = 'DELETE' AND "burst_key" = ${burstKey} AND "closed_at" IS NULL
         AND "last_added_at" > ${new Date(now.getTime() - windowMs)}
       ORDER BY "last_added_at" DESC LIMIT 1 FOR UPDATE`;
    if (open.length) {
      if (open[0].folder_id === entry.id) {
        await tx.driveTrashGroup.update({
          where: { id: open[0].id },
          data: { folderId: entry.parentId, folderPath: await pathOf(tx, ownerId, entry.parentId!) },
        });
      }
      return open[0].id;
    }
  }
  const group = await tx.driveTrashGroup.create({
    data: {
      id: uuidv7(), ownerId, kind: 'DELETE', folderId: entry.parentId, folderPath: await pathOf(tx, ownerId, entry.parentId!),
      createdAt: now, lastAddedAt: now, closedAt: burstKey ? null : now, burstKey, actorKind: writer.kind,
      actorSessionId: writer.sessionId ?? null, actorRunnerId: writer.runnerId ?? null,
    },
  });
  return group.id;
}

/**
 * The live folder a restored item goes into: its own folder when that is live; otherwise its nearest live ancestor, with
 * each missing folder of the path below it made again, or a live folder of that name used (§3.5).
 */
async function liveDestination(tx: Tx, ownerId: string, parentId: string, writer: DriveWriter, now: Date, changes: ChangeRow[]): Promise<string> {
  const chain = await tx.$queryRaw<Array<{ id: string; name: string; trashed_at: Date | null }>>`
    WITH RECURSIVE "up" AS (
      SELECT "id", "parent_id", "name", "trashed_at", 0 AS "depth" FROM "drive_entry" WHERE "id" = ${parentId}::uuid AND "owner_id" = ${ownerId}::uuid
      UNION ALL
      SELECT e."id", e."parent_id", e."name", e."trashed_at", "up"."depth" + 1 FROM "drive_entry" e JOIN "up" ON e."id" = "up"."parent_id"
       WHERE e."owner_id" = ${ownerId}::uuid AND "up"."trashed_at" IS NOT NULL
    )
    SELECT "id", "name", "trashed_at" FROM "up" ORDER BY "depth" ASC`;
  const liveAt = chain.findIndex((c) => c.trashed_at === null);
  if (liveAt === 0) return (await lockLiveFolder(tx, ownerId, parentId)).id;
  let dest = liveAt > 0 ? (await lockLiveFolder(tx, ownerId, chain[liveAt].id)).id : (await rootIn(tx, ownerId)).id;
  for (const missing of chain.slice(0, liveAt < 0 ? chain.length : liveAt).reverse()) {
    const existing = await tx.driveEntry.findFirst({ where: { ownerId, parentId: dest, name: missing.name, trashedAt: null } });
    if (existing?.kind === 'FOLDER') {
      dest = existing.id;
      continue;
    }
    const name = await freeName(tx, ownerId, dest, missing.name, 'FOLDER', 'SUFFIX');
    const created = await tx.driveEntry.create({
      data: { id: uuidv7(), ownerId, parentId: dest, kind: 'FOLDER', name, mtime: now, createdAt: now, updatedAt: now, ...lastWriterFields(writer, now) },
    });
    changes.push({ entryId: created.id, parentId: dest, op: 'UPSERT' });
    dest = created.id;
  }
  return dest;
}

/** Groups of `ids` that nothing is in any more, deleted; the rest get their counts again. */
async function deleteEmptyGroups(tx: Tx, ownerId: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  await tx.driveTrashGroup.deleteMany({ where: { ownerId, id: { in: unique }, entries: { none: {} }, versions: { none: {} } } });
  await tx.$executeRaw`
    UPDATE "drive_trash_group" g
       SET "item_count" = c."items", "size_bytes" = c."bytes"
      FROM (
        SELECT g2."id",
               (SELECT count(*) FROM "drive_entry" e WHERE e."owner_id" = g2."owner_id" AND e."trash_group_id" = g2."id")
             + (SELECT count(*) FROM "drive_version" v WHERE v."owner_id" = g2."owner_id" AND v."trash_group_id" = g2."id") AS "items",
               coalesce((SELECT sum(e."size_bytes") FROM "drive_entry" e WHERE e."owner_id" = g2."owner_id" AND e."trash_group_id" = g2."id" AND e."kind" = 'FILE'), 0)
             + coalesce((SELECT sum(v."size_bytes") FROM "drive_version" v WHERE v."owner_id" = g2."owner_id" AND v."trash_group_id" = g2."id"), 0) AS "bytes"
          FROM "drive_trash_group" g2 WHERE g2."owner_id" = ${ownerId}::uuid AND g2."id" = ANY(${unique}::uuid[])
      ) c
     WHERE g."id" = c."id"`;
}

/** Delete one batch of leaves. Seed from the group's entries (or all Trash), then include descendants in other groups
 * and descendants a stopped marking has yet to reach. UNION deduplicates descendants that are themselves seeds. Check
 * for children as the walk yields rows so the batch limit can stop it early. */
async function deleteTrashLeaves(tx: Tx, ownerId: string, groupId?: string): Promise<boolean> {
  const scope = groupId ? Prisma.sql`e."trash_group_id" = ${groupId}::uuid` : Prisma.sql`e."trash_group_id" IS NOT NULL`;
  const picked = await tx.$queryRaw<Array<{ id: string; still_here: boolean }>>`
    WITH RECURSIVE "sub" AS (
      SELECT e."id", e."parent_id" FROM "drive_entry" e WHERE e."owner_id" = ${ownerId}::uuid AND ${scope}
      UNION
      SELECT e."id", e."parent_id" FROM "sub" JOIN "drive_entry" e ON e."parent_id" = "sub"."id"
       WHERE e."owner_id" = ${ownerId}::uuid
    ), "leaves" AS (
      SELECT s."id", s."parent_id" FROM "sub" s
       WHERE (SELECT 1 FROM "drive_entry" c WHERE c."parent_id" = s."id" LIMIT 1) IS NULL
       LIMIT ${DRIVE_TRASH_BATCH}
    )
    SELECT e."id", e."parent_id" = l."parent_id" AS "still_here"
      FROM "leaves" l JOIN "drive_entry" e ON e."id" = l."id"
     ORDER BY e."kind" DESC, e."id" FOR UPDATE OF e`;
  const ids = picked.filter((e) => e.still_here).map((e) => e.id);
  if (!ids.length) return picked.length > 0;

  // Take a fresh snapshot with the rows locked. A child may have been added while waiting for a folder lock during
  // stopped marking. The row locks also keep a mount commit from changing the versions we are about to cascade.
  const touched = await tx.$queryRaw<Array<{ group_id: string }>>`
    WITH "deleted" AS (
      DELETE FROM "drive_entry" e WHERE e."owner_id" = ${ownerId}::uuid AND e."id" = ANY(${ids}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM "drive_entry" c WHERE c."parent_id" = e."id")
      RETURNING e."id", e."trash_group_id"
    )
    SELECT "trash_group_id" AS "group_id" FROM "deleted" WHERE "trash_group_id" IS NOT NULL
    UNION
    SELECT v."trash_group_id" FROM "drive_version" v JOIN "deleted" d ON d."id" = v."entry_id"
     WHERE v."owner_id" = ${ownerId}::uuid AND v."trash_group_id" IS NOT NULL`;
  await deleteEmptyGroups(tx, ownerId, touched.map((row) => row.group_id));
  return true;
}

/** Delete one batch of replaced versions and tidy their Trash groups. */
async function deleteTrashVersions(tx: Tx, ownerId: string, groupId?: string): Promise<boolean> {
  const scope = groupId ? Prisma.sql`"trash_group_id" = ${groupId}::uuid` : Prisma.sql`"trash_group_id" IS NOT NULL`;
  const deleted = await tx.$queryRaw<Array<{ trash_group_id: string }>>`
    DELETE FROM "drive_version" WHERE "owner_id" = ${ownerId}::uuid AND "replaced_at" IS NOT NULL AND ${scope}
      AND "id" IN (
        SELECT "id" FROM "drive_version" WHERE "owner_id" = ${ownerId}::uuid AND "replaced_at" IS NOT NULL AND ${scope}
        LIMIT ${DRIVE_TRASH_BATCH} FOR UPDATE
      )
    RETURNING "trash_group_id"`;
  await deleteEmptyGroups(tx, ownerId, deleted.map((row) => row.trash_group_id));
  return deleted.length > 0;
}

/** An entry a folder's trash marked, as its UPDATE answers it. */
interface MarkedRow {
  id: string;
  parent_id: string | null;
  kind: string;
  size_bytes: bigint;
}

/** What marked entries add to their group's counts. */
function countsOf(marked: MarkedRow[]) {
  return {
    itemCount: { increment: marked.length },
    sizeBytes: { increment: marked.reduce((sum, m) => sum + (m.kind === 'FILE' ? BigInt(m.size_bytes) : 0n), 0n) },
  };
}

/**
 * What is live in the folders `from` of a group (null: in any folder of the group, a look over it all), marked into the
 * group, up to `limit` entries. Each batch is picked by a statement of its own, so it sees every create that committed
 * meanwhile, and a create that comes after finds its folder trashed (§1.4); a folder marked joins the open folders, and
 * the open folders are let go once a batch finds fewer than it asked for. Folders are locked before files, as a file
 * rename locks its destination folder before the file. `verified`: a look over the group found nothing live under it.
 */
async function markUnder(
  tx: Tx,
  ownerId: string,
  groupId: string,
  from: string[] | null,
  now: Date,
  limit: number,
): Promise<{ marked: MarkedRow[]; open: string[]; verified: boolean }> {
  const marked: MarkedRow[] = [];
  let open = from;
  while (marked.length < limit) {
    if (open === null) {
      const holding = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT p."id" FROM "drive_entry" p
          JOIN "drive_entry" c ON c."owner_id" = p."owner_id" AND c."parent_id" = p."id" AND c."trashed_at" IS NULL
         WHERE p."owner_id" = ${ownerId}::uuid AND p."trash_group_id" = ${groupId}::uuid AND p."kind" = 'FOLDER'`;
      if (!holding.length) return { marked, open: [], verified: true };
      open = holding.map((h) => h.id);
    }
    if (!open.length) break;
    const want = limit - marked.length;
    const picked = await tx.$queryRaw<Array<{ id: string; kind: string }>>`
      SELECT c."id", c."kind" FROM "drive_entry" c JOIN "drive_entry" p ON p."id" = c."parent_id"
       WHERE c."owner_id" = ${ownerId}::uuid AND c."parent_id" = ANY(${open}::uuid[]) AND c."trashed_at" IS NULL
         AND p."trash_group_id" = ${groupId}::uuid
       LIMIT ${want}`;
    const reached: string[] = [];
    for (const kind of ['FOLDER', 'FILE']) {
      const ids = picked.filter((p) => p.kind === kind).map((p) => p.id);
      if (!ids.length) continue;
      const rows = await tx.$queryRaw<MarkedRow[]>`
        UPDATE "drive_entry"
           SET "trashed_at" = ${now}, "trash_group_id" = ${groupId}::uuid, "trash_top" = false, "updated_at" = ${now}
         WHERE "id" = ANY(${ids}::uuid[]) AND "owner_id" = ${ownerId}::uuid AND "trashed_at" IS NULL
        RETURNING "id", "parent_id", "kind", "size_bytes"`;
      marked.push(...rows);
      if (kind === 'FOLDER') reached.push(...rows.map((r) => r.id));
    }
    open = picked.length < want ? reached : [...open, ...reached];
  }
  return { marked, open: open ?? [], verified: false };
}

/**
 * Entries of a DELETE group hanging in the live folders `from`, out of Trash folder by folder, each folder's in the order
 * they were deleted, until `limit` have come back; a folder that comes back joins the open folders. One whose name a live
 * entry has, or an entry back before it in the same folder had, gets the first free suffix once the others are live
 * (§3.5). A folder that went to Trash again meanwhile is let go: what hangs in it stays in the group. Answers the folders
 * still open.
 */
async function restoreUnder(
  tx: Tx,
  ownerId: string,
  groupId: string,
  from: string[],
  writer: DriveWriter,
  now: Date,
  limit: number,
  changes: ChangeRow[],
  ids: string[],
): Promise<string[]> {
  const open = [...new Set(from)];
  let left = limit;
  while (left > 0 && open.length) {
    const folder = open[0];
    const picked = await tx.$queryRaw<Array<{ id: string; name: string; kind: string; taken: boolean }>>`
      SELECT c."id", c."name", c."kind",
             EXISTS (SELECT 1 FROM "drive_entry" l
                      WHERE l."owner_id" = c."owner_id" AND l."parent_id" = c."parent_id" AND l."name" = c."name"
                        AND l."trashed_at" IS NULL) AS "taken"
        FROM "drive_entry" c JOIN "drive_entry" p ON p."id" = c."parent_id"
       WHERE c."owner_id" = ${ownerId}::uuid AND c."parent_id" = ${folder}::uuid AND c."trash_group_id" = ${groupId}::uuid
         AND p."trashed_at" IS NULL
       ORDER BY c."trashed_at" ASC, c."id" ASC LIMIT ${left}`;
    if (picked.length < left) open.shift();
    left -= picked.length;
    const names = new Set<string>();
    const plain: string[] = [];
    const clashing: typeof picked = [];
    for (const r of picked) {
      if (r.taken || names.has(r.name)) clashing.push(r);
      else {
        names.add(r.name);
        plain.push(r.id);
      }
    }
    const back = { trashedAt: null, trashGroupId: null, trashTop: false, updatedAt: now, ...lastWriterFields(writer, now) };
    if (plain.length) await tx.driveEntry.updateMany({ where: { ownerId, trashGroupId: groupId, id: { in: plain } }, data: back });
    for (const c of clashing) {
      const name = await freeName(tx, ownerId, folder, c.name, c.kind, 'SUFFIX');
      await tx.driveEntry.update({ where: { id: c.id }, data: { ...back, name } });
    }
    for (const r of picked) {
      changes.push({ entryId: r.id, parentId: folder, op: 'UPSERT' });
      ids.push(r.id);
      if (r.kind === 'FOLDER') open.push(r.id);
    }
  }
  return open;
}

/** Every chunk a commit names is this account's to name, with its bytes kept and the size it says (§3.1, §4.4). */
async function assertChunksHeld(tx: Tx, ownerId: string, chunks: DriveChunkRef[]): Promise<void> {
  const wanted = [...new Set(chunks.map((c) => c.sha256))];
  if (!wanted.length) return;
  const held = await tx.$queryRaw<Array<{ sha256: string; size_bytes: number }>>`
    SELECT b."sha256", b."size_bytes" FROM "file_blob" b
     WHERE b."sha256" = ANY(${wanted}::text[]) AND b."bytes_deleted_at" IS NULL
       AND (EXISTS (SELECT 1 FROM "drive_staging_chunk" s WHERE s."sha256" = b."sha256" AND s."owner_id" = ${ownerId}::uuid)
         OR EXISTS (SELECT 1 FROM "drive_version_chunk" v WHERE v."sha256" = b."sha256" AND v."owner_id" = ${ownerId}::uuid))`;
  const sizes = new Map(held.map((h) => [h.sha256, Number(h.size_bytes)]));
  for (const c of chunks) {
    if (sizes.get(c.sha256) !== c.size) {
      throw refusal(HttpStatus.CONFLICT, DRIVE_CHUNK_NOT_HELD, `Chunk ${c.idx} names content this account has not sent; send the chunk first.`, { idx: c.idx });
    }
  }
}

function assertContiguous(chunks: DriveChunkRef[], from: number): void {
  chunks.forEach((c, i) => {
    if (c.idx !== from + i) {
      throw refusal(HttpStatus.BAD_REQUEST, DRIVE_COMMIT_INVALID, `Chunks are numbered from ${from} with no gap; ${c.idx} came where ${from + i} was due.`);
    }
  });
}

function validateCommit(input: DriveCommitInput): void {
  const bad = (message: string) => refusal(HttpStatus.BAD_REQUEST, DRIVE_COMMIT_INVALID, message);
  if (typeof input.commitId !== 'string' || input.commitId.length < 1 || input.commitId.length > 200) throw bad('A commit names a commitId of 1 to 200 characters.');
  if (!['OVERWRITE', 'APPEND', 'CONTINUE'].includes(input.mode)) throw bad('A commit\'s mode is OVERWRITE, APPEND or CONTINUE.');
  if (!Array.isArray(input.chunks)) throw bad('A commit names its chunks.');
  for (const c of input.chunks) {
    if (!Number.isSafeInteger(c.idx) || c.idx < 0 || !/^[0-9a-f]{64}$/.test(c.sha256) || !Number.isSafeInteger(c.size) || c.size < 1 || c.size > DRIVE_CHUNK_MAX) {
      throw bad(`A chunk is { idx, sha256, size } with size 1 to ${DRIVE_CHUNK_MAX}.`);
    }
  }
  if (input.mode === 'APPEND' && !input.baseVersionId) throw bad('An append names the version it was built on.');
}
