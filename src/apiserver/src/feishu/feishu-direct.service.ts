import { createHash } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { taskMovesRowWord } from '@orbit/shared';
import { readOwnerDecisionsBySession } from '../projects/owner-decision-signal';
import { orbitUrl } from '../push/feishu-transport';
import { PushService } from '../push/push.service';
import { ownerWordsForAgent } from '../sessions/reply-translation';
import type { ExternalTurnSender } from '../sessions/session-message';
import { SessionsService } from '../sessions/sessions.service';
import { isSlashCommand, translationLanguages } from '../sessions/turn-translation';
import {
  DEFAULT_WORKSPACE_ACTION,
  DIRECT_CARD_MAX_ENTRIES,
  renderStatusCard,
  renderWorkspaceChosenCard,
  renderWorkspacePickerCard,
  type FeishuDirectCard,
} from './cards/feishu-direct-cards';
import { groupReason } from './feishu-group.service';
import { openSlotStarted, releaseOpenSlot, reserveOpenSlot, type FeishuOpenRequest } from './feishu-open-limits';
import { FeishuOutbound, feishuDedupeUuid } from './feishu-outbound';
import { credentialsOf, FeishuOwnerService, type FeishuOwnerApp } from './feishu-owner.service';
import type { FeishuActor } from './feishu-router';

/** What the bot answers the owner's direct messages with (§7.3). English, as every word the bot sends (CLAUDE.md §5). */
export const FEISHU_DIRECT_REPLIES = {
  nonText: 'Only text messages are supported for now.',
  help: [
    'What you can send here:',
    '• A new message starts a session in your default workspace.',
    '• A reply to an alert, or to a session started here, goes to that session as your next message.',
    '• status lists what is waiting on you in Orbit.',
    '• disconnect stops you being the owner of this bot.',
    '• help shows this message.',
  ].join('\n'),
  notLinked: "This message isn't linked to an Orbit session. To start a new session, send a new message rather than a reply.",
  noWorkspace: 'You have no workspace in Orbit yet. Create one in Orbit, then send your message again.',
  started: (title: string, workspace: string) => `Started · ${title} · ${workspace}`,
  notStarted: (reason: string) => `Orbit didn't start a session: ${reason}.`,
  notSent: (reason: string) => `Orbit didn't send this to the session: ${reason}.`,
  workspaceGone: 'That workspace is no longer in Orbit. Send a new message to choose another.',
  workspaceChosen: (name: string) => `Default workspace: ${name}`,
} as const;

/**
 * What the bot answers someone other than the owner in a direct message while it is open (§14.2, task O3). English,
 * and, since the reader is not the account's owner, never naming Orbit (§15.1): a server's refusal is passed through
 * `groupReason`, as in a group. The limits' sentences are FEISHU_OPEN_REPLIES (feishu-open-limits.ts).
 */
export const FEISHU_OPEN_DIRECT_REPLIES = {
  started: (title: string) => `Started · ${title}`,
  notLinked: "This message isn't linked to a session. To start a new session, send a new message rather than a reply.",
  notStarted: (reason: string) => `Nothing was started: ${groupReason(reason)}.`,
  notSent: (reason: string) => `This wasn't sent to the session: ${groupReason(reason)}.`,
} as const;

/** The app as the router read it, with where the owner's new sessions open. */
export interface FeishuDirectApp extends FeishuOwnerApp {
  defaultWorkspaceId: string | null;
  /** "Show Orbit in Feishu" (§15.2): off, the status card has no Open in Orbit. */
  showOrbit: boolean;
}

/** The app as the router read it, with the settings sessions other people open use (§14.1). */
export interface FeishuOpenDirectApp extends FeishuDirectApp {
  openWorkspaceId: string | null;
  openPermissionMode: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** A direct message as this branch reads it from the event (§7.3). Pure; exported for its spec. */
export interface DirectMessage {
  messageId: string;
  chatId: string;
  /** Feishu's root_id and parent_id: set when the message is a reply. */
  rootId?: string;
  parentId?: string;
  /** The words of a text message; null for any other kind (an image, a file, rich text). */
  text: string | null;
}

export function directMessageOf(payload: unknown): DirectMessage | null {
  const message = obj(obj(obj(payload).event).message);
  const messageId = str(message.message_id);
  const chatId = str(message.chat_id);
  if (!messageId || !chatId) return null;
  let text: string | null = null;
  if (str(message.message_type) === 'text') {
    try {
      const words = obj(JSON.parse(str(message.content) ?? '')).text;
      if (typeof words === 'string' && words.trim() !== '') text = words.trim();
    } catch {
      text = null;
    }
  }
  return { messageId, chatId, rootId: str(message.root_id), parentId: str(message.parent_id), text };
}

/** `help` or `status`, matched as the whole message (§7.3); null for anything else. Exported for its spec. */
export function directCommandOf(text: string): 'help' | 'status' | null {
  const word = text.trim().toLowerCase();
  return word === 'help' || word === 'status' ? word : null;
}

/**
 * A UUID derived from why it is made, so the same Feishu event handled twice names the same turn or session (project
 * instruction 15). Shaped as a version-5 UUID. Exported for its spec.
 */
export function feishuDerivedUuid(...why: string[]): string {
  const hex = createHash('sha256').update(JSON.stringify(why)).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The clientTurnId of a turn a Feishu event writes: derived from the app and the event, so the event handled twice
 * names the same turn. Prefixed, never a bare derived UUID: that is the key of a turn Orbit wrote itself
 * (`isOrbitAuthoredTurn`), and these are a person's words — the owner's own in a direct chat, a group member's in a
 * group — which the row, the composer and a withdrawal treat as somebody's, not the platform's.
 */
export function feishuTurnKey(appId: string, eventId: string): string {
  return `feishu:${feishuDerivedUuid('feishu-turn', appId, eventId)}`;
}

/** What a refusal says, as one clause: the words a client would show for it. */
export function refusalWords(error: HttpException): string {
  const body = error.getResponse();
  const said = typeof body === 'string' ? body : obj(body).message;
  const words = Array.isArray(said) ? said.join('; ') : typeof said === 'string' ? said : error.message;
  return words.trim().replace(/[.\s]+$/, '');
}

/**
 * The owner's direct messages (docs/feishu-bot-design.md §7.3; `feishu_thread`, migration 0499). The router hands
 * here only what the owner sent in a direct message, once FeishuOwnerService found it was not an owner code or
 * `disconnect`; and the owner's clicks on the default-workspace picker.
 *
 *   - A reply (the event carries root_id / parent_id) to a message that belongs to session S — an alert card in
 *     `feishu_message`, or a chain in `feishu_thread` — is a turn of S through `SessionsService.createTurn`, exactly as
 *     the iOS banner's Reply sends one: the words alone, no intent. Whatever that refuses (S ended, S in Trash) is
 *     what the App would be told, and the bot answers it. The chain is registered for S, and spoken in now.
 *   - A new message opens a session in the app's default workspace through `SessionsService.create`, with no
 *     permission mode, so the account's default applies (as for a PAT, docs/personal-access-token-design.md §5.1).
 *     The bot answers the message with `Started · <title> · <workspace>`, and the message's chain is S's. Without a
 *     default workspace it answers with a card to choose one, and the click writes `defaultWorkspaceId`. A refusal
 *     before the session is written (no runner, a disabled workspace, a signed-out engine) is answered and nothing is
 *     made.
 *   - `help` and `status` answer; anything that is not text is answered `Only text messages are supported for now.`
 *
 * Handled at least once (§7.1), so every write is keyed on the event: a turn's clientTurnId and a session's id are
 * derived from the app and the message, so a second handling finds what the first wrote; and every reply carries a
 * Feishu uuid derived from the message answered, so the owner gets one. Each new turn or session is recorded as an
 * activity row with credentialKind=FEISHU, the open_id and the message_id (§7.2), once.
 */
@Injectable()
export class FeishuDirectService {
  private readonly logger = new Logger(FeishuDirectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: FeishuOwnerService,
    private readonly outbound: FeishuOutbound,
    @Inject(forwardRef(() => SessionsService)) private readonly sessions: SessionsService,
    @Inject(forwardRef(() => PushService)) private readonly push: PushService,
  ) {}

  /** One direct message from the owner, not an owner code or `disconnect`. */
  async handleMessage(app: FeishuDirectApp, actor: FeishuActor, eventId: string, payload: unknown): Promise<void> {
    const message = directMessageOf(payload);
    if (!message) return;
    if (message.text === null) {
      await this.owner.replyTo(app, message.messageId, FEISHU_DIRECT_REPLIES.nonText);
      return;
    }
    if (message.rootId || message.parentId) {
      await this.reply(app, actor, eventId, message, message.text);
      return;
    }
    const command = directCommandOf(message.text);
    if (command === 'help') {
      await this.owner.replyTo(app, message.messageId, FEISHU_DIRECT_REPLIES.help);
      return;
    }
    if (command === 'status') {
      await this.status(app, message);
      return;
    }
    await this.start(app, actor, message, message.text);
  }

  /**
   * One direct message from someone other than the owner, in the app's availability scope, while the app is open
   * (§14.2, task O3). False when the app is not open after all — switched back to OWNER_ONLY, or its open workspace
   * gone — and nothing was written: the router answers as it does for a closed bot.
   *
   *   - A top-level message opens a session in `open_workspace_id`, in `open_permission_mode`, owned by the account,
   *     whose first turn records the sender (Feishu, the open_id, the name Feishu gives). Before it is made, a slot of
   *     the open bot is held (reserveOpenSlot, §14.4): the message's chain in feishu_thread, with the sender as
   *     `open_access_open_id`. Over a limit nothing is made, and the sender is answered with the limit's sentence. The
   *     bot answers the message with `Started · <title>`, and every turn's last words come back to the chain through the
   *     outbox, as words alone (feishu-outbox.ts).
   *   - A reply in a chain the sender opened is a turn of its session, recording the sender. A reply anywhere else is
   *     answered `notLinked`; nobody else's chain, and no alert card, is reachable from here.
   *   - Anything that is not text is answered as the owner's is. `help`, `status` and `disconnect` are the owner's
   *     commands, and here they are an ordinary message.
   *
   * Keyed on the event as the owner's path is: the session id is derived from the app and the message, a turn's
   * clientTurnId from the app and the event, every reply's Feishu uuid from the message answered. Each new session or
   * turn, and each request refused for a limit, is recorded once as an activity with credentialKind=FEISHU.
   */
  async handleOpenMessage(app: FeishuOpenDirectApp, actor: FeishuActor, eventId: string, payload: unknown): Promise<boolean> {
    const message = directMessageOf(payload);
    if (!message) return false;
    const workspace = app.openWorkspaceId
      ? await this.prisma.workspace.findFirst({ where: { id: app.openWorkspaceId, ownerId: app.ownerId, deletedAt: null }, select: { id: true } })
      : null;
    if (!workspace) return false;
    if (message.text === null) {
      await this.replyText(app, message.messageId, 'non-text', FEISHU_DIRECT_REPLIES.nonText);
      return true;
    }
    if (message.rootId || message.parentId) {
      await this.openReply(app, actor, eventId, message, message.text);
      return true;
    }
    return this.openStart(app, actor, message, message.text, workspace.id);
  }

  /** A top-level message from someone else: a session in the open settings, within the limits (§14.2, §14.4). */
  private async openStart(app: FeishuOpenDirectApp, actor: FeishuActor, message: DirectMessage, text: string, workspaceId: string): Promise<boolean> {
    const openId = actor.credential.openId;
    const sessionId = feishuDerivedUuid('feishu-open-session', app.appId, message.messageId);
    const slot: Omit<FeishuOpenRequest, 'ownerId' | 'openId'> = { appId: app.appId, chatId: message.chatId, rootMessageId: message.messageId, sessionId };
    const find = () => this.prisma.session.findFirst({ where: { id: sessionId, ownerId: app.ownerId }, select: { id: true, title: true } });
    let session = await find();
    if (!session) {
      const held = await withTransactionRetry(this.prisma, async (tx) => {
        const answer = await reserveOpenSlot(tx, { ...slot, ownerId: app.ownerId, openId });
        if (!answer.ok && answer.limit !== 'NOT_OPEN') {
          await this.recordActivityOnce(tx, app.ownerId, actor, 'feishu.open.refused', { chatId: message.chatId, limit: answer.limit, max: answer.max });
        }
        return answer;
      }, loggedRetry(this.logger, 'feishuDirect.openStart'));
      if (!held.ok) {
        if (held.limit === 'NOT_OPEN') return false;
        this.logger.log(`feishu app ${app.appId}: a direct message from someone else started nothing (${held.limit})`);
        await this.replyText(app, message.messageId, 'over-limit', held.words);
        return true;
      }
      const sender: ExternalTurnSender = { source: 'FEISHU', id: openId, name: await this.userName(app, openId) };
      try {
        const made = await this.sessions.create(
          app.ownerId,
          { workspaceId, prompt: text, permissionMode: app.openPermissionMode },
          { id: sessionId, credential: actor.credential, openedBy: 'FEISHU', externalSender: sender },
        );
        session = { id: made.id, title: made.title };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') session = await find();
        if (!session) {
          // Anything but a refusal fails the inbox attempt, and the next one finds the reservation and uses it.
          if (!(error instanceof HttpException)) throw error;
          await releaseOpenSlot(this.prisma, slot);
          this.logger.log(`feishu app ${app.appId}: a session for someone else was not started (${error.getStatus()})`);
          await this.replyText(app, message.messageId, 'not-started', FEISHU_OPEN_DIRECT_REPLIES.notStarted(refusalWords(error)));
          return true;
        }
      }
    }
    const opened = session;
    await withTransactionRetry(this.prisma, async (tx) => {
      if (await openSlotStarted(tx, slot)) {
        await this.recordActivity(tx, app.ownerId, actor, 'feishu.open.session.created', { sessionId: opened.id, workspaceId, chatId: message.chatId });
      }
    }, loggedRetry(this.logger, 'feishuDirect.openStarted'));
    this.logger.log(`feishu app ${app.appId}: session ${opened.id} started from someone else's direct message`);
    await this.replyText(app, message.messageId, 'started', FEISHU_OPEN_DIRECT_REPLIES.started(opened.title));
    return true;
  }

  /** A reply from someone else: a turn of the session whose chain they opened, recording them. */
  private async openReply(app: FeishuOpenDirectApp, actor: FeishuActor, eventId: string, message: DirectMessage, text: string): Promise<void> {
    const openId = actor.credential.openId;
    const roots = [message.rootId, message.parentId].filter((id): id is string => id !== undefined);
    // Only a chain this sender opened in this chat: never the owner's chains, nor an alert card.
    const thread = await this.prisma.feishuThread.findFirst({
      where: { appId: app.appId, ownerId: app.ownerId, chatId: message.chatId, rootMessageId: { in: roots }, openAccessOpenId: openId },
      orderBy: { createdAt: 'desc' },
      select: { sessionId: true, rootMessageId: true },
    });
    if (!thread) {
      await this.replyText(app, message.messageId, 'not-linked', FEISHU_OPEN_DIRECT_REPLIES.notLinked);
      return;
    }
    const { sessionId, rootMessageId } = thread;
    const sender: ExternalTurnSender = { source: 'FEISHU', id: openId, name: await this.userName(app, openId) };
    try {
      await this.sessions.createTurn(app.ownerId, sessionId, { clientTurnId: feishuTurnKey(app.appId, eventId), content: text }, {
        senderClient: { client: 'feishu' },
        // A person's message, as at the owner's own doors: the row moves to the top of the list.
        listed: true,
        externalSender: sender,
        // Written with the turn, so a replay of this clientTurnId records nothing again. The chain is the one the slot
        // was held on, stamped as spoken in; no other chain is written for the session.
        onTurnWritten: async (tx, turn) => {
          await this.registerChain(tx, app, message.chatId, rootMessageId, sessionId);
          await this.recordActivity(tx, app.ownerId, actor, 'feishu.open.session.turn', { sessionId, turnId: turn.id, chatId: message.chatId });
        },
      });
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.logger.log(`feishu app ${app.appId}: someone else's reply was not sent to session ${sessionId} (${error.getStatus()})`);
      await this.replyText(app, message.messageId, 'not-sent', FEISHU_OPEN_DIRECT_REPLIES.notSent(refusalWords(error)));
      return;
    }
    this.logger.log(`feishu app ${app.appId}: someone else's reply went to session ${sessionId} as a turn`);
  }

  /** The name Feishu gives for `openId`, read each handling; a replay's turn keeps the one it was written with. */
  private async userName(app: FeishuOwnerApp, openId: string): Promise<string | null> {
    const credentials = credentialsOf(app);
    return credentials ? this.outbound.userName(credentials, openId) : null;
  }

  /**
   * The owner's click on a card this branch sent: a default-workspace button. The answer Feishu shows at once; null
   * for a click that is not this branch's.
   */
  async handleCardAction(app: FeishuDirectApp, payload: unknown): Promise<unknown | null> {
    const value = obj(obj(obj(obj(payload).event).action).value);
    if (value.kind !== DEFAULT_WORKSPACE_ACTION) return null;
    const workspaceId = str(value.workspaceId);
    // Only a workspace of the app's own account: any other id is answered as one that is gone, and nothing is written.
    const workspace = workspaceId && /^[0-9a-f-]{36}$/i.test(workspaceId)
      ? await this.prisma.workspace.findFirst({ where: { id: workspaceId, ownerId: app.ownerId, deletedAt: null }, select: { id: true, name: true } })
      : null;
    if (!workspace) return { toast: { type: 'error', content: FEISHU_DIRECT_REPLIES.workspaceGone } };
    await this.prisma.feishuApp.updateMany({ where: { appId: app.appId, ownerId: app.ownerId }, data: { defaultWorkspaceId: workspace.id } });
    this.logger.log(`the owner of Feishu app ${app.appId} chose workspace ${workspace.id} as the default`);
    return {
      toast: { type: 'success', content: FEISHU_DIRECT_REPLIES.workspaceChosen(workspace.name) },
      card: { type: 'raw', data: renderWorkspaceChosenCard(workspace.name) },
    };
  }

  /** A reply: a turn of the session its chain belongs to (§7.3, 1). */
  private async reply(app: FeishuDirectApp, actor: FeishuActor, eventId: string, message: DirectMessage, text: string): Promise<void> {
    const root = message.rootId ?? message.parentId!;
    const sessionId = await this.sessionOfChain(app, message);
    if (!sessionId) {
      await this.owner.replyTo(app, message.messageId, FEISHU_DIRECT_REPLIES.notLinked);
      return;
    }
    try {
      // Settings › Translation: the owner's reply reaches the session in the agent language. One that cannot be
      // translated is refused (422 TRANSLATION_FAILED, answered below in the chat) and nothing is written.
      const langs = await translationLanguages(this.prisma, app.ownerId);
      const translation = isSlashCommand(text) ? null : await ownerWordsForAgent(text, langs);
      await this.sessions.createTurn(app.ownerId, sessionId, { clientTurnId: feishuTurnKey(app.appId, eventId), content: text }, {
        ...(translation && langs ? { translated: { content: translation.text, from: langs.owner } } : {}),
        senderClient: { client: 'feishu' },
        // A person's message, as at the owner's own doors: the row moves to the top of the list.
        listed: true,
        // Written with the turn, so a second handling — a replay of this clientTurnId — records nothing again.
        onTurnWritten: async (tx, turn) => {
          await this.registerChain(tx, app, message.chatId, root, sessionId);
          await this.recordActivity(tx, app.ownerId, actor, 'feishu.session.turn', { sessionId, turnId: turn.id });
        },
      });
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.logger.log(`feishu app ${app.appId}: a reply was not sent to session ${sessionId} (${error.getStatus()})`);
      await this.owner.replyTo(app, message.messageId, FEISHU_DIRECT_REPLIES.notSent(refusalWords(error)));
      return;
    }
    this.logger.log(`feishu app ${app.appId}: a reply went to session ${sessionId} as a turn`);
  }

  /**
   * The session a reply's chain belongs to: the chain's root first, then the message replied to — a chain in
   * feishu_thread, or an alert card in feishu_message — always of this app's own account.
   */
  private async sessionOfChain(app: FeishuDirectApp, message: DirectMessage): Promise<string | null> {
    for (const id of [message.rootId, message.parentId]) {
      if (!id) continue;
      const thread = await this.prisma.feishuThread.findFirst({
        where: { appId: app.appId, ownerId: app.ownerId, chatId: message.chatId, rootMessageId: id },
        select: { sessionId: true },
      });
      if (thread) return thread.sessionId;
      const card = await this.prisma.feishuMessage.findFirst({
        where: { appId: app.appId, ownerId: app.ownerId, messageId: id, sessionId: { not: null } },
        select: { sessionId: true },
      });
      if (card?.sessionId) return card.sessionId;
    }
    return null;
  }

  /** A new message: a session in the default workspace, and the receipt (§7.3, 2). */
  private async start(app: FeishuDirectApp, actor: FeishuActor, message: DirectMessage, text: string): Promise<void> {
    const workspace = app.defaultWorkspaceId
      ? await this.prisma.workspace.findFirst({ where: { id: app.defaultWorkspaceId, ownerId: app.ownerId, deletedAt: null }, select: { id: true, name: true } })
      : null;
    if (!workspace) {
      await this.offerWorkspaces(app, message);
      return;
    }
    // Derived from the message, so the same event handled again finds the session the first handling made.
    const sessionId = feishuDerivedUuid('feishu-session', app.appId, message.messageId);
    let session = await this.prisma.session.findFirst({ where: { id: sessionId, ownerId: app.ownerId }, select: { id: true, title: true } });
    if (!session) {
      try {
        // No permissionMode: the account's default applies (§7.2).
        const made = await this.sessions.create(app.ownerId, { workspaceId: workspace.id, prompt: text }, { id: sessionId, credential: actor.credential, openedBy: 'FEISHU' });
        session = { id: made.id, title: made.title };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          session = await this.prisma.session.findFirst({ where: { id: sessionId, ownerId: app.ownerId }, select: { id: true, title: true } });
        }
        if (!session) {
          if (!(error instanceof HttpException)) throw error;
          this.logger.log(`feishu app ${app.appId}: a session was not started (${error.getStatus()})`);
          await this.owner.replyTo(app, message.messageId, FEISHU_DIRECT_REPLIES.notStarted(refusalWords(error)));
          return;
        }
      }
    }
    const opened = session;
    await withTransactionRetry(this.prisma, async (tx) => {
      if (await this.registerChain(tx, app, message.chatId, message.messageId, opened.id)) {
        await this.recordActivity(tx, app.ownerId, actor, 'feishu.session.created', { sessionId: opened.id, workspaceId: workspace.id });
      }
    }, loggedRetry(this.logger, 'feishuDirect.start'));
    this.logger.log(`feishu app ${app.appId}: session ${opened.id} started from a direct message`);
    // Keyed on the message alone, not the words: the title may have been renamed before a second handling.
    await this.replyText(app, message.messageId, 'started', FEISHU_DIRECT_REPLIES.started(opened.title, workspace.name));
  }

  /** No default workspace: a card to choose one, or how to make one. */
  private async offerWorkspaces(app: FeishuDirectApp, message: DirectMessage): Promise<void> {
    const workspaces = await this.prisma.workspace.findMany({
      where: { ownerId: app.ownerId, deletedAt: null, enabled: true },
      // The order the workspace list shows them in (workspaces.service.ts).
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
      take: DIRECT_CARD_MAX_ENTRIES,
      select: { id: true, name: true },
    });
    if (workspaces.length === 0) {
      await this.owner.replyTo(app, message.messageId, FEISHU_DIRECT_REPLIES.noWorkspace);
      return;
    }
    await this.replyCard(app, message.messageId, 'workspace-picker', renderWorkspacePickerCard(workspaces));
  }

  /** `status`: the sessions waiting on the owner, the owner items in them, each with Open in Orbit. */
  private async status(app: FeishuDirectApp, message: DirectMessage): Promise<void> {
    const ids = await this.push.needsYouSessions(app.ownerId);
    const [sessions, decisions] = await Promise.all([
      this.prisma.session.findMany({ where: { id: { in: ids }, ownerId: app.ownerId }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], select: { id: true, title: true } }),
      readOwnerDecisionsBySession(this.prisma, app.ownerId, { sessionIds: ids }),
    ]);
    const entries = sessions.map((s) => ({
      title: s.title,
      ownerItems: [
        ...(decisions.get(s.id)?.ownerItems ?? []).map((item) => item.title),
        ...(decisions.get(s.id)?.ownerRequests ?? []).map((request) => request.title),
        ...(decisions.get(s.id)?.taskMoves ?? []).map((group) => `${taskMovesRowWord(group.count)}: ${group.title}`),
      ],
      url: orbitUrl({ sessionId: s.id }),
    }));
    await this.replyCard(app, message.messageId, 'status', renderStatusCard(entries, app.showOrbit));
  }

  /**
   * Make the chain `(chatId, root)` session S's, spoken in now. True when this wrote the chain; a chain already S's is
   * only stamped. A chain is one session's: one another session holds is left as it is.
   */
  private async registerChain(tx: Prisma.TransactionClient, app: FeishuDirectApp, chatId: string, root: string, sessionId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ inserted: boolean }>>`
      INSERT INTO "feishu_thread" ("id", "owner_id", "app_id", "chat_id", "root_message_id", "session_id")
      VALUES (${feishuDerivedUuid('feishu-thread', app.appId, chatId, root)}::uuid, ${app.ownerId}::uuid, ${app.appId}, ${chatId}, ${root}, ${sessionId}::uuid)
      ON CONFLICT ("app_id", "chat_id", "root_message_id") DO UPDATE
        SET "last_spoken_at" = now(), "updated_at" = now()
        WHERE "feishu_thread"."session_id" = EXCLUDED."session_id"
      RETURNING (xmax = 0) AS "inserted"`;
    return rows[0]?.inserted === true;
  }

  /** The record that this was done from Feishu, by whom, on which message (§7.2). */
  private async recordActivity(tx: Prisma.TransactionClient, ownerId: string, actor: FeishuActor, type: string, payload: Json): Promise<void> {
    const { appId, openId, messageId } = actor.credential;
    await tx.activity.create({
      data: { actorId: ownerId, type, payload: { ...payload, appId, openId, messageId: messageId ?? null } as Prisma.InputJsonValue, credentialKind: 'FEISHU' },
    });
  }

  /**
   * The same record for an act that leaves nothing else behind (a request refused for a limit): its id is derived from
   * the app and the message, so the same event handled again records it once.
   */
  private async recordActivityOnce(tx: Prisma.TransactionClient, ownerId: string, actor: FeishuActor, type: string, payload: Json): Promise<void> {
    const { appId, openId, messageId } = actor.credential;
    await tx.activity.createMany({
      data: [{
        id: feishuDerivedUuid('feishu-activity', type, appId, messageId ?? ''),
        actorId: ownerId, type, payload: { ...payload, appId, openId, messageId: messageId ?? null } as Prisma.InputJsonValue, credentialKind: 'FEISHU',
      }],
      skipDuplicates: true,
    });
  }

  private async replyText(app: FeishuDirectApp, messageId: string, purpose: string, words: string): Promise<void> {
    const credentials = credentialsOf(app);
    if (!credentials) return;
    const result = await this.outbound.reply(credentials, messageId, { msgType: 'text', content: { text: words } }, {
      uuid: feishuDedupeUuid('direct-reply', app.appId, messageId, purpose),
    });
    if (!result.ok) this.logger.warn(`feishu app ${app.appId}: a reply was not delivered (code ${result.feishuCode ?? result.status})`);
  }

  private async replyCard(app: FeishuDirectApp, messageId: string, purpose: string, card: FeishuDirectCard): Promise<void> {
    const credentials = credentialsOf(app);
    if (!credentials) return;
    const result = await this.outbound.reply(credentials, messageId, { msgType: 'interactive', content: card }, {
      uuid: feishuDedupeUuid('direct-card', app.appId, messageId, purpose),
    });
    if (!result.ok) this.logger.warn(`feishu app ${app.appId}: a card reply was not delivered (code ${result.feishuCode ?? result.status})`);
  }
}
