import { HttpException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { feishuDerivedUuid, refusalWords } from './feishu-direct.service';
import { FeishuOutbound, feishuDedupeUuid } from './feishu-outbound';
import { credentialsOf, type FeishuOwnerApp } from './feishu-owner.service';
import type { FeishuActor } from './feishu-router';

/** What the bot answers in a connected group (§8.2). English, as every word the bot sends (CLAUDE.md §5). */
export const FEISHU_GROUP_WORK_REPLIES = {
  started: (title: string) => `Started · ${title}`,
  notAllowed: "This group's Orbit connection doesn't take requests from you, so nothing was started. Ask the bot's owner to add you in Orbit.",
  empty: (bot: string) => `Say what you want done after @${bot}, for example: @${bot} fix the failing test.`,
  notLinked: (bot: string) => `This topic isn't linked to an Orbit session. To start one, send "@${bot} <request>" in the group, not in a topic.`,
  notStarted: (reason: string) => `Orbit didn't start a session: ${reason}.`,
  notSent: (reason: string) => `Orbit didn't send this to the session: ${reason}.`,
} as const;

/** The confirmed, switched-on route of the group a mention was sent in (feishu_chat_route, §8.1). */
export interface FeishuGroupRoute {
  ownerId: string;
  chatId: string;
  workspaceId: string;
  permissionMode: string;
  /** Who may send work besides the owner; empty means everyone in the group. */
  allowedOpenIds: string[];
}

/** A mention of the bot in a connected group, as this branch reads it. */
export interface FeishuGroupMention {
  eventId: string;
  chatId: string;
  messageId: string;
  openId: string;
  /** The words with the @mentions dropped; empty for anything that is not text. */
  text: string;
  /** Feishu's root_id: set when the message was sent inside a topic. */
  rootId?: string;
}

/**
 * Work sent from a connected group (docs/feishu-bot-design.md §8.2, decision 4: one topic per request). The router hands
 * here every mention of the bot in a group whose route is confirmed and switched on, other than `connect`.
 *
 *   - A sender who is neither the bot's owner nor on the route's allowed list (when it has one) is answered with one
 *     sentence and nothing is written.
 *   - A top-level mention opens a session through `SessionsService.create` in the route's workspace, in the route's
 *     permission mode, owned by the route's account. The bot answers in a topic on that message (`reply_in_thread`)
 *     with `Started · <title>`, and the message is the root of the session's `feishu_thread`, so every turn's reply goes
 *     back into the topic through the outbox (§7.5). A refusal before the session is written is answered in the topic.
 *   - A mention inside a topic whose root is a session's is a turn of that session through `SessionsService.createTurn`,
 *     with no intent, so the ordinary steer / queue rules apply. A topic no session owns is answered and starts nothing.
 *
 * Handled at least once (§7.1), so every write is keyed on the event, as in feishu-direct.service.ts: the session's id
 * from the app and the message, a turn's clientTurnId from the app and the event, and every reply's Feishu uuid from the
 * message answered. Each new session or turn is recorded once as an activity with credentialKind=FEISHU (§7.2).
 */
@Injectable()
export class FeishuGroupService {
  private readonly logger = new Logger(FeishuGroupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: FeishuOutbound,
    @Inject(forwardRef(() => SessionsService)) private readonly sessions: SessionsService,
  ) {}

  async handleMention(app: FeishuOwnerApp & { botName: string | null }, actor: FeishuActor, route: FeishuGroupRoute, message: FeishuGroupMention): Promise<void> {
    const inTopic = message.rootId !== undefined && message.rootId !== message.messageId;
    const allowed = (app.ownerOpenId !== null && message.openId === app.ownerOpenId)
      || route.allowedOpenIds.length === 0 || route.allowedOpenIds.includes(message.openId);
    if (!allowed) {
      this.logger.log(`feishu app ${app.appId}: a group request from someone the route does not allow; nothing started`);
      await this.reply(app, message.messageId, 'not-allowed', FEISHU_GROUP_WORK_REPLIES.notAllowed, inTopic);
      return;
    }
    const bot = app.botName ?? 'bot';
    if (message.text === '') {
      await this.reply(app, message.messageId, 'empty', FEISHU_GROUP_WORK_REPLIES.empty(bot), inTopic);
      return;
    }
    if (inTopic) await this.turn(app, actor, route, message, message.rootId!, bot);
    else await this.start(app, actor, route, message);
  }

  /** A top-level mention: a session in the route's workspace and mode, answered in a topic. */
  private async start(app: FeishuOwnerApp, actor: FeishuActor, route: FeishuGroupRoute, message: FeishuGroupMention): Promise<void> {
    const sessionId = feishuDerivedUuid('feishu-group-session', app.appId, message.messageId);
    const find = () => this.prisma.session.findFirst({ where: { id: sessionId, ownerId: route.ownerId }, select: { id: true, title: true } });
    let session = await find();
    if (!session) {
      try {
        const made = await this.sessions.create(
          route.ownerId,
          { workspaceId: route.workspaceId, prompt: message.text, permissionMode: route.permissionMode },
          { id: sessionId, credential: actor.credential },
        );
        session = { id: made.id, title: made.title };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') session = await find();
        if (!session) {
          if (!(error instanceof HttpException)) throw error;
          this.logger.log(`feishu app ${app.appId}: a group session was not started (${error.getStatus()})`);
          await this.reply(app, message.messageId, 'not-started', FEISHU_GROUP_WORK_REPLIES.notStarted(refusalWords(error)), true);
          return;
        }
      }
    }
    const opened = session;
    await withTransactionRetry(this.prisma, async (tx) => {
      if (await this.registerTopic(tx, app, route, message.chatId, message.messageId, opened.id)) {
        await this.recordActivity(tx, route.ownerId, actor, 'feishu.group.session.created', {
          sessionId: opened.id, workspaceId: route.workspaceId, chatId: message.chatId,
        });
      }
    }, loggedRetry(this.logger, 'feishuGroup.start'));
    this.logger.log(`feishu app ${app.appId}: session ${opened.id} started from a group`);
    // Keyed on the message alone, not the words: the title may have been renamed before a second handling.
    await this.reply(app, message.messageId, 'started', FEISHU_GROUP_WORK_REPLIES.started(opened.title), true);
  }

  /** A mention inside a topic: a turn of the topic's session. */
  private async turn(app: FeishuOwnerApp, actor: FeishuActor, route: FeishuGroupRoute, message: FeishuGroupMention, root: string, bot: string): Promise<void> {
    const thread = await this.prisma.feishuThread.findFirst({
      where: { appId: app.appId, ownerId: route.ownerId, chatId: message.chatId, rootMessageId: root },
      select: { sessionId: true },
    });
    if (!thread) {
      await this.reply(app, message.messageId, 'not-linked', FEISHU_GROUP_WORK_REPLIES.notLinked(bot), true);
      return;
    }
    const sessionId = thread.sessionId;
    try {
      await this.sessions.createTurn(route.ownerId, sessionId, { clientTurnId: feishuDerivedUuid('feishu-turn', app.appId, message.eventId), content: message.text }, {
        // Written with the turn, so a replay of this clientTurnId records nothing again.
        onTurnWritten: async (tx, turn) => {
          await this.registerTopic(tx, app, route, message.chatId, root, sessionId);
          await this.recordActivity(tx, route.ownerId, actor, 'feishu.group.session.turn', { sessionId, turnId: turn.id, chatId: message.chatId });
        },
      });
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.logger.log(`feishu app ${app.appId}: a group message was not sent to session ${sessionId} (${error.getStatus()})`);
      await this.reply(app, message.messageId, 'not-sent', FEISHU_GROUP_WORK_REPLIES.notSent(refusalWords(error)), true);
      return;
    }
    this.logger.log(`feishu app ${app.appId}: a group message went to session ${sessionId} as a turn`);
  }

  /** Make the topic `(chatId, root)` session S's, spoken in now; true when this wrote it. A topic is one session's. */
  private async registerTopic(
    tx: Prisma.TransactionClient, app: FeishuOwnerApp, route: FeishuGroupRoute, chatId: string, root: string, sessionId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ inserted: boolean }>>`
      INSERT INTO "feishu_thread" ("id", "owner_id", "app_id", "chat_id", "root_message_id", "session_id")
      VALUES (${feishuDerivedUuid('feishu-thread', app.appId, chatId, root)}::uuid, ${route.ownerId}::uuid, ${app.appId}, ${chatId}, ${root}, ${sessionId}::uuid)
      ON CONFLICT ("app_id", "chat_id", "root_message_id") DO UPDATE
        SET "last_spoken_at" = now(), "updated_at" = now()
        WHERE "feishu_thread"."session_id" = EXCLUDED."session_id"
      RETURNING (xmax = 0) AS "inserted"`;
    return rows[0]?.inserted === true;
  }

  /** The record that this was done from Feishu, by whom, on which message (§7.2). */
  private async recordActivity(tx: Prisma.TransactionClient, ownerId: string, actor: FeishuActor, type: string, payload: Record<string, unknown>): Promise<void> {
    const { appId, openId, messageId } = actor.credential;
    await tx.activity.create({
      data: { actorId: ownerId, type, payload: { ...payload, appId, openId, messageId: messageId ?? null } as Prisma.InputJsonValue, credentialKind: 'FEISHU' },
    });
  }

  private async reply(app: FeishuOwnerApp, messageId: string, purpose: string, words: string, inTopic: boolean): Promise<void> {
    const credentials = credentialsOf(app);
    if (!credentials) return;
    const result = await this.outbound.reply(credentials, messageId, { msgType: 'text', content: { text: words } }, {
      replyInThread: inTopic,
      uuid: feishuDedupeUuid('group-work-reply', app.appId, messageId, purpose),
    });
    if (!result.ok) this.logger.warn(`feishu app ${app.appId}: a group reply was not delivered (code ${result.feishuCode ?? result.status})`);
  }
}
