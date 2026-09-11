import { Injectable, Logger } from '@nestjs/common';
import type { CodexRateLimitResetOperation, Prisma } from '@prisma/client';
import {
  codexResetTransitionViolations,
  type CodexRateLimitResetConsumeOutcome,
  type CodexRateLimitResetConsumeState,
  type CodexRateLimitResetFailureCode,
  type CodexRateLimitResetOperationState,
  type CodexRateLimitResetRefreshState,
  type CodexRateLimitResetResultCode,
} from '@orbit/shared';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Where `codex_rate_limit_reset_operation` rows become the contract's operation state and back
 * (docs/codex-rate-limit-reset-contract.md §7, §9.3; migration 0255).
 *
 * Two writes and no more. `insertIfAbsent` adds the row a confirmation built with
 * `newCodexResetOperation`; `transition` is the only way an existing row changes, and it changes one
 * only after `codexResetTransitionViolations` found nothing wrong with the move — judged against the
 * row as it stands under its row lock, never against a copy read before. 0255's guard trigger refuses
 * the same moves again for any writer that does not come through here.
 */

type Reader = PrismaService | Prisma.TransactionClient;

/** The checkpoint combinations the contract calls active (PENDING, CONSUMING, REFRESHING): the
 *  predicate of 0255's in-flight unique index, spelled for Prisma. */
const ACTIVE: Prisma.CodexRateLimitResetOperationWhereInput = {
  OR: [
    { consumeState: { in: ['PENDING', 'CLAIMED'] } },
    { consumeState: 'CONFIRMED', refreshState: 'PENDING' },
  ],
};

const NEWEST_FIRST: Prisma.CodexRateLimitResetOperationOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

const OLDEST_FIRST: Prisma.CodexRateLimitResetOperationOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];

/** A move `codexResetTransitionViolations` refused. Nothing was written. */
export class CodexResetTransitionRefused extends Error {
  constructor(
    readonly operationId: string,
    readonly violations: readonly string[],
  ) {
    super(`codex rate-limit reset operation ${operationId}: ${violations.join('; ')}`);
    this.name = 'CodexResetTransitionRefused';
  }
}

@Injectable()
export class CodexRateLimitResetRepository {
  private readonly logger = new Logger(CodexRateLimitResetRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The operation one confirmation of this owner already created, whichever runner it named. */
  async byClientRequest(
    db: Reader,
    ownerId: string,
    clientRequestId: string,
  ): Promise<CodexRateLimitResetOperationState | null> {
    const row = await db.codexRateLimitResetOperation.findUnique({
      where: { ownerId_clientRequestId: { ownerId, clientRequestId } },
    });
    return row && stateOf(row);
  }

  /** The active operation of one runner and account — 0255's in-flight index allows one at most. */
  async activeFor(
    db: Reader,
    runnerId: string,
    accountFingerprint: string,
  ): Promise<CodexRateLimitResetOperationState | null> {
    const row = await db.codexRateLimitResetOperation.findFirst({
      where: { runnerId, accountFingerprint, ...ACTIVE },
    });
    return row && stateOf(row);
  }

  /**
   * Insert `operation` unless a row already holds its request id or its runner and account's active
   * slot. ON CONFLICT DO NOTHING: a conflicting insert still in flight is waited for, and losing to it
   * writes nothing and aborts nothing — so the caller can read what won in the same transaction.
   */
  async insertIfAbsent(
    tx: Prisma.TransactionClient,
    operation: CodexRateLimitResetOperationState,
  ): Promise<boolean> {
    const { count } = await tx.codexRateLimitResetOperation.createMany({ data: [rowOf(operation)], skipDuplicates: true });
    return count === 1;
  }

  /** A runner's active operation and its most recent one, which is the same row while one is active. */
  async forRunner(
    ownerId: string,
    runnerId: string,
  ): Promise<{ active: CodexRateLimitResetOperationState | null; latest: CodexRateLimitResetOperationState | null }> {
    const [active, latest] = await Promise.all([
      this.prisma.codexRateLimitResetOperation.findFirst({ where: { ownerId, runnerId, ...ACTIVE }, orderBy: NEWEST_FIRST }),
      this.prisma.codexRateLimitResetOperation.findFirst({ where: { ownerId, runnerId }, orderBy: NEWEST_FIRST }),
    ]);
    return { active: active && stateOf(active), latest: latest && stateOf(latest) };
  }

  async byId(ownerId: string, runnerId: string, id: string): Promise<CodexRateLimitResetOperationState | null> {
    const row = await this.prisma.codexRateLimitResetOperation.findFirst({ where: { id, ownerId, runnerId } });
    return row && stateOf(row);
  }

  /** The ids of one runner's active operations, oldest first: what a heartbeat of that runner dispatches. */
  async activeIdsOfRunner(runnerId: string): Promise<string[]> {
    const rows = await this.prisma.codexRateLimitResetOperation.findMany({
      where: { runnerId, ...ACTIVE },
      select: { id: true },
      orderBy: OLDEST_FIRST,
    });
    return rows.map((row) => row.id);
  }

  /**
   * Move one operation. `decide` is handed the row as it stands under `FOR UPDATE` and returns the
   * state to write, or null to leave the row as it is. A move the contract does not allow throws
   * `CodexResetTransitionRefused` and writes nothing. Resolves null when the operation does not exist.
   */
  async transition(
    id: string,
    decide: (current: CodexRateLimitResetOperationState) => CodexRateLimitResetOperationState | null,
  ): Promise<CodexRateLimitResetOperationState | null> {
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "codex_rate_limit_reset_operation" WHERE "id" = ${id}::uuid FOR UPDATE`;
        if (locked.length === 0) return null;
        const current = stateOf(await tx.codexRateLimitResetOperation.findUniqueOrThrow({ where: { id } }));
        const next = decide(current);
        if (next === null || sameState(current, next)) return current;
        const violations = codexResetTransitionViolations(current, next);
        if (violations.length > 0) throw new CodexResetTransitionRefused(id, violations);
        return stateOf(await tx.codexRateLimitResetOperation.update({ where: { id }, data: progressOf(next) }));
      },
      loggedRetry(this.logger, 'codexRateLimitReset.transition'),
    );
  }
}

function stateOf(row: CodexRateLimitResetOperation): CodexRateLimitResetOperationState {
  return {
    id: row.id,
    ownerId: row.ownerId,
    runnerId: row.runnerId,
    accountFingerprint: row.accountFingerprint,
    clientRequestId: row.clientRequestId,
    providerIdempotencyKey: row.providerIdempotencyKey,
    // The column CHECKs of 0255 admit exactly these unions' members.
    consumeState: row.consumeState as CodexRateLimitResetConsumeState,
    consumeOutcome: row.consumeOutcome as CodexRateLimitResetConsumeOutcome | null,
    refreshState: row.refreshState as CodexRateLimitResetRefreshState,
    failureCode: row.failureCode as CodexRateLimitResetFailureCode | null,
    lastErrorCode: row.lastErrorCode as CodexRateLimitResetResultCode | null,
    claimLeaseOwner: row.claimLeaseOwner,
    claimGeneration: row.claimGeneration,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    claimsWithUnknownCall: row.claimsWithUnknownCall,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    consumeConfirmedAt: row.consumeConfirmedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function rowOf(operation: CodexRateLimitResetOperationState): Prisma.CodexRateLimitResetOperationCreateManyInput {
  return {
    id: operation.id,
    ownerId: operation.ownerId,
    runnerId: operation.runnerId,
    accountFingerprint: operation.accountFingerprint,
    clientRequestId: operation.clientRequestId,
    providerIdempotencyKey: operation.providerIdempotencyKey,
    createdAt: new Date(operation.createdAt),
    ...progressOf(operation),
  };
}

/** Every column a transition may change. The immutable ones are written once, by the insert. */
function progressOf(operation: CodexRateLimitResetOperationState) {
  return {
    consumeState: operation.consumeState,
    consumeOutcome: operation.consumeOutcome,
    refreshState: operation.refreshState,
    failureCode: operation.failureCode,
    lastErrorCode: operation.lastErrorCode,
    claimLeaseOwner: operation.claimLeaseOwner,
    claimGeneration: operation.claimGeneration,
    claimedAt: instant(operation.claimedAt),
    claimsWithUnknownCall: operation.claimsWithUnknownCall,
    updatedAt: new Date(operation.updatedAt),
    consumeConfirmedAt: instant(operation.consumeConfirmedAt),
    completedAt: instant(operation.completedAt),
  };
}

function instant(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function sameState(a: CodexRateLimitResetOperationState, b: CodexRateLimitResetOperationState): boolean {
  return (Object.keys(a) as Array<keyof CodexRateLimitResetOperationState>).every((key) => a[key] === b[key]);
}
