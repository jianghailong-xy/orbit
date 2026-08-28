import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  actionFailureFingerprint,
  actionProtocolDigest,
  canonicalActionObligation,
  actionProtocolMismatch,
  validateActionProtocolDeclaration,
  validateProviderReceipt,
  type ActionEffectClass,
  type ActionProtocolDeclaration,
  type BoundSourceObligation,
  type ConstrainedActionIntent,
  type ProviderActionReceipt,
} from './action-executor';

export interface ActionAdapterContext {
  intent: ConstrainedActionIntent;
  sourceObligation: BoundSourceObligation;
  attemptNumber: number;
  signal: AbortSignal;
  /** Must be awaited immediately before any non-read-only effect is committed. */
  assertCommitFence(): Promise<void>;
}

export interface ActionExecutionAdapter {
  capability: string;
  providerIdentity: string;
  effectClasses: ReadonlySet<ActionEffectClass>;
  idempotency: 'PROVIDER_ENFORCED';
  fenceMode: 'REQUIRED_BEFORE_EFFECT';
  execute(context: ActionAdapterContext): Promise<ProviderActionReceipt>;
}

export interface ActionCompensationReceipt {
  result: 'COMPENSATED' | 'FAILED' | 'UNAVAILABLE';
  capability: string;
  effectDigest: string;
  idempotencyKey: string;
  detail?: Record<string, unknown>;
}

export interface ActionCompensator {
  capability: string;
  idempotency: 'PROVIDER_ENFORCED';
  compensate(
    context: ActionAdapterContext & { receipt: ProviderActionReceipt },
  ): Promise<ActionCompensationReceipt>;
}

interface ClaimedAction {
  actionIntentId: string;
  attemptNumber: number;
  leaseToken: string;
  leaseExpiresLogicalTime: string;
  dispatchSequence: string;
  intent: ConstrainedActionIntent;
  sourceObligation: BoundSourceObligation;
}

interface BeginCommitResult {
  authorized: boolean;
  replayed: boolean;
  code: string;
  status?: string;
  transactionId?: string;
  attemptNumber?: number;
  receipt?: unknown;
}

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

const MAX_ACTION_TIMEOUT_MS = 300_000;
const MIN_TRANSACTION_HEADROOM_MS = 5_000;
const SHA256_DIGEST = /^[0-9a-f]{64}$/;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function json<T>(value: Prisma.JsonValue): T {
  return value as unknown as T;
}

function timeoutReceipt(intent: ConstrainedActionIntent, providerIdentity: string): ProviderActionReceipt {
  return {
    providerIdentity,
    effectDigest: actionFailureFingerprint('ACTION_TIMEOUT', {
      actionIntentId: intent.actionIntentId,
      targetDigest: intent.targetDigest,
    }),
    observedAt: new Date().toISOString(),
    result: 'TIMED_OUT',
    idempotencyKey: intent.idempotencyKey,
    failureFingerprint: null,
    retryAfterLogicalTicks: null,
    detail: { timeoutMs: intent.timeout.wallClockMs },
  };
}

@Injectable()
export class ActionCapabilityRegistry {
  private readonly protocols = new Map<string, {
    digest: string;
    declaration: ActionProtocolDeclaration;
  }>();
  private readonly adapters = new Map<string, ActionExecutionAdapter>();
  private readonly compensators = new Map<string, ActionCompensator>();

  registerProtocol(protocol: ActionProtocolDeclaration): void {
    const declarationError = validateActionProtocolDeclaration(protocol);
    if (declarationError) {
      throw new Error(`${declarationError}:${protocol.actionKind ?? 'UNKNOWN'}`);
    }
    const protocolDigest = actionProtocolDigest(protocol);
    const standing = this.protocols.get(protocol.actionKind);
    if (standing && standing.digest !== protocolDigest) {
      throw new Error(`ACTION_PROTOCOL_REGISTRATION_CONFLICT:${protocol.actionKind}`);
    }
    if (!standing) {
      const declaration = deepFreeze(structuredClone(protocol));
      this.protocols.set(protocol.actionKind, { digest: protocolDigest, declaration });
    }
  }

  registerAdapter(adapter: ActionExecutionAdapter): void {
    const standing = this.adapters.get(adapter.capability);
    if (standing && standing !== adapter) {
      throw new Error(`ACTION_ADAPTER_REGISTRATION_CONFLICT:${adapter.capability}`);
    }
    if (adapter.idempotency !== 'PROVIDER_ENFORCED'
        || adapter.fenceMode !== 'REQUIRED_BEFORE_EFFECT') {
      throw new Error(`ACTION_ADAPTER_UNSAFE:${adapter.capability}`);
    }
    this.adapters.set(adapter.capability, adapter);
  }

  registerCompensator(compensator: ActionCompensator): void {
    const standing = this.compensators.get(compensator.capability);
    if (standing && standing !== compensator) {
      throw new Error(`ACTION_COMPENSATOR_REGISTRATION_CONFLICT:${compensator.capability}`);
    }
    if (compensator.idempotency !== 'PROVIDER_ENFORCED') {
      throw new Error(`ACTION_COMPENSATOR_UNSAFE:${compensator.capability}`);
    }
    this.compensators.set(compensator.capability, compensator);
  }

  protocol(actionKind: string): ActionProtocolDeclaration | null {
    return this.protocols.get(actionKind)?.declaration ?? null;
  }

  adapter(capability: string): ActionExecutionAdapter | null {
    return this.adapters.get(capability) ?? null;
  }

  compensator(capability: string | null): ActionCompensator | null {
    return capability ? this.compensators.get(capability) ?? null : null;
  }
}

@Injectable()
export class ActionExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ActionCapabilityRegistry,
  ) {}

  async registerBudget(input: {
    tenantId: string;
    projectId: string;
    accountId: string;
    budgetDigest: string;
    unit: string;
    limit: number;
  }): Promise<Record<string, unknown>> {
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_register_action_budget(
        ${input.tenantId}::uuid,
        ${input.projectId}::uuid,
        ${input.accountId},
        ${input.budgetDigest},
        ${input.unit},
        ${input.limit}::numeric
      ) AS result
    `);
    if (!row) throw new Error('Action budget registration returned no result');
    return json(row.result);
  }

  async registerPrecondition(input: {
    tenantId: string;
    projectId: string;
    resourceType: string;
    resourceId: string;
    preconditionDigest: string;
    targetDigest: string;
  }): Promise<Record<string, unknown>> {
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_register_action_precondition(
        ${input.tenantId}::uuid,
        ${input.projectId}::uuid,
        ${input.resourceType},
        ${input.resourceId},
        ${input.preconditionDigest},
        ${input.targetDigest}
      ) AS result
    `);
    if (!row) throw new Error('Action precondition registration returned no result');
    return json(row.result);
  }

  private async recordModelGap(
    intent: ConstrainedActionIntent,
    source: BoundSourceObligation,
    code: string,
    logicalNow: string,
  ): Promise<Record<string, unknown>> {
    const obligation = canonicalActionObligation(intent, source, code, {
      logicalNow,
      message: `${code} refused ${intent.actionKind}; the agent must diagnose the action model.`,
    });
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_record_action_diagnostic(
        ${intent.tenantId}::uuid,
        ${intent.projectId}::uuid,
        ${intent.obligationRevision},
        ${`${intent.idempotencyKey}:diagnostic`},
        ${code},
        ${JSON.stringify({ intent, sourceObligation: source })}::jsonb,
        ${JSON.stringify(obligation)}::jsonb
      ) AS result
    `);
    if (!row) throw new Error('Action model-gap recording returned no result');
    return json(row.result);
  }

  async enqueue(input: {
    intent: ConstrainedActionIntent;
    sourceObligation: BoundSourceObligation;
    logicalNow: string;
    fairWaitLogicalTicks?: number;
  }): Promise<Record<string, unknown>> {
    const protocol = this.registry.protocol(input.intent.actionKind);
    const mismatch = actionProtocolMismatch(input.intent, input.sourceObligation, protocol);
    if (mismatch) {
      return this.recordModelGap(input.intent, input.sourceObligation, mismatch, input.logicalNow);
    }
    if (!protocol) {
      return this.recordModelGap(
        input.intent,
        input.sourceObligation,
        'UNKNOWN_ACTION_KIND',
        input.logicalNow,
      );
    }
    const adapter = this.registry.adapter(protocol.actor.capability);
    if (!adapter || !adapter.effectClasses.has(input.intent.effectClass)) {
      return this.recordModelGap(
        input.intent,
        input.sourceObligation,
        'ACTION_ADAPTER_MISSING',
        input.logicalNow,
      );
    }
    if (input.intent.timeout.wallClockMs > MAX_ACTION_TIMEOUT_MS) {
      return this.recordModelGap(
        input.intent,
        input.sourceObligation,
        'ACTION_TIMEOUT_UNBOUNDED',
        input.logicalNow,
      );
    }
    const backoff = Prisma.sql`ARRAY[${Prisma.join(
      protocol.retry.backoffLogicalTicks.map((value) => Prisma.sql`${BigInt(value)}`),
    )}]::bigint[]`;
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_enqueue_action(
        ${input.intent.tenantId}::uuid,
        ${input.intent.projectId}::uuid,
        ${JSON.stringify(input.intent)}::jsonb,
        ${JSON.stringify(input.sourceObligation)}::jsonb,
        ${backoff},
        ${BigInt(input.logicalNow)}::bigint,
        ${BigInt(input.fairWaitLogicalTicks ?? 100)}::bigint
      ) AS result
    `);
    if (!row) throw new Error('Action enqueue returned no result');
    return json(row.result);
  }

  async claimNext(input: {
    tenantId: string;
    workerId: string;
    logicalNow: string;
    leaseLogicalTicks: number;
  }): Promise<ClaimedAction | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue | null }>>(Prisma.sql`
      SELECT outcome_claim_next_action(
        ${input.tenantId}::uuid,
        ${input.workerId},
        ${BigInt(input.logicalNow)}::bigint,
        ${BigInt(input.leaseLogicalTicks)}::bigint
      ) AS result
    `);
    if (!row?.result) return null;
    return json(row.result);
  }

  private async assertFence(
    tx: RawClient,
    tenantId: string,
    actionIntentId: string,
    leaseToken: string,
  ): Promise<void> {
    const [row] = await tx.$queryRaw<Array<{ fence: string }>>(Prisma.sql`
      SELECT outcome_assert_action_commit_fence(
        ${tenantId}::uuid,
        ${actionIntentId}::uuid,
        ${leaseToken}::uuid
      ) AS fence
    `);
    if (!row?.fence) throw new Error('Action commit fence is absent');
  }

  private async invokeBounded(
    adapter: ActionExecutionAdapter,
    context: Omit<ActionAdapterContext, 'signal'>,
    timeoutMs: number,
  ): Promise<{ receipt: ProviderActionReceipt; fenceChecked: boolean }> {
    const controller = new AbortController();
    let fenceChecked = false;
    const guardedContext: ActionAdapterContext = {
      ...context,
      signal: controller.signal,
      assertCommitFence: async () => {
        await context.assertCommitFence();
        fenceChecked = true;
      },
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const execution = Promise.resolve().then(() => adapter.execute(guardedContext));
    // A late adapter can no longer pass assertCommitFence after FINISH changes the row. Attach a
    // rejection handler because Promise.race deliberately stops awaiting it after the deadline.
    execution.catch(() => undefined);
    const timeout = new Promise<ProviderActionReceipt>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(timeoutReceipt(context.intent, adapter.providerIdentity));
      }, timeoutMs);
    });
    try {
      const receipt = await Promise.race([execution, timeout]);
      const receiptError = receipt.providerIdentity !== adapter.providerIdentity
        ? 'RECEIPT_PROVIDER_IDENTITY_MISMATCH'
        : validateProviderReceipt(context.intent, receipt);
      if (receiptError) {
        const effectMayHaveOccurred = context.intent.effectClass !== 'READ_ONLY' && fenceChecked;
        return {
          fenceChecked,
          receipt: {
            providerIdentity: adapter.providerIdentity,
            effectDigest: actionFailureFingerprint(receiptError, receipt),
            observedAt: new Date().toISOString(),
            result: effectMayHaveOccurred ? 'WRONG_EFFECT' : 'PERMANENT_FAILURE',
            idempotencyKey: context.intent.idempotencyKey,
            failureFingerprint: effectMayHaveOccurred ? null : actionFailureFingerprint(receiptError),
            retryAfterLogicalTicks: null,
            detail: { code: receiptError, reportedReceipt: receipt },
          },
        };
      }
      if (context.intent.effectClass !== 'READ_ONLY' && receipt.result !== 'TIMED_OUT' && !fenceChecked) {
        return {
          fenceChecked,
          receipt: {
            ...receipt,
            result: 'WRONG_EFFECT',
            failureFingerprint: null,
            retryAfterLogicalTicks: null,
            detail: { ...receipt.detail, code: 'ADAPTER_EFFECT_WITHOUT_COMMIT_FENCE' },
          },
        };
      }
      return { receipt, fenceChecked };
    } catch (error) {
      const effectMayHaveOccurred = context.intent.effectClass !== 'READ_ONLY' && fenceChecked;
      return {
        fenceChecked,
        receipt: {
          providerIdentity: adapter.providerIdentity,
          effectDigest: actionFailureFingerprint('ACTION_ADAPTER_THROW', String(error)),
          observedAt: new Date().toISOString(),
          result: effectMayHaveOccurred ? 'TIMED_OUT' : 'RETRYABLE_FAILURE',
          idempotencyKey: context.intent.idempotencyKey,
          failureFingerprint: effectMayHaveOccurred
            ? null
            : actionFailureFingerprint('ACTION_ADAPTER_THROW', String(error)),
          retryAfterLogicalTicks: null,
          detail: { error: String(error) },
        },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async compensationFor(
    claimed: ClaimedAction,
    receipt: ProviderActionReceipt,
    assertCommitFence: () => Promise<void>,
    timeoutMs: number,
  ): Promise<ActionCompensationReceipt | null> {
    if (!['PARTIAL_EFFECT', 'WRONG_EFFECT'].includes(receipt.result)) return null;
    const capability = claimed.intent.compensation.compensatorCapability;
    if (!capability) return null;
    const compensator = this.registry.compensator(capability);
    if (!compensator) {
      return {
        result: 'UNAVAILABLE',
        capability,
        effectDigest: actionFailureFingerprint('COMPENSATOR_UNAVAILABLE', capability),
        idempotencyKey: `${claimed.intent.idempotencyKey}:compensation`,
      };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const execution = Promise.resolve().then(() => compensator.compensate({
      intent: claimed.intent,
      sourceObligation: claimed.sourceObligation,
      attemptNumber: claimed.attemptNumber,
      signal: controller.signal,
      assertCommitFence,
      receipt,
    }));
    execution.catch(() => undefined);
    const timeout = new Promise<ActionCompensationReceipt>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({
          result: 'FAILED',
          capability,
          effectDigest: actionFailureFingerprint('COMPENSATION_TIMEOUT', { timeoutMs }),
          idempotencyKey: `${claimed.intent.idempotencyKey}:compensation`,
          detail: { code: 'COMPENSATION_TIMEOUT', timeoutMs },
        });
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([execution, timeout]);
      const expectedKey = `${claimed.intent.idempotencyKey}:compensation`;
      if (!['COMPENSATED', 'FAILED', 'UNAVAILABLE'].includes(result.result)
          || result.capability !== capability
          || result.idempotencyKey !== expectedKey
          || !SHA256_DIGEST.test(result.effectDigest)) {
        return {
          result: 'FAILED',
          capability,
          effectDigest: actionFailureFingerprint('COMPENSATION_RECEIPT_INVALID', result),
          idempotencyKey: expectedKey,
          detail: { code: 'COMPENSATION_RECEIPT_INVALID', reportedReceipt: result },
        };
      }
      return result;
    } catch (error) {
      return {
        result: 'FAILED',
        capability,
        effectDigest: actionFailureFingerprint('COMPENSATION_FAILED', String(error)),
        idempotencyKey: `${claimed.intent.idempotencyKey}:compensation`,
        detail: { error: String(error) },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async executeNext(input: {
    tenantId: string;
    workerId: string;
    logicalNow: string;
    leaseLogicalTicks: number;
  }): Promise<Record<string, unknown> | null> {
    const claimed = await this.claimNext(input);
    if (!claimed) return null;
    const protocol = this.registry.protocol(claimed.intent.actionKind);
    const mismatch = actionProtocolMismatch(claimed.intent, claimed.sourceObligation, protocol);
    const adapter = protocol ? this.registry.adapter(protocol.actor.capability) : null;
    if (mismatch || !protocol || !adapter || !adapter.effectClasses.has(claimed.intent.effectClass)) {
      const code = mismatch ?? 'ACTION_ADAPTER_MISSING';
      const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
        SELECT outcome_fail_claimed_action_diagnosis(
          ${input.tenantId}::uuid,
          ${claimed.actionIntentId}::uuid,
          ${claimed.leaseToken}::uuid,
          ${code},
          ${BigInt(input.logicalNow)}::bigint
        ) AS result
      `);
      return row ? json(row.result) : null;
    }

    const transactionTimeout = claimed.intent.timeout.wallClockMs + MIN_TRANSACTION_HEADROOM_MS;
    return this.prisma.$transaction(async (tx) => {
      const [beginRow] = await tx.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
        SELECT outcome_begin_action_commit(
          ${input.tenantId}::uuid,
          ${claimed.actionIntentId}::uuid,
          ${claimed.leaseToken}::uuid,
          ${input.workerId},
          ${BigInt(input.logicalNow)}::bigint
        ) AS result
      `);
      if (!beginRow) throw new Error('Action commit begin returned no result');
      const begun = json<BeginCommitResult>(beginRow.result);
      if (!begun.authorized) return begun as unknown as Record<string, unknown>;

      const assertCommitFence = () => this.assertFence(
        tx,
        input.tenantId,
        claimed.actionIntentId,
        claimed.leaseToken,
      );
      const effectDeadline = Date.now() + claimed.intent.timeout.wallClockMs;
      const { receipt } = await this.invokeBounded(adapter, {
        intent: claimed.intent,
        sourceObligation: claimed.sourceObligation,
        attemptNumber: claimed.attemptNumber,
        assertCommitFence,
      }, claimed.intent.timeout.wallClockMs);
      const compensation = await this.compensationFor(
        claimed,
        receipt,
        assertCommitFence,
        Math.max(1, effectDeadline - Date.now()),
      );
      const [finishRow] = await tx.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
        SELECT outcome_finish_action_commit(
          ${input.tenantId}::uuid,
          ${claimed.actionIntentId}::uuid,
          ${claimed.leaseToken}::uuid,
          ${JSON.stringify(receipt)}::jsonb,
          ${compensation === null ? Prisma.sql`NULL::jsonb` : Prisma.sql`${JSON.stringify(compensation)}::jsonb`},
          ${BigInt(input.logicalNow)}::bigint
        ) AS result
      `);
      if (!finishRow) throw new Error('Action commit finish returned no result');
      return json<Record<string, unknown>>(finishRow.result);
    }, { maxWait: 10_000, timeout: transactionTimeout });
  }
}
