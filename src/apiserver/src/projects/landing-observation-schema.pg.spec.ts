import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { INTEGRATION_JOB_KINDS, INTEGRATION_JOB_PHASES, INTEGRATION_JOB_STATES } from './project-integration-job';
import { OPEN_ITEM_KINDS, OPEN_ITEM_RESOLUTIONS } from './project-open-item';

/**
 * Migration 0453 on PostgreSQL: the data layer of landing observation and delivery mode
 * (docs/project-integration-line-contract.md §10.4, revision 29).
 *
 * Two databases. The one the harness hands this spec had every migration applied from empty, 0453
 * among them. On it, each new CHECK admits what §10.4 admits and refuses what it does not, the
 * partial unique index keeps a project to one queued observation, and each closed set the database
 * holds is the one the API server spells. The other is built beside it, migrated only as far as the
 * migration before 0453, and given rows in every table 0453 alters. The shipped file then applies
 * over those rows without writing one, a failure at its last statement leaves nothing behind, and a
 * second run changes nothing.
 *
 * Destructive: it creates and drops a database next to the one it is handed, so it needs a server of
 * its own (scripts/run-pg-spec.sh gives each spec one).
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const API = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(API, 'prisma', 'migrations');
const UNIT = '0453_landing_observation_delivery_mode';
/** Read where it is replayed, so a tree without 0453 fails each case on what is missing instead of failing to load. */
const migration = (): string => readFileSync(path.join(MIGRATIONS, UNIT, 'migration.sql'), 'utf8');
// Resolved rather than named, for project-codebase-migration.pg.spec.ts's reason: which node_modules
// holds the prisma CLI is a fact about the lockfile's hoisting, not about this repository.
const PRISMA = require.resolve('prisma/build/index.js');

const REPO = 'https://github.com/orbit-fixtures/landing-observation';
const MAIN = 'refs/heads/main';
const sha = (digit: string): string => digit.repeat(40);

/** The two kinds the database admits before the API server lists them: they join `OPEN_ITEM_KINDS`
 *  together with their doors (§10.8), because the door census refuses a kind that has none. */
const KINDS_AWAITING_DOORS = ['LANDED_WITHOUT_CONFIRMATION', 'LANDING_UNOBSERVED'];

/** The four tables 0453 alters. */
const ALTERED = ['project_codebase', 'project_integration_job', 'project_open_item', 'task'];

/** Run `write` and require PostgreSQL to refuse it with this SQLSTATE, naming this constraint. */
async function refused(
  write: () => Promise<unknown>,
  code: string,
  constraint: string,
  why: string,
): Promise<void> {
  await assert.rejects(write, (error: unknown) => {
    const e = error as { code?: string; constraint?: string };
    assert.equal(e.code, code, `${why}: ${String(error)}`);
    assert.equal(e.constraint, constraint, `${why}: ${String(error)}`);
    return true;
  }, why);
}

/** The values a CHECK lists, as PostgreSQL states it back: `= ANY (ARRAY[…])` or `<> ALL (ARRAY[…])`. */
async function checkValues(sql: Client, constraint: string): Promise<string[]> {
  const { rows } = await sql.query<{ def: string }>(
    'SELECT pg_get_constraintdef("oid") AS "def" FROM "pg_constraint" WHERE "conname" = $1', [constraint]);
  assert.equal(rows.length, 1, `${constraint} is not installed`);
  const listed = /ARRAY\[([^\]]*)\]/.exec(rows[0].def);
  assert.ok(listed, `${constraint} lists no values: ${rows[0].def}`);
  return [...listed[1].matchAll(/'([^']*)'::text/g)].map((match) => match[1]).sort();
}

interface Line {
  projectId: string;
  codebaseId: string;
  integrationRef: string;
}

async function newOwner(sql: Client, label: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "user" ("id", "email", "name", "password_hash") VALUES ($1, $2, $3, 'x')`,
    [id, `${label}-${id}@landing-observation.invalid`, label],
  );
  return id;
}

/** A project and its binding. `integrationRef` equal to `MAIN` is a MAIN line; anything else is a
 *  PROJECT_BRANCH line. `startedAt` set is a line that has started, which 0270 locks. */
async function newLine(
  sql: Client,
  ownerId: string,
  title: string,
  integrationRef: string,
  extra: { startedAt?: Date; deliveryMode?: string } = {},
): Promise<Line> {
  const projectId = randomUUID();
  await sql.query(
    `INSERT INTO "project" ("id", "owner_id", "title", "updated_at") VALUES ($1, $2, $3, now())`,
    [projectId, ownerId, title],
  );
  const codebaseId = randomUUID();
  const columns = ['id', 'project_id', 'owner_id', 'canonical_repo_url', 'upstream_ref', 'integration_ref',
    'ref_authority', 'integration_started_at', 'updated_at'];
  const values: unknown[] = [codebaseId, projectId, ownerId, REPO, MAIN, integrationRef, 'REMOTE',
    extra.startedAt ?? null, new Date()];
  if (extra.deliveryMode !== undefined) {
    columns.push('delivery_mode');
    values.push(extra.deliveryMode);
  }
  await sql.query(
    `INSERT INTO "project_codebase" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})`,
    values,
  );
  return { projectId, codebaseId, integrationRef };
}

async function newTask(sql: Client, ownerId: string, projectId: string, title: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "task" ("id", "owner_id", "title", "status", "project_id", "creator_type", "creator_id",
       "updated_at", "completion_criterion")
     VALUES ($1, $2, $3, 'OPEN', $4, 'USER', $2, now(), 'EVIDENCE_JUDGMENT')`,
    [id, ownerId, title, projectId],
  );
  return id;
}

interface JobFields {
  kind?: string;
  state?: string;
  phase?: string | null;
  generation?: number;
  taskId?: string | null;
  /** Defaults to the project's observation key, `canonical_repo_url || '#observe:' || project_id`. */
  serialKey?: string;
  observations?: unknown;
  landed?: boolean;
  errorCode?: string;
  /** Appended verbatim: `ON CONFLICT … DO NOTHING`. */
  onConflict?: string;
}

/** One job row, written the way §10.4 has an OBSERVE_LANDING written unless told otherwise: no task,
 *  session, promotion or landing, and both refs the integration line. Names 0453's `observations`
 *  only when given one, so it writes the database from before 0453 too. Answers the rows it inserted. */
async function insertJob(
  sql: Client,
  ownerId: string,
  line: Line,
  fields: JobFields = {},
): Promise<{ id: string; inserted: number }> {
  const id = randomUUID();
  const kind = fields.kind ?? 'OBSERVE_LANDING';
  const generation = fields.generation ?? 1;
  const row: Record<string, unknown> = {
    id, project_id: line.projectId, owner_id: ownerId, codebase_id: line.codebaseId, kind, generation,
    state: fields.state ?? 'QUEUED', phase: fields.phase ?? null, task_id: fields.taskId ?? null,
    serial_key: fields.serialKey ?? `${REPO}#observe:${line.projectId}`, target_ref: line.integrationRef,
    upstream_ref: MAIN, source_ref: line.integrationRef, error_code: fields.errorCode ?? null,
    idempotency_key: `ij:v1:${kind}:${line.projectId}:${generation}:${id}`, updated_at: new Date(),
    ...(fields.landed ? { landed_sha: sha('8'), tested_tree_sha: sha('7'), landed_tree_sha: sha('7') } : {}),
    ...(fields.observations !== undefined ? { observations: JSON.stringify(fields.observations) } : {}),
  };
  const columns = Object.keys(row);
  const result = await sql.query(
    `INSERT INTO "project_integration_job" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${columns.map((column, index) => (column === 'observations' ? `$${index + 1}::jsonb` : `$${index + 1}`)).join(', ')})
     ${fields.onConflict ?? ''}`,
    Object.values(row),
  );
  return { id, inserted: result.rowCount ?? 0 };
}

interface ItemFields {
  kind: string;
  assignee: 'COORDINATOR' | 'OWNER';
  assigneeReason?: string;
  resolution?: string;
  escalated?: boolean;
  handling?: { jobId: string; userId: string };
}

async function insertItem(
  sql: Client,
  ownerId: string,
  line: Line,
  taskId: string | null,
  fields: ItemFields,
): Promise<string> {
  const id = randomUUID();
  const resolved = fields.resolution !== undefined;
  await sql.query(
    `INSERT INTO "project_open_item" ("id", "project_id", "owner_id", "kind", "state", "assignee", "assignee_reason",
       "task_id", "dedupe_key", "title", "payload", "waiting_since", "assigned_at", "escalated_at", "resolution",
       "resolved_at", "resolved_by", "handling_job_id", "handling_user_id", "handling_reason", "handling_started_at")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb, now(), now(), $11, $12, $13, $14, $15, $16, $17,
       $18)`,
    [
      id, line.projectId, ownerId, fields.kind, resolved ? 'RESOLVED' : 'OPEN', fields.assignee,
      fields.assigneeReason ?? 'DEFAULT', taskId, `fixture:${fields.kind}:${id}`, `Fixture ${fields.kind}`,
      fields.escalated ? new Date() : null, fields.resolution ?? null, resolved ? new Date() : null,
      resolved ? 'USER' : null, fields.handling?.jobId ?? null, fields.handling?.userId ?? null,
      fields.handling ? 'The branch was pushed again.' : null, fields.handling ? new Date() : null,
    ],
  );
  return id;
}

test('0453 §10.4 on a database every migration ran on from empty', { skip, timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const sql = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 10_000 });
  await sql.connect();
  t.after(() => sql.end().catch(() => undefined));
  await verifyCoordinatorPgIdentity(sql);

  await t.test('every migration on disk is applied, 0453 among them', async () => {
    const onDisk = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const applied = (await sql.query<{ name: string }>(
      `SELECT "migration_name" AS "name" FROM "_prisma_migrations"
        WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
    )).rows.map((row) => row.name).sort();
    assert.deepEqual(applied, onDisk, 'this is not a database every migration ran on');
    assert.ok(applied.includes(UNIT));
  });

  await t.test('§10.4: the new columns have the types the contract gives them', async () => {
    const { rows } = await sql.query(
      `SELECT "table_name" AS "table", "column_name" AS "column", "data_type" AS "type",
              "character_maximum_length" AS "length", "datetime_precision" AS "precision",
              "is_nullable" AS "nullable", "column_default" AS "default"
         FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND ("table_name", "column_name") IN (
            ('project_codebase', 'delivery_mode'), ('project_codebase', 'delivery_mode_chosen_at'),
            ('task', 'delivered_sha'), ('task', 'delivered_base_sha'), ('task', 'delivered_branch'),
            ('task', 'delivered_session_id'), ('task', 'delivered_at'),
            ('project_integration_job', 'observations'))
        ORDER BY 1, 2`,
    );
    const column = (table: string, name: string, type: string, nullable: 'YES' | 'NO', more: {
      length?: number; precision?: number; default?: string;
    } = {}) => ({
      table, column: name, type, length: more.length ?? null, precision: more.precision ?? null, nullable,
      default: more.default ?? null,
    });
    assert.deepEqual(rows, [
      column('project_codebase', 'delivery_mode', 'text', 'NO', { default: "'PLATFORM'::text" }),
      column('project_codebase', 'delivery_mode_chosen_at', 'timestamp with time zone', 'YES', { precision: 3 }),
      column('project_integration_job', 'observations', 'jsonb', 'YES'),
      column('task', 'delivered_at', 'timestamp with time zone', 'YES', { precision: 3 }),
      column('task', 'delivered_base_sha', 'character', 'YES', { length: 40 }),
      column('task', 'delivered_branch', 'text', 'YES'),
      column('task', 'delivered_session_id', 'uuid', 'YES'),
      column('task', 'delivered_sha', 'character', 'YES', { length: 40 }),
    ]);
  });

  const ownerId = await newOwner(sql, 'landing-observation-schema');
  const main = await newLine(sql, ownerId, 'MAIN line', MAIN);
  const branch = await newLine(sql, ownerId, 'PROJECT_BRANCH line', 'refs/heads/project/landing-observation');
  const started = await newLine(sql, ownerId, 'MAIN line, started', MAIN, { startedAt: new Date() });
  const taskId = await newTask(sql, ownerId, main.projectId, 'A task that delivers');

  const binding = async (line: Line) => (await sql.query<{
    mode: string; chosenAt: Date | null; revision: string; integrationRef: string;
  }>(
    `SELECT "delivery_mode" AS "mode", "delivery_mode_chosen_at" AS "chosenAt",
            "config_revision"::text AS "revision", "integration_ref" AS "integrationRef"
       FROM "project_codebase" WHERE "id" = $1`, [line.codebaseId])).rows[0];
  const setMode = (line: Line, mode: string | null) => sql.query(
    `UPDATE "project_codebase" SET "delivery_mode" = $2, "delivery_mode_chosen_at" = now() WHERE "id" = $1`,
    [line.codebaseId, mode]);

  await t.test('§10.4 O-L1: delivery_mode is PLATFORM by default, AGENT_PUSH on a MAIN line, and nothing else',
    async () => {
      const fresh = await binding(main);
      assert.equal(fresh.mode, 'PLATFORM', 'a binding nobody chose for is a PLATFORM one');
      assert.equal(fresh.chosenAt, null, 'NULL is "never chosen"');

      await setMode(main, 'AGENT_PUSH');
      const chosen = await binding(main);
      assert.equal(chosen.mode, 'AGENT_PUSH');
      assert.ok(chosen.chosenAt instanceof Date, 'the owner\'s choice is stamped');
      await setMode(main, 'PLATFORM');
      assert.equal((await binding(main)).mode, 'PLATFORM');

      for (const mode of ['MANUAL', 'agent_push', 'AGENT-PUSH', 'PLATFORM ', '']) {
        await refused(() => setMode(main, mode), '23514', 'project_codebase_delivery_mode_chk',
          `delivery_mode ${JSON.stringify(mode)} is outside the closed set`);
      }
      await assert.rejects(() => setMode(main, null), (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23502', String(error));
        return true;
      }, 'delivery_mode is NOT NULL');
      assert.deepEqual(await checkValues(sql, 'project_codebase_delivery_mode_chk'), ['AGENT_PUSH', 'PLATFORM']);
    });

  await t.test('§10.4 O-L1: a PROJECT_BRANCH line cannot hold AGENT_PUSH, however it is written', async () => {
    const LINE_CHK = 'project_codebase_delivery_mode_line_chk';
    await refused(() => setMode(branch, 'AGENT_PUSH'), '23514', LINE_CHK,
      'a PROJECT_BRANCH binding switched to AGENT_PUSH');
    assert.equal((await binding(branch)).mode, 'PLATFORM', 'the refused write left the binding as it was');
    await refused(
      () => newLine(sql, ownerId, 'PROJECT_BRANCH line born AGENT_PUSH', 'refs/heads/project/born', {
        deliveryMode: 'AGENT_PUSH',
      }),
      '23514', LINE_CHK, 'a PROJECT_BRANCH binding inserted as AGENT_PUSH');
    // The other direction: an AGENT_PUSH MAIN line does not become a project branch while it stays
    // AGENT_PUSH. Back on PLATFORM the same move is allowed, because this line has not started.
    await setMode(main, 'AGENT_PUSH');
    const moveLine = (ref: string) => sql.query(
      `UPDATE "project_codebase" SET "integration_ref" = $2 WHERE "id" = $1`, [main.codebaseId, ref]);
    await refused(() => moveLine('refs/heads/project/moved'), '23514', LINE_CHK,
      'an AGENT_PUSH binding moved onto a project branch');
    await setMode(main, 'PLATFORM');
    await moveLine('refs/heads/project/moved');
    assert.equal((await binding(main)).integrationRef, 'refs/heads/project/moved');
    await moveLine(MAIN);
  });

  await t.test('§10.4 O-L1: neither 0270\'s lock nor 0231\'s config guard names the delivery mode', async () => {
    // A started line: 0270 refuses moving its refs, and still lets the delivery mode change.
    const before = await binding(started);
    await setMode(started, 'AGENT_PUSH');
    const after = await binding(started);
    assert.equal(after.mode, 'AGENT_PUSH', 'the delivery mode changes after the line has started');
    assert.equal(after.revision, before.revision, 'choosing a delivery mode is no configuration change');
    await setMode(started, 'PLATFORM');
    assert.equal((await binding(started)).revision, before.revision);
    await assert.rejects(
      () => sql.query(`UPDATE "project_codebase" SET "integration_ref" = $2 WHERE "id" = $1`,
        [started.codebaseId, 'refs/heads/project/started']),
      /INTEGRATION_LINE_LOCKED/,
      'the lock still refuses moving the line: it is live, and it does not name delivery_mode',
    );
    // And the guard is live: a column it does name moves the revision.
    const unstarted = await binding(main);
    await sql.query(`UPDATE "project_codebase" SET "remote_name" = 'upstream' WHERE "id" = $1`, [main.codebaseId]);
    assert.equal(BigInt((await binding(main)).revision), BigInt(unstarted.revision) + 1n);
    await sql.query(`UPDATE "project_codebase" SET "remote_name" = 'origin' WHERE "id" = $1`, [main.codebaseId]);
  });

  await t.test('§10.4 O1: the five delivery columns are nullable, and the session is a reference with no key',
    async () => {
      const identity = async () => (await sql.query(
        `SELECT "delivered_sha" AS "sha", "delivered_base_sha" AS "baseSha", "delivered_branch" AS "branch",
                "delivered_session_id"::text AS "sessionId", "delivered_at" IS NOT NULL AS "frozen"
           FROM "task" WHERE "id" = $1`, [taskId])).rows[0];
      assert.deepEqual(await identity(),
        { sha: null, baseSha: null, branch: null, sessionId: null, frozen: false }, 'a new task is not frozen');

      // The session named here does not exist, and nothing refuses it: no foreign key, as 0424.
      const gone = randomUUID();
      await sql.query(
        `UPDATE "task" SET "delivered_sha" = $2, "delivered_base_sha" = $3, "delivered_branch" = 'orbit/task-x',
                "delivered_session_id" = $4, "delivered_at" = now()
          WHERE "id" = $1`, [taskId, sha('a'), sha('b'), gone]);
      assert.deepEqual(await identity(),
        { sha: sha('a'), baseSha: sha('b'), branch: 'orbit/task-x', sessionId: gone, frozen: true });
      const keys = await sql.query(
        `SELECT 1 FROM "pg_constraint" c
           JOIN "pg_attribute" a ON a."attrelid" = c."conrelid" AND a."attnum" = ANY (c."conkey")
          WHERE c."conrelid" = '"task"'::regclass AND c."contype" = 'f' AND a."attname" = 'delivered_session_id'`);
      assert.equal(keys.rowCount, 0, 'delivered_session_id is a history reference, not a foreign key');

      await assert.rejects(
        () => sql.query(`UPDATE "task" SET "delivered_sha" = $2 WHERE "id" = $1`, [taskId, `${sha('a')}0`]),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, '22001', String(error));
          return true;
        },
        'a commit is 40 characters, and CHAR(40) holds no more',
      );

      await sql.query(
        `UPDATE "task" SET "delivered_sha" = NULL, "delivered_base_sha" = NULL, "delivered_branch" = NULL,
                "delivered_session_id" = NULL, "delivered_at" = NULL
          WHERE "id" = $1`, [taskId]);
      assert.deepEqual(await identity(),
        { sha: null, baseSha: null, branch: null, sessionId: null, frozen: false }, 'all five clear again');
    });

  await t.test('§10.4 §10.6: an OBSERVE_LANDING job steps through FETCH and OBSERVE, ends OBSERVED, and stays final',
    async () => {
      const observed = await newLine(sql, ownerId, 'observed line', MAIN);
      const job = await insertJob(sql, ownerId, observed);
      const step = (set: string, values: unknown[] = []) => sql.query(
        `UPDATE "project_integration_job" SET ${set} WHERE "id" = $1`, [job.id, ...values]);
      await step(`"state" = 'RUNNING', "phase" = 'FETCH', "claimed_at" = now()`);
      await step(`"phase" = 'OBSERVE'`);
      const observations = [{
        taskId, deliveredSha: sha('a'), baseSha: sha('b'), onUpstream: true, onIntegrationLine: null,
        empty: false, fullyApplied: null,
      }];
      await step(
        `"state" = 'OBSERVED', "observations" = $2::jsonb, "upstream_sha" = $3, "target_sha_before" = $3,
         "finished_at" = now()`,
        [JSON.stringify(observations), sha('c')]);
      const row = (await sql.query(
        `SELECT "kind", "state", "phase", "observations", "task_id" AS "taskId", "source_ref" AS "sourceRef",
                "target_ref" AS "targetRef"
           FROM "project_integration_job" WHERE "id" = $1`, [job.id])).rows[0];
      assert.deepEqual(row, {
        kind: 'OBSERVE_LANDING', state: 'OBSERVED', phase: 'OBSERVE', observations, taskId: null,
        sourceRef: MAIN, targetRef: MAIN,
      });
      // J4: the guard refuses every update of a row that is neither QUEUED nor RUNNING, OBSERVED included.
      await assert.rejects(() => step(`"observations" = '[]'::jsonb`), /PROJECT_INTEGRATION_JOB_TERMINAL/,
        'an OBSERVED job is final');

      await refused(() => insertJob(sql, ownerId, observed, { kind: 'OBSERVE' }), '23514',
        'project_integration_job_kind_chk', 'an unknown job kind');
      await refused(() => insertJob(sql, ownerId, observed, { state: 'OBSERVING' }), '23514',
        'project_integration_job_state_chk', 'an unknown job state');
      await refused(() => insertJob(sql, ownerId, observed, { phase: 'OBSERVING' }), '23514',
        'project_integration_job_phase_chk', 'an unknown job phase');
    });

  await t.test('§10.4: every job kind, state and phase the API server spells is the one the database holds',
    async () => {
      assert.deepEqual(await checkValues(sql, 'project_integration_job_kind_chk'), [...INTEGRATION_JOB_KINDS].sort());
      assert.deepEqual(await checkValues(sql, 'project_integration_job_state_chk'), [...INTEGRATION_JOB_STATES].sort());
      assert.deepEqual(await checkValues(sql, 'project_integration_job_phase_chk'), [...INTEGRATION_JOB_PHASES].sort());
      // And each of them is written, not only listed: one row per value, each under a key of its own.
      const every = await newLine(sql, ownerId, 'every value', MAIN);
      const key = () => `${REPO}#census:${randomUUID()}`;
      for (const kind of INTEGRATION_JOB_KINDS) {
        await insertJob(sql, ownerId, every, {
          kind, serialKey: key(), taskId: kind === 'LAND_TASK' ? taskId : null, state: 'CANCELLED',
        });
      }
      for (const state of INTEGRATION_JOB_STATES) {
        await insertJob(sql, ownerId, every, { kind: 'CHECK_PROMOTION', state, serialKey: key(), landed: state === 'LANDED' });
      }
      for (const phase of INTEGRATION_JOB_PHASES) {
        await insertJob(sql, ownerId, every, { kind: 'CHECK_PROMOTION', state: 'ERROR', phase, serialKey: key() });
      }
    });

  await t.test('§10.4 J1: a second QUEUED OBSERVE_LANDING of one project is refused by the partial unique index',
    async () => {
      const INDEX = 'project_integration_job_observe_queued_key';
      const line = await newLine(sql, ownerId, 'queued observations', MAIN);
      const other = await newLine(sql, ownerId, 'another project', MAIN);
      const queued = async (of: Line) => Number((await sql.query<{ n: string }>(
        `SELECT count(*) AS "n" FROM "project_integration_job"
          WHERE "project_id" = $1 AND "kind" = 'OBSERVE_LANDING' AND "state" = 'QUEUED'`, [of.projectId])).rows[0].n);

      const first = await insertJob(sql, ownerId, line, { generation: 1 });
      await refused(() => insertJob(sql, ownerId, line, { generation: 2 }), '23505', INDEX,
        'a second queued observation of one project');
      // The way §10.4 has every trigger enqueue: the later one folds into the one already queued.
      assert.equal((await insertJob(sql, ownerId, line, { generation: 2, onConflict: 'ON CONFLICT DO NOTHING' }))
        .inserted, 0);
      assert.equal((await insertJob(sql, ownerId, line, {
        generation: 2,
        onConflict: `ON CONFLICT ("serial_key") WHERE "kind" = 'OBSERVE_LANDING' AND "state" = 'QUEUED' DO NOTHING`,
      })).inserted, 0, 'the index is an arbiter an enqueue can name');
      assert.equal(await queued(line), 1);
      // Another project's observation has a key of its own.
      await insertJob(sql, ownerId, other, { generation: 1 });
      assert.equal(await queued(other), 1);
      // The index is about QUEUED only: once the first is claimed, one more may queue behind it.
      await sql.query(
        `UPDATE "project_integration_job" SET "state" = 'RUNNING', "phase" = 'FETCH' WHERE "id" = $1`, [first.id]);
      const second = await insertJob(sql, ownerId, line, { generation: 2 });
      assert.equal(second.inserted, 1);
      // J1's running index covers the #observe: key too: two observations of one project never run at once.
      await refused(
        () => sql.query(`UPDATE "project_integration_job" SET "state" = 'RUNNING' WHERE "id" = $1`, [second.id]),
        '23505', 'project_integration_job_running_serial_key', 'a second running observation of one project');
      await sql.query(
        `UPDATE "project_integration_job" SET "state" = 'OBSERVED', "phase" = 'OBSERVE', "finished_at" = now()
          WHERE "id" = $1`, [first.id]);
      await sql.query(`UPDATE "project_integration_job" SET "state" = 'RUNNING' WHERE "id" = $1`, [second.id]);
      assert.equal((await insertJob(sql, ownerId, line, { generation: 3 })).inserted, 1);
      assert.equal(await queued(line), 1);
    });

  await t.test('§10.4 §10.7: the two new kinds and resolutions, and LANDED_WITHOUT_CONFIRMATION is the owner\'s alone',
    async () => {
      const job = await insertJob(sql, ownerId, main, { generation: 1 });
      await insertItem(sql, ownerId, main, taskId, { kind: 'LANDING_UNOBSERVED', assignee: 'COORDINATOR' });
      await insertItem(sql, ownerId, main, taskId, {
        kind: 'LANDING_UNOBSERVED', assignee: 'OWNER', assigneeReason: 'NO_COORDINATOR',
      });
      await insertItem(sql, ownerId, main, taskId, { kind: 'LANDED_WITHOUT_CONFIRMATION', assignee: 'OWNER' });
      await refused(
        () => insertItem(sql, ownerId, main, taskId, { kind: 'LANDED_WITHOUT_CONFIRMATION', assignee: 'COORDINATOR' }),
        '23514', 'project_open_item_owner_only_chk', 'an unconfirmed landing put to a coordinator');
      await insertItem(sql, ownerId, main, taskId, {
        kind: 'LANDED_WITHOUT_CONFIRMATION', assignee: 'OWNER', resolution: 'ACCEPTED',
      });
      await insertItem(sql, ownerId, main, taskId, {
        kind: 'LANDING_UNOBSERVED', assignee: 'COORDINATOR', resolution: 'CODELESS',
      });
      // §10.8: a renewed observation is recorded on the open item the way a rerun is (H1).
      await insertItem(sql, ownerId, main, taskId, {
        kind: 'LANDING_UNOBSERVED', assignee: 'COORDINATOR', handling: { jobId: job.id, userId: ownerId },
      });
      await refused(
        () => insertItem(sql, ownerId, main, taskId, {
          kind: 'LANDED_WITHOUT_CONFIRMATION', assignee: 'OWNER', handling: { jobId: job.id, userId: ownerId },
        }),
        '23514', 'project_open_item_handling_kind_chk', 'nothing reruns an unconfirmed landing');

      await refused(
        () => insertItem(sql, ownerId, main, taskId, { kind: 'LANDING_NOT_OBSERVED', assignee: 'COORDINATOR' }),
        '23514', 'project_open_item_kind_chk', 'an unknown item kind');
      await refused(
        () => insertItem(sql, ownerId, main, taskId, {
          kind: 'LANDED_WITHOUT_CONFIRMATION', assignee: 'OWNER', resolution: 'ACCEPT',
        }),
        '23514', 'project_open_item_resolution_chk', 'an unknown resolution');
    });

  await t.test('§10.4: the open-item CHECKs and the API server\'s closed sets agree', async () => {
    assert.deepEqual(await checkValues(sql, 'project_open_item_resolution_chk'), [...OPEN_ITEM_RESOLUTIONS].sort());
    assert.deepEqual(await checkValues(sql, 'project_open_item_kind_chk'),
      [...new Set<string>([...OPEN_ITEM_KINDS, ...KINDS_AWAITING_DOORS])].sort(),
      'the kinds the database admits are the ones the API server lists, and the two that join with their doors');
    const ownerOnly = await checkValues(sql, 'project_open_item_owner_only_chk');
    assert.ok(ownerOnly.includes('LANDED_WITHOUT_CONFIRMATION'));
    assert.ok(!ownerOnly.includes('LANDING_UNOBSERVED'), 'LANDING_UNOBSERVED goes to the coordinator first');
    assert.deepEqual(await checkValues(sql, 'project_open_item_handling_kind_chk'),
      ['INTEGRATION_CHECK_FAILED', 'INTEGRATION_CONFLICT', 'INTEGRATION_ERROR', 'LANDING_UNOBSERVED']);
  });
});

/** The constraints, indexes and columns of the tables 0453 alters: what "the schema did not move" means. */
async function shape(client: Client) {
  const constraints = await client.query(
    `SELECT c."conrelid"::regclass::text AS "table", c."conname" AS "name", pg_get_constraintdef(c."oid") AS "def"
       FROM "pg_constraint" c
      WHERE c."conrelid" = ANY ($1::regclass[])
      ORDER BY 1, 2`, [ALTERED]);
  const indexes = await client.query(
    `SELECT "tablename" AS "table", "indexname" AS "name", "indexdef" AS "def" FROM "pg_indexes"
      WHERE "schemaname" = 'public' AND "tablename" = ANY ($1::text[])
      ORDER BY 1, 2`, [ALTERED]);
  const columns = await client.query(
    `SELECT "table_name" AS "table", "column_name" AS "name", "data_type" AS "type", "is_nullable" AS "nullable",
            "column_default" AS "default"
       FROM "information_schema"."columns"
      WHERE "table_schema" = 'public' AND "table_name" = ANY ($1::text[])
      ORDER BY 1, 2`, [ALTERED]);
  return { constraints: constraints.rows, indexes: indexes.rows, columns: columns.rows };
}

/** Every column of the named rows, as PostgreSQL renders them, keyed by table and id. */
async function rowsOf(client: Client, ids: Record<string, string[]>): Promise<Map<string, Record<string, unknown>>> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const [table, of] of Object.entries(ids)) {
    const found = await client.query<{ id: string; row: Record<string, unknown> }>(
      `SELECT x."id"::text AS "id", to_jsonb(x) AS "row" FROM "${table}" x WHERE x."id" = ANY ($1::uuid[])`, [of]);
    assert.equal(found.rowCount, of.length, `a ${table} fixture row is missing`);
    for (const { id, row } of found.rows) rows.set(`${table}:${id}`, row);
  }
  return rows;
}

/** The columns 0453 adds, and what every stored row reads in them once it has run. */
const ADDED: Record<string, Record<string, unknown>> = {
  project_codebase: { delivery_mode: 'PLATFORM', delivery_mode_chosen_at: null },
  task: {
    delivered_sha: null, delivered_base_sha: null, delivered_branch: null, delivered_session_id: null,
    delivered_at: null,
  },
  project_integration_job: { observations: null },
  project_open_item: {},
};

test('0453 §10.4 §10.9 on the schema before it, over rows of every table it alters: no row written, atomic, runs twice',
  { skip, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(PG_URL);
    const caseClient = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 10_000 });
    await caseClient.connect();
    // Every handle is released in one hook registered before anything can throw, in the order that keeps a
    // dropped database from reporting a disconnect nobody is listening for.
    let replay: Client | null = null;
    let admin: Client | null = null;
    let tree: string | null = null;
    const url = new URL(PG_URL);
    const name = `${decodeURIComponent(url.pathname.replace(/^\//, ''))}_0453`;
    const dropReplay = async (): Promise<void> => {
      if (!admin) return;
      await admin.query(
        `SELECT pg_terminate_backend("pid") FROM "pg_stat_activity" WHERE "datname" = $1 AND "pid" <> pg_backend_pid()`,
        [name]);
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    };
    t.after(async () => {
      await replay?.end().catch(() => undefined);
      await dropReplay().catch(() => undefined);
      await admin?.end().catch(() => undefined);
      await caseClient.end().catch(() => undefined);
      if (tree) rmSync(tree, { recursive: true, force: true });
    });
    await verifyCoordinatorPgIdentity(caseClient);

    // A database beside the case's own, named from it so the pcc* isolation the harness proved covers it too,
    // created empty because the point is to start from before 0453.
    assert.ok(name.length <= 63, `${name} is longer than a PostgreSQL identifier`);
    assert.match(name, /^pcc[0-9a-z]*[_-]/, 'the replay database keeps the case database\'s pcc* prefix');
    const maintenance = new URL(PG_URL);
    maintenance.pathname = '/postgres';
    admin = new Client({ connectionString: maintenance.href, connectionTimeoutMillis: 10_000 });
    await admin.connect();
    await dropReplay();
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    const replayUrl = new URL(PG_URL);
    replayUrl.pathname = `/${name}`;

    // The migration directory as it stood the moment before 0453, built from the files this repository ships.
    const baseline = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .filter((dir) => dir < UNIT);
    assert.ok(baseline.length > 400, 'the history before 0453 is missing');
    tree = mkdtempSync(path.join(tmpdir(), 'landing-observation-0453-'));
    cpSync(path.join(API, 'prisma', 'schema.prisma'), path.join(tree, 'schema.prisma'));
    mkdirSync(path.join(tree, 'migrations'));
    cpSync(path.join(MIGRATIONS, 'migration_lock.toml'), path.join(tree, 'migrations', 'migration_lock.toml'));
    for (const dir of baseline) {
      cpSync(path.join(MIGRATIONS, dir), path.join(tree, 'migrations', dir), { recursive: true });
    }
    try {
      execFileSync(process.execPath, [PRISMA, 'migrate', 'deploy', '--config', path.join(API, 'prisma.frontier.config.ts')], {
        cwd: API,
        timeout: 240_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CHECKPOINT_DISABLE: '1',
          PRISMA_HIDE_UPDATE_MESSAGE: 'true',
          DATABASE_URL: replayUrl.href,
          ORBIT_FRONTIER_PRISMA_SCHEMA: path.join(tree, 'schema.prisma'),
          ORBIT_FRONTIER_PRISMA_MIGRATIONS: path.join(tree, 'migrations'),
        },
      });
    } catch (error) {
      const failure = error as { stdout?: Buffer; stderr?: Buffer };
      assert.fail(`prisma migrate deploy failed:\n${failure.stdout?.toString() ?? ''}\n${failure.stderr?.toString() ?? ''}`);
    }

    replay = new Client({ connectionString: replayUrl.href, connectionTimeoutMillis: 10_000 });
    await replay.connect();
    const sql = replay;
    const applied = (await sql.query<{ name: string }>(
      `SELECT "migration_name" AS "name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY 1`,
    )).rows.map((row) => row.name);
    assert.deepEqual(applied, baseline, 'the frontier did not stop where it was asked to');
    const before = await shape(sql);
    assert.ok(!before.columns.some((column) => column.name === 'delivery_mode'), 'this database has not heard of 0453');

    // Rows of every table 0453 alters, in shapes production holds: a started MAIN line and a PROJECT_BRANCH
    // line, tasks, jobs of each kind and in a final state the terminal guard protects, and items of several
    // kinds, one being handled and one resolved.
    const ownerId = await newOwner(sql, 'landing-observation-0453');
    const main = await newLine(sql, ownerId, 'MAIN line, started', MAIN, { startedAt: new Date() });
    const branch = await newLine(sql, ownerId, 'PROJECT_BRANCH line', 'refs/heads/project/landing-observation-0453');
    const taskA = await newTask(sql, ownerId, main.projectId, 'Landed work');
    const taskB = await newTask(sql, ownerId, branch.projectId, 'Work on the project branch');
    const landed = await insertJob(sql, ownerId, main, {
      kind: 'LAND_TASK', state: 'LANDED', phase: 'PUSH', taskId: taskA, serialKey: `${REPO}#main`, landed: true,
    });
    const check = await insertJob(sql, ownerId, branch, {
      kind: 'CHECK_PROMOTION', state: 'QUEUED', serialKey: `${REPO}#main`,
    });
    const failed = await insertJob(sql, ownerId, branch, {
      kind: 'LAND_TASK', state: 'ERROR', phase: 'FETCH', taskId: taskB, errorCode: 'SOURCE_BRANCH_MISSING',
      serialKey: `${REPO}#project/landing-observation-0453`,
    });
    const handled = await insertItem(sql, ownerId, branch, taskB, {
      kind: 'INTEGRATION_ERROR', assignee: 'COORDINATOR', handling: { jobId: failed.id, userId: ownerId },
    });
    const lease = await insertItem(sql, ownerId, main, null, {
      kind: 'LANDING_LEASE_EXPIRED', assignee: 'OWNER', assigneeReason: 'ESCALATED', escalated: true,
    });
    const closed = await insertItem(sql, ownerId, main, taskA, {
      kind: 'INTEGRATION_CONFLICT', assignee: 'COORDINATOR', resolution: 'LANDED',
    });
    const ids: Record<string, string[]> = {
      project_codebase: [main.codebaseId, branch.codebaseId],
      task: [taskA, taskB],
      project_integration_job: [landed.id, check.id, failed.id],
      project_open_item: [handled, lease, closed],
    };
    const stored = await rowsOf(sql, ids);
    const shipped = migration();

    await t.test('a failure at its last statement leaves nothing of it behind', async () => {
      const doomed = shipped.replace(/COMMIT;\s*$/, 'SELECT 1 / 0;\nCOMMIT;\n');
      assert.notEqual(doomed, shipped, 'the fault was not injected');
      await assert.rejects(() => sql.query(doomed), /division by zero/);
      await sql.query('ROLLBACK');
      assert.deepEqual(await shape(sql), before, 'the failed migration left part of itself');
      assert.deepEqual(await rowsOf(sql, ids), stored);
    });

    const withoutAdded = (key: string, row: Record<string, unknown>) => {
      const table = key.slice(0, key.indexOf(':'));
      return Object.fromEntries(Object.entries(row).filter(([column]) => !(column in ADDED[table])));
    };

    await t.test('the shipped file applies over the stored rows and rewrites none of them', async () => {
      await sql.query(shipped);
      const after = await rowsOf(sql, ids);
      for (const [key, row] of stored) {
        const now = after.get(key)!;
        assert.deepEqual(withoutAdded(key, now), row, `${key}: a stored column changed, updated_at and config_revision included`);
        const table = key.slice(0, key.indexOf(':'));
        for (const [column, value] of Object.entries(ADDED[table])) {
          assert.deepEqual(now[column], value, `${key}: ${column} reads ${JSON.stringify(now[column])}`);
        }
      }
    });

    const applied0453 = await shape(sql);

    await t.test('the result is the schema a database migrated from empty has', async () => {
      assert.deepEqual(applied0453, await shape(caseClient),
        'the tables 0453 alters differ between a database migrated over data and one migrated from empty');
    });

    await t.test('a second run changes neither the schema nor a row', async () => {
      const once = await rowsOf(sql, ids);
      await sql.query(shipped);
      assert.deepEqual(await shape(sql), applied0453, 'running 0453 again moved the schema');
      assert.deepEqual(await rowsOf(sql, ids), once, 'running 0453 again touched a row');
    });
  });
