/**
 * THE DATABASE HALF OF DEPLOY D2: THE CHECKs THAT HOLD turn_state EQUAL TO THE STORED WORD WHILE BOTH EXIST, phase NOT
 * NULL, THE PARTIAL INDEXES AND THE GATE THAT KEEPS AN UN-BACKFILLED DATABASE OUT (migrations 1622, 1627 to 1634 and
 * 1651 to 1655).
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
 *   (4) on a populated database whose backfill has not run: prisma migrate deploy applies 1622 and the indexes, then
 *       1651 refuses, naming the count, and changes no constraint; the unfilled rows go on taking writes. After the
 *       backfill it still refuses a row whose phase alone is wrong. After the backfill again and `migrate resolve
 *       --rolled-back`, it deploys to the state of (1)
 *
 * The plans of §4.5 are scripts/session-status-query-plans.sql's.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-turn-state-checks.pg.spec.ts
 *
 * Run it on a database of its own, as run-pg-spec.sh does: (4) takes constraints away and puts them back.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

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

test('D2: the agreement CHECKs, phase NOT NULL, the partial indexes and the backfill gate', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  t.after(() => sql.end().catch(() => undefined));

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

  await t.test('(4) 1651 refuses a database whose backfill has not run, and deploys after it', async () => {
    const unfilled: Record<string, string> = {};
    for (const word of Object.keys(HELD_WORDS)) unfilled[word] = await insert(word);
    // The database as D1 leaves rows the backfill has not reached: no D2 objects, the two facts NULL.
    await sql.query(
      `ALTER TABLE "session" DROP CONSTRAINT "${AGREES}", DROP CONSTRAINT "${RELEASED}",
                             ALTER COLUMN "phase" DROP NOT NULL`);
    for (const name of Object.keys(INDEXES)) await sql.query(`DROP INDEX "${name}"`);
    await sql.query(`ALTER TABLE "session" DISABLE TRIGGER "session_zz_phase"`);
    await sql.query(`UPDATE "session" SET "turn_state" = NULL, "phase" = NULL WHERE "id" = ANY($1::uuid[])`,
      [Object.values(unfilled)]);
    await sql.query(`ALTER TABLE "session" ENABLE TRIGGER "session_zz_phase"`);
    await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])`, [D2]);

    /** What stands while 1651 refuses: 1622's two CHECKs, NOT VALID, and nothing of 1651 or after. */
    const assertRefusedState = async () => {
      assert.deepEqual(await checks(), [
        { conname: 'session_phase_chk', convalidated: true },
        { conname: AGREES_UNLESS_NULL, convalidated: false },
        { conname: 'session_turn_state_chk', convalidated: true },
        { conname: RELEASED, convalidated: false },
      ]);
      assert.equal(await phaseNullable(), 'YES');
      assert.deepEqual(await indexes(), builtIndexes);
    };
    const resolve = () => {
      const resolved = prisma(url, 'migrate', 'resolve', '--rolled-back', GATE);
      assert.ok(resolved.ok, resolved.output);
    };
    const backfill = () => sql.query(readFileSync(join(SCRIPTS, 'session-turn-state-backfill.sql'), 'utf8'));

    // Every row of this database but the four was written through the triggers, so the four are all that disagree.
    const first = prisma(url, 'migrate', 'deploy');
    assert.equal(first.ok, false, 'deploy refuses');
    assert.match(first.output, /4 session rows have a turn_state or phase that is not derived from their status/);
    assert.ok(Object.values(unfilled).some((id) => first.output.includes(id)), 'it names one of them');
    await assertRefusedState();

    // The old server goes on serving: a write that names no state column leaves both facts NULL, and passes.
    for (const [word, id] of Object.entries(unfilled)) {
      await sql.query(`UPDATE "session" SET "title" = 'written', "updated_at" = now() WHERE "id" = $1`, [id]);
      assert.deepEqual(await read(id), { status: word, turn_state: null, phase: null }, word);
    }

    await backfill();
    assert.deepEqual(await read(unfilled.PENDING), { status: 'PENDING', turn_state: 'QUEUED', phase: 'PENDING' });
    assert.deepEqual(await read(unfilled.RUNNING), { status: 'RUNNING', turn_state: 'IN_FLIGHT', phase: 'RUNNING' });
    assert.deepEqual(await read(unfilled.AWAITING_INPUT), { status: 'AWAITING_INPUT', turn_state: null, phase: 'IDLE' });

    // The phase half of the gate on its own: turn_state right, phase wrong.
    await sql.query(`UPDATE "session" SET "phase" = 'RUNNING' WHERE "id" = $1`, [unfilled.AWAITING_INPUT]);
    resolve();
    const second = prisma(url, 'migrate', 'deploy');
    assert.equal(second.ok, false, 'deploy refuses a wrong phase');
    assert.match(second.output, /1 session rows have a turn_state or phase that is not derived from their status/);
    assert.match(second.output, new RegExp(unfilled.AWAITING_INPUT));
    await assertRefusedState();

    await backfill();
    resolve();
    const third = prisma(url, 'migrate', 'deploy');
    assert.ok(third.ok, third.output);
    assert.deepEqual(await checks(), EXPECTED_CHECKS);
    assert.equal(await phaseNullable(), 'NO');
    assert.deepEqual(await indexes(), builtIndexes);
    assert.deepEqual(await read(unfilled.PENDING), { status: 'PENDING', turn_state: 'QUEUED', phase: 'PENDING' });
  });
});
