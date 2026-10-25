import type { ManagedRunner } from '@prisma/client';

import {
  DockerChannelError,
  DockerChannelUnreachable,
  type ChannelContainer,
  type ChannelContainerRequest,
  type ChannelHost,
  type ChannelVolume,
  type DockerChannel,
} from './docker-channel-client';
import {
  ManagedFirewallNotEnforced,
  ManagedInstanceLimit,
  ManagedRunnerConflict,
  ManagedVolumeHeld,
  type ManagedCredential,
  type ManagedFencingReceipt,
  type ManagedInstance,
  type ManagedRunnerBackend,
  type ManagedRunnerBackendFailure,
  type ManagedRunnerBackendTerms,
  type ManagedVolume,
  type ManagedVolumeBacking,
  type VerifiedVolume,
} from './managed-runner-backend';
import { quantityUnits, type CapacityBudget, type ComputeAmounts, type StorageAmounts } from './managed-runner-capacity';
import { readDockerFencingReceipt, type ManagedRunnerPredecessor, type ObservedStopProof } from './managed-runner-fencing';
import type { DockerRunnerProfile } from './managed-runner-profile';
import { managedPodName, managedPvcName, managedSecretName } from './managed-runner-resources';

/**
 * The Docker backend (docs/managed-runner-design.md, "Implementation record: Docker backend"): one
 * host's Docker, reached only through the restricted Docker channel (docker-channel-client.ts), which
 * holds the Docker socket and labels everything with this deployment's instance.
 *
 *   data volume   local named volume `mr-data-<runner uuid>`, its UID the channel's label; the
 *                 "storage behind it" is the volume itself (handle `docker:<instance>/<name>/<uid>`)
 *   credential    the runner credential of one generation, kept by the channel until its container
 *                 starts, then a read-only file in the container (never its environment)
 *   instance      container `mr-<runner uuid>` from the channel's template: the configured image,
 *                 UID 10001, no capabilities, read-only root, CPU/memory/PID/tmp limits, one network
 *   instance UID  a canonical UUID the channel gives each container (the runner door requires one)
 *   stop report   Docker's own: the container exited (exit code, FinishedAt), or was never started
 *   released      no container, of any label, refers to the volume
 *   fencing       an operator's host check of a container that vanished unobserved (HOST_PROCESS_CHECK)
 *   capacity      the profile's per-runner limits; the pool's budget derived from the host the channel
 *                 reports (CPU, memory, the disk Docker's volumes live on) less a reserve, unless stated
 *
 * One host's Docker vouches for every stop it makes, so this backend can also stop an instance
 * (`stopInstance`) when the manager asks: an accepted sleep that overran its drain time, or a disabled
 * owner's runner that has not stopped by itself. Asking is never the proof: the gate still waits for
 * Docker's report of the exit and the container's removal.
 */

const TERMS: ManagedRunnerBackendTerms = {
  volume: 'volume',
  backing: 'volume',
  credential: 'credential',
  instance: 'container',
  stopReport: "Docker's report",
};

/** What a derived budget leaves to everything else on the host, unless the profile says otherwise. */
export const DOCKER_DEFAULT_RESERVE = { cpu: 0.25, memory: 0.25, disk: 0.1 } as const;

interface DockerVolume extends ManagedVolume {
  readonly view: ChannelVolume;
}
interface DockerCredential extends ManagedCredential {
  readonly uid: string;
}
interface DockerInstance extends ManagedInstance {
  readonly view: ChannelContainer;
}

function units(quantity: string, scale: 'unit' | 'milli' = 'unit'): number {
  const value = quantityUnits(quantity, scale);
  if (value === null) throw new Error(`not a countable quantity: ${JSON.stringify(quantity)}`);
  return value;
}

/** One runner's compute share: its container's limits (Docker reserves nothing below them), one container, one volume, one user. */
export function dockerComputeShare(profile: Pick<DockerRunnerProfile, 'runner'>): ComputeAmounts {
  return {
    cpuMillis: units(profile.runner.resources.cpu, 'milli'),
    memoryBytes: units(profile.runner.resources.memory),
    ephemeralBytes: units(profile.runner.tmpSizeLimit),
    pods: 1,
    attachments: 1,
    activeUsers: 1,
  };
}

/**
 * The pool's budget: every dimension the profile states, and the rest derived from the host the
 * channel reports, less a reserve for everything else running there.
 *
 *   CPU, memory     the host's, less `reserve.cpu` / `reserve.memory` (a quarter each by default)
 *   /tmp            a tmpfs, held in the containers' memory: bounded by the memory budget
 *   containers      as many runners as CPU and memory both fit; the same number of volume slots and users.
 *                   Never more than the channel will make (`channelMaxContainers`, the `maxContainers` its
 *                   /v1/info reports): it refuses a container past that, so the pool admits no runner it
 *                   could not start.
 *   storage         what data volumes could hold: the free space of the disk Docker's volumes live on
 *                   plus what this instance's volumes already hold; `reserve.disk` of that disk (a
 *                   tenth by default) is the headroom kept free. A disk the channel cannot see gives
 *                   no storage until the profile states it.
 */
export function dockerCapacityBudget(
  host: ChannelHost,
  profile: Pick<DockerRunnerProfile, 'runner' | 'capacity'>,
  channelMaxContainers?: number,
): CapacityBudget {
  const stated = profile.capacity ?? {};
  const containers = typeof channelMaxContainers === 'number' && Number.isSafeInteger(channelMaxContainers) && channelMaxContainers > 0
    ? channelMaxContainers
    : Infinity;
  const reserve = { ...DOCKER_DEFAULT_RESERVE, ...stated.reserve };
  const share = dockerComputeShare(profile);
  const cpuMillis = stated.compute?.cpu ? units(stated.compute.cpu, 'milli') : Math.floor(host.cpus * 1000 * (1 - reserve.cpu));
  const memoryBytes = stated.compute?.memory ? units(stated.compute.memory) : Math.floor(host.memoryBytes * (1 - reserve.memory));
  const ephemeralBytes = stated.compute?.ephemeralStorage ? units(stated.compute.ephemeralStorage) : memoryBytes;
  const fit = Math.max(0, Math.min(Math.floor(cpuMillis / share.cpuMillis), Math.floor(memoryBytes / share.memoryBytes), containers));
  const disk = host.disk;
  return {
    cpuMillis,
    memoryBytes,
    ephemeralBytes,
    pods: Math.min(stated.compute?.pods ?? fit, containers),
    attachments: stated.compute?.attachments ?? fit,
    activeUsers: stated.maxActiveUsers ?? fit,
    storageUsableBytes: stated.storage?.usable ? units(stated.storage.usable) : disk ? disk.freeBytes + host.managedVolumeBytes : 0,
    storageHeadroomBytes: stated.storage?.headroom ? units(stated.storage.headroom) : disk ? Math.ceil(disk.totalBytes * reserve.disk) : 0,
  };
}

/** Where Docker's report puts the container, in its own words: operator details only. */
function phaseOf(view: ChannelContainer): string {
  if (view.status === 'created' && view.neverStarted) return 'created (never started)';
  if (view.status !== 'exited' && view.status !== 'dead') return view.status;
  const why = [view.oomKilled ? 'OOM-killed' : '', view.evicted ? `stopped: its volume held ${view.evicted.usageBytes} bytes, over its ${view.evicted.limitBytes}-byte limit` : '']
    .filter(Boolean).join('; ');
  return `${view.status} (exit ${view.exitCode ?? '?'}${why ? `; ${why}` : ''})`;
}

function instanceOf(view: ChannelContainer): DockerInstance {
  const neverRan = view.status === 'created' && view.neverStarted;
  const ended = view.status === 'exited' || view.status === 'dead';
  return {
    name: view.name,
    uid: view.uid,
    node: view.node,
    phase: phaseOf(view),
    running: view.status === 'running',
    // A container the channel created and never started has no process, and never will: the channel
    // finishes or abandons an interrupted create before it answers anything.
    terminated: ended || neverRan,
    // Docker's own report: an exit it recorded (when and how), or no start at all.
    stopConfirmed: (ended && !!view.finishedAt) || neverRan,
    removing: view.status === 'removing',
    // Docker marks a container OOM-killed when any process in it was; the runner ran out of memory
    // itself only if it ended killed (137) as well.
    exit: ended ? { code: view.exitCode, outOfMemory: view.oomKilled && view.exitCode === 137 } : null,
    view,
  };
}

export class DockerBackend implements ManagedRunnerBackend {
  readonly name = 'docker';
  readonly terms = TERMS;
  readonly location: { readonly clusterKey: string; readonly namespace: string };

  constructor(
    private readonly channel: DockerChannel,
    private readonly profile: DockerRunnerProfile,
  ) {
    this.location = { clusterKey: profile.clusterKey, namespace: profile.docker.instanceId };
  }

  names(runnerId: string) {
    return { volume: managedPvcName(runnerId), instance: managedPodName(runnerId), credential: managedSecretName(runnerId) };
  }

  /** Derived from the host the channel reports, after checking the channel serves this deployment and image. */
  async capacityBudget(): Promise<CapacityBudget> {
    const info = await this.channel.info();
    if (info.instanceId !== this.profile.docker.instanceId || info.image !== this.profile.runner.image) {
      throw new ManagedRunnerConflict(
        'DOCKER_CHANNEL_MISMATCH',
        `the channel serves instance ${info.instanceId} with image ${info.image}; this profile names ${this.profile.docker.instanceId} with ${this.profile.runner.image}`,
      );
    }
    return dockerCapacityBudget(info.host, this.profile, info.limits?.maxContainers);
  }

  computeShare(): ComputeAmounts {
    return dockerComputeShare(this.profile);
  }

  storageShare(): StorageAmounts {
    return { durableBytes: units(this.profile.storage.capacity) };
  }

  // ── the data volume ────────────────────────────────────────────────────────────────────────

  async readVolume(mapping: ManagedRunner): Promise<DockerVolume | null> {
    const view = await this.channel.readVolume(mapping.pvcName);
    return view ? { uid: view.uid, boundTo: view.name, view } : null;
  }

  async createVolume(mapping: ManagedRunner): Promise<DockerVolume> {
    const ask = () => this.channel.ensureVolume(mapping.pvcName, {
      ownerId: mapping.ownerId,
      runnerId: mapping.runnerId,
      limitBytes: this.storageShare().durableBytes,
    });
    const view = await this.orReadBack(ask, () => this.channel.readVolume(mapping.pvcName));
    return { uid: view.uid, boundTo: view.name, view };
  }

  volumeProblem(volume: DockerVolume, mapping: ManagedRunner): string | null {
    if (mapping.pvcUid && volume.uid !== mapping.pvcUid) return 'the volume under this name has a different UID from the one recorded';
    if (volume.view.ownerId !== mapping.ownerId) return 'the volume names another owner (or none)';
    if (volume.view.runnerId !== mapping.runnerId) return 'the volume names another runner (or none)';
    return null;
  }

  /** A local volume is its own storage: the same UID, and a handle naming the instance, the volume and that UID. */
  async readBacking(volume: DockerVolume): Promise<ManagedVolumeBacking> {
    return { uid: volume.uid, handle: `docker:${this.profile.docker.instanceId}/${volume.view.name}/${volume.uid}` };
  }

  backingProblem(backing: ManagedVolumeBacking, mapping: ManagedRunner): string | null {
    if (mapping.pvUid && backing.uid !== mapping.pvUid) return 'the volume has a different UID from the one recorded';
    if (mapping.volumeHandle && backing.handle !== mapping.volumeHandle) return 'the volume has a different handle from the one recorded';
    return null;
  }

  /** Every container that refers to the volume, labelled or not, in any state. */
  async volumeHolders({ volume }: VerifiedVolume): Promise<string[]> {
    const holders = await this.channel.volumeHolders((volume as DockerVolume).view.name);
    return holders.map((holder) => (holder.managed && holder.name ? holder.name : 'a container outside this instance'));
  }

  // ── the credential ─────────────────────────────────────────────────────────────────────────

  async readCredential(mapping: ManagedRunner): Promise<DockerCredential | null> {
    const view = await this.channel.readCredential(mapping.runnerId);
    return view ? { uid: view.uid, ownerId: view.ownerId ?? undefined, runnerId: view.runnerId ?? undefined, generation: view.generation, token: view.token, removing: false } : null;
  }

  async issueCredential(mapping: ManagedRunner, token: string): Promise<DockerCredential> {
    const ask = () => this.channel.putCredential(mapping.runnerId, { ownerId: mapping.ownerId, generation: mapping.generation, token });
    const view = await this.orReadBack(ask, () => this.channel.readCredential(mapping.runnerId));
    return { uid: view.uid, ownerId: view.ownerId ?? undefined, runnerId: view.runnerId ?? undefined, generation: view.generation, token: view.token, removing: false };
  }

  credentialProblem(credential: DockerCredential, mapping: ManagedRunner): string | null {
    if (credential.ownerId !== mapping.ownerId) return 'the credential names another owner (or none)';
    if (credential.runnerId !== mapping.runnerId) return 'the credential names another runner (or none)';
    if (credential.generation !== mapping.generation) return 'the credential is for another generation';
    return credential.token ? null : 'the credential carries no credential';
  }

  async removeCredential(mapping: ManagedRunner, credential: DockerCredential): Promise<void> {
    await this.channel.deleteCredential(mapping.runnerId, credential.uid);
  }

  // ── the instance ───────────────────────────────────────────────────────────────────────────

  async readInstance(mapping: ManagedRunner): Promise<DockerInstance | null> {
    const view = await this.channel.readContainer(managedPodName(mapping.runnerId));
    return view ? instanceOf(view) : null;
  }

  /**
   * Proof that the channel's single-container guard is in force: a dry run of this generation's
   * container under another name comes back refused by it (409 SINGLE_CONTAINER_GUARD). Admitted, or
   * refused for anything else, nothing is created.
   */
  async requireInstanceGuard(mapping: ManagedRunner): Promise<void> {
    const probe = { ...this.containerRequest(mapping), name: `${managedPodName(mapping.runnerId)}-guard-probe` };
    const answer = await this.channel.dryRunContainer(probe);
    if (answer.status === 409 && answer.code === 'SINGLE_CONTAINER_GUARD') return;
    if (answer.status >= 500 || answer.status === 429) throw new DockerChannelError(answer.status, answer.code ?? `HTTP_${answer.status}`, answer.message ?? 'the guard probe failed');
    if (answer.status < 300) throw new ManagedRunnerConflict('CONTAINER_GUARD_MISSING', 'a container the single-container guard must refuse was admitted by a dry run');
    throw new ManagedRunnerConflict('CONTAINER_GUARD_UNVERIFIED', `the guard probe was refused, but not by the guard: ${answer.status} ${answer.code ?? ''} ${answer.message ?? ''}`.trim());
  }

  /**
   * The channel refuses it, VOLUME_IN_USE, while any other container refers to the volume, and
   * CONTAINER_LIMIT (429) while this instance has `maxContainers` containers, and FIREWALL_NOT_ENFORCED (503)
   * while the host's firewall for managed runners is configured and not in force: the manager then waits.
   */
  async createInstance(mapping: ManagedRunner): Promise<DockerInstance> {
    const name = managedPodName(mapping.runnerId);
    try {
      const view = await this.orReadBack(() => this.channel.createContainer(this.containerRequest(mapping)), () => this.channel.readContainer(name));
      return instanceOf(view);
    } catch (error) {
      if (error instanceof DockerChannelError && error.code === 'VOLUME_IN_USE') throw new ManagedVolumeHeld(error.message);
      if (error instanceof DockerChannelError && error.code === 'CONTAINER_LIMIT') throw new ManagedInstanceLimit(error.message);
      if (error instanceof DockerChannelError && error.code === 'FIREWALL_NOT_ENFORCED') throw new ManagedFirewallNotEnforced(error.message);
      throw error;
    }
  }

  instanceProblem(instance: DockerInstance, mapping: ManagedRunner): string | null {
    const { view } = instance;
    if (view.ownerId !== mapping.ownerId) return 'the container names another owner (or none)';
    if (view.runnerId !== mapping.runnerId) return 'the container names another runner (or none)';
    if (view.generation !== mapping.generation) return 'the container is of another generation';
    if (view.volumeUid !== mapping.pvcUid) return 'the container was authorized for another volume';
    return null;
  }

  /** Removed by the recorded instance UID: a successor under the same name is never removed. */
  async removeInstance(mapping: ManagedRunner): Promise<void> {
    await this.channel.removeContainer(managedPodName(mapping.runnerId), mapping.podUid!);
  }

  /** Asks the recorded container to stop: SIGTERM, the channel's grace, then a kill. Never a proof. */
  async stopInstance(mapping: ManagedRunner): Promise<void> {
    await this.channel.stopContainer(managedPodName(mapping.runnerId), mapping.podUid!);
  }

  // ── stop proof ─────────────────────────────────────────────────────────────────────────────

  observedStop(predecessor: ManagedRunnerPredecessor, instance: DockerInstance, now: Date): ObservedStopProof {
    const { view } = instance;
    const neverRan = view.status === 'created' && view.neverStarted;
    return {
      kind: 'OBSERVED_STOP',
      predecessor,
      recordedAt: now.toISOString(),
      observation: {
        phase: view.status,
        containers: [neverRan
          ? { name: 'runner', state: 'waiting' }
          : {
            name: 'runner',
            state: 'terminated',
            ...(view.exitCode !== null ? { exitCode: view.exitCode } : {}),
            ...(view.finishedAt ? { finishedAt: view.finishedAt } : {}),
          }],
      },
    };
  }

  async readFencingReceipt(mapping: ManagedRunner, predecessor: ManagedRunnerPredecessor, _backing: ManagedVolumeBacking, now: Date): Promise<ManagedFencingReceipt | null> {
    const receipt = await this.channel.fencingReceipt(mapping.runnerId);
    if (receipt === null) return null;
    const source = `channel fencing/${mapping.runnerId}.json`;
    return { source, verdict: readDockerFencingReceipt(receipt, source, predecessor, now) };
  }

  failure(error: unknown): ManagedRunnerBackendFailure | null {
    if (error instanceof DockerChannelUnreachable) return error.connected ? { retryable: true } : { retryable: true, unreachable: true };
    if (!(error instanceof DockerChannelError)) return null;
    if (error.status >= 500 || error.status === 429 || error.status === 408) return { retryable: true };
    const log = `the Docker channel answered ${error.status} ${error.code}: ${error.message}`;
    if (error.status === 401) return { retryable: false, code: 'DOCKER_CHANNEL_FORBIDDEN', detail: `HTTP 401 ${error.code}`, log };
    if (error.code === 'VOLUME_OVER_LIMIT') return { retryable: false, code: 'VOLUME_OVER_LIMIT', detail: error.message, log };
    if (error.code === 'IMAGE_REFUSED' || error.code === 'LIMIT_REFUSED') {
      return { retryable: false, code: 'DOCKER_CHANNEL_MISMATCH', detail: `${error.code}: ${error.message}`, log };
    }
    return { retryable: false, code: 'DOCKER_CHANNEL_REFUSED', detail: `HTTP ${error.status} ${error.code}`, log };
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  /** What the mapping's container is made from: identities and the profile's amounts. */
  private containerRequest(mapping: ManagedRunner): ChannelContainerRequest {
    const share = this.computeShare();
    return {
      name: managedPodName(mapping.runnerId),
      image: this.profile.runner.image,
      ownerId: mapping.ownerId,
      runnerId: mapping.runnerId,
      generation: mapping.generation,
      volume: { name: mapping.pvcName, uid: mapping.pvcUid! },
      resources: { cpuMillis: share.cpuMillis, memoryBytes: share.memoryBytes, pids: this.profile.runner.resources.pids, tmpBytes: share.ephemeralBytes },
      runner: { serverUrl: this.profile.runner.serverUrl, maxConcurrent: this.profile.runner.maxConcurrent },
    };
  }

  /**
   * Ask; whatever the answer, a failure is followed by a read of the same name. What is found there is
   * returned for the caller's identity check — a create whose answer was lost after it was carried out
   * is adopted, never made twice — and only when nothing is there is the error passed on.
   */
  private async orReadBack<T>(ask: () => Promise<T>, read: () => Promise<T | null>): Promise<T> {
    try {
      return await ask();
    } catch (error) {
      const found = await read();
      if (found) return found;
      throw error;
    }
  }
}
