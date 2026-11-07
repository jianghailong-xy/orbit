import { createHash, createHmac, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { FeishuChatRoute as FeishuChatRouteRow } from '@prisma/client';
import {
  FEISHU_CHAT_BOT_REMOVED,
  FEISHU_CHAT_BOT_REMOVED_MESSAGE,
  FEISHU_CHAT_NOT_FOUND_MESSAGE,
  FEISHU_CHAT_TICKET_INVALID,
  FEISHU_CHAT_TICKET_INVALID_MESSAGE,
  FEISHU_CHAT_TICKET_TTL_MINUTES,
  FEISHU_CONNECT_GROUP_PATH,
  type FeishuChatChange,
  type FeishuChatConfirm,
  type FeishuChatDisabledReason,
  type FeishuChatRoute,
  type FeishuChatRoutes,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { renderConnectGroupCard } from './cards/feishu-cards';
import { FeishuOutbound, feishuDedupeUuid } from './feishu-outbound';
import { credentialsOf, type FeishuOwnerApp } from './feishu-owner.service';

/** What the bot answers in a group (§8.1). English, as every word the bot sends (CLAUDE.md §5). */
export const FEISHU_GROUP_REPLIES = {
  /** `connect` from anyone but the owner. */
  strangerConnect: 'Only the owner of this bot can connect this group to Orbit.',
  /** `connect` in a group with people from another organization. */
  external: 'Orbit connects only groups inside your organization. This group has members from other organizations.',
  /** `connect` when Feishu would not say what the group is. */
  unreadable:
    "Orbit couldn't read this group's information from Feishu. Check that the app has the im:chat:readonly permission, then try again.",
  /** A mention in a group that was never connected, or whose connection was never confirmed (§8.1). */
  notConnected: (bot: string) =>
    `This group isn't connected to Orbit, so nothing was started. The bot's owner can connect it by sending "@${bot} connect" here.`,
  /** A mention in a connected group that is switched off. */
  switchedOff: (bot: string) =>
    `This group's connection to Orbit is switched off, so nothing was started. The bot's owner can switch it back on in Orbit, or send "@${bot} connect" here.`,
} as const;

/** The app as the router read it, with the bot's name for the replies. */
export type FeishuChatApp = FeishuOwnerApp & { botName: string | null };

/** A message in a group that @-mentions the bot. `text` is empty for anything but text. */
export interface FeishuGroupMessage {
  eventId: string;
  chatId: string;
  messageId: string;
  openId: string;
  text: string;
}

/** The SHA-256 a ticket is stored as. */
export const hashChatTicket = (ticket: string): string => createHash('sha256').update(ticket).digest('hex');

/**
 * The ticket an event issues: derived from the app, the event and this server's PROVIDER_SECRET_KEY, so the same event
 * processed again issues the same ticket — and the same card — while nobody without the key can derive one.
 */
export function chatTicketFor(appId: string, eventId: string): string {
  const key = createHash('sha256').update(`feishu-chat-ticket:${process.env.PROVIDER_SECRET_KEY ?? ''}`).digest();
  return createHmac('sha256', key).update(`${appId}\n${eventId}`).digest('base64url').slice(0, 43);
}

/** Where the card's button goes: Orbit's confirm page, with the ticket. */
function confirmUrl(ticket: string): string {
  const origin = (process.env.PUBLIC_ORIGIN?.trim() || 'http://localhost:2086').replace(/\/+$/, '');
  return `${origin}${FEISHU_CONNECT_GROUP_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

function present(row: FeishuChatRouteRow): FeishuChatRoute {
  return {
    id: row.id,
    chatId: row.chatId,
    chatName: row.chatName,
    workspaceId: row.workspaceId ?? '',
    permissionMode: row.permissionMode ?? '',
    allowedOpenIds: row.allowedOpenIds,
    maxConcurrentSessions: row.maxConcurrentSessions,
    sessionsPerDay: row.sessionsPerDay,
    enabled: row.enabled,
    disabledReason: (row.disabledReason as FeishuChatDisabledReason | null) ?? null,
    confirmedAt: (row.confirmedAt ?? row.createdAt).toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Group chats connected to Orbit (docs/feishu-bot-design.md §8.1, §8.3; `feishu_chat_route`, migration 0496).
 *
 * The owner sends `@<bot> connect` in a group (`handleGroupMessage`). From anyone else it is refused with one sentence and
 * writes nothing; a group with members from another organization, or one Feishu will not describe, likewise. Otherwise the
 * group's row is made, or found, holding a one-time ticket bound to the owner's open_id and the group, and the bot answers
 * with a card whose button opens Orbit's confirm page. The ticket is derived from the event (`chatTicketFor`), and the row
 * is not touched again by the event that already issued its ticket, so the same event processed twice issues one ticket,
 * one card (Feishu's uuid), and never reopens a ticket that was used.
 *
 * Confirming (`confirm`, an owner-channel route: a personal access token is refused) writes the workspace, the permission
 * mode, the allowed senders and the limits, switches the route on and clears the ticket, in one conditional UPDATE: a
 * ticket works once, within FEISHU_CHAT_TICKET_TTL_MINUTES, and only while the open_id it was issued to is still the app's
 * owner. Until then, and while a confirmed route is off, a mention in the group starts nothing and is answered with one
 * sentence. The bot removed from the group (`botRemoved`) switches its route off.
 */
@Injectable()
export class FeishuChatRouteService {
  private readonly logger = new Logger(FeishuChatRouteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: FeishuOutbound,
  ) {}

  /** A group message that @-mentions the bot: `connect`, or anything else in a group that cannot run it. */
  async handleGroupMessage(app: FeishuChatApp, message: FeishuGroupMessage): Promise<void> {
    if (message.text.trim().toLowerCase() === 'connect') {
      await this.connect(app, message);
      return;
    }
    const route = await this.prisma.feishuChatRoute.findUnique({
      where: { appId_chatId: { appId: app.appId, chatId: message.chatId } },
      select: { confirmedAt: true, enabled: true },
    });
    const bot = app.botName ?? 'bot';
    if (!route?.confirmedAt) {
      this.logger.log(`feishu app ${app.appId}: a mention in a group that is not connected; nothing started`);
      await this.replyText(app, message.messageId, FEISHU_GROUP_REPLIES.notConnected(bot));
      return;
    }
    if (!route.enabled) {
      this.logger.log(`feishu app ${app.appId}: a mention in a group whose connection is off; nothing started`);
      await this.replyText(app, message.messageId, FEISHU_GROUP_REPLIES.switchedOff(bot));
      return;
    }
    // A connected group's requests are F3-2's (§8.2).
    this.logger.log(`feishu app ${app.appId}: a mention in a connected group`);
  }

  private async connect(app: FeishuChatApp, message: FeishuGroupMessage): Promise<void> {
    if (!app.ownerOpenId || message.openId !== app.ownerOpenId) {
      this.logger.log(`feishu app ${app.appId}: connect sent in a group by someone other than the owner, refused`);
      await this.replyText(app, message.messageId, FEISHU_GROUP_REPLIES.strangerConnect);
      return;
    }
    const credentials = credentialsOf(app);
    if (!credentials) return;
    const chat = await this.outbound.chatInfo(credentials, message.chatId);
    if (!chat) {
      await this.replyText(app, message.messageId, FEISHU_GROUP_REPLIES.unreadable);
      return;
    }
    if (chat.external) {
      this.logger.log(`feishu app ${app.appId}: connect sent in an external group, refused`);
      await this.replyText(app, message.messageId, FEISHU_GROUP_REPLIES.external);
      return;
    }
    const ticket = chatTicketFor(app.appId, message.eventId);
    const expiresAt = new Date(Date.now() + FEISHU_CHAT_TICKET_TTL_MINUTES * 60_000);
    // One statement: the group's row made or given this ticket — unless this very event already gave it one, which
    // may since have been used.
    await this.prisma.$executeRaw`
      INSERT INTO "feishu_chat_route"
        ("id", "owner_id", "app_id", "chat_id", "chat_name", "ticket_hash", "ticket_open_id", "ticket_event_id", "ticket_expires_at", "updated_at")
      VALUES (${randomUUID()}::uuid, ${app.ownerId}::uuid, ${app.appId}, ${message.chatId}, ${chat.name}, ${hashChatTicket(ticket)},
              ${message.openId}, ${message.eventId}, ${expiresAt}::timestamptz, now())
      ON CONFLICT ("app_id", "chat_id") DO UPDATE SET
        "chat_name" = COALESCE(EXCLUDED."chat_name", "feishu_chat_route"."chat_name"),
        "ticket_hash" = EXCLUDED."ticket_hash",
        "ticket_open_id" = EXCLUDED."ticket_open_id",
        "ticket_event_id" = EXCLUDED."ticket_event_id",
        "ticket_expires_at" = EXCLUDED."ticket_expires_at",
        "updated_at" = now()
      WHERE "feishu_chat_route"."ticket_event_id" IS DISTINCT FROM EXCLUDED."ticket_event_id"`;
    this.logger.log(`feishu app ${app.appId} of account ${app.ownerId}: the owner asked to connect a group; card sent`);
    const card = renderConnectGroupCard(chat.name, confirmUrl(ticket), FEISHU_CHAT_TICKET_TTL_MINUTES);
    const sent = await this.outbound.reply(credentials, message.messageId, { msgType: 'interactive', content: card }, {
      uuid: feishuDedupeUuid('connect-card', app.appId, message.messageId),
    });
    if (!sent.ok) this.logger.warn(`feishu app ${app.appId}: the connect card was not delivered (code ${sent.feishuCode ?? sent.status})`);
  }

  /** `im.chat.member.bot.deleted_v1` (§8.1): the group's route is switched off, and any live ticket stops working. */
  async botRemoved(appId: string, chatId: string): Promise<void> {
    if (!chatId) return;
    const changed = await this.prisma.$executeRaw`
      UPDATE "feishu_chat_route"
      SET "enabled" = false,
          "disabled_reason" = CASE WHEN "confirmed_at" IS NULL THEN NULL ELSE 'BOT_REMOVED' END,
          "ticket_hash" = NULL, "ticket_open_id" = NULL, "ticket_expires_at" = NULL,
          "updated_at" = now()
      WHERE "app_id" = ${appId} AND "chat_id" = ${chatId}
        AND ("enabled" OR "ticket_hash" IS NOT NULL OR ("confirmed_at" IS NOT NULL AND "disabled_reason" IS DISTINCT FROM 'BOT_REMOVED'))`;
    if (changed > 0) this.logger.log(`feishu app ${appId}: the bot was removed from a group; its route is off`);
  }

  /** `GET /integrations/feishu/chats`: the confirmed groups, and the group a live ticket names, when given one. */
  async list(ownerId: string, ticket?: string): Promise<FeishuChatRoutes> {
    const rows = await this.prisma.feishuChatRoute.findMany({
      where: { ownerId, confirmedAt: { not: null } },
      orderBy: [{ confirmedAt: 'desc' }, { id: 'asc' }],
    });
    let pending: FeishuChatRoutes['pending'] = null;
    if (ticket) {
      const row = await this.prisma.feishuChatRoute.findFirst({
        where: { ownerId, ticketHash: hashChatTicket(ticket), ticketExpiresAt: { gt: new Date() } },
        include: { app: { select: { platform: true, appId: true, appSecretEnc: true, ownerOpenId: true } } },
      });
      if (row?.ticketExpiresAt) {
        // Who is in the group, read from Feishu now, for the allowed-senders picker; the owner is always allowed.
        const credentials = credentialsOf(row.app);
        const members = credentials ? await this.outbound.chatMembers(credentials, row.chatId) : null;
        pending = {
          chatId: row.chatId,
          chatName: row.chatName,
          expiresAt: row.ticketExpiresAt.toISOString(),
          connected: row.confirmedAt !== null,
          members: members?.filter((m) => m.openId !== row.app.ownerOpenId) ?? null,
        };
      }
    }
    return { routes: rows.map(present), pending };
  }

  /**
   * `POST /integrations/feishu/chats/confirm` (owner channel): connect the ticket's group with the owner's choices. 404
   * for a workspace that is not the account's; 409 FEISHU_CHAT_TICKET_INVALID for a ticket that is unknown, used,
   * expired, another account's, or issued to an open_id that is no longer the app's owner.
   */
  async confirm(ownerId: string, dto: FeishuChatConfirm): Promise<FeishuChatRoute> {
    const workspace = await this.prisma.workspace.findFirst({ where: { id: dto.workspaceId, ownerId, deletedAt: null }, select: { id: true } });
    if (!workspace) throw new NotFoundException('No such workspace.');
    const app = await this.prisma.feishuApp.findUnique({ where: { ownerId }, select: { appId: true, ownerOpenId: true } });
    const ticketHash = hashChatTicket(dto.ticket);
    const live = app?.ownerOpenId
      ? { ownerId, appId: app.appId, ticketHash, ticketOpenId: app.ownerOpenId, ticketExpiresAt: { gt: new Date() } }
      : null;
    const target = live ? await this.prisma.feishuChatRoute.findFirst({ where: live, select: { id: true } }) : null;
    // The UPDATE is the claim: of two confirms with one ticket, one matches and the other is answered as a used ticket.
    const confirmed = target && live
      ? await this.prisma.feishuChatRoute.updateMany({
        where: { id: target.id, ...live },
        data: {
          workspaceId: workspace.id,
          permissionMode: dto.permissionMode,
          allowedOpenIds: [...new Set(dto.allowedOpenIds)],
          maxConcurrentSessions: dto.maxConcurrentSessions,
          sessionsPerDay: dto.sessionsPerDay,
          enabled: true,
          disabledReason: null,
          confirmedAt: new Date(),
          ticketHash: null,
          ticketOpenId: null,
          ticketExpiresAt: null,
        },
      })
      : { count: 0 };
    if (!target || confirmed.count === 0) {
      throw new ConflictException({ code: FEISHU_CHAT_TICKET_INVALID, message: FEISHU_CHAT_TICKET_INVALID_MESSAGE });
    }
    const row = await this.prisma.feishuChatRoute.findUniqueOrThrow({ where: { id: target.id } });
    this.logger.log(`account ${ownerId} connected a Feishu group to workspace ${workspace.id} (${dto.permissionMode})`);
    return present(row);
  }

  /** `PATCH /integrations/feishu/chats/:id` (owner channel). Switching on a route whose bot left the group is a 409. */
  async change(ownerId: string, id: string, dto: FeishuChatChange): Promise<FeishuChatRoute> {
    const row = await this.prisma.feishuChatRoute.findFirst({ where: { id, ownerId, confirmedAt: { not: null } } });
    if (!row) throw new NotFoundException(FEISHU_CHAT_NOT_FOUND_MESSAGE);
    if (dto.enabled === true && !row.enabled && row.disabledReason === 'BOT_REMOVED') {
      throw new ConflictException({ code: FEISHU_CHAT_BOT_REMOVED, message: FEISHU_CHAT_BOT_REMOVED_MESSAGE });
    }
    const switching = dto.enabled === undefined || dto.enabled === row.enabled ? {} : dto.enabled
      ? { enabled: true, disabledReason: null }
      : { enabled: false, disabledReason: 'OWNER' };
    const { count } = await this.prisma.feishuChatRoute.updateMany({
      where: { id, ownerId, confirmedAt: { not: null } },
      data: {
        ...switching,
        ...(dto.permissionMode !== undefined ? { permissionMode: dto.permissionMode } : {}),
        ...(dto.allowedOpenIds !== undefined ? { allowedOpenIds: [...new Set(dto.allowedOpenIds)] } : {}),
        ...(dto.maxConcurrentSessions !== undefined ? { maxConcurrentSessions: dto.maxConcurrentSessions } : {}),
        ...(dto.sessionsPerDay !== undefined ? { sessionsPerDay: dto.sessionsPerDay } : {}),
      },
    });
    if (count === 0) throw new NotFoundException(FEISHU_CHAT_NOT_FOUND_MESSAGE);
    this.logger.log(`account ${ownerId} changed Feishu group route ${id}`);
    return present(await this.prisma.feishuChatRoute.findUniqueOrThrow({ where: { id } }));
  }

  /** `DELETE /integrations/feishu/chats/:id` (owner channel): the group is no longer connected. */
  async remove(ownerId: string, id: string): Promise<{ removed: true }> {
    const { count } = await this.prisma.feishuChatRoute.deleteMany({ where: { id, ownerId } });
    if (count === 0) throw new NotFoundException(FEISHU_CHAT_NOT_FOUND_MESSAGE);
    this.logger.log(`account ${ownerId} removed Feishu group route ${id}`);
    return { removed: true };
  }

  private async replyText(app: FeishuChatApp, messageId: string, words: string): Promise<void> {
    const credentials = credentialsOf(app);
    if (!credentials) return;
    const result = await this.outbound.reply(credentials, messageId, { msgType: 'text', content: { text: words } }, {
      uuid: feishuDedupeUuid('group-reply', app.appId, messageId, words),
    });
    if (!result.ok) this.logger.warn(`feishu app ${app.appId}: a reply was not delivered (code ${result.feishuCode ?? result.status})`);
  }
}
