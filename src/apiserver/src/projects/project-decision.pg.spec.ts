import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import type { Client, QueryResult } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  ProjectDecisionService,
  createDecisionId,
  planProjectDecision,
} from './project-decision.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectEventsService } from './project-events.service';
import { ProjectReconcileService } from './project-reconcile.service';

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc11_decision';
const OWNER = '00000000-0000-7000-8000-000000001111';
const FOREIGN_OWNER = '00000000-0000-7000-8000-000000001112';
const PROJECT = '00000000-0000-7000-8000-000000001113';
const COORDINATOR = '00000000-0000-7000-8000-000000001114';
const FOREIGN_WORKSPACE = '00000000-0000-7000-8000-000000001115';
const RUNNER = '00000000-0000-7000-8000-000000001116';
const FOREIGN_RUNNER = '00000000-0000-7000-8000-000000001117';
const TASK = '00000000-0000-7000-8000-000000001118';
const VERIFIER = '00000000-0000-7000-8000-000000001119';
const FOREIGN_TASK = '00000000-0000-7000-8000-000000001120';
const SESSION = '00000000-0000-7000-8000-000000001121';
const VERIFIER_SESSION = '00000000-0000-7000-8000-000000001122';
const COORDINATOR_SESSION = '00000000-0000-7000-8000-000000001123';
const FOREIGN_SESSION = '00000000-0000-7000-8000-000000001124';
const PROVIDER = '00000000-0000-7000-8000-000000001125';
const FOREIGN_PROVIDER = '00000000-0000-7000-8000-000000001126';
const SOURCE = '00000000-0000-7000-8000-000000001127';
const LIVE_AFTER_SNAPSHOT = '00000000-0000-7000-8000-000000001128';

const OUTBOX = migration('0116_project_event_outbox');
const RECONCILE = migration('0119_project_reconcile_runtime');
const DECISION = migration('0120_project_decision_audit');
const AUTHORIZATION = migration('0121_project_authorization_policy');
const BLOCKER = migration('0125_project_blocker');

type ClientCtor = new (config: { connectionString?: string; connectionTimeoutMillis?: number }) => Client;
type Tx = Prisma.TransactionClient;

function migration(name: string): string {
  return readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');
}

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
    $transaction: async <T>(
      fn: (tx: Tx) => Promise<T>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => {
      const isolation = options?.isolationLevel === Prisma.TransactionIsolationLevel.RepeatableRead
        ? ' ISOLATION LEVEL REPEATABLE READ'
        : options?.isolationLevel === Prisma.TransactionIsolationLevel.Serializable
          ? ' ISOLATION LEVEL SERIALIZABLE'
          : '';
      await client.query(`BEGIN${isolation}`);
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

async function useSchema(client: Client): Promise<void> {
  await client.query(`SET search_path TO ${SCHEMA}`);
}

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await useSchema(client);
  await client.query(`
    CREATE TYPE "project_status" AS ENUM ('OPEN', 'DONE', 'CANCELLED');
    CREATE TYPE "project_automation_policy" AS ENUM ('MANUAL', 'GUARDED_AUTO', 'AUTO');
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "title" TEXT NOT NULL,
      "goal" TEXT,
      "acceptance_criteria" TEXT,
      "instructions" TEXT,
      "status" "project_status" NOT NULL DEFAULT 'OPEN',
      "coordinator_enabled" BOOLEAN NOT NULL DEFAULT true,
      "automation_policy" "project_automation_policy" NOT NULL DEFAULT 'GUARDED_AUTO',
      "max_concurrent_tasks" INTEGER NOT NULL DEFAULT 3,
      "session_budget_per_day" INTEGER,
      "config_revision" BIGINT NOT NULL DEFAULT 0,
      "coordinator_session_id" UUID,
      "coordinator_workspace_id" UUID
    );
    CREATE TABLE "project_runtime" (
      "project_id" UUID PRIMARY KEY REFERENCES "project"("id") ON DELETE CASCADE,
      "coordinator_generation" BIGINT NOT NULL DEFAULT 0,
      -- §7.5's rotation baseline (migration 0113). This fixture builds a subset of the real
      -- schema by hand, and §6.1 reads this column, so it belongs in the subset.
      "coordinator_session_id" UUID,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL
    );
  `);
  await client.query(OUTBOX);
  await client.query(RECONCILE);
  await client.query(DECISION);
  await client.query(`
    CREATE TABLE "runner" (
      "id" UUID PRIMARY KEY, "owner_id" UUID NOT NULL, "status" TEXT NOT NULL,
      "labels" TEXT[] NOT NULL DEFAULT '{}', "version" TEXT,
      "last_heartbeat_at" TIMESTAMP(3), "model_catalog" JSONB,
      "capabilities" TEXT[] NOT NULL DEFAULT '{}', "capabilities_reported_at" TIMESTAMP(3),
      "engines" JSONB, "runs_as_root" BOOLEAN
    );
    CREATE TABLE "workspace" (
      "id" UUID PRIMARY KEY, "owner_id" UUID NOT NULL, "name" TEXT NOT NULL,
      "runner_id" UUID, "enabled" BOOLEAN NOT NULL DEFAULT true, "deleted_at" TIMESTAMP(3),
      "model" TEXT, "effort" TEXT, "default_merge_target" TEXT,
      "work_dir_exists" BOOLEAN, "work_dir_is_git" BOOLEAN, "work_dir_probed_at" TIMESTAMP(3)
    );
    CREATE TABLE "project_member" (
      "id" UUID PRIMARY KEY, "project_id" UUID NOT NULL, "agent_id" UUID NOT NULL, "role" TEXT NOT NULL
    );
    CREATE TABLE "task" (
      "id" UUID PRIMARY KEY, "owner_id" UUID NOT NULL, "project_id" UUID,
      "title" TEXT NOT NULL, "description" TEXT, "acceptance_criteria" TEXT,
      "labels" TEXT[] NOT NULL DEFAULT '{}', "status" TEXT NOT NULL DEFAULT 'OPEN',
      "parent_task_id" UUID, "assignee_id" UUID, "provider" TEXT, "model" TEXT,
      "auto_run_when_ready" BOOLEAN NOT NULL DEFAULT true,
      "dispatch_hold" BOOLEAN NOT NULL DEFAULT false, "run_at" TIMESTAMP(3),
      "dispatch_authority" TEXT NOT NULL DEFAULT 'LEGACY',
      "dispatch_attempt" BIGINT NOT NULL DEFAULT 0,
      "required_capabilities" TEXT[] NOT NULL DEFAULT '{}',
      "verifies_task_id" UUID,
      "completion_policy" TEXT NOT NULL DEFAULT 'MANUAL', "verdict" TEXT,
      "verdict_revision" BIGINT NOT NULL DEFAULT 0,
      -- §13.6's columns, which the authorization adapter reads since 0130: a stand-in schema that
      -- omits a column the code under test selects fails on the column, not on the property.
      "superseded_by_task_id" UUID, "superseded_at" TIMESTAMP(3), "terminal_reason" TEXT,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "task_dependency" (
      "task_id" UUID NOT NULL, "depends_on_task_id" UUID NOT NULL,
      PRIMARY KEY ("task_id", "depends_on_task_id")
    );
    CREATE TABLE "session" (
      "id" UUID PRIMARY KEY, "owner_id" UUID NOT NULL, "task_id" UUID,
      "workspace_id" UUID, "assigned_runner_id" UUID, "status" TEXT NOT NULL,
      "provider" TEXT NOT NULL DEFAULT 'codex', "model" TEXT, "permission_mode" TEXT,
      "effort" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "started_at" TIMESTAMP(3), "finished_at" TIMESTAMP(3),
      "completed_at" TIMESTAMP(3), "deleted_at" TIMESTAMP(3), "result" TEXT, "error" TEXT,
      "branch" TEXT, "base_sha" TEXT, "changed_files" JSONB, "merge_status" TEXT,
      "merged_source_sha" TEXT, "merge_target" TEXT, "branch_merged" BOOLEAN,
      "worktree_branch" TEXT, "worktree_dirty" BOOLEAN, "commit_status" TEXT
    );
    CREATE TABLE "model_provider" (
      "id" UUID PRIMARY KEY, "slug" TEXT NOT NULL, "runtime" TEXT NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT true, "models" JSONB NOT NULL DEFAULT '[]',
      "default_model" TEXT, "owner_id" UUID
    );
    CREATE TABLE "business_effect" (
      "action_id" UUID PRIMARY KEY, "marker" TEXT NOT NULL
    );
  `);
  await client.query(AUTHORIZATION);
  // §11's table, and the `reason_code` column §7.6 TR2-a's window bucket is read from — the latter
  // arrives with 0122, whose dispatch-boundary triggers are not what this spec is about.
  await client.query(`ALTER TABLE "project_action" ADD COLUMN "reason_code" TEXT`);
  await client.query(BLOCKER);
  await client.query(`
    INSERT INTO "project" (
      "id", "owner_id", "title", "goal", "acceptance_criteria",
      "coordinator_session_id", "coordinator_workspace_id", "config_revision"
    ) VALUES ($1, $2, 'snapshot project', 'ship safely', 'tests pass', $3, $4, 7)
  `, [PROJECT, OWNER, COORDINATOR_SESSION, COORDINATOR]);
  await client.query(`
    INSERT INTO "project_runtime" ("project_id", "updated_at") VALUES ($1, CURRENT_TIMESTAMP)
  `, [PROJECT]);
  await client.query(`
    INSERT INTO "runner" ("id", "owner_id", "status", "labels", "version", "model_catalog") VALUES
      ($1, $2, 'ONLINE', ARRAY['linux'], '1.2.3', '{"codex":["gpt-5.6-sol"]}'),
      ($3, $4, 'ONLINE', ARRAY['foreign'], '9.9.9', '{}')
  `, [RUNNER, OWNER, FOREIGN_RUNNER, FOREIGN_OWNER]);
  await client.query(`
    INSERT INTO "workspace" (
      "id", "owner_id", "name", "runner_id", "enabled", "model", "effort",
      "default_merge_target", "work_dir_exists", "work_dir_is_git"
    ) VALUES
      ($1, $2, 'coordinator', $3, true, 'gpt-5.6-sol', 'high', 'feat/project', true, true),
      ($4, $5, 'foreign', $6, true, 'secret-model', 'max', 'foreign/main', true, true)
  `, [COORDINATOR, OWNER, RUNNER, FOREIGN_WORKSPACE, FOREIGN_OWNER, FOREIGN_RUNNER]);
  await client.query(`
    UPDATE "workspace"
       SET "provider_fallbacks" = '[{"provider":"codex","model":"gpt-5.6-sol"}]',
           "can_create_tasks" = true, "can_delegate" = true, "max_concurrent_tasks" = 2
     WHERE "id" = $1
  `, [COORDINATOR]);
  await client.query(`
    INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
      VALUES ('00000000-0000-7000-8000-000000001129', $1, $2, 'COORDINATOR')
  `, [PROJECT, COORDINATOR]);
  await client.query(`
    INSERT INTO "task" (
      "id", "owner_id", "project_id", "title", "description", "acceptance_criteria",
      "labels", "status", "assignee_id", "provider", "model"
    ) VALUES
      ($1, $2, $3, 'implementation', 'internal description', 'unit tests pass', ARRAY['dev'], 'OPEN', $4, 'custom', 'model-a'),
      ($5, $2, $3, 'verification', 'run tests', 'independent pass', ARRAY['verify'], 'DONE', $4, 'custom', 'model-a'),
      ($6, $7, $3, 'foreign task', 'must be invisible', NULL, ARRAY['foreign'], 'OPEN', $8, 'foreign', 'secret')
  `, [TASK, OWNER, PROJECT, COORDINATOR, VERIFIER, FOREIGN_TASK, FOREIGN_OWNER, FOREIGN_WORKSPACE]);
  await client.query(`UPDATE "task" SET "verifies_task_id" = $1 WHERE "id" = $2`, [TASK, VERIFIER]);
  await client.query(`
    INSERT INTO "task_dependency" ("task_id", "depends_on_task_id") VALUES ($1, $2)
  `, [VERIFIER, TASK]);
  await client.query(`
    INSERT INTO "session" (
      "id", "owner_id", "task_id", "workspace_id", "assigned_runner_id", "status",
      "provider", "model", "finished_at", "completed_at", "result", "branch", "base_sha",
      "changed_files", "merge_status", "merge_target", "merged_source_sha", "branch_merged",
      "worktree_branch", "worktree_dirty", "commit_status"
    ) VALUES
      ($1, $2, $3, $4, $5, 'SUCCEEDED', 'custom', 'model-a', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
       'implemented', 'orbit/task', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"path":"a.ts"}]',
       'merged', 'feat/project', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', true, 'orbit/task', false, 'committed'),
      ($6, $2, $7, $4, $5, 'SUCCEEDED', 'custom', 'model-a', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
       'tests: pass', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
      ($8, $2, NULL, $4, $5, 'AWAITING_INPUT', 'codex', 'gpt-5.6-sol', NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
      ($9, $10, $11, $12, $13, 'RUNNING', 'foreign', 'secret', NULL, NULL,
       'foreign result', 'foreign/secret', NULL, NULL, NULL, NULL, NULL, false, NULL, true, NULL)
  `, [
    SESSION, OWNER, TASK, COORDINATOR, RUNNER, VERIFIER_SESSION, VERIFIER,
    COORDINATOR_SESSION, FOREIGN_SESSION, FOREIGN_OWNER, FOREIGN_TASK, FOREIGN_WORKSPACE,
    FOREIGN_RUNNER,
  ]);
  await client.query(`
    INSERT INTO "model_provider" ("id", "slug", "runtime", "models", "default_model", "owner_id") VALUES
      ($1, 'custom', 'codex', '[{"value":"model-a"}]', 'model-a', $2),
      ($3, 'foreign', 'codex', '[{"value":"secret"}]', 'secret', $4)
  `, [PROVIDER, OWNER, FOREIGN_PROVIDER, FOREIGN_OWNER]);
}

test('consistent snapshot, replay, stale refusal and restart recovery hold on real PostgreSQL',
  { skip: !URL }, async () => {
    const a = await connect();
    const b = await connect();
    try {
      await reset(a);
      await useSchema(b);
      const dbA = prisma(a);
      const dbB = prisma(b);
      const events = new ProjectEventsService(dbA);
      const decisions = new ProjectDecisionService(dbA);
      const reconciler = new ProjectReconcileService(dbA, events, decisions);
      const started = new Date('2026-08-20T08:00:00.000Z');
      const lease = await reconciler.acquireLease(PROJECT, started);
      assert.ok(lease);

      const decisionId = createDecisionId();
      const appliedKey = `pc:v1:${PROJECT}:turn:0:apply`;
      let frozenInput: Awaited<ReturnType<ProjectDecisionService['capture']>>['input'];
      await dbA.$transaction(async (tx) => {
        const captured = await decisions.capture(tx, PROJECT, started);
        frozenInput = captured.input;
        const outcome = planProjectDecision(captured.input, {
          decisionId,
          actions: [{
            type: 'OPEN_COORDINATOR_TURN', idempotencyKey: appliedKey,
            subject: { type: 'PROJECT', id: uuidToBase62(PROJECT) },
          }],
        });
        await decisions.persist(tx, captured, outcome, decisionId);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

      assert.equal(frozenInput!.world.project.ownerId.length <= 22, true);
      assert.equal(frozenInput!.world.team.length, 1);
      assert.deepEqual(frozenInput!.world.team[0].providerFallbacks,
        [{ provider: 'codex', model: 'gpt-5.6-sol' }]);
      assert.equal(frozenInput!.world.team[0].maxConcurrentTasks, 2);
      assert.equal(frozenInput!.world.tasks.length, 2, 'foreign-owner task is outside the snapshot');
      assert.equal(frozenInput!.world.sessions.length, 3, 'foreign-owner session is outside the snapshot');
      assert.equal(frozenInput!.world.workspaces.length, 1);
      assert.equal(frozenInput!.world.runners.length, 1);
      assert.deepEqual(frozenInput!.world.providers.map((provider) => provider.slug), ['codex', 'custom']);
      assert.equal(frozenInput!.world.providers.find((provider) => provider.slug === 'codex')?.scope, 'BUILTIN');
      assert.equal(frozenInput!.world.evidence.branches.length, 1);
      assert.equal(frozenInput!.world.evidence.tests.length, 1);
      assert.doesNotMatch(JSON.stringify(frozenInput!),
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        'public snapshot JSON must not leak internal UUID spelling');

      const applied = await reconciler.applyDecisionAction(lease, decisionId, {
        idempotencyKey: appliedKey,
        type: 'OPEN_COORDINATOR_TURN',
        subject: { type: 'PROJECT', id: PROJECT },
      }, async (tx, actionId) => {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "business_effect" ("action_id", "marker") VALUES (${actionId}::uuid, 'applied')
        `);
      }, new Date('2026-08-20T08:00:00.500Z'));
      assert.equal(applied.status, 'APPLIED');
      assert.deepEqual((await a.query(`
        SELECT a."status"::text, a."decision_id"::text, e."marker"
          FROM "project_action" a JOIN "business_effect" e ON e."action_id" = a."id"
         WHERE a."idempotency_key" = $1
      `, [appliedKey])).rows[0], { status: 'APPLIED', decision_id: decisionId, marker: 'applied' });
      await assert.rejects(
        a.query(`UPDATE "project_decision" SET "reason" = 'rewritten' WHERE "id" = $1`, [decisionId]),
        /PROJECT_DECISION_IMMUTABLE/,
      );
      await assert.rejects(
        a.query(`UPDATE "project_action" SET "decision_id" = NULL WHERE "idempotency_key" = $1`, [appliedKey]),
        /ACTION_DECISION_LINK_FROZEN/,
      );

      const replay = await decisions.replay(OWNER, decisionId);
      assert.deepEqual(
        {
          matches: replay?.matches,
          hash: replay?.hashMatches,
          outcome: replay?.outcomeMatches,
          actions: replay?.actionsTraceable,
        },
        { matches: true, hash: true, outcome: true, actions: true },
      );
      assert.doesNotMatch(JSON.stringify(replay?.decision),
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        'public audit must Base62 ids embedded in action keys too');
      assert.equal(await decisions.replay(FOREIGN_OWNER, decisionId), null,
        'another tenant cannot replay the decision');

      const staleDecisionId = createDecisionId();
      const actionKey = `pc:v1:${PROJECT}:turn:0:stale`;
      let staleInput: Awaited<ReturnType<ProjectDecisionService['capture']>>['input'];
      await dbA.$transaction(async (tx) => {
        const captured = await decisions.capture(tx, PROJECT, new Date('2026-08-20T08:00:01.000Z'));
        staleInput = captured.input;
        const outcome = planProjectDecision(captured.input, {
          decisionId: staleDecisionId,
          actions: [{
            type: 'OPEN_COORDINATOR_TURN', idempotencyKey: actionKey,
            subject: { type: 'PROJECT', id: uuidToBase62(PROJECT) },
          }],
        });
        await decisions.persist(tx, captured, outcome, staleDecisionId);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

      const producerEvents = new ProjectEventsService(dbB);
      await dbB.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "task" SET "status" = 'DONE', "updated_at" = ${new Date('2026-08-20T08:00:01Z')}
           WHERE "id" = ${TASK}::uuid
        `);
        await producerEvents.enqueue(tx, {
          projectId: PROJECT,
          kind: 'task.updated',
          source: { type: 'TASK', id: SOURCE },
          dedupeKey: `task.updated:${SOURCE}:stale`,
        });
      });

      let effectCalls = 0;
      const refused = await reconciler.applyDecisionAction(lease, staleDecisionId, {
        idempotencyKey: actionKey,
        type: 'OPEN_COORDINATOR_TURN',
        subject: { type: 'PROJECT', id: PROJECT },
      }, async () => { effectCalls += 1; }, new Date('2026-08-20T08:00:02.000Z'));
      assert.equal(refused.status, 'REFUSED');
      assert.equal(effectCalls, 0);
      assert.deepEqual((await a.query(`
        SELECT "status"::text, "refusal_code", "decision_id"::text,
               "detail"->>'decisionInputHash' AS expected,
               "detail"->>'actualDecisionInputHash' AS actual
          FROM "project_action" WHERE "idempotency_key" = $1
      `, [actionKey])).rows[0], {
        status: 'REFUSED', refusal_code: 'STALE_SNAPSHOT', decision_id: staleDecisionId,
        expected: staleInput!.decisionInputHash,
        actual: refused.status === 'REFUSED' ? refused.actualDecisionInputHash : '',
      });
      assert.equal((await a.query(`
        SELECT count(*)::int n FROM "project_event"
         WHERE "kind" = 'coordinator.snapshot_stale' AND "consumed_at" IS NULL
      `)).rows[0].n, 1);
      assert.equal((await a.query(`
        SELECT "next_wake_at" IS NOT NULL AS wake,
               "next_wake_reason" = 'stale Coordinator decision requires reconcile' AS reason
          FROM "project_runtime" WHERE "project_id" = $1
      `, [PROJECT])).rows[0].wake, true);

      const duplicate = await reconciler.applyDecisionAction(lease, staleDecisionId, {
        idempotencyKey: actionKey,
        type: 'OPEN_COORDINATOR_TURN',
        subject: { type: 'PROJECT', id: PROJECT },
      }, async () => { effectCalls += 1; }, new Date('2026-08-20T08:00:03.000Z'));
      assert.equal(duplicate.status, 'ALREADY_APPLIED');
      assert.equal(effectCalls, 0);
      assert.equal((await a.query(`SELECT count(*)::int n FROM "project_action"`)).rows[0].n, 2);
      assert.equal((await a.query(`
        SELECT count(*)::int n FROM "project_event" WHERE "kind" = 'coordinator.snapshot_stale'
      `)).rows[0].n, 1, 'duplicate action does not create a second stale wake');

      assert.equal(await reconciler.releaseLease(lease), true);
      const restartedEvents = new ProjectEventsService(dbA);
      const restartedDecisions = new ProjectDecisionService(dbA);
      const restarted = new ProjectReconcileService(dbA, restartedEvents, restartedDecisions);
      restartedEvents.registerHandler(restarted);
      assert.equal((await restartedEvents.drainOnce(new Date('2026-08-20T08:00:04.000Z'))).status, 'CONSUMED');
      assert.equal((await a.query(`
        SELECT count(*)::int n FROM "project_event" WHERE "consumed_at" IS NULL
      `)).rows[0].n, 0, 'restart consumes both the business signal and stale-action wake');
      assert.equal((await a.query(`SELECT count(*)::int n FROM "project_decision"`)).rows[0].n, 3,
        'restart records a fresh replayable judgment');

      // Establish an MVCC snapshot, then commit a task/session pair on another connection. The
      // old transaction observes neither half; a new capture observes both, never a torn pair.
      await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await a.query('SELECT count(*) FROM "task"');
      await b.query('BEGIN');
      await b.query(`UPDATE "task" SET "status" = 'IN_PROGRESS', "updated_at" = CURRENT_TIMESTAMP WHERE "id" = $1`, [TASK]);
      await b.query(`
        INSERT INTO "session" ("id", "owner_id", "task_id", "workspace_id", "assigned_runner_id", "status")
        VALUES ($1, $2, $3, $4, $5, 'RUNNING')
      `, [LIVE_AFTER_SNAPSHOT, OWNER, TASK, COORDINATOR, RUNNER]);
      await b.query('COMMIT');
      const oldSnapshot = await restartedDecisions.capture(
        transactionClient(a), PROJECT, new Date('2026-08-20T08:00:05.000Z'),
      );
      assert.equal(oldSnapshot.input.world.tasks.find((task) => task.title === 'implementation')?.status, 'DONE');
      assert.equal(oldSnapshot.input.world.sessions.some((session) => session.runStatus === 'RUNNING'), false);
      await a.query('ROLLBACK');

      await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const newSnapshot = await restartedDecisions.capture(
        transactionClient(a), PROJECT, new Date('2026-08-20T08:00:05.000Z'),
      );
      await a.query('ROLLBACK');
      assert.equal(newSnapshot.input.world.tasks.find((task) => task.title === 'implementation')?.status, 'IN_PROGRESS');
      assert.equal(newSnapshot.input.world.sessions.some((session) => session.runStatus === 'RUNNING'), true);
      assert.notEqual(newSnapshot.input.decisionInputHash, oldSnapshot.input.decisionInputHash);

      const migrationCount = (await a.query(`
        SELECT count(*)::int n FROM information_schema.tables
         WHERE table_schema = $1 AND table_name IN ('project_event','project_action','project_decision')
      `, [SCHEMA])).rows[0].n;
      assert.equal(migrationCount, 3);
    } finally {
      await a.end();
      await b.end();
    }
  });
