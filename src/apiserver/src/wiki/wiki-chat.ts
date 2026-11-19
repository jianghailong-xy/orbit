import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import {
  WIKI_CHAT_COPY,
  wikiChatFabCounts,
  wikiChatListPage,
  wikiSpaceSettings,
  type WikiChatCreateAnswer,
  type WikiChatList,
  type WikiChatListPage,
  type WikiChatRow,
} from '@orbit/shared';
import type { AuthCredential } from '../common/current-user.decorator';
import { isSessionGenerating } from '../common/session-generating';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalRepoUrl } from '../projects/project-criterion-landing';
import { RealtimeService } from '../realtime/realtime.service';
import { RUNNER_BEATS, runnerIsOnline } from '../runners/runner-presence';
import type { CreateSessionDto } from '../sessions/dto';
import { SessionsService } from '../sessions/sessions.service';
import { cardsOfChats } from './wiki-chat-cards';
import { readWikiChatContext } from './wiki-chat-context';
import { normalizeRepoUrl, WikiRefusalError } from './wiki.service';
import { wikiChatChoices, type WikiChatChoice } from './wiki-workspaces';

/**
 * The wiki chat's user door (contracts/wiki.contract.json `chat`, docs/wiki-contract.md §28.1–§28.3; design
 * docs/wiki-chat-design.md §4–§5): making a chat of a space, and reading the space's chats with where they run.
 *
 * A chat is an ordinary session (`SessionsService.create`), with three things only a chat has: the space it belongs
 * to (`session.wiki_chat_space_id`), a worktree of its own, and origin/main as its SOURCE (SR54). Everything else —
 * title, list, price, approvals, permission mode, the session page, the phone — is a session's.
 *
 * Its own module rather than a part of WikiModule, which injects nothing from Sessions (see wiki.module.ts): this
 * door's create IS a session's, so it is the one wiki door that needs SessionsService.
 *
 * Both routes are the owner's alone. A request with a session header is refused WIKI_OWNER_CHANNEL_ONLY whatever the
 * session (contract `chat.door`): no agent makes a chat or reads where the chats run through here. The create also
 * refuses a personal access token at its guard; the read takes one with wiki:read.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The session columns a chat row and the round button's counts are read from. */
const CHAT_SELECT = {
  id: true,
  title: true,
  status: true,
  engineTurnActive: true,
  createdAt: true,
  updatedAt: true,
  lastTurnAt: true,
  completedAt: true,
} satisfies Prisma.SessionSelect;

type ChatSession = Prisma.SessionGetPayload<{ select: typeof CHAT_SELECT }>;

function refuseActingSession(actingSessionId: string | null, what: string): void {
  if (!actingSessionId) return;
  throw new WikiRefusalError({
    code: 'WIKI_OWNER_CHANNEL_ONLY',
    message: `${what} is the account owner's, through an owner channel with no acting session: a session neither makes `
      + "a wiki chat nor reads where a space's chats run.",
  });
}

@Injectable()
export class WikiChat {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    // `wiki.changed` once the space remembers another workspace, as a binding write publishes it. Global, and
    // defaulted so a spec that builds this by hand need not stub it.
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  /** Another owner's space is the plain 404 every tenancy check answers (contract `refusalRules.notFound`), and one in Trash. */
  private async requireSpace(ownerId: string, spaceId: string) {
    const space = await this.prisma.wikiSpace.findFirst({
      where: { id: spaceId, ownerId, deletedAt: null },
      select: { id: true, repoUrlNorm: true, rootCommitSha: true, settings: true },
    });
    if (!space) throw new NotFoundException('no such wiki space');
    return space;
  }

  /**
   * `POST /api/wiki/spaces/:id/chats` (contract `chat.create`): `{ workspaceId?, content, clientTurnId, wikiContext?,
   * attachmentIds?, engine?, model?, permissionMode?, effort?, fastMode? }`.
   *
   * The workspace is the one named — which must be one the space's chats may run in, and which the space then
   * remembers (Runs in) — or else the one the space remembers; with neither, 400 says to choose one. No default is
   * worked out (contract `chat.workspace.choose`): the workspace a space's sessions last ran in could carry the chat
   * onto a production machine. An offline machine is no reason to move: the chat is made and waits for its runner.
   *
   * The first message's pictures and files (board 43): `attachmentIds` are uploads of the owner's not yet used by any
   * session (`POST /api/attachments` with none named), held to that as a new session's are; they join the first turn
   * in the transaction that files it (`SessionsService.writeChat`). The model, effort, speed and mode are the ones the
   * composer's toolbar shows, each defaulting as a session of that workspace does.
   */
  async create(
    ownerId: string,
    spaceId: string,
    body: unknown,
    actingSessionId: string | null,
    credential?: AuthCredential,
  ): Promise<WikiChatCreateAnswer> {
    refuseActingSession(actingSessionId, 'making a wiki chat');
    const input = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (typeof input.content !== 'string' || input.content.trim() === '') {
      throw new BadRequestException("content is the owner's first message, and it has to say something");
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
    const attachmentIds = input.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== 'string' || id === '')) {
      throw new BadRequestException('attachmentIds must be a list of the ids of files the owner uploaded');
    }
    const wikiContext = readWikiChatContext(input.wikiContext);
    const space = await this.requireSpace(ownerId, spaceId);
    const remembered = wikiSpaceSettings(space.settings).chat.workspaceId;
    const choices = await wikiChatChoices(this.prisma, ownerId, space);
    const named = typeof input.workspaceId === 'string' && input.workspaceId !== '' ? input.workspaceId : null;
    const chosen = await this.chosenWorkspace(ownerId, choices, named ?? remembered, named !== null);
    const repoUrl = chosen.repoUrl ? canonicalRepoUrl(chosen.repoUrl) : null;
    if (!repoUrl) {
      throw new ConflictException(
        'Orbit does not know which repository this workspace\'s folder is on yet, and a wiki chat starts from main as '
          + 'that repository\'s origin has it. Its runner reads the folder\'s remote when it next looks at it.',
      );
    }
    const onTheSpacesRepository = space.repoUrlNorm !== null && normalizeRepoUrl(chosen.repoUrl!) === space.repoUrlNorm;
    const dto: CreateSessionDto = {
      prompt: input.content,
      workspaceId: chosen.id,
      ...(typeof input.engine === 'string' ? { engine: input.engine } : {}),
      ...(typeof input.model === 'string' ? { model: input.model } : {}),
      ...(typeof input.permissionMode === 'string' ? { permissionMode: input.permissionMode } : {}),
      ...(typeof input.effort === 'string' ? { effort: input.effort } : {}),
      ...(typeof input.fastMode === 'boolean' ? { fastMode: input.fastMode } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds: attachmentIds as string[] } : {}),
    } as CreateSessionDto;
    const session = await this.sessions.create(ownerId, dto, {
      credential,
      openedBy: 'WIKI_CHAT',
      wikiChat: {
        spaceId: space.id,
        clientTurnId: input.clientTurnId,
        wikiContext,
        repository: { repoUrl, rootCommitSha: onTheSpacesRepository ? space.rootCommitSha : null },
      },
    });
    // Remembered once the chat is made (contract `chat.create.rules`): a create refused for any reason above leaves
    // the space's choice as it was. One statement, which merges the key over the settings as they stand.
    if (chosen.id !== remembered) {
      await this.prisma.$executeRaw`
        UPDATE "wiki_space"
           SET "settings" = "settings" || jsonb_build_object('chat', jsonb_build_object('workspaceId', ${chosen.id}::text)),
               "updated_at" = now()
         WHERE "id" = ${space.id}::uuid AND "owner_id" = ${ownerId}::uuid`;
      this.realtime?.publishWikiChanged(ownerId, space.id);
    }
    const created = await this.prisma.session.findUniqueOrThrow({ where: { id: session.id }, select: CHAT_SELECT });
    return { sessionId: created.id, chat: chatRow(created, 0, 0, created.status === RunStatus.PENDING || isSessionGenerating(created)) };
  }

  /**
   * The workspace a create runs in, or the refusal: one the space's chats may not run in is a 400 that says why, and
   * one that is not the owner's at all the plain 404. Nothing named and nothing remembered — or a remembered one that
   * stopped being eligible, which is neither used nor replaced — is the 400 that asks the owner to choose.
   */
  private async chosenWorkspace(
    ownerId: string,
    choices: WikiChatChoice[],
    workspaceId: string | null,
    named: boolean,
  ): Promise<WikiChatChoice> {
    const chosen = workspaceId ? choices.find((choice) => choice.id === workspaceId) : undefined;
    if (chosen) return chosen;
    if (!named) {
      throw new BadRequestException(`${WIKI_CHAT_COPY.panel.chooseWorkspace}: name a workspaceId among the space's choices`);
    }
    const owned = await this.prisma.workspace.findFirst({ where: { id: workspaceId!, ownerId }, select: { id: true } });
    if (!owned) throw new NotFoundException('no such workspace');
    throw new BadRequestException(
      "this space's chats run only in a workspace of the space that runs its sessions in worktrees of their own: "
        + 'a chat never runs in a shared checkout',
    );
  }

  /**
   * `GET /api/wiki/spaces/:id/chats` (contract `chat.list`): the remembered workspace as it stands, every workspace
   * the chats may run in, the round button's three counts over every chat of the space not in Trash — its approvals and
   * questions, and its cards (`wiki-chat-cards.ts`) — and one page of the chats (`chat.list.page`): those whose title
   * holds `q`, the one last spoken in first, each with its cards and its share of needsYou.
   */
  async list(ownerId: string, spaceId: string, actingSessionId: string | null, page: WikiChatListPage = {}): Promise<WikiChatList> {
    refuseActingSession(actingSessionId, "reading where a space's chats run");
    const space = await this.requireSpace(ownerId, spaceId);
    const remembered = wikiSpaceSettings(space.settings).chat.workspaceId;
    const choices = await wikiChatChoices(this.prisma, ownerId, space);
    const chats = await this.prisma.session.findMany({
      where: { ownerId, wikiChatSpaceId: space.id, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: CHAT_SELECT,
    });
    const open = (chat: ChatSession) => OPEN_SESSION_STATUSES.includes(chat.status);
    // What an open chat waits on the owner for, as the session list counts it — the same rows, read by the same reader.
    const listed = await this.sessions.listRowsByIds(ownerId, chats.filter(open).map((chat) => chat.id));
    const approvals = new Map(listed.map((row) => [row.id, row.pendingApprovals ?? 0]));
    // Every card of the space's chats not in Trash (contract `chat.fab.counts`), each read as its card read says it.
    const cards = await cardsOfChats(this.prisma, ownerId, chats.map((chat) => chat.id));
    const counted = chats.map((chat) => ({
      chat,
      open: open(chat),
      approvals: open(chat) ? (approvals.get(chat.id) ?? 0) : 0,
      cards: cards.get(chat.id) ?? [],
    }));
    const fabOf = (one: (typeof counted)[number]) => ({
      open: one.open,
      turnActive: one.chat.status === RunStatus.PENDING || isSessionGenerating(one.chat),
      approvals: one.approvals,
      cards: one.cards,
    });
    const fab = wikiChatFabCounts(counted.map(fabOf));
    return {
      spaceId: space.id,
      workspace: await this.rememberedWorkspace(ownerId, remembered, choices),
      choices: choices.map(({ id, name, runner, online }) => ({ id, name, runner, online })),
      fab,
      ...wikiChatListPage(
        counted.map((one) => chatRow(one.chat, wikiChatFabCounts([fabOf(one)]).needsYou, one.cards.length, fabOf(one).turnActive)),
        page,
      ),
    };
  }

  /** The remembered workspace as it stands now: eligible when it is one of the choices, and shown either way. */
  private async rememberedWorkspace(ownerId: string, workspaceId: string | null, choices: WikiChatChoice[]): Promise<WikiChatList['workspace']> {
    if (!workspaceId) return null;
    const choice = choices.find((candidate) => candidate.id === workspaceId);
    if (choice) return { id: choice.id, name: choice.name, runner: choice.runner, online: choice.online, eligible: true };
    const row = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, ownerId },
      select: { id: true, name: true, runner: { select: { name: true, displayName: true, status: true, ...RUNNER_BEATS } } },
    });
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      runner: row.runner?.displayName || row.runner?.name || null,
      online: runnerIsOnline(row.runner),
      eligible: false,
    };
  }
}

/** One chat as the list names it (contract `chat.list.chats`): how many cards it holds, and how much of `needsYou` is its. */
function chatRow(chat: ChatSession, needsYou: number, drafts = 0, working = false): WikiChatRow {
  return {
    sessionId: chat.id,
    title: chat.title,
    status: chat.status,
    open: OPEN_SESSION_STATUSES.includes(chat.status),
    completed: chat.completedAt !== null,
    working,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    lastActiveAt: (chat.lastTurnAt ?? chat.createdAt).toISOString(),
    drafts,
    needsYou,
  };
}
