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
  PROJECT_TELEMETRY_RETENTION_MS,
} from './project-reconcile.service';

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc09_reconcile';
const PROJECT = '00000000-0000-7000-8000-000000000901';
const TASK = '00000000-0000-7000-8000-000000000902';
const VERIFIER = '00000000-0000-7000-8000-000000000903';
const SESSION = '00000000-0000-7000-8000-000000000904';
const SOURCE_A = '00000000-0000-7000-8000-000000000905';
const SOURCE_B = '00000000-0000-7000-8000-000000000906';
const LOAD_PROJECT = '00000000-0000-7000-8000-000000000907';
const IDLE_DECISION = '00000000-0000-7000-8000-000000000908';
const RECENT_DECISION = '00000000-0000-7000-8000-000000000909';
const BLOCKER_DECISION = '00000000-0000-7000-8000-000000000910';
const REFUSED_DECISION = '00000000-0000-7000-8000-000000000911';
const PLANNED_DECISION = '00000000-0000-7000-8000-000000000912';
const REFUSED_ACTION = '00000000-0000-7000-8000-000000000913';
const ACCEPTANCE_DECISION = '00000000-0000-7000-8000-000000000914';
const ACCEPTANCE_RUN = '00000000-0000-7000-8000-000000000915';

const OUTBOX = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0116_project_event_outbox/migration.sql'),
  'utf8',
);
const RECONCILE = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0119_project_reconcile_runtime/migration.sql'),
  'utf8',
);
const DECISION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0120_project_decision_audit/migration.sql'),
  'utf8',
);
const RETENTION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0151_project_telemetry_retention/migration.sql'),
  'utf8',
);
const DECISION_HASH = 'a'.repeat(64);

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
  await client.query(DECISION);
  await client.query(`
    CREATE TABLE "project_acceptance_run" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
      "decision_id" UUID,
      FOREIGN KEY ("decision_id", "project_id")
        REFERENCES "project_decision"("id", "project_id") ON DELETE NO ACTION
    )
  `);
  await client.query(RETENTION);
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

function idleDecisionInput(): Record<string, unknown> {
  return {
    v: 1,
    readAt: '2030-01-01T00:00:00.000Z',
    decisionInputHash: DECISION_HASH,
    world: {},
    evaluation: {},
    signals: [],
  };
}

function idleDecisionOutcome(): Record<string, unknown> {
  return {
    v: 1,
    decisionInputHash: DECISION_HASH,
    reason: 'in-flight session may end',
    runStateBefore: 'EXECUTING',
    runStateAfter: 'EXECUTING',
    actions: [],
    authorizations: [],
    blockersOpened: [],
    blockersCleared: [],
    blockers: { raised: [], touched: [], cleared: [], escalated: [], open: [] },
    coordinator: { status: 'HEALTHY' },
    aggregations: [],
    aggregationCycleTaskIds: [],
    turnReason: null,
    suppressedTurnReasons: [],
    detail: {
      wakeCandidates: [{ source: 5, reason: 'in-flight session may end' }],
      flooredBy: null,
    },
    nextWakeAt: '2030-01-01T00:01:00.000Z',
    nextWakeReason: 'in-flight session may end',
    consumedEventIds: ['timer-event'],
  };
}

async function insertDecision(
  client: Client,
  id: string,
  createdAt: Date,
  reason: string,
  outcome: Record<string, unknown>,
): Promise<void> {
  await client.query(`
    INSERT INTO "project_decision" (
      "id", "project_id", "input_version", "decision_input_hash", "decision_input",
      "outcome", "decided_by", "fencing_token", "reason", "created_at"
    ) VALUES ($1, $2, 1, $3, $4::jsonb, $5::jsonb, 'ORCHESTRATOR', 1, $6, $7)
  `, [id, PROJECT, DECISION_HASH, JSON.stringify(idleDecisionInput()), JSON.stringify(outcome),
    reason, createdAt]);
}

async function seedIdleTelemetry(
  client: Client,
  startedAt: Date,
  endedAt: Date,
): Promise<void> {
  await client.query(`
    INSERT INTO "project_event" (
      "id", "project_id", "kind", "occurred_at", "source_type", "source_id",
      "dedupe_key", "payload", "last_at", "consumed_at", "disposition"
    )
    SELECT gen_random_uuid(), p.id, 'timer.due', tick.at, 'TIMER', p.id,
           'timer.due:in-flight session may end',
           '{"reason":"in-flight session may end"}'::jsonb, tick.at, tick.at, 'RECONCILED'
      FROM (VALUES ($1::uuid), ($2::uuid)) AS p(id)
      CROSS JOIN generate_series($3::timestamp, $4::timestamp, interval '1 minute') AS tick(at)
  `, [PROJECT, LOAD_PROJECT, startedAt, endedAt]);
  await client.query(`
    INSERT INTO "project_decision" (
      "id", "project_id", "input_version", "decision_input_hash", "decision_input",
      "outcome", "decided_by", "fencing_token", "reason", "created_at"
    )
    SELECT gen_random_uuid(), p.id, 1, $3, $4::jsonb, $5::jsonb,
           'ORCHESTRATOR', 1, 'in-flight session may end', tick.at
      FROM (VALUES ($1::uuid), ($2::uuid)) AS p(id)
      CROSS JOIN generate_series($6::timestamp, $7::timestamp, interval '1 minute') AS tick(at)
  `, [PROJECT, LOAD_PROJECT, DECISION_HASH, JSON.stringify(idleDecisionInput()),
    JSON.stringify(idleDecisionOutcome()), startedAt, endedAt]);
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

test('a consumed stable-key timer wake cannot suppress the next real wake', { skip: !URL }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const db = prisma(client);
    const events = new ProjectEventsService(db);
    const reconciler = new ProjectReconcileService(db, events);
    events.registerHandler(reconciler);
    const first = new Date('2026-08-23T02:00:00.000Z');

    await client.query(`
      UPDATE "project_runtime"
         SET "run_state" = 'EXECUTING', "next_wake_at" = $1,
             "next_wake_reason" = 'in-flight session may end'
       WHERE "project_id" = $2
    `, [new Date(first.getTime() - 1_000), PROJECT]);
    await reconciler.tick(first);

    await client.query(`
      UPDATE "project_runtime"
         SET "run_state" = 'EXECUTING', "next_wake_at" = $1,
             "next_wake_reason" = 'in-flight session may end'
       WHERE "project_id" = $2
    `, [new Date(first.getTime() + 59_000), PROJECT]);
    await reconciler.tick(new Date(first.getTime() + 60_000));

    const wakes = (await client.query<{
      id: string;
      dedupe_key: string;
      consumed: boolean;
      disposition: string | null;
    }>(`
      SELECT "id"::text, "dedupe_key", "consumed_at" IS NOT NULL AS consumed, "disposition"
        FROM "project_event"
       WHERE "project_id" = $1 AND "kind" = 'timer.due'
       ORDER BY "occurred_at", "id"
    `, [PROJECT])).rows;
    assert.equal(wakes.length, 2,
      'the consumed row must be outside dedupe so the next due wake becomes a new row');
    assert.equal(new Set(wakes.map((wake) => wake.id)).size, 2);
    assert.deepEqual(new Set(wakes.map((wake) => wake.dedupe_key)),
      new Set(['timer.due:in-flight session may end']),
      'the pending key is stable for one unchanged wake reason');
    assert.ok(wakes.every((wake) => wake.consumed && wake.disposition === 'RECONCILED'),
      'both real wakes enter the queue and can be consumed');
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await client.end();
  }
});

test('pending timer wakes coalesce while the reason is unchanged and split when it changes',
  { skip: !URL }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const db = prisma(client);
      // No handler: the rows stay pending so this test isolates the partial unique index's
      // coalescing half from the consumed-row safety case above.
      const reconciler = new ProjectReconcileService(db, new ProjectEventsService(db));
      const first = new Date('2026-08-23T03:00:00.000Z');
      for (const [offset, reason] of [
        [0, 'in-flight session may end'],
        [10_000, 'in-flight session may end'],
        [20_000, 'task retry backoff expires'],
      ] as const) {
        const now = new Date(first.getTime() + offset);
        await client.query(`
          UPDATE "project_runtime"
             SET "run_state" = 'EXECUTING', "next_wake_at" = $1, "next_wake_reason" = $2
           WHERE "project_id" = $3
        `, [new Date(now.getTime() - 1), reason, PROJECT]);
        await reconciler.tick(now);
      }
      assert.deepEqual((await client.query<{
        dedupe_key: string;
        occurrences: number;
      }>(`
        SELECT "dedupe_key", "occurrences" FROM "project_event"
         WHERE "kind" = 'timer.due' ORDER BY "dedupe_key"
      `)).rows, [
        { dedupe_key: 'timer.due:in-flight session may end', occurrences: 2 },
        { dedupe_key: 'timer.due:task retry backoff expires', occurrences: 1 },
      ]);
      assert.equal((await client.query(`
        SELECT count(*)::int n FROM "project_event" WHERE "consumed_at" IS NOT NULL
      `)).rows[0].n, 0, 'coalescing never consumes or rewrites queue ownership');
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
      await client.end();
    }
  });

test('telemetry retention removes only old consumed idle rows and leaves pending bytes unchanged',
  { skip: !URL }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const now = new Date('2030-01-10T00:00:00.000Z');
      const old = new Date(now.getTime() - PROJECT_TELEMETRY_RETENTION_MS - 60_000);
      const recent = new Date(now.getTime() - PROJECT_TELEMETRY_RETENTION_MS + 60_000);
      await client.query(`
        INSERT INTO "project_event" (
          "id", "project_id", "kind", "occurred_at", "source_type", "source_id",
          "dedupe_key", "payload", "last_at", "attempts", "next_attempt_at",
          "consumed_at", "disposition"
        ) VALUES
          (gen_random_uuid(), $1, 'timer.due', $2, 'TIMER', $1, 'delete-idle', '{}', $2,
            0, NULL, $2, 'RECONCILED'),
          (gen_random_uuid(), $1, 'timer.due', $3, 'TIMER', $1, 'keep-recent', '{}', $3,
            0, NULL, $3, 'RECONCILED'),
          (gen_random_uuid(), $1, 'timer.due', $2, 'TIMER', $1, 'keep-pending',
            '{"pending":true}', $3, 3, $3, NULL, NULL),
          (gen_random_uuid(), $1, 'timer.due', $2, 'TIMER', $1, 'keep-dead', '{}', $2,
            10, NULL, $2, 'DEAD'),
          (gen_random_uuid(), $1, 'timer.backstop', $2, 'TIMER', $1, 'keep-backstop', '{}', $2,
            0, NULL, $2, 'RECONCILED'),
          (gen_random_uuid(), $1, 'blocker.escalated', $2, 'TIMER', $1, 'keep-blocker', '{}', $2,
            0, NULL, $2, 'RECONCILED'),
          (gen_random_uuid(), $1, 'task.updated', $2, 'TASK', $4, 'keep-task', '{}', $2,
            0, NULL, $2, 'RECONCILED')
      `, [PROJECT, old, recent, SOURCE_A]);
      const pendingBefore = (await client.query<{ row: unknown }>(`
        SELECT to_jsonb(e) AS row FROM "project_event" e WHERE "dedupe_key" = 'keep-pending'
      `)).rows[0].row;

      await insertDecision(client, IDLE_DECISION, old, 'in-flight session may end',
        idleDecisionOutcome());
      await insertDecision(client, RECENT_DECISION, recent, 'in-flight session may end',
        idleDecisionOutcome());
      const blockerOutcome = idleDecisionOutcome();
      (blockerOutcome.blockers as { open: unknown[] }).open = [{ id: 'open-blocker' }];
      await insertDecision(client, BLOCKER_DECISION, old, 'in-flight session may end',
        blockerOutcome);
      await insertDecision(client, REFUSED_DECISION, old, 'in-flight session may end',
        idleDecisionOutcome());
      const plannedOutcome = idleDecisionOutcome();
      plannedOutcome.actions = [{ type: 'OPEN_COORDINATOR_TURN' }];
      await insertDecision(client, PLANNED_DECISION, old, 'in-flight session may end',
        plannedOutcome);
      await insertDecision(client, ACCEPTANCE_DECISION, old, 'in-flight session may end',
        idleDecisionOutcome());
      await client.query(`
        INSERT INTO "project_action" (
          "id", "project_id", "idempotency_key", "type", "status", "subject_type",
          "fencing_token", "decision_id", "refusal_code", "created_at", "updated_at"
        ) VALUES ($1, $2, 'retention-refused-action', 'OPEN_COORDINATOR_TURN', 'REFUSED',
                  'PROJECT', 1, $3, 'TEST_REFUSAL', $4, $4)
      `, [REFUSED_ACTION, PROJECT, REFUSED_DECISION, old]);
      await client.query(`
        INSERT INTO "project_acceptance_run" ("id", "project_id", "decision_id")
        VALUES ($1, $2, $3)
      `, [ACCEPTANCE_RUN, PROJECT, ACCEPTANCE_DECISION]);

      const reconciler = new ProjectReconcileService(prisma(client), noEvents());
      assert.deepEqual(await reconciler.pruneTelemetry(now), { events: 1, decisions: 1 });

      const pendingAfter = (await client.query<{ row: unknown }>(`
        SELECT to_jsonb(e) AS row FROM "project_event" e WHERE "dedupe_key" = 'keep-pending'
      `)).rows[0].row;
      assert.deepEqual(pendingAfter, pendingBefore,
        'retention must not change one byte of a pending row');
      assert.deepEqual((await client.query<{ dedupe_key: string }>(`
        SELECT "dedupe_key" FROM "project_event" ORDER BY "dedupe_key"
      `)).rows.map((row) => row.dedupe_key), [
        'keep-backstop', 'keep-blocker', 'keep-dead', 'keep-pending', 'keep-recent', 'keep-task',
      ]);
      assert.deepEqual((await client.query<{ id: string }>(`
        SELECT "id"::text FROM "project_decision" ORDER BY "id"
      `)).rows.map((row) => row.id), [
        RECENT_DECISION, BLOCKER_DECISION, REFUSED_DECISION, PLANNED_DECISION,
        ACCEPTANCE_DECISION,
      ].sort());
      assert.equal((await client.query(`
        SELECT count(*)::int n FROM "project_action" WHERE "id" = $1
      `, [REFUSED_ACTION])).rows[0].n, 1, 'a refused action and its decision are immutable audit');
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
      await client.end();
    }
  });

test('48-hour retention turns a minute-pair load from linear growth into a bounded plateau',
  { skip: !URL }, async () => {
    const client = await connect();
    try {
      await reset(client);
      await client.query(`
        INSERT INTO "project" ("id") VALUES ($1)
      `, [LOAD_PROJECT]);
      await client.query(`
        INSERT INTO "project_runtime" ("project_id", "updated_at") VALUES ($1, CURRENT_TIMESTAMP)
      `, [LOAD_PROJECT]);
      const start = new Date('2035-01-01T00:00:00.000Z');
      const day = 24 * 60 * 60_000;
      const minute = 60_000;
      await seedIdleTelemetry(client, start, new Date(start.getTime() + 3 * day - minute));

      const count = async (): Promise<number> => Number((await client.query(`
        SELECT (SELECT count(*) FROM "project_event")
             + (SELECT count(*) FROM "project_decision") AS n
      `)).rows[0].n);
      const baselineRows = await count();
      const baselineGrowthPerDay = 2 * 1_440 * 2;
      assert.equal(baselineRows, baselineGrowthPerDay * 3);

      const reconciler = new ProjectReconcileService(prisma(client), noEvents());
      assert.deepEqual(await reconciler.pruneTelemetry(new Date(start.getTime() + 3 * day)),
        { events: 2_880, decisions: 2_880 });
      const plateauRows = await count();
      assert.equal(plateauRows, 11_520, 'two projects retain exactly two days of minute pairs');

      await seedIdleTelemetry(client, new Date(start.getTime() + 3 * day),
        new Date(start.getTime() + 4 * day - minute));
      assert.equal(await count(), plateauRows + baselineGrowthPerDay);
      assert.deepEqual(await reconciler.pruneTelemetry(new Date(start.getTime() + 4 * day)),
        { events: 2_880, decisions: 2_880 });
      const retainedGrowthPerDay = (await count()) - plateauRows;
      assert.equal(retainedGrowthPerDay, 0);
      console.log(`telemetry-growth before=${baselineGrowthPerDay} rows/day `
        + `after-steady-state=${retainedGrowthPerDay} rows/day `
        + 'load=2-projects*1-event+1-decision/minute');
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
      await client.end();
    }
  });
