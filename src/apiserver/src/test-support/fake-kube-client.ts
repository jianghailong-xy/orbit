import { randomUUID } from 'node:crypto';

import {
  KubeAmbiguousError,
  KubeApiError,
  type ConfigMap,
  type KubeObject,
  type KubeResource,
  type KubeWatchEvent,
  type ManagedKubeClient,
  type PersistentVolume,
  type PersistentVolumeClaim,
  type Pod,
  type Secret,
  type VolumeAttachment,
} from '../managed-runners/kube-client';
import type { PodAdmissionRequest } from '../managed-runners/managed-runner-admission';
import { TEST_MANAGER_USERNAME } from './managed-runner-profile.fixture';

/**
 * An in-memory Kubernetes namespace for managed runner tests: the resources the manager uses, plus
 * the PVs claims bind to and the VolumeAttachments of the volumes Pods use. Several clients —
 * several manager replicas — share one cluster.
 *
 * What it imitates of the API server: one object per name (a second create is 409 AlreadyExists),
 * server-assigned UIDs, delete preconditions by UID, label-selected list and watch, dry-run creates,
 * and — once a test installs one — a validating admission webhook every Pod create and update
 * passes through, with `failurePolicy: Fail` (a webhook that throws refuses the Pod). What a test
 * scripts: binding (a claim binds to a fresh CSI-backed PV at once unless `autoBind` is off), the
 * phase a Pod is created in, attachment (a Pod's volume is attached to its node when it is stored,
 * and detached when the last Pod using it is gone unless `autoDetach` is off), and faults — a
 * create that commits and then times out, one that times out without committing, or a server
 * error — consumed in order by the matching call.
 */

type Kind = 'persistentvolumeclaims' | 'secrets' | 'pods' | 'configmaps';
export type FakeKubeOp =
  | 'get'
  | 'create'
  | 'dryRunCreate'
  | 'delete'
  | 'list'
  | 'watch'
  | 'getPersistentVolume'
  | 'listVolumeAttachments';

/** The installed admission webhook: refused, it says why. Throwing is the webhook failing. */
export type FakeAdmissionWebhook = (request: PodAdmissionRequest) => Promise<{ allowed: boolean; message?: string }>;

/** The name the fake API server gives the webhook in its refusals, as a ValidatingWebhookConfiguration would. */
export const FAKE_ADMISSION_WEBHOOK_NAME = 'pods.managed-runner.orbit.dev';

export interface FakeKubeFault {
  op: FakeKubeOp;
  kind?: Kind;
  /**
   * `commit-then-timeout`: the object is stored, and the caller is told nothing definite.
   * `timeout`: nothing is stored, and the caller is told nothing definite.
   * `status`: nothing is stored; the API answers `status`.
   */
  mode: 'commit-then-timeout' | 'timeout' | 'status';
  status?: number;
  /** How many matching calls it applies to; Infinity until cleared. Default 1. */
  times?: number;
}

export interface FakeKubeCall {
  op: FakeKubeOp;
  kind?: Kind;
  name?: string;
}

const clone = <T>(value: T): T => structuredClone(value);

export class FakeKubeCluster {
  readonly calls: FakeKubeCall[] = [];
  readonly persistentVolumes = new Map<string, PersistentVolume>();
  readonly volumeAttachments = new Map<string, VolumeAttachment>();
  /** Bind each new claim to a fresh PV at once. */
  autoBind = true;
  /** Detach a volume as soon as no stored Pod uses it. Off: it stays attached until `detach`. */
  autoDetach = true;
  /** The phase a new Pod is stored in. */
  podPhase = 'Running';
  /** The node a new Pod is scheduled on. */
  podNode = 'node-a';
  /** The validating admission webhook Pod creates and updates pass through; none until installed. */
  admission?: FakeAdmissionWebhook;
  private readonly stores: Record<Kind, Map<string, KubeObject>> = {
    persistentvolumeclaims: new Map(),
    secrets: new Map(),
    pods: new Map(),
    configmaps: new Map(),
  };
  private faults: FakeKubeFault[] = [];
  private version = 1;
  private readonly watchers: Array<{ kind: Kind; selector?: string; onEvent: (event: KubeWatchEvent<KubeObject>) => void }> = [];

  constructor(readonly namespace = 'orbit-managed-test') {}

  /**
   * A client of this cluster, as one manager replica holds it. `delayMs` interleaves concurrent
   * callers; `username` is who the API server says is calling (the manager's identity by default).
   */
  client(options: { delayMs?: number; username?: string } = {}): ManagedKubeClient {
    const pause = async () => {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
    };
    const username = options.username ?? TEST_MANAGER_USERNAME;
    const configMaps = this.resource<ConfigMap>('configmaps', pause, username);
    return {
      namespace: this.namespace,
      persistentVolumeClaims: this.resource<PersistentVolumeClaim>('persistentvolumeclaims', pause, username),
      secrets: this.resource<Secret>('secrets', pause, username),
      pods: this.resource<Pod>('pods', pause, username),
      configMaps: { get: configMaps.get },
      getPersistentVolume: async (name) => {
        await pause();
        this.calls.push({ op: 'getPersistentVolume', name });
        this.fault('getPersistentVolume');
        const pv = this.persistentVolumes.get(name);
        return pv ? clone(pv) : null;
      },
      listVolumeAttachments: async () => {
        await pause();
        this.calls.push({ op: 'listVolumeAttachments' });
        this.fault('listVolumeAttachments');
        return [...this.volumeAttachments.values()].map((va) => clone(va));
      },
    };
  }

  /**
   * A Pod created through the API server by someone other than the manager — a tenant, an
   * operator, a controller — through the same admission and name uniqueness the manager meets.
   */
  async submitPod(pod: Pod, options: { username: string; dryRun?: boolean }): Promise<Pod> {
    return this.resource<Pod>('pods', async () => undefined, options.username).create(pod, { dryRun: options.dryRun });
  }

  /** An update of a stored Pod through the API server, admission included (`subResource` as sent). */
  async updatePod(name: string, change: (pod: Pod) => void, options: { username: string; subResource?: string }): Promise<Pod> {
    const before = this.stores.pods.get(name) as Pod | undefined;
    if (!before) throw new KubeApiError(404, 'NotFound', `pods "${name}" not found`);
    const after = clone(before);
    change(after);
    await this.admit('UPDATE', after, before, options.username, false, options.subResource);
    after.metadata.resourceVersion = String(this.version++);
    this.stores.pods.set(name, after);
    this.emit('pods', 'MODIFIED', after);
    return clone(after);
  }

  /** The kubelet reports every container of a stored Pod stopped: a terminal phase it vouches for. */
  stopPod(name: string, exitCode = 0): void {
    this.mutate<Pod>('pods', name, (pod) => {
      const finishedAt = new Date().toISOString();
      const statuses = (key: 'initContainers' | 'containers') =>
        (Array.isArray(pod.spec[key]) ? (pod.spec[key] as Array<{ name: string }>) : []).map((c) => ({
          name: c.name,
          state: { terminated: { exitCode: key === 'initContainers' ? 0 : exitCode, reason: exitCode ? 'Error' : 'Completed', finishedAt } },
        }));
      pod.status = {
        ...pod.status,
        phase: exitCode ? 'Failed' : 'Succeeded',
        initContainerStatuses: statuses('initContainers'),
        containerStatuses: statuses('containers'),
      };
    });
  }

  /** PodGC marks a Pod of an unreachable or out-of-service node Failed: the API's word, not the kubelet's. */
  markFailedByControlPlane(name: string): void {
    this.mutate<Pod>('pods', name, (pod) => {
      pod.status = {
        ...pod.status,
        phase: 'Failed',
        conditions: [...(pod.status?.conditions ?? []), { type: 'DisruptionTarget', status: 'True', reason: 'DeletionByPodGC' }],
      };
    });
  }

  /** The volume's attachment is gone, as the attach/detach controller would remove it. */
  detach(pvName: string): void {
    for (const [name, va] of this.volumeAttachments) if (va.spec.source.persistentVolumeName === pvName) this.volumeAttachments.delete(name);
  }

  inject(fault: FakeKubeFault): void {
    this.faults.push({ times: 1, ...fault });
  }

  clearFaults(): void {
    this.faults = [];
  }

  count(op: FakeKubeOp, kind?: Kind): number {
    return this.calls.filter((call) => call.op === op && (kind === undefined || call.kind === kind)).length;
  }

  /** Every object of `kind`, as stored. */
  all<T extends KubeObject>(kind: Kind): T[] {
    return [...this.stores[kind].values()].map((object) => clone(object) as T);
  }

  object<T extends KubeObject>(kind: Kind, name: string): T | undefined {
    const found = this.stores[kind].get(name);
    return found ? (clone(found) as T) : undefined;
  }

  /** Put an object in place as an operator or another tool would — not through the manager. */
  plant<T extends KubeObject>(kind: Kind, object: T): T {
    return this.store(kind, clone(object));
  }

  /** Change a stored object in place (phase, annotations…) as the cluster would. */
  mutate<T extends KubeObject>(kind: Kind, name: string, change: (object: T) => void): void {
    const found = this.stores[kind].get(name) as T | undefined;
    if (!found) throw new Error(`no ${kind} ${name}`);
    change(found);
    found.metadata.resourceVersion = String(this.version++);
    this.emit(kind, 'MODIFIED', found);
  }

  /** Remove an object as an operator would, whatever its UID. */
  remove(kind: Kind, name: string): void {
    const found = this.stores[kind].get(name);
    if (!found) return;
    this.stores[kind].delete(name);
    if (kind === 'pods') this.detachUnused();
    this.emit(kind, 'DELETED', found);
  }

  /** Bind a pending claim to a fresh PV with a CSI volume handle. */
  bind(name: string): PersistentVolume {
    const pvc = this.stores.persistentvolumeclaims.get(name) as PersistentVolumeClaim | undefined;
    if (!pvc) throw new Error(`no claim ${name}`);
    const pvName = `pvc-${pvc.metadata.uid}`;
    const pv: PersistentVolume = {
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: { name: pvName, uid: randomUUID(), resourceVersion: String(this.version++) },
      spec: {
        storageClassName: pvc.spec.storageClassName,
        claimRef: { namespace: this.namespace, name, uid: pvc.metadata.uid },
        // Ceph-CSI names the pool and the RBD image in the volume's attributes.
        csi: (() => {
          const image = randomUUID();
          return {
            driver: 'rbd.csi.ceph.com',
            volumeHandle: `0001-0009-test-0000000000000001-${image}`,
            volumeAttributes: { clusterID: 'test', pool: 'orbit-test', imageName: `csi-vol-${image}` },
          };
        })(),
        persistentVolumeReclaimPolicy: 'Retain',
      },
      status: { phase: 'Bound' },
    };
    this.persistentVolumes.set(pvName, pv);
    pvc.spec.volumeName = pvName;
    pvc.status = { phase: 'Bound' };
    return clone(pv);
  }

  private fault(op: FakeKubeOp, kind?: Kind): FakeKubeFault | undefined {
    const index = this.faults.findIndex((f) => f.op === op && (f.kind === undefined || f.kind === kind));
    if (index < 0) return undefined;
    const fault = this.faults[index];
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) this.faults.splice(index, 1);
    if (fault.mode === 'status') throw new KubeApiError(fault.status ?? 500, 'InternalError', `injected ${fault.status ?? 500}`);
    // Only a create can commit before its answer is lost; any other call simply has no answer.
    if (op !== 'create') throw new KubeAmbiguousError(`injected timeout of ${op}`);
    return fault;
  }

  private store<T extends KubeObject>(kind: Kind, object: T): T {
    object.metadata.uid ??= randomUUID();
    object.metadata.namespace ??= this.namespace;
    object.metadata.resourceVersion = String(this.version++);
    object.metadata.creationTimestamp ??= new Date().toISOString();
    if (kind === 'pods') {
      const pod = object as unknown as Pod;
      pod.spec.nodeName ??= this.podNode;
      pod.status ??= { phase: this.podPhase };
      this.attach(pod);
    }
    if (kind === 'persistentvolumeclaims') {
      (object as unknown as PersistentVolumeClaim).status ??= { phase: 'Pending' };
    }
    this.stores[kind].set(object.metadata.name, object);
    if (kind === 'persistentvolumeclaims' && this.autoBind && !(object as unknown as PersistentVolumeClaim).spec.volumeName) {
      this.bind(object.metadata.name);
    }
    this.emit(kind, 'ADDED', object);
    return clone(object);
  }

  /** The attach/detach controller: each bound volume a scheduled Pod uses is attached to its node. */
  private attach(pod: Pod): void {
    for (const volume of pod.spec.volumes ?? []) {
      const claim = volume.persistentVolumeClaim && (this.stores.persistentvolumeclaims.get(volume.persistentVolumeClaim.claimName) as PersistentVolumeClaim | undefined);
      const pvName = claim?.spec.volumeName;
      if (!pvName || !pod.spec.nodeName) continue;
      const name = `csi-${pvName}-${pod.spec.nodeName}`;
      if (this.volumeAttachments.has(name)) continue;
      this.volumeAttachments.set(name, {
        apiVersion: 'storage.k8s.io/v1',
        kind: 'VolumeAttachment',
        metadata: { name, uid: randomUUID(), resourceVersion: String(this.version++) },
        spec: { attacher: 'rbd.csi.ceph.com', nodeName: pod.spec.nodeName, source: { persistentVolumeName: pvName } },
        status: { attached: true },
      });
    }
  }

  /** …and detaches a volume once no stored Pod uses it, unless the test holds it attached. */
  private detachUnused(): void {
    if (!this.autoDetach) return;
    const used = new Set<string>();
    for (const object of this.stores.pods.values()) {
      for (const volume of (object as Pod).spec.volumes ?? []) {
        const claim = volume.persistentVolumeClaim && (this.stores.persistentvolumeclaims.get(volume.persistentVolumeClaim.claimName) as PersistentVolumeClaim | undefined);
        if (claim?.spec.volumeName) used.add(claim.spec.volumeName);
      }
    }
    for (const [name, va] of this.volumeAttachments) {
      if (!used.has(va.spec.source.persistentVolumeName ?? '')) this.volumeAttachments.delete(name);
    }
  }

  /** The installed webhook's answer, as the API server applies it with `failurePolicy: Fail`. */
  private async admit(operation: 'CREATE' | 'UPDATE', object: Pod, oldObject: Pod | null, username: string, dryRun: boolean, subResource?: string): Promise<void> {
    if (!this.admission) return;
    let answer: { allowed: boolean; message?: string };
    try {
      answer = await this.admission({
        uid: randomUUID(),
        resource: { group: '', version: 'v1', resource: 'pods' },
        ...(subResource ? { subResource } : {}),
        operation,
        namespace: this.namespace,
        name: object.metadata.name,
        userInfo: { username },
        object: clone(object),
        oldObject: oldObject ? clone(oldObject) : null,
        dryRun,
      });
    } catch (error) {
      throw new KubeApiError(500, 'InternalError', `Internal error occurred: failed calling webhook "${FAKE_ADMISSION_WEBHOOK_NAME}": ${(error as Error).message}`);
    }
    if (!answer.allowed) {
      throw new KubeApiError(403, 'Forbidden', `admission webhook "${FAKE_ADMISSION_WEBHOOK_NAME}" denied the request: ${answer.message ?? 'without explanation'}`);
    }
  }

  private emit(kind: Kind, type: KubeWatchEvent<KubeObject>['type'], object: KubeObject): void {
    for (const watcher of this.watchers) {
      if (watcher.kind === kind && selects(watcher.selector, object)) watcher.onEvent({ type, object: clone(object) });
    }
  }

  private resource<T extends KubeObject>(kind: Kind, pause: () => Promise<void>, username: string): KubeResource<T> {
    const objects = this.stores[kind];
    return {
      get: async (name) => {
        await pause();
        this.calls.push({ op: 'get', kind, name });
        this.fault('get', kind);
        const found = objects.get(name);
        return found ? (clone(found) as T) : null;
      },
      create: async (object, options) => {
        await pause();
        if (options?.dryRun) {
          // Admission runs and answers; nothing is stored, and no fault meant for a create applies.
          this.calls.push({ op: 'dryRunCreate', kind, name: object.metadata.name });
          if (kind === 'pods') await this.admit('CREATE', clone(object) as unknown as Pod, null, username, true);
          return clone(object);
        }
        this.calls.push({ op: 'create', kind, name: object.metadata.name });
        const fault = this.fault('create', kind);
        if (fault?.mode === 'timeout') throw new KubeAmbiguousError(`injected timeout before ${kind} ${object.metadata.name} committed`);
        if (kind === 'pods') await this.admit('CREATE', clone(object) as unknown as Pod, null, username, false);
        if (objects.has(object.metadata.name)) {
          throw new KubeApiError(409, 'AlreadyExists', `${kind} "${object.metadata.name}" already exists`);
        }
        const stored = this.store(kind, clone(object));
        if (fault?.mode === 'commit-then-timeout') throw new KubeAmbiguousError(`injected timeout after ${kind} ${object.metadata.name} committed`);
        return stored as T;
      },
      delete: async (name, options) => {
        await pause();
        this.calls.push({ op: 'delete', kind, name });
        this.fault('delete', kind);
        const found = objects.get(name);
        if (!found) return;
        if (options?.uid && found.metadata.uid !== options.uid) {
          throw new KubeApiError(409, 'Conflict', `Precondition failed: UID in precondition: ${options.uid}, UID in object meta: ${found.metadata.uid}`);
        }
        objects.delete(name);
        if (kind === 'pods') this.detachUnused();
        this.emit(kind, 'DELETED', found);
      },
      list: async (options) => {
        await pause();
        this.calls.push({ op: 'list', kind });
        this.fault('list', kind);
        return [...objects.values()].filter((o) => selects(options?.labelSelector, o)).map((o) => clone(o) as T);
      },
      watch: (options, onEvent) => {
        this.calls.push({ op: 'watch', kind });
        const watcher = { kind, selector: options.labelSelector, onEvent: onEvent as (event: KubeWatchEvent<KubeObject>) => void };
        this.watchers.push(watcher);
        let stop: () => void = () => undefined;
        const done = new Promise<void>((resolve) => {
          stop = () => {
            const at = this.watchers.indexOf(watcher);
            if (at >= 0) this.watchers.splice(at, 1);
            resolve();
          };
        });
        return { stop: () => stop(), done };
      },
    };
  }
}

/** `a=b,c=d` equality selectors, which is all the managed runner manager would ever use. */
function selects(selector: string | undefined, object: KubeObject): boolean {
  if (!selector) return true;
  const labels = object.metadata.labels ?? {};
  return selector.split(',').every((term) => {
    const [key, value] = term.split('=');
    return labels[key.trim()] === value?.trim();
  });
}

/**
 * The Kubernetes client constructor for a test where it must never be reached: a construction is
 * recorded, and what it hands back records every resource method too (and throws), so a client
 * built by mistake is caught at its constructor and at each call.
 */
export function tripwireKubeClientFactory(record: string[]): () => ManagedKubeClient {
  return () => {
    record.push('kube client constructed');
    return tripwireKubeClient(record);
  };
}

/** A client whose every resource method records and throws: for proving nothing reaches one. */
export function tripwireKubeClient(record: string[]): ManagedKubeClient {
  const trap = (what: string) => () => {
    record.push(what);
    throw new Error(`tripwire: ${what}`);
  };
  const resource = (kind: string): KubeResource<never> => ({
    get: trap(`${kind}.get`),
    create: trap(`${kind}.create`),
    delete: trap(`${kind}.delete`),
    list: trap(`${kind}.list`),
    watch: trap(`${kind}.watch`),
  });
  return {
    namespace: 'tripwire',
    persistentVolumeClaims: resource('persistentVolumeClaims'),
    secrets: resource('secrets'),
    pods: resource('pods'),
    configMaps: { get: trap('configMaps.get') },
    getPersistentVolume: trap('getPersistentVolume'),
    listVolumeAttachments: trap('listVolumeAttachments'),
  };
}
