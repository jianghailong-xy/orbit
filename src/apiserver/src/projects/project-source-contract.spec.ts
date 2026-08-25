import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * `docs/project-source-contract.md` 的契约自检（SR53）。
 *
 * 这里断言的是**契约自身的自洽性**，不是任何实现的行为：编号唯一且连续、错误码与正文双向闭合、
 * 冻结集合不相交、准入闸是全序、优先级表的每一对可同真谓词都被定序、`fixAction` 封闭、
 * §13 的每一行都引用得到一条 §12 用例。
 *
 * 它不连数据库、不起 Nest，因此在任何实现任务开工前就能跑绿 —— 一份没有自检的契约，与一份没有人读的
 * 契约在效果上相同。契约里"由契约自检断言"这句话在这里兑现；每多一处只写在文档里的闭合声明，就多一处
 * 两个实现都能引用同一份契约的来源（PAC v1 的二义正是这么来的）。
 */

const REPO = path.resolve(__dirname, '../../../..');
const DOC = readFileSync(path.join(REPO, 'docs/project-source-contract.md'), 'utf8');
const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');

/** 一条规则的**定义**是行首的 `**SR<n>` —— 正文里的 `SR<n>` 是**引用**。 */
const definitions = [...DOC.matchAll(/\*\*SR(\d+)(?!\d)/g)].map((m) => Number(m[1]));
const references = [...DOC.matchAll(/\bSR(\d+)(?!\d)/g)].map((m) => Number(m[1]));

test('SR 编号唯一、连续、且每处引用都定义得到', () => {
  const seen = new Set<number>();
  for (const n of definitions) {
    assert.equal(seen.has(n), false, `SR${n} 被定义了两次 —— 两处编号就是两处会漂移的真相`);
    seen.add(n);
  }
  const max = Math.max(...definitions);
  const gaps = Array.from({ length: max }, (_, i) => i + 1).filter((n) => !seen.has(n));
  assert.deepEqual(gaps, [], '编号有缺口：一个不存在的 SR 号会让引用它的测试无从写起');
  const dangling = [...new Set(references)].filter((n) => !seen.has(n));
  assert.deepEqual(dangling, [], '引用了未定义的 SR 号');
});

/** §10.1 的码表：只有那张表用 `| \`CODE\` |` 起行。 */
const TABLE_CODES = [...DOC.matchAll(/^\| `([A-Z][A-Z_]+)` \|/gm)].map((m) => m[1]);

test('SR47 错误码双向闭合', () => {
  assert.equal(new Set(TABLE_CODES).size, TABLE_CODES.length, '码表里有重复的码');
  assert.ok(TABLE_CODES.length >= 10, '码表至少十行');
  // AC 点名的六类拒绝必须在表内。
  for (const required of [
    'PROJECT_CODEBASE_UNBOUND', 'BASE_REF_NOT_FOUND', 'BASE_SHA_UNAVAILABLE',
    'BASE_REPO_MISMATCH', 'DEPENDENCY_BASE_NOT_LANDED', 'WORKTREE_REQUIRED',
  ]) {
    assert.ok(TABLE_CODES.includes(required), `${required} 不在码表内`);
  }
  // 方向一：表里的每个码都必须在正文被引用（出现次数 > 1，那一次是表本身）。
  for (const code of TABLE_CODES) {
    const uses = DOC.split('`' + code + '`').length - 1;
    assert.ok(uses > 1, `${code} 只存在于码表，正文没有一处规则引用它`);
  }
});

/**
 * 方向二：正文里每一个长得像错误码的裸标识符，都必须是码表的一行，或是一个**已声明的非错误码词汇**。
 * 白名单是显式的：一个"顺手"加进正文的新码，只会以测试失败的形式出现，而不是以两份互相矛盾的实现出现。
 */
const NON_CODE_TOKENS = new Set([
  // 状态机（§6）
  'UNBOUND', 'SELECTED', 'PINNED', 'REFUSED',
  // selector 种类（§4）
  'VERIFICATION_SUBJECT', 'PINNED_REVISION', 'TASK_KNOWN_GOOD', 'DEPENDENCY_CLOSURE', 'PROJECT_UPSTREAM',
  // ref 权威（§2）与开放问题里的第三个取值（§15）
  'REMOTE', 'RUNNER_LOCAL', 'SERVER_MIRROR',
  // 既有表的既有取值
  'ACCEPTED', 'WIP_RED', 'MERGED', 'SOURCE_UNRESOLVED', 'UNKNOWN_FAILURE',
  // fixAction 封闭集合（§10.1 第六列）
  'BIND_CODEBASE', 'FIX_WORKSPACE_REPO', 'RETRY_OR_FIX_CREDENTIALS', 'FIX_REF', 'RESTORE_COMMIT',
  'LAND_PREREQUISITE', 'ENABLE_ISOLATION', 'UPGRADE_RUNNER', 'START_NEW_RUN', 'FIX_CODEBASE_CONFIG',
  // SQL 关键字
  'NOT NULL',
]);

test('SR47 正文没有码表之外的错误码', () => {
  const tokens = new Set([...DOC.matchAll(/`([A-Z][A-Z_ ]{5,})`/g)].map((m) => m[1]));
  const stray = [...tokens].filter((t) => !TABLE_CODES.includes(t) && !NON_CODE_TOKENS.has(t));
  assert.deepEqual(stray, [], '正文出现了码表里没有的错误码');
});

test('SR49 fixAction 封闭', () => {
  // 码表第六列。逐行取最后一个 `CODE`，因为前面几列也可能带反引号。
  const rows = [...DOC.matchAll(/^\| `([A-Z][A-Z_]+)` \|.*\| `([A-Z][A-Z_]+)` \|$/gm)];
  assert.equal(rows.length, TABLE_CODES.length, '码表每一行都必须有 fixAction');
  for (const [, code, fix] of rows) {
    assert.ok(NON_CODE_TOKENS.has(fix), `${code} 的 fixAction ${fix} 不在封闭集合内`);
  }
});

test('SR11 冻结集合不相交', () => {
  const section = DOC.split('**SR11')[1].split('**SR12')[0];
  const [createRow, claimRow] = section.split('\n').filter((l) => l.includes('frozen**'));
  const cols = (row: string) => new Set([...row.matchAll(/`(source[A-Za-z]+)`/g)].map((m) => m[1]));
  const createFrozen = cols(createRow);
  const claimFrozen = cols(claimRow);
  assert.ok(createFrozen.size >= 9, 'create-frozen 集合至少九列');
  assert.ok(claimFrozen.size >= 3, 'claim-frozen 集合至少三列');
  const overlap = [...createFrozen].filter((c) => claimFrozen.has(c));
  assert.deepEqual(overlap, [], '两个冻结集合有交集 —— "这一列还能不能写"就有了两个答案');
});

test('SR21 准入闸是全序，每级恰好一个码', () => {
  const gate = DOC.split('\n## 5.')[1].split('\n## 6.')[0];
  const rows = [...gate.matchAll(/^\| \*\*(G\d)\*\* \|.*\| `([A-Z_]+)` \|$/gm)];
  assert.deepEqual(rows.map((r) => r[1]), ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6'], '闸门必须是 G0..G6 的全序');
  const codes = rows.map((r) => r[2]);
  assert.equal(new Set(codes).size, codes.length, '两级闸门共用一个码，同一输入就能命中两个码');
  for (const code of codes) assert.ok(TABLE_CODES.includes(code), `${code} 不在码表内`);
});

test('SR19/SR20 优先级表五序齐全，且每一对可同真谓词都被定序', () => {
  const ranks = [...DOC.matchAll(/^\| \*\*(P\d'?)\*\* \|/gm)].map((m) => m[1]);
  assert.deepEqual(ranks, ['P0', "P0'", 'P1', 'P2', 'P3', 'P4', 'P5'], '优先级表必须是 P0..P5');
  const pairs = [...DOC.matchAll(/^\| \*\*(D\d)\*\* (P\d) ∩ (P\d) \|/gm)];
  assert.deepEqual(pairs.map((p) => p[1]), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].slice(0, pairs.length));
  // 表里声明"能同时为真"的每一对，都必须给出定序结论（"X 胜"）。
  const disamb = DOC.split('\n### 4.2')[1].split('\n## 5.')[0];
  for (const row of disamb.split('\n').filter((l) => /^\| \*\*D\d\*\*/.test(l))) {
    const canOverlap = !row.includes('不能');
    if (canOverlap) assert.match(row, /胜\*\*/, `可同真的一对没有定序：${row.slice(0, 40)}`);
  }
});

test('SR50/SR51 blocker kind 恰好一个，且确实是新增的', () => {
  const kinds = [...DOC.matchAll(/`project_blocker\.kind = '([A-Z_]+)'`/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(kinds)], ['SOURCE_UNRESOLVED'], '本契约只贡献一个 blocker kind');
  // 现行封闭集合来自最后一次改写 project_blocker_kind_chk 的迁移。
  const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d{4}_/.test(d)).sort();
  let closed: string[] = [];
  for (const d of dirs) {
    let sql = '';
    try { sql = readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8'); } catch { continue; }
    const m = sql.match(/ADD CONSTRAINT "project_blocker_kind_chk"[\s\S]*?CHECK \("kind" IN \(([\s\S]*?)\)\)/);
    if (m) closed = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  }
  assert.ok(closed.length > 0, '读不到 project_blocker_kind_chk 的封闭集合');
  assert.equal(
    closed.includes('SOURCE_UNRESOLVED'),
    false,
    'SOURCE_UNRESOLVED 已在封闭集合内：SR51 的"尚未落地"过期了，改契约而不是改这条断言',
  );
  // 落地位置有且只有一条声明。
  // 数**出现次数**而不是行数：同一行里写第二处落地，按行数看仍然是一行。
  const landings = DOC.split('ALTER TABLE "project_blocker"').length - 1;
  assert.equal(landings, 1, '落地位置必须有且只有一条声明');
  // 契约声称"加入现有 25 个 kind"。那个数字也是一句可以过期的断言。
  const claimed = DOC.match(/加入现有 (\d+) 个 kind/);
  assert.ok(claimed, '落地声明必须写明现有 kind 数');
  assert.equal(closed.length, Number(claimed[1]), '封闭集合的大小与契约声称的不一致');
});

test('SR17 解析器输入不含 WHERE 链的任何字段', () => {
  const input = DOC.split('SourceResolutionInput` 的类型')[1].split('```')[1];
  for (const forbidden of ['workspace', 'workDir', 'defaultMergeTarget', 'runnerId', 'assignedRunner']) {
    assert.equal(
      input.includes(forbidden), false,
      `解析器输入含 ${forbidden} —— WHERE 泄漏进 SOURCE 就重新变得可表达了`,
    );
  }
});

test('SR10 ProjectCodebase 不含指向单机文件系统的列', () => {
  const section = DOC.split('\n### 3.1')[1].split('\n### 3.2')[0];
  const columns = section.split('\n').filter((l) => /^\| `/.test(l)).join('\n');
  for (const forbidden of ['`workDir`', '`workspaceId`', '`defaultMergeTarget`', '`enableWorktree`']) {
    assert.equal(columns.includes(forbidden), false, `project_codebase 不得有 ${forbidden} 列`);
  }
  // `authorityRunnerId` 是 SR31 明写的唯一例外，必须在。
  assert.ok(columns.includes('`authorityRunnerId`'));
});

test('§13 的每一行都引用得到一条 §12 用例', () => {
  // 用例集合只从 §12 建。从全文建会让 §13 里写错的编号把自己算进集合 —— 断言就永远为真。
  const catalogue = DOC.split('\n## 12.')[1].split('\n## 13.')[0];
  const cases = new Set([...catalogue.matchAll(/\bS(\d)\.(\d\d)\b/g)].map((m) => `S${m[1]}.${m[2]}`));
  const mapping = DOC.split('\n## 13.')[1].split('\n## 14.')[0];
  const referenced = [...new Set([...mapping.matchAll(/\bS\d\.\d\d\b/g)].map((m) => m[0]))];
  assert.ok(referenced.length > 0, '§13 必须引用用例编号');
  for (const id of referenced) assert.ok(cases.has(id), `§13 引用了不存在的用例 ${id}`);
  // 反向：Project 的七条验收标准每条都要有一行。
  const rows = mapping.split('\n').filter((l) => /^\| \d\./.test(l));
  assert.equal(rows.length, 7, '七条 Project acceptance criteria 每条一行');
});

test('SR2 defaultMergeTarget 只以"被禁止"的身份出现', () => {
  // 每一处提及都必须落在一条禁止/兼容规则里，而不是某处悄悄把它当成输入。
  const lines = DOC.split('\n').filter((l) => l.includes('defaultMergeTarget'));
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.match(
      line,
      /不是|不得|不复用|禁止|缺席|不可达|Legacy|不改写|SR2|不被|拒绝|保留|改过/,
      `这一行把 defaultMergeTarget 当成了输入：${line.slice(0, 60)}`,
    );
  }
});
