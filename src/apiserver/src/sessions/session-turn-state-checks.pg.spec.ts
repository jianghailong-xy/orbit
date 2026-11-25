/**
 * THE DATABASE HALF OF DEPLOY D2 THAT IS SAFE BEFORE THE BACKFILL: THE NOT VALID CHECKs ON turn_state AND THE PARTIAL
 * INDEXES (migrations 1622 and 1627 to 1634).
 *
 * docs/session-status-retirement-plan.md §1.4, §1.5, §4.1 (D2), §4.5 and §4.6; task T5. The project branch reaches main
 * as one merge, so these can be deployed before the backfill (task T3) has filled turn_state and phase. VALIDATE, phase
 * NOT NULL and the strict agreement CHECK wait for it, in a later task. Against PostgreSQL:
 *
 *   (1) on the database run-pg-spec.sh migrated from empty: the two CHECKs, NOT VALID; phase still nullable; every index
 *       built, valid and over the columns and rows named here
 *   (2) a mismatched row is refused: a turn state written alone against every held word that does not mean it, and any
 *       turn state on a released row. A row that was refused is left as it was
 *   (3) what the two releases write passes: a D1 server's (the word only) and a D2 server's (the word and its turn
 *       state), for every word; and the released CHECK on its own, with the agreement CHECK taken away
 *   (4) on a populated database whose backfill has not run: prisma migrate deploy applies the files with no gate; the
 *       unfilled rows (turn_state and phase NULL) go on taking writes, which the plan's strict CHECK, even NOT VALID,
 *       would refuse; the backfill then fills them
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
];

const AGREES = 'session_turn_state_agrees_unless_null_chk';
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
const TURN_STATES = ['QUEUED', 'IN_FLIGHT', 'ABANDONED'];

const CHECK_VIOLATION = '23514';

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

test('D2 before the backfill: the NOT VALID CHECKs and the partial indexes', {
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
  /** 1611's two value CHECKs, validated by 1612, beside this task's two, which nothing validates yet. */
  const EXPECTED_CHECKS = [
    { conname: 'session_phase_chk', convalidated: true },
    { conname: AGREES, convalidated: false },
    { conname: 'session_turn_state_chk', convalidated: true },
    { conname: RELEASED, convalidated: false },
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

  await t.test('(1) a fresh database: the CHECKs NOT VALID, phase nullable, the indexes', async () => {
    assert.deepEqual(await checks(), EXPECTED_CHECKS);
    assert.equal(await phaseNullable(), 'YES', 'NOT NULL waits for the backfill');
    assert.deepEqual(await indexes(), builtIndexes);
  });

  await t.test('(2) a NOT VALID CHECK refuses a new mismatched row, and leaves it as it was', async () => {
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
      assert.deepEqual(await read(id), before);
    }
    assert.equal(refusals, 9);
    for (const word of RELEASED_WORDS) {
      const id = await insert(word);
      for (const state of TURN_STATES) {
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

  await t.test('(4) before the backfill: the files apply with no gate, and unfilled rows go on taking writes', async () => {
    const unfilled: Record<string, string> = {};
    for (const word of Object.keys(HELD_WORDS)) unfilled[word] = await insert(word);
    // The database as D1 leaves rows the backfill has not reached: no D2 objects, the two facts NULL.
    await sql.query(`ALTER TABLE "session" DROP CONSTRAINT "${AGREES}", DROP CONSTRAINT "${RELEASED}"`);
    for (const name of Object.keys(INDEXES)) await sql.query(`DROP INDEX "${name}"`);
    await sql.query(`ALTER TABLE "session" DISABLE TRIGGER "session_zz_phase"`);
    await sql.query(`UPDATE "session" SET "turn_state" = NULL, "phase" = NULL WHERE "id" = ANY($1::uuid[])`,
      [Object.values(unfilled)]);
    await sql.query(`ALTER TABLE "session" ENABLE TRIGGER "session_zz_phase"`);
    await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])`, [D2]);

    const deployed = prisma(url, 'migrate', 'deploy');
    assert.ok(deployed.ok, deployed.output);
    assert.deepEqual(await checks(), EXPECTED_CHECKS);
    assert.equal(await phaseNullable(), 'YES');
    assert.deepEqual(await indexes(), builtIndexes);

    // A write that names no state column leaves both facts NULL, and passes.
    for (const [word, id] of Object.entries(unfilled)) {
      await sql.query(`UPDATE "session" SET "title" = 'written', "updated_at" = now() WHERE "id" = $1`, [id]);
      assert.deepEqual(await read(id), { status: word, turn_state: null, phase: null }, word);
    }
    // Why the plan's strict CHECK waits: even NOT VALID, it refuses that write on a row whose word means a turn.
    await sql.query('BEGIN');
    try {
      await sql.query(`ALTER TABLE "session" ADD CONSTRAINT "session_turn_state_agrees_chk"
        CHECK ("turn_state" IS NOT DISTINCT FROM (CASE "status" WHEN 'PENDING' THEN 'QUEUED'
                 WHEN 'RUNNING' THEN 'IN_FLIGHT' WHEN 'INTERRUPTED' THEN 'ABANDONED' END)) NOT VALID`);
      await refused(`UPDATE "session" SET "title" = $2 WHERE "id" = $1`, [unfilled.RUNNING, 'again'],
        CHECK_VIOLATION, 'session_turn_state_agrees_chk', 'an unfilled RUNNING row under the strict CHECK');
    } finally {
      await sql.query('ROLLBACK');
    }
    // The writes that move an unfilled row: a background job (phase is written, turn_state stays NULL) and a release.
    await sql.query(`UPDATE "session" SET "running_bg_jobs" = ARRAY['bgj_1'] WHERE "id" = $1`, [unfilled.RUNNING]);
    assert.equal((await read(unfilled.RUNNING)).turn_state, null);
    await sql.query(`UPDATE "session" SET "status" = 'CANCELLED', "finished_at" = now() WHERE "id" = $1`,
      [unfilled.INTERRUPTED]);
    assert.deepEqual(await read(unfilled.INTERRUPTED), { status: 'CANCELLED', turn_state: null, phase: 'IDLE' });

    await sql.query(readFileSync(join(SCRIPTS, 'session-turn-state-backfill.sql'), 'utf8'));
    assert.deepEqual(await read(unfilled.PENDING), { status: 'PENDING', turn_state: 'QUEUED', phase: 'PENDING' });
    assert.deepEqual(await read(unfilled.RUNNING), { status: 'RUNNING', turn_state: 'IN_FLIGHT', phase: 'RUNNING' });
    assert.deepEqual(await read(unfilled.AWAITING_INPUT), { status: 'AWAITING_INPUT', turn_state: null, phase: 'IDLE' });
  });
});
