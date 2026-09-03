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
 * 迁移 0231 的 S1 用例（`docs/project-source-contract.md` §12.1），全部打真实 PostgreSQL。
 *
 * 打真库而不是手搭 schema 子集，是因为本单元交付的**全部内容就是数据库约束**：CHECK 的真值、触发器
 * 的触发时机、`ADD COLUMN` 走没走 catalog 路径 —— 没有一条是在 TypeScript 里能断言的。一个只和自己
 * 一致的假 schema，对"这条 CHECK 在真库上到底拦不拦得住"一个字也说不出来。
 *
 * 每条断言尽量落在**行为**上而不是 DDL 文本上：`pg_constraint` 里有没有那个名字，与"写一行违反它的
 * 数据会不会被拒"是两个不同的命题，而只有后者是这个单元承诺的东西。
 *
 * 非破坏性：只读 catalog，并且只写自己前缀的夹具行，跑完全部删掉。它不 DROP 任何 0231 的对象，因此
 * 可以和别的 spec 共用一个迁移好的库。
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const MIGRATION_DIR = path.resolve(
  __dirname,
  '../../prisma/migrations/0231_project_codebase_session_source',
);
const MIGRATION = readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8');

/** 夹具 id 都带这个前缀，清理按前缀走 —— 绝不整表删（0080 给 `model_provider` 装过删除守卫）。 */
const FIX = '0231a231-0231-4231-8231-';
const id = (n: string) => `${FIX}${n.padStart(12, '0')}`;

const OWNER = id('1');
const OTHER_OWNER = id('2');
const PROJECT = id('10');
const OTHER_PROJECT = id('11');
const RUNNER = id('20');
const CODEBASE = id('30');

const SHA = (c: string) => c.repeat(40);

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const client = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function cleanup(client: Client) {
  // 子先父后。`project_codebase` 会被 project 的 CASCADE 带走，显式删是为了让这个函数在只建了
  // 一半夹具的失败路径上也把话说完。
  await client.query(`DELETE FROM "project_codebase" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  await client.query(`DELETE FROM "session" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  await client.query(`DELETE FROM "task" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  await client.query(`DELETE FROM "project" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  await client.query(`DELETE FROM "runner" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  await client.query(`DELETE FROM "user" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
}

async function seed(client: Client) {
  await cleanup(client);
  // 裸 SQL 夹具必须自己给 `updated_at`：Prisma 的 `@updatedAt` 是客户端行为，列上只有 NOT NULL。
  await client.query(
    `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'A','h'), ($3,$4,'B','h')`,
    [OWNER, `${FIX}a@x`, OTHER_OWNER, `${FIX}b@x`],
  );
  await client.query(
    `INSERT INTO "project"("id","title","owner_id","updated_at")
     VALUES ($1,'S1 fixture',$2,now()), ($3,'S1 other owner',$4,now())`,
    [PROJECT, OWNER, OTHER_PROJECT, OTHER_OWNER],
  );
  await client.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash") VALUES ($1,'S1 runner',$2,'t')`,
    [RUNNER, OWNER],
  );
}

/** 写一条 codebase，缺省是一份合法的 REMOTE 绑定；覆盖任意列以构造反例。 */
function insertCodebase(client: Client, over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: CODEBASE,
    project_id: PROJECT,
    owner_id: OWNER,
    slot: 'primary',
    canonical_repo_url: 'https://github.com/orbit/orbit',
    upstream_ref: 'refs/heads/main',
    integration_ref: 'refs/heads/main',
    ref_authority: 'REMOTE',
    ...over,
  };
  const cols = Object.keys(row);
  return client.query(
    `INSERT INTO "project_codebase"(${cols.map((c) => `"${c}"`).join(',')},"updated_at")
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}, now())`,
    Object.values(row),
  );
}

/** 写一条 session，缺省是 Legacy；覆盖 source_* 以构造快照。 */
function insertSession(client: Client, sessionId: string, over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: sessionId,
    title: 'S1 session',
    prompt: 'p',
    owner_id: OWNER,
    creator_id: OWNER,
    ...over,
  };
  const cols = Object.keys(row);
  return client.query(
    `INSERT INTO "session"(${cols.map((c) => `"${c}"`).join(',')},"updated_at")
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}, now())`,
    Object.values(row),
  );
}

/** 一条 SELECTED 的 `PROJECT_UPSTREAM` 快照，九列齐备。 */
const SELECTED_SNAPSHOT = {
  source_state: 'SELECTED',
  source_kind: 'PROJECT_UPSTREAM',
  source_codebase_id: CODEBASE,
  source_repo_url: 'https://github.com/orbit/orbit',
  source_root_commit_sha: SHA('a'),
  source_ref: 'refs/heads/main',
  source_config_revision: 0,
  source_ref_authority: 'REMOTE',
};

/** 断言这条语句被数据库拒绝，且拒绝理由里点到了预期的约束/错误码。 */
async function refuses(run: () => Promise<unknown>, expected: RegExp, why: string) {
  const error = await run().then(() => null, (e: Error) => e);
  assert.ok(error, `${why} —— 这条写入本该被拒绝，但它成功了`);
  assert.match(error.message, expected, why);
}

test('0231 · S1 数据模型', { skip, timeout: 180_000 }, async (t) => {
  const client = await connect();
  t.after(async () => {
    await cleanup(client).catch(() => undefined);
    await client.end().catch(() => undefined);
  });

  await t.test('S1.01 迁移在既有数据上执行后，既有 session 行全部 UNBOUND（SR45）', async () => {
    await seed(client);
    // 迁移之前就存在的行 —— 这个库上的既有 session 就是它们，一行都没有被本次迁移碰过。
    const rows = await client.query<{ total: string; unbound: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE "source_state" = 'UNBOUND')::text AS unbound
         FROM "session"`,
    );
    assert.equal(rows.rows[0].unbound, rows.rows[0].total,
      '存量 session 必须全部落进 Legacy，而不是被猜成某个 Project 基线');

    // 而且新写入的、不提这些列的 session 也是 UNBOUND：分流是一列的默认值，不是一次推断。
    await insertSession(client, id('100'));
    const legacy = await client.query<{ state: string; required: string[] }>(
      `SELECT "source_state" AS state, "source_required_contains" AS required
         FROM "session" WHERE "id" = $1`, [id('100')]);
    assert.equal(legacy.rows[0].state, 'UNBOUND');
    assert.deepEqual(legacy.rows[0].required, []);
  });

  await t.test('S1.02 常量默认值不触发全表重写（attmissingval）', async () => {
    const probe = await client.query<{ attname: string; atthasmissing: boolean; attmissingval: string }>(
      `SELECT a."attname", a."atthasmissing", a."attmissingval"::text AS "attmissingval"
         FROM pg_attribute a
        WHERE a."attrelid" = ANY(ARRAY['session'::regclass, 'task'::regclass])
          AND a."attname" IN ('source_state', 'source_required_contains', 'codeless')`,
    );
    assert.equal(probe.rows.length, 3, '三个带常量默认值的新列都要在');
    for (const row of probe.rows) {
      // `atthasmissing = t` 就是"走了 catalog 路径"的实证：既有行在语句提交那一刻读到默认值，堆一页
      // 没动。若为 f，说明默认值是 volatile 的、真重写了堆 —— 那正是这一列不该付的代价，因为 session
      // 上一次全表 UPDATE 是 3ms/行。
      assert.equal(row.atthasmissing, true,
        `${row.attname} 没有走 attmissingval 路径 —— 这次迁移重写了整张表`);
    }
    const missing = Object.fromEntries(probe.rows.map((r) => [r.attname, r.attmissingval]));
    assert.match(missing.source_state, /UNBOUND/);
    assert.match(missing.codeless, /f/);

    // 反向：迁移文件里不得有任何一条对这三张表的 UPDATE。回填被"顺手"加回来是最容易发生的事，而它
    // 一旦发生，上面那条 attmissingval 断言仍然为真 —— 它只说默认值走了 catalog，不说没人再扫一遍。
    const statements = MIGRATION.replace(/--[^\n]*/g, '');
    assert.doesNotMatch(statements, /UPDATE\s+"(session|task|project)"/i,
      '迁移里出现了对既有表的 UPDATE —— 常量默认值的全部意义就是不需要它');
  });

  await t.test('S1.03 (projectId, slot) 唯一（SR7）', async () => {
    await seed(client);
    await insertCodebase(client);
    await refuses(
      () => insertCodebase(client, { id: id('31'), canonical_repo_url: 'https://github.com/orbit/other' }),
      /project_codebase_project_slot_key/,
      '一个 Project 的一个 slot 只能有一份绑定',
    );
    // 而第二个 slot 是允许的：多仓库扩展在数据模型上已经可表达（取舍 1），只是 v1 的解析器不读它。
    await insertCodebase(client, { id: id('32'), slot: 'docs', canonical_repo_url: 'https://github.com/orbit/docs' });
    // 另一个 Project 用同一个 slot 名，当然也可以。
    await insertCodebase(client, { id: id('33'), project_id: OTHER_PROJECT, owner_id: OTHER_OWNER });
  });

  await t.test('S1.04 configRevision 由触发器维护，请求体给的值被忽略（SR8）', async () => {
    await seed(client);
    await insertCodebase(client, { config_revision: 42 });
    const read = async () => (await client.query<{ v: string }>(
      `SELECT "config_revision"::text AS v FROM "project_codebase" WHERE "id" = $1`, [CODEBASE])).rows[0].v;

    assert.equal(await read(), '0', 'INSERT 时写入方给的版本号被丢弃');

    await client.query(`UPDATE "project_codebase" SET "config_revision" = 99 WHERE "id" = $1`, [CODEBASE]);
    assert.equal(await read(), '0', '只改版本号的 UPDATE 什么也没发生 —— 没有配置变过');

    await client.query(`UPDATE "project_codebase" SET "upstream_ref" = 'refs/heads/dev' WHERE "id" = $1`, [CODEBASE]);
    assert.equal(await read(), '1', '任一配置列变更即 +1');

    // 同一条语句里既改配置又送一个版本号：仍然是 OLD + 1，写入方拿不到选择权。
    await client.query(
      `UPDATE "project_codebase" SET "integration_ref" = 'refs/heads/next', "config_revision" = 0 WHERE "id" = $1`,
      [CODEBASE]);
    assert.equal(await read(), '2');

    // 写回同一个值不是变更。否则每一次幂等的重复保存都会让在飞 session 的 configRevision 过期。
    await client.query(`UPDATE "project_codebase" SET "upstream_ref" = 'refs/heads/dev' WHERE "id" = $1`, [CODEBASE]);
    assert.equal(await read(), '2');

    // 而 `updated_at` 这类非配置列的变动同样不动它。
    await client.query(`UPDATE "project_codebase" SET "updated_at" = now() WHERE "id" = $1`, [CODEBASE]);
    assert.equal(await read(), '2');
  });

  await t.test('S1.05 短名 ref 写入被拒（SR9）', async () => {
    await seed(client);
    await refuses(() => insertCodebase(client, { upstream_ref: 'main' }),
      /project_codebase_refs_chk/, '`main` 在 refs/heads 与 refs/tags 同名时是二义的');
    await refuses(() => insertCodebase(client, { integration_ref: 'release/next' }),
      /project_codebase_refs_chk/, 'integration 侧同样要全名');
    await refuses(() => insertCodebase(client, { upstream_ref: 'refs/heads/a b' }),
      /project_codebase_refs_chk/, '带空白的 ref git 自己也解析不出来');

    // Task 侧的同一条规则（SR15）：缩写 SHA 与短名 ref 都拒，全名两种形态都收。
    await client.query(
      `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at")
       VALUES ($1,'S1 task',$2,'USER',$2,now())`, [id('200'), OWNER]);
    for (const bad of ['abc1234', 'main', SHA('A'), `${SHA('a')} `, SHA('a').slice(0, 39)]) {
      await refuses(
        () => client.query(`UPDATE "task" SET "pinned_revision" = $2 WHERE "id" = $1`, [id('200'), bad]),
        /task_pinned_revision_shape_chk/,
        `pinnedRevision 收下了 ${JSON.stringify(bad)} —— 缩写按构造就是二义的`,
      );
    }
    await client.query(`UPDATE "task" SET "pinned_revision" = $2 WHERE "id" = $1`, [id('200'), SHA('a')]);
    await client.query(`UPDATE "task" SET "pinned_revision" = 'refs/tags/v1' WHERE "id" = $1`, [id('200')]);

    // SR16：verification 任务不得携带 pin，两个方向都关着。
    await client.query(
      `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","verifies_task_id")
       VALUES ($1,'S1 verifier',$2,'USER',$2,now(),$3)`, [id('201'), OWNER, id('200')]);
    await refuses(
      () => client.query(`UPDATE "task" SET "pinned_revision" = 'refs/tags/v1' WHERE "id" = $1`, [id('201')]),
      /task_pinned_revision_verification_chk/,
      '给 verification 加基线，就是允许它对着别的代码宣布 PASS',
    );
    // 反方向：一个已经 pin 的任务不能被改成 verification。同一条 CHECK，因此不需要第二处规则。
    await client.query(
      `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","pinned_revision")
       VALUES ($1,'S1 pinned',$2,'USER',$2,now(),$3)`, [id('202'), OWNER, SHA('b')]);
    await client.query(
      `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at")
       VALUES ($1,'S1 subject',$2,'USER',$2,now())`, [id('203'), OWNER]);
    await refuses(
      () => client.query(`UPDATE "task" SET "verifies_task_id" = $2 WHERE "id" = $1`, [id('202'), id('203')]),
      /task_pinned_revision_verification_chk/,
      '把一个已 pin 的任务改成 verification，与给 verification 加 pin 是同一件事',
    );
  });

  await t.test('S1.06 RUNNER_LOCAL 无 authorityRunnerId 被拒（SR31）', async () => {
    await seed(client);
    await refuses(
      () => insertCodebase(client, { ref_authority: 'RUNNER_LOCAL' }),
      /project_codebase_authority_runner_chk/,
      '"以某台不确定的机器的本地状态为准"会让两台 runner 解析出两个答案',
    );
    // 绑上机器就合法。
    await insertCodebase(client, { ref_authority: 'RUNNER_LOCAL', authority_runner_id: RUNNER });

    // 反向也关着：REMOTE 的行不得携带一个没人会读的 runner id —— 它会在有人把权威改成 RUNNER_LOCAL
    // 的那一刻被静默采纳。
    await refuses(
      () => insertCodebase(client, { id: id('34'), slot: 'x', authority_runner_id: RUNNER }),
      /project_codebase_authority_runner_chk/,
      'REMOTE 的行不该记着一台机器',
    );

    // 权威封闭：第三个取值要等 §15 的 SERVER_MIRROR 真的存在时才由一次迁移打开。
    await refuses(
      () => insertCodebase(client, { id: id('35'), slot: 'y', ref_authority: 'SERVER_MIRROR' }),
      /project_codebase_ref_authority_chk/,
      'ref authority 是封闭集合',
    );

    // 权威机器不能被悄悄删掉（RESTRICT）：删机器之前得先改绑定，否则这一行会退化成"哪台机器都行"。
    await refuses(
      () => client.query(`DELETE FROM "runner" WHERE "id" = $1`, [RUNNER]),
      /project_codebase_authority_runner_fkey|violates foreign key/,
      '删掉权威机器会把绑定悄悄变成"随便哪台"',
    );
  });

  await t.test('S1.07 指向单机文件系统的列在 project_codebase 上缺席（SR10）', async () => {
    const columns = await client.query<{ column_name: string }>(
      `SELECT "column_name" FROM information_schema.columns WHERE "table_name" = 'project_codebase'`,
    );
    const names = columns.rows.map((r) => r.column_name);
    assert.ok(names.length > 0, '表必须存在');
    for (const forbidden of ['work_dir', 'workspace_id', 'default_merge_target', 'enable_worktree']) {
      assert.equal(names.includes(forbidden), false,
        `project_codebase 长出了 ${forbidden} —— 一个"为了方便"加进来的列，就是耦合回 WHERE 的那条路`);
    }
    // SR31 明写的唯一例外必须在，且它命名的是权威而不是执行位置。
    assert.ok(names.includes('authority_runner_id'));

    // `workspace.default_merge_target` 的语义在 v1 内不变（SR2）：本迁移一个字都没碰它。
    assert.doesNotMatch(MIGRATION.replace(/--[^\n]*/g, ''), /default_merge_target/,
      '迁移读写了 defaultMergeTarget —— 那是一个会被 mergeToMain 回写的展示偏好，不是代码基线');
  });

  await t.test('S1.08 create-frozen 九列冻结（SR11 / SR28）', async () => {
    await seed(client);
    await insertCodebase(client);
    await insertSession(client, id('100'));
    await insertSession(client, id('101'), SELECTED_SNAPSHOT);

    const NINE: Record<string, unknown> = {
      source_kind: 'DEPENDENCY_CLOSURE',
      source_codebase_id: id('39'),
      source_repo_url: 'https://github.com/orbit/elsewhere',
      source_root_commit_sha: SHA('b'),
      source_ref: 'refs/heads/dev',
      source_revision_sha: SHA('c'),
      source_config_revision: 7,
      source_ref_authority: 'RUNNER_LOCAL',
      source_required_contains: [SHA('d')],
    };
    for (const [column, value] of Object.entries(NINE)) {
      await refuses(
        () => client.query(`UPDATE "session" SET "${column}" = $2 WHERE "id" = $1`, [id('101'), value]),
        /SOURCE_PIN_IMMUTABLE/,
        `${column} 在 create 之后仍然可写 —— selector 就不是冻结的了`,
      );
    }

    // 而且在 Legacy 行上也一样冻着。这一格比 SR11 的封条更强，正是 SR28 要的：selector 九列必须与
    // session 行同一条 INSERT 写入，否则就存在一个"已可被 claim 而 selector 为空"的窗口。
    await refuses(
      () => client.query(`UPDATE "session" SET "source_kind" = 'PROJECT_UPSTREAM' WHERE "id" = $1`, [id('100')]),
      /SOURCE_PIN_IMMUTABLE/,
      'UNBOUND 的行被第二条语句装上了 selector',
    );

    // 与此同时，与 SOURCE 无关的 UPDATE 一点没受影响 —— 守卫挂在 `UPDATE OF`，不点名就不触发。
    await client.query(`UPDATE "session" SET "title" = 'renamed' WHERE "id" = $1`, [id('101')]);
    const title = await client.query<{ title: string }>(
      `SELECT "title" FROM "session" WHERE "id" = $1`, [id('101')]);
    assert.equal(title.rows[0].title, 'renamed');
  });

  await t.test('S1.09 sourceBaseSha 非空后不可写（SR11 / SR12）', async () => {
    await seed(client);
    await insertCodebase(client);
    await insertSession(client, id('102'), SELECTED_SNAPSHOT);

    // §6.3 的第 3 步就是这条 CAS。它必须能赢一次。
    const won = await client.query(
      `UPDATE "session"
          SET "source_base_sha" = $2, "source_state" = 'PINNED', "source_resolved_at" = now(),
              "source_resolved_by_runner_id" = $3
        WHERE "id" = $1 AND "source_state" = 'SELECTED' AND "source_base_sha" IS NULL`,
      [id('102'), SHA('e'), RUNNER]);
    assert.equal(won.rowCount, 1);

    for (const [column, value] of Object.entries({
      source_base_sha: SHA('f'),
      source_resolved_at: new Date(),
      source_resolved_by_runner_id: null,
    })) {
      await refuses(
        () => client.query(`UPDATE "session" SET "${column}" = $2 WHERE "id" = $1`, [id('102'), value]),
        /SOURCE_PIN_IMMUTABLE/,
        `${column} 在 pin 之后仍可写 —— 已经有一个 worktree 建在赢家的 SHA 上`,
      );
    }

    // PAC §6 S4 给 `model` 留的"下架了就改写一次"没有对应物：一个不可达的 SHA 是拒绝的理由，不是
    // 换一个的理由。因此 PINNED 也不能退回去重来。
    for (const to of ['SELECTED', 'REFUSED', 'UNBOUND']) {
      await refuses(
        () => client.query(`UPDATE "session" SET "source_state" = $2 WHERE "id" = $1`, [id('102'), to]),
        /SOURCE_PIN_IMMUTABLE/,
        `PINNED -> ${to} 是一次换基线`,
      );
    }

    // 第二个 claim 的 CAS 输掉（0 行），于是它去读赢家的 pin —— 而不是覆盖它（SR30）。
    const lost = await client.query(
      `UPDATE "session" SET "source_base_sha" = $2, "source_state" = 'PINNED', "source_resolved_at" = now()
        WHERE "id" = $1 AND "source_state" = 'SELECTED' AND "source_base_sha" IS NULL`,
      [id('102'), SHA('f')]);
    assert.equal(lost.rowCount, 0, '输家的 CAS 必须匹配不到行，而不是靠触发器去救');
    const pinned = await client.query<{ sha: string; state: string }>(
      `SELECT "source_base_sha" AS sha, "source_state" AS state FROM "session" WHERE "id" = $1`, [id('102')]);
    assert.equal(pinned.rows[0].sha, SHA('e'));
    assert.equal(pinned.rows[0].state, 'PINNED');
  });

  await t.test('S1.09b 状态机的其余转移与合法组合', async () => {
    await seed(client);
    await insertCodebase(client);

    // T4：SELECTED -> REFUSED，带一个码表内的码。
    await insertSession(client, id('103'), SELECTED_SNAPSHOT);
    await client.query(
      `UPDATE "session" SET "source_state" = 'REFUSED', "source_refusal_code" = 'BASE_REF_NOT_FOUND',
              "source_refusal_detail" = $2::jsonb WHERE "id" = $1`,
      [id('103'), JSON.stringify({ ref: 'refs/heads/main', fixAction: 'FIX_REF' })]);

    // T8：REFUSED 是终态。恢复是新开一条 session，不是把这一条改回去。
    await refuses(
      () => client.query(`UPDATE "session" SET "source_state" = 'SELECTED', "source_refusal_code" = NULL WHERE "id" = $1`, [id('103')]),
      /SOURCE_PIN_IMMUTABLE/,
      'REFUSED 之后任何事件都不改状态',
    );

    // 码表外的码写不进去。一个落不进这一列的拒绝，只能变成一次静默降级。
    await insertSession(client, id('104'), SELECTED_SNAPSHOT);
    await refuses(
      () => client.query(`UPDATE "session" SET "source_state" = 'REFUSED', "source_refusal_code" = 'NOPE' WHERE "id" = $1`, [id('104')]),
      /session_source_refusal_code_chk/,
      '拒绝码是封闭集合',
    );
    // 反过来，状态与码必须成对：没有"REFUSED 但说不出为什么"，也没有"码在而状态不是 REFUSED"。
    await refuses(
      () => client.query(`UPDATE "session" SET "source_state" = 'REFUSED' WHERE "id" = $1`, [id('104')]),
      /session_source_refusal_chk/, 'REFUSED 必须带一个码');
    await refuses(
      () => client.query(`UPDATE "session" SET "source_refusal_code" = 'WORKTREE_REQUIRED' WHERE "id" = $1`, [id('104')]),
      /session_source_refusal_chk/, '码只在 REFUSED 上有意义');

    // PINNED 与 pin 互为充要：没有"已 PINNED 但还没有 SHA"可以被 claim 读到，也没有"有 SHA 而状态
    // 没跟上"可以让 engine 提前起来（SR33）。
    await refuses(
      () => client.query(`UPDATE "session" SET "source_state" = 'PINNED' WHERE "id" = $1`, [id('104')]),
      /session_source_pin_chk/, 'PINNED 必须带 SHA');
    await refuses(
      () => client.query(`UPDATE "session" SET "source_base_sha" = $2 WHERE "id" = $1`, [id('104'), SHA('e')]),
      /session_source_pin_chk/, 'SHA 必须带状态');

    // Legacy 行携带半个 selector 会让读它的人以为解析发生过。
    await refuses(
      () => insertSession(client, id('105'), { source_ref: 'refs/heads/main' }),
      /session_source_snapshot_chk/, 'UNBOUND 的行必须是空的');
    // 非 UNBOUND 的行反过来必须齐备。
    for (const missing of ['source_codebase_id', 'source_repo_url', 'source_config_revision',
                           'source_ref_authority']) {
      await refuses(
        () => insertSession(client, id('106'), { ...SELECTED_SNAPSHOT, [missing]: null }),
        /session_source_snapshot_chk/,
        `SELECTED 的行少了 ${missing} 也进得去 —— 快照就只有半张脸`);
    }
    // ref 值与 SHA 值 selector 恰好一个。
    await refuses(
      () => insertSession(client, id('107'), { ...SELECTED_SNAPSHOT, source_revision_sha: SHA('c') }),
      /session_source_snapshot_chk/, 'selector 不能既是 ref 又是 SHA');
    await refuses(
      // `PINNED_REVISION` 是唯一两种形态都收的 kind，所以它是隔离"恰好一个"这条规则的唯一构造 ——
      // 换别的 kind 会同时踩中下面那条真值表 CHECK，测到的就不再是这一条。
      () => insertSession(client, id('108'), {
        ...SELECTED_SNAPSHOT, source_kind: 'PINNED_REVISION', source_ref: null,
      }),
      /session_source_snapshot_chk/, 'selector 也不能两者皆无');

    // §4.1 的真值表：候选提交与 known-good 点都是 commit，integration/upstream 的 tip 都是 ref。
    await refuses(
      () => insertSession(client, id('109'), { ...SELECTED_SNAPSHOT, source_kind: 'VERIFICATION_SUBJECT' }),
      /session_source_kind_selector_chk/, 'VERIFICATION_SUBJECT 是 SHA 值 selector');
    await refuses(
      () => insertSession(client, id('110'), {
        ...SELECTED_SNAPSHOT, source_kind: 'DEPENDENCY_CLOSURE', source_ref: null, source_revision_sha: SHA('c'),
      }),
      /session_source_kind_selector_chk/, 'DEPENDENCY_CLOSURE 是 ref 值 selector');
    // `PINNED_REVISION` 两者皆可（SR15），两条正向用例。
    await insertSession(client, id('111'), { ...SELECTED_SNAPSHOT, source_kind: 'PINNED_REVISION' });
    await insertSession(client, id('112'), {
      ...SELECTED_SNAPSHOT, source_kind: 'PINNED_REVISION', source_ref: null, source_revision_sha: SHA('c'),
    });

    // 四个 SHA 位置同一条规则，数组逐元素也算。
    await refuses(
      () => insertSession(client, id('113'), { ...SELECTED_SNAPSHOT, source_root_commit_sha: SHA('A') }),
      /session_source_sha_chk/, 'SHA 必须小写');
    await refuses(
      () => insertSession(client, id('114'), {
        ...SELECTED_SNAPSHOT, source_kind: 'DEPENDENCY_CLOSURE', source_required_contains: [SHA('c'), 'abc'],
      }),
      /session_source_sha_chk/, 'requiredContains 的每个元素都要是全 40 位');
    await insertSession(client, id('115'), {
      ...SELECTED_SNAPSHOT, source_kind: 'DEPENDENCY_CLOSURE', source_required_contains: [SHA('c'), SHA('d')],
    });
  });

  await t.test('S1.10 project_blocker_kind_chk 新增 SOURCE_UNRESOLVED 且可写入（SR51）', async () => {
    await seed(client);
    // 契约声称的 blocker kind 集合恰好是这一个（`project-source-contract.spec.ts` 断言那一半），
    // 这里断言的是另一半：它在真库里确实写得进去。一个写不进去的拒绝码，等于一次静默跳过的派发 ——
    // 真实数据库对它的回答会是 `violates check constraint "project_blocker_kind_chk"`。
    const write = (kind: string) => client.query(
      `INSERT INTO "project_blocker"(
         "id","project_id","kind","owner","recovery","severity","required_action","next_check_at",
         "subject_type","subject_id","dedupe_key","lifecycle_generation","condition_version",
         "first_seen_at","last_seen_at","updated_at")
       VALUES (gen_random_uuid(),$1,$2,'USER','HUMAN','CRITICAL','bind a codebase',now(),
               'PROJECT',$4,$3,1,repeat('0',64),now(),now(),now())`,
      // `subject_id` 是 TEXT 而不是 uuid（一个内建 provider 没有自己的行，只有 slug），所以它要一个
      // 自己的参数：同一个 $1 既当 uuid 又当 text 会让 pg 推不出类型。
      [PROJECT, kind, `${kind}:PROJECT:${PROJECT}`, PROJECT]);

    await write('SOURCE_UNRESOLVED');
    const stored = await client.query<{ kind: string }>(
      `SELECT "kind" FROM "project_blocker" WHERE "project_id" = $1`, [PROJECT]);
    assert.deepEqual(stored.rows.map((r) => r.kind), ['SOURCE_UNRESOLVED']);

    // 集合仍然封闭：精确码留在 payload 里，不是每加一个错误码就往这条 CHECK 里塞一个值。
    await refuses(() => write('PROJECT_CODEBASE_UNBOUND'), /project_blocker_kind_chk/,
      '八个 SOURCE 拒绝码路由到同一个结论，所以它们不是八个 kind');

    await client.query(`DELETE FROM "project_blocker" WHERE "project_id" = $1`, [PROJECT]);
  });

  await t.test('S1.11 非代码 Project 不被要求绑定 codebase（SR5）', async () => {
    await seed(client);
    // 没有绑定的 Project 完全正常：能建任务、能开 session，session 落在 Legacy，没有任何 Git 要求，
    // 也没有任何拒绝。"这个 Project 需要代码"必须是一个被显式记录的事实。
    const bindings = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "project_codebase" WHERE "project_id" = $1`, [PROJECT]);
    assert.equal(bindings.rows[0].n, '0');

    await client.query(
      `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","project_id")
       VALUES ($1,'codeless work',$2,'USER',$2,now(),$3)`, [id('210'), OWNER, PROJECT]);
    await insertSession(client, id('120'), { task_id: id('210') });

    const row = await client.query<{ state: string; codeless: boolean }>(
      `SELECT s."source_state" AS state, t."codeless" AS codeless
         FROM "session" s JOIN "task" t ON t."id" = s."task_id" WHERE s."id" = $1`, [id('120')]);
    assert.equal(row.rows[0].state, 'UNBOUND');
    assert.equal(row.rows[0].codeless, false,
      'codeless 的默认是 false —— 它是绑了 codebase 的 Project 里的逃生口，不是"没绑定"的同义词');

    // 而 codeless 本身是可写的：一个绑了代码库的 Project 里的调研/文档任务用它退出解析。
    await client.query(`UPDATE "task" SET "codeless" = true WHERE "id" = $1`, [id('210')]);
  });

  await t.test('租户围栏：绑定不可能和它的 project / runner 在"这是谁的"上分歧', async () => {
    await seed(client);
    await refuses(
      () => insertCodebase(client, { owner_id: OTHER_OWNER }),
      /project_codebase_project_fkey|violates foreign key/,
      '一条 owner 与 project 不符的绑定',
    );
    // 另一个 owner 的 runner 也当不了权威 —— 复合外键的第二列就是为了这一条。
    await client.query(
      `INSERT INTO "runner"("id","name","owner_id","token_hash") VALUES ($1,'other runner',$2,'t')`,
      [id('21'), OTHER_OWNER]);
    await refuses(
      () => insertCodebase(client, { ref_authority: 'RUNNER_LOCAL', authority_runner_id: id('21') }),
      /project_codebase_authority_runner_fkey|violates foreign key/,
      '别人的机器当了这条绑定的权威',
    );

    // 身份写一次：换 project 的那一行不是"改了配置"，是另一条绑定。
    await insertCodebase(client);
    await refuses(
      () => client.query(`UPDATE "project_codebase" SET "project_id" = $2 WHERE "id" = $1`, [CODEBASE, OTHER_PROJECT]),
      /CODEBASE_AUTHORITY_INVALID/, '绑定被重新指向了另一个 Project');

    // rootCommitSha：NULL -> 值是一次**观测**，允许；此后任何改写（含清空）都是在声称这是另一个仓库,
    // 而已按旧身份冻结过快照的 session 无从知道这件事（SR37）。
    await client.query(
      `UPDATE "project_codebase" SET "root_commit_sha" = $2 WHERE "id" = $1`, [CODEBASE, SHA('a')]);
    await refuses(
      () => client.query(`UPDATE "project_codebase" SET "root_commit_sha" = $2 WHERE "id" = $1`, [CODEBASE, SHA('b')]),
      /CODEBASE_AUTHORITY_INVALID/, '仓库身份被改写了');
    await refuses(
      () => client.query(`UPDATE "project_codebase" SET "root_commit_sha" = NULL WHERE "id" = $1`, [CODEBASE]),
      /CODEBASE_AUTHORITY_INVALID/, '清空身份和改写身份是同一件事');

    // 删掉 Project 会带走它的绑定（CASCADE）；而绑定被删不改写任何已冻结的快照，因为
    // `session.source_codebase_id` 故意没有外键。
    await insertSession(client, id('130'), SELECTED_SNAPSHOT);
    await client.query(`DELETE FROM "project" WHERE "id" = $1`, [PROJECT]);
    const survived = await client.query<{ codebase: string; state: string }>(
      `SELECT "source_codebase_id" AS codebase, "source_state" AS state FROM "session" WHERE "id" = $1`,
      [id('130')]);
    assert.equal(survived.rows[0].codebase, CODEBASE,
      '删掉绑定改写了一条已冻结的快照 —— 那条 session 的历史就此说不清了');
    assert.equal(survived.rows[0].state, 'SELECTED');
  });
});
