import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const PG_URL = process.env.COORDINATOR_PG_URL;

const pgError = (code: string, constraint: string) => (error: unknown) => {
  const failure = error as { code?: string; constraint?: string };
  assert.equal(failure.code, code, String(error));
  assert.equal(failure.constraint, constraint, String(error));
  return true;
};

test('model-routing schema against PostgreSQL', { skip: !PG_URL, concurrency: 1, timeout: 60_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const sql = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = new PrismaClient({ adapter: new PrismaPg(PG_URL) });
  const ownerId = randomUUID();
  t.after(async () => {
    try {
      await prisma.task.deleteMany({ where: { ownerId } });
      await prisma.workspace.deleteMany({ where: { ownerId } });
      await prisma.user.deleteMany({ where: { id: ownerId } });
    } finally {
      await prisma.$disconnect();
      await sql.end();
    }
  });
  await prisma.user.create({
    data: { id: ownerId, email: `routing-schema-${ownerId}@example.invalid`, name: 'routing schema', passwordHash: 'h' },
  });
  const task = await prisma.task.create({
    data: { title: 'routing schema', ownerId, creatorType: 'USER', creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT' },
  });
  const otherTask = await prisma.task.create({
    data: { title: 'other routing task', ownerId, creatorType: 'USER', creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT' },
  });

  await t.test('one migration supplies all columns, their types, defaults, uniqueness and indexes', async () => {
    const migrations = await sql.query(
      `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NULL AS active
         FROM _prisma_migrations WHERE migration_name LIKE '%_task_model_routing'`,
    );
    assert.deepEqual(migrations.rows, [{ migration_name: '0364_task_model_routing', finished: true, active: true }]);
    const columns = await sql.query<{
      table_name: string; column_name: string; udt_name: string; is_nullable: string; column_default: string | null;
    }>(
      `SELECT table_name, column_name, udt_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'task' AND column_name IN ('model_hint', 'model_hint_reason'))
            OR (table_name = 'workspace' AND column_name IN ('model_routing', 'model_routing_providers'))
            OR table_name = 'task_route_decision')`,
    );
    assert.deepEqual(columns.rows.map((r) => [r.table_name, r.column_name, r.udt_name, r.is_nullable]).sort(), [
      ['task', 'model_hint', 'text', 'YES'],
      ['task', 'model_hint_reason', 'text', 'YES'],
      ['workspace', 'model_routing', 'bool', 'NO'],
      ['workspace', 'model_routing_providers', '_text', 'NO'],
      ...[
        ['id', 'uuid', 'NO'], ['owner_id', 'uuid', 'NO'], ['task_id', 'uuid', 'NO'],
        ['request_token', 'text', 'NO'], ['session_id', 'uuid', 'YES'], ['applied', 'bool', 'NO'],
        ['policy_version', 'int4', 'NO'], ['level', 'text', 'YES'], ['provider', 'text', 'NO'],
        ['model', 'text', 'YES'], ['effort', 'text', 'YES'], ['baseline', 'jsonb', 'NO'],
        ['features', 'jsonb', 'NO'], ['reasons', '_text', 'NO'], ['created_at', 'timestamptz', 'NO'],
      ].map((r) => ['task_route_decision', ...r]),
    ].sort());
    const defaults = Object.fromEntries(columns.rows.map((r) => [`${r.table_name}.${r.column_name}`, r.column_default]));
    assert.equal(defaults['workspace.model_routing'], 'false');
    assert.equal(defaults['workspace.model_routing_providers'], 'ARRAY[]::text[]');
    assert.equal(defaults['task.model_hint'], null);
    assert.equal(defaults['task.model_hint_reason'], null);
    assert.equal(defaults['task_route_decision.created_at'], 'CURRENT_TIMESTAMP');
    const unique = await sql.query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'task_route_decision'::regclass AND contype = 'u'`,
    );
    assert.deepEqual(unique.rows, [{ definition: 'UNIQUE (task_id, request_token)' }]);
    const indexes = await sql.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'task_route_decision'`,
    );
    const definitions = Object.fromEntries(indexes.rows.map((r) => [r.indexname, r.indexdef]));
    assert.match(definitions.task_route_decision_owner_id_created_at_idx, /\(owner_id, created_at\)$/);
    assert.match(definitions.task_route_decision_session_id_idx, /\(session_id\)$/);
    const sessionKeys = await sql.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'task_route_decision'::regclass
        AND contype = 'f' AND pg_get_constraintdef(oid) LIKE '%session_id%'`,
    );
    assert.equal(sessionKeys.rowCount, 0);
  });

  const requestToken = randomUUID();
  const baseline = { provider: 'claude', model: null, effort: null };
  const features = { modelHint: null, modelRouting: false };
  const reasons = ['No suggestion — keeps the agent\'s model, as today'];
  let decisionId: string;
  await t.test('database defaults and Prisma mappings preserve unrouted decisions, with UUID v7 ids', async () => {
    const workspaceId = randomUUID();
    await sql.query(`INSERT INTO workspace (id, name, owner_id) VALUES ($1, 'routing schema', $2)`, [workspaceId, ownerId]);
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    assert.equal(workspace.modelRouting, false);
    assert.deepEqual(workspace.modelRoutingProviders, []);
    assert.equal(task.modelHint, null);
    assert.equal(task.modelHintReason, null);
    const before = Date.now();
    const decision = await prisma.taskRouteDecision.create({
      data: { ownerId, taskId: task.id, requestToken, applied: false, policyVersion: 1, provider: 'claude', baseline, features, reasons },
    });
    decisionId = decision.id;
    assert.equal(decision.id[14], '7');
    assert.ok(decision.createdAt.getTime() >= before && decision.createdAt.getTime() <= Date.now());
    assert.deepEqual(
      { level: decision.level, sessionId: decision.sessionId, model: decision.model, effort: decision.effort, applied: decision.applied },
      { level: null, sessionId: null, model: null, effort: null, applied: false },
    );
    assert.deepEqual({ baseline: decision.baseline, features: decision.features, reasons: decision.reasons }, { baseline, features, reasons });
    // The planned session does not exist yet, and may never be created.
    const sessionId = randomUUID();
    const updated = await prisma.taskRouteDecision.update({ where: { id: decisionId }, data: { sessionId } });
    assert.equal(updated.sessionId, sessionId);
    assert.equal((await sql.query('SELECT id FROM session WHERE id = $1', [sessionId])).rowCount, 0);
    await prisma.task.update({ where: { id: task.id }, data: { modelHint: 'M', modelHintReason: 'one migration and its spec' } });
    assert.deepEqual((await sql.query('SELECT model_hint, model_hint_reason FROM task WHERE id = $1', [task.id])).rows,
      [{ model_hint: 'M', model_hint_reason: 'one migration and its spec' }]);
  });

  await t.test('both tier CHECKs accept S/M/L/XL and NULL and reject values outside that set', async () => {
    for (const level of ['S', 'M', 'L', 'XL', null]) {
      await sql.query('UPDATE task SET model_hint = $2 WHERE id = $1', [task.id, level]);
      await sql.query('UPDATE task_route_decision SET level = $2 WHERE id = $1', [decisionId!, level]);
    }
    for (const level of ['XS', 'm', '', 'XXL', 'M ']) {
      await assert.rejects(sql.query('UPDATE task SET model_hint = $2 WHERE id = $1', [task.id, level]),
        pgError('23514', 'task_model_hint_check'));
      await assert.rejects(sql.query('UPDATE task_route_decision SET level = $2 WHERE id = $1', [decisionId!, level]),
        pgError('23514', 'task_route_decision_level_check'));
    }
  });

  await t.test('a run request is unique within its task; deleting that task cascades only its decisions', async () => {
    await assert.rejects(sql.query(
      `INSERT INTO task_route_decision (id, owner_id, task_id, request_token, applied, policy_version, provider, baseline, features, reasons)
       VALUES ($1, $2, $3, $4, false, 1, 'claude', '{}', '{}', ARRAY[]::text[])`,
      [randomUUID(), ownerId, task.id, requestToken],
    ), pgError('23505', 'task_route_decision_task_id_request_token_key'));
    await prisma.taskRouteDecision.create({
      data: { ownerId, taskId: task.id, requestToken: randomUUID(), applied: false, policyVersion: 1, provider: 'claude', baseline, features, reasons },
    });
    const other = await prisma.taskRouteDecision.create({
      data: { ownerId, taskId: otherTask.id, requestToken, applied: false, policyVersion: 1, provider: 'claude', baseline, features, reasons },
    });
    assert.equal(await prisma.taskRouteDecision.count({ where: { taskId: task.id } }), 2);
    await prisma.task.delete({ where: { id: task.id } });
    assert.equal(await prisma.taskRouteDecision.count({ where: { taskId: task.id } }), 0);
    assert.equal(await prisma.taskRouteDecision.count({ where: { id: other.id } }), 1);
  });
});
