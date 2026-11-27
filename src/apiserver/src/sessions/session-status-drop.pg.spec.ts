/**
 * DEPLOY D4 OF THE session.status RETIREMENT: THE COLUMN AND ITS TYPE ARE DROPPED (migration 1711), AND PUT BACK BY THE
 * DOWN SCRIPT (scripts/session-status-drop-down.sql). docs/session-status-retirement-plan.md §4.1 and §4.3, task T15.
 * Against PostgreSQL, on a database of its own holding what deploy D3 left (every migration up to 1711):
 *
 *   (1) 1711 refuses to drop anything while something it does not know still names the column or the type: a view, a
 *       trigger column list, an index, a CHECK, a function body naming it (by an alias, by a row variable, by NEW, in a
 *       cast); each named in the error, the database left as it was
 *   (2) over rows of every shape, 1711 (applied by `prisma migrate deploy`, as a server boots) drops the column, the
 *       type and what exists only for them, writes no row, and every row's legacy word is what it was
 *   (3) a server of deploy D3 boots on the database D4 left: its `prisma migrate deploy` finds nothing to apply, its
 *       writes (facts only) run, and the word it answers is the facts'
 *   (4) the down script gives back the D3 database: every function, trigger, index, constraint, column and enum equal to
 *       the one taken before 1711 (column order aside); every row's stored word is the projector's, which is the word
 *       D3 stored for every row D3 wrote (a released row D2 left with a word of its own comes back with the facts',
 *       plan §3.4); D3's trigger and CHECKs hold writes again; the script a second time does nothing; going on to D2
 *       (1671's down script) works; and migrating forward again drops it all again
 *   (5) the down script on 100,000 rows, timed
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-status-drop.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { REPO_SCRIPTS, restoreStatusColumn } from '../test-support/session-d3-database';
import { legacySessionStatus, type LandingSettlement, type LegacyStatusFacts } from './session-legacy-words';
import { WORD_SHAPES, type WordShape } from './session-legacy-words.fixture';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const API = join(__dirname, '..', '..');
const MIGRATIONS = join(API, 'prisma', 'migrations');
const D4 = '1711_session_status_drop';
const MIGRATION_SQL = readFileSync(join(MIGRATIONS, D4, 'migration.sql'), 'utf8');
const D3_DOWN = readFileSync(join(REPO_SCRIPTS, 'session-status-from-facts-down.sql'), 'utf8');

const lit = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return `'${value.toISOString()}'::timestamptz`;
  return `'${String(value).replace(/'/g, "''")}'`;
};

/** `prisma migrate deploy` over this tree's migrations but those from `skipFrom` on (null: all of them). */
function migrateDeploy(url: string, skipFrom: string | null): string {
  // Inside the apiserver directory, so the config's imports (prisma/config, dotenv) resolve as they do for the real one.
  const dir = mkdtempSync(join(API, '.d4-'));
  try {
    cpSync(join(API, 'prisma'), join(dir, 'prisma'), { recursive: true });
    cpSync(join(API, 'prisma.config.ts'), join(dir, 'prisma.config.ts'));
    if (skipFrom !== null) {
      for (const name of readdirSync(join(dir, 'prisma', 'migrations'))) {
        if (/^\d{4}_/.test(name) && name >= skipFrom) rmSync(join(dir, 'prisma', 'migrations', name), { recursive: true });
      }
    }
    return execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: dir, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: 'pipe',
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return assert.fail(`prisma migrate deploy failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Everything of the schema D4 or its down script could touch, one line each, sorted. Column order is left out: a
 *  column added back goes to the end of its table. */
async function catalog(sql: Client): Promise<string[]> {
  const lines = async (query: string): Promise<string[]> => (await sql.query<{ line: string }>(query)).rows.map((r) => r.line);
  return [
    ...await lines(`SELECT 'function ' || pg_get_functiondef(p.oid) AS line FROM pg_proc p
                     WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')`),
    ...await lines(`SELECT 'trigger ' || pg_get_triggerdef(oid) AS line FROM pg_trigger WHERE NOT tgisinternal`),
    ...await lines(`SELECT 'index ' || indexdef AS line FROM pg_indexes WHERE schemaname = 'public'`),
    ...await lines(`SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
                            || ' validated=' || convalidated::text AS line
                      FROM pg_constraint WHERE connamespace = 'public'::regnamespace`),
    ...await lines(`SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                            || ' notnull=' || a.attnotnull::text || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS line
                      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm') AND a.attnum > 0
                       AND NOT a.attisdropped`),
    ...await lines(`SELECT 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS line
                      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid GROUP BY t.typname`),
  ].sort();
}

/** The facts of every session and the word the projector gives them, by id. */
async function words(sql: Client): Promise<Map<string, string>> {
  const rows = (await sql.query<{
    id: string; finished_at: Date | null; turn_state: string | null; end_reason: string | null; last_turn_outcome: string | null;
    started_at: Date | null; import_source_cwd: string | null; kind: string; settled_as: string | null; settled_at: Date | null;
  }>(`SELECT s."id", s."finished_at", s."turn_state", s."end_reason", s."last_turn_outcome", s."started_at",
             s."import_source_cwd", s."kind", l."settled_as", l."settled_at"
        FROM "session" s LEFT JOIN "project_landing" l ON l."session_id" = s."id"`)).rows;
  return new Map(rows.map((row) => {
    const facts: LegacyStatusFacts = {
      finishedAt: row.finished_at, turnState: row.turn_state, endReason: row.end_reason, lastTurnOutcome: row.last_turn_outcome,
      startedAt: row.started_at, importSourceCwd: row.import_source_cwd, sessionKind: row.kind,
    };
    const landing: LandingSettlement | null = row.settled_as === null ? null : { settledAt: row.settled_at, settledAs: row.settled_as };
    return [row.id, legacySessionStatus(facts, landing)];
  }));
}

const storedWords = async (sql: Client): Promise<Map<string, string>> => new Map(
  (await sql.query<{ id: string; status: string }>(`SELECT "id", "status"::text AS status FROM "session"`)).rows
    .map((row) => [row.id, row.status]));

const columnAndType = async (sql: Client) => (await sql.query(
  `SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'session' AND column_name = 'status') AS columns,
          (SELECT count(*)::int FROM pg_type WHERE typname IN ('run_status', '_run_status')) AS types`)).rows[0];

interface World { owner: string; project: string; codebase: string }

async function world(sql: Client): Promise<World> {
  const owner = randomUUID();
  const project = randomUUID();
  const codebase = randomUUID();
  await sql.query(`INSERT INTO "user" ("id", "email", "name") VALUES ($1, $2, 'd4')`, [owner, `d4-${owner}@status-drop.invalid`]);
  await sql.query(`INSERT INTO "project" ("id", "owner_id", "title", "updated_at") VALUES ($1, $2, 'd4', now())`, [project, owner]);
  await sql.query(
    `INSERT INTO "project_codebase" ("id", "owner_id", "project_id", "canonical_repo_url", "upstream_ref", "integration_ref",
                                     "ref_authority", "updated_at")
     VALUES ($1, $2, $3, $4, 'refs/heads/main', 'refs/heads/main', 'REMOTE', now())`,
    [codebase, owner, project, `https://github.com/example/d4-${codebase}`]);
  return { owner, project, codebase };
}

/** A session of `shape`, written as its facts, a landing's own row first (projects/landing-session.ts writes it so). */
async function insertShape(sql: Client, w: World, shape: WordShape): Promise<string> {
  const id = randomUUID();
  const f = shape.facts;
  if (shape.landing) {
    const task = randomUUID();
    await sql.query(`INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id", "updated_at", "completion_criterion", "project_id")
                     VALUES ($1, 'landed', $2, 'USER', $2, now(), 'EVIDENCE_JUDGMENT', $3)`, [task, w.owner, w.project]);
    await sql.query(
      `INSERT INTO "project_landing" ("id", "project_id", "owner_id", "codebase_id", "subject", "task_id", "session_id",
                                      "settled_at", "settled_as")
       VALUES (gen_random_uuid(), $1, $2, $3, 'TASK', $4, $5, now(), $6)`,
      [w.project, w.owner, w.codebase, task, id, shape.landing.settledAs]);
  }
  await sql.query(`INSERT INTO "session" ("id", "owner_id", "creator_id", "title", "prompt", "provider", "provider_builtin",
                     "dispatch_origin", "updated_at", "turn_state", "finished_at", "end_reason", "last_turn_outcome",
                     "started_at", "import_source_cwd", "kind")
                   VALUES ($1, $2, $2, $3, 'd4', $4, true, 'USER', now(), ${lit(f.turnState)}, ${lit(f.finishedAt)},
                     ${lit(f.endReason)}, ${lit(f.lastTurnOutcome)}, ${lit(f.startedAt)}, ${lit(f.importSourceCwd)}, ${lit(f.sessionKind)})`,
  [id, w.owner, shape.name, f.sessionKind === 'LANDING' ? 'orbit' : 'claude']);
  return id;
}

/** Each planted object, and the words the migration's refusal must name it by. */
const PLANTS: ReadonlyArray<[what: string, sql: string, named: RegExp]> = [
  ['a view', `CREATE VIEW planted_view AS SELECT "id", "status" FROM "session"`, /planted_view/],
  ['an index', `CREATE INDEX planted_index ON "session" ("owner_id") WHERE "status" = 'RUNNING'`, /planted_index/],
  ['a CHECK', `ALTER TABLE "session" ADD CONSTRAINT planted_chk CHECK ("status" IS NOT NULL) NOT VALID`, /planted_chk/],
  ['a trigger column list', `CREATE FUNCTION planted_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER planted_trigger BEFORE UPDATE OF "status" ON "session" FOR EACH ROW EXECUTE FUNCTION planted_noop()`, /planted_trigger/],
  ['a table of the type', `CREATE TABLE planted_table ("word" run_status)`, /planted_table/],
  ['a function reading it by an alias', `CREATE FUNCTION planted_alias_reader() RETURNS bigint LANGUAGE plpgsql AS
    $$ DECLARE n bigint; BEGIN SELECT count(*) INTO n FROM "session" s WHERE s."status" = 'RUNNING'; RETURN n; END $$`, /planted_alias_reader/],
  ['a function writing it', `CREATE FUNCTION planted_writer(i uuid) RETURNS void LANGUAGE plpgsql AS
    $$ BEGIN UPDATE "session" SET "status" = 'RUNNING' WHERE "id" = i; END $$`, /planted_writer/],
  ['a function reading a row variable', `CREATE FUNCTION planted_rowtype_reader(i uuid) RETURNS text LANGUAGE plpgsql AS
    $$ DECLARE v "session"%ROWTYPE; BEGIN SELECT * INTO v FROM "session" WHERE "id" = i; RETURN v."status"; END $$`, /planted_rowtype_reader/],
  ['a function of a session row', `CREATE FUNCTION planted_row_reader(s "session") RETURNS boolean LANGUAGE plpgsql AS
    $$ BEGIN RETURN s."status" IS NULL; END $$`, /planted_row_reader/],
  ['a session trigger reading NEW', `CREATE FUNCTION planted_new_reader() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN IF NEW."status" IS NULL THEN RETURN NULL; END IF; RETURN NEW; END $$;
    CREATE TRIGGER planted_new_trigger BEFORE UPDATE OF "title" ON "session" FOR EACH ROW EXECUTE FUNCTION planted_new_reader()`, /planted_new_reader/],
  ['a function casting to the type', `CREATE FUNCTION planted_cast(word text) RETURNS text LANGUAGE plpgsql AS
    $$ BEGIN RETURN (word::run_status)::text; END $$`, /planted_cast/],
];

test('D4: session.status and run_status are dropped, and the down script gives them back (1711)', {
  skip, concurrency: 1, timeout: 900_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const admin = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  await verifyCoordinatorPgIdentity(admin);
  const name = `pccspec_d4_${randomUUID().slice(0, 8)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new globalThis.URL(URL!);
  target.pathname = `/${name}`;
  const url = target.toString();
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  t.after(async () => {
    await sql.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  migrateDeploy(url, D4);
  await sql.connect();
  assert.deepEqual(await columnAndType(sql), { columns: 1, types: 2 }, 'the database deploy D3 left');
  const w = await world(sql);
  const ids = new Map<string, string>();
  for (const shape of WORD_SHAPES) ids.set(shape.name, await insertShape(sql, w, shape));
  const d3 = await catalog(sql);

  await t.test('(1) 1711 refuses while anything else names the column or the type, and drops nothing', async () => {
    for (const [what, plant, named] of PLANTS) {
      await sql.query(plant);
      const before = await catalog(sql);
      await assert.rejects(sql.query(MIGRATION_SQL), (error: Error) => {
        assert.match(error.message, /^SESSION_STATUS_STILL_NAMED: /, what);
        assert.match(error.message, named, what);
        return true;
      }, what);
      // The refusal is the whole file's: the connection is in no transaction, and the catalog is the one it was.
      assert.deepEqual(await catalog(sql), before, `${what}: left as it was`);
      await sql.query(`DROP VIEW IF EXISTS planted_view; DROP INDEX IF EXISTS planted_index;
        ALTER TABLE "session" DROP CONSTRAINT IF EXISTS planted_chk;
        DROP TRIGGER IF EXISTS planted_trigger ON "session"; DROP TRIGGER IF EXISTS planted_new_trigger ON "session";
        DROP TABLE IF EXISTS planted_table;
        DROP FUNCTION IF EXISTS planted_noop(); DROP FUNCTION IF EXISTS planted_alias_reader();
        DROP FUNCTION IF EXISTS planted_writer(uuid); DROP FUNCTION IF EXISTS planted_rowtype_reader(uuid);
        DROP FUNCTION IF EXISTS planted_row_reader("session"); DROP FUNCTION IF EXISTS planted_new_reader();
        DROP FUNCTION IF EXISTS planted_cast(text)`);
    }
    assert.deepEqual(await catalog(sql), d3);
  });

  // A released row deploy D2 left with a word of its own (plan §3.4 C1: an end nobody honoured), stored FAILED while
  // the facts read CANCELLED: D3's trigger fires on no write of the word alone, so D3 keeps it.
  const old = await insertShape(sql, w, WORD_SHAPES.find((s) => s.name === 'held RUNNING')!);
  await sql.query(`UPDATE "session" SET "turn_state" = NULL, "finished_at" = now(), "end_reason" = 'cancelled' WHERE "id" = $1`, [old]);
  await sql.query(`UPDATE "session" SET "status" = 'FAILED' WHERE "id" = $1`, [old]);
  const storedAtD3 = await storedWords(sql);
  assert.equal(storedAtD3.get(old), 'FAILED');
  const wordsAtD3 = await words(sql);
  const rowsAtD3 = (await sql.query(`SELECT count(*)::int AS n, sum(xmin::text::bigint) AS x FROM "session"`)).rows[0];

  await t.test('(2) 1711 drops the column, the type and their objects, writing no row; every word stays', async () => {
    const out = migrateDeploy(url, null);
    assert.match(out, new RegExp(D4));
    assert.deepEqual(await columnAndType(sql), { columns: 0, types: 0 });
    const left = (await sql.query(
      `SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'session_aa_status_from_facts') AS trigger,
              (SELECT count(*)::int FROM pg_proc WHERE proname IN ('session_status_from_facts', 'session_turn_state_of_status')) AS functions,
              (SELECT count(*)::int FROM pg_proc WHERE proname = 'session_legacy_status') AS projectors,
              (SELECT count(*)::int FROM pg_constraint WHERE conname IN ('session_release_fact_chk', 'session_turn_state_agrees_chk')) AS checks,
              (SELECT count(*)::int FROM pg_constraint WHERE conname IN ('session_turn_state_chk', 'session_turn_state_released_chk', 'session_phase_chk') AND convalidated) AS kept,
              (SELECT count(*)::int FROM pg_indexes WHERE indexname IN ('session_status_idx', 'session_assigned_runner_id_status_idx',
                 'session_batch_id_status_idx', 'session_over_capacity_pending_idx', 'session_owner_status_task_idx',
                 'session_root_session_id_status_idx')) AS indexes`)).rows[0];
    assert.deepEqual(left, { trigger: 0, functions: 0, projectors: 1, checks: 0, kept: 3, indexes: 0 });
    // Each trigger D3 had, but the rollback one, is there with `status` taken from its column list and nothing else.
    const triggers = (lines: string[]) => lines.filter((line) => line.startsWith('trigger '));
    assert.deepEqual(
      triggers(await catalog(sql)),
      triggers(d3).filter((line) => !line.includes('session_aa_status_from_facts'))
        .map((line) => (line.includes(' ON public.session ') ? line.replace(/UPDATE OF status, /, 'UPDATE OF ') : line)).sort(),
    );
    assert.deepEqual((await sql.query(`SELECT count(*)::int AS n, sum(xmin::text::bigint) AS x FROM "session"`)).rows[0], rowsAtD3,
      'the migration writes no row');
    assert.deepEqual(await words(sql), wordsAtD3);
  });

  await t.test('(3) deploy D3 boots on this database and writes the facts; the words are theirs', async () => {
    assert.match(migrateDeploy(url, D4), /No pending migrations to apply/);
    const id = await insertShape(sql, w, WORD_SHAPES.find((s) => s.name === 'held RUNNING')!);
    await sql.query(`UPDATE "session" SET "turn_state" = NULL WHERE "id" = $1`, [id]);
    assert.equal((await words(sql)).get(id), 'AWAITING_INPUT');
    await sql.query(`UPDATE "session" SET "finished_at" = now(), "end_reason" = 'task_done' WHERE "id" = $1`, [id]);
    assert.equal((await words(sql)).get(id), 'SUCCEEDED');
  });

  await t.test('(4) the down script gives back the D3 database, its words, its trigger and its CHECKs', async () => {
    const atD4 = await words(sql);
    await restoreStatusColumn(sql);
    assert.deepEqual(await catalog(sql), d3, 'the catalog is deploy D3\'s');
    const stored = await storedWords(sql);
    assert.deepEqual(stored, atD4, 'every row holds the projector\'s word');
    for (const [id, word] of storedAtD3) {
      assert.equal(stored.get(id), id === old ? 'CANCELLED' : word, `row ${id}: D3's word, but the old one D2 wrote`);
    }
    // D3's trigger keeps the word from the facts, and the CHECKs refuse a word the facts do not give.
    const held = await insertShape(sql, w, WORD_SHAPES.find((s) => s.name === 'held AWAITING_INPUT')!);
    assert.equal((await storedWords(sql)).get(held), 'AWAITING_INPUT');
    await sql.query(`UPDATE "session" SET "turn_state" = 'QUEUED' WHERE "id" = $1`, [held]);
    assert.equal((await storedWords(sql)).get(held), 'PENDING');
    await assert.rejects(sql.query(`UPDATE "session" SET "status" = 'RUNNING' WHERE "id" = $1`, [held]),
      (error: { constraint?: string }) => error.constraint === 'session_turn_state_agrees_chk');
    await assert.rejects(sql.query(`UPDATE "session" SET "status" = 'FAILED' WHERE "id" = $1`, [held]),
      (error: { code?: string }) => error.code === '23514');
    // A second run does nothing.
    const after = await catalog(sql);
    await restoreStatusColumn(sql);
    assert.deepEqual(await catalog(sql), after);
    // D3's own boot on it, once 1711's record is deleted as the script says, and further back to D2.
    await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = $1`, [D4]);
    assert.match(migrateDeploy(url, D4), /No pending migrations to apply/);
    await sql.query(D3_DOWN);
    await sql.query(`UPDATE "session" SET "status" = 'RUNNING', "turn_state" = 'IN_FLIGHT' WHERE "id" = $1`, [held]);
    // Forward again from D2: 1671 and then 1711 are applied once their records are gone.
    await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = '1671_session_status_from_facts'`);
    const out = migrateDeploy(url, null);
    assert.match(out, /1671_session_status_from_facts/);
    assert.match(out, new RegExp(D4));
    assert.deepEqual(await columnAndType(sql), { columns: 0, types: 0 });
    assert.equal((await words(sql)).get(held), 'RUNNING');
  });

  await t.test('(5) the down script on 100,000 rows, and the drop again, timed', async () => {
    await sql.query(
      `INSERT INTO "session" ("id", "owner_id", "creator_id", "title", "prompt", "provider", "provider_builtin",
                              "dispatch_origin", "updated_at", "turn_state", "finished_at", "last_turn_outcome")
       SELECT gen_random_uuid(), $1, $1, 'bulk', 'd4', 'claude', true, 'USER', now(),
              CASE WHEN g % 20 = 0 THEN 'QUEUED' END,
              CASE WHEN g % 20 <> 0 AND g % 3 = 0 THEN now() END,
              CASE WHEN g % 7 = 0 THEN 'FAILED' END
         FROM generate_series(1, 100000) g`, [w.owner]);
    let started = Date.now();
    await restoreStatusColumn(sql);
    console.log(`# down script over ${(await sql.query(`SELECT count(*)::int AS n FROM "session"`)).rows[0].n} rows: ${Date.now() - started} ms`);
    assert.deepEqual(await storedWords(sql), await words(sql));
    started = Date.now();
    await sql.query(MIGRATION_SQL);
    console.log(`# 1711 over the same rows: ${Date.now() - started} ms`);
    assert.deepEqual(await columnAndType(sql), { columns: 0, types: 0 });
  });
});
