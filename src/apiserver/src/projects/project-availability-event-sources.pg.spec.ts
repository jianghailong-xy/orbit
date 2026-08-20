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
const SCHEMA = 'pcc07_availability_sources';
const OWNER = '00000000-0000-7000-8000-000000000701';
const RUNNER_A = '00000000-0000-7000-8000-000000000702';
const RUNNER_B = '00000000-0000-7000-8000-000000000703';
const WORKSPACE_A = '00000000-0000-7000-8000-000000000704';
const WORKSPACE_C = '00000000-0000-7000-8000-000000000705';
const WORKSPACE_B = '00000000-0000-7000-8000-000000000706';
const PROJECT_A = '00000000-0000-7000-8000-000000000707';
const PROJECT_C = '00000000-0000-7000-8000-000000000708';
const PROJECT_B = '00000000-0000-7000-8000-000000000709';
const PROJECT_DISABLED = '00000000-0000-7000-8000-00000000070a';
const TASK_A = '00000000-0000-7000-8000-00000000070b';
const TASK_C = '00000000-0000-7000-8000-00000000070c';
const TASK_B = '00000000-0000-7000-8000-00000000070d';
const TASK_DISABLED = '00000000-0000-7000-8000-00000000070e';
const CONFIGURED_PROVIDER = '00000000-0000-7000-8000-00000000070f';

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

type ClientCtor = new (config: { connectionString?: string }) => Client;
type EventRow = {
  project_id: string;
  kind: string;
  source_type: string;
  source_id: string;
  dedupe_key: string;
  occurrences: number;
  payload: Record<string, unknown>;
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
    CREATE TABLE "runner" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'OFFLINE',
      "last_heartbeat_at" TIMESTAMP(3),
      "labels" TEXT[] NOT NULL DEFAULT '{}',
      "max_concurrent" INTEGER NOT NULL DEFAULT 1,
      "min_free_disk_mb" INTEGER,
      "plan_usage" JSONB,
      "model_catalog" JSONB,
      "runtime_default_models" JSONB,
      "runs_as_root" BOOLEAN,
      "engines" JSONB
    );
    CREATE TABLE "workspace" (
      "id" UUID PRIMARY KEY,
      "runner_id" UUID REFERENCES "runner"("id"),
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "deleted_at" TIMESTAMP(3),
      "work_dir_exists" BOOLEAN,
      "work_dir_free_bytes" BIGINT
    );
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
    CREATE TABLE "project_member" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "project_id" UUID NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
      "agent_id" UUID NOT NULL REFERENCES "workspace"("id"),
      UNIQUE ("project_id", "agent_id")
    );
    CREATE TABLE "task" (
      "id" UUID PRIMARY KEY,
      "title" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "project_id" UUID REFERENCES "project"("id"),
      "parent_task_id" UUID REFERENCES "task"("id") ON DELETE SET NULL,
      "assignee_id" UUID REFERENCES "workspace"("id"),
      "provider" TEXT,
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
      "workspace_id" UUID REFERENCES "workspace"("id"),
      "provider" TEXT,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "batch_id" UUID,
      "merge_status" TEXT,
      "merge_error" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "approval" (
      "id" UUID PRIMARY KEY,
      "session_id" UUID NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "decided_by_id" UUID
    );
    CREATE TABLE "model_provider" (
      "id" UUID PRIMARY KEY,
      "slug" TEXT NOT NULL UNIQUE,
      "owner_id" UUID,
      "enabled" BOOLEAN NOT NULL DEFAULT true
    );
  `);
  await client.query(OUTBOX);
  await client.query(BUSINESS_SOURCES);
  await client.query(AVAILABILITY_SOURCES);
}

async function seed(client: Client): Promise<void> {
  const signedIn = JSON.stringify([
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'codex', installed: true, auth: 'yes' },
  ]);
  await client.query(`
    INSERT INTO "runner" (
      "id", "owner_id", "status", "last_heartbeat_at", "min_free_disk_mb", "engines"
    ) VALUES
      ($1,$3,'OFFLINE',now() - interval '5 minutes',100,$4::jsonb),
      ($2,$3,'ONLINE',now(),100,$4::jsonb)
  `, [RUNNER_A, RUNNER_B, OWNER, signedIn]);
  await client.query(`
    INSERT INTO "workspace" (
      "id", "runner_id", "enabled", "work_dir_exists", "work_dir_free_bytes"
    ) VALUES
      ($1,$4,true,true,209715200),
      ($2,$4,true,true,209715200),
      ($3,$5,true,true,209715200)
  `, [WORKSPACE_A, WORKSPACE_C, WORKSPACE_B, RUNNER_A, RUNNER_B]);
  await client.query(
    `INSERT INTO "model_provider" ("id","slug","owner_id","enabled") VALUES ($1,'deepseek',$2,true)`,
    [CONFIGURED_PROVIDER, OWNER],
  );
  await client.query(`
    INSERT INTO "project" ("id","owner_id","title","coordinator_enabled") VALUES
      ($1,$5,'A',true),($2,$5,'C',true),($3,$5,'B',true),($4,$5,'disabled',false)
  `, [PROJECT_A, PROJECT_C, PROJECT_B, PROJECT_DISABLED, OWNER]);
  await client.query(`
    INSERT INTO "project_member" ("project_id","agent_id") VALUES
      ($1,$5),($2,$6),($3,$7),($4,$5)
  `, [PROJECT_A, PROJECT_C, PROJECT_B, PROJECT_DISABLED, WORKSPACE_A, WORKSPACE_C, WORKSPACE_B]);
  await client.query(`
    INSERT INTO "task" ("id","title","project_id","assignee_id","provider") VALUES
      ($1,'A',$5,$9,'codex'),($2,'C',$6,$10,'claude'),
      ($3,'B',$7,$11,'codex'),($4,'disabled',$8,$9,'codex')
  `, [
    TASK_A, TASK_C, TASK_B, TASK_DISABLED,
    PROJECT_A, PROJECT_C, PROJECT_B, PROJECT_DISABLED,
    WORKSPACE_A, WORKSPACE_C, WORKSPACE_B,
  ]);
  await clearEvents(client);
}

async function clearEvents(client: Client): Promise<void> {
  await client.query(`DELETE FROM "project_event"`);
}

async function events(client: Client): Promise<EventRow[]> {
  const result: QueryResult<EventRow> = await client.query(`
    SELECT project_id::text, kind, source_type, source_id::text,
           dedupe_key, occurrences, payload
      FROM "project_event"
     ORDER BY project_id, kind, dedupe_key
  `);
  return result.rows;
}

const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

test('Runner, Workspace and Provider edges wake only relevant enabled Projects', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await seed(client);

    // Recovery wakes both enabled Projects on runner A, but neither another runner nor a disabled
    // Project. A timestamp-only second heartbeat is noise. A later offline/online cycle coalesces
    // the second online edge into the still-pending row.
    await client.query(`UPDATE "runner" SET "status"='ONLINE', "last_heartbeat_at"=now() WHERE "id"=$1`, [RUNNER_A]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind, row.occurrences]), [
      [PROJECT_A, 'runner.online', 1],
      [PROJECT_C, 'runner.online', 1],
    ]);
    await client.query(`UPDATE "runner" SET "status"='ONLINE', "last_heartbeat_at"=now() WHERE "id"=$1`, [RUNNER_A]);
    assert.equal((await events(client)).length, 2, 'a repeated effective heartbeat emitted noise');
    await client.query(`UPDATE "runner" SET "status"='OFFLINE' WHERE "id"=$1`, [RUNNER_A]);
    await client.query(`UPDATE "runner" SET "status"='ONLINE', "last_heartbeat_at"=now() WHERE "id"=$1`, [RUNNER_A]);
    const runnerEdges = await events(client);
    assert.deepEqual(
      runnerEdges.map((row) => [row.project_id, row.kind, row.occurrences]),
      [
        [PROJECT_A, 'runner.offline', 1],
        [PROJECT_A, 'runner.online', 2],
        [PROJECT_C, 'runner.offline', 1],
        [PROJECT_C, 'runner.online', 2],
      ],
    );

    // Provider-specific capabilities are routed by provider as well as runner: Project C shares
    // the machine but is pinned to Claude, so a Codex model-catalog change cannot wake it.
    await clearEvents(client);
    await client.query(`UPDATE "runner" SET "model_catalog"='{"codex":[{"id":"gpt"}]}'::jsonb WHERE "id"=$1`, [RUNNER_A]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind]), [
      [PROJECT_A, 'runner.capabilities_changed'],
    ]);

    // Workspace availability is exact even when two workspaces share one runner. Repeating the
    // same below-floor reading emits nothing; recovery coalesces on the same pending cause.
    await clearEvents(client);
    await client.query(`UPDATE "workspace" SET "enabled"=false WHERE "id"=$1`, [WORKSPACE_C]);
    await client.query(`UPDATE "workspace" SET "enabled"=false WHERE "id"=$1`, [WORKSPACE_C]);
    await client.query(`UPDATE "workspace" SET "enabled"=true WHERE "id"=$1`, [WORKSPACE_C]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind, row.occurrences]), [
      [PROJECT_C, 'runner.capabilities_changed', 2],
    ]);
    await clearEvents(client);
    await client.query(`UPDATE "workspace" SET "work_dir_free_bytes"=52428800 WHERE "id"=$1`, [WORKSPACE_A]);
    await client.query(`UPDATE "workspace" SET "work_dir_free_bytes"=41943040 WHERE "id"=$1`, [WORKSPACE_A]);
    await client.query(`UPDATE "workspace" SET "work_dir_free_bytes"=209715200 WHERE "id"=$1`, [WORKSPACE_A]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind, row.occurrences]), [
      [PROJECT_A, 'runner.capabilities_changed', 2],
    ]);

    // Signed-out and restored engine edges reach only the Project pinned to that provider.
    await clearEvents(client);
    const codexSignedOut = JSON.stringify([
      { engine: 'claude', installed: true, auth: 'yes' },
      { engine: 'codex', installed: true, auth: 'no' },
    ]);
    await client.query(`UPDATE "runner" SET "engines"=$2::jsonb WHERE "id"=$1`, [RUNNER_A, codexSignedOut]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind]), [
      [PROJECT_A, 'provider.unavailable'],
      [PROJECT_A, 'runner.capabilities_changed'],
    ]);
    await clearEvents(client);
    const codexSignedIn = JSON.stringify([
      { engine: 'claude', installed: true, auth: 'yes' },
      { engine: 'codex', installed: true, auth: 'yes' },
    ]);
    await client.query(`UPDATE "runner" SET "engines"=$2::jsonb WHERE "id"=$1`, [RUNNER_A, codexSignedIn]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind]), [
      [PROJECT_A, 'provider.restored'],
      [PROJECT_A, 'runner.capabilities_changed'],
    ]);

    // Quota snapshots use the same effective predicate as dispatch. Changing fetchedAt while the
    // exhausted state is unchanged does not produce a second signal; recovery is explicit.
    await clearEvents(client);
    const exhausted = JSON.stringify({
      codex: { primary: { utilization: 100, resetsAt: '2099-01-01T00:00:00Z' } },
    });
    await client.query(`UPDATE "runner" SET "plan_usage"=$2::jsonb WHERE "id"=$1`, [RUNNER_A, exhausted]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind]), [
      [PROJECT_A, 'provider.quota_exhausted'],
    ]);
    await clearEvents(client);
    const exhaustedAgain = JSON.stringify({
      codex: {
        primary: { utilization: 100, resetsAt: '2099-01-01T00:00:00Z' },
        fetchedAt: '2026-08-20T12:00:00Z',
      },
    });
    await client.query(`UPDATE "runner" SET "plan_usage"=$2::jsonb WHERE "id"=$1`, [RUNNER_A, exhaustedAgain]);
    assert.deepEqual(await events(client), []);
    const restored = JSON.stringify({
      codex: { primary: { utilization: 20, resetsAt: '2099-01-01T00:00:00Z' } },
    });
    await client.query(`UPDATE "runner" SET "plan_usage"=$2::jsonb WHERE "id"=$1`, [RUNNER_A, restored]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind]), [
      [PROJECT_A, 'provider.restored'],
    ]);

    // A reset timestamp may already be in the past when the first refreshed utilization arrives.
    // Compare the stored claims, not OLD re-evaluated against the new wall clock, or this recovery
    // edge disappears. Merely advancing fetchedAt while the provider still claims 100% stays quiet.
    const exhaustedPastReset = JSON.stringify({
      codex: {
        primary: { utilization: 100, resetsAt: '2020-01-01T00:00:00Z' },
        fetchedAt: '2026-08-20T12:01:00Z',
      },
    });
    await client.query(`UPDATE "runner" SET "plan_usage"=$2::jsonb WHERE "id"=$1`, [RUNNER_A, exhaustedPastReset]);
    await clearEvents(client);
    const recoveredAfterReset = JSON.stringify({
      codex: {
        primary: { utilization: 1, resetsAt: '2020-01-01T00:00:00Z' },
        fetchedAt: '2026-08-20T12:02:00Z',
      },
    });
    await client.query(`UPDATE "runner" SET "plan_usage"=$2::jsonb WHERE "id"=$1`, [RUNNER_A, recoveredAfterReset]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind]), [
      [PROJECT_A, 'provider.restored'],
    ]);

    // Configured-provider enablement is a global row but a tenant- and pin-scoped fanout. The
    // source never rewrites a Task/Session provider: unavailability cannot become silent fallback.
    await client.query(`UPDATE "task" SET "provider"='deepseek' WHERE "id"=$1`, [TASK_A]);
    await clearEvents(client);
    await client.query(`UPDATE "model_provider" SET "enabled"=false WHERE "id"=$1`, [CONFIGURED_PROVIDER]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind, row.source_type]), [
      [PROJECT_A, 'provider.unavailable', 'PROVIDER'],
    ]);
    await clearEvents(client);
    await client.query(`UPDATE "model_provider" SET "enabled"=true WHERE "id"=$1`, [CONFIGURED_PROVIDER]);
    assert.deepEqual((await events(client)).map((row) => [row.project_id, row.kind]), [
      [PROJECT_A, 'provider.restored'],
    ]);
    assert.equal((await client.query(`SELECT "provider" FROM "task" WHERE "id"=$1`, [TASK_A])).rows[0].provider, 'deepseek');
    assert.equal((await client.query(`SELECT "provider" FROM "task" WHERE "id"=$1`, [TASK_C])).rows[0].provider, 'claude');

    // The trigger participates in the business transaction: rollback leaves neither state nor an
    // orphan event.
    await clearEvents(client);
    await client.query('BEGIN');
    await client.query(`UPDATE "runner" SET "status"='OFFLINE' WHERE "id"=$1`, [RUNNER_A]);
    await client.query('ROLLBACK');
    assert.deepEqual(await events(client), []);
    assert.equal((await client.query(`SELECT "status" FROM "runner" WHERE "id"=$1`, [RUNNER_A])).rows[0].status, 'ONLINE');
  } finally {
    await client.end();
  }
});
