import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import type { ExternalTurnSender } from '../sessions/session-message';
import { sessionTurnStateSql } from '../sessions/session-turn-state';
import { SessionsService } from '../sessions/sessions.service';
import { feishuDerivedUuid, feishuTurnKey, refusalWords } from './feishu-direct.service';
import { FEISHU_GROUP_REPLIES } from './feishu-chat-route.service';
import { FEISHU_OPEN_REPLIES, openSlotStarted, releaseOpenSlot, reserveOpenSlot } from './feishu-open-limits';
import { FeishuOutbound, feishuDedupeUuid } from './feishu-outbound';
import { credentialsOf, type FeishuOwnerApp } from './feishu-owner.service';
import type { FeishuActor } from './feishu-router';

/**
 * What the bot answers in a connected group (§8.2). English, as every word the bot sends (CLAUDE.md §5); and, since
 * everyone in the group reads it, never naming Orbit (§15.1) — the bot's own name aside.
 */
export const FEISHU_GROUP_WORK_REPLIES = {
  started: (title: string) => `Started · ${title}`,
  notAllowed: "This group's connection doesn't take requests from you, so nothing was started. Ask the bot's owner to add you.",
  empty: (bot: string) => `Say what you want done after @${bot}, for example: @${bot} fix the failing test.`,
  notLinked: (bot: string) => `This topic isn't linked to a session. To start one, send "@${bot} <request>" in the group, not in a topic.`,
  notStarted: (reason: string) => `Nothing was started: ${groupReason(reason)}.`,
  notSent: (reason: string) => `This wasn't sent to the session: ${groupReason(reason)}.`,
  busy: (limit: number) =>
    `Nothing was started: this group already has ${sessionsWord(limit)} running, the most its connection allows at a time. Try again when one finishes.`,
  dailyLimit: (limit: number) =>
    `Nothing was started: this group has started ${sessionsWord(limit)} today, the most its connection allows in a day. Try again after midnight UTC.`,
  gone: 'Nothing was started: this group is no longer connected.',
} as const;

/** What a group reads in place of a server's refusal that names Orbit (§15.1). */
export const FEISHU_GROUP_NEUTRAL_REASON = "the bot's owner needs to look into it";

/**
 * A server's refusal as the group reads it (§15.1). Refusals are written for the account owner and may name Orbit, its
 * pages or its tools; one that does is replaced whole by a neutral reason rather than edited, so no half-sentence about
 * Orbit reaches the group.
 */
export function groupReason(reason: string): string {
  return /orbit/i.test(reason) ? FEISHU_GROUP_NEUTRAL_REASON : reason;
}

function sessionsWord(n: number): string {
  return n === 1 ? '1 session' : `${n} sessions`;
}

/**
 * `last_spoken_at` of a topic reserved for a session not made yet (§8.2, F3-4): nobody has spoken in it. The start
 * stamps it with now() once the session exists, and only the start that does so records the activity.
 */
const RESERVED_AT = '1970-01-01T00:00:00Z';
/** How long a reservation whose session never came (the process died mid-start) still holds a slot. */
const RESERVATION_HOLD = '10 minutes';

/**
 * The confirmed, switched-on route of the group a mention was sent in (feishu_chat_route, §8.1) — or, while the bot is
 * open, the app's settings for a group that uses them (§14.2), with `openAccess`.
 */
export interface FeishuGroupRoute {
  ownerId: string;
  chatId: string;
  workspaceId: string;
  permissionMode: string;
  /** Who may send work besides the owner; empty means everyone in the group. */
  allowedOpenIds: string[];
  /**
   * Set for a group with no confirmed connection, served with the app's settings (§14.2): its implicit route is written
   * with a request's slot, named as Feishu gave the group, and its sessions count against the open bot's limits (§14.4).
   */
  openAccess?: { chatName: string | null };
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
 *   - Either way the turn records who sent it (§8.2, migration 0502): 'FEISHU', the sender's open_id and the name Feishu
 *     gives — unless the sender is the bot's owner, whose words are the owner's. Clients draw "From Feishu · <name>",
 *     and the runner tells the agent the message is not the account owner's.
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
    const sender = await this.senderOf(app, message.openId);
    if (inTopic) await this.turn(app, actor, route, message, message.rootId!, bot, sender);
    else await this.start(app, actor, route, message, sender);
  }

  /**
   * Who the turn is from when it is not the account owner (§8.2, sender attribution): a group member, by open_id and
   * the name Feishu gives for them. The bot's owner speaking in a group is the owner, and is no outside sender. The
   * name is read each handling, and a replay's turn keeps the one it was written with.
   */
  private async senderOf(app: FeishuOwnerApp, openId: string): Promise<ExternalTurnSender | undefined> {
    if (app.ownerOpenId !== null && openId === app.ownerOpenId) return undefined;
    const credentials = credentialsOf(app);
    const name = credentials ? await this.outbound.userName(credentials, openId) : null;
    return { source: 'FEISHU', id: openId, name };
  }

  /** A top-level mention: a session in the route's workspace and mode, answered in a topic. */
  private async start(
    app: FeishuOwnerApp & { botName: string | null }, actor: FeishuActor, route: FeishuGroupRoute, message: FeishuGroupMention, sender: ExternalTurnSender | undefined,
  ): Promise<void> {
    const sessionId = feishuDerivedUuid('feishu-group-session', app.appId, message.messageId);
    const open = route.openAccess;
    if (open && !sender) {
      // The app's settings are for other people (§14.2): the owner connects the group to send work from it.
      this.logger.log(`feishu app ${app.appId}: the owner mentioned the bot in a group that is not connected; nothing started`);
      await this.reply(app, message.messageId, 'not-connected', FEISHU_GROUP_REPLIES.notConnected(app.botName ?? 'bot'), false);
      return;
    }
    const slot = { appId: app.appId, chatId: message.chatId, rootMessageId: message.messageId, sessionId };
    const find = () => this.prisma.session.findFirst({ where: { id: sessionId, ownerId: route.ownerId }, select: { id: true, title: true } });
    let session = await find();
    if (!session) {
      const refusal = await withTransactionRetry(this.prisma, (tx) => open
        ? this.reserveOpen(tx, app, route, message, sessionId, open, sender!)
        : this.reserve(tx, app, route, message.chatId, message.messageId, sessionId),
      loggedRetry(this.logger, 'feishuGroup.reserve'));
      if (refusal) {
        this.logger.log(`feishu app ${app.appId}: a group session was not started (over the route's limits)`);
        await this.reply(app, message.messageId, 'over-limit', refusal, true);
        return;
      }
      try {
        const made = await this.sessions.create(
          route.ownerId,
          { workspaceId: route.workspaceId, prompt: message.text, permissionMode: route.permissionMode },
          { id: sessionId, credential: actor.credential, openedBy: 'FEISHU', ...(sender ? { externalSender: sender } : {}) },
        );
        session = { id: made.id, title: made.title };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') session = await find();
        if (!session) {
          // Anything but a refusal fails the inbox attempt, and the next one finds the reservation and uses it.
          if (!(error instanceof HttpException)) throw error;
          if (open) await releaseOpenSlot(this.prisma, slot);
          else await this.release(app, message.chatId, message.messageId, sessionId);
          this.logger.log(`feishu app ${app.appId}: a group session was not started (${error.getStatus()})`);
          await this.reply(app, message.messageId, 'not-started', FEISHU_GROUP_WORK_REPLIES.notStarted(refusalWords(error)), true);
          return;
        }
      }
    }
    const opened = session;
    await withTransactionRetry(this.prisma, async (tx) => {
      if ((open ? await openSlotStarted(tx, slot) : await this.openReserved(tx, app, message.chatId, message.messageId, opened.id))
        || await this.registerTopic(tx, app, route, message.chatId, message.messageId, opened.id)) {
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
  private async turn(
    app: FeishuOwnerApp, actor: FeishuActor, route: FeishuGroupRoute, message: FeishuGroupMention, root: string, bot: string,
    sender: ExternalTurnSender | undefined,
  ): Promise<void> {
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
      await this.sessions.createTurn(route.ownerId, sessionId, { clientTurnId: feishuTurnKey(app.appId, message.eventId), content: message.text }, {
        senderClient: { client: 'feishu' },
        // A group member's message is a person's: the row moves to the top of the list.
        listed: true,
        ...(sender ? { externalSender: sender } : {}),
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

  /**
   * Hold a slot of the route for the session `sessionId` about to be made from message `root`, or say why not (§8.1 the
   * limits, F3-4). Under the route row's lock, so two requests arriving together are counted one after the other: the
   * topic row is written here, before the session, and counts as the session from then on.
   *
   *   - at a time: the route's topics whose session is PENDING or RUNNING (a turn queued or being worked; a session
   *     waiting for its next message, ended or in Trash holds none), and those reserved for a session still being made;
   *   - a day: the route's topics opened since midnight UTC whose session exists or is still being made.
   *
   * A reservation of this very request (the same event handled again) passes as it is. Null when the slot is held.
   */
  private async reserve(
    tx: Prisma.TransactionClient, app: FeishuOwnerApp, route: FeishuGroupRoute, chatId: string, root: string, sessionId: string,
  ): Promise<string | null> {
    const [limits] = await tx.$queryRaw<Array<{ max: number; perDay: number }>>`
      SELECT "max_concurrent_sessions" AS "max", "sessions_per_day" AS "perDay" FROM "feishu_chat_route"
      WHERE "app_id" = ${app.appId} AND "chat_id" = ${chatId} AND "owner_id" = ${route.ownerId}::uuid
        AND "enabled" AND "confirmed_at" IS NOT NULL
      FOR UPDATE`;
    if (!limits) return FEISHU_GROUP_WORK_REPLIES.gone;
    const [mine] = await tx.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS "one" FROM "feishu_thread"
      WHERE "app_id" = ${app.appId} AND "chat_id" = ${chatId} AND "root_message_id" = ${root} AND "session_id" = ${sessionId}::uuid`;
    if (mine) return null;
    const [held] = await tx.$queryRaw<Array<{ running: number; today: number }>>`
      SELECT
        count(*) FILTER (WHERE (s."id" IS NULL AND t."created_at" > now() - ${RESERVATION_HOLD}::interval)
                            OR (${sessionTurnStateSql('s')} IN ('QUEUED', 'IN_FLIGHT') AND s."deleted_at" IS NULL))::int AS "running",
        count(*) FILTER (WHERE t."created_at" >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                           AND (s."id" IS NOT NULL OR t."created_at" > now() - ${RESERVATION_HOLD}::interval))::int AS "today"
      FROM "feishu_thread" t
      LEFT JOIN "session" s ON s."id" = t."session_id" AND s."owner_id" = t."owner_id"
      WHERE t."app_id" = ${app.appId} AND t."chat_id" = ${chatId} AND t."owner_id" = ${route.ownerId}::uuid`;
    if (held!.running >= limits.max) return FEISHU_GROUP_WORK_REPLIES.busy(limits.max);
    if (held!.today >= limits.perDay) return FEISHU_GROUP_WORK_REPLIES.dailyLimit(limits.perDay);
    await tx.$executeRaw`
      INSERT INTO "feishu_thread" ("id", "owner_id", "app_id", "chat_id", "root_message_id", "session_id", "last_spoken_at")
      VALUES (${feishuDerivedUuid('feishu-thread', app.appId, chatId, root)}::uuid, ${route.ownerId}::uuid, ${app.appId}, ${chatId}, ${root},
              ${sessionId}::uuid, ${RESERVED_AT}::timestamptz)
      ON CONFLICT ("app_id", "chat_id", "root_message_id") DO NOTHING`;
    return null;
  }

  /**
   * Hold a slot of the open bot (§14.4) for the session `sessionId` about to be made from a group using the app's
   * settings, and write the group's implicit route with it (§14.2), or say why not. In one transaction, so a request
   * over a limit writes nothing at all; and the route exists before anything reads the session's topic (the cards'
   * `Started by <name> in <group>`, O5).
   *
   *   - The group's route row, when there is one, is locked first: a route the owner switched off meanwhile, or the bot
   *     left, is answered as such.
   *   - `reserveOpenSlot` counts under the app row's lock and writes the topic's row; not open any more, the group is
   *     not connected.
   *   - Then the implicit route: inserted with who used it first (source OPEN_ACCESS, on, unconfirmed), or made one from
   *     a connect that was never confirmed — whose ticket still works, and confirming it gives the group its own
   *     settings. A row already an implicit route, or confirmed, is left as it is, so a replay writes nothing more.
   */
  private async reserveOpen(
    tx: Prisma.TransactionClient, app: FeishuOwnerApp & { botName: string | null }, route: FeishuGroupRoute, message: FeishuGroupMention,
    sessionId: string, open: NonNullable<FeishuGroupRoute['openAccess']>, sender: ExternalTurnSender,
  ): Promise<string | null> {
    const [row] = await tx.$queryRaw<Array<{ enabled: boolean; source: string; confirmed: boolean }>>`
      SELECT "enabled", "source", "confirmed_at" IS NOT NULL AS "confirmed" FROM "feishu_chat_route"
      WHERE "app_id" = ${app.appId} AND "chat_id" = ${message.chatId} AND "owner_id" = ${route.ownerId}::uuid
      FOR UPDATE`;
    if (row && row.source === 'OPEN_ACCESS' && !row.enabled && !row.confirmed) return FEISHU_OPEN_REPLIES.switchedOff;
    const slot = await reserveOpenSlot(tx, {
      appId: app.appId, ownerId: route.ownerId, chatId: message.chatId, rootMessageId: message.messageId, sessionId, openId: message.openId,
    });
    if (!slot.ok) return slot.limit === 'NOT_OPEN' ? FEISHU_GROUP_REPLIES.notConnected(app.botName ?? 'bot') : slot.words;
    await tx.$executeRaw`
      INSERT INTO "feishu_chat_route"
        ("id", "owner_id", "app_id", "chat_id", "chat_name", "source", "enabled", "first_used_by_open_id", "first_used_by_name", "first_used_at", "updated_at")
      VALUES (${randomUUID()}::uuid, ${route.ownerId}::uuid, ${app.appId}, ${message.chatId}, ${open.chatName}, 'OPEN_ACCESS', true,
              ${message.openId}, ${sender.name}, now(), now())
      ON CONFLICT ("app_id", "chat_id") DO UPDATE SET
        "source" = 'OPEN_ACCESS', "enabled" = true, "disabled_reason" = NULL,
        "chat_name" = COALESCE(EXCLUDED."chat_name", "feishu_chat_route"."chat_name"),
        "first_used_by_open_id" = EXCLUDED."first_used_by_open_id", "first_used_by_name" = EXCLUDED."first_used_by_name",
        "first_used_at" = EXCLUDED."first_used_at", "updated_at" = now()
      WHERE "feishu_chat_route"."source" = 'CONNECT' AND "feishu_chat_route"."confirmed_at" IS NULL`;
    return null;
  }

  /** Give back the slot of a session that was refused before it was written: its reservation, never a made session's topic. */
  private async release(app: FeishuOwnerApp, chatId: string, root: string, sessionId: string): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM "feishu_thread" t
      WHERE t."app_id" = ${app.appId} AND t."chat_id" = ${chatId} AND t."root_message_id" = ${root} AND t."session_id" = ${sessionId}::uuid
        AND t."last_spoken_at" = ${RESERVED_AT}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM "session" s WHERE s."id" = t."session_id")`;
  }

  /** Stamp the reserved topic of a session now made as spoken in; true for the one start that does. */
  private async openReserved(tx: Prisma.TransactionClient, app: FeishuOwnerApp, chatId: string, root: string, sessionId: string): Promise<boolean> {
    const stamped = await tx.$executeRaw`
      UPDATE "feishu_thread" SET "last_spoken_at" = now(), "updated_at" = now()
      WHERE "app_id" = ${app.appId} AND "chat_id" = ${chatId} AND "root_message_id" = ${root} AND "session_id" = ${sessionId}::uuid
        AND "last_spoken_at" = ${RESERVED_AT}::timestamptz`;
    return stamped > 0;
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
