import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { FailureContinuationControllerService } from './failure-continuation-controller.service';
import {
  FailureContinuationWakeClaim,
  failureContinuationWakeFact,
} from './failure-continuation';

const POLL_INTERVAL_MS = 5_000;
const LEASE_SECONDS = 30;
const CLAIM_LIMIT = 8;
const RETRY_DELAY_MS = 5_000;

export interface FailureContinuationSweepResult {
  scanned: number;
  materialized: number;
  requeued: number;
}

type CurrentState =
  | 'ACTIVE'
  | 'COORDINATOR_DISABLED'
  | 'OBLIGATION_NO_LONGER_CURRENT'
  | 'LEASE_LOST';

/**
 * Durable courier for typed-failure DIAGNOSIS continuations.
 *
 * PostgreSQL owns the fact, the idempotency key, due time and lease.  This timer only re-delivers
 * committed outbox rows.  Multiple API replicas are safe: SKIP LOCKED picks a row, and every
 * acknowledgement is fenced by both lease generation and token.  The outbox's planned Session id
 * is passed to `wakePlanned`, closing the process-crash windows before and after Session creation.
 */
@Injectable()
export class FailureContinuationService
implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FailureContinuationService.name);
  private readonly workerId = [
    'failure-continuation', hostname(), process.pid, randomUUID(),
  ].join(':');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private rerunRequested = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly judgments: CoordinatorJudgmentService,
    @Optional()
    private readonly controller?: FailureContinuationControllerService,
  ) {}

  onApplicationBootstrap(): void {
    void this.kick();
    this.timer = setInterval(() => void this.kick(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Immediate latency nudge. Correctness remains the periodic durable sweep. */
  async kick(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerunRequested = false;
        await this.runOnce();
      } while (this.rerunRequested);
    } catch (error) {
      this.logger.error(
        `failure continuation sweep failed: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** One bounded pass, public so the isolated regression can exercise the production path. */
  async runOnce(observedAt = new Date()): Promise<FailureContinuationSweepResult> {
    const result = await this.sweep(observedAt);
    const claims = await this.claimDue(this.workerId, observedAt, LEASE_SECONDS, CLAIM_LIMIT);
    for (const claim of claims) {
      try {
        await this.deliverClaim(claim, observedAt);
      } catch (error) {
        await this.retry(
          claim,
          new Date(observedAt.getTime() + RETRY_DELAY_MS),
          'FAILURE_CONTINUATION_DELIVERY_EXCEPTION',
        );
        this.logger.warn(
          `failure continuation delivery ${claim.outboxId} failed: `
          + `${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return result;
  }

  async sweep(observedAt = new Date(), limit = 64): Promise<FailureContinuationSweepResult> {
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT failure_continuation_sweep(${observedAt}, ${limit}::integer) AS result
    `);
    const value = (row?.result ?? {}) as Record<string, unknown>;
    return {
      scanned: Number(value.scanned ?? 0),
      materialized: Number(value.materialized ?? 0),
      requeued: Number(value.requeued ?? 0),
    };
  }

  async claimDue(
    workerId: string,
    observedAt = new Date(),
    leaseSeconds = LEASE_SECONDS,
    limit = CLAIM_LIMIT,
  ): Promise<FailureContinuationWakeClaim[]> {
    return this.prisma.$queryRaw<FailureContinuationWakeClaim[]>(Prisma.sql`
      SELECT outbox_id AS "outboxId", obligation_id AS "obligationId",
             tenant_id AS "tenantId", goal_id AS "goalId", task_id AS "taskId",
             continuation_id AS "continuationId",
             binding_revision AS "bindingRevision",
             attempt_generation AS "attemptGeneration",
             failure_fingerprint AS "failureFingerprint",
             idempotency_key AS "idempotencyKey",
             planned_session_id AS "plannedSessionId",
             lease_owner AS "leaseOwner", lease_token AS "leaseToken",
             lease_generation AS "leaseGeneration", leased_until AS "leasedUntil",
             delivery_attempts AS "deliveryAttempts", reason_code AS "reasonCode",
             termination_kind AS "terminationKind", actual_exit_code AS "actualExitCode",
             signal, receipt_digest AS "receiptDigest"
        FROM failure_continuation_claim_wakeups(
          ${workerId}, ${observedAt}, ${leaseSeconds}::integer, ${limit}::integer
        )
    `);
  }

  /**
   * Deliver the claimed row.  A caller may deliberately stop after `wakePlanned` and before this
   * method's ACK to reproduce a claimant crash; the next lease adopts the same planned Session.
   */
  async deliverClaim(
    claim: FailureContinuationWakeClaim,
    observedAt = new Date(),
  ): Promise<boolean> {
    const initial = await this.currentState(claim, observedAt);
    if (initial === 'LEASE_LOST') return false;
    if (initial === 'OBLIGATION_NO_LONGER_CURRENT') {
      return this.cancel(claim, observedAt, initial);
    }
    if (initial === 'COORDINATOR_DISABLED') {
      return this.retry(
        claim,
        new Date(observedAt.getTime() + RETRY_DELAY_MS),
        initial,
      );
    }

    // Route before opening the coordinator Session. The decision is append-only and keyed by the
    // obligation, so a crash after this call but before wake ACK replays the exact same plan.
    const route = this.controller
      ? await this.controller.routeClaim(claim, observedAt)
      : null;
    const fact = failureContinuationWakeFact(claim, route);
    const outcome = await this.judgments.wakePlanned(
      fact,
      async () => {
        const state = await this.currentState(claim, observedAt);
        return state === 'ACTIVE'
          ? { allowed: true as const }
          : { allowed: false as const, refusalCode: state };
      },
      claim.plannedSessionId,
    );

    if (outcome.outcome === 'OPENED') {
      return this.ack(
        claim,
        outcome.wakeId,
        outcome.sessionId,
        observedAt,
      );
    }
    if (outcome.outcome === 'REFUSED'
        && outcome.refusalCode === 'OBLIGATION_NO_LONGER_CURRENT') {
      return this.cancel(claim, observedAt, outcome.refusalCode);
    }
    return this.retry(
      claim,
      new Date(observedAt.getTime() + RETRY_DELAY_MS),
      outcome.outcome === 'REFUSED' ? outcome.refusalCode : outcome.outcome,
    );
  }

  private async currentState(
    claim: FailureContinuationWakeClaim,
    observedAt: Date,
  ): Promise<CurrentState> {
    const [row] = await this.prisma.$queryRaw<Array<{
      leaseCurrent: boolean;
      sourceCurrent: boolean;
      coordinatorEnabled: boolean;
    }>>(Prisma.sql`
      SELECT (
               wakeup.state = 'LEASED'
               AND wakeup.lease_token = ${claim.leaseToken}::uuid
               AND wakeup.lease_generation = ${claim.leaseGeneration}
               AND wakeup.leased_until > ${observedAt}
             ) AS "leaseCurrent",
             (
               continuation.kind = 'DIAGNOSIS'
               AND continuation.status = 'ACTIVE'
               AND continuation.goal_actionable = true
               AND current_task.project_id = obligation.goal_id
               AND current_task.scope_revision::bigint = obligation.binding_revision
               AND current_task.status NOT IN ('DONE', 'CANCELLED')
               AND current_task.superseded_by_task_id IS NULL
             ) AS "sourceCurrent",
             current_goal.coordinator_enabled AS "coordinatorEnabled"
        FROM failure_continuation_wakeup_outbox wakeup
        JOIN failure_continuation_obligation obligation
          ON obligation.obligation_id = wakeup.obligation_id
        JOIN task_executable_continuation continuation
          ON continuation.id = obligation.continuation_id
        JOIN task current_task ON current_task.id = obligation.task_id
        JOIN project current_goal ON current_goal.id = obligation.goal_id
       WHERE wakeup.outbox_id = ${claim.outboxId}::uuid
         AND wakeup.obligation_id = ${claim.obligationId}::uuid
         AND wakeup.planned_session_id = ${claim.plannedSessionId}::uuid
    `);
    if (!row || !row.leaseCurrent) return 'LEASE_LOST';
    if (!row.sourceCurrent) return 'OBLIGATION_NO_LONGER_CURRENT';
    return row.coordinatorEnabled ? 'ACTIVE' : 'COORDINATOR_DISABLED';
  }

  private async ack(
    claim: FailureContinuationWakeClaim,
    wakeId: string,
    sessionId: string,
    deliveredAt: Date,
  ): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<Array<{ applied: boolean }>>(Prisma.sql`
      SELECT failure_continuation_ack_wakeup(
        ${claim.outboxId}::uuid, ${claim.leaseToken}::uuid, ${claim.leaseGeneration},
        ${wakeId}::uuid, ${sessionId}::uuid, ${deliveredAt}
      ) AS applied
    `);
    return row?.applied === true;
  }

  private async retry(
    claim: FailureContinuationWakeClaim,
    availableAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<Array<{ applied: boolean }>>(Prisma.sql`
      SELECT failure_continuation_retry_wakeup(
        ${claim.outboxId}::uuid, ${claim.leaseToken}::uuid, ${claim.leaseGeneration},
        ${availableAt}, ${errorCode}
      ) AS applied
    `);
    return row?.applied === true;
  }

  private async cancel(
    claim: FailureContinuationWakeClaim,
    cancelledAt: Date,
    reasonCode: string,
  ): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<Array<{ applied: boolean }>>(Prisma.sql`
      SELECT failure_continuation_cancel_wakeup(
        ${claim.outboxId}::uuid, ${claim.leaseToken}::uuid, ${claim.leaseGeneration},
        ${cancelledAt}, ${reasonCode}
      ) AS applied
    `);
    return row?.applied === true;
  }
}
