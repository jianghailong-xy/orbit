import { HttpException, HttpStatus, Injectable, Optional } from '@nestjs/common';
import type { DriveSync, Prisma } from '@prisma/client';
import { isSessionExecuting } from '../common/session-working';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { turnStateOf } from '../sessions/session-turn-state';

/**
 * An agent's directory sync into the owner's Drive, as the upload tray shows it
 * (docs/drive-directory-sync-design.md S4, "How the progress gets there"). The runner running `orbit documents sync`
 * opens one row and reports into it at most every two seconds; the owner's Drive page reads the list and re-reads it
 * on `drive.sync`. Nothing here moves a byte: the copy itself goes through the runner drive door like any drive write.
 */

/** A running sync whose runner sent nothing for this long reads as STOPPED. */
export const DRIVE_SYNC_STALE_MS = 2 * 60_000;
/** How long an ended sync is listed, unless it needs handling (NEEDS_HANDLING). */
export const DRIVE_SYNC_KEEP_MS = 24 * 60 * 60_000;
/** The most failed paths a row keeps; `failedCount` counts them all. */
export const DRIVE_SYNC_FAILED_MAX = 100;
/** The most syncs the tray is sent. */
const DRIVE_SYNC_LIST_MAX = 50;

export type DriveSyncStatus = 'CHECKING' | 'UPLOADING' | 'DONE' | 'FAILED' | 'STOPPED';
export const DRIVE_SYNC_STATUSES: readonly DriveSyncStatus[] = ['CHECKING', 'UPLOADING', 'DONE', 'FAILED', 'STOPPED'];
const RUNNING: readonly string[] = ['CHECKING', 'UPLOADING'];

/**
 * A sync that ended with failures nobody has dealt with yet: the Drive page keeps it under "Needs you", so it is neither
 * pruned nor dropped from the list, whatever its age, until the owner clears it or a later clean sync of the same source
 * and destination does.
 */
const NEEDS_HANDLING = {
  endedAt: { not: null },
  handledAt: null,
  OR: [{ failedCount: { gt: 0 } }, { status: 'FAILED' }],
} satisfies Prisma.DriveSyncWhereInput;

export interface DriveSyncFailure {
  path: string;
  error: string;
}

/** One sync as the tray reads it (`GET /drive/syncs`). */
export interface DriveSyncView {
  id: string;
  status: DriveSyncStatus;
  sourceName: string;
  destPath: string;
  destEntryId: string | null;
  /** The session that ran it; `open` while it can take a turn (not ended, stopping or in Trash). */
  session: { id: string; title: string; open: boolean } | null;
  filesSeen: number;
  filesTotal: number | null;
  filesDone: number;
  filesSame: number;
  filesDeleted: number;
  bytesTotal: number | null;
  bytesSent: number;
  currentPath: string | null;
  failed: DriveSyncFailure[];
  failedCount: number;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** When the failures stopped needing the owner; null while they do (or there were none). */
  handledAt: string | null;
  /** The session the failures were handed to, and when. */
  fixSessionId: string | null;
  fixRequestedAt: string | null;
  /** Where that session stands, null with no hand-off. */
  fix: DriveSyncFixState | null;
}

/**
 * The session a sync's failures were handed to: `working` while a turn of it is queued or running and it asks nobody
 * anything; `question` is what it asks the owner, if it does (a pending approval). A hand-off that is not working and
 * not handled is back with the owner.
 */
export interface DriveSyncFixState {
  /** Null when the session is gone. */
  title: string | null;
  working: boolean;
  question: string | null;
}

/** The session columns a sync's two sessions are read with. */
const SESSION_FACTS_SELECT = {
  id: true,
  title: true,
  deletedAt: true,
  cancelRequestedAt: true,
  finishedAt: true,
  turnState: true,
  engineTurnActive: true,
  runningSubagents: true,
  runningBgJobs: true,
} satisfies Prisma.SessionSelect;

type SessionFactsRow = Prisma.SessionGetPayload<{ select: typeof SESSION_FACTS_SELECT }>;

/** A session as a sync's view reads it, with the newest question it has the owner pending. */
export interface DriveSyncSessionFacts extends SessionFactsRow {
  question: string | null;
}

/** Whether a session takes a new turn: what `POST /sessions/:id/turns` refuses as ended or in Trash, it does not. */
export const sessionTakesTurn = (session: Pick<SessionFactsRow, 'deletedAt' | 'cancelRequestedAt' | 'finishedAt'>): boolean =>
  session.deletedAt === null && session.cancelRequestedAt === null && session.finishedAt === null;

/** What a pending approval asks the owner: an AskUserQuestion's first question, or the tool it wants to use. */
function questionOf(approval: { toolName: string; input: Prisma.JsonValue }): string {
  if (approval.toolName === 'AskUserQuestion') {
    const questions = (approval.input as { questions?: Array<{ question?: unknown }> } | null)?.questions;
    const first = Array.isArray(questions) ? questions[0]?.question : undefined;
    if (typeof first === 'string' && first.trim() !== '') return first.trim();
  }
  return `It is waiting for your approval to use ${approval.toolName}.`;
}

function fixStateOf(session: DriveSyncSessionFacts | undefined): DriveSyncFixState {
  if (!session) return { title: null, working: false, question: null };
  const working = sessionTakesTurn(session)
    && session.question === null
    && (turnStateOf(session) === 'QUEUED' || isSessionExecuting(session));
  return { title: session.title, working, question: session.question };
}

export interface DriveSyncOpen {
  sourceName: string;
  destPath: string;
  sessionId?: string | null;
}

export interface DriveSyncReport {
  status: DriveSyncStatus;
  filesSeen?: number;
  filesTotal?: number | null;
  filesDone?: number;
  filesSame?: number;
  filesDeleted?: number;
  bytesTotal?: number | null;
  bytesSent?: number;
  currentPath?: string | null;
  destEntryId?: string | null;
  failed?: DriveSyncFailure[];
  failedCount?: number;
  error?: string | null;
}

function refusal(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

@Injectable()
export class DriveSyncsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  /**
   * A runner starts a sync. The owner's syncs that ended more than a day ago go first, so the table stays small; one
   * that still needs handling stays.
   */
  async open(runner: { id: string; ownerId: string }, input: DriveSyncOpen, now = new Date()): Promise<{ id: string }> {
    await this.prisma.driveSync.deleteMany({
      where: { ownerId: runner.ownerId, endedAt: { lt: new Date(now.getTime() - DRIVE_SYNC_KEEP_MS) }, NOT: NEEDS_HANDLING },
    });
    // The session is shown to the owner by title, so only one of the owner's own is kept.
    const session = input.sessionId
      ? await this.prisma.session.findFirst({ where: { id: input.sessionId, ownerId: runner.ownerId }, select: { id: true } })
      : null;
    const row = await this.prisma.driveSync.create({
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
  async report(runner: { id: string; ownerId: string }, id: string, input: DriveSyncReport, now = new Date()): Promise<{ ok: true }> {
    const ending = !RUNNING.includes(input.status);
    const failed = input.failed?.slice(0, DRIVE_SYNC_FAILED_MAX);
    const data: Prisma.DriveSyncUpdateManyMutationInput = {
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
    const { count } = await this.prisma.driveSync.updateMany({
      where: { id, ownerId: runner.ownerId, runnerId: runner.id, endedAt: null },
      data,
    });
    if (count === 0) {
      const row = await this.prisma.driveSync.findFirst({
        where: { id, ownerId: runner.ownerId, runnerId: runner.id },
        select: { endedAt: true },
      });
      if (!row) throw refusal(HttpStatus.NOT_FOUND, 'DOCUMENTS_SYNC_NOT_FOUND', 'No such sync on this runner.');
      throw refusal(HttpStatus.CONFLICT, 'DOCUMENTS_SYNC_ENDED', 'This sync has already ended.');
    }
    if (ending) await this.handleEarlierFailures(runner.ownerId, id, now);
    this.realtime?.publishDriveSync(runner.ownerId, id);
    return { ok: true };
  }

  /** A sync that ended DONE with nothing failed settles the earlier failures of the same source into the same place. */
  private async handleEarlierFailures(ownerId: string, id: string, now: Date): Promise<void> {
    const row = await this.prisma.driveSync.findFirst({
      where: { id, ownerId },
      select: { status: true, failedCount: true, sourceName: true, destPath: true, startedAt: true },
    });
    if (!row || row.status !== 'DONE' || row.failedCount > 0) return;
    const earlier = await this.prisma.driveSync.findMany({
      where: { ownerId, sourceName: row.sourceName, destPath: row.destPath, startedAt: { lte: row.startedAt }, id: { not: id }, ...NEEDS_HANDLING },
      select: { id: true },
    });
    if (earlier.length === 0) return;
    await this.prisma.driveSync.updateMany({ where: { id: { in: earlier.map((sync) => sync.id) }, handledAt: null }, data: { handledAt: now } });
    for (const sync of earlier) this.realtime?.publishDriveSync(ownerId, sync.id);
  }

  /**
   * The owner has dealt with a sync's failures (the Drive page's Clear): it ages out like any other from now on. Saying
   * it again keeps the first time. Another account's sync is not found.
   */
  async markHandled(ownerId: string, id: string, now = new Date()): Promise<DriveSyncView> {
    const { count } = await this.prisma.driveSync.updateMany({ where: { id, ownerId, handledAt: null }, data: { handledAt: now } });
    const view = await this.get(ownerId, id, now);
    if (count > 0) this.realtime?.publishDriveSync(ownerId, id);
    return view;
  }

  /**
   * One sync, whatever its age: what the conversation's sync card reads for the call that started it. Another
   * account's sync is not found, as a sync that never was.
   */
  async get(ownerId: string, id: string, now = new Date()): Promise<DriveSyncView> {
    const row = await this.prisma.driveSync.findFirst({ where: { id, ownerId } });
    if (!row) throw refusal(HttpStatus.NOT_FOUND, 'DOCUMENTS_SYNC_NOT_FOUND', 'No such sync.');
    return viewOf(row, await this.sessionFacts(ownerId, [row]), now);
  }

  /**
   * What the tray shows: running syncs, those that ended in the last day, and those that still need handling whatever
   * their age, newest first. The last are read on their own, so fifty newer syncs never push one out of the list.
   */
  async list(ownerId: string, now = new Date()): Promise<{ syncs: DriveSyncView[] }> {
    const [recent, unhandled] = await Promise.all([
      this.prisma.driveSync.findMany({
        where: { ownerId, OR: [{ endedAt: null }, { endedAt: { gte: new Date(now.getTime() - DRIVE_SYNC_KEEP_MS) } }] },
        orderBy: { startedAt: 'desc' },
        take: DRIVE_SYNC_LIST_MAX,
      }),
      this.prisma.driveSync.findMany({ where: { ownerId, ...NEEDS_HANDLING }, orderBy: { startedAt: 'desc' }, take: DRIVE_SYNC_LIST_MAX }),
    ]);
    const rows = [...new Map([...recent, ...unhandled].map((row) => [row.id, row])).values()]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const sessions = await this.sessionFacts(ownerId, rows);
    return { syncs: rows.map((row) => viewOf(row, sessions, now)) };
  }

  /**
   * The owner's sessions the rows name, as ran them or as their failures were handed to, each with the newest question
   * it has pending for the owner. Another account's session is not read, so it is named by no title.
   */
  private async sessionFacts(
    ownerId: string,
    rows: ReadonlyArray<Pick<DriveSync, 'sessionId' | 'fixSessionId'>>,
  ): Promise<Map<string, DriveSyncSessionFacts>> {
    const ids = [...new Set(rows.flatMap((row) => [row.sessionId, row.fixSessionId]).filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const fixIds = new Set(rows.map((row) => row.fixSessionId).filter((id): id is string => id !== null));
    const [sessions, approvals] = await Promise.all([
      this.prisma.session.findMany({ where: { id: { in: ids }, ownerId }, select: SESSION_FACTS_SELECT }),
      this.prisma.approval.findMany({
        where: { sessionId: { in: [...fixIds] }, status: 'PENDING', session: { ownerId } },
        orderBy: { createdAt: 'desc' },
        select: { sessionId: true, toolName: true, input: true },
      }),
    ]);
    const questions = new Map<string, string>();
    for (const approval of approvals) if (!questions.has(approval.sessionId)) questions.set(approval.sessionId, questionOf(approval));
    return new Map(sessions.map((session) => [session.id, { ...session, question: questions.get(session.id) ?? null }]));
  }
}

/** A row as the tray reads it. A running row nothing reported into for DRIVE_SYNC_STALE_MS reads as STOPPED. */
export function viewOf(row: DriveSync, sessions: Map<string, DriveSyncSessionFacts>, now: Date): DriveSyncView {
  const stale = row.endedAt === null && now.getTime() - row.updatedAt.getTime() > DRIVE_SYNC_STALE_MS;
  const session = row.sessionId ? sessions.get(row.sessionId) : undefined;
  return {
    id: row.id,
    status: stale ? 'STOPPED' : (row.status as DriveSyncStatus),
    sourceName: row.sourceName,
    destPath: row.destPath,
    destEntryId: row.destEntryId,
    session: session ? { id: session.id, title: session.title, open: sessionTakesTurn(session) } : null,
    filesSeen: row.filesSeen,
    filesTotal: row.filesTotal,
    filesDone: row.filesDone,
    filesSame: row.filesSame,
    filesDeleted: row.filesDeleted,
    bytesTotal: row.bytesTotal === null ? null : Number(row.bytesTotal),
    bytesSent: Number(row.bytesSent),
    currentPath: stale ? null : row.currentPath,
    failed: Array.isArray(row.failed) ? (row.failed as unknown as DriveSyncFailure[]) : [],
    failedCount: row.failedCount,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    endedAt: (row.endedAt ?? (stale ? row.updatedAt : null))?.toISOString() ?? null,
    handledAt: row.handledAt?.toISOString() ?? null,
    fixSessionId: row.fixSessionId,
    fixRequestedAt: row.fixRequestedAt?.toISOString() ?? null,
    fix: row.fixSessionId ? fixStateOf(sessions.get(row.fixSessionId)) : null,
  };
}
