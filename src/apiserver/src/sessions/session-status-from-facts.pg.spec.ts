/**
 * DEPLOY D3 OF THE session.status RETIREMENT: THE STORED WORD FOLLOWS THE FACTS (migration 1671;
 * docs/session-status-retirement-plan.md §4.1 and §4.3, task T14). Against PostgreSQL:
 *
 *   (1) the catalog as 1671 leaves it: session_aa_status_from_facts first of the BEFORE triggers, on INSERT and on an
 *       UPDATE of each fact the word is made from (and not of `status`); 1611's trigger and its function gone;
 *       session_held_turn_state reading no stored word; the column lists T6 left as they were (comment
 *       353j9PXw1D2Npfm9ZT4Hm) carrying turn_state, and session_listed_at_settle finished_at
 *   (2) INSERT: a session of every row shape of session-legacy-words.fixture.ts, written as its facts (no word), stores
 *       the word the projector gives those facts, a LANDING container's settlement included (written first, as both
 *       of its writers write it, projects/landing-session.ts)
 *   (3) UPDATE: from every one of those shapes, every write a writer makes, each naming only the facts (a turn queued,
 *       claimed, parked, abandoned; a release by a failure, with no cause, by an end, by a finished task; a revive; an
 *       end asked; a turn outcome recorded; an import's marker cleared): the stored word is the projector's after each
 *   (4) a deploy-2 replica's writes during the hand-over, which name both spellings: the word follows the facts,
 *       the §3.4 kinds included (an end not honoured stores CANCELLED, not FAILED); its INSERT likewise; and a stray
 *       write of the word alone names no fact, so the trigger does not undo it: session_turn_state_agrees_chk refuses
 *       it, and the row is left as it was
 *   (5) the column lists fire on writes that name turn_state alone: an engine row's claim is skipped by its guard, and
 *       taken under the declaration; an abandoned turn with an end closes the requests sent to the session; and a
 *       release that names finished_at alone moves listed_at
 *
 * The product's writers name only the facts: sessions/session-status-column.spec.ts refuses any write of the column in
 * product code, and the field is not in the Prisma model. The PG specs of those writers read the word through the
 * projector; projects/landing-session.pg.spec.ts and queue/claim-slot-turn-state.pg.spec.ts also read what this
 * trigger stored, after the landing writers and the claim.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-status-from-facts.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { legacySessionStatus, type LandingSettlement, type LegacyStatusFacts } from './session-legacy-words';
import { WORD_SHAPES, type WordShape } from './session-legacy-words.fixture';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const FACT_COLUMNS = ['turn_state', 'finished_at', 'end_reason', 'last_turn_outcome', 'started_at', 'import_source_cwd', 'kind'];

/** A SQL literal of a JS value. */
const lit = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return `'${value.toISOString()}'::timestamptz`;
  return `'${String(value).replace(/'/g, "''")}'`;
};

interface Row {
  status: string;
  finished_at: Date | null;
  turn_state: string | null;
  end_reason: string | null;
  last_turn_outcome: string | null;
  started_at: Date | null;
  import_source_cwd: string | null;
  kind: string;
  settled_as: string | null;
  settled_at: Date | null;
}

/** A write a writer makes, as the columns it names. Applies to the rows `when` admits. */
interface Write {
  name: string;
  when: (row: Row) => boolean;
  set: string;
}

const held = (row: Row) => row.finished_at === null;
const released = (row: Row) => row.finished_at !== null;

const WRITES: Write[] = [
  { name: 'a turn queued', when: held, set: `"turn_state" = 'QUEUED'` },
  { name: 'claimed', when: held, set: `"turn_state" = 'IN_FLIGHT'` },
  { name: 'parked', when: held, set: `"turn_state" = NULL` },
  { name: 'the runner stopped under it', when: held, set: `"turn_state" = 'ABANDONED', "last_turn_outcome" = 'INTERRUPTED'` },
  { name: 'an end asked', when: held, set: `"end_reason" = 'cancelled'` },
  { name: 'a turn outcome recorded', when: held, set: `"last_turn_outcome" = 'FAILED'` },
  { name: 'released by a failure', when: held, set: `"turn_state" = NULL, "finished_at" = now(), "last_turn_outcome" = 'FAILED'` },
  { name: 'released with no cause', when: held, set: `"turn_state" = NULL, "finished_at" = now(), "last_turn_outcome" = 'CANCELLED'` },
  { name: 'released by an end', when: held, set: `"turn_state" = NULL, "finished_at" = now(), "end_reason" = 'ended'` },
  { name: 'released by an end not honoured', when: held, set: `"turn_state" = NULL, "finished_at" = now(), "end_reason" = 'cancelled', "last_turn_outcome" = 'FAILED'` },
  { name: 'its task done', when: held, set: `"turn_state" = NULL, "finished_at" = now(), "end_reason" = 'task_done'` },
  { name: 'its task done before it started', when: held, set: `"turn_state" = NULL, "finished_at" = now(), "end_reason" = 'task_done', "started_at" = NULL` },
  { name: 'an import failed', when: held, set: `"turn_state" = NULL, "finished_at" = now(), "import_source_cwd" = '/home/someone/project'` },
  { name: 'revived', when: released, set: `"turn_state" = 'QUEUED', "finished_at" = NULL, "end_reason" = NULL` },
  { name: 'released again by a failed import', when: released, set: `"finished_at" = now(), "import_source_cwd" = '/p'` },
  { name: 'a released turn outcome rewritten', when: released, set: `"last_turn_outcome" = 'FAILED'` },
  { name: 'an end reason recorded late', when: released, set: `"end_reason" = 'completed'` },
  { name: 'an import marker cleared', when: () => true, set: `"import_source_cwd" = NULL` },
];

test('D3: the stored word follows the facts, for rollback only (1671)', { skip, concurrency: 1, timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  t.after(() => sql.end().catch(() => undefined));
  // Every row here has no engine, so the engine guards pass every claim (0414's rule) but the one (5) asks about.

  const owner = randomUUID();
  await sql.query(`INSERT INTO "user" ("id", "email", "name") VALUES ($1, $2, 'd3')`, [owner, `d3-${owner}@status-from-facts.invalid`]);
  const project = randomUUID();
  await sql.query(`INSERT INTO "project" ("id", "owner_id", "title", "updated_at") VALUES ($1, $2, 'd3', now())`, [project, owner]);
  const codebase = randomUUID();
  await sql.query(
    `INSERT INTO "project_codebase" ("id", "owner_id", "project_id", "canonical_repo_url", "upstream_ref", "integration_ref",
                                     "ref_authority", "updated_at")
     VALUES ($1, $2, $3, $4, 'refs/heads/main', 'refs/heads/main', 'REMOTE', now())`,
    [codebase, owner, project, `https://github.com/example/d3-${codebase}`]);

  const read = async (id: string): Promise<Row> => (await sql.query<Row>(
    `SELECT s."status"::text AS status, s."finished_at", s."turn_state", s."end_reason", s."last_turn_outcome",
            s."started_at", s."import_source_cwd", s."kind", l."settled_as", l."settled_at"
       FROM "session" s LEFT JOIN "project_landing" l ON l."session_id" = s."id" WHERE s."id" = $1::uuid`, [id])).rows[0];
  /** The projector's word over the row's facts and its landing: what the stored word must be. */
  const projected = (row: Row): string => {
    const facts: LegacyStatusFacts = {
      finishedAt: row.finished_at, turnState: row.turn_state, endReason: row.end_reason,
      lastTurnOutcome: row.last_turn_outcome, startedAt: row.started_at, importSourceCwd: row.import_source_cwd,
      sessionKind: row.kind,
    };
    const landing: LandingSettlement | null = row.settled_as === null ? null : { settledAt: row.settled_at, settledAs: row.settled_as };
    return legacySessionStatus(facts, landing);
  };

  /** A session of `shape`, written as its facts: a landing's row first, then the container, as its writers write. */
  const insertShape = async (shape: WordShape): Promise<string> => {
    const id = randomUUID();
    const f = shape.facts;
    if (shape.landing) {
      const task = randomUUID();
      await sql.query(`INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id", "updated_at", "completion_criterion", "project_id")
                       VALUES ($1, 'landed', $2, 'USER', $2, now(), 'EVIDENCE_JUDGMENT', $3)`, [task, owner, project]);
      await sql.query(
        `INSERT INTO "project_landing" ("id", "project_id", "owner_id", "codebase_id", "subject", "task_id", "session_id",
                                        "settled_at", "settled_as")
         VALUES (gen_random_uuid(), $1, $2, $3, 'TASK', $4, $5, now(), $6)`,
        [project, owner, codebase, task, id, shape.landing.settledAs]);
    }
    await sql.query(`INSERT INTO "session" ("id", "owner_id", "creator_id", "title", "prompt", "provider", "provider_builtin",
                       "dispatch_origin", "updated_at", "turn_state", "finished_at", "end_reason", "last_turn_outcome",
                       "started_at", "import_source_cwd", "kind")
                     VALUES ($1, $2, $2, $3, 'd3', $4, true, 'USER', now(), ${lit(f.turnState)}, ${lit(f.finishedAt)},
                       ${lit(f.endReason)}, ${lit(f.lastTurnOutcome)}, ${lit(f.startedAt)}, ${lit(f.importSourceCwd)}, ${lit(f.sessionKind)})`,
    [id, owner, shape.name, f.sessionKind === 'LANDING' ? 'orbit' : 'claude']);
    return id;
  };

  await t.test('(1) the catalog: the word\'s trigger on the facts, D1\'s gone, the column lists extended', async () => {
    const triggers = (await sql.query<{ tgname: string; def: string }>(
      `SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'session'::regclass AND NOT tgisinternal`)).rows;
    const def = (name: string) => triggers.find((tr) => tr.tgname === name)?.def;
    assert.equal(def('session_aa_status_from_facts'),
      `CREATE TRIGGER session_aa_status_from_facts BEFORE INSERT OR UPDATE OF ${FACT_COLUMNS.join(', ')} ON public.session `
      + 'FOR EACH ROW EXECUTE FUNCTION session_status_from_facts()');
    assert.equal(def('session_aa_turn_state_from_status'), undefined, 'the facts no longer follow the word');
    const functions = (await sql.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE proname IN ('session_turn_state_from_status', 'session_status_from_facts') ORDER BY 1`)).rows;
    assert.deepEqual(functions.map((p) => p.proname), ['session_status_from_facts']);
    // The first BEFORE row trigger on session, so every other one sees the word it wrote (name order, C collation).
    const before = triggers.filter((tr) => /^CREATE TRIGGER \S+ BEFORE /.test(tr.def)).map((tr) => tr.tgname).sort();
    assert.equal(before[0], 'session_aa_status_from_facts');
    // The fallback is gone from the one function the restated triggers read the stored word through.
    const held = (await sql.query<{ def: string }>(`SELECT pg_get_functiondef('session_held_turn_state'::regproc) AS def`)).rows[0].def;
    assert.match(held, /CASE WHEN s\."finished_at" IS NULL THEN s\."turn_state" END/);
    assert.doesNotMatch(held, /status/);
    // T6's column lists (comment 353j9PXw1D2Npfm9ZT4Hm, item 1): turn_state beside status, finished_at on the settle.
    for (const name of ['session_acquisition_engine_guard', 'session_opencode_runner_claim_guard', 'session_antigravity_runner_claim_guard',
      'session_cursor_runner_acquisition_guard', 'session_dsh_runner_acquisition_guard']) {
      assert.match(def(name)!, /^CREATE TRIGGER \S+ BEFORE UPDATE OF status, turn_state\b/, name);
    }
    for (const name of ['session_request_recipient_ended', 'session_request_asker_stopped', 'task_owner_confirmation_review_reviewer_ended']) {
      assert.match(def(name)!, /^CREATE TRIGGER \S+ AFTER UPDATE OF status, turn_state, /, name);
    }
    assert.match(def('session_listed_at_settle')!, /BEFORE UPDATE OF status, completed_at, finished_at ON/);
  });

  const shapes = new Map<string, string>();
  await t.test('(2) INSERT: every row shape stores the projector\'s word', async () => {
    const differences: string[] = [];
    for (const shape of WORD_SHAPES) {
      const id = await insertShape(shape);
      shapes.set(shape.name, id);
      const row = await read(id);
      // The projector over the shape's own facts, which the row holds: the stored word is no other.
      assert.equal(projected(row), legacySessionStatus(shape.facts, shape.landing), `${shape.name}: the row holds the shape's facts`);
      if (row.status !== projected(row)) differences.push(`${shape.name}: stored ${row.status}, facts say ${projected(row)}`);
    }
    assert.deepEqual(differences, []);
    // Every word is among them, so no word's derivation went unchecked.
    const stored = new Set<string>();
    for (const id of shapes.values()) stored.add((await read(id)).status);
    assert.deepEqual([...stored].sort(), ['AWAITING_INPUT', 'CANCELLED', 'FAILED', 'INTERRUPTED', 'PENDING', 'RUNNING', 'SUCCEEDED']);
  });

  await t.test('(3) UPDATE: after every write a writer makes, from every shape, the stored word is the facts\'', async () => {
    const differences: string[] = [];
    let writes = 0;
    for (const shape of WORD_SHAPES) {
      for (const write of WRITES) {
        const id = await insertShape(shape);
        if (!write.when(await read(id))) continue;
        await sql.query(`UPDATE "session" SET ${write.set} WHERE "id" = $1::uuid`, [id]);
        writes += 1;
        const row = await read(id);
        if (row.status !== projected(row)) differences.push(`${shape.name} / ${write.name}: stored ${row.status}, facts say ${projected(row)}`);
      }
    }
    assert.deepEqual(differences, []);
    assert.ok(writes > WORD_SHAPES.length * 5, `${writes} writes`);
  });

  await t.test('(4) a deploy-2 replica\'s writes: the word follows the facts; the word alone is refused', async () => {
    const parked = await insertShape(WORD_SHAPES.find((s) => s.name === 'held AWAITING_INPUT')!);
    // Its enqueue, both spellings: the word it names agrees.
    await sql.query(`UPDATE "session" SET "status" = 'PENDING', "turn_state" = 'QUEUED' WHERE "id" = $1::uuid`, [parked]);
    assert.deepEqual([(await read(parked)).status, (await read(parked)).turn_state], ['PENDING', 'QUEUED']);
    // Its reaper's release of an end nobody honoured: it names FAILED; the facts say CANCELLED (plan §3.4 C1).
    await sql.query(`UPDATE "session" SET "status" = 'FAILED', "turn_state" = NULL, "finished_at" = now(),
                            "end_reason" = 'cancelled', "last_turn_outcome" = 'CANCELLED' WHERE "id" = $1::uuid`, [parked]);
    assert.equal((await read(parked)).status, 'CANCELLED');
    assert.equal((await read(parked)).status, projected(await read(parked)));
    // Its create, both spellings.
    const created = randomUUID();
    await sql.query(`INSERT INTO "session" ("id", "owner_id", "creator_id", "title", "prompt", "provider", "provider_builtin",
                       "dispatch_origin", "updated_at", "status", "turn_state", "started_at")
                     VALUES ($1, $2, $2, 'd2 create', 'd3', 'claude', true, 'USER', now(), 'PENDING', 'QUEUED', now())`, [created, owner]);
    assert.deepEqual([(await read(created)).status, (await read(created)).turn_state], ['PENDING', 'QUEUED']);
    // A stray write of the word alone names no fact: this trigger leaves it, and the agreement CHECK refuses it loudly.
    await assert.rejects(
      sql.query(`UPDATE "session" SET "status" = 'RUNNING' WHERE "id" = $1::uuid`, [created]),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' && error.constraint === 'session_turn_state_agrees_chk');
    assert.deepEqual([(await read(created)).status, (await read(created)).turn_state], ['PENDING', 'QUEUED'], 'left as it was');
  });

  await t.test('(5) the column lists fire on a write of turn_state alone', async () => {
    // The engine claim guard (0414): an engine row's claim by a replica that does not read engines is skipped whole.
    const engineRow = randomUUID();
    await sql.query(`INSERT INTO "session" ("id", "owner_id", "creator_id", "title", "prompt", "provider", "provider_builtin",
                       "engine", "dispatch_origin", "updated_at", "turn_state")
                     VALUES ($1, $2, $2, 'engine', 'd3', 'claude', true, 'claude', 'USER', now(), 'QUEUED')`, [engineRow, owner]);
    const claim = `UPDATE "session" SET "turn_state" = 'IN_FLIGHT' WHERE "id" = $1::uuid`;
    assert.equal((await sql.query(claim, [engineRow])).rowCount, 0, 'the guard skips the claim');
    assert.deepEqual([(await read(engineRow)).status, (await read(engineRow)).turn_state], ['PENDING', 'QUEUED']);
    await sql.query('BEGIN');
    await sql.query(`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`);
    assert.equal((await sql.query(claim, [engineRow])).rowCount, 1, 'the declared claim goes through');
    await sql.query('COMMIT');
    assert.deepEqual([(await read(engineRow)).status, (await read(engineRow)).turn_state], ['RUNNING', 'IN_FLIGHT']);

    // session_request_recipient_ended (0350, 1641): the end recorded first, then the turn abandoned alone.
    const recipient = await insertShape(WORD_SHAPES.find((s) => s.name === 'held RUNNING')!);
    const asker = await insertShape(WORD_SHAPES.find((s) => s.name === 'held AWAITING_INPUT')!);
    const request = randomUUID();
    await sql.query(`INSERT INTO "session_request" ("id", "owner_id", "from_session_id", "to_session_id", "turn_id",
                       "client_turn_id", "request_preview", "reply_by", "state")
                     VALUES ($1, $2, $3, $4, gen_random_uuid(), $5, 'a question', now() + interval '1 hour', 'OPEN')`,
    [request, owner, asker, recipient, `d3-${request}`]);
    await sql.query(`UPDATE "session" SET "end_reason" = 'cancelled' WHERE "id" = $1::uuid`, [recipient]);
    assert.equal((await sql.query(`SELECT state FROM "session_request" WHERE id = $1::uuid`, [request])).rows[0].state, 'OPEN');
    await sql.query(`UPDATE "session" SET "turn_state" = 'ABANDONED' WHERE "id" = $1::uuid`, [recipient]);
    assert.deepEqual((await sql.query(`SELECT state, close_reason FROM "session_request" WHERE id = $1::uuid`, [request])).rows[0],
      { state: 'RECIPIENT_ENDED', close_reason: 'INTERRUPTED:cancelled' });

    // session_listed_at_settle (1490, 1641): a release that names finished_at, not the word, moves the list's key.
    const settling = await insertShape(WORD_SHAPES.find((s) => s.name === 'held RUNNING')!);
    await sql.query(`UPDATE "session" SET "listed_at" = '2000-01-01' WHERE "id" = $1::uuid`, [settling]);
    await sql.query(`UPDATE "session" SET "turn_state" = NULL, "finished_at" = now(), "end_reason" = 'ended' WHERE "id" = $1::uuid`, [settling]);
    const moved = (await sql.query(`SELECT listed_at > '2000-01-01' AS moved, status::text AS status FROM "session" WHERE id = $1::uuid`, [settling])).rows[0];
    assert.deepEqual(moved, { moved: true, status: 'CANCELLED' });
  });
});
