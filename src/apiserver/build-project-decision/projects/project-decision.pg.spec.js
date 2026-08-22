"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_test_1 = require("node:test");
const client_1 = require("@prisma/client");
const shared_1 = require("@orbit/shared");
const project_decision_service_1 = require("./project-decision.service");
const coordinator_pg_test_safety_1 = require("./coordinator-pg-test-safety");
const project_events_service_1 = require("./project-events.service");
const project_reconcile_service_1 = require("./project-reconcile.service");
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
function migration(name) {
    return (0, node_fs_1.readFileSync)(node_path_1.default.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');
}
async function connect() {
    (0, coordinator_pg_test_safety_1.assertCoordinatorPgUrlIsIsolated)(URL);
    const { Client: Ctor } = (await import('pg'));
    const client = new Ctor({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    await (0, coordinator_pg_test_safety_1.verifyCoordinatorPgIdentity)(client);
    return client;
}
function rows(result) {
    return result.rows;
}
function transactionClient(client) {
    return {
        $queryRaw: async (query) => rows(await client.query(query.text, query.values)),
        $executeRaw: async (query) => (await client.query(query.text, query.values)).rowCount ?? 0,
        $executeRawUnsafe: async (query, ...values) => (await client.query(query, values)).rowCount ?? 0,
    };
}
function prisma(client) {
    const direct = transactionClient(client);
    return {
        $queryRaw: direct.$queryRaw.bind(direct),
        $executeRaw: direct.$executeRaw.bind(direct),
        $transaction: async (fn, options) => {
            const isolation = options?.isolationLevel === client_1.Prisma.TransactionIsolationLevel.RepeatableRead
                ? ' ISOLATION LEVEL REPEATABLE READ'
                : options?.isolationLevel === client_1.Prisma.TransactionIsolationLevel.Serializable
                    ? ' ISOLATION LEVEL SERIALIZABLE'
                    : '';
            await client.query(`BEGIN${isolation}`);
            try {
                const result = await fn(transactionClient(client));
                await client.query('COMMIT');
                return result;
            }
            catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        },
    };
}
async function useSchema(client) {
    await client.query(`SET search_path TO ${SCHEMA}`);
}
async function reset(client) {
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
      -- §13.6 SU1's columns, which the authorization adapter and the capture have selected since
      -- they landed: a hand-built subset only ever agrees with itself, and a stand-in schema that
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
      -- 13.3 DEP3's two: the lifecycle half the capture projects beside completed_at, and the
      -- end reason that tells a worker finishing the task from a person filing the session.
      "archived_at" TIMESTAMP(3), "end_reason" TEXT,
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
(0, node_test_1.test)('consistent snapshot, replay, stale refusal and restart recovery hold on real PostgreSQL', { skip: !URL }, async () => {
    const a = await connect();
    const b = await connect();
    try {
        await reset(a);
        await useSchema(b);
        const dbA = prisma(a);
        const dbB = prisma(b);
        const events = new project_events_service_1.ProjectEventsService(dbA);
        const decisions = new project_decision_service_1.ProjectDecisionService(dbA);
        const reconciler = new project_reconcile_service_1.ProjectReconcileService(dbA, events, decisions);
        const started = new Date('2026-08-20T08:00:00.000Z');
        const lease = await reconciler.acquireLease(PROJECT, started);
        strict_1.default.ok(lease);
        const decisionId = (0, project_decision_service_1.createDecisionId)();
        const appliedKey = `pc:v1:${PROJECT}:turn:0:apply`;
        let frozenInput;
        await dbA.$transaction(async (tx) => {
            const captured = await decisions.capture(tx, PROJECT, started);
            frozenInput = captured.input;
            const outcome = (0, project_decision_service_1.planProjectDecision)(captured.input, {
                decisionId,
                actions: [{
                        type: 'OPEN_COORDINATOR_TURN', idempotencyKey: appliedKey,
                        subject: { type: 'PROJECT', id: (0, shared_1.uuidToBase62)(PROJECT) },
                    }],
            });
            await decisions.persist(tx, captured, outcome, decisionId);
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.RepeatableRead });
        strict_1.default.equal(frozenInput.world.project.ownerId.length <= 22, true);
        strict_1.default.equal(frozenInput.world.team.length, 1);
        strict_1.default.deepEqual(frozenInput.world.team[0].providerFallbacks, [{ provider: 'codex', model: 'gpt-5.6-sol' }]);
        strict_1.default.equal(frozenInput.world.team[0].maxConcurrentTasks, 2);
        strict_1.default.equal(frozenInput.world.tasks.length, 2, 'foreign-owner task is outside the snapshot');
        strict_1.default.equal(frozenInput.world.sessions.length, 3, 'foreign-owner session is outside the snapshot');
        strict_1.default.equal(frozenInput.world.workspaces.length, 1);
        strict_1.default.equal(frozenInput.world.runners.length, 1);
        strict_1.default.deepEqual(frozenInput.world.providers.map((provider) => provider.slug), ['codex', 'custom']);
        strict_1.default.equal(frozenInput.world.providers.find((provider) => provider.slug === 'codex')?.scope, 'BUILTIN');
        strict_1.default.equal(frozenInput.world.evidence.branches.length, 1);
        strict_1.default.equal(frozenInput.world.evidence.tests.length, 1);
        strict_1.default.doesNotMatch(JSON.stringify(frozenInput), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'public snapshot JSON must not leak internal UUID spelling');
        const applied = await reconciler.applyDecisionAction(lease, decisionId, {
            idempotencyKey: appliedKey,
            type: 'OPEN_COORDINATOR_TURN',
            subject: { type: 'PROJECT', id: PROJECT },
        }, async (tx, actionId) => {
            await tx.$executeRaw(client_1.Prisma.sql `
          INSERT INTO "business_effect" ("action_id", "marker") VALUES (${actionId}::uuid, 'applied')
        `);
        }, new Date('2026-08-20T08:00:00.500Z'));
        strict_1.default.equal(applied.status, 'APPLIED');
        strict_1.default.deepEqual((await a.query(`
        SELECT a."status"::text, a."decision_id"::text, e."marker"
          FROM "project_action" a JOIN "business_effect" e ON e."action_id" = a."id"
         WHERE a."idempotency_key" = $1
      `, [appliedKey])).rows[0], { status: 'APPLIED', decision_id: decisionId, marker: 'applied' });
        await strict_1.default.rejects(a.query(`UPDATE "project_decision" SET "reason" = 'rewritten' WHERE "id" = $1`, [decisionId]), /PROJECT_DECISION_IMMUTABLE/);
        await strict_1.default.rejects(a.query(`UPDATE "project_action" SET "decision_id" = NULL WHERE "idempotency_key" = $1`, [appliedKey]), /ACTION_DECISION_LINK_FROZEN/);
        const replay = await decisions.replay(OWNER, decisionId);
        strict_1.default.deepEqual({
            matches: replay?.matches,
            hash: replay?.hashMatches,
            outcome: replay?.outcomeMatches,
            actions: replay?.actionsTraceable,
        }, { matches: true, hash: true, outcome: true, actions: true });
        strict_1.default.doesNotMatch(JSON.stringify(replay?.decision), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'public audit must Base62 ids embedded in action keys too');
        strict_1.default.equal(await decisions.replay(FOREIGN_OWNER, decisionId), null, 'another tenant cannot replay the decision');
        const staleDecisionId = (0, project_decision_service_1.createDecisionId)();
        const actionKey = `pc:v1:${PROJECT}:turn:0:stale`;
        let staleInput;
        await dbA.$transaction(async (tx) => {
            const captured = await decisions.capture(tx, PROJECT, new Date('2026-08-20T08:00:01.000Z'));
            staleInput = captured.input;
            const outcome = (0, project_decision_service_1.planProjectDecision)(captured.input, {
                decisionId: staleDecisionId,
                actions: [{
                        type: 'OPEN_COORDINATOR_TURN', idempotencyKey: actionKey,
                        subject: { type: 'PROJECT', id: (0, shared_1.uuidToBase62)(PROJECT) },
                    }],
            });
            await decisions.persist(tx, captured, outcome, staleDecisionId);
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.RepeatableRead });
        const producerEvents = new project_events_service_1.ProjectEventsService(dbB);
        await dbB.$transaction(async (tx) => {
            await tx.$executeRaw(client_1.Prisma.sql `
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
        strict_1.default.equal(refused.status, 'REFUSED');
        strict_1.default.equal(effectCalls, 0);
        strict_1.default.deepEqual((await a.query(`
        SELECT "status"::text, "refusal_code", "decision_id"::text,
               "detail"->>'decisionInputHash' AS expected,
               "detail"->>'actualDecisionInputHash' AS actual
          FROM "project_action" WHERE "idempotency_key" = $1
      `, [actionKey])).rows[0], {
            status: 'REFUSED', refusal_code: 'STALE_SNAPSHOT', decision_id: staleDecisionId,
            expected: staleInput.decisionInputHash,
            actual: refused.status === 'REFUSED' ? refused.actualDecisionInputHash : '',
        });
        strict_1.default.equal((await a.query(`
        SELECT count(*)::int n FROM "project_event"
         WHERE "kind" = 'coordinator.snapshot_stale' AND "consumed_at" IS NULL
      `)).rows[0].n, 1);
        strict_1.default.equal((await a.query(`
        SELECT "next_wake_at" IS NOT NULL AS wake,
               "next_wake_reason" = 'stale Coordinator decision requires reconcile' AS reason
          FROM "project_runtime" WHERE "project_id" = $1
      `, [PROJECT])).rows[0].wake, true);
        const duplicate = await reconciler.applyDecisionAction(lease, staleDecisionId, {
            idempotencyKey: actionKey,
            type: 'OPEN_COORDINATOR_TURN',
            subject: { type: 'PROJECT', id: PROJECT },
        }, async () => { effectCalls += 1; }, new Date('2026-08-20T08:00:03.000Z'));
        strict_1.default.equal(duplicate.status, 'ALREADY_APPLIED');
        strict_1.default.equal(effectCalls, 0);
        strict_1.default.equal((await a.query(`SELECT count(*)::int n FROM "project_action"`)).rows[0].n, 2);
        strict_1.default.equal((await a.query(`
        SELECT count(*)::int n FROM "project_event" WHERE "kind" = 'coordinator.snapshot_stale'
      `)).rows[0].n, 1, 'duplicate action does not create a second stale wake');
        strict_1.default.equal(await reconciler.releaseLease(lease), true);
        const restartedEvents = new project_events_service_1.ProjectEventsService(dbA);
        const restartedDecisions = new project_decision_service_1.ProjectDecisionService(dbA);
        const restarted = new project_reconcile_service_1.ProjectReconcileService(dbA, restartedEvents, restartedDecisions);
        restartedEvents.registerHandler(restarted);
        strict_1.default.equal((await restartedEvents.drainOnce(new Date('2026-08-20T08:00:04.000Z'))).status, 'CONSUMED');
        strict_1.default.equal((await a.query(`
        SELECT count(*)::int n FROM "project_event" WHERE "consumed_at" IS NULL
      `)).rows[0].n, 0, 'restart consumes both the business signal and stale-action wake');
        strict_1.default.equal((await a.query(`SELECT count(*)::int n FROM "project_decision"`)).rows[0].n, 3, 'restart records a fresh replayable judgment');
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
        const oldSnapshot = await restartedDecisions.capture(transactionClient(a), PROJECT, new Date('2026-08-20T08:00:05.000Z'));
        strict_1.default.equal(oldSnapshot.input.world.tasks.find((task) => task.title === 'implementation')?.status, 'DONE');
        strict_1.default.equal(oldSnapshot.input.world.sessions.some((session) => session.runStatus === 'RUNNING'), false);
        await a.query('ROLLBACK');
        await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const newSnapshot = await restartedDecisions.capture(transactionClient(a), PROJECT, new Date('2026-08-20T08:00:05.000Z'));
        await a.query('ROLLBACK');
        strict_1.default.equal(newSnapshot.input.world.tasks.find((task) => task.title === 'implementation')?.status, 'IN_PROGRESS');
        strict_1.default.equal(newSnapshot.input.world.sessions.some((session) => session.runStatus === 'RUNNING'), true);
        strict_1.default.notEqual(newSnapshot.input.decisionInputHash, oldSnapshot.input.decisionInputHash);
        const migrationCount = (await a.query(`
        SELECT count(*)::int n FROM information_schema.tables
         WHERE table_schema = $1 AND table_name IN ('project_event','project_action','project_decision')
      `, [SCHEMA])).rows[0].n;
        strict_1.default.equal(migrationCount, 3);
    }
    finally {
        await a.end();
        await b.end();
    }
});
//# sourceMappingURL=project-decision.pg.spec.js.map