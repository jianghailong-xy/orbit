import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ManagedRunner } from '@prisma/client';

import { FakeKubeCluster } from '../test-support/fake-kube-client';
import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import type { PersistentVolume, PersistentVolumeClaim } from './kube-client';
import { KubernetesBackend } from './kubernetes-backend';
import { managedRunnerReason } from './managed-runner-manager';
import { buildManagedPvc, managedPvcName } from './managed-runner-resources';
import { recordedVolume, volumeSwitchStateProblem } from './managed-runner-volume-switch';

// An administrator's switch of a runner's data volume to a restored one: the mapping states it may happen in, and
// what the Kubernetes backend reads of the claim under the runner's name and of the recorded PV's attachments. The
// switch itself, the database and the manager's order of checks are managed-runner-volume-switch.pg.spec.ts.

const NOW = new Date('2026-10-18T08:00:00.000Z');
const RUNNER = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OWNER = '0199a1b2-0000-7000-8000-000000000001';
const OTHER_OWNER = '0199a1b2-0000-7000-8000-000000000002';
const profile = testManagedRunnerProfile();

function mapping(change: Partial<ManagedRunner> = {}): ManagedRunner {
  return {
    id: 'm',
    ownerId: OWNER,
    runnerId: RUNNER,
    defaultWorkspaceId: 'w',
    desiredState: 'RUNNING',
    managementState: 'FAILED',
    generation: 3,
    revision: 7,
    backend: 'kubernetes',
    clusterKey: profile.clusterKey,
    namespace: profile.kubernetes.namespace,
    pvcName: managedPvcName(RUNNER),
    pvcUid: 'old-claim-uid',
    pvUid: 'old-pv-uid',
    volumeHandle: 'old-handle',
    podName: null,
    podUid: null,
    nodeName: null,
    nodeUid: null,
    reservation: null,
    demandRevision: 2,
    lastDemandAt: null,
    capacityRevision: null,
    drainDemandRevision: null,
    stopRequestedAt: null,
    stopAcknowledgedAt: null,
    initialProvider: 'claude',
    resourceProfileId: 'p',
    resourceOperationId: null,
    resourceOperationKind: null,
    resourceOperationState: null,
    attempt: 0,
    nextAttemptAt: null,
    startupDeadlineAt: null,
    lastError: { ...managedRunnerReason('PVC_MISSING'), detail: 'PVC mr-data-… (old-claim-uid) is gone' },
    fencingReceipt: null,
    leaseHolder: null,
    leaseExpiresAt: null,
    lastRequestKey: null,
    stateEnteredAt: NOW,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...change,
  };
}

test('a switch is for a runner asleep or failed, with its volume recorded and nothing in flight; failed PVC_MISSING or confirmed', () => {
  assert.equal(volumeSwitchStateProblem(mapping(), false), null, 'FAILED PVC_MISSING: the manager found the recorded volume missing');
  assert.equal(volumeSwitchStateProblem(mapping({ desiredState: 'SLEEPING' }), false), null, 'whatever is desired, short of deletion');
  const asleep = mapping({ managementState: 'SLEEPING', lastError: null });
  assert.deepEqual(volumeSwitchStateProblem(asleep, false), { check: 'CONFIRMATION_REQUIRED', detail: 'it is SLEEPING, not FAILED PVC_MISSING' });
  assert.equal(volumeSwitchStateProblem(asleep, true), null, 'asleep, and the administrator confirms the replacement');
  const crashed = mapping({ podName: `mr-${RUNNER}`, podUid: 'pod-uid', lastError: { ...managedRunnerReason('POD_TERMINATED') } });
  assert.deepEqual(volumeSwitchStateProblem(crashed, false), { check: 'CONFIRMATION_REQUIRED', detail: 'it is FAILED (POD_TERMINATED), not FAILED PVC_MISSING' });
  assert.equal(volumeSwitchStateProblem(crashed, true), null, 'a stopped instance still recorded is the manager\'s check, against its stop proof');

  for (const managementState of ['REQUESTED', 'WAITING_CAPACITY', 'PROVISIONING', 'STARTING', 'READY', 'DRAINING', 'FENCING', 'DELETING', 'DELETED'] as const) {
    assert.deepEqual(volumeSwitchStateProblem(mapping({ managementState }), true), { check: 'NOT_SWITCHABLE', detail: `it is ${managementState}` });
  }
  assert.deepEqual(volumeSwitchStateProblem(mapping({ desiredState: 'DELETED' }), true), { check: 'NOT_SWITCHABLE', detail: 'its deletion was asked' });
  assert.deepEqual(
    volumeSwitchStateProblem(mapping({ resourceOperationKind: 'CREATE_POD', resourceOperationState: 'PENDING' }), true),
    { check: 'NOT_SWITCHABLE', detail: 'a CREATE_POD it asked for may still take effect' },
  );
  assert.equal(volumeSwitchStateProblem(mapping({ resourceOperationKind: 'CREATE_POD', resourceOperationState: 'COMPLETED' }), false), null);
  assert.deepEqual(
    volumeSwitchStateProblem(mapping({ pvcUid: null, pvUid: null, volumeHandle: null }), true),
    { check: 'NOT_SWITCHABLE', detail: 'it records no data volume yet: the manager makes its first one itself' },
  );
  assert.deepEqual(recordedVolume(mapping()), { pvcName: managedPvcName(RUNNER), pvcUid: 'old-claim-uid', pvUid: 'old-pv-uid', volumeHandle: 'old-handle' });
});

/** The in-memory namespace, the backend over it, and a restored claim planted under the runner's name as an operator makes one. */
function cluster() {
  const kube = new FakeKubeCluster(profile.kubernetes.namespace);
  const backend = new KubernetesBackend(kube.client(), profile);
  const identity = { ownerId: OWNER, runnerId: RUNNER, generation: 3, namespace: profile.kubernetes.namespace };
  const restore = (change: (pvc: PersistentVolumeClaim) => void = () => undefined): PersistentVolumeClaim => {
    const pvc = buildManagedPvc(identity, profile);
    change(pvc);
    return kube.plant('persistentvolumeclaims', pvc);
  };
  return { kube, backend, restore };
}

test('the claim under the runner\'s name, as a restored volume: its marks, its binding and whether its PV was made for it', async () => {
  const { kube, backend, restore } = cluster();
  assert.equal(await backend.readReplacement(mapping()), null, 'nothing under the name');

  const claim = restore();
  const found = (await backend.readReplacement(mapping()))!;
  assert.equal(found.volume.uid, claim.metadata.uid);
  assert.equal(found.volume.boundTo, `pvc-${claim.metadata.uid}`);
  assert.equal(found.backing?.handle, kube.persistentVolumes.get(`pvc-${claim.metadata.uid}`)!.spec.csi!.volumeHandle);
  assert.deepEqual([found.removing, found.problem, found.foreign], [false, null, null], 'the manager\'s own marks, its PV provisioned for it');

  // Another account's marks: refused by the same check every pass makes of the mapping's claim.
  kube.remove('persistentvolumeclaims', claim.metadata.name);
  restore((pvc) => void (pvc.metadata.annotations!['orbit.dev/owner-id'] = OTHER_OWNER));
  assert.equal((await backend.readReplacement(mapping()))!.problem, 'the PVC names another owner (or none)');
  kube.remove('persistentvolumeclaims', managedPvcName(RUNNER));
  restore((pvc) => void (pvc.spec.storageClassName = 'another-class'));
  assert.equal((await backend.readReplacement(mapping()))!.problem, 'the PVC uses another storage class');

  // Not bound yet.
  kube.remove('persistentvolumeclaims', managedPvcName(RUNNER));
  kube.autoBind = false;
  const pending = restore();
  const unbound = (await backend.readReplacement(mapping()))!;
  assert.deepEqual([unbound.volume.uid, unbound.volume.boundTo, unbound.backing], [pending.metadata.uid, null, null]);

  // Bound by hand to a retained PV made an hour before the claim: made for another claim first.
  kube.mutate<PersistentVolumeClaim>('persistentvolumeclaims', managedPvcName(RUNNER), (pvc) => {
    pvc.spec.volumeName = 'pv-retained';
    pvc.status = { phase: 'Bound' };
  });
  const madeAt = new Date(Date.parse(pending.metadata.creationTimestamp!) - 3_600_000).toISOString();
  kube.persistentVolumes.set('pv-retained', {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: 'pv-retained', uid: 'retained-pv-uid', creationTimestamp: madeAt },
    spec: {
      storageClassName: profile.storage.className,
      claimRef: { namespace: profile.kubernetes.namespace, name: managedPvcName(RUNNER), uid: pending.metadata.uid },
      csi: { driver: 'rbd.csi.ceph.com', volumeHandle: 'retained-handle' },
      persistentVolumeReclaimPolicy: 'Retain',
    },
  });
  const rebound = (await backend.readReplacement(mapping()))!;
  assert.equal(rebound.problem, null, 'its marks and binding are right');
  assert.match(rebound.foreign ?? '', /^PV pv-retained was created at .*, before PVC mr-data-.*: it was made for another claim first$/);
  // Its claim reference names another claim: not bound to this one.
  kube.persistentVolumes.get('pv-retained')!.spec.claimRef!.uid = 'another-claim';
  assert.equal((await backend.readReplacement(mapping()))!.problem, 'the PV is bound to another claim');
});

test('what still holds the recorded volume: attachments of its PV, found by its recorded UID or handle', async () => {
  const { kube, backend, restore } = cluster();
  const claim = restore();
  const replacement = (await backend.readReplacement(mapping()))!;
  const pv = (name: string, uid: string, handle: string): PersistentVolume => ({
    apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name, uid }, spec: { csi: { driver: 'rbd.csi.ceph.com', volumeHandle: handle } },
  });
  const attach = (name: string, pvName: string, attacher = 'rbd.csi.ceph.com') => kube.volumeAttachments.set(name, {
    apiVersion: 'storage.k8s.io/v1', kind: 'VolumeAttachment', metadata: { name },
    spec: { attacher, nodeName: 'node-b', source: { persistentVolumeName: pvName } }, status: { attached: true },
  });
  assert.deepEqual(await backend.recordedVolumeHolders(mapping(), replacement), [], 'nothing attached');

  kube.persistentVolumes.set('pv-old', pv('pv-old', 'old-pv-uid', 'old-handle'));
  kube.persistentVolumes.set('pv-other', pv('pv-other', 'other-pv-uid', 'other-handle'));
  attach('va-other', 'pv-other');
  attach('va-restored', `pvc-${claim.metadata.uid}`);
  attach('va-elsewhere', 'pv-old', 'nfs.csi.k8s.io');
  assert.deepEqual(await backend.recordedVolumeHolders(mapping(), replacement), [], 'another PV, the restored one\'s own, another driver\'s');

  attach('va-old', 'pv-old');
  assert.deepEqual(await backend.recordedVolumeHolders(mapping(), replacement), ['va-old on node node-b (PV pv-old)'], 'the recorded PV, by its UID');
  kube.persistentVolumes.set('pv-old', pv('pv-old', 'a-copy-of-it', 'old-handle'));
  assert.deepEqual(await backend.recordedVolumeHolders(mapping(), replacement), ['va-old on node node-b (PV pv-old)'], 'and by its handle');
  kube.volumeAttachments.delete('va-old');

  attach('va-unknown', 'pv-gone');
  assert.deepEqual(
    await backend.recordedVolumeHolders(mapping(), replacement),
    ['va-unknown on node node-b (its PV pv-gone cannot be read)'],
    'an attachment whose PV cannot be read may be the recorded one',
  );
});
