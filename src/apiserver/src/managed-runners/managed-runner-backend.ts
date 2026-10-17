import type { ManagedRunner } from '@prisma/client';

import type { CapacityBudget, ComputeAmounts, StorageAmounts } from './managed-runner-capacity';
import type { FencingReceiptVerdict, ManagedRunnerPredecessor, ObservedStopProof } from './managed-runner-fencing';

/**
 * Where a managed runner's data volume lives and its instance runs: the one surface between the
 * manager's state machine (managed-runner-manager.ts — admission, provisioning, the single-writer
 * gate, wake, sleep and a disabled owner's runner, none of which knows what runs underneath) and the
 * infrastructure (docs/managed-runner-design.md, "Implementation record: run backends").
 *
 *   kubernetes   KubernetesBackend (kubernetes-backend.ts): a Ceph RBD filesystem PVC, the bootstrap
 *                Secret of each generation, and one bare Pod under a fixed name.
 *   docker       named, not implemented: one host's local volume and container (task D2). A profile
 *                that chooses it leaves the feature unavailable (managed-runner-profile.ts); nothing
 *                is run on Kubernetes in its place.
 *
 * A backend observes and acts; it decides nothing and writes no database row. The manager reads an
 * observation, decides, records what it is about to do on the mapping (a pending resource operation),
 * asks the backend to do it and records the result: so the calls below come one at a time, each
 * between two compare-and-sets of the mapping, never inside a transaction.
 *
 * What every implementation keeps, because the manager's safety rests on it:
 *
 *   - Names. A runner's objects are found by fixed names derived from its UUID alone (`names`); the
 *     mapping's CHECK holds the volume's and the instance's to `mr-data-<uuid>` and `mr-<uuid>`. A
 *     create under such a name meets the same object, never a second one.
 *   - Create once. A create that fails in any way is followed by a read of the same name, and an
 *     object found there is returned: a timed-out create that did commit is adopted, never made
 *     twice. Only when nothing is there is the error passed on.
 *   - Identity. Whatever is found under a name is checked against the mapping before it is used or
 *     recorded (`volumeProblem`, `backingProblem`, `credentialProblem`, `instanceProblem`): another
 *     owner's, runner's, generation's or volume's object is a problem an operator reviews, never
 *     adopted, replaced or deleted.
 *   - Retention. No method removes a data volume. A volume belongs to no instance (no owner object,
 *     nothing that cascades) and outlives sleep, replacement, failure and the switch turned off.
 *   - Instance identity. An instance is made for one generation and runs with it, and the backend
 *     gives it a UID it never reuses (Kubernetes: the Pod UID, which the runner reads through the
 *     Downward API). The manager records that UID, and the runner door authorizes only the recorded
 *     generation and UID (managed-runner-instance.ts), so it has to be a canonical UUID.
 *   - Stopping. No method stops a running instance. An instance stops by itself — it accepted a
 *     sleep request in its heartbeat, or its owner's account was disabled and the runner door
 *     refuses it — and nothing is forced (docs/managed-runner-design.md, "Implementation record:
 *     capacity, wake and sleep"). The backend reports that stop: `ManagedInstance.terminated`, and
 *     `stopConfirmed` when the host itself vouches every process ended, which is half a stop proof.
 *   - Removal by UID. An instance or a credential is removed only by the UID it was observed with,
 *     so a successor under the same name is never removed; and an instance only once its stop is
 *     proven (the manager's gate).
 *   - Release. A volume is released when nothing holds it any more (`volumeHolders` is empty —
 *     Kubernetes: no VolumeAttachment names its PV). The gate needs that before the next generation
 *     starts or compute goes back to the pool.
 *   - Capacity. The backend names its pool (`location`, which is also where a new mapping's volume
 *     lives) and where its budget comes from (`capacityBudget`): configuration, never usage the
 *     infrastructure reports. A runner's share (`computeShare`, `storageShare`) is what one instance
 *     and one volume reserve.
 *
 * An observation goes back only to the backend that made it, which may read its own fields of it.
 */

/** Every backend a profile may name. `docker` is named and not implemented yet. */
export const MANAGED_RUNNER_BACKENDS = ['kubernetes', 'docker'] as const;
export type ManagedRunnerBackendName = (typeof MANAGED_RUNNER_BACKENDS)[number];

/** The words the manager's operator details and logs use for a backend's objects. Never client copy. */
export interface ManagedRunnerBackendTerms {
  /** The data volume object (Kubernetes: `PVC`). */
  readonly volume: string;
  /** The storage a bound volume names (Kubernetes: `PV`). */
  readonly backing: string;
  /** The bootstrap credential object (Kubernetes: `Secret`). */
  readonly credential: string;
  /** The instance object (Kubernetes: `Pod`). */
  readonly instance: string;
  /** Whose report proves an instance stopped (Kubernetes: `its kubelet's report`). */
  readonly stopReport: string;
}

/** A runner's data volume, as found under its name. */
export interface ManagedVolume {
  /** Its own identity, never reused (Kubernetes: the PVC UID). Recorded as `pvcUid`. */
  readonly uid: string;
  /** The storage it is bound to, by name, or null while it is not bound (Kubernetes: the PV of a Bound claim). */
  readonly boundTo: string | null;
}

/** The storage behind a bound volume. */
export interface ManagedVolumeBacking {
  /** Recorded as `pvUid` (Kubernetes: the PV UID). */
  readonly uid: string;
  /** The storage's own handle (Kubernetes: the CSI volume handle). Recorded as `volumeHandle`; no second mapping may record it. */
  readonly handle: string;
}

/** A recorded volume found as recorded: bound, and to the recorded storage. */
export interface VerifiedVolume {
  readonly volume: ManagedVolume;
  readonly backing: ManagedVolumeBacking;
}

/** The bootstrap credential of a generation, as found under its name. */
export interface ManagedCredential {
  /** The owner and runner it says it was issued for. */
  readonly ownerId: string | undefined;
  readonly runnerId: string | undefined;
  /** The generation it says it was issued for, or null when it says none. */
  readonly generation: number | null;
  /** The credential it carries, or null when it carries none. */
  readonly token: string | null;
  /** Its removal was asked and it is not gone yet. */
  readonly removing: boolean;
}

/** A runner's instance, as found under its name. */
export interface ManagedInstance {
  /** Its fixed name. Recorded as `podName`. */
  readonly name: string;
  /** Its own identity, never reused (Kubernetes: the Pod UID). Recorded as `podUid`. */
  readonly uid: string;
  /** The machine it was placed on, or null before it is placed (Kubernetes: the node). Recorded as `nodeName`. */
  readonly node: string | null;
  /** Where it is, in the backend's own word (Kubernetes: the Pod phase): operator details only. */
  readonly phase: string | undefined;
  /** Up, so a runner in it can report in (Kubernetes: phase Running). */
  readonly running: boolean;
  /** Finished, never to start again (Kubernetes: Succeeded or Failed). */
  readonly terminated: boolean;
  /** Terminated, and the host itself reported every process of it ended (Kubernetes: the kubelet's
   *  terminal container states, with no sign the control plane declared it on the node's behalf). */
  readonly stopConfirmed: boolean;
  /** Its removal was asked and it is not gone yet. */
  readonly removing: boolean;
}

/** A fencing receipt left for an instance, and what reading it concluded. */
export interface ManagedFencingReceipt {
  /** Where it was found (Kubernetes: the ConfigMap's name), for the log. */
  readonly source: string;
  readonly verdict: FencingReceiptVerdict;
}

/** What a failed backend call means for the manager. */
export type ManagedRunnerBackendFailure =
  /** Worth another attempt later, once whatever it may have done has been read back. */
  | { readonly retryable: true }
  /** A definite refusal: the mapping fails with `code` (a reason the manager's table words). */
  | { readonly retryable: false; readonly code: string; readonly detail: string; readonly log: string };

/**
 * What the infrastructure holds is not what the mapping recorded, or is not safe to use: an operator
 * has to look. Thrown by the manager and by a backend; the mapping fails with `code`, nothing retried.
 */
export class ManagedRunnerConflict extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'ManagedRunnerConflict';
  }
}

export interface ManagedRunnerBackend {
  readonly name: ManagedRunnerBackendName;
  readonly terms: ManagedRunnerBackendTerms;
  /** Where this backend's mappings live: recorded on every new mapping, and the key of its capacity pool. */
  readonly location: { readonly clusterKey: string; readonly namespace: string };

  /** The fixed names of one runner's objects, from its UUID alone. */
  names(runnerId: string): { volume: string; instance: string; credential: string };

  // ── capacity ──
  /** The pool's totals, from configuration. */
  capacityBudget(): CapacityBudget;
  /** What one running instance reserves from the pool. */
  computeShare(): ComputeAmounts;
  /** What one data volume reserves from the pool, for as long as it exists. */
  storageShare(): StorageAmounts;

  // ── the data volume: ensured, read, retained ──
  readVolume(mapping: ManagedRunner): Promise<ManagedVolume | null>;
  /** Create the mapping's volume (create once, see above). */
  createVolume(mapping: ManagedRunner): Promise<ManagedVolume>;
  /** Why the volume found under the mapping's name is not its data volume, or null when it is. A recorded UID must match. */
  volumeProblem(volume: ManagedVolume, mapping: ManagedRunner): string | null;
  /** The storage a bound volume names, or null when it is not there (yet). */
  readBacking(volume: ManagedVolume): Promise<ManagedVolumeBacking | null>;
  /** Why that storage is not the recorded one, or null when it is. */
  backingProblem(backing: ManagedVolumeBacking, mapping: ManagedRunner): string | null;
  /** What still holds a verified volume on a machine (Kubernetes: its VolumeAttachments). Empty: released. */
  volumeHolders(volume: VerifiedVolume): Promise<string[]>;

  // ── the instance credential ──
  readCredential(mapping: ManagedRunner): Promise<ManagedCredential | null>;
  /** Deliver `token`, the credential of the mapping's generation, where its instance reads it (create once). */
  issueCredential(mapping: ManagedRunner, token: string): Promise<ManagedCredential>;
  /** Why the credential found under the mapping's name is not its generation's, or null when it is. */
  credentialProblem(credential: ManagedCredential, mapping: ManagedRunner): string | null;
  /** Remove a retired generation's credential, by the identity it was read with. */
  removeCredential(mapping: ManagedRunner, credential: ManagedCredential): Promise<void>;

  // ── the instance ──
  readInstance(mapping: ManagedRunner): Promise<ManagedInstance | null>;
  /**
   * Prove the backend's single-instance guard is in force before any instance is created (Kubernetes:
   * a dry run of a Pod the admission guard must refuse comes back refused by it). Throws a
   * ManagedRunnerConflict when it is missing or cannot be shown; a transient failure as it came.
   */
  requireInstanceGuard(mapping: ManagedRunner): Promise<void>;
  /** Create the one instance of the mapping's generation on its recorded volume (create once). */
  createInstance(mapping: ManagedRunner): Promise<ManagedInstance>;
  /** Why the instance found under the mapping's name is not its generation's, or null when it is. */
  instanceProblem(instance: ManagedInstance, mapping: ManagedRunner): string | null;
  /** Remove the recorded instance (`mapping.podUid`), by that UID. Called only once its stop is proven. */
  removeInstance(mapping: ManagedRunner): Promise<void>;

  // ── stop proof ──
  /** The recorded proof of an instance's own stop. The caller has checked `stopConfirmed`. */
  observedStop(predecessor: ManagedRunnerPredecessor, instance: ManagedInstance, now: Date): ObservedStopProof;
  /** The fencing receipt an operator left for the predecessor, read and judged; null when there is none. */
  readFencingReceipt(
    mapping: ManagedRunner,
    predecessor: ManagedRunnerPredecessor,
    backing: ManagedVolumeBacking,
    now: Date,
  ): Promise<ManagedFencingReceipt | null>;

  /** What a failure of one of the calls above means; null for an error that is not the backend's. */
  failure(error: unknown): ManagedRunnerBackendFailure | null;
}
