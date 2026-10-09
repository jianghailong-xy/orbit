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
import {
  KubeApiError,
  isRetryableKubeError,
  type ManagedKubeClient,
  type PersistentVolume,
  type PersistentVolumeClaim,
  type Pod,
  type Secret,
} from './kube-client';
import { MANAGED_ADMISSION_DENIAL_MARKER } from './managed-runner-admission';
import {
  capacityShortMessage,
  computeOf,
  computeShare,
  readCapacityPool,
  readReservation,
  releaseCapacity,
  reserveCapacity,
  shortDimensions,
  storageShare,
  syncCapacityPool,
  type CapacityPool,
  type ComputeAmounts,
  type ManagedRunnerReservation,
  type StorageAmounts,
} from './managed-runner-capacity';
import {
  observedStop,
  readFencingReceipt,
  stopProofFor,
  type ManagedRunnerPredecessor,
  type ManagedRunnerStopProof,
} from './managed-runner-fencing';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import {
  OWNER_ANNOTATION,
  RUNNER_ANNOTATION,
  bootstrapCredentialOf,
  buildManagedPod,
  buildManagedPvc,
  buildManagedSecret,
  managedAdmissionProbeName,
  managedFencingReceiptName,
  managedPodName,
  managedSecretName,
  podIdentityProblem,
  podStopConfirmed,
  podTerminated,
  pvIdentityProblem,
  pvcIdentityProblem,
  secretGeneration,
  secretIdentityProblem,
  type ManagedRunnerIdentity,
} from './managed-runner-resources';
import { readStoredWorkload, workloadIdle, type StoredManagedWorkload } from './managed-runner-sleep';
import { managedRuntimeSupply, type ManagedSupplyRunner } from './managed-runner-supply';
import { managedRunnerWork, recordManagedDemand, sleepingRunnersWithDemand } from './managed-runner-work';

/**
 * The managed runner manager: drives one mapping's Kubernetes objects towards its desired state
 * (docs/managed-runner-design.md, "Identity and durable mapping" and "Management and execution
 * states"). The persisted mapping is the work queue — a pass reads the row, observes the cluster by
 * deterministic name and takes at most one step at a time, each committed as a compare-and-set on
 * the row's `revision` under this replica's lease — so a restart, a second replica or a lost reply
 * resumes from what is recorded and what is observed, never from memory.
 *
 * This version provisions: REQUESTED → PROVISIONING (data PVC, its PV and volume handle, the
 * bootstrap Secret and the runner credential it carries) → STARTING (the one Pod of the current
 * generation, until the runner row has a fresh heartbeat reporting a runtime installed and signed
 * in — the one READY records as `initialProvider`; without one it reports MODEL_UNAVAILABLE) →
 * READY; and FAILED, with a structured cause, when the attempt budget is spent or what the cluster
 * holds is not what the mapping recorded. It never deletes a PVC, a runner row or a workspace. The
 * only objects it deletes, always by UID, are a Pod the kubelet reported stopped, when an explicit
 * retry asked for a fresh start, and the bootstrap Secret of a generation the gate has retired.
 *
 * The single-writer gate (docs/managed-runner-design.md, "Single Pod and single writer protection")
 * is `replacePredecessor`: generation N+1 — a new credential, a new Secret, a new Pod — is issued only
 * after the recorded instance of generation N is proven stopped. Proof is the kubelet's report that
 * every container of that Pod UID stopped, or an operator's fencing receipt bound to that instance
 * and volume (managed-runner-fencing.ts); either way the Pod object must be gone and no
 * VolumeAttachment may hold the volume. A Pod that vanished or was replaced unobserved, a stale
 * heartbeat or an expired lease is not proof: the mapping goes FENCING, its predecessor's credential
 * stops working at once, its disk is kept, and it waits for the proof. No Pod is created at all
 * until a dry run shows the admission guard refusing one it must refuse.
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
 *     drain off exclude each other on the row. It then exits on its own, and the kubelet's report
 *     of that stop is the stop proof the single-writer gate needs: the Pod object is released by
 *     UID, the volume detaches, the generation advances and only then is compute released. Runner
 *     row, workspace, PVC and data stay; SLEEPING.
 *   - Wake: demand (managed-runner-demand.ts, or the sweep below) desires RUNNING again; a sleeping
 *     mapping goes back through admission and provisioning, which adopt the recorded PVC and the
 *     same runner row, and starts the next generation's Pod on them.
 *
 * Left to the work that follows: deletion.
 */

/** Where a pass got to. */
export type ReconcileOutcome =
  /** Another replica holds the lease. */
  | 'LEASED_ELSEWHERE'
  /** The row changed under this pass; the next pass starts from the new revision. */
  | 'SUPERSEDED'
  /** Nothing to do until the cluster or the runner moves (claim binding, Pod start, heartbeat). */
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

/** What the cluster holds is not what the mapping recorded: an operator has to look. */
class Conflict extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
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
    message: 'The runner is up, but none of its runtimes is installed and signed in, so it cannot start a session. Sign one in from Providers; a runner that has stopped waiting for it can then be retried.',
    retryable: true,
  },
  POD_TERMINATED: { message: 'The runner instance stopped. A retry releases it and keeps the data volume.', retryable: true },
  KUBERNETES_FORBIDDEN: { message: 'The cluster refused the manager. An operator has to check its permissions; then it can be retried.', retryable: true },
  KUBERNETES_REJECTED: { message: 'The cluster rejected a managed runner object. An operator has to check the environment; then it can be retried.', retryable: true },
  PVC_CONFLICT: { message: "A data volume under this runner's name is not the recorded one, so nothing was replaced. An operator has to review it.", retryable: false },
  PVC_MISSING: { message: "This runner's recorded data volume is gone. No empty volume is created in its place; an operator has to review it.", retryable: false },
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
};

export function managedRunnerReason(code: string): ManagedRunnerReason {
  const known = REASONS[code];
  return { code, message: known?.message ?? 'The managed runner could not be provisioned.', retryable: known?.retryable ?? false };
}

/** What a step decided: stop the pass with an outcome, or go on from the row it committed. */
type Step = { done: ReconcileOutcome } | { next: ManagedRunner };

/** The states a RUNNING desire drives towards READY (and READY itself, watched). */
const ACTIVE_STATES = ['REQUESTED', 'PROVISIONING', 'STARTING', 'READY', 'FENCING'] as const;
/** A pass takes at most this many steps; the worker's next pass continues. */
const MAX_STEPS_PER_PASS = 12;
/** Sleeping mappings the demand sweep wakes per pass. */
const SWEEP_BATCH = 50;

/** The drain was called off: why, for the log. */
type DrainAbort = 'DEMAND' | 'WORK' | 'RUNNER_BUSY' | 'TELEMETRY_MISSING' | 'NOT_ACKNOWLEDGED';

export class ManagedRunnerManager {
  readonly holder: string;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly log: Pick<Logger, 'warn' | 'error'>;
  /** This environment's capacity pool, created or brought to the profile's totals once per process. */
  private pool?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kube: ManagedKubeClient,
    private readonly profile: ManagedRunnerProfile,
    options: ManagedRunnerManagerOptions = {},
  ) {
    this.holder = options.holder ?? randomUUID();
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.log = options.log ?? new Logger('ManagedRunnerManager');
  }

  /**
   * The mappings a pass should visit now. Work first — every state that moves by itself, an intent
   * waiting for capacity once its retry time comes or the pool has moved since it was refused
   * (oldest waiter first, so a release is offered in the order the waits began), a drain, a wake —
   * then the READY runners whose instance and idleness each pass looks at.
   */
  async dueMappings(limit: number): Promise<string[]> {
    const now = this.now();
    const due = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] };
    const pool = await this.capacityPool();
    const waiting = await this.prisma.managedRunner.findMany({
      where: {
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
        OR: [
          { desiredState: 'RUNNING', managementState: { in: ['REQUESTED', 'PROVISIONING', 'STARTING', 'FENCING'] }, ...due },
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
      where: { desiredState: 'RUNNING', managementState: 'READY', ...due },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return [...new Set([...waiting, ...moving, ...watched].map((row) => row.id))].slice(0, limit);
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

  /** One pass over one mapping, under this replica's lease. */
  async reconcile(mappingId: string): Promise<ReconcileOutcome> {
    const leased = await this.acquireLease(mappingId);
    if (!leased) {
      const exists = await this.prisma.managedRunner.count({ where: { id: mappingId } });
      return exists ? 'LEASED_ELSEWHERE' : 'NOT_FOUND';
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

  private identity(mapping: ManagedRunner): ManagedRunnerIdentity {
    return { ownerId: mapping.ownerId, runnerId: mapping.runnerId, generation: mapping.generation, namespace: mapping.namespace };
  }

  private async step(mapping: ManagedRunner): Promise<Step> {
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
      default:
        if (mapping.desiredState !== 'RUNNING') return { done: 'IDLE' };
        if (!(ACTIVE_STATES as readonly string[]).includes(mapping.managementState)) {
          return { done: mapping.managementState === 'FAILED' ? 'FAILED' : 'IDLE' };
        }
        if (mapping.nextAttemptAt && mapping.nextAttemptAt > this.now()) return { done: 'BACKOFF' };
    }
    try {
      return await this.drive(mapping);
    } catch (error) {
      if (error instanceof Superseded) return { done: 'SUPERSEDED' };
      throw error;
    }
  }

  private async drive(mapping: ManagedRunner): Promise<Step> {
    try {
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
        default:
          return await this.ready(mapping);
      }
    } catch (error) {
      if (error instanceof Superseded) throw error;
      // Each handler below reads the row afresh: the one this step started from may have been
      // advanced by an operation record before the failure.
      const current = await this.reread(mapping.id);
      if (error instanceof Conflict) {
        this.log.warn(`managed runner ${mapping.id}: ${error.code}: ${error.detail}`);
        return this.fail(current, error.code, error.detail);
      }
      if (isRetryableKubeError(error)) return this.backoff(current, error);
      if (error instanceof KubeApiError) {
        this.log.warn(`managed runner ${mapping.id}: Kubernetes answered ${error.status} ${error.reason}: ${error.message}`);
        const code = error.status === 401 || error.status === 403 ? 'KUBERNETES_FORBIDDEN' : 'KUBERNETES_REJECTED';
        return this.fail(current, code, `HTTP ${error.status} ${error.reason}`.trim());
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
   * The pool as it stands now. Its row is created, or brought to the profile's totals, on this
   * process's first use; after that only its id is kept, and its figures and revision are read afresh
   * each time — they move with every admission and release, by any replica.
   */
  private async capacityPool(): Promise<CapacityPool> {
    this.pool ??= syncCapacityPool(this.prisma, this.profile).then((pool) => pool.id).catch((error: Error) => {
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
    const needStorage = held?.storage ? null : storageShare(this.profile);
    const needCompute = held?.compute ? null : computeShare(this.profile);
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
      lastError: Prisma.DbNull,
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
    const { mapping, pvc } = await this.ensurePvc(start);
    if (!mapping.pvcUid) return { next: await this.commit(mapping, { pvcUid: pvc.metadata.uid, ...this.settled(mapping) }) };
    if (pvc.status?.phase !== 'Bound' || !pvc.spec.volumeName) return this.waitWithin(mapping);

    const pv = await this.kube.getPersistentVolume(pvc.spec.volumeName);
    if (!pv) return this.waitWithin(mapping);
    const pvProblem = pvIdentityProblem(pv, mapping.pvcUid, this.profile, { pvUid: mapping.pvUid, volumeHandle: mapping.volumeHandle });
    if (pvProblem) throw new Conflict('PV_CONFLICT', pvProblem);
    if (!mapping.pvUid || !mapping.volumeHandle) {
      return { next: await this.commit(mapping, { pvUid: pv.metadata.uid, volumeHandle: pv.spec.csi!.volumeHandle }) };
    }

    const retired = await this.replaceRetiredSecret(mapping);
    if (retired) return retired;
    const issued = await this.ensureSecret(mapping);
    if (!issued.mapping.podUid) {
      const adopted = await this.adoptCredential(issued.mapping, issued.secret);
      if (adopted) return { next: adopted };
    }
    return {
      next: await this.commit(issued.mapping, {
        managementState: 'STARTING',
        stateEnteredAt: this.now(),
        lastError: Prisma.DbNull,
        ...this.settled(issued.mapping),
      }),
    };
  }

  private async starting(mapping: ManagedRunner): Promise<Step> {
    await this.verifyStorage(mapping);
    const name = managedPodName(mapping.runnerId);
    let pod = await this.kube.pods.get(name);
    if (!pod && mapping.podUid) {
      // The recorded instance is gone, and nothing proves it stopped writing.
      return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', `Pod ${mapping.podUid} of generation ${mapping.generation} is gone without a stop proof`);
    }
    if (!pod) {
      // The one Pod of this generation, created only where the admission guard is known to refuse
      // any other.
      await this.requireAdmissionGuard(mapping);
      const begun = await this.beginOperation(mapping, 'CREATE_POD');
      pod = await this.createOrReadBack(this.kube.pods, buildManagedPod(this.identity(begun), begun.pvcUid!, this.profile));
      return { next: await this.recordPod(begun, pod) };
    }
    if (mapping.podUid && pod.metadata.uid !== mapping.podUid) {
      return this.fence(mapping, 'POD_REPLACED', `Pod ${mapping.podUid} was replaced by ${pod.metadata.uid} without a stop proof`);
    }
    this.checkPod(mapping, pod);
    if (pod.metadata.uid !== mapping.podUid || (pod.spec.nodeName ?? null) !== mapping.nodeName) {
      return { next: await this.recordPod(mapping, pod) };
    }
    if (podTerminated(pod)) return this.terminated(mapping, pod);
    // A released instance still being removed: wait for it to go, then the gate decides.
    if (pod.metadata.deletionTimestamp) return this.waitWithin(mapping);
    const report = pod.status?.phase === 'Running' ? await this.reportSince(mapping, mapping.stateEnteredAt) : null;
    if (!report) return this.waitWithin(mapping);
    // READY needs model supply as well as a live instance: the runtime it is found ready with is the
    // one a default workspace with no history starts on, recorded, never guessed later.
    const [initialProvider] = managedRuntimeSupply(report);
    if (!initialProvider) return this.withoutSupply(mapping);
    await this.commit(mapping, {
      managementState: 'READY',
      stateEnteredAt: this.now(),
      attempt: 0,
      nextAttemptAt: null,
      startupDeadlineAt: null,
      lastError: Prisma.DbNull,
      initialProvider,
    });
    return { done: 'READY' };
  }

  private async ready(mapping: ManagedRunner): Promise<Step> {
    await this.verifyStorage(mapping);
    const pod = await this.kube.pods.get(managedPodName(mapping.runnerId));
    if (!pod) {
      return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', `Pod ${mapping.podUid} of generation ${mapping.generation} is gone without a stop proof`);
    }
    if (pod.metadata.uid !== mapping.podUid) {
      return this.fence(mapping, 'POD_REPLACED', `Pod ${mapping.podUid} was replaced by ${pod.metadata.uid} without a stop proof`);
    }
    this.checkPod(mapping, pod);
    if (podTerminated(pod)) return this.terminated(mapping, pod);
    // A stale heartbeat makes READY unusable (the status says so); it is not proof the instance died,
    // and it authorizes nothing.
    return (await this.beginDrain(mapping)) ?? { done: 'READY' };
  }

  // ── sleep and wake ─────────────────────────────────────────────────────────────────────────

  /**
   * What the authorized instance last reported, if it may be believed: it declares it can sleep, it
   * heartbeated recently, and the report is fresh and comes from the generation and Pod recorded now.
   * Null otherwise — missing or stale telemetry never lets anything sleep.
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
   * or by the drain budget running out unaccepted. Once it accepts it exits on its own; nothing here
   * stops it. Its stop then goes through the single-writer gate's own rules: the kubelet's report of
   * every container stopped is recorded as the stop proof, the Pod object is released by UID, and the
   * mapping sleeps only once the object is gone and the volume detached. A Pod that vanished or was
   * replaced unobserved, or was made terminal by the control plane, fences, as anywhere else.
   */
  private async draining(mapping: ManagedRunner): Promise<Step> {
    const name = managedPodName(mapping.runnerId);
    const pod = await this.kube.pods.get(name);
    const predecessor = this.predecessorOf(mapping);
    if (!pod) {
      const proof = stopProofFor(mapping.fencingReceipt, predecessor);
      if (!proof) return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', `Pod ${mapping.podUid} of generation ${mapping.generation} is gone without a stop proof`);
      const { pvc } = await this.verifyStorage(mapping);
      const attached = (await this.kube.listVolumeAttachments()).filter((va) => va.spec.source.persistentVolumeName === pvc.spec.volumeName);
      if (attached.length > 0) return { done: 'DRAINING' };
      return { next: await this.fallAsleep(mapping, proof) };
    }
    if (pod.metadata.uid !== mapping.podUid) {
      return this.fence(mapping, 'POD_REPLACED', `Pod ${mapping.podUid} was replaced by ${pod.metadata.uid} without a stop proof`);
    }
    this.checkPod(mapping, pod);
    await this.verifyStorage(mapping);
    if (podTerminated(pod)) {
      if (!podStopConfirmed(pod)) {
        return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', `Pod ${pod.metadata.uid} is ${pod.status?.phase}, but not by its kubelet's report`);
      }
      let current = mapping;
      if (!stopProofFor(mapping.fencingReceipt, predecessor)) {
        current = await this.commit(mapping, { fencingReceipt: observedStop(predecessor, pod, this.now()) as unknown as Prisma.InputJsonValue });
      }
      if (pod.metadata.deletionTimestamp) return { done: 'DRAINING' };
      // Released by UID: a successor under the same name is never deleted.
      const begun = await this.beginOperation(current, 'DELETE_POD');
      await this.kube.pods.delete(name, { uid: mapping.podUid! });
      return { next: await this.commit(begun, { resourceOperationState: 'COMPLETED' }) };
    }
    const now = this.now();
    if (!mapping.stopAcknowledgedAt) {
      const abort = await this.drainAbort(mapping, now);
      return abort ? this.abortDrain(mapping, abort) : { done: 'DRAINING' };
    }
    // Accepted: it stops by itself. Overdue is said, never forced.
    const overdue = now.getTime() - mapping.stopAcknowledgedAt.getTime() > this.profile.lifecycle.drainSeconds * 1000;
    if (overdue && (mapping.lastError as { code?: unknown } | null)?.code !== 'SLEEP_STOP_OVERDUE') {
      await this.commit(mapping, { lastError: { ...managedRunnerReason('SLEEP_STOP_OVERDUE'), detail: `accepted at ${mapping.stopAcknowledgedAt.toISOString()}` } });
    }
    return { done: 'DRAINING' };
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
   * The drained instance is proven stopped, its Pod object gone and its volume detached: generation N
   * is retired on that proof and N+1 reserved, exactly as the single-writer gate advances (its
   * credential replaced by one nobody holds), and in the same transaction its compute share goes back
   * to the pool. The storage share, the PVC, the runner row and the workspace stay. SLEEPING — and if
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

  // ── the single-writer gate ─────────────────────────────────────────────────────────────────

  /** The recorded instance, as a proof has to name it. */
  private predecessorOf(mapping: ManagedRunner): ManagedRunnerPredecessor {
    return {
      runnerId: mapping.runnerId,
      generation: mapping.generation,
      podName: mapping.podName ?? managedPodName(mapping.runnerId),
      podUid: mapping.podUid!,
      nodeName: mapping.nodeName,
      pvcUid: mapping.pvcUid!,
      volumeHandle: mapping.volumeHandle!,
    };
  }

  /**
   * The recorded Pod is terminal. With the kubelet's report of it, that report is recorded as the
   * stop proof and the mapping fails retryable: an explicit retry replaces the instance. A Pod the
   * control plane made terminal for its node proves nothing about the node: FENCING.
   */
  private async terminated(mapping: ManagedRunner, pod: Pod): Promise<Step> {
    if (!podStopConfirmed(pod)) {
      return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', `Pod ${pod.metadata.uid} is ${pod.status?.phase}, but not by its kubelet's report`);
    }
    const proof = stopProofFor(mapping.fencingReceipt, this.predecessorOf(mapping)) ?? observedStop(this.predecessorOf(mapping), pod, this.now());
    return this.fail(mapping, 'POD_TERMINATED', `Pod ${pod.metadata.uid} is ${pod.status?.phase}`, {
      fencingReceipt: proof as unknown as Prisma.InputJsonValue,
    });
  }

  /**
   * Retire the recorded instance (`mapping.podUid`, generation N) and advance to generation N+1, if
   * and only if it is proven stopped (see the class comment). Answers null when there is nothing to
   * do because the instance is still running and the mapping is not fencing — a retry waits on it.
   */
  private async replacePredecessor(mapping: ManagedRunner): Promise<Step | null> {
    const name = managedPodName(mapping.runnerId);
    const predecessor = this.predecessorOf(mapping);
    const pod = await this.kube.pods.get(name);
    if (pod && pod.metadata.uid !== mapping.podUid) {
      return this.fence(mapping, 'POD_REPLACED', `Pod ${mapping.podUid} was replaced by ${pod.metadata.uid} without a stop proof`);
    }
    let proof = stopProofFor(mapping.fencingReceipt, predecessor);
    if (pod) {
      if (podStopConfirmed(pod)) {
        let current = mapping;
        if (!proof) current = await this.commit(mapping, { fencingReceipt: observedStop(predecessor, pod, this.now()) as unknown as Prisma.InputJsonValue });
        if (pod.metadata.deletionTimestamp) return { done: 'WAITING' };
        // Released by UID: a successor under the same name is never deleted.
        const begun = await this.beginOperation(current, 'DELETE_POD');
        await this.kube.pods.delete(name, { uid: mapping.podUid! });
        return { next: await this.commit(begun, { resourceOperationState: 'COMPLETED' }) };
      }
      if (podTerminated(pod)) {
        return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', `Pod ${pod.metadata.uid} is ${pod.status?.phase}, but not by its kubelet's report`);
      }
      // Still there and not stopped: a retry waits on it; a fencing mapping waits for its removal.
      return mapping.managementState === 'FENCING' ? { done: 'FENCING' } : null;
    }
    // The Pod object is gone.
    const { pvc, pv } = await this.verifyStorage(mapping);
    if (!proof) {
      if (mapping.managementState !== 'FENCING') {
        return this.fence(mapping, 'PREDECESSOR_STOP_UNPROVEN', `Pod ${mapping.podUid} of generation ${mapping.generation} is gone without a stop proof`);
      }
      const received = await this.receivedFencing(mapping, predecessor, pv);
      if (!received) return { done: 'FENCING' };
      proof = received.proof;
      mapping = received.mapping;
    }
    const attached = (await this.kube.listVolumeAttachments()).filter((va) => va.spec.source.persistentVolumeName === pvc.spec.volumeName);
    if (attached.length > 0) {
      if ((mapping.lastError as { code?: unknown } | null)?.code !== 'VOLUME_STILL_ATTACHED') {
        await this.commit(mapping, { lastError: { ...managedRunnerReason('VOLUME_STILL_ATTACHED'), detail: attached.map((va) => va.metadata.name).join(', ') } });
      }
      return { done: mapping.managementState === 'FENCING' ? 'FENCING' : 'WAITING' };
    }
    return { next: await this.advance(mapping, proof) };
  }

  /**
   * A fencing receipt for this predecessor, read from its ConfigMap and recorded once accepted. An
   * unacceptable one is reported on the mapping (what was wrong goes to the log) and changes nothing.
   */
  private async receivedFencing(
    mapping: ManagedRunner,
    predecessor: ManagedRunnerPredecessor,
    pv: PersistentVolume,
  ): Promise<{ mapping: ManagedRunner; proof: ManagedRunnerStopProof } | null> {
    const configMap = await this.kube.configMaps.get(managedFencingReceiptName(mapping.runnerId));
    if (!configMap) return null;
    const verdict = readFencingReceipt(configMap, predecessor, pv, this.now());
    if (!verdict.ok) {
      const detail = verdict.problems.join('; ');
      const stored = mapping.lastError as { code?: unknown; detail?: unknown } | null;
      if (stored?.code !== 'FENCING_RECEIPT_INVALID' || stored.detail !== detail) {
        this.log.warn(`managed runner ${mapping.id}: fencing receipt ${configMap.metadata.name} not accepted: ${detail}`);
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
   * next generation's credential arrives with its own Secret. The disk, the Secret and the Pod
   * object stay where they are.
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
   * compare-and-set — no Pod recorded, a fresh attempt budget, REQUESTED. The retired credential is
   * replaced by one nobody holds; N+1's is issued with its own Secret once N's is removed.
   */
  private async advance(mapping: ManagedRunner, proof: ManagedRunnerStopProof): Promise<ManagedRunner> {
    const now = this.now();
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
            attempt: 0,
            nextAttemptAt: null,
            startupDeadlineAt: null,
            lastError: Prisma.DbNull,
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
   * The bootstrap Secret of a generation the gate retired: removed, by UID, before this generation's
   * is issued under the same name. Its credential stopped working when the generation advanced.
   */
  private async replaceRetiredSecret(mapping: ManagedRunner): Promise<Step | null> {
    if (mapping.podUid) return null;
    const name = managedSecretName(mapping.runnerId);
    const secret = await this.kube.secrets.get(name);
    const generation = secret ? secretGeneration(secret) : null;
    if (!secret || generation === null || generation >= mapping.generation) return null;
    const said = secret.metadata.annotations ?? {};
    // Not this runner's: ensureSecret reports the conflict.
    if (said[OWNER_ANNOTATION] !== mapping.ownerId || said[RUNNER_ANNOTATION] !== mapping.runnerId) return null;
    if (secret.metadata.deletionTimestamp) return this.waitWithin(mapping);
    const begun = await this.beginOperation(mapping, 'DELETE_SECRET');
    await this.kube.secrets.delete(name, { uid: secret.metadata.uid });
    return { next: await this.commit(begun, { resourceOperationState: 'COMPLETED' }) };
  }

  /**
   * Proof that the environment's admission guard is in force (managed-runner-admission.ts): a dry
   * run of a Pod it must refuse — this generation's template under another name — comes back
   * refused by it. Admitted, or refused by anything else, nothing is created.
   */
  private async requireAdmissionGuard(mapping: ManagedRunner): Promise<void> {
    const probe = buildManagedPod(this.identity(mapping), mapping.pvcUid!, this.profile);
    probe.metadata.name = managedAdmissionProbeName(mapping.runnerId);
    try {
      await this.kube.pods.create(probe, { dryRun: true });
    } catch (error) {
      if (error instanceof KubeApiError && error.message.includes(MANAGED_ADMISSION_DENIAL_MARKER)) return;
      if (isRetryableKubeError(error)) throw error;
      throw new Conflict('ADMISSION_GUARD_UNVERIFIED', `the admission probe was refused, but not by the guard: ${(error as Error).message}`);
    }
    throw new Conflict('ADMISSION_GUARD_MISSING', 'a Pod the single-Pod admission guard must refuse was admitted by a dry run');
  }

  // ── resources ──────────────────────────────────────────────────────────────────────────────

  /** The mapping's PVC: created once, adopted by identity, never recreated once its UID is recorded. */
  private async ensurePvc(mapping: ManagedRunner): Promise<{ mapping: ManagedRunner; pvc: PersistentVolumeClaim }> {
    let current = mapping;
    let pvc = await this.kube.persistentVolumeClaims.get(mapping.pvcName);
    if (!pvc) {
      if (mapping.pvcUid) throw new Conflict('PVC_MISSING', `PVC ${mapping.pvcName} (${mapping.pvcUid}) is gone`);
      current = await this.beginOperation(mapping, 'CREATE_PVC');
      pvc = await this.createOrReadBack(this.kube.persistentVolumeClaims, buildManagedPvc(this.identity(current), this.profile));
    }
    const problem = pvcIdentityProblem(pvc, this.identity(current), this.profile, current.pvcUid);
    if (problem) throw new Conflict('PVC_CONFLICT', problem);
    return { mapping: current, pvc };
  }

  /** The recorded PVC and PV, unchanged: checked on every pass once the instance is being started. */
  private async verifyStorage(mapping: ManagedRunner): Promise<{ pvc: PersistentVolumeClaim; pv: PersistentVolume }> {
    const pvc = await this.kube.persistentVolumeClaims.get(mapping.pvcName);
    if (!pvc) throw new Conflict('PVC_MISSING', `PVC ${mapping.pvcName} (${mapping.pvcUid}) is gone`);
    const problem = pvcIdentityProblem(pvc, this.identity(mapping), this.profile, mapping.pvcUid);
    if (problem) throw new Conflict('PVC_CONFLICT', problem);
    if (pvc.status?.phase !== 'Bound' || !pvc.spec.volumeName) throw new Conflict('PVC_CONFLICT', 'the recorded PVC is no longer bound');
    const pv = await this.kube.getPersistentVolume(pvc.spec.volumeName);
    if (!pv) throw new Conflict('PV_CONFLICT', `PV ${pvc.spec.volumeName} is gone`);
    const pvProblem = pvIdentityProblem(pv, mapping.pvcUid!, this.profile, { pvUid: mapping.pvUid, volumeHandle: mapping.volumeHandle });
    if (pvProblem) throw new Conflict('PV_CONFLICT', pvProblem);
    return { pvc, pv };
  }

  /**
   * The bootstrap Secret of the mapping's generation. A new one carries a fresh credential; once an
   * instance has been started no new credential is ever issued under it here.
   */
  private async ensureSecret(mapping: ManagedRunner): Promise<{ mapping: ManagedRunner; secret: Secret }> {
    let current = mapping;
    const name = managedSecretName(mapping.runnerId);
    let secret = await this.kube.secrets.get(name);
    if (!secret) {
      if (mapping.podUid) throw new Conflict('SECRET_MISSING', `Secret ${name} is gone after Pod ${mapping.podUid} was started`);
      current = await this.beginOperation(mapping, 'CREATE_SECRET');
      secret = await this.createOrReadBack(this.kube.secrets, buildManagedSecret(this.identity(current), generateToken(32)));
    }
    const problem = secretIdentityProblem(secret, this.identity(current));
    if (problem) throw new Conflict('SECRET_CONFLICT', problem);
    return { mapping: current, secret };
  }

  /**
   * Create `object`; whatever the answer, a failure is followed by a read of the same name. An
   * object found there is returned for the caller's identity check — a timed-out create that did
   * commit is adopted, never created twice — and only when nothing is there is the error passed on.
   */
  private async createOrReadBack<T extends PersistentVolumeClaim | Secret | Pod>(
    resource: { create(object: T): Promise<T>; get(name: string): Promise<T | null> },
    object: T,
  ): Promise<T> {
    try {
      return await resource.create(object);
    } catch (error) {
      const found = await resource.get(object.metadata.name);
      if (found) return found;
      throw error;
    }
  }

  /** A Pod under the fixed name that is not this generation's template is a conflict for an operator.
   *  (One that replaced the recorded Pod UID is the single-writer gate's: callers fence first.) */
  private checkPod(mapping: ManagedRunner, pod: Pod): void {
    const problem = podIdentityProblem(pod, this.identity(mapping), mapping.pvcUid!);
    if (problem) throw new Conflict('POD_CONFLICT', problem);
  }

  private async recordPod(mapping: ManagedRunner, pod: Pod): Promise<ManagedRunner> {
    this.checkPod(mapping, pod);
    return this.commit(mapping, {
      podName: pod.metadata.name,
      podUid: pod.metadata.uid,
      nodeName: pod.spec.nodeName ?? null,
      ...this.settled(mapping),
    });
  }

  /** The runner row's credential is the Secret's: its hash, set before any instance exists. */
  private async adoptCredential(mapping: ManagedRunner, secret: Secret): Promise<ManagedRunner | null> {
    const tokenHash = sha256(bootstrapCredentialOf(secret)!);
    const runner = await this.prisma.runner.findUnique({ where: { id: mapping.runnerId }, select: { tokenHash: true } });
    if (runner?.tokenHash === tokenHash) return null;
    const now = this.now();
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const { count } = await tx.managedRunner.updateMany({
          where: { id: mapping.id, revision: mapping.revision, leaseHolder: this.holder },
          data: { revision: { increment: 1 }, leaseExpiresAt: this.leaseUntil(now), ...this.settled(mapping) },
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

  /** Take (or keep) the lease: free, expired, or already this replica's. */
  private async acquireLease(id: string): Promise<ManagedRunner | null> {
    const now = this.now();
    const { count } = await this.prisma.managedRunner.updateMany({
      where: { id, OR: [{ leaseHolder: null }, { leaseHolder: this.holder }, { leaseExpiresAt: { lte: now } }] },
      data: { leaseHolder: this.holder, leaseExpiresAt: this.leaseUntil(now) },
    });
    return count === 0 ? null : this.reread(id);
  }

  private async releaseLease(id: string): Promise<void> {
    await this.prisma.managedRunner.updateMany({
      where: { id, leaseHolder: this.holder },
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

  /** Record the one resource operation in flight before it is sent, so a restart knows it may exist. */
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

  /** Keep waiting, unless the startup deadline has passed. */
  private async waitWithin(mapping: ManagedRunner): Promise<Step> {
    if (mapping.startupDeadlineAt && mapping.startupDeadlineAt <= this.now()) {
      return this.fail(mapping, 'STARTUP_TIMEOUT', `no fresh heartbeat by ${mapping.startupDeadlineAt.toISOString()}`);
    }
    return { done: 'WAITING' };
  }

  /**
   * The instance is up and reporting, with no runtime installed and signed in: not READY. Said as
   * MODEL_UNAVAILABLE while the startup deadline lasts — a runtime signed in meanwhile makes the next
   * pass READY — and then FAILED with that cause, retryable, so the owner can retry once one is.
   */
  private async withoutSupply(mapping: ManagedRunner): Promise<Step> {
    if (mapping.startupDeadlineAt && mapping.startupDeadlineAt <= this.now()) {
      return this.fail(mapping, MODEL_UNAVAILABLE, `no runtime installed and signed in by ${mapping.startupDeadlineAt.toISOString()}`);
    }
    if ((mapping.lastError as { code?: unknown } | null)?.code !== MODEL_UNAVAILABLE) {
      await this.commit(mapping, { lastError: { ...managedRunnerReason(MODEL_UNAVAILABLE) } });
    }
    return { done: 'WAITING' };
  }

  private async fail(mapping: ManagedRunner, code: string, detail: string, also: Prisma.ManagedRunnerUpdateManyMutationInput = {}): Promise<Step> {
    await this.commitFailed(mapping, {
      ...also,
      managementState: 'FAILED',
      stateEnteredAt: this.now(),
      nextAttemptAt: null,
      lastError: { ...managedRunnerReason(code), detail },
    });
    return { done: 'FAILED' };
  }

  /**
   * FAILED. Its compute share goes back to the pool in the same transaction when no instance of this
   * generation exists or can exist — none recorded and no Pod create in flight, so there is nothing
   * whose stop would have to be proven first. A recorded or possibly created Pod keeps it: that one
   * is released only through the stop gate. A retry is admitted again from REQUESTED.
   */
  private async commitFailed(mapping: ManagedRunner, data: Prisma.ManagedRunnerUpdateManyMutationInput): Promise<void> {
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
      loggedRetry(this.log, 'managedRunners.failReleasingCompute'),
    );
  }

  /** A transient failure spends one attempt; the last one leaves the mapping FAILED, retryable. */
  private async backoff(mapping: ManagedRunner, error: unknown): Promise<Step> {
    const attempt = mapping.attempt + 1;
    this.log.warn(`managed runner ${mapping.id}: transient failure ${attempt}/${this.profile.lifecycle.maxAttempts}: ${(error as Error).message}`);
    if (attempt >= this.profile.lifecycle.maxAttempts) {
      await this.commitFailed(mapping, {
        attempt,
        managementState: 'FAILED',
        stateEnteredAt: this.now(),
        nextAttemptAt: null,
        lastError: { ...managedRunnerReason('RETRY_EXHAUSTED'), detail: `after ${attempt} attempts` },
      });
      return { done: 'FAILED' };
    }
    const { backoffBaseSeconds, backoffMaxSeconds } = this.profile.lifecycle;
    const ceiling = Math.min(backoffMaxSeconds, backoffBaseSeconds * 2 ** (attempt - 1)) * 1000;
    // Subtractive jitter, at most half: never longer than the ceiling, never in lockstep.
    const delayMs = Math.round(ceiling - ceiling * 0.5 * this.random());
    await this.commit(mapping, {
      attempt,
      nextAttemptAt: new Date(this.now().getTime() + delayMs),
      lastError: { ...managedRunnerReason('TRANSIENT') },
    });
    return { done: 'BACKOFF' };
  }
}
