import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Client, QueryResult } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc06_event_sources';
const OWNER = '00000000-0000-7000-8000-000000000601';
const PROJECT_A = '00000000-0000-7000-8000-000000000602';
const PROJECT_B = '00000000-0000-7000-8000-000000000603';
const TASK_A = '00000000-0000-7000-8000-000000000604';
const TASK_B = '00000000-0000-7000-8000-000000000605';
const TASK_LEGACY = '00000000-0000-7000-8000-000000000606';
const SESSION_A = '00000000-0000-7000-8000-000000000607';
const SESSION_LEGACY = '00000000-0000-7000-8000-000000000608';
const APPROVAL = '00000000-0000-7000-8000-000000000609';

const OUTBOX = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0116_project_event_outbox/migration.sql'),
  'utf8',
);
const SOURCES = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0117_project_event_sources/migration.sql'),
  'utf8',
);

type ClientCtor = new (config: { connectionString?: string }) => Client;
type EventRow = {
  project_id: string;
  kind: string;
  source_type: string;
  source_id: string;
  dedupe_key: string;
  occurrences: number;
};

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  await client.query(`
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "title" TEXT NOT NULL,
      "goal" TEXT,
      "acceptance_criteria" TEXT,
      "instructions" TEXT,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "coordinator_session_id" UUID,
      "coordinator_workspace_id" UUID,
      "coordinator_enabled" BOOLEAN NOT NULL DEFAULT true,
      "automation_policy" TEXT NOT NULL DEFAULT 'GUARDED_AUTO',
      "max_concurrent_tasks" INTEGER NOT NULL DEFAULT 3,
      "session_budget_per_day" INTEGER,
      "config_revision" BIGINT NOT NULL DEFAULT 0,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "task" (
      "id" UUID PRIMARY KEY,
      "title" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "project_id" UUID REFERENCES "project"("id"),
      "parent_task_id" UUID REFERENCES "task"("id") ON DELETE SET NULL,
      "assignee_id" UUID,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "task_dependency" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "task_id" UUID NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
      "depends_on_task_id" UUID NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
      UNIQUE ("task_id", "depends_on_task_id")
    );
    CREATE TABLE "session" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "task_id" UUID REFERENCES "task"("id") ON DELETE SET NULL,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "batch_id" UUID,
      "merge_status" TEXT,
      "merge_error" TEXT
    );
    CREATE TABLE "approval" (
      "id" UUID PRIMARY KEY,
      "session_id" UUID NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "decided_by_id" UUID
    );
  `);
  await client.query(OUTBOX);
  await client.query(SOURCES);
}

async function seed(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "project" ("id", "owner_id", "title") VALUES ($1,$3,'A'),($2,$3,'B')`,
    [PROJECT_A, PROJECT_B, OWNER],
  );
  await clearEvents(client);
}

async function clearEvents(client: Client): Promise<void> {
  await client.query(`DELETE FROM "project_event"`);
}

async function events(client: Client): Promise<EventRow[]> {
  const result: QueryResult<EventRow> = await client.query(`
    SELECT project_id::text, kind, source_type, source_id::text, dedupe_key, occurrences
      FROM "project_event"
     ORDER BY project_id, kind, occurred_at, id
  `);
  return result.rows;
}

const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

test('Task producers cover every write class, legacy rows, moves and batch coalescing', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await seed(client);

    await client.query(
      `INSERT INTO "task" ("id","title","project_id") VALUES ($1,'A',$2),($3,'legacy',NULL)`,
      [TASK_A, PROJECT_A, TASK_LEGACY],
    );
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind]), [
      [PROJECT_A, 'task.created'],
    ]);

    await clearEvents(client);
    await client.query(`UPDATE "task" SET "title"='renamed', "updated_at"=now() WHERE "id"=$1`, [TASK_A]);
    await client.query(`UPDATE "task" SET "title"='legacy renamed', "updated_at"=now() WHERE "id"=$1`, [TASK_LEGACY]);
    assert.deepEqual((await events(client)).map((row) => row.kind), ['task.updated']);

    await clearEvents(client);
    await client.query(`UPDATE "task" SET "status"='DONE', "updated_at"=now() WHERE "id"=$1`, [TASK_A]);
    assert.deepEqual((await events(client)).map((row) => row.kind), ['task.status_changed']);

    await client.query(`INSERT INTO "task" ("id","title","project_id") VALUES ($1,'B',$2)`, [TASK_B, PROJECT_B]);
    await clearEvents(client);
    await client.query(`UPDATE "task" SET "project_id"=$2, "parent_task_id"=$3, "updated_at"=now() WHERE "id"=$1`, [TASK_A, PROJECT_B, TASK_B]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind]), [
      [PROJECT_A, 'task.reparented'],
      [PROJECT_B, 'task.reparented'],
    ]);

    await clearEvents(client);
    await client.query(`INSERT INTO "task_dependency" ("task_id","depends_on_task_id") VALUES ($1,$2)`, [TASK_A, TASK_LEGACY]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind]), [
      [PROJECT_B, 'task.dependency_changed'],
    ]);

    await clearEvents(client);
    await client.query(`
      INSERT INTO "task" ("id","title","project_id") VALUES
        ('00000000-0000-7000-8000-000000000611','batch-1',$1),
        ('00000000-0000-7000-8000-000000000612','batch-2',$1),
        ('00000000-0000-7000-8000-000000000613','batch-3',$2)
    `, [PROJECT_A, PROJECT_B]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind, row.occurrences]), [
      [PROJECT_A, 'task.created', 2],
      [PROJECT_B, 'task.created', 1],
    ]);

    await clearEvents(client);
    await client.query(`UPDATE "task" SET "assignee_id"=$2, "updated_at"=now() WHERE "project_id"=$1`, [
      PROJECT_A,
      '00000000-0000-7000-8000-000000000614',
    ]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind, row.occurrences]), [
      [PROJECT_A, 'task.updated', 2],
    ]);

    await clearEvents(client);
    await client.query(`DELETE FROM "task" WHERE "id"=$1`, [TASK_A]);
    assert.equal((await events(client)).some((row) => row.kind === 'task.deleted'), true);
  } finally {
    await client.end();
  }
});

test('Session, approval and merge producers follow their committed lifecycle rows', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await seed(client);
    await client.query(
      `INSERT INTO "task" ("id","title","project_id") VALUES ($1,'A',$2),($3,'legacy',NULL)`,
      [TASK_A, PROJECT_A, TASK_LEGACY],
    );
    await clearEvents(client);

    await client.query(
      `INSERT INTO "session" ("id","owner_id","task_id","status") VALUES ($1,$3,$2,'PENDING'),($4,$3,$5,'PENDING')`,
      [SESSION_A, TASK_A, OWNER, SESSION_LEGACY, TASK_LEGACY],
    );
    assert.deepEqual((await events(client)).map((row) => row.kind), ['session.started']);

    // batchExecute initializes sessions in separate short transactions. Their durable batch id,
    // rather than txid_current(), must still collapse the starts to one pending signal.
    await client.query(`INSERT INTO "task" ("id","title","project_id") VALUES ($1,'B',$2)`, [
      TASK_B,
      PROJECT_A,
    ]);
    await clearEvents(client);
    const batch = '00000000-0000-7000-8000-000000000616';
    await client.query(
      `INSERT INTO "session" ("id","owner_id","task_id","status","batch_id") VALUES
         ('00000000-0000-7000-8000-000000000617',$2,$1,'PENDING',$3)`,
      [TASK_A, OWNER, batch],
    );
    await client.query(
      `INSERT INTO "session" ("id","owner_id","task_id","status","batch_id") VALUES
         ('00000000-0000-7000-8000-000000000618',$2,$1,'PENDING',$3)`,
      [TASK_B, OWNER, batch],
    );
    assert.deepEqual((await events(client)).map((row) => [row.kind, row.occurrences]), [
      ['session.started', 2],
    ]);

    const transitions: Array<[string, string]> = [
      ['AWAITING_INPUT', 'session.awaiting_input'],
      ['INTERRUPTED', 'session.awaiting_input'],
      ['FAILED', 'session.failed'],
      ['SUCCEEDED', 'session.ended'],
      ['PENDING', 'session.started'],
    ];
    for (const [status, kind] of transitions) {
      await clearEvents(client);
      await client.query(`UPDATE "session" SET "status"=$2 WHERE "id"=$1`, [SESSION_A, status]);
      assert.deepEqual((await events(client)).map((row) => row.kind), [kind]);
    }

    await clearEvents(client);
    await client.query(`UPDATE "session" SET "merge_status"='merged' WHERE "id"=$1`, [SESSION_A]);
    assert.deepEqual((await events(client)).map((row) => row.kind), ['merge.succeeded']);
    await clearEvents(client);
    await client.query(`UPDATE "session" SET "merge_status"='pending' WHERE "id"=$1`, [SESSION_A]);
    await client.query(`UPDATE "session" SET "merge_status"='conflict', "merge_error"='conflict' WHERE "id"=$1`, [SESSION_A]);
    assert.deepEqual((await events(client)).map((row) => row.kind), ['merge.conflict']);

    await clearEvents(client);
    await client.query(`INSERT INTO "approval" ("id","session_id") VALUES ($1,$2)`, [APPROVAL, SESSION_A]);
    assert.deepEqual((await events(client)).map((row) => row.kind), ['session.approval_pending']);
    await clearEvents(client);
    await client.query(`UPDATE "approval" SET "status"='ALLOWED', "decided_by_id"=$2 WHERE "id"=$1`, [APPROVAL, OWNER]);
    assert.deepEqual((await events(client)).map((row) => [row.kind, row.source_type, row.source_id]), [
      ['user.approval_resolved', 'USER', OWNER],
    ]);
  } finally {
    await client.end();
  }
});

test('Project edits and manual requests produce only the closed user event set', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await client.query(`INSERT INTO "project" ("id","owner_id","title") VALUES ($1,$2,'A')`, [PROJECT_A, OWNER]);
    assert.deepEqual((await events(client)).map((row) => row.kind), ['user.project_edited']);

    await clearEvents(client);
    await client.query(`UPDATE "project" SET "max_concurrent_tasks"=7, "config_revision"=1 WHERE "id"=$1`, [PROJECT_A]);
    assert.deepEqual((await events(client)).map((row) => row.kind), ['user.policy_changed']);

    await clearEvents(client);
    await client.query(`UPDATE "project" SET "goal"='ship it' WHERE "id"=$1`, [PROJECT_A]);
    assert.deepEqual((await events(client)).map((row) => row.kind), ['user.project_edited']);

    await clearEvents(client);
    const request = '00000000-0000-7000-8000-000000000615';
    await client.query('BEGIN');
    await client.query(`SELECT "project_event_manual_trigger"($1,$2,$3)`, [PROJECT_A, OWNER, request]);
    await client.query(`SELECT "project_event_manual_trigger"($1,$2,$3)`, [PROJECT_A, OWNER, request]);
    await client.query('COMMIT');
    assert.deepEqual((await events(client)).map((row) => [row.kind, row.occurrences]), [
      ['user.manual_trigger', 2],
    ]);
  } finally {
    await client.end();
  }
});

test('business rows and source events fail or roll back together without orphans', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await seed(client);

    await client.query('BEGIN');
    await client.query(`INSERT INTO "task" ("id","title","project_id") VALUES ($1,'rollback',$2)`, [TASK_A, PROJECT_A]);
    await client.query('ROLLBACK');
    assert.equal((await client.query(`SELECT count(*)::int n FROM "task" WHERE "id"=$1`, [TASK_A])).rows[0].n, 0);
    assert.deepEqual(await events(client), []);

    await client.query(`INSERT INTO "task" ("id","title","project_id") VALUES ($1,'atomic',$2)`, [TASK_A, PROJECT_A]);
    await clearEvents(client);
    await client.query(`ALTER TABLE "project_event" ADD CONSTRAINT "reject_task_updated" CHECK ("kind" <> 'task.updated')`);
    await assert.rejects(
      client.query(`UPDATE "task" SET "title"='must not land', "updated_at"=now() WHERE "id"=$1`, [TASK_A]),
      /reject_task_updated/,
    );
    assert.equal((await client.query(`SELECT "title" FROM "task" WHERE "id"=$1`, [TASK_A])).rows[0].title, 'atomic');
    assert.deepEqual(await events(client), []);
  } finally {
    await client.end();
  }
});
