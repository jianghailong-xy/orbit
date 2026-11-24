import { HttpException, HttpStatus, Injectable, Optional } from '@nestjs/common';
import type { DocumentSync, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * An agent's directory sync into the owner's Documents, as the upload tray shows it
 * (docs/documents-directory-sync-design.md S4, "How the progress gets there"). The runner running `orbit documents sync`
 * opens one row and reports into it at most every two seconds; the owner's Documents page reads the list and re-reads it
 * on `drive.sync`. Nothing here moves a byte: the copy itself goes through the runner drive door like any drive write.
 */

/** A running sync whose runner sent nothing for this long reads as STOPPED. */
export const DOCUMENTS_SYNC_STALE_MS = 2 * 60_000;
/** How long an ended sync is listed. */
export const DOCUMENTS_SYNC_KEEP_MS = 24 * 60 * 60_000;
/** The most failed paths a row keeps; `failedCount` counts them all. */
export const DOCUMENTS_SYNC_FAILED_MAX = 100;
/** The most syncs the tray is sent. */
const DOCUMENTS_SYNC_LIST_MAX = 50;

export type DocumentsSyncStatus = 'CHECKING' | 'UPLOADING' | 'DONE' | 'FAILED' | 'STOPPED';
export const DOCUMENTS_SYNC_STATUSES: readonly DocumentsSyncStatus[] = ['CHECKING', 'UPLOADING', 'DONE', 'FAILED', 'STOPPED'];
const RUNNING: readonly string[] = ['CHECKING', 'UPLOADING'];

export interface DocumentsSyncFailure {
  path: string;
  error: string;
}

/** One sync as the tray reads it (`GET /drive/syncs`). */
export interface DocumentsSyncView {
  id: string;
  status: DocumentsSyncStatus;
  sourceName: string;
  destPath: string;
  destEntryId: string | null;
  session: { id: string; title: string } | null;
  filesSeen: number;
  filesTotal: number | null;
  filesDone: number;
  filesSame: number;
  filesDeleted: number;
  bytesTotal: number | null;
  bytesSent: number;
  currentPath: string | null;
  failed: DocumentsSyncFailure[];
  failedCount: number;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface DocumentsSyncOpen {
  sourceName: string;
  destPath: string;
  sessionId?: string | null;
}

export interface DocumentsSyncReport {
  status: DocumentsSyncStatus;
  filesSeen?: number;
  filesTotal?: number | null;
  filesDone?: number;
  filesSame?: number;
  filesDeleted?: number;
  bytesTotal?: number | null;
  bytesSent?: number;
  currentPath?: string | null;
  destEntryId?: string | null;
  failed?: DocumentsSyncFailure[];
  failedCount?: number;
  error?: string | null;
}

function refusal(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

@Injectable()
export class DocumentsSyncsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  /** A runner starts a sync. The owner's syncs that ended more than a day ago go first, so the table stays small. */
  async open(runner: { id: string; ownerId: string }, input: DocumentsSyncOpen, now = new Date()): Promise<{ id: string }> {
    await this.prisma.documentSync.deleteMany({
      where: { ownerId: runner.ownerId, endedAt: { lt: new Date(now.getTime() - DOCUMENTS_SYNC_KEEP_MS) } },
    });
    // The session is shown to the owner by title, so only one of the owner's own is kept.
    const session = input.sessionId
      ? await this.prisma.session.findFirst({ where: { id: input.sessionId, ownerId: runner.ownerId }, select: { id: true } })
      : null;
    const row = await this.prisma.documentSync.create({
      data: {
        ownerId: runner.ownerId,
        runnerId: runner.id,
        sessionId: session?.id ?? null,
        sourceName: input.sourceName,
        destPath: input.destPath,
        startedAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
    this.realtime?.publishDriveSync(runner.ownerId, row.id);
    return { id: row.id };
  }

  /**
   * The runner's report: the counts as they are now, never a delta, so a lost report costs nothing. Only the runner that
   * opened the sync reports into it, and an ended sync takes no more reports.
   */
  async report(runner: { id: string; ownerId: string }, id: string, input: DocumentsSyncReport, now = new Date()): Promise<{ ok: true }> {
    const ending = !RUNNING.includes(input.status);
    const failed = input.failed?.slice(0, DOCUMENTS_SYNC_FAILED_MAX);
    const data: Prisma.DocumentSyncUpdateManyMutationInput = {
      status: input.status,
      updatedAt: now,
      ...(ending ? { endedAt: now, currentPath: null } : {}),
      ...(input.filesSeen !== undefined ? { filesSeen: input.filesSeen } : {}),
      ...(input.filesTotal !== undefined ? { filesTotal: input.filesTotal } : {}),
      ...(input.filesDone !== undefined ? { filesDone: input.filesDone } : {}),
      ...(input.filesSame !== undefined ? { filesSame: input.filesSame } : {}),
      ...(input.filesDeleted !== undefined ? { filesDeleted: input.filesDeleted } : {}),
      ...(input.bytesTotal !== undefined ? { bytesTotal: input.bytesTotal === null ? null : BigInt(input.bytesTotal) } : {}),
      ...(input.bytesSent !== undefined ? { bytesSent: BigInt(input.bytesSent) } : {}),
      ...(input.currentPath !== undefined && !ending ? { currentPath: input.currentPath } : {}),
      ...(input.destEntryId !== undefined ? { destEntryId: input.destEntryId } : {}),
      ...(failed !== undefined ? { failed: failed as unknown as Prisma.InputJsonValue } : {}),
      ...(input.failedCount !== undefined || failed !== undefined
        ? { failedCount: Math.max(input.failedCount ?? 0, failed?.length ?? 0) }
        : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };
    const { count } = await this.prisma.documentSync.updateMany({
      where: { id, ownerId: runner.ownerId, runnerId: runner.id, endedAt: null },
      data,
    });
    if (count === 0) {
      const row = await this.prisma.documentSync.findFirst({
        where: { id, ownerId: runner.ownerId, runnerId: runner.id },
        select: { endedAt: true },
      });
      if (!row) throw refusal(HttpStatus.NOT_FOUND, 'DOCUMENTS_SYNC_NOT_FOUND', 'No such sync on this runner.');
      throw refusal(HttpStatus.CONFLICT, 'DOCUMENTS_SYNC_ENDED', 'This sync has already ended.');
    }
    this.realtime?.publishDriveSync(runner.ownerId, id);
    return { ok: true };
  }

  /**
   * One sync, whatever its age: what the conversation's sync card reads for the call that started it. Another
   * account's sync is not found, as a sync that never was.
   */
  async get(ownerId: string, id: string, now = new Date()): Promise<DocumentsSyncView> {
    const row = await this.prisma.documentSync.findFirst({ where: { id, ownerId } });
    if (!row) throw refusal(HttpStatus.NOT_FOUND, 'DOCUMENTS_SYNC_NOT_FOUND', 'No such sync.');
    const session = row.sessionId
      ? await this.prisma.session.findFirst({ where: { id: row.sessionId, ownerId }, select: { id: true, title: true } })
      : null;
    return viewOf(row, new Map(session ? [[session.id, session.title]] : []), now);
  }

  /** What the tray shows: running syncs and those that ended in the last day, newest first. */
  async list(ownerId: string, now = new Date()): Promise<{ syncs: DocumentsSyncView[] }> {
    const rows = await this.prisma.documentSync.findMany({
      where: { ownerId, OR: [{ endedAt: null }, { endedAt: { gte: new Date(now.getTime() - DOCUMENTS_SYNC_KEEP_MS) } }] },
      orderBy: { startedAt: 'desc' },
      take: DOCUMENTS_SYNC_LIST_MAX,
    });
    const sessionIds = [...new Set(rows.map((row) => row.sessionId).filter((id): id is string => id !== null))];
    const sessions = sessionIds.length
      ? await this.prisma.session.findMany({ where: { id: { in: sessionIds }, ownerId }, select: { id: true, title: true } })
      : [];
    const titles = new Map(sessions.map((session) => [session.id, session.title]));
    return { syncs: rows.map((row) => viewOf(row, titles, now)) };
  }
}

/** A row as the tray reads it. A running row nothing reported into for DOCUMENTS_SYNC_STALE_MS reads as STOPPED. */
export function viewOf(row: DocumentSync, titles: Map<string, string>, now: Date): DocumentsSyncView {
  const stale = row.endedAt === null && now.getTime() - row.updatedAt.getTime() > DOCUMENTS_SYNC_STALE_MS;
  const title = row.sessionId ? titles.get(row.sessionId) : undefined;
  return {
    id: row.id,
    status: stale ? 'STOPPED' : (row.status as DocumentsSyncStatus),
    sourceName: row.sourceName,
    destPath: row.destPath,
    destEntryId: row.destEntryId,
    session: row.sessionId && title !== undefined ? { id: row.sessionId, title } : null,
    filesSeen: row.filesSeen,
    filesTotal: row.filesTotal,
    filesDone: row.filesDone,
    filesSame: row.filesSame,
    filesDeleted: row.filesDeleted,
    bytesTotal: row.bytesTotal === null ? null : Number(row.bytesTotal),
    bytesSent: Number(row.bytesSent),
    currentPath: stale ? null : row.currentPath,
    failed: Array.isArray(row.failed) ? (row.failed as unknown as DocumentsSyncFailure[]) : [],
    failedCount: row.failedCount,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    endedAt: (row.endedAt ?? (stale ? row.updatedAt : null))?.toISOString() ?? null,
  };
}
