import { Injectable } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import type {
  OutcomeCoordinatorClaim,
  OutcomeCoordinatorContext,
  OutcomeCoordinatorResolution,
  OutcomeCoordinatorResolver,
} from '../outcome-reconciler/outcome-coordinator.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import type { WakeFact } from '../projects/coordinator-wake';

export const COMPLETION_ACK_RECOVERY_CAPABILITY = 'completion-ack.recover';

const FOLLOW_UP_LOGICAL_TICKS = 30;
const DELIVERY_RETRY_LOGICAL_TICKS = 5;
const DELIVERY_POLL_BUDGET = 2_880;

interface DeliveryPlan {
  planId: string;
  targetSessionId: string;
  subjectVersion: string;
  wakeId?: string | null;
  sessionId?: string | null;
  sessionStatus?: string | null;
}

interface DeliveryState {
  sourceActive: boolean;
  sourceClosed: boolean;
  latestDeliveryRevoked: boolean;
  latestPlan: DeliveryPlan | null;
  latestDelivery: {
    deliveryReceiptId: string;
    planId: string;
    wakeId: string;
    sessionId: string;
    sessionStatus: string | null;
    engineTurnActive: boolean;
    retryAt: string | null;
  } | null;
  remediationActions: Array<{
    actionKind: string;
    taskId?: string | null;
    taskStatus?: string | null;
  }>;
  activeTaskCount: number;
  settledTaskCount: number;
}

interface PlannedDelivery {
  planId: string;
  targetSessionId: string;
  subjectVersion: string;
  replayed: boolean;
}

interface DeliveryReceipt {
  deliveryReceiptId: string;
  planId: string;
  sessionId: string;
  wakeId: string;
  replayed: boolean;
  adopted: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === 'string' && value[key] ? value[key] as string : null;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const raw = value[key];
  const parsed = typeof raw === 'number' ? raw : Number(raw ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePlan(value: unknown): DeliveryPlan | null {
  const row = asRecord(value);
  const planId = stringField(row, 'planId');
  const targetSessionId = stringField(row, 'targetSessionId');
  const subjectVersion = stringField(row, 'subjectVersion');
  if (!planId || !targetSessionId || !subjectVersion) return null;
  return {
    planId,
    targetSessionId,
    subjectVersion,
    wakeId: stringField(row, 'wakeId'),
    sessionId: stringField(row, 'sessionId'),
    sessionStatus: stringField(row, 'sessionStatus'),
  };
}

function normalizeState(value: Prisma.JsonValue): DeliveryState {
  const row = asRecord(value);
  const latest = asRecord(row.latestDelivery);
  const remediationActions = Array.isArray(row.remediationActions)
    ? row.remediationActions.map((item) => {
        const action = asRecord(item);
        return {
          actionKind: stringField(action, 'actionKind') ?? 'UNKNOWN',
          taskId: stringField(action, 'taskId'),
          taskStatus: stringField(action, 'taskStatus'),
        };
      })
    : [];
  const deliveryReceiptId = stringField(latest, 'deliveryReceiptId');
  const planId = stringField(latest, 'planId');
  const wakeId = stringField(latest, 'wakeId');
  const sessionId = stringField(latest, 'sessionId');
  return {
    sourceActive: row.sourceActive === true,
    sourceClosed: row.sourceClosed === true,
    latestDeliveryRevoked: row.latestDeliveryRevoked === true,
    latestPlan: normalizePlan(row.latestPlan),
    latestDelivery: deliveryReceiptId && planId && wakeId && sessionId
      ? {
          deliveryReceiptId,
          planId,
          wakeId,
          sessionId,
          sessionStatus: stringField(latest, 'sessionStatus'),
          engineTurnActive: latest.engineTurnActive === true,
          retryAt: stringField(latest, 'retryAt'),
        }
      : null,
    remediationActions,
    activeTaskCount: numberField(row, 'activeTaskCount'),
    settledTaskCount: numberField(row, 'settledTaskCount'),
  };
}

function completionBinding(claim: OutcomeCoordinatorClaim): Record<string, unknown> {
  return asRecord(claim.sourceObligation.binding);
}

function claimWorkerId(claim: OutcomeCoordinatorClaim): string {
  const workerId = stringField(asRecord(claim), 'workerId');
  if (!workerId) throw new Error('COMPLETION_ACK_COORDINATOR_WORKER_ID_MISSING');
  return workerId;
}

/**
 * The only capability adapter hosted by the completion coordinator process.
 *
 * This resolver may perform exactly one effect: deliver the already-committed obligation to the
 * owning project's coordinator Session. PostgreSQL plans the target id before that effect and
 * validates the immutable receipt afterwards. It cannot decide the obligation; an ACK CLOSED
 * event remains the only resolution authority.
 */
@Injectable()
export class CompletionAckCoordinatorResolver implements OutcomeCoordinatorResolver {
  readonly capability = COMPLETION_ACK_RECOVERY_CAPABILITY;

  constructor(
    private readonly prisma: PrismaService,
    private readonly judgments: CoordinatorJudgmentService,
    private readonly realtime: RealtimeService,
  ) {}

  async resolve(context: OutcomeCoordinatorContext): Promise<OutcomeCoordinatorResolution> {
    const { claim } = context;
    if (claim.capability !== this.capability
        || claim.sourceObligation.capability !== this.capability
        || claim.sourceObligation.owner !== 'PROJECT_COORDINATOR') {
      return {
        kind: 'RETRYABLE_FAILURE',
        code: 'COMPLETION_ACK_SOURCE_CONTRACT_MISMATCH',
        evidence: {
          capability: claim.capability,
          sourceCapability: claim.sourceObligation.capability,
          owner: claim.sourceObligation.owner,
        },
        retryAfterLogicalTicks: DELIVERY_RETRY_LOGICAL_TICKS,
      };
    }

    const state = await this.readState(claim);
    if (state.sourceClosed) {
      // Normally the source-only reconciliation pass terminalizes this before it can be claimed.
      // This branch closes the lease if ACK commits between reconciliation and resolver read.
      return {
        kind: 'RESOLVED',
        detail: { code: 'COMPLETION_ACK_CANONICAL_SOURCE_CLOSED' },
      };
    }
    if (!state.sourceActive) {
      return {
        kind: 'RETRYABLE_FAILURE',
        code: 'COMPLETION_ACK_SOURCE_STATE_INDETERMINATE',
        evidence: { obligationRevision: claim.obligationRevision },
        retryAfterLogicalTicks: DELIVERY_RETRY_LOGICAL_TICKS,
      };
    }

    // A plan without a receipt is the crash window. Recover it before considering another
    // delivery, including a Session inserted by the dead worker but not yet bound to its wake.
    if (state.latestPlan
        && (!state.latestDelivery || state.latestPlan.planId !== state.latestDelivery.planId)) {
      return this.deliverPlan(context, state.latestPlan);
    }

    // A revoked receipt is immutable history, not a crash-window plan to adopt and not live
    // delivery authority.  Planning under this claim's newer lease creates a distinct plan/session.
    const prior = state.latestDeliveryRevoked ? null : state.latestDelivery;
    if (prior) {
      const status = prior.sessionStatus;
      const liveSession = status === RunStatus.PENDING
        || status === RunStatus.RUNNING
        || status === RunStatus.INTERRUPTED
        || prior.engineTurnActive;
      const autoRetryOwnsFailure = status === RunStatus.FAILED && prior.retryAt !== null;
      if (liveSession || autoRetryOwnsFailure || state.activeTaskCount > 0) {
        return {
          kind: 'EXTERNAL_WAIT',
          provider: 'ORBIT_PROJECT_COORDINATOR',
          condition: {
            obligationId: claim.obligationId,
            obligationRevision: claim.obligationRevision,
            deliveryReceiptId: prior.deliveryReceiptId,
            sessionId: prior.sessionId,
            activeTaskCount: state.activeTaskCount,
          },
          pollBudget: DELIVERY_POLL_BUDGET,
          retryAfterLogicalTicks: FOLLOW_UP_LOGICAL_TICKS,
        };
      }
      // A one-shot coordinator that returned AWAITING_INPUT without a durable task/action did not
      // accept the obligation. Likewise, settled actions while the ACK is still ACTIVE mean the
      // next recovery step must be routed. Both produce a new fenced delivery attempt below.
    }

    const plan = await this.plan(context.claim);
    return this.deliverPlan(context, plan);
  }

  private async readState(claim: OutcomeCoordinatorClaim): Promise<DeliveryState> {
    const [row] = await this.prisma.$queryRaw<Array<{ state: Prisma.JsonValue }>>(Prisma.sql`
      SELECT completion_ack_coordination_state(
        ${claim.tenantId}::uuid,
        ${claim.coordinationId}::uuid
      ) AS state
    `);
    if (!row) throw new Error('COMPLETION_ACK_COORDINATION_STATE_MISSING');
    return normalizeState(row.state);
  }

  private async plan(claim: OutcomeCoordinatorClaim): Promise<PlannedDelivery> {
    const [row] = await this.prisma.$queryRaw<Array<{ plan: Prisma.JsonValue }>>(Prisma.sql`
      SELECT completion_ack_plan_coordinator_delivery(
        ${claim.tenantId}::uuid,
        ${claim.coordinationId}::uuid,
        ${claim.leaseToken}::uuid,
        ${claimWorkerId(claim)}
      ) AS plan
    `);
    const plan = asRecord(row?.plan);
    const planId = stringField(plan, 'planId');
    const targetSessionId = stringField(plan, 'targetSessionId');
    const subjectVersion = stringField(plan, 'subjectVersion');
    if (!planId || !targetSessionId || !subjectVersion) {
      throw new Error('COMPLETION_ACK_DELIVERY_PLAN_INVALID');
    }
    return {
      planId,
      targetSessionId,
      subjectVersion,
      replayed: plan.replayed === true,
    };
  }

  private async deliverPlan(
    context: OutcomeCoordinatorContext,
    plan: DeliveryPlan,
  ): Promise<OutcomeCoordinatorResolution> {
    const { claim } = context;
    const binding = completionBinding(claim);
    const taskId = stringField(binding, 'taskId');
    const affectedSessionId = stringField(binding, 'sessionId');
    if (!taskId || !affectedSessionId) {
      return {
        kind: 'RETRYABLE_FAILURE',
        code: 'COMPLETION_ACK_BINDING_INCOMPLETE',
        evidence: { bindingDigest: claim.sourceObligation.bindingDigest },
        retryAfterLogicalTicks: DELIVERY_RETRY_LOGICAL_TICKS,
      };
    }

    const fact: WakeFact = {
      event: 'COMPLETION_ACK_STALE',
      projectId: claim.projectId,
      subjectType: 'TASK',
      subjectId: taskId,
      // This is a delivery-attempt identity, not an obligation revision. The canonical identity
      // remains in detail and in every read surface; retries never mint a second obligation.
      subjectVersion: plan.subjectVersion,
      detail: {
        ...claim.sourceObligation,
        coordinationId: claim.coordinationId,
        coordinationAttempt: claim.attemptNumber,
        deliveryPlanId: plan.planId,
      },
    };
    const opened = await this.judgments.wakePlanned(fact, () => ({ allowed: true }), plan.targetSessionId);
    if (opened.outcome === 'REFUSED') {
      return {
        kind: 'EXTERNAL_WAIT',
        provider: 'ORBIT_PROJECT_COORDINATOR_LANDING',
        condition: {
          code: opened.refusalCode,
          projectId: claim.projectId,
          planId: plan.planId,
        },
        pollBudget: DELIVERY_POLL_BUDGET,
        retryAfterLogicalTicks: FOLLOW_UP_LOGICAL_TICKS,
      };
    }
    if (opened.outcome !== 'OPENED') {
      return {
        kind: 'RETRYABLE_FAILURE',
        code: `COMPLETION_ACK_DELIVERY_${opened.outcome}`,
        evidence: { planId: plan.planId },
        retryAfterLogicalTicks: DELIVERY_RETRY_LOGICAL_TICKS,
      };
    }

    const [row] = await this.prisma.$queryRaw<Array<{ receipt: Prisma.JsonValue }>>(Prisma.sql`
      SELECT completion_ack_record_coordinator_delivery(
        ${claim.tenantId}::uuid,
        ${claim.coordinationId}::uuid,
        ${claim.leaseToken}::uuid,
        ${claimWorkerId(claim)},
        ${plan.planId}::uuid,
        ${opened.wakeId}::uuid,
        ${opened.sessionId}::uuid
      ) AS receipt
    `);
    const receipt = asRecord(row?.receipt);
    const normalized: DeliveryReceipt = {
      deliveryReceiptId: stringField(receipt, 'deliveryReceiptId') ?? '',
      planId: stringField(receipt, 'planId') ?? '',
      sessionId: stringField(receipt, 'sessionId') ?? '',
      wakeId: stringField(receipt, 'wakeId') ?? '',
      replayed: receipt.replayed === true,
      adopted: receipt.adopted === true,
    };
    if (!normalized.deliveryReceiptId
        || normalized.planId !== plan.planId
        || normalized.sessionId !== opened.sessionId
        || normalized.wakeId !== opened.wakeId) {
      throw new Error('COMPLETION_ACK_DELIVERY_RECEIPT_INVALID');
    }

    this.realtime.publishSessionUpdated(affectedSessionId);
    return {
      kind: 'DELIVERED',
      detail: {
        deliveryReceiptId: normalized.deliveryReceiptId,
        deliveryPlanId: normalized.planId,
        wakeId: normalized.wakeId,
        sessionId: normalized.sessionId,
        affectedSessionId,
        replayed: normalized.replayed,
        adopted: normalized.adopted,
      },
    };
  }
}
