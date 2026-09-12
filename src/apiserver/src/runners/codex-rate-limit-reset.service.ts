import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  codexRateLimitResetOf,
  codexResetAccountOverride,
  codexResetCreateReplay,
  codexResetOperationStatus,
  codexResetOperationView,
  codexResetRefusal,
  createCodexResetRequestViolations,
  newCodexResetOperation,
  type CodexRateLimitResetOperations,
  type CodexRateLimitResetOperationState,
  type CodexRateLimitResetOperationView,
  type CodexRateLimitResetRefusal,
  type CodexRateLimitResetRefusalCode,
  type CreateCodexRateLimitResetRequest,
  type CreateCodexRateLimitResetResponse,
  type PlanUsage,
} from '@orbit/shared';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_AGENT_PROVIDER, lastProviderByWorkspace } from '../workspaces/workspace-provider';
import { codexResetLogLine } from './codex-reset-log';
import { countCodexResetAdmission } from './codex-reset-metrics';
import { CodexRateLimitResetRepository } from './codex-rate-limit-reset.repository';
import { isRunnerOnline } from './runners.service';

/**
 * How many times one confirmation re-reads after losing an insert. One is what a single concurrent
 * confirmation costs: the insert waits for the winner, so the next pass reads it. A further loss needs
 * yet another confirmation committing inside that window.
 */
const INSERT_PASSES = 3;

/**
 * Admission of Codex earned rate-limit resets (docs/codex-rate-limit-reset-contract.md §5, §6.1).
 *
 * All this does is decide whether a confirmation may become an operation, and make a retried or
 * concurrent confirmation come back as the operation it already is. Nothing here hands a command to a
 * runner or talks to a provider. Every confirmation is counted and logged at the admission stage
 * (codex-reset-metrics.ts, codex-reset-log.ts), after its transaction, so a retried transaction counts once.
 */
@Injectable()
export class CodexRateLimitResetService {
  private readonly logger = new Logger(CodexRateLimitResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: CodexRateLimitResetRepository,
  ) {}

  /**
   * One confirmation, in one transaction and in the contract's order: the runner must be the
   * caller's; a request id that already exists is answered with its operation — replayed without
   * asking eligibility again or generating a key — or refused as REQUEST_ID_REUSED when it named
   * another runner or account; otherwise `codexResetRefusal` decides, and the operation is inserted
   * with a provider key generated for that insert alone. Eligibility includes the runner and account's
   * last operation that may have spent a credit no refresh confirmed: the block it is judged on has to be
   * a read that started after that operation settled.
   *
   * The insert is ON CONFLICT DO NOTHING against both keys a concurrent confirmation can take first:
   * the request id and the runner and account's active slot. Losing writes nothing, and the winner has
   * committed by the time the insert returns, so the next pass reads it — as this request replayed, or
   * as the operation in flight. The key generated for the losing insert was never written anywhere.
   */
  async create(ownerId: string, runnerId: string, body: unknown): Promise<CreateCodexRateLimitResetResponse> {
    const violations = createCodexResetRequestViolations(body);
    if (violations.length > 0) {
      countCodexResetAdmission('invalid');
      this.logger.warn(codexResetLogLine('admission', { event: 'invalid', runnerId }));
      throw new BadRequestException(violations.join('; '));
    }
    const request = body as CreateCodexRateLimitResetRequest;
    const created = await withTransactionRetry(
      this.prisma,
      async (tx): Promise<{ operation: CodexRateLimitResetOperationState; replayed: boolean }> => {
        const runner = await tx.runner.findFirst({
          where: { id: runnerId, ownerId },
          select: {
            status: true,
            lastHeartbeatAt: true,
            capabilities: true,
            heartbeatLeaseOwner: true,
            heartbeatDraining: true,
            planUsage: true,
          },
        });
        if (!runner) throw new NotFoundException('runner not found');
        const now = new Date();
        const replayOf = (existing: CodexRateLimitResetOperationState) => {
          const replay = codexResetCreateReplay(existing, { runnerId, accountFingerprint: request.accountFingerprint });
          if (replay === 'REQUEST_ID_REUSED') throw refused(replay, existing.id);
          return { operation: existing, replayed: true };
        };
        for (let pass = 1; pass <= INSERT_PASSES; pass += 1) {
          const existing = await this.operations.byClientRequest(tx, ownerId, request.clientRequestId);
          if (existing) return replayOf(existing);
          const active = await this.operations.activeFor(tx, runnerId, request.accountFingerprint);
          const refusal = codexResetRefusal({
            now,
            accountOverride:
              request.workspaceId !== undefined && (await accountOverride(tx, ownerId, runnerId, request.workspaceId)),
            activeOperation: active !== null,
            runnerOnline: isRunnerOnline(runner, now.getTime()),
            runnerCapabilities: runner.capabilities,
            heartbeatLeaseOwner: runner.heartbeatLeaseOwner,
            runnerDraining: runner.heartbeatDraining === true,
            rateLimitReset: codexRateLimitResetOf(runner.planUsage as PlanUsage | null),
            expectedAccountFingerprint: request.accountFingerprint,
            readRequiredAfter: await this.operations.unrefreshedSpendSettledAt(tx, runnerId, request.accountFingerprint),
          });
          if (refusal === 'OPERATION_IN_FLIGHT') {
            // Each statement reads what had committed when it started, so the operation in flight can be this
            // request's own: a concurrent POST of it that committed after the request id was read above. Read
            // again after the in-flight read, the request id sees it whenever that is so.
            const committedSince = await this.operations.byClientRequest(tx, ownerId, request.clientRequestId);
            if (committedSince) return replayOf(committedSince);
          }
          if (refusal) throw refused(refusal, refusal === 'OPERATION_IN_FLIGHT' ? active?.id : undefined);
          const operation = newCodexResetOperation({
            id: randomUUID(),
            ownerId,
            runnerId,
            accountFingerprint: request.accountFingerprint,
            clientRequestId: request.clientRequestId,
            providerIdempotencyKey: randomUUID(),
            now,
          });
          if (await this.operations.insertIfAbsent(tx, operation)) return { operation, replayed: false };
        }
        throw new Error(`codex rate-limit reset: ${INSERT_PASSES} inserts in a row lost to concurrent confirmations`);
      },
      loggedRetry(this.logger, 'codexRateLimitReset.create'),
    ).catch((error: unknown) => {
      this.observeRefusal(runnerId, error);
      throw error;
    });
    const event = created.replayed ? 'replayed' : 'created';
    countCodexResetAdmission(event);
    this.logger.log(
      codexResetLogLine(
        'admission',
        {
          event,
          operationId: created.operation.id,
          runnerId,
          status: codexResetOperationStatus(created.operation),
          replayed: created.replayed,
        },
        [created.operation.providerIdempotencyKey],
      ),
    );
    return { operation: codexResetOperationView(created.operation), replayed: created.replayed };
  }

  /** The runner's active operation and its most recent one: what a page polls while one is active. */
  async operationsFor(ownerId: string, runnerId: string): Promise<CodexRateLimitResetOperations> {
    await this.ownRunner(ownerId, runnerId);
    const { active, latest } = await this.operations.forRunner(ownerId, runnerId);
    return {
      active: active && codexResetOperationView(active),
      latest: latest && codexResetOperationView(latest),
    };
  }

  /** One operation of one runner; another runner's operation is not found here, even the caller's. */
  async operation(ownerId: string, runnerId: string, operationId: string): Promise<CodexRateLimitResetOperationView> {
    await this.ownRunner(ownerId, runnerId);
    const operation = await this.operations.byId(ownerId, runnerId, operationId);
    if (!operation) throw new NotFoundException('operation not found');
    return codexResetOperationView(operation);
  }

  private async ownRunner(ownerId: string, runnerId: string): Promise<void> {
    const runner = await this.prisma.runner.findFirst({ where: { id: runnerId, ownerId }, select: { id: true } });
    if (!runner) throw new NotFoundException('runner not found');
  }

  /** Counts and logs a confirmation that became no operation: refused with a code, or naming no runner of the caller. */
  private observeRefusal(runnerId: string, error: unknown): void {
    if (error instanceof ConflictException) {
      const refusal = error.getResponse() as CodexRateLimitResetRefusal;
      countCodexResetAdmission('refused', refusal.code);
      this.logger.log(codexResetLogLine('admission', { event: 'refused', runnerId, code: refusal.code, operationId: refusal.operationId }));
    } else if (error instanceof NotFoundException) {
      countCodexResetAdmission('invalid');
      this.logger.warn(codexResetLogLine('admission', { event: 'not_found', runnerId }));
    }
  }
}

/**
 * Whether the workspace a confirmation came from runs on something other than the runner's default
 * Codex account (§3). A workspace holds no provider, so its provider is the derived default a new
 * session there starts on; a configured provider is never the runner's own login, whatever its slug.
 */
async function accountOverride(
  tx: Prisma.TransactionClient,
  ownerId: string,
  runnerId: string,
  workspaceId: string,
): Promise<boolean> {
  const workspace = await tx.workspace.findFirst({
    where: { id: workspaceId, ownerId, runnerId, deletedAt: null },
    select: { env: true },
  });
  if (!workspace) throw new NotFoundException('workspace not found');
  const seed = (await lastProviderByWorkspace(tx, [workspaceId])).get(workspaceId) ?? DEFAULT_AGENT_PROVIDER;
  return (
    !seed.providerBuiltin ||
    codexResetAccountOverride({ provider: seed.provider, env: workspace.env as Record<string, string> | null })
  );
}

function refused(code: CodexRateLimitResetRefusalCode, operationId: string | undefined): ConflictException {
  const body: CodexRateLimitResetRefusal = operationId === undefined ? { code } : { code, operationId };
  return new ConflictException(body);
}
