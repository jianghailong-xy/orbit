/**
 * THE DATABASE HALF OF DEPLOY D2: THE CHECKs THAT HOLD turn_state EQUAL TO THE STORED WORD WHILE BOTH EXIST, phase NOT
 * NULL, THE PARTIAL INDEXES, THE FILL OF AN UN-BACKFILLED DATABASE AND THE GATE THAT REFUSES A WRONG ROW (migrations
 * 1622, 1627 to 1634 and 1651 to 1655).
 *
 * docs/session-status-retirement-plan.md §1.4, §1.5, §4.1 (D2), §4.5 and §4.6; task T5 and the task that follows the
 * backfill (T3). Against PostgreSQL:
 *
 *   (1) on the database run-pg-spec.sh migrated from empty: every CHECK validated, 1622's NULL-tolerant one and the
 *       NOT NULL helper gone, phase NOT NULL, and every index built, valid and over the columns and rows named here
 *   (2) a mismatched row is refused: turn_state written alone, against every held word and every turn state it does not
 *       mean (null under a word that means one included); on a released row; a null phase. A row that was refused is left
 *       as it was
 *   (3) what the two releases write passes: a D1 server's (the word only) and a D2 server's (the word and its turn
 *       state), for every word; and the released CHECK on its own, with the agreement CHECK taken away
 *   (4) on a populated database whose backfill has not run: one prisma migrate deploy fills the unfilled rows as the
 *       backfill would, writes no row that was filled, and ends in the state of (1)
 *   (5) a filled but wrong row, turn_state or phase, is refused: 1651 names the count and changes no constraint, and the
 *       unfilled rows beside it stay filled. Once the wrong rows are corrected and the migration resolved, it deploys to
 *       the state of (1)
 *   (6) 1651's fill is committed before it asks for the table lock: while another transaction keeps that lock from it,
 *       the filled rows can be read and written
 *
 * The plans of §4.5 are scripts/session-status-query-plans.sql's.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-turn-state-checks.pg.spec.ts
 *
 * Run it on a database of its own, as run-pg-spec.sh does: it rolls migration 1671 (deploy D3) back first
 * (scripts/session-status-from-facts-down.sql), and (4) takes constraints away and puts them back.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const API = join(__dirname, '..', '..');
const SCRIPTS = join(API, '..', '..', 'scripts');

const D2 = [
  '1622_session_turn_state_checks',
  '1627_session_runner_turn_state_idx',
  '1628_session_runner_held_idx',
  '1629_session_batch_in_flight_idx',
  '1631_session_root_in_flight_idx',
  '1632_session_over_capacity_queued_idx',
  '1633_session_owner_held_task_idx',
  '1634_session_released_failed_idx',
  '1651_session_turn_state_strict_checks',
  '1652_session_turn_state_agrees_validate',
  '1653_session_turn_state_released_validate',
  '1654_session_phase_not_null_validate',
  '1655_session_phase_set_not_null',
];
const GATE = '1651_session_turn_state_strict_checks';

const AGREES = 'session_turn_state_agrees_chk';
const AGREES_UNLESS_NULL = 'session_turn_state_agrees_unless_null_chk';
const RELEASED = 'session_turn_state_released_chk';

/** Each index, as pg_get_indexdef words it after `USING btree`. */
const INDEXES: Record<string, string> = {
  session_batch_in_flight_idx: `(batch_id) WHERE (turn_state = 'IN_FLIGHT'::text)`,
  session_over_capacity_queued_idx:
    `(assigned_runner_id) WHERE ((over_capacity_turn_id IS NOT NULL) AND (turn_state = 'QUEUED'::text))`,
  session_owner_held_task_idx: `(owner_id, task_id) WHERE (finished_at IS NULL)`,
  session_released_failed_idx:
    `(owner_id) WHERE ((owner_id IS NOT NULL) AND (finished_at IS NOT NULL) AND (end_reason IS NULL) AND `
    + `((last_turn_outcome = 'FAILED'::text) OR ((last_turn_outcome IS NULL) AND (import_source_cwd IS NOT NULL))))`,
  session_root_in_flight_idx: `(root_session_id) WHERE (turn_state = 'IN_FLIGHT'::text)`,
  session_runner_held_idx: `(assigned_runner_id) WHERE (finished_at IS NULL)`,
  session_runner_turn_state_idx: `(assigned_runner_id, turn_state) WHERE (turn_state IS NOT NULL)`,
};

/** Plan §1.4: the turn state each held word means; every other word means none. */
const HELD_WORDS = { PENDING: 'QUEUED', RUNNING: 'IN_FLIGHT', INTERRUPTED: 'ABANDONED', AWAITING_INPUT: null } as const;
const RELEASED_WORDS = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const TURN_STATES = ['QUEUED', 'IN_FLIGHT', 'ABANDONED', null];

const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';

function prisma(url: string, ...args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), ...args], {
      cwd: API, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: 'pipe',
    });
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('D2: the agreement CHECKs, phase NOT NULL, the partial indexes, the fill and the gate', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  t.after(() => sql.end().catch(() => undefined));
  // The database deploy D2 left: migration 1671 (D3) rolled back, as its down script does it. What this file holds to
  // account are D2's CHECKs, whose deploy-1 writes (the word alone) D3's trigger would not keep the facts beside.
  await sql.query(readFileSync(join(SCRIPTS, 'session-status-from-facts-down.sql'), 'utf8'));

  const owner = randomUUID();
  await sql.query(`INSERT INTO "user" ("id", "email", "name") VALUES ($1, $2, 'checks')`,
    [owner, `checks-${owner}@turn-state.invalid`]);

  /** A session holding `word`, released when the word is one of the three released ones. Written as D1 writes it. */
  const insert = async (word: string): Promise<string> => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "session" ("id", "title", "prompt", "owner_id", "creator_id", "updated_at", "status", "finished_at")
       VALUES ($1, $2::text, 'p', $3, $3, now(), $2::run_status, CASE WHEN $4::boolean THEN now() END)`,
      [id, word, owner, RELEASED_WORDS.includes(word)]);
    return id;
  };
  const read = async (id: string) => (await sql.query<{ status: string; turn_state: string | null; phase: string }>(
    `SELECT "status"::text AS status, "turn_state", "phase" FROM "session" WHERE "id" = $1`, [id])).rows[0];
  const refused = async (query: string, params: Array<string | null>, code: string, constraint: string | undefined, what: string) => {
    await assert.rejects(sql.query(query, params), (thrown: unknown) => {
      const error = thrown as { code?: string; constraint?: string };
      assert.equal(error.code, code, `${what}: ${String(error)}`);
      if (constraint) assert.equal(error.constraint, constraint, what);
      return true;
    }, what);
  };

  const checks = async () => (await sql.query<{ conname: string; convalidated: boolean }>(
    `SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'session'::regclass
        AND (conname LIKE 'session_turn_state_%chk' OR conname LIKE 'session_phase_%chk') ORDER BY conname`)).rows;
  /** 1611's two value CHECKs beside D2's two, all validated; the NOT NULL helper gone. */
  const EXPECTED_CHECKS = [
    { conname: 'session_phase_chk', convalidated: true },
    { conname: AGREES, convalidated: true },
    { conname: 'session_turn_state_chk', convalidated: true },
    { conname: RELEASED, convalidated: true },
  ];
  const phaseNullable = async () => (await sql.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'session' AND column_name = 'phase'`,
  )).rows[0].is_nullable;
  const indexes = async () => (await sql.query<{ name: string; def: string; valid: boolean; unique: boolean }>(
    `SELECT c.relname AS name, regexp_replace(pg_get_indexdef(i.indexrelid), '^.* USING btree ', '') AS def,
            i.indisvalid AS valid, i.indisunique AS "unique"
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'session'::regclass AND c.relname = ANY($1::text[]) ORDER BY 1`, [Object.keys(INDEXES)])).rows;
  const builtIndexes = Object.keys(INDEXES).sort()
    .map((name) => ({ name, def: INDEXES[name], valid: true, unique: false }));

  await t.test('(1) a fresh database: the CHECKs validated, phase NOT NULL, the indexes', async () => {
    assert.deepEqual(await checks(), EXPECTED_CHECKS);
    assert.equal(await phaseNullable(), 'NO');
    assert.deepEqual(await indexes(), builtIndexes);
  });

  await t.test('(2) a mismatched row is refused, and left as it was', async () => {
    let refusals = 0;
    for (const [word, meant] of Object.entries(HELD_WORDS)) {
      const id = await insert(word);
      const before = await read(id);
      assert.equal(before.turn_state, meant, word);
      // turn_state named alone: 1611's trigger fires on a statement naming status, so nothing puts it right.
      for (const wrong of TURN_STATES.filter((state) => state !== meant)) {
        await refused(`UPDATE "session" SET "turn_state" = $2 WHERE "id" = $1`, [id, wrong],
          CHECK_VIOLATION, AGREES, `${word} with turn_state ${wrong}`);
        refusals += 1;
      }
      await refused(`UPDATE "session" SET "phase" = NULL WHERE "id" = $1`, [id],
        NOT_NULL_VIOLATION, undefined, `${word} with a null phase`);
      assert.deepEqual(await read(id), before);
    }
    // Three wrong values for each of the four held words, null among them where the word means a turn.
    assert.equal(refusals, 12);
    for (const word of RELEASED_WORDS) {
      const id = await insert(word);
      for (const state of TURN_STATES.filter((s) => s !== null)) {
        await refused(`UPDATE "session" SET "turn_state" = $2 WHERE "id" = $1`, [id, state],
          CHECK_VIOLATION, undefined, `released ${word} with turn_state ${state}`);
      }
      assert.equal((await read(id)).turn_state, null);
    }
  });

  await t.test('(3) both releases\' writes pass; the released CHECK holds on its own', async () => {
    const words = [...Object.keys(HELD_WORDS), ...RELEASED_WORDS];
    const turnStateOf = (word: string) => (HELD_WORDS as Record<string, string | null>)[word] ?? null;
    const move = `"status" = $2::run_status, "finished_at" = CASE WHEN $3::boolean THEN now() END`;
    for (const from of words) {
      for (const to of words) {
        const released = RELEASED_WORDS.includes(to);
        // D1: the word only.
        const d1 = await insert(from);
        await sql.query(`UPDATE "session" SET ${move} WHERE "id" = $1`, [d1, to, released]);
        assert.equal((await read(d1)).turn_state, turnStateOf(to), `${from} to ${to}, the word only`);
        // D2: the word and its turn state.
        const d2 = await insert(from);
        await sql.query(`UPDATE "session" SET ${move}, "turn_state" = $4 WHERE "id" = $1`,
          [d2, to, released, turnStateOf(to)]);
        assert.equal((await read(d2)).turn_state, turnStateOf(to), `${from} to ${to}, both spellings`);
      }
    }
    // A released word with a turn is refused by the agreement CHECK first. Without it (as after D4), the released
    // CHECK alone refuses it.
    const id = await insert('SUCCEEDED');
    await sql.query('BEGIN');
    try {
      await sql.query(`ALTER TABLE "session" DROP CONSTRAINT "${AGREES}"`);
      await refused(`UPDATE "session" SET "turn_state" = 'QUEUED' WHERE "id" = $1`, [id],
        CHECK_VIOLATION, RELEASED, 'a released row with a turn');
    } finally {
      await sql.query('ROLLBACK');
    }
  });

  /** The database as D1 leaves rows the backfill has not reached: `migrations` not yet applied, the two facts NULL. */
  const rewind = async (migrations: string[], unfilled: string[]) => {
    await sql.query(
      `ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "${AGREES}", ALTER COLUMN "phase" DROP NOT NULL`);
    if (migrations.includes(D2[0])) {
      await sql.query(`ALTER TABLE "session" DROP CONSTRAINT "${RELEASED}"`);
      for (const name of Object.keys(INDEXES)) await sql.query(`DROP INDEX "${name}"`);
    }
    await sql.query(`ALTER TABLE "session" DISABLE TRIGGER "session_zz_phase"`);
    await sql.query(`UPDATE "session" SET "turn_state" = NULL, "phase" = NULL WHERE "id" = ANY($1::uuid[])`, [unfilled]);
    await sql.query(`ALTER TABLE "session" ENABLE TRIGGER "session_zz_phase"`);
    await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])`, [migrations]);
  };
  /** One session of every word, none of them filled once `rewind` has had them. */
  const everyWord = async (): Promise<Record<string, string>> => {
    const ids: Record<string, string> = {};
    for (const word of [...Object.keys(HELD_WORDS), ...RELEASED_WORDS]) ids[word] = await insert(word);
    return ids;
  };
  /** What a filled row of each word reads, with nothing executing. */
  const filled = (word: string) => ({
    status: word,
    turn_state: (HELD_WORDS as Record<string, string | null>)[word] ?? null,
    phase: word === 'PENDING' ? 'PENDING' : word === 'RUNNING' ? 'RUNNING' : 'IDLE',
  });
  const census = async () => (await sql.query<{ turn_state_disagrees: number; phase_disagrees: number; phase_null: number }>(
    readFileSync(join(SCRIPTS, 'session-turn-state-census.sql'), 'utf8'))).rows[0];
  const assertCensusClean = async () => {
    const { turn_state_disagrees, phase_disagrees, phase_null } = await census();
    assert.deepEqual([turn_state_disagrees, phase_disagrees, phase_null], [0, 0, 0]);
  };
  /** Every row but `ids`, with the transaction that last wrote it. */
  const versions = async (ids: string[]) => (await sql.query(
    `SELECT "id", xmin::text AS xmin FROM "session" WHERE NOT "id" = ANY($1::uuid[]) ORDER BY "id"`, [ids])).rows;
  const assertDeployed = async () => {
    assert.deepEqual(await checks(), EXPECTED_CHECKS);
    assert.equal(await phaseNullable(), 'NO');
    assert.deepEqual(await indexes(), builtIndexes);
  };

  await t.test('(4) an un-backfilled database is filled by the deploy, and ends as a fresh one', async () => {
    const unfilled = await everyWord();
    // A parked session with a background job: its phase comes from more than its word.
    const working = await insert('AWAITING_INPUT');
    await sql.query(`UPDATE "session" SET "running_bg_jobs" = ARRAY['bgj_1'] WHERE "id" = $1`, [working]);
    const ids = [...Object.values(unfilled), working];
    await rewind(D2, ids);
    assert.equal((await census()).phase_null, ids.length);
    const others = await versions(ids);
    assert.ok(others.length > 0, 'there are filled rows beside them');

    const deployed = prisma(url, 'migrate', 'deploy');
    assert.ok(deployed.ok, deployed.output);
    await assertDeployed();
    for (const [word, id] of Object.entries(unfilled)) assert.deepEqual(await read(id), filled(word), word);
    assert.deepEqual(await read(working), { status: 'AWAITING_INPUT', turn_state: null, phase: 'RUNNING' });
    await assertCensusClean();
    assert.deepEqual(await versions(ids), others, 'no filled row was written');
  });

  await t.test('(5) a filled but wrong row is refused, and deploys once corrected', async () => {
    const unfilled = await everyWord();
    const wrongTurn = await insert('RUNNING');
    const wrongPhase = await insert('AWAITING_INPUT');
    await rewind(D2, Object.values(unfilled));
    await sql.query(`UPDATE "session" SET "turn_state" = 'QUEUED' WHERE "id" = $1`, [wrongTurn]);
    await sql.query(`UPDATE "session" SET "phase" = 'RUNNING' WHERE "id" = $1`, [wrongPhase]);

    const refusal = prisma(url, 'migrate', 'deploy');
    assert.equal(refusal.ok, false, 'deploy refuses');
    assert.match(refusal.output,
      /2 session rows have a filled turn_state or phase that is not derived from their status/);
    assert.ok([wrongTurn, wrongPhase].some((id) => refusal.output.includes(id)), 'it names one of them');
    // 1622's two CHECKs stand, NOT VALID, and nothing of 1651's swap or after.
    assert.deepEqual(await checks(), [
      { conname: 'session_phase_chk', convalidated: true },
      { conname: AGREES_UNLESS_NULL, convalidated: false },
      { conname: 'session_turn_state_chk', convalidated: true },
      { conname: RELEASED, convalidated: false },
    ]);
    assert.equal(await phaseNullable(), 'YES');
    for (const [word, id] of Object.entries(unfilled)) assert.deepEqual(await read(id), filled(word), word);
    assert.deepEqual(await read(wrongPhase), { status: 'AWAITING_INPUT', turn_state: null, phase: 'RUNNING' });

    // The hint's correction: the backfill rewrites a disagreeing row from its status.
    await sql.query(readFileSync(join(SCRIPTS, 'session-turn-state-backfill.sql'), 'utf8'));
    const resolved = prisma(url, 'migrate', 'resolve', '--rolled-back', GATE);
    assert.ok(resolved.ok, resolved.output);
    const deployed = prisma(url, 'migrate', 'deploy');
    assert.ok(deployed.ok, deployed.output);
    await assertDeployed();
    assert.deepEqual(await read(wrongTurn), filled('RUNNING'));
    assert.deepEqual(await read(wrongPhase), filled('AWAITING_INPUT'));
  });

  await t.test('(6) the fill is committed before 1651 asks for the table lock', async () => {
    const id = await insert('PENDING');
    await rewind(D2.slice(D2.indexOf(GATE)), [id]);
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    await holder.query('BEGIN');
    // Lets the UPDATE through and keeps ALTER TABLE out.
    await holder.query('LOCK TABLE "session" IN ACCESS SHARE MODE');
    let ended = false;
    const deploy = promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      { cwd: API, env: { ...process.env, DATABASE_URL: url } }).finally(() => { ended = true; });
    deploy.catch(() => undefined);
    try {
      for (const until = Date.now() + 30_000; (await read(id)).phase === null;) {
        assert.ok(Date.now() < until && !ended, 'the filled row is visible while the deploy waits');
        await sleep(100);
      }
      // Behind a queued ALTER for 2 s at most; behind the row lock of an uncommitted fill, until the deploy ends.
      await sql.query(`SET lock_timeout = '5s'`);
      await sql.query(`UPDATE "session" SET "title" = 'written' WHERE "id" = $1`, [id]);
      await sql.query('RESET lock_timeout');
      assert.equal(ended, false, 'the deploy is still waiting for the table lock');
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    await deploy;
    await assertDeployed();
    assert.deepEqual(await read(id), filled('PENDING'));
  });
});
