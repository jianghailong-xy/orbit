/**
 * Provisioning at sign-in (docs/managed-runner-design.md, "Provisioning retry wake and sleep" 1–3,
 * and "Default disabled gate"), over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty. No cluster, kubeconfig, model or provider credential is involved anywhere.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-sign-in.pg.spec.ts
 *
 * (A) Off — ORBIT_MANAGED_RUNNERS_ENABLED absent, then explicitly `false` — the production server
 *     (`build/main.js`, the whole AppModule) with a scrubbed environment and the preloaded tripwire
 *     of test-support/managed-runner-apiserver.ts: a new account (the first-user bootstrap, and an
 *     account an administrator opened, signing in for the first time) and an existing account with
 *     its runner, workspaces and session sign in and answer as before. No managed_runner, runner or
 *     workspace row is written, the existing rows are byte-for-byte what they were, and no
 *     Kubernetes client is constructed (so no PVC either), no kubeconfig read, no managed timer.
 *
 * (B) On — the whole AppModule in this process, its environment scrubbed (PATH, the database, the
 *     JWT secret and scratch HOME, ORBIT_HOME, CODEX_HOME and CLAUDE_CONFIG_DIR — nothing else), a
 *     valid profile, and in place of the Kubernetes client the in-memory namespace of
 *     test-support/fake-kube-client.ts (the real client and its HTTPS transport are trapped). The
 *     test plays the runner: it reads the credential the manager put in the bootstrap Secret and
 *     heartbeats and claims with it.
 *       (1) bootstrap and login are the sign-ins; creating an account, refresh, logout, a password
 *           change and the capability and status reads are not;
 *       (2) end to end: a new account signs in — with every Kubernetes call held, so the answer
 *           cannot have waited for one — then provisioning, the runner's heartbeat reporting Codex
 *           installed and signed in and Claude not installed, READY with Codex as the initial
 *           provider, the default workspace bound to that runner, a first session on Codex with no
 *           provider named, and the runner claiming it;
 *       (3) concurrent and repeated sign-ins make one mapping, runner, workspace, PVC, Secret and
 *           Pod; a default the owner removed stays removed;
 *       (4) an account with workspaces keeps its order, its first workspace, its deep links and its
 *           self-managed default; a runner named like the managed one and a workspace named and
 *           placed like the default are never taken for them;
 *       (5) a sign-in whose intent cannot be written still signs in, and an explicit ensure then
 *           provisions; provisioning that fails leaves sign-in alone, is not retried by the next
 *           sign-in, and an explicit retry makes it READY on the same mapping and volume;
 *       (6) a runner with nothing installed and signed in is not READY: MODEL_UNAVAILABLE, and a
 *           first session on any engine is refused with it, the Claude floor included; a runtime
 *           signed in afterwards makes it READY on its own;
 *       (7) the server's eligibility decision governs both sign-in and explicit ensure.
 *
 * (C) The manager, on the test's clock: MODEL_UNAVAILABLE until the startup deadline, then FAILED
 *     and retryable; a retry once a runtime is signed in is READY with that runtime.
 *
 * Destructive only to its own disposable database: (A) and (B) truncate its accounts to run the
 * first-user bootstrap.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Global, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  MANAGED_RUNNER_GENERATION_HEADER,
  MANAGED_RUNNER_INSTANCE_CAPABILITY,
  MANAGED_RUNNER_POD_UID_HEADER,
  toUuid,
} from '@orbit/shared';
import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { json, urlencoded } from 'express';
import { Client } from 'pg';

import { call, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { generateToken, hashPassword, sha256 } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { outsideThePoolGateway } from '../providers/pool-gateway.controller';
import { FakeKubeCluster } from '../test-support/fake-kube-client';
import { installManagedRunnerAdmission } from '../test-support/managed-runner-admission.fixture';
import { assertTripwireQuiet, bootScrubbedApiserver } from '../test-support/managed-runner-apiserver';
import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import type { ManagedKubeClient, Pod, Secret } from './kube-client';
import { EVERY_ACCOUNT } from './managed-runner-eligibility';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import {
  GENERATION_ANNOTATION,
  MANAGED_RUNNER_NAME,
  MANAGED_WORKSPACE_DIR,
  bootstrapCredentialOf,
  managedPodName,
  managedPvcName,
  managedSecretName,
} from './managed-runner-resources';
import { MANAGED_RUNNER_KUBE_CLIENT_FACTORY, MANAGED_RUNNER_RUNTIME, type ManagedRunnerRuntime } from './managed-runner-runtime';
import { ManagedRunnerWorker } from './managed-runner-worker';
import { ManagedRunnerService } from './managed-runner.service';

declare global {
  interface BigInt { toJSON(): string; }
}
// main.ts installs this before it creates the app; session rows carry BIGINT columns.
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const PG_URL = process.env.COORDINATOR_PG_URL;
const PASSWORD = 'correct horse battery staple';
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };

/** What every sign-in answers, with ids in the public codec (`publicId` is the twin main.ts adds). */
const SIGN_IN_KEYS = ['accessToken', 'refreshToken', 'user'];
const SIGNED_IN_USER_KEYS = ['email', 'id', 'name', 'publicId'];

function assertSignedIn(reply: Reply, label: string): void {
  assert.equal(reply.status, 201, `${label}: ${reply.text}`);
  assert.deepEqual(Object.keys(reply.json).sort(), SIGN_IN_KEYS, label);
  assert.deepEqual(Object.keys(reply.json.user).sort(), SIGNED_IN_USER_KEYS, label);
  assert.ok(reply.json.accessToken && reply.json.refreshToken, label);
}

const engine = (name: string, change: Record<string, unknown> = {}) => ({ engine: name, installed: true, auth: 'yes', ...change });

test('managed runners at sign-in: off changes nothing; on, sign-in records intent and the first session runs on a supplied runtime', {
  skip: !PG_URL, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-managed-sign-in-'));
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  });

  const JWT_SECRET = randomBytes(32).toString('hex');
  const jwt = new JwtService({ secret: JWT_SECRET });
  const RUN = randomUUID().slice(0, 8);
  let accounts = 0;

  /** An account as an earlier sign-up left it: a row with a password, never signed in here. */
  const account = async (label: string): Promise<{ id: string; email: string }> => {
    const email = `${label}-${RUN}-${(accounts += 1)}@example.invalid`;
    const row = await db.user.create({ data: { email, name: label, passwordHash: hashPassword(PASSWORD) } });
    return { id: row.id, email };
  };
  /** A bearer for `userId` without signing in: what a client holding an earlier session has. */
  const bearer = (userId: string) => jwt.signAsync({ sub: userId, email: `${userId}@example.invalid` });
  const count = async (table: string, ownerId?: string): Promise<number> =>
    Number((await sql.query(`SELECT count(*)::int AS n FROM "${table}"${ownerId ? ' WHERE owner_id = $1' : ''}`, ownerId ? [ownerId] : [])).rows[0].n);
  const countsOf = async (ownerId: string) => ({
    mappings: await count('managed_runner', ownerId),
    runners: await count('runner', ownerId),
    workspaces: await count('workspace', ownerId),
  });
  const rows = async (query: string, values: unknown[] = []) =>
    (await sql.query(query, values)).rows.map((r) => JSON.stringify(r));

  /** An account with a self-managed runner, three workspaces in a chosen order and a session. */
  async function veteran(label: string) {
    const user = await account(label);
    // A self-managed machine that happens to carry the managed runner's name, and a workspace named
    // and placed like the managed default: neither may be taken for them.
    const runnerId = (await sql.query(
      `INSERT INTO runner (id, name, owner_id, token_hash, status, max_concurrent)
         VALUES (gen_random_uuid(), $1, $2, $3, 'OFFLINE', 1) RETURNING id`,
      [MANAGED_RUNNER_NAME, user.id, sha256(generateToken(32))],
    )).rows[0].id as string;
    const workspace = async (name: string, position: number | null, workDir: string) =>
      (await sql.query(
        `INSERT INTO workspace (id, name, owner_id, runner_id, target_runner_id, work_dir, position, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $3, $4, $5, now() - interval '1 day') RETURNING id`,
        [name, user.id, runnerId, workDir, position],
      )).rows[0].id as string;
    const api = await workspace('api', 0, '/srv/api');
    const web = await workspace('web', 1, '/srv/web');
    const decoy = await workspace('Default', null, MANAGED_WORKSPACE_DIR);
    return { ...user, runnerId, api, web, decoy };
  }

  // ── (A) off: the production server ─────────────────────────────────────────────────────────
  await t.test('(A) off — absent, then explicitly false: bootstrap and sign-ins answer as before, and nothing managed is written', async () => {
    for (const [label, extra] of [['absent', {}], ['false', { ORBIT_MANAGED_RUNNERS_ENABLED: 'false' }]] as const) {
      // The first-user bootstrap needs a deployment with no account.
      await sql.query('TRUNCATE "user" CASCADE');
      const server = await bootScrubbedApiserver(scratch, `off-${label}`, { DATABASE_URL: url, JWT_SECRET, ...extra });
      try {
        // A new account: the deployment's first user.
        const first = await call(server, 'POST', '/api/auth/bootstrap', undefined, { email: `first-${label}-${RUN}@example.invalid`, name: 'First', password: PASSWORD });
        assertSignedIn(first, `${label}: bootstrap`);
        // A new account an administrator opened, signing in for the first time.
        const opened = await call(server, 'POST', '/api/admin/users', first.json.accessToken, { email: `new-${label}-${RUN}@example.invalid`, name: 'New', password: PASSWORD });
        assert.equal(opened.status, 201, opened.text);
        assertSignedIn(await call(server, 'POST', '/api/auth/login', undefined, { email: `new-${label}-${RUN}@example.invalid`, password: PASSWORD }), `${label}: a new account's first sign-in`);

        // An existing account with a runner, workspaces and a session.
        const old = await veteran(`veteran-${label}`);
        const token = await bearer(old.id);
        const session = await call(server, 'POST', '/api/sessions', token, { workspaceId: old.api, prompt: 'hello', title: 'existing work' });
        assert.equal(session.status, 201, session.text);
        const listBefore = await call(server, 'GET', '/api/workspaces', token);
        const before = {
          runners: await rows('SELECT row_to_json(r) AS row FROM runner r ORDER BY id'),
          workspaces: await rows('SELECT row_to_json(w) AS row FROM workspace w ORDER BY id'),
          sessions: await rows('SELECT id, workspace_id, assigned_runner_id, provider, status FROM session ORDER BY id'),
        };
        const signedIn = await call(server, 'POST', '/api/auth/login', undefined, { email: old.email, password: PASSWORD });
        assertSignedIn(signedIn, `${label}: an existing account`);
        assert.equal(toUuid(signedIn.json.user.id), old.id);
        assert.equal((await call(server, 'POST', '/api/auth/refresh', undefined, { refreshToken: signedIn.json.refreshToken })).status, 201);
        assert.deepEqual((await call(server, 'GET', '/api/workspaces', signedIn.json.accessToken)).json, listBefore.json, `${label}: the same workspaces, in the same order`);
        assert.deepEqual(await rows('SELECT row_to_json(r) AS row FROM runner r ORDER BY id'), before.runners, `${label}: no runner written or changed`);
        assert.deepEqual(await rows('SELECT row_to_json(w) AS row FROM workspace w ORDER BY id'), before.workspaces, `${label}: no workspace written or changed`);
        assert.deepEqual(await rows('SELECT id, workspace_id, assigned_runner_id, provider, status FROM session ORDER BY id'), before.sessions);

        const capabilities = await call(server, 'GET', '/api/auth/capabilities', signedIn.json.accessToken);
        assert.deepEqual(capabilities.json, { managedRunners: { enabled: false, contractVersion: 1 } });
      } finally {
        await server.stop();
      }
      assertTripwireQuiet(server, label);
      assert.equal(await count('managed_runner'), 0, `${label}: no managed intent`);
      assert.equal(await count('runner'), 1, `${label}: only the existing account's own runner`);
      assert.equal(await count('workspace'), 3, `${label}: only the existing account's own workspaces`);
      assert.doesNotMatch(server.output(), /managed runners are enabled/);
    }
  });

  // ── (B) on: the whole AppModule in this process, against a fake cluster ─────────────────────
  const profile = testManagedRunnerProfile({ lifecycle: { pollIntervalSeconds: 1, backoffBaseSeconds: 1, backoffMaxSeconds: 2 } });
  // With the environment's single-Pod admission guard installed, as the manager requires.
  const cluster = installManagedRunnerAdmission(new FakeKubeCluster(profile.kubernetes.namespace), db as unknown as PrismaService, profile);
  /** Every Kubernetes call waits on this while it is held: open unless a case holds it. */
  let held: Promise<void> = Promise.resolve();
  let attempted = 0;
  /** The fake namespace's client, every call counted and made to wait while calls are held. */
  const heldClient = (): ManagedKubeClient => {
    const inner = cluster.client();
    const wrap = <F extends (...args: any[]) => any>(fn: F): F =>
      (async (...args: unknown[]) => {
        attempted += 1;
        await held;
        return fn(...args);
      }) as F;
    const resource = <R extends object>(r: R): R =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'function' && k !== 'watch' ? wrap(v) : v])) as R;
    return {
      namespace: inner.namespace,
      persistentVolumeClaims: resource(inner.persistentVolumeClaims),
      secrets: resource(inner.secrets),
      pods: resource(inner.pods),
      configMaps: resource(inner.configMaps),
      getPersistentVolume: wrap(inner.getPersistentVolume),
      listVolumeAttachments: wrap(inner.listVolumeAttachments),
    };
  };
  const realClient: string[] = [];

  const dir = path.join(scratch, 'on');
  const home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const profilePath = path.join(dir, 'profile.json');
  writeFileSync(profilePath, JSON.stringify(profile));
  const savedEnv = process.env;
  let app: INestApplication | undefined;
  let server!: Apiserver;
  t.after(async () => {
    await app?.close().catch(() => undefined);
    process.env = savedEnv;
  });

  await t.test('(B) boot: enabled with a valid profile, over the fake cluster, in a scrubbed environment', async () => {
    await sql.query('TRUNCATE "user" CASCADE');
    process.env = {
      PATH: savedEnv.PATH,
      NO_COLOR: '1',
      TMPDIR: dir,
      HOME: home,
      ORBIT_HOME: path.join(home, '.orbit'),
      CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      DATABASE_URL: url,
      JWT_SECRET,
      ORBIT_MANAGED_RUNNERS_ENABLED: 'true',
      ORBIT_MANAGED_RUNNERS_PROFILE: profilePath,
    };
    // The real client may not be built, nor its transport used: only the fake namespace exists here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const kubeHttp = require('./kube-http-client') as { kubeClientFromProfile: unknown; httpsTransport: { request: unknown; stream: unknown } };
    kubeHttp.kubeClientFromProfile = () => {
      realClient.push('kubeClientFromProfile');
      throw new Error('tripwire: the real Kubernetes client was constructed');
    };
    kubeHttp.httpsTransport.request = () => {
      realClient.push('request');
      throw new Error('tripwire: a real Kubernetes request');
    };
    kubeHttp.httpsTransport.stream = () => {
      realClient.push('watch');
      throw new Error('tripwire: a real Kubernetes watch');
    };
    const { AppModule } = await import('../app.module.js');

    @Global()
    @Module({
      providers: [
        { provide: MANAGED_RUNNER_KUBE_CLIENT_FACTORY, useValue: () => heldClient() },
      ],
      exports: [MANAGED_RUNNER_KUBE_CLIENT_FACTORY],
    })
    class FakeEnvironment {}
    @Module({ imports: [FakeEnvironment, AppModule] })
    class Harness {}

    // main.ts, step for step.
    app = await NestFactory.create(Harness, { bodyParser: false, logger: ['error'], abortOnError: false });
    app.use(outsideThePoolGateway(json({ limit: '10mb' })));
    app.use(outsideThePoolGateway(urlencoded({ extended: true, limit: '10mb' })));
    app.use(publicIdHeaders);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
    app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
    const adapter = app.get(HttpAdapterHost).httpAdapter;
    app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
    await app.listen(0, '127.0.0.1');
    server = { port: Number(new globalThis.URL((await app.getUrl()).replace('[::1]', '127.0.0.1')).port) } as Apiserver;
    const runtime = app.get<ManagedRunnerRuntime | null>(MANAGED_RUNNER_RUNTIME);
    assert.equal(runtime?.available, true, 'the managed runtime is up');
  });
  if (!app) return;

  const mappingOf = async (ownerId: string): Promise<ManagedRunner | null> => db.managedRunner.findUnique({ where: { ownerId } });
  async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }
  const login = async (email: string) => call(server, 'POST', '/api/auth/login', undefined, { email, password: PASSWORD });
  const statusOf = async (token: string) => (await call(server, 'GET', '/api/managed-runner', token)).json;
  /** The credential the manager handed the runner in its bootstrap Secret. */
  const runnerCredential = (runnerId: string) => bootstrapCredentialOf(cluster.object<Secret>('secrets', managedSecretName(runnerId))!)!;
  /** What a managed runner sends with every request: the instance its Pod is (managed-runner-instance.ts). */
  const instanceHeaders = (runnerId: string): Record<string, string> => {
    const pod = cluster.object<Pod>('pods', managedPodName(runnerId))!;
    return {
      'x-orbit-runner-capabilities': MANAGED_RUNNER_INSTANCE_CAPABILITY,
      [MANAGED_RUNNER_GENERATION_HEADER]: pod.metadata.annotations![GENERATION_ANNOTATION],
      [MANAGED_RUNNER_POD_UID_HEADER]: pod.metadata.uid!,
    };
  };
  /** The runner's heartbeat, with the engine health a real one reports. */
  const heartbeat = async (runnerId: string, engines: unknown[]) => {
    const beat = await call(server, 'POST', '/api/runner/heartbeat', runnerCredential(runnerId), { engines, version: '0.1.0' }, instanceHeaders(runnerId));
    assert.ok(beat.status === 200 || beat.status === 201, `heartbeat: ${beat.text}`);
  };
  /** Provisioned up to its one Pod, then heartbeating with `engines`, until `state`. */
  async function bringUp(ownerId: string, engines: unknown[], state: 'READY' | 'STARTING' = 'READY'): Promise<ManagedRunner> {
    const starting = await until('the Pod to be recorded', async () => {
      const m = await mappingOf(ownerId);
      return m?.podUid && m.managementState === 'STARTING' ? m : null;
    });
    await heartbeat(starting.runnerId, engines);
    return until(`managementState ${state}`, async () => {
      const m = await mappingOf(ownerId);
      if (m?.managementState === state && (state === 'READY' || m.lastError)) return m;
      return null;
    });
  }
  const created = (kind: 'persistentvolumeclaims' | 'secrets' | 'pods', name: string) =>
    cluster.calls.filter((c) => c.op === 'create' && c.kind === kind && c.name === name).length;

  await t.test('(B1) bootstrap and login are the sign-ins; opening an account, refresh, logout, a password change and the reads are not', async () => {
    const first = await call(server, 'POST', '/api/auth/bootstrap', undefined, { email: `admin-${RUN}@example.invalid`, name: 'Admin', password: PASSWORD });
    assertSignedIn(first, 'bootstrap');
    const adminId = toUuid(first.json.user.id);
    const adminMapping = await until('the first user’s intent', () => mappingOf(adminId));
    assert.equal(adminMapping.desiredState, 'RUNNING');
    assert.deepEqual(await countsOf(adminId), { mappings: 1, runners: 1, workspaces: 1 });

    // An administrator opening an account signs nobody in.
    const opened = await call(server, 'POST', '/api/admin/users', first.json.accessToken, { email: `opened-${RUN}@example.invalid`, name: 'Opened', password: PASSWORD });
    assert.equal(opened.status, 201, opened.text);
    const openedId = (await db.user.findUniqueOrThrow({ where: { email: `opened-${RUN}@example.invalid` } })).id;
    assert.deepEqual(await countsOf(openedId), { mappings: 0, runners: 0, workspaces: 0 });

    // A client holding an earlier session: its reads, refresh, password change and logout.
    const quietUser = await account('quiet');
    const token = await bearer(quietUser.id);
    const refreshToken = generateToken(32);
    await db.refreshToken.create({ data: { userId: quietUser.id, tokenHash: sha256(refreshToken), expiresAt: new Date(Date.now() + 86_400_000) } });
    assert.deepEqual((await call(server, 'GET', '/api/auth/capabilities', token)).json, { managedRunners: { enabled: true, contractVersion: 1 } });
    const status = await statusOf(token);
    assert.equal(status.managementState, 'NOT_PROVISIONED');
    assert.equal(status.actions.canEnsure, true);
    const rotated = await call(server, 'POST', '/api/auth/refresh', undefined, { refreshToken });
    assert.equal(rotated.status, 201, rotated.text);
    const changed = await call(server, 'POST', '/api/auth/change-password', token, { currentPassword: PASSWORD, newPassword: `${PASSWORD} again` });
    assert.equal(changed.status, 201, changed.text);
    assert.equal((await call(server, 'POST', '/api/auth/logout', undefined, { refreshToken: rotated.json.refreshToken })).status, 201);
    assert.deepEqual(await countsOf(quietUser.id), { mappings: 0, runners: 0, workspaces: 0 }, 'none of them recorded intent');

    // The sign-in itself does.
    assertSignedIn(await call(server, 'POST', '/api/auth/login', undefined, { email: quietUser.email, password: `${PASSWORD} again` }), 'login');
    assert.deepEqual(await countsOf(quietUser.id), { mappings: 1, runners: 1, workspaces: 1 });
  });

  await t.test('(B2) end to end: sign-in → intent → provisioning → READY on the supplied runtime → the default workspace → a first session the runner claims', async () => {
    const user = await account('newcomer');
    // Every Kubernetes call waits until released, from before this account's mapping exists: a
    // sign-in that waited for one, or for the instance, would never answer.
    let release!: () => void;
    held = new Promise<void>((resolve) => (release = resolve));
    const attemptedBefore = attempted;
    let signedIn: Reply;
    let requested: any;
    let mapping: ManagedRunner;
    try {
      signedIn = await login(user.email);
      assertSignedIn(signedIn, 'a new account');
      requested = await statusOf(signedIn.json.accessToken);
      mapping = (await mappingOf(user.id))!;
      assert.deepEqual(
        cluster.calls.filter((c) => c.name === mapping.pvcName || c.name === managedPodName(mapping.runnerId) || c.name === managedSecretName(mapping.runnerId)),
        [],
        'no Kubernetes call about this account had returned when its sign-in answered',
      );
      // Meanwhile the manager, woken by it, is the one waiting on Kubernetes.
      await until('the manager to be held in a Kubernetes call', async () => attempted > attemptedBefore);
    } finally {
      release();
      held = Promise.resolve();
    }
    const token = signedIn.json.accessToken as string;
    assert.ok(['REQUESTED', 'PROVISIONING'].includes(requested.managementState), `recorded intent, nothing more: ${requested.managementState}`);
    assert.equal(requested.desiredState, 'RUNNING');
    assert.equal(requested.usable, false);

    // The runner reports Codex installed and signed in, and Claude not installed at all.
    const ready = await bringUp(user.id, [engine('claude', { installed: false, auth: 'unknown' }), engine('codex')]);
    assert.equal(ready.initialProvider, 'codex', 'the runtime it is ready with, not the Claude floor');
    assert.equal(ready.id, mapping.id);
    const status = await statusOf(token);
    assert.equal(status.managementState, 'READY');
    assert.equal(status.usable, true);
    assert.equal(status.initialProvider, 'codex');
    assert.equal(toUuid(status.runnerId), mapping.runnerId);
    assert.equal(toUuid(status.workspaceId), mapping.defaultWorkspaceId);
    assert.equal(created('persistentvolumeclaims', managedPvcName(mapping.runnerId)), 1);
    assert.equal(created('pods', managedPodName(mapping.runnerId)), 1);

    // The default workspace: bound to the managed runner, and defaulting to the supplied runtime.
    const workspaces = (await call(server, 'GET', '/api/workspaces', token)).json;
    assert.equal(workspaces.length, 1);
    const [workspace] = workspaces;
    assert.equal(toUuid(workspace.id), mapping.defaultWorkspaceId);
    assert.equal(toUuid(workspace.runnerId), mapping.runnerId);
    assert.equal(toUuid(workspace.targetRunnerId), mapping.runnerId);
    assert.equal(workspace.workDir, MANAGED_WORKSPACE_DIR);
    assert.equal(workspace.lastProvider, 'codex');
    assert.equal(workspace.provider, 'codex', 'the derived alias agrees; nothing is stored on the workspace');
    assert.equal(workspace.autoInitGit, true);
    assert.equal(workspace.enableWorktree, true);

    // The first session, with no provider named, starts on Codex, and the managed runner claims it.
    const session = await call(server, 'POST', '/api/sessions', token, { workspaceId: workspace.id, prompt: 'hello', title: 'first session' });
    assert.equal(session.status, 201, session.text);
    assert.equal(session.json.provider, 'codex');
    const claim = await call(server, 'GET', '/api/runner/sessions/claim', runnerCredential(mapping.runnerId), undefined, instanceHeaders(mapping.runnerId));
    assert.equal(claim.status, 200, claim.text);
    assert.equal(toUuid(claim.json.sessionId), toUuid(session.json.id), 'the managed runner claimed the first session');
    assert.equal(claim.json.provider, 'codex');
    assert.equal(claim.json.workDir, MANAGED_WORKSPACE_DIR);
  });

  await t.test('(B3) concurrent and repeated sign-ins add nothing; a default the owner removed stays removed', async () => {
    const user = await account('eager');
    const replies = await Promise.all(Array.from({ length: 8 }, () => login(user.email)));
    for (const reply of replies) assertSignedIn(reply, 'a concurrent sign-in');
    assert.deepEqual(await countsOf(user.id), { mappings: 1, runners: 1, workspaces: 1 });
    const ready = await bringUp(user.id, [engine('claude')]);
    assert.equal(ready.initialProvider, 'claude', 'Orbit’s own default, when the runner has it ready');
    for (let i = 0; i < 3; i += 1) assertSignedIn(await login(user.email), 'a repeated sign-in');
    await sleep(1_500); // a manager pass, should a sign-in have woken one
    assert.deepEqual(await countsOf(user.id), { mappings: 1, runners: 1, workspaces: 1 });
    const after = (await mappingOf(user.id))!;
    assert.equal(after.revision, ready.revision, 'a sign-in leaves an existing mapping as it is');
    assert.equal(created('persistentvolumeclaims', ready.pvcName), 1);
    assert.equal(created('secrets', managedSecretName(ready.runnerId)), 1);
    assert.equal(created('pods', managedPodName(ready.runnerId)), 1);

    // The owner removes the default workspace; signing in again does not bring it, or another, back.
    const token = (await login(user.email)).json.accessToken as string;
    assert.equal((await call(server, 'DELETE', `/api/workspaces/${ready.defaultWorkspaceId}`, token)).status, 200);
    assertSignedIn(await login(user.email), 'a sign-in after the removal');
    assert.deepEqual((await call(server, 'GET', '/api/workspaces', token)).json, []);
    assert.deepEqual(await countsOf(user.id), { mappings: 1, runners: 1, workspaces: 1 });
    assert.notEqual((await db.workspace.findUniqueOrThrow({ where: { id: ready.defaultWorkspaceId } })).deletedAt, null);
  });

  await t.test('(B4) an account with workspaces keeps its order, first workspace, deep links and own default; nothing is matched by name', async () => {
    const old = await veteran('veteran');
    const token = await bearer(old.id);
    const session = await call(server, 'POST', '/api/sessions', token, { workspaceId: old.api, prompt: 'existing work', title: 'existing' });
    assert.equal(session.status, 201, session.text);
    assert.equal(session.json.provider, 'claude', 'a self-managed workspace starts on the floor, as before');
    // What a workspace payload lists for every runner of the owner: the new runner adds an entry,
    // which is not a change to the workspace itself.
    const own = (w: Record<string, unknown>) => {
      const { antigravityKeyAvailableByRunner: _keys, ...rest } = w;
      return rest;
    };
    const read = async () => ({
      list: ((await call(server, 'GET', '/api/workspaces', token)).json as Array<Record<string, unknown>>).map(own),
      links: await Promise.all([old.api, old.web, old.decoy].map(async (id) => own((await call(server, 'GET', `/api/workspaces/${id}`, token)).json))),
      session: (await call(server, 'GET', `/api/sessions/${session.json.id}`, token)).json,
      runner: ((await call(server, 'GET', '/api/runners', token)).json as Array<{ id: string }>).find((r) => toUuid(r.id) === old.runnerId),
      rows: {
        runners: await rows('SELECT row_to_json(r) AS row FROM runner r WHERE owner_id = $1 ORDER BY id', [old.id]),
        workspaces: await rows('SELECT row_to_json(w) AS row FROM workspace w WHERE owner_id = $1 ORDER BY id', [old.id]),
      },
    });
    const before = await read();
    assert.deepEqual(before.list.map((w) => toUuid(w.id as string)), [old.api, old.web, old.decoy]);

    assertSignedIn(await login(old.email), 'an existing account');
    const mapping = (await mappingOf(old.id))!;
    assert.notEqual(mapping.runnerId, old.runnerId, 'a runner carrying the managed name is not taken for the managed runner');
    assert.notEqual(mapping.defaultWorkspaceId, old.decoy, 'a workspace named and placed like the default is not taken for it');
    await bringUp(old.id, [engine('codex')]);

    const after = await read();
    assert.deepEqual(after.list.slice(0, 3), before.list, 'the same workspaces, in the same order, unchanged');
    assert.equal(after.list.length, 4);
    assert.equal(toUuid(after.list[3].id as string), mapping.defaultWorkspaceId, 'the managed default is added after them');
    assert.equal(toUuid(after.list.find((w) => w.runnerId)!.id as string), old.api, 'the first workspace a client lands on is the same');
    assert.deepEqual(after.links, before.links, 'every deep link opens what it opened');
    assert.deepEqual(after.session, before.session);
    assert.deepEqual(after.runner, before.runner);
    assert.deepEqual(after.rows.runners.filter((r) => !r.includes(mapping.runnerId)), before.rows.runners);
    assert.deepEqual(after.rows.workspaces.filter((w) => !w.includes(mapping.defaultWorkspaceId)), before.rows.workspaces);
    // The floor is untouched for self-managed workspaces; only the managed default starts on its supply.
    assert.equal(after.list.find((w) => toUuid(w.id as string) === old.web)!.lastProvider, 'claude');
    assert.equal(after.list[3].lastProvider, 'codex');
  });

  await t.test('(B5) provisioning that fails never breaks a sign-in, and an explicit ensure or retry provisions', async () => {
    // The intent itself cannot be written.
    const unlucky = await account('unlucky');
    const fn = `c5_refuse_managed_runner_${RUN}`;
    await sql.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected: managed intent refused'; END $$`);
    await sql.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON managed_runner FOR EACH ROW WHEN (NEW.owner_id = '${unlucky.id}') EXECUTE FUNCTION ${fn}()`);
    let signedIn: Reply;
    try {
      signedIn = await login(unlucky.email);
    } finally {
      await sql.query(`DROP TRIGGER ${fn} ON managed_runner`);
      await sql.query(`DROP FUNCTION ${fn}()`);
    }
    assertSignedIn(signedIn, 'a sign-in whose intent was refused');
    const token = signedIn.json.accessToken as string;
    assert.deepEqual(await countsOf(unlucky.id), { mappings: 0, runners: 0, workspaces: 0 }, 'nothing half-written');
    assert.equal((await call(server, 'POST', '/api/auth/refresh', undefined, { refreshToken: signedIn.json.refreshToken })).status, 201, 'the session it issued stands');
    const offered = await statusOf(token);
    assert.equal(offered.managementState, 'NOT_PROVISIONED');
    assert.equal(offered.actions.canEnsure, true);
    const ensured = await call(server, 'POST', '/api/managed-runner/ensure', token, { idempotencyKey: `ensure-${RUN}` });
    assert.equal(ensured.status, 202, ensured.text);
    assert.equal((await bringUp(unlucky.id, [engine('kimi')])).initialProvider, 'kimi');

    // Provisioning fails in the cluster: the sign-in has already answered.
    const forbidden = await account('forbidden');
    cluster.inject({ op: 'create', kind: 'persistentvolumeclaims', mode: 'status', status: 403 });
    const first = await login(forbidden.email);
    assertSignedIn(first, 'a sign-in whose provisioning then fails');
    const failed = await until('FAILED', async () => {
      const m = await mappingOf(forbidden.id);
      return m?.managementState === 'FAILED' ? m : null;
    });
    assert.equal((failed.lastError as { code: string }).code, 'KUBERNETES_FORBIDDEN');
    const status = await statusOf(first.json.accessToken);
    assert.equal(status.actions.canRetry, true);
    // Signing in again neither breaks nor retries it.
    assertSignedIn(await login(forbidden.email), 'a sign-in while provisioning has failed');
    await sleep(1_500);
    const still = (await mappingOf(forbidden.id))!;
    assert.equal(still.managementState, 'FAILED');
    assert.equal(still.revision, failed.revision);
    // The explicit retry, at the revision read: the same mapping and volume, READY.
    const retried = await call(server, 'POST', '/api/managed-runner/retry', first.json.accessToken, { idempotencyKey: `retry-${RUN}`, revision: status.revision });
    assert.equal(retried.status, 202, retried.text);
    const ready = await bringUp(forbidden.id, [engine('claude')]);
    assert.equal(ready.id, failed.id);
    assert.equal(ready.runnerId, failed.runnerId);
    assert.equal(ready.defaultWorkspaceId, failed.defaultWorkspaceId);
    assert.equal(cluster.all('persistentvolumeclaims').filter((p) => p.metadata.name === ready.pvcName).length, 1);
    assert.deepEqual(await countsOf(forbidden.id), { mappings: 1, runners: 1, workspaces: 1 });
  });

  await t.test('(B6) nothing installed and signed in: MODEL_UNAVAILABLE, no first session on any engine, READY once one is signed in', async () => {
    const user = await account('nomodel');
    const token = (await login(user.email)).json.accessToken as string;
    // Claude installed but its sign-in unknown, Codex missing: no supply at all.
    const waiting = await bringUp(user.id, [engine('claude', { auth: 'unknown' }), engine('codex', { installed: false, auth: 'no' })], 'STARTING');
    assert.equal((waiting.lastError as { code: string }).code, 'MODEL_UNAVAILABLE');
    const status = await statusOf(token);
    assert.equal(status.managementState, 'STARTING', 'not READY');
    assert.equal(status.usable, false);
    assert.equal(status.reason.code, 'MODEL_UNAVAILABLE');
    assert.equal(status.initialProvider, null);

    const workspaceId = (await call(server, 'GET', '/api/workspaces', token)).json[0].id as string;
    for (const provider of [undefined, 'claude', 'codex', 'kimi']) {
      const refusedSession = await call(server, 'POST', '/api/sessions', token, { workspaceId, prompt: 'hello', title: 'first', ...(provider ? { provider } : {}) });
      assert.equal(refusedSession.status, 409, `${provider ?? 'no provider'}: ${refusedSession.text}`);
      assert.equal(refusedSession.json.code, 'MODEL_UNAVAILABLE');
    }
    assert.equal(await db.session.count({ where: { workspaceId: toUuid(workspaceId) } }), 0, 'nothing was created');

    // A runtime signed in on the runner: READY at the next pass, without a retry.
    await heartbeat(waiting.runnerId, [engine('claude', { auth: 'unknown' }), engine('codex')]);
    const ready = await until('READY', async () => {
      const m = await mappingOf(user.id);
      return m?.managementState === 'READY' ? m : null;
    });
    assert.equal(ready.initialProvider, 'codex');
    assert.equal(ready.lastError, null);
    // Asked for an engine the runner does not have, the first session is still refused, and names the one it has.
    const wrong = await call(server, 'POST', '/api/sessions', token, { workspaceId, prompt: 'hello', title: 'first', provider: 'kimi' });
    assert.equal(wrong.status, 409, wrong.text);
    assert.match(wrong.json.message, /Codex/);
    const first = await call(server, 'POST', '/api/sessions', token, { workspaceId, prompt: 'hello', title: 'first' });
    assert.equal(first.status, 201, first.text);
    assert.equal(first.json.provider, 'codex');
    // From the second session on, the workspace's own history decides, as anywhere.
    assert.equal((await call(server, 'GET', '/api/workspaces', token)).json[0].lastProvider, 'codex');
  });

  await t.test('(B7) the eligibility decision governs both sign-in and explicit ensure', async () => {
    // The shipped decision, which this server was built with and nothing overrides, narrowed for one
    // account: what a later invited-testers rule does.
    const outsider = await account('outsider');
    const shipped = EVERY_ACCOUNT.eligible;
    EVERY_ACCOUNT.eligible = async (ownerId) => ownerId !== outsider.id;
    try {
      const signedIn = await login(outsider.email);
      assertSignedIn(signedIn, 'an account the server gives no managed runner');
      const token = signedIn.json.accessToken as string;
      assert.deepEqual(await countsOf(outsider.id), { mappings: 0, runners: 0, workspaces: 0 });
      const status = await statusOf(token);
      assert.equal(status.managementState, 'NOT_PROVISIONED');
      assert.equal(status.reason.code, 'MANAGED_RUNNER_NOT_ELIGIBLE');
      assert.equal(status.actions.canEnsure, false);
      const ensured = await call(server, 'POST', '/api/managed-runner/ensure', token, { idempotencyKey: `outsider-${RUN}` });
      assert.equal(ensured.status, 403, ensured.text);
      assert.equal(ensured.json.code, 'MANAGED_RUNNER_NOT_ELIGIBLE');
      assert.deepEqual(await countsOf(outsider.id), { mappings: 0, runners: 0, workspaces: 0 });
    } finally {
      EVERY_ACCOUNT.eligible = shipped;
    }
    // As shipped, every account: the next sign-in records it.
    assertSignedIn(await login(outsider.email), 'the same account under the shipped decision');
    assert.deepEqual(await countsOf(outsider.id), { mappings: 1, runners: 1, workspaces: 1 });
  });

  await t.test('(B) shutdown: the real Kubernetes client was never built', async () => {
    await app!.close();
    app = undefined;
    process.env = savedEnv;
    assert.deepEqual(realClient, []);
  });

  // ── (C) the manager on the test's clock ────────────────────────────────────────────────────
  await t.test('(C) no supply until the startup deadline: FAILED with MODEL_UNAVAILABLE, retryable; a retry once one is signed in is READY', async () => {
    const clockProfile = testManagedRunnerProfile();
    const fake = installManagedRunnerAdmission(new FakeKubeCluster(clockProfile.kubernetes.namespace), db as unknown as PrismaService, clockProfile);
    const clock = { ms: Date.parse('2026-10-07T08:00:00.000Z') };
    const now = () => new Date(clock.ms);
    const manager = new ManagedRunnerManager(db as unknown as PrismaService, fake.client(), clockProfile, { holder: 'clock', now, random: () => 0.5, log: quiet });
    const runtime: ManagedRunnerRuntime = { available: true, profile: clockProfile, manager, worker: new ManagedRunnerWorker(manager, 60_000, quiet) };
    const service = new ManagedRunnerService(db as unknown as PrismaService, { enabled: true, problem: null }, runtime);
    const user = await account('deadline');
    await service.signedIn({ id: user.id });
    const mapping = (await mappingOf(user.id))!;
    const pass = () => manager.reconcile(mapping.id);
    const outcomes: ReconcileOutcome[] = [];
    for (let i = 0; i < 4 && !(await mappingOf(user.id))!.podUid; i += 1) outcomes.push(await pass());
    const beat = (engines: unknown[]) =>
      db.runner.update({ where: { id: mapping.runnerId }, data: { status: 'ONLINE', lastHeartbeatAt: now(), engines: engines as never } });

    clock.ms += 1_000;
    await beat([engine('claude', { auth: 'no' })]);
    assert.equal(await pass(), 'WAITING');
    const waiting = (await mappingOf(user.id))!;
    assert.equal(waiting.managementState, 'STARTING');
    assert.equal((waiting.lastError as { code: string }).code, 'MODEL_UNAVAILABLE');
    assert.equal(await pass(), 'WAITING');
    assert.equal((await mappingOf(user.id))!.revision, waiting.revision, 'said once, not rewritten every pass');

    clock.ms += clockProfile.lifecycle.startupDeadlineSeconds * 1000;
    await beat([engine('claude', { auth: 'no' })]);
    assert.equal(await pass(), 'FAILED');
    const failed = (await mappingOf(user.id))!;
    assert.deepEqual(
      { code: (failed.lastError as { code: string }).code, retryable: (failed.lastError as { retryable: boolean }).retryable },
      { code: 'MODEL_UNAVAILABLE', retryable: true },
    );
    assert.equal(failed.initialProvider, null);
    assert.equal((await service.status(user.id)).actions.canRetry, true);

    await service.retry(user.id, `retry-${RUN}`, failed.revision);
    for (let i = 0; i < 4; i += 1) {
      const outcome = await pass();
      if ((await mappingOf(user.id))!.managementState === 'STARTING') break;
      outcomes.push(outcome);
    }
    clock.ms += 1_000;
    await beat([engine('claude', { auth: 'no' }), engine('kimi')]);
    assert.equal(await pass(), 'READY');
    const ready = (await mappingOf(user.id))!;
    assert.equal(ready.initialProvider, 'kimi');
    assert.equal(ready.podUid, failed.podUid, 'the same instance, waited on rather than replaced');
    assert.equal(fake.count('delete'), 0);
  });
});
