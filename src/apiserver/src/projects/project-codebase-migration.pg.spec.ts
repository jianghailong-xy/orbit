import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * 在哪个数据库上重放（2026-09-08 改）
 * ==================================
 * 本文件原来的做法是：拿 harness 给的**前沿库**（每条迁移都应用过），先按名字把 0231 建的东西一件件
 * DROP 掉，再把 `migration.sql` 重放上去。那次拆卸从 2026-09-07 起恒红：
 *
 *     cannot drop index project_id_owner_id_key because other objects depend on it   (2BP01)
 *
 * 0245 给 `project_standard_set_confirmation` 加了 `FOREIGN KEY ("project_id", "owner_id")
 * REFERENCES "project"("id", "owner_id")`，而这条复合外键唯一能挂的目标，就是 0231 建的那个
 * `project_id_owner_id_key`。红的是拆卸，不是被测的性质：0231 依然原子、依然幂等。
 *
 * 三条路，选第三条：
 *
 *   (A) 拆卸时先按名 DROP 掉 0245 那条外键，重放完再建回来。要写死 0245 的定义，于是**下一条**指向
 *       这批对象的迁移会让同一处再烂一次 —— 而这正是刚发生过的事。
 *   (B) `DROP INDEX … CASCADE`，再断言那条外键回来了。CASCADE 删掉的是**别人的**约束，重放 0231 不会
 *       把它带回来（0231 从来没建过它），所以要么这条断言恒红，要么本文件得替 0245 重建它 —— 也就是
 *       退回 (A)，还多附赠一个"悄悄拆掉别人东西"的动作。
 *   (C) 不拆卸：另起一个**只应用到 0231 之前**的库，在那上面重放。
 *
 * 选 (C)。理由不是它更省事（它更贵：要多建一个库、多跑一遍前缀迁移），而是它换掉的是**性质本身**：
 * "0231 应用到它当年面对的那个数据库上"是一个不随后来的迁移改变的命题，而"前沿库拆掉 0231 再装回去"
 * 是一个每加一条迁移就要重新验算一次的命题。(A)/(B) 只修这一次的 2BP01，(C) 让这一族红不再发生。
 *
 * 顺带掉了两个坑：
 *   * 拆卸里那份 `project_blocker_kind_chk` 的取值表是第三份冻结副本（另两份在 `migration.sql` 和
 *     `down.sql` 里）。以后哪条迁移新加一个 kind，这份副本会**静默**把它从库里抹掉 —— 不是红，是错。
 *   * harness 交给本用例的那个库不再被拆开。最后一条断言就是这句话的可执行形态：跑完之后它的约束和
 *     索引与跑之前逐字相同。
 *
 * 仍然需要一个属于自己的数据库：本用例会在旁边建库、删库。`scripts/project-pg-matrix.sh` 与
 * `scripts/run-pg-spec.sh` 都给每个 pg spec 一个。
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const API = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(API, 'prisma', 'migrations');
const PRISMA = path.join(API, 'node_modules', 'prisma', 'build', 'index.js');

/** 被测的那一条。前沿在它**之前**停下，所以重放开始时这个库从没听说过它。 */
const UNIT = '0231_project_codebase_session_source';

const MIGRATION = readFileSync(path.join(MIGRATIONS, UNIT, 'migration.sql'), 'utf8');

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

const NOTHING = {
  tables: [], triggers: [], functions: [], sessionColumns: [], taskColumns: [], indexes: [],
  sourceUnresolved: false,
};

/** 0231 之前的那段历史，按目录名排序取。名字变了就说出来，别悄悄少跑一半。 */
function baselineMigrations(): string[] {
  const all = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(all.includes(UNIT), `${UNIT} 不再是一个迁移目录`);
  const baseline = all.filter((name) => name < UNIT);
  assert.ok(baseline.length > 0, '0231 之前一条迁移都没有 —— 那不是这份历史');
  return baseline;
}

function prisma(args: string[], env: NodeJS.ProcessEnv): void {
  try {
    execFileSync(process.execPath, [PRISMA, ...args], {
      cwd: API,
      timeout: 240_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: 'true', ...env },
    });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    assert.fail(`prisma ${args.join(' ')} failed:\n` +
      `${failure.stdout?.toString() ?? ''}\n${failure.stderr?.toString() ?? ''}`);
  }
}

async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  return client;
}

/**
 * 用例库旁边的另一个库，名字从用例库派生 —— harness 为前者证明过的 pcc* 隔离因此也覆盖后者。
 * 空建（`template0`）而不是从模板克隆：整件事的前提就是"从 0231 之前开始"。
 */
async function replayDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const url = new URL(PG_URL);
  const name = `${decodeURIComponent(url.pathname.replace(/^\//, ''))}_0231`;
  assert.ok(name.length <= 63, `重放库名 ${name} 超过 PostgreSQL 的标识符上限`);
  assert.match(name, /^pcc[0-9a-z]*[_-]/, '重放库必须继承用例库的 pcc* 前缀');

  const maintenance = new URL(PG_URL);
  maintenance.pathname = '/postgres';
  const admin = await connect(maintenance.href);
  const drop = async (): Promise<void> => {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  };
  await drop();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);

  const replay = new URL(PG_URL);
  replay.pathname = `/${name}`;
  return {
    url: replay.href,
    drop: async () => { await drop(); await admin.end(); },
  };
}

/** 迁移目录在 0231 之前那一刻的样子，用仓库里发出去的那些文件拼出来。 */
function baselineTree(baseline: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'project-codebase-0231-'));
  cpSync(path.join(API, 'prisma', 'schema.prisma'), path.join(dir, 'schema.prisma'));
  mkdirSync(path.join(dir, 'migrations'));
  cpSync(path.join(MIGRATIONS, 'migration_lock.toml'), path.join(dir, 'migrations', 'migration_lock.toml'));
  for (const name of baseline) {
    cpSync(path.join(MIGRATIONS, name), path.join(dir, 'migrations', name), { recursive: true });
  }
  return dir;
}

/** 一个库的约束与索引全集，用来说"这个库没被动过"。 */
async function shape(client: Client) {
  const q = async (sql: string) => (await client.query<{ n: string }>(sql)).rows.map((r) => r.n);
  return {
    constraints: await q(
      `SELECT c.conname AS n FROM pg_constraint c JOIN pg_namespace ns ON ns.oid = c.connamespace
        WHERE ns.nspname = 'public' ORDER BY 1`),
    indexes: await q(`SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
  };
}

test('0231 在有数据的库上原子地应用，失败什么也不留', { skip, timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const caseClient = await connect(PG_URL);
  // 钩子在第一个连接之后**立刻**注册，而不是等夹具搭完：中间任何一步抛出，这个连接都会留在事件循环
  // 里，`node --test` 于是不退出 —— harness 把那种情况报成 TIMEOUT 而不是一条读得懂的红。
  // 钩子内部的顺序也要紧：删库会掐掉它上面的每一个 backend，还握着连接的客户端会在断言早就跑完之后
  // 把这次断连报成一个没人接的错误。
  let replayClient: Client | null = null;
  let replay: { drop: () => Promise<void> } | null = null;
  let tree: string | null = null;
  t.after(async () => {
    await replayClient?.end().catch(() => undefined);
    await replay?.drop().catch(() => undefined);
    await caseClient.end().catch(() => undefined);
    if (tree) rmSync(tree, { recursive: true, force: true });
  });

  await verifyCoordinatorPgIdentity(caseClient);
  const caseShapeBefore = await shape(caseClient);

  const baseline = baselineMigrations();
  const database = await replayDatabase();
  replay = database;
  tree = baselineTree(baseline);

  prisma(['migrate', 'deploy', '--config', path.join(API, 'prisma.frontier.config.ts')], {
    DATABASE_URL: database.url,
    ORBIT_FRONTIER_PRISMA_SCHEMA: path.join(tree, 'schema.prisma'),
    ORBIT_FRONTIER_PRISMA_MIGRATIONS: path.join(tree, 'migrations'),
  });

  const client = await connect(database.url);
  replayClient = client;
  const applied = (await client.query<{ name: string }>(
    `SELECT "migration_name" AS name FROM "_prisma_migrations"
      WHERE "finished_at" IS NOT NULL ORDER BY "migration_name"`)).rows.map((row) => row.name);
  assert.deepEqual(applied, baseline, '前沿没有停在它被要求停下的地方');
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
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","project_id","completion_criterion")
     VALUES ($1,'legacy task',$2,'USER',$2,now(),$3,'EVIDENCE_JUDGMENT')`, [id('20'), id('1'), id('10')]);
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

  // 而 harness 交给本用例的那个前沿库，从头到尾一件东西也没被拆走 —— 包括后来的迁移挂在 0231 那些
  // 索引上的外键。这条断言是上面"不拆卸"那个决定的可执行形态：它不点名任何一条迁移，所以哪条迁移
  // 加了或撤了依赖都不会让它变红。
  assert.deepEqual(await shape(caseClient), caseShapeBefore,
    '本用例拆掉了 harness 交给它的那个库里的东西');
});
