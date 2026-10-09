import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type ManagedRunner } from '@prisma/client';
import {
  MANAGED_RUNNER_BUSY,
  MANAGED_RUNNER_REVISION_CONFLICT,
  MANAGED_RUNNER_SLEEP_CAPABILITY,
  MANAGED_RUNNER_TRANSITION_REFUSED,
  type ManagedRunnerStatus,
} from '@orbit/shared';

import { generateToken, sha256 } from '../common/crypto.util';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import {
  EVERY_ACCOUNT,
  MANAGED_RUNNER_ELIGIBILITY,
  enabledAccountsOnly,
  managedRunnerAccountDisabledReason,
  managedRunnerNotEligibleReason,
  ownerAccountDisabled,
  type ManagedRunnerEligibility,
} from './managed-runner-eligibility';
import { MANAGED_RUNNER_GATE, managedRunnerDisabledError, type ManagedRunnerGate } from './managed-runner-gate';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import {
  MANAGED_RUNNER_NAME,
  MANAGED_WORKSPACE_DIR,
  MANAGED_WORKSPACE_NAME,
  managedPvcName,
} from './managed-runner-resources';
import { MANAGED_RUNNER_RUNTIME, type ManagedRunnerRuntime } from './managed-runner-runtime';
import type { ManagedRunnerSignIn } from './managed-runner-sign-in';
import { managedRunnerWork, recordManagedDemand } from './managed-runner-work';
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
 * anything call them), `signedIn` returns before reading anything, and no runtime, client or timer
 * exists.
 *
 * Whether an account is given a mapping at all is ManagedRunnerEligibility's decision, asked by both
 * ways one is created: a sign-in and an explicit ensure.
 *
 * An account an administrator disabled (`User.disabledAt`) is refused every write here, 403
 * ACCOUNT_DISABLED, after the switch and before anything is read of its mapping or written: no
 * mapping is created, retried, woken or put to sleep for it. The manager puts what it has to sleep.
 */
@Injectable()
export class ManagedRunnerService implements OnModuleInit, OnModuleDestroy, ManagedRunnerSignIn {
  private readonly log = new Logger('ManagedRunners');
  /** The rule provided under the token, or EVERY_ACCOUNT, asked only about an account that is not disabled. */
  private readonly eligibility: ManagedRunnerEligibility;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MANAGED_RUNNER_GATE) private readonly gate: ManagedRunnerGate,
    @Inject(MANAGED_RUNNER_RUNTIME) private readonly runtime: ManagedRunnerRuntime | null,
    @Optional() @Inject(MANAGED_RUNNER_ELIGIBILITY) rule?: ManagedRunnerEligibility,
  ) {
    this.eligibility = enabledAccountsOnly(rule ?? EVERY_ACCOUNT, prisma);
  }

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
    // Off, management is frozen and nothing more is read than the mapping and its runner.
    const ownerDisabled = this.gate.enabled ? await ownerAccountDisabled(this.prisma, ownerId) : false;
    return managedRunnerStatus({
      enabled: this.gate.enabled,
      available,
      // Only what could still be offered is asked: an account with a mapping has had its answer.
      eligible: !mapping && this.gate.enabled && available && !ownerDisabled ? await this.eligibility.eligible(ownerId) : true,
      ownerDisabled,
      mapping,
      runner,
      now: new Date(),
      heartbeatFreshMs: this.runtime?.available ? this.runtime.profile.lifecycle.heartbeatFreshSeconds * 1000 : DEFAULT_HEARTBEAT_FRESH_MS,
    });
  }

  /**
   * A sign-in (ManagedRunnerSignIn): AuthService.completeLogin calls this after it has issued the
   * tokens, and nothing else does. Off, it returns before reading anything. On, an eligible owner
   * without a mapping gets one — its runner row and default workspace with it, once — and the manager
   * is woken to provision it in the background: the sign-in waits for no instance and makes no
   * Kubernetes call. A mapping that exists is left as it is, whatever its state: a sign-in neither
   * retries a FAILED one nor recreates a deleted one. Nothing here throws. A sign-in whose intent
   * could not be recorded stands; an explicit ensure, or the next sign-in, records it.
   */
  async signedIn(user: { id: string }): Promise<void> {
    if (!this.gate.enabled) return;
    // Enabled without a usable environment: the status read reports MANAGED_RUNNER_UNAVAILABLE.
    const runtime = this.runtime;
    if (!runtime?.available) return;
    try {
      if (await this.prisma.managedRunner.findUnique({ where: { ownerId: user.id }, select: { id: true } })) return;
      if (!(await this.eligibility.eligible(user.id))) return;
      await this.createMapping(user.id, `sign-in:${randomUUID()}`, runtime.profile);
      runtime.worker.kick();
    } catch (error) {
      this.log.warn(`managed runner intent not recorded at sign-in for owner ${user.id}; an explicit ensure records it: ${(error as Error).message}`);
    }
  }

  /**
   * Record RUNNING intent: the owner's one mapping, with its runner row and default workspace,
   * created together if it does not exist yet. Idempotent per owner — a repeated or concurrent
   * ensure answers with the same mapping. Creating one is for an eligible owner only.
   */
  async ensure(ownerId: string, idempotencyKey: string): Promise<ManagedRunnerStatus> {
    const runtime = this.operable();
    await this.refuseDisabledOwner(ownerId);
    const mapping = (await this.prisma.managedRunner.findUnique({ where: { ownerId } }))
      ?? (await this.createEligibleMapping(ownerId, idempotencyKey, runtime.profile));
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
    await this.refuseDisabledOwner(ownerId);
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

  /**
   * An explicit wake: demand from the owner, the same as a message would be. A sleeping or draining
   * runner is started again (a drain the instance has not accepted is called off; one it has accepted
   * finishes, and the runner starts again after it); anything else on its way up is left as it is. A
   * FAILED runner is retried, not woken, and a fenced one waits for its proof.
   */
  async wake(ownerId: string, idempotencyKey: string): Promise<ManagedRunnerStatus> {
    const runtime = this.operable();
    await this.refuseDisabledOwner(ownerId);
    const mapping = await this.owned(ownerId);
    if (mapping.lastRequestKey === idempotencyKey) return this.status(ownerId);
    if (!['REQUESTED', 'WAITING_CAPACITY', 'PROVISIONING', 'STARTING', 'READY', 'DRAINING', 'SLEEPING'].includes(mapping.managementState)) {
      throw new ConflictException({
        code: MANAGED_RUNNER_TRANSITION_REFUSED,
        message: mapping.managementState === 'FAILED'
          ? 'A failed managed runner is retried, not woken.'
          : `A ${mapping.managementState} managed runner cannot be woken.`,
      });
    }
    await recordManagedDemand(this.prisma, mapping.runnerId, new Date());
    await this.prisma.managedRunner.updateMany({ where: { id: mapping.id, ownerId }, data: { lastRequestKey: idempotencyKey } });
    runtime.worker.kick();
    return this.status(ownerId);
  }

  /**
   * An explicit sleep of a READY runner. Never of one with work: the records showing a turn queued or
   * running, a job, a landing or any other operation for it refuse the request (409
   * MANAGED_RUNNER_BUSY), and so does a runner that cannot sleep. Accepted, it is a desire: the
   * manager drains the runner once its instance reports nothing in flight, and demand that comes
   * first keeps it running.
   */
  async sleep(ownerId: string, idempotencyKey: string, revision: number | undefined): Promise<ManagedRunnerStatus> {
    const runtime = this.operable();
    await this.refuseDisabledOwner(ownerId);
    if (revision === undefined) {
      throw new BadRequestException({ code: 'MANAGED_RUNNER_REVISION_REQUIRED', message: 'A sleep names the revision it was read at.' });
    }
    const mapping = await this.owned(ownerId);
    if (mapping.lastRequestKey === idempotencyKey) return this.status(ownerId);
    if (mapping.revision !== revision) throw this.revisionConflict(mapping);
    if (mapping.managementState !== 'READY' || mapping.desiredState !== 'RUNNING') {
      throw new ConflictException({ code: MANAGED_RUNNER_TRANSITION_REFUSED, message: `A ${mapping.managementState} managed runner is not put to sleep.` });
    }
    const runner = await this.prisma.runner.findUnique({ where: { id: mapping.runnerId }, select: { capabilities: true } });
    if (!runner?.capabilities.includes(MANAGED_RUNNER_SLEEP_CAPABILITY)) {
      throw new ConflictException({ code: MANAGED_RUNNER_TRANSITION_REFUSED, message: 'This managed runner cannot be put to sleep: its runner does not report what it is doing.' });
    }
    const work = await managedRunnerWork(this.prisma, mapping.runnerId);
    if (work.length > 0) {
      throw new ConflictException({
        code: MANAGED_RUNNER_BUSY,
        message: 'This managed runner has work in flight or waiting, and sleep never interrupts work. Try again once it is done.',
        work,
      });
    }
    const { count } = await this.prisma.managedRunner.updateMany({
      where: { id: mapping.id, ownerId, revision, managementState: 'READY', desiredState: 'RUNNING' },
      data: { desiredState: 'SLEEPING', lastRequestKey: idempotencyKey, revision: { increment: 1 } },
    });
    if (count === 0) throw this.revisionConflict(await this.owned(ownerId));
    runtime.worker.kick();
    return this.status(ownerId);
  }

  /** Delete: authenticated and enabled, but performed by a later version of the manager. */
  async refuseUnsupported(ownerId: string, action: 'delete'): Promise<never> {
    this.operable();
    await this.refuseDisabledOwner(ownerId);
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

  /**
   * A disabled account's write, refused 403 ACCOUNT_DISABLED before anything is read of its mapping
   * or written. Read afresh from its row: JwtAuthGuard's view of the disabled accounts can be half a
   * minute old on another replica, and this answer must not be.
   */
  private async refuseDisabledOwner(ownerId: string): Promise<void> {
    if (await ownerAccountDisabled(this.prisma, ownerId)) throw new ForbiddenException(managedRunnerAccountDisabledReason());
  }

  /** The caller's own mapping; another account's is as absent as none. */
  private async owned(ownerId: string): Promise<ManagedRunner> {
    const mapping = await this.prisma.managedRunner.findUnique({ where: { ownerId } });
    if (!mapping) throw new NotFoundException({ code: MANAGED_RUNNER_NOT_FOUND, message: 'You have no managed runner.' });
    return mapping;
  }

  /** An explicit ensure's new mapping, after the decision that the owner may have one. */
  private async createEligibleMapping(ownerId: string, idempotencyKey: string, profile: ManagedRunnerProfile): Promise<ManagedRunner> {
    if (!(await this.eligibility.eligible(ownerId))) throw new ForbiddenException(managedRunnerNotEligibleReason());
    return this.createMapping(ownerId, idempotencyKey, profile);
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
