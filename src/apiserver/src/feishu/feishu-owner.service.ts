import { createHash, randomInt } from 'node:crypto';
import { BadGatewayException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  FEISHU_CONNECT_CODE_LENGTH,
  FEISHU_CONNECT_CODE_TTL_MINUTES,
  FEISHU_NO_APP_MESSAGE,
  FEISHU_NO_OWNER,
  FEISHU_NO_OWNER_MESSAGE,
  FEISHU_NOT_ALLOWED,
  FEISHU_NOT_ALLOWED_MESSAGE,
  feishuBotApplink,
  type FeishuConnectCode,
  type FeishuIntegration,
  type FeishuPlatform,
  type FeishuTestMessageResult,
} from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from '../providers/provider-crypto';
import { FeishuAppService } from './feishu-app.service';
import type { FeishuAppCredentials } from './feishu-open-platform';
import { FeishuOutbound, feishuDedupeUuid, type FeishuSendResult } from './feishu-outbound';

/** What the bot answers in Feishu (§5). English, as every word the bot sends (CLAUDE.md §5). */
export const FEISHU_OWNER_REPLIES = {
  connected: "You're connected as the owner of this Orbit bot.",
  expired:
    'This code has expired. Generate a new one in Orbit (Settings → Feishu → Connect your Feishu account) and send it here within 10 minutes.',
  invalid:
    "This code isn't valid: it may have been used already, or mistyped. Generate a new one in Orbit (Settings → Feishu → Connect your Feishu account).",
  group:
    'Owner codes are only accepted in a direct message with the bot. This code no longer works: generate a new one in Orbit and send it to the bot directly.',
  disconnected:
    "You're no longer the owner of this Orbit bot. Orbit stops sending you alerts here; the app stays connected. To connect again, generate a new code in Orbit.",
  test: 'This is a test message from Orbit. Your alerts will arrive here.',
  /** A direct message from someone other than the owner (§7.3). */
  stranger: 'This bot only takes direct messages from its owner.',
  /** A direct message while nobody is the owner yet (§7.3): how to become it. */
  noOwner:
    'This bot has no owner yet. To become its owner, generate a code in Orbit (Settings → Feishu → Connect your Feishu account) and send it here.',
  /** The toast for a click on a card by someone other than the owner, e.g. on a forwarded card (§7.4). */
  strangerCard: 'Only the owner of this bot can answer this card.',
} as const;

/** The characters a code is made of: no 0/O, 1/I, so it can be read off a screen and typed. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** A code as it may be typed: 8 of the alphabet, at least one a digit, so no 8-letter word is ever read as one. */
const CODE_SHAPE = new RegExp(`^(?=.*[2-9])[${ALPHABET}]{${FEISHU_CONNECT_CODE_LENGTH}}$`);

/** A fresh code: uniformly random, with a digit in it (CODE_SHAPE). */
export function generateConnectCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < FEISHU_CONNECT_CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    if (CODE_SHAPE.test(code)) return code;
  }
}

/** The code a message's text is, if it is one: spaces and a hyphen dropped, upper-cased. Exported for its spec. */
export function codeIn(text: string): string | null {
  const code = text.replace(/[\s-]+/g, '').toUpperCase();
  return CODE_SHAPE.test(code) ? code : null;
}

/** What is stored for a code: its SHA-256, hex. */
export function hashConnectCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** A message as the owner branch reads it: where it was sent, by whom, and its text. */
export interface FeishuTextMessage {
  chatType: 'p2p' | 'group';
  openId: string;
  messageId: string;
  text: string;
}

/** The app as the router read it when the event was routed. */
export interface FeishuOwnerApp {
  ownerId: string;
  appId: string;
  platform: string;
  appSecretEnc: string;
  ownerOpenId: string | null;
}

/**
 * The owner's identity (docs/feishu-bot-design.md §5; `feishu_app.owner_open_id`, `feishu_connect_code`, migration 0494).
 *
 * The account generates a one-time code in Settings → Feishu (`createCode`): 8 characters, 10 minutes, one use, only its
 * SHA-256 stored, and any earlier code of the account dropped. Whoever sends it to the account's own bot in a direct
 * message becomes the app's owner (`handleMessage`): the code row is deleted and owner_open_id set in one transaction,
 * so the same event processed twice binds once and the second time is answered as the first was. A code sent in a group
 * binds nobody and stops working, since the group saw it. The owner leaves with Disconnect in Settings (`disconnect`) or
 * by sending `disconnect` to the bot; either clears the identity and the app stays connected.
 *
 * A code is never logged or stored as typed, and is answered only by the route that generated it.
 */
@Injectable()
export class FeishuOwnerService {
  private readonly logger = new Logger(FeishuOwnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly apps: FeishuAppService,
    private readonly outbound: FeishuOutbound,
  ) {}

  /** `POST /integrations/feishu/connect-codes`: a new code for the account's app, replacing any it had. */
  async createCode(ownerId: string): Promise<FeishuConnectCode> {
    if (!(await this.apps.allowed())) throw new ForbiddenException({ code: FEISHU_NOT_ALLOWED, message: FEISHU_NOT_ALLOWED_MESSAGE });
    const app = await this.prisma.feishuApp.findUnique({ where: { ownerId }, select: { platform: true, appId: true } });
    if (!app) throw new NotFoundException(FEISHU_NO_APP_MESSAGE);
    const code = generateConnectCode();
    const expiresAt = new Date(Date.now() + FEISHU_CONNECT_CODE_TTL_MINUTES * 60_000);
    const codeHash = hashConnectCode(code);
    await withTransactionRetry(this.prisma, async (tx) => {
      await tx.feishuConnectCode.deleteMany({ where: { OR: [{ ownerId }, { expiresAt: { lte: new Date() } }] } });
      await tx.feishuConnectCode.create({ data: { ownerId, codeHash, expiresAt } });
    }, loggedRetry(this.logger, 'feishuOwner.createCode'));
    this.logger.log(`account ${ownerId} generated a Feishu owner code`);
    return { code, expiresAt: expiresAt.toISOString(), applink: feishuBotApplink(app.platform as FeishuPlatform, app.appId) };
  }

  /** `DELETE /integrations/feishu/owner`: nobody is the owner any more; the app stays connected. */
  async disconnect(ownerId: string): Promise<FeishuIntegration> {
    const { count } = await this.prisma.feishuApp.updateMany({ where: { ownerId }, data: { ownerOpenId: null, ownerName: null } });
    if (count === 0) throw new NotFoundException(FEISHU_NO_APP_MESSAGE);
    this.logger.log(`account ${ownerId} disconnected the owner of its Feishu app`);
    return this.apps.integration(ownerId);
  }

  /**
   * `POST /integrations/feishu/test`: one text message to the owner. 409 while nobody is the owner, or Orbit cannot act
   * as the app; 502 with Feishu's code and message when Feishu refused it, which is kept as the app's last error.
   */
  async sendTest(ownerId: string): Promise<FeishuTestMessageResult> {
    const app = await this.prisma.feishuApp.findUnique({ where: { ownerId } });
    if (!app) throw new NotFoundException(FEISHU_NO_APP_MESSAGE);
    if (!app.ownerOpenId) throw new ConflictException({ code: FEISHU_NO_OWNER, message: FEISHU_NO_OWNER_MESSAGE });
    if (!app.enabled) {
      throw new ConflictException({ code: 'FEISHU_APP_OFF', message: 'This Feishu app is switched off. Switch it on to send a test message.' });
    }
    const credentials = credentialsOf(app);
    if (!credentials) {
      throw new ConflictException({
        code: 'FEISHU_SECRET_UNREADABLE',
        message: 'The saved App Secret can no longer be decrypted. Enter the App Secret again to send a test message.',
      });
    }
    const sent = await this.outbound.send(credentials, { receiveIdType: 'open_id', receiveId: app.ownerOpenId }, text(FEISHU_OWNER_REPLIES.test));
    if (!sent.ok) {
      const lastError = `Feishu error ${sent.feishuCode ?? sent.status ?? 'unknown'}: ${sent.feishuMsg || 'no reason given'}`;
      await this.prisma.feishuApp.updateMany({ where: { id: app.id }, data: { lastError } });
      throw new BadGatewayException({ code: 'FEISHU_SEND_FAILED', message: `Feishu did not deliver the test message (${lastError}).` });
    }
    this.logger.log(`account ${ownerId} sent a Feishu test message to its owner`);
    return { sent: true };
  }

  /**
   * A text message to the bot (§5.1, §5.2, §7.3): an owner code, or the owner's `disconnect`. Answers whether it was one
   * of them; anything else is left to the rest of the router.
   */
  async handleMessage(app: FeishuOwnerApp, message: FeishuTextMessage): Promise<boolean> {
    const code = codeIn(message.text);
    if (!code) {
      if (message.chatType === 'p2p' && message.text.trim().toLowerCase() === 'disconnect' && app.ownerOpenId && app.ownerOpenId === message.openId) {
        await this.prisma.feishuApp.updateMany({
          where: { appId: app.appId, ownerOpenId: message.openId },
          data: { ownerOpenId: null, ownerName: null },
        });
        this.logger.log(`the owner of Feishu app ${app.appId} disconnected from Feishu`);
        await this.reply(app, message, FEISHU_OWNER_REPLIES.disconnected);
        return true;
      }
      return false;
    }
    const codeHash = hashConnectCode(code);
    if (message.chatType === 'group') {
      // The group saw it: nobody may use it now.
      await this.prisma.feishuConnectCode.deleteMany({ where: { codeHash, ownerId: app.ownerId } });
      this.logger.log(`an owner code was sent to Feishu app ${app.appId} in a group; not accepted, and dropped`);
      await this.reply(app, message, FEISHU_OWNER_REPLIES.group);
      return true;
    }
    const outcome = await this.claimCode(app, codeHash, message.openId);
    if (outcome === 'BOUND') {
      this.logger.log(`Feishu app ${app.appId} of account ${app.ownerId} has a new owner`);
      const credentials = credentialsOf(app);
      const name = credentials ? await this.outbound.userName(credentials, message.openId) : null;
      if (name) {
        await this.prisma.feishuApp.updateMany({ where: { appId: app.appId, ownerOpenId: message.openId }, data: { ownerName: name } });
      }
      await this.reply(app, message, FEISHU_OWNER_REPLIES.connected);
    } else if (outcome === 'INVALID' && app.ownerOpenId === message.openId) {
      // The same event processed again, or the owner sending their used code once more: they are the owner.
      await this.reply(app, message, FEISHU_OWNER_REPLIES.connected);
    } else {
      this.logger.log(`an owner code sent to Feishu app ${app.appId} was ${outcome === 'EXPIRED' ? 'expired' : 'not valid'}`);
      await this.reply(app, message, outcome === 'EXPIRED' ? FEISHU_OWNER_REPLIES.expired : FEISHU_OWNER_REPLIES.invalid);
    }
    return true;
  }

  /**
   * Use a code sent in a direct message: delete its row and make the sender the owner, in one transaction, so a code
   * binds once however often its event is processed. BOUND, or why not: EXPIRED (the row goes too) or INVALID (no such
   * code of this account — never generated, mistyped, used, or replaced by a newer one).
   */
  private claimCode(app: FeishuOwnerApp, codeHash: string, openId: string): Promise<'BOUND' | 'EXPIRED' | 'INVALID'> {
    return withTransactionRetry(this.prisma, async (tx) => {
      const used = await tx.feishuConnectCode.deleteMany({ where: { codeHash, ownerId: app.ownerId, expiresAt: { gt: new Date() } } });
      if (used.count === 0) {
        const expired = await tx.feishuConnectCode.deleteMany({ where: { codeHash, ownerId: app.ownerId } });
        return expired.count > 0 ? 'EXPIRED' : 'INVALID';
      }
      const bound = await tx.feishuApp.updateMany({
        where: { appId: app.appId, ownerId: app.ownerId },
        data: { ownerOpenId: openId, ownerName: null },
      });
      return bound.count > 0 ? 'BOUND' : 'INVALID';
    }, loggedRetry(this.logger, 'feishuOwner.claimCode'));
  }

  private reply(app: FeishuOwnerApp, message: FeishuTextMessage, words: string): Promise<FeishuSendResult | null> {
    return this.replyTo(app, message.messageId, words);
  }

  /** A text reply to one message, as the app; null when its secret no longer decrypts. Writes nothing. */
  async replyTo(app: FeishuOwnerApp, messageId: string, words: string): Promise<FeishuSendResult | null> {
    const credentials = credentialsOf(app);
    if (!credentials) return null;
    // Keyed on the app, the message answered and what the answer says: the same event processed again, or a retry whose
    // request got through, is one reply to Feishu (project instruction 15).
    const result = await this.outbound.reply(credentials, messageId, text(words), {
      uuid: feishuDedupeUuid('owner-reply', app.appId, messageId, words),
    });
    if (!result.ok) this.logger.warn(`feishu app ${app.appId}: a reply was not delivered (code ${result.feishuCode ?? result.status})`);
    return result;
  }
}

const text = (words: string) => ({ msgType: 'text', content: { text: words } });

/** The app's credentials, or null when its secret no longer decrypts (§4.1). */
function credentialsOf(app: { platform: string; appId: string; appSecretEnc: string }): FeishuAppCredentials | null {
  try {
    return { platform: app.platform as FeishuPlatform, appId: app.appId, appSecret: decryptSecret(app.appSecretEnc) };
  } catch {
    return null;
  }
}
