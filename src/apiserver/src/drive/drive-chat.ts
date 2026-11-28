import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  DRIVE_CHAT_COPY,
  driveChatListPage,
  type DriveChatCreateAnswer,
  type DriveChatList,
  type DriveChatListPage,
  type DriveChatRow,
  type DriveChatWorkspace,
  type DriveChatWorkspaceFrom,
} from '@orbit/shared';
import type { AuthCredential } from '../common/current-user.decorator';
import { isSessionGenerating } from '../common/session-generating';
import { isHeld } from '../common/session-release';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_BEATS, runnerIsOnline } from '../runners/runner-presence';
import type { CreateSessionDto } from '../sessions/dto';
import { legacySessionStatus, LEGACY_STATUS_SELECT } from '../sessions/session-legacy-words';
import { turnStateOf } from '../sessions/session-turn-state';
import { SessionsService } from '../sessions/sessions.service';
import { readDriveChatContext } from './drive-chat-context';

/**
 * The Drive chat's user door (project "Drive chat: manage files by talking to an agent", board
 * docs/mocks/drive-chat/01-board.html), modelled on the wiki chat's (wiki/wiki-chat.ts): making a chat, and reading the
 * owner's chats with where a new one runs.
 *
 * A Drive chat is an ordinary session (`SessionsService.create`) opened by DRIVE_CHAT (`session.opened_by`), whose first
 * turn — the owner's words under the client's UUID, with the folder they had open and the items they selected as ids —
 * is filed in the transaction that makes it (`SessionsService.writeChat`), as a wiki chat's is. Each of its messages is
 * delivered with an `<orbit_drive_chat>` note (drive-chat-notes.ts). Everything else — title, list, approvals,
 * permission mode, the session page — is a session's.
 *
 * Where it runs (owner Q3 A): the workspace named, else the workspace of the owner's most recent Drive chat, else the
 * account's Orbit Cloud workspace; with none of those, the create is a 400 asking for one.
 *
 * Both routes are the owner's alone: a request with a session header is refused DRIVE_CHAT_OWNER_CHANNEL_ONLY.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The session columns a chat row and the round button's counts are read from. */
const CHAT_SELECT = {
  id: true,
  title: true,
  workspaceId: true,
  ...LEGACY_STATUS_SELECT,
  engineTurnActive: true,
  createdAt: true,
  updatedAt: true,
  lastTurnAt: true,
  completedAt: true,
} satisfies Prisma.SessionSelect;

type ChatSession = Prisma.SessionGetPayload<{ select: typeof CHAT_SELECT }>;

const WORKSPACE_SELECT = {
  id: true,
  name: true,
  runner: { select: { name: true, displayName: true, status: true, ...RUNNER_BEATS } },
} satisfies Prisma.WorkspaceSelect;

type WorkspaceRow = Prisma.WorkspaceGetPayload<{ select: typeof WORKSPACE_SELECT }>;

function refuseActingSession(actingSessionId: string | null, what: string): void {
  if (!actingSessionId) return;
  throw new ForbiddenException({
    code: 'DRIVE_CHAT_OWNER_CHANNEL_ONLY',
    message: `${what} is the account owner's, through an owner channel with no acting session: a session neither makes a `
      + 'Drive chat nor reads the Drive chats.',
  });
}

@Injectable()
export class DriveChat {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * `POST /api/drive/chats`: `{ text, clientTurnId, workspaceId?, folderId?, noFolder?, entryIds?, attachmentIds?, engine?,
   * model?, permissionMode?, effort?, fastMode? }`. `folderId` is the folder the owner has open (null or absent for the
   * top level), `entryIds` the items they selected; both are ids, read at delivery. `noFolder: true` says the owner
   * removed the folder chip: the first turn carries no folder and no selection, as a later message without a
   * driveContext does. The model, effort, speed and mode are the composer's, each defaulting as a session of that
   * workspace does.
   */
  async create(ownerId: string, body: unknown, actingSessionId: string | null, credential?: AuthCredential): Promise<DriveChatCreateAnswer> {
    refuseActingSession(actingSessionId, 'Making a Drive chat');
    const input = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (typeof input.text !== 'string' || input.text.trim() === '') {
      throw new BadRequestException("text is the owner's first message, and it has to say something");
    }
    if (typeof input.clientTurnId !== 'string' || !UUID.test(input.clientTurnId)) {
      throw new BadRequestException('clientTurnId must be a UUID the client made for this message');
    }
    for (const field of ['workspaceId', 'engine', 'model', 'permissionMode', 'effort'] as const) {
      if (input[field] !== undefined && input[field] !== null && typeof input[field] !== 'string') {
        throw new BadRequestException(`${field} must be a string`);
      }
    }
    if (input.fastMode !== undefined && input.fastMode !== null && typeof input.fastMode !== 'boolean') {
      throw new BadRequestException('fastMode must be true or false');
    }
    if (input.noFolder !== undefined && typeof input.noFolder !== 'boolean') {
      throw new BadRequestException('noFolder must be true or false');
    }
    const noFolder = input.noFolder === true;
    if (noFolder && ((input.folderId !== undefined && input.folderId !== null) || input.entryIds !== undefined)) {
      throw new BadRequestException('noFolder sends no folder and no selection: leave folderId and entryIds out with it');
    }
    const attachmentIds = input.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== 'string' || id === '')) {
      throw new BadRequestException('attachmentIds must be a list of the ids of files the owner uploaded');
    }
    const driveContext = noFolder
      ? null
      : readDriveChatContext({
          folderId: input.folderId ?? null,
          ...(input.entryIds !== undefined ? { entryIds: input.entryIds } : {}),
        });
    const named = typeof input.workspaceId === 'string' && input.workspaceId !== '' ? input.workspaceId : null;
    const workspace = named ? await this.ownedWorkspace(ownerId, named) : (await this.defaultWorkspace(ownerId))?.row;
    if (!workspace) {
      throw new BadRequestException({
        code: 'DRIVE_CHAT_WORKSPACE_REQUIRED',
        message: `${DRIVE_CHAT_COPY.chooseWorkspace}: this account has no Drive chat yet and no Orbit Cloud workspace, `
          + 'so name a workspaceId',
      });
    }
    const dto: CreateSessionDto = {
      prompt: input.text,
      workspaceId: workspace.id,
      ...(typeof input.engine === 'string' ? { engine: input.engine } : {}),
      ...(typeof input.model === 'string' ? { model: input.model } : {}),
      ...(typeof input.permissionMode === 'string' ? { permissionMode: input.permissionMode } : {}),
      ...(typeof input.effort === 'string' ? { effort: input.effort } : {}),
      ...(typeof input.fastMode === 'boolean' ? { fastMode: input.fastMode } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds: attachmentIds as string[] } : {}),
    } as CreateSessionDto;
    const session = await this.sessions.create(ownerId, dto, {
      credential,
      openedBy: 'DRIVE_CHAT',
      driveChat: { clientTurnId: input.clientTurnId, driveContext },
    });
    const created = await this.prisma.session.findUniqueOrThrow({ where: { id: session.id }, select: CHAT_SELECT });
    return { sessionId: created.id, chat: chatRow(created, 0, chatTurnActive(created)), workspace: workspaceView(workspace) };
  }

  /**
   * `GET /api/drive/chats?q=&offset=&status=`: the workspace a new chat runs in and where that came from ("Runs in"),
   * the round button's counts over every open chat not in Trash, and one page of the owner's Drive chats — Open first
   * (the ones that need the owner, then the ones working, then the one last spoken in), then Completed — 50 to a page.
   */
  async list(ownerId: string, actingSessionId: string | null, page: DriveChatListPage = {}): Promise<DriveChatList> {
    refuseActingSession(actingSessionId, 'Reading the Drive chats');
    const chats = await this.prisma.session.findMany({
      where: { ownerId, openedBy: 'DRIVE_CHAT', deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: CHAT_SELECT,
    });
    const open = chats.filter((chat) => isHeld(chat));
    // What an open chat waits on the owner for, as the session list counts it — the same rows, read by the same reader.
    const listed = await this.sessions.listRowsByIds(ownerId, open.map((chat) => chat.id));
    const approvals = new Map(listed.map((row) => [row.id, row.pendingApprovals ?? 0]));
    const rows = chats.map((chat) => chatRow(chat, isHeld(chat) ? (approvals.get(chat.id) ?? 0) : 0, chatTurnActive(chat)));
    const counted = rows.filter((row) => row.open);
    const chosen = await this.defaultWorkspace(ownerId);
    return {
      workspace: chosen ? workspaceView(chosen.row) : null,
      workspaceFrom: chosen?.from ?? null,
      fab: { needsYou: counted.reduce((sum, row) => sum + row.needsYou, 0), working: counted.some((row) => row.working) },
      ...driveChatListPage(rows, page),
    };
  }

  /**
   * Where a chat that names no workspace runs (owner Q3 A): the workspace of the owner's most recent Drive chat that is
   * still there, else the account's Orbit Cloud workspace; null when there is neither.
   */
  private async defaultWorkspace(ownerId: string): Promise<{ row: WorkspaceRow; from: DriveChatWorkspaceFrom } | null> {
    const last = await this.prisma.session.findFirst({
      where: { ownerId, openedBy: 'DRIVE_CHAT', workspace: { is: { ownerId, deletedAt: null } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { workspace: { select: WORKSPACE_SELECT } },
    });
    if (last?.workspace) return { row: last.workspace, from: 'LAST_CHAT' };
    const cloud = await this.prisma.managedRunner.findFirst({
      where: { ownerId, desiredState: { not: 'DELETED' }, defaultWorkspace: { is: { deletedAt: null } } },
      select: { defaultWorkspace: { select: WORKSPACE_SELECT } },
    });
    return cloud?.defaultWorkspace ? { row: cloud.defaultWorkspace, from: 'ORBIT_CLOUD' } : null;
  }

  /** A workspace the request named: the owner's and not deleted, or the plain 404. */
  private async ownedWorkspace(ownerId: string, workspaceId: string): Promise<WorkspaceRow> {
    const row = UUID.test(workspaceId)
      ? await this.prisma.workspace.findFirst({ where: { id: workspaceId, ownerId, deletedAt: null }, select: WORKSPACE_SELECT })
      : null;
    if (!row) throw new NotFoundException('no such workspace');
    return row;
  }
}

function workspaceView(row: WorkspaceRow): DriveChatWorkspace {
  return {
    id: row.id,
    name: row.name,
    runner: row.runner?.displayName || row.runner?.name || null,
    online: runnerIsOnline(row.runner),
  };
}

/** A turn of the chat waits for a claim, or the engine is producing output for it. */
function chatTurnActive(chat: ChatSession): boolean {
  return turnStateOf(chat) === 'QUEUED' || isSessionGenerating(chat);
}

function chatRow(chat: ChatSession, needsYou: number, working: boolean): DriveChatRow {
  return {
    sessionId: chat.id,
    title: chat.title,
    status: legacySessionStatus(chat),
    open: isHeld(chat),
    completed: chat.completedAt !== null,
    working,
    needsYou,
    workspaceId: chat.workspaceId,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    lastActiveAt: (chat.lastTurnAt ?? chat.createdAt).toISOString(),
  };
}
