import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import type { PersistentVolume, PersistentVolumeClaim } from './kube-client';
import {
  bootstrapCredentialOf,
  buildDriveMountSecret,
  buildManagedPod,
  driveMountSecretName,
  buildManagedPvc,
  buildManagedSecret,
  managedPodName,
  managedPvcName,
  managedSecretName,
  podIdentityProblem,
  pvIdentityProblem,
  pvcIdentityProblem,
  secretGeneration,
  secretIdentityProblem,
  TMP_SUBPATH,
} from './managed-runner-resources';

// The objects the manager creates are the ones deploy/managed-runner describes: the PVC is the
// storage template rendered, field for field; the Pod is the Pod example with its placeholders
// filled in and exactly the documented differences (identity annotations, and the bootstrap
// credential in place of the enrollment token). A change to either side fails here.

const DEPLOY = path.resolve(__dirname, '../../../../deploy/managed-runner');
const RUNNER = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OWNER = '0199a1b2-0000-7000-8000-000000000001';
const PVC_UID = '9b1f3c2e-1111-4222-8333-444455556666';
const profile = testManagedRunnerProfile();
/** The profile with the drive: the example shows the Pod with it. */
const filesProfile = testManagedRunnerProfile({ files: true });
const identity = { ownerId: OWNER, runnerId: RUNNER, generation: 1, namespace: profile.kubernetes.namespace };

test('names derive from the canonical runner UUID alone', () => {
  assert.equal(managedPodName(RUNNER), `mr-${RUNNER}`);
  assert.equal(managedPvcName(RUNNER), `mr-data-${RUNNER}`);
  assert.equal(managedSecretName(RUNNER), `mr-boot-${RUNNER}`);
  assert.equal(managedPvcName(RUNNER.toUpperCase()), `mr-data-${RUNNER}`, 'canonical: lower case');
  assert.throws(() => managedPodName('alice'), /canonical runner UUID/);
  assert.throws(() => managedPvcName(`${RUNNER}/../x`), /canonical runner UUID/);
});

test('the PVC is deploy/managed-runner/storage/pvc.template.json rendered, and nothing else', () => {
  const template = JSON.parse(readFileSync(path.join(DEPLOY, 'storage/pvc.template.json'), 'utf8'));
  const values: Record<string, string> = {
    'storage.pvcName': managedPvcName(RUNNER),
    'kubernetes.namespace': profile.kubernetes.namespace,
    'storage.ownerID': OWNER,
    'storage.runnerID': RUNNER,
    'storage.className': profile.storage.className,
    'storage.capacity': profile.storage.capacity,
  };
  const render = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const token = /^\$\{([^}]+)\}$/.exec(node);
      if (!token) return node;
      assert.ok(token[1] in values, `the template names ${token[1]}, which the manager does not fill`);
      return values[token[1]];
    }
    if (Array.isArray(node)) return node.map(render);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, render(v)]));
    return node;
  };
  const pvc = buildManagedPvc(identity, profile);
  assert.deepEqual(pvc, render(template));
  assert.equal(pvc.metadata.ownerReferences, undefined, 'no compute object owns a data volume');
});

/**
 * The YAML subset runner-pod.yaml.example is written in: block mappings and sequences, flow
 * sequences of plain scalars, quoted strings, integers (a leading zero is octal, as Kubernetes'
 * YAML 1.1 parser reads `0444`), booleans, and whole-line comments.
 */
function readYaml(text: string): unknown {
  const lines = text
    .split('\n')
    .map((raw) => ({ indent: raw.length - raw.trimStart().length, body: raw.trim() }))
    .filter((line) => line.body !== '' && !line.body.startsWith('#'));
  let at = 0;
  const scalar = (value: string): unknown => {
    if (value.startsWith('[') && value.endsWith(']')) {
      return value.slice(1, -1).split(',').map((item) => scalar(item.trim()));
    }
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1);
    if (value === 'true' || value === 'false') return value === 'true';
    if (/^0[0-7]+$/.test(value)) return parseInt(value, 8);
    if (/^-?[0-9]+$/.test(value)) return Number(value);
    return value;
  };
  const block = (indent: number): unknown => {
    if (lines[at].body.startsWith('- ')) {
      const list: unknown[] = [];
      while (at < lines.length && lines[at].indent === indent && lines[at].body.startsWith('- ')) {
        const first = lines[at];
        const rest = first.body.slice(2);
        if (!rest.includes(': ') && !rest.endsWith(':')) {
          list.push(scalar(rest));
          at += 1;
          continue;
        }
        // A mapping item: its keys line up two columns in, the first on the dash's line.
        lines[at] = { indent: indent + 2, body: rest };
        list.push(block(indent + 2));
      }
      return list;
    }
    const map: Record<string, unknown> = {};
    while (at < lines.length && lines[at].indent === indent && !lines[at].body.startsWith('- ')) {
      const { body } = lines[at];
      const colon = body.indexOf(':');
      const key = body.slice(0, colon);
      const value = body.slice(colon + 1).trim();
      at += 1;
      map[key] = value === '' ? block(lines[at].indent) : scalar(value);
    }
    return map;
  };
  return block(0);
}

test('the Pod is deploy/managed-runner/runner-pod.yaml.example, filled in and nothing else', () => {
  const pod = buildManagedPod(identity, PVC_UID, filesProfile);
  const fill: Record<string, string> = {
    __FIXED_USER_POD_NAME__: managedPodName(RUNNER),
    __AUTHORIZED_TEST_NAMESPACE__: profile.kubernetes.namespace,
    __TEST_ENVIRONMENT_ID__: profile.environmentId,
    __OWNER_UUID__: OWNER,
    __RUNNER_UUID__: RUNNER,
    __RESERVED_GENERATION__: '1',
    __DATA_PVC_UID__: PVC_UID,
    __RUNNER_IMAGE_AT_SHA256_DIGEST__: profile.runner.image,
    __INIT_CPU_REQUEST__: profile.runner.resources.init.requests.cpu,
    __INIT_MEMORY_REQUEST__: profile.runner.resources.init.requests.memory,
    __INIT_CPU_LIMIT__: profile.runner.resources.init.limits.cpu,
    __INIT_MEMORY_LIMIT__: profile.runner.resources.init.limits.memory,
    __AUTHORIZED_TEST_ORBIT_HTTPS_URL__: profile.runner.serverUrl,
    __STABLE_USER_RUNNER_NAME__: 'Orbit Cloud',
    __AUTHORIZED_SESSION_CONCURRENCY__: String(profile.runner.maxConcurrent),
    __RUNNER_CPU_REQUEST__: profile.runner.resources.runner.requests.cpu,
    __RUNNER_MEMORY_REQUEST__: profile.runner.resources.runner.requests.memory,
    __RUNNER_CPU_LIMIT__: profile.runner.resources.runner.limits.cpu,
    __RUNNER_MEMORY_LIMIT__: profile.runner.resources.runner.limits.memory,
    __EXISTING_PER_USER_TEST_PVC__: managedPvcName(RUNNER),
    __BOOTSTRAP_SECRET__: managedSecretName(RUNNER),
  };
  const yaml = readFileSync(path.join(DEPLOY, 'runner-pod.yaml.example'), 'utf8')
    .replace(/__[A-Z0-9_]+__/g, (token) => {
      assert.ok(token in fill, `the example has a placeholder the manager does not fill: ${token}`);
      return fill[token];
    });
  assert.deepEqual(pod, readYaml(yaml));
  assert.equal(pod.spec.restartPolicy, 'Never');
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.terminationGracePeriodSeconds, 240);
  assert.ok(!JSON.stringify(pod).includes('ENROLLMENT'), 'a managed runner is never given an enrollment token');
  // The instance identity comes from the API server's own record of the Pod (the Downward API), so
  // the runner can only ever name the generation and Pod UID it really is.
  const env = (pod.spec.containers as Array<{ env: Array<{ name: string; valueFrom?: { fieldRef?: { fieldPath?: string } } }> }>)[0].env;
  assert.equal(env.find((e) => e.name === 'ORBIT_MANAGED_RUNNER_GENERATION')?.valueFrom?.fieldRef?.fieldPath, "metadata.annotations['orbit.dev/generation']");
  assert.equal(env.find((e) => e.name === 'ORBIT_MANAGED_RUNNER_POD_UID')?.valueFrom?.fieldRef?.fieldPath, 'metadata.uid');
});

type Mount = { name: string; mountPath: string; subPath?: string; readOnly?: boolean };
type Container = { name: string; volumeMounts: Mount[] };

test('Kubernetes: /tmp is a directory of the data volume, so filling it is ENOSPC — no emptyDir, no sizeLimit, no eviction', () => {
  const pod = buildManagedPod(identity, PVC_UID, profile);
  const volumes = pod.spec.volumes!;
  assert.deepEqual(volumes.map((v) => [v.name, Object.keys(v).filter((key) => key !== 'name')]), [
    ['user-state', ['persistentVolumeClaim']],
    ['bootstrap', ['secret']],
  ], 'the data volume and the bootstrap Secret, and no emptyDir');
  assert.equal(volumes[0].persistentVolumeClaim?.claimName, managedPvcName(RUNNER));
  assert.doesNotMatch(JSON.stringify(pod), /emptyDir|sizeLimit|ephemeral-storage/);
  const containers = [...(pod.spec.initContainers as Container[]), ...(pod.spec.containers as Container[])];
  assert.deepEqual(containers.map((c) => c.name), ['private-volume-directories', 'runner']);
  for (const container of containers) {
    const tmp = container.volumeMounts.filter((m) => m.mountPath === '/tmp');
    assert.deepEqual(tmp, [{ name: 'user-state', mountPath: '/tmp', subPath: TMP_SUBPATH }], `${container.name}: /tmp on the data volume`);
    assert.deepEqual(container.volumeMounts.find((m) => m.mountPath === '/home/orbit'), { name: 'user-state', mountPath: '/home/orbit' });
  }
  assert.equal(TMP_SUBPATH, '.orbit-tmp', 'the image (entrypoint.py) and the runner (managed_tmp.go) name the same directory');
});

test('Docker: the channel\'s template mounts the same data volume directory at /tmp, and no tmpfs', () => {
  // The Docker backend's container is built by the channel alone (deploy/managed-runner/docker-channel/channel.py):
  // its template, rendered for this runner by its own code.
  const channel = path.join(DEPLOY, 'docker-channel/channel.py');
  const script = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("channel", sys.argv[1])',
    'ch = importlib.util.module_from_spec(spec); spec.loader.exec_module(ch)',
    'config = {"image": "sha256:" + "a" * 64, "network": "orbit-mr", "extraLabels": {}, "instanceId": "i", "stopGraceSeconds": 200, "logMaxSize": "10m", "logMaxFiles": 3}',
    'request = {"runnerId": sys.argv[2], "ownerId": sys.argv[3], "generation": 1, "volume": {"name": "mr-data-" + sys.argv[2], "uid": sys.argv[4]},',
    '           "resources": {"cpuMillis": 1000, "memoryBytes": 2 ** 31, "pids": 512, "tmpBytes": 2 ** 30}, "runner": {"serverUrl": "http://10.0.0.1:3000", "maxConcurrent": 2}}',
    'made = ch.container_spec(config, request, sys.argv[4])',
    'print(json.dumps({"subpath": ch.TMP_SUBPATH, "mounts": made["HostConfig"]["Mounts"], "problems": ch.unsafe(config, made)}))',
  ].join('\n');
  const out = JSON.parse(execFileSync('python3', ['-I', '-c', script, channel, RUNNER, OWNER, PVC_UID], { encoding: 'utf8' }));
  assert.equal(out.subpath, TMP_SUBPATH, 'both backends mount the same directory of the volume');
  assert.deepEqual(out.problems, [], 'the template keeps the channel\'s own rules');
  const tmp = out.mounts.filter((m: { Target: string }) => m.Target === '/tmp');
  assert.deepEqual(tmp, [{ Type: 'volume', Source: managedPvcName(RUNNER), Target: '/tmp', ReadOnly: false, VolumeOptions: { NoCopy: true, Subpath: TMP_SUBPATH } }]);
  assert.equal(out.mounts.find((m: { Target: string }) => m.Target === '/home/orbit')?.Source, managedPvcName(RUNNER), '/tmp is the runner\'s own data volume');
  assert.ok(!out.mounts.some((m: { Type: string }) => m.Type === 'tmpfs'), 'no tmpfs held in the container\'s memory');
});

test('the drive adds one CSI volume and one mount to the runner, and changes nothing else (G3)', () => {
  type Container = { name: string; securityContext: unknown; volumeMounts: Array<Record<string, unknown>> };
  const withDrive = buildManagedPod(identity, PVC_UID, filesProfile);
  const without = buildManagedPod(identity, PVC_UID, profile);
  const volume = { name: 'orbit-drive', csi: { driver: 'drive.orbit.dev', volumeAttributes: { runnerId: RUNNER } } };
  const mount = { name: 'orbit-drive', mountPath: '/run/orbit-drive', mountPropagation: 'HostToContainer' };
  assert.deepEqual(withDrive.spec.volumes, [...without.spec.volumes!, volume]);
  const runner = (pod: typeof withDrive) => (pod.spec.containers as Container[])[0];
  assert.deepEqual(runner(withDrive).volumeMounts, [...runner(without).volumeMounts, mount]);
  // Everything but the runner's mounts and the Pod's volumes is the same object: security contexts, host
  // namespaces, the service-account token, the init container.
  const rest = (pod: typeof withDrive) => {
    const copy = structuredClone(pod);
    delete copy.spec.volumes;
    delete (copy.spec.containers as Array<Partial<Container>>)[0].volumeMounts;
    return copy;
  };
  assert.deepEqual(rest(withDrive), rest(without));
  assert.deepEqual(runner(withDrive).securityContext, {
    runAsUser: 10001,
    runAsGroup: 10001,
    runAsNonRoot: true,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  });
  assert.deepEqual(withDrive.spec.securityContext, { seccompProfile: { type: 'RuntimeDefault' } });
  assert.ok(!JSON.stringify(withDrive).includes('mrf-'), 'the mount credential never enters the runner Pod');
});

test("the mount Secret carries the generation's mount credential, in the files namespace", () => {
  const secret = buildDriveMountSecret({ ...identity, generation: 3 }, 'orbit-drive-test', 'orbit_drive_mount_x');
  assert.equal(secret.metadata.name, driveMountSecretName(RUNNER));
  assert.equal(secret.metadata.name, `mrf-${RUNNER}`);
  assert.equal(secret.metadata.namespace, 'orbit-drive-test');
  assert.equal(secret.immutable, true);
  assert.equal(bootstrapCredentialOf(secret), 'orbit_drive_mount_x');
  assert.equal(Buffer.from(secret.data!.generation, 'base64').toString('utf8'), '3');
  assert.equal(secretGeneration(secret), 3);
  assert.equal(secretIdentityProblem(secret, { ...identity, generation: 3 }), null);
  assert.throws(() => driveMountSecretName('alice'), /canonical runner UUID/);
});

test('the bootstrap Secret carries the credential and the generation it is for, and is immutable', () => {
  const secret = buildManagedSecret(identity, 'credential-of-generation-1');
  assert.equal(secret.metadata.name, managedSecretName(RUNNER));
  assert.equal(secret.immutable, true);
  assert.equal(bootstrapCredentialOf(secret), 'credential-of-generation-1');
  assert.equal(Buffer.from(secret.data!.generation, 'base64').toString('utf8'), '1', 'the entrypoint checks it against the Pod');
  assert.equal(secretGeneration(secret), 1);
  assert.equal(secretIdentityProblem(secret, identity), null);
  assert.match(secretIdentityProblem(secret, { ...identity, generation: 2 })!, /another generation/);
  assert.match(secretIdentityProblem(secret, { ...identity, ownerId: RUNNER })!, /another owner/);
});

test('identity checks: owner, runner, UID, storage profile, volume handle and generation must all match', () => {
  const pvc: PersistentVolumeClaim = { ...buildManagedPvc(identity, profile), status: { phase: 'Bound' } };
  pvc.metadata.uid = PVC_UID;
  assert.equal(pvcIdentityProblem(pvc, identity, profile, null), null);
  assert.equal(pvcIdentityProblem(pvc, identity, profile, PVC_UID), null);
  assert.match(pvcIdentityProblem(pvc, identity, profile, 'another-uid')!, /different UID/);
  assert.match(pvcIdentityProblem(pvc, { ...identity, ownerId: RUNNER }, profile, null)!, /another owner/);
  assert.match(pvcIdentityProblem({ ...pvc, spec: { ...pvc.spec, storageClassName: 'fast' } }, identity, profile, null)!, /storage class/);
  assert.match(pvcIdentityProblem({ ...pvc, spec: { ...pvc.spec, accessModes: ['ReadWriteMany'] } }, identity, profile, null)!, /access modes/);
  assert.match(pvcIdentityProblem({ ...pvc, spec: { ...pvc.spec, volumeMode: 'Block' } }, identity, profile, null)!, /Filesystem/);
  assert.match(
    pvcIdentityProblem({ ...pvc, metadata: { ...pvc.metadata, ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: 'x', uid: 'y' }] } }, identity, profile, null)!,
    /owner reference/,
  );

  const pv: PersistentVolume = {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: 'pv-1', uid: 'pv-uid-1' },
    spec: { storageClassName: 'runner-data', claimRef: { uid: PVC_UID }, csi: { volumeHandle: 'handle-1' } },
  };
  assert.equal(pvIdentityProblem(pv, PVC_UID, profile, { pvUid: null, volumeHandle: null }), null);
  assert.equal(pvIdentityProblem(pv, PVC_UID, profile, { pvUid: 'pv-uid-1', volumeHandle: 'handle-1' }), null);
  assert.match(pvIdentityProblem(pv, PVC_UID, profile, { pvUid: 'pv-uid-1', volumeHandle: 'handle-2' })!, /volume handle/);
  assert.match(pvIdentityProblem(pv, 'other-claim', profile, { pvUid: null, volumeHandle: null })!, /another claim/);
  assert.match(pvIdentityProblem({ ...pv, spec: { ...pv.spec, csi: undefined } }, PVC_UID, profile, { pvUid: null, volumeHandle: null })!, /no CSI volume handle/);

  const pod = buildManagedPod(identity, PVC_UID, profile);
  assert.equal(podIdentityProblem(pod, identity, PVC_UID), null);
  assert.match(podIdentityProblem(pod, { ...identity, generation: 2 }, PVC_UID)!, /another generation/);
  assert.match(podIdentityProblem(pod, identity, 'another-pvc-uid')!, /another PVC/);
  const unlabelled = structuredClone(pod);
  unlabelled.metadata.annotations = {};
  assert.match(podIdentityProblem(unlabelled, identity, PVC_UID)!, /another owner/);
});
