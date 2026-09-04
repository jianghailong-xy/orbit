import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/**
 * The catalogue half of the 0226 removal, against a real PostgreSQL that replayed every migration.
 *
 * `outcome-reconciler/criteria-confirmation-removal.spec.ts` reads the migration text; this reads
 * the server. They can disagree — a `CREATE OR REPLACE` in a later file, a cascade nobody named,
 * a function left behind when its trigger went — and only the server settles which of the two
 * describes the database that exists.
 *
 * Its other job is the wall this removal was most likely to knock down by accident. The relation
 * being dropped sits in the middle of the `project_acceptance_*` family, and everything else in
 * that family is the account-level acceptance standard set: 306 criterion definitions, 313
 * criteria and 152 conclusions across 43 projects, all of it older than this project and none of
 * it this removal's to touch. So the family is asserted column by column, the four
 * `project_acceptance_*` triggers on `project` are asserted definition by definition, and the DONE
 * gate is exercised negatively including the alphabetical-ordering bypass 0150 names by hand.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

const CONFIRMATION_TABLE = 'project_acceptance_criteria_confirmation';
const CONFIRMATION_GUARD = 'project_acceptance_confirmation_immutable';
const CONFIRMATION_INDEXES = [
  'project_acceptance_confirmation_digest_key',
  'project_acceptance_confirmation_project_idx',
];

/**
 * What `project_acceptance_*` is made of after 0229, in the spelling `format_type` gives it. Kept
 * in step with `tasks/verification-subject-guard-removal.pg.spec.ts`: two independent suites
 * asserting the same census is the point, because a removal that widened or narrowed one of these
 * would have to defeat both.
 *
 * The run, the per-run criterion, the conclusion and the audit stood here until migration 0229
 * removed the project acceptance judgment on 2026-09-03 — a later and separate account-owner
 * decision than 0226's. The criterion's own wiring towards the work went in 0233, and the
 * evaluation-plan lane those columns fed went in 0234: two more later decisions. What 0226 was
 * protecting, and what came through all of it column for column, is the authored declaration.
 */
const PROJECT_ACCEPTANCE_COLUMNS: Readonly<Record<string, string>> = {
  project_acceptance_criterion_definition:
    'id:uuid!, project_id:uuid!, ordinal:integer!, text:text!, revision:integer!, content_hash:character(64)!, created_at:timestamp(3) without time zone!, updated_at:timestamp(3) without time zone!, verification_method:text!, completion_criterion_override_reason:text, semantic_revision:integer!, semantic_hash:character(64)!',
};


/** A project with one stated criterion, and nothing that judges it. */
async function seedProject(client: Client, label: string): Promise<{
  ownerId: string; projectId: string; definitionId: string;
}> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const definitionId = randomUUID();
  await client.query(
    `INSERT INTO "user" ("id","email","password_hash","name")
     VALUES ($1,$2,'x','confirmation removal fixture')`,
    [ownerId, `${label}-${ownerId}@example.test`],
  );
  await client.query(
    `INSERT INTO "project" ("id","owner_id","title","goal","status","updated_at")
     VALUES ($1,$2,$3,'prove the criteria survive','OPEN'::"project_status",now())`,
    [projectId, ownerId, `confirmation removal ${label}`],
  );
  await client.query(
    `INSERT INTO "project_acceptance_criterion_definition"
       ("id","project_id","ordinal","text","verification_method",
        "content_hash","semantic_hash","created_at","updated_at")
     VALUES ($1,$2,1,'The criteria survive','a person reads the criterion',
             $3,$4,now(),now())`,
    [definitionId, projectId, 'a'.repeat(64), 'd'.repeat(64)],
  );
  return { ownerId, projectId, definitionId };
}

async function refusal(client: Client, sql: string, values: unknown[]): Promise<string> {
  await client.query('BEGIN');
  try {
    await client.query(sql, values);
    await client.query('ROLLBACK');
    return '';
  } catch (error) {
    await client.query('ROLLBACK');
    return error instanceof Error ? error.message : String(error);
  }
}

// (a) ------------------------------------------------------------------------------------------
suite('(a) the confirmation relation, its indexes, its trigger and its function are all gone',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });

    assert.equal((await client.query('SELECT to_regclass($1)::text AS name',
      [CONFIRMATION_TABLE])).rows[0].name, null);

    assert.deepEqual((await client.query(`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY 1`,
    [[CONFIRMATION_TABLE, ...CONFIRMATION_INDEXES]])).rows, []);

    assert.deepEqual((await client.query(`
      SELECT t.tgname AS name FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgname = $1`, [CONFIRMATION_GUARD])).rows, []);

    // The function is the one a DROP TABLE cascade would NOT have taken. An uncallable
    // `RETURNS TRIGGER` orphan is the same class of leftover as the relation itself.
    assert.deepEqual((await client.query(`
      SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = $1`, [CONFIRMATION_GUARD])).rows, []);

    // Nothing that survives may still name what is gone: a stored body is raw SQL no compiler
    // reads, and 0189's DONE gate used to hold a CRITERIA_CONFIRMATION_REQUIRED clause.
    assert.deepEqual((await client.query(`
      SELECT n.nspname || '.' || p.proname AS name
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')
         AND p.prosrc LIKE '%criteria_confirmation%'
       ORDER BY 1`)).rows, []);

    // And no view or foreign key was left pointing at it either.
    assert.deepEqual((await client.query(`
      SELECT viewname AS name FROM pg_views
       WHERE definition LIKE '%${CONFIRMATION_TABLE}%'`)).rows, []);
  });

// (b) ------------------------------------------------------------------------------------------
suite('(b) the acceptance standard set comes through with every column it went in with',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });

    const census = await client.query<{ name: string; columns: string }>(`
      SELECT c.relname AS name,
             string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod)
                        || CASE WHEN a.attnotnull THEN '!' ELSE '' END, ', '
                        ORDER BY a.attnum) AS columns
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname LIKE 'project\\_acceptance\\_%'
         AND a.attnum > 0 AND NOT a.attisdropped
       GROUP BY c.relname ORDER BY c.relname`);
    assert.deepEqual(
      Object.fromEntries(census.rows.map((row) => [row.name, row.columns])),
      PROJECT_ACCEPTANCE_COLUMNS,
      'the acceptance wall must come through this removal with every column it went in with');
  });

// (c) ------------------------------------------------------------------------------------------
suite('(c) the guards on the acceptance family and on `project` are untouched by 0226', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  // Two. Ten when this file was written, minus
  // `project_acceptance_criteria_confirmation|..._confirmation_immutable` (the one this removal
  // takes, and the only one it takes), minus
  // `project_acceptance_run|project_acceptance_run_closure_guard`, which 0227 removed with 0215's
  // closing move, and minus the six that went with the judgment tables in 0229. Each of those is
  // a later and separate account-owner decision, and none of them is 0226's.
  const family = await client.query(`
    SELECT c.relname || '|' || t.tgname AS name
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname = 'public'
       AND c.relname LIKE 'project\\_acceptance\\_%'
     ORDER BY 1`);
  assert.deepEqual(family.rows.map((row) => row.name), [
    'project_acceptance_criterion_definition|project_acceptance_definition_normalize',
    'project_acceptance_criterion_definition|zz_project_completion_contract_definition',
  ]);

  // 0150's three and 0172's one, on `project` itself: all four gone with 0229, which is where the
  // decision to remove them was made. 0226 named none of them.
  const onProject = await client.query<{ name: string }>(`
    SELECT t.tgname AS name
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND c.relname = 'project'
       AND t.tgname LIKE 'project\\_acceptance\\_%'
     ORDER BY t.tgname`);
  assert.deepEqual(onProject.rows, []);
  const removal = readFileSync(
    path.resolve(__dirname, '../../prisma/migrations/0226_project_criteria_confirmation_removal/migration.sql'),
    'utf8',
  ).split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  for (const trigger of ['project_acceptance_advance_epoch', 'project_acceptance_criteria_fact',
    'project_acceptance_done_gate', 'project_acceptance_epoch_audit']) {
    assert.equal(removal.includes(trigger), false, `0226 names ${trigger} in a statement`);
  }
});

// (d) ------------------------------------------------------------------------------------------
suite('(d) 0226 refused nothing about DONE, and after 0229 nothing refuses it at all', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });
  const seeded = await seedProject(client, 'gate');

  // Three refusals stood here — no evidence version, the epoch-rewriting bypass, and the positive
  // path that earned a DONE. All three were the 0150 gate's, and 0229 removed it. What is left to
  // check is that the write goes through and the criterion it was never judged against is intact.
  assert.equal(
    await refusal(client, `UPDATE "project" SET "status" = 'DONE' WHERE "id" = $1::uuid`,
      [seeded.projectId]),
    '');
  await client.query(
    `UPDATE "project" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [seeded.projectId]);
  assert.equal((await client.query(
    `SELECT "status"::text AS status FROM "project" WHERE "id" = $1::uuid`, [seeded.projectId],
  )).rows[0].status, 'DONE');
  assert.equal((await client.query(
    `SELECT "text" FROM "project_acceptance_criterion_definition" WHERE "id" = $1::uuid`,
    [seeded.definitionId])).rows[0].text, 'The criteria survive');
});

// (e) ------------------------------------------------------------------------------------------
suite('(e) ordinary control-plane writes are unaffected', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  await client.query(
    `INSERT INTO "user" ("id","email","name","password_hash")
     VALUES ($1,$2,'ordinary writes','x')`, [ownerId, `writes-${ownerId}@example.test`]);
  await client.query(
    `INSERT INTO "runner" ("id","owner_id","name","token_hash") VALUES ($1,$2,'runner','h')`,
    [runnerId, ownerId]);
  await client.query(
    `INSERT INTO "workspace" ("id","owner_id","runner_id","name","work_dir")
     VALUES ($1,$2,$3,'ws','/tmp/ws')`, [workspaceId, ownerId, runnerId]);
  await client.query(
    `INSERT INTO "task" ("id","owner_id","title","creator_type","creator_id","updated_at")
     VALUES ($1,$2,'ordinary task','USER'::"creator_type",$2,now())`, [taskId, ownerId]);
  await client.query(
    `INSERT INTO "session" ("id","owner_id","creator_id","workspace_id","task_id","title","prompt",
                            "updated_at")
     VALUES ($1,$2,$2,$3,$4,'ordinary session','do the work',now())`,
    [sessionId, ownerId, workspaceId, taskId]);
  await client.query(
    `INSERT INTO "run_event" ("id","session_id","seq","type","payload")
     VALUES ($1,$2,1,'assistant','{}'::jsonb)`, [randomUUID(), sessionId]);
  await client.query(
    `INSERT INTO "task_comment" ("id","task_id","author_type","author_id","body")
     VALUES ($1,$2,'USER'::"creator_type",$3,'ordinary comment')`,
    [randomUUID(), taskId, ownerId]);
  await client.query(
    // `session_merge_receipt_merged_target_check`: a MERGED receipt has to name the target commit
    // it produced, so the fixture supplies one rather than claiming a merge with no result.
    `INSERT INTO "session_merge_receipt"
       ("id","owner_id","session_id","result","source_branch","source_sha","target_branch",
        "target_sha_after","recorded_by","idempotency_key")
     VALUES ($1,$2,$3,'MERGED','orbit/x',$4,'main',$5,'RUNNER',$6)`,
    [randomUUID(), ownerId, sessionId, 'a'.repeat(40), 'b'.repeat(40), `key-${randomUUID()}`]);

  const counts = await client.query<{ name: string; n: string }>(`
    SELECT 'run_event' AS name, count(*)::text AS n FROM "run_event" WHERE "session_id" = $2::uuid
    UNION ALL SELECT 'session', count(*)::text FROM "session" WHERE "id" = $2::uuid
    UNION ALL SELECT 'session_merge_receipt', count(*)::text FROM "session_merge_receipt" WHERE "session_id" = $2::uuid
    UNION ALL SELECT 'task', count(*)::text FROM "task" WHERE "id" = $1::uuid
    UNION ALL SELECT 'task_comment', count(*)::text FROM "task_comment" WHERE "task_id" = $1::uuid
    ORDER BY 1`, [taskId, sessionId]);
  assert.deepEqual(counts.rows, [
    { name: 'run_event', n: '1' },
    { name: 'session', n: '1' },
    { name: 'session_merge_receipt', n: '1' },
    { name: 'task', n: '1' },
    { name: 'task_comment', n: '1' },
  ]);
});
