import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type ManagedRunner } from '@prisma/client';
import {
  MANAGED_RUNNER_REVISION_CONFLICT,
  MANAGED_RUNNER_TRANSITION_REFUSED,
  type ManagedRunnerStatus,
} from '@orbit/shared';

import { generateToken, sha256 } from '../common/crypto.util';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { MANAGED_RUNNER_GATE, managedRunnerDisabledError, type ManagedRunnerGate } from './managed-runner-gate';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import {
  MANAGED_RUNNER_NAME,
  MANAGED_WORKSPACE_DIR,
  MANAGED_WORKSPACE_NAME,
  managedPvcName,
} from './managed-runner-resources';
import { MANAGED_RUNNER_RUNTIME, type ManagedRunnerRuntime } from './managed-runner-runtime';
import { DEFAULT_HEARTBEAT_FRESH_MS, managedRunnerStatus, managedRunnerUnavailableReason } from './managed-runner-status';

export const MANAGED_RUNNER_NOT_FOUND = 'MANAGED_RUNNER_NOT_FOUND';

/**
 * The owner's side of managed runners: the status read and the requested transitions
 * (docs/managed-runner-design.md, "Server and three client interfaces").
 *
 * Every read and write is keyed by the authenticated owner and nothing a request names: a caller
 * reaches its own mapping or none, so another account's runner, instance and volume are not even
 * addressable here. Requests record desired state and nothing else; the manager performs every
 * resource operation, outside these transactions.
 *
 * With the feature off this is the inert status facade the design allows: `status` reads, the
 * writes are refused by ManagedRunnerEnabledGuard before they get here (and again here, should
 * anything call them), and no runtime, client or timer exists.
 */
@Injectable()
export class ManagedRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ManagedRunners');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MANAGED_RUNNER_GATE) private readonly gate: ManagedRunnerGate,
    @Inject(MANAGED_RUNNER_RUNTIME) private readonly runtime: ManagedRunnerRuntime | null,
  ) {}

  onModuleInit(): void {
    if (this.gate.enabled && this.runtime?.available) this.runtime.worker.start();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.runtime?.available) await this.runtime.worker.stop();
  }

  /** The owner's mapping as stored, with its derived usability and allowed actions. Writes nothing. */
  async status(ownerId: string): Promise<ManagedRunnerStatus> {
    const mapping = await this.prisma.managedRunner.findUnique({ where: { ownerId } });
    const runner = mapping
      ? await this.prisma.runner.findUnique({ where: { id: mapping.runnerId }, select: { status: true, lastHeartbeatAt: true } })
      : null;
    const available = !!this.runtime?.available;
    return managedRunnerStatus({
      enabled: this.gate.enabled,
      available,
      mapping,
      runner,
      now: new Date(),
      heartbeatFreshMs: this.runtime?.available ? this.runtime.profile.lifecycle.heartbeatFreshSeconds * 1000 : DEFAULT_HEARTBEAT_FRESH_MS,
    });
  }

  /**
   * Record RUNNING intent: the owner's one mapping, with its runner row and default workspace,
   * created together if it does not exist yet. Idempotent per owner — a repeated or concurrent
   * ensure answers with the same mapping.
   */
  async ensure(ownerId: string, idempotencyKey: string): Promise<ManagedRunnerStatus> {
    const runtime = this.operable();
    const mapping = (await this.prisma.managedRunner.findUnique({ where: { ownerId } }))
      ?? (await this.createMapping(ownerId, idempotencyKey, runtime.profile));
    if (mapping.desiredState === 'DELETED' || mapping.managementState === 'DELETING' || mapping.managementState === 'DELETED') {
      throw new ConflictException({
        code: MANAGED_RUNNER_TRANSITION_REFUSED,
        message: 'This managed runner was deleted; ensuring it again does not recreate its data.',
      });
    }
    runtime.worker.kick();
    return this.status(ownerId);
  }

  /**
   * An explicit retry of a FAILED mapping whose cause is safe to retry: the attempt budget starts
   * again from REQUESTED with the same mapping, runner, workspace and PVC. Conflicts that need an
   * operator are not retryable, and nothing here can authorize a new instance past the stop gate.
   */
  async retry(ownerId: string, idempotencyKey: string, revision: number | undefined): Promise<ManagedRunnerStatus> {
    const runtime = this.operable();
    if (revision === undefined) {
      throw new BadRequestException({ code: 'MANAGED_RUNNER_REVISION_REQUIRED', message: 'A retry names the revision it was read at.' });
    }
    const mapping = await this.owned(ownerId);
    // The same request again, already applied: answered as it was.
    if (mapping.lastRequestKey === idempotencyKey) return this.status(ownerId);
    if (mapping.revision !== revision) throw this.revisionConflict(mapping);
    const retryable = (mapping.lastError as { retryable?: unknown } | null)?.retryable === true;
    if (mapping.managementState !== 'FAILED' || !retryable) {
      throw new ConflictException({
        code: MANAGED_RUNNER_TRANSITION_REFUSED,
        message: mapping.managementState === 'FAILED'
          ? 'This failure needs an operator; retrying cannot resolve it.'
          : `A ${mapping.managementState} managed runner is not retried.`,
      });
    }
    const { count } = await this.prisma.managedRunner.updateMany({
      where: { id: mapping.id, ownerId, revision, managementState: 'FAILED' },
      data: {
        managementState: 'REQUESTED',
        stateEnteredAt: new Date(),
        attempt: 0,
        nextAttemptAt: null,
        startupDeadlineAt: null,
        lastError: Prisma.DbNull,
        lastRequestKey: idempotencyKey,
        revision: { increment: 1 },
      },
    });
    if (count === 0) throw this.revisionConflict(await this.owned(ownerId));
    runtime.worker.kick();
    return this.status(ownerId);
  }

  /** Wake, sleep and delete: authenticated and enabled, but performed by later versions of the manager. */
  async refuseUnsupported(ownerId: string, action: 'wake' | 'sleep' | 'delete'): Promise<never> {
    this.operable();
    await this.owned(ownerId);
    throw new ConflictException({
      code: MANAGED_RUNNER_TRANSITION_REFUSED,
      message: `This Orbit server cannot ${action} a managed runner yet; nothing was changed.`,
    });
  }

  /** The enabled runtime, or the refusal of a server that has none. Checked before anything is written. */
  private operable(): Extract<ManagedRunnerRuntime, { available: true }> {
    if (!this.gate.enabled) throw managedRunnerDisabledError();
    if (!this.runtime?.available) throw new ServiceUnavailableException(managedRunnerUnavailableReason());
    return this.runtime;
  }

  /** The caller's own mapping; another account's is as absent as none. */
  private async owned(ownerId: string): Promise<ManagedRunner> {
    const mapping = await this.prisma.managedRunner.findUnique({ where: { ownerId } });
    if (!mapping) throw new NotFoundException({ code: MANAGED_RUNNER_NOT_FOUND, message: 'You have no managed runner.' });
    return mapping;
  }

  private revisionConflict(mapping: ManagedRunner): ConflictException {
    return new ConflictException({
      code: MANAGED_RUNNER_REVISION_CONFLICT,
      message: 'The managed runner changed since it was read; read it again and decide again.',
      revision: mapping.revision,
    });
  }

  /**
   * The mapping, the runner row and the default workspace, in one retriable transaction. The runner
   * row starts OFFLINE with a credential nobody holds: the manager issues the real one with the
   * bootstrap Secret. A concurrent request that loses the owner's unique key reads the winner.
   */
  private async createMapping(ownerId: string, idempotencyKey: string, profile: ManagedRunnerProfile): Promise<ManagedRunner> {
    try {
      return await withTransactionRetry(
        this.prisma,
        async (tx) => {
          const runner = await tx.runner.create({
            data: {
              ownerId,
              name: MANAGED_RUNNER_NAME,
              tokenHash: sha256(generateToken(32)),
              status: 'OFFLINE',
              maxConcurrent: profile.runner.maxConcurrent,
            },
          });
          const workspace = await tx.workspace.create({
            data: {
              ownerId,
              name: MANAGED_WORKSPACE_NAME,
              runnerId: runner.id,
              targetRunnerId: runner.id,
              workDir: MANAGED_WORKSPACE_DIR,
              autoInitGit: true,
              enableWorktree: true,
            },
          });
          return tx.managedRunner.create({
            data: {
              ownerId,
              runnerId: runner.id,
              defaultWorkspaceId: workspace.id,
              clusterKey: profile.clusterKey,
              namespace: profile.kubernetes.namespace,
              pvcName: managedPvcName(runner.id),
              resourceProfileId: profile.resourceProfileId,
              lastRequestKey: idempotencyKey,
            },
          });
        },
        loggedRetry(this.log, 'managedRunners.createMapping'),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.prisma.managedRunner.findUnique({ where: { ownerId } });
        if (winner) return winner;
      }
      throw error;
    }
  }
}
