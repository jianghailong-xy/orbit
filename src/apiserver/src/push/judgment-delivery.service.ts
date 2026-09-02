import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService, type JudgmentPushResult } from './push.service';

const DELIVERY_LEASE_SECONDS = 60;
const DELIVERY_MAX_FAILURES = 8;
const DELIVERY_MAX_CRASH_RECOVERIES = 64;
const DELIVERY_PER_DRAIN = 20;
const DELIVERY_BASE_BACKOFF_SECONDS = 15;
const DELIVERY_MAX_BACKOFF_SECONDS = 30 * 60;

interface DeliveryClaim {
  id: string;
  attempts: number;
  failures: number;
  claims: number;
  leaseHolder: string;
}

/** Exported for the PG specification and operator documentation, not as user-facing policy. */
export const JUDGMENT_DELIVERY_LIMITS = {
  leaseSeconds: DELIVERY_LEASE_SECONDS,
  maxFailures: DELIVERY_MAX_FAILURES,
  maxCrashRecoveries: DELIVERY_MAX_CRASH_RECOVERIES,
} as const;

function backoffSeconds(generation: number): number {
  return Math.min(
    DELIVERY_MAX_BACKOFF_SECONDS,
    DELIVERY_BASE_BACKOFF_SECONDS * (2 ** Math.min(Math.max(0, generation - 1), 7)),
  );
}

/**
 * Reliable APNs outbox worker for N12's in-app judgment items.
 *
 * There is no in-memory state machine and no fixed polling interval. The database row owns status,
 * attempts, lease and the next due instant. A producer kick gives the common path low latency; on
 * startup and after each pass this service schedules one timer for the earliest persisted due row.
 * A restart therefore resumes the same item, while two replicas converge through SKIP LOCKED and
 * the row lease rather than through process-local deduplication.
 */
@Injectable()
export class JudgmentDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JudgmentDeliveryService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private timerDue = Number.POSITIVE_INFINITY;
  private running?: Promise<number>;
  private rerun = false;
  private destroyed = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  onModuleInit(): void {
    // Startup recovery is a due-ledger read. It does not reconstruct request state or mint work.
    this.kick();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Nudge the durable worker after a request commits or a device is registered. */
  kick(delayMs = 0): void {
    if (this.destroyed) return;
    const due = Date.now() + Math.max(0, delayMs);
    if (this.timer && this.timerDue <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerDue = Number.POSITIVE_INFINITY;
      void this.runScheduled();
    }, Math.max(0, due - Date.now()));
    this.timer.unref();
  }

  private async runScheduled(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = this.deliverDue();
    try {
      await this.running;
    } catch (error) {
      this.logger.error(
        `judgment delivery drain failed: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      this.running = undefined;
    }
    if (this.rerun) {
      this.rerun = false;
      this.kick();
      return;
    }
    await this.schedulePersistedWake();
  }

  /** Public so a targeted recovery command/spec can drain the same production path. */
  async deliverDue(limit = DELIVERY_PER_DRAIN): Promise<number> {
    await this.expireCrashedDeliveries();
    let delivered = 0;
    for (let taken = 0; taken < limit; taken += 1) {
      const claim = await this.claimOne();
      if (!claim) break;
      await this.deliverClaim(claim);
      delivered += 1;
    }
    return delivered;
  }

  /** A worker that died 64 consecutive times is a DEAD fact, not an eternal expired lease. */
  private async expireCrashedDeliveries(): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "task_judgment_push_delivery"
         SET "status" = 'DEAD',
             "next_attempt_at" = NULL,
             "lease_holder" = NULL,
             "lease_expires_at" = NULL,
             "error_code" = 'WORKER_CRASH_LOOP',
             "required_action" = 'INSPECT_DELIVERY_WORKER',
             "last_error" = 'The delivery lease expired repeatedly before an outcome was recorded.',
             "stopped_at" = statement_timestamp(),
             "updated_at" = statement_timestamp()
       WHERE "status" = 'DELIVERING'
         AND "lease_expires_at" <= statement_timestamp()
         AND "claims" >= ${DELIVERY_MAX_CRASH_RECOVERIES}`;
  }

  /** One database-clock lease claim. SKIP LOCKED lets another replica take different work. */
  private async claimOne(): Promise<DeliveryClaim | null> {
    const holder = `${process.pid}:${randomUUID()}`;
    const [claim] = await this.prisma.$queryRaw<DeliveryClaim[]>(Prisma.sql`
      WITH candidate AS (
        SELECT delivery."id"
          FROM "task_judgment_push_delivery" delivery
          JOIN "task_judgment_inbox_item" inbox ON inbox."id" = delivery."inbox_item_id"
          JOIN "task_judgment_request" request ON request."id" = inbox."request_id"
         WHERE request."status" = 'OPEN'
           AND request."kind" = 'EVIDENCE_JUDGMENT'
           AND ((delivery."status" IN ('PENDING', 'BLOCKED')
                 AND delivery."next_attempt_at" <= statement_timestamp()) OR
                (delivery."status" = 'DELIVERING'
                 AND delivery."lease_expires_at" <= statement_timestamp()
                 AND delivery."claims" < ${DELIVERY_MAX_CRASH_RECOVERIES}))
         ORDER BY COALESCE(delivery."next_attempt_at", delivery."lease_expires_at"),
                  delivery."created_at", delivery."id"
         FOR UPDATE OF delivery SKIP LOCKED
         LIMIT 1
      )
      UPDATE "task_judgment_push_delivery" delivery
         SET "status" = 'DELIVERING',
             "attempts" = delivery."attempts" + 1,
             "claims" = CASE WHEN delivery."status" = 'DELIVERING'
                              THEN delivery."claims" + 1 ELSE 0 END,
             "next_attempt_at" = NULL,
             "lease_holder" = ${holder},
             "lease_expires_at" = statement_timestamp()
               + make_interval(secs => ${DELIVERY_LEASE_SECONDS}),
             "last_attempt_at" = statement_timestamp(),
             "updated_at" = statement_timestamp()
        FROM candidate
       WHERE delivery."id" = candidate."id"
      RETURNING delivery."id", delivery."attempts", delivery."failures", delivery."claims",
                delivery."lease_holder" AS "leaseHolder"
    `);
    return claim ?? null;
  }

  private async deliverClaim(claim: DeliveryClaim): Promise<void> {
    try {
      const row = await this.prisma.taskJudgmentPushDelivery.findFirst({
        where: { id: claim.id, status: 'DELIVERING', leaseHolder: claim.leaseHolder },
        include: {
          inboxItem: {
            include: { request: { select: { status: true, kind: true } } },
          },
        },
      });
      if (!row || row.inboxItem.request.status !== 'OPEN'
        || row.inboxItem.request.kind !== 'EVIDENCE_JUDGMENT') return;

      const openCount = await this.prisma.taskJudgmentInboxItem.count({
        where: {
          recipientId: row.inboxItem.recipientId,
          request: { status: 'OPEN', kind: 'EVIDENCE_JUDGMENT' },
        },
      });
      const result = await this.push.deliverJudgmentRequest({
        recipientId: row.inboxItem.recipientId,
        requestId: row.requestId,
        requestVersion: row.requestVersion,
        taskId: row.inboxItem.taskId,
        taskTitle: row.inboxItem.taskTitle,
        projectId: row.inboxItem.projectId,
        projectTitle: row.inboxItem.projectTitle,
        requiredAction: row.inboxItem.requiredAction,
        deepLink: row.inboxItem.deepLink,
        openCount,
      });
      await this.finishDelivery(claim, result);
    } catch (error) {
      await this.finishDelivery(claim, {
        outcome: 'RETRY',
        code: 'DELIVERY_WORKER_ERROR',
        requiredAction: 'RETRY_PUSH',
        error: error instanceof Error ? error.message : String(error),
        payload: {},
      });
    }
  }

  /** Fenced receipt write. A request-terminal trigger that won the race makes this match zero. */
  private async finishDelivery(claim: DeliveryClaim, result: JudgmentPushResult): Promise<void> {
    const nextFailures = result.outcome === 'RETRY' ? claim.failures + 1 : claim.failures;
    const dead = result.outcome === 'RETRY' && nextFailures >= DELIVERY_MAX_FAILURES;
    const status = result.outcome === 'DELIVERED'
      ? 'DELIVERED'
      : dead
        ? 'DEAD'
        : result.outcome === 'BLOCKED'
          ? 'BLOCKED'
          : 'PENDING';
    const retrySeconds = status === 'PENDING' || status === 'BLOCKED'
      ? backoffSeconds(result.outcome === 'BLOCKED' ? claim.attempts : nextFailures)
      : null;
    const errorCode = result.outcome === 'DELIVERED' ? null : result.code;
    const requiredAction = result.outcome === 'DELIVERED' ? null : result.requiredAction;
    const lastError = result.outcome === 'DELIVERED' ? null : result.error;
    const devices = result.outcome === 'DELIVERED' ? result.devices : null;

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "task_judgment_push_delivery" delivery
         SET "status" = ${status}::"task_judgment_push_delivery_status",
             "failures" = ${nextFailures},
             "claims" = 0,
             "next_attempt_at" = CASE WHEN ${retrySeconds}::integer IS NULL THEN NULL
               ELSE statement_timestamp() + make_interval(secs => ${retrySeconds}::integer) END,
             "lease_holder" = NULL,
             "lease_expires_at" = NULL,
             "error_code" = ${errorCode},
             "required_action" = ${requiredAction},
             "last_error" = ${lastError},
             "last_payload" = ${JSON.stringify(result.payload)}::jsonb,
             "delivered_devices" = ${devices},
             "delivered_at" = CASE WHEN ${status} = 'DELIVERED'
               THEN statement_timestamp() ELSE NULL END,
             "stopped_at" = CASE WHEN ${status} = 'DEAD'
               THEN statement_timestamp() ELSE NULL END,
             "updated_at" = statement_timestamp()
       WHERE delivery."id" = ${claim.id}::uuid
         AND delivery."status" = 'DELIVERING'
         AND delivery."lease_holder" = ${claim.leaseHolder}
         AND EXISTS (
           SELECT 1
             FROM "task_judgment_inbox_item" inbox
             JOIN "task_judgment_request" request ON request."id" = inbox."request_id"
            WHERE inbox."id" = delivery."inbox_item_id"
              AND request."status" = 'OPEN'
              AND request."kind" = 'EVIDENCE_JUDGMENT'
         )
    `);
  }

  /** Schedule exactly the next persisted due/lease instant; no fixed polling tick exists. */
  private async schedulePersistedWake(): Promise<void> {
    if (this.destroyed) return;
    const [row] = await this.prisma.$queryRaw<Array<{ due: Date | null }>>(Prisma.sql`
      SELECT min(CASE delivery."status"
                   WHEN 'DELIVERING' THEN delivery."lease_expires_at"
                   ELSE delivery."next_attempt_at"
                 END) AS "due"
        FROM "task_judgment_push_delivery" delivery
        JOIN "task_judgment_inbox_item" inbox ON inbox."id" = delivery."inbox_item_id"
        JOIN "task_judgment_request" request ON request."id" = inbox."request_id"
       WHERE request."status" = 'OPEN'
         AND request."kind" = 'EVIDENCE_JUDGMENT'
         AND delivery."status" IN ('PENDING', 'BLOCKED', 'DELIVERING')
    `);
    if (row?.due) this.kick(Math.max(0, row.due.getTime() - Date.now()));
  }
}
