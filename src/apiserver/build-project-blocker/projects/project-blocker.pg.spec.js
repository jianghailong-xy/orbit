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
const coordinator_pg_test_safety_1 = require("./coordinator-pg-test-safety");
const project_decision_service_1 = require("./project-decision.service");
const project_events_service_1 = require("./project-events.service");
const project_reconcile_service_1 = require("./project-reconcile.service");
const project_blocker_1 = require("./project-blocker");
const project_next_wake_1 = require("./project-next-wake");
const project_blocker_guard_1 = require("./project-blocker-guard");
// Structured blockers on real PostgreSQL (contract §11), against a DISPOSABLE server.
//
// Everything asserted here is a property of the DATABASE and not of the planner: the partial unique
// index that makes one open episode per key, the `MAX + 1` generation that survives a takeover, the
// trigger that refuses a second escalation, the compare-and-set that resolves a row once. A unit
// test can only show that the code intends those; the index and the triggers are what still hold
// when the next writer forgets.
//
// The server is disposable and proved so before the first write (`coordinator-pg-test-safety.ts`):
// a copied production URL fails on the explicit expected database, role and system identifier
// rather than on a `DROP SCHEMA` that already ran.
const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc17_blocker';
const skip = !URL;
const OWNER = '00000000-0000-7000-8000-000000001701';
const PROJECT = '00000000-0000-7000-8000-000000001702';
const LEGACY_PROJECT = '00000000-0000-7000-8000-000000001703';
const COORDINATOR = '00000000-0000-7000-8000-000000001704';
const RUNNER = '00000000-0000-7000-8000-000000001705';
const TASK = '00000000-0000-7000-8000-000000001706';
const OTHER_TASK = '00000000-0000-7000-8000-000000001707';
const VERIFIER = '00000000-0000-7000-8000-000000001708';
const SESSION = '00000000-0000-7000-8000-000000001709';
const LEGACY_TASK = '00000000-0000-7000-8000-000000001710';
const OUTBOX = migration('0116_project_event_outbox');
const RECONCILE = migration('0119_project_reconcile_runtime');
const DECISION = migration('0120_project_decision_audit');
const AUTHORIZATION = migration('0121_project_authorization_policy');
const BLOCKER = migration('0125_project_blocker');
/**
 * The kind CHECK as it stands TODAY, not as 0125 first wrote it.
 *
 * This spec builds a schema subset and applies 0125 to it, which was the whole schema for this
 * table until a later migration added kinds. Re-applying only the first one would freeze this
 * fixture on a closed set the product has moved past, and the failure reads as "the new kind is
 * invalid" rather than "the fixture is old". Only the two `ALTER TABLE` statements are taken — the
 * same file's `ALTER TYPE` touches an enum this subset does not build.
 */
const KIND_CHECK = migration('0135_project_task_completion_gap')
    .split(';')
    .filter((statement) => /project_blocker_kind_chk/.test(statement))
    .map((statement) => `${statement};`)
    .join('\n');
function migration(name) {
    return (0, node_fs_1.readFileSync)(node_path_1.default.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');
}
async function connect() {
    (0, coordinator_pg_test_safety_1.assertCoordinatorPgUrlIsIsolated)(URL);
    const { Client: Ctor } = (await import('pg'));
    const client = new Ctor({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    await (0, coordinator_pg_test_safety_1.verifyCoordinatorPgIdentity)(client);
    await client.query(`SET search_path TO ${SCHEMA}`);
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
            const isolation = options?.isolationLevel === client_1.Prisma.TransactionIsolationLevel.Serializable
                ? ' ISOLATION LEVEL SERIALIZABLE'
                : ' ISOLATION LEVEL REPEATABLE READ';
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
async function reset(client) {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
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
      -- §13.6 SU1's columns, which the authorization adapter and every reconcile in this file read
      -- since 0130: a stand-in schema that omits a column the code under test selects fails on the
      -- column, not on the property. Missing here since they landed, so eleven of the fifteen tests
      -- were failing on a missing column rather than on anything they assert. Same drift, same fix,
      -- as the one repaired in project-authorization.pg.spec.
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
      -- 13.3 DEP3's two, which the capture projects beside completed_at: the other half of 4.2's
      -- COMPLETED lifecycle, and the end reason that tells a worker finishing the task apart from
      -- a person filing the session.
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
  `);
    await client.query(AUTHORIZATION);
    // `reason_code` arrives with migration 0122, whose dispatch-boundary triggers belong to §7.7 and
    // would reject the synthetic ledger rows this fixture writes on purpose. The column is what §11
    // reads (TR2-a's window bucket), so this fixture declares it and stops there.
    await client.query(`ALTER TABLE "project_action" ADD COLUMN "reason_code" TEXT`);
    await client.query(BLOCKER);
    await client.query(KIND_CHECK);
    await client.query(`
    INSERT INTO "project" ("id", "owner_id", "title", "coordinator_workspace_id") VALUES
      ($1, $2, 'blocker project', $3),
      ($4, $2, 'legacy project', NULL)
  `, [PROJECT, OWNER, COORDINATOR, LEGACY_PROJECT]);
    await client.query(`
    UPDATE "project" SET "coordinator_enabled" = false WHERE "id" = $1
  `, [LEGACY_PROJECT]);
    await client.query(`
    INSERT INTO "project_runtime" ("project_id", "updated_at")
      VALUES ($1, CURRENT_TIMESTAMP), ($2, CURRENT_TIMESTAMP)
  `, [PROJECT, LEGACY_PROJECT]);
    await client.query(`
    INSERT INTO "runner" ("id", "owner_id", "status", "model_catalog")
      VALUES ($1, $2, 'ONLINE', '{"codex":["gpt-5.6-sol"]}')
  `, [RUNNER, OWNER]);
    await client.query(`
    INSERT INTO "workspace" ("id", "owner_id", "name", "runner_id") VALUES ($1, $2, 'coordinator', $3)
  `, [COORDINATOR, OWNER, RUNNER]);
    await client.query(`
    INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
      VALUES ('00000000-0000-7000-8000-000000001711', $1, $2, 'COORDINATOR')
  `, [PROJECT, COORDINATOR]);
    await client.query(`
    INSERT INTO "task" ("id", "owner_id", "project_id", "title", "assignee_id", "status") VALUES
      ($1, $2, $3, 'implementation', $4, 'OPEN'),
      ($5, $2, $3, 'other work', $4, 'OPEN'),
      ($6, $2, $3, 'verification', $4, 'DONE'),
      ($7, $2, $8, 'legacy work', $4, 'OPEN')
  `, [TASK, OWNER, PROJECT, COORDINATOR, OTHER_TASK, VERIFIER, LEGACY_TASK, LEGACY_PROJECT]);
    await client.query(`UPDATE "task" SET "verifies_task_id" = $1 WHERE "id" = $2`, [TASK, VERIFIER]);
}
/** One delivery of the real loop: capture, plan, publish blockers, publish the runtime row. */
async function reconcile(db, reconciler) {
    await db.$transaction(async (tx) => reconciler.handle(tx, PROJECT, []), { isolationLevel: client_1.Prisma.TransactionIsolationLevel.RepeatableRead });
}
/** The lever most of §11.2's table hangs off: PAC refuses a dispatch, and the code IS the kind. */
async function refuse(client, taskId, refusalCode, at) {
    await client.query(`
    INSERT INTO "project_action" (
      "id", "project_id", "idempotency_key", "type", "status", "subject_type", "subject_id",
      "fencing_token", "refusal_code", "created_at", "updated_at"
    ) VALUES (
      gen_random_uuid(), $1, $2, 'DISPATCH_TASK', 'REFUSED', 'TASK', $3, 1, $4,
      COALESCE($5::timestamp(3), CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
    )
  `, [PROJECT, `pc:v1:${PROJECT}:dispatch:${taskId}:${refusalCode}:${Math.random()}`, taskId, refusalCode, at ?? null]);
}
async function blockers(client, projectId = PROJECT) {
    return rows(await client.query(`
    SELECT "id", "kind", "owner"::text, "recovery"::text, "severity"::text, "required_action",
           "next_check_at", "subject_type", "subject_id", "detail", "dedupe_key",
           "lifecycle_generation"::text AS "lifecycle_generation", "condition_version",
           "first_seen_at", "last_seen_at", "occurrences", "escalated_at",
           "resolved_at", "resolved_by"::text
      FROM "project_blocker" WHERE "project_id" = $1
     ORDER BY "dedupe_key", "lifecycle_generation"
  `, [projectId]));
}
async function runtime(client) {
    return rows(await client.query(`
      SELECT "run_state", "next_wake_at", "next_wake_reason" FROM "project_runtime"
       WHERE "project_id" = $1
    `, [PROJECT]))[0];
}
async function latestDecision(client) {
    const row = rows(await client.query(`
      SELECT "outcome", "decision_input" FROM "project_decision"
       WHERE "project_id" = $1 ORDER BY "created_at" DESC, "id" DESC LIMIT 1
    `, [PROJECT]))[0];
    return { outcome: row.outcome, epoch: row.decision_input.evaluation.epoch };
}
function loop(client) {
    const db = prisma(client);
    const events = new project_events_service_1.ProjectEventsService(db);
    const decisions = new project_decision_service_1.ProjectDecisionService(db);
    return { db, events, reconciler: new project_reconcile_service_1.ProjectReconcileService(db, events, decisions) };
}
(0, node_test_1.test)('every blocker kind persists all five answers and every audited column', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const { db, reconciler } = loop(client);
        // One task per kind, so each condition has its own subject and they can all be observed in a
        // single pass — which is also the strongest form of "the plan is a set, not a sequence".
        const byRefusal = [
            ['WHO_UNRESOLVED', 'WHO_UNRESOLVED'],
            ['WHO_NOT_IN_TEAM', 'WHO_NOT_IN_TEAM'],
            ['WHO_DISABLED', 'WHO_DISABLED'],
            ['PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE'],
            ['RUNTIME_REQUIREMENT_UNMET', 'RUNTIME_REQUIREMENT_UNMET'],
            ['NO_MATCHING_RUNNER', 'RUNNER_UNAVAILABLE'],
            ['TEST_FAILED', 'MAX_ATTEMPTS_REACHED'],
            ['VERIFICATION_FAILED', 'VERIFICATION_DEFECT_OPEN'],
            ['BUDGET_EXHAUSTED', 'SESSION_BUDGET_EXHAUSTED'],
            ['AWAITING_USER_APPROVAL', 'APPROVAL_PENDING'],
            ['POLICY_MANUAL_HOLD', 'USER_CONTROL_REQUIRED'],
            ['COORDINATOR_UNAVAILABLE', 'COORDINATOR_NOT_ASSIGNED'],
            ['UNKNOWN_FAILURE', 'A_CODE_NOBODY_CLASSIFIED'],
        ];
        for (const [at, [, refusalCode]] of byRefusal.entries()) {
            const taskId = `00000000-0000-7000-8000-0000000018${String(at).padStart(2, '0')}`;
            await client.query(`
        INSERT INTO "task" ("id", "owner_id", "project_id", "title", "assignee_id", "status")
          VALUES ($1, $2, $3, $4, $5, 'OPEN')
      `, [taskId, OWNER, PROJECT, `task ${refusalCode}`, COORDINATOR]);
            await refuse(client, taskId, refusalCode);
        }
        // MERGE_CONFLICT and AWAITING_USER_INPUT come from session evidence, not from a refusal.
        await client.query(`
      INSERT INTO "session" ("id", "owner_id", "task_id", "workspace_id", "status", "branch",
                             "merge_status", "merge_target", "changed_files")
        VALUES ($1, $2, $3, $4, 'AWAITING_INPUT', 'orbit/task', 'conflict', 'main', '[{"path":"a.ts"}]')
    `, [SESSION, OWNER, TASK, COORDINATOR]);
        // DEPENDENCY_CYCLE comes from the graph unit 15 also refuses to aggregate over.
        await client.query(`
      INSERT INTO "task_dependency" ("task_id", "depends_on_task_id") VALUES ($1, $2), ($2, $1)
    `, [TASK, OTHER_TASK]);
        // NO_PROJECT_WORKSPACE: this fixture's only candidate location is the coordinator seat's
        // workspace. Disabling it leaves the project with candidates it can no longer use — which is
        // the condition, as distinct from having none at all.
        await client.query(`UPDATE "workspace" SET "enabled" = false WHERE "id" = $1`, [COORDINATOR]);
        await reconcile(db, reconciler);
        const rowsByKind = new Map((await blockers(client)).map((row) => [row.kind, row]));
        const expected = [
            ...byRefusal.map(([kind]) => kind),
            'MERGE_CONFLICT', 'AWAITING_USER_INPUT', 'DEPENDENCY_CYCLE', 'NO_PROJECT_WORKSPACE',
        ].sort();
        strict_1.default.deepEqual([...rowsByKind.keys()].sort(), expected, 'every kind this deployment can observe must reach the table');
        const { epoch } = await latestDecision(client);
        for (const [kind, row] of rowsByKind) {
            const policy = project_blocker_1.PROJECT_BLOCKER_POLICY[kind];
            strict_1.default.equal(row.owner, policy.owner, `${kind} owner`);
            strict_1.default.equal(row.recovery, policy.recovery, `${kind} recovery`);
            strict_1.default.equal(row.severity, policy.severity, `${kind} severity`);
            strict_1.default.equal(row.required_action, policy.requiredAction, `${kind} required action`);
            strict_1.default.equal(row.lifecycle_generation, '1', `${kind} first episode`);
            strict_1.default.equal(row.occurrences, 1, `${kind} occurrences`);
            strict_1.default.match(row.condition_version, /^[0-9a-f]{64}$/, `${kind} condition version`);
            strict_1.default.equal(row.escalated_at, null, `${kind} not escalated on the pass that opened it`);
            strict_1.default.equal(row.resolved_at, null, `${kind} open`);
            strict_1.default.equal(row.resolved_by, null, `${kind} unresolved`);
            strict_1.default.equal(row.dedupe_key, `${kind}:${row.subject_type}:${row.subject_id}`, `${kind} key`);
            strict_1.default.equal(row.first_seen_at.getTime(), row.last_seen_at.getTime(), `${kind} seen once`);
            strict_1.default.ok(Object.keys(row.detail).length > 0, `${kind} carries diagnosis`);
            // BL5, measured against the FROZEN epoch rather than against a second clock reading.
            const check = row.next_check_at.getTime();
            if (policy.recovery === 'EVENT') {
                strict_1.default.equal(check, epoch * 1_000 + policy.pollMs, `${kind} recompute poll`);
            }
            else if (policy.recovery === 'HUMAN') {
                strict_1.default.equal(check, row.first_seen_at.getTime() + policy.escalateMs, `${kind} escalation alarm`);
            }
            else {
                strict_1.default.ok(check > epoch * 1_000, `${kind} recovery instant`);
            }
            // §7.3 / BE3: the raise key and the row are one-to-one.
            const action = rows(await client.query(`
        SELECT count(*)::text n FROM "project_action"
         WHERE "idempotency_key" = $1 AND "type" = 'RAISE_BLOCKER' AND "status" = 'APPLIED'
      `, [`pc:v1:${PROJECT}:blocker:${kind}:${row.subject_id}:${row.lifecycle_generation}`]))[0];
            strict_1.default.equal(action.n, '1', `${kind} raise action`);
        }
        // §4.2 guard 2: several of these are USER-owned, so the project is waiting on a person — and
        // the masked SYSTEM/COORDINATOR rows are still open and still carry their own clocks (N-mask).
        const state = await runtime(client);
        strict_1.default.equal(state.run_state, 'AWAITING_HUMAN');
        strict_1.default.ok(state.next_wake_at, 'I5: a project with blockers must still have a clock');
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('the same cause five times is one row, one action and no second notification', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const { db, reconciler } = loop(client);
        await refuse(client, TASK, 'WHO_UNRESOLVED');
        // ES5 quantifies over "any N, any order, ACROSS RESTARTS", so half the passes run on a service
        // built from scratch — a takeover reads the same committed rows and must reach the same answer.
        for (let pass = 0; pass < 5; pass += 1) {
            await reconcile(db, pass < 3 ? reconciler : loop(client).reconciler);
        }
        const open = await blockers(client);
        strict_1.default.equal(open.length, 1, 'AC8: one open episode per cause');
        strict_1.default.equal(open[0].kind, 'WHO_UNRESOLVED');
        strict_1.default.equal(open[0].lifecycle_generation, '1');
        // ES5's two permitted columns, and only those two.
        strict_1.default.equal(open[0].occurrences, 5);
        strict_1.default.ok(open[0].last_seen_at.getTime() >= open[0].first_seen_at.getTime());
        strict_1.default.equal(open[0].escalated_at, null);
        const counts = rows(await client.query(`
      SELECT
        (SELECT count(*)::text FROM "project_action" WHERE "type" = 'RAISE_BLOCKER') AS raises,
        (SELECT count(*)::text FROM "project_action" WHERE "type" = 'CLEAR_BLOCKER') AS clears,
        (SELECT count(*)::text FROM "project_event" WHERE "kind" = 'blocker.escalated') AS escalations
    `))[0];
        strict_1.default.deepEqual(counts, { raises: '1', clears: '0', escalations: '0' }, 'five deliveries of one fact produce one action and no notification');
        // The digest is the CONDITION, so it did not move either — that is what lets §7.6 TR1 tell a
        // redelivery from a world that actually changed.
        const versions = rows(await client.query(`
      SELECT count(DISTINCT ("outcome" #>> '{blockers,open,0,conditionVersion}'))::text n
        FROM "project_decision" WHERE "project_id" = $1
    `, [PROJECT]))[0];
        strict_1.default.equal(versions.n, '1');
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('a condition that goes away clears itself, in the pass that recomputes the state', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const { db, reconciler } = loop(client);
        await refuse(client, TASK, 'PROVIDER_UNAVAILABLE');
        await reconcile(db, reconciler);
        strict_1.default.equal((await runtime(client)).run_state, 'BLOCKED');
        const raised = (await blockers(client))[0];
        // The world moves on: the next attempt on that task went through. BL3 — the row clears because
        // the CONDITION was recomputed and is gone, not because anything announced a recovery.
        await client.query(`
      INSERT INTO "project_action" (
        "id", "project_id", "idempotency_key", "type", "status", "subject_type", "subject_id",
        "fencing_token", "updated_at"
      ) VALUES (gen_random_uuid(), $1, $2, 'DISPATCH_TASK', 'APPLIED', 'TASK', $3, 1, CURRENT_TIMESTAMP)
    `, [PROJECT, `pc:v1:${PROJECT}:dispatch:${TASK}:1`, TASK]);
        await reconcile(db, reconciler);
        const cleared = (await blockers(client))[0];
        strict_1.default.equal(cleared.id, raised.id, 'the row is resolved, never deleted (BE1 reads it again)');
        strict_1.default.ok(cleared.resolved_at, '§11.4: the condition is gone, so the row is resolved');
        strict_1.default.equal(cleared.resolved_by, 'AUTO', 'nobody did anything; the world stopped being that way');
        strict_1.default.equal(rows(await client.query(`
      SELECT count(*)::text n FROM "project_action"
       WHERE "type" = 'CLEAR_BLOCKER' AND "idempotency_key" = $1
    `, [`pc:v1:${PROJECT}:unblock:${cleared.id}`]))[0].n, '1');
        // And the state and the clock were recomputed in the SAME pass, not on the next tick.
        const state = await runtime(client);
        strict_1.default.notEqual(state.run_state, 'BLOCKED');
        strict_1.default.ok(state.next_wake_at, 'the wake is recomputed immediately too');
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('BE1: a cause that comes back after clearing is a new episode, one generation later', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const { db, reconciler } = loop(client);
        await refuse(client, TASK, 'NO_MATCHING_RUNNER');
        await reconcile(db, reconciler);
        await client.query(`DELETE FROM "project_action" WHERE "type" = 'DISPATCH_TASK'`);
        await reconcile(db, reconciler);
        await refuse(client, TASK, 'NO_MATCHING_RUNNER');
        await reconcile(db, reconciler);
        const episodes = await blockers(client);
        strict_1.default.deepEqual(episodes.map((row) => row.lifecycle_generation), ['1', '2']);
        strict_1.default.equal(episodes[0].resolved_by, 'AUTO');
        strict_1.default.equal(episodes[1].resolved_at, null);
        // Two rows, two keys, two turn identities: §7.6 TR3 can tell "it broke again" from "the
        // coordinator ran and changed nothing".
        strict_1.default.equal(rows(await client.query(`
      SELECT count(DISTINCT "idempotency_key")::text n FROM "project_action" WHERE "type" = 'RAISE_BLOCKER'
    `))[0].n, '2');
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('the database refuses a second open episode and a duplicate generation', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const insert = async (generation) => client.query(`
      INSERT INTO "project_blocker" (
        "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
        "next_check_at", "subject_type", "subject_id", "dedupe_key", "lifecycle_generation",
        "condition_version", "first_seen_at", "last_seen_at", "updated_at"
      ) VALUES (
        gen_random_uuid(), $1::uuid, 'MERGE_CONFLICT', 'COORDINATOR', 'EVENT', 'CRITICAL', 'fix it',
        CURRENT_TIMESTAMP, 'TASK', $2::text, $3, $4, repeat('a', 64),
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `, [PROJECT, TASK, `MERGE_CONFLICT:TASK:${TASK}`, generation]);
        await insert(1);
        // §11.3's partial unique index: one OPEN episode per key, whatever the generation.
        await strict_1.default.rejects(insert(2), /project_blocker_open_dedupe_idx/);
        const resolveAll = () => client.query(`
      UPDATE "project_blocker" SET "resolved_at" = CURRENT_TIMESTAMP, "resolved_by" = 'AUTO'
       WHERE "resolved_at" IS NULL
    `);
        await resolveAll();
        await insert(2);
        await resolveAll();
        // BE1's second index, over ALL rows and not just open ones: two raisers that computed the same
        // `MAX + 1` in a takeover window cannot both land even once neither episode is open.
        await strict_1.default.rejects(insert(2), /project_blocker_episode_idx/);
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('two writers racing the same raise cannot both land', { skip }, async () => {
    const a = await connect();
    const b = await connect();
    try {
        await reset(a);
        await b.query(`SET search_path TO ${SCHEMA}`);
        // §11.3 BE2: ordinary reads do not see uncommitted writes, so two raisers in a takeover window
        // CAN compute the same `MAX + 1`. What stops both from landing is the pair of indexes plus
        // §8.5 C1's `ON CONFLICT ... DO NOTHING RETURNING` — a conflict is a return value, not a
        // rollback, so the loser reads the winner's row and carries on with ITS generation.
        const raise = (client) => client.query(`
      INSERT INTO "project_blocker" (
        "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
        "next_check_at", "subject_type", "subject_id", "dedupe_key", "lifecycle_generation",
        "condition_version", "first_seen_at", "last_seen_at", "updated_at"
      )
      SELECT gen_random_uuid(), $1::uuid, 'MERGE_CONFLICT', 'COORDINATOR', 'EVENT', 'CRITICAL',
             'fix it', CURRENT_TIMESTAMP, 'TASK', $2::text, $3,
             COALESCE(MAX(x."lifecycle_generation"), 0) + 1, repeat('a', 64),
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM "project_blocker" x
       WHERE x."project_id" = $1::uuid AND x."dedupe_key" = $3
      ON CONFLICT ("project_id", "dedupe_key") WHERE "resolved_at" IS NULL DO NOTHING
      RETURNING "id", "lifecycle_generation"::text AS "lifecycle_generation"
    `, [PROJECT, TASK, `MERGE_CONFLICT:TASK:${TASK}`]);
        await a.query('BEGIN');
        await b.query('BEGIN');
        const first = await raise(a);
        await a.query('COMMIT');
        const second = await raise(b);
        await b.query('COMMIT');
        strict_1.default.equal(first.rowCount, 1, 'one writer opens the episode');
        strict_1.default.equal(second.rowCount, 0, 'the other gets a return value, not an exception');
        const open = await blockers(a);
        strict_1.default.equal(open.length, 1);
        strict_1.default.equal(open[0].lifecycle_generation, '1');
    }
    finally {
        await a.end();
        await b.end();
    }
});
(0, node_test_1.test)('escalation is once, to USER, leaves recovery, and notifies exactly once', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const { db, reconciler } = loop(client);
        // BUDGET_EXHAUSTED is the row `PC-CX-05` was written about: SYSTEM/TIME, so it clears itself —
        // and escalating it must not turn it into a wait for a person that time can no longer end.
        await refuse(client, TASK, 'SESSION_BUDGET_EXHAUSTED');
        await reconcile(db, reconciler);
        strict_1.default.equal((await runtime(client)).run_state, 'BLOCKED');
        // ES4: age alone. Nothing else about the world changes.
        await client.query(`
      UPDATE "project_blocker" SET "first_seen_at" = CURRENT_TIMESTAMP - INTERVAL '25 hours'
    `);
        await reconcile(db, reconciler);
        await reconcile(db, reconciler);
        await reconcile(db, reconciler);
        const row = (await blockers(client))[0];
        strict_1.default.equal(row.owner, 'USER', 'ES3: exactly one step, and always to USER');
        strict_1.default.equal(row.recovery, 'TIME', 'ES1: escalation does not change what can clear it');
        strict_1.default.ok(row.escalated_at);
        strict_1.default.equal((await runtime(client)).run_state, 'AWAITING_HUMAN', 'I4a');
        strict_1.default.equal(rows(await client.query(`
      SELECT count(*)::text n FROM "project_event" WHERE "kind" = 'blocker.escalated'
    `))[0].n, '1', 'three passes past the threshold still notify once');
        // And the database refuses a second escalation whoever attempts it.
        await strict_1.default.rejects(client.query(`
      UPDATE "project_blocker" SET "escalated_at" = CURRENT_TIMESTAMP
    `), /BLOCKER_ALREADY_ESCALATED/);
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('an escalated HUMAN blocker is the one legal way to stop the clock', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const { db, reconciler } = loop(client);
        await refuse(client, TASK, 'MAX_ATTEMPTS_REACHED');
        await reconcile(db, reconciler);
        strict_1.default.ok((await runtime(client)).next_wake_at, 'before escalation it is still ticking');
        await client.query(`
      UPDATE "project_blocker" SET "first_seen_at" = CURRENT_TIMESTAMP - INTERVAL '25 hours'
    `);
        await reconcile(db, reconciler);
        const state = await runtime(client);
        strict_1.default.equal(state.run_state, 'AWAITING_HUMAN');
        // N-null: TEST_FAILED is HUMAN, it is now escalated, nothing is backing off, nothing is
        // scheduled, nothing is in flight. This is the only shape in which a null is not a defect.
        strict_1.default.equal(state.next_wake_at, null);
        strict_1.default.equal(state.next_wake_reason, null);
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('an open blocker stops dispatch, and stopping it breeds no second blocker', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const { db, reconciler } = loop(client);
        await refuse(client, TASK, 'WHO_UNRESOLVED');
        await reconcile(db, reconciler);
        // The guard's own refusal, as the dispatcher writes it. It must be transparent to §11.2's
        // detector: reading it as this task's latest verdict would clear the very row that caused it,
        // then reopen it next pass, advancing a generation every tick.
        await refuse(client, TASK, 'PROJECT_BLOCKED');
        await reconcile(db, reconciler);
        await reconcile(db, reconciler);
        const open = await blockers(client);
        strict_1.default.equal(open.length, 1);
        strict_1.default.equal(open[0].kind, 'WHO_UNRESOLVED');
        strict_1.default.equal(open[0].lifecycle_generation, '1', 'the guard must not flap the episode counter');
        strict_1.default.equal(open[0].resolved_at, null);
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('the guard stops the right dispatches and only those', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const raw = async (kind, subjectType, subjectId) => client.query(`
      INSERT INTO "project_blocker" (
        "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
        "next_check_at", "subject_type", "subject_id", "dedupe_key", "lifecycle_generation",
        "condition_version", "first_seen_at", "last_seen_at", "updated_at"
      ) VALUES (
        gen_random_uuid(), $1::uuid, $2::text, 'USER', 'HUMAN', 'CRITICAL', 'do the thing',
        CURRENT_TIMESTAMP, $3::text, $4::text, $2::text || ':' || $3::text || ':' || $4::text, 1, repeat('d', 64),
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `, [PROJECT, kind, subjectType, subjectId]);
        const guard = async (taskId) => {
            const sql = (0, project_blocker_guard_1.openBlockersStoppingDispatch)(PROJECT, taskId);
            return rows(await client.query(sql.text, sql.values));
        };
        strict_1.default.deepEqual(await guard(TASK), [], 'nothing open, nothing stopped');
        await raw('MERGE_CONFLICT', 'TASK', TASK);
        strict_1.default.deepEqual((await guard(TASK)).map((r) => r.kind), ['MERGE_CONFLICT']);
        strict_1.default.deepEqual(await guard(OTHER_TASK), [], 'a task-scoped row stops its own task only');
        // ...with one exception, and it is not a softening: §7.4 re-answers the resolution chain's own
        // codes from the current world on EVERY attempt, so a row of one of those kinds describes the
        // last answer rather than gating the next. Gating it would freeze §11.4's recomputation on a
        // refusal that can no longer be superseded — the provider comes back and the row never clears
        // (unit 18's counterexample, verify18-control-loop.pg.spec).
        await raw('WHO_UNRESOLVED', 'TASK', TASK);
        strict_1.default.deepEqual((await guard(TASK)).map((r) => r.kind), ['MERGE_CONFLICT'], 'a chain-derived task row must not stop the attempt that recomputes it');
        await raw('COORDINATOR_UNAVAILABLE', 'TASK', TASK);
        strict_1.default.deepEqual((await guard(TASK)).map((r) => r.kind), ['MERGE_CONFLICT'], 'a historical missing-coordinator refusal must not block its recovery attempt');
        await raw('COORDINATOR_UNAVAILABLE', 'PROJECT', PROJECT);
        strict_1.default.deepEqual((await guard(OTHER_TASK)).map((r) => r.kind), ['COORDINATOR_UNAVAILABLE'], 'current project-wide coordinator unavailability remains a hard gate');
        await client.query(`
      DELETE FROM "project_blocker"
       WHERE "project_id" = $1 AND "kind" = 'COORDINATOR_UNAVAILABLE'
         AND "subject_type" = 'PROJECT'
    `, [PROJECT]);
        // Somebody is being waited on inside one conversation. That stops that conversation, not the
        // rest of the project — otherwise one unanswered question freezes every other task.
        await raw('AWAITING_USER_INPUT', 'SESSION', SESSION);
        strict_1.default.deepEqual(await guard(OTHER_TASK), []);
        // A project-scoped row stops everything, because there is nowhere for anything to run.
        await raw('NO_PROJECT_WORKSPACE', 'PROJECT', PROJECT);
        strict_1.default.deepEqual((await guard(OTHER_TASK)).map((r) => r.kind), ['NO_PROJECT_WORKSPACE']);
        strict_1.default.deepEqual((await guard(TASK)).map((r) => r.kind), ['MERGE_CONFLICT', 'NO_PROJECT_WORKSPACE']);
        // And resolving it lets the work through again without anything else changing.
        await client.query(`
      UPDATE "project_blocker" SET "resolved_at" = CURRENT_TIMESTAMP, "resolved_by" = 'AUTO'
       WHERE "kind" = 'NO_PROJECT_WORKSPACE'
    `);
        strict_1.default.deepEqual(await guard(OTHER_TASK), []);
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('§10.4: next_wake_at is the smallest candidate, floored, with the whole table audited', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const { db, reconciler } = loop(client);
        // NO_MATCHING_RUNNER polls at +2min; WHO_UNRESOLVED at +5min. The smaller one has to win, and
        // the loser has to be recorded rather than dropped.
        await refuse(client, TASK, 'RUNNER_UNAVAILABLE');
        await refuse(client, OTHER_TASK, 'WHO_UNRESOLVED');
        await reconcile(db, reconciler);
        const { outcome, epoch } = await latestDecision(client);
        const state = await runtime(client);
        strict_1.default.equal(state.next_wake_at.getTime(), epoch * 1_000 + project_blocker_1.PROJECT_BLOCKER_POLICY.NO_MATCHING_RUNNER.pollMs);
        strict_1.default.equal(state.next_wake_reason, 'recheck NO_MATCHING_RUNNER');
        strict_1.default.ok(state.next_wake_at.getTime() >= epoch * 1_000 + project_next_wake_1.PROJECT_WAKE_FLOOR_MS, 'W3');
        const candidates = outcome.detail.wakeCandidates;
        strict_1.default.equal(outcome.detail.flooredBy, null);
        strict_1.default.ok(candidates.length >= 4, 'both blockers contribute a recheck and an alarm');
        // W5 clause 4: stored in the total order, so "same hash ⇒ same audit row" holds for the table.
        const sorted = [...candidates].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.source - b.source);
        strict_1.default.deepEqual(candidates.map((c) => `${c.at}/${c.source}`), sorted.map((c) => `${c.at}/${c.source}`));
        strict_1.default.equal(candidates[0].reason, 'recheck NO_MATCHING_RUNNER');
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('the audit protocol carries Base62 only — no internal UUID reaches it', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const { db, reconciler } = loop(client);
        await refuse(client, TASK, 'WHO_UNRESOLVED');
        await reconcile(db, reconciler);
        const UUID_ANYWHERE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
        const audit = JSON.stringify((await latestDecision(client)).outcome);
        strict_1.default.doesNotMatch(audit, UUID_ANYWHERE, 'a uuid in the outcome is an id no caller could hand to any other endpoint');
        strict_1.default.ok(audit.includes(`WHO_UNRESOLVED:TASK:${(0, shared_1.uuidToBase62)(TASK)}`), 'the dedupe key embeds a subject, so its subject is publicized too');
        // The row id is not in the decision — the row is created by the action the decision PROPOSES,
        // so a plan that named it would be a plan that could not replay. It is on the action instead,
        // and in Base62 there too.
        const open = (await blockers(client))[0];
        const action = rows(await client.query(`
      SELECT "detail" FROM "project_action" WHERE "type" = 'RAISE_BLOCKER'
    `))[0];
        strict_1.default.equal(action.detail.blockerId, (0, shared_1.uuidToBase62)(open.id));
        strict_1.default.doesNotMatch(JSON.stringify(action.detail), UUID_ANYWHERE);
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('a kind nothing observes is cleared, and unit 15 / unit 16 both reach the blocker face', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const { db, reconciler } = loop(client);
        // COORDINATOR_NO_PROGRESS belongs to §7.6 TR3, which compares reasonDigests across turns — and
        // no pass opens a turn yet. Its row, its constraints and its lifecycle work; what does not
        // exist is a detector, so this proves the other half of BL3: a condition nothing observes is
        // one the recomputation resolves.
        await client.query(`
      INSERT INTO "project_blocker" (
        "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
        "next_check_at", "subject_type", "subject_id", "dedupe_key", "lifecycle_generation",
        "condition_version", "first_seen_at", "last_seen_at", "updated_at"
      ) VALUES (
        gen_random_uuid(), $1::uuid, 'COORDINATOR_NO_PROGRESS', 'USER', 'HUMAN', 'CRITICAL', 'take over',
        CURRENT_TIMESTAMP, 'PROJECT', $1::text, $2, 1, repeat('b', 64),
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `, [PROJECT, `COORDINATOR_NO_PROGRESS:PROJECT:${PROJECT}`]);
        // Unit 15: a parent cycle it refuses to aggregate over. Unit 16: a FAIL verdict.
        await client.query(`UPDATE "task" SET "parent_task_id" = $1 WHERE "id" = $2`, [OTHER_TASK, TASK]);
        await client.query(`UPDATE "task" SET "parent_task_id" = $1 WHERE "id" = $2`, [TASK, OTHER_TASK]);
        await client.query(`
      UPDATE "task" SET "verdict" = 'FAIL', "verdict_revision" = 1 WHERE "id" = $1
    `, [VERIFIER]);
        await reconcile(db, reconciler);
        const all = await blockers(client);
        const byKind = new Map(all.map((row) => [row.kind, row]));
        strict_1.default.equal(byKind.get('COORDINATOR_NO_PROGRESS').resolved_by, 'AUTO');
        const cycle = byKind.get('DEPENDENCY_CYCLE');
        strict_1.default.ok(cycle, 'unit 15\'s cycle set must stop the work visibly, not only silently');
        strict_1.default.deepEqual(cycle.detail.aggregationCycleTaskIds.sort(), [(0, shared_1.uuidToBase62)(OTHER_TASK), (0, shared_1.uuidToBase62)(TASK)].sort());
        const verification = byKind.get('VERIFICATION_FAILED');
        strict_1.default.ok(verification, 'unit 16\'s verdict must project onto the general blocker face');
        strict_1.default.equal(verification.subject_id, TASK, 'the subject is the task that failed the check');
        strict_1.default.equal(verification.detail.verdict, 'FAIL');
        strict_1.default.equal(verification.detail.verifierTaskId, (0, shared_1.uuidToBase62)(VERIFIER));
        // Unit 16 keeps its own audit: this projection is additive, not a replacement.
        const outcome = (await latestDecision(client)).outcome;
        strict_1.default.ok(Array.isArray(outcome.aggregationCycleTaskIds) && outcome.aggregationCycleTaskIds.length === 2);
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('§12.1: migration 0125 leaves a legacy project completely silent', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        const { db, reconciler } = loop(client);
        // The legacy project has coordinator_enabled = false and an open task nobody assigned.
        await reconcile(db, reconciler);
        strict_1.default.equal(rows(await client.query(`
      SELECT count(*)::text n FROM "project_blocker" WHERE "project_id" = $1
    `, [LEGACY_PROJECT]))[0].n, '0');
        strict_1.default.equal(rows(await client.query(`
      SELECT "next_wake_at" FROM "project_runtime" WHERE "project_id" = $1
    `, [LEGACY_PROJECT]))[0].next_wake_at, null);
    }
    finally {
        await client.end();
    }
});
(0, node_test_1.test)('the kind CHECK is the closed set, and refuses anything outside it', { skip }, async () => {
    const client = await connect();
    try {
        await reset(client);
        for (const kind of [...project_blocker_1.PROJECT_BLOCKER_KINDS, 'SOMETHING_ELSE']) {
            const insert = client.query(`
        INSERT INTO "project_blocker" (
          "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
          "next_check_at", "subject_type", "subject_id", "dedupe_key", "lifecycle_generation",
          "condition_version", "first_seen_at", "last_seen_at", "updated_at"
        ) VALUES (
          gen_random_uuid(), $1::uuid, $2::text, 'USER', 'HUMAN', 'INFO', 'do a thing',
          CURRENT_TIMESTAMP, 'PROJECT', $1::text, $2::text || ':PROJECT:' || $1::text, 1, repeat('c', 64),
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `, [PROJECT, kind]);
            if (kind === 'SOMETHING_ELSE') {
                await strict_1.default.rejects(insert, /project_blocker_kind_chk/, 'the closed set must be closed');
            }
            else {
                await insert;
            }
        }
        // And resolution is one fact in two columns, never half-written.
        await strict_1.default.rejects(client.query(`
      UPDATE "project_blocker" SET "resolved_at" = CURRENT_TIMESTAMP
       WHERE "kind" = 'UNKNOWN_FAILURE'
    `), /project_blocker_resolution_chk/);
    }
    finally {
        await client.end();
    }
});
//# sourceMappingURL=project-blocker.pg.spec.js.map