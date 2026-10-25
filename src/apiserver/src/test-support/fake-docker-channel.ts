import { randomUUID } from 'node:crypto';

import {
  DockerChannelError,
  DockerChannelUnreachable,
  type ChannelContainer,
  type ChannelContainerRequest,
  type ChannelCredential,
  type ChannelHolder,
  type ChannelHost,
  type ChannelInfo,
  type ChannelVolume,
  type DockerChannel,
} from '../managed-runners/docker-channel-client';

/**
 * The restricted Docker channel (deploy/managed-runner/docker-channel/channel.py) in memory, keeping
 * the rules the backend relies on: create once under fixed names, the single-container guard (only
 * `mr-<runner>` may use a runner's volume, and not while anything else refers to it), the container
 * of a generation only with that generation's credential, removal by UID and only once stopped, the
 * cap on containers (`limits.maxContainers`, counting every container in any state), and Docker's
 * exit report. The channel's own tests (scripts/managed-runner/docker_channel_test.py) and
 * the real-Docker run are where the channel itself is proven; this is what DockerBackend is unit
 * tested against.
 *
 * `failNext` makes the next call of a kind fail: unreachable (ambiguous, after or before it took
 * effect) or with a channel refusal.
 */

interface StoredContainer extends ChannelContainer {
  request: ChannelContainerRequest;
}

type Failure =
  | { kind: 'unreachable-before' }
  | { kind: 'unreachable-after' }
  | { kind: 'refused'; status: number; code: string };

export class FakeDockerChannel implements DockerChannel {
  readonly calls: string[] = [];
  readonly volumes = new Map<string, ChannelVolume>();
  readonly credentials = new Map<string, ChannelCredential>();
  readonly containers = new Map<string, StoredContainer>();
  readonly receipts = new Map<string, unknown>();
  /** Containers outside this instance that refer to a volume, by volume name. */
  readonly foreignHolders = new Map<string, number>();
  readonly stopRequests: Array<{ name: string; uid: string }> = [];
  host: ChannelHost = {
    name: 'docker-host-a', cpus: 8, memoryBytes: 16 * 2 ** 30, serverVersion: '29.0',
    disk: { path: '/var/lib/docker', totalBytes: 1000 * 2 ** 30, freeBytes: 600 * 2 ** 30 }, managedVolumeBytes: 0,
  };
  /** The ceilings /v1/info reports; the real channel always reports `maxContainers` among them. */
  limits: Record<string, number> = {};
  /** Set: the host's firewall for managed runners is configured and not in force, and the channel starts no container. */
  firewallDown: string | null = null;
  private failures: Array<{ call: string; failure: Failure }> = [];

  /**
   * `image` is the one the channel's configuration names: an upgrade restarts the channel on another one
   * (`image = …`), while the containers made from the previous one stay as they are (`request.image`).
   */
  constructor(
    readonly instanceId: string,
    public image: string,
  ) {}

  // ── test controls ──────────────────────────────────────────────────────────────────────────

  failNext(call: string, failure: Failure): void {
    this.failures.push({ call, failure });
  }

  /** The runner exited by itself (or was killed): Docker's report, with its exit code and when, and whether it marked an OOM kill. */
  exit(runnerId: string, exitCode = 0, oomKilled = false): void {
    const container = this.containers.get(`mr-${runnerId}`)!;
    Object.assign(container, { status: 'exited', running: false, exitCode, oomKilled, finishedAt: new Date().toISOString() });
  }

  /** Removed by hand, outside the channel: gone with no report of how. */
  vanish(runnerId: string): void {
    this.containers.delete(`mr-${runnerId}`);
  }

  count(call: string): number {
    return this.calls.filter((c) => c === call).length;
  }

  // ── the channel ────────────────────────────────────────────────────────────────────────────

  async info(): Promise<ChannelInfo> {
    this.call('info');
    return {
      schemaVersion: 1, instanceId: this.instanceId, image: this.image,
      network: { name: 'orbit-managed-runners', internal: true, interContainer: false },
      limits: this.limits, stopGraceSeconds: 240, diskCheckSeconds: 120, host: this.host,
    };
  }

  async readVolume(name: string): Promise<ChannelVolume | null> {
    this.call('readVolume');
    return this.volumes.get(name) ?? null;
  }

  async ensureVolume(name: string, volume: { ownerId: string; runnerId: string; limitBytes: number }): Promise<ChannelVolume> {
    return this.effect('ensureVolume', () => {
      if (!this.volumes.has(name)) {
        this.volumes.set(name, { name, uid: randomUUID(), ownerId: volume.ownerId, runnerId: volume.runnerId, limitBytes: volume.limitBytes, createdAt: new Date().toISOString(), usageBytes: null });
      }
      return this.volumes.get(name)!;
    });
  }

  async volumeHolders(name: string): Promise<ChannelHolder[]> {
    this.call('volumeHolders');
    if (!this.volumes.has(name)) throw new DockerChannelError(404, 'NOT_FOUND', `no data volume ${name} of this instance`);
    return [
      ...[...this.containers.values()].filter((c) => c.volume === name).map((c) => ({ name: c.name, managed: true })),
      ...Array.from({ length: this.foreignHolders.get(name) ?? 0 }, () => ({ managed: false })),
    ];
  }

  async readCredential(runnerId: string): Promise<ChannelCredential | null> {
    this.call('readCredential');
    return this.credentials.get(runnerId) ?? null;
  }

  async putCredential(runnerId: string, credential: { ownerId: string; generation: number; token: string }): Promise<ChannelCredential> {
    return this.effect('putCredential', () => {
      if (!this.credentials.has(runnerId)) {
        this.credentials.set(runnerId, { uid: randomUUID(), ownerId: credential.ownerId, runnerId, generation: credential.generation, token: credential.token, createdAt: new Date().toISOString() });
      }
      return this.credentials.get(runnerId)!;
    });
  }

  async deleteCredential(runnerId: string, uid: string): Promise<void> {
    this.effect('deleteCredential', () => {
      const found = this.credentials.get(runnerId);
      if (found && found.uid !== uid) throw new DockerChannelError(409, 'UID_MISMATCH', 'not the credential with that UID');
      this.credentials.delete(runnerId);
    });
  }

  async dryRunContainer(request: ChannelContainerRequest): Promise<{ status: number; code: string | null; message: string | null }> {
    this.call('dryRunContainer');
    if (request.image !== this.image) return { status: 403, code: 'IMAGE_REFUSED', message: 'another image' };
    if (request.name !== `mr-${request.runnerId}`) return { status: 409, code: 'SINGLE_CONTAINER_GUARD', message: 'only the fixed name' };
    return { status: 200, code: null, message: null };
  }

  async createContainer(request: ChannelContainerRequest): Promise<ChannelContainer> {
    return this.effect('createContainer', () => {
      const existing = this.containers.get(request.name);
      if (existing) {
        const same = existing.ownerId === request.ownerId && existing.generation === request.generation && existing.volumeUid === request.volume.uid;
        if (same) return existing;
        throw new DockerChannelError(409, 'CONTAINER_CONFLICT', 'an earlier container is still there');
      }
      if (request.name !== `mr-${request.runnerId}`) throw new DockerChannelError(409, 'SINGLE_CONTAINER_GUARD', 'only the fixed name');
      if (this.firewallDown !== null) throw new DockerChannelError(503, 'FIREWALL_NOT_ENFORCED', `the managed runners' host firewall is not in force: ${this.firewallDown}`);
      if (request.image !== this.image) throw new DockerChannelError(403, 'IMAGE_REFUSED', 'another image');
      const volume = this.volumes.get(request.volume.name);
      if (!volume || volume.uid !== request.volume.uid) throw new DockerChannelError(409, 'VOLUME_REFUSED', 'not the authorized volume');
      if ((this.foreignHolders.get(volume.name) ?? 0) > 0) throw new DockerChannelError(409, 'VOLUME_IN_USE', 'something else refers to it');
      const credential = this.credentials.get(request.runnerId);
      if (!credential || credential.generation !== request.generation) throw new DockerChannelError(409, 'CREDENTIAL_MISSING', 'no credential of this generation');
      if (volume.limitBytes !== null && (volume.usageBytes ?? 0) > volume.limitBytes) throw new DockerChannelError(409, 'VOLUME_OVER_LIMIT', 'over its limit');
      const cap = this.limits.maxContainers;
      if (cap !== undefined && this.containers.size >= cap) {
        throw new DockerChannelError(429, 'CONTAINER_LIMIT', `containers of this instance: ${this.containers.size}, at its limit (limits.maxContainers ${cap}); another is made only once one of them is removed`);
      }
      const container: StoredContainer = {
        name: request.name, uid: randomUUID(), ownerId: request.ownerId, runnerId: request.runnerId, generation: request.generation,
        volumeUid: request.volume.uid, volume: request.volume.name, node: this.host.name, status: 'running', running: true,
        neverStarted: false, exitCode: null, startedAt: new Date().toISOString(), finishedAt: null, oomKilled: false, stopping: false,
        evicted: null, request,
      };
      this.containers.set(request.name, container);
      return container;
    });
  }

  async readContainer(name: string): Promise<ChannelContainer | null> {
    this.call('readContainer');
    return this.containers.get(name) ?? null;
  }

  async stopContainer(name: string, uid: string): Promise<ChannelContainer | null> {
    return this.effect('stopContainer', () => {
      const found = this.containers.get(name);
      if (!found) return null;
      if (found.uid !== uid) throw new DockerChannelError(409, 'UID_MISMATCH', 'not the container with that UID');
      this.stopRequests.push({ name, uid });
      // SIGTERM, the grace, then a kill: Docker records the exit either way.
      if (found.status === 'running') Object.assign(found, { status: 'exited', running: false, exitCode: 143, finishedAt: new Date().toISOString() });
      return found;
    });
  }

  async removeContainer(name: string, uid: string): Promise<void> {
    this.effect('removeContainer', () => {
      const found = this.containers.get(name);
      if (!found) return;
      if (found.uid !== uid) throw new DockerChannelError(409, 'UID_MISMATCH', 'not the container with that UID');
      if (found.status === 'running') throw new DockerChannelError(409, 'CONTAINER_RUNNING', 'removed only once stopped');
      this.containers.delete(name);
    });
  }

  async fencingReceipt(runnerId: string): Promise<unknown | null> {
    this.call('fencingReceipt');
    return this.receipts.get(runnerId) ?? null;
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  private call(name: string): Failure | undefined {
    this.calls.push(name);
    const at = this.failures.findIndex((f) => f.call === name);
    if (at < 0) return undefined;
    const [{ failure }] = this.failures.splice(at, 1);
    if (failure.kind === 'unreachable-before') throw new DockerChannelUnreachable(`injected: ${name} never reached the channel`, false);
    if (failure.kind === 'refused') throw new DockerChannelError(failure.status, failure.code, `injected refusal of ${name}`);
    return failure;
  }

  /** A call that changes something: an injected `unreachable-after` lets it take effect, then loses the answer. */
  private effect<T>(name: string, apply: () => T): T {
    const failure = this.call(name);
    const result = apply();
    if (failure?.kind === 'unreachable-after') throw new DockerChannelUnreachable(`injected: ${name}'s answer was lost`);
    return result;
  }
}
