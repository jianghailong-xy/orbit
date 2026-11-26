/**
 * DEPLOY D1 OF THE session.status RETIREMENT: session.turn_state AND session.phase, KEPT FROM THE STORED WORD BY
 * TRIGGERS (migrations 1611 and 1612), EQUAL TO THEIR DERIVATION ON EVERY ROW SHAPE; THE BACKFILL AND THE CENSUS.
 *
 * docs/session-status-retirement-plan.md §1.2, §1.3, §4.1 (D1), §4.4 and §4.6; task T2. What deploy D2 adds on top
 * (the CHECKs, phase NOT NULL, the indexes) is session-turn-state-checks.pg.spec.ts's. Against PostgreSQL:
 *
 *   (1) on the database run-pg-spec.sh migrated from empty (every migration, 1611 and 1612 among them): the two
 *       columns, their validated value CHECKs, the two triggers with their events, `session_aa_…` the first and
 *       `session_zz_phase` the last BEFORE row trigger on session, and no other BEFORE trigger function assigning a
 *       column the two read or write (so a statement that changes one of them names a column they fire on)
 *   (2) INSERT: a session of every shape of common/session-release-shapes.fixture.ts, and one held session of each
 *       held word, each with every combination of the three execution facts (the engine's own turn, a sub-agent, a
 *       background job): turn_state is the word's (plan §1.4) and phase is deriveSessionPhase of the row
 *   (3) UPDATE: each execution fact set and cleared by a statement naming only it, on every one of those shapes; every
 *       word moved to every other word (with finished_at, as session_release_fact_chk asks) with and without a
 *       background job running; the claim on an engine row skipped by its guard, and taken under the declaration
 *   (4) on a database that holds rows and is put back to before 1611: the down script takes 1611 and 1612 away (D2's
 *       CHECKs and indexes go with the columns, their migrations staying recorded, so what follows is a D1 database),
 *       prisma migrate deploy puts them back and writes no row; the census counts the unfilled rows; the backfill
 *       fills them 500 at a time, skipping a locked row until it is free; the census then answers 0 everywhere, and
 *       every row equals its derivation; a stray write of turn_state alone is counted by the census and undone by the
 *       backfill; a second deploy writes nothing
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-turn-state-phase.pg.spec.ts
 *
 * It runs on the database deploy D2 left: migrations 1691 (D4) and 1671 (D3) are rolled back first, with their down
 * scripts (scripts/session-status-drop-down.sql, scripts/session-status-from-facts-down.sql), since D4 dropped the
 * column and D3 replaced the D1 trigger this file holds to account; what D3 stores is
 * sessions/session-status-from-facts.pg.spec.ts's.
 *
 * Not destructive to anything but this disposable database, which it leaves at every migration: every id is fresh.
 * (4)'s census counts the whole database, which it reads as this spec's rows alone: run it on a database of its own,
 * as run-pg-spec.sh does.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { PrismaClient, RunnerStatus } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { RELEASE_SHAPES, type ReleaseShape } from '../common/session-release-shapes.fixture';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { deriveSessionPhase } from './session-phase';
import { turnStateOfWord } from './session-turn-state';
import { restoreStatusColumn } from '../test-support/session-d3-database';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const API = join(__dirname, '..', '..');
const SCRIPTS = join(API, '..', '..', 'scripts');
const D1 = ['1611_session_turn_state_phase', '1612_session_turn_state_phase_validate'];
/** What rewrites D1's phase function and trigger since (the armed-retry rule): taken away and put back with it. */
const AFTER_D1 = ['1667_session_phase_retry_running', '1670_session_phase_retry_pending'];

/** The plan's §1.4: each word the slot and claim rules read is exactly one turn state; every other word has none. */
const TURN_STATE_OF_WORD: Partial<Record<RunStatus, string>> = {
  PENDING: 'QUEUED', RUNNING: 'IN_FLIGHT', INTERRUPTED: 'ABANDONED',
};
const turnStateOf = (word: string): string | null => TURN_STATE_OF_WORD[word as RunStatus] ?? null;

const WORDS = Object.values(RunStatus);
const RELEASED_WORDS: readonly string[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/** The execution facts, every combination of the three. */
interface Facts { engineTurnActive: boolean; runningSubagents: string[]; runningBgJobs: string[] }
const FACTS: Facts[] = [false, true].flatMap((engine) => [false, true].flatMap((subagent) => [false, true].map((job) => ({
  engineTurnActive: engine, runningSubagents: subagent ? ['agent-1'] : [], runningBgJobs: job ? ['bgj_1'] : [],
}))));
const factsLabel = (f: Facts) =>
  `engine ${f.engineTurnActive}, sub-agents ${f.runningSubagents.length}, jobs ${f.runningBgJobs.length}`;

/** One held session of each held word, beside the fixture's shapes (which hold no INTERRUPTED one). */
const HELD: ReleaseShape[] = (['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'] as const).map((status) => ({
  name: `held ${status}`, what: `a held ${status} session`, writer: 'this spec', status, released: false,
  endReason: null, lastTurnOutcome: status === 'INTERRUPTED' ? 'INTERRUPTED' : null, sessionKind: 'CONVERSATION',
  carriesTurnOutcome: true,
}));
const SHAPES: readonly ReleaseShape[] = [...RELEASE_SHAPES, ...HELD];

interface Stored {
  id: string; status: string; finished_at: Date | null; engine_turn_active: boolean; running_subagents: string[];
  running_bg_jobs: string[]; retry_at: Date | null; turn_state: string | null; phase: string | null;
}

const READ = `SELECT "id", "status"::text AS status, "finished_at", "engine_turn_active", "running_subagents",
                     "running_bg_jobs", "retry_at", "turn_state", "phase" FROM "session"`;

/** What the stored row's two facts must be: the word's turn state, and deriveSessionPhase of the row. */
function expected(row: Stored): { turn_state: string | null; phase: string } {
  return {
    turn_state: turnStateOf(row.status),
    phase: deriveSessionPhase({
      turnState: turnStateOfWord(row.status as RunStatus), finishedAt: row.finished_at, engineTurnActive: row.engine_turn_active,
      runningSubagents: row.running_subagents, runningBgJobs: row.running_bg_jobs, retryAt: row.retry_at,
    }),
  };
}

/** See session-release-backfill.pg.spec.ts: forget the rows, then let prisma find the files pending and apply them. */
function migrateDeploy(url: string): void {
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: API, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: 'pipe',
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    assert.fail(`prisma migrate deploy failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
}

interface World { ownerId: string; runnerId: string; workspaceId: string }

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@turn-state.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: `/srv/${label}` },
  });
  return { ownerId, runnerId, workspaceId };
}

/**
 * A session of `shape` with `facts`, as a deploy-1 writer leaves it: Prisma's INSERT (which names neither new column),
 * then the word, written alone. The Prisma model has no `status` since deploy D3, so the word is an UPDATE of its own,
 * with the release column it comes with (session_release_fact_chk) and the engine read declared, as a claim declares
 * it, so the engine guards let a move to RUNNING through.
 */
async function insertShape(db: PrismaClient, w: World, shape: ReleaseShape, facts: Facts, engine: string | null = 'claude'): Promise<string> {
  const id = randomUUID();
  const landing = shape.sessionKind === 'LANDING';
  await db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: shape.name, prompt: shape.what,
      ...(landing
        ? { sessionKind: 'LANDING', provider: 'orbit', providerBuiltin: true, engine: null, startsTaskWork: false }
        : { provider: 'claude', providerBuiltin: true, engine, assignedRunnerId: w.runnerId }),
      endReason: shape.endReason,
      ...(shape.endReason ? { cancelRequestedAt: new Date() } : {}),
      lastTurnOutcome: shape.lastTurnOutcome,
      ...(shape.trashed ? { deletedAt: new Date(), importSourceCwd: '/home/someone/project' } : {}),
      ...facts,
    },
  });
  await db.$transaction([
    db.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`,
    db.$executeRawUnsafe(
      `UPDATE "session" SET "status" = $2::run_status, "finished_at" = CASE WHEN $3::boolean THEN now() END WHERE "id" = $1::uuid`,
      id, shape.status, shape.released),
  ]);
  return id;
}

test('D1: turn_state and phase kept from the word by triggers, the backfill and the census', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  // The database deploy D2 left: migrations 1691 (D4) and 1671 (D3) rolled back, as their down scripts do it. What this file holds to
  // account is D1's trigger, which keeps the facts from the word, and which D3 replaced with one that does the opposite.
  await restoreStatusColumn(sql);
  await sql.query(readFileSync(join(SCRIPTS, 'session-status-from-facts-down.sql'), 'utf8'));
  const read = async (id: string): Promise<Stored> =>
    (await sql.query(`${READ} WHERE "id" = $1::uuid`, [id])).rows[0] as Stored;
  const assertDerived = (row: Stored, what: string) => {
    assert.deepEqual({ turn_state: row.turn_state, phase: row.phase }, expected(row), what);
  };
  const census = async () => (await sql.query(readFileSync(join(SCRIPTS, 'session-turn-state-census.sql'), 'utf8')))
    .rows[0] as Record<string, unknown>;
  const backfillSql = readFileSync(join(SCRIPTS, 'session-turn-state-backfill.sql'), 'utf8');
  /** One batch of the backfill script, as psql sends it: its SET, then its UPDATE. The UPDATE's row count. */
  const backfillBatch = async (client: Client = sql): Promise<number> => {
    const results = await client.query(backfillSql) as unknown as Array<{ command: string; rowCount: number }>;
    const update = results.find((r) => r.command === 'UPDATE');
    assert.ok(update, 'the script runs one UPDATE');
    return update.rowCount;
  };

  await t.test('(1) a fresh database: the columns, the validated CHECKs, the triggers and their order', async () => {
    const columns = (await sql.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'session' AND column_name IN ('turn_state', 'phase') ORDER BY column_name`,
    )).rows;
    assert.deepEqual(columns, [
      // NOT NULL since deploy D2 (1655).
      { column_name: 'phase', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'turn_state', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
    const checks = (await sql.query(
      `SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'session'::regclass AND conname IN ('session_turn_state_chk', 'session_phase_chk') ORDER BY conname`,
    )).rows;
    assert.deepEqual(checks, [
      { conname: 'session_phase_chk', convalidated: true,
        def: `CHECK ((phase = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'IDLE'::text])))` },
      { conname: 'session_turn_state_chk', convalidated: true,
        def: `CHECK (((turn_state IS NULL) OR (turn_state = ANY (ARRAY['QUEUED'::text, 'IN_FLIGHT'::text, 'ABANDONED'::text]))))` },
    ]);
    const triggers = (await sql.query(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def, (t.tgtype & 4) <> 0 AS on_insert, (t.tgtype & 16) <> 0 AS on_update,
              p.proname, pg_get_functiondef(p.oid) AS body
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'session'::regclass AND NOT t.tgisinternal
          AND (t.tgtype & 1) <> 0 AND (t.tgtype & 2) <> 0
        ORDER BY t.tgname`,
    )).rows as Array<{ tgname: string; def: string; on_insert: boolean; on_update: boolean; proname: string; body: string }>;
    const def = (name: string) => triggers.find((tr) => tr.tgname === name)?.def;
    assert.equal(def('session_aa_turn_state_from_status'),
      'CREATE TRIGGER session_aa_turn_state_from_status BEFORE INSERT OR UPDATE OF status ON public.session '
      + 'FOR EACH ROW EXECUTE FUNCTION session_turn_state_from_status()');
    assert.equal(def('session_zz_phase'),
      'CREATE TRIGGER session_zz_phase BEFORE INSERT OR UPDATE OF status, turn_state, finished_at, engine_turn_active, '
      + 'running_subagents, running_bg_jobs, retry_at ON public.session FOR EACH ROW EXECUTE FUNCTION session_phase_from_facts()');
    // PostgreSQL fires the BEFORE row triggers of one event in name order (C collation), which ORDER BY tgname gives.
    for (const event of ['on_insert', 'on_update'] as const) {
      const names = triggers.filter((tr) => tr[event]).map((tr) => tr.tgname).sort();
      assert.equal(names[0], 'session_aa_turn_state_from_status', `${event}: the word's turn state is written first`);
      assert.equal(names.at(-1), 'session_zz_phase', `${event}: phase is written last, from what the others left`);
    }
    // No other BEFORE trigger assigns a column the two read or write, so none can change one behind their backs.
    const watched = /NEW\."?(status|finished_at|engine_turn_active|running_subagents|running_bg_jobs|retry_at|turn_state|phase)"?\s*:=/gi;
    const assigning = triggers.flatMap((tr) => [...tr.body.matchAll(watched)].map((m) => `${tr.tgname}: ${m[1]}`));
    assert.deepEqual(assigning.sort(),
      ['session_aa_turn_state_from_status: turn_state', 'session_zz_phase: phase'],
      'only the two new triggers assign any of these columns');
  });

  await t.test('(2) INSERT: every fixture shape and held word, with every combination of the execution facts', async () => {
    const w = await world(db, 'insert');
    let checked = 0;
    for (const shape of SHAPES) {
      for (const facts of FACTS) {
        const row = await read(await insertShape(db, w, shape, facts));
        assertDerived(row, `${shape.name} (${shape.status}), ${factsLabel(facts)}`);
        checked += 1;
      }
    }
    assert.equal(checked, SHAPES.length * 8);
    assert.ok(SHAPES.length >= RELEASE_SHAPES.length + 4);
    // Every value each column can take was reached, so no branch of either function went unasked.
    const reached = (await sql.query(
      `SELECT array_agg(DISTINCT COALESCE("turn_state", '-') ORDER BY COALESCE("turn_state", '-')) AS turn_states,
              array_agg(DISTINCT "phase" ORDER BY "phase") AS phases
         FROM "session" WHERE "owner_id" = $1::uuid`, [w.ownerId],
    )).rows[0];
    assert.deepEqual(reached, { turn_states: ['-', 'ABANDONED', 'IN_FLIGHT', 'QUEUED'], phases: ['IDLE', 'PENDING', 'RUNNING'] });
  });

  await t.test('(3) UPDATE: each execution fact alone, every word to every word, the engine guard', async () => {
    const w = await world(db, 'update');
    const none = FACTS[0];
    const single: Array<[string, string, string]> = [
      ['engine_turn_active', 'true', 'false'],
      ['running_subagents', `ARRAY['agent-1']`, `ARRAY[]::text[]`],
      ['running_bg_jobs', `ARRAY['bgj_1']`, `ARRAY[]::text[]`],
      // Migrations 1667 and 1670: an armed retry makes a session PENDING, held or released, unless it executes.
      ['retry_at', `now() + interval '30 seconds'`, 'NULL'],
    ];
    for (const shape of SHAPES) {
      const id = await insertShape(db, w, shape, none);
      for (const [column, on, off] of single) {
        await sql.query(`UPDATE "session" SET "${column}" = ${on} WHERE "id" = $1::uuid`, [id]);
        assertDerived(await read(id), `${shape.name}: ${column} set by a statement naming only it`);
        await sql.query(`UPDATE "session" SET "${column}" = ${off} WHERE "id" = $1::uuid`, [id]);
        assertDerived(await read(id), `${shape.name}: ${column} cleared`);
      }
    }
    // Every word to every other word. engine null: the engine guards (0414 and its siblings) pass a row with none.
    let moves = 0;
    for (const jobs of [[], ['bgj_1']]) {
      for (const from of WORDS) {
        for (const to of WORDS) {
          if (from === to) continue;
          const shape = { ...HELD[0], name: `${from} to ${to}`, status: from, released: RELEASED_WORDS.includes(from) };
          const id = await insertShape(db, w, shape, { ...none, runningBgJobs: jobs }, null);
          assertDerived(await read(id), `${from}, inserted`);
          await sql.query(
            `UPDATE "session" SET "status" = $2::run_status,
                    "finished_at" = CASE WHEN $3::boolean THEN COALESCE("finished_at", now()) END
              WHERE "id" = $1::uuid`,
            [id, to, RELEASED_WORDS.includes(to)]);
          const row = await read(id);
          assert.equal(row.status, to);
          assertDerived(row, `${from} to ${to}, ${jobs.length} background jobs`);
          moves += 1;
        }
      }
    }
    assert.equal(moves, 2 * WORDS.length * (WORDS.length - 1));

    // The claim on an engine row: an older replica's (no declaration) is skipped whole by the guard, so the row keeps
    // QUEUED and PENDING; the current claim's declaration lets it through, to IN_FLIGHT and RUNNING.
    const queued = await insertShape(db, w, HELD[0], none, 'claude');
    const claim = `UPDATE "session" SET "status" = 'RUNNING' WHERE "id" = $1::uuid`;
    assert.equal((await sql.query(claim, [queued])).rowCount, 0, 'the guard skips the claim');
    assert.deepEqual(await read(queued).then((r) => [r.status, r.turn_state, r.phase]), ['PENDING', 'QUEUED', 'PENDING']);
    await sql.query('BEGIN');
    await sql.query(`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`);
    assert.equal((await sql.query(claim, [queued])).rowCount, 1);
    await sql.query('COMMIT');
    assert.deepEqual(await read(queued).then((r) => [r.status, r.turn_state, r.phase]), ['RUNNING', 'IN_FLIGHT', 'RUNNING']);
  });

  await t.test('(4) on a populated database: down, deploy again, census, backfill in batches, census', async () => {
    const w = await world(db, 'backfill');
    // More rows than two batches hold, of every shape and every combination of the facts.
    for (let i = 0; i < 3; i += 1) {
      for (const shape of SHAPES) {
        for (const facts of FACTS) await insertShape(db, w, shape, facts);
      }
    }
    // The down script: session as it was before 1611.
    await sql.query(readFileSync(join(SCRIPTS, 'session-turn-state-phase-down.sql'), 'utf8'));
    await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])`, [[...D1, ...AFTER_D1]]);
    const left = (await sql.query(
      `SELECT (SELECT count(*)::int FROM information_schema.columns
                WHERE table_name = 'session' AND column_name IN ('turn_state', 'phase')) AS columns,
              (SELECT count(*)::int FROM pg_proc WHERE proname IN ('session_turn_state_of_status', 'session_phase_of',
                 'session_turn_state_from_status', 'session_phase_from_facts')) AS functions,
              (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'session'::regclass
                  AND tgname IN ('session_aa_turn_state_from_status', 'session_zz_phase')) AS triggers`,
    )).rows[0];
    assert.deepEqual(left, { columns: 0, functions: 0, triggers: 0 }, 'the down script leaves nothing of D1');
    const total = (await sql.query(`SELECT count(*)::int AS n FROM "session"`)).rows[0].n as number;
    assert.ok(total > 1000, `${total} rows: more than two batches`);
    const updatedAt = (await sql.query(`SELECT max("updated_at") AS at, sum(xmin::text::bigint) AS x FROM "session"`)).rows[0];

    migrateDeploy(url);
    const applied = (await sql.query(
      `SELECT count(*)::int AS n FROM _prisma_migrations
        WHERE migration_name = ANY($1::text[]) AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, [D1],
    )).rows[0].n;
    assert.equal(applied, 2, 'prisma applied 1611 and 1612 on a database that had every migration before them');
    assert.deepEqual((await sql.query(`SELECT max("updated_at") AS at, sum(xmin::text::bigint) AS x FROM "session"`)).rows[0],
      updatedAt, 'the migration writes no row');

    const before = await census();
    console.log(`# census before the backfill: ${JSON.stringify({ ...before, by_word: undefined, by_shape: undefined })}`);
    const heldWithTurn = (await sql.query(
      `SELECT count(*)::int AS n FROM "session" WHERE "status"::text IN ('PENDING', 'RUNNING', 'INTERRUPTED')`)).rows[0].n;
    assert.equal(before.rows, total);
    assert.equal(before.phase_null, total, 'no row has a phase yet');
    assert.equal(before.phase_disagrees, total);
    assert.equal(before.turn_state_disagrees, heldWithTurn, 'the rows whose word has a turn state');
    assert.equal(before.parked_rows, 0);
    assert.equal(before.released_with_turn, 0);

    // A row another transaction holds is skipped, and filled by a later batch once it is free.
    const locked = (await sql.query(`SELECT "id" FROM "session" ORDER BY "id" LIMIT 1`)).rows[0].id as string;
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM "session" WHERE "id" = $1::uuid FOR UPDATE`, [locked]);
    const batches: number[] = [];
    try {
      for (;;) {
        const n = await backfillBatch();
        batches.push(n);
        if (n === 0) break;
        assert.ok(batches.length < 20, 'the backfill ends');
      }
      assert.equal((await read(locked)).phase, null, 'the locked row is not written while it is held');
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    const last = await backfillBatch();
    assert.equal(last, 1, 'the row left locked, once free');
    assert.equal(await backfillBatch(), 0);
    console.log(`# backfill batches: ${JSON.stringify([...batches, last])}`);
    assert.ok(batches.slice(0, -1).every((n) => n > 0 && n <= 500), 'at most 500 rows a batch');
    assert.equal(batches.reduce((a, b) => a + b, 0) + last, total, 'every row written once');
    assert.equal(batches.length, Math.ceil((total - 1) / 500) + 1, 'full batches, then the one that finds none');

    const after = await census();
    console.log(`# census after the backfill: ${JSON.stringify(after)}`);
    assert.deepEqual(
      [after.rows, after.turn_state_disagrees, after.phase_disagrees, after.phase_null, after.parked_rows, after.released_with_turn],
      [total, 0, 0, 0, 0, 0]);
    const byWord = after.by_word as Array<{ disagree: number }>;
    assert.ok(byWord.length > 0 && byWord.every((b) => b.disagree === 0));
    for (const row of (await sql.query(READ)).rows as Stored[]) assertDerived(row, `backfilled ${row.id}`);

    // A stray write of turn_state alone (no code of D1 writes it): the census counts it and the backfill undoes it.
    const parked = (await sql.query(
      `SELECT "id" FROM "session" WHERE "status" = 'AWAITING_INPUT' AND NOT "engine_turn_active"
          AND cardinality("running_subagents") = 0 AND cardinality("running_bg_jobs") = 0 LIMIT 1`)).rows[0].id as string;
    await sql.query(`UPDATE "session" SET "turn_state" = 'IN_FLIGHT' WHERE "id" = $1::uuid`, [parked]);
    assert.deepEqual(await read(parked).then((r) => [r.turn_state, r.phase]), ['IN_FLIGHT', 'RUNNING']);
    const stray = await census();
    assert.deepEqual([stray.turn_state_disagrees, stray.phase_disagrees], [1, 1]);
    assert.equal(await backfillBatch(), 1);
    assertDerived(await read(parked), 'the stray write undone');
    assert.deepEqual(await census().then((c) => [c.turn_state_disagrees, c.phase_disagrees]), [0, 0]);

    // The dead label: counted by name, and given no turn state.
    const old = await insertShape(db, w, HELD[2], FACTS[0], null);
    await sql.query(`UPDATE "session" SET "status" = 'PARKED' WHERE "id" = $1::uuid`, [old]);
    assert.deepEqual(await read(old).then((r) => [r.turn_state, r.phase]), [null, 'IDLE']);
    assert.equal((await census()).parked_rows, 1);
    await sql.query(`DELETE FROM "session" WHERE "id" = $1::uuid`, [old]);

    // Deployed again: re-runnable, and it writes no row.
    const steady = (await sql.query(`SELECT sum(xmin::text::bigint) AS x FROM "session"`)).rows[0];
    await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])`, [[...D1, ...AFTER_D1]]);
    migrateDeploy(url);
    assert.deepEqual((await sql.query(`SELECT sum(xmin::text::bigint) AS x FROM "session"`)).rows[0], steady);
    assert.equal(await backfillBatch(), 0, 'nothing to backfill after a second deploy');
  });
});
