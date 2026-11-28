import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthCredential } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import { DriveChat } from './drive-chat';
import { DriveSyncsService, type DriveSyncView } from './drive-syncs.service';

/**
 * A failed sync handed to an agent (board drive-web 01 frame 6, `POST /api/drive/syncs/:id/fix`). The failures go to the
 * session that ran the sync as a new turn, through the session message door's own `createTurn`, because only that
 * session's machine can read the source folder. When that session has ended, or the sync has none, they start a Drive
 * chat on the same workspace instead, through the Drive chat door's own `create`. Either way the sync records the session
 * (`fix_session_id`, `fix_requested_at`), and the activity view lists it under "Agents working on it" while that session
 * works (drive-syncs.service.ts `fix`).
 *
 * `mode: 'retry'` is the activity view's Retry failed: the same hand-off, asking for the failed files to be synced again
 * and nothing more.
 *
 * The owner's alone: a request with a session header is refused, as the Drive chat's create is.
 */

export type DriveSyncFixMode = 'fix' | 'retry';

export interface DriveSyncFixAnswer {
  /** SESSION: a turn on the session that ran the sync. NEW_CHAT: a Drive chat started for it. */
  via: 'SESSION' | 'NEW_CHAT';
  sessionId: string;
  sync: DriveSyncView;
}

function refusal(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

/** At most this many failed paths are written into the message; the rest are counted. */
const LISTED_MAX = 100;

/** The message the agent receives: which sync, what failed and why, and what to do. */
export function driveSyncFixMessage(
  sync: Pick<DriveSyncView, 'sourceName' | 'destPath' | 'status' | 'error' | 'failed' | 'failedCount' | 'session'>,
  mode: DriveSyncFixMode,
  via: DriveSyncFixAnswer['via'],
): string {
  const files = sync.failedCount === 1 ? '1 file' : `${sync.failedCount} files`;
  const lines: string[] = [`Sync ${sync.sourceName} → ${sync.destPath}${sync.failedCount > 0 ? ` · ${sync.failedCount} failed` : ' · failed'}`, ''];
  if (via === 'NEW_CHAT') {
    lines.push(
      sync.session
        ? `The session that ran this sync (“${sync.session.title}”) has ended, so this chat runs on the same workspace in its place.`
        : 'No session ran this sync, so this chat runs on the workspace of the machine that did.',
      '',
    );
  }
  if (sync.status === 'FAILED' && sync.failedCount === 0) {
    lines.push(`The sync stopped before it finished: ${sync.error ?? 'no reason was given'}.`);
    lines.push(mode === 'retry' ? 'Run the same sync again.' : 'Find out why and fix it, then run the same sync again.');
  } else {
    lines.push(
      mode === 'retry'
        ? `${files} failed in this sync. Sync those files again; nothing else needs changing:`
        : `${files} failed in this sync. Find out why and fix them, then sync those files again:`,
    );
    for (const failure of sync.failed.slice(0, LISTED_MAX)) lines.push(`- ${failure.path}: ${failure.error}`);
    const unlisted = sync.failedCount - Math.min(sync.failed.length, LISTED_MAX);
    if (unlisted > 0) lines.push(`and ${unlisted} more not listed here`);
    if (sync.status === 'FAILED' && sync.error) lines.push('', `The sync also stopped before it finished: ${sync.error}.`);
  }
  return lines.join('\n');
}

@Injectable()
export class DriveSyncFix {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly chats: DriveChat,
    private readonly syncs: DriveSyncsService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  async fix(
    ownerId: string,
    id: string,
    body: unknown,
    actingSessionId: string | null,
    credential?: AuthCredential,
  ): Promise<DriveSyncFixAnswer> {
    if (actingSessionId) {
      throw new ForbiddenException({
        code: 'DRIVE_SYNC_FIX_OWNER_CHANNEL_ONLY',
        message: "Handing a sync's failures to an agent is the account owner's, through an owner channel with no acting session.",
      });
    }
    const input = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (input.mode !== undefined && input.mode !== 'fix' && input.mode !== 'retry') {
      throw new BadRequestException('mode is fix (find out why and fix it) or retry (sync the failed files again), or left out for fix');
    }
    const mode: DriveSyncFixMode = input.mode === 'retry' ? 'retry' : 'fix';

    const sync = await this.syncs.get(ownerId, id);
    if (sync.endedAt === null) throw refusal(HttpStatus.CONFLICT, 'DRIVE_SYNC_RUNNING', 'This sync is still running.');
    if (sync.status !== 'FAILED' && sync.failedCount === 0) {
      throw refusal(HttpStatus.CONFLICT, 'DRIVE_SYNC_NOT_FAILED', 'This sync has no failures to fix.');
    }
    if (sync.handledAt !== null) throw refusal(HttpStatus.CONFLICT, 'DRIVE_SYNC_HANDLED', "This sync's failures have been handled.");
    if (sync.fix?.working) {
      throw refusal(HttpStatus.CONFLICT, 'DRIVE_SYNC_FIX_WORKING', 'An agent is already working on these failures.');
    }

    // Claimed first, against the hand-off read above: of two presses at once, one hands the failures over.
    const before = sync.fixRequestedAt === null ? null : new Date(sync.fixRequestedAt);
    const now = new Date();
    const { count } = await this.prisma.driveSync.updateMany({
      where: { id: sync.id, ownerId, handledAt: null, fixRequestedAt: before },
      data: { fixRequestedAt: now },
    });
    if (count === 0) throw refusal(HttpStatus.CONFLICT, 'DRIVE_SYNC_FIX_WORKING', 'These failures were just handed to an agent.');

    let answer: { via: DriveSyncFixAnswer['via']; sessionId: string };
    try {
      answer = (sync.session?.open ? await this.toOwnSession(ownerId, sync, mode) : null)
        ?? await this.toNewChat(ownerId, sync, mode, credential);
    } catch (error) {
      await this.prisma.driveSync.updateMany({ where: { id: sync.id, ownerId, fixRequestedAt: now }, data: { fixRequestedAt: before } });
      throw error;
    }
    await this.prisma.driveSync.updateMany({ where: { id: sync.id, ownerId }, data: { fixSessionId: answer.sessionId } });
    this.realtime?.publishDriveSync(ownerId, sync.id);
    return { ...answer, sync: await this.syncs.get(ownerId, sync.id) };
  }

  /** A turn on the session that ran the sync; null when it ended between the read and the write. */
  private async toOwnSession(ownerId: string, sync: DriveSyncView, mode: DriveSyncFixMode) {
    const sessionId = sync.session!.id;
    try {
      await this.sessions.createTurn(
        ownerId,
        sessionId,
        { clientTurnId: randomUUID(), content: driveSyncFixMessage(sync, mode, 'SESSION'), intent: 'NEXT_TURN' },
        // The owner's own press: the session moves to the top of their list.
        { listed: true },
      );
    } catch (error) {
      if (error instanceof SessionNotSendable) return null;
      throw error;
    }
    return { via: 'SESSION' as const, sessionId };
  }

  /** A Drive chat on the workspace of the session that ran the sync, else one on the machine that ran it. */
  private async toNewChat(ownerId: string, sync: DriveSyncView, mode: DriveSyncFixMode, credential?: AuthCredential) {
    const row = await this.prisma.driveSync.findFirstOrThrow({ where: { id: sync.id, ownerId }, select: { sessionId: true, runnerId: true } });
    const ran = row.sessionId
      ? await this.prisma.session.findFirst({
          where: { id: row.sessionId, ownerId, workspace: { is: { ownerId, deletedAt: null } } },
          select: { workspaceId: true },
        })
      : null;
    const onRunner = ran?.workspaceId
      ? null
      : await this.prisma.workspace.findFirst({
          where: { ownerId, runnerId: row.runnerId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
    const workspaceId = ran?.workspaceId ?? onRunner?.id;
    const created = await this.chats.create(
      ownerId,
      {
        text: driveSyncFixMessage(sync, mode, 'NEW_CHAT'),
        clientTurnId: randomUUID(),
        ...(workspaceId ? { workspaceId } : {}),
        noFolder: true,
      },
      null,
      credential,
    );
    return { via: 'NEW_CHAT' as const, sessionId: created.sessionId };
  }
}
