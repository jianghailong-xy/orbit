import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ManagedRunner } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { testDockerRunnerProfile } from '../test-support/docker-runner-profile.fixture';
import { FakeDockerChannel } from '../test-support/fake-docker-channel';
import { tripwireKubeClientFactory } from '../test-support/fake-kube-client';
import { ADOPTED_IMAGE_TTL_MS, DockerBackend, dockerCapacityBudget } from './docker-backend';
import { DockerChannelUnreachable } from './docker-channel-client';
import { ManagedRunnerConflict } from './managed-runner-backend';
import type { ManagedRunnerManager } from './managed-runner-manager';
import { freeRoom, placeNewMapping, type PlacementPool } from './managed-runner-placement';
import {
  DOCKER_IMAGE_FROM_CHANNEL,
  dockerHostProfile,
  dockerRunnerHosts,
  parseManagedRunnerProfile,
  type DockerRunnerProfile,
} from './managed-runner-profile';
import { managedPodName, managedPvcName } from './managed-runner-resources';
import { createManagedRunnerRuntime, type ManagedRunnerHostRuntime } from './managed-runner-runtime';
import { ManagedRunnerWorker } from './managed-runner-worker';

// Several Docker channel hosts (docs/managed-runner-remote-host-design.md, Proposal items 2 and 4, D2,
// D5, "Several channel hosts"): the `docker.hosts` profile, remote private-address channels and the
// https rule that comes with them, the channel's image adopted on a remote profile, one backend and
// manager per host, placement and draining, and a host that cannot be reached. The managers against a
// real database are managed-runner-hosts.pg.spec.ts.

const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const RUNNER = '0195c0de-0000-7000-8000-0000000000a1';
const OWNER = '0195c0de-0000-7000-8000-0000000000b1';
const IMAGE_A = `sha256:${'a'.repeat(64)}`;
const IMAGE_B = `sha256:${'b'.repeat(64)}`;

/** A profile in list form: two remote hosts on wg1, the runners reaching the server over https, the channel's image adopted. */
function twoHostFile(change: (p: Record<string, any>) => void = () => undefined): Record<string, any> {
  const p = structuredClone(testDockerRunnerProfile()) as unknown as Record<string, any>;
  p.docker = {
    hosts: [
      { instanceId: 'orbit-host-a', channel: { url: 'http://10.66.0.3:7781' }, tokenFile: '/etc/orbit/channel-a.token' },
      { instanceId: 'orbit-host-b', channel: { url: 'http://10.66.0.4:7781' }, tokenFile: '/etc/orbit/channel-b.token', capacity: { compute: { pods: 3 } }, draining: true },
    ],
  };
  p.runner.serverUrl = 'https://orbitd.io';
  p.runner.image = 'channel';
  change(p);
  return p;
}

function problemsOf(value: Record<string, any>): string[] {
  const result = parseManagedRunnerProfile(value);
  return result.ok ? [] : result.problems;
}

function mapping(change: Partial<ManagedRunner> = {}): ManagedRunner {
  return {
    id: 'mapping', ownerId: OWNER, runnerId: RUNNER, generation: 1, backend: 'docker', clusterKey: 'docker-fake', namespace: 'orbit-docker-fake',
    pvcName: managedPvcName(RUNNER), pvcUid: null, pvUid: null, volumeHandle: null, podName: null, podUid: null, nodeName: null, ...change,
  } as ManagedRunner;
}

test('docker.hosts: remote private-address channels, each host its own instance, capacity and draining', () => {
  const parsed = parseManagedRunnerProfile(twoHostFile());
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.problems));
  const profile = parsed.profile as DockerRunnerProfile;
  assert.equal(profile.runner.image, DOCKER_IMAGE_FROM_CHANNEL);
  assert.deepEqual(dockerRunnerHosts(profile), [
    { instanceId: 'orbit-host-a', channel: { url: 'http://10.66.0.3:7781' }, tokenFile: '/etc/orbit/channel-a.token', remote: true, draining: false },
    { instanceId: 'orbit-host-b', channel: { url: 'http://10.66.0.4:7781' }, tokenFile: '/etc/orbit/channel-b.token', remote: true, draining: true, capacity: { compute: { pods: 3 } } },
  ]);
  // The first host's channel stands in `docker` too, for whatever reads one channel.
  assert.deepEqual({ ...profile.docker, hosts: undefined }, { instanceId: 'orbit-host-a', channel: { url: 'http://10.66.0.3:7781' }, tokenFile: '/etc/orbit/channel-a.token', hosts: undefined });
  // Each host's backend gets its own channel and capacity, and nothing of the list.
  const [a, b] = dockerRunnerHosts(profile);
  assert.deepEqual(dockerHostProfile(profile, b).docker, { instanceId: 'orbit-host-b', channel: { url: 'http://10.66.0.4:7781' }, tokenFile: '/etc/orbit/channel-b.token' });
  assert.deepEqual(dockerHostProfile(profile, b).capacity, { compute: { pods: 3 } });
  assert.equal(dockerHostProfile(profile, a).capacity, undefined);
  const shared = parseManagedRunnerProfile(twoHostFile((p) => (p.capacity = { maxActiveUsers: 5 })));
  assert.ok(shared.ok);
  const sharedProfile = shared.profile as DockerRunnerProfile;
  assert.deepEqual(dockerHostProfile(sharedProfile, dockerRunnerHosts(sharedProfile)[0]).capacity, { maxActiveUsers: 5 }, 'a host without its own capacity takes the profile\'s');
  assert.deepEqual(dockerHostProfile(sharedProfile, dockerRunnerHosts(sharedProfile)[1]).capacity, { compute: { pods: 3 } }, 'a host\'s own capacity wins');

  // Every private IPv4 range is a channel host's address, a socket and loopback stay local.
  for (const url of ['http://10.0.0.5:7781', 'http://172.16.0.1:7781', 'http://172.31.255.1:7781', 'http://192.168.1.11:7781', 'http://100.64.0.9:7781', 'http://100.127.0.1:7781']) {
    assert.deepEqual(problemsOf(twoHostFile((p) => (p.docker.hosts[0].channel = { url }))), [], url);
  }
  const mixed = parseManagedRunnerProfile(twoHostFile((p) => (p.docker.hosts[0].channel = { socketPath: '/run/orbit-docker-channel/channel.sock' })));
  assert.ok(mixed.ok);
  assert.deepEqual(dockerRunnerHosts(mixed.profile as DockerRunnerProfile).map((h) => h.remote), [false, true]);
});

test('a remote host requires an https runner.serverUrl, and every docker.hosts field is checked', () => {
  const cases: Array<[string, (p: Record<string, any>) => void, RegExp]> = [
    ['plain http to a private server address', (p) => (p.runner.serverUrl = 'http://10.66.0.1:2086'), /runner\.serverUrl must be an https URL when a channel host is remote/],
    ['plain http to loopback', (p) => (p.runner.serverUrl = 'http://127.0.0.1:3000'), /runner\.serverUrl must be an https URL when a channel host is remote/],
    ['plain http to a container-network name', (p) => (p.runner.serverUrl = 'http://apiserver:3000'), /must be an https URL when a channel host is remote/],
    ['a channel on a public address', (p) => (p.docker.hosts[1].channel = { url: 'http://8.8.8.8:7781' }), /docker\.hosts\.1\.channel\.url must be http:\/\/127\.0\.0\.1/],
    ['a channel on link-local', (p) => (p.docker.hosts[1].channel = { url: 'http://169.254.0.1:7781' }), /docker\.hosts\.1\.channel\.url must be/],
    ['a channel on a private IPv6 address', (p) => (p.docker.hosts[1].channel = { url: 'http://[fd00::1]:7781' }), /docker\.hosts\.1\.channel\.url must be/],
    ['a channel without a port', (p) => (p.docker.hosts[1].channel = { url: 'http://10.66.0.4' }), /docker\.hosts\.1\.channel\.url must be/],
    ['a channel with a path', (p) => (p.docker.hosts[1].channel = { url: 'http://10.66.0.4:7781/v1' }), /docker\.hosts\.1\.channel\.url must be/],
    ['a channel over https', (p) => (p.docker.hosts[1].channel = { url: 'https://10.66.0.4:7781' }), /docker\.hosts\.1\.channel\.url must be/],
    ['two channels in one host', (p) => (p.docker.hosts[0].channel = { url: 'http://10.66.0.3:1', socketPath: '/run/c.sock' }), /docker\.hosts\.0\.channel must name exactly one/],
    ['Docker\'s own socket', (p) => (p.docker.hosts[0].channel = { socketPath: '/var/run/docker.sock' }), /never Docker's own/],
    ['the same instance twice', (p) => (p.docker.hosts[1].instanceId = 'orbit-host-a'), /names instance orbit-host-a twice/],
    ['an instance that is no DNS label', (p) => (p.docker.hosts[1].instanceId = 'Host_B'), /docker\.hosts\.1\.instanceId must be a DNS label/],
    ['a relative token file', (p) => (p.docker.hosts[0].tokenFile = 'token'), /docker\.hosts\.0\.tokenFile must be an absolute path/],
    ['a draining that is no boolean', (p) => (p.docker.hosts[0].draining = 'yes'), /docker\.hosts\.0\.draining must be true or false/],
    ['a host capacity that is no quantity', (p) => (p.docker.hosts[1].capacity = { compute: { cpu: 'lots' } }), /docker\.hosts\.1\.capacity\.compute\.cpu is not a quantity/],
    ['a host reserve above 0.9', (p) => (p.docker.hosts[1].capacity = { reserve: { memory: 0.95 } }), /docker\.hosts\.1\.capacity\.reserve\.memory must be a fraction/],
    ['an empty list', (p) => (p.docker.hosts = []), /docker\.hosts must be a non-empty list/],
    ['a list and a single channel', (p) => (p.docker.channel = { socketPath: '/run/c.sock' }), /docker\.channel belongs in each entry of docker\.hosts/],
    ['an image that is neither an ID nor "channel"', (p) => (p.runner.image = 'orbit-managed-runner:local'), /runner\.image must be the local image ID .*, or "channel"/],
  ];
  for (const [what, change, expected] of cases) {
    const problems = problemsOf(twoHostFile(change));
    assert.ok(problems.some((p) => expected.test(p)), `${what}: ${JSON.stringify(problems)}`);
  }
  // A pinned image ID still works on a remote profile.
  assert.deepEqual(problemsOf(twoHostFile((p) => (p.runner.image = IMAGE_A))), []);
});

test('the single-channel form keeps its rules, may be remote, and "channel" is for a remote profile only', () => {
  const single = testDockerRunnerProfile();
  const parsed = parseManagedRunnerProfile(structuredClone(single));
  assert.deepEqual(parsed, { ok: true, profile: single }, 'today\'s profile parses to exactly what it was: no hosts list');
  assert.deepEqual(dockerRunnerHosts(single), [{ ...single.docker, remote: false, draining: false }]);
  assert.equal(dockerHostProfile(single, dockerRunnerHosts(single)[0]), single, 'its one host\'s profile is the profile itself');

  const local = structuredClone(single) as unknown as Record<string, any>;
  local.runner.image = 'channel';
  assert.ok(problemsOf(local).some((p) => /runner\.image may be "channel" only on a profile with a remote channel host/.test(p)), JSON.stringify(problemsOf(local)));

  const remote = structuredClone(single) as unknown as Record<string, any>;
  remote.docker.channel = { url: 'http://10.66.0.3:7781' };
  assert.ok(problemsOf(remote).some((p) => /runner\.serverUrl must be an https URL when a channel host is remote/.test(p)), 'the fixture\'s http serverUrl is refused once the channel is remote');
  remote.runner.serverUrl = 'https://orbitd.io';
  remote.runner.image = 'channel';
  const accepted = parseManagedRunnerProfile(remote);
  assert.ok(accepted.ok, JSON.stringify(!accepted.ok && accepted.problems));
  assert.deepEqual(dockerRunnerHosts(accepted.profile as DockerRunnerProfile).map((h) => [h.instanceId, h.remote]), [['orbit-docker-fake', true]]);
});

test('on a remote profile DockerBackend adopts the image its channel reports, and still checks the instance', async () => {
  let clock = 1_000_000;
  const profile: DockerRunnerProfile = { ...testDockerRunnerProfile(), runner: { ...testDockerRunnerProfile().runner, image: DOCKER_IMAGE_FROM_CHANNEL, serverUrl: 'https://orbitd.io' } };
  const channel = new FakeDockerChannel(profile.docker.instanceId, IMAGE_A);
  const backend = new DockerBackend(channel, profile, () => clock);
  assert.deepEqual(await backend.capacityBudget(), dockerCapacityBudget(channel.host, profile), 'any image ID of the channel\'s own is accepted');

  // A container is made from the image the channel reports at that moment.
  const volume = await backend.createVolume(mapping());
  const backing = await backend.readBacking(volume);
  const recorded = mapping({ pvcUid: volume.uid, pvUid: backing.uid, volumeHandle: backing.handle });
  await backend.issueCredential(recorded, 'the-credential-0123456789');
  await backend.requireInstanceGuard(recorded);
  const instance = await backend.createInstance(recorded);
  assert.equal(channel.containers.get(managedPodName(RUNNER))!.request.image, IMAGE_A);
  assert.equal(instance.previousImage, undefined);

  // The channel host is upgraded: within the adopted image's lifetime the running container is still current,
  // after it the channel is asked again and the container is of a previous image.
  channel.image = IMAGE_B;
  assert.equal((await backend.readInstance(recorded))!.previousImage, undefined);
  clock += ADOPTED_IMAGE_TTL_MS + 1;
  assert.equal((await backend.readInstance(recorded))!.previousImage, IMAGE_A);

  // Before anything is created the channel is always asked afresh, so a create never names an image it would refuse.
  const fresh = new DockerBackend(channel, profile, () => clock);
  await fresh.capacityBudget();
  channel.image = `sha256:${'c'.repeat(64)}`;
  await channel.removeContainer(managedPodName(RUNNER), instance.uid).catch(() => undefined);
  channel.containers.delete(managedPodName(RUNNER));
  const next = mapping({ ...recorded, generation: 1 });
  await fresh.requireInstanceGuard(next);
  await fresh.createInstance(next);
  assert.equal(channel.containers.get(managedPodName(RUNNER))!.request.image, `sha256:${'c'.repeat(64)}`);

  // Another instance is refused whatever its image, and so is an image that is no image ID.
  const other = new DockerBackend(new FakeDockerChannel('another-instance', IMAGE_A), profile);
  await assert.rejects(other.capacityBudget(), (e: unknown) => e instanceof ManagedRunnerConflict && e.code === 'DOCKER_CHANNEL_MISMATCH');
  await assert.rejects(other.requireInstanceGuard(recorded), (e: unknown) => e instanceof ManagedRunnerConflict && e.code === 'DOCKER_CHANNEL_MISMATCH', 'nothing is made on it either');
  const nonsense = new DockerBackend(new FakeDockerChannel(profile.docker.instanceId, 'orbit-managed-runner:local'), profile);
  await assert.rejects(nonsense.capacityBudget(), (e: unknown) => e instanceof ManagedRunnerConflict && e.code === 'DOCKER_CHANNEL_MISMATCH');

  // A pinned profile still refuses a channel on another image.
  const pinned = new DockerBackend(new FakeDockerChannel(profile.docker.instanceId, IMAGE_B), { ...profile, runner: { ...profile.runner, image: IMAGE_A } });
  await assert.rejects(pinned.capacityBudget(), (e: unknown) => e instanceof ManagedRunnerConflict && e.code === 'DOCKER_CHANNEL_MISMATCH');
});

test('one backend and one manager per host, each scoped to its own location; a single host is scoped as before', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-docker-hosts-'));
  try {
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify(twoHostFile()));
    const made: DockerRunnerProfile[] = [];
    const constructed: string[] = [];
    const runtime = createManagedRunnerRuntime({
      profilePath: file,
      prisma: {} as PrismaService,
      kubeClient: tripwireKubeClientFactory(constructed),
      dockerChannel: (profile) => {
        made.push(profile);
        return new FakeDockerChannel(profile.docker.instanceId, IMAGE_A);
      },
      log: quiet,
    });
    assert.ok(runtime.available);
    assert.deepEqual(made.map((p) => [p.docker.instanceId, 'url' in p.docker.channel ? p.docker.channel.url : null, p.docker.tokenFile]), [
      ['orbit-host-a', 'http://10.66.0.3:7781', '/etc/orbit/channel-a.token'],
      ['orbit-host-b', 'http://10.66.0.4:7781', '/etc/orbit/channel-b.token'],
    ], 'one channel per host, each from its own entry');
    assert.deepEqual(runtime.hosts!.map((h) => [h.instanceId, h.draining, h.manager.backend.location, h.manager.scope]), [
      ['orbit-host-a', false, { clusterKey: 'docker-fake', namespace: 'orbit-host-a' }, { backend: 'docker', clusterKey: 'docker-fake', namespace: 'orbit-host-a' }],
      ['orbit-host-b', true, { clusterKey: 'docker-fake', namespace: 'orbit-host-b' }, { backend: 'docker', clusterKey: 'docker-fake', namespace: 'orbit-host-b' }],
    ]);
    assert.equal(runtime.manager, runtime.hosts![0].manager);
    const [a, b] = runtime.hosts!.map((h) => h.manager);
    assert.equal(a.owns({ backend: 'docker', clusterKey: 'docker-fake', namespace: 'orbit-host-a' }), true);
    assert.equal(a.owns({ backend: 'docker', clusterKey: 'docker-fake', namespace: 'orbit-host-b' }), false);
    assert.equal(b.owns({ backend: 'docker', clusterKey: 'docker-fake', namespace: 'orbit-host-b' }), true);
    assert.equal(a.owns({ backend: 'kubernetes', clusterKey: 'docker-fake', namespace: 'orbit-host-a' }), false);
    assert.deepEqual(constructed, []);

    // Today's profile: one host, one manager, every Docker mapping its own, as before the list.
    writeFileSync(file, JSON.stringify(testDockerRunnerProfile()));
    const single = createManagedRunnerRuntime({
      profilePath: file,
      prisma: {} as PrismaService,
      kubeClient: tripwireKubeClientFactory(constructed),
      dockerChannel: (profile) => new FakeDockerChannel(profile.docker.instanceId, profile.runner.image),
      log: quiet,
    });
    assert.ok(single.available);
    assert.equal(single.hosts!.length, 1);
    assert.deepEqual(single.manager.scope, { backend: 'docker' });
    assert.equal(single.manager.owns({ backend: 'docker', clusterKey: 'an-older-key', namespace: 'an-older-instance' }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function pool(totalPods: number, reservedPods: number, change: Partial<PlacementPool> = {}): PlacementPool {
  const GiB = 2 ** 30;
  return {
    cpuMillis: BigInt(100_000), memoryBytes: BigInt(200 * GiB), ephemeralBytes: BigInt(200 * GiB), pods: totalPods, attachments: 100, activeUsers: 100,
    storageUsableBytes: BigInt(1000 * GiB), storageHeadroomBytes: BigInt(100 * GiB),
    cpuMillisReserved: BigInt(reservedPods * 1000), memoryBytesReserved: BigInt(reservedPods * 2 * GiB), ephemeralBytesReserved: BigInt(0),
    podsReserved: reservedPods, attachmentsReserved: reservedPods, activeUsersReserved: reservedPods, durableBytesReserved: BigInt(reservedPods * 10 * GiB),
    ...change,
  };
}

test('free room counts every dimension: the tightest one decides', () => {
  const backend = new DockerBackend(new FakeDockerChannel('x', IMAGE_A), testDockerRunnerProfile());
  const [compute, storage] = [backend.computeShare(), backend.storageShare()];
  assert.equal(freeRoom(pool(10, 3), compute, storage), 7, 'slots');
  assert.equal(freeRoom(pool(10, 0, { cpuMillis: BigInt(2500) }), compute, storage), 2, 'CPU: 2.5 runners is 2');
  assert.equal(freeRoom(pool(10, 0, { storageUsableBytes: BigInt(130 * 2 ** 30) }), compute, storage), 3, 'storage less headroom: 30 GiB is 3 volumes');
  assert.equal(freeRoom(pool(10, 10), compute, storage), 0, 'full');
  assert.equal(freeRoom(pool(10, 12), compute, storage), 0, 'totals below what is reserved: still no room, never negative');
});

test('placement: the non-draining host with the most free room; ties to the earlier host; none when all drain', async () => {
  const hostOf = (namespace: string, draining = false): ManagedRunnerHostRuntime => {
    const backend = new DockerBackend(new FakeDockerChannel(namespace, IMAGE_A), testDockerRunnerProfile({ instanceId: namespace }));
    return { instanceId: namespace, draining, manager: { backend } as unknown as ManagedRunnerManager };
  };
  const rows: Array<PlacementPool & { clusterKey: string; namespace: string }> = [];
  const asked: unknown[] = [];
  const prisma = {
    managedRunnerCapacity: {
      findMany: async (query: { where: { OR: Array<{ clusterKey: string; namespace: string }> } }) => {
        asked.push(query.where.OR.map((l) => l.namespace));
        return rows.filter((row) => query.where.OR.some((l) => l.clusterKey === row.clusterKey && l.namespace === row.namespace));
      },
    },
  } as unknown as PrismaService;
  const set = (namespace: string, total: number, reserved: number) => {
    const at = rows.findIndex((row) => row.namespace === namespace);
    if (at >= 0) rows.splice(at, 1);
    rows.push({ clusterKey: 'docker-fake', namespace, ...pool(total, reserved) });
  };
  const a = hostOf('host-a');
  const b = hostOf('host-b');
  const c = hostOf('host-c');
  const place = async (...hosts: ManagedRunnerHostRuntime[]) => (await placeNewMapping(prisma, { manager: hosts[0].manager, hosts }))?.backend.location.namespace ?? null;

  assert.equal(await place(a, b), 'host-a', 'no pool row anywhere yet: the first host');
  set('host-b', 4, 0);
  assert.equal(await place(a, b), 'host-b', 'a host whose pool is known beats one never heard from');
  set('host-a', 4, 1);
  assert.equal(await place(a, b), 'host-b', '4 free beats 3');
  set('host-b', 4, 1);
  assert.equal(await place(a, b), 'host-a', 'a tie goes to the earlier host');
  set('host-a', 4, 4);
  set('host-b', 4, 4);
  assert.equal(await place(a, b), 'host-a', 'both full: still placed, to wait for room in its own pool');
  set('host-c', 50, 0);
  assert.equal(await place(a, b, { ...c, draining: true }), 'host-a', 'a draining host takes no new runner, however much room it has');
  assert.deepEqual(asked.at(-1), ['host-a', 'host-b'], 'a draining host\'s pool is not even read');
  assert.equal(await place({ ...a, draining: true }, { ...b, draining: true }), null, 'every host draining: nowhere');

  // One host, or a runtime with no hosts list (Kubernetes): that manager, with nothing read.
  const reads = asked.length;
  assert.equal((await placeNewMapping(prisma, { manager: a.manager, hosts: [a] })), a.manager);
  assert.equal((await placeNewMapping(prisma, { manager: a.manager })), a.manager);
  assert.equal(asked.length, reads, 'a single host reads no pool');
});

test('the Docker backend tracks whether its channel can be reached: marked by a call that reaches nothing, cleared by any answer', async () => {
  const profile = testDockerRunnerProfile({ instanceId: 'host-a' });
  const channel = new FakeDockerChannel('host-a', profile.runner.image);
  const backend = new DockerBackend(channel, profile);
  assert.equal(backend.unreachable, false, 'nothing heard yet: not marked');
  channel.down = true;
  await assert.rejects(backend.readVolume(mapping()));
  assert.equal(backend.unreachable, true, 'a call that reached nothing marks it');
  channel.down = false;
  channel.failNext('readContainer', { kind: 'refused', status: 409, code: 'CONFLICT' });
  await assert.rejects(backend.readInstance(mapping()));
  assert.equal(backend.unreachable, false, 'a refusal is an answer: cleared');
  channel.down = true;
  await assert.rejects(backend.capacityBudget());
  assert.equal(backend.unreachable, true);
  channel.down = false;
  await backend.capacityBudget();
  assert.equal(backend.unreachable, false, 'an answer clears it');

  // A call that connected and then lost its answer says nothing new either way.
  let lost = false;
  const flaky = new Proxy(channel, {
    get: (target, key, receiver) => (key === 'readVolume' && lost
      ? async () => { throw new DockerChannelUnreachable('injected: the answer broke off'); }
      : Reflect.get(target, key, receiver)),
  });
  const other = new DockerBackend(flaky, profile);
  channel.down = true;
  await assert.rejects(other.readInstance(mapping()));
  channel.down = false;
  lost = true;
  await assert.rejects(other.readVolume(mapping()), DockerChannelUnreachable);
  assert.equal(other.unreachable, true, 'still marked');
  lost = false;
  await other.readVolume(mapping());
  assert.equal(other.unreachable, false);
});

test('placement skips a host whose channel cannot be reached while another is reachable; eligible again once it answers; all unreachable still places', async () => {
  const channels = new Map<string, FakeDockerChannel>();
  const hostOf = (namespace: string): ManagedRunnerHostRuntime => {
    const channel = new FakeDockerChannel(namespace, IMAGE_A);
    channels.set(namespace, channel);
    const backend = new DockerBackend(channel, testDockerRunnerProfile({ instanceId: namespace }));
    return { instanceId: namespace, draining: false, manager: { backend } as unknown as ManagedRunnerManager };
  };
  const rows = [
    { clusterKey: 'docker-fake', namespace: 'host-a', ...pool(4, 3) },
    { clusterKey: 'docker-fake', namespace: 'host-b', ...pool(8, 0) },
  ];
  const asked: string[][] = [];
  const prisma = {
    managedRunnerCapacity: {
      findMany: async (query: { where: { OR: Array<{ clusterKey: string; namespace: string }> } }) => {
        asked.push(query.where.OR.map((l) => l.namespace));
        return rows.filter((row) => query.where.OR.some((l) => l.clusterKey === row.clusterKey && l.namespace === row.namespace));
      },
    },
  } as unknown as PrismaService;
  const a = hostOf('host-a');
  const b = hostOf('host-b');
  const backendOf = (host: ManagedRunnerHostRuntime) => host.manager.backend as DockerBackend;
  const place = async (...hosts: ManagedRunnerHostRuntime[]) => (await placeNewMapping(prisma, { manager: hosts[0].manager, hosts }))?.backend.location.namespace ?? null;

  assert.equal(await place(a, b), 'host-b', 'both reachable: the one with more stored room');

  // B's channel goes down, and a pass of B's manager finds it so.
  channels.get('host-b')!.down = true;
  await assert.rejects(backendOf(b).readInstance(mapping()));
  assert.equal(backendOf(b).unreachable, true);
  assert.equal(await place(a, b), 'host-a', 'B shows 8 free against A\'s 1, but B cannot be reached');
  assert.deepEqual(asked.at(-1), ['host-a'], 'an unreachable host\'s pool is not even read');
  assert.equal(await place(b, a), 'host-a', 'whatever the order');

  // B answers again on its next pass.
  channels.get('host-b')!.down = false;
  await backendOf(b).readInstance(mapping());
  assert.equal(backendOf(b).unreachable, false);
  assert.equal(await place(a, b), 'host-b', 'once it answers, B is eligible again');

  // Every host unreachable: still placed by stored room, to start once its host is back.
  for (const host of [a, b]) {
    channels.get(host.instanceId)!.down = true;
    await assert.rejects(backendOf(host).readInstance(mapping()));
  }
  assert.equal(await place(a, b), 'host-b', 'all unreachable: the most stored room, as before');
  assert.deepEqual(asked.at(-1), ['host-a', 'host-b']);
  // A draining host stays skipped even when it is the only reachable one.
  channels.get('host-b')!.down = false;
  await backendOf(b).readInstance(mapping());
  assert.equal(await place(a, { ...b, draining: true }), 'host-a', 'the reachable host drains; the unreachable one is the only open one');

  // One host: that manager, unreachable or not, with nothing read.
  const reads = asked.length;
  assert.equal(await placeNewMapping(prisma, { manager: a.manager, hosts: [a] }), a.manager);
  assert.equal(asked.length, reads, 'a single host reads no pool');
});

test('a host marked unreachable with no mapping to call on it is asked once per poll interval, and placed on again once it answers', async () => {
  let clock = 1_000_000;
  const channels = new Map<string, FakeDockerChannel>();
  const hostOf = (namespace: string): ManagedRunnerHostRuntime => {
    const profile = testDockerRunnerProfile({ instanceId: namespace });
    const channel = new FakeDockerChannel(namespace, profile.runner.image);
    channels.set(namespace, channel);
    const backend = new DockerBackend(channel, profile, () => clock);
    // A manager with nothing due: no mapping on this host (or all asleep), so no pass calls its channel.
    const manager = { backend, sweepDemand: async () => 0, dueMappings: async () => [], reconcile: async () => 'IDLE' };
    return { instanceId: namespace, draining: false, manager: manager as unknown as ManagedRunnerManager };
  };
  const rows = [
    { clusterKey: 'docker-fake', namespace: 'host-a', ...pool(4, 3) },
    { clusterKey: 'docker-fake', namespace: 'host-b', ...pool(8, 0) },
  ];
  const prisma = {
    managedRunnerCapacity: {
      findMany: async (query: { where: { OR: Array<{ clusterKey: string; namespace: string }> } }) =>
        rows.filter((row) => query.where.OR.some((l) => l.clusterKey === row.clusterKey && l.namespace === row.namespace)),
    },
  } as unknown as PrismaService;
  const a = hostOf('host-a');
  const b = hostOf('host-b');
  const channelB = channels.get('host-b')!;
  const backendB = b.manager.backend as DockerBackend;
  const interval = testDockerRunnerProfile().lifecycle.pollIntervalSeconds * 1000;
  const worker = new ManagedRunnerWorker([a.manager, b.manager], interval, { error: () => undefined });
  const place = async () => (await placeNewMapping(prisma, { manager: a.manager, hosts: [a, b] }))?.backend.location.namespace ?? null;

  await worker.drain();
  assert.equal(channelB.count('info'), 0, 'reachable: a pass asks nothing new');
  assert.equal(channels.get('host-a')!.count('info'), 0);

  // B is found unreachable once (its pool sync, or the last runner's stop), then has nothing to call on it.
  channelB.down = true;
  await assert.rejects(backendB.capacityBudget());
  const asked = channelB.count('info');
  assert.equal(await place(), 'host-a');
  await worker.drain();
  assert.equal(channelB.count('info'), asked + 1, 'while marked: one /v1/info in the pass');
  await worker.drain();
  await worker.drain();
  assert.equal(channelB.count('info'), asked + 1, 'at most once per poll interval, however many passes are kicked');
  assert.equal(backendB.unreachable, true, 'still down: still marked');

  // B comes back with no mapping touching it: the next pass after the interval notices.
  channelB.down = false;
  clock += interval;
  await worker.drain();
  assert.equal(channelB.count('info'), asked + 2);
  assert.equal(backendB.unreachable, false, 'its answer clears the mark');
  assert.equal(await place(), 'host-b', 'placed on again');
  clock += interval;
  await worker.drain();
  assert.equal(channelB.count('info'), asked + 2, 'reachable again: nothing new asked');

  // A single host is driven as before: the loop asks nothing of a marked backend.
  const single = hostOf('host-s');
  const channelS = channels.get('host-s')!;
  channelS.down = true;
  await assert.rejects((single.manager.backend as DockerBackend).capacityBudget());
  const singleAsked = channelS.count('info');
  channelS.down = false;
  clock += interval;
  await new ManagedRunnerWorker(single.manager, interval, { error: () => undefined }).drain();
  assert.equal(channelS.count('info'), singleAsked, 'one host: no recheck');
});

test('the loop drives every host; one whose channel cannot be reached does not stop the others', async () => {
  const visited: string[] = [];
  const errors: string[] = [];
  const managerOf = (name: string, fail = false) => ({
    backend: { location: { clusterKey: 'k', namespace: name } },
    sweepDemand: async () => {
      visited.push(`${name}:sweep`);
      return 0;
    },
    dueMappings: async () => {
      if (fail) throw new Error(`the channel of ${name} is unreachable`);
      return [`${name}-1`, `${name}-2`];
    },
    reconcile: async (id: string) => {
      visited.push(id);
      return 'READY';
    },
  }) as unknown as ManagedRunnerManager;
  const worker = new ManagedRunnerWorker([managerOf('a', true), managerOf('b')], 60_000, { error: (m: string) => errors.push(m) });
  await worker.drain();
  assert.deepEqual(visited, ['a:sweep', 'b-1', 'b-2'], 'the demand sweep once, then host b\'s mappings although host a failed');
  assert.deepEqual(errors, ['managed runner pass failed on k/a: the channel of a is unreachable']);

  // One manager: a failure is the pass's own, as before.
  const single = new ManagedRunnerWorker(managerOf('a', true), 60_000, { error: () => undefined });
  await assert.rejects(single.drain(), /unreachable/);
});
