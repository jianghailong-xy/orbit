import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import { KubeAmbiguousError, KubeApiError, isRetryableKubeError, type KubeWatchEvent, type Pod } from './kube-client';
import {
  KubeHttpClient,
  kubeClientFromProfile,
  type KubeTransport,
  type KubeTransportRequest,
  type KubeTransportResponse,
} from './kube-http-client';
import { buildManagedPvc } from './managed-runner-resources';

// The real Kubernetes client, tested at its HTTP layer: a recording transport stands where
// node:https would be, so every request the client would send is inspected and every answer is
// scripted. Nothing here opens a socket, reads a real kubeconfig or reaches a cluster.

const PROFILE = testManagedRunnerProfile();
const KUBECONFIG = PROFILE.kubernetes.kubeconfig;

/** A transport that answers from a script, in order, and remembers what it was asked. */
function scripted(...answers: Array<KubeTransportResponse | Error>) {
  const sent: KubeTransportRequest[] = [];
  const transport: KubeTransport = {
    async request(request) {
      sent.push(request);
      const answer = answers.shift();
      if (!answer) throw new Error(`unscripted request ${request.method} ${request.url.pathname}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    stream(request, onChunk) {
      sent.push(request);
      const answer = answers.shift();
      if (!answer || answer instanceof Error) throw new Error('unscripted watch');
      const done = (async () => {
        if (answer.status >= 200 && answer.status < 300) for (const chunk of answer.body.split('|')) onChunk(chunk);
        return answer.status >= 200 && answer.status < 300 ? { status: answer.status, body: '' } : answer;
      })();
      return { abort: () => undefined, done };
    },
  };
  return { sent, transport };
}

const json = (status: number, body: unknown): KubeTransportResponse => ({ status, body: JSON.stringify(body) });

/** A kubeconfig with a decoy current context, a decoy cluster and the profile's context. */
function kubeconfig(overrides: { context?: Record<string, unknown>; cluster?: Record<string, unknown>; user?: Record<string, unknown> } = {}) {
  return {
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': 'production',
    clusters: [
      { name: 'production-cluster', cluster: { server: 'https://production.invalid:6443' } },
      { name: 'test-cluster', cluster: { server: 'https://kube.invalid:6443', 'certificate-authority-data': Buffer.from('CA PEM').toString('base64'), ...overrides.cluster } },
    ],
    users: [
      { name: 'production-admin', user: { token: 'production-token' } },
      { name: 'manager', user: { token: 'manager-token', ...overrides.user } },
    ],
    contexts: [
      { name: 'production', context: { cluster: 'production-cluster', user: 'production-admin', namespace: 'default' } },
      { name: 'orbit-fake', context: { cluster: 'test-cluster', user: 'manager', namespace: 'orbit-managed-test', ...overrides.context } },
    ],
  };
}

function reader(files: Record<string, unknown>, read: string[] = []) {
  return (file: string): Buffer => {
    read.push(file);
    if (!(file in files)) throw new Error(`ENOENT: ${file}`);
    const value = files[file];
    return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  };
}

function client(...answers: Array<KubeTransportResponse | Error>) {
  const { sent, transport } = scripted(...answers);
  return { sent, kube: kubeClientFromProfile(PROFILE, { readFile: reader({ [KUBECONFIG]: kubeconfig() }), transport }) };
}

test('only the named context is used: never current-context, KUBECONFIG, ~/.kube or in-cluster credentials', async () => {
  const saved = { ...process.env };
  process.env.KUBECONFIG = '/tmp/should-not-be-read/kubeconfig';
  process.env.KUBERNETES_SERVICE_HOST = '10.255.0.1';
  process.env.KUBERNETES_SERVICE_PORT = '443';
  try {
    const read: string[] = [];
    const { sent, transport } = scripted(json(200, { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'x' }, spec: {} }));
    const kube = kubeClientFromProfile(PROFILE, { readFile: reader({ [KUBECONFIG]: kubeconfig() }, read), transport });
    await kube.pods.get('x');
    assert.deepEqual(read, [KUBECONFIG], 'the one file the profile names, and nothing else');
    assert.equal(sent[0].url.origin, 'https://kube.invalid:6443');
    assert.equal(sent[0].headers.authorization, 'Bearer manager-token', "the named context's user, not current-context's");
    assert.equal(sent[0].tls.ca?.toString(), 'CA PEM');

    // The profile's context missing: refused, with no fallback to current-context or in-cluster.
    const without = kubeconfig();
    without.contexts = without.contexts.filter((c) => c.name !== 'orbit-fake');
    assert.throws(
      () => kubeClientFromProfile(PROFILE, { readFile: reader({ [KUBECONFIG]: without }), transport }),
      /no context named "orbit-fake"/,
    );
  } finally {
    process.env = saved;
  }
});

test('the context must point at the profile API server and namespace; unsafe credentials are refused', () => {
  const build = (config: unknown, extra: Record<string, unknown> = {}) => () =>
    kubeClientFromProfile(PROFILE, { readFile: reader({ [KUBECONFIG]: config, ...extra }), transport: scripted().transport });

  assert.throws(build(kubeconfig({ cluster: { server: 'https://elsewhere.invalid:6443' } })), /points at https:\/\/elsewhere\.invalid:6443, not the profile/);
  assert.throws(build(kubeconfig({ context: { namespace: 'default' } })), /names namespace default, not the profile's orbit-managed-test/);
  assert.throws(build(kubeconfig({ cluster: { 'insecure-skip-tls-verify': true } })), /skips TLS verification/);
  assert.throws(build(kubeconfig({ user: { exec: { command: 'aws' } } })), /uses exec/);
  assert.throws(build(kubeconfig({ user: { 'auth-provider': { name: 'gcp' } } })), /uses auth-provider/);
  assert.throws(build(kubeconfig({ user: { token: undefined } })), /has no token or client certificate/);
  assert.throws(build(kubeconfig({ cluster: { 'certificate-authority-data': undefined, 'certificate-authority': 'ca.pem' } })), /must be an absolute path/);
  assert.throws(build('apiVersion: v1\nkind: Config\n'), /is not readable JSON/);
  const twice = kubeconfig();
  twice.contexts.push({ name: 'orbit-fake', context: { cluster: 'production-cluster', user: 'production-admin', namespace: 'orbit-managed-test' } });
  assert.throws(build(twice), /more than one context named "orbit-fake"/);
  assert.throws(() => new KubeHttpClient({ server: 'http://kube.invalid', namespace: 'x', tls: {}, requestTimeoutMs: 1 }), /over https/);
});

test('a token file is read again for every request, so a rotated token is followed', async () => {
  let token = 'first';
  const config = kubeconfig({ user: { token: undefined, tokenFile: '/var/orbit-manager/token' } });
  const read = (file: string) => (file === KUBECONFIG ? Buffer.from(JSON.stringify(config)) : Buffer.from(`${token}\n`));
  const { sent, transport } = scripted(json(404, {}), json(404, {}));
  const kube = kubeClientFromProfile(PROFILE, { readFile: read, transport });
  await kube.secrets.get('a');
  token = 'second';
  await kube.secrets.get('a');
  assert.deepEqual(sent.map((r) => r.headers.authorization), ['Bearer first', 'Bearer second']);
});

test('a client certificate is presented when the context uses one', async () => {
  const config = kubeconfig({
    user: {
      token: undefined,
      'client-certificate-data': Buffer.from('CERT').toString('base64'),
      'client-key-data': Buffer.from('KEY').toString('base64'),
    },
  });
  const { sent, transport } = scripted(json(404, {}));
  const kube = kubeClientFromProfile(PROFILE, { readFile: reader({ [KUBECONFIG]: config }), transport });
  await kube.pods.get('x');
  assert.equal(sent[0].tls.cert?.toString(), 'CERT');
  assert.equal(sent[0].tls.key?.toString(), 'KEY');
  assert.equal(sent[0].headers.authorization, undefined);
});

test('requests: paths, verbs, bodies and answers', async () => {
  const pvc = buildManagedPvc({ ownerId: 'o', runnerId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', generation: 1, namespace: 'orbit-managed-test' }, PROFILE);
  const created = { ...pvc, metadata: { ...pvc.metadata, uid: 'uid-1' } };
  const { sent, kube } = client(
    json(404, { kind: 'Status', reason: 'NotFound' }),
    json(201, created),
    json(409, { kind: 'Status', reason: 'AlreadyExists', message: 'already exists' }),
    json(200, { items: [created] }),
    json(200, { kind: 'Status' }),
    json(404, { kind: 'Status', reason: 'NotFound' }),
    json(200, { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: 'pv-1' }, spec: {} }),
    json(404, {}),
  );
  const ns = '/api/v1/namespaces/orbit-managed-test';

  assert.equal(await kube.persistentVolumeClaims.get(pvc.metadata.name), null);
  assert.deepEqual(await kube.persistentVolumeClaims.create(pvc), created);
  await assert.rejects(kube.persistentVolumeClaims.create(pvc), (e: unknown) => e instanceof KubeApiError && e.status === 409 && e.reason === 'AlreadyExists');
  assert.deepEqual(await kube.persistentVolumeClaims.list({ labelSelector: 'app.kubernetes.io/name=orbit-managed-runner' }), [created]);
  await kube.pods.delete('mr-x', { uid: 'pod-uid-1' });
  await kube.pods.delete('mr-x'); // already gone: resolves
  assert.equal((await kube.getPersistentVolume('pv-1'))?.metadata.name, 'pv-1');
  assert.equal(await kube.getPersistentVolume('pv-2'), null);

  assert.deepEqual(
    sent.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`),
    [
      `GET ${ns}/persistentvolumeclaims/${pvc.metadata.name}`,
      `POST ${ns}/persistentvolumeclaims`,
      `POST ${ns}/persistentvolumeclaims`,
      `GET ${ns}/persistentvolumeclaims?labelSelector=app.kubernetes.io%2Fname%3Dorbit-managed-runner`,
      `DELETE ${ns}/pods/mr-x`,
      `DELETE ${ns}/pods/mr-x`,
      'GET /api/v1/persistentvolumes/pv-1',
      'GET /api/v1/persistentvolumes/pv-2',
    ],
  );
  assert.deepEqual(JSON.parse(sent[1].body!), pvc);
  assert.equal(sent[1].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(sent[4].body!), { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'pod-uid-1' } });
  assert.deepEqual(JSON.parse(sent[5].body!), { apiVersion: 'v1', kind: 'DeleteOptions' });
  assert.ok(sent.every((r) => r.timeoutMs === PROFILE.lifecycle.requestTimeoutSeconds * 1000));
});

test('answers without a definite outcome are ambiguous or retryable; refusals are definite', async () => {
  const { kube } = client(
    new KubeAmbiguousError('POST timed out'),
    json(503, { kind: 'Status', reason: 'ServiceUnavailable' }),
    json(429, { kind: 'Status', reason: 'TooManyRequests' }),
    json(403, { kind: 'Status', reason: 'Forbidden', message: 'pods is forbidden' }),
    { status: 200, body: 'not json' },
  );
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'mr-x' }, spec: {} } as Pod;
  const timeout = await kube.pods.create(pod).catch((e: unknown) => e);
  assert.ok(timeout instanceof KubeAmbiguousError && isRetryableKubeError(timeout));
  const unavailable = await kube.pods.create(pod).catch((e: unknown) => e);
  assert.ok(unavailable instanceof KubeApiError && unavailable.status === 503 && isRetryableKubeError(unavailable));
  const throttled = await kube.pods.get('mr-x').catch((e: unknown) => e);
  assert.ok(throttled instanceof KubeApiError && isRetryableKubeError(throttled));
  const forbidden = await kube.pods.get('mr-x').catch((e: unknown) => e);
  assert.ok(forbidden instanceof KubeApiError && forbidden.status === 403 && !isRetryableKubeError(forbidden));
  assert.match((forbidden as Error).message, /pods is forbidden/);
  assert.ok((await kube.pods.get('mr-x').catch((e: unknown) => e)) instanceof KubeAmbiguousError);
});

test('names and namespaces are fixed: no path injection, no create outside the namespace', async () => {
  const { sent, kube } = client();
  await assert.rejects(kube.pods.get('../../secrets/x'), /not a Kubernetes object name/);
  await assert.rejects(kube.secrets.get('Mixed_Case'), /not a Kubernetes object name/);
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'mr-x', namespace: 'kube-system' }, spec: {} } as Pod;
  await assert.rejects(kube.pods.create(pod), /outside namespace orbit-managed-test/);
  assert.equal(sent.length, 0, 'refused before anything was sent');
});

test('a watch streams JSON lines, a line split across chunks included, and a refused watch rejects', async () => {
  const events = [
    { type: 'ADDED', object: { metadata: { name: 'mr-a', uid: '1' } } },
    { type: 'MODIFIED', object: { metadata: { name: 'mr-a', uid: '1' }, status: { phase: 'Running' } } },
    { type: 'DELETED', object: { metadata: { name: 'mr-a', uid: '1' } } },
  ].map((e) => JSON.stringify(e));
  // `|` separates chunks: the second event arrives in two pieces.
  const body = `${events[0]}\n${events[1].slice(0, 20)}|${events[1].slice(20)}\n${events[2]}\n`;
  const { sent, kube } = client({ status: 200, body }, json(403, { kind: 'Status', reason: 'Forbidden' }));
  const seen: Array<KubeWatchEvent<Pod>> = [];
  const watch = kube.pods.watch({ labelSelector: 'app.kubernetes.io/name=orbit-managed-runner', resourceVersion: '7' }, (e) => seen.push(e));
  await watch.done;
  assert.deepEqual(seen.map((e) => e.type), ['ADDED', 'MODIFIED', 'DELETED']);
  assert.equal(sent[0].url.searchParams.get('watch'), 'true');
  assert.equal(sent[0].url.searchParams.get('resourceVersion'), '7');
  assert.equal(sent[0].timeoutMs, 0, 'a watch has no request deadline');
  await assert.rejects(kube.pods.watch({}, () => undefined).done, (e: unknown) => e instanceof KubeApiError && e.status === 403);
});

test('the single-writer reads and the admission probe: receipts read-only, attachments listed, a create dry-run', async () => {
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'mr-probe', namespace: 'orbit-managed-test' }, spec: {} } as Pod;
  const { sent, kube } = client(
    json(200, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'mr-fence-x', uid: 'cm-1' }, data: { 'receipt.json': '{}' } }),
    json(404, { kind: 'Status', reason: 'NotFound' }),
    json(200, { items: [{ apiVersion: 'storage.k8s.io/v1', kind: 'VolumeAttachment', metadata: { name: 'csi-1' }, spec: { source: { persistentVolumeName: 'pv-1' }, nodeName: 'node-a' } }] }),
    json(400, { kind: 'Status', reason: 'BadRequest', message: 'admission webhook "pods.managed-runner.orbit.dev" denied the request: orbit-managed-runner-admission: NOT_THE_FIXED_NAME: no' }),
  );
  assert.equal((await kube.configMaps.get('mr-fence-x'))?.data?.['receipt.json'], '{}');
  assert.equal(await kube.configMaps.get('mr-fence-y'), null);
  assert.deepEqual(Object.keys(kube.configMaps), ['get'], 'a receipt can be read, never written');
  const attachments = await kube.listVolumeAttachments();
  assert.equal(attachments[0].spec.source.persistentVolumeName, 'pv-1');
  await assert.rejects(kube.pods.create(pod, { dryRun: true }), (e: KubeApiError) => e.status === 400 && /orbit-managed-runner-admission/.test(e.message));
  assert.deepEqual(sent.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`), [
    'GET /api/v1/namespaces/orbit-managed-test/configmaps/mr-fence-x',
    'GET /api/v1/namespaces/orbit-managed-test/configmaps/mr-fence-y',
    'GET /apis/storage.k8s.io/v1/volumeattachments',
    'POST /api/v1/namespaces/orbit-managed-test/pods?dryRun=All',
  ]);
});
