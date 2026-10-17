import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ManagedRunner } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { FakeKubeCluster, tripwireKubeClientFactory } from '../test-support/fake-kube-client';
import { MemoryRunBackend } from '../test-support/memory-run-backend';
import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import { KubeAmbiguousError, KubeApiError, type PersistentVolumeClaim, type Pod } from './kube-client';
import { KubernetesBackend } from './kubernetes-backend';
import { MANAGED_ADMISSION_DENIAL_MARKER } from './managed-runner-admission';
import { MANAGED_RUNNER_BACKENDS, ManagedRunnerConflict } from './managed-runner-backend';
import { capacityBudget, computeShare, storageShare } from './managed-runner-capacity';
import { ManagedRunnerManager } from './managed-runner-manager';
import { parseManagedRunnerProfile, type ManagedRunnerProfile } from './managed-runner-profile';
import { managedAdmissionProbeName, managedPodName, managedPvcName, managedSecretName } from './managed-runner-resources';
import { createManagedRunnerRuntime } from './managed-runner-runtime';
import { ManagedRunnerService } from './managed-runner.service';

// The run backend boundary (managed-runner-backend.ts): which backend a profile chooses, Docker
// refused by name with nothing built for Kubernetes in its place, KubernetesBackend making exactly
// the Kubernetes calls the manager made itself, and the manager making none of its own. The manager
// driving a mapping on a backend with no Kubernetes in it is managed-runner-backend.pg.spec.ts.

const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const RUNNER = '0195c0de-0000-7000-8000-0000000000a1';
const OWNER = '0195c0de-0000-7000-8000-0000000000b1';
const DOCKER_REFUSED = /^backend is "docker", which this server does not implement yet; it does not run managed runners on Kubernetes instead$/;

function mapping(change: Partial<ManagedRunner> = {}): ManagedRunner {
  return {
    id: 'mapping', ownerId: OWNER, runnerId: RUNNER, generation: 1, namespace: 'orbit-managed-test', pvcName: managedPvcName(RUNNER),
    pvcUid: null, pvUid: null, volumeHandle: null, podName: null, podUid: null, nodeName: null, ...change,
  } as ManagedRunner;
}

function profileFile(profile: unknown): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'orbit-mr-backend-')), 'profile.json');
  writeFileSync(file, JSON.stringify(profile));
  return file;
}

test('a profile chooses its backend: absent or "kubernetes" is Kubernetes, "docker" is refused by name, anything else is refused', () => {
  assert.deepEqual(MANAGED_RUNNER_BACKENDS, ['kubernetes', 'docker']);
  const absent = parseManagedRunnerProfile(structuredClone(testManagedRunnerProfile()));
  assert.ok(absent.ok);
  assert.equal('backend' in absent.profile, false, 'a profile without the field is read as it always was');

  const stated = parseManagedRunnerProfile({ ...testManagedRunnerProfile(), backend: 'kubernetes' });
  assert.ok(stated.ok);
  assert.equal(stated.profile.backend, 'kubernetes');

  // Docker is refused with that one reason — whatever else the file says, and with no Kubernetes
  // section asked of it — so nothing reads it as a Kubernetes profile.
  for (const docker of [{ ...testManagedRunnerProfile(), backend: 'docker' }, { backend: 'docker' }, { schemaVersion: 2, backend: 'docker' }]) {
    const refused = parseManagedRunnerProfile(docker);
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.problems.length, 1, JSON.stringify(!refused.ok && refused.problems));
    assert.match(!refused.ok ? refused.problems[0] : '', DOCKER_REFUSED);
  }
  for (const other of ['Kubernetes', 'podman', '', 1, null]) {
    const refused = parseManagedRunnerProfile({ ...testManagedRunnerProfile(), backend: other });
    assert.deepEqual(refused, { ok: false, problems: ['backend must be one of "kubernetes", "docker", or absent for "kubernetes"'] }, JSON.stringify(other));
  }
});

test('a docker profile leaves the enabled feature unavailable, and nothing is built for Kubernetes instead', async () => {
  const constructed: string[] = [];
  const logged: string[] = [];
  const runtime = createManagedRunnerRuntime({
    profilePath: profileFile({ ...testManagedRunnerProfile(), backend: 'docker' }),
    prisma: {} as PrismaService,
    kubeClient: tripwireKubeClientFactory(constructed),
    log: { error: (line: string) => void logged.push(line), log: (line: string) => void logged.push(line) },
  });
  assert.equal(runtime.available, false);
  assert.match(!runtime.available ? runtime.problems.join('\n') : '', DOCKER_REFUSED);
  assert.deepEqual(constructed, [], 'no Kubernetes client was constructed');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^managed runners are enabled but unavailable: backend is "docker"/);

  // What an owner is told: unavailable, never a Kubernetes runner instead.
  const reads = { managedRunner: { findUnique: async () => null }, user: { findUnique: async () => ({ disabledAt: null }) } };
  const service = new ManagedRunnerService(reads as unknown as PrismaService, { enabled: true, problem: null }, runtime);
  const status = await service.status(OWNER);
  assert.equal(status.reason?.code, 'MANAGED_RUNNER_UNAVAILABLE');
  assert.equal(status.actions.canEnsure, false);
  await assert.rejects(service.ensure(OWNER, 'ensure'), (e: { getStatus?: () => number; getResponse?: () => { code?: string } }) =>
    e.getStatus?.() === 503 && e.getResponse?.().code === 'MANAGED_RUNNER_UNAVAILABLE');
  assert.deepEqual(constructed, []);
});

test('a Kubernetes profile, with the field or without it, runs on KubernetesBackend over the client it names', () => {
  for (const profile of [testManagedRunnerProfile(), { ...testManagedRunnerProfile(), backend: 'kubernetes' as const }]) {
    const made: ManagedRunnerProfile[] = [];
    const cluster = new FakeKubeCluster();
    const runtime = createManagedRunnerRuntime({
      profilePath: profileFile(profile),
      prisma: {} as PrismaService,
      kubeClient: (p) => {
        made.push(p);
        return cluster.client();
      },
      log: quiet,
    });
    assert.ok(runtime.available);
    assert.equal(made.length, 1);
    assert.ok(runtime.manager.backend instanceof KubernetesBackend);
    assert.equal(runtime.manager.backend.name, 'kubernetes');
    assert.deepEqual(runtime.manager.backend.location, { clusterKey: profile.clusterKey, namespace: profile.kubernetes.namespace });
    assert.deepEqual(cluster.calls, [], 'building it calls nothing');
  }
});

test('the manager runs on the backend it is given, and on KubernetesBackend over a bare Kubernetes client', () => {
  const profile = testManagedRunnerProfile();
  const memory = new MemoryRunBackend({ clusterKey: 'memory', namespace: 'memory' }, { budget: capacityBudget(profile), compute: computeShare(profile), storage: storageShare(profile) });
  assert.equal(new ManagedRunnerManager({} as PrismaService, memory, { lifecycle: profile.lifecycle }).backend, memory);
  const cluster = new FakeKubeCluster();
  const wrapped = new ManagedRunnerManager({} as PrismaService, cluster.client(), profile).backend;
  assert.ok(wrapped instanceof KubernetesBackend);
  assert.deepEqual(cluster.calls, []);
});

test('KubernetesBackend names, pools and budgets as the profile says', () => {
  const profile = testManagedRunnerProfile();
  const backend = new KubernetesBackend(new FakeKubeCluster().client(), profile);
  assert.deepEqual(backend.names(RUNNER), { volume: managedPvcName(RUNNER), instance: managedPodName(RUNNER), credential: managedSecretName(RUNNER) });
  assert.deepEqual(backend.location, { clusterKey: profile.clusterKey, namespace: profile.kubernetes.namespace });
  assert.deepEqual(backend.capacityBudget(), capacityBudget(profile));
  assert.deepEqual(backend.computeShare(), computeShare(profile));
  assert.deepEqual(backend.storageShare(), storageShare(profile));
  assert.deepEqual(backend.terms, { volume: 'PVC', backing: 'PV', credential: 'Secret', instance: 'Pod', stopReport: "its kubelet's report" });
});

test('KubernetesBackend reads, creates and checks the data volume with the calls the manager made', async () => {
  const profile = testManagedRunnerProfile();
  const cluster = new FakeKubeCluster(profile.kubernetes.namespace);
  const backend = new KubernetesBackend(cluster.client(), profile);
  const name = managedPvcName(RUNNER);

  assert.equal(await backend.readVolume(mapping()), null);
  // A create whose answer was lost after it committed is read back by name and adopted.
  cluster.inject({ op: 'create', kind: 'persistentvolumeclaims', mode: 'commit-then-timeout' });
  const volume = await backend.createVolume(mapping());
  assert.deepEqual(cluster.calls, [
    { op: 'get', kind: 'persistentvolumeclaims', name },
    { op: 'create', kind: 'persistentvolumeclaims', name },
    { op: 'get', kind: 'persistentvolumeclaims', name },
  ]);
  const stored = cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', name)!;
  assert.equal(volume.uid, stored.metadata.uid);
  assert.equal(volume.boundTo, stored.spec.volumeName, 'bound: the PV it names');
  assert.equal(backend.volumeProblem(volume, mapping()), null);
  assert.match(backend.volumeProblem(volume, mapping({ pvcUid: 'another-uid' })) ?? '', /different UID/);
  assert.match(backend.volumeProblem(volume, mapping({ ownerId: '0195c0de-0000-7000-8000-0000000000b2' })) ?? '', /another owner/);

  cluster.calls.length = 0;
  const backing = (await backend.readBacking(volume))!;
  assert.deepEqual(cluster.calls, [{ op: 'getPersistentVolume', name: volume.boundTo }]);
  const pv = cluster.persistentVolumes.get(volume.boundTo!)!;
  assert.deepEqual({ uid: backing.uid, handle: backing.handle }, { uid: pv.metadata.uid, handle: pv.spec.csi!.volumeHandle });
  const recorded = mapping({ pvcUid: volume.uid, pvUid: backing.uid, volumeHandle: backing.handle });
  assert.equal(backend.backingProblem(backing, recorded), null);
  assert.match(backend.backingProblem(backing, mapping({ pvcUid: volume.uid, volumeHandle: 'another-handle' })) ?? '', /different volume handle/);
  assert.match(backend.backingProblem(backing, mapping({ pvcUid: 'another-claim' })) ?? '', /bound to another claim/);
});

test('KubernetesBackend issues, reads and removes the bootstrap credential, and runs and removes the instance', async () => {
  const profile = testManagedRunnerProfile();
  const cluster = new FakeKubeCluster(profile.kubernetes.namespace);
  const backend = new KubernetesBackend(cluster.client(), profile);
  const volume = await backend.createVolume(mapping());
  const backing = (await backend.readBacking(volume))!;
  const recorded = mapping({ pvcUid: volume.uid, pvUid: backing.uid, volumeHandle: backing.handle });

  const credential = await backend.issueCredential(recorded, 'the-credential');
  assert.deepEqual(
    { ownerId: credential.ownerId, runnerId: credential.runnerId, generation: credential.generation, token: credential.token, removing: credential.removing },
    { ownerId: OWNER, runnerId: RUNNER, generation: 1, token: 'the-credential', removing: false },
  );
  assert.equal(backend.credentialProblem(credential, recorded), null);
  assert.match(backend.credentialProblem(credential, mapping({ generation: 2 })) ?? '', /another generation/);
  const read = (await backend.readCredential(recorded))!;
  assert.equal(read.token, 'the-credential');
  cluster.calls.length = 0;
  await backend.removeCredential(recorded, read);
  assert.deepEqual(cluster.calls, [{ op: 'delete', kind: 'secrets', name: managedSecretName(RUNNER) }]);
  assert.equal(await backend.readCredential(recorded), null);

  const instance = await backend.createInstance(recorded);
  const pod = cluster.object<Pod>('pods', managedPodName(RUNNER))!;
  assert.deepEqual(
    { name: instance.name, uid: instance.uid, node: instance.node, running: instance.running, terminated: instance.terminated, stopConfirmed: instance.stopConfirmed, removing: instance.removing },
    { name: managedPodName(RUNNER), uid: pod.metadata.uid, node: 'node-a', running: true, terminated: false, stopConfirmed: false, removing: false },
  );
  const running = mapping({ ...recorded, podUid: instance.uid, podName: instance.name, nodeName: instance.node });
  assert.equal(backend.instanceProblem(instance, running), null);
  assert.match(backend.instanceProblem(instance, mapping({ ...running, generation: 2 })) ?? '', /another generation/);
  const verified = { volume, backing };
  assert.deepEqual(await backend.volumeHolders(verified), [`csi-${volume.boundTo}-node-a`], 'attached while the Pod is there');

  cluster.stopPod(managedPodName(RUNNER));
  const stopped = (await backend.readInstance(running))!;
  assert.deepEqual([stopped.terminated, stopped.stopConfirmed, stopped.phase], [true, true, 'Succeeded']);
  const predecessor = { runnerId: RUNNER, generation: 1, podName: instance.name, podUid: instance.uid, nodeName: 'node-a', pvcUid: volume.uid, volumeHandle: backing.handle };
  const proof = backend.observedStop(predecessor, stopped, new Date('2026-10-17T00:00:00.000Z'));
  assert.equal(proof.kind, 'OBSERVED_STOP');
  assert.deepEqual(proof.predecessor, predecessor);
  assert.deepEqual(proof.observation.containers.map((c) => [c.name, c.state]), [['private-volume-directories', 'terminated'], ['runner', 'terminated']]);

  cluster.calls.length = 0;
  await backend.removeInstance(running);
  assert.deepEqual(cluster.calls, [{ op: 'delete', kind: 'pods', name: managedPodName(RUNNER) }]);
  assert.equal(await backend.readInstance(running), null);
  assert.deepEqual(await backend.volumeHolders(verified), [], 'released once no Pod uses it');

  // Terminal by the control plane's word, not the kubelet's: not a confirmed stop.
  const again = await backend.createInstance(recorded);
  cluster.markFailedByControlPlane(managedPodName(RUNNER));
  const declared = (await backend.readInstance(mapping({ ...recorded, podUid: again.uid })))!;
  assert.deepEqual([declared.terminated, declared.stopConfirmed], [true, false]);
  assert.equal(await backend.readFencingReceipt(recorded, predecessor, backing, new Date()), null, 'no receipt left');
});

test('KubernetesBackend proves the admission guard before a Pod, and words failures as the manager did', async () => {
  const profile = testManagedRunnerProfile();
  const cluster = new FakeKubeCluster(profile.kubernetes.namespace);
  const backend = new KubernetesBackend(cluster.client(), profile);
  const recorded = mapping({ pvcUid: '0195c0de-0000-7000-8000-0000000000c1' });
  const probe = managedAdmissionProbeName(RUNNER);

  await assert.rejects(backend.requireInstanceGuard(recorded), (e: unknown) => e instanceof ManagedRunnerConflict && e.code === 'ADMISSION_GUARD_MISSING');
  assert.deepEqual(cluster.calls, [{ op: 'dryRunCreate', kind: 'pods', name: probe }]);
  cluster.admission = async () => ({ allowed: false, message: `${MANAGED_ADMISSION_DENIAL_MARKER}: NOT_RESERVED: no` });
  await backend.requireInstanceGuard(recorded);
  cluster.admission = async () => ({ allowed: false, message: 'some other policy' });
  await assert.rejects(backend.requireInstanceGuard(recorded), (e: unknown) => e instanceof ManagedRunnerConflict && e.code === 'ADMISSION_GUARD_UNVERIFIED');
  cluster.admission = async () => {
    throw new Error('webhook down');
  };
  await assert.rejects(backend.requireInstanceGuard(recorded), (e: unknown) => e instanceof KubeApiError && e.status === 500 && backend.failure(e)?.retryable === true);
  assert.equal(cluster.count('create'), 0, 'a probe is only ever a dry run');

  assert.deepEqual(backend.failure(new KubeAmbiguousError('timed out')), { retryable: true });
  assert.deepEqual(backend.failure(new KubeApiError(429, 'TooManyRequests', 'slow down')), { retryable: true });
  assert.deepEqual(backend.failure(new KubeApiError(503, 'ServiceUnavailable', 'later')), { retryable: true });
  assert.deepEqual(backend.failure(new KubeApiError(403, 'Forbidden', 'pods is forbidden')), {
    retryable: false, code: 'KUBERNETES_FORBIDDEN', detail: 'HTTP 403 Forbidden', log: 'Kubernetes answered 403 Forbidden: pods is forbidden',
  });
  assert.equal((backend.failure(new KubeApiError(401, '', 'who are you')) as { code: string }).code, 'KUBERNETES_FORBIDDEN');
  assert.deepEqual(backend.failure(new KubeApiError(422, '', 'invalid')), {
    retryable: false, code: 'KUBERNETES_REJECTED', detail: 'HTTP 422', log: 'Kubernetes answered 422 : invalid',
  });
  assert.equal(backend.failure(new Error('a database error')), null, 'not the backend\'s: the manager passes it on');
  assert.equal(backend.failure(new ManagedRunnerConflict('PVC_CONFLICT', 'x')), null);
});

test('the manager calls no Kubernetes API of its own: every call is the backend\'s', () => {
  const source = readFileSync(path.resolve(__dirname, '../../src/managed-runners/managed-runner-manager.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const imports = [...code.matchAll(/^import (.+?) from '([^']+)';$/gms)].map(([, what, from]) => ({ what: what.replace(/\s+/g, ' '), from }));
  for (const kubernetesOnly of ['./kube-http-client', './managed-runner-resources', './managed-runner-admission', './managed-runner-admission.controller']) {
    assert.ok(!imports.some((i) => i.from === kubernetesOnly), `the manager imports ${kubernetesOnly}`);
  }
  // Two names only, both for the constructor that takes a bare client as every caller once did.
  assert.deepEqual(imports.filter((i) => i.from === './kube-client'), [{ what: 'type { ManagedKubeClient }', from: './kube-client' }]);
  assert.deepEqual(imports.filter((i) => i.from === './kubernetes-backend'), [{ what: '{ KubernetesBackend }', from: './kubernetes-backend' }]);
  assert.equal(code.match(/\bKubernetesBackend\b/g)?.length, 2, 'imported, and built in the constructor alone');
  assert.match(code, /this\.backend = 'name' in backend \? backend : new KubernetesBackend\(backend, profile as ManagedRunnerProfile\);/);
  for (const api of [/\bkube\b/, /\.pods\b/, /persistentVolumeClaims/, /getPersistentVolume/, /listVolumeAttachments/, /configMaps/, /\.secrets\b/, /KubeApiError/, /isRetryableKubeError/]) {
    assert.doesNotMatch(code.replace(/^import .+$/gm, '').replace(/\bManagedKubeClient\b/g, ''), api);
  }
});
