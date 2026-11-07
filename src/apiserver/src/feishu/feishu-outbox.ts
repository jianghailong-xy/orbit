import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { orbitUrl } from '../push/feishu-transport';
import { ControlPlaneLeader } from '../realtime/control-plane-leader';
import { renderSessionReply } from './cards/feishu-reply-cards';
import { FeishuAppService } from './feishu-app.service';
import { FeishuOutbound, feishuDedupeUuid, type FeishuSendResult } from './feishu-outbound';
import { credentialsOf } from './feishu-owner.service';
import { feishuTiming, type FeishuTiming } from './feishu-timing';

/** Attempts of one reply before it is given up on, when Feishu keeps failing on its side or cannot be reached. */
export const FEISHU_OUTBOX_MAX_ATTEMPTS = 12;

/** Rows one claim takes. */
const CLAIM_BATCH = 20;

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Worth trying again: Feishu was not reached, or failed on its side. A refusal (a 4xx, a Feishu code) is the answer. */
function retryable(result: FeishuSendResult): boolean {
  return !result.ok && (result.status === null || result.status >= 500);
}

function failure(result: FeishuSendResult): string {
  return result.ok ? '' : `Feishu error ${result.feishuCode ?? result.status ?? 'unknown'}: ${result.feishuMsg || 'no reason given'}`;
}

/** The wait before attempt `attempts + 1`, after `attempts` failed ones (≥ 1): 5 s, doubling, at most 10 minutes. */
export function outboxRetryMs(attempts: number, timing: FeishuTiming): number {
  return Math.min(timing.outboxRetryMs * 2 ** Math.min(Math.max(attempts, 1) - 1, 20), timing.outboxRetryCapMs);
}

interface ClaimedRow {
  id: string;
  ownerId: string;
  appId: string;
  sessionId: string;
  chatId: string;
  rootMessageId: string;
  text: string;
  attempts: number;
}

/**
 * The outbox's worker (docs/feishu-bot-design.md §7.5, `feishu_outbox`, migration 0501): on every replica, claims due
 * rows — PENDING, or FAILED with its wait over — with FOR UPDATE SKIP LOCKED, `due_at` moved on as the claim's lease and
 * the attempt counted, and replies to the chain's root message with the session's words: in its thread in a group (a
 * chat with a feishu_chat_route), with Open in Orbit in a direct chat. A row waits while an earlier row of its session
 * has still to go, so a session's replies arrive in order. Sent in either detail mode (§6.4): the conversation is the
 * owner's own, held in Feishu already.
 *
 * Every reply carries Feishu's de-duplication key, derived from the row (project instruction 15): a reply whose answer
 * was lost, or a row a lease ran out on, reaches the chain once. A failure Feishu may recover from (unreached, a 5xx) is
 * tried again after a wait that doubles, FEISHU_OUTBOX_MAX_ATTEMPTS times in all, then given up on (GAVE_UP); a refusal
 * is given up on at once. Whenever a reply of an app gets through, that app's FAILED rows are due at once: Feishu is
 * back, so what failed is sent now rather than after its wait. The leader deletes rows settled 7 days ago.
 */
@Injectable()
export class FeishuOutboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FeishuOutboxService.name);
  private readonly timing: FeishuTiming = feishuTiming();
  private pollTimer?: ReturnType<typeof setInterval>;
  private purgeTimer?: ReturnType<typeof setInterval>;
  private draining?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: FeishuOutbound,
    private readonly apps: FeishuAppService,
    @Optional() private readonly leader?: ControlPlaneLeader,
  ) {}

  onApplicationBootstrap(): void {
    this.pollTimer = setInterval(() => this.kick(), this.timing.inboxPollMs);
    this.purgeTimer = setInterval(() => {
      if (this.leader && !this.leader.leads()) return;
      this.purge().catch((error) => this.logger.warn(`the outbox purge failed and runs again later: ${messageOf(error)}`));
    }, this.timing.inboxPurgeMs);
    this.pollTimer.unref();
    this.purgeTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.purgeTimer);
    await this.draining;
  }

  /** Drain now, unless a drain is in flight; the next poll picks up whatever came after it. */
  kick(): void {
    if (this.stopped || this.draining) return;
    this.draining = (async () => {
      try {
        while (!this.stopped && (await this.drain()) > 0);
      } catch (error) {
        this.logger.warn(`the outbox worker failed and tries again: ${messageOf(error)}`);
      }
    })().finally(() => {
      this.draining = undefined;
    });
  }

  /** Claim up to a batch of due rows and send them. Returns how many it claimed. */
  async drain(): Promise<number> {
    const claimed = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "feishu_outbox" AS o
      SET "attempts" = o."attempts" + 1,
          "due_at" = now() + ${this.timing.outboxLeaseMs}::int * interval '1 millisecond',
          "updated_at" = now()
      FROM (
        SELECT d."id" FROM "feishu_outbox" AS d
        WHERE d."status" IN ('PENDING', 'FAILED') AND d."due_at" <= now()
          AND NOT EXISTS (
            SELECT 1 FROM "feishu_outbox" AS p
            WHERE p."session_id" = d."session_id" AND p."status" IN ('PENDING', 'FAILED')
              AND (p."created_at", p."id") < (d."created_at", d."id")
          )
        ORDER BY d."due_at", d."id"
        LIMIT ${CLAIM_BATCH}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE o."id" = due."id"
      RETURNING o."id", o."owner_id" AS "ownerId", o."app_id" AS "appId", o."session_id" AS "sessionId",
                o."chat_id" AS "chatId", o."root_message_id" AS "rootMessageId", o."text", o."attempts"`;
    for (const row of claimed) await this.send(row);
    return claimed.length;
  }

  private async send(row: ClaimedRow): Promise<void> {
    try {
      const app = await this.prisma.feishuApp.findFirst({
        where: { appId: row.appId, ownerId: row.ownerId },
        select: { platform: true, appId: true, appSecretEnc: true, enabled: true },
      });
      const credentials = app ? credentialsOf(app) : null;
      if (!app || !app.enabled || !credentials || !(await this.apps.allowed())) {
        await this.settle(row, 'GAVE_UP', { error: app && !credentials ? 'The saved App Secret can no longer be decrypted' : 'The Feishu app is switched off' });
        return;
      }
      const group = (await this.prisma.feishuChatRoute.count({ where: { appId: row.appId, ownerId: row.ownerId, chatId: row.chatId } })) > 0;
      const body = renderSessionReply(row.text, group ? null : orbitUrl({ sessionId: row.sessionId }));
      const result = await this.outbound.reply(credentials, row.rootMessageId, body, {
        replyInThread: group,
        uuid: feishuDedupeUuid('session-reply', row.appId, row.id),
      });
      if (result.ok) {
        await this.settle(row, 'SENT', { messageId: result.messageId });
        await this.rearm(row.appId);
        this.logger.log(`feishu app ${row.appId}: a reply of session ${row.sessionId} went back to its chain`);
        return;
      }
      const again = retryable(result) && row.attempts < FEISHU_OUTBOX_MAX_ATTEMPTS;
      await this.settle(row, again ? 'FAILED' : 'GAVE_UP', { error: failure(result) });
      this.logger.warn(
        `feishu app ${row.appId}: a reply of session ${row.sessionId} was not delivered on attempt ${row.attempts}`
          + ` (${failure(result)})${again ? '' : '; it is given up on'}`,
      );
    } catch (error) {
      // Not Feishu's answer (the database, a bug): tried again after the same wait, within the same attempts.
      const again = row.attempts < FEISHU_OUTBOX_MAX_ATTEMPTS;
      await this.settle(row, again ? 'FAILED' : 'GAVE_UP', { error: messageOf(error) }).catch(() => undefined);
      this.logger.warn(`feishu outbox row ${row.id} failed on attempt ${row.attempts}: ${messageOf(error)}`);
    }
  }

  /** Settle a claimed row, unless it was settled meanwhile (a lease ran out and another replica sent it). */
  private async settle(row: ClaimedRow, status: 'SENT' | 'FAILED' | 'GAVE_UP', { messageId = null, error = null }: { messageId?: string | null; error?: string | null }): Promise<void> {
    const waitMs = outboxRetryMs(row.attempts, this.timing);
    await this.prisma.$executeRaw`
      UPDATE "feishu_outbox"
      SET "status" = ${status},
          "due_at" = CASE WHEN ${status} = 'FAILED' THEN now() + ${waitMs}::int * interval '1 millisecond' ELSE now() END,
          "message_id" = coalesce(${messageId}, "message_id"),
          "last_error" = CASE WHEN ${status} = 'SENT' THEN "last_error" ELSE ${error} END,
          "sent_at" = CASE WHEN ${status} = 'SENT' THEN now() ELSE "sent_at" END,
          "updated_at" = now()
      WHERE "id" = ${row.id}::uuid AND "status" IN ('PENDING', 'FAILED')`;
  }

  /** Feishu answers this app again: what failed for it is due now, not after its wait. */
  private async rearm(appId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "feishu_outbox" SET "due_at" = now(), "updated_at" = now()
      WHERE "app_id" = ${appId} AND "status" = 'FAILED' AND "due_at" > now()`;
  }

  /** Delete rows sent, or given up on, longer ago than the inbox keeps its rows (7 days). */
  async purge(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - this.timing.inboxRetentionMs);
    return this.prisma.$executeRaw`
      DELETE FROM "feishu_outbox" WHERE "status" IN ('SENT', 'GAVE_UP') AND "updated_at" < ${before}`;
  }
}
