import type { ManagedRunner } from '@prisma/client';

import {
  KubeAmbiguousError,
  KubeApiError,
  KubeUnreachableError,
  isRetryableKubeError,
  type ManagedKubeClient,
  type PersistentVolume,
  type PersistentVolumeClaim,
  type Pod,
  type PodContainerStatus,
  type Secret,
} from './kube-client';
import { MANAGED_ADMISSION_DENIAL_MARKER } from './managed-runner-admission';
import {
  ManagedRunnerConflict,
  type ManagedCredential,
  type ManagedFencingReceipt,
  type ManagedInstance,
  type ManagedReplacementVolume,
  type ManagedRunnerBackend,
  type ManagedRunnerBackendFailure,
  type ManagedRunnerBackendTerms,
  type ManagedVolume,
  type ManagedVolumeBacking,
  type VerifiedVolume,
} from './managed-runner-backend';
import { capacityBudget, computeShare, storageShare, type CapacityBudget, type ComputeAmounts, type StorageAmounts } from './managed-runner-capacity';
import { observedStop, readFencingReceipt, type ManagedRunnerPredecessor, type ObservedStopProof } from './managed-runner-fencing';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import {
  MANAGED_STOP_REPORT_FINALIZER,
  OWNER_ANNOTATION,
  RUNNER_ANNOTATION,
  bootstrapCredentialOf,
  buildManagedPod,
  buildManagedPvc,
  buildManagedSecret,
  managedAdmissionProbeName,
  managedFencingReceiptName,
  managedPodName,
  managedPvcName,
  managedSecretName,
  podHeldForStopReport,
  podIdentityProblem,
  podStopConfirmed,
  podTerminated,
  pvIdentityProblem,
  pvcIdentityProblem,
  secretGeneration,
  secretIdentityProblem,
  type ManagedRunnerIdentity,
} from './managed-runner-resources';

/**
 * The Kubernetes + Ceph RBD backend (docs/managed-runner-design.md): the managed runner's objects in
 * the one namespace a profile names, through the narrow client of kube-client.ts.
 *
 *   data volume   PVC `mr-data-<runner uuid>` (storage/pvc.template.json), bound to a Ceph-CSI PV
 *   credential    Secret `mr-boot-<runner uuid>`, the runner credential of one generation
 *   instance      bare Pod `mr-<runner uuid>` (runner-pod.yaml.example), behind the admission guard
 *   stop report   the kubelet's terminal container states (podStopConfirmed), kept on the Pod by the
 *                 manager's finalizer until the manager has recorded them, whoever deleted it
 *   released      no VolumeAttachment names the volume's PV
 *   fencing       an operator's receipt in ConfigMap `mr-fence-<runner uuid>`
 *   capacity      the profile's budget, pooled by cluster key and namespace
 *   a switch      an operator's restored claim under the runner's name, judged as its replacement, and the
 *                 recorded PV's attachments, found by its UID and handle (`readReplacement`, `recordedVolumeHolders`)
 *
 * Every method makes the calls the manager made itself before this interface existed, in the same
 * order, with the same identity checks and messages; T04 added the stop-report finalizer's removal
 * to `removeInstance`, and an API server that cannot be reached at all, which spends no attempt.
 */

const TERMS: ManagedRunnerBackendTerms = {
  volume: 'PVC',
  backing: 'PV',
  credential: 'Secret',
  instance: 'Pod',
  stopReport: "its kubelet's report",
};

/** What this backend's observations carry for its own later calls. */
interface KubeVolume extends ManagedVolume {
  readonly pvc: PersistentVolumeClaim;
}
interface KubeBacking extends ManagedVolumeBacking {
  readonly pv: PersistentVolume;
}
interface KubeCredential extends ManagedCredential {
  readonly secret: Secret;
}
interface KubeInstance extends ManagedInstance {
  readonly pod: Pod;
}
interface KubeReplacement extends ManagedReplacementVolume {
  readonly backing: KubeBacking | null;
}

function volumeOf(pvc: PersistentVolumeClaim): KubeVolume {
  return { uid: pvc.metadata.uid!, boundTo: pvc.status?.phase === 'Bound' && pvc.spec.volumeName ? pvc.spec.volumeName : null, pvc };
}

function credentialOf(secret: Secret): KubeCredential {
  const said = secret.metadata.annotations ?? {};
  return {
    ownerId: said[OWNER_ANNOTATION],
    runnerId: said[RUNNER_ANNOTATION],
    generation: secretGeneration(secret),
    token: bootstrapCredentialOf(secret),
    removing: !!secret.metadata.deletionTimestamp,
    secret,
  };
}

/**
 * How a terminal Pod ended, by the kubelet's container states: the runner's exit code, and whether a
 * container ended killed (137) with the runtime's OOMKilled reason — which, like Docker's flag, is
 * also given for a container in which only a child process was killed.
 */
function exitOf(pod: Pod): ManagedInstance['exit'] {
  if (!podTerminated(pod)) return null;
  const ended = (statuses: PodContainerStatus[] | undefined) => (statuses ?? []).flatMap((c) => (c.state?.terminated ? [c.state.terminated] : []));
  const runner = ended(pod.status?.containerStatuses);
  const all = [...ended(pod.status?.initContainerStatuses), ...runner];
  if (all.length === 0) return null;
  return { code: (runner[0] ?? all[0]).exitCode ?? null, outOfMemory: all.some((t) => t.reason === 'OOMKilled' && t.exitCode === 137) };
}

/**
 * Why `pv` was not made for `pvc`, or null when it was. A dynamically provisioned PV is created after its claim;
 * one created before the claim was bound to something else first — a retained volume of another claim, rebound by
 * hand — and is no restore made for this one. Both stamps are the API server's.
 */
function madeForAnother(pv: PersistentVolume, pvc: PersistentVolumeClaim): string | null {
  const made = Date.parse(pv.metadata.creationTimestamp ?? '');
  const claimed = Date.parse(pvc.metadata.creationTimestamp ?? '');
  if (Number.isNaN(made) || Number.isNaN(claimed)) return `when PV ${pv.metadata.name} was made, against PVC ${pvc.metadata.name}, cannot be told`;
  if (made >= claimed) return null;
  return `PV ${pv.metadata.name} was created at ${pv.metadata.creationTimestamp}, before PVC ${pvc.metadata.name} (${pvc.metadata.creationTimestamp}): it was made for another claim first`;
}

function instanceOf(pod: Pod): KubeInstance {
  const terminated = podTerminated(pod);
  return {
    name: pod.metadata.name,
    uid: pod.metadata.uid!,
    node: pod.spec.nodeName ?? null,
    phase: pod.status?.phase,
    running: pod.status?.phase === 'Running',
    terminated,
    stopConfirmed: podStopConfirmed(pod),
    // A deleted Pod that has ended and that the stop-report finalizer still holds does not go by
    // itself: it waits for the manager, which records its stop and then removes it (`removeInstance`).
    removing: !!pod.metadata.deletionTimestamp && !(terminated && podHeldForStopReport(pod)),
    exit: exitOf(pod),
    pod,
  };
}

export class KubernetesBackend implements ManagedRunnerBackend {
  readonly name = 'kubernetes';
  readonly terms = TERMS;
  readonly location: { readonly clusterKey: string; readonly namespace: string };

  constructor(
    private readonly kube: ManagedKubeClient,
    private readonly profile: ManagedRunnerProfile,
  ) {
    this.location = { clusterKey: profile.clusterKey, namespace: profile.kubernetes.namespace };
  }

  names(runnerId: string) {
    return { volume: managedPvcName(runnerId), instance: managedPodName(runnerId), credential: managedSecretName(runnerId) };
  }

  capacityBudget(): CapacityBudget {
    return capacityBudget(this.profile);
  }

  computeShare(): ComputeAmounts {
    return computeShare(this.profile);
  }

  storageShare(): StorageAmounts {
    return storageShare(this.profile);
  }

  // ── the data volume ────────────────────────────────────────────────────────────────────────

  async readVolume(mapping: ManagedRunner): Promise<KubeVolume | null> {
    const pvc = await this.kube.persistentVolumeClaims.get(mapping.pvcName);
    return pvc ? volumeOf(pvc) : null;
  }

  async createVolume(mapping: ManagedRunner): Promise<KubeVolume> {
    return volumeOf(await this.createOrReadBack(this.kube.persistentVolumeClaims, buildManagedPvc(this.identity(mapping), this.profile)));
  }

  volumeProblem(volume: KubeVolume, mapping: ManagedRunner): string | null {
    return pvcIdentityProblem(volume.pvc, this.identity(mapping), this.profile, mapping.pvcUid);
  }

  async readBacking(volume: ManagedVolume): Promise<KubeBacking | null> {
    const pv = await this.kube.getPersistentVolume(volume.boundTo!);
    return pv ? { uid: pv.metadata.uid!, handle: pv.spec.csi?.volumeHandle as string, pv } : null;
  }

  backingProblem(backing: KubeBacking, mapping: ManagedRunner): string | null {
    return pvIdentityProblem(backing.pv, mapping.pvcUid!, this.profile, { pvUid: mapping.pvUid, volumeHandle: mapping.volumeHandle });
  }

  async volumeHolders({ volume }: VerifiedVolume): Promise<string[]> {
    const attachments = await this.kube.listVolumeAttachments();
    return attachments.filter((va) => va.spec.source.persistentVolumeName === volume.boundTo).map((va) => va.metadata.name);
  }

  // ── an operator's switch to a restored volume ──────────────────────────────────────────────

  /**
   * The claim now under the runner's name, judged as the restored volume an operator switches the mapping to
   * (managed-runner-manager.ts, `switchVolume`): the marks every pass checks the mapping's claim for
   * (`pvcIdentityProblem`, its own UID in the recorded one's place), its PV's binding (`pvIdentityProblem`, with
   * nothing of the old PV recorded) and whether that PV was made for it (`madeForAnother`).
   */
  async readReplacement(mapping: ManagedRunner): Promise<KubeReplacement | null> {
    const pvc = await this.kube.persistentVolumeClaims.get(mapping.pvcName);
    if (!pvc) return null;
    const volume = volumeOf(pvc);
    const removing = !!pvc.metadata.deletionTimestamp;
    const marks = pvcIdentityProblem(pvc, this.identity(mapping), this.profile, null);
    const pv = volume.boundTo ? await this.kube.getPersistentVolume(volume.boundTo) : null;
    if (!pv) return { volume, backing: null, removing, problem: marks, foreign: null };
    const backing: KubeBacking = { uid: pv.metadata.uid!, handle: pv.spec.csi?.volumeHandle as string, pv };
    const problem = marks ?? pvIdentityProblem(pv, volume.uid, this.profile, { pvUid: null, volumeHandle: null });
    return { volume, backing, removing, problem, foreign: madeForAnother(pv, pvc) };
  }

  /**
   * The VolumeAttachments of the mapping's recorded PV, found by the PV UID and volume handle the mapping records:
   * the claim under its name is the restored one now, bound to another PV. Every attachment of the restored PV's
   * CSI driver but that PV's own is read back to its PV; one whose PV cannot be read is counted, since it may be
   * the recorded one.
   */
  async recordedVolumeHolders(mapping: ManagedRunner, replacement: KubeReplacement): Promise<string[]> {
    const driver = replacement.backing?.pv.spec.csi?.driver;
    const holders: string[] = [];
    for (const va of await this.kube.listVolumeAttachments()) {
      const name = va.spec.source.persistentVolumeName;
      if (!name || name === replacement.volume.boundTo || (driver && va.spec.attacher !== driver)) continue;
      const pv = await this.kube.getPersistentVolume(name);
      if (!pv) holders.push(`${va.metadata.name} on node ${va.spec.nodeName} (its PV ${name} cannot be read)`);
      else if (pv.metadata.uid === mapping.pvUid || pv.spec.csi?.volumeHandle === mapping.volumeHandle) {
        holders.push(`${va.metadata.name} on node ${va.spec.nodeName} (PV ${name})`);
      }
    }
    return holders;
  }

  // ── the bootstrap credential ───────────────────────────────────────────────────────────────

  async readCredential(mapping: ManagedRunner): Promise<KubeCredential | null> {
    const secret = await this.kube.secrets.get(managedSecretName(mapping.runnerId));
    return secret ? credentialOf(secret) : null;
  }

  async issueCredential(mapping: ManagedRunner, token: string): Promise<KubeCredential> {
    return credentialOf(await this.createOrReadBack(this.kube.secrets, buildManagedSecret(this.identity(mapping), token)));
  }

  credentialProblem(credential: KubeCredential, mapping: ManagedRunner): string | null {
    return secretIdentityProblem(credential.secret, this.identity(mapping));
  }

  async removeCredential(mapping: ManagedRunner, credential: KubeCredential): Promise<void> {
    await this.kube.secrets.delete(managedSecretName(mapping.runnerId), { uid: credential.secret.metadata.uid });
  }

  // ── the instance ───────────────────────────────────────────────────────────────────────────

  async readInstance(mapping: ManagedRunner): Promise<KubeInstance | null> {
    const pod = await this.kube.pods.get(managedPodName(mapping.runnerId));
    return pod ? instanceOf(pod) : null;
  }

  /**
   * Proof that the environment's admission guard is in force (managed-runner-admission.ts): a dry
   * run of a Pod it must refuse — this generation's template under another name — comes back
   * refused by it. Admitted, or refused by anything else, nothing is created.
   */
  async requireInstanceGuard(mapping: ManagedRunner): Promise<void> {
    const probe = buildManagedPod(this.identity(mapping), mapping.pvcUid!, this.profile);
    probe.metadata.name = managedAdmissionProbeName(mapping.runnerId);
    try {
      await this.kube.pods.create(probe, { dryRun: true });
    } catch (error) {
      if (error instanceof KubeApiError && error.message.includes(MANAGED_ADMISSION_DENIAL_MARKER)) return;
      if (isRetryableKubeError(error)) throw error;
      throw new ManagedRunnerConflict('ADMISSION_GUARD_UNVERIFIED', `the admission probe was refused, but not by the guard: ${(error as Error).message}`);
    }
    throw new ManagedRunnerConflict('ADMISSION_GUARD_MISSING', 'a Pod the single-Pod admission guard must refuse was admitted by a dry run');
  }

  async createInstance(mapping: ManagedRunner): Promise<KubeInstance> {
    return instanceOf(await this.createOrReadBack(this.kube.pods, buildManagedPod(this.identity(mapping), mapping.pvcUid!, this.profile)));
  }

  /** A Pod under the fixed name that is not this generation's template. (One that replaced the
   *  recorded Pod UID is the single-writer gate's: the manager fences before it asks.) */
  instanceProblem(instance: KubeInstance, mapping: ManagedRunner): string | null {
    return podIdentityProblem(instance.pod, this.identity(mapping), mapping.pvcUid!);
  }

  /**
   * Released by UID: a successor under the same name is never deleted. Then the stop-report finalizer
   * comes off that same Pod — its stop is recorded, which is all it waited for — and the object goes
   * once its kubelet is done with it, as one without the finalizer would.
   */
  async removeInstance(mapping: ManagedRunner): Promise<void> {
    const name = managedPodName(mapping.runnerId);
    await this.kube.pods.delete(name, { uid: mapping.podUid! });
    await this.releaseStopReport(name, mapping.podUid!);
  }

  // ── stop proof ─────────────────────────────────────────────────────────────────────────────

  observedStop(predecessor: ManagedRunnerPredecessor, instance: KubeInstance, now: Date): ObservedStopProof {
    return observedStop(predecessor, instance.pod, now);
  }

  async readFencingReceipt(
    mapping: ManagedRunner,
    predecessor: ManagedRunnerPredecessor,
    backing: KubeBacking,
    now: Date,
  ): Promise<ManagedFencingReceipt | null> {
    const configMap = await this.kube.configMaps.get(managedFencingReceiptName(mapping.runnerId));
    if (!configMap) return null;
    return { source: configMap.metadata.name, verdict: readFencingReceipt(configMap, predecessor, backing.pv, now) };
  }

  failure(error: unknown): ManagedRunnerBackendFailure | null {
    if (error instanceof KubeUnreachableError) return { retryable: true, unreachable: true };
    if (isRetryableKubeError(error)) return { retryable: true };
    if (!(error instanceof KubeApiError)) return null;
    const log = `Kubernetes answered ${error.status} ${error.reason}: ${error.message}`;
    // A namespace ResourceQuota refused the create — its admission answers 403 with "exceeded quota:
    // <quota>, requested: …, used: …, limited: …" — and nothing was made. Not a permission: room lets
    // the same create through.
    const quota = error.status === 403 ? /exceeded quota: .*/.exec(error.message) : null;
    if (quota) return { retryable: false, waitForRoom: true, code: 'KUBERNETES_QUOTA_EXCEEDED', detail: quota[0], log };
    return {
      retryable: false,
      code: error.status === 401 || error.status === 403 ? 'KUBERNETES_FORBIDDEN' : 'KUBERNETES_REJECTED',
      detail: `HTTP ${error.status} ${error.reason}`.trim(),
      log,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  /**
   * The stop-report finalizer off the Pod `name` with the UID `uid`, if it is still on it. The patch
   * tests the UID and the finalizer it removes, so it changes nothing on a successor, or on a Pod
   * whose finalizers moved since the read; such a Pod is read again on the manager's next pass.
   */
  private async releaseStopReport(name: string, uid: string): Promise<void> {
    const pod = await this.kube.pods.get(name);
    if (!pod || pod.metadata.uid !== uid) return;
    const at = (pod.metadata.finalizers ?? []).indexOf(MANAGED_STOP_REPORT_FINALIZER);
    if (at < 0) return;
    try {
      await this.kube.pods.patch(name, [
        { op: 'test', path: '/metadata/uid', value: uid },
        { op: 'test', path: `/metadata/finalizers/${at}`, value: MANAGED_STOP_REPORT_FINALIZER },
        { op: 'remove', path: `/metadata/finalizers/${at}` },
      ]);
    } catch (error) {
      // A test that did not hold (409 or 422): the Pod changed between the read and the patch.
      if (error instanceof KubeApiError && (error.status === 409 || error.status === 422)) {
        throw new KubeAmbiguousError(`the stop-report finalizer of Pod ${uid} was not removed: the Pod changed meanwhile (${error.message})`);
      }
      // Gone meanwhile: nothing to release.
      if (error instanceof KubeApiError && error.status === 404) return;
      throw error;
    }
  }

  /** What every builder and check needs to know about the mapping. */
  private identity(mapping: ManagedRunner): ManagedRunnerIdentity {
    return { ownerId: mapping.ownerId, runnerId: mapping.runnerId, generation: mapping.generation, namespace: mapping.namespace };
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
}
