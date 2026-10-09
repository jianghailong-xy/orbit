import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ManagedRunner, ManagedRunnerManagementState } from '@prisma/client';
import type { ManagedRunnerReason } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { MANAGED_RUNNER_GATE, type ManagedRunnerGate } from './managed-runner-gate';
import { MANAGED_RUNNER_RUNTIME, type ManagedRunnerRuntime } from './managed-runner-runtime';
import { recordManagedDemand } from './managed-runner-work';

/**
 * Demand for a managed runner (docs/managed-runner-design.md, "Provisioning retry wake and sleep"
 * 5 to 7): work addressed to the runner's mapping wakes it, and work in flight or queued keeps it
 * from sleeping.
 *
 * Two ways in, by design. The hook (`ManagedRunnerDemand.requested`) is called where work for a
 * runner is recorded — a session created or revived, a turn queued, an auto-retry waiting on the
 * runner — and before any gate that refuses work for an offline runner, so a sleeping runner is
 * asked to wake by the very request that found it asleep. The sweep (`sleepingRunnersWithDemand`,
 * run by the manager on every pass) reads the same facts from the database and repairs whatever a
 * hook missed: a replica that died between commit and hook, or work that reaches a runner only
 * through its heartbeat — a landing, a merge, a sign-in.
 *
 * With the switch off the hook returns before it reads anything: every caller keeps the
 * self-managed behaviour it had, and no managed row is written. A runner without a mapping matches
 * no row: one UPDATE by a unique key, and nothing else changes for it. Neither does a runner whose
 * owner an administrator disabled: demand for it is not recorded and wakes nothing — the caller goes
 * on as for any runner that is not coming back — and the sweep leaves it alone until the account is
 * enabled again.
 */

/** Where a piece of demand came from: for the log line, never for a decision. */
export type ManagedDemandSource = 'session' | 'turn' | 'resume' | 'auto-retry' | 'sweep' | 'owner';

export interface ManagedRunnerDemandAnswer {
  /** The switch is on and the runner is a managed runner: the demand was recorded on its mapping. */
  managed: boolean;
  /** …and it comes back by itself: it is up, starting, waiting for capacity, draining or asleep.
   *  False for a mapping that needs an owner or an operator first (FAILED, FENCING, deletion). */
  comingBack: boolean;
  state?: ManagedRunnerManagementState;
  /** What it is waiting for, as the status read says it. */
  reason?: ManagedRunnerReason | null;
  retryAfter?: Date | null;
}

export interface ManagedRunnerDemand {
  /** Work for `runnerId` is recorded, or about to be. Never throws; a failure answers `managed: false`. */
  requested(runnerId: string | null | undefined, source: ManagedDemandSource): Promise<ManagedRunnerDemandAnswer>;
}

/** The DI token the session paths inject it by. A module graph without managed runners has nothing here. */
export const MANAGED_RUNNER_DEMAND = Symbol('MANAGED_RUNNER_DEMAND');

export const NOT_MANAGED: ManagedRunnerDemandAnswer = Object.freeze({ managed: false, comingBack: false });

/** The states a mapping leaves by itself, given time, capacity or a manager pass. */
const COMING_BACK: ReadonlySet<ManagedRunnerManagementState> = new Set([
  'REQUESTED', 'WAITING_CAPACITY', 'PROVISIONING', 'STARTING', 'READY', 'DRAINING', 'SLEEPING',
]);

export function demandAnswer(mapping: ManagedRunner): ManagedRunnerDemandAnswer {
  const reason = mapping.lastError as ManagedRunnerReason | null;
  return {
    managed: true,
    comingBack: COMING_BACK.has(mapping.managementState),
    state: mapping.managementState,
    reason: reason && typeof reason === 'object' ? { code: reason.code, message: reason.message, retryable: reason.retryable === true } : null,
    retryAfter: mapping.nextAttemptAt,
  };
}

/**
 * The hook, as the session paths inject it (MANAGED_RUNNER_DEMAND). Off — or on without a usable
 * environment, where nothing could act on it — it answers `managed: false` before reading anything.
 * On, it records demand and kicks this replica's reconcile loop when the mapping needs the manager
 * to move; another replica's loop finds it at its next pass. A failure is logged and answered
 * `managed: false`: the caller goes on as for any runner, and the sweep repairs the missed wake.
 */
@Injectable()
export class ManagedRunnerDemandService implements ManagedRunnerDemand {
  private readonly log = new Logger('ManagedRunnerDemand');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MANAGED_RUNNER_GATE) private readonly gate: ManagedRunnerGate,
    @Inject(MANAGED_RUNNER_RUNTIME) private readonly runtime: ManagedRunnerRuntime | null,
  ) {}

  async requested(runnerId: string | null | undefined, source: ManagedDemandSource): Promise<ManagedRunnerDemandAnswer> {
    if (!this.gate.enabled || !runnerId) return NOT_MANAGED;
    const runtime = this.runtime;
    if (!runtime?.available) return NOT_MANAGED;
    try {
      const mapping = await recordManagedDemand(this.prisma, runnerId, new Date());
      if (!mapping) return NOT_MANAGED;
      if (mapping.managementState !== 'READY') {
        this.log.log(`managed runner ${mapping.id}: demand (${source}) while ${mapping.managementState}`);
        runtime.worker.kick();
      }
      return demandAnswer(mapping);
    } catch (error) {
      this.log.warn(`managed runner demand for runner ${runnerId} (${source}) not recorded; the next sweep finds it: ${(error as Error).message}`);
      return NOT_MANAGED;
    }
  }
}
