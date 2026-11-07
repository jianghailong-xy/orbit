import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ControlPlaneLeader } from '../realtime/control-plane-leader';
import { FeishuRouter, type InboundEvent } from './feishu-router';
import { feishuTiming, type FeishuTiming } from './feishu-timing';

/** This process among the apiserver's replicas: what feishu_link and feishu_inbound_event name it by. */
export const FEISHU_REPLICA_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Claims of one inbox row before it is given up on: the first and four retries. */
export const FEISHU_INBOX_MAX_ATTEMPTS = 5;

/** Rows one claim takes. */
const CLAIM_BATCH = 20;

/** A card callback's synchronous answer must reach Feishu within 3 seconds (§7.1); the router gets this much of them. */
const CARD_ANSWER_BUDGET_MS = 2_500;

/** The event id and type of Feishu's envelope: schema 2.0's header, or a v1 event's `uuid` and `event.type`. */
export function eventIdentity(envelope: unknown): { eventId: string; eventType: string } | null {
  const e = (envelope && typeof envelope === 'object' ? envelope : {}) as {
    header?: { event_id?: unknown; event_type?: unknown };
    uuid?: unknown;
    event?: { type?: unknown };
  };
  const eventId = typeof e.header?.event_id === 'string' ? e.header.event_id : typeof e.uuid === 'string' ? e.uuid : '';
  const eventType = typeof e.header?.event_type === 'string' ? e.header.event_type : typeof e.event?.type === 'string' ? e.event.type : '';
  if (eventId.trim() === '' || eventId.length > 256) return null;
  return { eventId, eventType: eventType || 'unknown' };
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

interface ClaimedRow {
  id: string;
  appId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
}

/**
 * The inbound inbox (docs/feishu-bot-design.md §7.1, `feishu_inbound_event`): first written, then processed.
 *
 * `record` is what a long connection's frame handler awaits: it inserts the event under its `(appId, eventId)` key and
 * returns, which is when the SDK acknowledges the frame — within Feishu's 3 seconds. A redelivery, to this replica or any
 * other, finds the row and is acknowledged without being processed again. Then a worker on any replica claims the row
 * (`drain`: FOR UPDATE SKIP LOCKED, a lease, the attempt counted), routes it (FeishuRouter) and stamps `processed_at`; a
 * failure keeps its error and waits for a later claim, up to FEISHU_INBOX_MAX_ATTEMPTS. A card callback is the exception
 * §7.1 makes: Feishu wants its answer synchronously, so `record` inserts it already claimed and routes it at once.
 *
 * The leader deletes rows 7 days after they were processed or given up on (`purge`).
 */
@Injectable()
export class FeishuInboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FeishuInboxService.name);
  private readonly timing: FeishuTiming = feishuTiming();
  private pollTimer?: ReturnType<typeof setInterval>;
  private purgeTimer?: ReturnType<typeof setInterval>;
  private draining?: Promise<void>;
  private again = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly router: FeishuRouter,
    @Optional() private readonly leader?: ControlPlaneLeader,
  ) {}

  onApplicationBootstrap(): void {
    this.pollTimer = setInterval(() => this.kick(), this.timing.inboxPollMs);
    this.purgeTimer = setInterval(() => {
      if (this.leader && !this.leader.leads()) return;
      this.purge().catch((error) => this.logger.warn(`the inbox purge failed and runs again later: ${messageOf(error)}`));
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

  /**
   * One delivered event: inserted unless its `(appId, eventId)` is already there. Resolves with what the connection
   * answers Feishu — nothing, or a card callback's answer — once the row is committed; throws when it could not be
   * written, so the SDK acknowledges code 500 and Feishu delivers it again.
   */
  async record(appId: string, envelope: unknown): Promise<unknown> {
    const identity = eventIdentity(envelope);
    if (!identity) {
      this.logger.warn(`feishu app ${appId} delivered an event without an event id; acknowledged and dropped`);
      return undefined;
    }
    const card = identity.eventType === 'card.action.trigger';
    const inserted = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "feishu_inbound_event" ("id", "app_id", "event_id", "event_type", "payload", "received_by", "attempts", "lease_until")
      VALUES (${randomUUID()}::uuid, ${appId}, ${identity.eventId}, ${identity.eventType}, ${JSON.stringify(envelope)}::jsonb,
              ${FEISHU_REPLICA_ID}, ${card ? 1 : 0},
              ${card ? new Date(Date.now() + this.timing.inboxLeaseMs) : null}::timestamptz)
      ON CONFLICT ("app_id", "event_id") DO NOTHING
      RETURNING "id"`;
    await this.prisma.$executeRaw`UPDATE "feishu_app" SET "last_event_at" = now() WHERE "app_id" = ${appId}`;
    const row = inserted[0];
    if (!row) {
      this.logger.log(`feishu event ${identity.eventId} of app ${appId} was delivered again; acknowledged, not processed again`);
      return undefined;
    }
    if (!card) {
      this.kick();
      return undefined;
    }
    // The card's answer is due now: route it here, under the claim the insert made, within Feishu's budget. Whatever
    // is not done in time is settled by the same code path, late, and Feishu has shown its own fallback.
    const work = this.process({ id: row.id, appId, ...identity, payload: envelope, attempts: 1 });
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), CARD_ANSWER_BUDGET_MS).unref());
    return Promise.race([work, timeout]);
  }

  /** Wake the worker: drain now, or once more right after the drain in flight. */
  kick(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = this.drainLoop().finally(() => {
      this.draining = undefined;
    });
  }

  private async drainLoop(): Promise<void> {
    do {
      this.again = false;
      try {
        while (!this.stopped && (await this.drain()) > 0);
      } catch (error) {
        this.logger.warn(`the inbox worker failed and tries again: ${messageOf(error)}`);
      }
    } while (this.again && !this.stopped);
  }

  /**
   * Claim up to a batch of due rows — unprocessed, attempts left, no live lease — and process them. SKIP LOCKED lets every
   * replica claim side by side; the lease keeps a row this replica holds from being claimed again while it works on it.
   * Returns how many it claimed.
   */
  async drain(): Promise<number> {
    const claimed = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "feishu_inbound_event" AS e
      SET "attempts" = e."attempts" + 1,
          "lease_until" = now() + ${this.timing.inboxLeaseMs}::int * interval '1 millisecond'
      FROM (
        SELECT "id" FROM "feishu_inbound_event"
        WHERE "processed_at" IS NULL AND "attempts" < ${FEISHU_INBOX_MAX_ATTEMPTS}
          AND ("lease_until" IS NULL OR "lease_until" <= now())
        ORDER BY "received_at", "id"
        LIMIT ${CLAIM_BATCH}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE e."id" = due."id"
      RETURNING e."id", e."app_id" AS "appId", e."event_id" AS "eventId", e."event_type" AS "eventType", e."payload", e."attempts"`;
    for (const row of claimed) await this.process(row);
    return claimed.length;
  }

  /** Route one claimed row and settle it: processed, or failed with its error and a wait before the next claim. */
  private async process(row: ClaimedRow): Promise<unknown> {
    const event: InboundEvent = { appId: row.appId, eventId: row.eventId, eventType: row.eventType, payload: row.payload };
    try {
      const decision = await this.router.route(event);
      await this.prisma.$executeRaw`
        UPDATE "feishu_inbound_event"
        SET "processed_at" = now(), "processed_by" = ${FEISHU_REPLICA_ID}, "lease_until" = NULL, "error" = NULL
        WHERE "id" = ${row.id}::uuid AND "processed_at" IS NULL`;
      return decision?.answer;
    } catch (error) {
      const reason = messageOf(error);
      const last = row.attempts >= FEISHU_INBOX_MAX_ATTEMPTS;
      // The next claim waits as a connection's backoff would, from the inbox's poll: 1, 2, 4, 8 polls.
      const waitMs = this.timing.inboxPollMs * 2 ** Math.max(row.attempts - 1, 0);
      await this.prisma.$executeRaw`
        UPDATE "feishu_inbound_event"
        SET "error" = ${reason}, "lease_until" = now() + ${waitMs}::int * interval '1 millisecond'
        WHERE "id" = ${row.id}::uuid AND "processed_at" IS NULL`
        .catch(() => undefined);
      this.logger.warn(
        `feishu event ${row.eventId} of app ${row.appId} failed on attempt ${row.attempts}`
          + `${last ? ', the last one; it is given up on' : ''}: ${reason}`,
      );
      return undefined;
    }
  }

  /** Delete rows processed, or given up on, longer ago than the retention (§7.1: 7 days). */
  async purge(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - this.timing.inboxRetentionMs);
    return this.prisma.$executeRaw`
      DELETE FROM "feishu_inbound_event"
      WHERE "processed_at" < ${before}
         OR ("processed_at" IS NULL AND "attempts" >= ${FEISHU_INBOX_MAX_ATTEMPTS} AND "received_at" < ${before})`;
  }
}
