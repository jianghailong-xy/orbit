import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { Prisma, type ManagedRunner } from '@prisma/client';
import { MODEL_UNAVAILABLE, type ManagedRunnerReason } from '@orbit/shared';

import { generateToken, sha256 } from '../common/crypto.util';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import { KubeApiError, isRetryableKubeError, type ManagedKubeClient, type PersistentVolumeClaim, type Pod, type Secret } from './kube-client';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import {
  bootstrapCredentialOf,
  buildManagedPod,
  buildManagedPvc,
  buildManagedSecret,
  managedPodName,
  managedSecretName,
  podIdentityProblem,
  podTerminated,
  pvIdentityProblem,
  pvcIdentityProblem,
  secretIdentityProblem,
  type ManagedRunnerIdentity,
} from './managed-runner-resources';
import { managedRuntimeSupply, type ManagedSupplyRunner } from './managed-runner-supply';

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
 * holds is not what the mapping recorded. It never deletes a PVC, a Secret, a runner row or a
 * workspace. The only object it deletes is a Pod that has already terminated, and only when an
 * explicit retry asked for a fresh start, by UID.
 *
 * Left to the work that follows, at the places marked below: capacity admission (WAITING_CAPACITY),
 * sleep/wake/drain, deletion, and the single-writer gate — replacing a predecessor Pod needs proof
 * that it stopped, or a fencing receipt, before the generation may advance. Until that gate exists
 * a vanished or replaced predecessor leaves the mapping FAILED with the disk kept.
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
  /** A state this version does not drive (sleep, deletion, capacity wait), or a non-RUNNING desire. */
  | 'IDLE'
  | 'NOT_FOUND';

/** Capacity admission, before any resource is created. This version admits everything. */
export type ManagedRunnerAdmission =
  | { admitted: true }
  | { admitted: false; reason: ManagedRunnerReason; retryAfter: Date };

export interface ManagedRunnerManagerOptions {
  /** This replica's lease identity. */
  holder?: string;
  now?: () => Date;
  random?: () => number;
  /** The capacity admission hook (WAITING_CAPACITY). Default: admitted. */
  admit?: (mapping: ManagedRunner) => Promise<ManagedRunnerAdmission>;
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

/** The client-safe sentence for each cause. Raw infrastructure errors stay in the server log. */
const REASONS: Record<string, { message: string; retryable: boolean }> = {
  TRANSIENT: { message: 'A transient infrastructure error interrupted provisioning; it is retried automatically.', retryable: true },
  RETRY_EXHAUSTED: { message: 'Provisioning kept failing on transient infrastructure errors and stopped. It can be retried.', retryable: true },
  STARTUP_TIMEOUT: { message: 'The runner did not report in before its startup deadline. It can be retried.', retryable: true },
  [MODEL_UNAVAILABLE]: {
    message: 'The runner is up, but none of its runtimes is installed and signed in, so it cannot start a session. Sign one in from Infrastructure; a runner that has stopped waiting for it can then be retried.',
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
    message: 'The previous runner instance is gone or was replaced, and its stop is not proven, so no new instance is started and the data volume is kept. An operator has to confirm the stop.',
    retryable: false,
  },
};

export function managedRunnerReason(code: string): ManagedRunnerReason {
  const known = REASONS[code];
  return { code, message: known?.message ?? 'The managed runner could not be provisioned.', retryable: known?.retryable ?? false };
}

/** What a step decided: stop the pass with an outcome, or go on from the row it committed. */
type Step = { done: ReconcileOutcome } | { next: ManagedRunner };

const ACTIVE_STATES = ['REQUESTED', 'PROVISIONING', 'STARTING', 'READY'] as const;
/** A pass takes at most this many steps; the worker's next pass continues. */
const MAX_STEPS_PER_PASS = 12;

export class ManagedRunnerManager {
  readonly holder: string;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly admit: (mapping: ManagedRunner) => Promise<ManagedRunnerAdmission>;
  private readonly log: Pick<Logger, 'warn' | 'error'>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kube: ManagedKubeClient,
    private readonly profile: ManagedRunnerProfile,
    options: ManagedRunnerManagerOptions = {},
  ) {
    this.holder = options.holder ?? randomUUID();
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.admit = options.admit ?? (async () => ({ admitted: true }));
    this.log = options.log ?? new Logger('ManagedRunnerManager');
  }

  /** The mappings a pass should visit now: RUNNING, in a state this version drives, not backing off. */
  async dueMappings(limit: number): Promise<string[]> {
    const rows = await this.prisma.managedRunner.findMany({
      where: {
        desiredState: 'RUNNING',
        managementState: { in: [...ACTIVE_STATES] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: this.now() } }],
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
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
    if (mapping.desiredState !== 'RUNNING') return { done: 'IDLE' };
    if (!(ACTIVE_STATES as readonly string[]).includes(mapping.managementState)) {
      return { done: mapping.managementState === 'FAILED' ? 'FAILED' : 'IDLE' };
    }
    if (mapping.nextAttemptAt && mapping.nextAttemptAt > this.now()) return { done: 'BACKOFF' };
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
        case 'PROVISIONING':
          return await this.provisioning(mapping);
        case 'STARTING':
          return await this.starting(mapping);
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
    // An explicit retry after the instance stopped: release the terminated Pod object (by UID, so a
    // successor under the same name is never deleted). The runner row, the workspace, the PVC and
    // the Secret stay; replacing the instance is the single-writer gate's decision (`starting`).
    if (mapping.podUid) {
      const pod = await this.kube.pods.get(managedPodName(mapping.runnerId));
      if (pod && pod.metadata.uid === mapping.podUid && podTerminated(pod) && !pod.metadata.deletionTimestamp) {
        const begun = await this.beginOperation(mapping, 'DELETE_POD');
        await this.kube.pods.delete(managedPodName(mapping.runnerId), { uid: mapping.podUid });
        return { next: await this.commit(begun, { resourceOperationState: 'COMPLETED' }) };
      }
    }
    // Capacity admission (WAITING_CAPACITY) is decided here, before any resource exists.
    const admission = await this.admit(mapping);
    if (!admission.admitted) {
      await this.commit(mapping, {
        managementState: 'WAITING_CAPACITY',
        stateEnteredAt: this.now(),
        lastError: { ...admission.reason },
        nextAttemptAt: admission.retryAfter,
      });
      return { done: 'IDLE' };
    }
    const now = this.now();
    return {
      next: await this.commit(mapping, {
        managementState: 'PROVISIONING',
        stateEnteredAt: now,
        startupDeadlineAt: new Date(now.getTime() + this.profile.lifecycle.startupDeadlineSeconds * 1000),
        lastError: Prisma.DbNull,
      }),
    };
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
      // The single-writer gate: the recorded instance is gone, and nothing proves it stopped writing.
      // A successor needs that proof or a fencing receipt before the generation may advance.
      throw new Conflict('PREDECESSOR_STOP_UNPROVEN', `Pod ${mapping.podUid} of generation ${mapping.generation} is gone without a stop proof`);
    }
    if (!pod) {
      const begun = await this.beginOperation(mapping, 'CREATE_POD');
      pod = await this.createOrReadBack(this.kube.pods, buildManagedPod(this.identity(begun), begun.pvcUid!, this.profile));
      return { next: await this.recordPod(begun, pod) };
    }
    this.checkPod(mapping, pod);
    if (pod.metadata.uid !== mapping.podUid || (pod.spec.nodeName ?? null) !== mapping.nodeName) {
      return { next: await this.recordPod(mapping, pod) };
    }
    // A released instance still being removed: wait for it to go, then the gate above decides.
    if (pod.metadata.deletionTimestamp) return this.waitWithin(mapping);
    if (podTerminated(pod)) return this.fail(mapping, 'POD_TERMINATED', `Pod ${pod.metadata.uid} is ${pod.status?.phase}`);
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
      throw new Conflict('PREDECESSOR_STOP_UNPROVEN', `Pod ${mapping.podUid} of generation ${mapping.generation} is gone without a stop proof`);
    }
    this.checkPod(mapping, pod);
    if (podTerminated(pod)) return this.fail(mapping, 'POD_TERMINATED', `Pod ${pod.metadata.uid} is ${pod.status?.phase}`);
    // A stale heartbeat makes READY unusable (the status says so); it is not proof the instance died.
    return { done: 'READY' };
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
  private async verifyStorage(mapping: ManagedRunner): Promise<void> {
    const pvc = await this.kube.persistentVolumeClaims.get(mapping.pvcName);
    if (!pvc) throw new Conflict('PVC_MISSING', `PVC ${mapping.pvcName} (${mapping.pvcUid}) is gone`);
    const problem = pvcIdentityProblem(pvc, this.identity(mapping), this.profile, mapping.pvcUid);
    if (problem) throw new Conflict('PVC_CONFLICT', problem);
    if (pvc.status?.phase !== 'Bound' || !pvc.spec.volumeName) throw new Conflict('PVC_CONFLICT', 'the recorded PVC is no longer bound');
    const pv = await this.kube.getPersistentVolume(pvc.spec.volumeName);
    if (!pv) throw new Conflict('PV_CONFLICT', `PV ${pvc.spec.volumeName} is gone`);
    const pvProblem = pvIdentityProblem(pv, mapping.pvcUid!, this.profile, { pvUid: mapping.pvUid, volumeHandle: mapping.volumeHandle });
    if (pvProblem) throw new Conflict('PV_CONFLICT', pvProblem);
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

  private checkPod(mapping: ManagedRunner, pod: Pod): void {
    const problem = podIdentityProblem(pod, this.identity(mapping), mapping.pvcUid!);
    if (problem) throw new Conflict('POD_CONFLICT', problem);
    if (mapping.podUid && pod.metadata.uid !== mapping.podUid) {
      // Same name and generation, another incarnation: the recorded Pod was replaced without the gate.
      throw new Conflict('PREDECESSOR_STOP_UNPROVEN', `Pod ${mapping.podUid} was replaced by ${pod.metadata.uid} without a stop proof`);
    }
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
  private beginOperation(mapping: ManagedRunner, kind: 'CREATE_PVC' | 'CREATE_SECRET' | 'CREATE_POD' | 'DELETE_POD'): Promise<ManagedRunner> {
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

  private async fail(mapping: ManagedRunner, code: string, detail: string): Promise<Step> {
    await this.commit(mapping, {
      managementState: 'FAILED',
      stateEnteredAt: this.now(),
      nextAttemptAt: null,
      lastError: { ...managedRunnerReason(code), detail },
    });
    return { done: 'FAILED' };
  }

  /** A transient failure spends one attempt; the last one leaves the mapping FAILED, retryable. */
  private async backoff(mapping: ManagedRunner, error: unknown): Promise<Step> {
    const attempt = mapping.attempt + 1;
    this.log.warn(`managed runner ${mapping.id}: transient failure ${attempt}/${this.profile.lifecycle.maxAttempts}: ${(error as Error).message}`);
    if (attempt >= this.profile.lifecycle.maxAttempts) {
      await this.commit(mapping, {
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
