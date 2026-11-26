/**
 * DEPLOY 3 ON A DATABASE AT DEPLOY 2'S STATE: 1441 BACKFILLS THE TURN OUTCOME, 1442 DROPS THE TRIGGERS' STATUS BRIDGE,
 * 1443 DROPS release_cause, AND NO STORED ROW CHANGES ITS ANSWER BUT THE TWO NAMED ONES.
 *
 * docs/session-three-state-design.md §12.6, removal steps R6, R7 and R8 (decision D9). Against PostgreSQL, through the
 * real `prisma migrate deploy`:
 *
 *   (1) the database is put back to deploy 2's state, the way an installation got there: 1261, 1403 and 1404 (the
 *       column release_cause and its validated CHECK) and 1425 (the ended-triggers with the status bridge) are applied
 *       again by prisma; pg_depend lists the CHECK as the column's only dependent
 *   (2) it is populated before deploy 3 runs: a session of every release row shape of design §12.2
 *       (common/session-release-shapes.fixture.ts), with the cause deploy 1 wrote where it wrote one, and turns as their
 *       writers leave them, among them a refused source's PENDING turn (H4), a lost runner's turn still IN_FLIGHT, a
 *       non-work turn ahead of the work turn, a failed import with a message queued during it (in Trash), open
 *       requests to bridged rows with and without a retry armed; the production pre-check
 *       (PRECHECK below) is run on it and answers what it should
 *   (3) 1441, 1442 and 1443 are applied by prisma: every row's last_turn_outcome is what the fixture's `backfilled`
 *       says, the carrying turn and no other got FAILED and the session's error, the failure question (without the
 *       bridge) answers as deploy 2's reading (with it) did before on every row but W5 and A2, the column and its CHECK
 *       are gone, no trigger names a terminal status, and the post-check (POSTCHECK)
 *       answers zero where the criterion asks for zero
 *   (4) applied a second time, the three write nothing
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/common/session-release-backfill.pg.spec.ts
 *
 * Not destructive to anything but this disposable database's schema state, which it leaves as every migration does:
 * every id is freshly generated. The pre- and post-check counts are over the whole database, which (3) reads as this
 * spec's rows alone: run it, as run-pg-spec.sh does, on a database of its own.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import { PrismaClient, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { releaseWasFailure, releaseWasFailureSql } from './session-release';
import { backfilled, RELEASE_SHAPES, type ReleaseShape } from './session-release-shapes.fixture';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const API = join(__dirname, '..', '..');
const DEPLOY_2_STATE = [
  '1261_session_release_cause', '1403_session_release_failure_causes', '1404_session_release_failure_causes_validate',
  '1425_ended_triggers_read_release',
];
const DEPLOY_3 = [
  '1441_session_turn_outcome_backfill', '1442_ended_triggers_drop_status_bridge', '1443_session_release_cause_drop',
];

/**
 * The read-only checks run around that deploy, on the database as it was then: it still has session.status, which both
 * read, so they live here with the migrations they check rather than under scripts/, where nothing reads the column
 * (docs/session-status-retirement-plan.md §2.6). A "bridged" row is one 1441 writes: released, FAILED, no end reason,
 * no FAILED turn outcome, not in Trash.
 */
const PRECHECK = `
WITH bridged AS (
  SELECT s."id", s."release_cause", s."finished_at", s."retry_at"
    FROM "session" s
   WHERE s."finished_at" IS NOT NULL AND s."end_reason" IS NULL AND s."status"::text = 'FAILED'
     AND s."last_turn_outcome" IS DISTINCT FROM 'FAILED' AND s."deleted_at" IS NULL
), a2 AS (
  SELECT s."id"
    FROM "session" s
   WHERE s."finished_at" IS NOT NULL AND s."end_reason" IS NULL AND s."status"::text <> 'FAILED'
     AND s."last_turn_outcome" = 'FAILED'
), trashed AS (
  SELECT s."id", s."import_source_cwd"
    FROM "session" s
   WHERE s."finished_at" IS NOT NULL AND s."end_reason" IS NULL AND s."status"::text = 'FAILED'
     AND s."last_turn_outcome" IS DISTINCT FROM 'FAILED' AND s."deleted_at" IS NOT NULL
)
SELECT
  (SELECT count(*) FROM bridged) AS bridged_rows,
  (SELECT json_object_agg(COALESCE(cause, 'null'), n) FROM (
     SELECT "release_cause" AS cause, count(*) AS n FROM bridged GROUP BY "release_cause") c) AS bridged_by_cause,
  (SELECT count(*) FROM bridged WHERE "finished_at" >= TIMESTAMP '2026-11-22 04:09:45') AS bridged_since_deploy2,
  (SELECT count(*) FROM bridged b WHERE NOT EXISTS (
     SELECT 1 FROM "conversation_turn" t WHERE t."session_id" = b."id" AND t."outcome" = 'FAILED'))
    AS bridged_without_failed_turn,
  (SELECT count(*) FROM bridged b WHERE EXISTS (
     SELECT 1 FROM "conversation_turn" t
      WHERE t."session_id" = b."id" AND t."outcome" IS NULL
        AND t."id" = (SELECT c."id" FROM "conversation_turn" c
                       WHERE c."session_id" = b."id" AND c."kind" IN ('message', 'shell')
                         AND c."status" IN ('IN_FLIGHT', 'PENDING')
                       ORDER BY (c."status" = 'IN_FLIGHT') DESC, c."seq" ASC LIMIT 1))) AS carrying_turns,
  (SELECT count(*) FROM a2) AS residual_a2_rows,
  (SELECT count(*) FROM "session" s
    WHERE s."finished_at" IS NOT NULL AND s."end_reason" IS NOT NULL AND s."status"::text <> 'FAILED'
      AND s."last_turn_outcome" = 'FAILED') AS stale_copy_rows,
  (SELECT count(*) FROM trashed) AS trashed_unbridged,
  (SELECT count(*) FROM trashed WHERE "import_source_cwd" IS NOT NULL) AS failed_imports,
  (SELECT count(*) FROM "session_request" r JOIN bridged b ON b."id" = r."to_session_id"
    WHERE r."state" = 'OPEN' AND b."retry_at" IS NULL) AS requests_closed_by_backfill,
  (SELECT count(*) FROM "session_request" r JOIN bridged b ON b."id" = r."from_session_id"
    WHERE r."state" <> 'OPEN' AND r."reply_client_turn_id" IS NULL AND r."reply_held_at" IS NOT NULL
      AND r."reply_comment_due_at" IS NULL) AS replies_due_by_backfill,
  (SELECT count(*) FROM "task_owner_confirmation_review" v JOIN a2 ON a2."id" = v."reviewer_session_id"
    WHERE v."reviewer_ended_at" IS NULL) AS reviews_ended_by_backfill,
  (SELECT count(*) FROM "session"
    WHERE "release_cause" IS NOT NULL AND "finished_at" >= TIMESTAMP '2026-11-22 04:09:45') AS causes_after_deploy2,
  (SELECT max("finished_at") FROM "session" WHERE "release_cause" IS NOT NULL) AS latest_cause_release,
  (SELECT count(*) FROM "pg_depend" d
     JOIN "pg_attribute" a ON a."attrelid" = d."refobjid" AND a."attnum" = d."refobjsubid"
    WHERE d."refclassid" = 'pg_class'::regclass AND d."refobjid" = '"session"'::regclass
      AND a."attname" = 'release_cause'
      AND NOT (d."classid" = 'pg_constraint'::regclass
               AND d."objid" = (SELECT "oid" FROM "pg_constraint"
                                 WHERE "conrelid" = '"session"'::regclass
                                   AND "conname" = 'session_release_cause_chk'))) AS other_dependents,
  (SELECT "convalidated" FROM "pg_constraint"
    WHERE "conrelid" = '"session"'::regclass AND "conname" = 'session_release_cause_chk') AS release_cause_chk_valid;
`;

const POSTCHECK = `
SELECT
  (SELECT count(*) FROM "information_schema"."columns"
    WHERE "table_name" = 'session' AND "column_name" = 'release_cause') AS release_cause_columns,
  (SELECT count(*) FROM "pg_constraint"
    WHERE "conname" LIKE '%release_cause%' OR pg_get_constraintdef("oid") LIKE '%release_cause%')
    AS release_cause_constraints,
  (SELECT count(*) FROM "session"
    WHERE "finished_at" IS NOT NULL AND "end_reason" IS NULL AND "status"::text = 'FAILED'
      AND "last_turn_outcome" IS DISTINCT FROM 'FAILED' AND "deleted_at" IS NULL) AS failed_without_failed_outcome,
  (SELECT count(*) FROM "session"
    WHERE "finished_at" IS NOT NULL AND "end_reason" IS NULL AND "status"::text = 'FAILED'
      AND "last_turn_outcome" IS DISTINCT FROM 'FAILED' AND "deleted_at" IS NOT NULL) AS trashed_without_failed_outcome,
  (SELECT count(*) FROM "session"
    WHERE "finished_at" IS NOT NULL AND "end_reason" IS NULL AND "status"::text <> 'FAILED'
      AND "last_turn_outcome" = 'FAILED') AS residual_a2_rows,
  (SELECT count(*) FROM "pg_trigger"
    WHERE "tgrelid" = '"session"'::regclass AND NOT "tgisinternal"
      AND pg_get_triggerdef("oid") ~ '''(SUCCEEDED|FAILED|CANCELLED)''::run_status') AS terminal_status_triggers;
`;

/** Deploy 2's failure question, as 1425 and the release module spelled it: with the status bridge. */
const DEPLOY_2_FAILED = `(s."finished_at" IS NOT NULL AND s."end_reason" IS NULL
  AND (s."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED' OR s."status" = 'FAILED'))`;

/** The cause deploy 1 (or 1262) wrote for a shape, where one was written; deploy 2 writes none. */
const CAUSE: Record<string, string> = {
  H2: 'runner_lost', H4: 'setup_failed', H6: 'engine_failed', 'B1 completed': 'completed', 'B1 task_done': 'task_done',
  'B1 engine': 'engine_exited', B2: 'cancelled', B3: 'engine_exited', B6: 'cancelled', B7: 'landing_settled',
};

/** See session-release.pg.spec.ts deployAgain: forget the rows, then let prisma find the files pending and apply them. */
async function deployAgain(sql: Client, url: string, migrations: string[]): Promise<void> {
  await sql.query(`DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])`, [migrations]);
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: API, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: 'pipe',
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    assert.fail(`prisma migrate deploy of ${migrations.join(', ')} failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
  const applied = (await sql.query(
    `SELECT count(*)::int AS n FROM _prisma_migrations
      WHERE migration_name = ANY($1::text[]) AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    [migrations],
  )).rows[0] as { n: number };
  assert.equal(applied.n, migrations.length, 'prisma recorded every one of them applied');
}

interface World { ownerId: string; runnerId: string; workspaceId: string }

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@release-backfill.invalid`, name: label, passwordHash: 'x' } });
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

/** A turn as its writer leaves it. */
interface Turn { kind: 'message' | 'shell' | 'end'; status: 'ANSWERED' | 'PENDING' | 'IN_FLIGHT'; outcome: string | null }

/** A session row of the table: a shape of the fixture, and the turns and extras this spec gives it. */
interface Row {
  label: string;
  shape: ReleaseShape;
  turns: Turn[];
  /** The index in `turns` of the turn 1441 writes, or null for none. */
  carrying: number | null;
  error?: string;
  retryArmed?: boolean;
  openRequest?: boolean;
}

const answered = (outcome: string | null = 'ANSWERED'): Turn => ({ kind: 'message', status: 'ANSWERED', outcome });

function rowsOf(): Row[] {
  const byName = (name: string) => RELEASE_SHAPES.find((shape) => shape.name === name)!;
  const rows: Row[] = RELEASE_SHAPES.map((shape) => ({
    label: shape.name, shape, turns: shape.lastTurnOutcome ? [answered(shape.lastTurnOutcome)] : [], carrying: null,
  }));
  const set = (label: string, patch: Partial<Row>) => Object.assign(rows.find((row) => row.label === label)!, patch);
  // H2: a deploy-1 reaper's drain answered every turn with no outcome: no turn for 1441 to write.
  set('H2', { turns: [answered(), answered(null)], error: 'runner offline', openRequest: true });
  // H4: a deploy-1 refused source leaves the dispatched turn PENDING, behind an `end` turn that is no work turn.
  set('H4', { turns: [answered(), { kind: 'end', status: 'PENDING', outcome: null },
    { kind: 'message', status: 'PENDING', outcome: null }], carrying: 2, error: 'SOURCE_REFUSED: no such ref' });
  // H6: a deploy-1 finalize, the engine failed with nothing but an old turn behind it.
  set('H6', { turns: [answered(null)], error: 'engine crashed' });
  // W5: a failed import with a message queued during it, in Trash: 1441 writes neither the session nor the turn.
  set('W5', { turns: [{ kind: 'message', status: 'PENDING', outcome: null }], error: 'transcript holds no conversation' });
  rows.push(
    // A lost runner whose turn is still IN_FLIGHT, with an older work turn PENDING: the IN_FLIGHT one carries it.
    { label: 'H2 in flight', shape: byName('H2'), error: 'runner offline',
      turns: [answered(), { kind: 'message', status: 'PENDING', outcome: null },
        { kind: 'shell', status: 'IN_FLIGHT', outcome: null }], carrying: 2 },
    // The same as H2 with a retry armed and an open request to it: it waits for the retry, before and after.
    { label: 'H2 retry armed', shape: byName('H2'), error: 'runner offline', turns: [answered(null)], carrying: null,
      retryArmed: true, openRequest: true },
  );
  return rows;
}

test('deploy 3 on a populated database at deploy 2\'s state: 1441, 1442 and 1443 by the real prisma migrate deploy', {
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
  const sessionIds = new Map<string, string>();
  const turnIds = new Map<string, string[]>();
  const requestIds = new Map<string, string>();
  const rows = rowsOf();
  const deploy2 = new Map<string, boolean>();
  const columnExists = async () => (await sql.query(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'session' AND column_name = 'release_cause'`,
  )).rows[0].n as number;
  const endedTriggers = async () => (await sql.query(
    `SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'session'::regclass
        AND tgname IN ('session_request_recipient_ended', 'session_request_asker_stopped',
                       'task_owner_confirmation_review_reviewer_ended') ORDER BY tgname`,
  )).rows as Array<{ tgname: string; def: string }>;

  await t.test('(1) back to deploy 2\'s state: the column, its validated CHECK, the bridged triggers', async () => {
    await deployAgain(sql, url, DEPLOY_2_STATE);
    assert.equal(await columnExists(), 1, 'release_cause is there again');
    const check = (await sql.query(
      `SELECT convalidated FROM pg_constraint WHERE conrelid = 'session'::regclass AND conname = 'session_release_cause_chk'`,
    )).rows;
    assert.deepEqual(check, [{ convalidated: true }]);
    for (const { tgname, def } of await endedTriggers()) {
      assert.match(def, /new\.status = 'FAILED'::run_status/, `${tgname}: deploy 2's clause, with the bridge`);
    }
    const dependents = (await sql.query(
      `SELECT pg_describe_object(d.classid, d.objid, d.objsubid) AS object, d.deptype
         FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
        WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = 'session'::regclass AND a.attname = 'release_cause'
        ORDER BY 1, 2`,
    )).rows as Array<{ object: string; deptype: string }>;
    console.log(`# pg_depend on session.release_cause: ${JSON.stringify(dependents)}`);
    assert.ok(dependents.length > 0, 'the CHECK depends on it');
    for (const d of dependents) {
      assert.equal(d.object, 'constraint session_release_cause_chk on table session', 'nothing but the CHECK');
    }
  });

  await t.test('(2) populated before deploy 3: every shape, its turns, open requests; the pre-check answers', async () => {
    const w = await world(db, 'backfill');
    const asker = randomUUID();
    await db.session.create({ data: {
      id: asker, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 'asker', prompt: 'ask',
      status: 'AWAITING_INPUT', provider: 'claude', providerBuiltin: true, engine: 'claude', assignedRunnerId: w.runnerId,
    } });
    for (const row of rows) {
      const { shape } = row;
      const id = randomUUID();
      sessionIds.set(row.label, id);
      const landing = shape.sessionKind === 'LANDING';
      await db.session.create({
        data: {
          id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: row.label, prompt: shape.what,
          status: shape.status,
          ...(landing
            ? { sessionKind: 'LANDING', provider: 'orbit', providerBuiltin: true, engine: null, startsTaskWork: false }
            : { provider: 'claude', providerBuiltin: true, engine: 'claude', assignedRunnerId: w.runnerId }),
          finishedAt: shape.released ? new Date() : null,
          endReason: shape.endReason,
          ...(shape.endReason ? { cancelRequestedAt: new Date() } : {}),
          lastTurnOutcome: shape.lastTurnOutcome,
          error: row.error ?? null,
          ...(row.retryArmed ? { retryAt: new Date(Date.now() + 3_600_000) } : {}),
          ...(shape.trashed ? { deletedAt: new Date(), importSourceCwd: '/home/someone/project' } : {}),
        },
      });
      // The cause column is not in this build's model: deploy 1 (or 1262) wrote it beside the status.
      if (CAUSE[row.label] || CAUSE[shape.name]) {
        await sql.query(`UPDATE "session" SET "release_cause" = $2 WHERE "id" = $1::uuid`,
          [id, CAUSE[row.label] ?? CAUSE[shape.name]]);
      }
      const ids: string[] = [];
      for (const [i, turn] of row.turns.entries()) {
        const turnId = randomUUID();
        ids.push(turnId);
        await sql.query(
          `INSERT INTO "conversation_turn" ("id", "session_id", "seq", "client_turn_id", "kind", "content", "status", "outcome")
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'a message', $6, $7)`,
          [turnId, id, i + 1, `turn-${turnId}`, turn.kind, turn.status, turn.outcome]);
      }
      turnIds.set(row.label, ids);
      if (row.openRequest) {
        const requestId = randomUUID();
        requestIds.set(row.label, requestId);
        await sql.query(
          `INSERT INTO "session_request" ("id", "owner_id", "from_session_id", "to_session_id", "turn_id", "client_turn_id",
                  "request_preview", "reply_by")
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'a question', now() + interval '1 hour')`,
          [requestId, w.ownerId, asker, id, randomUUID(), `turn-${requestId}`]);
      }
    }
    const answers = (await sql.query(
      `SELECT s."id", ${DEPLOY_2_FAILED} AS failed FROM "session" s WHERE s."id" = ANY($1::uuid[])`,
      [[...sessionIds.values()]])).rows as Array<{ id: string; failed: boolean }>;
    for (const row of rows) deploy2.set(row.label, answers.find((a) => a.id === sessionIds.get(row.label))!.failed);

    const pre = (await sql.query(PRECHECK)).rows[0] as Record<string, unknown>;
    console.log(`# pre-check: ${JSON.stringify(pre)}`);
    // The bridged rows: released FAILED, no end reason, no FAILED outcome, outside Trash.
    const bridged = rows.filter(({ shape }) => shape.released && shape.status === 'FAILED' && shape.endReason === null
      && shape.lastTurnOutcome !== 'FAILED' && !shape.trashed);
    assert.deepEqual(bridged.map((row) => row.label).sort(),
      ['H2', 'H2 in flight', 'H2 retry armed', 'H4', 'H6', 'W7 no reason'].sort());
    assert.equal(Number(pre.bridged_rows), bridged.length);
    assert.deepEqual(pre.bridged_by_cause, { runner_lost: 3, setup_failed: 1, engine_failed: 1, null: 1 });
    assert.equal(Number(pre.bridged_since_deploy2), bridged.length, 'all written now, after 2026-11-22 04:09:45');
    assert.equal(Number(pre.bridged_without_failed_turn), bridged.length);
    assert.equal(Number(pre.carrying_turns), 2, 'H4\'s PENDING turn, and the lost runner\'s IN_FLIGHT one');
    assert.equal(Number(pre.residual_a2_rows), 1, 'A2');
    assert.equal(Number(pre.stale_copy_rows), 1, 'N2');
    assert.equal(Number(pre.trashed_unbridged), 1, 'W5');
    assert.equal(Number(pre.failed_imports), 1, 'W5 is an import');
    assert.equal(Number(pre.requests_closed_by_backfill), 1, 'the open request to H2, which has no retry armed');
    assert.equal(Number(pre.replies_due_by_backfill), 0);
    assert.equal(Number(pre.reviews_ended_by_backfill), 0);
    assert.equal(Number(pre.causes_after_deploy2), Object.keys(CAUSE).length + 2, 'this spec wrote causes just now');
    assert.equal(Number(pre.other_dependents), 0);
    assert.equal(pre.release_cause_chk_valid, true);
  });

  await t.test('(3) 1441, 1442, 1443: the backfill, the failure question without the bridge, the column gone', async () => {
    const turnsBefore = (await sql.query(
      `SELECT "id", "status", "outcome", "error" FROM "conversation_turn" WHERE "session_id" = ANY($1::uuid[])`,
      [[...sessionIds.values()]])).rows as Array<{ id: string; status: string; outcome: string | null; error: string | null }>;

    await deployAgain(sql, url, DEPLOY_3);

    const after = (await sql.query(
      `SELECT s."id", s."status"::text AS status, s."finished_at", s."end_reason", s."last_turn_outcome", s."error",
              ${releaseWasFailureSql('s').sql} AS failed
         FROM "session" s WHERE s."id" = ANY($1::uuid[])`,
      [[...sessionIds.values()]])).rows as Array<{ id: string; status: string; finished_at: Date | null;
      end_reason: string | null; last_turn_outcome: string | null; error: string | null; failed: boolean }>;
    const differences: string[] = [];
    for (const row of rows) {
      const stored = after.find((r) => r.id === sessionIds.get(row.label))!;
      const expected = backfilled(row.shape).lastTurnOutcome;
      console.log(`# ${row.label} | last_turn_outcome ${row.shape.lastTurnOutcome} -> ${stored.last_turn_outcome}`
        + ` | failed: deploy 2 ${deploy2.get(row.label)}, deploy 3 ${stored.failed}`);
      assert.equal(stored.last_turn_outcome, expected, `${row.label}: what the fixture's backfilled says`);
      assert.equal(stored.status, row.shape.status, `${row.label}: the status is not written`);
      assert.equal(stored.failed, releaseWasFailure({
        finishedAt: stored.finished_at, endReason: stored.end_reason, lastTurnOutcome: stored.last_turn_outcome,
        status: stored.status,
      }), `${row.label}: the SQL and the predicate agree`);
      if (stored.failed !== deploy2.get(row.label)) differences.push(row.label);
      // The turns: the carrying one got FAILED and the session's error; every other one is as it was.
      for (const [i, turnId] of turnIds.get(row.label)!.entries()) {
        const turn = (await sql.query(`SELECT "status", "outcome", "error" FROM "conversation_turn" WHERE "id" = $1::uuid`,
          [turnId])).rows[0] as { status: string; outcome: string | null; error: string | null };
        const was = turnsBefore.find((b) => b.id === turnId)!;
        if (i === row.carrying) {
          assert.deepEqual(turn, { status: was.status, outcome: 'FAILED', error: row.error ?? null },
            `${row.label}: turn ${i + 1} carries the failure, and keeps its place in the queue`);
        } else {
          assert.deepEqual(turn, { status: was.status, outcome: was.outcome, error: was.error },
            `${row.label}: turn ${i + 1} is not written`);
        }
      }
    }
    assert.deepEqual(differences, ['W5', 'A2'],
      'the failure question answers as deploy 2 did on every stored row but W5 (in Trash) and A2 (ruled a stop)');

    // The ended-triggers fired for the write that named last_turn_outcome where their clause says: the open request
    // to H2 (no retry armed) is closed, the one to the H2 with a retry armed still waits.
    const state = async (label: string) => (await sql.query(
      `SELECT "state", "close_reason" FROM "session_request" WHERE "id" = $1::uuid`, [requestIds.get(label)])).rows[0];
    assert.deepEqual(await state('H2'), { state: 'RECIPIENT_ENDED', close_reason: 'FAILED' });
    assert.deepEqual(await state('H2 retry armed'), { state: 'OPEN', close_reason: null });

    assert.equal(await columnExists(), 0, 'release_cause is gone');

    // What main's 1428_open_list_workspace_probes replaced, open_list_bump_owner(), is called by no UPDATE trigger of the
    // two tables 1441 writes; their Open-list UPDATE triggers are statement-level, so each UPDATE fired one once, not per
    // row. (conversation_turn_evidence_review_deadline, per row, is AFTER INSERT only: 1441 inserts nothing.)
    const openList = (await sql.query(
      `SELECT c.relname AS tbl, t.tgname, p.proname, (t.tgtype & 1) = 1 AS per_row
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND c.relname IN ('session', 'conversation_turn') AND p.proname LIKE 'open_list%'
          AND (t.tgtype & 16) <> 0
        ORDER BY 1, 2`)).rows as Array<{ tbl: string; tgname: string; proname: string; per_row: boolean }>;
    console.log(`# open-list UPDATE triggers on the tables 1441 writes: ${JSON.stringify(openList)}`);
    assert.ok(openList.some((r) => r.tbl === 'session') && openList.some((r) => r.tbl === 'conversation_turn'));
    for (const r of openList) {
      assert.notEqual(r.proname, 'open_list_bump_owner', `${r.tbl}.${r.tgname}: not the function main's 1428 replaced`);
      assert.equal(r.per_row, false, `${r.tbl}.${r.tgname}: statement-level`);
    }
    for (const { tgname, def } of await endedTriggers()) {
      console.log(`# ${tgname}: ${def}`);
      assert.doesNotMatch(def, /'(SUCCEEDED|FAILED|CANCELLED)'::run_status/, `${tgname}: no terminal status`);
    }
    const post = (await sql.query(POSTCHECK)).rows[0] as Record<string, unknown>;
    console.log(`# post-check: ${JSON.stringify(post)}`);
    assert.deepEqual(Object.fromEntries(Object.entries(post).map(([k, v]) => [k, Number(v)])), {
      release_cause_columns: 0, release_cause_constraints: 0, failed_without_failed_outcome: 0,
      trashed_without_failed_outcome: 1, residual_a2_rows: 0, terminal_status_triggers: 0,
    });
  });

  await t.test('(4) applied a second time, deploy 3\'s migrations write nothing', async () => {
    const snapshot = async () => (await sql.query(`
      SELECT s."id", s."last_turn_outcome", s."status"::text AS status,
             (SELECT json_agg(json_build_object('id', t."id", 'status', t."status", 'outcome', t."outcome", 'error', t."error")
                       ORDER BY t."seq") FROM "conversation_turn" t WHERE t."session_id" = s."id") AS turns
        FROM "session" s WHERE s."id" = ANY($1::uuid[]) ORDER BY s."id"`, [[...sessionIds.values()]])).rows;
    const before = await snapshot();
    await deployAgain(sql, url, DEPLOY_3);
    assert.deepEqual(await snapshot(), before);
  });
});
