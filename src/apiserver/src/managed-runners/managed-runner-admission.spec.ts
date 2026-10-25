/**
 * The single-Pod admission guard, offline (docs/managed-runner-design.md, "Single Pod and single
 * writer protection"; managed-runner-admission.ts). The decision is a pure function of the review,
 * the mapping the database holds for each claim and the profile, so every case here is decided
 * exactly as the webhook decides it. The webhook's own refusals — switched off, unavailable, no
 * token, a malformed review, a database that fails — are its HTTP answers, which the API server,
 * with the template's `failurePolicy: Fail`, turns into a refused Pod.
 *
 * The same decision runs against a real database and a fake API server (with its one-object-per-name
 * rule and concurrent creates) in managed-runner-fencing.pg.spec.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { sha256 } from '../common/crypto.util';
import { FAKE_ADMISSION_WEBHOOK_NAME } from '../test-support/fake-kube-client';
import {
  TEST_ADMISSION_WEBHOOK_TOKEN,
  TEST_MANAGER_USERNAME,
  testManagedRunnerProfile,
} from '../test-support/managed-runner-profile.fixture';
import type { Pod } from './kube-client';
import {
  MANAGED_ADMISSION_DENIAL_MARKER,
  admissionReviewResponse,
  decidePodAdmission,
  type PodAdmissionDecision,
  type PodAdmissionMapping,
  type PodAdmissionRequest,
} from './managed-runner-admission';
import { ManagedRunnerAdmissionController, ManagedRunnerAdmissionGuard } from './managed-runner-admission.controller';
import type { ManagedRunnerRuntime } from './managed-runner-runtime';
import { buildManagedPod, managedPodName, managedPvcName, managedSecretName } from './managed-runner-resources';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RUNNER = '22222222-2222-4222-8222-222222222222';
const OTHER_RUNNER = '33333333-3333-4333-8333-333333333333';
const PVC_UID = '44444444-4444-4444-8444-444444444444';
const profile = testManagedRunnerProfile();
const NS = profile.kubernetes.namespace;
const policy = { namespace: NS, managerUsername: TEST_MANAGER_USERNAME, image: profile.runner.image };
const DEPLOY = path.resolve(__dirname, '../../../../deploy/managed-runner');

/** A mapping that has reserved generation 3: STARTING, no Pod recorded, the create pending. */
function reserved(overrides: Partial<PodAdmissionMapping> = {}): PodAdmissionMapping {
  return {
    ownerId: OWNER,
    runnerId: RUNNER,
    generation: 3,
    pvcName: managedPvcName(RUNNER),
    pvcUid: PVC_UID,
    podUid: null,
    managementState: 'STARTING',
    resourceOperationKind: 'CREATE_POD',
    resourceOperationState: 'PENDING',
    ...overrides,
  };
}

/** The Pod the manager creates for generation 3. */
function authorizedPod(generation = 3): Pod {
  return buildManagedPod({ ownerId: OWNER, runnerId: RUNNER, generation, namespace: NS }, PVC_UID, profile);
}

/** Any Pod that mounts the runner's data volume, as a tenant, an operator or a controller might write it. */
function podUsingTheVolume(name: string, options: { nodeName?: string; labels?: Record<string, string>; readOnly?: boolean } = {}): Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: NS, ...(options.labels ? { labels: options.labels } : {}) },
    spec: {
      ...(options.nodeName ? { nodeName: options.nodeName } : {}),
      containers: [{ name: 'shell', image: 'busybox', volumeMounts: [{ name: 'data', mountPath: '/data' }] }],
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: managedPvcName(RUNNER), ...(options.readOnly ? { readOnly: true } : {}) } }],
    },
  };
}

function create(object: Pod, username = TEST_MANAGER_USERNAME, extra: Partial<PodAdmissionRequest> = {}): PodAdmissionRequest {
  return {
    uid: 'review-uid',
    resource: { group: '', version: 'v1', resource: 'pods' },
    operation: 'CREATE',
    namespace: NS,
    name: object.metadata.name,
    userInfo: { username },
    object,
    oldObject: null,
    ...extra,
  };
}

function decide(request: PodAdmissionRequest, mapping: PodAdmissionMapping | null = reserved()): PodAdmissionDecision {
  return decidePodAdmission(request, new Map([[managedPvcName(RUNNER), mapping]]), policy);
}

function refusedWith(decision: PodAdmissionDecision, code: string, label: string): void {
  assert.equal(decision.allowed, false, `${label}: admitted`);
  assert.equal((decision as { code: string }).code, code, `${label}: ${JSON.stringify(decision)}`);
}

test('the authorized Pod is admitted: the manager, the fixed name, the reserved generation, the template', () => {
  assert.deepEqual(decide(create(authorizedPod())), { allowed: true, reason: 'AUTHORIZED' });
  // Labels play no part in it either way.
  const unlabelled = authorizedPod();
  delete unlabelled.metadata.labels;
  assert.deepEqual(decide(create(unlabelled)), { allowed: true, reason: 'AUTHORIZED' });
});

test('any other Pod using the volume is refused: another name, no labels, a Job, a read-only mount, on the same node or another', () => {
  const tenant = 'system:serviceaccount:orbit-managed-test:default';
  const cases: Array<[string, PodAdmissionRequest, string]> = [
    ['another name, by the manager', create({ ...authorizedPod(), metadata: { ...authorizedPod().metadata, name: `${managedPodName(RUNNER)}-debug` } }), 'NOT_THE_FIXED_NAME'],
    ['another name, unlabelled, by someone else', create(podUsingTheVolume('backup'), tenant), 'NOT_THE_MANAGER'],
    ['another name, unlabelled, by the manager’s identity', create(podUsingTheVolume('backup')), 'NOT_THE_FIXED_NAME'],
    ['the fixed name, unlabelled, by someone else', create(podUsingTheVolume(managedPodName(RUNNER)), tenant), 'NOT_THE_MANAGER'],
    ['the fixed name, unlabelled and unannotated, by the manager', create(podUsingTheVolume(managedPodName(RUNNER))), 'NOT_THE_OWNER'],
    ['on the same node as the runner', create(podUsingTheVolume('same-node', { nodeName: 'node-a' }), tenant), 'NOT_THE_MANAGER'],
    ['on another node', create(podUsingTheVolume('cross-node', { nodeName: 'node-b' }), tenant), 'NOT_THE_MANAGER'],
    ['labelled as a runner', create(podUsingTheVolume('impostor', { labels: { 'app.kubernetes.io/name': 'orbit-managed-runner' } }), tenant), 'NOT_THE_MANAGER'],
    ['read-only', create(podUsingTheVolume('reader', { readOnly: true }), tenant), 'NOT_THE_MANAGER'],
    ['a Job’s Pod', create(podUsingTheVolume('restore-job-x7k2p'), 'system:serviceaccount:kube-system:job-controller'), 'NOT_THE_MANAGER'],
  ];
  for (const [label, request, code] of cases) refusedWith(decide(request), code, label);
  // An init container's use is the Pod's: the claim is the Pod's volume, whichever container mounts it.
  const init = podUsingTheVolume('init-copy');
  init.spec.initContainers = init.spec.containers;
  init.spec.containers = [{ name: 'sleep', image: 'busybox' }];
  refusedWith(decide(create(init, tenant)), 'NOT_THE_MANAGER', 'an init container');
});

test('the manager itself is refused for anything but the reserved generation’s one create', () => {
  refusedWith(decide(create(authorizedPod(2))), 'NOT_THE_RESERVED_GENERATION', 'a stale manager’s previous generation');
  refusedWith(decide(create(authorizedPod(4))), 'NOT_THE_RESERVED_GENERATION', 'a generation never reserved');
  refusedWith(decide(create(authorizedPod()), reserved({ podUid: '55555555-5555-4555-8555-555555555555', managementState: 'READY', resourceOperationState: 'COMPLETED' })), 'NOT_RESERVED', 'a second Pod of a recorded generation');
  refusedWith(decide(create(authorizedPod()), reserved({ managementState: 'FENCING' })), 'NOT_RESERVED', 'while fencing');
  refusedWith(decide(create(authorizedPod()), reserved({ resourceOperationKind: 'CREATE_SECRET' })), 'NOT_RESERVED', 'no create pending');
  refusedWith(decide(create(authorizedPod()), reserved({ pvcUid: '66666666-6666-4666-8666-666666666666' })), 'NOT_THE_VOLUME', 'authorized for another PVC');
  refusedWith(decide(create(authorizedPod()), reserved({ ownerId: '77777777-7777-4777-8777-777777777777' })), 'NOT_THE_OWNER', 'another owner');

  const tampered = (change: (pod: Pod) => void, label: string) => {
    const pod = authorizedPod();
    change(pod);
    refusedWith(decide(create(pod)), 'NOT_THE_TEMPLATE', label);
  };
  tampered((pod) => void ((pod.spec.containers as Array<{ image: string }>)[0].image = 'busybox'), 'another image');
  tampered((pod) => void (pod.spec.hostNetwork = true), 'the host network');
  tampered((pod) => void (pod.spec.automountServiceAccountToken = true), 'a service account token');
  tampered((pod) => void ((pod.spec.containers as Array<Record<string, unknown>>)[0].securityContext = { privileged: true }), 'a privileged container');
  tampered((pod) => void pod.spec.volumes!.push({ name: 'host', hostPath: { path: '/' } }), 'a host path');
  tampered((pod) => void pod.spec.volumes!.push({ name: 'other', secret: { secretName: managedSecretName(OTHER_RUNNER) } }), 'another runner’s Secret');
  tampered((pod) => void (pod.spec.ephemeralContainers = [{ name: 'debug', image: profile.runner.image }]), 'an ephemeral container');
});

test('volumes are resolved from the database, never from the Pod: unknown, aliased and doubled claims are refused', () => {
  const tenant = 'system:serviceaccount:orbit-managed-test:default';
  refusedWith(decide(create(podUsingTheVolume('x'), tenant), null), 'UNMAPPED_MANAGED_CLAIM', 'a managed name no mapping owns');
  const both = podUsingTheVolume('both');
  both.spec.volumes!.push({ name: 'other', persistentVolumeClaim: { claimName: managedPvcName(OTHER_RUNNER) } });
  const decision = decidePodAdmission(create(both, tenant), new Map([[managedPvcName(RUNNER), reserved()], [managedPvcName(OTHER_RUNNER), null]]), policy);
  refusedWith(decision, 'MULTIPLE_MANAGED_CLAIMS', 'two managed volumes');
  // A generic ephemeral volume whose claim would be `<pod>-<volume>`, named to collide with the data volume.
  const alias: Pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'mr-data', namespace: NS },
    spec: { containers: [{ name: 'c', image: 'busybox' }], volumes: [{ name: RUNNER, ephemeral: { volumeClaimTemplate: { spec: {} } } }] },
  };
  refusedWith(decide(create(alias, tenant)), 'NOT_THE_MANAGER', 'an ephemeral claim named like the data volume');
  // A Pod with no managed volume, or in another namespace (where these claims cannot be named), is not this guard's business.
  assert.deepEqual(decide(create({ ...podUsingTheVolume('x'), spec: { containers: [{ name: 'c', image: 'busybox' }] } }, tenant)), { allowed: true, reason: 'NOT_MANAGED' });
  assert.deepEqual(decide(create(podUsingTheVolume('x'), tenant, { namespace: 'elsewhere' })), { allowed: true, reason: 'NOT_MANAGED' });
});

test('an update may not change the Pod’s volumes, images or identity, nor add an ephemeral container', () => {
  const before = { ...authorizedPod(), metadata: { ...authorizedPod().metadata, uid: 'pod-uid' } };
  const update = (after: Pod, subResource?: string): PodAdmissionRequest => ({
    ...create(after, 'system:serviceaccount:kube-system:generic-garbage-collector'),
    operation: 'UPDATE',
    oldObject: before,
    ...(subResource ? { subResource } : {}),
  });
  const recorded = reserved({ podUid: 'pod-uid', managementState: 'READY', resourceOperationState: 'COMPLETED' });
  const relabelled = structuredClone(before);
  relabelled.metadata.labels = { ...relabelled.metadata.labels, extra: 'x' };
  assert.deepEqual(decide(update(relabelled), recorded), { allowed: true, reason: 'UNCHANGED' });
  const regenerated = structuredClone(before);
  regenerated.metadata.annotations!['orbit.dev/generation'] = '4';
  refusedWith(decide(update(regenerated), recorded), 'IMMUTABLE_IDENTITY', 'a new generation annotation');
  const reimaged = structuredClone(before);
  (reimaged.spec.containers as Array<{ image: string }>)[0].image = 'busybox';
  refusedWith(decide(update(reimaged), recorded), 'IMMUTABLE_IDENTITY', 'another image');
  const debugged = structuredClone(before);
  debugged.spec.ephemeralContainers = [{ name: 'debugger', image: 'busybox' }];
  refusedWith(decide(update(debugged, 'ephemeralcontainers'), recorded), 'EPHEMERAL_CONTAINER', 'kubectl debug');
});

test('a refusal is an AdmissionReview v1 answer the manager’s probe can recognise; an admission echoes the uid', () => {
  assert.deepEqual(admissionReviewResponse('review-uid', { allowed: true, reason: 'AUTHORIZED' }), {
    apiVersion: 'admission.k8s.io/v1',
    kind: 'AdmissionReview',
    response: { uid: 'review-uid', allowed: true },
  });
  const refused = admissionReviewResponse('review-uid', { allowed: false, code: 'NOT_THE_MANAGER', message: 'only the manager' });
  assert.equal(refused.response.allowed, false);
  assert.equal(refused.response.uid, 'review-uid');
  assert.equal((refused.response as { status: { code: number } }).status.code, 403);
  assert.match((refused.response as { status: { message: string } }).status.message, new RegExp(`^${MANAGED_ADMISSION_DENIAL_MARKER}: NOT_THE_MANAGER: `));
});

test('the template: every Pod create and update in the managed namespace, failurePolicy Fail, no label selector', () => {
  const template = JSON.parse(readFileSync(path.join(DEPLOY, 'admission/pod-admission-webhook.template.json'), 'utf8'));
  assert.equal(template.kind, 'ValidatingWebhookConfiguration');
  assert.equal(template.apiVersion, 'admissionregistration.k8s.io/v1');
  assert.equal(template.webhooks.length, 1);
  const [webhook] = template.webhooks;
  assert.equal(webhook.name, FAKE_ADMISSION_WEBHOOK_NAME, 'the fake API server names it as the real one does');
  assert.equal(webhook.failurePolicy, 'Fail', 'a webhook that cannot answer refuses the Pod');
  assert.equal(webhook.sideEffects, 'None', 'so the manager’s dry-run probe reaches it');
  assert.equal(webhook.matchPolicy, 'Equivalent');
  assert.ok(webhook.timeoutSeconds > 0 && webhook.timeoutSeconds <= 10);
  assert.deepEqual(webhook.admissionReviewVersions, ['v1']);
  assert.equal(webhook.objectSelector, undefined, 'labels are the Pod’s own word: they select nothing here');
  assert.deepEqual(Object.keys(webhook.namespaceSelector.matchLabels), ['kubernetes.io/metadata.name']);
  assert.deepEqual(webhook.rules, [{
    apiGroups: [''],
    apiVersions: ['v1'],
    operations: ['CREATE', 'UPDATE'],
    resources: ['pods', 'pods/ephemeralcontainers'],
    scope: 'Namespaced',
  }]);
  const route = `/api/${Reflect.getMetadata(PATH_METADATA, ManagedRunnerAdmissionController)}`;
  assert.equal(new URL(webhook.clientConfig.url.replace('__AUTHORIZED_TEST_ORBIT_HOST__', 'orbit.invalid')).pathname, route);
  assert.equal(webhook.clientConfig.service, undefined);
});

/** The guard and controller as Nest runs them, with a request and nothing else. */
function http(headers: Record<string, string> = {}): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as unknown as ExecutionContext;
}

const ON = { enabled: true, problem: null } as const;
const OFF = { enabled: false, problem: null } as const;
const available = { available: true, profile } as unknown as ManagedRunnerRuntime;
const bearer = { authorization: `Bearer ${TEST_ADMISSION_WEBHOOK_TOKEN}` };

test('the webhook fails closed: off 404, unavailable 503, no or a wrong token 401 — before anything is read', () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, ManagedRunnerAdmissionController), [ManagedRunnerAdmissionGuard]);
  const status = (gate: typeof ON | typeof OFF, runtime: ManagedRunnerRuntime | null, headers: Record<string, string>) => {
    try {
      new ManagedRunnerAdmissionGuard(gate, runtime).canActivate(http(headers));
      return 200;
    } catch (error) {
      return (error as { getStatus(): number }).getStatus();
    }
  };
  assert.equal(status(OFF, null, bearer), 404, 'switched off: as a server without the feature');
  assert.equal(status(OFF, available, bearer), 404, 'switched off, whatever else is configured');
  assert.equal(status(ON, null, bearer), 503);
  assert.equal(status(ON, { available: false, problems: ['no profile'] }, bearer), 503);
  assert.equal(status(ON, available, {}), 401);
  assert.equal(status(ON, available, { authorization: 'Bearer wrong' }), 401);
  assert.equal(status(ON, available, { authorization: sha256(TEST_ADMISSION_WEBHOOK_TOKEN) }), 401, 'the hash is not the token');
  assert.equal(status(ON, available, bearer), 200);
});

test('the webhook fails closed: a malformed review is 400, a database that fails is an error — never an admission', async () => {
  const calls: unknown[] = [];
  const prisma = {
    managedRunner: {
      findMany: async (query: unknown) => {
        calls.push(query);
        return [{ ...reserved() }];
      },
    },
  };
  const controller = new ManagedRunnerAdmissionController(prisma as never, available);
  const review = (request: unknown) => ({ apiVersion: 'admission.k8s.io/v1', kind: 'AdmissionReview', request });
  for (const body of [null, {}, review(null), review({ operation: 'CREATE' }), { kind: 'AdmissionReview', request: create(authorizedPod()) }]) {
    await assert.rejects(controller.review(body as never), (e: any) => e.getStatus() === 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0, 'nothing was read for a review that is not one');

  const admitted = await controller.review(review(create(authorizedPod())) as never);
  assert.deepEqual(admitted.response, { uid: 'review-uid', allowed: true });
  assert.deepEqual((calls[0] as { where: unknown }).where, {
    clusterKey: profile.clusterKey,
    namespace: NS,
    pvcName: { in: [managedPvcName(RUNNER)] },
  }, 'ownership is looked up by the claim, in this cluster and namespace');
  const refused = await controller.review(review(create(podUsingTheVolume('other'), 'system:serviceaccount:orbit-managed-test:default')) as never);
  assert.equal(refused.response.allowed, false);

  const failing = new ManagedRunnerAdmissionController({ managedRunner: { findMany: async () => { throw new Error('database down'); } } } as never, available);
  await assert.rejects(failing.review(review(create(authorizedPod())) as never), /database down/);
  const unavailable = new ManagedRunnerAdmissionController(prisma as never, null);
  await assert.rejects(unavailable.review(review(create(authorizedPod())) as never), (e: any) => e.getStatus() === 503);
});
