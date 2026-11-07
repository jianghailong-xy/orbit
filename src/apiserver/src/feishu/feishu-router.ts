import { Injectable, Logger } from '@nestjs/common';
import type { AuthCredential } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { FeishuDirectService } from './feishu-direct.service';
import { FEISHU_OWNER_REPLIES, FeishuOwnerService, type FeishuTextMessage } from './feishu-owner.service';

/** Who a Feishu event acts as (docs/feishu-bot-design.md §7.2): always the account its app belongs to. */
export interface FeishuActor {
  userId: string;
  credential: Extract<AuthCredential, { kind: 'FEISHU' }>;
}

/** The branches an event is routed to. */
export type FeishuRoute =
  /** A message in a direct chat with the bot (§7.3). */
  | 'DIRECT_MESSAGE'
  /** A message in a group that @-mentions the bot: the only group messages the app's permissions deliver (§4.2, §8.2). */
  | 'GROUP_MENTION'
  /** A click on a card the bot sent (§7.4). */
  | 'CARD_ACTION'
  /** The bot was removed from a group (§8.1). */
  | 'BOT_REMOVED_FROM_CHAT'
  /** Anything else the app is subscribed to: acknowledged and recorded, never acted on. */
  | 'IGNORED';

/** An inbox row as the router reads it. */
export interface InboundEvent {
  appId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
}

/** What routing one event decided: the branch, and who it acts as; null when its app is gone. */
export interface RouteDecision {
  route: FeishuRoute;
  actor: FeishuActor;
  /** The synchronous answer to a card callback (a toast or a card), returned within Feishu's 3 seconds. */
  answer?: unknown;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The branch, the actor's open_id and the message an event names, from Feishu's envelope. Pure; exported for its spec. */
export function classify(eventType: string, payload: unknown): { route: FeishuRoute; openId: string; messageId?: string } {
  const event = obj(obj(payload).event);
  switch (eventType) {
    case 'im.message.receive_v1': {
      const message = obj(event.message);
      const openId = str(obj(obj(event.sender).sender_id).open_id) ?? '';
      const messageId = str(message.message_id);
      const chatType = str(message.chat_type);
      if (chatType === 'p2p') return { route: 'DIRECT_MESSAGE', openId, messageId };
      if (chatType === 'group') return { route: 'GROUP_MENTION', openId, messageId };
      return { route: 'IGNORED', openId, messageId };
    }
    case 'card.action.trigger':
      return {
        route: 'CARD_ACTION',
        openId: str(obj(event.operator).open_id) ?? '',
        messageId: str(obj(event.context).open_message_id),
      };
    case 'im.chat.member.bot.deleted_v1':
      return { route: 'BOT_REMOVED_FROM_CHAT', openId: str(obj(event.operator_id).open_id) ?? '' };
    default:
      return { route: 'IGNORED', openId: '' };
  }
}

/**
 * The text of a message event, with where it was sent and by whom; null for anything that is not a text message. In a
 * group, the @mention placeholders (`@_user_1`) are dropped. Pure; exported for its spec.
 */
export function textMessageOf(payload: unknown): FeishuTextMessage | null {
  const event = obj(obj(payload).event);
  const message = obj(event.message);
  const chatType = str(message.chat_type);
  const openId = str(obj(obj(event.sender).sender_id).open_id);
  const messageId = str(message.message_id);
  if ((chatType !== 'p2p' && chatType !== 'group') || !openId || !messageId || str(message.message_type) !== 'text') return null;
  let text: unknown;
  try {
    text = obj(JSON.parse(str(message.content) ?? '')).text;
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  return { chatType, openId, messageId, text: chatType === 'group' ? text.replace(/@_user_\d+/g, ' ').trim() : text.trim() };
}

/**
 * FeishuRouter (docs/feishu-bot-design.md §3, §7): sends each inbound event to its branch, acting as the account the app
 * belongs to — read from feishu_app as the event is routed, so an event of an app that is gone acts nowhere. A text
 * message that is an owner code, or the owner's `disconnect`, goes to FeishuOwnerService (§5).
 *
 * Only the owner is served (§7.3, §7.4). Any other direct message is answered with one English sentence — that the bot
 * takes direct messages only from its owner, or, while nobody is the owner, how to become it — and writes nothing. A
 * card click is checked first of all: a clicker whose open_id is not the app's ownerOpenId (a forwarded card) is
 * answered with a toast and writes nothing. Every later card action goes through that same check. The owner's own
 * direct messages, and their clicks on its cards, go to FeishuDirectService (§7.3). Every other branch
 * records the event and does nothing more yet; later tasks fill them in, each calling only service methods on the §7.2 allowlist
 * (feishu/feishu-actions.ts). What is logged names the event, the app, the branch and the account,
 * never the message's text.
 */
@Injectable()
export class FeishuRouter {
  private readonly logger = new Logger(FeishuRouter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: FeishuOwnerService,
    private readonly direct: FeishuDirectService,
  ) {}

  async route(event: InboundEvent): Promise<RouteDecision | null> {
    const app = await this.prisma.feishuApp.findUnique({
      where: { appId: event.appId },
      select: { ownerId: true, appId: true, platform: true, appSecretEnc: true, ownerOpenId: true, defaultWorkspaceId: true },
    });
    if (!app) {
      this.logger.log(`feishu event ${event.eventId} of app ${event.appId} dropped: the app is no longer connected`);
      return null;
    }
    const { route, openId, messageId } = classify(event.eventType, event.payload);
    const actor: FeishuActor = {
      userId: app.ownerId,
      credential: { kind: 'FEISHU', appId: event.appId, openId, ...(messageId ? { messageId } : {}) },
    };
    this.logger.log(`feishu event ${event.eventId} of app ${event.appId} routed as ${route} for account ${app.ownerId}`);
    if (route === 'CARD_ACTION') {
      if (!app.ownerOpenId || openId !== app.ownerOpenId) {
        this.logger.log(`feishu event ${event.eventId} of app ${event.appId}: a card click by someone other than the owner, refused`);
        return { route, actor, answer: { toast: { type: 'error', content: FEISHU_OWNER_REPLIES.strangerCard } } };
      }
      const answer = await this.direct.handleCardAction(app, event.payload);
      return answer ? { route, actor, answer } : { route, actor };
    }
    if (route === 'DIRECT_MESSAGE' || route === 'GROUP_MENTION') {
      const message = textMessageOf(event.payload);
      // An owner code is taken from anyone (§5.1): it is how someone becomes the owner.
      if (message && (await this.owner.handleMessage(app, message))) return { route, actor };
      if (route === 'DIRECT_MESSAGE' && messageId && (!app.ownerOpenId || openId !== app.ownerOpenId)) {
        this.logger.log(`feishu event ${event.eventId} of app ${event.appId}: a direct message from someone other than the owner, refused`);
        await this.owner.replyTo(app, messageId, app.ownerOpenId ? FEISHU_OWNER_REPLIES.stranger : FEISHU_OWNER_REPLIES.noOwner);
      } else if (route === 'DIRECT_MESSAGE') {
        await this.direct.handleMessage(app, actor, event.eventId, event.payload);
      }
    }
    return { route, actor };
  }
}
