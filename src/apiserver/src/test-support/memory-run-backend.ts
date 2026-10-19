import { randomUUID } from 'node:crypto';

import type { ManagedRunner } from '@prisma/client';

import {
  type ManagedCredential,
  type ManagedFencingReceipt,
  type ManagedInstance,
  type ManagedRunnerBackend,
  type ManagedRunnerBackendFailure,
  type ManagedVolume,
  type ManagedVolumeBacking,
  type VerifiedVolume,
} from '../managed-runners/managed-runner-backend';
import type { CapacityBudget, ComputeAmounts, StorageAmounts } from '../managed-runners/managed-runner-capacity';
import type { ManagedRunnerPredecessor, ObservedStopProof } from '../managed-runners/managed-runner-fencing';

/**
 * A run backend with no Kubernetes in it: one host's volumes, credential files and containers, held
 * in memory. It is what the manager's state machine is proven to run on without knowing what is
 * underneath (managed-runner-backend.pg.spec.ts), and it plays the contract a one-host backend
 * supplies — fixed names, create once, identity checks, a UUID per instance, its own stop report,
 * removal by UID, release once nothing uses a volume. It is not a Docker implementation.
 *
 * `failNext` makes the next call of a kind fail transiently (`retryable`) or definitely.
 */

interface Volume {
  uid: string;
  ownerId: string;
  runnerId: string;
}

interface Credential {
  uid: string;
  ownerId: string;
  runnerId: string;
  generation: number;
  token: string;
  removing: boolean;
}

interface Instance {
  name: string;
  uid: string;
  ownerId: string;
  runnerId: string;
  generation: number;
  volumeUid: string;
  state: 'running' | 'exited';
  exitCode: number | null;
  /** Declared exited by something other than the host itself: no stop report. */
  unvouched: boolean;
}

/** A failure the backend reports; `retryable` decides how the manager takes it. */
export class MemoryBackendError extends Error {
  constructor(readonly retryable: boolean, message: string) {
    super(message);
  }
}

export class MemoryRunBackend implements ManagedRunnerBackend {
  /** It has to carry a backend's name; it plays a one-host backend, the shape `docker` will have. */
  readonly name = 'docker';
  readonly terms = { volume: 'volume', backing: 'volume', credential: 'credential file', instance: 'container', stopReport: "the host's report" };
  readonly calls: string[] = [];
  readonly volumes = new Map<string, Volume>();
  readonly credentials = new Map<string, Credential>();
  readonly instances = new Map<string, Instance>();
  private failures: Array<{ call: string; retryable: boolean }> = [];

  constructor(
    readonly location: { clusterKey: string; namespace: string },
    private readonly amounts: { budget: CapacityBudget; compute: ComputeAmounts; storage: StorageAmounts },
  ) {}

  names(runnerId: string) {
    return { volume: `mr-data-${runnerId}`, instance: `mr-${runnerId}`, credential: `mr-boot-${runnerId}` };
  }

  capacityBudget(): CapacityBudget {
    return this.amounts.budget;
  }

  computeShare(): ComputeAmounts {
    return this.amounts.compute;
  }

  storageShare(): StorageAmounts {
    return this.amounts.storage;
  }

  // ── test controls ──────────────────────────────────────────────────────────────────────────

  failNext(call: string, retryable: boolean): void {
    this.failures.push({ call, retryable });
  }

  /** The runner in it exited by itself, and the host says so. */
  exit(runnerId: string, exitCode = 0): void {
    const instance = this.instances.get(this.names(runnerId).instance)!;
    instance.state = 'exited';
    instance.exitCode = exitCode;
  }

  /** Marked exited by something other than the host itself: terminal, with no stop report. */
  declareExited(runnerId: string): void {
    const instance = this.instances.get(this.names(runnerId).instance)!;
    instance.state = 'exited';
    instance.unvouched = true;
  }

  /** Gone with no report of how: what a host that lost track of it would leave. */
  vanish(runnerId: string): void {
    this.instances.delete(this.names(runnerId).instance);
  }

  count(call: string): number {
    return this.calls.filter((c) => c === call).length;
  }

  // ── the data volume ────────────────────────────────────────────────────────────────────────

  async readVolume(mapping: ManagedRunner): Promise<ManagedVolume | null> {
    this.call('readVolume');
    const volume = this.volumes.get(mapping.pvcName);
    return volume ? { uid: volume.uid, boundTo: mapping.pvcName } : null;
  }

  async createVolume(mapping: ManagedRunner): Promise<ManagedVolume> {
    this.call('createVolume');
    if (!this.volumes.has(mapping.pvcName)) this.volumes.set(mapping.pvcName, { uid: randomUUID(), ownerId: mapping.ownerId, runnerId: mapping.runnerId });
    return { uid: this.volumes.get(mapping.pvcName)!.uid, boundTo: mapping.pvcName };
  }

  volumeProblem(volume: ManagedVolume, mapping: ManagedRunner): string | null {
    const stored = this.volumes.get(mapping.pvcName)!;
    if (mapping.pvcUid && volume.uid !== mapping.pvcUid) return 'the volume under this name has a different UID from the one recorded';
    return stored.ownerId === mapping.ownerId && stored.runnerId === mapping.runnerId ? null : 'the volume names another owner or runner';
  }

  async readBacking(volume: ManagedVolume): Promise<ManagedVolumeBacking | null> {
    this.call('readBacking');
    return { uid: volume.uid, handle: `local/${volume.boundTo}/${volume.uid}` };
  }

  backingProblem(backing: ManagedVolumeBacking, mapping: ManagedRunner): string | null {
    if (mapping.pvUid && backing.uid !== mapping.pvUid) return 'the volume has a different UID from the one recorded';
    if (mapping.volumeHandle && backing.handle !== mapping.volumeHandle) return 'the volume has a different handle from the one recorded';
    return null;
  }

  async volumeHolders({ volume }: VerifiedVolume): Promise<string[]> {
    this.call('volumeHolders');
    return [...this.instances.values()].filter((i) => i.volumeUid === volume.uid).map((i) => i.name);
  }

  // ── the credential ─────────────────────────────────────────────────────────────────────────

  async readCredential(mapping: ManagedRunner): Promise<ManagedCredential | null> {
    this.call('readCredential');
    const found = this.credentials.get(this.names(mapping.runnerId).credential);
    return found ? { ownerId: found.ownerId, runnerId: found.runnerId, generation: found.generation, token: found.token, removing: found.removing } : null;
  }

  async issueCredential(mapping: ManagedRunner, token: string): Promise<ManagedCredential> {
    this.call('issueCredential');
    const name = this.names(mapping.runnerId).credential;
    if (!this.credentials.has(name)) {
      this.credentials.set(name, { uid: randomUUID(), ownerId: mapping.ownerId, runnerId: mapping.runnerId, generation: mapping.generation, token, removing: false });
    }
    return (await this.readCredential(mapping))!;
  }

  credentialProblem(credential: ManagedCredential, mapping: ManagedRunner): string | null {
    if (credential.ownerId !== mapping.ownerId || credential.runnerId !== mapping.runnerId) return 'the credential file names another owner or runner';
    if (credential.generation !== mapping.generation) return 'the credential file is for another generation';
    return credential.token ? null : 'the credential file carries no credential';
  }

  async removeCredential(mapping: ManagedRunner): Promise<void> {
    this.call('removeCredential');
    this.credentials.delete(this.names(mapping.runnerId).credential);
  }

  // ── the instance ───────────────────────────────────────────────────────────────────────────

  async readInstance(mapping: ManagedRunner): Promise<ManagedInstance | null> {
    this.call('readInstance');
    const found = this.instances.get(this.names(mapping.runnerId).instance);
    return found ? this.observe(found) : null;
  }

  async requireInstanceGuard(): Promise<void> {
    this.call('requireInstanceGuard');
  }

  async createInstance(mapping: ManagedRunner): Promise<ManagedInstance> {
    this.call('createInstance');
    const name = this.names(mapping.runnerId).instance;
    if (!this.instances.has(name)) {
      this.instances.set(name, {
        name, uid: randomUUID(), ownerId: mapping.ownerId, runnerId: mapping.runnerId, generation: mapping.generation,
        volumeUid: mapping.pvcUid!, state: 'running', exitCode: null, unvouched: false,
      });
    }
    return this.observe(this.instances.get(name)!);
  }

  instanceProblem(instance: ManagedInstance, mapping: ManagedRunner): string | null {
    const found = this.instances.get(instance.name)!;
    if (found.ownerId !== mapping.ownerId || found.runnerId !== mapping.runnerId) return 'the container names another owner or runner';
    if (found.generation !== mapping.generation) return 'the container is of another generation';
    return found.volumeUid === mapping.pvcUid ? null : 'the container mounts another volume';
  }

  async removeInstance(mapping: ManagedRunner): Promise<void> {
    this.call('removeInstance');
    const name = this.names(mapping.runnerId).instance;
    if (this.instances.get(name)?.uid === mapping.podUid) this.instances.delete(name);
  }

  observedStop(predecessor: ManagedRunnerPredecessor, instance: ManagedInstance, now: Date): ObservedStopProof {
    const found = this.instances.get(instance.name)!;
    return {
      kind: 'OBSERVED_STOP',
      predecessor,
      recordedAt: now.toISOString(),
      observation: { phase: 'exited', containers: [{ name: 'runner', state: 'terminated', exitCode: found.exitCode ?? undefined }] },
    };
  }

  async readFencingReceipt(): Promise<ManagedFencingReceipt | null> {
    this.call('readFencingReceipt');
    return null;
  }

  failure(error: unknown): ManagedRunnerBackendFailure | null {
    if (!(error instanceof MemoryBackendError)) return null;
    return error.retryable ? { retryable: true } : { retryable: false, code: 'BACKEND_REJECTED', detail: error.message, log: `the memory backend refused: ${error.message}` };
  }

  private observe(found: Instance): ManagedInstance {
    return {
      name: found.name,
      uid: found.uid,
      node: 'host-a',
      phase: found.state,
      running: found.state === 'running',
      terminated: found.state === 'exited',
      stopConfirmed: found.state === 'exited' && !found.unvouched,
      removing: false,
      exit: found.state === 'exited' ? { code: found.exitCode, outOfMemory: false } : null,
    };
  }

  private call(name: string): void {
    this.calls.push(name);
    const at = this.failures.findIndex((f) => f.call === name);
    if (at < 0) return;
    const [failure] = this.failures.splice(at, 1);
    throw new MemoryBackendError(failure.retryable, `injected failure of ${name}`);
  }
}
