// Run against the task's disposable database and already-running branch apiserver:
// API_ORIGIN=http://127.0.0.1:<port> DATABASE_URL=<isolated URL> GEMINI_ENTRY_UPLOADS=<session uploads> node docs/evidence/gemini-antigravity-entry/seed.mjs
// These runner clients report test snapshots only. They never claim or execute a session.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const requireApi = createRequire(path.join(repo, 'src/apiserver/package.json'));
const { PrismaClient } = requireApi('@prisma/client');
const { PrismaPg } = requireApi('@prisma/adapter-pg');
const { base62ToUuid, uuidToBase62 } = requireApi(path.join(repo, 'src/shared/dist/index.js'));
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.equal(databaseUrl.hostname, '127.0.0.1', 'only the task database is allowed');
assert.equal(databaseUrl.port, '32927', 'only the task database port is allowed');
assert.equal(databaseUrl.pathname, '/gemini_entry', 'only the task database name is allowed');
assert.equal(databaseUrl.username, 'gemini_entry', 'only the isolated fixture user is allowed');
const origin = new URL(process.env.API_ORIGIN ?? '');
assert.equal(origin.protocol, 'http:');
assert.equal(origin.hostname, '127.0.0.1', 'only a local isolated apiserver is allowed');
assert.ok(origin.port, 'the isolated API port must be explicit');
assert.equal(origin.pathname, '/');
const uploads = process.env.GEMINI_ENTRY_UPLOADS;
assert.ok(uploads, 'GEMINI_ENTRY_UPLOADS must name this session upload directory');
const db = new PrismaClient({ adapter: new PrismaPg(databaseUrl.toString()) });
const checks = [];
let ownerToken;

async function request(method, route, body, options = {}) {
  const response = await fetch(new URL(`/api${route}`, origin), {
    method,
    headers: {
      'content-type': 'application/json',
      ...((options.token ?? ownerToken) ? { authorization: `Bearer ${options.token ?? ownerToken}` } : {}),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  const expected = options.expected ?? (method === 'POST' ? 201 : 200);
  assert.equal(response.status, expected, `${method} ${route}: unexpected HTTP status`);
  checks.push({ method, route, status: response.status, expected, succeeded: true });
  return result;
}

const toUuid = (id) => /^[0-9a-f]{8}-/.test(id) ? id : base62ToUuid(id);
const descriptions = {
  ready: { name: 'build-box', displayName: 'build-box', version: '0.1.209', supported: true, installed: true },
  upgrade: { name: 'HPC', displayName: 'HPC', version: '0.1.208', supported: false, installed: true },
  uninstalled: { name: 'workstation', displayName: 'workstation', version: '0.1.209', supported: true, installed: false },
};

async function heartbeat(runner) {
  return request('POST', '/runner/heartbeat', {
    status: 'ONLINE', idleCapacity: 16, version: runner.version,
    engines: [
      { engine: 'claude', installed: true, version: '2.1.0', auth: 'yes' },
      { engine: 'codex', installed: true, version: '0.154.0', auth: 'yes' },
      { engine: 'kimi', installed: true, version: '1.24.0', auth: 'yes' },
      { engine: 'antigravity', installed: runner.installed, auth: 'no', ...(runner.installed ? { version: '1.2.16' } : {}) },
    ],
  }, {
    token: runner.token, expected: 201,
    headers: { 'x-orbit-supported-providers': runner.supported ? 'claude,codex,opencode,antigravity' : 'claude,codex,opencode' },
  });
}

try {
  const email = 'gemini-entry@example.test';
  const users = await db.user.findMany({ select: { email: true } });
  assert.ok(users.length === 0 || (users.length === 1 && users[0].email === email), 'only a fresh database or this exact fixture can be seeded');
  const setup = await request('GET', '/auth/setup-status');
  assert.equal(setup.needsSetup, users.length === 0, 'the apiserver must share this isolated database');
  const auth = await request('POST', users.length === 0 ? '/auth/bootstrap' : '/auth/login', {
    email, ...(users.length === 0 ? { name: 'Gemini entry review' } : {}), password: 'isolated-gemini-entry-only',
  });
  ownerToken = auth.accessToken;
  const userId = toUuid(auth.user.id);
  assert.ok(await db.user.findUnique({ where: { id: userId } }), 'API and seed must share this exact database');

  const runners = {};
  for (const [state, description] of Object.entries(descriptions)) {
    const enrollment = await request('POST', '/runners/enrollment-tokens', { label: `Gemini entry fixture: ${state}` });
    const registered = await request('POST', '/runner/register', {
      enrollmentToken: enrollment.token, name: description.name, hostname: 'isolated-fixture',
      version: description.version, labels: ['isolated-gemini-entry-fixture', state], maxConcurrent: 16,
    });
    const uuid = toUuid(registered.runnerId);
    runners[state] = { ...description, id: uuidToBase62(uuid), uuid, token: registered.runnerToken };
    await db.runner.update({ where: { id: uuid }, data: { installStatus: null, installEngine: null } });
    await request('PATCH', `/runners/${runners[state].id}`, { displayName: description.displayName });
    await heartbeat(runners[state]);
  }

  const providers = await request('GET', '/providers/mine');
  const gemini = providers.find((provider) => provider.presetSlug === 'gemini' && provider.label === 'Gemini') ?? await request('POST', '/providers/mine', {
    label: 'Gemini', presetSlug: 'gemini', runtime: 'antigravity', followsPreset: true,
    baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'dummy-isolated-fixture-key-never-sent-to-google',
  });
  const workspaces = {};
  const existingWorkspaces = await request('GET', '/workspaces');
  for (const [state, runnerState] of [['default', 'ready'], ['upgrade', 'upgrade'], ['uninstalled', 'uninstalled'], ['envKey', 'ready']]) {
    const name = `Gemini · ${state === 'envKey' ? 'env key' : state}`;
    workspaces[state] = existingWorkspaces.find((workspace) => workspace.name === name) ?? await request('POST', '/workspaces', {
      name,
      description: 'Isolated Gemini entry acceptance fixture; no real runner or provider calls.',
      runnerId: runners[runnerState].id, workDir: `/tmp/gemini-entry-${state}`, enableWorktree: false,
      ...(state === 'envKey' ? { env: { GEMINI_API_KEY: 'dummy-workspace-env-key' } } : {}),
    });
  }

  const missingKey = 'Failed to authenticate: Antigravity runs on an API key (GEMINI_API_KEY), and neither this session nor the runner has one.';
  const upgradeError = 'Antigravity requires a newer Orbit runner; update this runner first';
  const missingBinary = 'Antigravity CLI ("agy") not found on this runner\'s PATH — run `orbit doctor` on the runner to install it and sign in.';
  const sessions = {};
  for (const [repair, state, runnerState, provider, status, error] of [
    ['needsKey', 'default', 'ready', 'antigravity', 'FAILED', missingKey],
    ['updateRunner', 'upgrade', 'upgrade', gemini.slug, 'PENDING', upgradeError],
    ['notInstalled', 'uninstalled', 'uninstalled', gemini.slug, 'FAILED', missingBinary],
  ]) {
    // Historical errors must remain visible even though new built-in sessions are now preflighted.
    const title = `Gemini repair · ${repair}`;
    const existing = await db.session.findFirst({ where: { ownerId: userId, title } });
    const session = existing
      ? await db.session.update({ where: { id: existing.id }, data: { provider, providerBuiltin: provider === 'antigravity', status, error, startedAt: status === 'FAILED' ? new Date() : null } })
      : await db.session.create({ data: {
      title, prompt: 'Continue this conversation on Gemini.',
      ownerId: userId, creatorId: userId, assignedRunnerId: runners[runnerState].uuid,
      workspaceId: toUuid(workspaces[state].id), provider, providerBuiltin: provider === 'antigravity',
      status, error, usesRuntimeDefaultModel: true, startsTaskWork: false,
      startedAt: status === 'FAILED' ? new Date() : null,
      runningBgShells: [], runningBgJobs: [], runningSubagents: [], lastTurnAt: new Date(),
    } });
    if (!existing && repair !== 'updateRunner') {
      await db.runEvent.create({ data: { sessionId: session.id, seq: 1, type: 'error', payload: { message: error } } });
    }
    sessions[repair] = uuidToBase62(session.id);
  }

  const refused = await request('POST', '/sessions', {
    prompt: 'Test missing-key preflight.', title: 'Missing key must be refused', workspaceId: workspaces.default.id,
    provider: 'antigravity', permissionMode: 'auto',
  }, { expected: 409 });
  assert.match(refused.message, /Antigravity needs a Gemini API key/);
  assert.match(refused.message, /Connect Gemini in Providers/);
  const byok = await request('POST', '/sessions', {
    prompt: 'Test Gemini BYOK admission only; no runner claims it.', title: 'Gemini BYOK preflight accepted',
    workspaceId: workspaces.default.id, provider: gemini.slug, permissionMode: 'auto',
  });
  assert.equal(byok.provider, gemini.slug);
  const envKey = await request('POST', '/sessions', {
    prompt: 'Test workspace env-key admission only; no runner claims it.', title: 'Env key preflight accepted',
    workspaceId: workspaces.envKey.id, provider: 'antigravity', permissionMode: 'auto',
  });
  assert.equal(envKey.provider, 'antigravity');

  const reported = await request('GET', '/runners');
  for (const [state, runner] of Object.entries(runners)) {
    const snapshot = reported.find((row) => row.id === runner.id);
    assert.equal(snapshot.online, true);
    assert.deepEqual(snapshot.antigravity, {
      supported: runner.supported, installed: runner.installed, version: runner.installed ? '1.2.16' : null, envKeyAvailable: false,
    });
  }
  for (const [state, workspace] of Object.entries(workspaces)) {
    const snapshot = await request('GET', `/workspaces/${workspace.id}`);
    assert.deepEqual(snapshot.antigravityKeyAvailableByRunner, Object.fromEntries(
      Object.values(runners).map((runner) => [runner.id, state === 'envKey']),
    ));
  }
  const legacy = await request('GET', `/sessions/${sessions.needsKey}`);
  assert.deepEqual(legacy.workspace.antigravityKeyAvailableByRunner, { [runners.ready.id]: false });

  mkdirSync(uploads, { recursive: true });
  writeFileSync(path.join(uploads, 'gemini-entry-fixture.json'), JSON.stringify({
    apiOrigin: origin.origin, accessToken: auth.accessToken, refreshToken: auth.refreshToken, userId: auth.user.id,
    provider: { id: gemini.id, slug: gemini.slug },
    runners: Object.fromEntries(Object.entries(runners).map(([state, runner]) => [state, {
      id: runner.id, token: runner.token, name: runner.displayName,
      fixture: 'Mock heartbeat client only; isolated-gemini-entry-fixture; never claims sessions',
    }])),
    workspaces: Object.fromEntries(Object.entries(workspaces).map(([state, workspace]) => [state, workspace.id])),
    sessions, preflight: { byokSessionId: byok.id, envKeySessionId: envKey.id },
  }, null, 2), { mode: 0o600 });
  writeFileSync(path.join(uploads, 'gemini-entry-api-checks.json'), JSON.stringify({
    succeeded: true, checks,
    assertions: ['built-in missing key refused with Connect Gemini', 'Gemini BYOK accepted', 'workspace env key accepted',
      'three runner readiness snapshots', 'four workspace public-id key maps', 'historical session effective runner key map'],
    gaps: ['Runner snapshots and historical failure events are synthetic fixtures.', 'No Gemini API call or real agy execution is performed.'],
  }, null, 2));
  console.log(`Seeded 3 isolated runner snapshots, 4 workspaces and 3 historical repair sessions; ${checks.length} HTTP checks passed.`);
  console.log(`Fixture written to ${path.join(uploads, 'gemini-entry-fixture.json')}; test tokens are not printed.`);
} finally {
  await db.$disconnect();
}
