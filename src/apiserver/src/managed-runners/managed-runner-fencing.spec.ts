/**
 * What proves a managed runner instance stopped (managed-runner-fencing.ts), offline: the kubelet's
 * report of a stopped Pod, and the operator's fencing receipt — its format, its completeness and its
 * binding to the one predecessor and volume. The manager acting on them, against a real database and
 * a fake cluster, is managed-runner-fencing.pg.spec.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { ConfigMap, PersistentVolume, Pod, PodCondition } from './kube-client';
import {
  FENCING_RECEIPT_KEY,
  observedStop,
  readFencingReceipt,
  stopProofFor,
  type ManagedRunnerPredecessor,
} from './managed-runner-fencing';
import { podStopConfirmed } from './managed-runner-resources';

const DEPLOY = path.resolve(__dirname, '../../../../deploy/managed-runner');
const NOW = new Date('2026-10-09T12:00:00.000Z');
const predecessor: ManagedRunnerPredecessor = {
  runnerId: '22222222-2222-4222-8222-222222222222',
  generation: 3,
  podName: 'mr-22222222-2222-4222-8222-222222222222',
  podUid: '55555555-5555-4555-8555-555555555555',
  nodeName: 'worker-a',
  pvcUid: '44444444-4444-4444-8444-444444444444',
  volumeHandle: '0001-0009-test-0000000000000001-image-1',
};
const pv: PersistentVolume = {
  apiVersion: 'v1',
  kind: 'PersistentVolume',
  metadata: { name: 'pvc-44444444' },
  spec: { csi: { volumeHandle: predecessor.volumeHandle, volumeAttributes: { pool: 'orbit-test', imageName: 'csi-vol-image-1' } } },
};

/** The example receipt in deploy/managed-runner, filled in for `predecessor`. */
function exampleReceipt(): Record<string, any> {
  const fill: Record<string, string | number> = {
    __RUNNER_UUID__: predecessor.runnerId,
    __RECORDED_GENERATION_AS_A_NUMBER__: predecessor.generation,
    __RECORDED_POD_UID__: predecessor.podUid,
    __RECORDED_NODE_NAME__: predecessor.nodeName!,
    __NODE_UID__: '66666666-6666-4666-8666-666666666666',
    __RECORDED_PVC_UID__: predecessor.pvcUid,
    __RECORDED_CSI_VOLUME_HANDLE__: predecessor.volumeHandle,
    __RBD_POOL__: 'orbit-test',
    __RBD_IMAGE__: 'csi-vol-image-1',
    __OPERATOR_IDENTITY__: 'storage-operator@example.invalid',
    __ISO_8601_TIME_OF_THE_POWER_OFF__: '2026-10-09T11:50:00.000Z',
    __WHAT_WAS_DONE_AND_THROUGH_WHICH_BMC_OR_HYPERVISOR__: 'worker-a powered off through its BMC',
    __CHANGE_OR_INCIDENT_REFERENCE__: 'CHG-0001',
    __WHO_OBSERVED_THE_RESULT__: 'infrastructure-on-call@example.invalid',
    __ISO_8601_TIME_OF_THE_OBSERVATION__: '2026-10-09T11:55:00.000Z',
    __WHERE_THE_INDEPENDENT_POWER_STATE_RECORD_IS__: 'BMC power state record PWR-0001',
    __HOW_THE_NODE_IS_KEPT_OUT_UNTIL_STALE_PODS_AND_MOUNTS_ARE_GONE__: 'cordoned, tainted out-of-service, BMC power locked',
  };
  const filled = readFileSync(path.join(DEPLOY, 'fencing-receipt.example.json'), 'utf8')
    .replace(/"(__[A-Z0-9_]+__)"/g, (_quoted, token: string) => {
      assert.ok(token in fill, `the example has a placeholder the test does not fill: ${token}`);
      return JSON.stringify(fill[token]);
    })
    .replace(/__[A-Z0-9_]+__/g, (token) => {
      assert.ok(token in fill, `the example has a placeholder the test does not fill: ${token}`);
      return String(fill[token]);
    });
  return JSON.parse(filled);
}

function configMap(receipt: unknown): ConfigMap {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: `mr-fence-${predecessor.runnerId}`, uid: 'cm-uid', resourceVersion: '7' },
    data: { [FENCING_RECEIPT_KEY]: typeof receipt === 'string' ? receipt : JSON.stringify(receipt) },
  };
}

function problems(receipt: unknown): string[] {
  const verdict = readFencingReceipt(configMap(receipt), predecessor, pv, NOW);
  return verdict.ok ? [] : verdict.problems;
}

test('the documented example, filled in for the recorded instance, is a receipt the manager accepts', () => {
  const verdict = readFencingReceipt(configMap(exampleReceipt()), predecessor, pv, NOW);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  if (!verdict.ok) return;
  assert.equal(verdict.proof.kind, 'FENCING_RECEIPT');
  assert.deepEqual(verdict.proof.predecessor, predecessor);
  assert.deepEqual(verdict.proof.source, { configMap: `mr-fence-${predecessor.runnerId}`, uid: 'cm-uid', resourceVersion: '7' });
  assert.equal(verdict.proof.receipt.method, 'NODE_POWER_OFF');
});

test('a receipt binds to exactly one predecessor and its volume', () => {
  const bound = (change: (r: Record<string, any>) => void) => {
    const r = exampleReceipt();
    change(r);
    return problems(r);
  };
  for (const [field, change] of [
    ['runnerId', (r: Record<string, any>) => void (r.predecessor.runnerId = '33333333-3333-4333-8333-333333333333')],
    ['generation', (r: Record<string, any>) => void (r.predecessor.generation = 2)],
    ['podName', (r: Record<string, any>) => void (r.predecessor.podName = 'mr-other')],
    ['podUid', (r: Record<string, any>) => void (r.predecessor.podUid = '77777777-7777-4777-8777-777777777777')],
    ['pvcUid', (r: Record<string, any>) => void (r.predecessor.pvcUid = '88888888-8888-4888-8888-888888888888')],
    ['volumeHandle', (r: Record<string, any>) => void (r.predecessor.volumeHandle = 'other')],
    ['nodeName', (r: Record<string, any>) => void (r.predecessor.nodeName = 'worker-b')],
    ['rbdImage.pool', (r: Record<string, any>) => void (r.predecessor.rbdImage.pool = 'production')],
    ['rbdImage.image', (r: Record<string, any>) => void (r.predecessor.rbdImage.image = 'csi-vol-other')],
  ] as const) {
    const found = bound(change);
    assert.ok(found.some((p) => p.includes(field)), `${field}: ${JSON.stringify(found)}`);
  }
  // The generation as a string is not the recorded number.
  assert.ok(bound((r) => void (r.predecessor.generation = '3')).some((p) => p.includes('predecessor.generation')));
});

test('a receipt states an action and an independent observation that it took effect', () => {
  const missing = (change: (r: Record<string, any>) => void) => {
    const r = exampleReceipt();
    change(r);
    return problems(r);
  };
  assert.ok(missing((r) => void delete r.action).length >= 4);
  assert.ok(missing((r) => void delete r.verification.observedBy).some((p) => p.includes('verification.observedBy')));
  assert.ok(missing((r) => void (r.verification.result = 'CLIENTS_BLOCKLISTED')).some((p) => p.includes('POWERED_OFF')));
  assert.ok(missing((r) => void (r.verification.observedAt = '2026-10-09T11:40:00.000Z')).some((p) => p.includes('before action.performedAt')));
  assert.ok(missing((r) => void (r.action.performedAt = 'yesterday')).some((p) => p.includes('ISO 8601')));
  assert.ok(missing((r) => void (r.verification.observedAt = '2026-10-09T13:00:00.000Z')).some((p) => p.includes('in the future')));
  assert.ok(missing((r) => void (r.nodePowerOff.quarantined = false)).some((p) => p.includes('quarantined')));
  assert.ok(missing((r) => void (r.nodePowerOff.mechanism = 'IPMI_SCRIPT')).some((p) => p.includes('mechanism')));
  assert.ok(missing((r) => void (r.method = 'CORDON')).some((p) => p.includes('method')));
  assert.ok(missing((r) => void (r.schemaVersion = 2)).some((p) => p.includes('schemaVersion')));
  assert.ok(missing((r) => void (r.kind = 'something-else')).some((p) => p.includes('kind')));
  assert.deepEqual(problems('not json'), [`${FENCING_RECEIPT_KEY} is not JSON`]);
  assert.deepEqual(problems('[]'), [`${FENCING_RECEIPT_KEY} is not an object`]);
  const empty = readFencingReceipt({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'mr-fence-x' } }, predecessor, pv, NOW);
  assert.equal(empty.ok, false);
});

test('a storage fence counts only persistent, propagated and complete; a temporary blocklist is not a fence', () => {
  const storageFence = (change: (fence: Record<string, any>) => void = () => undefined) => {
    const r = exampleReceipt();
    r.method = 'STORAGE_FENCE';
    r.verification.result = 'CLIENTS_BLOCKLISTED';
    delete r.nodePowerOff;
    r.storageFence = {
      procedureReference: 'ceph-client-fence-procedure-v1 (tested 2026-10-01)',
      blocklistedClients: [{ address: '10.0.0.21:0/3141592653', nonce: '3141592653' }],
      osdMapEpoch: 4821,
      propagationVerifiedAt: '2026-10-09T11:56:00.000Z',
      persistent: true,
      expiresAt: null,
      rejoinPolicy: 'worker-a rejoins only after a reinstall and an operator review',
    };
    change(r.storageFence);
    return problems(r);
  };
  assert.deepEqual(storageFence(), []);
  assert.ok(storageFence((f) => void (f.persistent = false)).some((p) => p.includes('persistent')));
  assert.ok(storageFence((f) => void (f.expiresAt = '2026-10-09T13:00:00.000Z')).some((p) => p.includes('expiresAt')));
  assert.ok(storageFence((f) => void (f.blocklistedClients = [])).some((p) => p.includes('blocklistedClients')));
  assert.ok(storageFence((f) => void (f.blocklistedClients = [{ address: '10.0.0.21:0' }])).some((p) => p.includes('nonce')));
  assert.ok(storageFence((f) => void (f.osdMapEpoch = 0)).some((p) => p.includes('osdMapEpoch')));
  assert.ok(storageFence((f) => void delete f.procedureReference).some((p) => p.includes('procedureReference')));
  assert.ok(storageFence((f) => void (f.propagationVerifiedAt = '2026-10-09T11:00:00.000Z')).some((p) => p.includes('propagationVerifiedAt')));
});

/** The kubelet's report, as a runner Pod's status shows it. */
function pod(phase: string, states: Record<string, Record<string, unknown>>, conditions: PodCondition[] = []): Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: predecessor.podName, uid: predecessor.podUid },
    spec: { initContainers: [{ name: 'private-volume-directories' }], containers: [{ name: 'runner' }] },
    status: {
      phase,
      conditions,
      initContainerStatuses: states['private-volume-directories'] ? [{ name: 'private-volume-directories', state: states['private-volume-directories'] }] : [],
      containerStatuses: states.runner ? [{ name: 'runner', state: states.runner }] : [],
    },
  };
}

test('a stop is the kubelet’s report: every container terminated (or never started), and not a terminal phase the control plane wrote', () => {
  const done = { terminated: { exitCode: 0, finishedAt: '2026-10-09T11:00:00Z' } };
  assert.equal(podStopConfirmed(pod('Failed', { 'private-volume-directories': done, runner: { terminated: { exitCode: 1 } } })), true);
  assert.equal(podStopConfirmed(pod('Succeeded', { 'private-volume-directories': done, runner: done })), true);
  // The init container failed; the runner never started.
  assert.equal(podStopConfirmed(pod('Failed', { 'private-volume-directories': { terminated: { exitCode: 1 } }, runner: { waiting: { reason: 'PodInitializing' } } })), true);
  // Not stopped, or not reported stopped.
  assert.equal(podStopConfirmed(pod('Running', { 'private-volume-directories': done, runner: { running: {} } })), false, 'running');
  assert.equal(podStopConfirmed(pod('Failed', { 'private-volume-directories': done, runner: { running: {} } })), false, 'a container still reported running');
  assert.equal(podStopConfirmed(pod('Failed', { 'private-volume-directories': done })), false, 'a container with no report');
  assert.equal(podStopConfirmed(pod('Failed', {})), false, 'no report at all');
  assert.equal(
    podStopConfirmed(pod('Failed', { 'private-volume-directories': done, runner: done }, [{ type: 'DisruptionTarget', status: 'True', reason: 'DeletionByPodGC' }])),
    false,
    'PodGC made it terminal for a node that is gone',
  );
  assert.equal(
    podStopConfirmed(pod('Failed', { 'private-volume-directories': done, runner: done }, [{ type: 'DisruptionTarget', status: 'True', reason: 'DeletionByTaintManager' }])),
    false,
    'the taint manager evicted it from an unreachable node',
  );
  assert.equal(
    podStopConfirmed(pod('Failed', { 'private-volume-directories': done, runner: done }, [{ type: 'DisruptionTarget', status: 'True', reason: 'TerminationByKubelet' }])),
    true,
    'the kubelet itself stopped it',
  );
});

test('a recorded stop proof is about one predecessor, and is spent once its generation is retired', () => {
  const stopped = pod('Failed', { 'private-volume-directories': { terminated: { exitCode: 0 } }, runner: { terminated: { exitCode: 137 } } });
  const proof = observedStop(predecessor, stopped, NOW);
  assert.equal(proof.kind, 'OBSERVED_STOP');
  assert.deepEqual(proof.observation.containers.map((c) => [c.name, c.state, c.exitCode]), [['private-volume-directories', 'terminated', 0], ['runner', 'terminated', 137]]);
  assert.deepEqual(stopProofFor(proof, predecessor), proof);
  assert.equal(stopProofFor(proof, { ...predecessor, generation: 4 }), null, 'another generation');
  assert.equal(stopProofFor(proof, { ...predecessor, podUid: '77777777-7777-4777-8777-777777777777' }), null, 'another Pod');
  assert.equal(stopProofFor(proof, { ...predecessor, volumeHandle: 'other' }), null, 'another volume');
  assert.equal(stopProofFor({ ...proof, retiredAt: NOW.toISOString() }, predecessor), null, 'already used to retire its generation');
  assert.equal(stopProofFor(null, predecessor), null);
  assert.equal(stopProofFor({ kind: 'SOMETHING_ELSE', predecessor }, predecessor), null);
});
