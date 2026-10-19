import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { Prisma, type ManagedRunner } from '@prisma/client';
import {
  MANAGED_RUNNER_CAPACITY_UNAVAILABLE,
  MANAGED_RUNNER_SLEEP_CAPABILITY,
  MODEL_UNAVAILABLE,
  type ManagedRunnerReason,
} from '@orbit/shared';

import { generateToken, sha256 } from '../common/crypto.util';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedKubeClient } from './kube-client';
import { KubernetesBackend } from './kubernetes-backend';
import {
  ManagedFirewallNotEnforced,
  ManagedInstanceLimit,
  ManagedRunnerConflict,
  ManagedVolumeHeld,
  type ManagedCredential,
  type ManagedInstance,
  type ManagedRunnerBackend,
  type ManagedVolume,
  type ManagedVolumeBacking,
  type VerifiedVolume,
} from './managed-runner-backend';
import {
  capacityShortMessage,
  computeOf,
  readCapacityPool,
  readReservation,
  releaseCapacity,
  reserveCapacity,
  shortDimensions,
  syncCapacityPool,
  type CapacityPool,
  type ComputeAmounts,
  type ManagedRunnerReservation,
  type StorageAmounts,
} from './managed-runner-capacity';
import { ownerAccountDisabled } from './managed-runner-eligibility';
import { stopProofFor, type ManagedRunnerPredecessor, type ManagedRunnerStopProof } from './managed-runner-fencing';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import { readStoredWorkload, workloadIdle, type StoredManagedWorkload } from './managed-runner-sleep';
import { managedKeySupply, managedRuntimeSupply, type ManagedSupplyRunner } from './managed-runner-supply';
import {
  MANAGED_RUNNER_VOLUME_SWITCHED_ACTIVITY,
  ManagedVolumeSwitchRefused,
  ManagedVolumeSwitchRevisionMoved,
  recordedVolume,
  volumeSwitchStateProblem,
  type ManagedVolumeSwitchOutcome,
  type ManagedVolumeSwitchRequest,
  type SwitchedVolume,
  type VolumeSwitchCheck,
} from './managed-runner-volume-switch';
import { managedRunnerWork, recordManagedDemand, sleepingRunnersWithDemand } from './managed-runner-work';

/**
 * The managed runner manager: drives one mapping's data volume and instance towards its desired
 * state (docs/managed-runner-design.md, "Identity and durable mapping" and "Management and execution
 * states"). The persisted mapping is the work queue — a pass reads the row, observes the backend by
 * deterministic name and takes at most one step at a time, each committed as a compare-and-set on
 * the row's `revision` under this replica's lease — so a restart, a second replica or a lost reply
 * resumes from what is recorded and what is observed, never from memory.
 *
 * Every infrastructure call goes through the run backend (managed-runner-backend.ts):
 * KubernetesBackend (a Ceph RBD PVC, a bootstrap Secret, a bare Pod) or DockerBackend (a local
 * volume, a credential file and a container, through the restricted Docker channel). What is decided
 * here — the states, admission, the single-writer gate, wake, sleep and a disabled owner's runner —
 * is the same for every backend, and a manager drives only the mappings its own backend made
 * (`managed_runner.backend`): another backend's are left as they are, as the switch off leaves them.
 *
 * This version provisions: REQUESTED → PROVISIONING (data volume, the storage it is bound to and its
 * handle, the bootstrap credential of the generation and the runner credential it carries) →
 * STARTING (the one instance of the current generation, until the runner row has a fresh heartbeat
 * reporting a runtime installed and signed in, or one installed that a model key of the owner's own
 * runs on — the runtime, or the key's slug, is what READY records as `initialProvider`; without either
 * it reports MODEL_UNAVAILABLE) → READY; and FAILED, with a structured cause, when the attempt
 * budget is spent or what the backend holds is not what the mapping recorded. It never deletes a
 * data volume, a runner row or a workspace. The only objects it removes, always by UID, are an
 * instance whose host reported it stopped, when it is replaced or put to sleep, and the bootstrap
 * credential of a generation the gate has retired.
 *
 * The single-writer gate (docs/managed-runner-design.md, "Single Pod and single writer protection")
 * is `replacePredecessor`: generation N+1 — a new credential, a new instance — is issued only after
 * the recorded instance of generation N is proven stopped. Proof is its host's report that every
 * process of that instance UID stopped, or an operator's fencing receipt bound to that instance and
 * volume (managed-runner-fencing.ts); either way the instance object must be gone and nothing may
 * still hold the volume. An instance that vanished or was replaced unobserved, a stale heartbeat or
 * an expired lease is not proof: the mapping goes FENCING, its predecessor's credential stops working
 * at once, its disk is kept, and it waits for the proof. No instance is created at all until the
 * backend shows its single-instance guard in force.
 *
 * Capacity, wake and sleep (docs/managed-runner-design.md, "Provisioning retry wake and sleep" and
 * "Resource admission model supply and isolation"):
 *
 *   - Admission, before any resource exists, reserves the mapping's share of the environment's
 *     fixed budget (managed-runner-capacity.ts) in the transaction that moves it on: storage once,
 *     for as long as its volume exists; compute until its instance is proven stopped. No room is
 *     WAITING_CAPACITY, with the reason and a retry time; a release anywhere in the pool moves the
 *     pool's revision and every waiting intent looks again, oldest first. Nothing is deleted,
 *     evicted or resized to make room.
 *   - Sleep: a READY runner the records show nothing for (managed-runner-work.ts), whose authorized
 *     instance reports no turn, job, operation or unflushed event and has been idle the profile's
 *     idle interval, drains: claims stop, the instance is asked — in its heartbeat — to stop, and
 *     accepts only while it is still idle and no demand has come; the acceptance and calling the
 *     drain off exclude each other on the row. It then exits on its own, and its host's report of
 *     that stop is the stop proof the single-writer gate needs: the instance object is released by
 *     UID, the volume is released, the generation advances and only then is compute released.
 *     Runner row, workspace, data volume and data stay; SLEEPING.
 *   - Wake: demand (managed-runner-demand.ts, or the sweep below) desires RUNNING again; a sleeping
 *     mapping goes back through admission and provisioning, which adopt the recorded volume and the
 *     same runner row, and starts the next generation's instance on them.
 *
 * A mapping whose owner an administrator disabled is driven to sleep and never towards READY
 * (`whileDisabled`): nothing is created for it, its instance drains and stops through the same gate a
 * sleep goes through, and demand does not wake it until the account is enabled again.
 *
 * Recovery (docs/managed-runner-design.md, "Implementation record: failure recovery and visibility"):
 *
 *   - An instance that stops unasked with its host's report of the stop — a crash, its memory limit,
 *     its host or Docker restarting — is started again by itself: the next generation on the same
 *     volume and runner, through the same gate, within `maxAttempts` and the backoff (`terminated`).
 *     A crash loop still ends FAILED. Every such stop is logged; running out of memory has reasons
 *     of its own for the owner.
 *   - The owner is told it is restarting (POD_RESTARTING, POD_RESTARTING_OUT_OF_MEMORY) until it is
 *     READY. A wait on the way — its predecessor's volume detaching, a volume held, the environment's
 *     cap, a transient error — is said while it lasts and carries that reason, which comes back once
 *     the wait is over (`waitReason`).
 *   - No instance is created on a volume something else holds, a backup's helper container say: it
 *     waits until the volume is free (VOLUME_IN_USE), as for a predecessor's volume still detaching.
 *     A host at its cap on instances makes it wait for room the same way (CONTAINER_LIMIT), and so does
 *     a Docker host whose firewall for managed runners is not in force (FIREWALL_NOT_ENFORCED).
 *   - A FAILED mapping whose recorded volume was missing is looked at again, and becomes retryable
 *     once that very volume is back (`volumeBack`).
 *   - A backend that cannot be reached at all — no request got to it: the Kubernetes API server or
 *     the Docker channel down, restarting or cut off — spends no attempt in any state (`unreachable`),
 *     any more than a held volume does: the budget counts tries that failed, and an outage lasts as
 *     long as it lasts. One that answers with a transient failure still spends one while provisioning.
 *   - On Kubernetes, where a claim's UID cannot be recreated, an administrator can switch an asleep or
 *     failed mapping to a volume restored under the runner's name, once the manager has verified it
 *     and that the recorded one is no longer in use (`switchVolume`): recorded, with an audit row.
 *
 * Left to the work that follows: deletion.
 */

/** Where a pass got to. */
export type ReconcileOutcome =
  /** Another replica holds the lease. */
  | 'LEASED_ELSEWHERE'
  /** The row changed under this pass; the next pass starts from the new revision. */
  | 'SUPERSEDED'
  /** Nothing to do until the backend or the runner moves (volume binding, instance start, heartbeat). */
  | 'WAITING'
  /** A transient failure: the next attempt is scheduled. */
  | 'BACKOFF'
  | 'READY'
  | 'FAILED'
  /** The recorded instance's stop is not proven: nothing replaces it until it is. */
  | 'FENCING'
  /** The environment's budget has no room: it looks again at its retry time or on a release. */
  | 'WAITING_CAPACITY'
  /** Draining to sleep: waiting for the instance to accept and stop. */
  | 'DRAINING'
  /** Compute stopped and released; the volume and identity kept. */
  | 'SLEEPING'
  /** A state this version does not drive (deletion), or a mapping with nothing to do. */
  | 'IDLE'
  | 'NOT_FOUND';

export interface ManagedRunnerManagerOptions {
  /** This replica's lease identity. */
  holder?: string;
  now?: () => Date;
  random?: () => number;
  log?: Pick<Logger, 'warn' | 'error'>;
}

/** The row moved on under this pass. */
class Superseded extends Error {}

/** The pool had no room: the admission transaction is rolled back whole. */
class CapacityRefused extends Error {}

/** The client-safe sentence for each cause. Raw infrastructure errors stay in the server log. */
const REASONS: Record<string, { message: string; retryable: boolean }> = {
  TRANSIENT: { message: 'A transient infrastructure error interrupted provisioning; it is retried automatically.', retryable: true },
  RETRY_EXHAUSTED: { message: 'Provisioning kept failing on transient infrastructure errors and stopped. It can be retried.', retryable: true },
  STARTUP_TIMEOUT: { message: 'The runner did not report in before its startup deadline. It can be retried.', retryable: true },
  [MODEL_UNAVAILABLE]: {
    message: 'The runner is up, but none of its runtimes is signed in and none of your model keys runs on it, so it cannot start a session. Sign one in, or add a model key, from Infrastructure; a runner that has stopped waiting for it can then be retried.',
    retryable: true,
  },
  POD_RESTARTING: {
    message: 'The runner instance stopped, so it is being started again on the same data volume. Messages sent meanwhile wait for it.',
    retryable: true,
  },
  POD_RESTARTING_OUT_OF_MEMORY: {
    message: 'The runner ran out of memory and stopped, so it is being started again on the same data volume. Messages sent meanwhile wait for it.',
    retryable: true,
  },
  POD_TERMINATED: { message: 'The runner instance stopped too often to be started again automatically. A retry starts it again and keeps the data volume.', retryable: true },
  POD_OUT_OF_MEMORY: {
    message: 'The runner kept running out of memory, so it is not started again automatically. A retry starts it again and keeps the data volume; if it keeps happening, an operator can give runners more memory.',
    retryable: true,
  },
  KUBERNETES_FORBIDDEN: { message: 'The cluster refused the manager. An operator has to check its permissions; then it can be retried.', retryable: true },
  KUBERNETES_REJECTED: { message: 'The cluster rejected a managed runner object. An operator has to check the environment; then it can be retried.', retryable: true },
  KUBERNETES_QUOTA_EXCEEDED: {
    message: "The cluster's resource quota for managed runners has no room for this runner, so it is not started yet. It starts by itself once there is room, as when another runner goes to sleep or an operator raises the quota.",
    retryable: false,
  },
  PVC_CONFLICT: { message: "A data volume under this runner's name is not the recorded one, so nothing was replaced. An operator has to review it.", retryable: false },
  PVC_MISSING: { message: "This runner's recorded data volume is gone. No empty volume is created in its place; an operator has to review it.", retryable: false },
  PVC_RESTORED: { message: "This runner's data volume is back as it was recorded. A retry starts the runner on it.", retryable: true },
  PV_CONFLICT: { message: "The storage behind this runner's data volume is not the recorded one. An operator has to review it.", retryable: false },
  SECRET_CONFLICT: { message: "The runner's bootstrap credential object is not the expected one. An operator has to review it.", retryable: false },
  SECRET_MISSING: { message: "The runner's bootstrap credential is gone while an instance exists. No new credential is issued under it; an operator has to review it.", retryable: false },
  POD_CONFLICT: { message: "An instance under this runner's name is not the expected one. An operator has to review it.", retryable: false },
  PREDECESSOR_STOP_UNPROVEN: {
    message: 'The previous runner instance is gone, and nothing proves it stopped, so no new instance is started and the data volume is kept. It waits for proof that it stopped or for an operator’s fencing receipt.',
    retryable: false,
  },
  POD_REPLACED: {
    message: 'An instance this runner did not authorize holds its name, so no new instance is started and the data volume is kept. It waits for proof that the previous one stopped or for an operator’s fencing receipt.',
    retryable: false,
  },
  FENCING_RECEIPT_INVALID: {
    message: 'A fencing receipt was found, but it is incomplete or names another instance or volume, so it was not accepted. An operator has to correct it.',
    retryable: false,
  },
  VOLUME_STILL_ATTACHED: {
    message: 'The previous instance has stopped and its data volume is still detaching. The next instance starts once it is detached.',
    retryable: false,
  },
  VOLUME_IN_USE: {
    message: "Something else is using this runner's data volume, such as a backup, so the runner is not started on it yet. It starts once the volume is free.",
    retryable: false,
  },
  ADMISSION_GUARD_MISSING: {
    message: 'The single-Pod admission guard is not in force in this environment, so no instance is started. An operator has to install it; then it can be retried.',
    retryable: true,
  },
  ADMISSION_GUARD_UNVERIFIED: {
    message: 'Whether the single-Pod admission guard is in force could not be established, so no instance is started. An operator has to check it; then it can be retried.',
    retryable: true,
  },
  SLEEP_STOP_OVERDUE: {
    message: 'The runner accepted going to sleep but has not stopped yet. It is not forced: it stops once its own drain finishes, and new work wakes it again afterwards.',
    retryable: false,
  },
  SLEEP_STOP_FORCED: {
    message: 'The runner accepted going to sleep but did not stop within its drain time, so it is being stopped. New work wakes it again afterwards.',
    retryable: false,
  },
  DOCKER_CHANNEL_FORBIDDEN: { message: 'The Docker channel refused the manager. An operator has to check its token; then it can be retried.', retryable: true },
  DOCKER_CHANNEL_REFUSED: { message: 'The Docker channel refused a managed runner request. An operator has to check the environment; then it can be retried.', retryable: true },
  DOCKER_CHANNEL_MISMATCH: {
    message: 'The Docker channel serves another deployment, image or limits than this server expects. An operator has to align them; then it can be retried.',
    retryable: true,
  },
  CONTAINER_GUARD_MISSING: {
    message: "The Docker channel admitted a second container for a runner's volume, so no instance is started. An operator has to check the channel; then it can be retried.",
    retryable: true,
  },
  CONTAINER_GUARD_UNVERIFIED: {
    message: "Whether the Docker channel's single-container guard is in force could not be established, so no instance is started. An operator has to check it; then it can be retried.",
    retryable: true,
  },
  VOLUME_OVER_LIMIT: {
    message: "This runner's data volume is over its disk limit, so no instance is started on it. An operator has to free space on it or raise its limit; then it can be retried.",
    retryable: true,
  },
  CONTAINER_LIMIT: {
    message: 'The Docker host has as many runner containers as it allows, so this runner is not started yet. It starts by itself once one of them is removed, as when another runner goes to sleep.',
    retryable: false,
  },
  FIREWALL_NOT_ENFORCED: {
    message: "The Docker host's firewall for managed runners is not in force, so this runner is not started yet. It starts by itself once an operator has the firewall running again.",
    retryable: false,
  },
};

/**
 * The waits for room (`waitForRoom`): a create the environment refused for now — its cap, or on Docker its
 * firewall for managed runners not in force — made again once it would be admitted.
 */
const ROOM_WAITS: ReadonlySet<string> = new Set(['CONTAINER_LIMIT', 'KUBERNETES_QUOTA_EXCEEDED', 'FIREWALL_NOT_ENFORCED']);

/** A reason an automatic restart stands under (`terminated`). */
function restartingReason(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | null | undefined)?.code;
  return code === 'POD_RESTARTING' || code === 'POD_RESTARTING_OUT_OF_MEMORY';
}

export function managedRunnerReason(code: string): ManagedRunnerReason {
  const known = REASONS[code];
  return { code, message: known?.message ?? 'The managed runner could not be provisioned.', retryable: known?.retryable ?? false };
}

/** What a step decided: stop the pass with an outcome, or go on from the row it committed. */
type Step = { done: ReconcileOutcome } | { next: ManagedRunner };

/** The states a RUNNING desire drives towards READY (and READY itself, watched). */
const ACTIVE_STATES = ['REQUESTED', 'PROVISIONING', 'STARTING', 'READY', 'FENCING'] as const;
/** The states a disabled owner's mapping is driven to sleep from, or kept asleep or fenced in. */
const DRIVEN_WHILE_DISABLED: ReadonlySet<ManagedRunner['managementState']> = new Set([
  'REQUESTED', 'WAITING_CAPACITY', 'PROVISIONING', 'STARTING', 'READY', 'DRAINING', 'SLEEPING', 'FENCING',
]);
/**
 * The states in which a pass only looks at what runs (and, draining, asks the host to stop or remove
 * what has stopped; failed, looks for a missing volume). A backend that does not answer there says
 * nothing about the runner: no attempt of the provisioning budget is spent and nothing is failed —
 * the next pass looks again. A restart of the Docker channel, or a Kubernetes API blip, leaves an up
 * or draining runner as it was.
 */
const OBSERVING_STATES: ReadonlySet<ManagedRunner['managementState']> = new Set(['READY', 'DRAINING', 'FENCING', 'FAILED']);
/** A pass takes at most this many steps; the worker's next pass continues. */
const MAX_STEPS_PER_PASS = 12;
/** Sleeping mappings the demand sweep wakes per pass. */
const SWEEP_BATCH = 50;

/** The drain was called off: why, for the log. */
type DrainAbort = 'DEMAND' | 'WORK' | 'RUNNER_BUSY' | 'TELEMETRY_MISSING' | 'NOT_ACKNOWLEDGED';

export class ManagedRunnerManager {
  readonly holder: string;
  /** Where instances run: every infrastructure call this manager makes. */
  readonly backend: ManagedRunnerBackend;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly log: Pick<Logger, 'warn' | 'error'>;
  /** This environment's capacity pool, created or brought to the backend's totals once per process. */
  private pool?: Promise<string>;

  /** On `backend`, with the profile's lifecycle budgets. */
  constructor(prisma: PrismaService, backend: ManagedRunnerBackend, profile: Pick<ManagedRunnerProfile, 'lifecycle'>, options?: ManagedRunnerManagerOptions);
  /** On KubernetesBackend over `client` and `profile`: how every caller built a manager before backends. */
  constructor(prisma: PrismaService, client: ManagedKubeClient, profile: ManagedRunnerProfile, options?: ManagedRunnerManagerOptions);
  constructor(
    private readonly prisma: PrismaService,
    backend: ManagedRunnerBackend | ManagedKubeClient,
    private readonly profile: Pick<ManagedRunnerProfile, 'lifecycle'>,
    options: ManagedRunnerManagerOptions = {},
  ) {
    this.backend = 'name' in backend ? backend : new KubernetesBackend(backend, profile as ManagedRunnerProfile);
    this.holder = options.holder ?? randomUUID();
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.log = options.log ?? new Logger('ManagedRunnerManager');
  }

  /**
   * The mappings a pass should visit now. A disabled owner's first, whatever their retry time: what
   * of theirs runs, is on its way up or still wants to wake is put to sleep (`whileDisabled`), and its
   * compute given back. Then work — every state that moves by itself, an intent waiting for capacity
   * once its retry time comes or the pool has moved since it was refused (oldest waiter first, so a
   * release is offered in the order the waits began), a drain, a wake — then the READY runners whose
   * instance and idleness each pass looks at, and last the FAILED ones whose recorded volume is
   * missing, to see whether it is back (`volumeBack`).
   */
  async dueMappings(limit: number): Promise<string[]> {
    const now = this.now();
    const due = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] };
    const pool = await this.capacityPool();
    const backend = this.backend.name;
    const disabled = await this.prisma.managedRunner.findMany({
      where: {
        backend,
        owner: { disabledAt: { not: null } },
        desiredState: { not: 'DELETED' },
        OR: [
          { managementState: { in: ['REQUESTED', 'WAITING_CAPACITY', 'PROVISIONING', 'STARTING', 'READY'] } },
          { managementState: 'SLEEPING', desiredState: 'RUNNING' },
        ],
      },
      orderBy: { stateEnteredAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    const waiting = await this.prisma.managedRunner.findMany({
      where: {
        backend,
        managementState: 'WAITING_CAPACITY',
        desiredState: 'RUNNING',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }, { capacityRevision: null }, { capacityRevision: { lt: pool.revision } }],
      },
      orderBy: { stateEnteredAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    const moving = await this.prisma.managedRunner.findMany({
      where: {
        backend,
        OR: [
          { desiredState: 'RUNNING', managementState: { in: ['REQUESTED', 'PROVISIONING', 'STARTING', 'FENCING'] }, ...due },
          // Demand cannot come for a disabled owner's fenced mapping: its proof is looked for anyway.
          { managementState: 'FENCING', owner: { disabledAt: { not: null } }, ...due },
          { managementState: 'DRAINING' },
          { managementState: 'SLEEPING', desiredState: 'RUNNING' },
          { managementState: 'READY', desiredState: 'SLEEPING' },
        ],
      },
      orderBy: { stateEnteredAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    const watched = await this.prisma.managedRunner.findMany({
      where: { backend, desiredState: 'RUNNING', managementState: 'READY', ...due },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    const missing = await this.prisma.managedRunner.findMany({
      where: { backend, managementState: 'FAILED', lastError: { path: ['code'], equals: 'PVC_MISSING' } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return [...new Set([...disabled, ...waiting, ...moving, ...watched, ...missing].map((row) => row.id))].slice(0, limit);
  }

  /**
   * The demand sweep: a sleeping mapping whose runner has work waiting in the records — a turn
   * queued, a landing, a merge, a due wakeup or retry, a sign-in — is asked to wake, as the hook would
   * have asked had it been reached (a replica that died between its commit and its hook, or work that
   * only a heartbeat carries). Answers how many were woken.
   */
  async sweepDemand(): Promise<number> {
    const runners = await sleepingRunnersWithDemand(this.prisma, SWEEP_BATCH);
    for (const runnerId of runners) {
      const mapping = await recordManagedDemand(this.prisma, runnerId, this.now());
      if (mapping) this.log.warn(`managed runner ${mapping.id}: work waiting while it sleeps; waking it`);
    }
    return runners.length;
  }

  /** One pass over one mapping, under this replica's lease. Another backend's mapping is not driven, nor leased. */
  async reconcile(mappingId: string): Promise<ReconcileOutcome> {
    const leased = await this.acquireLease(mappingId);
    if (!leased) {
      const found = await this.prisma.managedRunner.findUnique({ where: { id: mappingId }, select: { backend: true } });
      if (!found) return 'NOT_FOUND';
      return found.backend === this.backend.name ? 'LEASED_ELSEWHERE' : 'IDLE';
    }
    try {
      let mapping = leased;
      for (let steps = 0; steps < MAX_STEPS_PER_PASS; steps += 1) {
        const step = await this.step(mapping);
        if ('done' in step) return step.done;
        mapping = step.next;
      }
      return 'WAITING';
    } finally {
      await this.releaseLease(mappingId).catch((error: Error) =>
        this.log.warn(`managed runner ${mappingId}: lease not released (it expires on its own): ${error.message}`),
      );
    }
  }

  private async step(mapping: ManagedRunner): Promise<Step> {
    // A disabled owner's mapping goes to sleep whatever it wants and whenever it was to be retried.
    // FAILED, deletion and the states nothing drives are left to the rules below.
    const disabled = mapping.desiredState !== 'DELETED' && DRIVEN_WHILE_DISABLED.has(mapping.managementState)
      && (await ownerAccountDisabled(this.prisma, mapping.ownerId));
    if (!disabled) {
      switch (mapping.managementState) {
        // Whatever is desired: a drain finishes or is called off; a sleeping mapping wakes or stays.
        case 'DRAINING':
        case 'SLEEPING':
          break;
        // READY is watched under either desire: SLEEPING there is an owner's request to sleep.
        case 'READY':
          if (mapping.desiredState === 'DELETED') return { done: 'IDLE' };
          break;
        case 'WAITING_CAPACITY':
          if (mapping.desiredState !== 'RUNNING') return { done: 'IDLE' };
          if (!this.capacityDue(mapping, await this.capacityPool())) return { done: 'WAITING_CAPACITY' };
          break;
        // A failure waits for a retry; only a missing volume is looked for again meanwhile.
        case 'FAILED':
          if ((mapping.lastError as { code?: unknown } | null)?.code !== 'PVC_MISSING') return { done: mapping.desiredState === 'RUNNING' ? 'FAILED' : 'IDLE' };
          break;
        default:
          if (mapping.desiredState !== 'RUNNING') return { done: 'IDLE' };
          if (!(ACTIVE_STATES as readonly string[]).includes(mapping.managementState)) return { done: 'IDLE' };
          if (mapping.nextAttemptAt && mapping.nextAttemptAt > this.now()) return { done: 'BACKOFF' };
      }
    }
    try {
      return await this.drive(mapping, disabled);
    } catch (error) {
      if (error instanceof Superseded) return { done: 'SUPERSEDED' };
      throw error;
    }
  }

  private async drive(mapping: ManagedRunner, ownerDisabled = false): Promise<Step> {
    try {
      if (ownerDisabled) return await this.whileDisabled(mapping);
      switch (mapping.managementState) {
        case 'REQUESTED':
          return await this.requested(mapping);
        case 'WAITING_CAPACITY':
          return await this.admitted(mapping);
        case 'PROVISIONING':
          return await this.provisioning(mapping);
        case 'STARTING':
          return await this.starting(mapping);
        case 'FENCING':
          return (await this.replacePredecessor(mapping)) ?? { done: 'FENCING' };
        case 'DRAINING':
          return await this.draining(mapping);
        case 'SLEEPING':
          return await this.sleeping(mapping);
        case 'FAILED':
          return await this.volumeBack(mapping);
        default:
          return await this.ready(mapping);
      }
    } catch (error) {
      if (error instanceof Superseded) throw error;
      // Each handler below reads the row afresh: the one this step started from may have been
      // advanced by an operation record before the failure.
      const current = await this.reread(mapping.id);
      if (error instanceof ManagedRunnerConflict) {
        this.log.warn(`managed runner ${mapping.id}: ${error.code}: ${error.detail}`);
        return this.fail(current, error.code, error.detail);
      }
      const failure = this.backend.failure(error);
      if (failure?.retryable) {
        if (OBSERVING_STATES.has(current.managementState)) return this.unanswered(current, error);
        return failure.unreachable ? this.unreachable(current, error) : this.backoff(current, error);
      }
      if (failure?.waitForRoom) return this.waitForRoom(current, failure.code, failure.detail);
      if (failure) {
        this.log.warn(`managed runner ${mapping.id}: ${failure.log}`);
        return this.fail(current, failure.code, failure.detail);
      }
      throw error;
    }
  }

  // ── states ─────────────────────────────────────────────────────────────────────────────────

  private async requested(mapping: ManagedRunner): Promise<Step> {
    // An explicit retry with an instance recorded. One still running is waited on again (a retry
    // after a startup timeout); one that stopped is replaced through the single-writer gate.
    if (mapping.podUid) {
      const replaced = await this.replacePredecessor(mapping);
      if (replaced) return replaced;
    }
    // Capacity admission (WAITING_CAPACITY) is decided here, before any resource exists.
    return this.admitted(mapping);
  }

  // ── capacity admission ─────────────────────────────────────────────────────────────────────

  /**
   * The pool as it stands now: the backend's, keyed by its location. Its row is created, or brought
   * to the backend's totals (which a backend may have to ask its host for), on this process's first
   * use; after that only its id is kept, and its figures and revision are read afresh each time —
   * they move with every admission and release, by any replica.
   */
  private async capacityPool(): Promise<CapacityPool> {
    this.pool ??= Promise.resolve()
      .then(() => this.backend.capacityBudget())
      .then((budget) => syncCapacityPool(this.prisma, this.backend.location, budget))
      .then((pool) => pool.id)
      .catch((error: Error) => {
        this.pool = undefined;
        throw error;
      });
    const pool = await readCapacityPool(this.prisma, await this.pool);
    if (!pool) {
      this.pool = undefined;
      throw new Error('the capacity pool row is gone');
    }
    return pool;
  }

  /** A waiting intent looks again at its retry time, or as soon as the pool moved since it was refused. */
  private capacityDue(mapping: ManagedRunner, pool: CapacityPool): boolean {
    if (!mapping.nextAttemptAt || mapping.nextAttemptAt <= this.now()) return true;
    return mapping.capacityRevision === null || mapping.capacityRevision < pool.revision;
  }

  /**
   * Admit the mapping to the environment's budget and move it on to PROVISIONING — or record why it
   * waits. What it already holds is not taken again: a mapping waking from sleep holds its storage
   * and asks for compute alone; one whose generation advanced on a retry holds both. The share and
   * the pool's figures change in one transaction, the pool's by a single conditional UPDATE that
   * takes nothing unless every dimension still fits (managed-runner-capacity.ts).
   */
  private async admitted(mapping: ManagedRunner): Promise<Step> {
    const now = this.now();
    const pool = await this.capacityPool();
    const held = readReservation(mapping.reservation);
    const needStorage = held?.storage ? null : this.backend.storageShare();
    const needCompute = held?.compute ? null : this.backend.computeShare();
    const reservation: ManagedRunnerReservation = {
      version: 1,
      pool: held?.pool ?? pool.id,
      storage: held?.storage ?? { ...needStorage!, reservedAt: now.toISOString() },
      compute: held?.compute ?? { ...needCompute!, reservedAt: now.toISOString(), generation: mapping.generation },
    };
    const onward: Prisma.ManagedRunnerUpdateManyMutationInput = {
      managementState: 'PROVISIONING',
      stateEnteredAt: now,
      startupDeadlineAt: new Date(now.getTime() + this.profile.lifecycle.startupDeadlineSeconds * 1000),
      nextAttemptAt: null,
      capacityRevision: null,
      lastError: this.restartReason(mapping),
    };
    if (!needStorage && !needCompute) return { next: await this.commit(mapping, onward) };
    const taken = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const { count } = await tx.managedRunner.updateMany({
          where: { id: mapping.id, revision: mapping.revision, leaseHolder: this.holder },
          data: { ...onward, reservation: reservation as unknown as Prisma.InputJsonValue, revision: { increment: 1 }, leaseExpiresAt: this.leaseUntil(now) },
        });
        if (count === 0) throw new Superseded();
        // Refused, the transaction is rolled back whole: the mapping is not moved either.
        if (!(await reserveCapacity(tx, reservation.pool, needCompute, needStorage))) throw new CapacityRefused();
        return true;
      },
      loggedRetry(this.log, 'managedRunners.admit'),
    ).catch((error: unknown) => {
      if (error instanceof CapacityRefused) return false;
      throw error;
    });
    if (taken) return { next: await this.reread(mapping.id) };
    // The revision read before the attempt: a release that lands after it moves the pool past it, and
    // the intent looks again at once rather than at its retry time.
    return this.waitForCapacity(mapping, reservation.pool, pool.revision, needCompute, needStorage);
  }

  /** No room: WAITING_CAPACITY with what is short, a retry time and the pool revision it was refused at. */
  private async waitForCapacity(
    mapping: ManagedRunner,
    poolId: string,
    refusedAt: number,
    compute: ComputeAmounts | null,
    storage: StorageAmounts | null,
  ): Promise<Step> {
    const now = this.now();
    const pool = await readCapacityPool(this.prisma, poolId);
    const short = pool ? shortDimensions(pool, compute, storage) : [];
    const detail = short.length ? `short of ${short.join(', ')}` : 'the pool moved while admitting';
    const entering = mapping.managementState !== 'WAITING_CAPACITY';
    if (entering) this.log.warn(`managed runner ${mapping.id}: WAITING_CAPACITY: ${detail}`);
    await this.commit(mapping, {
      managementState: 'WAITING_CAPACITY',
      // The wait is measured, and served, from when it began.
      ...(entering ? { stateEnteredAt: now } : {}),
      lastError: {
        code: MANAGED_RUNNER_CAPACITY_UNAVAILABLE,
        message: capacityShortMessage(short),
        retryable: true,
        detail,
        short,
      },
      nextAttemptAt: new Date(now.getTime() + this.profile.lifecycle.capacityRetrySeconds * 1000),
      capacityRevision: refusedAt,
    });
    return { done: 'WAITING_CAPACITY' };
  }

  private async provisioning(start: ManagedRunner): Promise<Step> {
    const { mapping, volume } = await this.ensureVolume(start);
    if (!mapping.pvcUid) return { next: await this.commit(mapping, { pvcUid: volume.uid, ...this.settled(mapping), ...this.roomMade(mapping) }) };
    if (!volume.boundTo) return this.waitWithin(mapping);

    const backing = await this.backend.readBacking(volume);
    if (!backing) return this.waitWithin(mapping);
    const backingProblem = this.backend.backingProblem(backing, mapping);
    if (backingProblem) throw new ManagedRunnerConflict('PV_CONFLICT', backingProblem);
    if (!mapping.pvUid || !mapping.volumeHandle) {
      return { next: await this.commit(mapping, { pvUid: backing.uid, volumeHandle: backing.handle }) };
    }

    const retired = await this.replaceRetiredCredential(mapping);
    if (retired) return retired;
    const issued = await this.ensureCredential(mapping);
    if (!issued.mapping.podUid) {
      const adopted = await this.adoptCredential(issued.mapping, issued.credential);
      if (adopted) return { next: adopted };
    }
    return {
      next: await this.commit(issued.mapping, {
        managementState: 'STARTING',
        stateEnteredAt: this.now(),
        lastError: this.restartReason(issued.mapping),
        ...this.settled(issued.mapping),
        ...this.roomMade(issued.mapping),
      }),
    };
  }

  private async starting(start: ManagedRunner): Promise<Step> {
    const storage = await this.verifyStorage(start);
    let mapping = start;
    let instance = await this.backend.readInstance(mapping);
    if (!instance && mapping.podUid) {
      // The recorded instance is gone, and nothing proves it stopped writing.
      return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', this.goneUnproven(mapping));
    }
    if (!instance) {
      // The one instance of this generation, created only on a volume nothing else holds (a backup's
      // helper container, an attachment left behind), and only where the backend's single-instance
      // guard is known to refuse any other.
      const holders = await this.backend.volumeHolders(storage);
      if (holders.length > 0) return this.volumeInUse(mapping, holders.join(', '));
      if ((mapping.lastError as { code?: unknown } | null)?.code === 'VOLUME_IN_USE') {
        // Free again: the startup deadline runs from now, and a restart's own reason is back.
        mapping = await this.commit(mapping, {
          lastError: this.restartReason(mapping),
          startupDeadlineAt: new Date(this.now().getTime() + this.profile.lifecycle.startupDeadlineSeconds * 1000),
        });
      }
      await this.backend.requireInstanceGuard(mapping);
      const begun = await this.beginOperation(mapping, 'CREATE_POD');
      try {
        instance = await this.backend.createInstance(begun);
      } catch (error) {
        // Refused for a holder that came after the look above, with nothing made: the same wait.
        if (error instanceof ManagedVolumeHeld) return this.volumeInUse(begun, error.detail, { resourceOperationState: 'COMPLETED' });
        if (error instanceof ManagedInstanceLimit) return this.waitForRoom(begun, 'CONTAINER_LIMIT', error.detail);
        if (error instanceof ManagedFirewallNotEnforced) {
          return this.waitForRoom(begun, 'FIREWALL_NOT_ENFORCED', error.detail, 'once the firewall is in force');
        }
        throw error;
      }
      return { next: await this.recordInstance(begun, instance, this.roomMade(begun)) };
    }
    if (mapping.podUid && instance.uid !== mapping.podUid) {
      return this.fence(mapping, 'POD_REPLACED', this.replacedUnproven(mapping, instance));
    }
    this.checkInstance(mapping, instance);
    if (instance.uid !== mapping.podUid || instance.node !== mapping.nodeName) {
      return { next: await this.recordInstance(mapping, instance) };
    }
    if (instance.terminated) return this.terminated(mapping, instance);
    // A released instance still being removed: wait for it to go, then the gate decides.
    if (instance.removing) return this.waitWithin(mapping);
    const report = instance.running ? await this.reportSince(mapping, mapping.stateEnteredAt) : null;
    if (!report) return this.waitWithin(mapping);
    // READY needs model supply as well as a live instance: a runtime signed in on the runner, or else
    // one of the owner's own model keys a runtime it has installed runs. What it is found ready with —
    // the runtime's name, or the key's slug — is what a default workspace with no history starts on,
    // recorded, never guessed later.
    const [runtime] = managedRuntimeSupply(report);
    const initialProvider = runtime ?? (await managedKeySupply(this.prisma, mapping.ownerId, report));
    if (!initialProvider) return this.withoutSupply(mapping);
    // The attempts it took stay counted until it has stayed up (`stoodUp`): a crash loop that
    // reaches READY each time still ends.
    await this.commit(mapping, {
      managementState: 'READY',
      stateEnteredAt: this.now(),
      nextAttemptAt: null,
      startupDeadlineAt: null,
      lastError: Prisma.DbNull,
      initialProvider,
    });
    return { done: 'READY' };
  }

  private async ready(mapping: ManagedRunner): Promise<Step> {
    await this.verifyStorage(mapping);
    const instance = await this.backend.readInstance(mapping);
    if (!instance) {
      return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', this.goneUnproven(mapping));
    }
    if (instance.uid !== mapping.podUid) {
      return this.fence(mapping, 'POD_REPLACED', this.replacedUnproven(mapping, instance));
    }
    this.checkInstance(mapping, instance);
    if (instance.terminated) return this.terminated(mapping, instance);
    // A stale heartbeat makes READY unusable (the status says so); it is not proof the instance died,
    // and it authorizes nothing.
    return (await this.beginDrain(mapping)) ?? { done: 'READY' };
  }

  // ── sleep and wake ─────────────────────────────────────────────────────────────────────────

  /**
   * What the authorized instance last reported, if it may be believed: it declares it can sleep, it
   * heartbeated recently, and the report is fresh and comes from the generation and instance recorded
   * now. Null otherwise — missing or stale telemetry never lets anything sleep.
   */
  private async instanceReport(mapping: ManagedRunner, now: Date): Promise<StoredManagedWorkload | null> {
    const runner = await this.prisma.runner.findUnique({
      where: { id: mapping.runnerId },
      select: { capabilities: true, lastHeartbeatAt: true, managedWorkload: true },
    });
    if (!runner?.capabilities.includes(MANAGED_RUNNER_SLEEP_CAPABILITY)) return null;
    const freshMs = this.profile.lifecycle.heartbeatFreshSeconds * 1000;
    if (!runner.lastHeartbeatAt || now.getTime() - runner.lastHeartbeatAt.getTime() > freshMs) return null;
    const report = readStoredWorkload(runner.managedWorkload);
    if (!report || report.generation !== mapping.generation || report.podUid !== mapping.podUid) return null;
    const received = Date.parse(report.receivedAt);
    return now.getTime() - received <= freshMs ? report : null;
  }

  /**
   * READY, and asked to sleep — by the owner, or by the idle interval having passed since the
   * runner became READY, since the last demand and by the instance's own count — with nothing in the
   * records and nothing in flight on the instance: drain. Claims stop at once (the claim refuses a
   * draining mapping), and the instance's heartbeats carry the sleep request from now on. The
   * compare-and-set includes the demand revision this decision read, so demand that came meanwhile
   * keeps the runner READY.
   */
  private async beginDrain(mapping: ManagedRunner): Promise<Step | null> {
    const now = this.now();
    const asked = mapping.desiredState === 'SLEEPING';
    const idleMs = this.profile.lifecycle.idleSeconds * 1000;
    const quietSince = Math.max(mapping.stateEnteredAt.getTime(), mapping.lastDemandAt?.getTime() ?? 0);
    if (!asked && now.getTime() - quietSince < idleMs) return null;
    const report = await this.instanceReport(mapping, now);
    if (!report || !workloadIdle(report) || report.draining) return null;
    if (!asked && Date.parse(report.receivedAt) - report.idleSeconds * 1000 > now.getTime() - idleMs) return null;
    if ((await managedRunnerWork(this.prisma, mapping.runnerId)).length > 0) return null;
    const { count } = await this.prisma.managedRunner.updateMany({
      where: {
        id: mapping.id,
        revision: mapping.revision,
        leaseHolder: this.holder,
        managementState: 'READY',
        desiredState: mapping.desiredState,
        demandRevision: mapping.demandRevision,
      },
      data: {
        managementState: 'DRAINING',
        desiredState: 'SLEEPING',
        stateEnteredAt: now,
        drainDemandRevision: mapping.demandRevision,
        stopRequestedAt: now,
        stopAcknowledgedAt: null,
        lastError: Prisma.DbNull,
        revision: { increment: 1 },
        leaseExpiresAt: this.leaseUntil(now),
      },
    });
    if (count === 0) throw new Superseded();
    this.log.warn(`managed runner ${mapping.id}: idle${asked ? ' and asked to sleep' : ''}; draining generation ${mapping.generation} to sleep`);
    return { next: await this.reread(mapping.id) };
  }

  /**
   * DRAINING. Until the instance accepts, the drain is called off — back to READY, claims open
   * again — by demand, by work in the records, by the instance reporting work or no longer reporting,
   * or by the drain budget running out unaccepted; never while the owner's account is disabled. Once
   * it accepts it exits on its own; nothing here stops it, unless it overruns the drain time on a
   * backend whose host reports every stop it makes (`stopOverdue`). Its stop then goes through the
   * single-writer gate's own rules: its host's report of every process stopped is recorded as the
   * stop proof, the instance object is released by UID, and the mapping sleeps only once the object
   * is gone and the volume released. An instance that vanished or was replaced unobserved, or was
   * declared terminal by anything but its host, fences, as anywhere else.
   */
  private async draining(mapping: ManagedRunner, ownerDisabled = false): Promise<Step> {
    const instance = await this.backend.readInstance(mapping);
    const predecessor = this.predecessorOf(mapping);
    if (!instance) {
      const proof = stopProofFor(mapping.fencingReceipt, predecessor);
      if (!proof) return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', this.goneUnproven(mapping));
      const holders = await this.backend.volumeHolders(await this.verifyStorage(mapping));
      if (holders.length > 0) return { done: 'DRAINING' };
      return { next: await this.fallAsleep(mapping, proof) };
    }
    if (instance.uid !== mapping.podUid) {
      return this.fence(mapping, 'POD_REPLACED', this.replacedUnproven(mapping, instance));
    }
    this.checkInstance(mapping, instance);
    await this.verifyStorage(mapping);
    if (instance.terminated) {
      if (!instance.stopConfirmed) {
        return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', this.stopUnconfirmed(instance));
      }
      let current = mapping;
      if (!stopProofFor(mapping.fencingReceipt, predecessor)) {
        current = await this.commit(mapping, { fencingReceipt: this.backend.observedStop(predecessor, instance, this.now()) as unknown as Prisma.InputJsonValue });
      }
      if (instance.removing) return { done: 'DRAINING' };
      // Released by UID: a successor under the same name is never removed.
      const begun = await this.beginOperation(current, 'DELETE_POD');
      await this.backend.removeInstance(mapping);
      return { next: await this.commit(begun, { resourceOperationState: 'COMPLETED' }) };
    }
    const now = this.now();
    if (!mapping.stopAcknowledgedAt) {
      // A disabled owner's drain is never called off: its runner, refused at every door, can neither
      // accept nor be kept, and stops on its own — or, past the drain time, is stopped (`stopOverdue`).
      if (ownerDisabled) {
        await this.stopOverdue(mapping, mapping.stopRequestedAt ?? mapping.stateEnteredAt, now);
        return { done: 'DRAINING' };
      }
      const abort = await this.drainAbort(mapping, now);
      return abort ? this.abortDrain(mapping, abort) : { done: 'DRAINING' };
    }
    // Accepted: it stops by itself. Overdue is said, and forced only where the backend can (`stopOverdue`).
    const overdue = now.getTime() - mapping.stopAcknowledgedAt.getTime() > this.profile.lifecycle.drainSeconds * 1000;
    const said = this.backend.stopInstance ? 'SLEEP_STOP_FORCED' : 'SLEEP_STOP_OVERDUE';
    if (overdue && (mapping.lastError as { code?: unknown } | null)?.code !== said) {
      await this.commit(mapping, { lastError: { ...managedRunnerReason(said), detail: `accepted at ${mapping.stopAcknowledgedAt.toISOString()}` } });
    }
    await this.stopOverdue(mapping, mapping.stopAcknowledgedAt, now);
    return { done: 'DRAINING' };
  }

  /**
   * A drain that is past its drain time since `since` — accepted and not yet stopped, or a disabled
   * owner's runner that has not stopped by itself — is stopped, where the backend's host reports
   * every stop it makes (`stopInstance`: Docker; Kubernetes has none and nothing is forced). Asking
   * is never the proof: the gate still waits for the host's report of the exit, then removes the
   * instance by UID, as for a runner that stopped on its own.
   */
  private async stopOverdue(mapping: ManagedRunner, since: Date, now: Date): Promise<void> {
    if (!this.backend.stopInstance || now.getTime() - since.getTime() <= this.profile.lifecycle.drainSeconds * 1000) return;
    this.log.warn(`managed runner ${mapping.id}: draining past its drain time; asking ${this.backend.terms.instance} ${mapping.podUid} to stop`);
    await this.backend.stopInstance(mapping);
  }

  /** Why an unaccepted drain is called off now, or null to keep waiting for the instance. */
  private async drainAbort(mapping: ManagedRunner, now: Date): Promise<DrainAbort | null> {
    if (mapping.desiredState === 'RUNNING' || mapping.demandRevision !== mapping.drainDemandRevision) return 'DEMAND';
    if ((await managedRunnerWork(this.prisma, mapping.runnerId)).length > 0) return 'WORK';
    const report = await this.instanceReport(mapping, now);
    if (!report) return 'TELEMETRY_MISSING';
    if (!workloadIdle(report)) return 'RUNNER_BUSY';
    const asked = mapping.stopRequestedAt ?? mapping.stateEnteredAt;
    if (now.getTime() - asked.getTime() > this.profile.lifecycle.drainSeconds * 1000) return 'NOT_ACKNOWLEDGED';
    return null;
  }

  /**
   * Back to READY, the runner never having stopped. Only while the instance has not accepted: that
   * acceptance is the other conditional write on this column, so exactly one of the two lands.
   */
  private async abortDrain(mapping: ManagedRunner, why: DrainAbort): Promise<Step> {
    const now = this.now();
    const { count } = await this.prisma.managedRunner.updateMany({
      where: { id: mapping.id, revision: mapping.revision, leaseHolder: this.holder, managementState: 'DRAINING', stopAcknowledgedAt: null },
      data: {
        managementState: 'READY',
        // Demand wants it running; anything else ends this attempt, and the idle interval starts over.
        desiredState: 'RUNNING',
        stateEnteredAt: now,
        drainDemandRevision: null,
        stopRequestedAt: null,
        revision: { increment: 1 },
        leaseExpiresAt: this.leaseUntil(now),
      },
    });
    if (count === 0) throw new Superseded();
    this.log.warn(`managed runner ${mapping.id}: drain to sleep called off (${why}); READY again`);
    return { done: 'READY' };
  }

  /**
   * The drained instance is proven stopped, its object gone and its volume released: generation N is
   * retired on that proof and N+1 reserved, exactly as the single-writer gate advances (its credential
   * replaced by one nobody holds), and in the same transaction its compute share goes back to the
   * pool. The storage share, the data volume, the runner row and the workspace stay. SLEEPING — and if
   * demand came while it drained, the next step wakes it at once with that demand.
   */
  private async fallAsleep(mapping: ManagedRunner, proof: ManagedRunnerStopProof): Promise<ManagedRunner> {
    const now = this.now();
    const held = readReservation(mapping.reservation);
    const compute = computeOf(held);
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const { count } = await tx.managedRunner.updateMany({
          where: { id: mapping.id, revision: mapping.revision, leaseHolder: this.holder, generation: mapping.generation, podUid: mapping.podUid, managementState: 'DRAINING' },
          data: {
            generation: { increment: 1 },
            podName: null,
            podUid: null,
            nodeName: null,
            nodeUid: null,
            fencingReceipt: { ...proof, retiredAt: now.toISOString() } as unknown as Prisma.InputJsonValue,
            managementState: 'SLEEPING',
            stateEnteredAt: now,
            attempt: 0,
            nextAttemptAt: null,
            startupDeadlineAt: null,
            lastError: Prisma.DbNull,
            drainDemandRevision: null,
            stopRequestedAt: null,
            stopAcknowledgedAt: null,
            ...(held ? { reservation: { ...held, compute: null } as unknown as Prisma.InputJsonValue } : {}),
            ...this.settled(mapping),
            revision: { increment: 1 },
            leaseExpiresAt: this.leaseUntil(now),
          },
        });
        if (count === 0) throw new Superseded();
        await tx.runner.update({ where: { id: mapping.runnerId }, data: { tokenHash: sha256(generateToken(32)) } });
        if (held && compute) await releaseCapacity(tx, held.pool, compute, null);
      },
      loggedRetry(this.log, 'managedRunners.fallAsleep'),
    );
    this.log.warn(`managed runner ${mapping.id}: asleep; generation ${mapping.generation} stopped (${proof.kind}), compute released, volume kept`);
    return this.reread(mapping.id);
  }

  /** SLEEPING: woken by demand (RUNNING desired), back through admission with the same volume and runner. */
  private async sleeping(mapping: ManagedRunner): Promise<Step> {
    if (mapping.desiredState !== 'RUNNING') return { done: 'SLEEPING' };
    const now = this.now();
    this.log.warn(`managed runner ${mapping.id}: waking for demand (generation ${mapping.generation})`);
    return {
      next: await this.commit(mapping, {
        managementState: 'REQUESTED',
        stateEnteredAt: now,
        attempt: 0,
        nextAttemptAt: null,
        startupDeadlineAt: null,
        lastError: Prisma.DbNull,
      }),
    };
  }

  // ── a disabled owner ───────────────────────────────────────────────────────────────────────

  /**
   * A step for a mapping whose owner an administrator disabled (`User.disabledAt`, docs/google-sign-in-
   * design.md §5.5). Its runner is refused at every door — a claim answered 403 ACCOUNT_DISABLED is a
   * permanent failure to the runner, which stops claiming, drains and exits on its own — and the
   * mapping is driven to sleep, never towards READY: no volume, credential or instance is created and
   * nothing is admitted.
   *
   *   - An instance, recorded or found under its name, drains: the drain a sleep takes, except that it
   *     is never called off and waits for no idle report. It ends as a sleep ends: its host's report of
   *     the stop is recorded as the proof, the instance object is removed by UID, and only once it is
   *     gone and the volume released is the generation retired and compute given back (`draining`,
   *     `fallAsleep`). An instance gone or declared terminal without that report fences, as anywhere.
   *   - Without one: SLEEPING at once, compute it holds given back — unless an instance create may
   *     still commit, which keeps the share and the mapping where they are until an instance is seen.
   *   - Asleep, it stays asleep: a wake desired before the account was disabled is dropped.
   *   - FENCING still waits for its proof; once it is proven, the next step puts the mapping to sleep.
   *
   * The data volume with its storage share, the runner row and the default workspace stay. Enabled
   * again, it is an ordinary sleeping mapping: demand wakes it on the same volume and runner.
   */
  private async whileDisabled(mapping: ManagedRunner): Promise<Step> {
    switch (mapping.managementState) {
      case 'DRAINING':
        return this.draining(mapping, true);
      case 'SLEEPING':
        if (mapping.desiredState === 'RUNNING') await this.commit(mapping, { desiredState: 'SLEEPING' });
        return { done: 'SLEEPING' };
      case 'FENCING':
        return (await this.replacePredecessor(mapping)) ?? { done: 'FENCING' };
      default:
        return this.stopForDisabledOwner(mapping);
    }
  }

  /** REQUESTED, WAITING_CAPACITY, PROVISIONING, STARTING or READY, for a disabled owner (see `whileDisabled`). */
  private async stopForDisabledOwner(mapping: ManagedRunner): Promise<Step> {
    if (!mapping.podUid && mapping.pvcUid) {
      // An instance created and never recorded — a create whose answer was lost — is found under its name.
      const instance = await this.backend.readInstance(mapping);
      if (instance) return { next: await this.recordInstance(mapping, instance) };
      if (mapping.resourceOperationKind === 'CREATE_POD' && mapping.resourceOperationState === 'PENDING') return { done: 'WAITING' };
    }
    const now = this.now();
    const stopped = { attempt: 0, nextAttemptAt: null, startupDeadlineAt: null, capacityRevision: null, lastError: Prisma.DbNull };
    if (mapping.podUid) {
      this.log.warn(`managed runner ${mapping.id}: its owner's account is disabled; draining generation ${mapping.generation} to sleep`);
      return {
        next: await this.commit(mapping, {
          managementState: 'DRAINING',
          desiredState: 'SLEEPING',
          stateEnteredAt: now,
          drainDemandRevision: mapping.demandRevision,
          stopRequestedAt: now,
          stopAcknowledgedAt: null,
          ...stopped,
        }),
      };
    }
    this.log.warn(`managed runner ${mapping.id}: its owner's account is disabled; asleep from ${mapping.managementState}, nothing having started`);
    await this.commitReleasingCompute(mapping, { managementState: 'SLEEPING', desiredState: 'SLEEPING', stateEnteredAt: now, ...stopped });
    return { done: 'SLEEPING' };
  }

  // ── the single-writer gate ─────────────────────────────────────────────────────────────────

  /** The recorded instance, as a proof has to name it. */
  private predecessorOf(mapping: ManagedRunner): ManagedRunnerPredecessor {
    return {
      runnerId: mapping.runnerId,
      generation: mapping.generation,
      podName: mapping.podName ?? this.backend.names(mapping.runnerId).instance,
      podUid: mapping.podUid!,
      nodeName: mapping.nodeName,
      pvcUid: mapping.pvcUid!,
      volumeHandle: mapping.volumeHandle!,
    };
  }

  /** The operator details of the gate's findings, in the backend's words. */
  private goneUnproven(mapping: ManagedRunner): string {
    return `${this.backend.terms.instance} ${mapping.podUid} of generation ${mapping.generation} is gone without a stop proof`;
  }

  private replacedUnproven(mapping: ManagedRunner, instance: ManagedInstance): string {
    return `${this.backend.terms.instance} ${mapping.podUid} was replaced by ${instance.uid} without a stop proof`;
  }

  private stopUnconfirmed(instance: ManagedInstance): string {
    return `${this.backend.terms.instance} ${instance.uid} is ${instance.phase}, but not by ${this.backend.terms.stopReport}`;
  }

  /**
   * The recorded instance of a STARTING or READY mapping is terminal, unasked: a crash, the memory
   * limit, its host or Docker restarting. One declared terminal by anything but its host proves
   * nothing about the host: FENCING. With its host's report of the stop, that report is recorded as
   * the stop proof and:
   *
   *   - wanted running, it is started again by itself. The mapping goes back to REQUESTED with the
   *     stopped instance recorded — what an owner's retry writes — and after the backoff of its
   *     attempt the single-writer gate removes that instance by UID, waits for its volume to be
   *     released and starts the next generation on the same volume and runner. Each stop spends an
   *     attempt, as a failed try on the way up does, unless the runner had stayed READY for twice the
   *     longest backoff (`stoodUp`); the stop that spends the last one leaves it FAILED, retryable,
   *     so a crash loop ends there. Compute stays reserved throughout, as for a retry.
   *   - asked to sleep by its owner, it goes to sleep: the drain's end (`draining`) releases it.
   *
   * Every such stop is logged with its exit code and whether it ran out of memory, and the owner's
   * reason says which, while it restarts and once it has failed.
   */
  private async terminated(mapping: ManagedRunner, instance: ManagedInstance): Promise<Step> {
    if (!instance.stopConfirmed) {
      return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', this.stopUnconfirmed(instance));
    }
    const now = this.now();
    const proof = stopProofFor(mapping.fencingReceipt, this.predecessorOf(mapping)) ?? this.backend.observedStop(this.predecessorOf(mapping), instance, now);
    const recorded = { fencingReceipt: proof as unknown as Prisma.InputJsonValue };
    const detail = `${this.backend.terms.instance} ${instance.uid} is ${instance.phase}`;
    const outOfMemory = instance.exit?.outOfMemory === true;
    const stopped = `managed runner ${mapping.id}: POD_TERMINATED: ${this.backend.terms.instance} ${instance.uid} of generation ${mapping.generation} `
      + `stopped in ${mapping.managementState} with exit code ${instance.exit?.code ?? 'unknown'}, ${outOfMemory ? 'out of memory' : 'not out of memory'}`;
    if (mapping.desiredState !== 'RUNNING') {
      this.log.warn(`${stopped}; its owner asked it to sleep, so it goes to sleep`);
      return {
        next: await this.commit(mapping, { ...recorded, managementState: 'DRAINING', stateEnteredAt: now, drainDemandRevision: mapping.demandRevision, lastError: Prisma.DbNull }),
      };
    }
    const { maxAttempts } = this.profile.lifecycle;
    const attempt = (this.stoodUp(mapping) ? 0 : mapping.attempt) + 1;
    if (attempt >= maxAttempts) {
      this.log.warn(`${stopped}; FAILED: attempt ${attempt} of ${maxAttempts} in a row`);
      return this.fail(mapping, outOfMemory ? 'POD_OUT_OF_MEMORY' : 'POD_TERMINATED', detail, { ...recorded, attempt });
    }
    const delayMs = this.backoffDelay(attempt);
    this.log.warn(`${stopped}; starting generation ${mapping.generation + 1} on the same volume in ${Math.ceil(delayMs / 1000)} s (attempt ${attempt} of ${maxAttempts})`);
    await this.commit(mapping, {
      ...recorded,
      managementState: 'REQUESTED',
      stateEnteredAt: now,
      attempt,
      nextAttemptAt: new Date(now.getTime() + delayMs),
      startupDeadlineAt: null,
      lastError: { ...managedRunnerReason(outOfMemory ? 'POD_RESTARTING_OUT_OF_MEMORY' : 'POD_RESTARTING'), detail },
    });
    return { done: 'BACKOFF' };
  }

  /**
   * READY for at least twice the longest backoff: what it took to get there no longer counts against
   * its next stop, as the kubelet starts a crash loop's backoff again after twice its ceiling.
   */
  private stoodUp(mapping: ManagedRunner): boolean {
    return mapping.managementState === 'READY'
      && this.now().getTime() - mapping.stateEnteredAt.getTime() >= 2 * this.profile.lifecycle.backoffMaxSeconds * 1000;
  }

  /**
   * The reason an automatic restart stands under until the runner is READY: the stored reason itself,
   * or the one a wait on the restart's way carries (`waitReason`), so that the restart's reason comes
   * back when the wait ends. A start nobody restarted — a wake, an owner's retry — has none.
   */
  private restartReason(mapping: ManagedRunner): Prisma.InputJsonValue | typeof Prisma.DbNull {
    const stored = mapping.lastError as { restart?: unknown } | null;
    if (restartingReason(stored)) return stored as Prisma.InputJsonValue;
    return restartingReason(stored?.restart) ? (stored!.restart as Prisma.InputJsonValue) : Prisma.DbNull;
  }

  /**
   * The reason for a wait that ends by itself while the runner is being started: its volume still
   * detaching or held by something else, the environment's cap on what it holds, a transient error.
   * The owner reads it while it lasts. On an automatic restart's way it also carries the restart's own
   * reason (`restart`, which no client is shown), and `restartReason` gives that back once the wait is
   * over. Kept in the reason itself, it goes wherever the reason goes: READY, a failure, a fence or a
   * sleep replaces it, restart and all.
   */
  private waitReason(mapping: ManagedRunner, code: string, detail?: string): Prisma.InputJsonValue {
    const restart = this.restartReason(mapping);
    return {
      ...managedRunnerReason(code),
      ...(detail === undefined ? {} : { detail }),
      ...(restart === Prisma.DbNull ? {} : { restart: restart as Prisma.InputJsonValue }),
    };
  }

  /**
   * Retire the recorded instance (`mapping.podUid`, generation N) and advance to generation N+1, if
   * and only if it is proven stopped (see the class comment). Answers null when there is nothing to
   * do because the instance is still running and the mapping is not fencing — a retry waits on it.
   */
  private async replacePredecessor(mapping: ManagedRunner): Promise<Step | null> {
    const predecessor = this.predecessorOf(mapping);
    const instance = await this.backend.readInstance(mapping);
    if (instance && instance.uid !== mapping.podUid) {
      return this.fence(mapping, 'POD_REPLACED', this.replacedUnproven(mapping, instance));
    }
    let proof = stopProofFor(mapping.fencingReceipt, predecessor);
    if (instance) {
      if (instance.stopConfirmed) {
        let current = mapping;
        if (!proof) current = await this.commit(mapping, { fencingReceipt: this.backend.observedStop(predecessor, instance, this.now()) as unknown as Prisma.InputJsonValue });
        if (instance.removing) return { done: 'WAITING' };
        // Released by UID: a successor under the same name is never removed.
        const begun = await this.beginOperation(current, 'DELETE_POD');
        await this.backend.removeInstance(mapping);
        return { next: await this.commit(begun, { resourceOperationState: 'COMPLETED' }) };
      }
      if (instance.terminated) {
        return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', this.stopUnconfirmed(instance));
      }
      // Still there and not stopped: a retry waits on it; a fencing mapping waits for its removal.
      return mapping.managementState === 'FENCING' ? { done: 'FENCING' } : null;
    }
    // The instance object is gone.
    const storage = await this.verifyStorage(mapping);
    if (!proof) {
      if (mapping.managementState !== 'FENCING') {
        return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', this.goneUnproven(mapping));
      }
      const received = await this.receivedFencing(mapping, predecessor, storage.backing);
      if (!received) return { done: 'FENCING' };
      proof = received.proof;
      mapping = received.mapping;
    }
    const holders = await this.backend.volumeHolders(storage);
    if (holders.length > 0) {
      if ((mapping.lastError as { code?: unknown } | null)?.code !== 'VOLUME_STILL_ATTACHED') {
        await this.commit(mapping, { lastError: this.waitReason(mapping, 'VOLUME_STILL_ATTACHED', holders.join(', ')) });
      }
      return { done: mapping.managementState === 'FENCING' ? 'FENCING' : 'WAITING' };
    }
    return { next: await this.advance(mapping, proof) };
  }

  /**
   * A fencing receipt for this predecessor, read where the backend has an operator leave it and
   * recorded once accepted. An unacceptable one is reported on the mapping (what was wrong goes to the
   * log) and changes nothing.
   */
  private async receivedFencing(
    mapping: ManagedRunner,
    predecessor: ManagedRunnerPredecessor,
    backing: ManagedVolumeBacking,
  ): Promise<{ mapping: ManagedRunner; proof: ManagedRunnerStopProof } | null> {
    const receipt = await this.backend.readFencingReceipt(mapping, predecessor, backing, this.now());
    if (!receipt) return null;
    const { verdict } = receipt;
    if (!verdict.ok) {
      const detail = verdict.problems.join('; ');
      const stored = mapping.lastError as { code?: unknown; detail?: unknown } | null;
      if (stored?.code !== 'FENCING_RECEIPT_INVALID' || stored.detail !== detail) {
        this.log.warn(`managed runner ${mapping.id}: fencing receipt ${receipt.source} not accepted: ${detail}`);
        await this.commit(mapping, { lastError: { ...managedRunnerReason('FENCING_RECEIPT_INVALID'), detail } });
      }
      return null;
    }
    const current = await this.commit(mapping, { fencingReceipt: verdict.proof as unknown as Prisma.InputJsonValue });
    return { mapping: current, proof: verdict.proof };
  }

  /**
   * FENCING: no instance of this mapping is authorized until a stop is proven. In the same
   * transaction the runner credential the predecessor holds is replaced by one nobody holds, so the
   * predecessor's requests fail from now on whatever state the mapping later passes through; the
   * next generation's credential arrives with its own bootstrap credential. The disk, the bootstrap
   * credential and the instance object stay where they are.
   */
  private async fence(mapping: ManagedRunner, code: string, detail: string): Promise<Step> {
    if (mapping.managementState === 'FENCING') {
      if ((mapping.lastError as { code?: unknown } | null)?.code !== code) {
        await this.commit(mapping, { lastError: { ...managedRunnerReason(code), detail } });
      }
      return { done: 'FENCING' };
    }
    this.log.warn(`managed runner ${mapping.id}: FENCING: ${code}: ${detail}`);
    const now = this.now();
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const { count } = await tx.managedRunner.updateMany({
          where: { id: mapping.id, revision: mapping.revision, leaseHolder: this.holder },
          data: {
            managementState: 'FENCING',
            stateEnteredAt: now,
            nextAttemptAt: null,
            startupDeadlineAt: null,
            lastError: { ...managedRunnerReason(code), detail },
            revision: { increment: 1 },
            leaseExpiresAt: this.leaseUntil(now),
          },
        });
        if (count === 0) throw new Superseded();
        await tx.runner.update({ where: { id: mapping.runnerId }, data: { tokenHash: sha256(generateToken(32)) } });
      },
      loggedRetry(this.log, 'managedRunners.fence'),
    );
    return { done: 'FENCING' };
  }

  /**
   * The gate opens: generation N is retired on `proof`, and N+1 is reserved in the same
   * compare-and-set — no instance recorded, REQUESTED. A retry, an owner's or the manager's own
   * after a stop (`terminated`), carries its attempts and reason over; a fencing receipt starts a
   * fresh budget. The retired credential is replaced by one nobody holds; N+1's is issued with its
   * own bootstrap credential once N's is removed.
   */
  private async advance(mapping: ManagedRunner, proof: ManagedRunnerStopProof): Promise<ManagedRunner> {
    const now = this.now();
    const retried = mapping.managementState === 'REQUESTED';
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const { count } = await tx.managedRunner.updateMany({
          where: { id: mapping.id, revision: mapping.revision, leaseHolder: this.holder, generation: mapping.generation, podUid: mapping.podUid },
          data: {
            generation: { increment: 1 },
            podName: null,
            podUid: null,
            nodeName: null,
            nodeUid: null,
            fencingReceipt: { ...proof, retiredAt: now.toISOString() } as unknown as Prisma.InputJsonValue,
            managementState: 'REQUESTED',
            stateEnteredAt: now,
            attempt: retried ? mapping.attempt : 0,
            nextAttemptAt: null,
            startupDeadlineAt: null,
            lastError: this.restartReason(mapping),
            ...this.settled(mapping),
            revision: { increment: 1 },
            leaseExpiresAt: this.leaseUntil(now),
          },
        });
        if (count === 0) throw new Superseded();
        await tx.runner.update({ where: { id: mapping.runnerId }, data: { tokenHash: sha256(generateToken(32)) } });
      },
      loggedRetry(this.log, 'managedRunners.advanceGeneration'),
    );
    this.log.warn(`managed runner ${mapping.id}: generation ${mapping.generation} retired (${proof.kind}); generation ${mapping.generation + 1} reserved`);
    return this.reread(mapping.id);
  }

  /**
   * The bootstrap credential of a generation the gate retired: removed, by UID, before this
   * generation's is issued under the same name. It stopped working when the generation advanced.
   */
  private async replaceRetiredCredential(mapping: ManagedRunner): Promise<Step | null> {
    if (mapping.podUid) return null;
    const credential = await this.backend.readCredential(mapping);
    if (!credential || credential.generation === null || credential.generation >= mapping.generation) return null;
    // Not this runner's: ensureCredential reports the conflict.
    if (credential.ownerId !== mapping.ownerId || credential.runnerId !== mapping.runnerId) return null;
    if (credential.removing) return this.waitWithin(mapping);
    const begun = await this.beginOperation(mapping, 'DELETE_SECRET');
    await this.backend.removeCredential(mapping, credential);
    return { next: await this.commit(begun, { resourceOperationState: 'COMPLETED' }) };
  }

  // ── an administrator's switch to a restored volume ─────────────────────────────────────────

  /**
   * Switch the mapping's data volume to the restored one an administrator verified (managed-runner-volume-switch.ts;
   * docs/managed-runner-kubernetes-operations.md, "Put a restored volume back under its runner"). A volume under the
   * runner's name with another identity is a conflict the manager never resolves by itself; this is an operator's
   * review of it, made explicit and recorded.
   *
   * Under the mapping's lease, with a holder of its own, so that no pass of this replica or another runs beside it.
   * Each check below refuses the switch (ManagedVolumeSwitchRefused) with nothing written:
   *
   *   - the mapping's state (`volumeSwitchStateProblem`) and the revision the administrator read; a stopped instance
   *     it still records only with the stop proof the gate itself would need (`stopProofFor`);
   *   - the volume under the runner's name (`readReplacement`): the one the administrator verified and not the
   *     recorded one, bound, with the marks every pass checks the mapping's volume for, its storage made for it;
   *   - no other mapping records it, its storage or its handle;
   *   - nothing holds it, no instance of the runner exists, and nothing holds the recorded volume
   *     (`recordedVolumeHolders`);
   *   - the single-instance guard is in force for it: the runner's template on it, under another name, is refused.
   *
   * Then one transaction records the new volume, its storage and its handle, and leaves the mapping SLEEPING. A
   * stopped instance it still recorded is retired on its proof there, as a sleep retires one: the generation
   * advances, the credential nobody may hold any more is replaced and its compute is given back. One `activity` row
   * records who switched which mapping, when, from which volume to which. The runner row, workspace, storage share
   * and desired state stay: the next wake starts the reserved generation on the new volume through the usual gate,
   * at once if demand is waiting.
   */
  async switchVolume(request: ManagedVolumeSwitchRequest): Promise<ManagedVolumeSwitchOutcome> {
    if (!this.backend.readReplacement || !this.backend.recordedVolumeHolders) {
      throw new ManagedVolumeSwitchRefused('NOT_APPLICABLE', `the ${this.backend.name} backend has no volume switch`);
    }
    // The same request again, already applied: answered as it stands, from a read. Its switch kicked the manager, whose
    // pass may hold the lease right now; a retry of an answer that was lost must not be refused for that.
    const current = await this.prisma.managedRunner.findUnique({ where: { id: request.mappingId } });
    if (current && current.lastRequestKey === request.idempotencyKey && current.pvcUid === request.volumeUid) {
      return { replayed: true, mapping: current, from: null, to: recordedVolume(current)!, at: null };
    }
    const holder = `${this.holder}/volume-switch/${randomUUID()}`;
    const leased = await this.acquireLease(request.mappingId, holder);
    if (!leased) {
      const found = await this.prisma.managedRunner.findUnique({ where: { id: request.mappingId }, select: { backend: true } });
      if (found && found.backend !== this.backend.name) {
        throw new ManagedVolumeSwitchRefused('NOT_APPLICABLE', `the mapping is a ${found.backend} one, and this server runs ${this.backend.name}`);
      }
      throw new ManagedVolumeSwitchRefused('MAPPING_BUSY', found ? "another manager pass holds the mapping's lease" : 'the mapping is gone');
    }
    try {
      return await this.switchLeased(leased, request, holder);
    } catch (error) {
      if (error instanceof ManagedVolumeSwitchRefused || error instanceof ManagedVolumeSwitchRevisionMoved) throw error;
      const failure = this.backend.failure(error);
      if (failure) throw new ManagedVolumeSwitchRefused('BACKEND_UNAVAILABLE', failure.retryable ? (error as Error).message : failure.log);
      throw error;
    } finally {
      await this.releaseLease(request.mappingId, holder).catch((error: Error) =>
        this.log.warn(`managed runner ${request.mappingId}: switch lease not released (it expires on its own): ${error.message}`),
      );
    }
  }

  private async switchLeased(mapping: ManagedRunner, request: ManagedVolumeSwitchRequest, holder: string): Promise<ManagedVolumeSwitchOutcome> {
    const refuse = (check: VolumeSwitchCheck, detail: string) => new ManagedVolumeSwitchRefused(check, detail);
    // Applied by another request with this key between the read in `switchVolume` and the lease.
    if (mapping.lastRequestKey === request.idempotencyKey && mapping.pvcUid === request.volumeUid) {
      return { replayed: true, mapping, from: null, to: recordedVolume(mapping)!, at: null };
    }
    if (mapping.revision !== request.revision) throw new ManagedVolumeSwitchRevisionMoved(mapping.revision);
    const state = volumeSwitchStateProblem(mapping, request.confirmReplacement);
    if (state) throw refuse(state.check, state.detail);
    const { terms } = this.backend;
    // A stopped instance still recorded (FAILED after it stopped): only on the proof the gate would need.
    const proof = mapping.podUid ? stopProofFor(mapping.fencingReceipt, this.predecessorOf(mapping)) : null;
    if (mapping.podUid && !proof) {
      throw refuse('RECORDED_VOLUME_IN_USE', `nothing proves ${terms.instance} ${mapping.podUid} of generation ${mapping.generation} stopped`);
    }

    const found = await this.backend.readReplacement!(mapping);
    const name = `${terms.volume} ${mapping.pvcName}`;
    if (!found) throw refuse('VOLUME_NOT_FOUND', `no ${name} in ${mapping.namespace}`);
    const { volume, backing } = found;
    if (volume.uid === mapping.pvcUid) throw refuse('VOLUME_ALREADY_RECORDED', `${name} is ${volume.uid}, the recorded one`);
    if (volume.uid !== request.volumeUid) throw refuse('VOLUME_NOT_VERIFIED', `${name} is ${volume.uid}, not ${request.volumeUid}`);
    if (found.removing) throw refuse('VOLUME_NOT_FOUND', `${name} (${volume.uid}) is being deleted`);
    if (!volume.boundTo || !backing) {
      throw refuse('VOLUME_NOT_BOUND', volume.boundTo ? `${terms.backing} ${volume.boundTo} of ${name} cannot be read` : `${name} is not bound`);
    }
    if (found.problem) throw refuse('VOLUME_NOT_THIS_RUNNERS', found.problem);
    const elsewhere = await this.prisma.managedRunner.findFirst({
      where: { id: { not: mapping.id }, OR: [{ pvcUid: volume.uid }, { pvUid: backing.uid }, { volumeHandle: backing.handle }] },
      select: { id: true },
    });
    if (elsewhere) {
      throw refuse('VOLUME_OF_ANOTHER_ACCOUNT', `another managed runner's mapping records ${name} (${volume.uid}), its ${terms.backing} ${volume.boundTo} or its handle`);
    }
    if (found.foreign) throw refuse('VOLUME_OF_ANOTHER_ACCOUNT', found.foreign);
    const holders = await this.backend.volumeHolders({ volume, backing });
    if (holders.length > 0) throw refuse('VOLUME_IN_USE', `${name} (${volume.uid}) is held by ${holders.join(', ')}`);
    const instance = await this.backend.readInstance(mapping);
    if (instance) throw refuse('RECORDED_VOLUME_IN_USE', `${terms.instance} ${instance.name} (${instance.uid}) still exists`);
    const recordedHolders = await this.backend.recordedVolumeHolders!(mapping, found);
    if (recordedHolders.length > 0) {
      throw refuse('RECORDED_VOLUME_IN_USE', `the recorded ${terms.backing} ${mapping.pvUid} (${mapping.volumeHandle}) is held by ${recordedHolders.join(', ')}`);
    }
    try {
      await this.backend.requireInstanceGuard({ ...mapping, pvcUid: volume.uid });
    } catch (error) {
      if (error instanceof ManagedRunnerConflict) throw refuse('ADMISSION_GUARD_MISSING', `${error.code}: ${error.detail}`);
      throw error;
    }
    return this.commitSwitch(mapping, request, holder, { volume, backing }, proof);
  }

  /**
   * The switch, in one transaction: the mapping by a compare-and-set on what the checks read (revision, the switch's
   * lease, state, generation and recorded instance), the runner's credential when a stopped instance is retired,
   * the pool's compute share when one is still held, and the audit row.
   */
  private async commitSwitch(
    mapping: ManagedRunner,
    request: ManagedVolumeSwitchRequest,
    holder: string,
    to: VerifiedVolume,
    proof: ManagedRunnerStopProof | null,
  ): Promise<ManagedVolumeSwitchOutcome> {
    const now = this.now();
    const held = readReservation(mapping.reservation);
    const compute = computeOf(held);
    const from = recordedVolume(mapping)!;
    const target: SwitchedVolume = { pvcName: mapping.pvcName, pvcUid: to.volume.uid, pvName: to.volume.boundTo!, pvUid: to.backing.uid, volumeHandle: to.backing.handle };
    const retired = mapping.podUid ? { generation: mapping.generation, podUid: mapping.podUid, proof: proof!.kind } : null;
    const payload = {
      mappingId: mapping.id,
      ownerId: mapping.ownerId,
      runnerId: mapping.runnerId,
      backend: mapping.backend,
      clusterKey: mapping.clusterKey,
      namespace: mapping.namespace,
      generation: mapping.generation,
      before: {
        managementState: mapping.managementState,
        desiredState: mapping.desiredState,
        code: (mapping.lastError as { code?: string } | null)?.code ?? null,
      },
      from,
      to: target,
      retired,
      confirmedReplacement: request.confirmReplacement,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
    };
    try {
      await withTransactionRetry(
        this.prisma,
        async (tx) => {
          const { count } = await tx.managedRunner.updateMany({
            where: {
              id: mapping.id,
              revision: mapping.revision,
              leaseHolder: holder,
              managementState: mapping.managementState,
              generation: mapping.generation,
              podUid: mapping.podUid,
            },
            data: {
              pvcUid: target.pvcUid,
              pvUid: target.pvUid,
              volumeHandle: target.volumeHandle,
              ...(retired
                ? {
                  generation: { increment: 1 },
                  podName: null,
                  podUid: null,
                  nodeName: null,
                  nodeUid: null,
                  fencingReceipt: { ...proof!, retiredAt: now.toISOString() } as unknown as Prisma.InputJsonValue,
                }
                : {}),
              managementState: 'SLEEPING',
              stateEnteredAt: now,
              attempt: 0,
              nextAttemptAt: null,
              startupDeadlineAt: null,
              capacityRevision: null,
              lastError: Prisma.DbNull,
              drainDemandRevision: null,
              stopRequestedAt: null,
              stopAcknowledgedAt: null,
              ...(held && compute ? { reservation: { ...held, compute: null } as unknown as Prisma.InputJsonValue } : {}),
              lastRequestKey: request.idempotencyKey,
              revision: { increment: 1 },
              leaseExpiresAt: this.leaseUntil(now),
            },
          });
          if (count === 0) throw new Superseded();
          if (retired) await tx.runner.update({ where: { id: mapping.runnerId }, data: { tokenHash: sha256(generateToken(32)) } });
          if (held && compute) await releaseCapacity(tx, held.pool, compute, null);
          await tx.activity.create({
            data: {
              actorId: request.actorId,
              type: MANAGED_RUNNER_VOLUME_SWITCHED_ACTIVITY,
              payload: payload as unknown as Prisma.InputJsonValue,
              credentialKind: 'LOGIN',
              createdAt: now,
            },
          });
        },
        loggedRetry(this.log, 'managedRunners.switchVolume'),
      );
    } catch (error) {
      if (error instanceof Superseded) throw new ManagedVolumeSwitchRevisionMoved((await this.reread(mapping.id)).revision);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ManagedVolumeSwitchRefused('VOLUME_OF_ANOTHER_ACCOUNT', `another mapping recorded ${this.backend.terms.volume} ${target.pvcUid} or its handle meanwhile`);
      }
      throw error;
    }
    this.log.warn(
      `managed runner ${mapping.id}: data volume switched by administrator ${request.actorId} from ${this.backend.terms.volume} ${from.pvcUid} `
        + `(${from.volumeHandle}) to ${target.pvcUid} (${target.volumeHandle})`
        + `${retired ? `; generation ${retired.generation} retired (${retired.proof})` : ''}; asleep, generation ${mapping.generation + (retired ? 1 : 0)} reserved`,
    );
    return { replayed: false, mapping: await this.reread(mapping.id), from, to: target, at: now };
  }

  // ── resources ──────────────────────────────────────────────────────────────────────────────

  /** The mapping's data volume: created once, adopted by identity, never recreated once its UID is recorded. */
  private async ensureVolume(mapping: ManagedRunner): Promise<{ mapping: ManagedRunner; volume: ManagedVolume }> {
    let current = mapping;
    let volume = await this.backend.readVolume(mapping);
    if (!volume) {
      if (mapping.pvcUid) throw new ManagedRunnerConflict('PVC_MISSING', `${this.backend.terms.volume} ${mapping.pvcName} (${mapping.pvcUid}) is gone`);
      current = await this.beginOperation(mapping, 'CREATE_PVC');
      volume = await this.backend.createVolume(current);
    }
    const problem = this.backend.volumeProblem(volume, current);
    if (problem) throw new ManagedRunnerConflict('PVC_CONFLICT', problem);
    return { mapping: current, volume };
  }

  /** The recorded volume and its storage, unchanged: checked on every pass once the instance is being started. */
  private async verifyStorage(mapping: ManagedRunner): Promise<VerifiedVolume> {
    const { terms } = this.backend;
    const volume = await this.backend.readVolume(mapping);
    if (!volume) throw new ManagedRunnerConflict('PVC_MISSING', `${terms.volume} ${mapping.pvcName} (${mapping.pvcUid}) is gone`);
    const problem = this.backend.volumeProblem(volume, mapping);
    if (problem) throw new ManagedRunnerConflict('PVC_CONFLICT', problem);
    if (!volume.boundTo) throw new ManagedRunnerConflict('PVC_CONFLICT', `the recorded ${terms.volume} is no longer bound`);
    const backing = await this.backend.readBacking(volume);
    if (!backing) throw new ManagedRunnerConflict('PV_CONFLICT', `${terms.backing} ${volume.boundTo} is gone`);
    const backingProblem = this.backend.backingProblem(backing, mapping);
    if (backingProblem) throw new ManagedRunnerConflict('PV_CONFLICT', backingProblem);
    return { volume, backing };
  }

  /**
   * FAILED with PVC_MISSING: the recorded volume is looked for again, by name. Once it is there as
   * recorded — its UID, owner and runner, bound to the recorded storage, as a restore by the runbook
   * leaves it — and nothing holds it any more (the restore's own containers have gone), the failure
   * becomes retryable (PVC_RESTORED), and a retry starts the runner on it through the usual checks.
   * Anything else under the name changes nothing but the operator's detail. Nothing is created,
   * adopted or removed here.
   */
  private async volumeBack(mapping: ManagedRunner): Promise<Step> {
    const { terms } = this.backend;
    const recorded = `${terms.volume} ${mapping.pvcName} (${mapping.pvcUid})`;
    let detail: string;
    try {
      const holders = await this.backend.volumeHolders(await this.verifyStorage(mapping));
      if (holders.length === 0) {
        this.log.warn(`managed runner ${mapping.id}: PVC_RESTORED: its recorded ${recorded} is back; it can be retried`);
        await this.commit(mapping, { lastError: { ...managedRunnerReason('PVC_RESTORED'), detail: `${recorded} is back as recorded` } });
        return { done: 'FAILED' };
      }
      detail = `${recorded} is back as recorded, and still held by ${holders.join(', ')}`;
    } catch (error) {
      if (!(error instanceof ManagedRunnerConflict)) throw error;
      detail = error.code === 'PVC_MISSING' ? error.detail : `a ${terms.volume} under its name is not the recorded one: ${error.code}: ${error.detail}`;
    }
    if ((mapping.lastError as { detail?: unknown } | null)?.detail !== detail) {
      this.log.warn(`managed runner ${mapping.id}: PVC_MISSING: ${detail}`);
      await this.commit(mapping, { lastError: { ...managedRunnerReason('PVC_MISSING'), detail } });
    }
    return { done: 'FAILED' };
  }

  /**
   * The bootstrap credential of the mapping's generation. A new one carries a fresh credential; once
   * an instance has been started no new credential is ever issued under it here.
   */
  private async ensureCredential(mapping: ManagedRunner): Promise<{ mapping: ManagedRunner; credential: ManagedCredential }> {
    let current = mapping;
    let credential = await this.backend.readCredential(mapping);
    if (!credential) {
      if (mapping.podUid) {
        const { terms } = this.backend;
        throw new ManagedRunnerConflict(
          'SECRET_MISSING',
          `${terms.credential} ${this.backend.names(mapping.runnerId).credential} is gone after ${terms.instance} ${mapping.podUid} was started`,
        );
      }
      current = await this.beginOperation(mapping, 'CREATE_SECRET');
      credential = await this.backend.issueCredential(current, generateToken(32));
    }
    const problem = this.backend.credentialProblem(credential, current);
    if (problem) throw new ManagedRunnerConflict('SECRET_CONFLICT', problem);
    return { mapping: current, credential };
  }

  /** An instance under the fixed name that is not this generation's is a conflict for an operator.
   *  (One that replaced the recorded instance UID is the single-writer gate's: callers fence first.) */
  private checkInstance(mapping: ManagedRunner, instance: ManagedInstance): void {
    const problem = this.backend.instanceProblem(instance, mapping);
    if (problem) throw new ManagedRunnerConflict('POD_CONFLICT', problem);
  }

  private async recordInstance(mapping: ManagedRunner, instance: ManagedInstance, also: Prisma.ManagedRunnerUpdateManyMutationInput = {}): Promise<ManagedRunner> {
    this.checkInstance(mapping, instance);
    return this.commit(mapping, {
      ...also,
      podName: instance.name,
      podUid: instance.uid,
      nodeName: instance.node,
      ...this.settled(mapping),
    });
  }

  /** The runner row's credential is the bootstrap credential's: its hash, set before any instance exists. */
  private async adoptCredential(mapping: ManagedRunner, credential: ManagedCredential): Promise<ManagedRunner | null> {
    const tokenHash = sha256(credential.token!);
    const runner = await this.prisma.runner.findUnique({ where: { id: mapping.runnerId }, select: { tokenHash: true } });
    if (runner?.tokenHash === tokenHash) return null;
    const now = this.now();
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const { count } = await tx.managedRunner.updateMany({
          where: { id: mapping.id, revision: mapping.revision, leaseHolder: this.holder },
          data: { revision: { increment: 1 }, leaseExpiresAt: this.leaseUntil(now), ...this.settled(mapping), ...this.roomMade(mapping) },
        });
        if (count === 0) throw new Superseded();
        await tx.runner.update({ where: { id: mapping.runnerId }, data: { tokenHash } });
      },
      loggedRetry(this.log, 'managedRunners.adoptCredential'),
    );
    return this.reread(mapping.id);
  }

  /**
   * What the runner's heartbeats report, once it heartbeated after `since` and is fresh now; null
   * until then. Never manufactured here.
   */
  private async reportSince(mapping: ManagedRunner, since: Date): Promise<ManagedSupplyRunner | null> {
    const runner = await this.prisma.runner.findUnique({
      where: { id: mapping.runnerId },
      select: { status: true, lastHeartbeatAt: true, engines: true, capabilities: true },
    });
    const beat = runner?.lastHeartbeatAt;
    if (!runner || !beat || runner.status === 'OFFLINE' || beat < since) return null;
    return this.now().getTime() - beat.getTime() <= this.profile.lifecycle.heartbeatFreshSeconds * 1000 ? runner : null;
  }

  // ── row writes ─────────────────────────────────────────────────────────────────────────────

  private leaseUntil(now: Date): Date {
    return new Date(now.getTime() + this.profile.lifecycle.leaseSeconds * 1000);
  }

  /**
   * Take (or keep) the lease of one of this backend's mappings: free, expired, or already `holder`'s — this
   * replica's, or the holder of one administrator's switch (`switchVolume`).
   */
  private async acquireLease(id: string, holder = this.holder): Promise<ManagedRunner | null> {
    const now = this.now();
    const { count } = await this.prisma.managedRunner.updateMany({
      where: { id, backend: this.backend.name, OR: [{ leaseHolder: null }, { leaseHolder: holder }, { leaseExpiresAt: { lte: now } }] },
      data: { leaseHolder: holder, leaseExpiresAt: this.leaseUntil(now) },
    });
    return count === 0 ? null : this.reread(id);
  }

  private async releaseLease(id: string, holder = this.holder): Promise<void> {
    await this.prisma.managedRunner.updateMany({
      where: { id, leaseHolder: holder },
      data: { leaseHolder: null, leaseExpiresAt: null },
    });
  }

  /** Compare-and-set on the revision this pass read, while this replica still holds the lease. */
  private async commit(mapping: ManagedRunner, data: Prisma.ManagedRunnerUpdateManyMutationInput): Promise<ManagedRunner> {
    const now = this.now();
    const { count } = await this.prisma.managedRunner.updateMany({
      where: { id: mapping.id, revision: mapping.revision, leaseHolder: this.holder },
      data: { ...data, revision: { increment: 1 }, leaseExpiresAt: this.leaseUntil(now) },
    });
    if (count === 0) throw new Superseded();
    return this.reread(mapping.id);
  }

  private async reread(id: string): Promise<ManagedRunner> {
    const row = await this.prisma.managedRunner.findUnique({ where: { id } });
    if (!row) throw new Superseded();
    return row;
  }

  /**
   * Record the one resource operation in flight before it is sent, so a restart knows it may exist.
   * The kinds keep their first, Kubernetes names for every backend: they are stored, and the admission
   * guard reads CREATE_POD. PVC is the data volume, SECRET the bootstrap credential, POD the instance.
   */
  private beginOperation(
    mapping: ManagedRunner,
    kind: 'CREATE_PVC' | 'CREATE_SECRET' | 'CREATE_POD' | 'DELETE_POD' | 'DELETE_SECRET',
  ): Promise<ManagedRunner> {
    return this.commit(mapping, { resourceOperationId: randomUUID(), resourceOperationKind: kind, resourceOperationState: 'PENDING' });
  }

  /** The in-flight operation, settled by the observation the caller is recording. */
  private settled(mapping: ManagedRunner): Prisma.ManagedRunnerUpdateManyMutationInput {
    return mapping.resourceOperationState === 'PENDING' ? { resourceOperationState: 'COMPLETED' } : {};
  }

  /**
   * Something other than the mapping's own instance holds its volume, so no instance is created on
   * it: the wait the gate makes for a predecessor's volume (VOLUME_STILL_ATTACHED). Nothing is spent
   * and no startup deadline runs; `starting` sets the deadline afresh once the volume is free.
   */
  private async volumeInUse(mapping: ManagedRunner, holders: string, also: Prisma.ManagedRunnerUpdateManyMutationInput = {}): Promise<Step> {
    const waiting = (mapping.lastError as { code?: unknown } | null)?.code === 'VOLUME_IN_USE';
    if (!waiting) {
      this.log.warn(`managed runner ${mapping.id}: VOLUME_IN_USE: ${this.backend.terms.volume} ${mapping.pvcName} is held by ${holders}; nothing is started on it until it is free`);
    }
    if (!waiting || Object.keys(also).length > 0) {
      await this.commit(mapping, { ...also, lastError: this.waitReason(mapping, 'VOLUME_IN_USE', holders), startupDeadlineAt: null });
    }
    return { done: 'WAITING' };
  }

  /**
   * The backend made nothing because the environment is at a cap on what it holds: the Docker
   * channel's `maxContainers` (CONTAINER_LIMIT), or a namespace ResourceQuota on Kubernetes
   * (KUBERNETES_QUOTA_EXCEEDED), which can refuse the volume, the credential or the instance. The
   * budget is meant to stay below such a cap, so this is something the pool does not count or a cap set
   * below the budget: room comes back by itself when another runner's instance is removed, or when an
   * operator raises the cap. So it waits as it does for a held volume — no attempt spent, no startup
   * deadline running — and asks again after `capacityRetrySeconds`. Once the create goes through, the
   * wait ends (`roomMade`) and the deadline runs from then.
   */
  private async waitForRoom(mapping: ManagedRunner, code: string, detail: string, until = 'once there is room'): Promise<Step> {
    if ((mapping.lastError as { code?: unknown } | null)?.code !== code) {
      this.log.warn(`managed runner ${mapping.id}: ${code}: ${detail}; it is started ${until}`);
    }
    await this.commit(mapping, {
      resourceOperationState: 'COMPLETED',
      lastError: this.waitReason(mapping, code, detail),
      startupDeadlineAt: null,
      nextAttemptAt: new Date(this.now().getTime() + this.profile.lifecycle.capacityRetrySeconds * 1000),
    });
    return { done: 'WAITING' };
  }

  /**
   * A create a wait for room held back has gone through: the wait's reason goes, an automatic
   * restart's own coming back (`restartReason`), and the startup deadline runs from now.
   */
  private roomMade(mapping: ManagedRunner): Prisma.ManagedRunnerUpdateManyMutationInput {
    const code = (mapping.lastError as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !ROOM_WAITS.has(code)) return {};
    return {
      lastError: this.restartReason(mapping),
      nextAttemptAt: null,
      startupDeadlineAt: new Date(this.now().getTime() + this.profile.lifecycle.startupDeadlineSeconds * 1000),
    };
  }

  /** Keep waiting, unless the startup deadline has passed. */
  private async waitWithin(mapping: ManagedRunner): Promise<Step> {
    if (mapping.startupDeadlineAt && mapping.startupDeadlineAt <= this.now()) {
      return this.fail(mapping, 'STARTUP_TIMEOUT', `no fresh heartbeat by ${mapping.startupDeadlineAt.toISOString()}`);
    }
    return { done: 'WAITING' };
  }

  /**
   * The instance is up and reporting, with no runtime installed and signed in and no model key of the
   * owner's own it can run: not READY. Said as MODEL_UNAVAILABLE while the startup deadline lasts — a
   * runtime signed in or a key added meanwhile makes the next pass READY — and then FAILED with that
   * cause, retryable, so the owner can retry once one is.
   */
  private async withoutSupply(mapping: ManagedRunner): Promise<Step> {
    if (mapping.startupDeadlineAt && mapping.startupDeadlineAt <= this.now()) {
      return this.fail(mapping, MODEL_UNAVAILABLE, `no runtime signed in and no model key of the owner's it runs by ${mapping.startupDeadlineAt.toISOString()}`);
    }
    if ((mapping.lastError as { code?: unknown } | null)?.code !== MODEL_UNAVAILABLE) {
      await this.commit(mapping, { lastError: { ...managedRunnerReason(MODEL_UNAVAILABLE) } });
    }
    return { done: 'WAITING' };
  }

  private async fail(mapping: ManagedRunner, code: string, detail: string, also: Prisma.ManagedRunnerUpdateManyMutationInput = {}): Promise<Step> {
    await this.commitReleasingCompute(mapping, {
      ...also,
      managementState: 'FAILED',
      stateEnteredAt: this.now(),
      nextAttemptAt: null,
      lastError: { ...managedRunnerReason(code), detail },
    });
    return { done: 'FAILED' };
  }

  /**
   * FAILED, or a disabled owner's mapping put to sleep with no instance. Its compute share goes back
   * to the pool in the same transaction when no instance of this generation exists or can exist —
   * none recorded and no instance create in flight, so there is nothing whose stop would have to be
   * proven first. A recorded or possibly created instance keeps it: that one is released only through
   * the stop gate. A retry, or a wake, is admitted again from REQUESTED.
   */
  private async commitReleasingCompute(mapping: ManagedRunner, data: Prisma.ManagedRunnerUpdateManyMutationInput): Promise<void> {
    const held = readReservation(mapping.reservation);
    const compute = computeOf(held);
    const createInFlight = mapping.resourceOperationKind === 'CREATE_POD' && mapping.resourceOperationState === 'PENDING';
    if (!held || !compute || mapping.podUid || createInFlight) {
      await this.commit(mapping, data);
      return;
    }
    const now = this.now();
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const { count } = await tx.managedRunner.updateMany({
          where: { id: mapping.id, revision: mapping.revision, leaseHolder: this.holder, podUid: null },
          data: {
            ...data,
            reservation: { ...held, compute: null } as unknown as Prisma.InputJsonValue,
            revision: { increment: 1 },
            leaseExpiresAt: this.leaseUntil(now),
          },
        });
        if (count === 0) throw new Superseded();
        await releaseCapacity(tx, held.pool, compute, null);
      },
      loggedRetry(this.log, 'managedRunners.releaseIdleCompute'),
    );
  }

  /** A transient failure while only looking (OBSERVING_STATES): said in the log, nothing spent or written. */
  private unanswered(mapping: ManagedRunner, error: unknown): Step {
    this.log.warn(`managed runner ${mapping.id}: ${mapping.managementState}, and the ${this.backend.name} backend did not answer: ${(error as Error).message}; looking again next pass`);
    return { done: 'BACKOFF' };
  }

  /**
   * The backend could not be reached at all while the mapping was being provisioned or started:
   * nothing was tried, so nothing is spent. Said as the transient error it is, and tried again after
   * the backoff of the attempt it is on — pass after pass, however long the outage lasts.
   */
  private async unreachable(mapping: ManagedRunner, error: unknown): Promise<Step> {
    const delayMs = this.backoffDelay(Math.max(1, mapping.attempt));
    this.log.warn(
      `managed runner ${mapping.id}: ${mapping.managementState}, and the ${this.backend.name} backend cannot be reached: ${(error as Error).message}; `
        + `nothing spent (attempt ${mapping.attempt} of ${this.profile.lifecycle.maxAttempts}), trying again in ${Math.ceil(delayMs / 1000)} s`,
    );
    await this.commit(mapping, {
      nextAttemptAt: new Date(this.now().getTime() + delayMs),
      lastError: this.waitReason(mapping, 'TRANSIENT'),
    });
    return { done: 'BACKOFF' };
  }

  /** A transient failure spends one attempt; the last one leaves the mapping FAILED, retryable. */
  private async backoff(mapping: ManagedRunner, error: unknown): Promise<Step> {
    const attempt = mapping.attempt + 1;
    this.log.warn(`managed runner ${mapping.id}: transient failure ${attempt}/${this.profile.lifecycle.maxAttempts}: ${(error as Error).message}`);
    if (attempt >= this.profile.lifecycle.maxAttempts) {
      await this.commitReleasingCompute(mapping, {
        attempt,
        managementState: 'FAILED',
        stateEnteredAt: this.now(),
        nextAttemptAt: null,
        lastError: { ...managedRunnerReason('RETRY_EXHAUSTED'), detail: `after ${attempt} attempts` },
      });
      return { done: 'FAILED' };
    }
    await this.commit(mapping, {
      attempt,
      nextAttemptAt: new Date(this.now().getTime() + this.backoffDelay(attempt)),
      lastError: this.waitReason(mapping, 'TRANSIENT'),
    });
    return { done: 'BACKOFF' };
  }

  /** The wait before attempt `attempt`: doubling from the base up to the ceiling. */
  private backoffDelay(attempt: number): number {
    const { backoffBaseSeconds, backoffMaxSeconds } = this.profile.lifecycle;
    const ceiling = Math.min(backoffMaxSeconds, backoffBaseSeconds * 2 ** (attempt - 1)) * 1000;
    // Subtractive jitter, at most half: never longer than the ceiling, never in lockstep.
    return Math.round(ceiling - ceiling * 0.5 * this.random());
  }
}
