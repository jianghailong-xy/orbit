/**
 * The narrow Kubernetes surface the managed runner manager uses: PVCs, Secrets and Pods in the one
 * configured namespace (get, create, delete, list, watch); a read of a PV, whose CSI volume handle
 * is part of a data volume's identity; a list of VolumeAttachments, which says whether that volume
 * is still attached to a node; and a read of a ConfigMap, the only way a fencing receipt reaches the
 * manager (it can read one, never write one). Nothing else — no cluster-scoped writes, no exec, no
 * node or storage administration.
 *
 * Two implementations: `kube-http-client.ts`, constructed only when the feature is enabled and an
 * explicit context and namespace are configured; and the test fake in
 * `test-support/fake-kube-client.ts`. The manager is written against this interface alone.
 */

export interface KubeObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: Array<{ apiVersion: string; kind: string; name: string; uid: string }>;
}

export interface PersistentVolumeClaim {
  apiVersion: 'v1';
  kind: 'PersistentVolumeClaim';
  metadata: KubeObjectMeta;
  spec: {
    storageClassName?: string;
    accessModes?: string[];
    volumeMode?: string;
    resources?: { requests?: { storage?: string } };
    volumeName?: string;
  };
  status?: { phase?: string };
}

export interface PersistentVolume {
  apiVersion: 'v1';
  kind: 'PersistentVolume';
  metadata: KubeObjectMeta;
  spec: {
    storageClassName?: string;
    claimRef?: { namespace?: string; name?: string; uid?: string };
    /** Ceph-CSI states the RBD `pool` and `imageName` in `volumeAttributes`. */
    csi?: { driver?: string; volumeHandle?: string; volumeAttributes?: Record<string, string> };
    persistentVolumeReclaimPolicy?: string;
  };
  status?: { phase?: string };
}

export interface Secret {
  apiVersion: 'v1';
  kind: 'Secret';
  metadata: KubeObjectMeta;
  type?: string;
  immutable?: boolean;
  /** Base64, as the API stores it. */
  data?: Record<string, string>;
}

/** One container's state as the kubelet reports it: exactly one of the three is set. */
export interface PodContainerStatus {
  name: string;
  state?: {
    waiting?: { reason?: string };
    running?: { startedAt?: string };
    terminated?: { exitCode?: number; reason?: string; finishedAt?: string };
  };
}

export interface PodCondition {
  type: string;
  status: string;
  reason?: string;
}

export interface Pod {
  apiVersion: 'v1';
  kind: 'Pod';
  metadata: KubeObjectMeta;
  spec: {
    nodeName?: string;
    volumes?: Array<{ name: string; persistentVolumeClaim?: { claimName: string; readOnly?: boolean }; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  status?: {
    phase?: string;
    startTime?: string;
    reason?: string;
    conditions?: PodCondition[];
    initContainerStatuses?: PodContainerStatus[];
    containerStatuses?: PodContainerStatus[];
  };
}

/** A volume attached, or being attached or detached, to a node (storage.k8s.io/v1, cluster-scoped). */
export interface VolumeAttachment {
  apiVersion: 'storage.k8s.io/v1';
  kind: 'VolumeAttachment';
  metadata: KubeObjectMeta;
  spec: { attacher?: string; nodeName?: string; source: { persistentVolumeName?: string } };
  status?: { attached?: boolean };
}

export interface ConfigMap {
  apiVersion: 'v1';
  kind: 'ConfigMap';
  metadata: KubeObjectMeta;
  data?: Record<string, string>;
}

export type KubeObject = PersistentVolumeClaim | PersistentVolume | Secret | Pod | ConfigMap;

export interface KubeWatchEvent<T> {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';
  object: T;
}

/** An open watch. `done` settles when it ends, by `stop()` or by the server closing it. */
export interface KubeWatch {
  stop(): void;
  readonly done: Promise<void>;
}

export interface KubeDeleteOptions {
  /** Delete only the object with this UID: a successor under the same name is never deleted. */
  uid?: string;
}

export interface KubeCreateOptions {
  /** `dryRun=All`: admission runs and answers, nothing is stored. */
  dryRun?: boolean;
}

/** One namespaced resource of the configured namespace. */
export interface KubeResource<T> {
  /** The object, or null when the API answers 404. */
  get(name: string): Promise<T | null>;
  create(object: T, options?: KubeCreateOptions): Promise<T>;
  /** Resolves once the API accepted the deletion; a 404 resolves too (already gone). */
  delete(name: string, options?: KubeDeleteOptions): Promise<void>;
  list(options?: { labelSelector?: string }): Promise<T[]>;
  watch(
    options: { labelSelector?: string; resourceVersion?: string },
    onEvent: (event: KubeWatchEvent<T>) => void,
  ): KubeWatch;
}

export interface ManagedKubeClient {
  /** The one namespace every resource below is addressed in. */
  readonly namespace: string;
  readonly persistentVolumeClaims: KubeResource<PersistentVolumeClaim>;
  readonly secrets: KubeResource<Secret>;
  readonly pods: KubeResource<Pod>;
  /** Read-only: where an operator leaves a fencing receipt (managed-runner-fencing.ts). */
  readonly configMaps: Pick<KubeResource<ConfigMap>, 'get'>;
  /** Read-only and cluster-scoped: the PV a bound claim names, or null on 404. */
  getPersistentVolume(name: string): Promise<PersistentVolume | null>;
  /** Read-only and cluster-scoped: every VolumeAttachment, whatever its node or volume. */
  listVolumeAttachments(): Promise<VolumeAttachment[]>;
}

/**
 * The API answered, and said no — or said the object already exists (409). Definite: whatever was
 * asked did not happen, except a 409 AlreadyExists, which says an object of that name is there.
 */
export class KubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'KubeApiError';
  }
}

/**
 * No definite answer: a timeout, a dropped connection, or a gateway/server error after the request
 * may have been applied. A write that ends this way has to be read back by name and compared
 * before anything is retried.
 */
export class KubeAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KubeAmbiguousError';
  }
}

/**
 * Whether an error is transient: worth another attempt later, once a write that may have taken
 * effect has been read back. Throttling (429) and server errors are; every other answer is definite.
 */
export function isRetryableKubeError(error: unknown): boolean {
  if (error instanceof KubeAmbiguousError) return true;
  return error instanceof KubeApiError && (error.status === 429 || error.status >= 500);
}
