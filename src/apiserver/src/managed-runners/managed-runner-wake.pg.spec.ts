/**
 * Wake on demand and sleep through the real application (docs/managed-runner-design.md, "Provisioning
 * retry wake and sleep" 5 to 8, "Default disabled gate"): the whole AppModule in this process with
 * ORBIT_MANAGED_RUNNERS_ENABLED=true, its Kubernetes the in-memory namespace of
 * `test-support/fake-kube-client.ts` with the single-Pod admission guard installed, over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, in a scrubbed environment. The test
 * plays the runner over the real routes — heartbeat (its workload, the sleep request and its
 * acceptance) and claim — with the credential and instance identity the manager handed its Pod, and
 * the kubelet by marking the Pod stopped. The application's own reconcile loop does everything else.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-wake.pg.spec.ts
 *
 * Each case starts from a managed runner put to sleep through the owner's sleep request and the full
 * handshake, and wakes it with one kind of demand only:
 *   (1) a message to a parked session of its workspace;
 *   (2) an executable task: Run Now of a task assigned to its workspace;
 *   (3) scheduled work: a session's due wakeup, delivered by the scheduled-wakeup worker, and a task
 *       whose run time came, started by the task scheduler;
 *   (4) a watch: its RESUME_SESSION delivery to a parked observer session;
 *   (5) auto retry: a failed run armed for retry, on a runner that then waits for capacity — no
 *       attempt is spent and nothing gives up while it waits, however long ago the run failed; once
 *       capacity frees and the runner is up, the retry is sent, once;
 *   (6) a revive of an ended session: queued for the waking runner instead of refused as offline.
 * Every wake starts the next generation on the same PVC and runner row, and the woken runner claims
 * the work that woke it. Also:
 *   (7) a self-managed runner's dispatch is untouched with the switch on: its session is claimed as
 *       ever, and nothing managed is read about it beyond one unmatched update;
 *   (8) an account an administrator disabled: its READY runner, refused at every door, is drained to
 *       sleep by the reconcile loop without being asked anything, and stops — the kubelet's report,
 *       the Pod deleted, the PVC kept. Then each kind of demand above, and the owner's ensure and
 *       retry (403 ACCOUNT_DISABLED), wakes nothing and writes nothing to the mapping; enabled again,
 *       the work that waited wakes it on the same PVC and runner row.
 *
 * Destructive only to its own disposable database.
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
  MANAGED_RUNNER_SLEEP_CAPABILITY,
  toUuid,
} from '@orbit/shared';
import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { json, urlencoded } from 'express';
import { Client } from 'pg';

import { DisabledAccounts } from '../auth/disabled-accounts';
import { call, type Apiserver } from '../auth/pat-test-apiserver';
import { generateToken, sha256 } from '../common/crypto.util';
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
import { ScheduledWakeupWorker } from '../runner-api/scheduled-wakeup.worker';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { TasksService } from '../tasks/tasks.service';
import { FakeKubeCluster } from '../test-support/fake-kube-client';
import { installManagedRunnerAdmission } from '../test-support/managed-runner-admission.fixture';
import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import type { PersistentVolumeClaim, Pod, Secret } from './kube-client';
import { GENERATION_ANNOTATION, bootstrapCredentialOf, managedPodName, managedSecretName } from './managed-runner-resources';
import { MANAGED_RUNNER_KUBE_CLIENT_FACTORY, MANAGED_RUNNER_RUNTIME, type ManagedRunnerRuntime } from './managed-runner-runtime';

declare global {
  interface BigInt { toJSON(): string; }
}
// main.ts installs this before it creates the app; session rows carry BIGINT columns.
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const PG_URL = process.env.COORDINATOR_PG_URL;
const IDLE = { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 1 };

test('managed runners wake on demand and sleep through the real application', {
  skip: !PG_URL, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const scratch = mkdtempSync(path.join(tmpdir(), 'orbit-managed-wake-'));
  const JWT_SECRET = randomBytes(32).toString('hex');
  const jwt = new JwtService({ secret: JWT_SECRET });

  // The environment: polls every second, never sleeps a runner on its own (each case asks), and
  // has room for every runner of the run — case (5) fills what is left on purpose.
  const profile = testManagedRunnerProfile({
    lifecycle: { pollIntervalSeconds: 1, backoffBaseSeconds: 1, backoffMaxSeconds: 2, idleSeconds: 604_800, capacityRetrySeconds: 5 },
    capacity: { maxActiveUsers: 12 },
  });
  const cluster = installManagedRunnerAdmission(new FakeKubeCluster(profile.kubernetes.namespace), db as unknown as PrismaService, profile);
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
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  });

  const realClient: string[] = [];
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
    providers: [{ provide: MANAGED_RUNNER_KUBE_CLIENT_FACTORY, useValue: () => cluster.client() }],
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

  // ── the test's side: the owner, the runner and the kubelet ──────────────────────────────────
  const bearer = (userId: string) => jwt.signAsync({ sub: userId, email: `${userId}@example.invalid` });
  const mappingOf = async (ownerId: string): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId } }))!;
  async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 45_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }
  /** The credential the manager put in the current generation's bootstrap Secret. */
  const credentialOf = (runnerId: string) => bootstrapCredentialOf(cluster.object<Secret>('secrets', managedSecretName(runnerId))!)!;
  /** What a managed runner sends with every request: the instance its Pod is, that it can sleep, and
   *  — as every current runner does — that it takes over a revived session's supervisor. */
  const instanceHeaders = (runnerId: string): Record<string, string> => {
    const pod = cluster.object<Pod>('pods', managedPodName(runnerId))!;
    return {
      'x-orbit-runner-capabilities': `${MANAGED_RUNNER_INSTANCE_CAPABILITY},${MANAGED_RUNNER_SLEEP_CAPABILITY},session-terminal-handoff-v1`,
      [MANAGED_RUNNER_GENERATION_HEADER]: pod.metadata.annotations![GENERATION_ANNOTATION],
      [MANAGED_RUNNER_POD_UID_HEADER]: pod.metadata.uid!,
    };
  };
  /** One heartbeat of the runner: a signed-in runtime, and its workload. Answers the route's response. */
  const heartbeat = async (runnerId: string, workload: Record<string, unknown> = IDLE) => {
    const beat = await call(server, 'POST', '/api/runner/heartbeat', credentialOf(runnerId),
      { engines: [{ engine: 'claude', installed: true, auth: 'yes' }], version: '0.1.0', managedWorkload: workload },
      instanceHeaders(runnerId));
    assert.ok(beat.status === 200 || beat.status === 201, `heartbeat: ${beat.text}`);
    return beat.json as { managedSleep?: { requestedAt: string; confirmed?: boolean }; integrationJobs?: unknown[] };
  };
  const claim = async (runnerId: string) => {
    const claimed = await call(server, 'GET', '/api/runner/sessions/claim', credentialOf(runnerId), undefined, instanceHeaders(runnerId));
    assert.equal(claimed.status, 200, claimed.text);
    return claimed.json as { sessionId: string };
  };
  /** Up to its one Pod of the current generation, heartbeating, until READY. */
  async function upAndReady(ownerId: string, generation: number): Promise<ManagedRunner> {
    const starting = await until(`generation ${generation}'s Pod`, async () => {
      const m = await mappingOf(ownerId);
      return m?.podUid && m.generation === generation && m.managementState === 'STARTING' ? m : null;
    });
    await heartbeat(starting.runnerId);
    return until('READY', async () => {
      const m = await mappingOf(ownerId);
      return m.managementState === 'READY' && m.generation === generation ? m : null;
    });
  }

  let accounts = 0;
  /** A new owner with a managed runner, READY. */
  async function owner(label: string) {
    const user = await db.user.create({ data: { email: `${label}-${(accounts += 1)}-${randomUUID().slice(0, 6)}@example.invalid`, name: label } });
    const token = await bearer(user.id);
    const ensured = await call(server, 'POST', '/api/managed-runner/ensure', token, { idempotencyKey: `ensure-${label}` });
    assert.equal(ensured.status, 202, ensured.text);
    const ready = await upAndReady(user.id, 1);
    return { userId: user.id, token, mapping: ready };
  }

  /**
   * Asleep through the owner's request and the whole handshake: drained by the reconcile loop, asked
   * in a heartbeat answer, accepting in the next one (idle), confirmed, stopped as the kubelet reports.
   */
  async function putToSleep(o: { userId: string; token: string }): Promise<ManagedRunner> {
    const m = await mappingOf(o.userId);
    const asked = await call(server, 'POST', '/api/managed-runner/sleep', o.token, { idempotencyKey: `sleep-${m.generation}-${randomUUID()}`, revision: m.revision });
    assert.equal(asked.status, 202, asked.text);
    await until('DRAINING', async () => (await mappingOf(o.userId)).managementState === 'DRAINING');
    const first = await heartbeat(m.runnerId);
    assert.ok(first.managedSleep?.requestedAt && !first.managedSleep.confirmed, `the drained instance is asked: ${JSON.stringify(first.managedSleep)}`);
    assert.equal(first.integrationJobs, undefined, 'a draining instance is handed no new work');
    const second = await heartbeat(m.runnerId, { ...IDLE, sleepReady: first.managedSleep!.requestedAt });
    assert.deepEqual(second.managedSleep, { requestedAt: first.managedSleep!.requestedAt, confirmed: true }, 'its acceptance is confirmed');
    cluster.stopPod(managedPodName(m.runnerId));
    return until('SLEEPING', async () => {
      const s = await mappingOf(o.userId);
      return s.managementState === 'SLEEPING' ? s : null;
    });
  }

  /** A session of the runner's default workspace, as earlier work left it. */
  async function session(m: ManagedRunner, status: string, extra: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const columns: Record<string, unknown> = {
      id, owner_id: m.ownerId, creator_id: m.ownerId, workspace_id: m.defaultWorkspaceId, assigned_runner_id: m.runnerId,
      title: 'earlier work', prompt: 'the opening prompt', provider: 'claude', provider_builtin: true, status, num_turns: 1,
      runtime_session_id: randomUUID(), ...extra,
    };
    const names = Object.keys(columns);
    await sql.query(
      // started_at and updated_at by the database's clock: they are timestamps without a zone.
      `INSERT INTO "session" (${names.map((n) => `"${n}"`).join(', ')}, "started_at", "updated_at")
       VALUES (${names.map((n, i) => (n === 'status' ? `$${i + 1}::"run_status"` : `$${i + 1}`)).join(', ')}, now(), now())`,
      names.map((n) => columns[n]),
    );
    return id;
  }

  /** What every wake must have kept: the runner row, its workspace and its volume, one generation on. */
  async function assertSameIdentity(before: ManagedRunner, after: ManagedRunner) {
    assert.equal(after.runnerId, before.runnerId, 'the same runner');
    assert.equal(after.defaultWorkspaceId, before.defaultWorkspaceId, 'the same workspace');
    assert.equal(after.pvcUid, before.pvcUid, 'the same PVC');
    assert.equal(after.volumeHandle, before.volumeHandle, 'the same volume');
    assert.equal(cluster.calls.filter((c) => c.op === 'create' && c.kind === 'persistentvolumeclaims' && c.name === before.pvcName).length, 1, 'never created again');
    const pod = cluster.object<Pod>('pods', managedPodName(before.runnerId))!;
    assert.equal(pod.metadata.annotations?.['orbit.dev/pvc-uid'], before.pvcUid);
  }

  /** The demand a request recorded, before the reconcile loop has done anything with it. */
  async function assertWakeRequested(ownerId: string, asleep: ManagedRunner) {
    const m = await mappingOf(ownerId);
    assert.equal(m.desiredState, 'RUNNING', 'RUNNING is desired again');
    assert.ok(m.demandRevision > asleep.demandRevision, 'the demand is recorded');
  }

  await t.test('(1) a message to a parked session wakes it, and the woken runner claims the turn', async () => {
    const o = await owner('message');
    const parked = await session(o.mapping, 'AWAITING_INPUT');
    const asleep = await putToSleep(o);
    const sent = await call(server, 'POST', `/api/sessions/${parked}/turns`, o.token, { clientTurnId: randomUUID(), content: 'are you there?' });
    assert.equal(sent.status, 201, sent.text);
    await assertWakeRequested(o.userId, asleep);
    const awake = await upAndReady(o.userId, 2);
    await assertSameIdentity(o.mapping, awake);
    assert.equal(toUuid((await claim(awake.runnerId)).sessionId), parked, 'the message is served by the woken runner');
  });

  await t.test('(2) an executable task wakes it: Run Now of a task assigned to its workspace', async () => {
    const o = await owner('task');
    const asleep = await putToSleep(o);
    const created = await call(server, 'POST', '/api/tasks', o.token, { title: 'build the thing', description: 'build it', assigneeId: o.mapping.defaultWorkspaceId, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 });
    assert.equal(created.status, 201, created.text);
    const ran = await call(server, 'POST', `/api/tasks/${created.json.id}/execute`, o.token, {});
    assert.ok(ran.status === 200 || ran.status === 201, ran.text);
    await assertWakeRequested(o.userId, asleep);
    const awake = await upAndReady(o.userId, 2);
    await assertSameIdentity(o.mapping, awake);
    const claimed = await claim(awake.runnerId);
    const run = await db.session.findUniqueOrThrow({ where: { id: toUuid(claimed.sessionId) } });
    assert.equal(run.taskId, toUuid(created.json.id), 'the task\'s run is served by the woken runner');
  });

  await t.test('(3) scheduled work wakes it: a due session wakeup, and a task whose run time came', async () => {
    const o = await owner('scheduled');
    const parked = await session(o.mapping, 'AWAITING_INPUT');
    let asleep = await putToSleep(o);
    await sql.query(
      `INSERT INTO "session_scheduled_wakeup" ("id", "session_id", "state", "delay_seconds", "reason", "prompt", "due_at")
       VALUES (gen_random_uuid(), $1, 'PENDING', 60, 'check the build', 'check the build', now() - interval '1 second')`,
      [parked],
    );
    await app!.get(ScheduledWakeupWorker).drain();
    await assertWakeRequested(o.userId, asleep);
    let awake = await upAndReady(o.userId, 2);
    await assertSameIdentity(o.mapping, awake);
    assert.equal(toUuid((await claim(awake.runnerId)).sessionId), parked, 'the wakeup\'s turn is served');
    await sql.query(`UPDATE "session" SET status = 'AWAITING_INPUT' WHERE id = $1`, [parked]); // its turn ran

    asleep = await putToSleep(o);
    const created = await call(server, 'POST', '/api/tasks', o.token, { title: 'nightly', description: 'run at its time', assigneeId: o.mapping.defaultWorkspaceId, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 });
    assert.equal(created.status, 201, created.text);
    await sql.query(`UPDATE "task" SET "run_at" = now() - interval '1 second' WHERE id = $1`, [toUuid(created.json.id)]);
    // The task scheduler's own pass (every minute in the application), taken now rather than waited for.
    await (app!.get(TasksService) as unknown as { dispatchDueScheduledTasks(): Promise<void> }).dispatchDueScheduledTasks();
    assert.equal(await db.session.count({ where: { taskId: toUuid(created.json.id) } }), 1, 'its run time came: it was started');
    await assertWakeRequested(o.userId, asleep);
    awake = await upAndReady(o.userId, 3);
    await assertSameIdentity(o.mapping, awake);
    const run = await db.session.findUniqueOrThrow({ where: { id: toUuid((await claim(awake.runnerId)).sessionId) } });
    assert.equal(run.taskId, toUuid(created.json.id));
  });

  await t.test('(4) a watch wakes it: its delivery to a parked observer session', async () => {
    const o = await owner('watch');
    const observer = await session(o.mapping, 'AWAITING_INPUT');
    const asleep = await putToSleep(o);
    const done = randomUUID();
    await sql.query(
      `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion","status")
       VALUES ($1,'watched work',$2,'USER',$2,now(),'EVIDENCE_JUDGMENT','DONE')`,
      [done, o.userId],
    );
    const watched = await call(server, 'POST', '/api/watches', o.token, {
      predicateVersion: 1,
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
      targets: [{ kind: 'TASK', id: done }],
      action: 'RESUME_SESSION',
      observerSessionId: observer,
    });
    assert.equal(watched.status, 201, watched.text);
    await until('the watch delivery', async () => (await mappingOf(o.userId)).desiredState === 'RUNNING', 60_000);
    await assertWakeRequested(o.userId, asleep);
    const awake = await upAndReady(o.userId, 2);
    await assertSameIdentity(o.mapping, awake);
    assert.equal(toUuid((await claim(awake.runnerId)).sessionId), observer, 'the watch\'s turn is served');
  });

  await t.test('(5) auto retry: waiting for capacity spends no attempt and never gives up; then the retry goes, once', async () => {
    const o = await owner('retry');
    const asleep = await putToSleep(o);
    // A run that failed 45 minutes ago, armed for retry and due now. `retry_at` and `finished_at` are
    // timestamps without a zone: written by the database's own clock, as the application writes them.
    const failed = await session(o.mapping, 'FAILED', { retry_attempts: 1, error: 'overloaded' });
    await sql.query(`UPDATE "session" SET retry_at = now() - interval '1 second', finished_at = now() - interval '45 minutes' WHERE id = $1`, [failed]);
    await sql.query(
      `INSERT INTO "run_event"("id","session_id","seq","type","payload") VALUES (gen_random_uuid(),$1,1,'user','{"text":"do the work"}'::jsonb)`,
      [failed],
    );
    // Every active-user slot left is taken by others: the woken runner has to wait.
    const pool = (await sql.query(`SELECT id FROM managed_runner_capacity WHERE cluster_key = $1`, [profile.clusterKey])).rows[0].id as string;
    const { rows: [{ free }] } = await sql.query(`SELECT active_users - active_users_reserved AS free FROM managed_runner_capacity WHERE id = $1`, [pool]);
    await sql.query(`UPDATE managed_runner_capacity SET active_users_reserved = active_users_reserved + $2, revision = revision + 1 WHERE id = $1`, [pool, free]);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await sql.query(`UPDATE managed_runner_capacity SET active_users_reserved = active_users_reserved - $2, revision = revision + 1 WHERE id = $1`, [pool, free]);
    };
    t.after(release);

    const retries = app!.get(AutoRetryService);
    await retries.sweep();
    await assertWakeRequested(o.userId, asleep);
    await until('WAITING_CAPACITY', async () => (await mappingOf(o.userId)).managementState === 'WAITING_CAPACITY');
    for (let i = 0; i < 3; i += 1) {
      await sql.query(`UPDATE "session" SET retry_at = now() - interval '1 second' WHERE id = $1`, [failed]);
      await retries.sweep();
    }
    const waiting = await db.session.findUniqueOrThrow({ where: { id: failed } });
    assert.equal(waiting.retryAttempts, 1, 'no attempt is spent waiting for managed capacity');
    assert.ok(waiting.retryAt && waiting.retryAt > new Date(), 'still armed: 45 minutes after the failure, nothing gave up');
    assert.equal(waiting.status, 'FAILED');
    const status = await call(server, 'GET', '/api/managed-runner', o.token);
    assert.equal(status.json.managementState, 'WAITING_CAPACITY');
    assert.equal(status.json.reason.code, 'MANAGED_RUNNER_CAPACITY_UNAVAILABLE', 'the wait says why');
    assert.ok(status.json.retryAfter, 'and until when');

    // The others give their slots back: the runner starts, and the next sweep sends the retry, once.
    await release();
    const awake = await upAndReady(o.userId, 2);
    await assertSameIdentity(o.mapping, awake);
    await sql.query(`UPDATE "session" SET retry_at = now() - interval '1 second' WHERE id = $1`, [failed]);
    await retries.sweep();
    const resent = await db.session.findUniqueOrThrow({ where: { id: failed } });
    assert.equal(resent.retryAttempts, 2, 'the retry was sent, and that is the one attempt it spent');
    assert.equal(resent.status, 'PENDING');
    assert.equal(toUuid((await claim(awake.runnerId)).sessionId), failed);
  });

  await t.test('(6) reviving an ended session queues it for the waking runner instead of refusing it as offline', async () => {
    const o = await owner('revive');
    const ended = await session(o.mapping, 'FAILED', { finished_at: new Date(), error: 'it stopped' });
    const asleep = await putToSleep(o);
    // Long enough asleep for its last heartbeat to read as offline: the gate a revive used to stop at.
    await sql.query(`UPDATE runner SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [asleep.runnerId]);
    const revived = await call(server, 'POST', `/api/sessions/${ended}/resume`, o.token, { clientTurnId: randomUUID(), content: 'carry on' });
    assert.ok(revived.status === 200 || revived.status === 201, `not refused as offline: ${revived.text}`);
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: ended } })).status, 'PENDING');
    await assertWakeRequested(o.userId, asleep);
    const awake = await upAndReady(o.userId, 2);
    await assertSameIdentity(o.mapping, awake);
    assert.equal(toUuid((await claim(awake.runnerId)).sessionId), ended);
  });

  await t.test('(7) a self-managed runner is dispatched as ever with the switch on', async () => {
    const user = await db.user.create({ data: { email: `self-${randomUUID()}@example.invalid`, name: 'self' } });
    const token = await bearer(user.id);
    const credential = generateToken(32);
    const runnerId = (await sql.query(
      `INSERT INTO runner (id, name, owner_id, token_hash, status, last_heartbeat_at, max_concurrent)
         VALUES (gen_random_uuid(), 'laptop', $1, $2, 'ONLINE', now(), 2) RETURNING id`,
      [user.id, sha256(credential)],
    )).rows[0].id as string;
    const workspaceId = (await sql.query(
      `INSERT INTO workspace (id, name, owner_id, runner_id, target_runner_id, work_dir) VALUES (gen_random_uuid(), 'repo', $1, $2, $2, '/srv/repo') RETURNING id`,
      [user.id, runnerId],
    )).rows[0].id as string;
    const parked = await session({ ownerId: user.id, runnerId, defaultWorkspaceId: workspaceId } as ManagedRunner, 'AWAITING_INPUT');
    const sent = await call(server, 'POST', `/api/sessions/${parked}/turns`, token, { clientTurnId: randomUUID(), content: 'hi' });
    assert.equal(sent.status, 201, sent.text);
    const beat = await call(server, 'POST', '/api/runner/heartbeat', credential, { version: '0.1.0', managedWorkload: IDLE }, {});
    assert.ok(beat.status === 200 || beat.status === 201, beat.text);
    assert.equal(beat.json.managedSleep, undefined, 'nothing about sleep is said to it');
    const claimed = await call(server, 'GET', '/api/runner/sessions/claim', credential);
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(toUuid(claimed.json.sessionId), parked, 'its session is claimed as ever');
    assert.equal(await db.managedRunner.count({ where: { ownerId: user.id } }), 0, 'no mapping is created for it');
    assert.equal((await db.runner.findUniqueOrThrow({ where: { id: runnerId } })).managedWorkload, null, 'and nothing managed is stored about it');
  });

  await t.test('(8) a disabled account: drained to sleep by the loop, woken by nothing until it is enabled again', async () => {
    const o = await owner('disabled');
    const runnerId = o.mapping.runnerId;
    // Work its owner left before the account was disabled: parked sessions a message, a due wakeup and
    // a watch go to, an ended one to revive, a failed run armed for retry, and a task to watch.
    const parked = await session(o.mapping, 'AWAITING_INPUT');
    const scheduled = await session(o.mapping, 'AWAITING_INPUT');
    const observer = await session(o.mapping, 'AWAITING_INPUT');
    const ended = await session(o.mapping, 'FAILED', { finished_at: new Date(), error: 'it stopped' });
    const retried = await session(o.mapping, 'FAILED', { retry_attempts: 1, error: 'overloaded' });
    await sql.query(
      `INSERT INTO "run_event"("id","session_id","seq","type","payload") VALUES (gen_random_uuid(),$1,1,'user','{"text":"do the work"}'::jsonb)`,
      [retried],
    );
    const watchedTask = randomUUID();
    await sql.query(
      `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion","status")
       VALUES ($1,'watched work',$2,'USER',$2,now(),'EVIDENCE_JUDGMENT','DONE')`,
      [watchedTask, o.userId],
    );

    // An administrator disables the account: its runner is refused at every door at once.
    await sql.query(`UPDATE "user" SET disabled_at = now() WHERE id = $1`, [o.userId]);
    const beat = await call(server, 'POST', '/api/runner/heartbeat', credentialOf(runnerId),
      { engines: [{ engine: 'claude', installed: true, auth: 'yes' }], version: '0.1.0', managedWorkload: IDLE }, instanceHeaders(runnerId));
    assert.equal(beat.status, 403, beat.text);
    assert.equal(beat.json.code, 'ACCOUNT_DISABLED');
    // The loop drains it without asking the instance anything. Its claims refused as well, the runner
    // drains and exits on its own, and the kubelet reports the stop.
    await until('DRAINING', async () => (await mappingOf(o.userId)).managementState === 'DRAINING');
    const claimed = await call(server, 'GET', '/api/runner/sessions/claim', credentialOf(runnerId), undefined, instanceHeaders(runnerId));
    assert.equal(claimed.status, 403, claimed.text);
    assert.equal(claimed.json.code, 'ACCOUNT_DISABLED');
    const pvc = cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', o.mapping.pvcName)!;
    cluster.stopPod(managedPodName(runnerId));
    const asleep = await until('SLEEPING', async () => {
      const m = await mappingOf(o.userId);
      return m.managementState === 'SLEEPING' ? m : null;
    });
    assert.equal(asleep.generation, 2, 'the drained generation is retired');
    assert.equal(asleep.desiredState, 'SLEEPING');
    assert.equal(cluster.object<Pod>('pods', managedPodName(runnerId)), undefined, 'its Pod is deleted');
    assert.equal(cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', o.mapping.pvcName)?.metadata.uid, pvc.metadata.uid, 'its PVC is kept');
    const rowOf = async () => (await sql.query(`SELECT row_to_json(m)::text AS row FROM managed_runner m WHERE owner_id = $1`, [o.userId])).rows[0].row as string;
    const stored = await rowOf();
    const mark = cluster.calls.length;
    // Long enough asleep for its last heartbeat to read as offline.
    await sql.query(`UPDATE runner SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [runnerId]);

    // The owner's own requests reach the server only on a replica whose view of the disabled accounts is
    // not yet half a minute old: played by holding this replica's view where it was.
    const accounts = app!.get(DisabledAccounts);
    const view = accounts.has.bind(accounts);
    accounts.has = () => false;
    try {
      const status = await call(server, 'GET', '/api/managed-runner', o.token);
      assert.equal(status.json.managementState, 'SLEEPING');
      assert.equal(status.json.reason.code, 'ACCOUNT_DISABLED', 'the status says why');
      assert.deepEqual(status.json.actions, { canEnsure: false, canWake: false, canSleep: false, canRetry: false, canDelete: false });
      for (const [action, body] of [['ensure', {}], ['retry', { revision: asleep.revision }], ['wake', {}]] as const) {
        const refused = await call(server, 'POST', `/api/managed-runner/${action}`, o.token, { idempotencyKey: `disabled-${action}`, ...body });
        assert.equal(refused.status, 403, `${action}: ${refused.text}`);
        assert.equal(refused.json.code, 'ACCOUNT_DISABLED', action);
      }
      // Scheduled work: a task whose run time came, started by the task scheduler's pass — first, while
      // nothing else is queued for the runner (that pass starts no more than the runner can claim).
      const later = await call(server, 'POST', '/api/tasks', o.token, { title: 'nightly while disabled', description: 'run at its time', assigneeId: o.mapping.defaultWorkspaceId, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 });
      assert.equal(later.status, 201, later.text);
      const nightly = toUuid(later.json.id);
      await sql.query(`UPDATE "task" SET "run_at" = now() - interval '1 second' WHERE id = $1`, [nightly]);
      await (app!.get(TasksService) as unknown as { dispatchDueScheduledTasks(): Promise<void> }).dispatchDueScheduledTasks();
      assert.equal(await db.session.count({ where: { taskId: nightly } }), 1, 'its run time came: it was started');
      // A message to a parked session: queued for its runner, as for any runner.
      const sent = await call(server, 'POST', `/api/sessions/${parked}/turns`, o.token, { clientTurnId: randomUUID(), content: 'are you there?' });
      assert.equal(sent.status, 201, sent.text);
      assert.equal((await db.session.findUniqueOrThrow({ where: { id: parked } })).status, 'PENDING');
      // An executable task: Run Now.
      const task = await call(server, 'POST', '/api/tasks', o.token, { title: 'build while disabled', description: 'build it', assigneeId: o.mapping.defaultWorkspaceId, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 });
      assert.equal(task.status, 201, task.text);
      const ran = await call(server, 'POST', `/api/tasks/${task.json.id}/execute`, o.token, {});
      assert.ok(ran.status === 200 || ran.status === 201, ran.text);
      assert.equal(await db.session.count({ where: { taskId: toUuid(task.json.id) } }), 1, 'its run was created');
      // A watch, delivered below by the application's own workers.
      const watched = await call(server, 'POST', '/api/watches', o.token, {
        predicateVersion: 1,
        predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
        targets: [{ kind: 'TASK', id: watchedTask }],
        action: 'RESUME_SESSION',
        observerSessionId: observer,
      });
      assert.equal(watched.status, 201, watched.text);
      // A revive of an ended session: refused as offline, the way a runner that is not coming back is.
      const revived = await call(server, 'POST', `/api/sessions/${ended}/resume`, o.token, { clientTurnId: randomUUID(), content: 'carry on' });
      assert.equal(revived.status, 409, revived.text);
    } finally {
      accounts.has = view;
    }
    // Scheduled work: a due wakeup, delivered by its worker.
    await sql.query(
      `INSERT INTO "session_scheduled_wakeup" ("id", "session_id", "state", "delay_seconds", "reason", "prompt", "due_at")
       VALUES (gen_random_uuid(), $1, 'PENDING', 60, 'check the build', 'check the build', now() - interval '1 second')`,
      [scheduled],
    );
    await app!.get(ScheduledWakeupWorker).drain();
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: scheduled } })).status, 'PENDING', 'the wakeup\'s turn waits for its runner');
    // The watch's delivery, by the application's own workers.
    await until('the watch delivery', async () => (await db.session.findUniqueOrThrow({ where: { id: observer } })).status === 'PENDING', 60_000);
    // Auto retry: armed and due, 45 minutes after its run failed. Not waited for as a managed runner
    // coming back: it gives up the ordinary way, spending nothing.
    await sql.query(`UPDATE "session" SET retry_at = now() - interval '1 second', finished_at = now() - interval '45 minutes' WHERE id = $1`, [retried]);
    await app!.get(AutoRetryService).sweep();
    const gaveUp = await db.session.findUniqueOrThrow({ where: { id: retried } });
    assert.equal(gaveUp.retryAt, null);
    assert.equal(gaveUp.retryAttempts, 1);
    // A few passes of the loop, its sweep included: none of it woke the runner.
    await sleep(3_000);
    assert.equal(await rowOf(), stored, 'not a column of the mapping moved: no demand, no desired state, no step');
    assert.deepEqual(cluster.calls.slice(mark).filter((c) => c.op === 'create' || c.op === 'dryRunCreate'), [], 'and nothing was created');

    // Enabled again: the work that waited wakes it, on the same PVC and runner row.
    await sql.query(`UPDATE "user" SET disabled_at = NULL WHERE id = $1`, [o.userId]);
    await accounts.reload();
    const awake = await upAndReady(o.userId, 2);
    await assertSameIdentity(o.mapping, awake);
    const waited = new Set((await db.session.findMany({ where: { assignedRunnerId: runnerId, status: 'PENDING' }, select: { id: true } })).map((r) => r.id));
    for (const id of [parked, scheduled, observer]) assert.ok(waited.has(id), 'the work queued while it was disabled is still there');
    assert.ok(waited.has(toUuid((await claim(awake.runnerId)).sessionId)), 'and the woken runner serves it');
  });

  await t.test('no real Kubernetes client was built or used', () => {
    assert.deepEqual(realClient, []);
  });
});
