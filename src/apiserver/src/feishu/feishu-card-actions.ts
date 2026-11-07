import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { FeishuTransport } from '../push/feishu-transport';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { approvalClass, FEISHU_CARD_ACTIONS, type FeishuCard } from './cards/feishu-cards';
import { FeishuOutbound } from './feishu-outbound';
import { FeishuRouter, type FeishuActor, type InboundEvent } from './feishu-router';

/** What a click is answered with in Feishu (§7.4). English, as every word the bot sends (CLAUDE.md §5). */
export const FEISHU_CARD_REPLIES = {
  allowed: 'Allowed.',
  denied: 'Denied.',
  /** The approval was answered elsewhere, its turn ended, or it is no longer there (§7.4). */
  stale: 'Already answered in Orbit.',
  /** `approvalsInFeishu` is off (§7.2): the card is answered in Orbit. */
  off: 'Answering approvals in Feishu is turned off. Open it in Orbit to answer.',
  /** "Always allow" widens a standing grant, which stays in the app (§7.2, decision 1). */
  remember: '"Always allow" is not available in Feishu. Open it in Orbit to choose it.',
  /** Anything else on a card: Orbit's own confirmation cards, owner items, questions (§7.2). */
  openInOrbit: 'Answer this in Orbit.',
} as const;

/** A card callback's synchronous answer, as Feishu takes it: a toast, and the card to draw in place of the clicked one. */
export interface FeishuCardAnswer {
  toast: { type: 'success' | 'info' | 'warning' | 'error'; content: string };
  card?: { type: 'raw'; data: FeishuCard };
}

/** How long after a click its update token may still be used (§7.1: 30 minutes). */
const DELAYED_UPDATE_WINDOW_MS = 30 * 60_000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** A click as the handler reads it: the button's value, any form values, and the callback's update token. */
export function clickOf(payload: unknown): { value: Json; formValue: Json; token?: string } {
  const event = obj(obj(payload).event);
  const action = obj(event.action);
  return { value: obj(action.value), formValue: obj(action.form_value), token: str(event.token) };
}

/** Whether a click asks for more than a plain allow or deny: any trace of "always allow" in what it sends. */
function asksToRemember(click: { value: Json; formValue: Json }): boolean {
  return ['rememberRules', 'rememberRule', 'remember'].some((key) => key in click.value || key in click.formValue);
}

/**
 * The owner's clicks on alert cards (docs/feishu-bot-design.md §7.2, §7.4; decision 1). FeishuRouter has already
 * checked that the clicker is the app's owner; this answers Allow once and Deny on a tool-permission approval with
 * `SessionsService.decideApproval`, acting as the app's account with the FEISHU credential (who clicked, on which card),
 * and nothing else:
 *
 *   - `approvalsInFeishu` off: refused, nothing written; the card is answered in Orbit;
 *   - a click that carries "always allow" (`rememberRules`): refused, nothing written — a standing grant stays in the app;
 *   - Orbit's own confirmation cards, owner items, questions: no button for them is drawn (cards/feishu-cards.ts), and
 *     a click naming one is refused all the same;
 *   - an approval answered elsewhere, whose turn ended, or that is not this account's: `Already answered in Orbit.`,
 *     and the card is drawn as it stands — the same answer whether the approval exists or not;
 *   - otherwise the decision, exactly what the web app's decision route writes, recorded as FEISHU with the clicker's
 *     open_id and the card's message_id; the toast says what was decided and the card is drawn in place.
 *
 * The card is answered synchronously (FeishuTransport.answerCard); a click whose answer is not ready within Feishu's
 * budget is answered `Working…` by the inbox, and the card follows through the callback's update token (`deliverLate`).
 * The same event handled twice decides once: `decideApproval` applies only to a still-PENDING row, and the second
 * handling finds its own decision and answers as the first did.
 */
@Injectable()
export class FeishuCardActions implements OnModuleInit {
  private readonly logger = new Logger(FeishuCardActions.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly router: FeishuRouter,
    private readonly sessions: SessionsService,
    private readonly transport: FeishuTransport,
    private readonly outbound: FeishuOutbound,
  ) {}

  onModuleInit(): void {
    this.router.useCardActions(this);
  }

  /** The owner's click on a card, answered. */
  async answer(event: InboundEvent, actor: FeishuActor): Promise<FeishuCardAnswer> {
    const click = clickOf(event.payload);
    const action = str(click.value.action);
    const approvalId = str(click.value.approvalId);
    const messageId = actor.credential.messageId;
    if (asksToRemember(click)) {
      this.logger.log(`feishu event ${event.eventId} of app ${event.appId}: a click asking to always allow, refused`);
      return { toast: { type: 'error', content: FEISHU_CARD_REPLIES.remember } };
    }
    if ((action !== FEISHU_CARD_ACTIONS.allow && action !== FEISHU_CARD_ACTIONS.deny) || !approvalId) {
      return { toast: { type: 'info', content: FEISHU_CARD_REPLIES.openInOrbit } };
    }
    const app = await this.prisma.feishuApp.findUnique({ where: { appId: event.appId }, select: { approvalsInFeishu: true } });
    if (!app?.approvalsInFeishu) return { toast: { type: 'info', content: FEISHU_CARD_REPLIES.off } };

    // Only this account's approval: another account's is answered exactly as one that does not exist.
    const approval = await this.prisma.approval.findFirst({
      where: { id: approvalId, session: { ownerId: actor.userId } },
      select: { id: true, sessionId: true, toolName: true },
    });
    if (approval && approvalClass(approval.toolName) !== 'tool') {
      return { toast: { type: 'info', content: FEISHU_CARD_REPLIES.openInOrbit } };
    }
    const behavior = action === FEISHU_CARD_ACTIONS.allow ? 'allow' : 'deny';
    let decided = false;
    if (approval) {
      const answerable = await this.sessions.listApprovals(actor.userId, approval.sessionId, 'PENDING');
      if (answerable.some((a) => a.id === approval.id)) {
        await this.sessions.decideApproval(actor.userId, approval.sessionId, approval.id, { behavior }, actor.credential);
      }
      // Whether the decision on the row is this click's: it landed now, or when this same event was handled before.
      const row = await this.prisma.approval.findUnique({
        where: { id: approval.id },
        select: { status: true, decidedCredentialKind: true, decidedFeishuOpenId: true, decidedFeishuMessageId: true },
      });
      decided = row?.status === (behavior === 'allow' ? 'ALLOWED' : 'DENIED')
        && row.decidedCredentialKind === 'FEISHU'
        && row.decidedFeishuOpenId === actor.credential.openId
        && row.decidedFeishuMessageId === (messageId ?? null);
    }
    this.logger.log(
      `feishu event ${event.eventId} of app ${event.appId}: the owner's ${behavior} ${decided ? 'was recorded' : 'found the approval already answered'}`,
    );
    const toast: FeishuCardAnswer['toast'] = decided
      ? { type: 'success', content: behavior === 'allow' ? FEISHU_CARD_REPLIES.allowed : FEISHU_CARD_REPLIES.denied }
      : { type: 'info', content: FEISHU_CARD_REPLIES.stale };
    const card = messageId ? await this.drawCard(actor.userId, messageId, approval?.sessionId ?? null) : null;
    return card ? { toast, card: { type: 'raw', data: card } } : { toast };
  }

  /** The clicked card as it stands now: what is still pending on it, or its outcome. Null when it is not ours to draw. */
  private async drawCard(ownerId: string, messageId: string, sessionId: string | null): Promise<FeishuCard | null> {
    const target = await this.transport.target(ownerId);
    if (!target) return null;
    const row = await this.prisma.feishuMessage.findFirst({
      where: { appId: target.appId, ownerId, messageId, kind: 'approval' },
      select: { sessionId: true },
    });
    const of = row?.sessionId ?? sessionId;
    const answerable = of ? await this.sessions.listApprovals(ownerId, of, 'PENDING').catch(() => []) : [];
    const drawn = await this.transport.answerCard(target, messageId, new Set(answerable.map((a) => a.id)));
    return drawn?.card ?? null;
  }

  /**
   * A click's answer that came after the inbox had answered `Working…` (§7.1): its card goes to Feishu with the
   * callback's update token, once, within the token's 30 minutes. The toast cannot follow; the card says it all.
   */
  async deliverLate(event: InboundEvent, answer: unknown, clickedAt: number): Promise<void> {
    const card = (answer as FeishuCardAnswer | undefined)?.card?.data;
    const { token } = clickOf(event.payload);
    if (!card || !token || Date.now() - clickedAt > DELAYED_UPDATE_WINDOW_MS) return;
    const owner = await this.prisma.feishuApp.findUnique({ where: { appId: event.appId }, select: { ownerId: true } });
    const target = owner ? await this.transport.target(owner.ownerId) : null;
    if (!target) return;
    const result = await this.outbound.delayedUpdateCard(target.credentials, token, card);
    if (!result.ok) {
      this.logger.warn(`feishu event ${event.eventId} of app ${event.appId}: the late card was not taken (code ${result.feishuCode ?? result.status})`);
    }
  }
}
