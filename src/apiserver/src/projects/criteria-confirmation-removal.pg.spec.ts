import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
 * Every column of the acceptance wall, in the spelling `format_type` gives it. Verbatim from
 * `tasks/verification-subject-guard-removal.pg.spec.ts`, minus the one relation this removal
 * drops: two independent suites asserting the same census is the point, because a removal that
 * widened or narrowed one of these would have to defeat both.
 */
const PROJECT_ACCEPTANCE_COLUMNS: Readonly<Record<string, string>> = {
  project_acceptance_audit:
    'id:uuid!, project_id:uuid!, kind:text!, run_id:uuid, reason:text, detail:jsonb!, created_at:timestamp(3) without time zone!',
  project_acceptance_conclusion:
    'id:uuid!, project_id:uuid!, evidence_run_id:uuid!, evidence_version:bigint!, ordinal:integer!, criterion_key:text!, criterion_text:text!, definition_id:uuid, definition_revision:integer, verdict:project_acceptance_verdict!, summary:text, evidence:jsonb!, evidence_task_id:uuid, evidence_session_id:uuid, decided_by:text!, decided_by_id:uuid!, acting_session_id:uuid, decided_at:timestamp(3) without time zone!, created_at:timestamp(3) without time zone!',
  project_acceptance_criterion:
    'id:uuid!, run_id:uuid!, project_id:uuid!, ordinal:integer!, criterion_key:text!, criterion_text:text!, verdict:project_acceptance_verdict, summary:text, evidence:jsonb!, evidence_task_id:uuid, evidence_session_id:uuid, decided_at:timestamp(3) without time zone, created_at:timestamp(3) without time zone!, definition_id:uuid, definition_revision:integer, completion_criterion:task_completion_criterion!, acceptance_command:text, acceptance_expected_exit_code:integer',
  project_acceptance_criterion_definition:
    'id:uuid!, project_id:uuid!, ordinal:integer!, text:text!, revision:integer!, content_hash:character(64)!, created_at:timestamp(3) without time zone!, updated_at:timestamp(3) without time zone!, verification_method:text!, completion_criterion:task_completion_criterion!, acceptance_command:text, acceptance_expected_exit_code:integer, evidence_task_id:uuid, completion_criterion_override_reason:text, semantic_revision:integer!, semantic_hash:character(64)!, evaluation_plan_revision:integer!, evaluation_plan_hash:character(64)!',
  project_acceptance_run:
    'id:uuid!, project_id:uuid!, attempt:bigint!, criteria_snapshot:text!, criteria_revision:character(64)!, input_digest:character(64)!, result_digest:character(64), verdict:project_acceptance_verdict, decided_by:text!, coordinator_agent_id:uuid, coordinator_session_id:uuid, project_action_id:uuid, superseded_at:timestamp(3) without time zone, superseded_reason:text, started_at:timestamp(3) without time zone!, completed_at:timestamp(3) without time zone, created_at:timestamp(3) without time zone!, digest_version:integer!, acceptance_epoch:bigint!, criteria_snapshot_v2:jsonb',
};

/** A project with one stated criterion and one PASS evidence version, ready to go DONE. */
async function seedAcceptedProject(client: Client, label: string): Promise<{
  ownerId: string; projectId: string; runId: string;
}> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const definitionId = randomUUID();
  await client.query(
    `INSERT INTO "user" ("id","email","password_hash","name")
     VALUES ($1,$2,'x','confirmation removal fixture')`,
    [ownerId, `${label}-${ownerId}@example.test`],
  );
  await client.query(
    `INSERT INTO "project" ("id","owner_id","title","goal","status","updated_at")
     VALUES ($1,$2,$3,'prove the gate still decides','OPEN'::"project_status",now())`,
    [projectId, ownerId, `confirmation removal ${label}`],
  );
  await client.query(
    `INSERT INTO "project_acceptance_criterion_definition"
       ("id","project_id","ordinal","text","verification_method","completion_criterion",
        "content_hash","semantic_hash","evaluation_plan_hash","created_at","updated_at")
     VALUES ($1,$2,1,'The gate still decides','a judgment reads the gate',
             'EVIDENCE_JUDGMENT'::"task_completion_criterion",$3,$4,$5,now(),now())`,
    [definitionId, projectId, 'a'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
  );
  const criteriaDigest = (await client.query(
    'SELECT project_acceptance_definition_digest($1::uuid) AS digest', [projectId],
  )).rows[0].digest as string;
  await client.query(
    `UPDATE "project" SET "acceptance_criteria_digest" = $2 WHERE "id" = $1::uuid`,
    [projectId, criteriaDigest],
  );
  const criterionKey = 'the-gate-still-decides';
  await client.query(
    `INSERT INTO "project_acceptance_run"
       ("id","project_id","attempt","criteria_snapshot","criteria_revision","input_digest",
        "result_digest","verdict","decided_by","digest_version","acceptance_epoch",
        "completed_at","created_at")
     VALUES ($1,$2,1,'[]'::jsonb,$3,$4,$5,'PASS'::"project_acceptance_verdict",
             'COORDINATOR_AGENT',4,0,now(),now())`,
    [runId, projectId, criteriaDigest, 'b'.repeat(64), 'c'.repeat(64)],
  );
  await client.query(
    `INSERT INTO "project_acceptance_criterion"
       ("id","run_id","project_id","ordinal","criterion_key","criterion_text","definition_id",
        "definition_revision","verdict","created_at")
     VALUES ($1,$2,$3,1,$4,'The gate still decides',$5,1,
             'PASS'::"project_acceptance_verdict",now())`,
    [randomUUID(), runId, projectId, criterionKey, definitionId],
  );
  await client.query(
    `INSERT INTO "project_acceptance_conclusion"
       ("id","project_id","evidence_run_id","evidence_version","ordinal","criterion_key",
        "criterion_text","definition_id","definition_revision","verdict","decided_by",
        "decided_by_id","decided_at")
     VALUES ($1,$2,$3,1,1,$4,'The gate still decides',$5,1,
             'PASS'::"project_acceptance_verdict",'USER',$6,now())`,
    [randomUUID(), projectId, runId, criterionKey, definitionId, ownerId],
  );
  return { ownerId, projectId, runId };
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
suite('(c) the guards on the acceptance family and on `project` are untouched', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  // Ten, not eleven: `project_acceptance_criteria_confirmation|..._confirmation_immutable` is the
  // one this removal takes, and it is the only one.
  const family = await client.query(`
    SELECT c.relname || '|' || t.tgname AS name
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname = 'public'
       AND c.relname LIKE 'project\\_acceptance\\_%'
     ORDER BY 1`);
  assert.deepEqual(family.rows.map((row) => row.name), [
    'project_acceptance_audit|project_acceptance_audit_append_only',
    'project_acceptance_conclusion|project_acceptance_conclusion_immutable',
    'project_acceptance_conclusion|project_acceptance_conclusion_reconcile',
    'project_acceptance_conclusion|project_acceptance_conclusion_validate',
    'project_acceptance_criterion_definition|project_acceptance_definition_normalize',
    'project_acceptance_criterion_definition|zz_project_completion_contract_definition',
    'project_acceptance_criterion|project_acceptance_criterion_immutable_guard',
    'project_acceptance_run|project_acceptance_run_closure_guard',
    'project_acceptance_run|project_acceptance_run_epoch_guard',
    'project_acceptance_run|project_acceptance_run_immutable_guard',
  ]);

  // 0150's three and 0172's one, on `project` itself. Definition by definition, because a rename
  // or a re-declared timing would read as "still four triggers" to a name-only check.
  const onProject = await client.query<{ name: string; def: string }>(`
    SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND c.relname = 'project'
       AND t.tgname LIKE 'project\\_acceptance\\_%'
     ORDER BY t.tgname`);
  assert.deepEqual(onProject.rows.map((row) => `${row.name} :: ${row.def}`), [
    'project_acceptance_advance_epoch :: CREATE TRIGGER project_acceptance_advance_epoch BEFORE UPDATE ON public.project FOR EACH ROW EXECUTE FUNCTION project_acceptance_advance_epoch()',
    'project_acceptance_criteria_fact :: CREATE TRIGGER project_acceptance_criteria_fact AFTER INSERT OR UPDATE OF acceptance_criteria ON public.project FOR EACH ROW EXECUTE FUNCTION project_acceptance_criteria_fact()',
    'project_acceptance_done_gate :: CREATE TRIGGER project_acceptance_done_gate BEFORE UPDATE OF status, accepted_run_id ON public.project FOR EACH ROW EXECUTE FUNCTION project_acceptance_done_gate()',
    'project_acceptance_epoch_audit :: CREATE TRIGGER project_acceptance_epoch_audit AFTER UPDATE ON public.project FOR EACH ROW WHEN ((new.acceptance_epoch IS DISTINCT FROM old.acceptance_epoch)) EXECUTE FUNCTION project_acceptance_epoch_audit()',
  ]);

  // The names are load-bearing: PostgreSQL fires BEFORE ROW triggers in alphabetical order, and
  // `..._advance_epoch` sorting before `..._done_gate` is what pins the epoch the gate reads.
  assert.ok('project_acceptance_advance_epoch' < 'project_acceptance_done_gate');
  assert.deepEqual(
    onProject.rows.map((row) => row.name),
    [...onProject.rows.map((row) => row.name)].sort(),
    'the catalogue order this test read IS the firing order');
});

// (d) ------------------------------------------------------------------------------------------
suite('(d) the DONE gate still refuses, including the ordering bypass 0150 names', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });
  const seeded = await seedAcceptedProject(client, 'gate');

  // No evidence version bound at all.
  assert.match(
    await refusal(client, `UPDATE "project" SET "status" = 'DONE' WHERE "id" = $1::uuid`,
      [seeded.projectId]),
    /ACCEPTANCE_MISSING/);

  // The bypass: rewriting the epoch in the same statement that closes the project. It only works
  // if the gate reads the epoch the caller supplied, which is what `..._advance_epoch` sorting
  // first prevents.
  assert.match(
    await refusal(client,
      `UPDATE "project" SET "status" = 'DONE', "acceptance_epoch" = 0 WHERE "id" = $1::uuid`,
      [seeded.projectId]),
    /ACCEPTANCE_MISSING/);

  // And the gate still says yes to the run that earned it: the removal took a refusal clause off
  // nothing, so the positive path has to be unchanged too.
  await client.query(
    `UPDATE "project" SET "status" = 'DONE', "accepted_run_id" = $2::uuid WHERE "id" = $1::uuid`,
    [seeded.projectId, seeded.runId]);
  assert.deepEqual((await client.query(
    `SELECT "status"::text AS status, "accepted_run_id"::text AS run
       FROM "project" WHERE "id" = $1::uuid`, [seeded.projectId])).rows[0],
  { status: 'DONE', run: seeded.runId });
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
