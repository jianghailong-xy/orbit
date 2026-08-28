import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

import { PrismaService } from '../prisma/prisma.service';
import {
  coordinatorFailureFingerprint,
} from '../outcome-reconciler/outcome-coordinator';
import {
  OutcomeCoordinatorService,
  type OutcomeCoordinatorClaim,
  type OutcomeCoordinatorResolution,
} from '../outcome-reconciler/outcome-coordinator.service';
import { assertFullGitSha } from '../outcome-watchdog/outcome-watchdog';
import { OutcomeWatchdogService } from '../outcome-watchdog/outcome-watchdog.service';
import { CompletionAckCoordinatorResolver } from './completion-ack-coordinator.resolver';

const POLL_INTERVAL_MS = 5_000;
const HEARTBEAT_DEADLINE_MS = 30_000;
const HEARTBEAT_MIN_INTERVAL_MS = 10_000;
const TENANT_LIMIT = 257;
const CLAIM_LIMIT_PER_TENANT = 4;
const CLAIM_LIMIT_PER_PASS = 16;
const LEASE_LOGICAL_TICKS = 180;
const RESOLVER_TIMEOUT_MS = 120_000;
const LIVENESS_LOGICAL_TICKS = 300;
const ATTEMPT_BUDGET = 4_096;
const WAKE_BUDGET = 16_384;
const SAME_FINGERPRINT_LIMIT = 512;
const DEFAULT_CLOCK_ID = 'c0dec0de-c0de-40de-80de-c0dec0dec0de';

type CoordinatorClaim = OutcomeCoordinatorClaim & { workerId: string };

/**
 * Abort signals are cooperative: a resolver (or a database driver call inside one) may ignore
 * them forever.  The worker's lease and heartbeat SLO therefore need an actual wall-clock race,
 * not merely a signal that says a deadline passed.  The losing promise remains observed by
 * Promise.race, so a late rejection cannot become an unhandled rejection in the replacement
 * process.
 */
export async function withCoordinatorWallDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('COMPLETION_ACK_RESOLVER_WALL_DEADLINE_EXCEEDED'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

/**
 * Production clock/lease loop for completion-ACK recovery.
 *
 * It is a separate process from both apiserver (the failing commit path) and outcome-watchdog
 * (the detector). PostgreSQL owns every due time, lease, retry budget and transition; this timer
 * merely advances an already-declared logical clock and consumes due work. Multiple replicas are
 * safe because the source-specific claim function fences one 0198 lease before returning work.
 */
@Injectable()
export class CompletionAckOutcomeCoordinatorRunner
implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CompletionAckOutcomeCoordinatorRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private sourceSha!: string;
  private targetSha!: string;
  private instanceId!: string;
  private workerId!: string;
  private expectationGeneration!: string;
  private tenantCursor: string | null = null;
  private lastHeartbeatWallMs = 0;
  private readonly moduleGraphDigest = createHash('sha256').update([
    'outcome-coordinator/main',
    'outcome-coordinator/worker-module',
    'outcome-coordinator/runner',
    'outcome-coordinator/completion-ack-resolver',
    'outcome-reconciler/persistent-coordinator',
    'projects/coordinator-judgment',
    'prisma',
  ].sort().join('\n')).digest('hex');

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly coordinator: OutcomeCoordinatorService,
    private readonly resolver: CompletionAckCoordinatorResolver,
    private readonly watchdog: OutcomeWatchdogService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.sourceSha = this.config.get<string>('OUTCOME_COORDINATOR_SOURCE_SHA') ?? '';
    this.targetSha = this.config.get<string>('OUTCOME_COORDINATOR_TARGET_SHA') ?? '';
    assertFullGitSha(this.sourceSha, 'COORDINATOR_SOURCE');
    assertFullGitSha(this.targetSha, 'COORDINATOR_TARGET');
    this.instanceId = this.config.get<string>('OUTCOME_COORDINATOR_INSTANCE_ID')
      ?? `${hostname()}:${process.pid}`;
    this.workerId = `completion-ack-coordinator:${this.instanceId}:${this.sourceSha}`;
    this.expectationGeneration = this.config.get<string>(
      'OUTCOME_COORDINATOR_EXPECTATION_GENERATION',
    ) ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(this.expectationGeneration)) {
      throw new Error('OUTCOME_COORDINATOR_EXPECTATION_GENERATION_INVALID');
    }
    await this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce().catch((error) => this.logFailure(error)),
      POLL_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) throw new Error('OUTCOME_COORDINATOR_POLL_OVERRUN');
    this.running = true;
    try {
      const tenantIds = await this.tenantIds();
      let reconciled = 0;
      let attempted = 0;
      for (const tenantId of tenantIds) {
        const clock = await this.clock(tenantId);
        const logicalNow = this.logicalNow(clock.logicalTime);
        await this.coordinator.advanceClock({
          tenantId,
          clockId: clock.clockId,
          logicalNow,
        });
        const [reconcile] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(
          Prisma.sql`
            SELECT completion_ack_reconcile_coordinator(
              ${tenantId}::uuid,
              ${LIVENESS_LOGICAL_TICKS}::bigint,
              ${ATTEMPT_BUDGET}::integer,
              ${WAKE_BUDGET}::integer,
              ${SAME_FINGERPRINT_LIMIT}::integer,
              1::integer
            ) AS result
          `,
        );
        if (!reconcile) throw new Error('COMPLETION_ACK_COORDINATOR_RECONCILE_MISSING');
        reconciled += Number(asObject(reconcile.result).registered ?? 0);
        await this.maybeHeartbeat({ tenantCount: tenantIds.length, reconciled, attempted });

        for (let index = 0; index < CLAIM_LIMIT_PER_TENANT; index += 1) {
          if (attempted >= CLAIM_LIMIT_PER_PASS) break;
          const claim = await this.claim(tenantId);
          if (!claim) break;
          attempted += 1;
          await this.executeClaim(claim, clock.clockId);
          await this.maybeHeartbeat({ tenantCount: tenantIds.length, reconciled, attempted });
        }
      }
      await this.maybeHeartbeat(
        { tenantCount: tenantIds.length, reconciled, attempted },
        this.lastHeartbeatWallMs === 0,
      );
    } finally {
      this.running = false;
    }
  }

  private async maybeHeartbeat(
    counts: { tenantCount: number; reconciled: number; attempted: number },
    force = false,
  ): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastHeartbeatWallMs < HEARTBEAT_MIN_INTERVAL_MS) return;
    const completedAt = new Date(now);
    const heartbeat = await this.watchdog.appendRuntimeHeartbeat({
      component: 'outcome-coordinator',
      instanceId: this.instanceId,
      sourceSha: this.sourceSha,
      moduleGraphDigest: this.moduleGraphDigest,
      expectationGeneration: this.expectationGeneration,
      observedAt: completedAt,
      deadlineAt: new Date(completedAt.getTime() + HEARTBEAT_DEADLINE_MS),
      payload: {
        schemaVersion: 1,
        targetSha: this.targetSha,
        pollIntervalSeconds: POLL_INTERVAL_MS / 1_000,
        tenantCount: counts.tenantCount,
        reconciled: counts.reconciled,
        attempted: counts.attempted,
        sourceType: 'COMPLETION_ACK',
        capability: this.resolver.capability,
      },
    });
    this.lastHeartbeatWallMs = now;
    this.logger.log(JSON.stringify({
      event: 'OUTCOME_COORDINATOR_HEARTBEAT',
      instanceId: this.instanceId,
      sequence: heartbeat.sequence.toString(),
      heartbeatDigest: heartbeat.heartbeatDigest,
      sourceSha: this.sourceSha,
      tenantCount: counts.tenantCount,
      reconciled: counts.reconciled,
      attempted: counts.attempted,
    }));
  }

  private async tenantIds(): Promise<string[]> {
    const cursor = this.tenantCursor;
    const rows = await this.prisma.$queryRaw<Array<{ tenantId: string }>>(Prisma.sql`
      SELECT tenant_id AS "tenantId"
        FROM (
          SELECT tenant_id FROM completion_ack_active_obligation
          UNION
          SELECT tenant_id FROM outcome_coordinator_obligation
           WHERE source_type = 'COMPLETION_ACK'
             AND status IN ('READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION')
        ) tenants
       ORDER BY CASE
         WHEN ${cursor}::uuid IS NULL OR tenant_id > ${cursor}::uuid THEN 0 ELSE 1
       END, tenant_id
       LIMIT ${TENANT_LIMIT}::integer
    `);
    if (rows.length > 0) this.tenantCursor = rows[rows.length - 1].tenantId;
    return rows.map((row) => row.tenantId);
  }

  private async clock(tenantId: string): Promise<{ clockId: string; logicalTime: bigint }> {
    const [row] = await this.prisma.$queryRaw<Array<{
      clockId: string;
      logicalTime: bigint;
    }>>(Prisma.sql`
      SELECT clock_id AS "clockId", logical_time AS "logicalTime"
        FROM outcome_coordinator_clock
       WHERE tenant_id = ${tenantId}::uuid
    `);
    return row ?? { clockId: DEFAULT_CLOCK_ID, logicalTime: 0n };
  }

  private logicalNow(standing: bigint): string {
    const wall = BigInt(Math.floor(Date.now() / 1_000));
    return (wall > standing ? wall : standing).toString();
  }

  private async claim(tenantId: string): Promise<CoordinatorClaim | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue | null }>>(
      Prisma.sql`
        SELECT completion_ack_claim_next_coordination(
          ${tenantId}::uuid,
          ${this.workerId},
          ${LEASE_LOGICAL_TICKS}::bigint
        ) AS result
      `,
    );
    if (!row?.result) return null;
    return {
      ...(row.result as unknown as OutcomeCoordinatorClaim),
      workerId: this.workerId,
    };
  }

  private async executeClaim(claim: CoordinatorClaim, clockId: string): Promise<void> {
    const claimedAtLogicalTime = BigInt(claim.leaseExpiresLogicalTime)
      - BigInt(LEASE_LOGICAL_TICKS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVER_TIMEOUT_MS);
    let resolution: OutcomeCoordinatorResolution;
    try {
      resolution = await withCoordinatorWallDeadline(
        this.resolver.resolve({
          claim,
          logicalNow: this.logicalNow(claimedAtLogicalTime),
          signal: controller.signal,
        }),
        RESOLVER_TIMEOUT_MS,
        () => controller.abort(),
      );
    } catch (error) {
      resolution = {
        kind: 'RETRYABLE_FAILURE',
        code: 'COMPLETION_ACK_RESOLVER_FAILED',
        evidence: {
          errorType: error instanceof Error ? error.constructor.name : 'UNKNOWN',
          obligationRevision: claim.obligationRevision,
        },
        retryAfterLogicalTicks: 5,
      };
    } finally {
      clearTimeout(timer);
    }

    const base = {
      tenantId: claim.tenantId,
      clockId,
      logicalNow: this.logicalNow(claimedAtLogicalTime),
      coordinationId: claim.coordinationId,
      leaseToken: claim.leaseToken,
      workerId: this.workerId,
      callbackKey: `completion-ack-resolver:${claim.leaseId}`,
    };
    if (resolution.kind === 'DELIVERED' || resolution.kind === 'RESOLVED'
        || resolution.kind === 'SUPERSEDED' || resolution.kind === 'ESCALATED'
        || resolution.kind === 'TERMINAL') {
      await this.coordinator.recordResult({
        ...base,
        result: resolution.kind,
        detail: resolution.detail,
      });
      return;
    }
    if (resolution.kind === 'EXTERNAL_WAIT' || resolution.kind === 'QUOTA_WAIT') {
      await this.coordinator.recordResult({
        ...base,
        result: resolution.kind,
        retryAfterLogicalTicks: resolution.retryAfterLogicalTicks,
        detail: {
          provider: resolution.provider,
          condition: resolution.condition,
          pollBudget: resolution.pollBudget,
        },
      });
      return;
    }
    if (resolution.kind === 'RETRYABLE_FAILURE') {
      await this.coordinator.recordResult({
        ...base,
        result: 'RETRYABLE_FAILURE',
        failureFingerprint: coordinatorFailureFingerprint(resolution.code, {
          obligationRevision: claim.obligationRevision,
          evidence: resolution.evidence ?? {},
        }),
        retryAfterLogicalTicks: resolution.retryAfterLogicalTicks,
        detail: { code: resolution.code, evidence: resolution.evidence ?? {} },
      });
      return;
    }
    throw new Error(`COMPLETION_ACK_RESOLUTION_FORBIDDEN:${resolution.kind}`);
  }

  private logFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error('UNKNOWN');
    this.logger.error(`OUTCOME_COORDINATOR_POLL_FAILED: ${failure.message}`);
    // This process must not keep publishing an apparently live module graph after its only poll
    // loop failed.  Docker's restart policy supplies a fresh courier; the separately deployed
    // dead-man observes the missed generation heartbeat even if restart itself is unsuccessful.
    this.onModuleDestroy();
    queueMicrotask(() => { throw failure; });
  }
}
