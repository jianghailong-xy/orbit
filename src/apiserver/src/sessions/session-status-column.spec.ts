import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { type Hit, readSchema, scanSessionStatus } from '../test-support/session-status-scan';

/**
 * Criterion: no apiserver code reads or writes `session.status` (docs/session-status-retirement-plan.md §5, task T1).
 * The readers and writers moved onto `phase`, `turn_state` and the facts beside them (tasks T7 to T12, and T14 for the
 * writers, deploy D3), and the allow-list that counted the uses left on the way is gone: no product file may hold one.
 * The stored word is written only by migration 1671's trigger, for a rollback to deploy-2 code, until T15 drops it.
 *
 * Read: every .ts file under src/apiserver/src except tests (.spec, .test, .it, .e2e), `.fixture(s).ts`, test-support
 * and __tests__. Comments are stripped first. What counts, each reported as `file:line: …`:
 *
 * - Prisma: `status` of Session in the where, data, create, update, select, omit, include, orderBy, distinct, by or
 *   cursor argument of a query, on `.session.` or through a relation that leads to Session (read from schema.prisma),
 *   in an object typed `Prisma.<Model>…`, and `Prisma.SessionScalarFieldEnum.status`.
 * - A row: `.status` of a variable filled by a session query (and of what iterates or filters it), of anything named
 *   `session` / `…Session` / `…sessions[i]`, or compared with the column's enum or asked of a held-status set.
 * - A value of the column's enum under a `status` key, wherever it is built.
 * - Raw SQL: `status` of the statement's session alias, the SET, WHERE and INSERT columns of a session statement,
 *   the fragments that name an interpolated session alias, and a cast to `run_status`.
 * - The enum: `RunStatus` of `@prisma/client`, which is the column's type (the protocol's is `@orbit/shared`'s).
 * - Dual write: a write of `status` with no `turnState` beside it (deploy 2's rule; since D3 every write is refused).
 * - Phase: `session.phase` read in queue/, runners/, managed-runners/, common/session-tree-sql.ts or
 *   common/session-scheduling.ts, which decide slots, claims and dispatch. None is allowed.
 *
 * What text cannot see: a row handed to a function under another name and only compared with a bare word
 * (`run.status !== 'FAILED'`), a status copied into a differently named fact (`runStatus`), a query argument built
 * in another file with no `Prisma.` type, and Prisma rows spread into a payload. The field has left schema.prisma
 * (T14), so `tsc` refuses every such Prisma read or write, and the column-less PG spec (T15) closes the raw SQL;
 * session-status-column.pg.spec.ts holds the database's own objects.
 */

const REPO = path.resolve(__dirname, '../../../..');
const ROOT = path.join(REPO, 'src/apiserver/src');
const SKIP_DIRS = new Set(['node_modules', 'test-support', '__tests__', '__fixtures__']);
const NOT_PRODUCT = /\.(spec|test|it|e2e|fixtures?)\.ts$/;
const schema = readSchema(readFileSync(path.join(REPO, 'src/apiserver/prisma/schema.prisma'), 'utf8'));


function sources(dir = '', found: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sources(relative, found);
    } else if (entry.name.endsWith('.ts') && !NOT_PRODUCT.test(entry.name)) {
      found.push(relative);
    }
  }
  return found;
}

function report(file: string, hit: Hit): string {
  const what = {
    read: 'reads session.status',
    write: 'writes session.status',
    enum: 'uses the type of session.status',
    alone: 'writes session.status alone',
    phase: 'reads session.phase where slots are decided',
  }[hit.kind];
  return `src/apiserver/src/${file}:${hit.line}: ${what} (${hit.how})`;
}

/** Every use a file holds, one line each. */
function problemsOf(file: string, text: string): string[] {
  return scanSessionStatus(file, text, schema).map((hit) => report(file, hit));
}

const found = (text: string, file = 'x/planted.ts'): string[] =>
  scanSessionStatus(file, text, schema).map((hit) => `${hit.line}:${hit.kind}`);

test('a planted use of each kind is reported at its line', () => {
  const planted: Array<[string, string[]]> = [
    ["await this.prisma.session.findMany({\n  where: { status: 'RUNNING' },\n});", ['2:read']],
    ['await db.session.findFirst({ select: { id: true,\n  status: true } });', ['2:read']],
    ["await tx.session.count({ where: { OR: [\n  { status: 'PENDING' }] } });", ['2:read']],
    ["await tx.session.groupBy({ by: ['status'] });", ['1:read']],
    ["const where = {\n  status: 'PENDING' };\nawait db.session.count({ where });", ['2:read']],
    ["await db.task.findMany({ where: {\n  sessions: { some: { status: 'RUNNING' } } } });", ['2:read']],
    ["await db.runEvent.findMany({ where: { session: { status: 'RUNNING' } } });", ['1:read']],
    ["const LIVE: Prisma.SessionWhereInput = {\n  status: { in: ['PENDING'] } };", ['2:read']],
    ["function live(): Prisma.SessionWhereInput {\n  return { status: 'RUNNING' };\n}", ['2:read']],
    ['const S = {\n  status: true,\n} satisfies Prisma.SessionSelect;', ['2:read']],
    ['const f = Prisma.SessionScalarFieldEnum.status;', ['1:read']],
    ["await tx.session.update({ where: { id }, data: {\n  status: 'PENDING' } });", ['2:write', '2:alone']],
    ["await tx.session.update({ where: { id }, data: { status: 'PENDING', turnState: 'QUEUED' } });", ['1:write']],
    ["const data: Prisma.SessionUncheckedUpdateInput = {};\nawait tx.session.update({ where: { id }, data });\ndata.status = 'PENDING';", ['3:write']],
    ["await db.task.update({ where: { id }, data: { sessions: { updateMany: { where: {}, data: { status: 'FAILED' } } } } });", ['1:write', '1:alone']],
    ['const row = await db.session.findUnique({ where: { id } });\nif (row?.status) go();', ['2:read']],
    ['const rows = await db.session.findMany();\nfor (const r of rows) {\n  use(r.status);\n}', ['3:read']],
    ['const rows = await db.session.findMany();\nrows.map((r) => r.status);', ['2:read']],
    ["if (session.status === 'RUNNING') go();", ['1:read']],
    ['const { status } = session;', ['1:read']],
    ["import { RunStatus } from '@prisma/client';\nconst q = { status: RunStatus.RUNNING };", ['1:enum', '2:read']],
    ["import { RunStatus as Column } from '@prisma/client';\nif (row.status === Column.PENDING) go();", ['1:enum', '2:read']],
    ["const q = { status: heldStatusFilter() };", ['1:read']],
    ['if (OPEN_SESSION_STATUSES.includes(row.status)) go();', ['1:read']],
    ['db.$queryRaw`SELECT s."id"\n  FROM "session" s WHERE s."status" = \'RUNNING\'`;', ['2:read']],
    ['db.$queryRaw`SELECT id FROM session WHERE\n  status = \'PENDING\'`;', ['2:read']],
    ["db.$executeRaw`UPDATE \"session\" SET\n  status = 'RUNNING' WHERE id = ${id}`;", ['2:write', '2:alone']],
    ["db.$executeRaw`UPDATE session s SET status = 'RUNNING', turn_state = 'IN_FLIGHT'`;", ['1:write']],
    ['db.$executeRaw`INSERT INTO "session" ("id",\n  "status") VALUES (1, 2)`;', ['2:write', '2:alone']],
    ["const sql = (session) => `${session}.\"status\" <> 'AWAITING_INPUT'`;", ['1:read']],
    ["const sql = (s) => `${s}.\"status\" = 'RUNNING'::\"run_status\"`;", ['1:read']],
    ["const sql = 'SELECT 1 WHERE $1 = ANY($2::run_status[])';", ['1:read']],
  ];
  for (const [text, expected] of planted) assert.deepEqual(found(text), expected, text);
});

test('what is not session.status is not reported', () => {
  const clean = [
    "// session.status\n/* await db.session.count({ where: { status: 'RUNNING' } }) */",
    "await db.task.findMany({ where: { status: 'OPEN', sessions: { some: { finishedAt: null } } } });",
    "await db.session.findMany({ where: { task: { status: 'OPEN' }, finishedAt: null } });",
    "const w: Prisma.SessionTagSelect = { status: true };",
    "await db.session.update({ where: { id }, data: { resolution: { status: 'x' } } });",
    "if (task.status === 'DONE' || runner.status === 'OFFLINE') go();",
    "if (session.status === 'APPROVED') go();",
    "import { RunStatus } from '@orbit/shared';\nconst words = { status: RunStatus.RUNNING };",
    "if (dto.status === 'FAILED') go();",
    "db.$queryRaw`SELECT t.\"status\" FROM \"task\" t JOIN \"session\" s ON s.task_id = t.id WHERE t.status = 'OPEN'`;",
    "db.$queryRaw`SELECT 1 FROM \"session\" s WHERE s.finished_at IS NULL AND r.status = 'ONLINE'`;",
    "const message = 'could not update the session status';",
  ];
  for (const text of clean) assert.deepEqual(found(text), [], text);
});

test('phase is refused where slots, claims and dispatch are decided, and only there', () => {
  const texts = [
    "await db.session.count({ where: { phase: 'RUNNING' } });",
    "if (session.phase === 'RUNNING') go();",
    'db.$queryRaw`SELECT 1 FROM "session" s WHERE s."phase" = \'RUNNING\'`;',
  ];
  for (const text of texts) {
    for (const file of ['queue/x.ts', 'runners/x.ts', 'managed-runners/x.ts', 'common/session-tree-sql.ts', 'common/session-scheduling.ts']) {
      assert.deepEqual(found(text, file), ['1:phase'], `${file}: ${text}`);
    }
    assert.deepEqual(found(text, 'sessions/x.ts'), [], text);
  }
  assert.deepEqual(found("if (report.phase === 'draining' || pod.status.phase === 'Failed') go();", 'runners/x.ts'), []);
});

test('a planted read and a planted write fail by name, in a product file and in a new one', () => {
  const read = "await db.session.findMany({ where: { status: 'RUNNING' } });";
  const write = "await db.session.update({ where: { id }, data: { turnState: 'QUEUED', status: 'PENDING' } });";
  assert.deepEqual(problemsOf('new/file.ts', read), [
    'src/apiserver/src/new/file.ts:1: reads session.status (Prisma where)',
  ]);
  assert.deepEqual(problemsOf('new/file.ts', write), [
    'src/apiserver/src/new/file.ts:1: writes session.status (Prisma data)',
  ]);
  const file = 'queue/queue.service.ts';
  const today = readFileSync(path.join(ROOT, file), 'utf8');
  assert.deepEqual(problemsOf(file, today), [], `${file} holds no use today`);
  const line = today.split('\n').length;
  for (const [text, how] of [[read, 'reads session.status (Prisma where)'], [write, 'writes session.status (Prisma data)']] as const) {
    assert.deepEqual(problemsOf(file, `${today}\n${text}\n`), [`src/apiserver/src/${file}:${line + 1}: ${how}`]);
  }
});

test('no apiserver product file reads or writes session.status', () => {
  const files = sources();
  assert.ok(files.length > 500, `the scan found only ${files.length} files: is REPO (${REPO}) the repository root?`);
  const problems = files.flatMap((file) => problemsOf(file, readFileSync(path.join(ROOT, file), 'utf8')));
  assert.deepEqual(
    problems,
    [],
    `\n${problems.join('\n')}\nsession.status is retired (docs/session-status-retirement-plan.md §2.1 says what to ask instead): `
      + 'read the facts, and write turn_state and the release beside it.\n',
  );
});
