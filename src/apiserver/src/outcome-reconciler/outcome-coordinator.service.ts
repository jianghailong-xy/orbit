import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ActionExecutorService,
} from './action-executor.service';
import type {
  BoundSourceObligation,
  ConstrainedActionIntent,
} from './action-executor';
import {
  coordinatorFailureFingerprint,
  validateCoordinatorOwnerDecision,
  validateCoordinatorSourceObligation,
  type CoordinatorOwnerDecisionPayload,
  type CoordinatorSourceObligation,
} from './outcome-coordinator';

export interface OutcomeCoordinatorClaim {
  coordinationId: string;
  tenantId: string;
  projectId: string;
  obligationId: string;
  obligationRevision: string;
  capability: string;
  attemptNumber: number;
  attemptBudgetRemaining: number;
  diagnosticPath: string;
  leaseId: string;
  leaseToken: string;
  leaseExpiresLogicalTime: string;
  sourceObligation: CoordinatorSourceObligation;
}

export interface OutcomeCoordinatorContext {
  claim: OutcomeCoordinatorClaim;
  logicalNow: string;
  signal: AbortSignal;
}

export type OutcomeCoordinatorResolution =
  | {
      kind: 'ACTION';
      intent: ConstrainedActionIntent;
      sourceObligation: BoundSourceObligation;
      fairWaitLogicalTicks?: number;
    }
  | {
      kind: 'EXTERNAL_WAIT' | 'QUOTA_WAIT';
      provider: string;
      condition: Record<string, unknown>;
      pollBudget: number;
      retryAfterLogicalTicks: number;
    }
  | {
      kind: 'OWNER_DECISION';
      reason: string;
      request: CoordinatorOwnerDecisionPayload;
    }
  | {
      kind: 'RETRYABLE_FAILURE';
      code: string;
      evidence?: Record<string, unknown>;
      retryAfterLogicalTicks?: number;
    }
  | {
      kind: 'DELIVERED' | 'RESOLVED' | 'SUPERSEDED' | 'ESCALATED' | 'TERMINAL';
      detail?: Record<string, unknown>;
    };

export interface OutcomeCoordinatorResolver {
  capability: string;
  resolve(context: OutcomeCoordinatorContext): Promise<OutcomeCoordinatorResolution>;
}

type JsonResult = Record<string, unknown>;

function asResult(value: Prisma.JsonValue): JsonResult {
  return value as unknown as JsonResult;
}

@Injectable()
export class OutcomeCoordinatorResolverRegistry {
  private readonly resolvers = new Map<string, OutcomeCoordinatorResolver>();

  register(resolver: OutcomeCoordinatorResolver): void {
    if (!resolver.capability.trim()) throw new Error('COORDINATOR_RESOLVER_CAPABILITY_REQUIRED');
    const standing = this.resolvers.get(resolver.capability);
    if (standing && standing !== resolver) {
      throw new Error(`COORDINATOR_RESOLVER_REGISTRATION_CONFLICT:${resolver.capability}`);
    }
    this.resolvers.set(resolver.capability, resolver);
  }

  resolve(capability: string): OutcomeCoordinatorResolver | null {
    return this.resolvers.get(capability) ?? null;
  }
}

/**
 * Persistent control-plane adapter. PostgreSQL owns clocks, leases, wakes, budgets, fairness and
 * the append-only trace; this service only translates resolver outcomes into fenced transitions.
 * A resolver cannot perform an effect through this API: its only effectful response is ACTION,
 * which is admitted by ActionExecutorService before the coordinator records delivery.
 */
@Injectable()
export class OutcomeCoordinatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: ActionExecutorService,
    private readonly resolvers: OutcomeCoordinatorResolverRegistry,
  ) {}

  async advanceClock(input: {
    tenantId: string;
    clockId: string;
    logicalNow: string;
  }): Promise<JsonResult> {
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_advance_coordinator_clock(
        ${input.tenantId}::uuid,
        ${input.clockId}::uuid,
        ${BigInt(input.logicalNow)}::bigint
      ) AS result
    `);
    if (!row) throw new Error('Coordinator clock returned no result');
    return asResult(row.result);
  }

  async reconcileActive(input: {
    tenantId: string;
    clockId: string;
    logicalNow: string;
    livenessDelta: number;
    attemptBudget: number;
    wakeBudget: number;
    sameFailureFingerprintLimit: number;
    maxLeaseRenewals?: number;
  }): Promise<JsonResult> {
    await this.advanceClock(input);
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_reconcile_active_obligations(
        ${input.tenantId}::uuid,
        ${input.livenessDelta}::bigint,
        ${input.attemptBudget},
        ${input.wakeBudget},
        ${input.sameFailureFingerprintLimit},
        ${input.maxLeaseRenewals ?? 1}
      ) AS result
    `);
    if (!row) throw new Error('Coordinator reconciliation returned no result');
    return asResult(row.result);
  }

  async claimNext(input: {
    tenantId: string;
    clockId: string;
    logicalNow: string;
    workerId: string;
    leaseLogicalTicks: number;
  }): Promise<OutcomeCoordinatorClaim | null> {
    await this.advanceClock(input);
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue | null }>>(Prisma.sql`
      SELECT outcome_claim_next_coordination(
        ${input.tenantId}::uuid,
        ${input.workerId},
        ${input.leaseLogicalTicks}::bigint
      ) AS result
    `);
    if (!row?.result) return null;
    return row.result as unknown as OutcomeCoordinatorClaim;
  }

  async renewLease(input: {
    tenantId: string;
    clockId: string;
    logicalNow: string;
    coordinationId: string;
    leaseToken: string;
    workerId: string;
    extensionLogicalTicks: number;
  }): Promise<JsonResult> {
    await this.advanceClock(input);
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_renew_coordinator_lease(
        ${input.tenantId}::uuid,
        ${input.coordinationId}::uuid,
        ${input.leaseToken}::uuid,
        ${input.workerId},
        ${input.extensionLogicalTicks}::bigint
      ) AS result
    `);
    if (!row) throw new Error('Coordinator lease renewal returned no result');
    return asResult(row.result);
  }

  async recordResult(input: {
    tenantId: string;
    clockId: string;
    logicalNow: string;
    coordinationId: string;
    leaseToken: string;
    workerId: string;
    callbackKey: string;
    result: 'DELIVERED' | 'ACTION_ENQUEUED' | 'RETRYABLE_FAILURE' | 'QUOTA_WAIT'
      | 'EXTERNAL_WAIT' | 'RESOLVED' | 'SUPERSEDED' | 'ESCALATED' | 'TERMINAL';
    failureFingerprint?: string | null;
    retryAfterLogicalTicks?: number | null;
    detail?: Record<string, unknown>;
  }): Promise<JsonResult> {
    await this.advanceClock(input);
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_record_coordinator_result(
        ${input.tenantId}::uuid,
        ${input.coordinationId}::uuid,
        ${input.leaseToken}::uuid,
        ${input.workerId},
        ${input.callbackKey},
        ${input.result},
        ${input.failureFingerprint ?? null},
        ${input.retryAfterLogicalTicks ?? null}::bigint,
        ${JSON.stringify(input.detail ?? {})}::jsonb
      ) AS result
    `);
    if (!row) throw new Error('Coordinator result returned no receipt');
    return asResult(row.result);
  }

  async requestOwnerDecision(input: {
    tenantId: string;
    clockId: string;
    logicalNow: string;
    coordinationId: string;
    leaseToken: string;
    workerId: string;
    reason: string;
    request: CoordinatorOwnerDecisionPayload;
  }): Promise<JsonResult> {
    const obligation = await this.readSourceObligation(input.tenantId, input.coordinationId);
    const invalid = validateCoordinatorOwnerDecision(obligation, input.reason, input.request);
    if (invalid) throw new Error(invalid);
    await this.advanceClock(input);
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_request_coordinator_owner_decision(
        ${input.tenantId}::uuid,
        ${input.coordinationId}::uuid,
        ${input.leaseToken}::uuid,
        ${input.workerId},
        ${input.reason},
        ${JSON.stringify(input.request)}::jsonb
      ) AS result
    `);
    if (!row) throw new Error('Coordinator owner request returned no receipt');
    return asResult(row.result);
  }

  async decideOwnerRequest(input: {
    tenantId: string;
    clockId: string;
    logicalNow: string;
    requestId: string;
    requestRevision: string;
    obligationId: string;
    obligationRevision: string;
    bindingDigest: string;
    idempotencyKey: string;
    decision: Record<string, unknown>;
  }): Promise<JsonResult> {
    await this.advanceClock(input);
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_decide_coordinator_owner_request(
        ${input.tenantId}::uuid,
        ${input.requestId}::uuid,
        ${input.requestRevision},
        ${input.obligationId},
        ${input.obligationRevision},
        ${input.bindingDigest},
        ${input.idempotencyKey},
        ${JSON.stringify(input.decision)}::jsonb
      ) AS result
    `);
    if (!row) throw new Error('Coordinator owner decision returned no receipt');
    return asResult(row.result);
  }

  async sweep(input: {
    tenantId: string;
    clockId: string;
    logicalNow: string;
  }): Promise<JsonResult> {
    await this.advanceClock(input);
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_sweep_coordinator(${input.tenantId}::uuid) AS result
    `);
    if (!row) throw new Error('Coordinator sweep returned no result');
    return asResult(row.result);
  }

  async auditLiveness(input: {
    tenantId: string;
    clockId: string;
    logicalNow: string;
  }): Promise<Array<{ coordinationId: string; status: string; violationCode: string }>> {
    await this.advanceClock(input);
    return this.prisma.$queryRaw<Array<{
      coordinationId: string;
      status: string;
      violationCode: string;
    }>>(Prisma.sql`
      SELECT coordination_id AS "coordinationId", status, violation_code AS "violationCode"
        FROM outcome_coordinator_liveness_audit(${input.tenantId}::uuid)
       ORDER BY coordination_id
    `);
  }

  private async readSourceObligation(
    tenantId: string,
    coordinationId: string,
  ): Promise<CoordinatorSourceObligation> {
    const [row] = await this.prisma.$queryRaw<Array<{ source: Prisma.JsonValue }>>(Prisma.sql`
      SELECT source_obligation AS source
        FROM outcome_coordinator_obligation
       WHERE tenant_id = ${tenantId}::uuid
         AND coordination_id = ${coordinationId}::uuid
    `);
    if (!row) throw new Error('COORDINATOR_OBLIGATION_NOT_FOUND');
    const source = row.source as unknown as CoordinatorSourceObligation;
    const invalid = validateCoordinatorSourceObligation(source);
    if (invalid) throw new Error(invalid);
    return source;
  }

  async executeNext(input: {
    tenantId: string;
    clockId: string;
    logicalNow: string;
    workerId: string;
    leaseLogicalTicks: number;
    wallClockTimeoutMs?: number;
  }): Promise<JsonResult | null> {
    const claim = await this.claimNext(input);
    if (!claim) return null;
    const resolver = this.resolvers.resolve(claim.capability);
    if (!resolver) {
      return this.recordResult({
        ...input,
        coordinationId: claim.coordinationId,
        leaseToken: claim.leaseToken,
        callbackKey: `resolver-unavailable:${claim.leaseId}`,
        result: 'RETRYABLE_FAILURE',
        failureFingerprint: coordinatorFailureFingerprint('RESOLVER_UNAVAILABLE', {
          capability: claim.capability,
          obligationRevision: claim.obligationRevision,
        }),
        detail: { code: 'RESOLVER_UNAVAILABLE', capability: claim.capability },
      });
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(input.wallClockTimeoutMs ?? 300_000, 300_000));
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('COORDINATOR_RESOLVER_TIMEOUT'));
        }, timeoutMs);
      });
      const resolution = await Promise.race([
        resolver.resolve({ claim, logicalNow: input.logicalNow, signal: controller.signal }),
        timeout,
      ]);
      const base = {
        ...input,
        coordinationId: claim.coordinationId,
        leaseToken: claim.leaseToken,
        callbackKey: `resolver:${claim.leaseId}`,
      };
      if (resolution.kind === 'ACTION') {
        const queued = await this.actions.enqueue({
          intent: resolution.intent,
          sourceObligation: resolution.sourceObligation,
          logicalNow: input.logicalNow,
          fairWaitLogicalTicks: resolution.fairWaitLogicalTicks,
        });
        if (typeof queued.actionIntentId !== 'string') {
          return this.recordResult({
            ...base,
            result: 'RETRYABLE_FAILURE',
            failureFingerprint: coordinatorFailureFingerprint('ACTION_EXECUTOR_REFUSED', {
              obligationRevision: claim.obligationRevision,
              response: queued,
            }),
            detail: { code: 'ACTION_EXECUTOR_REFUSED', response: queued },
          });
        }
        return this.recordResult({
          ...base,
          result: 'ACTION_ENQUEUED',
          detail: { actionIntentId: queued.actionIntentId, executorReceipt: queued },
        });
      }
      if (resolution.kind === 'OWNER_DECISION') {
        return this.requestOwnerDecision({
          ...base,
          reason: resolution.reason,
          request: resolution.request,
        });
      }
      if (resolution.kind === 'EXTERNAL_WAIT' || resolution.kind === 'QUOTA_WAIT') {
        return this.recordResult({
          ...base,
          result: resolution.kind,
          retryAfterLogicalTicks: resolution.retryAfterLogicalTicks,
          detail: {
            provider: resolution.provider,
            condition: resolution.condition,
            pollBudget: resolution.pollBudget,
          },
        });
      }
      if (resolution.kind === 'RETRYABLE_FAILURE') {
        return this.recordResult({
          ...base,
          result: 'RETRYABLE_FAILURE',
          failureFingerprint: coordinatorFailureFingerprint(resolution.code, {
            obligationRevision: claim.obligationRevision,
            ...(resolution.evidence ?? {}),
          }),
          retryAfterLogicalTicks: resolution.retryAfterLogicalTicks,
          detail: { code: resolution.code, ...(resolution.evidence ?? {}) },
        });
      }
      return this.recordResult({
        ...base,
        result: resolution.kind,
        detail: 'detail' in resolution ? resolution.detail : undefined,
      });
    } catch (error) {
      return this.recordResult({
        ...input,
        coordinationId: claim.coordinationId,
        leaseToken: claim.leaseToken,
        callbackKey: `resolver-failure:${claim.leaseId}`,
        result: 'RETRYABLE_FAILURE',
        failureFingerprint: coordinatorFailureFingerprint('RESOLVER_FAILURE', {
          obligationRevision: claim.obligationRevision,
          error: error instanceof Error ? error.message : String(error),
        }),
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
