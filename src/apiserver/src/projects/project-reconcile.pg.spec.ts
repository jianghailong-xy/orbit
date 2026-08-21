import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import type { Client, QueryResult } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectEventsService } from './project-events.service';
import {
  ProjectLeaseLostError,
  ProjectReconcileService,
} from './project-reconcile.service';

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc09_reconcile';
const PROJECT = '00000000-0000-7000-8000-000000000901';
const TASK = '00000000-0000-7000-8000-000000000902';
const VERIFIER = '00000000-0000-7000-8000-000000000903';
const SESSION = '00000000-0000-7000-8000-000000000904';
const SOURCE_A = '00000000-0000-7000-8000-000000000905';
const SOURCE_B = '00000000-0000-7000-8000-000000000906';

const OUTBOX = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0116_project_event_outbox/migration.sql'),
  'utf8',
);
const RECONCILE = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0119_project_reconcile_runtime/migration.sql'),
  'utf8',
);

type ClientCtor = new (config: { connectionString?: string; connectionTimeoutMillis?: number }) => Client;
type Tx = Prisma.TransactionClient;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
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

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
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
    -- §10.2 W4 (ii)/(iii): the backstop reads open blockers to tell "waiting on a person who has
    -- already been told" — the one shape §10.4 N-null lets stop its own clock — apart from a
    -- stopped clock with nothing behind it. Unit 17's table landed after this subset was written;
    -- these are the four columns that predicate reads.
    CREATE TABLE "project_blocker" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
      "recovery" TEXT NOT NULL,
      "escalated_at" TIMESTAMP(3),
      "resolved_at" TIMESTAMP(3)
    );
    INSERT INTO "project" ("id") VALUES ('${PROJECT}');
    INSERT INTO "project_runtime" ("project_id", "updated_at")
      VALUES ('${PROJECT}', CURRENT_TIMESTAMP);
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
      "action_id" UUID NOT NULL
    );
  `);
}

async function useSchema(client: Client): Promise<void> {
  await client.query(`SET search_path TO ${SCHEMA}`);
}

function noEvents(): ProjectEventsService {
  return {} as ProjectEventsService;
}

test('lease fencing, action idempotency and recovery converge on real PostgreSQL', { skip: !URL }, async () => {
  const a = await connect();
  const b = await connect();
  try {
    await reset(a);
    await useSchema(b);
    const dbA = prisma(a);
    const dbB = prisma(b);
    const serviceA = new ProjectReconcileService(dbA, noEvents());
    const serviceB = new ProjectReconcileService(dbB, noEvents());
    const started = new Date();

    const leaseA = await serviceA.acquireLease(PROJECT, started);
    assert.ok(leaseA);
    assert.equal(leaseA.fencingToken, 1n);
    assert.equal(await serviceB.acquireLease(PROJECT, new Date(started.getTime() + 1_000)), null,
      'a second instance cannot acquire an unexpired lease');

    const leaseB = await serviceB.acquireLease(PROJECT, new Date(started.getTime() + 61_000));
    assert.ok(leaseB);
    assert.equal(leaseB.fencingToken, 2n, 'takeover monotonically advances the fence');
    const firstKey = `pc:v1:${PROJECT}:turn:0:initial`;
    let staleEffectCalls = 0;
    await assert.rejects(
      serviceA.applyAction(leaseA, {
        idempotencyKey: firstKey,
        type: 'OPEN_COORDINATOR_TURN',
        subject: { type: 'PROJECT', id: PROJECT },
      }, async () => { staleEffectCalls += 1; }, new Date(started.getTime() + 62_000)),
      ProjectLeaseLostError,
    );
    assert.equal(staleEffectCalls, 0, 'an expired holder cannot reach its effect');

    const applied = await serviceB.applyAction(leaseB, {
      idempotencyKey: firstKey,
      type: 'OPEN_COORDINATOR_TURN',
      subject: { type: 'PROJECT', id: PROJECT },
    }, async (tx, actionId) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "business_effect" ("action_key", "action_id")
        VALUES (${firstKey}, ${actionId}::uuid)
      `);
    }, new Date(started.getTime() + 62_000));
    assert.equal(applied.status, 'APPLIED');
    assert.equal(await serviceB.releaseLease(leaseB), true);

    // A new process acquires a new token but the permanent key still suppresses the effect.
    const serviceAfterRestart = new ProjectReconcileService(dbA, noEvents());
    const restartedLease = await serviceAfterRestart.acquireLease(
      PROJECT,
      new Date(started.getTime() + 63_000),
    );
    assert.ok(restartedLease);
    assert.equal(restartedLease.fencingToken, 3n);
    let restartedEffectCalls = 0;
    const duplicate = await serviceAfterRestart.applyAction(restartedLease, {
      idempotencyKey: firstKey,
      type: 'OPEN_COORDINATOR_TURN',
      subject: { type: 'PROJECT', id: PROJECT },
    }, async () => { restartedEffectCalls += 1; }, new Date(started.getTime() + 64_000));
    assert.equal(duplicate.status, 'ALREADY_APPLIED');
    assert.equal(restartedEffectCalls, 0);

    // A failed attempt rolls back both key and effect; retrying the same key applies exactly once.
    const retryKey = `pc:v1:${PROJECT}:turn:0:retry`;
    await assert.rejects(
      serviceAfterRestart.applyAction(restartedLease, {
        idempotencyKey: retryKey,
        type: 'OPEN_COORDINATOR_TURN',
        subject: { type: 'PROJECT', id: PROJECT },
      }, async (tx, actionId) => {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "business_effect" ("action_key", "action_id")
          VALUES (${retryKey}, ${actionId}::uuid)
        `);
        throw new Error('injected crash before commit');
      }, new Date(started.getTime() + 65_000)),
      /injected crash/,
    );
    assert.equal((await a.query(
      `SELECT count(*)::int n FROM "project_action" WHERE "idempotency_key" = $1`,
      [retryKey],
    )).rows[0].n, 0);
    assert.equal((await a.query(
      `SELECT count(*)::int n FROM "business_effect" WHERE "action_key" = $1`,
      [retryKey],
    )).rows[0].n, 0);

    const retried = await serviceAfterRestart.applyAction(restartedLease, {
      idempotencyKey: retryKey,
      type: 'OPEN_COORDINATOR_TURN',
      subject: { type: 'PROJECT', id: PROJECT },
    }, async (tx, actionId) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "business_effect" ("action_key", "action_id")
        VALUES (${retryKey}, ${actionId}::uuid)
      `);
    }, new Date(started.getTime() + 66_000));
    assert.equal(retried.status, 'APPLIED');
    assert.deepEqual((await a.query(`
      SELECT (SELECT count(*)::int FROM "project_action") AS actions,
             (SELECT count(*)::int FROM "business_effect") AS effects
    `)).rows[0], { actions: 2, effects: 2 });
    assert.equal(await serviceAfterRestart.releaseLease(restartedLease), true);

    // Event contention persists a retry instead of consuming or spinning. Once the holder expires,
    // a fresh service re-reads current facts and converges independently of delivery order.
    const events = new ProjectEventsService(dbA);
    const reconciler = new ProjectReconcileService(dbA, events);
    const unregister = events.registerHandler(reconciler);
    const foreignLease = await serviceB.acquireLease(PROJECT, new Date());
    assert.ok(foreignLease);
    await dbA.$transaction(async (tx) => {
      await events.enqueue(tx, {
        projectId: PROJECT,
        kind: 'task.updated',
        source: { type: 'TASK', id: SOURCE_A },
        dedupeKey: `task.updated:${SOURCE_A}`,
      });
    });
    const deferred = await events.drainOnce(new Date());
    assert.equal(deferred.status, 'DEFERRED');
    assert.deepEqual((await a.query(`
      SELECT "consumed_at" IS NULL AS pending, "next_attempt_at" IS NOT NULL AS scheduled
        FROM "project_event" WHERE "dedupe_key" = $1
    `, [`task.updated:${SOURCE_A}`])).rows[0], { pending: true, scheduled: true });

    const expired = new Date(Date.now() - 1_000);
    await a.query(`
      UPDATE "project_runtime"
         SET "lease_heartbeat_at" = $1, "lease_expires_at" = $2
       WHERE "project_id" = $3
    `, [new Date(expired.getTime() - 1_000), expired, PROJECT]);
    await a.query(`UPDATE "project_event" SET "next_attempt_at" = $1 WHERE "consumed_at" IS NULL`, [expired]);
    unregister();
    const restartedEvents = new ProjectEventsService(dbA);
    const restartedReconciler = new ProjectReconcileService(dbA, restartedEvents);
    restartedEvents.registerHandler(restartedReconciler);
    assert.equal((await restartedEvents.drainOnce(new Date())).status, 'CONSUMED');
    let runtime = (await a.query(`
      SELECT "run_state", "next_wake_at" IS NOT NULL AS has_wake
        FROM "project_runtime" WHERE "project_id" = $1
    `, [PROJECT])).rows[0];
    assert.deepEqual(runtime, { run_state: 'PLANNING', has_wake: true });

    await a.query(
      `INSERT INTO "task" ("id", "project_id", "status") VALUES ($1, $2, 'IN_PROGRESS')`,
      [TASK, PROJECT],
    );
    await a.query(
      `INSERT INTO "session" ("id", "task_id", "status") VALUES ($1, $2, 'RUNNING')`,
      [SESSION, TASK],
    );
    const occurred = Date.now();
    await dbA.$transaction(async (tx) => {
      await restartedEvents.enqueue(tx, {
        projectId: PROJECT,
        kind: 'session.started',
        source: { type: 'SESSION', id: SESSION },
        dedupeKey: `session.started:${SESSION}`,
        occurredAt: new Date(occurred + 2_000),
      });
      await restartedEvents.enqueue(tx, {
        projectId: PROJECT,
        kind: 'task.updated',
        source: { type: 'TASK', id: SOURCE_B },
        dedupeKey: `task.updated:${SOURCE_B}`,
        occurredAt: new Date(occurred),
      });
      await restartedEvents.enqueue(tx, {
        projectId: PROJECT,
        kind: 'task.updated',
        source: { type: 'TASK', id: SOURCE_B },
        dedupeKey: `task.updated:${SOURCE_B}`,
        occurredAt: new Date(occurred + 1_000),
      });
    });
    assert.equal((await restartedEvents.drainOnce(new Date(occurred + 3_000))).status, 'CONSUMED');
    runtime = (await a.query(`
      SELECT "run_state", "next_wake_at" IS NOT NULL AS has_wake
        FROM "project_runtime" WHERE "project_id" = $1
    `, [PROJECT])).rows[0];
    assert.deepEqual(runtime, { run_state: 'EXECUTING', has_wake: true });
    assert.equal((await a.query(`
      SELECT "occurrences" FROM "project_event" WHERE "dedupe_key" = $1
      ORDER BY "occurred_at" DESC LIMIT 1
    `, [`task.updated:${SOURCE_B}`])).rows[0].occurrences, 2);

    await a.query(`UPDATE "session" SET "status" = 'SUCCEEDED' WHERE "id" = $1`, [SESSION]);
    await a.query(`
      INSERT INTO "task" ("id", "project_id", "status", "verifies_task_id")
      VALUES ($1, $2, 'OPEN', $3)
    `, [VERIFIER, PROJECT, TASK]);
    await dbA.$transaction(async (tx) => {
      // Same producer key after its previous row was consumed is a new signal, while reconciliation
      // still converges from current facts rather than replaying the old envelope.
      await restartedEvents.enqueue(tx, {
        projectId: PROJECT,
        kind: 'task.updated',
        source: { type: 'TASK', id: SOURCE_B },
        dedupeKey: `task.updated:${SOURCE_B}`,
        occurredAt: new Date(occurred - 5_000),
      });
    });
    assert.equal((await restartedEvents.drainOnce(new Date(occurred + 4_000))).status, 'CONSUMED');
    runtime = (await a.query(`
      SELECT "run_state", "next_wake_at" IS NOT NULL AS has_wake
        FROM "project_runtime" WHERE "project_id" = $1
    `, [PROJECT])).rows[0];
    assert.deepEqual(runtime, { run_state: 'AWAITING_VERIFICATION', has_wake: true });
    assert.equal((await a.query(`
      SELECT count(*)::int n FROM "project_event" WHERE "consumed_at" IS NULL
    `)).rows[0].n, 0, 'all duplicate/out-of-order wakes eventually settle');

    const timerNow = new Date();
    await a.query(`
      UPDATE "project_runtime" SET "next_wake_at" = $1, "next_wake_reason" = 'test due wake'
       WHERE "project_id" = $2
    `, [new Date(timerNow.getTime() - 1_000), PROJECT]);
    await restartedReconciler.tick(timerNow);
    assert.equal((await a.query(`
      SELECT count(*)::int n FROM "project_event"
       WHERE "kind" = 'timer.due' AND "consumed_at" IS NOT NULL
    `)).rows[0].n, 1, 'the shared recovery timer materializes and consumes a due wake');

    await a.query(`
      UPDATE "project_runtime" SET "next_wake_at" = NULL, "next_wake_reason" = NULL
       WHERE "project_id" = $1
    `, [PROJECT]);
    await restartedReconciler.tick(new Date(timerNow.getTime() + 61_000));
    assert.equal(restartedReconciler.backstopHits, 1);
    assert.equal((await a.query(`
      SELECT count(*)::int n FROM "project_event"
       WHERE "kind" = 'timer.backstop' AND "consumed_at" IS NOT NULL
    `)).rows[0].n, 1, 'the same timer rescues a Project whose recovery clock disappeared');
  } finally {
    await a.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await a.end();
    await b.end();
  }
});
