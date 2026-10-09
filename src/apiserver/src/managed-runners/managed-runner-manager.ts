import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { Prisma, type ManagedRunner } from '@prisma/client';
import { MODEL_UNAVAILABLE, type ManagedRunnerReason } from '@orbit/shared';

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
 * Left to the work that follows: capacity admission (WAITING_CAPACITY), sleep/wake/drain and
 * deletion.
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
};

export function managedRunnerReason(code: string): ManagedRunnerReason {
  const known = REASONS[code];
  return { code, message: known?.message ?? 'The managed runner could not be provisioned.', retryable: known?.retryable ?? false };
}

/** What a step decided: stop the pass with an outcome, or go on from the row it committed. */
type Step = { done: ReconcileOutcome } | { next: ManagedRunner };

const ACTIVE_STATES = ['REQUESTED', 'PROVISIONING', 'STARTING', 'READY', 'FENCING'] as const;
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
        case 'FENCING':
          return (await this.replacePredecessor(mapping)) ?? { done: 'FENCING' };
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
    return { done: 'READY' };
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
    await this.commit(mapping, {
      ...also,
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
