import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/**
 * 0231 是 ATOMIC 的，失败什么也不留 —— 并且它在**有数据的库上**跑得过去（用例 S1.01 的前半句）。
 *
 * 这一批对象彼此没有意义：一张没有冻结守卫的快照表比没有更糟（它让"selector 是冻结的"这句话在数据
 * 库里不成立，而上层每一条规则都建在那句话上），一条加了 `SOURCE_UNRESOLVED` 却没有 session 快照列
 * 的 CHECK 是一个指向不存在事实的词汇。所以部分应用不是降级状态，是错误状态。
 *
 * 文件因此自带 `BEGIN`/`COMMIT`（0130/0131/0134/0137 同一条理由）。这里对着真服务器证明两件事：
 *
 *   1. 同一份 SQL，让它在最后一条语句上失败，必须留下一个从没听说过它的数据库；
 *   2. 然后未经修改的文件必须能干净地应用上去 —— 而且是应用到一个**装着 session / task / project
 *      行**的数据库上，因为"在既有数据上可执行"是本单元的验收条款，不是可以在空库上代跑的东西。
 *
 * 与 0137 的一处差别值得写下来：0137 是原子但**不**幂等，重跑撞 `relation already exists`。0231 两者
 * 都是 —— 每条语句都带 `IF NOT EXISTS` / `duplicate_object` 守卫 / `CREATE OR REPLACE`。最后一段断言
 * 的正是后一半：重跑既不改 schema，也不碰数据，更不把一条绑定的 `configRevision` 推高。
 *
 * 设计上具有破坏性：它 DROP 0231 的对象再重建，所以需要一个属于自己的数据库。
 * `scripts/project-pg-matrix.sh` 给每个 pg spec 一个。
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const MIGRATION = readFileSync(
  path.join(__dirname, '../../prisma/migrations/0231_project_codebase_session_source/migration.sql'),
  'utf8',
);

/** 0231 建的每一样东西，按"它在不在"这个问题分类。 */
const OBJECTS = {
  tables: ['project_codebase'],
  triggers: ['project_codebase_config_guard', 'session_source_freeze_guard'],
  functions: ['project_codebase_config_guard', 'session_source_freeze_guard'],
  sessionColumns: [
    'source_state', 'source_kind', 'source_codebase_id', 'source_repo_url', 'source_root_commit_sha',
    'source_ref', 'source_revision_sha', 'source_config_revision', 'source_ref_authority',
    'source_required_contains', 'source_base_sha', 'source_resolved_at',
    'source_resolved_by_runner_id', 'source_refusal_code', 'source_refusal_detail',
  ],
  taskColumns: ['pinned_revision', 'codeless'],
  indexes: ['project_id_owner_id_key', 'runner_id_owner_id_key', 'session_source_codebase_idx'],
};

const FIX = '0231b231-0231-4231-8231-';
const id = (n: string) => `${FIX}${n.padStart(12, '0')}`;

async function present(client: Client) {
  const q = async (sql: string, params: unknown[]) => (await client.query<{ n: string }>(sql, params)).rows.map((r) => r.n).sort();
  return {
    tables: await q(
      `SELECT table_name AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [OBJECTS.tables]),
    triggers: [...new Set(await q(
      `SELECT tgname AS n FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[])`,
      [OBJECTS.triggers]))],
    functions: [...new Set(await q(
      `SELECT proname AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public' AND proname = ANY($1::text[])`, [OBJECTS.functions]))],
    sessionColumns: await q(
      `SELECT column_name AS n FROM information_schema.columns
        WHERE table_name = 'session' AND column_name = ANY($1::text[])`, [OBJECTS.sessionColumns]),
    taskColumns: await q(
      `SELECT column_name AS n FROM information_schema.columns
        WHERE table_name = 'task' AND column_name = ANY($1::text[])`, [OBJECTS.taskColumns]),
    indexes: await q(
      `SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [OBJECTS.indexes]),
    sourceUnresolved: (await client.query<{ ok: boolean }>(
      `SELECT pg_get_constraintdef(oid) LIKE '%SOURCE_UNRESOLVED%' AS ok
         FROM pg_constraint WHERE conname = 'project_blocker_kind_chk'`)).rows[0]?.ok ?? false,
  };
}

/** 回到一个从没见过 0231 的数据库 —— 失败用例必须从那里开始度量。 */
async function drop0231(client: Client) {
  await client.query(`DROP TRIGGER IF EXISTS "session_source_freeze_guard" ON "session"`);
  await client.query(`DROP TRIGGER IF EXISTS "project_codebase_config_guard" ON "project_codebase"`);
  await client.query(`DROP TABLE IF EXISTS "project_codebase"`);
  for (const fn of OBJECTS.functions) await client.query(`DROP FUNCTION IF EXISTS "${fn}"() CASCADE`);
  for (const c of OBJECTS.sessionColumns) await client.query(`ALTER TABLE "session" DROP COLUMN IF EXISTS "${c}"`);
  for (const c of OBJECTS.taskColumns) await client.query(`ALTER TABLE "task" DROP COLUMN IF EXISTS "${c}"`);
  for (const i of OBJECTS.indexes) await client.query(`DROP INDEX IF EXISTS "${i}"`);
  await client.query(`ALTER TABLE "project_blocker" DROP CONSTRAINT IF EXISTS "project_blocker_kind_chk"`);
  await client.query(`ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_kind_chk"
    CHECK ("kind" IN (
      'WHO_UNRESOLVED', 'WHO_NOT_IN_TEAM', 'WHO_DISABLED', 'PROVIDER_UNAVAILABLE',
      'RUNTIME_REQUIREMENT_UNMET', 'NO_PROJECT_WORKSPACE', 'NO_MATCHING_RUNNER',
      'MERGE_CONFLICT', 'TEST_FAILED', 'VERIFICATION_FAILED', 'BUDGET_EXHAUSTED',
      'AWAITING_USER_APPROVAL', 'AWAITING_USER_INPUT', 'POLICY_MANUAL_HOLD',
      'DEPENDENCY_CYCLE', 'COORDINATOR_UNAVAILABLE', 'COORDINATOR_NO_PROGRESS',
      'AGGREGATE_PARENT_UNSATISFIABLE', 'SUCCESSOR_OUTSIDE_SUBTREE', 'VERIFICATION_REQUIRED',
      'VERIFICATION_CANNOT_CONCLUDE', 'ENVIRONMENT_BROKEN', 'HUMAN_DECISION_REQUIRED',
      'VERDICT_APPLY_EXHAUSTED', 'COMPLETION_ACK_STALE', 'UNKNOWN_FAILURE'))`);
}

const NOTHING = {
  tables: [], triggers: [], functions: [], sessionColumns: [], taskColumns: [], indexes: [],
  sourceUnresolved: false,
};

test('0231 在有数据的库上原子地应用，失败什么也不留', { skip, timeout: 180_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const client = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  t.after(async () => {
    await client.query(`DELETE FROM "session" WHERE "id"::text LIKE $1`, [`${FIX}%`]).catch(() => undefined);
    await client.query(`DELETE FROM "task" WHERE "id"::text LIKE $1`, [`${FIX}%`]).catch(() => undefined);
    await client.query(`DELETE FROM "project" WHERE "id"::text LIKE $1`, [`${FIX}%`]).catch(() => undefined);
    await client.query(`DELETE FROM "user" WHERE "id"::text LIKE $1`, [`${FIX}%`]).catch(() => undefined);
    await client.end().catch(() => undefined);
  });

  await drop0231(client);
  assert.deepEqual(await present(client), NOTHING, '夹具从一个没有 0231 的数据库开始');

  // 存量数据。迁移**之后**这些行必须一行未改，且全部读作 Legacy —— 这是 SR45 在真实历史数据上的
  // 断言，而不是在一张空表上的。
  await client.query(
    `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'legacy','h')`,
    [id('1'), `${FIX}legacy@x`]);
  await client.query(
    `INSERT INTO "project"("id","title","owner_id","updated_at") VALUES ($1,'legacy project',$2,now())`,
    [id('10'), id('1')]);
  await client.query(
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","project_id")
     VALUES ($1,'legacy task',$2,'USER',$2,now(),$3)`, [id('20'), id('1'), id('10')]);
  await client.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","base_sha","branch")
     VALUES ($1,'legacy session','p',$2,$2,now(),$3,'orbit/legacy')`,
    [id('30'), id('1'), 'a'.repeat(40)]);
  const beforeRow = await client.query(
    `SELECT "id","title","base_sha","branch","updated_at" FROM "session" WHERE "id" = $1`, [id('30')]);

  // 同一份 SQL，让它在最后一条语句上失败。之前的一切都跑在**文件自己**打开的事务里，所以失败让它们
  // 全部作废 —— 后面那条 `ROLLBACK` 是部署方对一条报错语句会做的事，不是这个测试需要的拐杖：没有文件
  // 自带的 `BEGIN`，失败点之上的每个对象早就提交了，没有任何东西可以回滚。
  const doomed = MIGRATION.replace(/COMMIT;\s*$/, 'SELECT 1 / 0;\nROLLBACK;\n');
  assert.notEqual(doomed, MIGRATION, '故障必须真的被注入');
  const failure = await client.query(doomed).catch((e: Error) => e);
  assert.ok(failure instanceof Error, '注入的故障必须真的让迁移失败');
  await client.query('ROLLBACK').catch(() => undefined);

  assert.deepEqual(await present(client), NOTHING,
    '失败的 0231 什么也没留下 —— 没有表、没有触发器、没有列、没有索引会在重跑时撞车');

  // ……而仓库里那份原样的文件，就应用到这个装着数据的数据库上。
  await client.query(MIGRATION);
  const after = await present(client);
  assert.deepEqual(after.tables, [...OBJECTS.tables].sort());
  assert.deepEqual(after.triggers, [...OBJECTS.triggers].sort());
  assert.deepEqual(after.functions, [...OBJECTS.functions].sort());
  assert.deepEqual(after.sessionColumns, [...OBJECTS.sessionColumns].sort());
  assert.deepEqual(after.taskColumns, [...OBJECTS.taskColumns].sort());
  assert.deepEqual(after.indexes, [...OBJECTS.indexes].sort());
  assert.equal(after.sourceUnresolved, true);

  // 存量行逐列不变，且落进 Legacy。`updated_at` 也在比较里：一次回填会移动它，而用户看得见它。
  const afterRow = await client.query(
    `SELECT "id","title","base_sha","branch","updated_at" FROM "session" WHERE "id" = $1`, [id('30')]);
  assert.deepEqual(afterRow.rows, beforeRow.rows, '迁移改写了一条既有 session 的既有列');
  const legacy = await client.query<{ state: string; codeless: boolean }>(
    `SELECT s."source_state" AS state, t."codeless" AS codeless
       FROM "session" s, "task" t WHERE s."id" = $1 AND t."id" = $2`, [id('30'), id('20')]);
  assert.equal(legacy.rows[0].state, 'UNBOUND',
    '历史 session 必须明确落进 Legacy，而不是被猜成某个 Project 基线');
  assert.equal(legacy.rows[0].codeless, false);

  // 而且它是**可重跑**的（不像 0137，那个是原子但不幂等）：每条语句都带 `IF NOT EXISTS` /
  // `duplicate_object` 守卫 / `CREATE OR REPLACE` / 先按名 DROP TRIGGER，所以被中断后重试到达的状态,
  // 与没被中断的一样 —— 这正是上面那次注入故障之后的处境。
  await client.query(MIGRATION);
  assert.deepEqual(await present(client), after, '重跑改变了 schema —— 那它就不是可重跑的');
  const rerunRow = await client.query(
    `SELECT "id","title","base_sha","branch","updated_at" FROM "session" WHERE "id" = $1`, [id('30')]);
  assert.deepEqual(rerunRow.rows, beforeRow.rows, '重跑碰了既有数据');

  // 而 `config_revision` 也没有被重跑推高：一次重放迁移不是一次配置变更。这一条单独测，是因为它是
  // 这份迁移里唯一一个"由触发器写、且会被任何 UPDATE 看见"的量，而重跑最容易在它上面留下痕迹。
  await client.query(
    `INSERT INTO "project_codebase"("id","project_id","owner_id","canonical_repo_url",
        "upstream_ref","integration_ref","ref_authority","updated_at")
     VALUES ($1,$2,$3,'https://github.com/orbit/orbit','refs/heads/main','refs/heads/main','REMOTE',now())`,
    [id('40'), id('10'), id('1')]);
  await client.query(MIGRATION);
  const revision = await client.query<{ v: string }>(
    `SELECT "config_revision"::text AS v FROM "project_codebase" WHERE "id" = $1`, [id('40')]);
  assert.equal(revision.rows[0].v, '0', '重跑迁移把一条绑定的 configRevision 推高了');
  await client.query(`DELETE FROM "project_codebase" WHERE "id" = $1`, [id('40')]);
});
