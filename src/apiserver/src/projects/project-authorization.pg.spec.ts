import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import type { Client, QueryResult } from 'pg';
import {
  ProjectAuthorizationService,
  ProjectAuthorizationTransactionCommand,
  replayProjectAuthorizationAudit,
} from './project-authorization.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc12_policy';
const OWNER = '00000000-0000-7000-8000-000000001201';
const FOREIGN_OWNER = '00000000-0000-7000-8000-000000001202';
const PROJECT = '00000000-0000-7000-8000-000000001203';
const COORDINATOR = '00000000-0000-7000-8000-000000001204';
const AGENT_A = '00000000-0000-7000-8000-000000001205';
const AGENT_B = '00000000-0000-7000-8000-000000001206';
const TASK_A = '00000000-0000-7000-8000-000000001207';
const TASK_B = '00000000-0000-7000-8000-000000001208';
const SESSION_A = '00000000-0000-7000-8000-000000001209';
const ACTION = '00000000-0000-7000-8000-000000001210';
const MIGRATION = readFileSync(path.resolve(
  __dirname,
  '../../prisma/migrations/0121_project_authorization_policy/migration.sql',
), 'utf8');

type ClientCtor = new (config: {
  connectionString?: string;
  connectionTimeoutMillis?: number;
}) => Client;

function rows<T>(result: QueryResult): T[] {
  return result.rows as T[];
}

function transactionClient(client: Client): Prisma.TransactionClient {
  return {
    $queryRaw: async (query: Prisma.Sql) => rows(await client.query(query.text, query.values)),
    $executeRaw: async (query: Prisma.Sql) =>
      (await client.query(query.text, query.values)).rowCount ?? 0,
  } as unknown as Prisma.TransactionClient;
}

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function useSchema(client: Client): Promise<void> {
  await client.query(`SET search_path TO ${SCHEMA}`);
}

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await useSchema(client);
  await client.query(`
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "coordinator_enabled" BOOLEAN NOT NULL DEFAULT false,
      "automation_policy" TEXT NOT NULL DEFAULT 'MANUAL',
      "max_concurrent_tasks" INTEGER NOT NULL DEFAULT 3,
      "session_budget_per_day" INTEGER,
      "config_revision" BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE "workspace" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "deleted_at" TIMESTAMP(3)
    );
    CREATE TABLE "project_member" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL,
      "agent_id" UUID NOT NULL,
      "role" TEXT NOT NULL
    );
    CREATE TABLE "task" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "project_id" UUID,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "dispatch_hold" BOOLEAN NOT NULL DEFAULT false,
      "run_at" TIMESTAMP(3),
      "assignee_id" UUID,
      -- The columns the commit gate reads off the task row it locks. A hand-built subset only ever
      -- agrees with ITSELF, which is how this table came to be missing four columns the adapter had
      -- been selecting since §13.6 landed — the whole spec failed on the first query rather than on
      -- anything it was written to check. They are here so the gate can actually run.
      "parent_task_id" UUID,
      "verifies_task_id" UUID,
      "superseded_by_task_id" UUID,
      "terminal_reason" TEXT,
      -- §13.1 AG6's column. Defaulted to MANUAL like the real schema, so every existing fixture in
      -- this file keeps meaning what it meant.
      "completion_policy" TEXT NOT NULL DEFAULT 'MANUAL'
    );
    CREATE TABLE "task_dependency" (
      "task_id" UUID NOT NULL,
      "depends_on_task_id" UUID NOT NULL,
      PRIMARY KEY ("task_id", "depends_on_task_id")
    );
    -- §13.2's condition row, in the shape the guard reads it: the commit-time gate answers "is a
    -- failed check still holding this task" from here, so the harness has to have it for the
    -- guard to be exercised at all.
    CREATE TABLE "task_verification_failure" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL,
      "verifier_task_id" UUID NOT NULL,
      "subject_task_id" UUID NOT NULL,
      "verdict" TEXT NOT NULL,
      "verdict_revision" BIGINT NOT NULL,
      "blocks_downstream" BOOLEAN NOT NULL,
      "defect_task_id" UUID,
      "resolved_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "session" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "task_id" UUID,
      -- §9.4 counts the sessions that OCCUPY a task as work; the adapter has selected on this
      -- column since that rule landed, and the subset never grew it.
      "starts_task_work" BOOLEAN NOT NULL DEFAULT true,
      "status" TEXT NOT NULL,
      "deleted_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "error" TEXT
    );
    CREATE TABLE "project_action" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL,
      "type" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Rows that predate 0121 stay inert. Applying the migration must not touch the Project table or
  // manufacture an Agent fallback.
  await client.query(`INSERT INTO "project" ("id", "owner_id") VALUES ($1, $2)`, [
    PROJECT,
    OWNER,
  ]);
  await client.query(`
    INSERT INTO "workspace" ("id", "owner_id") VALUES ($1, $2), ($3, $2), ($4, $2)
  `, [COORDINATOR, OWNER, AGENT_A, AGENT_B]);
  await client.query(MIGRATION);
  assert.deepEqual((await client.query(`
    SELECT "coordinator_enabled", "automation_policy", "config_revision"::int
      FROM "project" WHERE "id" = $1
  `, [PROJECT])).rows[0], {
    coordinator_enabled: false,
    automation_policy: 'MANUAL',
    config_revision: 0,
  });
  assert.deepEqual((await client.query(`
    SELECT "provider_fallbacks", "can_create_tasks", "can_delegate", "max_concurrent_tasks"
      FROM "workspace" WHERE "id" = $1
  `, [AGENT_A])).rows[0], {
    provider_fallbacks: [],
    can_create_tasks: false,
    can_delegate: false,
    max_concurrent_tasks: null,
  });

  await client.query(`
    UPDATE "project"
       SET "coordinator_enabled" = true, "automation_policy" = 'GUARDED_AUTO',
           "max_concurrent_tasks" = 3, "session_budget_per_day" = 20,
           "config_revision" = 1
     WHERE "id" = $1
  `, [PROJECT]);
  await client.query(`
    UPDATE "workspace"
       SET "can_create_tasks" = true, "can_delegate" = true
     WHERE "id" = $1
  `, [COORDINATOR]);
  await client.query(`
    UPDATE "workspace"
       SET "provider_fallbacks" = '[{"provider":"missing"},{"provider":"codex","model":"gpt-5.6-sol"}]',
           "max_concurrent_tasks" = 1
     WHERE "id" = $1
  `, [AGENT_A]);
  await client.query(`
    INSERT INTO "project_member" ("id", "project_id", "agent_id", "role") VALUES
      ('00000000-0000-7000-8000-000000001211', $1, $2, 'COORDINATOR'),
      ('00000000-0000-7000-8000-000000001212', $1, $3, 'MEMBER'),
      ('00000000-0000-7000-8000-000000001213', $1, $4, 'MEMBER')
  `, [PROJECT, COORDINATOR, AGENT_A, AGENT_B]);
  await client.query(`
    INSERT INTO "task" ("id", "owner_id", "project_id", "assignee_id") VALUES
      ($1, $2, $3, $4),
      ($5, $2, $3, $4)
  `, [TASK_A, OWNER, PROJECT, AGENT_A, TASK_B]);
}

function command(taskId: string, overrides: Partial<ProjectAuthorizationTransactionCommand> = {})
  : ProjectAuthorizationTransactionCommand {
  return {
    ownerId: OWNER,
    projectId: PROJECT,
    coordinatorAgentId: COORDINATOR,
    idempotencyKey: `pc:v1:${PROJECT}:dispatch:${taskId}:1`,
    action: 'DISPATCH_TASK',
    taskId,
    sourceDecisionInputHash: 'a'.repeat(64),
    provider: {
      requestedProvider: 'codex',
      requestedModel: 'gpt-5.6-sol',
      availability: [{ provider: 'codex', available: true, models: ['gpt-5.6-sol'] }],
    },
    runner: {
      available: true,
      capabilitiesReported: true,
      capabilities: ['linux', 'docker'],
      requiredCapabilities: ['linux'],
    },
    ...overrides,
  };
}

async function waitForProjectLock(observer: Client, blockedPid: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const state = (await observer.query<{ wait_event_type: string | null }>(`
      SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1
    `, [blockedPid])).rows[0];
    if (state?.wait_event_type === 'Lock') return;
    await wait(10);
  }
  assert.fail('the competing authorization never waited on the Project admission lock');
}

test('migration defaults, tenant scope, admission races, budget, approval and fallback hold on PostgreSQL',
  { skip: !URL }, async () => {
    const a = await connect();
    const b = await connect();
    const observer = await connect();
    const authorizer = new ProjectAuthorizationService();
    try {
      await reset(a);
      await useSchema(b);
      await useSchema(observer);
      const pidB = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const at = new Date('2026-08-20T08:00:00.000Z');

      // Two different Tasks target the same one-slot Agent. The second transaction starts while
      // the first still holds the Project lock, then observes the committed placeholder rather
      // than authorizing from a stale count.
      await a.query('BEGIN');
      const first = await authorizer.authorizeInTransaction(transactionClient(a), command(TASK_A), at);
      assert.equal(first?.result.decision, 'ALLOW');
      await a.query(`
        INSERT INTO "session" ("id", "owner_id", "task_id", "status")
        VALUES ($1, $2, $3, 'PENDING')
      `, [SESSION_A, OWNER, TASK_A]);
      await b.query('BEGIN');
      const competing = authorizer.authorizeInTransaction(transactionClient(b), command(TASK_B), at);
      await waitForProjectLock(observer, pidB);
      await a.query('COMMIT');
      const agentCapped = await competing;
      assert.equal(agentCapped?.result.decision, 'DEFER');
      assert.equal(agentCapped?.result.reasonCode, 'AGENT_CONCURRENCY_LIMIT');
      await b.query('ROLLBACK');

      // The Project cap is the same shared gate, independent of which Agent the second Task uses.
      await a.query(`UPDATE "project" SET "max_concurrent_tasks" = 1 WHERE "id" = $1`, [PROJECT]);
      await a.query(`UPDATE "task" SET "assignee_id" = $1 WHERE "id" = $2`, [AGENT_B, TASK_B]);
      const projectCapped = await a.query('BEGIN').then(() =>
        authorizer.authorizeInTransaction(transactionClient(a), command(TASK_B), at));
      assert.equal(projectCapped?.result.reasonCode, 'PROJECT_CONCURRENCY_LIMIT');
      await a.query('ROLLBACK');

      await a.query(`DELETE FROM "session"`);
      await a.query(`UPDATE "project" SET "max_concurrent_tasks" = 3, "session_budget_per_day" = 1 WHERE "id" = $1`, [PROJECT]);
      await a.query(`
        INSERT INTO "project_action" ("id", "project_id", "type", "status", "created_at")
        VALUES ($1, $2, 'DISPATCH_TASK', 'APPLIED', $3)
      `, [ACTION, PROJECT, at]);
      await a.query('BEGIN');
      const budget = await authorizer.authorizeInTransaction(transactionClient(a), command(TASK_B), at);
      assert.equal(budget?.result.decision, 'DEFER');
      assert.equal(budget?.result.reasonCode, 'SESSION_BUDGET_EXHAUSTED');
      await a.query('ROLLBACK');

      await a.query(`DELETE FROM "project_action"`);
      await a.query(`UPDATE "project" SET "session_budget_per_day" = 20 WHERE "id" = $1`, [PROJECT]);
      await a.query(`UPDATE "task" SET "assignee_id" = $1 WHERE "id" = $2`, [AGENT_A, TASK_B]);
      const fallbackCommand = command(TASK_B, {
        provider: {
          requestedProvider: 'kimi',
          requestedModel: 'k2',
          availability: [
            { provider: 'kimi', available: false },
            { provider: 'missing', available: false },
            { provider: 'codex', available: true, models: ['gpt-5.6-sol'] },
            { provider: 'claude', available: true },
          ],
        },
      });
      await a.query('BEGIN');
      const guarded = await authorizer.authorizeInTransaction(transactionClient(a), fallbackCommand, at);
      assert.equal(guarded?.result.decision, 'REQUIRE_APPROVAL');
      assert.equal(guarded?.result.policyRow, 'DISPATCH_PROVIDER_FALLBACK');
      assert.deepEqual(guarded?.result.providerResolution?.candidatesConsidered, ['kimi', 'missing', 'codex']);
      assert.equal(replayProjectAuthorizationAudit(guarded!), true);
      await a.query('ROLLBACK');

      await a.query('BEGIN');
      const approved = await authorizer.authorizeInTransaction(transactionClient(a), {
        ...fallbackCommand,
        approval: { state: 'APPROVED', targetIdempotencyKey: fallbackCommand.idempotencyKey },
      }, at);
      assert.equal(approved?.result.decision, 'ALLOW');
      assert.equal(approved?.result.reasonCode, 'APPROVAL_GRANTED');
      await a.query('ROLLBACK');

      await a.query(`UPDATE "workspace" SET "provider_fallbacks" = '[]' WHERE "id" = $1`, [AGENT_A]);
      await a.query('BEGIN');
      const noFallback = await authorizer.authorizeInTransaction(transactionClient(a), fallbackCommand, at);
      assert.equal(noFallback?.result.decision, 'DENY');
      assert.equal(noFallback?.result.reasonCode, 'PROVIDER_UNAVAILABLE');
      assert.equal(noFallback?.result.providerResolution?.selectedProvider, null);
      await a.query('ROLLBACK');

      await a.query('BEGIN');
      const invisible = await authorizer.authorizeInTransaction(transactionClient(a), {
        ...command(TASK_A), ownerId: FOREIGN_OWNER,
      }, at);
      assert.equal(invisible, null, 'a foreign owner cannot probe or authorize the Project');
      await a.query('ROLLBACK');

      const migrationObjects = (await a.query<{ n: number }>(`
        SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workspace'
           AND column_name IN ('provider_fallbacks','can_create_tasks','can_delegate','max_concurrent_tasks')
      `, [SCHEMA])).rows[0].n;
      assert.equal(migrationObjects, 4);
      const migrationConstraints = (await a.query<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE n.nspname = $1
           AND c.conname IN (
             'workspace_provider_fallbacks_array',
             'workspace_max_concurrent_tasks_positive'
           )
      `, [SCHEMA])).rows[0].n;
      assert.equal(migrationConstraints, 2);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      await a.end();
      await b.end();
      await observer.end();
    }
  });
