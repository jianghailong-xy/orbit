/**
 * 0259 applies, rolls back and re-applies — on a database that has rows in it.
 *
 * "The migration can be safely apply/rollback rehearsed on an existing database" is the acceptance
 * clause, and neither half of it can be rehearsed on an empty schema: a migration that rewrites
 * existing rows, or whose rollback takes something else down with it, looks identical to a correct
 * one until there is something there to damage. So this replays the real history to the frontier
 * IMMEDIATELY BEFORE 0259, puts a user, a session and a task in it, and then drives the full
 * round trip against those rows.
 *
 *   frontier (every migration < 0259)
 *     → seed real rows
 *     → apply migration.sql        → the four relations exist; not one seeded row moved
 *     → apply it again             → re-runnable: nothing changed
 *     → apply down.sql             → all four gone; STILL not one seeded row moved
 *     → apply migration.sql again  → back, byte for byte the same shape as the first time
 *
 * WHY A SEPARATE DATABASE AND NOT THE HARNESS'S
 * =============================================
 * The harness hands every pg spec a database with every migration already applied, 0259 included.
 * Dismantling 0259 on that database to re-apply it is the shape that rotted for
 * `project-codebase-migration.pg.spec.ts`: the teardown had to name, and then rebuild, whatever
 * LATER migrations had attached themselves to the objects being dropped, so it went red every time
 * somebody added one. "0259 applied to the database it actually faced" does not change when a
 * 0260 arrives. So a second database is built here and the harness's is left strictly alone — the
 * last assertion is that claim in executable form.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-migration.pg.spec.ts
 */
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
} from '../projects/coordinator-pg-test-safety';

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const API = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(API, 'prisma', 'migrations');
// Resolved rather than named: which node_modules holds the prisma CLI is a fact about the
// lockfile's hoisting, not about this repo. `prisma` has no main export, so name the entry.
const PRISMA = require.resolve('prisma/build/index.js');

const UNIT = '0259_watch_persistence';
const MIGRATION = readFileSync(path.join(MIGRATIONS, UNIT, 'migration.sql'), 'utf8');
const DOWN = readFileSync(path.join(MIGRATIONS, UNIT, 'down.sql'), 'utf8');

/** Everything 0259 creates, by the question "is it there". */
const TABLES = ['watch', 'watch_delivery', 'watch_match', 'watch_target'];

const FIX = '0259b259-0259-4259-8259-';
const id = (n: string) => `${FIX}${n.padStart(12, '0')}`;

/** The 0259 objects a database currently has. */
async function present(client: Client) {
  const q = async (sql: string, params: unknown[] = []) =>
    (await client.query<{ n: string }>(sql, params)).rows.map((row) => row.n).sort();
  return {
    tables: await q(
      `SELECT table_name AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [TABLES]),
    // Indexes and constraints are read by the TABLE they belong to rather than by a frozen list of
    // names: a second copy of the name list here would be a thing to keep in step, and the
    // question being asked is "did the whole of 0259 come back", not "do these strings exist".
    indexes: await q(
      `SELECT indexname AS n FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])`, [TABLES]),
    constraints: await q(
      `SELECT c.conname || ' ' || pg_get_constraintdef(c.oid) AS n
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace ns ON ns.oid = t.relnamespace
        WHERE ns.nspname = 'public' AND t.relname = ANY($1::text[])`, [TABLES]),
    // 0259 claims to create none of these. Asserted, not assumed: a trigger or function appearing
    // later would be invisible to the table list above.
    triggers: await q(
      `SELECT t.tgname AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relname = ANY($1::text[])`, [TABLES]),
  };
}

const NOTHING = { tables: [], indexes: [], constraints: [], triggers: [] };

/** The migrations before 0259, by directory name. */
function baselineMigrations(): string[] {
  const all = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(all.includes(UNIT), `${UNIT} is no longer a migration directory`);
  const baseline = all.filter((name) => name < UNIT);
  assert.ok(baseline.length > 0, 'there is no history before 0259 — that is not this repository');
  return baseline;
}

/** The migrations directory as it stood the moment before 0259, assembled from the shipped files. */
function baselineTree(baseline: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'watch-0259-'));
  cpSync(path.join(API, 'prisma', 'schema.prisma'), path.join(dir, 'schema.prisma'));
  mkdirSync(path.join(dir, 'migrations'));
  cpSync(path.join(MIGRATIONS, 'migration_lock.toml'),
    path.join(dir, 'migrations', 'migration_lock.toml'));
  for (const name of baseline) {
    cpSync(path.join(MIGRATIONS, name), path.join(dir, 'migrations', name), { recursive: true });
  }
  return dir;
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
 * A second database beside the case's own, named from it so the harness's proof that the case
 * database is an isolated pcc* one covers this too. Created empty from `template0`, because the
 * entire point is to start from before 0259.
 */
async function replayDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const url = new URL(PG_URL);
  const name = `${decodeURIComponent(url.pathname.replace(/^\//, ''))}_0259`;
  assert.ok(name.length <= 63, `replay database ${name} exceeds PostgreSQL's identifier limit`);
  assert.match(name, /^pcc[0-9a-z]*[_-]/, 'the replay database must inherit the case database’s pcc* prefix');

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
  return { url: replay.href, drop: async () => { await drop(); await admin.end(); } };
}

/** A whole database's constraints and indexes: what "nothing here was disturbed" is measured on. */
async function shape(client: Client) {
  const q = async (sql: string) => (await client.query<{ n: string }>(sql)).rows.map((r) => r.n);
  return {
    constraints: await q(
      `SELECT c.conname AS n FROM pg_constraint c JOIN pg_namespace ns ON ns.oid = c.connamespace
        WHERE ns.nspname = 'public' ORDER BY 1`),
    indexes: await q(`SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
  };
}

// ── the static half: what the file is allowed to contain ────────────────────────────────────────
// Cheap, and it pins the claim the live drill below can only sample: backward compatibility here
// is the ABSENCE of statements, and absence is the one thing a run against one database cannot
// demonstrate about every other deployment.
test('0259 alters nothing and writes nothing', { skip: false }, () => {
  const statements = MIGRATION.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  assert.doesNotMatch(statements, /\bALTER\s+TABLE\b/i,
    'an ALTER TABLE would make this migration reach a relation that already has rows in it');
  // `UPDATE` is matched together with its `SET`, and `DELETE` with its `FROM`. A bare `\bUPDATE\b`
  // also matches the `ON UPDATE CASCADE` of every foreign key below, which is a referential action
  // and not a write — the looser pattern reports this migration as rewriting rows it never touches.
  for (const write of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+(?:ONLY\s+)?"?[a-z_]+"?\s+SET\b/i,
    /\bDELETE\s+FROM\b/i]) {
    assert.doesNotMatch(statements, write, 'the four tables are new and start empty: there is no backfill');
  }
  assert.doesNotMatch(statements, /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i, '0259 creates no function');
  assert.doesNotMatch(statements, /\bCREATE\s+TRIGGER\b/i, '0259 creates no trigger');
  assert.doesNotMatch(statements, /\bCREATE\s+TYPE\b|\bALTER\s+TYPE\b/i, '0259 creates no enum type');
  // It is atomic, which is what lets an interrupted apply simply be re-run.
  assert.match(statements, /^\s*BEGIN;/m);
  assert.match(statements, /^\s*COMMIT;\s*$/m);
  // And the rollback only ever drops what 0259 made.
  const down = DOWN.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  const dropped = [...down.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([a-z_0-9]+)"/gi)]
    .map((match) => match[1]).sort();
  assert.deepEqual(dropped, TABLES, 'down.sql drops exactly the four tables 0259 created');
  assert.doesNotMatch(down, /CASCADE/i,
    'a CASCADE in the rollback would drop objects belonging to migrations that came after it');
});

test('0259 applies, rolls back and re-applies on a database with rows in it',
  { skip, concurrency: 1, timeout: 600_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(PG_URL);
    const caseClient = await connect(PG_URL!);
    // Registered immediately after the first connection rather than once the fixture is built: a
    // throw anywhere below would otherwise leave the connection in the event loop, `node --test`
    // would not exit, and the harness would report a timeout instead of a readable failure. The
    // order inside matters too — dropping the database cuts every backend on it, so a client still
    // holding one reports the disconnection long after the assertions passed.
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
    assert.deepEqual(applied, baseline, 'the frontier did not stop where it was asked to');
    assert.deepEqual(await present(client), NOTHING,
      'the fixture starts from a database that has never heard of 0259');

    // The rows that make this an existing database rather than an empty schema. Everything below
    // is measured against them: a migration that rewrites one is not backward compatible, however
    // clean its DDL looks.
    await client.query(
      `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'incumbent','h')`,
      [id('1'), `${FIX}legacy@watch.invalid`]);
    await client.query(
      `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at")
       VALUES ($1,'a conversation that predates Watch','p',$2,$2,now())`, [id('10'), id('1')]);
    await client.query(
      `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion")
       VALUES ($1,'work that predates Watch',$2,'USER',$2,now(),'EVIDENCE_JUDGMENT')`,
      [id('20'), id('1')]);

    /** Every column of the three seeded rows, as text. What "untouched" is measured on. */
    const rows = async () => ({
      user: (await client.query(`SELECT * FROM "user" WHERE "id" = $1`, [id('1')])).rows,
      session: (await client.query(`SELECT * FROM "session" WHERE "id" = $1`, [id('10')])).rows,
      task: (await client.query(`SELECT * FROM "task" WHERE "id" = $1`, [id('20')])).rows,
    });
    const seeded = await rows();
    assert.equal(seeded.session.length, 1, 'the fixture rows are on record before the migration runs');

    await t.test('(1) it applies to the database it actually faces', async () => {
      await client.query(MIGRATION);
      const after = await present(client);
      assert.deepEqual(after.tables, TABLES, 'all four relations are there');
      assert.deepEqual(after.triggers, [], '0259 installs no trigger');
      assert.ok(after.indexes.length >= 13,
        `only ${after.indexes.length} indexes — the primary keys, unique keys and query indexes ` +
        'of four tables should be more than that');
      assert.deepEqual(await rows(), seeded,
        'the migration rewrote a row that was already there — that is not backward compatible');
    });

    const installed = await present(client);

    await t.test('(2) it is re-runnable, which is what an interrupted apply needs', async () => {
      await client.query(MIGRATION);
      assert.deepEqual(await present(client), installed,
        'a second apply changed the schema, so an interrupted first one cannot simply be retried');
      assert.deepEqual(await rows(), seeded, 'a second apply touched existing data');
    });

    await t.test('(3) down.sql removes 0259 and only 0259', async () => {
      await client.query(DOWN);
      assert.deepEqual(await present(client), NOTHING,
        'the rollback left part of 0259 behind, so a re-apply would collide with it');
      // The point of the rollback drill: the rows that were here before are still exactly here.
      assert.deepEqual(await rows(), seeded,
        'rolling 0259 back damaged data it never created');
      // And the rest of the database is still whole — the FKs 0259 pointed AT `user` and `session`
      // went away with the tables that owned them, taking nothing of their targets with them.
      const survivors = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`);
      assert.ok(Number(survivors.rows[0].n) > 40,
        'the rollback took other relations with it');
    });

    await t.test('(4) re-applying after the rollback restores it exactly', async () => {
      await client.query(MIGRATION);
      assert.deepEqual(await present(client), installed,
        'the database after apply → down → apply differs from the database after the first apply');
      assert.deepEqual(await rows(), seeded, 're-applying rewrote existing data');
    });

    await t.test('(5) a failed apply leaves nothing behind', async () => {
      // The same file, made to fail on its last statement. Everything before the failure ran inside
      // the transaction the FILE opens, so the failure voids all of it; the trailing ROLLBACK is
      // what a deployment does with a failed statement, not a crutch this test needs.
      await client.query(DOWN);
      const doomed = MIGRATION.replace(/COMMIT;\s*$/, 'SELECT 1 / 0;\nROLLBACK;\n');
      assert.notEqual(doomed, MIGRATION, 'the fault must actually be injected');
      const failure = await client.query(doomed).catch((e: Error) => e);
      assert.ok(failure instanceof Error, 'the injected fault must actually fail the migration');
      await client.query('ROLLBACK').catch(() => undefined);

      assert.deepEqual(await present(client), NOTHING,
        'a failed 0259 left objects behind for the retry to collide with');
      assert.deepEqual(await rows(), seeded, 'a failed 0259 still managed to touch existing data');

      // And the retry it is now facing succeeds.
      await client.query(MIGRATION);
      assert.deepEqual(await present(client), installed);
    });

    await t.test('(6) the constraints that survive the round trip are the ones that matter',
      async () => {
        // Named here, unlike `present()` above, because these three are the acceptance clause: a
        // rollback drill that restored the tables but lost a unique key would pass every assertion
        // so far and leave duplicate Matches possible.
        const defs = new Map((await client.query<{ name: string; def: string }>(
          `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def
             FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
            WHERE t.relname = ANY($1::text[])`, [TABLES])).rows.map((r) => [r.name, r.def]));

        assert.match(defs.get('watch_match_watch_generation_key') ?? '',
          /UNIQUE \("?watch_id"?, "?generation"?\)/,
          'the one-shot guarantee did not come back through the rollback');
        assert.match(defs.get('watch_delivery_match_action_key') ?? '',
          /UNIQUE \("?match_id"?, "?action"?\)/,
          'one delivery per match per action did not come back through the rollback');
        assert.match(defs.get('watch_target_watch_resource_key') ?? '',
          /UNIQUE \("?watch_id"?, "?target_kind"?, "?target_resource_id"?\)/,
          'target de-duplication did not come back through the rollback');

        const indexes = (await client.query<{ name: string; def: string }>(
          `SELECT indexname AS name, indexdef AS def FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = ANY($1::text[])`, [TABLES])).rows;
        const byName = new Map(indexes.map((row) => [row.name, row.def]));
        for (const [index, shapeOf] of [
          ['watch_target_resource_idx', /\(target_kind, target_resource_id\)/],
          ['watch_owner_state_idx', /\(owner_id, state\)/],
          ['watch_due_idx', /\(next_evaluate_at\)[\s\S]*WHERE \(next_evaluate_at IS NOT NULL\)/],
        ] as Array<[string, RegExp]>) {
          assert.match(byName.get(index) ?? '', shapeOf,
            `${index} is missing or no longer covers the query it exists for`);
        }
      });

    // Finally: the database the harness handed this case was never opened. This is the "do not
    // dismantle the frontier" decision in executable form, and it names no migration, so a later
    // one attaching itself to 0259's objects cannot make it red.
    assert.deepEqual(await shape(caseClient), caseShapeBefore,
      'this case disturbed the database the harness gave it');
  });
