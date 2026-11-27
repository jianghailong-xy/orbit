/**
 * THE SESSION TRIGGERS AND FUNCTIONS ON THE FACTS (migration 1641; docs/session-status-retirement-plan.md §2.8, §4.2,
 * task T6). Every object 1641 restates, held to the definition it replaces on the same rows:
 *
 *   (1) each restated body is the one in force before 1641 (its latest migration) with exactly the replacements below,
 *       and each restated WHEN clause is 1442's with exactly its replacements: nothing else moved, nothing reverted
 *   (2) session_held_turn_state reads the turn state of a held row and NULL of a released one, whatever stored word
 *       is beside it (migration 1671 took the stored-word fallback out of it, task T14)
 *   (3) the five engine guards: the same claims, revives and lease writes go through, are skipped or are refused
 *   (4) open_list_bump_owner: the same workspace probes bump the same scope
 *   (5) session_listed_at_on_settle: the same writes move listed_at, but for the one kind the migration names
 *   (6) session_request_recipient_ended: the same requests close, with the same close_reason but for the released
 *       kinds of plan §3.4, which read the projector's word
 *   (7) session_request_asker_stopped and (8) task_owner_confirmation_review_reviewer_ended: the same writes fire
 *   (9) task_supersession_live_session_guard: the same retirements are refused, with the same words in the error
 *
 * Each of (3)-(9) runs its statements twice on the same rows, in a transaction rolled back after each run: once with
 * the definitions before 1641 installed (read from their migrations), once as migrated, and compares what each run
 * left. Every row is written with both spellings; since 1671 (deploy D3) the stored word is the trigger's, from the
 * facts, so the definitions before 1641, which read it, see what those after read. The rows with no turn_state
 * beside a word that names a turn, and the writes of the word alone, are gone with the NULL fallback (task T14).
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-triggers-read-facts.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { legacySessionStatus } from './session-legacy-words';
import { WORD_SHAPES } from './session-legacy-words.fixture';
import { restoreStatusColumn } from '../test-support/session-d3-database';

const URL = process.env.COORDINATOR_PG_URL;

/** A held word's turn state, as SQL. */
const TURN_SQL: Record<string, string> = { PENDING: `'QUEUED'`, RUNNING: `'IN_FLIGHT'`, INTERRUPTED: `'ABANDONED'`, AWAITING_INPUT: 'NULL' };
const skip = !URL;

const THIS_MIGRATION = '1641_session_triggers_read_facts';
const MIGRATIONS = path.resolve(__dirname, '../..', 'prisma/migrations');

/** What 1641 replaced in each function body, as pg_get_functiondef prints it. */
const CLAIM: [string, string] = [
  `OLD."status" = 'PENDING' AND NEW."status" = 'RUNNING'`,
  `session_held_turn_state(OLD) = 'QUEUED' AND session_held_turn_state(NEW) = 'IN_FLIGHT'`,
];
const CLAIM_SPLIT: Array<[string, string]> = [
  [`OLD."status" = 'PENDING'\n`, `session_held_turn_state(OLD) = 'QUEUED'\n`],
  [`NEW."status" = 'RUNNING'\n`, `session_held_turn_state(NEW) = 'IN_FLIGHT'\n`],
];
const REVIVE: [string, string] = [`AND NEW."status" = 'PENDING'`, `AND session_held_turn_state(NEW) = 'QUEUED'`];
const FUNCTION_REPLACEMENTS: Record<string, Array<[string, string]>> = {
  guard_session_engine_acquisition: [CLAIM, REVIVE],
  guard_opencode_runner_claim: CLAIM_SPLIT,
  guard_antigravity_runner_claim: CLAIM_SPLIT,
  guard_cursor_runner_acquisition: [CLAIM, REVIVE],
  guard_dsh_runner_acquisition: [CLAIM, REVIVE],
  open_list_bump_owner: [[`s.status = 'PENDING'`, `session_held_turn_state(s) = 'QUEUED'`]],
  session_listed_at_on_settle: [[
    `  IF (NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED'))`,
    `  IF (NEW."finished_at" IS NOT NULL AND OLD."finished_at" IS NULL)
     OR (NEW."finished_at" IS NOT NULL AND OLD."finished_at" IS NOT NULL
         AND NEW."finished_at" IS DISTINCT FROM OLD."finished_at"
         AND session_legacy_status(OLD."finished_at", NULL, OLD."end_reason", OLD."last_turn_outcome", OLD."started_at",
                                   OLD."import_source_cwd", OLD."kind", NULL, NULL) <> 'FAILED')`,
  ]],
  session_request_recipient_ended: [[
    `             ELSE NEW."status"::text`,
    `             ELSE session_legacy_status(NEW."finished_at", session_held_turn_state(NEW), NEW."end_reason",
                    NEW."last_turn_outcome", NEW."started_at", NEW."import_source_cwd", NEW."kind",
                    CASE WHEN NEW."kind" = 'LANDING' THEN
                      (SELECT pl."settled_as" FROM "project_landing" pl WHERE pl."session_id" = NEW."id") END,
                    NULL)`,
  ]],
  task_supersession_live_session_guard: [[
    `  SELECT s."id", s."status"::text INTO live_id, live_status`,
    `  SELECT s."id", session_legacy_status(s."finished_at", session_held_turn_state(s), s."end_reason", s."last_turn_outcome",
                                       s."started_at", s."import_source_cwd", s."kind", NULL, NULL)
    INTO live_id, live_status`,
  ]],
};

/** What 1641 replaced in the three WHEN clauses, as pg_get_triggerdef prints them. */
const INTERRUPTED: [string, string] = [
  `(new.status = 'INTERRUPTED'::run_status)`, `(session_held_turn_state(new.*) = 'ABANDONED'::text)`,
];
const PARKED: [string, string] = [
  `(new.status = 'AWAITING_INPUT'::run_status)`, `(new.finished_at IS NULL) AND (session_held_turn_state(new.*) IS NULL)`,
];
const TRIGGER_REPLACEMENTS: Record<string, Array<[string, string]>> = {
  session_request_recipient_ended: [INTERRUPTED],
  session_request_asker_stopped: [INTERRUPTED, PARKED],
  task_owner_confirmation_review_reviewer_ended: [INTERRUPTED],
};

function migrationsBeforeThis(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < THIS_MIGRATION)
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      try {
        return [{ name, sql: readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8') }];
      } catch {
        return [];
      }
    });
}

/** The CREATE OR REPLACE FUNCTION statement of the last migration before 1641 that (re)defines `name`. */
function functionBefore(name: string): { migration: string; statement: string } {
  let found: { migration: string; statement: string } | null = null;
  const head = new RegExp(`CREATE OR REPLACE FUNCTION\\s+(?:public\\.)?"?${name}"?\\s*\\(`, 'g');
  for (const { name: migration, sql } of migrationsBeforeThis()) {
    for (const match of sql.matchAll(head)) {
      const rest = sql.slice(match.index);
      const open = /\$([A-Za-z_]*)\$/.exec(rest)!;
      const close = rest.indexOf(open[0], open.index + open[0].length);
      const end = rest.indexOf(';', close + open[0].length);
      found = { migration, statement: rest.slice(0, end + 1) };
    }
  }
  assert.ok(found, `no migration before ${THIS_MIGRATION} defines ${name}`);
  return found;
}

/** 1442's DO block: the three ended-triggers as they stood before 1641. */
function triggersBefore(): string {
  const sql = readFileSync(path.join(MIGRATIONS, '1442_ended_triggers_drop_status_bridge', 'migration.sql'), 'utf8');
  return sql.slice(sql.indexOf('DO $$'));
}

/** Everything 1641 replaced, as it stood before it. */
function definitionsBefore(): string {
  return [...Object.keys(FUNCTION_REPLACEMENTS).map((name) => functionBefore(name).statement), triggersBefore()].join('\n');
}

const v4 = (): string => randomUUID();
const v5 = (): string => { const id = randomUUID(); return `${id.slice(0, 14)}5${id.slice(15)}`; };
const lit = (value: string | null): string => (value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`);

interface World { ownerId: string; runnerId: string; workspaceId: string }

test('the session triggers and functions read the facts and answer as before (1641)', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  // The column session.status was dropped in deploy D4 (migration 1711): this file rehearses deploys it
  // was part of, on the database deploy D3 left, as the D4 down script restores it.
  await restoreStatusColumn(sql);
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const w: World = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({ data: { id: w.ownerId, email: `t6-${w.ownerId}@triggers.invalid`, name: 't6', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: w.runnerId, ownerId: w.ownerId, name: 't6-runner', tokenHash: `hash-${w.runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: ['provider:cursor', 'provider:dsh'], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      minFreeDiskMb: 100,
    },
  });
  await db.workspace.create({ data: { id: w.workspaceId, ownerId: w.ownerId, runnerId: w.runnerId, name: 't6', enabled: true } });
  const project = await db.project.create({ data: { ownerId: w.ownerId, title: 't6 project' } });
  const codebase = await db.projectCodebase.create({
    data: {
      ownerId: w.ownerId, projectId: project.id, canonicalRepoUrl: `https://github.com/example/t6-${project.id}`,
      upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/main', refAuthority: 'REMOTE',
    },
  });

  /** A session row, inserted as a writer would leave it; `cols` are SQL expressions. Returns its id. */
  const insertSession = async (cols: Record<string, string>, id: string = randomUUID()): Promise<string> => {
    const all: Record<string, string> = {
      id: lit(id), owner_id: lit(w.ownerId), creator_id: lit(w.ownerId), title: `'t6'`, prompt: `'t6'`,
      updated_at: 'now()', workspace_id: lit(w.workspaceId), assigned_runner_id: lit(w.runnerId),
      provider: `'claude'`, provider_builtin: 'true', engine: `'claude'`, dispatch_origin: `'USER'`,
      started_at: `now() - interval '2 hours'`, listed_at: `'2000-01-01'`, ...cols,
    };
    await sql.query(`INSERT INTO "session" (${Object.keys(all).map((c) => `"${c}"`).join(', ')})
                     VALUES (${Object.values(all).join(', ')})`);
    return id;
  };
  /** A start state by its word: the word with its turn state, as every writer of deploy 2 left it. */
  const held = (word: string, extra: Record<string, string> = {}) => ({ status: `'${word}'`, turn_state: TURN_SQL[word], ...extra });
  const released = (word: string, extra: Record<string, string> = {}) => ({
    status: `'${word}'`, finished_at: `now() - interval '1 hour'`, ...extra,
  });
  /** One statement, its effect or its refusal, without aborting the run. */
  const attempt = async (statement: string, params: unknown[] = []): Promise<string> => {
    await sql.query('SAVEPOINT t6');
    try {
      const result = await sql.query(statement, params);
      await sql.query('RELEASE SAVEPOINT t6');
      return `rows ${result.rowCount}`;
    } catch (error) {
      await sql.query('ROLLBACK TO SAVEPOINT t6');
      const e = error as { code?: string; message?: string };
      return `refused ${e.code}: ${e.message}`;
    }
  };
  /** `run` once on the definitions before 1641 and once on 1641's, each in a transaction rolled back after it. */
  const beforeAndAfter = async <T>(run: () => Promise<T>): Promise<{ before: T; after: T }> => {
    await sql.query('BEGIN');
    let before: T;
    try {
      await sql.query(definitionsBefore());
      before = await run();
    } finally {
      await sql.query('ROLLBACK');
    }
    await sql.query('BEGIN');
    let after: T;
    try {
      after = await run();
    } finally {
      await sql.query('ROLLBACK');
    }
    return { before, after };
  };

  await t.test('(1) each restated body and WHEN clause is the one before it with only the word reads replaced', async () => {
    const functionDef = async (name: string) =>
      (await sql.query<{ def: string }>(`SELECT pg_get_functiondef($1::regproc) AS def`, [name])).rows[0].def;
    const triggerDef = async (name: string) =>
      (await sql.query<{ def: string }>(`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = $1`, [name])).rows[0].def;
    const now = {
      functions: Object.fromEntries(await Promise.all(Object.keys(FUNCTION_REPLACEMENTS).map(async (n) => [n, await functionDef(n)]))),
      triggers: Object.fromEntries(await Promise.all(Object.keys(TRIGGER_REPLACEMENTS).map(async (n) => [n, await triggerDef(n)]))),
    };
    await sql.query('BEGIN');
    try {
      await sql.query(definitionsBefore());
      for (const [name, replacements] of Object.entries(FUNCTION_REPLACEMENTS)) {
        let def = await functionDef(name);
        for (const [from, to] of replacements) {
          assert.ok(def.includes(from), `${name} (${functionBefore(name).migration}) has no ${JSON.stringify(from)}`);
          def = def.split(from).join(to);
        }
        assert.equal(now.functions[name], def, `${name}: 1641 changes more than the word reads`);
        assert.doesNotMatch(now.functions[name], /\b(new|old|s)\s*\.\s*"?status\b/i, `${name} still reads the word`);
      }
      for (const [name, replacements] of Object.entries(TRIGGER_REPLACEMENTS)) {
        let def = await triggerDef(name);
        for (const [from, to] of replacements) {
          assert.ok(def.includes(from), `${name} (1442) has no ${from}`);
          def = def.split(from).join(to);
        }
        // 1671 (task T14) added turn_state to the column list beside status (plan §4.2), and nothing else.
        def = def.replace('AFTER UPDATE OF status, ', 'AFTER UPDATE OF status, turn_state, ');
        assert.equal(now.triggers[name], def, `${name}: 1641 and 1671 change more than the word reads and the list`);
        // The column list still names the word (plan §4.2: it leaves with the column, T14 and T15).
        assert.match(now.triggers[name], /AFTER UPDATE OF status, /);
        assert.doesNotMatch(now.triggers[name].replace(/^.* WHEN /, ''), /\bstatus\b/, `${name}'s WHEN still reads the word`);
      }
    } finally {
      await sql.query('ROLLBACK');
    }
  });

  await t.test('(2) session_held_turn_state is a held row\'s turn state, whatever stored word is beside it', async () => {
    const rows = (await sql.query<{ status: string; finished: boolean; turn_state: string | null; held: string | null }>(`
      WITH words AS (SELECT unnest(enum_range(NULL::run_status)) AS status),
           combos AS (SELECT w.status, f.finished, ts.turn_state
                        FROM words w, (VALUES (false), (true)) f(finished),
                             (VALUES (NULL::text), ('QUEUED'), ('IN_FLIGHT'), ('ABANDONED')) ts(turn_state))
      SELECT c.status::text AS status, c.finished, c.turn_state,
             session_held_turn_state(jsonb_populate_record(NULL::"session", jsonb_build_object(
               'status', c.status, 'turn_state', c.turn_state,
               'finished_at', CASE WHEN c.finished THEN '2026-11-25T00:00:00' END))) AS held
        FROM combos c ORDER BY 1, 2, 3`)).rows;
    // Every word (PARKED among the type's labels) against every turn state, held and released: the word decides none.
    assert.equal(rows.length, 8 * 2 * 4);
    for (const row of rows) assert.equal(row.held, row.finished ? null : row.turn_state, JSON.stringify(row));
  });

  await t.test('(3) the five engine guards pass, skip and refuse the same writes', async () => {
    const ENGINES: Array<{ name: string; cols: Record<string, string> }> = [
      { name: 'claude with no engine recorded', cols: { engine: 'NULL' } },
      { name: 'claude', cols: {} },
      { name: 'opencode', cols: { engine: `'opencode'`, provider: `'opencode'` } },
      { name: 'antigravity', cols: { engine: `'antigravity'`, provider: `'antigravity'` } },
      { name: 'cursor', cols: { engine: `'cursor'`, provider: `'cursor'` } },
      { name: 'dsh', cols: { engine: `'dsh'`, provider: `'dsh'` } },
    ];
    const ALL_ON = ['claim_reads_session_engine', 'runner_supports_opencode', 'runner_supports_antigravity',
      'runner_supports_cursor', 'runner_supports_dsh'];
    const SETTINGS: Array<{ name: string; on: string[] }> = [
      { name: 'an API that predates engines', on: [] },
      { name: 'reads engines, no runtime declared', on: ['claim_reads_session_engine'] },
      { name: 'every runtime declared', on: ALL_ON },
    ];
    interface Move { name: string; start: Record<string, string>; set: string }
    const MOVES: Move[] = [
      { name: 'claim, both spellings', start: held('PENDING'), set: `"status" = 'RUNNING', "turn_state" = 'IN_FLIGHT'` },
      { name: 'enqueue on a parked session', start: held('AWAITING_INPUT'), set: `"status" = 'PENDING', "turn_state" = 'QUEUED'` },
      { name: 'turn end', start: held('RUNNING'), set: `"status" = 'AWAITING_INPUT', "turn_state" = NULL` },
      { name: 'a runner takes the lease', start: held('RUNNING'), set: `"inbox_lease_owner" = '${v4()}'` },
      { name: 'revive with a hand-off marker', start: released('CANCELLED', { end_reason: `'cancelled'` }),
        set: `"status" = 'PENDING', "turn_state" = 'QUEUED', "finished_at" = NULL, "end_reason" = NULL, "inbox_lease_owner" = '${v5()}'` },
      { name: 'revive with a runner lease', start: released('CANCELLED'),
        set: `"status" = 'PENDING', "turn_state" = 'QUEUED', "finished_at" = NULL, "inbox_lease_owner" = '${v4()}'` },
      { name: 'a parked row takes a hand-off marker', start: held('AWAITING_INPUT'), set: `"inbox_lease_owner" = '${v5()}'` },
    ];
    const cases = ENGINES.flatMap((engine) => SETTINGS.flatMap((setting) => MOVES.map((move) => ({
      name: `${engine.name} / ${setting.name} / ${move.name}`, engine, setting, move, id: randomUUID(),
    }))));
    const { before, after } = await beforeAndAfter(async () => {
      const seen: Record<string, string> = {};
      for (const c of cases) {
        await insertSession({ ...c.engine.cols, ...c.move.start }, c.id);
        for (const name of ALL_ON) {
          await sql.query(`SELECT set_config($1, $2, true)`, [`orbit.${name}`, c.setting.on.includes(name) ? '1' : '0']);
        }
        const outcome = await attempt(`UPDATE "session" SET ${c.move.set} WHERE "id" = $1::uuid`, [c.id]);
        const row = (await sql.query(`SELECT status::text AS status, turn_state, finished_at IS NOT NULL AS released,
                                             inbox_lease_owner::text AS lease FROM "session" WHERE id = $1::uuid`, [c.id])).rows[0];
        seen[c.name] = `${outcome.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')} -> ${JSON.stringify(row)}`;
      }
      return seen;
    });
    assert.deepEqual(after, before);
    // The guards decided something: a skip (0 rows) and a refusal are among the answers, and a claim went through.
    const answers = Object.values(after).join('\n');
    assert.match(answers, /^rows 0 /m);
    assert.match(answers, /^refused 55000/m);
    assert.match(answers, /^rows 1 -> \{"status":"RUNNING"/m);
    assert.equal(Object.keys(after).length, ENGINES.length * SETTINGS.length * MOVES.length);
  });

  await t.test('(4) open_list_bump_owner: the same workspace probes bump the workspace scope', async () => {
    const STARTS: Array<{ name: string; cols: Record<string, string> }> = [
      { name: 'queued, never started', cols: held('PENDING', { started_at: 'NULL' }) },
      { name: 'queued, started', cols: held('PENDING') },
      { name: 'parked, never started', cols: held('AWAITING_INPUT', { started_at: 'NULL' }) },
      { name: 'released, never started', cols: released('CANCELLED', { started_at: 'NULL' }) },
    ];
    const PROBES = [
      { name: 'free space falls below the floor', from: 500, to: 50 },
      { name: 'free space rises above the floor', from: 50, to: 500 },
      { name: 'free space moves above the floor', from: 500, to: 400 },
    ];
    const cases = STARTS.flatMap((start) => PROBES.map((probe) => ({
      name: `${start.name} / ${probe.name}`, start, probe, workspaceId: randomUUID(), sessionId: randomUUID(),
    })));
    const { before, after } = await beforeAndAfter(async () => {
      const seen: Record<string, number> = {};
      for (const c of cases) {
        await sql.query(`INSERT INTO "workspace" ("id", "owner_id", "runner_id", "name", "work_dir_free_bytes")
                         VALUES ($1::uuid, $2::uuid, $3::uuid, 'probe', $4::bigint * 1048576)`,
        [c.workspaceId, w.ownerId, w.runnerId, c.probe.from]);
        await insertSession({ ...c.start.cols, workspace_id: lit(c.workspaceId) }, c.sessionId);
        const epoch = async () => Number((await sql.query(`
          SELECT COALESCE(sum(e.epoch), 0) AS n FROM open_list_epoch e
           WHERE e.owner_id = $1::uuid AND starts_with(e.source, open_list_scope_key('workspace', $2::uuid, true))`,
        [w.ownerId, c.workspaceId])).rows[0].n);
        const was = await epoch();
        await sql.query(`UPDATE "workspace" SET "work_dir_free_bytes" = $2::bigint * 1048576 WHERE "id" = $1::uuid`,
          [c.workspaceId, c.probe.to]);
        seen[c.name] = (await epoch()) - was;
      }
      return seen;
    });
    assert.deepEqual(after, before);
    assert.equal(after['queued, never started / free space falls below the floor'], 1);
  });

  await t.test('(5) session_listed_at_on_settle moves listed_at on the same writes, but for a failed import over C1', async () => {
    const IMPORT_FAILED = `"status" = 'FAILED', "turn_state" = NULL, "error" = 'import failed', "deleted_at" = clock_timestamp(), "finished_at" = clock_timestamp()`;
    interface Write { name: string; start: Record<string, string>; set: string }
    const WRITES: Write[] = [
      { name: 'ended', start: held('RUNNING'), set: `"status" = 'CANCELLED', "turn_state" = NULL, "finished_at" = now(), "end_reason" = 'cancelled'` },
      { name: 'failed', start: held('RUNNING'), set: `"status" = 'FAILED', "turn_state" = NULL, "finished_at" = now(), "last_turn_outcome" = 'FAILED'` },
      { name: 'finished its task', start: held('PENDING'), set: `"status" = 'SUCCEEDED', "turn_state" = NULL, "finished_at" = now(), "end_reason" = 'task_done'` },
      { name: 'completed', start: released('CANCELLED', { end_reason: `'cancelled'` }), set: `"completed_at" = now()` },
      { name: 'revived', start: released('CANCELLED', { end_reason: `'cancelled'` }), set: `"status" = 'PENDING', "turn_state" = 'QUEUED', "finished_at" = NULL, "end_reason" = NULL` },
      { name: 'parked', start: held('RUNNING'), set: `"status" = 'AWAITING_INPUT', "turn_state" = NULL` },
      { name: 'a released row ended again (the word kept)', start: released('CANCELLED', { end_reason: `'cancelled'` }), set: `"status" = 'CANCELLED', "end_reason" = 'cancelled'` },
      { name: 'an import fails while it runs', start: held('RUNNING', { import_source_cwd: `'/home/someone/project'` }), set: IMPORT_FAILED },
      { name: 'an import fails over an ended row', start: released('CANCELLED', { end_reason: `'cancelled'`, import_source_cwd: `'/p'` }), set: IMPORT_FAILED },
      { name: 'an import fails over a finished row', start: released('SUCCEEDED', { end_reason: `'task_done'`, import_source_cwd: `'/p'` }), set: IMPORT_FAILED },
      { name: 'an import fails over a failed row', start: released('FAILED', { last_turn_outcome: `'FAILED'`, import_source_cwd: `'/p'` }), set: IMPORT_FAILED },
      { name: 'an import fails over a failed import', start: released('FAILED', { import_source_cwd: `'/p'` }), set: IMPORT_FAILED },
      { name: 'an import fails over C1 (FAILED, an end not honoured)', start: released('FAILED', { end_reason: `'cancelled'`, import_source_cwd: `'/p'` }), set: IMPORT_FAILED },
    ];
    const cases = WRITES.map((write) => ({ ...write, id: randomUUID() }));
    const { before, after } = await beforeAndAfter(async () => {
      const seen: Record<string, boolean> = {};
      for (const c of cases) {
        await insertSession(c.start, c.id);
        await sql.query(`UPDATE "session" SET ${c.set} WHERE "id" = $1::uuid`, [c.id]);
        seen[c.name] = (await sql.query(`SELECT listed_at > '2000-01-01' AS moved FROM "session" WHERE id = $1::uuid`, [c.id])).rows[0].moved;
      }
      return seen;
    });
    // A failed import over a released row with an end recorded: since 1671 (deploy D3) the stored word is the facts',
    // which the import's FAILED does not move (P2 needs no end), so the definitions before 1641, which read the word,
    // see no move there. 1641's, which read the release, move listed_at for every row that did not read FAILED: the
    // ended and the finished row, and the kind 1641 named (plan §3.4 C1), stored FAILED until D3.
    const OVER_AN_END = ['an import fails over an ended row', 'an import fails over a finished row',
      'an import fails over C1 (FAILED, an end not honoured)'];
    const rest = (answers: Record<string, boolean>) =>
      Object.fromEntries(Object.entries(answers).filter(([name]) => !OVER_AN_END.includes(name)));
    assert.deepEqual(rest(after), rest(before));
    assert.deepEqual(OVER_AN_END.map((name) => after[name]), [true, true, true]);
    assert.equal(after['an import fails over an ended row'], true);
    assert.equal(after['an import fails over a failed row'], false);
  });

  await t.test('(6) session_request_recipient_ended closes the same requests, with the projector\'s word', async () => {
    interface Shape { name: string; kind: string; start: Record<string, string>; set: string;
      projected: string | null; stored: string; settledAs: string | null }
    const at = `'2026-11-21T00:00:00'`;
    const shapes: Shape[] = WORD_SHAPES.map((shape) => {
      const f = shape.facts;
      const set = [
        `"status" = '${shape.stored}'`, `"turn_state" = ${lit(f.turnState)}`, `"finished_at" = ${f.finishedAt ? at : 'NULL'}`,
        `"end_reason" = ${lit(f.endReason)}`, `"last_turn_outcome" = ${lit(f.lastTurnOutcome)}`,
        `"started_at" = ${f.startedAt ? at : 'NULL'}`, `"import_source_cwd" = ${lit(f.importSourceCwd)}`,
      ].join(', ');
      return {
        name: shape.name, kind: f.sessionKind, start: held('RUNNING', { kind: `'${f.sessionKind}'` }), set,
        projected: legacySessionStatus(f, shape.landing), stored: shape.stored, settledAs: shape.landing?.settledAs ?? null,
      };
    });
    // A held row reaches the word only when INTERRUPTED with an end.
    shapes.push(
      { name: 'interrupted, then ended', kind: 'CONVERSATION', start: held('INTERRUPTED'), set: `"end_reason" = 'cancelled'`,
        projected: 'INTERRUPTED', stored: 'INTERRUPTED', settledAs: null },
      { name: 'trashed', kind: 'CONVERSATION', start: held('RUNNING'), set: `"deleted_at" = now()`, projected: null, stored: 'RUNNING', settledAs: null },
      { name: 'completed', kind: 'CONVERSATION', start: released('CANCELLED'), set: `"completed_at" = now()`, projected: null, stored: 'CANCELLED', settledAs: null },
    );
    const cases = shapes.map((shape) => ({ ...shape, id: randomUUID(), asker: randomUUID(), request: randomUUID(), task: randomUUID() }));
    const { before, after } = await beforeAndAfter(async () => {
      const seen: Record<string, string> = {};
      for (const c of cases) {
        const landing = c.kind === 'LANDING';
        await insertSession(held('AWAITING_INPUT'), c.asker);
        await insertSession(landing
          ? { ...c.start, provider: `'orbit'`, engine: 'NULL', starts_task_work: 'false', workspace_id: 'NULL', assigned_runner_id: 'NULL' }
          : c.start, c.id);
        if (landing && c.settledAs) {
          await sql.query(`INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id", "updated_at",
                                               "completion_criterion", "project_id")
                           VALUES ($1::uuid, 'landed', $2::uuid, 'USER', $2::uuid, now(), 'EVIDENCE_JUDGMENT', $3::uuid)`,
          [c.task, w.ownerId, project.id]);
          await sql.query(`INSERT INTO "project_landing" ("id", "project_id", "owner_id", "codebase_id", "subject", "task_id",
                                                          "session_id", "settled_at", "settled_as")
                           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'TASK', $4::uuid, $5::uuid, now(), $6)`,
          [project.id, w.ownerId, codebase.id, c.task, c.id, c.settledAs]);
        }
        await sql.query(`INSERT INTO "session_request" ("id", "owner_id", "from_session_id", "to_session_id", "turn_id",
                                                        "client_turn_id", "request_preview", "reply_by")
                         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, gen_random_uuid(), $1::text, 'a question',
                                 now() + interval '1 hour')`, [c.request, w.ownerId, c.asker, c.id]);
        await sql.query(`UPDATE "session" SET ${c.set} WHERE "id" = $1::uuid`, [c.id]);
        const row = (await sql.query(`SELECT state, close_reason FROM "session_request" WHERE id = $1::uuid`, [c.request])).rows[0];
        seen[c.name] = `${row.state} ${row.close_reason}`;
      }
      return seen;
    });
    // Equal but for the rows whose projected word is not the stored one (plan §3.4), each now with the projected word.
    const expected = { ...before };
    const changed: string[] = [];
    for (const c of cases) {
      if (c.projected === null || c.projected === c.stored || !before[c.name].startsWith('RECIPIENT_ENDED ')) continue;
      expected[c.name] = before[c.name].replace(`RECIPIENT_ENDED ${c.stored}`, `RECIPIENT_ENDED ${c.projected}`);
      changed.push(`${c.name}: ${c.stored} -> ${c.projected}`);
    }
    assert.deepEqual(after, expected);
    console.log(`# close_reason changes (plan §3.4):\n# ${changed.join('\n# ')}`);
    assert.ok(changed.length > 0, 'the §3.4 kinds are among the shapes');
  });

  await t.test('(7) session_request_asker_stopped fires on the same writes', async () => {
    interface Write { name: string; start: Record<string, string>; set: string }
    const armed = { retry_at: `now() + interval '1 hour'` };
    const WRITES: Write[] = [
      { name: 'parked, its retry disarmed', start: held('AWAITING_INPUT', armed), set: `"retry_at" = NULL` },
      { name: 'queued, its retry disarmed', start: held('PENDING', armed), set: `"retry_at" = NULL` },
      { name: 'parked, its claimed retry given up', start: held('AWAITING_INPUT', { retry_attempts: '1', retry_claimed_at: 'now()' }), set: `"retry_attempts" = 0, "retry_claimed_at" = NULL` },
      { name: 'parked by a turn end, its retry disarmed', start: held('RUNNING', armed), set: `"status" = 'AWAITING_INPUT', "turn_state" = NULL, "retry_at" = NULL` },
      { name: 'interrupted, then ended', start: held('INTERRUPTED'), set: `"end_reason" = 'cancelled'` },
      { name: 'ended', start: held('RUNNING'), set: `"status" = 'CANCELLED', "turn_state" = NULL, "finished_at" = now(), "end_reason" = 'cancelled'` },
      { name: 'failed with a retry armed', start: held('RUNNING'), set: `"status" = 'FAILED', "turn_state" = NULL, "finished_at" = now(), "last_turn_outcome" = 'FAILED', "retry_at" = now() + interval '1 hour'` },
    ];
    const cases = WRITES.map((write) => ({ ...write, id: randomUUID(), peer: randomUUID(), request: randomUUID() }));
    const { before, after } = await beforeAndAfter(async () => {
      const seen: Record<string, boolean> = {};
      for (const c of cases) {
        await insertSession(c.start, c.id);
        await insertSession(held('AWAITING_INPUT'), c.peer);
        // A reply the asker holds: answered, its comment not yet due.
        await sql.query(`INSERT INTO "session_request" ("id", "owner_id", "from_session_id", "to_session_id", "turn_id",
                                                        "client_turn_id", "request_preview", "reply_by", "state", "closed_at",
                                                        "reply_held_at")
                         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, gen_random_uuid(), $1::text, 'a question',
                                 now() + interval '1 hour', 'NO_REPLY', now(), now())`, [c.request, w.ownerId, c.id, c.peer]);
        await sql.query(`UPDATE "session" SET ${c.set} WHERE "id" = $1::uuid`, [c.id]);
        seen[c.name] = (await sql.query(`SELECT reply_comment_due_at IS NOT NULL AS due FROM "session_request" WHERE id = $1::uuid`, [c.request])).rows[0].due;
      }
      return seen;
    });
    assert.deepEqual(after, before);
    assert.equal(after['parked, its retry disarmed'], true);
    assert.equal(after['interrupted, then ended'], true);
  });

  await t.test('(8) task_owner_confirmation_review_reviewer_ended fires on the same writes', async () => {
    interface Write { name: string; start: Record<string, string>; set: string }
    const WRITES: Write[] = [
      { name: 'interrupted, then ended', start: held('INTERRUPTED'), set: `"end_reason" = 'cancelled'` },
      { name: 'parked, then ended', start: held('AWAITING_INPUT'), set: `"end_reason" = 'cancelled'` },
      { name: 'interrupted by the runner', start: held('RUNNING'), set: `"status" = 'INTERRUPTED', "turn_state" = 'ABANDONED', "end_reason" = 'cancelled'` },
      { name: 'ended', start: held('RUNNING'), set: `"status" = 'CANCELLED', "turn_state" = NULL, "finished_at" = now(), "end_reason" = 'cancelled'` },
      { name: 'failed', start: held('RUNNING'), set: `"status" = 'FAILED', "turn_state" = NULL, "finished_at" = now(), "last_turn_outcome" = 'FAILED'` },
    ];
    const cases = WRITES.map((write) => ({ ...write, id: randomUUID(), asker: randomUUID(), task: randomUUID(), request: randomUUID(), review: randomUUID() }));
    const { before, after } = await beforeAndAfter(async () => {
      const seen: Record<string, boolean> = {};
      for (const c of cases) {
        await insertSession(c.start, c.id);
        await insertSession(held('AWAITING_INPUT'), c.asker);
        await sql.query(`INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id", "updated_at", "completion_criterion")
                         VALUES ($1::uuid, 'reviewed', $2::uuid, 'USER', $2::uuid, now(), 'EVIDENCE_JUDGMENT')`, [c.task, w.ownerId]);
        await sql.query(`INSERT INTO "task_owner_confirmation_request" ("id", "task_id", "owner_id", "session_id", "turn_id")
                         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, gen_random_uuid())`, [c.request, c.task, w.ownerId, c.asker]);
        await sql.query(`INSERT INTO "task_owner_confirmation_review" ("id", "request_id", "task_id", "owner_id", "reviewer_kind",
                                                                       "window_seconds", "due_at", "reviewer_session_id")
                         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'TASK_CREATOR', 3600, now() + interval '1 hour', $5::uuid)`,
        [c.review, c.request, c.task, w.ownerId, c.id]);
        await sql.query(`UPDATE "session" SET ${c.set} WHERE "id" = $1::uuid`, [c.id]);
        seen[c.name] = (await sql.query(`SELECT reviewer_ended_at IS NOT NULL AS ended FROM "task_owner_confirmation_review" WHERE id = $1::uuid`, [c.review])).rows[0].ended;
      }
      return seen;
    });
    assert.deepEqual(after, before);
    assert.equal(after['interrupted, then ended'], true);
  });

  await t.test('(9) task_supersession_live_session_guard refuses the same retirements, naming the same word', async () => {
    const STARTS: Array<{ name: string; cols: Record<string, string> }> = [
      ...['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'].flatMap((word) => [
        { name: word, cols: held(word) },
      ]),
      { name: 'released', cols: released('CANCELLED', { end_reason: `'cancelled'` }) },
    ];
    const cases = STARTS.map((start) => ({ ...start, id: randomUUID(), task: randomUUID() }));
    const { before, after } = await beforeAndAfter(async () => {
      const seen: Record<string, string> = {};
      for (const c of cases) {
        await sql.query(`INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id", "updated_at", "completion_criterion")
                         VALUES ($1::uuid, 'retired', $2::uuid, 'USER', $2::uuid, now(), 'EVIDENCE_JUDGMENT')`, [c.task, w.ownerId]);
        await insertSession({ ...c.cols, task_id: lit(c.task), starts_task_work: 'true' }, c.id);
        seen[c.name] = (await attempt(`UPDATE "task" SET "status" = 'CANCELLED', "terminal_reason" = 'ABANDONED' WHERE "id" = $1::uuid`, [c.task]))
          .split(c.id).join('<session>').split(c.task).join('<task>');
      }
      return seen;
    });
    assert.deepEqual(after, before);
    assert.match(after.RUNNING, /TASK_RETIRED_WHILE_RUNNING: .*\(<session> is RUNNING\)/);
    assert.equal(after.released, 'rows 1');
  });
});
