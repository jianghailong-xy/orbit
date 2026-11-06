/**
 * Migration 0482 (`wiki_model_request.material` and its CHECK) against a real PostgreSQL, through the real
 * `prisma migrate deploy`, at production's lock_timeout (30 s) and statement_timeout (300 s). The file asks for its
 * lock on the table in short tries and validates the CHECK after a COMMIT, in a transaction of its own; its header
 * says why. Each case runs on its own copy of a database replayed to the migration just before 0482 and seeded with
 * a space, a job and model requests:
 *
 *   (a) another transaction holds a lock on wiki_model_request for 10 s: the migration does not fail, it asks for
 *       the lock in tries rather than in one long wait, and it completes once the holder lets go, with the column
 *       and a validated CHECK that refuses a non-object;
 *   (b) a second run on the database that has it, the way an operator re-runs a failed migration
 *       (`migrate resolve --rolled-back`, then `migrate deploy`), raises nothing and changes nothing;
 *   (c) while it waits for the lock, a third connection's read of the table completes within 5 s, before the holder
 *       lets go;
 *   (d) the VALIDATE runs after the DO's transaction has ended: a SHARE UPDATE EXCLUSIVE request queued behind the
 *       DO's lock request is served first, the VALIDATE waits for it holding no lock on the table, and meanwhile a
 *       read and a write go through and a write of a non-object is already refused.
 *
 * WHY THE REAL CLI
 * ================
 * What the file does depends on how it reaches the server. `migrate deploy` sends a file with a DO in it whole, as
 * one query, which PostgreSQL runs as one transaction up to the COMMIT. Drilled for this task with the server's
 * statement log: 0482 arrived as one query, 0479, which has no DO, a statement at a time. Without the COMMIT, the
 * same drill as (d) saw the deploy finish without the VALIDATE ever waiting: it had run under the DO's ACCESS
 * EXCLUSIVE lock. So the cases run the CLI rather than send the text themselves.
 *
 * WHY ITS OWN DATABASES
 * =====================
 * The harness hands every pg spec a database with every migration applied, 0482 included, and taking 0482 out of it
 * would have to know whatever later migrations build on it (watch-migration.pg.spec.ts says how that rots). So the
 * frontier before 0482 is replayed into a database of its own from template0 by the same CLI, seeded once, and
 * copied for each case; the harness's database is only read, to prove whose server this is.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-model-request-material-migration.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const API = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(API, 'prisma', 'migrations');
// Resolved rather than named, as watch-migration.pg.spec.ts does: which node_modules holds the CLI is the lockfile's.
const PRISMA = require.resolve('prisma/build/index.js');
const FRONTIER_CONFIG = path.join(API, 'prisma.frontier.config.ts');

const UNIT = '0482_wiki_model_request_material';
const CHECK = 'wiki_model_request_material_chk';
const CHECK_DEF = `CHECK (((material IS NULL) OR (jsonb_typeof(material) = 'object'::text)))`;
/** How long the other transaction holds its lock, in (a) and (c). */
const HOLD_MS = 10_000;

const FIX = '0482b482-0482-4482-8482-';
const id = (n: number) => `${FIX}${String(n).padStart(12, '0')}`;
const OWNER = id(1);
const SPACE = id(2);
const JOB = id(3);
const SEEDED = 20;
/** A seeded request, the one the cases write to. */
const ROW = id(101);

async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  return client;
}

async function backendPid(client: Client): Promise<number> {
  return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
}

interface Run {
  code: number | null;
  output: string;
  endedAt: number;
}

/**
 * The real CLI, against `databaseUrl`, with the migrations of `tree`. Spawned, never execFileSync: the cases hold
 * locks and watch pg_locks while it runs, and a synchronous child would stop the event loop that has to let go.
 */
function prisma(args: string[], databaseUrl: string, tree: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PRISMA, ...args, '--config', FRONTIER_CONFIG], {
      cwd: API,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CHECKPOINT_DISABLE: '1',
        PRISMA_HIDE_UPDATE_MESSAGE: 'true',
        DATABASE_URL: databaseUrl,
        ORBIT_FRONTIER_PRISMA_SCHEMA: path.join(tree, 'schema.prisma'),
        ORBIT_FRONTIER_PRISMA_MIGRATIONS: path.join(tree, 'migrations'),
      },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, endedAt: Date.now() });
    });
  });
}

/** The migrations directory as it stood the moment before 0482, from the shipped files. */
function frontierTree(): string {
  const all = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(all.includes(UNIT), `${UNIT} is no longer a migration directory`);
  const dir = mkdtempSync(path.join(tmpdir(), 'migration-0482-'));
  cpSync(path.join(API, 'prisma', 'schema.prisma'), path.join(dir, 'schema.prisma'));
  mkdirSync(path.join(dir, 'migrations'));
  cpSync(path.join(MIGRATIONS, 'migration_lock.toml'), path.join(dir, 'migrations', 'migration_lock.toml'));
  for (const name of all.filter((dir) => dir < UNIT)) {
    cpSync(path.join(MIGRATIONS, name), path.join(dir, 'migrations', name), { recursive: true });
  }
  return dir;
}

interface Lock {
  pid: number;
  mode: string;
  granted: boolean;
}

/** Every lock held or asked for on wiki_model_request in the database `client` is connected to. */
async function locks(client: Client): Promise<Lock[]> {
  return (await client.query<Lock>(
    `SELECT pid, mode, granted FROM pg_locks
      WHERE locktype = 'relation'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND relation = '"wiki_model_request"'::regclass
      ORDER BY pid, mode`)).rows;
}

/** The backend, not one of `own`, waiting for ACCESS EXCLUSIVE on the table: the migration's DO, mid-try. */
async function migrationWaiting(client: Client, own: Set<number>): Promise<number | null> {
  const waiting = (await locks(client))
    .find((lock) => !own.has(lock.pid) && lock.mode === 'AccessExclusiveLock' && !lock.granted);
  return waiting ? waiting.pid : null;
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    assert.ok(Date.now() < deadline, `waited ${ms} ms for ${what}`);
    await delay(10);
  }
}

async function columnExists(client: Client): Promise<boolean> {
  return (await client.query(
    `SELECT 1 FROM pg_attribute
      WHERE attrelid = '"wiki_model_request"'::regclass AND attname = 'material' AND NOT attisdropped`)).rowCount === 1;
}

async function checkRow(client: Client): Promise<{ convalidated: boolean; def: string } | null> {
  return (await client.query<{ convalidated: boolean; def: string }>(
    `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = '"wiki_model_request"'::regclass AND conname = $1`, [CHECK])).rows[0] ?? null;
}

/**
 * The table as the catalog and its rows have it, each row version with its xmin: what "a second run changed
 * nothing" is measured on. A catalog row rewritten in place keeps its values and gets a new xmin, so the xmins say
 * whether anything was written at all, not only whether it reads the same.
 */
async function fingerprint(client: Client) {
  const rows = async (sql: string) => (await client.query(sql)).rows;
  return {
    table: await rows(
      `SELECT xmin::text AS xmin, relfilenode::text AS relfilenode, relnatts, relchecks
         FROM pg_class WHERE oid = '"wiki_model_request"'::regclass`),
    columns: await rows(
      `SELECT xmin::text AS xmin, attnum, attname, format_type(atttypid, atttypmod) AS type, attnotnull, atthasdef
         FROM pg_attribute WHERE attrelid = '"wiki_model_request"'::regclass AND attnum > 0 ORDER BY attnum`),
    constraints: await rows(
      `SELECT xmin::text AS xmin, oid::text AS oid, conname, convalidated, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conrelid = '"wiki_model_request"'::regclass ORDER BY conname`),
    indexes: await rows(
      `SELECT xmin::text AS xmin, indexrelid::regclass::text AS name, pg_get_indexdef(indexrelid) AS def
         FROM pg_index WHERE indrelid = '"wiki_model_request"'::regclass ORDER BY 2`),
    rows: await rows(`SELECT xmin::text AS xmin, to_jsonb(r) AS row FROM "wiki_model_request" r ORDER BY "id"`),
  };
}

test('migration 0482 waits for its lock in short tries and validates its CHECK on its own',
  { skip, concurrency: 1, timeout: 600_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(PG_URL);
    const caseClient = await connect(PG_URL!);
    const maintenance = new URL(PG_URL!);
    maintenance.pathname = '/postgres';
    const admin = await connect(maintenance.href);
    const clients: Client[] = [];
    const databases: string[] = [];
    let tree: string | null = null;
    // Registered before anything can throw: a client left open keeps `node --test` from exiting, and dropping a
    // database cuts every backend still on it.
    t.after(async () => {
      for (const client of clients) await client.end().catch(() => undefined);
      for (const name of databases) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
      await caseClient.end().catch(() => undefined);
      if (tree) rmSync(tree, { recursive: true, force: true });
    });
    await verifyCoordinatorPgIdentity(caseClient);

    const caseName = decodeURIComponent(new URL(PG_URL!).pathname.replace(/^\//, ''));
    const urlOf = (name: string) => {
      const url = new URL(PG_URL!);
      url.pathname = `/${name}`;
      return url.href;
    };
    const open = async (name: string) => {
      const client = await connect(urlOf(name));
      clients.push(client);
      return client;
    };

    // The frontier: every migration before 0482, by the CLI, into a database of its own, then the rows.
    const frontier = `${caseName}_0482`;
    assert.ok(`${frontier}x`.length <= 63, `${frontier} leaves no room under PostgreSQL's identifier limit`);
    databases.push(frontier);
    await admin.query(`DROP DATABASE IF EXISTS "${frontier}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${frontier}" TEMPLATE template0`);
    tree = frontierTree();
    const replayed = await prisma(['migrate', 'deploy'], urlOf(frontier), tree);
    assert.equal(replayed.code, 0, `the frontier did not replay:\n${replayed.output}`);
    const seed = await connect(urlOf(frontier));
    try {
      assert.equal(await columnExists(seed), false, 'the frontier already has 0482');
      await seed.query(`INSERT INTO "user"("id", "email", "name") VALUES ($1, $2, 'migration 0482 spec')`,
        [OWNER, `${FIX}owner@migration-0482.invalid`]);
      await seed.query(`INSERT INTO "wiki_space"("id", "owner_id", "slug", "title")
        VALUES ($1, $2, 'migration-0482', 'Migration 0482 spec')`, [SPACE, OWNER]);
      await seed.query(`INSERT INTO "wiki_job"("id", "owner_id", "space_id", "kind") VALUES ($1, $2, $3, 'smoke')`,
        [JOB, OWNER, SPACE]);
      // Answered and still queued calls alike, the shapes the table holds in production.
      await seed.query(
        `INSERT INTO "wiki_model_request"("id", "job_id", "owner_id", "space_id", "step", "unit", "request",
                                          "request_sha256", "state", "answer", "ended_at")
         SELECT ($1 || lpad((100 + g)::text, 12, '0'))::uuid, $2, $3, $4, 'extract', 'session-' || g,
                jsonb_build_object('system', 's', 'prompt', 'p' || g, 'maxTokens', 1000), repeat('a', 64),
                CASE WHEN g % 2 = 1 THEN 'succeeded' ELSE 'queued' END,
                CASE WHEN g % 2 = 1 THEN 'an answer' END,
                CASE WHEN g % 2 = 1 THEN now() END
           FROM generate_series(1, ${SEEDED}) AS g`, [FIX, JOB, OWNER, SPACE]);
    } finally {
      await seed.end();
    }
    // From here on the cases deploy 0482 itself, the file as shipped.
    cpSync(path.join(MIGRATIONS, UNIT), path.join(tree, 'migrations', UNIT), { recursive: true });
    const deploy = (name: string) => prisma(['migrate', 'deploy'], urlOf(name), tree!);

    /** A copy of the frontier for one case, under production's two timeouts (docker-compose.yml). */
    const copy = async (suffix: string) => {
      const name = `${frontier}${suffix}`;
      databases.push(name);
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${frontier}"`);
      await admin.query(`ALTER DATABASE "${name}" SET lock_timeout = '30s'`);
      await admin.query(`ALTER DATABASE "${name}" SET statement_timeout = '300s'`);
      return name;
    };

    const a = await copy('a');
    const aWatch = await open(a);
    const setting = async (name: string) =>
      (await aWatch.query<{ v: string }>('SELECT current_setting($1) AS v', [name])).rows[0].v;
    assert.equal(await setting('lock_timeout'), '30s');
    assert.equal(await setting('statement_timeout'), '5min');

    await t.test('(a) a transaction holding a lock on the table for 10 s does not fail the migration: it ' +
      'completes once the lock is let go, with the column and a validated CHECK', async () => {
      const holder = await open(a);
      const own = new Set([await backendPid(aWatch), await backendPid(holder)]);
      const before = (await aWatch.query(`SELECT to_jsonb(r) AS row FROM "wiki_model_request" r ORDER BY "id"`)).rows;
      // ACCESS SHARE: what any open transaction that has read the table holds, a pg_dump for its whole run.
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE "wiki_model_request" IN ACCESS SHARE MODE');
      const heldAt = Date.now();
      let ended: Run | null = null;
      const deploying = deploy(a).then((run) => (ended = run));

      // While the holder holds the lock: when was the migration seen waiting for it? One long wait is one span;
      // short tries are several, with the 1 s pauses between them. Held 10 s, and never less than 5 s past the
      // first try, however long the CLI took to start.
      const waits: Array<{ from: number; to: number }> = [];
      let since: number | null = null;
      let firstWait: number | null = null;
      while (Date.now() < heldAt + HOLD_MS || firstWait === null || Date.now() < firstWait + 5_000) {
        assert.ok(Date.now() < heldAt + 60_000, 'the migration never asked for the lock');
        const waiting = (await migrationWaiting(aWatch, own)) !== null;
        const now = Date.now() - heldAt;
        if (waiting) firstWait ??= Date.now();
        if (waiting && since === null) since = now;
        if (!waiting && since !== null) {
          waits.push({ from: since, to: now });
          since = null;
        }
        assert.equal(ended, null, 'the migration ended while the holder still held its lock');
        await delay(20);
      }
      if (since !== null) waits.push({ from: since, to: Date.now() - heldAt });
      assert.equal(await columnExists(aWatch), false, 'the column appeared while the holder still held its lock');

      const releasedAt = Date.now();
      await holder.query('COMMIT');
      const run = await deploying;
      t.diagnostic(`waits for the lock while it was held (ms after it was taken): ${JSON.stringify(waits)}`);
      t.diagnostic(`deploy ended ${run.endedAt - releasedAt} ms after the holder let go`);

      assert.equal(run.code, 0, `migrate deploy failed while a lock was held for ${HOLD_MS} ms:\n${run.output}`);
      assert.ok(run.endedAt > releasedAt, 'the deploy ended before the holder let go');
      assert.ok(waits.length >= 2,
        `the migration asked for the lock once and kept waiting, ${JSON.stringify(waits)}: no short tries`);

      const ledger = (await aWatch.query<{ finished: boolean; rolled_back: boolean }>(
        `SELECT "finished_at" IS NOT NULL AS finished, "rolled_back_at" IS NOT NULL AS rolled_back
           FROM "_prisma_migrations" WHERE "migration_name" = $1`, [UNIT])).rows;
      assert.deepEqual(ledger, [{ finished: true, rolled_back: false }], 'prisma did not record 0482 as applied');

      const column = (await aWatch.query(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'wiki_model_request' AND column_name = 'material'`)).rows;
      assert.deepEqual(column, [{ data_type: 'jsonb', is_nullable: 'YES', column_default: null }]);
      assert.deepEqual(await checkRow(aWatch), { convalidated: true, def: CHECK_DEF },
        'the CHECK is not there, or not validated');

      // In force: a non-object is refused, an object kept. Inside a transaction rolled back, so the rows stay seeded.
      await aWatch.query('BEGIN');
      try {
        await aWatch.query(`UPDATE "wiki_model_request" SET "material" = '{"dossier": "d"}' WHERE "id" = $1`, [ROW]);
      } finally {
        await aWatch.query('ROLLBACK');
      }
      for (const value of ['[]', '"text"', '1']) {
        await assert.rejects(
          aWatch.query(`UPDATE "wiki_model_request" SET "material" = $2::jsonb WHERE "id" = $1`, [ROW, value]),
          (error: { code?: string; constraint?: string }) => error.code === '23514' && error.constraint === CHECK,
          `material ${value} was not refused by ${CHECK}`);
      }

      // No row written: every seeded request reads as it did, with NULL in the new column.
      const after = (await aWatch.query(
        `SELECT to_jsonb(r) - 'material' AS row, "material" IS NULL AS empty FROM "wiki_model_request" r ORDER BY "id"`))
        .rows;
      assert.equal(after.length, SEEDED);
      assert.deepEqual(after.map((r: { row: unknown }) => r.row), before.map((r: { row: unknown }) => r.row));
      assert.ok(after.every((r: { empty: boolean }) => r.empty), 'a stored request has a material');
    });

    await t.test('(b) a second run on the database that has it raises nothing and changes nothing', async () => {
      const before = await fingerprint(aWatch);
      assert.ok(before.constraints.some((row: { conname: string }) => row.conname === CHECK), '(a) did not apply 0482');

      // What a deploy leaves when the file failed after it started (its VALIDATE past statement_timeout, say): the
      // row of the attempt, unfinished. Every deploy then stops on P3009, and the operator's way on is the header's.
      await aWatch.query(`UPDATE "_prisma_migrations" SET "finished_at" = NULL WHERE "migration_name" = $1`, [UNIT]);
      const stopped = await deploy(a);
      assert.notEqual(stopped.code, 0, 'a deploy went past a failed 0482');
      assert.match(stopped.output, /P3009/);
      const resolved = await prisma(['migrate', 'resolve', '--rolled-back', UNIT], urlOf(a), tree!);
      assert.equal(resolved.code, 0, `migrate resolve --rolled-back failed:\n${resolved.output}`);

      const again = await deploy(a);
      assert.equal(again.code, 0, `the second run failed:\n${again.output}`);
      assert.match(again.output, new RegExp(`Applying migration \`${UNIT}\``), 'the second deploy did not run 0482');
      assert.deepEqual(await fingerprint(aWatch), before,
        'the second run changed the table, its catalog rows or one of its rows');
      const ledger = (await aWatch.query<{ finished: boolean; rolled_back: boolean }>(
        `SELECT "finished_at" IS NOT NULL AS finished, "rolled_back_at" IS NOT NULL AS rolled_back
           FROM "_prisma_migrations" WHERE "migration_name" = $1 ORDER BY "started_at"`, [UNIT])).rows;
      assert.deepEqual(ledger, [{ finished: false, rolled_back: true }, { finished: true, rolled_back: false }]);
    });

    await t.test('(c) while it waits for the lock, another connection\'s read of the table completes within 5 s, ' +
      'not after the holder lets go', async () => {
      const c = await copy('c');
      const watch = await open(c);
      const holder = await open(c);
      const reader = await open(c);
      const readerPid = await backendPid(reader);
      const own = new Set([await backendPid(watch), await backendPid(holder), readerPid]);
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE "wiki_model_request" IN ACCESS SHARE MODE');
      const heldAt = Date.now();
      let ended: Run | null = null;
      const deploying = deploy(c).then((run) => (ended = run));

      // The watch starts before the CLI does, so the first wait it sees is a try that has just begun.
      await until('the migration to ask for its lock', async () => {
        assert.equal(ended, null, 'the deploy ended without ever waiting for the lock');
        return migrationWaiting(watch, own);
      });
      const readStartedAt = Date.now();
      let readEndedAt: number | null = null;
      const reading = reader.query<{ n: number }>('SELECT count(*)::int AS n FROM "wiki_model_request"')
        .then((result) => {
          readEndedAt = Date.now();
          return result.rows[0].n;
        });
      // The holder lets go 10 s after it took the lock, and never less than 6 s after the read began, whatever the
      // read did: a read still waiting at 5 s has failed while the lock was still held.
      const releaseAt = Math.max(heldAt + HOLD_MS, readStartedAt + 6_000);
      // Was the read queued behind the migration's request at all? If it never waited, it proves nothing.
      let readerQueued = false;
      while (readEndedAt === null && Date.now() < releaseAt) {
        if ((await locks(watch)).some((lock) => lock.pid === readerPid && !lock.granted)) readerQueued = true;
        await delay(10);
      }
      await delay(Math.max(0, releaseAt - Date.now()));
      const releasedAt = Date.now();
      await holder.query('COMMIT');
      const count = await reading;
      const run = await deploying;
      const readMs = readEndedAt! - readStartedAt;
      t.diagnostic(`the read took ${readMs} ms, queued behind the migration: ${readerQueued}`);

      assert.equal(run.code, 0, `migrate deploy failed:\n${run.output}`);
      assert.equal(count, SEEDED);
      assert.ok(readerQueued, 'the read never waited behind the migration\'s lock request, so this case proved nothing');
      assert.ok(readMs < 5_000, `the read took ${readMs} ms while the migration waited for its lock`);
      assert.ok(readEndedAt! < releasedAt, 'the read was answered only after the holder let go');
      assert.deepEqual(await checkRow(watch), { convalidated: true, def: CHECK_DEF });
    });

    await t.test('(d) the VALIDATE runs in a transaction of its own, after the DO\'s lock is gone, ' +
      'and holds up no reader or writer', async () => {
      const d = await copy('d');
      const watch = await open(d);
      const holder = await open(d);
      const queued = await open(d);
      const other = await open(d);
      const queuedPid = await backendPid(queued);
      const own = new Set([await backendPid(watch), await backendPid(holder), queuedPid, await backendPid(other)]);
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE "wiki_model_request" IN ACCESS SHARE MODE');
      let ended: Run | null = null;
      const deploying = deploy(d).then((run) => (ended = run));
      const migrationPid = await until('the migration to ask for its lock', async () => {
        assert.equal(ended, null, 'the deploy ended without ever waiting for the lock');
        return migrationWaiting(watch, own);
      });

      // Asked for while the DO's request waits, SHARE UPDATE EXCLUSIVE queues behind it: when the DO's transaction
      // ends, it is served before anything the migration asks for next.
      await queued.query('BEGIN');
      let queuedGranted = false;
      const queuing = queued.query('LOCK TABLE "wiki_model_request" IN SHARE UPDATE EXCLUSIVE MODE')
        .then(() => { queuedGranted = true; });
      await until('the SHARE UPDATE EXCLUSIVE request to queue behind the DO', async () => {
        assert.equal(queuedGranted, false, 'it was granted at once: the DO was between two tries');
        return (await locks(watch)).some((lock) => lock.pid === queuedPid && !lock.granted) ? true : null;
      });
      await holder.query('COMMIT');

      // The DO takes its lock, makes its change and commits; then the VALIDATE asks for SHARE UPDATE EXCLUSIVE and
      // waits for the request served before it. Run inside the DO's transaction, it would never wait.
      const held = await until('the VALIDATE to wait, or the deploy to end', async () => {
        if (ended !== null) return 'ended' as const;
        const mine = (await locks(watch)).filter((lock) => lock.pid === migrationPid);
        return mine.some((lock) => lock.mode === 'ShareUpdateExclusiveLock' && !lock.granted) ? mine : null;
      });
      assert.notEqual(held, 'ended', 'the deploy ended without the VALIDATE ever waiting: it ran inside the DO\'s ' +
        'transaction, under its ACCESS EXCLUSIVE lock');
      assert.deepEqual(held, [{ pid: migrationPid, mode: 'ShareUpdateExclusiveLock', granted: false }],
        'the migration still holds a lock on the table while its VALIDATE waits');
      assert.equal(queuedGranted, true);
      assert.equal(await columnExists(watch), true, 'the DO\'s column is not committed');
      assert.deepEqual(await checkRow(watch), { convalidated: false, def: `${CHECK_DEF} NOT VALID` },
        'the DO\'s CHECK is not committed NOT VALID');

      // Meanwhile the table is the wiki worker's as usual, and the CHECK already holds what is written.
      const readAt = Date.now();
      assert.equal((await other.query<{ n: number }>('SELECT count(*)::int AS n FROM "wiki_model_request"')).rows[0].n,
        SEEDED);
      const readMs = Date.now() - readAt;
      const writeAt = Date.now();
      await other.query(`UPDATE "wiki_model_request" SET "priority" = "priority" + 1 WHERE "id" = $1`, [ROW]);
      const writeMs = Date.now() - writeAt;
      t.diagnostic(`while the VALIDATE waited: a read took ${readMs} ms, a write ${writeMs} ms`);
      assert.ok(readMs < 5_000 && writeMs < 5_000, `a read took ${readMs} ms and a write ${writeMs} ms`);
      await assert.rejects(
        other.query(`UPDATE "wiki_model_request" SET "material" = '[1]' WHERE "id" = $1`, [ROW]),
        (error: { code?: string; constraint?: string }) => error.code === '23514' && error.constraint === CHECK,
        'the NOT VALID CHECK let a non-object through');

      await queuing;
      await queued.query('COMMIT');
      const run = await deploying;
      assert.equal(run.code, 0, `migrate deploy failed:\n${run.output}`);
      assert.deepEqual(await checkRow(watch), { convalidated: true, def: CHECK_DEF }, 'the VALIDATE did not finish');
    });
  });
