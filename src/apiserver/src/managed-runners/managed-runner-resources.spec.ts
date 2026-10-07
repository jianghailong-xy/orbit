import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import type { PersistentVolume, PersistentVolumeClaim } from './kube-client';
import {
  bootstrapCredentialOf,
  buildManagedPod,
  buildManagedPvc,
  buildManagedSecret,
  managedPodName,
  managedPvcName,
  managedSecretName,
  podIdentityProblem,
  pvIdentityProblem,
  pvcIdentityProblem,
  secretIdentityProblem,
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

test('the Pod is deploy/managed-runner/runner-pod.yaml.example filled in, with exactly the documented differences', () => {
  const pod = buildManagedPod(identity, PVC_UID, profile);
  const fill: Record<string, string> = {
    __FIXED_USER_POD_NAME__: managedPodName(RUNNER),
    __AUTHORIZED_TEST_NAMESPACE__: profile.kubernetes.namespace,
    __TEST_ENVIRONMENT_ID__: profile.environmentId,
    __RUNNER_IMAGE_AT_SHA256_DIGEST__: profile.runner.image,
    __INIT_CPU_REQUEST__: profile.runner.resources.init.requests.cpu,
    __INIT_MEMORY_REQUEST__: profile.runner.resources.init.requests.memory,
    __INIT_CPU_LIMIT__: profile.runner.resources.init.limits.cpu,
    __INIT_MEMORY_LIMIT__: profile.runner.resources.init.limits.memory,
    __AUTHORIZED_TEST_ORBIT_HTTPS_URL__: profile.runner.serverUrl,
    __STABLE_USER_RUNNER_NAME__: 'orbit-managed',
    __AUTHORIZED_SESSION_CONCURRENCY__: String(profile.runner.maxConcurrent),
    __RUNNER_CPU_REQUEST__: profile.runner.resources.runner.requests.cpu,
    __RUNNER_MEMORY_REQUEST__: profile.runner.resources.runner.requests.memory,
    __RUNNER_CPU_LIMIT__: profile.runner.resources.runner.limits.cpu,
    __RUNNER_MEMORY_LIMIT__: profile.runner.resources.runner.limits.memory,
    __EXISTING_PER_USER_TEST_PVC__: managedPvcName(RUNNER),
    __AUTHORIZED_TMP_SIZE__: profile.runner.tmpSizeLimit,
    __TARGET_USERS_ONE_TIME_TEST_ENROLLMENT_SECRET__: managedSecretName(RUNNER),
  };
  const yaml = readFileSync(path.join(DEPLOY, 'runner-pod.yaml.example'), 'utf8')
    .replace(/__[A-Z0-9_]+__/g, (token) => {
      assert.ok(token in fill, `the example has a placeholder the manager does not fill: ${token}`);
      return fill[token];
    });
  const example = readYaml(yaml) as { metadata: Record<string, any>; spec: Record<string, any> };

  // The documented differences, applied to the example: identity annotations; the runner's
  // pre-created ID; and the bootstrap credential mounted where the enrollment token was.
  example.metadata.annotations = {
    'orbit.dev/owner-id': OWNER,
    'orbit.dev/runner-id': RUNNER,
    'orbit.dev/generation': '1',
    'orbit.dev/pvc-uid': PVC_UID,
  };
  const runner = example.spec.containers[0];
  runner.env = [
    ...runner.env.filter((e: { name: string }) => e.name !== 'ORBIT_RUNNER_ENROLLMENT_TOKEN_FILE'),
    { name: 'ORBIT_RUNNER_EXPECTED_ID', value: RUNNER },
    { name: 'ORBIT_RUNNER_CREDENTIAL_FILE', value: '/run/orbit-bootstrap/token' },
  ];
  runner.volumeMounts = runner.volumeMounts.map((m: { name: string }) =>
    m.name === 'enrollment' ? { name: 'bootstrap', mountPath: '/run/orbit-bootstrap', readOnly: true } : m,
  );
  example.spec.volumes = example.spec.volumes.map((v: { name: string }) => (v.name === 'enrollment' ? { ...v, name: 'bootstrap' } : v));

  assert.deepEqual(pod, example);
  assert.equal(pod.spec.restartPolicy, 'Never');
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.terminationGracePeriodSeconds, 240);
  assert.ok(!JSON.stringify(pod).includes('ENROLLMENT'), 'an image that only knows enrollment gets no token to enroll with');
});

test('the bootstrap Secret carries the credential and the generation it is for, and is immutable', () => {
  const secret = buildManagedSecret(identity, 'credential-of-generation-1');
  assert.equal(secret.metadata.name, managedSecretName(RUNNER));
  assert.equal(secret.immutable, true);
  assert.equal(bootstrapCredentialOf(secret), 'credential-of-generation-1');
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
