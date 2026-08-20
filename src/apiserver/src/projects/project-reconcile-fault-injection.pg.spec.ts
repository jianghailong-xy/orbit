import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setImmediate as waitImmediate, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Prisma } from '@prisma/client';
import type { Client, QueryResult } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  ProjectEventHandler,
  ProjectEventsService,
} from './project-events.service';
import {
  PROJECT_RECONCILE_TIMER_MS,
  ProjectLeaseLostError,
  ProjectReconcileLease,
  ProjectReconcileService,
} from './project-reconcile.service';

const URL = process.env.COORDINATOR_PG_URL;
const CONTAINER = process.env.COORDINATOR_PG_CONTAINER;
const SCHEMA = 'pcc10_reconcile_faults';
const PROJECT_PLANNING = '00000000-0000-7000-8000-000000001001';
const PROJECT_EXECUTING = '00000000-0000-7000-8000-000000001002';
const PROJECT_VERIFYING = '00000000-0000-7000-8000-000000001003';
const PROJECT_ERROR = '00000000-0000-7000-8000-000000001004';
const TASK_EXECUTING = '00000000-0000-7000-8000-000000001005';
const TASK_VERIFYING = '00000000-0000-7000-8000-000000001006';
const VERIFIED_TASK = '00000000-0000-7000-8000-000000001007';
const SESSION_EXECUTING = '00000000-0000-7000-8000-000000001008';
const SOURCE_PLANNING = '00000000-0000-7000-8000-000000001009';
const SOURCE_EXECUTING = '00000000-0000-7000-8000-000000001010';
const SOURCE_VERIFYING = '00000000-0000-7000-8000-000000001011';
const SOURCE_ERROR = '00000000-0000-7000-8000-000000001012';

const OUTBOX = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0116_project_event_outbox/migration.sql'),
  'utf8',
);
const RECONCILE = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0119_project_reconcile_runtime/migration.sql'),
  'utf8',
);

type ClientCtor = new (config: {
  connectionString?: string;
  connectionTimeoutMillis?: number;
}) => Client;
type Tx = Prisma.TransactionClient;

const execFileAsync = promisify(execFile);
const skip = URL
  ? false
  : 'set COORDINATOR_PG_URL and the three expected identity variables to run';

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function connectEventually(): Promise<Client> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await connect();
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError;
}

function rows<T>(result: QueryResult): T[] {
  return result.rows as T[];
}

function transactionClient(client: Client): Tx {
  return {
    $queryRaw: async (query: Prisma.Sql) => rows(await client.query(query.text, query.values)),
    $executeRaw: async (query: Prisma.Sql) =>
      (await client.query(query.text, query.values)).rowCount ?? 0,
    $executeRawUnsafe: async (query: string, ...values: unknown[]) =>
      (await client.query(query, values)).rowCount ?? 0,
  } as unknown as Tx;
}

function prisma(client: Client): PrismaService {
  const direct = transactionClient(client);
  return {
    $queryRaw: direct.$queryRaw.bind(direct),
    $executeRaw: direct.$executeRaw.bind(direct),
    $transaction: async <T>(fn: (tx: Tx) => Promise<T>) => {
      await client.query('BEGIN');
      try {
        const result = await fn(transactionClient(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  } as unknown as PrismaService;
}

async function inTransaction<T>(
  client: Client,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return prisma(client).$transaction(fn) as Promise<T>;
}

async function useSchema(client: Client): Promise<void> {
  await client.query(`SET search_path TO ${SCHEMA}`);
}

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await useSchema(client);
  await client.query(`
    CREATE TYPE "project_status" AS ENUM ('OPEN', 'DONE', 'CANCELLED');
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "status" "project_status" NOT NULL DEFAULT 'OPEN',
      "coordinator_enabled" BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE "project_runtime" (
      "project_id" UUID PRIMARY KEY REFERENCES "project"("id") ON DELETE CASCADE,
      "coordinator_generation" BIGINT NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL
    );
    INSERT INTO "project" ("id") VALUES
      ('${PROJECT_PLANNING}'), ('${PROJECT_EXECUTING}'),
      ('${PROJECT_VERIFYING}'), ('${PROJECT_ERROR}');
    INSERT INTO "project_runtime" ("project_id", "updated_at")
      SELECT "id", CURRENT_TIMESTAMP FROM "project";
  `);
  await client.query(OUTBOX);
  await client.query(RECONCILE);
  await client.query(`
    CREATE TABLE "task" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID REFERENCES "project"("id") ON DELETE CASCADE,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "verifies_task_id" UUID
    );
    CREATE TABLE "session" (
      "id" UUID PRIMARY KEY,
      "task_id" UUID REFERENCES "task"("id") ON DELETE SET NULL,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "deleted_at" TIMESTAMP(3)
    );
    CREATE TABLE "business_effect" (
      "action_key" TEXT PRIMARY KEY,
      "action_id" UUID NOT NULL,
      "project_id" UUID NOT NULL REFERENCES "project"("id"),
      "marker" TEXT NOT NULL
    );
    UPDATE "project_runtime"
       SET "next_wake_at" = NULL, "next_wake_reason" = NULL;
  `);
}

function noEvents(): ProjectEventsService {
  return {} as ProjectEventsService;
}

async function enqueue(
  client: Client,
  events: ProjectEventsService,
  projectId: string,
  sourceId: string,
  dedupeKey: string,
  occurredAt = new Date(),
  kind = 'task.updated',
): Promise<void> {
  await inTransaction(client, (tx) => events.enqueue(tx, {
    projectId,
    kind,
    source: { type: 'TASK', id: sourceId },
    dedupeKey,
    occurredAt,
    payload: { claimedProject: PROJECT_ERROR },
  }));
}

async function writeEffect(
  tx: Tx,
  actionId: string,
  actionKey: string,
  projectId: string,
  marker: string,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "business_effect" ("action_key", "action_id", "project_id", "marker")
    VALUES (${actionKey}, ${actionId}::uuid, ${projectId}::uuid, ${marker})
  `);
}

async function waitForMarker(
  child: ChildProcessWithoutNullStreams,
  marker: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error(
      `timed out waiting for ${marker}; stdout=${stdout} stderr=${stderr}`,
    )), 10_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(marker)) finish();
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      finish(new Error(
        `claimant exited before ${marker}: code=${code} signal=${signal} stderr=${stderr}`,
      ));
    });
  });
}

function spawnActionClaimant(
  mode: 'BEFORE_COMMIT' | 'AFTER_COMMIT',
  actionKey: string,
  now: Date,
): ChildProcessWithoutNullStreams {
  const script = String.raw`
    const { Client } = require('pg');
    const { ProjectReconcileService } = require(
      './build-project-reconcile-faults/projects/project-reconcile.service.js'
    );
    (async () => {
      const client = new Client({ connectionString: process.env.PCC_CHILD_URL });
      await client.connect();
      const identity = (await client.query(
        'SELECT current_database() database, current_user role, ' +
        '(SELECT system_identifier::text FROM pg_control_system()) system_identifier'
      )).rows[0];
      if (identity.database !== process.env.COORDINATOR_PG_EXPECTED_DATABASE ||
          identity.role !== process.env.COORDINATOR_PG_EXPECTED_USER ||
          identity.system_identifier !== process.env.COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER) {
        throw new Error('child PostgreSQL identity mismatch: ' + JSON.stringify(identity));
      }
      await client.query('SET search_path TO ' + process.env.PCC_CHILD_SCHEMA);
      const direct = {
        $queryRaw: async (query) => (await client.query(query.text, query.values)).rows,
        $executeRaw: async (query) =>
          (await client.query(query.text, query.values)).rowCount || 0,
        $executeRawUnsafe: async (query, ...values) =>
          (await client.query(query, values)).rowCount || 0,
      };
      const db = {
        ...direct,
        $transaction: async (fn) => {
          await client.query('BEGIN');
          try {
            const value = await fn(direct);
            await client.query('COMMIT');
            return value;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        },
      };
      const service = new ProjectReconcileService(db, {});
      const started = new Date(process.env.PCC_CHILD_NOW);
      const lease = await service.acquireLease(process.env.PCC_CHILD_PROJECT, started);
      if (!lease) throw new Error('child failed to acquire lease');
      await service.applyAction(lease, {
        idempotencyKey: process.env.PCC_CHILD_ACTION_KEY,
        type: 'OPEN_COORDINATOR_TURN',
        subject: { type: 'PROJECT', id: process.env.PCC_CHILD_PROJECT },
      }, async (tx, actionId) => {
        await tx.$executeRaw({
          text: 'INSERT INTO business_effect(action_key,action_id,project_id,marker) ' +
                'VALUES ($1,$2::uuid,$3::uuid,$4)',
          values: [process.env.PCC_CHILD_ACTION_KEY, actionId,
            process.env.PCC_CHILD_PROJECT, process.env.PCC_CHILD_MODE],
        });
        if (process.env.PCC_CHILD_MODE === 'BEFORE_COMMIT') {
          process.stdout.write('EFFECT_WRITTEN\n');
          await new Promise(() => {});
        }
      }, new Date(started.getTime() + 1_000));
      process.stdout.write('ACTION_COMMITTED\n');
      setInterval(() => {}, 1_000);
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  return spawn(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      PCC_CHILD_URL: URL!,
      PCC_CHILD_SCHEMA: SCHEMA,
      PCC_CHILD_PROJECT: PROJECT_PLANNING,
      PCC_CHILD_ACTION_KEY: actionKey,
      PCC_CHILD_MODE: mode,
      PCC_CHILD_NOW: now.toISOString(),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function killClaimant(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.kill('SIGKILL');
  await once(child, 'exit');
}

test('the recovery loop owns one unref timer and one initial pass, without a second clock', async () => {
  let registered: unknown;
  let unregistered = 0;
  let drains = 0;
  let cleared = 0;
  const eventService = {
    registerHandler: (handler: unknown) => {
      registered = handler;
      return () => { unregistered += 1; };
    },
    drainAvailable: async () => { drains += 1; return 0; },
  } as unknown as ProjectEventsService;
  const db = { $executeRaw: async () => 0 } as unknown as PrismaService;
  const service = new ProjectReconcileService(db, eventService);

  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const intervals: Array<{ delay: number; unref: number }> = [];
  const fakeTimer = { unref: () => { intervals[0].unref += 1; } };
  globalThis.setInterval = ((_callback: () => void, delayMs?: number) => {
    intervals.push({ delay: Number(delayMs), unref: 0 });
    return fakeTimer as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((_timer: ReturnType<typeof setInterval>) => {
    cleared += 1;
  }) as typeof clearInterval;

  try {
    service.onModuleInit();
    await waitImmediate();
    assert.equal(registered, service);
    assert.deepEqual(intervals, [{ delay: PROJECT_RECONCILE_TIMER_MS, unref: 1 }]);
    assert.equal(drains, 2);
    service.onModuleDestroy();
    assert.equal(cleared, 1);
    assert.equal(unregistered, 1);
  } finally {
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
  }
});

test('two service instances race, lease takeover advances the fence, and exactly one effect commits', {
  skip,
}, async () => {
  const a = await connect();
  const b = await connect();
  try {
    await reset(a);
    await useSchema(b);
    const serviceA = new ProjectReconcileService(prisma(a), noEvents());
    const serviceB = new ProjectReconcileService(prisma(b), noEvents());
    const started = new Date('2026-08-20T08:00:00.000Z');
    const [leaseA, leaseB] = await Promise.all([
      serviceA.acquireLease(PROJECT_PLANNING, started),
      serviceB.acquireLease(PROJECT_PLANNING, started),
    ]);
    assert.equal(Number(Boolean(leaseA)) + Number(Boolean(leaseB)), 1,
      'exactly one racing instance owns the lease');

    const winnerService = leaseA ? serviceA : serviceB;
    const loserService = leaseA ? serviceB : serviceA;
    const winnerLease = (leaseA ?? leaseB) as ProjectReconcileLease;
    assert.equal(winnerLease.fencingToken, 1n);

    const takeover = await loserService.acquireLease(
      PROJECT_PLANNING,
      new Date(started.getTime() + 60_001),
    );
    assert.ok(takeover);
    assert.equal(takeover.fencingToken, 2n);

    const key = `pc:v1:${PROJECT_PLANNING}:turn:race`;
    let staleEffectCalls = 0;
    await assert.rejects(
      winnerService.applyAction(winnerLease, {
        idempotencyKey: key,
        type: 'OPEN_COORDINATOR_TURN',
        subject: { type: 'PROJECT', id: PROJECT_PLANNING },
      }, async () => { staleEffectCalls += 1; }, new Date(started.getTime() + 60_002)),
      ProjectLeaseLostError,
    );
    assert.equal(staleEffectCalls, 0, 'the stale token cannot reach the action effect');

    const applied = await loserService.applyAction(takeover, {
      idempotencyKey: key,
      type: 'OPEN_COORDINATOR_TURN',
      subject: { type: 'PROJECT', id: PROJECT_PLANNING },
    }, (tx, actionId) => writeEffect(
      tx, actionId, key, PROJECT_PLANNING, 'takeover',
    ), new Date(started.getTime() + 60_003));
    assert.equal(applied.status, 'APPLIED');
    assert.equal(await loserService.releaseLease(takeover), true);

    const afterRestart = new ProjectReconcileService(prisma(a), noEvents());
    const thirdLease = await afterRestart.acquireLease(
      PROJECT_PLANNING,
      new Date(started.getTime() + 60_004),
    );
    assert.ok(thirdLease);
    assert.equal(thirdLease.fencingToken, 3n);
    let duplicateEffectCalls = 0;
    const duplicate = await afterRestart.applyAction(thirdLease, {
      idempotencyKey: key,
      type: 'OPEN_COORDINATOR_TURN',
      subject: { type: 'PROJECT', id: PROJECT_PLANNING },
    }, async () => { duplicateEffectCalls += 1; }, new Date(started.getTime() + 60_005));
    assert.equal(duplicate.status, 'ALREADY_APPLIED');
    assert.equal(duplicateEffectCalls, 0);
    assert.deepEqual((await a.query(`
      SELECT (SELECT count(*)::int FROM "project_action") actions,
             (SELECT count(*)::int FROM "business_effect") effects
    `)).rows[0], { actions: 1, effects: 1 });
  } finally {
    await a.end();
    await b.end();
  }
});

test('SIGKILL before the action commit rolls back both ledger key and effect, then takeover retries once', {
  skip,
}, async () => {
  const client = await connect();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await reset(client);
    const started = new Date();
    const key = `pc:v1:${PROJECT_PLANNING}:turn:killed-before-commit`;
    child = spawnActionClaimant('BEFORE_COMMIT', key, started);
    await waitForMarker(child, 'EFFECT_WRITTEN');
    await killClaimant(child);
    child = undefined;

    assert.deepEqual((await client.query(`
      SELECT (SELECT count(*)::int FROM "project_action") actions,
             (SELECT count(*)::int FROM "business_effect") effects
    `)).rows[0], { actions: 0, effects: 0 },
    'PostgreSQL must roll back the insert-first key and its partial effect together');

    const fresh = new ProjectReconcileService(prisma(client), noEvents());
    const lease = await fresh.acquireLease(
      PROJECT_PLANNING,
      new Date(started.getTime() + 60_001),
    );
    assert.ok(lease);
    const retried = await fresh.applyAction(lease, {
      idempotencyKey: key,
      type: 'OPEN_COORDINATOR_TURN',
      subject: { type: 'PROJECT', id: PROJECT_PLANNING },
    }, (tx, actionId) => writeEffect(
      tx, actionId, key, PROJECT_PLANNING, 'recovered-after-precommit-kill',
    ), new Date(started.getTime() + 60_002));
    assert.equal(retried.status, 'APPLIED');
    assert.deepEqual((await client.query(`
      SELECT (SELECT count(*)::int FROM "project_action") actions,
             (SELECT count(*)::int FROM "business_effect") effects
    `)).rows[0], { actions: 1, effects: 1 });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await killClaimant(child).catch(() => undefined);
    }
    await client.end();
  }
});

test('SIGKILL after the action commit preserves the ledger and suppresses the takeover retry effect', {
  skip,
}, async () => {
  const client = await connect();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await reset(client);
    const started = new Date();
    const key = `pc:v1:${PROJECT_PLANNING}:turn:killed-after-commit`;
    child = spawnActionClaimant('AFTER_COMMIT', key, started);
    await waitForMarker(child, 'ACTION_COMMITTED');
    await killClaimant(child);
    child = undefined;

    assert.deepEqual((await client.query(`
      SELECT (SELECT count(*)::int FROM "project_action") actions,
             (SELECT count(*)::int FROM "business_effect") effects
    `)).rows[0], { actions: 1, effects: 1 },
    'a post-COMMIT process death cannot erase the committed action');

    const fresh = new ProjectReconcileService(prisma(client), noEvents());
    const lease = await fresh.acquireLease(
      PROJECT_PLANNING,
      new Date(started.getTime() + 61_001),
    );
    assert.ok(lease);
    let duplicateEffectCalls = 0;
    const duplicate = await fresh.applyAction(lease, {
      idempotencyKey: key,
      type: 'OPEN_COORDINATOR_TURN',
      subject: { type: 'PROJECT', id: PROJECT_PLANNING },
    }, async () => { duplicateEffectCalls += 1; }, new Date(started.getTime() + 61_002));
    assert.equal(duplicate.status, 'ALREADY_APPLIED');
    assert.equal(duplicateEffectCalls, 0);
    assert.equal((await client.query(`SELECT count(*)::int n FROM "business_effect"`)).rows[0].n, 1);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await killClaimant(child).catch(() => undefined);
    }
    await client.end();
  }
});

test('a real PostgreSQL stop/start preserves pending events and nextWakeAt for a fresh service', {
  skip: skip || (!CONTAINER
    ? 'set COORDINATOR_PG_CONTAINER to inject a PostgreSQL stop/start'
    : false),
}, async () => {
  let client = await connect();
  let connected = true;
  try {
    await reset(client);
    const identityBefore = (await client.query(`
      SELECT (SELECT system_identifier::text FROM pg_control_system()) system_identifier
    `)).rows[0].system_identifier;
    await client.query(`
      INSERT INTO "task" ("id", "project_id", "status", "verifies_task_id")
      VALUES ($1, $2, 'OPEN', $3)
    `, [TASK_VERIFYING, PROJECT_VERIFYING, VERIFIED_TASK]);
    await client.query(`
      UPDATE "project" SET "coordinator_enabled" = false WHERE "id" IN ($1, $2)
    `, [PROJECT_EXECUTING, PROJECT_ERROR]);
    const producer = new ProjectEventsService(prisma(client));
    await enqueue(
      client,
      producer,
      PROJECT_PLANNING,
      SOURCE_PLANNING,
      `task.updated:${SOURCE_PLANNING}:before-db-stop`,
    );
    const due = new Date(Date.now() - 1_000);
    await client.query(`
      UPDATE "project_runtime"
         SET "next_wake_at" = $1, "next_wake_reason" = 'verification wake persisted before stop'
       WHERE "project_id" = $2
    `, [due, PROJECT_VERIFYING]);
    await client.end();
    connected = false;

    await execFileAsync('docker', ['stop', CONTAINER!], { timeout: 30_000 });
    await execFileAsync('docker', ['start', CONTAINER!], { timeout: 30_000 });
    client = await connectEventually();
    connected = true;
    await useSchema(client);
    const identityAfter = (await client.query(`
      SELECT (SELECT system_identifier::text FROM pg_control_system()) system_identifier
    `)).rows[0].system_identifier;
    assert.equal(identityAfter, identityBefore, 'the restarted server is the same isolated cluster');

    const events = new ProjectEventsService(prisma(client));
    const reconciler = new ProjectReconcileService(prisma(client), events);
    events.registerHandler(reconciler);
    const recoveredAt = new Date();
    await reconciler.tick(recoveredAt);

    const states = await client.query(`
      SELECT "project_id"::text project_id, "run_state", "next_wake_at" IS NOT NULL has_wake
        FROM "project_runtime"
       WHERE "project_id" IN ($1, $2)
       ORDER BY "project_id"
    `, [PROJECT_PLANNING, PROJECT_VERIFYING]);
    assert.deepEqual(states.rows, [
      { project_id: PROJECT_PLANNING, run_state: 'PLANNING', has_wake: true },
      { project_id: PROJECT_VERIFYING, run_state: 'AWAITING_VERIFICATION', has_wake: true },
    ]);
    assert.deepEqual((await client.query(`
      SELECT kind, disposition, count(*)::int n
        FROM "project_event" GROUP BY kind, disposition ORDER BY kind
    `)).rows, [
      { kind: 'task.updated', disposition: 'RECONCILED', n: 1 },
      { kind: 'timer.due', disposition: 'RECONCILED', n: 1 },
    ]);

    await reconciler.tick(recoveredAt);
    assert.equal((await client.query(`SELECT count(*)::int n FROM "project_event"`)).rows[0].n, 2,
      'restarting and immediately ticking again does not duplicate either wake');
  } finally {
    if (connected) await client.end();
  }
});

test('duplicate/out-of-order wakes converge within the liveness clock and one failing Project is isolated', {
  skip,
}, async () => {
  const client = await connect();
  try {
    await reset(client);
    await client.query(`
      INSERT INTO "task" ("id", "project_id", "status")
      VALUES ($1, $2, 'IN_PROGRESS')
    `, [TASK_EXECUTING, PROJECT_EXECUTING]);
    await client.query(`
      INSERT INTO "session" ("id", "task_id", "status")
      VALUES ($1, $2, 'RUNNING')
    `, [SESSION_EXECUTING, TASK_EXECUTING]);
    await client.query(`
      INSERT INTO "task" ("id", "project_id", "status", "verifies_task_id")
      VALUES ($1, $2, 'OPEN', $3)
    `, [TASK_VERIFYING, PROJECT_VERIFYING, VERIFIED_TASK]);
    const producer = new ProjectEventsService(prisma(client));
    const base = Date.now() - 10_000;
    await enqueue(client, producer, PROJECT_ERROR, SOURCE_ERROR,
      `task.updated:${SOURCE_ERROR}`, new Date(base));
    await enqueue(client, producer, PROJECT_PLANNING, SOURCE_PLANNING,
      `task.updated:${SOURCE_PLANNING}`, new Date(base + 3_000), 'task.newest');
    await enqueue(client, producer, PROJECT_PLANNING, SOURCE_PLANNING,
      `task.updated:${SOURCE_PLANNING}`, new Date(base + 1_000), 'task.stale');
    await enqueue(client, producer, PROJECT_EXECUTING, SOURCE_EXECUTING,
      `session.started:${SOURCE_EXECUTING}`, new Date(base + 2_000), 'session.started');
    await enqueue(client, producer, PROJECT_VERIFYING, SOURCE_VERIFYING,
      `task.updated:${SOURCE_VERIFYING}`, new Date(base + 4_000));

    const events = new ProjectEventsService(prisma(client));
    const reconciler = new ProjectReconcileService(prisma(client), events);
    const faultingHandler: ProjectEventHandler = {
      handle: (tx, projectId, batch) => {
        if (projectId === PROJECT_ERROR) throw new Error('injected Project-local reconcile fault');
        return reconciler.handle(tx, projectId, batch);
      },
      deadLetter: (tx, projectId, batch, error) =>
        reconciler.deadLetter(tx, projectId, batch, error),
    };
    events.registerHandler(faultingHandler);
    const drainAt = new Date();
    assert.equal((await events.drainOnce(drainAt)).status, 'RETRY_SCHEDULED');
    assert.equal((await events.drainOnce(drainAt)).status, 'CONSUMED');
    assert.equal((await events.drainOnce(drainAt)).status, 'CONSUMED');
    assert.equal((await events.drainOnce(drainAt)).status, 'CONSUMED');
    assert.equal((await events.drainOnce(drainAt)).status, 'IDLE');

    assert.deepEqual((await client.query(`
      SELECT "project_id"::text project_id, "run_state", "next_wake_at" IS NOT NULL has_wake
        FROM "project_runtime"
       WHERE "project_id" <> $1
       ORDER BY "project_id"
    `, [PROJECT_ERROR])).rows, [
      { project_id: PROJECT_PLANNING, run_state: 'PLANNING', has_wake: true },
      { project_id: PROJECT_EXECUTING, run_state: 'EXECUTING', has_wake: true },
      { project_id: PROJECT_VERIFYING, run_state: 'AWAITING_VERIFICATION', has_wake: true },
    ]);
    const wakeBounds = (await client.query(`
      SELECT min("next_wake_at") earliest, max("next_wake_at") latest
        FROM "project_runtime" WHERE "project_id" <> $1
    `, [PROJECT_ERROR])).rows[0];
    assert.ok(wakeBounds.earliest.getTime() >= drainAt.getTime() + 55_000);
    assert.ok(wakeBounds.latest.getTime() <= Date.now() + 65_000,
      'all healthy OPEN Projects retain a bounded recovery clock');

    assert.deepEqual((await client.query(`
      SELECT kind, occurrences FROM "project_event"
       WHERE "project_id" = $1 AND dedupe_key = $2
    `, [PROJECT_PLANNING, `task.updated:${SOURCE_PLANNING}`])).rows[0], {
      kind: 'task.newest',
      occurrences: 2,
    }, 'the newest envelope survives an older duplicate while current facts determine state');
    assert.deepEqual((await client.query(`
      SELECT attempts, consumed_at IS NULL pending
        FROM "project_event" WHERE "project_id" = $1
    `, [PROJECT_ERROR])).rows[0], { attempts: 1, pending: true });
    assert.equal((await client.query(`
      SELECT count(*)::int n FROM "project_event"
       WHERE "project_id" <> $1 AND "consumed_at" IS NULL
    `, [PROJECT_ERROR])).rows[0].n, 0,
    'a retrying Project does not block healthy Projects behind it');
  } finally {
    await client.end();
  }
});

test('a lost wake is rescued once by the backstop and repeated early ticks do not busy-loop', {
  skip,
}, async () => {
  const client = await connect();
  try {
    await reset(client);
    await client.query(`
      UPDATE "project" SET "coordinator_enabled" = false WHERE "id" <> $1
    `, [PROJECT_PLANNING]);
    await client.query(`
      UPDATE "project_runtime"
         SET "run_state" = 'PLANNING', "next_wake_at" = NULL,
             "next_wake_reason" = NULL, "lease_holder" = NULL,
             "lease_expires_at" = NULL, "lease_heartbeat_at" = NULL
       WHERE "project_id" = $1
    `, [PROJECT_PLANNING]);
    const events = new ProjectEventsService(prisma(client));
    const reconciler = new ProjectReconcileService(prisma(client), events);
    events.registerHandler(reconciler);
    const detectedAt = new Date();
    await reconciler.tick(detectedAt);

    assert.equal(reconciler.backstopHits, 1);
    assert.deepEqual((await client.query(`
      SELECT "run_state", "next_wake_reason", "next_wake_at" IS NOT NULL has_wake,
             round(extract(epoch FROM ("next_wake_at" - "updated_at")))::int wake_seconds
        FROM "project_runtime" WHERE "project_id" = $1
    `, [PROJECT_PLANNING])).rows[0], {
      run_state: 'PLANNING',
      next_wake_reason: 'planning requires coordinator turn',
      has_wake: true,
      wake_seconds: 60,
    });
    assert.deepEqual((await client.query(`
      SELECT kind, disposition, occurrences FROM "project_event"
    `)).rows, [{ kind: 'timer.backstop', disposition: 'RECONCILED', occurrences: 1 }]);

    for (let offset = 1; offset <= 25; offset += 1) {
      await reconciler.tick(new Date(detectedAt.getTime() + offset));
    }
    assert.equal(reconciler.backstopHits, 1);
    assert.equal((await client.query(`SELECT count(*)::int n FROM "project_event"`)).rows[0].n, 1,
      '25 early recovery passes neither create new work nor re-hit the backstop');
    assert.equal((await client.query(`SELECT count(*)::int n FROM "project_action"`)).rows[0].n, 0,
      'the recovery clock does not synthesize duplicate semantic actions');
  } finally {
    await client.end();
  }
});
