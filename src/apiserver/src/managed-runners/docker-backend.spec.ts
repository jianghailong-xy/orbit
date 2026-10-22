import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ExecutionContext } from '@nestjs/common';
import type { ManagedRunner } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { testDockerRunnerProfile } from '../test-support/docker-runner-profile.fixture';
import { FakeDockerChannel } from '../test-support/fake-docker-channel';
import { tripwireKubeClientFactory } from '../test-support/fake-kube-client';
import { DOCKER_DEFAULT_RESERVE, DockerBackend, dockerCapacityBudget, dockerComputeShare } from './docker-backend';
import { DockerChannelClient, DockerChannelError, DockerChannelUnreachable, dockerChannelFromProfile, type ChannelHost } from './docker-channel-client';
import { ManagedRunnerAdmissionGuard } from './managed-runner-admission.controller';
import { ManagedInstanceLimit, ManagedRunnerConflict, ManagedVolumeHeld } from './managed-runner-backend';
import type { ManagedRunnerPredecessor } from './managed-runner-fencing';
import { parseManagedRunnerProfile, type DockerRunnerProfile } from './managed-runner-profile';
import { managedPodName, managedPvcName, managedSecretName } from './managed-runner-resources';
import { createManagedRunnerRuntime } from './managed-runner-runtime';

// The Docker backend (docker-backend.ts): its profile, its budget derived from the host, the channel
// client's wire behaviour, DockerBackend over a channel that keeps the real one's rules
// (test-support/fake-docker-channel.ts), and the admission webhook's answer on a Docker server. The
// manager on DockerBackend is docker-backend.pg.spec.ts; the channel itself is
// scripts/managed-runner/docker_channel_test.py; real Docker is scripts/managed-runner/docker-backend-it.py.

const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const RUNNER = '0195c0de-0000-7000-8000-0000000000a1';
const OWNER = '0195c0de-0000-7000-8000-0000000000b1';
const GiB = 2 ** 30;
const EXAMPLE = path.resolve(__dirname, '../../../../deploy/managed-runner/docker-channel/manager-profile.example.json');

function mapping(change: Partial<ManagedRunner> = {}): ManagedRunner {
  return {
    id: 'mapping', ownerId: OWNER, runnerId: RUNNER, generation: 1, backend: 'docker', clusterKey: 'docker-fake', namespace: 'orbit-docker-fake',
    pvcName: managedPvcName(RUNNER), pvcUid: null, pvUid: null, volumeHandle: null, podName: null, podUid: null, nodeName: null, ...change,
  } as ManagedRunner;
}

function world(profile: DockerRunnerProfile = testDockerRunnerProfile()) {
  const channel = new FakeDockerChannel(profile.docker.instanceId, profile.runner.image);
  return { profile, channel, backend: new DockerBackend(channel, profile) };
}

const withChange = (change: (profile: Record<string, any>) => void) => {
  const profile = structuredClone(testDockerRunnerProfile()) as unknown as Record<string, any>;
  change(profile);
  return parseManagedRunnerProfile(profile);
};

test('a complete Docker profile is accepted as it is', () => {
  const profile = testDockerRunnerProfile();
  assert.deepEqual(parseManagedRunnerProfile(structuredClone(profile)), { ok: true, profile });
  const stated = testDockerRunnerProfile({ capacity: { compute: { cpu: '6' }, storage: { usable: '100Gi' }, reserve: { disk: 0.2 }, maxActiveUsers: 3 } });
  assert.deepEqual(parseManagedRunnerProfile(structuredClone(stated)), { ok: true, profile: stated });
  const url = { ...testDockerRunnerProfile(), docker: { ...testDockerRunnerProfile().docker, channel: { url: 'http://127.0.0.1:7781' } } };
  assert.equal(parseManagedRunnerProfile(url).ok, true);
});

test('every Docker field is required and checked, and Kubernetes sections are refused', () => {
  const cases: Array<[string, (p: Record<string, any>) => void, RegExp]> = [
    ['an example profile', (p) => (p.valueKind = 'example'), /valueKind must be "actual"/],
    ['a Kubernetes section', (p) => (p.kubernetes = { namespace: 'x' }), /kubernetes belongs to the kubernetes backend/],
    ['an admission section', (p) => (p.admission = {}), /admission belongs to the kubernetes backend/],
    ['no channel', (p) => delete p.docker.channel, /docker\.channel must name exactly one of socketPath or url/],
    ['two channels', (p) => (p.docker.channel = { socketPath: '/run/c.sock', url: 'http://127.0.0.1:1' }), /exactly one/],
    ['Docker\'s own socket', (p) => (p.docker.channel = { socketPath: '/var/run/docker.sock' }), /never Docker's own/],
    ['a relative socket', (p) => (p.docker.channel = { socketPath: 'run/c.sock' }), /must be an absolute path/],
    ['a channel off loopback', (p) => (p.docker.channel = { url: 'http://10.0.0.5:7781' }), /listens on loopback only/],
    ['a channel over https', (p) => (p.docker.channel = { url: 'https://127.0.0.1:7781' }), /listens on loopback only/],
    ['a relative token file', (p) => (p.docker.tokenFile = 'token'), /docker\.tokenFile must be an absolute path/],
    ['an instance that is no DNS label', (p) => (p.docker.instanceId = 'Orbit_A'), /docker\.instanceId must be a DNS label/],
    ['an image by tag', (p) => (p.runner.image = 'orbit-managed-runner:local'), /runner\.image must be the local image ID/],
    ['an image by registry digest', (p) => (p.runner.image = `registry.invalid/x@sha256:${'a'.repeat(64)}`), /local image ID/],
    ['plain http to a public name', (p) => (p.runner.serverUrl = 'http://orbit.example.com'), /runner\.serverUrl must be an https URL, or http to a loopback or private address/],
    ['plain http to a public address', (p) => (p.runner.serverUrl = 'http://8.8.8.8:3000'), /runner\.serverUrl must be an https URL/],
    ['a server with credentials', (p) => (p.runner.serverUrl = 'https://u:p@orbit.example.com'), /must not carry credentials/],
    ['no PID limit', (p) => delete p.runner.resources.pids, /runner\.resources\.pids must be an integer from 16/],
    ['a CPU that is no quantity', (p) => (p.runner.resources.cpu = 'one'), /runner\.resources\.cpu is not a quantity/],
    ['/tmp beyond memory', (p) => (p.runner.tmpSizeLimit = '3Gi'), /tmpSizeLimit is a tmpfs held in memory/],
    ['a reserve above 0.9', (p) => (p.capacity = { reserve: { cpu: 0.95 } }), /capacity\.reserve\.cpu must be a fraction from 0 to 0\.9/],
    ['a stated budget that is no quantity', (p) => (p.capacity = { compute: { memory: 'lots' } }), /capacity\.compute\.memory is not a quantity/],
    ['no attempt budget', (p) => delete p.lifecycle.maxAttempts, /lifecycle\.maxAttempts must be an integer/],
    ['a backoff ceiling below its base', (p) => (p.lifecycle.backoffMaxSeconds = 1), /backoffMaxSeconds must not be below/],
    ['a placeholder', (p) => (p.clusterKey = 'REPLACE_ME'), /clusterKey is still a placeholder/],
  ];
  for (const [what, change, expected] of cases) {
    const result = withChange(change);
    assert.equal(result.ok, false, what);
    assert.ok(!result.ok && result.problems.some((p) => expected.test(p)), `${what}: ${JSON.stringify(!result.ok && result.problems)}`);
  }
  for (const serverUrl of ['http://172.30.0.1:3000', 'http://10.1.2.3', 'http://192.168.1.12:2086', 'http://apiserver:3000', 'http://[fd00::1]:3000', 'http://127.0.0.1:3000', 'https://orbit.example.com']) {
    assert.equal(withChange((p) => (p.runner.serverUrl = serverUrl)).ok, true, serverUrl);
  }
});

test('the shipped Docker example is refused as it stands, and has the fixture\'s shape', () => {
  const example = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  const refused = parseManagedRunnerProfile(example);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.problems.some((p) => /valueKind must be "actual"/.test(p)));
  assert.ok(!refused.ok && refused.problems.some((p) => /placeholder/.test(p)));
  const keys = (value: unknown, prefix = ''): string[] =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
      : [prefix.slice(0, -1)];
  assert.deepEqual(keys(example).sort(), keys(testDockerRunnerProfile({ capacity: { reserve: { cpu: 0.25, memory: 0.25, disk: 0.1 } } })).sort());
});

test('the budget is derived from the host less its reserve, and every stated dimension wins', () => {
  const host: ChannelHost = {
    name: 'h', cpus: 24, memoryBytes: 16 * GiB, serverVersion: '29',
    disk: { path: '/var/lib/docker', totalBytes: 1000 * GiB, freeBytes: 300 * GiB }, managedVolumeBytes: 20 * GiB,
  };
  const profile = testDockerRunnerProfile();
  assert.deepEqual(dockerComputeShare(profile), { cpuMillis: 1000, memoryBytes: 2 * GiB, ephemeralBytes: 512 * 2 ** 20, pods: 1, attachments: 1, activeUsers: 1 });
  assert.deepEqual(DOCKER_DEFAULT_RESERVE, { cpu: 0.25, memory: 0.25, disk: 0.1 });
  assert.deepEqual(dockerCapacityBudget(host, profile), {
    cpuMillis: 18_000,
    memoryBytes: 12 * GiB,
    ephemeralBytes: 12 * GiB, // /tmp is a tmpfs: it lives in the memory budget
    pods: 6, attachments: 6, activeUsers: 6, // memory fits six 2 GiB runners, CPU eighteen
    storageUsableBytes: 320 * GiB, // free, plus what this instance's volumes already hold
    storageHeadroomBytes: 100 * GiB, // a tenth of the disk kept free
  });
  const stated = testDockerRunnerProfile({
    capacity: { compute: { cpu: '4', memory: '8Gi', pods: 2 }, storage: { usable: '50Gi', headroom: '5Gi' }, maxActiveUsers: 1, reserve: { memory: 0.5 } },
  });
  assert.deepEqual(dockerCapacityBudget(host, stated), {
    cpuMillis: 4000, memoryBytes: 8 * GiB, ephemeralBytes: 8 * GiB, pods: 2, attachments: 4, activeUsers: 1,
    storageUsableBytes: 50 * GiB, storageHeadroomBytes: 5 * GiB,
  });
  const reserved = testDockerRunnerProfile({ capacity: { reserve: { memory: 0.5, cpu: 0, disk: 0.5 } } });
  const r = dockerCapacityBudget(host, reserved);
  assert.deepEqual([r.cpuMillis, r.memoryBytes, r.pods, r.storageHeadroomBytes], [24_000, 8 * GiB, 4, 500 * GiB]);
  // A disk the channel cannot see gives no storage until the profile states it: admission waits rather than guesses.
  assert.deepEqual([dockerCapacityBudget({ ...host, disk: null }, profile).storageUsableBytes, dockerCapacityBudget({ ...host, disk: null }, profile).storageHeadroomBytes], [0, 0]);
});

test('the budget holds no more runners than the channel makes containers', () => {
  const host: ChannelHost = {
    name: 'h', cpus: 24, memoryBytes: 16 * GiB, serverVersion: '29',
    disk: { path: '/var/lib/orbit-docker-volumes', totalBytes: 1000 * GiB, freeBytes: 300 * GiB }, managedVolumeBytes: 0,
  };
  const profile = testDockerRunnerProfile();
  // Memory fits six; a channel capped at four makes four, and the pool admits four.
  const capped = dockerCapacityBudget(host, profile, 4);
  assert.deepEqual([capped.pods, capped.attachments, capped.activeUsers], [4, 4, 4]);
  assert.equal(capped.cpuMillis, 18_000, 'compute and storage are as derived');
  // A cap above what the host fits changes nothing; neither does a channel that reports none, or nonsense.
  for (const cap of [6, 15, undefined, 0, -1, 2.5, Number.NaN]) {
    assert.deepEqual(dockerCapacityBudget(host, profile, cap), dockerCapacityBudget(host, profile), `cap ${cap}`);
  }
  // A stated pod count is held to the channel's cap too: the channel would refuse the rest.
  const stated = testDockerRunnerProfile({ capacity: { compute: { pods: 50 } } });
  assert.equal(dockerCapacityBudget(host, stated, 4).pods, 4);
  assert.equal(dockerCapacityBudget(host, stated).pods, 50);
});

test('a Docker profile runs on DockerBackend over the channel it names, and nothing is built for Kubernetes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-docker-runtime-'));
  try {
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify(testDockerRunnerProfile()));
    const constructed: string[] = [];
    const made: DockerRunnerProfile[] = [];
    const runtime = createManagedRunnerRuntime({
      profilePath: file,
      prisma: {} as PrismaService,
      kubeClient: tripwireKubeClientFactory(constructed),
      dockerChannel: (profile) => {
        made.push(profile);
        return new FakeDockerChannel(profile.docker.instanceId, profile.runner.image);
      },
      log: quiet,
    });
    assert.ok(runtime.available);
    assert.ok(runtime.manager.backend instanceof DockerBackend);
    assert.equal(runtime.manager.backend.name, 'docker');
    assert.deepEqual(runtime.manager.backend.location, { clusterKey: 'docker-fake', namespace: 'orbit-docker-fake' });
    assert.equal(made.length, 1);
    assert.deepEqual(constructed, [], 'no Kubernetes client was constructed');

    // The real channel client reads its token from a file nobody else may read.
    const unreadable = createManagedRunnerRuntime({ profilePath: file, prisma: {} as PrismaService, kubeClient: tripwireKubeClientFactory(constructed), log: quiet });
    assert.equal(unreadable.available, false);
    assert.match(!unreadable.available ? unreadable.problems[0] : '', /ENOENT|token file/);
    const token = path.join(dir, 'token');
    writeFileSync(token, 'x'.repeat(48), { mode: 0o644 });
    assert.throws(() => dockerChannelFromProfile({ ...testDockerRunnerProfile(), docker: { ...testDockerRunnerProfile().docker, tokenFile: token } }), /only its owner can read/);
    chmodSync(token, 0o600);
    writeFileSync(token, 'short');
    assert.throws(() => dockerChannelFromProfile({ ...testDockerRunnerProfile(), docker: { ...testDockerRunnerProfile().docker, tokenFile: token } }), /at least 32/);
    writeFileSync(token, 'x'.repeat(48));
    assert.ok(dockerChannelFromProfile({ ...testDockerRunnerProfile(), docker: { ...testDockerRunnerProfile().docker, tokenFile: token } }) instanceof DockerChannelClient);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DockerBackend names, pools, terms and budgets as its profile and host say', async () => {
  const { backend, channel, profile } = world();
  assert.deepEqual(backend.names(RUNNER), { volume: managedPvcName(RUNNER), instance: managedPodName(RUNNER), credential: managedSecretName(RUNNER) });
  assert.deepEqual(backend.terms, { volume: 'volume', backing: 'volume', credential: 'credential', instance: 'container', stopReport: "Docker's report" });
  assert.deepEqual(backend.storageShare(), { durableBytes: 10 * GiB });
  assert.deepEqual(await backend.capacityBudget(), dockerCapacityBudget(channel.host, profile));
  channel.limits = { maxContainers: 2 };
  assert.equal((await backend.capacityBudget()).pods, 2, 'the cap the channel reports in /v1/info');
  const mismatched = new DockerBackend(new FakeDockerChannel('another-instance', profile.runner.image), profile);
  await assert.rejects(mismatched.capacityBudget(), (e: unknown) => e instanceof ManagedRunnerConflict && e.code === 'DOCKER_CHANNEL_MISMATCH');
  const otherImage = new DockerBackend(new FakeDockerChannel(profile.docker.instanceId, `sha256:${'e'.repeat(64)}`), profile);
  await assert.rejects(otherImage.capacityBudget(), (e: unknown) => e instanceof ManagedRunnerConflict && e.code === 'DOCKER_CHANNEL_MISMATCH');
});

test('DockerBackend creates the data volume once, adopts one whose answer was lost, and checks whose it is', async () => {
  const { backend, channel } = world();
  assert.equal(await backend.readVolume(mapping()), null);
  channel.failNext('ensureVolume', { kind: 'unreachable-after' });
  const volume = await backend.createVolume(mapping());
  assert.deepEqual(channel.calls, ['readVolume', 'ensureVolume', 'readVolume'], 'read back after the lost answer');
  assert.equal(channel.volumes.size, 1);
  assert.equal(volume.boundTo, managedPvcName(RUNNER), 'a local volume is bound to itself');
  assert.equal(channel.volumes.get(managedPvcName(RUNNER))!.limitBytes, 10 * GiB, 'its disk limit is its storage share');
  assert.equal(backend.volumeProblem(volume, mapping()), null);
  assert.match(backend.volumeProblem(volume, mapping({ pvcUid: 'another' })) ?? '', /different UID/);
  assert.match(backend.volumeProblem(volume, mapping({ ownerId: '0195c0de-0000-7000-8000-0000000000b2' })) ?? '', /another owner/);
  channel.failNext('ensureVolume', { kind: 'unreachable-before' });
  channel.volumes.clear();
  await assert.rejects(backend.createVolume(mapping()), DockerChannelUnreachable, 'nothing there: the error goes on');

  const made = await backend.createVolume(mapping());
  const backing = await backend.readBacking(made);
  assert.deepEqual(backing, { uid: made.uid, handle: `docker:orbit-docker-fake/${managedPvcName(RUNNER)}/${made.uid}` });
  const recorded = mapping({ pvcUid: made.uid, pvUid: backing.uid, volumeHandle: backing.handle });
  assert.equal(backend.backingProblem(backing, recorded), null);
  assert.match(backend.backingProblem(backing, mapping({ ...recorded, volumeHandle: 'docker:x/y/z' })) ?? '', /different handle/);
});

test('DockerBackend issues, reads and removes the credential of a generation by its UID', async () => {
  const { backend, channel } = world();
  const credential = await backend.issueCredential(mapping(), 'the-credential-0123456789');
  assert.deepEqual(
    { ownerId: credential.ownerId, runnerId: credential.runnerId, generation: credential.generation, token: credential.token, removing: credential.removing },
    { ownerId: OWNER, runnerId: RUNNER, generation: 1, token: 'the-credential-0123456789', removing: false },
  );
  assert.equal(backend.credentialProblem(credential, mapping()), null);
  assert.match(backend.credentialProblem(credential, mapping({ generation: 2 })) ?? '', /another generation/);
  assert.match(backend.credentialProblem(credential, mapping({ runnerId: '0195c0de-0000-7000-8000-0000000000a2' })) ?? '', /another runner/);
  const again = await backend.issueCredential(mapping({ generation: 2 }), 'another-credential-0123456789');
  assert.equal(again.generation, 1, 'issued once: the existing one comes back for the identity check');
  await backend.removeCredential(mapping(), (await backend.readCredential(mapping()))!);
  assert.equal(await backend.readCredential(mapping()), null);
  assert.equal(channel.count('deleteCredential'), 1);
});

test('DockerBackend proves the single-container guard before a container, then creates one, adopting a lost answer', async () => {
  const { backend, channel } = world();
  const volume = await backend.createVolume(mapping());
  const backing = await backend.readBacking(volume);
  const recorded = mapping({ pvcUid: volume.uid, pvUid: backing.uid, volumeHandle: backing.handle });
  await backend.issueCredential(recorded, 'the-credential-0123456789');
  await backend.requireInstanceGuard(recorded);
  assert.equal(channel.count('dryRunContainer'), 1);
  assert.equal(channel.containers.size, 0, 'a probe is only ever a dry run');

  channel.failNext('createContainer', { kind: 'unreachable-after' });
  const instance = await backend.createInstance(recorded);
  assert.equal(channel.count('createContainer'), 1, 'never created twice');
  assert.deepEqual(
    { name: instance.name, node: instance.node, running: instance.running, terminated: instance.terminated, stopConfirmed: instance.stopConfirmed },
    { name: managedPodName(RUNNER), node: 'docker-host-a', running: true, terminated: false, stopConfirmed: false },
  );
  assert.match(instance.uid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a canonical UUID, as the runner door requires');
  const request = channel.containers.get(managedPodName(RUNNER))!.request;
  assert.deepEqual(request, {
    name: managedPodName(RUNNER), image: `sha256:${'d'.repeat(64)}`, ownerId: OWNER, runnerId: RUNNER, generation: 1,
    volume: { name: managedPvcName(RUNNER), uid: volume.uid },
    resources: { cpuMillis: 1000, memoryBytes: 2 * GiB, pids: 1024, tmpBytes: 512 * 2 ** 20 },
    runner: { serverUrl: 'http://172.30.0.1:3000', maxConcurrent: 2 },
  }, 'identities and amounts only: the channel\'s template does the rest');
  const running = mapping({ ...recorded, podUid: instance.uid, podName: instance.name, nodeName: instance.node });
  assert.equal(backend.instanceProblem(instance, running), null);
  assert.match(backend.instanceProblem(instance, mapping({ ...running, generation: 2 })) ?? '', /another generation/);
  assert.match(backend.instanceProblem(instance, mapping({ ...running, pvcUid: 'another' })) ?? '', /another volume/);
  assert.deepEqual(await backend.volumeHolders({ volume, backing }), [managedPodName(RUNNER)]);
  channel.foreignHolders.set(managedPvcName(RUNNER), 1);
  assert.deepEqual(await backend.volumeHolders({ volume, backing }), [managedPodName(RUNNER), 'a container outside this instance']);
});

test('a container the channel refuses because another container refers to the volume is a held volume, and nothing is made', async () => {
  const { backend, channel } = world();
  const volume = await backend.createVolume(mapping());
  const recorded = mapping({ pvcUid: volume.uid });
  await backend.issueCredential(recorded, 'the-credential-0123456789');
  channel.foreignHolders.set(managedPvcName(RUNNER), 1);
  await assert.rejects(backend.createInstance(recorded), (e: unknown) => e instanceof ManagedVolumeHeld && e.detail === 'something else refers to it', 'the channel\'s words, for the operator');
  assert.equal(channel.containers.size, 0);
  channel.foreignHolders.delete(managedPvcName(RUNNER));
  assert.equal((await backend.createInstance(recorded)).running, true, 'once it is free, the same create goes through');
});

test('a container the channel refuses at its cap on containers is a wait for room, and nothing is made', async () => {
  const { backend, channel } = world();
  const OTHER = '0195c0de-0000-7000-8000-0000000000a2';
  const ready = async (runnerId: string) => {
    const volume = await backend.createVolume(mapping({ runnerId, pvcName: managedPvcName(runnerId) }));
    const recorded = mapping({ runnerId, pvcName: managedPvcName(runnerId), pvcUid: volume.uid });
    await backend.issueCredential(recorded, 'the-credential-0123456789');
    return recorded;
  };
  const first = await ready(RUNNER);
  const second = await ready(OTHER);
  channel.limits = { maxContainers: 1 };
  const made = await backend.createInstance(first);
  channel.exit(RUNNER, 0);
  await assert.rejects(
    backend.createInstance(second),
    (e: unknown) => e instanceof ManagedInstanceLimit
      && e.detail === 'containers of this instance: 1, at its limit (limits.maxContainers 1); another is made only once one of them is removed',
    'an exited container still counts; the channel\'s words, for the operator',
  );
  assert.deepEqual([...channel.containers.keys()], [managedPodName(RUNNER)], 'nothing made');
  await backend.removeInstance({ ...first, podUid: made.uid });
  assert.equal((await backend.createInstance(second)).running, true, 'once one is removed, the same create goes through');
});

test('the guard probe is proof only when the guard itself refuses it', async () => {
  const { backend, channel } = world();
  const recorded = mapping({ pvcUid: '0195c0de-0000-7000-8000-0000000000c1' });
  channel.dryRunContainer = async () => ({ status: 200, code: null, message: null });
  await assert.rejects(backend.requireInstanceGuard(recorded), (e: unknown) => e instanceof ManagedRunnerConflict && e.code === 'CONTAINER_GUARD_MISSING');
  channel.dryRunContainer = async () => ({ status: 403, code: 'IMAGE_REFUSED', message: 'another image' });
  await assert.rejects(backend.requireInstanceGuard(recorded), (e: unknown) => e instanceof ManagedRunnerConflict && e.code === 'CONTAINER_GUARD_UNVERIFIED');
  channel.dryRunContainer = async () => ({ status: 503, code: 'DOCKER_UNAVAILABLE', message: 'later' });
  await assert.rejects(backend.requireInstanceGuard(recorded), (e: unknown) => e instanceof DockerChannelError && backend.failure(e)?.retryable === true);
});

test('Docker\'s report is the stop: an exit with its code and time, or no start at all; removal and stop go by UID', async () => {
  const { backend, channel } = world();
  const volume = await backend.createVolume(mapping());
  const recorded = mapping({ pvcUid: volume.uid });
  await backend.issueCredential(recorded, 'the-credential-0123456789');
  const instance = await backend.createInstance(recorded);
  const running = mapping({ ...recorded, podUid: instance.uid, podName: instance.name, nodeName: instance.node });

  await assert.rejects(backend.removeInstance(running), (e: unknown) => e instanceof DockerChannelError && e.code === 'CONTAINER_RUNNING', 'never while it runs');
  await backend.stopInstance(running);
  assert.deepEqual(channel.stopRequests, [{ name: managedPodName(RUNNER), uid: instance.uid }]);
  const stopped = (await backend.readInstance(running))!;
  assert.deepEqual([stopped.terminated, stopped.stopConfirmed, stopped.running], [true, true, false]);
  assert.equal(stopped.phase, 'exited (exit 143)');
  assert.deepEqual(stopped.exit, { code: 143, outOfMemory: false });
  const predecessor: ManagedRunnerPredecessor = { runnerId: RUNNER, generation: 1, podName: instance.name, podUid: instance.uid, nodeName: 'docker-host-a', pvcUid: volume.uid, volumeHandle: 'h' };
  const proof = backend.observedStop(predecessor, stopped, new Date('2026-10-17T00:00:00.000Z'));
  assert.equal(proof.kind, 'OBSERVED_STOP');
  assert.deepEqual(proof.observation.phase, 'exited');
  assert.deepEqual(proof.observation.containers, [{ name: 'runner', state: 'terminated', exitCode: 143, finishedAt: stopped.view.finishedAt }]);
  await backend.removeInstance(mapping({ ...running, podUid: '0195c0de-0000-7000-8000-00000000dead' })).then(
    () => assert.fail('another UID must not remove it'),
    (e: unknown) => assert.ok(e instanceof DockerChannelError && e.code === 'UID_MISMATCH'),
  );
  await backend.removeInstance(running);
  assert.equal(await backend.readInstance(running), null, 'gone');
  await backend.removeInstance(running); // already gone is done

  // Docker's own words for the other states. Out of memory is Docker's OOM mark on a runner that ended
  // killed (137): the mark alone is also set when only a child process of the runner was killed.
  type Seen = { terminated: boolean; stopConfirmed: boolean; running: boolean; removing: boolean; phase: string; exit: { code: number | null; outOfMemory: boolean } | null };
  const states: Array<[Record<string, unknown>, Seen]> = [
    [{ status: 'created', neverStarted: true }, { terminated: true, stopConfirmed: true, running: false, removing: false, phase: 'created (never started)', exit: null }],
    [{ status: 'dead', exitCode: 137, finishedAt: '2026-10-17T00:00:00Z', oomKilled: true },
      { terminated: true, stopConfirmed: true, running: false, removing: false, phase: 'dead (exit 137; OOM-killed)', exit: { code: 137, outOfMemory: true } }],
    [{ status: 'exited', exitCode: 255, finishedAt: '2026-10-17T00:00:00Z', oomKilled: true },
      { terminated: true, stopConfirmed: true, running: false, removing: false, phase: 'exited (exit 255; OOM-killed)', exit: { code: 255, outOfMemory: false } }],
    [{ status: 'exited', exitCode: 255, finishedAt: null }, { terminated: true, stopConfirmed: false, running: false, removing: false, phase: 'exited (exit 255)', exit: { code: 255, outOfMemory: false } }],
    [{ status: 'paused' }, { terminated: false, stopConfirmed: false, running: false, removing: false, phase: 'paused', exit: null }],
    [{ status: 'removing', finishedAt: '2026-10-17T00:00:00Z' }, { terminated: false, stopConfirmed: false, running: false, removing: true, phase: 'removing', exit: null }],
    [{ status: 'exited', exitCode: 143, finishedAt: '2026-10-17T00:00:00Z', evicted: { reason: 'VOLUME_OVER_LIMIT', volume: 'v', usageBytes: 11, limitBytes: 10, at: 'now' } },
      { terminated: true, stopConfirmed: true, running: false, removing: false, phase: 'exited (exit 143; stopped: its volume held 11 bytes, over its 10-byte limit)', exit: { code: 143, outOfMemory: false } }],
  ];
  const again = await backend.createInstance(recorded);
  for (const [state, expected] of states) {
    Object.assign(channel.containers.get(again.name)!, { running: false, neverStarted: false, oomKilled: false, evicted: null, ...state });
    const seen = (await backend.readInstance(recorded))!;
    assert.deepEqual({ terminated: seen.terminated, stopConfirmed: seen.stopConfirmed, running: seen.running, removing: seen.removing, phase: seen.phase, exit: seen.exit }, expected, JSON.stringify(state));
  }
  Object.assign(channel.containers.get(again.name)!, { status: 'created', neverStarted: true });
  const never = backend.observedStop(predecessor, (await backend.readInstance(recorded))!, new Date());
  assert.deepEqual(never.observation.containers, [{ name: 'runner', state: 'waiting' }], 'never started: no process ever ran');
});

test('an operator\'s host check is the only receipt for a container that vanished unobserved', async () => {
  const { backend, channel } = world();
  const predecessor: ManagedRunnerPredecessor = {
    runnerId: RUNNER, generation: 3, podName: managedPodName(RUNNER), podUid: '0195c0de-0000-7000-8000-0000000000c3',
    nodeName: 'docker-host-a', pvcUid: '0195c0de-0000-7000-8000-0000000000d1', volumeHandle: 'docker:orbit-docker-fake/v/u',
  };
  const now = new Date('2026-10-17T12:00:00.000Z');
  const backing = { uid: predecessor.pvcUid, handle: predecessor.volumeHandle };
  assert.equal(await backend.readFencingReceipt(mapping(), predecessor, backing, now), null);
  const receipt = {
    schemaVersion: 1, kind: 'orbit.managed-runner.fencing-receipt', method: 'HOST_PROCESS_CHECK', predecessor,
    action: { performedBy: 'operator@example.invalid', performedAt: '2026-10-17T11:00:00.000Z', description: 'docker ps -a, ps, fuser on the volume', reference: 'ticket-1' },
    verification: { observedBy: 'second-operator@example.invalid', observedAt: '2026-10-17T11:05:00.000Z', result: 'NO_PROCESS_OF_THE_INSTANCE', evidenceReference: 'ticket-1#2' },
  };
  channel.receipts.set(RUNNER, receipt);
  const accepted = (await backend.readFencingReceipt(mapping(), predecessor, backing, now))!;
  assert.ok(accepted.verdict.ok);
  assert.deepEqual(accepted.verdict.ok && accepted.verdict.proof.source, { file: `channel fencing/${RUNNER}.json` });
  channel.receipts.set(RUNNER, { ...receipt, predecessor: { ...predecessor, podUid: '0195c0de-0000-7000-8000-0000000000c4' } });
  const wrong = (await backend.readFencingReceipt(mapping(), predecessor, backing, now))!;
  assert.ok(!wrong.verdict.ok && wrong.verdict.problems.some((p) => /predecessor\.podUid/.test(p)));
  channel.receipts.set(RUNNER, { ...receipt, method: 'NODE_POWER_OFF' });
  const method = (await backend.readFencingReceipt(mapping(), predecessor, backing, now))!;
  assert.ok(!method.verdict.ok && method.verdict.problems.some((p) => /HOST_PROCESS_CHECK/.test(p)));
});

test('DockerBackend words the channel\'s failures for the manager', () => {
  const { backend } = world();
  assert.deepEqual(backend.failure(new DockerChannelUnreachable('the answer broke off')), { retryable: true });
  assert.deepEqual(backend.failure(new DockerChannelUnreachable('no socket', false)), { retryable: true, unreachable: true }, 'no connection: nothing asked');
  assert.deepEqual(backend.failure(new DockerChannelError(502, 'DOCKER_ERROR', 'Docker answered 500')), { retryable: true });
  assert.deepEqual(backend.failure(new DockerChannelError(503, 'DOCKER_UNAVAILABLE', 'later')), { retryable: true });
  assert.deepEqual(backend.failure(new DockerChannelError(401, 'UNAUTHENTICATED', 'token')), {
    retryable: false, code: 'DOCKER_CHANNEL_FORBIDDEN', detail: 'HTTP 401 UNAUTHENTICATED', log: 'the Docker channel answered 401 UNAUTHENTICATED: token',
  });
  assert.equal((backend.failure(new DockerChannelError(409, 'VOLUME_OVER_LIMIT', 'over')) as { code: string }).code, 'VOLUME_OVER_LIMIT');
  assert.equal((backend.failure(new DockerChannelError(403, 'IMAGE_REFUSED', 'x')) as { code: string }).code, 'DOCKER_CHANNEL_MISMATCH');
  assert.equal((backend.failure(new DockerChannelError(403, 'LIMIT_REFUSED', 'x')) as { code: string }).code, 'DOCKER_CHANNEL_MISMATCH');
  assert.deepEqual(backend.failure(new DockerChannelError(409, 'VOLUME_IN_USE', 'held')), {
    retryable: false, code: 'DOCKER_CHANNEL_REFUSED', detail: 'HTTP 409 VOLUME_IN_USE', log: 'the Docker channel answered 409 VOLUME_IN_USE: held',
  });
  assert.equal(backend.failure(new Error('a database error')), null, 'not the backend\'s: the manager passes it on');
  assert.equal(backend.failure(new ManagedRunnerConflict('PVC_CONFLICT', 'x')), null);
});

test('the channel client speaks to the channel\'s socket with its token, and tells a refusal from no answer', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-docker-client-'));
  const socket = path.join(dir, 'channel.sock');
  const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
  let mode: 'normal' | 'garbage' | 'hang' = 'normal';
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (mode === 'hang') return;
      if (mode === 'garbage') return void res.end('<html>');
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url?.startsWith('/v1/volumes/missing')) return json(404, { code: 'NOT_FOUND', message: 'no such volume' });
      if (req.url === '/v1/containers') return json(409, { code: 'SINGLE_CONTAINER_GUARD', message: 'only the fixed name' });
      if (req.method === 'DELETE') return void res.writeHead(204).end();
      return json(200, { name: 'v', uid: 'u' });
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const client = new DockerChannelClient({ socketPath: socket }, 'the-bearer-token', 2_000);
    assert.equal(await client.readVolume('missing'), null, '404 on a read is nothing there');
    assert.deepEqual(await client.ensureVolume('mr-data-x', { ownerId: OWNER, runnerId: RUNNER, limitBytes: 1 }), { name: 'v', uid: 'u' });
    assert.deepEqual(seen.at(-1), {
      method: 'PUT', url: '/v1/volumes/mr-data-x', auth: 'Bearer the-bearer-token',
      body: JSON.stringify({ ownerId: OWNER, runnerId: RUNNER, limitBytes: 1 }),
    });
    await assert.rejects(client.createContainer({} as never), (e: unknown) => e instanceof DockerChannelError && e.status === 409 && e.code === 'SINGLE_CONTAINER_GUARD');
    assert.deepEqual(await client.dryRunContainer({ name: 'probe' } as never), { status: 409, code: 'SINGLE_CONTAINER_GUARD', message: 'only the fixed name' });
    assert.equal(JSON.parse(seen.at(-1)!.body).dryRun, true);
    await client.removeContainer('mr-x', 'u-1');
    assert.equal(seen.at(-1)!.url, '/v1/containers/mr-x?uid=u-1');
    mode = 'garbage';
    await assert.rejects(client.info(), (e: unknown) => e instanceof DockerChannelUnreachable && e.connected);
    mode = 'hang';
    const slow = new DockerChannelClient({ socketPath: socket }, 't', 200);
    await assert.rejects(slow.info(), (e: unknown) => e instanceof DockerChannelUnreachable && /no answer within 200 ms/.test(e.message) && e.connected);
    // No socket to connect to: nothing reached the channel.
    await assert.rejects(new DockerChannelClient({ socketPath: path.join(dir, 'nothing.sock') }, 't', 1_000).info(), (e: unknown) => e instanceof DockerChannelUnreachable && !e.connected);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('on a Docker server the admission webhook answers that it does not apply, before any token is read', () => {
  const runtime = { available: true as const, profile: testDockerRunnerProfile(), manager: {} as never, worker: {} as never };
  const guard = new ManagedRunnerAdmissionGuard({ enabled: true, problem: null }, runtime);
  const context = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) } as unknown as ExecutionContext;
  assert.throws(() => guard.canActivate(context), (e: { getStatus?: () => number; getResponse?: () => { code?: string } }) =>
    e.getStatus?.() === 404 && e.getResponse?.().code === 'MANAGED_RUNNER_ADMISSION_NOT_APPLICABLE');
});
