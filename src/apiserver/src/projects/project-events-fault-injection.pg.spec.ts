import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Client, QueryResult } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  ProjectEventsService,
} from './project-events.service';
import type {
  EnqueueProjectEvent,
  ProjectEventHandler,
} from './project-events.service';

const URL = process.env.COORDINATOR_PG_URL;
const CONTAINER = process.env.COORDINATOR_PG_CONTAINER;
const SCHEMA = 'pcc08_event_faults';
const ROLLING_SCHEMA = 'pcc08_event_rolling';
const OWNER = '00000000-0000-7000-8000-000000000801';
const PROJECT_A = '00000000-0000-7000-8000-000000000802';
const PROJECT_B = '00000000-0000-7000-8000-000000000803';
const SOURCE_A = '00000000-0000-7000-8000-000000000804';
const SOURCE_B = '00000000-0000-7000-8000-000000000805';

const OUTBOX = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0116_project_event_outbox/migration.sql'),
  'utf8',
);
const BUSINESS_SOURCES = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0117_project_event_sources/migration.sql'),
  'utf8',
);
const AVAILABILITY_SOURCES = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0118_project_availability_event_sources/migration.sql'),
  'utf8',
);

type ClientCtor = new (config: { connectionString?: string; connectionTimeoutMillis?: number }) => Client;
type Tx = Prisma.TransactionClient;
const execFileAsync = promisify(execFile);

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

function sqlResult<T>(result: QueryResult): T[] {
  return result.rows as T[];
}

function transactionClient(client: Client): Tx {
  return {
    $queryRaw: async (query: Prisma.Sql) => sqlResult(await client.query(query.text, query.values)),
    $executeRaw: async (query: Prisma.Sql) =>
      (await client.query(query.text, query.values)).rowCount ?? 0,
    $executeRawUnsafe: async (query: string, ...values: unknown[]) =>
      (await client.query(query, values)).rowCount ?? 0,
  } as unknown as Tx;
}

function prisma(client: Client): PrismaService {
  return {
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

async function inTransaction<T>(client: Client, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma(client).$transaction(fn) as Promise<T>;
}

async function useSchema(client: Client, schema = SCHEMA): Promise<void> {
  await client.query(`SET search_path TO ${schema}`);
}

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await useSchema(client);
  await client.query(`
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "coordinator_enabled" BOOLEAN NOT NULL DEFAULT true
    );
    INSERT INTO "project" ("id") VALUES ('${PROJECT_A}'), ('${PROJECT_B}');
    CREATE TABLE "business_state" (
      "project_id" UUID PRIMARY KEY REFERENCES "project"("id"),
      "revision" INTEGER NOT NULL,
      "desired" TEXT NOT NULL
    );
    CREATE TABLE "reconcile_projection" (
      "project_id" UUID PRIMARY KEY REFERENCES "project"("id"),
      "revision" INTEGER NOT NULL,
      "desired" TEXT NOT NULL
    );
    CREATE TABLE "delivery_effect" (
      "action_key" TEXT PRIMARY KEY,
      "project_id" UUID NOT NULL REFERENCES "project"("id"),
      "revision" INTEGER NOT NULL
    );
    CREATE TABLE "dead_letter" (
      "event_id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL,
      "error" TEXT NOT NULL
    );
  `);
  await client.query(OUTBOX);
}

function input(projectId: string, sourceId: string, over: Partial<EnqueueProjectEvent> = {}): EnqueueProjectEvent {
  return {
    projectId,
    kind: 'task.updated',
    source: { type: 'TASK', id: sourceId },
    dedupeKey: `task.updated:${sourceId}`,
    payload: {},
    ...over,
  };
}

function convergingHandler(): ProjectEventHandler {
  return {
    handle: async (tx, projectId) => {
      const state = (await tx.$queryRaw<Array<{ revision: number; desired: string }>>(Prisma.sql`
        SELECT "revision", "desired" FROM "business_state"
         WHERE "project_id" = ${projectId}::uuid
      `))[0];
      assert.ok(state, `missing current state for ${projectId}`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "reconcile_projection" ("project_id", "revision", "desired")
        VALUES (${projectId}::uuid, ${state.revision}, ${state.desired})
        ON CONFLICT ("project_id") DO UPDATE SET
          "revision" = EXCLUDED."revision", "desired" = EXCLUDED."desired"
        WHERE EXCLUDED."revision" >= "reconcile_projection"."revision"
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "delivery_effect" ("action_key", "project_id", "revision")
        VALUES (${`${projectId}:${state.revision}`}, ${projectId}::uuid, ${state.revision})
        ON CONFLICT ("action_key") DO NOTHING
      `);
    },
    deadLetter: async (tx, projectId, events, error) => {
      for (const event of events) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "dead_letter" ("event_id", "project_id", "error")
          VALUES (${event.id}::uuid, ${projectId}::uuid, ${error})
          ON CONFLICT ("event_id") DO NOTHING
        `);
      }
    },
  };
}

async function waitForClaim(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!settled && stdout.includes('CLAIMED')) {
        settled = true;
        resolve();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('exit', (code, signal) => {
      if (!settled) reject(new Error(`claimant exited before claim: code=${code} signal=${signal} ${stderr}`));
    });
    child.once('error', reject);
  });
}

async function resetRolling(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${ROLLING_SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${ROLLING_SCHEMA}`);
  await useSchema(client, ROLLING_SCHEMA);
  await client.query(`
    CREATE TABLE "runner" (
      "id" UUID PRIMARY KEY, "owner_id" UUID NOT NULL, "status" TEXT NOT NULL DEFAULT 'OFFLINE',
      "last_heartbeat_at" TIMESTAMP(3), "labels" TEXT[] NOT NULL DEFAULT '{}',
      "max_concurrent" INTEGER NOT NULL DEFAULT 1, "min_free_disk_mb" INTEGER,
      "plan_usage" JSONB, "model_catalog" JSONB, "runtime_default_models" JSONB,
      "runs_as_root" BOOLEAN, "engines" JSONB
    );
    CREATE TABLE "workspace" (
      "id" UUID PRIMARY KEY, "runner_id" UUID REFERENCES "runner"("id"),
      "enabled" BOOLEAN NOT NULL DEFAULT true, "deleted_at" TIMESTAMP(3),
      "work_dir_exists" BOOLEAN, "work_dir_free_bytes" BIGINT
    );
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY, "owner_id" UUID NOT NULL, "title" TEXT NOT NULL,
      "goal" TEXT, "acceptance_criteria" TEXT, "instructions" TEXT,
      "status" TEXT NOT NULL DEFAULT 'OPEN', "coordinator_session_id" UUID,
      "coordinator_workspace_id" UUID, "coordinator_enabled" BOOLEAN NOT NULL DEFAULT true,
      "automation_policy" TEXT NOT NULL DEFAULT 'GUARDED_AUTO',
      "max_concurrent_tasks" INTEGER NOT NULL DEFAULT 3, "session_budget_per_day" INTEGER,
      "config_revision" BIGINT NOT NULL DEFAULT 0,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "project_member" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "project_id" UUID NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
      "agent_id" UUID NOT NULL REFERENCES "workspace"("id"), UNIQUE ("project_id", "agent_id")
    );
    CREATE TABLE "task" (
      "id" UUID PRIMARY KEY, "title" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'OPEN',
      "project_id" UUID REFERENCES "project"("id"),
      "parent_task_id" UUID REFERENCES "task"("id") ON DELETE SET NULL,
      "assignee_id" UUID REFERENCES "workspace"("id"), "provider" TEXT,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "task_dependency" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "task_id" UUID NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
      "depends_on_task_id" UUID NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
      UNIQUE ("task_id", "depends_on_task_id")
    );
    CREATE TABLE "session" (
      "id" UUID PRIMARY KEY, "owner_id" UUID NOT NULL,
      "task_id" UUID REFERENCES "task"("id") ON DELETE SET NULL,
      "workspace_id" UUID REFERENCES "workspace"("id"), "provider" TEXT,
      "status" TEXT NOT NULL DEFAULT 'PENDING', "batch_id" UUID,
      "merge_status" TEXT, "merge_error" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "approval" (
      "id" UUID PRIMARY KEY, "session_id" UUID NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
      "status" TEXT NOT NULL DEFAULT 'PENDING', "decided_by_id" UUID
    );
    CREATE TABLE "model_provider" (
      "id" UUID PRIMARY KEY, "slug" TEXT NOT NULL UNIQUE, "owner_id" UUID,
      "enabled" BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE "business_state" (
      "project_id" UUID PRIMARY KEY REFERENCES "project"("id"),
      "revision" INTEGER NOT NULL, "desired" TEXT NOT NULL
    );
    CREATE TABLE "reconcile_projection" (
      "project_id" UUID PRIMARY KEY REFERENCES "project"("id"),
      "revision" INTEGER NOT NULL, "desired" TEXT NOT NULL
    );
    CREATE TABLE "delivery_effect" (
      "action_key" TEXT PRIMARY KEY, "project_id" UUID NOT NULL REFERENCES "project"("id"),
      "revision" INTEGER NOT NULL
    );
    CREATE TABLE "dead_letter" (
      "event_id" UUID PRIMARY KEY, "project_id" UUID NOT NULL, "error" TEXT NOT NULL
    );
    INSERT INTO "project" ("id", "owner_id", "title") VALUES ('${PROJECT_A}', '${OWNER}', 'rolling');
    INSERT INTO "business_state" ("project_id", "revision", "desired")
      VALUES ('${PROJECT_A}', 11, 'after-upgrade');
  `);
  await client.query(OUTBOX);
}

const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

test('out-of-order, duplicate and future-version signals converge per Project without duplicate effects', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await client.query(`
      INSERT INTO "business_state" ("project_id", "revision", "desired") VALUES
        ($1, 3, 'A-current'), ($2, 7, 'B-current')
    `, [PROJECT_A, PROJECT_B]);
    const events = new ProjectEventsService(prisma(client));
    const t1 = new Date('2026-08-20T01:00:00.000Z');
    const t2 = new Date('2026-08-20T02:00:00.000Z');
    const t3 = new Date('2026-08-20T03:00:00.000Z');

    await inTransaction(client, (tx) => events.enqueue(tx, input(PROJECT_A, SOURCE_A, {
      v: 3, kind: 'task.v3', occurredAt: t3, payload: { claimedRevision: 3 },
    })));
    await inTransaction(client, (tx) => events.enqueue(tx, input(PROJECT_A, SOURCE_A, {
      v: 1, kind: 'task.v1', occurredAt: t1, payload: { claimedRevision: 1 },
    })));
    await inTransaction(client, (tx) => events.enqueue(tx, input(PROJECT_A, SOURCE_A, {
      v: 2, kind: 'task.v2', occurredAt: t2, payload: { claimedRevision: 2 },
    })));
    await inTransaction(client, (tx) => events.enqueue(tx, input(PROJECT_B, SOURCE_B, {
      v: 99, kind: 'future.unknown', occurredAt: t1,
      payload: { wrongProjectHint: PROJECT_A, claimedRevision: -1 },
    })));

    const pending = (await client.query(`
      SELECT v, kind, occurrences, last_at FROM "project_event" WHERE "project_id"=$1
    `, [PROJECT_A])).rows[0];
    assert.equal(pending.v, 3);
    assert.equal(pending.kind, 'task.v3');
    assert.equal(pending.occurrences, 3);
    assert.equal(pending.last_at.toISOString(), t3.toISOString());

    events.registerHandler(convergingHandler());
    assert.equal((await events.drainOnce(t3)).status, 'CONSUMED');
    assert.equal((await events.drainOnce(t3)).status, 'CONSUMED');
    assert.equal((await events.drainOnce(t3)).status, 'IDLE');

    const projections = (await client.query(`
      SELECT project_id::text, revision, desired FROM "reconcile_projection" ORDER BY project_id
    `)).rows;
    assert.deepEqual(projections, [
      { project_id: PROJECT_A, revision: 3, desired: 'A-current' },
      { project_id: PROJECT_B, revision: 7, desired: 'B-current' },
    ], 'payload hints and delivery order never cross Project boundaries');
    assert.equal((await client.query(`SELECT count(*)::int n FROM "delivery_effect"`)).rows[0].n, 2);

    await inTransaction(client, (tx) => events.enqueue(tx, input(PROJECT_A, SOURCE_A, {
      v: 1, kind: 'old.redelivery', occurredAt: t1,
    })));
    assert.equal((await events.drainOnce(t3)).status, 'CONSUMED');
    assert.equal((await client.query(`
      SELECT count(*)::int n FROM "delivery_effect" WHERE "project_id"=$1
    `, [PROJECT_A])).rows[0].n, 1, 'redelivery does not repeat the revision side effect');

    await client.query(`UPDATE "business_state" SET revision=4, desired='A-final' WHERE project_id=$1`, [PROJECT_A]);
    await inTransaction(client, (tx) => events.enqueue(tx, input(PROJECT_A, SOURCE_A, {
      v: 1, kind: 'legacy.writer', occurredAt: t2,
    })));
    assert.equal((await events.drainOnce(t3)).status, 'CONSUMED');
    assert.deepEqual((await client.query(`
      SELECT revision, desired FROM "reconcile_projection" WHERE project_id=$1
    `, [PROJECT_A])).rows[0], { revision: 4, desired: 'A-final' });
  } finally {
    await client.end();
  }
});

test('concurrent claimants serialize and exactly one commits the Project side effect', { skip }, async () => {
  const firstClient = await connect();
  const secondClient = await connect();
  try {
    await reset(firstClient);
    await useSchema(secondClient);
    await firstClient.query(`INSERT INTO "business_state" VALUES ($1, 1, 'claimed-once')`, [PROJECT_A]);
    const producer = new ProjectEventsService(prisma(firstClient));
    await inTransaction(firstClient, (tx) => producer.enqueue(tx, input(PROJECT_A, SOURCE_A)));

    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const base = convergingHandler();
    const handler: ProjectEventHandler = {
      ...base,
      handle: async (tx, projectId, batch) => {
        calls += 1;
        entered();
        await releasePromise;
        await base.handle(tx, projectId, batch);
      },
    };
    const first = new ProjectEventsService(prisma(firstClient));
    const second = new ProjectEventsService(prisma(secondClient));
    first.registerHandler(handler);
    second.registerHandler(handler);

    const winner = first.drainOnce();
    await enteredPromise;
    assert.equal((await second.drainOnce()).status, 'IDLE');
    release();
    assert.equal((await winner).status, 'CONSUMED');
    assert.equal(calls, 1);
    assert.equal((await firstClient.query(`SELECT count(*)::int n FROM "delivery_effect"`)).rows[0].n, 1);
  } finally {
    await firstClient.end();
    await secondClient.end();
  }
});

test('SIGKILL of a claimant rolls back its partial effect and a fresh process recovers the durable event', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await client.query(`INSERT INTO "business_state" VALUES ($1, 1, 'after-crash')`, [PROJECT_A]);
    const producer = new ProjectEventsService(prisma(client));
    await inTransaction(client, (tx) => producer.enqueue(tx, input(PROJECT_A, SOURCE_A)));

    const script = String.raw`
      const { Client } = require('pg');
      (async () => {
        const client = new Client({ connectionString: process.env.PCC_CHILD_URL });
        await client.connect();
        await client.query('SET search_path TO ' + process.env.PCC_CHILD_SCHEMA);
        await client.query('BEGIN');
        const claimed = await client.query(
          'SELECT p.id FROM project p WHERE p.id=$1 AND EXISTS (' +
          'SELECT 1 FROM project_event e WHERE e.project_id=p.id AND e.consumed_at IS NULL' +
          ') FOR NO KEY UPDATE OF p SKIP LOCKED', [process.env.PCC_CHILD_PROJECT]);
        if (claimed.rowCount !== 1) throw new Error('failed to claim Project');
        await client.query(
          'SELECT id FROM project_event WHERE project_id=$1 AND consumed_at IS NULL FOR UPDATE',
          [process.env.PCC_CHILD_PROJECT]);
        await client.query(
          'INSERT INTO delivery_effect(action_key,project_id,revision) VALUES ($1,$2,0)',
          ['uncommitted-crash-effect', process.env.PCC_CHILD_PROJECT]);
        process.stdout.write('CLAIMED\\n');
        setInterval(() => {}, 1000);
      })().catch((error) => { console.error(error); process.exit(1); });
    `;
    const child = spawn(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        PCC_CHILD_URL: URL!,
        PCC_CHILD_SCHEMA: SCHEMA,
        PCC_CHILD_PROJECT: PROJECT_A,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await waitForClaim(child);
    child.kill('SIGKILL');
    await once(child, 'exit');

    assert.equal((await client.query(`SELECT count(*)::int n FROM "delivery_effect"`)).rows[0].n, 0,
      'the killed transaction must not leak its partial side effect');
    assert.equal((await client.query(`
      SELECT count(*)::int n FROM "project_event" WHERE consumed_at IS NULL
    `)).rows[0].n, 1, 'the signal must remain pending after claimant death');

    const restarted = new ProjectEventsService(prisma(client));
    restarted.registerHandler(convergingHandler());
    assert.equal((await restarted.drainOnce()).status, 'CONSUMED');
    assert.equal((await client.query(`SELECT count(*)::int n FROM "delivery_effect"`)).rows[0].n, 1);
  } finally {
    await client.end();
  }
});

test('a real PostgreSQL restart preserves the pending signal for a fresh consumer', {
  skip: skip || (!CONTAINER ? 'set COORDINATOR_PG_CONTAINER to inject a PostgreSQL restart' : false),
}, async () => {
  let client = await connect();
  let connected = true;
  try {
    await reset(client);
    await client.query(`INSERT INTO "business_state" VALUES ($1, 1, 'after-database-restart')`, [PROJECT_A]);
    const producer = new ProjectEventsService(prisma(client));
    await inTransaction(client, (tx) => producer.enqueue(tx, input(PROJECT_A, SOURCE_A)));
    await client.end();
    connected = false;

    await execFileAsync('docker', ['restart', CONTAINER!], { timeout: 30_000 });
    client = await connectEventually();
    connected = true;
    await useSchema(client);
    const restarted = new ProjectEventsService(prisma(client));
    restarted.registerHandler(convergingHandler());
    assert.equal((await restarted.drainOnce()).status, 'CONSUMED');
    assert.deepEqual((await client.query(`
      SELECT revision, desired FROM "reconcile_projection" WHERE project_id=$1
    `, [PROJECT_A])).rows[0], { revision: 1, desired: 'after-database-restart' });
    assert.equal((await client.query(`SELECT count(*)::int n FROM "delivery_effect"`)).rows[0].n, 1);
  } finally {
    if (connected) await client.end();
  }
});

test('pending envelopes survive the 0116 to 0118 rolling migration and mixed writer versions', { skip }, async () => {
  const client = await connect();
  try {
    await resetRolling(client);
    const producer0116 = new ProjectEventsService(prisma(client));
    const future = await inTransaction(client, (tx) => producer0116.enqueue(tx, input(PROJECT_A, SOURCE_A, {
      v: 99,
      kind: 'future.writer',
      occurredAt: new Date('2026-08-20T09:00:00.000Z'),
      payload: { envelope: 'newer-than-consumer' },
    })));

    await client.query(BUSINESS_SOURCES);
    await client.query(AVAILABILITY_SOURCES);
    const afterMigration = (await client.query(`
      SELECT id::text, v, kind, occurrences, consumed_at FROM "project_event" WHERE id=$1
    `, [future.id])).rows[0];
    assert.deepEqual(afterMigration, {
      id: future.id,
      v: 99,
      kind: 'future.writer',
      occurrences: 1,
      consumed_at: null,
    }, 'rolling migrations preserve the pre-upgrade pending envelope exactly');

    const consumer0118 = new ProjectEventsService(prisma(client));
    consumer0118.registerHandler(convergingHandler());
    assert.equal((await consumer0118.drainOnce(new Date('2026-08-20T10:00:00.000Z'))).status, 'CONSUMED');

    await inTransaction(client, (tx) => producer0116.enqueue(tx, input(PROJECT_A, SOURCE_A, {
      v: 1,
      kind: 'legacy.writer',
      occurredAt: new Date('2026-08-20T08:00:00.000Z'),
    })));
    assert.equal((await consumer0118.drainOnce(new Date('2026-08-20T10:00:00.000Z'))).status, 'CONSUMED');
    assert.equal((await client.query(`
      SELECT count(*)::int n FROM "project_event" WHERE disposition='RECONCILED'
    `)).rows[0].n, 2);
    assert.equal((await client.query(`SELECT count(*)::int n FROM "delivery_effect"`)).rows[0].n, 1,
      'mixed writer versions still converge to one current-state side effect');
  } finally {
    await client.end();
  }
});
