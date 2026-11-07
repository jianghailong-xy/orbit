import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable, Logger } from '@nestjs/common';
import { uuidToBase62, type FeishuMessageDetail, type FeishuPlatform } from '@orbit/shared';
import { renderFeishuCard, type FeishuAlert, type FeishuApprovalItem } from '../feishu/cards/feishu-cards';
import { FeishuAppService } from '../feishu/feishu-app.service';
import type { FeishuAppCredentials } from '../feishu/feishu-open-platform';
import { FeishuOutbound, feishuDedupeUuid, type FeishuSendResult } from '../feishu/feishu-outbound';
import { feishuTiming, type FeishuTiming } from '../feishu/feishu-timing';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from '../providers/provider-crypto';

/** The account's app, when alerts can go to its owner: switched on, allowed, an owner bound, its secret readable. */
export interface FeishuTarget {
  ownerId: string;
  appId: string;
  credentials: FeishuAppCredentials;
  openId: string;
  detail: FeishuMessageDetail;
  approvalsInFeishu: boolean;
}

/** The kind column of `feishu_message` (§6.1). */
export type FeishuMessageKind = FeishuAlert['kind'];

/** One card to send, or to update when a card with its collapse key was sent already. */
export interface FeishuCardSpec {
  /** What the card is merged on (§6.2), unique per app. */
  collapseKey: string;
  kind: FeishuMessageKind;
  sessionId?: string | null;
  approvalId?: string | null;
  openItemId?: string | null;
  /** Where Open in Orbit goes. */
  openUrl: string;
  /** The alert, drawn when the card is sent or updated; null when there is nothing left to show. */
  render: () => Promise<FeishuAlert | null>;
}

/** Attempts of one send or update before it is given up on (§6.3: "a bounded number of retries"). */
export const FEISHU_ALERT_ATTEMPTS = 3;
/** Rounds one caller sends or updates a card in, picking up what other callers announced meanwhile. */
const MAX_ROUNDS = 5;

/** The deployment's own address, as the other links it hands out are built (sign-in-providers.service.ts). */
function publicOrigin(): string {
  return (process.env.PUBLIC_ORIGIN?.trim() || 'http://localhost:2086').replace(/\/+$/, '');
}

/** Open in Orbit: a session, a project, a task, or the app. */
export function orbitUrl(to: { sessionId?: string | null; projectId?: string | null; taskId?: string | null } = {}): string {
  if (to.sessionId) return `${publicOrigin()}/sessions/${uuidToBase62(to.sessionId)}`;
  if (to.projectId) return `${publicOrigin()}/projects/${uuidToBase62(to.projectId)}`;
  if (to.taskId) return `${publicOrigin()}/tasks/${uuidToBase62(to.taskId)}`;
  return `${publicOrigin()}/`;
}

/** Worth trying again: Feishu was not reached, or failed on its side. A refusal (a 4xx, a Feishu code) is the answer. */
function retryable(result: FeishuSendResult): boolean {
  return !result.ok && (result.status === null || result.status >= 500);
}

function failure(result: FeishuSendResult): string {
  return result.ok ? '' : `Feishu error ${result.feishuCode ?? result.status ?? 'unknown'}: ${result.feishuMsg || 'no reason given'}`;
}

/**
 * The third channel of PushService (docs/feishu-bot-design.md §6.1–§6.3): alerts as cards in the owner's direct messages
 * with the account's own Feishu app. PushService decides whether and when to alert, as it does for APNs and FCM — the
 * same call sites, eligibility and cross-process claims — and hands the card here.
 *
 * EVERY CARD IS A ROW (`feishu_message`, migration 0495), merged at the grain of the APNs collapse id (§6.2): the row is
 * inserted with its collapse key, or, when the key has a row already, its `revision` is bumped. Whoever then takes the
 * row's lease draws the card from what the database says now and sends it (no message_id yet) or updates it (PATCH),
 * records the revision it drew as `rendered_revision`, lets go, and looks again: a bump made while it held the lease is
 * drawn by it before it returns, and a bump made after it let go is drawn by whoever bumped. So a card announced on two
 * apiservers at once is sent once, and shows what both announced.
 *
 * Failures are hints, not facts (§6.3): a send or update is tried FEISHU_ALERT_ATTEMPTS times when Feishu was not
 * reached or failed on its side, then given up on; the reason goes to the row's and the app's `last_error`. Nothing here
 * throws, so a Feishu failure never costs an APNs or FCM delivery.
 */
@Injectable()
export class FeishuTransport {
  private readonly log = new Logger(FeishuTransport.name);
  /** The clocks, and how a retry's wait is waited: a spec replaces either. */
  timing: FeishuTiming = feishuTiming();
  wait: (ms: number) => Promise<unknown> = sleep;

  constructor(
    private readonly prisma: PrismaService,
    private readonly apps: FeishuAppService,
    private readonly outbound: FeishuOutbound,
  ) {}

  /** Where the account's alerts go in Feishu, or null when they go nowhere there. Never throws. */
  async target(ownerId: string): Promise<FeishuTarget | null> {
    try {
      const app = await this.prisma.feishuApp.findUnique({
        where: { ownerId },
        select: { appId: true, platform: true, appSecretEnc: true, enabled: true, ownerOpenId: true, messageDetail: true, approvalsInFeishu: true },
      });
      if (!app || !app.enabled || !app.ownerOpenId) return null;
      if (!(await this.apps.allowed())) return null;
      let appSecret: string;
      try {
        appSecret = decryptSecret(app.appSecretEnc);
      } catch {
        return null; // secretUnreadable (§4.1): the settings page says so.
      }
      return {
        ownerId,
        appId: app.appId,
        credentials: { platform: app.platform as FeishuPlatform, appId: app.appId, appSecret },
        openId: app.ownerOpenId,
        detail: app.messageDetail === 'FULL' ? 'FULL' : 'TITLES_ONLY',
        approvalsInFeishu: app.approvalsInFeishu,
      };
    } catch (err) {
      this.log.warn(`feishu target lookup failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Send the card, or update the one already sent under its collapse key. True when Feishu holds the card as drawn now
   * (or as another apiserver is drawing it). Never throws.
   */
  async post(target: FeishuTarget, spec: FeishuCardSpec): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "feishu_message" ("id", "owner_id", "app_id", "collapse_key", "kind", "receive_id", "session_id", "approval_id", "open_item_id")
        VALUES (${randomUUID()}::uuid, ${target.ownerId}::uuid, ${target.appId}, ${spec.collapseKey}, ${spec.kind}, ${target.openId},
                ${spec.sessionId ?? null}::uuid, ${spec.approvalId ?? null}::uuid, ${spec.openItemId ?? null}::uuid)
        ON CONFLICT ("app_id", "collapse_key") DO UPDATE
          SET "revision" = "feishu_message"."revision" + 1, "updated_at" = now()
        RETURNING "id"`;
      return await this.pump(rows[0]!.id, target, spec);
    } catch (err) {
      this.log.warn(`feishu ${spec.kind} card failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * One more approval of a stretch whose alert another call claimed (PushService.claimApprovalAlert answered false):
   * bump the stretch's card so it lists this approval too, and draw it unless its holder will. The card is the session's
   * approval card whose first approval opens this approval's stretch — the latest approval at or before it that no
   * earlier approval was pending at — or, for an approval that committed after a later one claimed the alert, the card
   * of the stretch that rang last, when that stretch began after this approval was asked. No card yet: the call that
   * claimed the stretch has not inserted it, and draws this approval when it does.
   */
  async joinApprovalStretch(target: FeishuTarget, sessionId: string, approvalId: string): Promise<void> {
    try {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        UPDATE "feishu_message" AS m SET "revision" = m."revision" + 1, "updated_at" = now()
         WHERE m."id" = (
           SELECT c."id" FROM "feishu_message" AS c
             JOIN "approval" AS y ON y."id" = c."approval_id" AND y."session_id" = c."session_id"
             JOIN "approval" AS b ON b."id" = ${approvalId}::uuid AND b."session_id" = c."session_id"
             JOIN "session" AS s ON s."id" = b."session_id"
            WHERE c."app_id" = ${target.appId} AND c."session_id" = ${sessionId}::uuid AND c."kind" = 'approval'
              AND ((y."created_at", y."id") = (
                     SELECT o."created_at", o."id" FROM "approval" AS o
                      WHERE o."session_id" = b."session_id" AND (o."created_at", o."id") <= (b."created_at", b."id")
                        AND NOT EXISTS (
                          SELECT 1 FROM "approval" AS p
                           WHERE p."session_id" = o."session_id" AND (p."created_at", p."id") < (o."created_at", o."id")
                             AND (p."status" = 'PENDING' OR p."decided_at" > o."created_at"))
                      ORDER BY o."created_at" DESC, o."id" DESC LIMIT 1)
                OR (y."created_at" = s."alerted_approval_at" AND (y."created_at", y."id") > (b."created_at", b."id")))
            ORDER BY c."created_at" DESC LIMIT 1)
        RETURNING m."id"`;
      if (rows.length === 0) return;
      await this.pump(rows[0]!.id, target, this.approvalCard(target, sessionId, null));
    } catch (err) {
      this.log.warn(`feishu approval card update failed: ${(err as Error).message}`);
    }
  }

  /** A stretch's approval card: the session's title and every approval of it still pending, each with its buttons. */
  approvalCard(target: FeishuTarget, sessionId: string, firstApprovalId: string | null): FeishuCardSpec {
    return {
      collapseKey: `approval-${firstApprovalId ?? ''}`,
      kind: 'approval',
      sessionId,
      approvalId: firstApprovalId,
      openUrl: orbitUrl({ sessionId }),
      render: async () => {
        const [session, approvals] = await Promise.all([
          this.prisma.session.findFirst({ where: { id: sessionId, ownerId: target.ownerId }, select: { title: true } }),
          this.prisma.approval.findMany({
            where: { sessionId, status: 'PENDING', session: { ownerId: target.ownerId } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, toolName: true, input: true },
          }),
        ]);
        if (!session || approvals.length === 0) return null;
        return { kind: 'approval', sessionTitle: session.title ?? '', approvals: approvals as FeishuApprovalItem[] };
      },
    };
  }

  /**
   * Take the row's lease while it has a revision nobody drew, draw it, send or update, record it, let go; again, until
   * nothing is left to draw or another holder has it.
   */
  private async pump(id: string, target: FeishuTarget, spec: FeishuCardSpec): Promise<boolean> {
    let delivered = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const token = randomUUID();
      const leaseUntil = new Date(Date.now() + this.timing.alertLeaseMs);
      const [held] = await this.prisma.$queryRaw<{ revision: number; message_id: string | null }[]>`
        UPDATE "feishu_message" SET "lease_token" = ${token}::uuid, "lease_until" = ${leaseUntil}::timestamptz
         WHERE "id" = ${id}::uuid AND "rendered_revision" <> "revision"
           AND ("lease_until" IS NULL OR "lease_until" < now())
        RETURNING "revision", "message_id"`;
      if (!held) {
        // Drawn already, or another apiserver holds it and draws what is new before it lets go.
        const row = await this.prisma.feishuMessage.findUnique({ where: { id }, select: { messageId: true, leaseUntil: true } });
        return delivered || Boolean(row?.messageId) || Boolean(row?.leaseUntil && row.leaseUntil > new Date());
      }
      let alert: FeishuAlert | null = null;
      try {
        alert = await spec.render();
      } catch (err) {
        this.log.warn(`feishu ${spec.kind} card could not be drawn: ${(err as Error).message}`);
      }
      if (!alert) {
        await this.prisma.$executeRaw`
          UPDATE "feishu_message" SET "rendered_revision" = ${held.revision}, "lease_token" = NULL, "lease_until" = NULL, "updated_at" = now()
           WHERE "id" = ${id}::uuid AND "lease_token" = ${token}::uuid`;
        return delivered || held.message_id !== null;
      }
      const card = renderFeishuCard(alert, { detail: target.detail, approvalsInFeishu: target.approvalsInFeishu, openUrl: spec.openUrl });
      const { result, attempts } = await this.attempt(() =>
        held.message_id
          ? this.outbound.updateCard(target.credentials, held.message_id, card)
          : this.outbound.send(target.credentials, { receiveIdType: 'open_id', receiveId: target.openId }, { msgType: 'interactive', content: card }, {
            // The card's own reason to exist: a re-send after a lost answer, or by an apiserver that took over an expired
            // lease, is the same card to Feishu (project instruction 15). An update needs none.
            uuid: feishuDedupeUuid('alert-card', target.appId, spec.collapseKey),
          }));
      const lastError = result.ok ? null : failure(result);
      const messageId = result.ok ? (held.message_id ?? result.messageId) : held.message_id;
      // Sent, sent before, or given up on before Feishu ever had it.
      const status = messageId ? 'SENT' : 'FAILED';
      await this.prisma.$executeRaw`
        UPDATE "feishu_message"
           SET "rendered_revision" = ${held.revision}, "lease_token" = NULL, "lease_until" = NULL,
               "message_id" = ${messageId}, "status" = ${status}, "alert" = ${JSON.stringify(alert)}::jsonb,
               "attempts" = "attempts" + ${attempts}, "last_error" = ${lastError},
               "sent_at" = CASE WHEN "sent_at" IS NULL AND ${result.ok}::boolean THEN now() ELSE "sent_at" END,
               "updated_at" = now()
         WHERE "id" = ${id}::uuid AND "lease_token" = ${token}::uuid`;
      if (result.ok) {
        delivered = true;
      } else {
        this.log.warn(`feishu app ${target.appId}: a ${spec.kind} card was given up on after ${attempts} attempt(s) (${lastError})`);
        await this.prisma.feishuApp.updateMany({ where: { appId: target.appId }, data: { lastError } }).catch(() => undefined);
      }
    }
    return delivered;
  }

  /** One send or update, tried again after Feishu was not reached or failed on its side, up to FEISHU_ALERT_ATTEMPTS. */
  private async attempt(once: () => Promise<FeishuSendResult>): Promise<{ result: FeishuSendResult; attempts: number }> {
    for (let attempts = 1; ; attempts++) {
      let result: FeishuSendResult;
      try {
        result = await once();
      } catch (err) {
        result = { ok: false, status: null, feishuCode: null, feishuMsg: (err as Error).message.slice(0, 200) };
      }
      if (result.ok || attempts >= FEISHU_ALERT_ATTEMPTS || !retryable(result)) return { result, attempts };
      await this.wait(this.timing.alertRetryMs * 2 ** (attempts - 1));
    }
  }
}
