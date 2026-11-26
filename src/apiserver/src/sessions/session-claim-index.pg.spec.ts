import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { heldFilter } from '../common/session-release';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { pgAdapterFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { DispatchPauseService } from '../queue/dispatch-pause.service';
import { TASK_OCCUPYING } from '../tasks/reclaim-stalled-task';
import {
  conflictingUniqueKey,
  isExecutionClaimConflict,
  namesExecutionClaimIndex,
} from '../tasks/task-supersession';
import { readTaskWorkCarriers } from './task-work-carrier';
import { WORD_SELECT } from '../test-support/session-word';

/**
 * ONE LIVE RUN PER TASK, RELEASE A: 1426's index on the release column beside 0130's on the status set.
 *
 * docs/session-three-state-plan.md §7 step 4.5; migration 1426's header says why each piece is there.
 *
 *   (1) 1426 by the real `prisma migrate deploy` on a database that holds sessions: the file is sent a statement at a
 *       time (a concurrent build inside a transaction block is refused, 25001, which is shown first), and afterwards
 *       both indexes exist, are valid, and read as their definitions say
 *   (2) an interrupted build: held behind an open writer, cancelled. The INVALID index it leaves, P3009 on the next
 *       deploy, `prisma migrate resolve --rolled-back`, and the deploy after it builds the index again, valid
 *   (3) a second live run for one task, and the revive of a released one, with the old index alone, the new alone,
 *       both as in production (0130's built first), and both the other way round: refused every time; what Prisma's
 *       P2002 reports; release A's classifiers and deploy 1's (copied below as production runs them at 45c327a903)
 *       each call it a claim conflict. A released run does not block the task's next one, under any of the four
 *   (4) the two indexes refuse and admit the same rows under session_release_fact_chk, for every status label and
 *       both values of the release column, with PARKED the one exception the migration's header names
 *   (5) on a large table, EXPLAIN of every reader that states the new predicate (the carrier, the two holder reads,
 *       the dispatch pause's two reads), before and after this change, with the old index alone, both, and the new
 *       alone (release B): each claim reader is planned through the new index once the old one is gone
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-claim-index.pg.spec.ts
 *
 * Not destructive beyond its own database: run-pg-spec.sh gives the spec a clone, and (2) and (3) drop and build
 * indexes on `session`, which they put back.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const NEW_INDEX = 'session_task_execution_claim_idx_finished_at';
/** The partial indexes on `finished_at IS NULL` (migrations 1628, 1633, 1426's execution claim). */
const HELD_PARTIAL_INDEXES = ['session_runner_held_idx', 'session_owner_held_task_idx', NEW_INDEX];
const OLD_INDEX = 'session_task_execution_claim_idx';
const MIGRATION = '1426_session_task_execution_claim_finished_at_idx';
const NEW_DEF = `CREATE UNIQUE INDEX ${NEW_INDEX} ON public.session USING btree (task_id) `
  + 'WHERE ((task_id IS NOT NULL) AND (deleted_at IS NULL) AND (finished_at IS NULL))';
const OLD_DEF = `CREATE UNIQUE INDEX ${OLD_INDEX} ON public.session USING btree (task_id) `
  + "WHERE ((task_id IS NOT NULL) AND (deleted_at IS NULL) AND (status = ANY (ARRAY['PENDING'::run_status, "
  + "'RUNNING'::run_status, 'AWAITING_INPUT'::run_status, 'INTERRUPTED'::run_status])))";

// ── Deploy 1's classifiers, as production runs them (45c327a903: src/apiserver/src/tasks/task-supersession.ts
// conflictingUniqueKey and isExecutionClaimConflict, src/apiserver/src/tasks/tasks.service.ts isTaskRunClaimConflict),
// copied rather than imported so that a later edit of today's cannot make this test pass for a server that is
// already running.
function deploy1ConflictingUniqueKey(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const candidate = error as {
    meta?: {
      target?: unknown;
      driverAdapterError?: {
        cause?: { constraint?: { fields?: unknown; index?: unknown }; originalMessage?: unknown };
      };
    };
  };
  const adapter = candidate.meta?.driverAdapterError?.cause;
  const parts: string[] = [];
  for (const source of [candidate.meta?.target, adapter?.constraint?.fields]) {
    if (Array.isArray(source)) parts.push(source.join(','));
    else if (typeof source === 'string') parts.push(source);
  }
  for (const source of [adapter?.constraint?.index, adapter?.originalMessage]) {
    if (typeof source === 'string') parts.push(source);
  }
  return parts.join('|');
}
const DEPLOY_1_EXECUTION_CLAIM_INDEX = 'session_task_execution_claim_idx';
function deploy1IsExecutionClaimConflict(error: unknown): boolean {
  return deploy1ConflictingUniqueKey(error).includes(DEPLOY_1_EXECUTION_CLAIM_INDEX);
}
function deploy1IsTaskRunClaimConflict(error: unknown): boolean {
  const named = deploy1ConflictingUniqueKey(error);
  return named.includes(DEPLOY_1_EXECUTION_CLAIM_INDEX) || /session_pkey/.test(named)
    || /task_id/.test(named) || /\bid\b/.test(named);
}
// Release A's isTaskRunClaimConflict (tasks.service.ts, not exported), as it reads after this change.
function releaseAIsTaskRunClaimConflict(error: unknown): boolean {
  const named = conflictingUniqueKey(error);
  return namesExecutionClaimIndex(named) || /session_pkey/.test(named)
    || /task_id/.test(named) || /\bid\b/.test(named);
}

// ── Prisma, as migrate deploy is run on an installation.
interface Run { code: number; out: string }
function prisma(url: string, args: string[]): Promise<Run> {
  const api = join(__dirname, '..', '..');
  return new Promise((resolve) => {
    execFile(process.execPath, [require.resolve('prisma/build/index.js'), ...args], {
      cwd: api, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

async function deploy1416Again(sql: Client, url: string): Promise<void> {
  await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = $1`, [MIGRATION]);
  const run = await prisma(url, ['migrate', 'deploy']);
  assert.equal(run.code, 0, `prisma migrate deploy of ${MIGRATION} failed:\n${run.out}`);
  await assertRecordedApplied(sql);
}

async function assertRecordedApplied(sql: Client): Promise<void> {
  const rows = (await sql.query(
    `SELECT count(*)::int AS n FROM _prisma_migrations
      WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, [MIGRATION],
  )).rows as Array<{ n: number }>;
  assert.equal(rows[0].n, 1, 'prisma recorded 1426 applied');
}

interface ClaimIndex { name: string; valid: boolean; ready: boolean; def: string; oid: number }
async function claimIndexes(sql: Client): Promise<ClaimIndex[]> {
  return (await sql.query(
    `SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready, pg_get_indexdef(c.oid) AS def,
            c.oid::int AS oid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'session'::regclass AND c.relname LIKE 'session_task_execution_claim_idx%'
      ORDER BY c.oid`,
  )).rows as ClaimIndex[];
}

// ── Rows.
async function owner(sql: Client, label: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "user" (id, email, name, password_hash) VALUES ($1::uuid, $2, $3, 'x')`,
    [id, `${label}-${id}@claim-index.invalid`, label],
  );
  return id;
}

async function tasks(sql: Client, ownerId: string, n: number): Promise<string[]> {
  const rows = (await sql.query(
    `INSERT INTO task (id, title, owner_id, creator_type, creator_id, updated_at, completion_criterion)
     SELECT gen_random_uuid(), 'claim index task ' || g, $1::uuid, 'USER', $1::uuid, now(),
            (enum_range(NULL::task_completion_criterion))[1]
       FROM generate_series(1, $2::int) g
     RETURNING id::text AS id`, [ownerId, n],
  )).rows as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** A run of `taskId` through Prisma, as every door writes one: held, or released with its cause. */
async function run(db: PrismaClient, ownerId: string, taskId: string, released = false): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId, creatorId: ownerId, taskId, title: 'a run', prompt: 'do it', startsTaskWork: true,
      ...(released
        ? { turnState: null, finishedAt: new Date()}
        : { turnState: 'IN_FLIGHT' }),
    },
  });
  return id;
}

async function caught(write: () => Promise<unknown>): Promise<unknown> {
  try {
    await write();
  } catch (error) {
    return error;
  }
  assert.fail('the write was admitted');
}

test('the one-live-run-per-task index, release A (migration 1426)', {
  skip, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = new PrismaClient({ adapter: pgAdapterFor(url) });
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const me = await owner(sql, 'claim-index');

  await t.test('(1) 1426 by prisma migrate deploy on a populated database: both indexes, valid', async () => {
    // The template is migrated to the head, where 1444 (release B) has dropped 0130's index. Back to deploy 1's
    // state, 0130's index alone, so that 1426 runs again beside it as it did in production; 1444 stays recorded.
    if (!(await claimIndexes(sql)).some((i) => i.name === OLD_INDEX)) {
      await sql.query(`DROP INDEX "${NEW_INDEX}"`);
      await sql.query(OLD_DEF);
    }
    // Rows before the migration runs again: three released runs per task, and a live one on every other task.
    const ids = await tasks(sql, me, 40);
    for (const [i, taskId] of ids.entries()) {
      for (let r = 0; r < 3; r += 1) await run(db, me, taskId, true);
      if (i % 2 === 0) await run(db, me, taskId);
    }
    const held = (await sql.query(
      `SELECT count(*)::int AS n FROM session WHERE owner_id = $1::uuid AND finished_at IS NULL`, [me],
    )).rows[0] as { n: number };
    assert.equal(held.n, 20, 'the database holds live runs when 1426 runs');

    // Why the file must be sent a statement at a time: the same build inside a transaction block is refused.
    await sql.query('BEGIN');
    await assert.rejects(
      sql.query(`CREATE UNIQUE INDEX CONCURRENTLY "claim_index_probe" ON "session" ("task_id") WHERE "finished_at" IS NULL`),
      (error: unknown) => (error as { code?: string }).code === '25001',
    );
    await sql.query('ROLLBACK');

    await deploy1416Again(sql, url);
    const found = await claimIndexes(sql);
    console.log(`# after 1426: ${JSON.stringify(found)}`);
    assert.deepEqual(found.map((i) => [i.name, i.valid, i.ready]), [
      [OLD_INDEX, true, true],
      [NEW_INDEX, true, true],
    ], 'both indexes exist and are valid, 0130\'s first');
    assert.equal(found.find((i) => i.name === OLD_INDEX)!.def, OLD_DEF, 'the old index is the one 0130 built');
    assert.equal(found.find((i) => i.name === NEW_INDEX)!.def, NEW_DEF);
  });

  await t.test('(2) an interrupted build leaves an INVALID index; P3009; resolved, the next deploy builds it valid', async () => {
    // As on a first run that is interrupted: the index is not there yet, and a writer holds `session` open.
    await sql.query(`DROP INDEX "${NEW_INDEX}"`);
    await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = $1`, [MIGRATION]);
    const [taskId] = await tasks(sql, me, 1);
    const writeHeld = await run(db, me, taskId);
    const writer = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await writer.connect();
    await writer.query('BEGIN');
    await writer.query(`UPDATE session SET title = title WHERE id = $1::uuid`, [writeHeld]);

    const deploying = prisma(url, ['migrate', 'deploy']);
    let builder: number | null = null;
    for (let i = 0; i < 600 && builder === null; i += 1) {
      const waiting = (await sql.query(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND query ILIKE '%CREATE UNIQUE INDEX CONCURRENTLY%${NEW_INDEX}%' AND wait_event_type = 'Lock'`,
      )).rows as Array<{ pid: number }>;
      if (waiting.length > 0) builder = waiting[0].pid;
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(builder !== null, 'the concurrent build was sent on its own and waits for the open writer');
    const midway = await claimIndexes(sql);
    console.log(`# while the build waits: ${JSON.stringify(midway)}`);
    assert.deepEqual(midway.find((i) => i.name === NEW_INDEX)?.valid, false, 'the half-built index is in the catalog, INVALID');

    // The interruption: an operator's cancel, a timeout or a lost connection all end the statement the same way.
    await sql.query('SELECT pg_cancel_backend($1)', [builder]);
    const interrupted = await deploying;
    await writer.query('ROLLBACK');
    await writer.end();
    console.log(`# interrupted deploy: exit ${interrupted.code}\n${interrupted.out.split('\n').map((l) => `#   ${l}`).join('\n')}`);
    assert.notEqual(interrupted.code, 0, 'the deploy fails');
    assert.match(interrupted.out, /canceling statement due to user request/);
    const left = await claimIndexes(sql);
    console.log(`# left behind: ${JSON.stringify(left)}`);
    assert.deepEqual(left.map((i) => [i.name, i.valid]), [[OLD_INDEX, true], [NEW_INDEX, false]],
      'an INVALID index is left, and 0130\'s is untouched');
    const failed = (await sql.query(
      `SELECT finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = $1`, [MIGRATION],
    )).rows as Array<{ finished_at: Date | null; rolled_back_at: Date | null }>;
    assert.deepEqual(failed, [{ finished_at: null, rolled_back_at: null }], 'prisma recorded 1426 as failed');

    // Detected: every later deploy stops until an operator acts.
    const stopped = await prisma(url, ['migrate', 'deploy']);
    console.log(`# next deploy: exit ${stopped.code}: ${stopped.out.match(/P3009[^\n]*/)?.[0] ?? stopped.out}`);
    assert.notEqual(stopped.code, 0);
    assert.match(stopped.out, /P3009/);
    assert.match(stopped.out, new RegExp(MIGRATION));

    // Repaired: resolve, deploy. The file's DROP INDEX IF EXISTS removes the INVALID index, and the build makes it again.
    const resolved = await prisma(url, ['migrate', 'resolve', '--rolled-back', MIGRATION]);
    assert.equal(resolved.code, 0, resolved.out);
    const again = await prisma(url, ['migrate', 'deploy']);
    assert.equal(again.code, 0, again.out);
    await assertRecordedApplied(sql);
    const rebuilt = await claimIndexes(sql);
    console.log(`# after resolve and deploy: ${JSON.stringify(rebuilt)}`);
    assert.deepEqual(rebuilt.map((i) => [i.name, i.valid, i.ready]), [[OLD_INDEX, true, true], [NEW_INDEX, true, true]]);
    assert.equal(rebuilt.find((i) => i.name === NEW_INDEX)!.def, NEW_DEF);
  });

  await t.test('(3) a second live run is refused under either index or both, and both releases call it the claim', async () => {
    const original = await claimIndexes(sql);
    assert.deepEqual(original.map((i) => i.name), [OLD_INDEX, NEW_INDEX], '0130\'s index first, as in production');
    const report: string[] = [];
    const states: Array<{ label: string; present: string[]; before?: () => Promise<void> }> = [
      { label: 'both, 0130 built first (production)', present: [OLD_INDEX, NEW_INDEX] },
      { label: 'old index alone (deploy 1)', present: [OLD_INDEX], before: () => sql.query(`DROP INDEX "${NEW_INDEX}"`).then(() => undefined) },
      {
        label: 'new index alone (release B)', present: [NEW_INDEX],
        before: async () => {
          await sql.query(NEW_DEF);
          await sql.query(`DROP INDEX "${OLD_INDEX}"`);
        },
      },
      { label: 'both, 1426 built first', present: [OLD_INDEX, NEW_INDEX], before: () => sql.query(OLD_DEF).then(() => undefined) },
    ];
    try {
      for (const state of states) {
        await state.before?.();
        assert.deepEqual((await claimIndexes(sql)).map((i) => i.name).sort(), [...state.present].sort(), state.label);
        const [busy, free] = await tasks(sql, me, 2);
        await run(db, me, busy);
        const releasedOnBusy = await run(db, me, busy, true);

        // A second live run for the task: what a dispatch writes.
        const second = await caught(() => run(db, me, busy));
        // The revive of a released run of the same task: what `resume` writes.
        const revive = await caught(() => db.session.update({
          where: { id: releasedOnBusy },
          data: { turnState: 'QUEUED', finishedAt: null},
        }));
        for (const [door, error] of [['second run', second], ['revive', revive]] as const) {
          const e = error as {
            code?: string;
            meta?: { target?: unknown; driverAdapterError?: { cause?: { constraint?: unknown; originalMessage?: unknown } } };
          };
          assert.equal(e.code, 'P2002', `${state.label}, ${door}: a duplicate key`);
          const named = conflictingUniqueKey(error);
          const index = state.present.slice().sort((a, b) => b.length - a.length).find((name) => named.includes(name));
          report.push(`${state.label} | ${door} | P2002 meta.target=${JSON.stringify(e.meta?.target ?? null)} `
            + `constraint=${JSON.stringify(e.meta?.driverAdapterError?.cause?.constraint ?? null)} `
            + `message=${JSON.stringify(e.meta?.driverAdapterError?.cause?.originalMessage ?? null)} | index ${index}`);
          assert.ok(index !== undefined, `${state.label}, ${door}: the refusal names one of the indexes present (${named})`);
          assert.equal(isExecutionClaimConflict(error), true, `${state.label}, ${door}: release A's isExecutionClaimConflict`);
          assert.equal(releaseAIsTaskRunClaimConflict(error), true, `${state.label}, ${door}: release A's isTaskRunClaimConflict`);
          assert.equal(deploy1IsExecutionClaimConflict(error), true, `${state.label}, ${door}: deploy 1's isExecutionClaimConflict`);
          assert.equal(deploy1IsTaskRunClaimConflict(error), true, `${state.label}, ${door}: deploy 1's isTaskRunClaimConflict`);
        }
        const live = (await sql.query(
          `SELECT count(*)::int AS n FROM session WHERE task_id = $1::uuid AND finished_at IS NULL`, [busy],
        )).rows[0] as { n: number };
        assert.equal(live.n, 1, `${state.label}: the task still has exactly one live run`);

        // A released run does not block the task's next one.
        await run(db, me, free, true);
        await run(db, me, free, true);
        await run(db, me, free);
        const next = (await sql.query(
          `SELECT count(*) FILTER (WHERE finished_at IS NULL)::int AS live, count(*)::int AS runs
             FROM session WHERE task_id = $1::uuid`, [free],
        )).rows[0] as { live: number; runs: number };
        assert.deepEqual(next, { live: 1, runs: 3 }, `${state.label}: released runs do not hold the claim`);
      }
    } finally {
      const now = (await claimIndexes(sql)).map((i) => i.name);
      if (!now.includes(OLD_INDEX)) await sql.query(OLD_DEF);
      if (!now.includes(NEW_INDEX)) await sql.query(NEW_DEF);
    }
    console.log(report.map((line) => `# ${line}`).join('\n'));
    assert.match(report[0], new RegExp(`index ${OLD_INDEX}$`), 'with both, as in production, PostgreSQL names 0130\'s');
  });

  await t.test('(4) under session_release_fact_chk the two indexes refuse and admit the same rows, PARKED aside', async () => {
    const labels = ((await sql.query(`SELECT unnest(enum_range(NULL::run_status))::text AS l`)).rows as Array<{ l: string }>)
      .map((r) => r.l);
    const outcome = async (only: string, label: string, released: boolean): Promise<string> => {
      const drop = only === NEW_INDEX ? OLD_INDEX : NEW_INDEX;
      await sql.query('BEGIN');
      try {
        await sql.query(`DROP INDEX "${drop}"`);
        const [taskId] = (await sql.query(
          `INSERT INTO task (id, title, owner_id, creator_type, creator_id, updated_at, completion_criterion)
           VALUES (gen_random_uuid(), 'shape', $1::uuid, 'USER', $1::uuid, now(), (enum_range(NULL::task_completion_criterion))[1])
           RETURNING id::text AS id`, [me],
        )).rows as Array<{ id: string }>;
        await sql.query(
          `INSERT INTO session (id, title, prompt, owner_id, creator_id, updated_at, task_id, turn_state)
           VALUES (gen_random_uuid(), 'holder', 'p', $1::uuid, $1::uuid, now(), $2::uuid, 'IN_FLIGHT')`, [me, taskId.id],
        );
        await sql.query('SAVEPOINT shape');
        try {
          await sql.query(
            `INSERT INTO session (id, title, prompt, owner_id, creator_id, updated_at, task_id, turn_state, finished_at)
             VALUES (gen_random_uuid(), 'shape', 'p', $1::uuid, $1::uuid, now(), $2::uuid, (CASE ($3)::text WHEN 'PENDING' THEN 'QUEUED' WHEN 'RUNNING' THEN 'IN_FLIGHT' WHEN 'INTERRUPTED' THEN 'ABANDONED' END), $4)`,
            [me, taskId.id, label, released ? new Date() : null],
          );
          return 'admitted';
        } catch (error) {
          const e = error as { code?: string; constraint?: string };
          if (e.code === '23505') return `refused by the claim (${e.constraint === only ? 'the index present' : e.constraint})`;
          return `refused by ${e.constraint ?? e.code}`;
        }
      } finally {
        await sql.query('ROLLBACK');
      }
    };
    const rows: string[] = [];
    for (const label of labels) {
      for (const released of [false, true]) {
        const oldAlone = await outcome(OLD_INDEX, label, released);
        const newAlone = await outcome(NEW_INDEX, label, released);
        rows.push(`${label.padEnd(15)} finished_at ${released ? 'set ' : 'NULL'} | old index alone: ${oldAlone} | new index alone: ${newAlone}`);
        const checkAdmits = !oldAlone.startsWith('refused by session_release_fact_chk');
        assert.equal(checkAdmits, !newAlone.startsWith('refused by session_release_fact_chk'), `${label}: the CHECK decides alike`);
        if (label === 'PARKED' && !released) {
          assert.deepEqual([oldAlone, newAlone], ['admitted', 'refused by the claim (the index present)'],
            'PARKED, unreleased: the one row the CHECK admits that only the new index counts as live');
        } else {
          assert.equal(oldAlone, newAlone, `${label}, finished_at ${released ? 'set' : 'NULL'}: the same answer`);
        }
      }
    }
    console.log(rows.map((line) => `# ${line}`).join('\n'));
    assert.equal(rows.filter((line) => /old index alone: refused by the claim/.test(line)).length, 4,
      'each of the four held statuses, unreleased, is a live run under both');
  });

  await t.test('(5) EXPLAIN on a large table: the readers that state the new predicate keep an index after release B', async () => {
    // A table shaped as production's: ten released runs a task, a live run on one task in twenty, a turn each.
    const big = await owner(sql, 'claim-index-explain');
    const ids = await tasks(sql, big, 10_000);
    await sql.query(
      `INSERT INTO session (id, title, prompt, owner_id, creator_id, updated_at, task_id, turn_state, finished_at, starts_task_work)
       SELECT gen_random_uuid(), 'released run', 'p', $1::uuid, $1::uuid, now(), t::uuid, NULL,
              now() - interval '1 day', true
         FROM unnest($2::text[]) t, generate_series(1, 10)`, [big, ids],
    );
    await sql.query(
      `INSERT INTO session (id, title, prompt, owner_id, creator_id, updated_at, task_id, turn_state, starts_task_work)
       SELECT gen_random_uuid(), 'live run', 'p', $1::uuid, $1::uuid, now(), t::uuid,
              CASE WHEN n % 2 = 0 THEN 'IN_FLIGHT' END, true
         FROM unnest($2::text[]) WITH ORDINALITY AS u(t, n) WHERE n % 20 = 0`, [big, ids],
    );
    await sql.query(
      `INSERT INTO conversation_turn (id, session_id, seq, client_turn_id, kind, status)
       SELECT gen_random_uuid(), s.id, 1, 'explain-' || s.id, 'message',
              CASE WHEN s.finished_at IS NULL THEN 'IN_FLIGHT' ELSE 'COMPLETED' END
         FROM session s WHERE s.owner_id = $1::uuid`, [big],
    );
    await sql.query(
      `INSERT INTO conversation_turn (id, session_id, seq, client_turn_id, kind, status)
       SELECT gen_random_uuid(), s.id, 2, 'explain2-' || s.id, 'message', 'PENDING'
         FROM session s WHERE s.owner_id = $1::uuid AND s.finished_at IS NULL`, [big],
    );
    // A released run's history: the turns it answered before it ended, as production's runs carry several each. With
    // one turn a session the whole turn table is small enough that a scan of it competes with the held sessions' index
    // probes, and the plan flips between the two on ANALYZE's sample (task T7 measured both on this table).
    await sql.query(
      `INSERT INTO conversation_turn (id, session_id, seq, client_turn_id, kind, status)
       SELECT gen_random_uuid(), s.id, g, 'explain-history-' || g || '-' || s.id, 'message', 'COMPLETED'
         FROM session s, generate_series(3, 7) g WHERE s.owner_id = $1::uuid AND s.finished_at IS NOT NULL`, [big],
    );
    await sql.query('ANALYZE session; ANALYZE conversation_turn; ANALYZE task');
    const sizes = (await sql.query(
      `SELECT (SELECT count(*) FROM session)::int AS sessions,
              (SELECT count(*) FROM session WHERE finished_at IS NULL)::int AS held,
              (SELECT count(*) FROM conversation_turn)::int AS turns`,
    )).rows[0];
    console.log(`# table: ${JSON.stringify(sizes)}`);
    // A task with a live run (every twentieth has one).
    const busy = ids[19];

    // The statements, as the code sends them: captured from a Prisma client that logs every query.
    const captured: Array<{ query: string; params: string }> = [];
    const logged = new PrismaClient({ adapter: pgAdapterFor(url), log: [{ emit: 'event', level: 'query' }] });
    (logged as unknown as { $on: (event: 'query', cb: (e: { query: string; params: string }) => void) => void })
      .$on('query', (e) => captured.push({ query: e.query, params: e.params }));
    const capture = async (work: () => Promise<unknown>): Promise<Array<{ query: string; params: string }>> => {
      const from = captured.length;
      await work();
      return captured.slice(from);
    };
    const pause = new DispatchPauseService(
      logged as unknown as PrismaService,
      { notifySessionQueued: () => undefined } as never,
      { notifyInbox: () => undefined, notifyRunnerWake: () => undefined } as never,
    );
    const holderSelect = { id: true, ...WORD_SELECT, workspaceId: true } as const;
    type Statement = { query: string; params: string };
    const one = (list: Statement[], pick: (s: Statement) => boolean, what: string): Statement => {
      const found = list.filter(pick);
      assert.equal(found.length, 1, `${what}: one statement captured (${list.map((s) => s.query).join(' ;; ')})`);
      return found[0];
    };
    const readers: Array<{ name: string; claim: boolean; before: Statement; after: Statement }> = [];
    try {
      // (a) the carrier (sessionCarriesTaskSql through readTaskWorkCarriers), before and after: 1426's
      // `finished_at IS NULL` is the line this change adds.
      const carrierAfter = one(await capture(() => readTaskWorkCarriers(
        logged as unknown as PrismaService, Prisma.sql`carrier."task_id" = ${busy}::uuid`,
      )), (s) => s.query.includes('carrier'), 'carrier');
      assert.match(carrierAfter.query, /carrier\."finished_at" IS NULL\n/);
      readers.push({
        name: 'carrier (sessionCarriesTaskSql)', claim: true,
        before: { ...carrierAfter, query: carrierAfter.query.replace(/\n\s*AND carrier\."finished_at" IS NULL/, '') },
        after: carrierAfter,
      });
      // (b) sessions.service routeOntoTheHeldClaim and (c) tasks.service createTaskSessionOrReadWinner: the holder,
      // read by the where each states, before (TASK_OCCUPYING) and after (heldFilter).
      for (const [name, not] of [['holder, sessions.service routeOntoTheHeldClaim', true], ['holder, tasks.service createTaskSessionOrReadWinner', false]] as const) {
        const where = (status: Prisma.SessionWhereInput): Prisma.SessionWhereInput => ({
          taskId: busy, deletedAt: null, ...status, ...(not ? { NOT: { id: randomUUID() } } : {}),
        });
        const pick = (s: Statement) => /FROM "public"\."session"/.test(s.query);
        readers.push({
          name, claim: true,
          before: one(await capture(() => logged.session.findFirst({
            where: where({ finishedAt: null }), select: holderSelect,
          })), pick, `${name} before`),
          after: one(await capture(() => logged.session.findFirst({
            where: where(heldFilter()), select: holderSelect,
          })), pick, `${name} after`),
        });
      }
      // (d), (e) the dispatch pause's two reads of held sessions, as DispatchPauseService sends them.
      const paused = await capture(() => pause.read());
      const woken = await capture(() => (pause as unknown as { wake: () => Promise<void> }).wake());
      for (const [name, list, turn] of [
        ['dispatch pause, read (turns IN_FLIGHT)', paused, `'IN_FLIGHT'`],
        ['dispatch pause, wake (turns PENDING)', woken, `'PENDING'`],
      ] as const) {
        const after = one(list, (s) => s.query.includes(`t."status" = ${turn}`), name);
        // The release column alone (task T7 of docs/session-status-retirement-plan.md): no held statuses beside it.
        assert.match(after.query, /WHERE s\."finished_at" IS NULL\s/);
        assert.doesNotMatch(after.query, /s\."status"/);
        readers.push({
          name, claim: false, after,
          before: { ...after, query: after.query.replace(/WHERE s\."finished_at" IS NULL/, `WHERE s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')`) },
        });
      }
    } finally {
      await logged.$disconnect().catch(() => undefined);
    }

    const plan = async (statement: Statement, drop: string | null): Promise<string> => {
      await sql.query('BEGIN');
      try {
        if (drop) await sql.query(`DROP INDEX "${drop}"`);
        const rows = (await sql.query(`EXPLAIN (COSTS OFF) ${statement.query}`, JSON.parse(statement.params) as unknown[]))
          .rows as Array<{ 'QUERY PLAN': string }>;
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      } finally {
        await sql.query('ROLLBACK');
      }
    };
    const indexesIn = (text: string): string[] =>
      [...text.matchAll(/(?:Index Scan|Index Only Scan|Bitmap Index Scan)(?: Backward)? (?:using|on) (\S+)/g)].map((m) => m[1]);
    const states = [['old index alone (deploy 1)', NEW_INDEX], ['both (release A)', null], ['new index alone (release B)', OLD_INDEX]] as const;
    const table: string[] = [];
    for (const reader of readers) {
      for (const [stateName, drop] of states) {
        for (const form of ['before', 'after'] as const) {
          const text = await plan(reader[form], drop);
          const used = indexesIn(text);
          const seq = /Seq Scan on (session|conversation_turn)\b/.exec(text)?.[0] ?? null;
          table.push(`${reader.name} | ${stateName} | ${form}: ${used.join(', ') || '(no index)'}${seq ? ` | ${seq}` : ''}`);
          console.log(`# ── ${reader.name} | ${stateName} | ${form}\n${text.split('\n').map((l) => `#   ${l}`).join('\n')}`);
          if (reader.claim && form === 'after' && drop === OLD_INDEX) {
            assert.ok(used.includes(NEW_INDEX), `${reader.name}: after release B it is planned through ${NEW_INDEX}`);
          }
          if (reader.claim && form === 'before' && drop === OLD_INDEX) {
            assert.ok(!used.includes(NEW_INDEX), `${reader.name}: the old predicate cannot use ${NEW_INDEX}`);
          }
          if (reader.claim && form === 'after' && drop === null) {
            assert.ok(used.includes(NEW_INDEX) || used.includes(OLD_INDEX), `${reader.name}: with both, a claim index`);
          }
          if (!reader.claim && form === 'after') {
            assert.equal(seq, null, `${reader.name}: no sequential scan of session or its turns`);
            // A partial index on the held rows (migrations 1628, 1633) is the entry now, as session_status_idx was.
            assert.ok(used.some((name) => HELD_PARTIAL_INDEXES.includes(name)), `${reader.name}: entered through a held partial index (${used.join(', ')})`);
          }
        }
      }
    }
    console.log(`# summary\n${table.map((line) => `#   ${line}`).join('\n')}`);
  });
});
