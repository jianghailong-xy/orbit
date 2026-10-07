/**
 * The production apiserver — `build/main.js`, the whole AppModule — started with managed runners
 * off, over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, with no Kubernetes
 * or Ceph credential anywhere in its environment ("Default disabled", docs/managed-runner-design.md,
 * "Verification and implementation handoff"). Four boots of one database:
 *
 *   (A) ORBIT_MANAGED_RUNNERS_ENABLED absent: first-user bootstrap, login, refresh, the capability
 *       and status reads, the five managed writes (401 without a login, then 404
 *       MANAGED_RUNNER_DISABLED), and a self-managed runner enrolling and heartbeating as before;
 *   (B) explicitly `false`: the same, on the existing account and runner;
 *   (C) `on` — not a value the switch knows: off, with one warning in the log;
 *   (D) `true` without an environment profile, and with a decoy kubeconfig, ~/.kube/config and
 *       in-cluster service variables present: the feature is unavailable, login and the rest of the
 *       server are not, and none of those credentials is read.
 *
 * Every boot runs with a scrubbed environment — no ORBIT_* or provider variable, scratch HOME,
 * ORBIT_HOME, CODEX_HOME and CLAUDE_CONFIG_DIR — and a preloaded tripwire that records: any
 * construction of the Kubernetes client (its factory, its class, its HTTPS transport and watch); any
 * attempt to read a kubeconfig or in-cluster credential path; and any timer created by managed
 * runner code. The tripwire also proves it was armed on the real module. After every boot the
 * managed_runner table is empty and the tripwire log is.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-boot.pg.spec.ts
 *
 * Destructive only to its own disposable database: (A) bootstraps its first user.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from 'pg';

import { call, type Apiserver } from '../auth/pat-test-apiserver';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { assertTripwireQuiet, bootScrubbedApiserver } from '../test-support/managed-runner-apiserver';

const URL = process.env.COORDINATOR_PG_URL;
const WRITES = ['ensure', 'retry', 'wake', 'sleep', 'delete'];

test('managed runners off: the production server starts without Kubernetes or Ceph credentials and nothing managed happens', {
  skip: !URL, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-managed-boot-'));
  t.after(async () => {
    await sql.end().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  });

  const JWT_SECRET = randomBytes(32).toString('hex');
  const EMAIL = `managed-off-${randomUUID().slice(0, 8)}@example.invalid`;
  const PASSWORD = 'correct horse battery staple';
  let runnerToken = '';

  const count = async (table: string): Promise<number> =>
    Number((await sql.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n);

  /** One scrubbed boot, and the checks every boot ends with. */
  async function withServer(label: string, extra: NodeJS.ProcessEnv, body: (server: Apiserver) => Promise<void>): Promise<string> {
    const server = await bootScrubbedApiserver(scratch, label, { DATABASE_URL: url, JWT_SECRET, ...extra });
    try {
      await body(server);
    } finally {
      await server.stop();
    }
    assertTripwireQuiet(server, label);
    assert.equal(await count('managed_runner'), 0, `${label}: no managed mapping was written`);
    if (extra.ORBIT_MANAGED_RUNNERS_ENABLED !== 'true') {
      assert.doesNotMatch(server.output(), /managed runners are enabled/, `${label}: no managed runtime was built`);
    }
    return server.output();
  }

  /** What every boot with the feature off answers. */
  async function offAnswers(server: Apiserver, access: string, enabled = false) {
    assert.equal((await call(server, 'GET', '/api/auth/capabilities')).status, 401);
    const capabilities = await call(server, 'GET', '/api/auth/capabilities', access);
    assert.equal(capabilities.status, 200, capabilities.text);
    assert.deepEqual(capabilities.json, { managedRunners: { enabled, contractVersion: 1 } });
    const status = await call(server, 'GET', '/api/managed-runner', access);
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json.enabled, enabled);
    assert.equal(status.json.managementState, 'NOT_PROVISIONED');
    assert.equal(status.json.actions.canEnsure, false);
    for (const action of WRITES) {
      const anonymous = await call(server, 'POST', `/api/managed-runner/${action}`, undefined, { idempotencyKey: 'k', revision: 1 });
      assert.equal(anonymous.status, 401, `${action} without a login`);
      const refused = await call(server, 'POST', `/api/managed-runner/${action}`, access, { idempotencyKey: 'k', revision: 1 });
      if (enabled) {
        assert.equal(refused.status, 503, `${action}: ${refused.text}`);
        assert.equal(refused.json.code, 'MANAGED_RUNNER_UNAVAILABLE');
      } else {
        assert.equal(refused.status, 404, `${action}: ${refused.text}`);
        assert.equal(refused.json.code, 'MANAGED_RUNNER_DISABLED');
      }
    }
  }

  async function login(server: Apiserver): Promise<{ accessToken: string; refreshToken: string }> {
    const reply = await call(server, 'POST', '/api/auth/login', undefined, { email: EMAIL, password: PASSWORD });
    assert.equal(reply.status, 201, reply.text);
    const refreshed = await call(server, 'POST', '/api/auth/refresh', undefined, { refreshToken: reply.json.refreshToken });
    assert.equal(refreshed.status, 201, refreshed.text);
    return refreshed.json;
  }

  async function heartbeat(server: Apiserver) {
    const beat = await call(server, 'POST', '/api/runner/heartbeat', runnerToken, {});
    assert.ok(beat.status === 200 || beat.status === 201, `the self-managed runner heartbeats as before: ${beat.text}`);
  }

  await t.test('(A) absent: bootstrap, login and refresh, the reads, the refused writes, and a self-managed runner', async () => {
    assert.equal(await count('user'), 0);
    await withServer('absent', {}, async (server) => {
      const setup = await call(server, 'GET', '/api/auth/setup-status');
      assert.deepEqual(setup.json, { needsSetup: true });
      const boot = await call(server, 'POST', '/api/auth/bootstrap', undefined, { email: EMAIL, name: 'Managed Off', password: PASSWORD });
      assert.equal(boot.status, 201, boot.text);
      const { accessToken } = await login(server);
      await offAnswers(server, accessToken);

      // A self-managed runner enrolls and heartbeats exactly as before.
      const enrollment = await call(server, 'POST', '/api/runners/enrollment-tokens', accessToken, { label: 'self-managed' });
      assert.equal(enrollment.status, 201, enrollment.text);
      const registered = await call(server, 'POST', '/api/runner/register', undefined, { enrollmentToken: enrollment.json.token, name: 'laptop', maxConcurrent: 2 });
      assert.equal(registered.status, 201, registered.text);
      runnerToken = registered.json.runnerToken;
      await heartbeat(server);
      const runners = await call(server, 'GET', '/api/runners', accessToken);
      assert.equal(runners.status, 200, runners.text);
      assert.deepEqual(runners.json.map((r: { name: string }) => r.name), ['laptop']);
    });
    assert.equal(await count('runner'), 1, 'only the self-managed runner exists');
    assert.equal(await count('workspace'), 0, 'no default workspace was made');
  });

  await t.test('(B) explicitly false: the same answers on the existing account and runner, and a configured profile is never read', async () => {
    // A complete profile and its kubeconfig, as an enabled test deployment would have them: with the
    // switch off, neither file may even be opened.
    const decoys = path.join(scratch, 'decoys-false');
    mkdirSync(decoys, { recursive: true });
    writeFileSync(path.join(decoys, 'kubeconfig.json'), '{}');
    writeFileSync(path.join(decoys, 'profile.json'), JSON.stringify({ schemaVersion: 1, valueKind: 'actual', kubernetes: { kubeconfig: path.join(decoys, 'kubeconfig.json') } }));
    await withServer('false', {
      ORBIT_MANAGED_RUNNERS_ENABLED: 'false',
      ORBIT_MANAGED_RUNNERS_PROFILE: path.join(decoys, 'profile.json'),
      MANAGED_RUNNER_TRIPWIRE_DECOYS: decoys,
    }, async (server) => {
      const { accessToken } = await login(server);
      await offAnswers(server, accessToken);
      await heartbeat(server);
    });
    assert.equal(await count('runner'), 1);
    assert.equal(await count('workspace'), 0);
  });

  await t.test('(C) an unreadable value is off, and said once in the log', async () => {
    const log = await withServer('invalid', { ORBIT_MANAGED_RUNNERS_ENABLED: 'on' }, async (server) => {
      const { accessToken } = await login(server);
      await offAnswers(server, accessToken);
    });
    assert.equal(log.split('ORBIT_MANAGED_RUNNERS_ENABLED="on" is neither true nor false: managed runners are disabled').length - 1, 1, log.slice(-3_000));
  });

  await t.test('(D) on without a profile: unavailable, login unaffected, and no kubeconfig or in-cluster credential is read', async () => {
    const decoys = path.join(scratch, 'decoys');
    mkdirSync(path.join(decoys, 'home', '.kube'), { recursive: true });
    const decoyConfig = JSON.stringify({ apiVersion: 'v1', kind: 'Config', 'current-context': 'decoy', contexts: [{ name: 'decoy', context: { cluster: 'decoy', user: 'decoy' } }], clusters: [{ name: 'decoy', cluster: { server: 'https://decoy.invalid:6443' } }], users: [{ name: 'decoy', user: { token: 'decoy' } }] });
    writeFileSync(path.join(decoys, 'kubeconfig'), decoyConfig);
    writeFileSync(path.join(decoys, 'home', '.kube', 'config'), decoyConfig);
    const log = await withServer('enabled-unconfigured', {
      ORBIT_MANAGED_RUNNERS_ENABLED: 'true',
      // A home whose ~/.kube/config exists, and a KUBECONFIG that names a file that exists.
      HOME: path.join(decoys, 'home'),
      KUBECONFIG: path.join(decoys, 'kubeconfig'),
      KUBERNETES_SERVICE_HOST: '192.0.2.1',
      KUBERNETES_SERVICE_PORT: '443',
    }, async (server) => {
      const { accessToken } = await login(server);
      await offAnswers(server, accessToken, true);
      const status = await call(server, 'GET', '/api/managed-runner', accessToken);
      assert.equal(status.json.reason.code, 'MANAGED_RUNNER_UNAVAILABLE');
      await heartbeat(server);
    });
    assert.match(log, /managed runners are enabled but unavailable: ORBIT_MANAGED_RUNNERS_PROFILE names no profile file/);
    assert.equal(await count('runner'), 1);
    assert.equal(await count('workspace'), 0);
  });
});
