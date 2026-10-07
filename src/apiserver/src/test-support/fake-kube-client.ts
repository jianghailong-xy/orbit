import { randomUUID } from 'node:crypto';

import {
  KubeAmbiguousError,
  KubeApiError,
  type KubeObject,
  type KubeResource,
  type KubeWatchEvent,
  type ManagedKubeClient,
  type PersistentVolume,
  type PersistentVolumeClaim,
  type Pod,
  type Secret,
} from '../managed-runners/kube-client';

/**
 * An in-memory Kubernetes namespace for managed runner tests: the three resources the manager
 * uses, plus the PVs claims bind to. Several clients — several manager replicas — share one cluster.
 *
 * What it imitates of the API server: one object per name (a second create is 409 AlreadyExists),
 * server-assigned UIDs, delete preconditions by UID, label-selected list and watch. What a test
 * scripts: binding (a claim binds to a fresh CSI-backed PV at once unless `autoBind` is off), the
 * phase a Pod is created in, and faults — a create that commits and then times out, one that times
 * out without committing, or a server error — consumed in order by the matching call.
 */

type Kind = 'persistentvolumeclaims' | 'secrets' | 'pods';
export type FakeKubeOp = 'get' | 'create' | 'delete' | 'list' | 'watch' | 'getPersistentVolume';

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
  /** Bind each new claim to a fresh PV at once. */
  autoBind = true;
  /** The phase a new Pod is stored in. */
  podPhase = 'Running';
  /** The node a new Pod is scheduled on. */
  podNode = 'node-a';
  private readonly stores: Record<Kind, Map<string, KubeObject>> = {
    persistentvolumeclaims: new Map(),
    secrets: new Map(),
    pods: new Map(),
  };
  private faults: FakeKubeFault[] = [];
  private version = 1;
  private readonly watchers: Array<{ kind: Kind; selector?: string; onEvent: (event: KubeWatchEvent<KubeObject>) => void }> = [];

  constructor(readonly namespace = 'orbit-managed-test') {}

  /** A client of this cluster, as one manager replica holds it. `delayMs` interleaves concurrent callers. */
  client(options: { delayMs?: number } = {}): ManagedKubeClient {
    const pause = async () => {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
    };
    return {
      namespace: this.namespace,
      persistentVolumeClaims: this.resource<PersistentVolumeClaim>('persistentvolumeclaims', pause),
      secrets: this.resource<Secret>('secrets', pause),
      pods: this.resource<Pod>('pods', pause),
      getPersistentVolume: async (name) => {
        await pause();
        this.calls.push({ op: 'getPersistentVolume', name });
        this.fault('getPersistentVolume');
        const pv = this.persistentVolumes.get(name);
        return pv ? clone(pv) : null;
      },
    };
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
        csi: { driver: 'rbd.csi.ceph.com', volumeHandle: `0001-0009-test-0000000000000001-${randomUUID()}` },
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

  private emit(kind: Kind, type: KubeWatchEvent<KubeObject>['type'], object: KubeObject): void {
    for (const watcher of this.watchers) {
      if (watcher.kind === kind && selects(watcher.selector, object)) watcher.onEvent({ type, object: clone(object) });
    }
  }

  private resource<T extends KubeObject>(kind: Kind, pause: () => Promise<void>): KubeResource<T> {
    const objects = this.stores[kind];
    return {
      get: async (name) => {
        await pause();
        this.calls.push({ op: 'get', kind, name });
        this.fault('get', kind);
        const found = objects.get(name);
        return found ? (clone(found) as T) : null;
      },
      create: async (object) => {
        await pause();
        this.calls.push({ op: 'create', kind, name: object.metadata.name });
        const fault = this.fault('create', kind);
        if (fault?.mode === 'timeout') throw new KubeAmbiguousError(`injected timeout before ${kind} ${object.metadata.name} committed`);
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
    getPersistentVolume: trap('getPersistentVolume'),
  };
}
