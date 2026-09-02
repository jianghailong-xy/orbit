import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * The catalog and behaviour half of the 0222 removal, against a real PostgreSQL that replayed every
 * migration.
 *
 * `canonical-done-gate-removal.spec.ts` reads the migration text; this reads the server. They can
 * disagree — a `CREATE OR REPLACE` in a later file, a cascade nobody named, a column an ALTER left
 * behind — and only the server settles which of the two describes the database that exists.
 *
 * Its other job is the wall this removal was most likely to knock down by accident. The account
 * owner's decision is that a project must still need a PASS acceptance run to be DONE, so the 0150
 * gate is exercised positively and negatively here, including the alphabetical-ordering bypass the
 * 0150 comment names by hand.
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

const DROPPED_TABLES = [
  'outcome_active_obligation', 'outcome_binding_transition', 'outcome_canonical_fact',
  'outcome_delivery_attestation', 'outcome_delivery_binding', 'outcome_delivery_verification',
  'outcome_evaluation_cut', 'outcome_evaluation_cut_fact', 'outcome_evaluation_projection',
  'outcome_evaluator_result', 'outcome_fact_authority_grant', 'outcome_fact_authority_matrix',
  'outcome_fact_authority_revocation', 'outcome_fact_binding', 'outcome_fact_stream',
  'outcome_obligation_event', 'outcome_obligation_reduction', 'outcome_obligation_revision',
  'outcome_obligation_successor', 'outcome_obsolete_obligation', 'outcome_proof_obsolescence',
  'outcome_proof_successor', 'outcome_reconcile_request',
  'outcome_current_evaluation_projection', 'outcome_current_evaluator_result',
  'outcome_current_reconcile_request', 'outcome_obligation_successor_set',
];

const DROPPED_FUNCTIONS = [
  'outcome_authority_revocation_invalidates_reduction', 'outcome_binding_changed_fields',
  'outcome_binding_invalidators', 'outcome_binding_transition_record', 'outcome_commit_evaluation',
  'outcome_commit_evaluation_v1', 'outcome_enqueue_reconcile_request',
  'outcome_ingest_canonical_fact', 'outcome_jsonb_exact_keys',
  'outcome_matching_fact_invalidates_reduction', 'outcome_obsolete_current_reduction',
  'outcome_operational_read_surface', 'outcome_publish_evaluation_projection',
  'outcome_read_delivery_evidence', 'outcome_read_evaluation_cut',
  'outcome_record_delivery_attestation', 'outcome_record_delivery_verification',
  'outcome_register_authority_grant', 'outcome_register_delivery_binding',
  'outcome_register_fact_binding', 'outcome_replay_fact_set_digest',
  'outcome_revoke_authority_grant', 'outcome_seal_evaluation_cut', 'project_canonical_done_gate',
  'project_canonical_done_gate_projection_integrity_body',
];

/**
 * A project with one stated criterion and one evidence version, ready to go DONE.
 *
 * The run row is written in its final shape rather than mutated afterwards, because
 * `project_acceptance_run_immutable_guard` refuses to rewrite a concluded run — which is itself one
 * of the walls this removal must not have knocked down.
 */
async function seedAcceptedProject(client: Client, label: string, run: {
  verdict?: 'PASS' | 'FAIL'; superseded?: boolean; conclusion?: 'PASS' | 'FAIL';
} = {}): Promise<{ ownerId: string; projectId: string; runId: string }> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const definitionId = randomUUID();
  await client.query(
    `INSERT INTO "user" ("id","email","password_hash","name")
     VALUES ($1,$2,'x','removal fixture')`,
    [ownerId, `${label}-${ownerId}@example.test`],
  );
  await client.query(
    `INSERT INTO "project" ("id","owner_id","title","goal","status","updated_at")
     VALUES ($1,$2,$3,'prove the gate still decides','OPEN'::"project_status",now())`,
    [projectId, ownerId, `removal ${label}`],
  );
  await client.query(
    `INSERT INTO "project_acceptance_criterion_definition"
       ("id","project_id","ordinal","text","verification_method","completion_criterion",
        "content_hash","semantic_hash","evaluation_plan_hash","created_at","updated_at")
     VALUES ($1,$2,1,'The gate still decides','a judgment reads the gate',
             'EVIDENCE_JUDGMENT'::"task_completion_criterion",$3,$4,$5,now(),now())`,
    [definitionId, projectId, 'a'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
  );
  // `project_acceptance_definition_digest` is the digest the 0172 trigger writes to
  // `project.acceptance_criteria_digest`, and the one 0182's gate compares `criteria_revision`
  // against. The proposal channel's own set-digest helper used to be read here; 0223 dropped it
  // with the rest of that channel, and it was never the value this gate compares.
  const criteriaDigest = (await client.query(
    'SELECT project_acceptance_definition_digest($1::uuid) AS digest', [projectId],
  )).rows[0].digest as string;
  await client.query(
    `UPDATE "project" SET "acceptance_criteria_digest" = $2 WHERE "id" = $1::uuid`,
    [projectId, criteriaDigest],
  );
  // Criterion results and conclusions carry the key; the definition itself is matched by
  // (definition_id, revision), which is what `project_acceptance_standing` joins on.
  const criterionKey = 'the-gate-still-decides';
  await client.query(
    `INSERT INTO "project_acceptance_run"
       ("id","project_id","attempt","criteria_snapshot","criteria_revision","input_digest",
        "result_digest","verdict","decided_by","digest_version","acceptance_epoch",
        "completed_at","superseded_at","superseded_reason","created_at")
     VALUES ($1,$2,1,'[]'::jsonb,$3,$4,$5,$6::"project_acceptance_verdict",
             'COORDINATOR_AGENT',4,0,now(),$7,$8,now())`,
    [runId, projectId, criteriaDigest, 'b'.repeat(64), 'c'.repeat(64),
      run.verdict ?? 'PASS',
      run.superseded ? new Date() : null,
      run.superseded ? 'a newer evidence version replaced it' : null],
  );
  await client.query(
    `INSERT INTO "project_acceptance_criterion"
       ("id","run_id","project_id","ordinal","criterion_key","criterion_text","definition_id",
        "definition_revision","verdict","created_at")
     VALUES ($1,$2,$3,1,$4,'The gate still decides',$5,1,
             $6::"project_acceptance_verdict",now())`,
    [randomUUID(), runId, projectId, criterionKey, definitionId, run.conclusion ?? 'PASS'],
  );
  await client.query(
    `INSERT INTO "project_acceptance_conclusion"
       ("id","project_id","evidence_run_id","evidence_version","ordinal","criterion_key",
        "criterion_text","definition_id","definition_revision","verdict","decided_by",
        "decided_by_id","decided_at")
     VALUES ($1,$2,$3,1,1,$4,'The gate still decides',$5,1,
             $6::"project_acceptance_verdict",'USER',$7,now())`,
    [randomUUID(), projectId, runId, criterionKey, definitionId,
      run.conclusion ?? 'PASS', ownerId],
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

// (a) ---------------------------------------------------------------------------------------------
suite('(a) the installed database has no obligation algebra, canonical gate or delivery attestation',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });

    const schema = await client.query(
      `SELECT nspname FROM pg_namespace WHERE nspname = 'outcome_projection'`);
    assert.deepEqual(schema.rows, [], 'the shadow projection schema and everything in it must be gone');

    const relations = await client.query(`
      SELECT n.nspname || '.' || c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','v','m','S')
         AND n.nspname NOT IN ('pg_catalog','information_schema')
         AND c.relname = ANY($1::text[])
       ORDER BY 1`, [DROPPED_TABLES]);
    assert.deepEqual(relations.rows, []);

    const functions = await client.query(`
      SELECT n.nspname || '.' || p.proname AS name
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')
         AND p.proname = ANY($1::text[])
       ORDER BY 1`, [DROPPED_FUNCTIONS]);
    assert.deepEqual(functions.rows, []);

    // Nothing that survives may still name what is gone: a stored body is exactly the raw SQL a
    // compiler cannot see.
    const dangling = await client.query(`
      SELECT n.nspname || '.' || p.proname AS name
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')
         AND p.prosrc ~ '(outcome_fact_stream|outcome_fact_binding|outcome_canonical_fact|outcome_evaluation_cut|outcome_evaluator_result|outcome_active_obligation|outcome_obligation_revision|outcome_delivery_|outcome_projection[.]|project_canonical_done_gate)'
       ORDER BY 1`);
    assert.deepEqual(dangling.rows, []);

    // 0196 widened a table that stays. The widening goes with it rather than being left as three
    // permanently-null columns nothing can ever populate.
    const intent = await client.query(`
      SELECT a.attname FROM pg_attribute a
       WHERE a.attrelid = 'project_ratified_action_intent'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname`);
    const names = intent.rows.map((row) => row.attname as string);
    assert.equal(names.includes('outcome_binding_digest'), false);
    assert.equal(names.includes('outcome_binding_epoch'), false);
    assert.ok(names.includes('contract_revision'),
      "0218's surviving _v1 action bodies still compare the contract revision");

    // The five shared 0194 helpers stay, because the subsystems this task must not break use them.
    const helpers = await client.query(`
      SELECT proname FROM pg_proc
       WHERE proname IN ('outcome_append_only_guard','outcome_sha256_json','outcome_canonical_json',
                         'outcome_canonical_number','outcome_valid_digest')
       ORDER BY 1`);
    assert.deepEqual(helpers.rows.map((row) => row.proname), [
      'outcome_append_only_guard', 'outcome_canonical_json', 'outcome_canonical_number',
      'outcome_sha256_json', 'outcome_valid_digest',
    ]);
  });

// (f) ---------------------------------------------------------------------------------------------
suite('(f) the four project triggers keep their names, their subjects and their firing order',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });

    const triggers = await client.query(`
      SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t
       WHERE t.tgrelid = 'project'::regclass AND NOT t.tgisinternal
         AND t.tgname LIKE 'project\\_acceptance\\_%'
       ORDER BY t.tgname`);
    assert.deepEqual(triggers.rows.map((row) => row.tgname), [
      'project_acceptance_advance_epoch',
      'project_acceptance_criteria_fact',
      'project_acceptance_done_gate',
      'project_acceptance_epoch_audit',
    ], "0197's project_acceptance_done_insert_gate is the only one that goes");

    const byName = new Map(triggers.rows.map((row) => [row.tgname as string, row.def as string]));
    assert.match(byName.get('project_acceptance_advance_epoch')!, /BEFORE UPDATE ON public\.project/);
    assert.match(byName.get('project_acceptance_done_gate')!,
      /BEFORE UPDATE OF status, accepted_run_id ON public\.project/);
    assert.match(byName.get('project_acceptance_epoch_audit')!, /AFTER UPDATE ON public\.project/);
    assert.match(byName.get('project_acceptance_criteria_fact')!,
      /AFTER INSERT OR UPDATE OF acceptance_criteria ON public\.project/);

    // The names are load-bearing: PostgreSQL fires BEFORE ROW triggers in alphabetical order, and
    // `..._advance_epoch` sorting before `..._done_gate` is what pins the epoch the gate reads.
    assert.ok('project_acceptance_advance_epoch' < 'project_acceptance_done_gate');

    // And the gate is once more the acceptance body, not a delegation to a canonical one.
    const body = (await client.query(
      `SELECT prosrc FROM pg_proc WHERE proname = 'project_acceptance_done_gate'`)).rows[0].prosrc;
    assert.match(body, /project_acceptance_run/);
    assert.match(body, /ACCEPTANCE_MISSING/);
    assert.match(body, /ACCEPTANCE_EVIDENCE_STALE/);
    assert.doesNotMatch(body, /project_canonical_done_gate|obligation/i);
  });

// (g)(h)(i)(j)(k) -----------------------------------------------------------------------------------
suite('(g)-(k) the 0150 acceptance DONE gate still decides, positively and negatively',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });
    const seeded = await seedAcceptedProject(client, 'gate');

    // (g) no accepted_run_id at all.
    assert.match(
      await refusal(client, `UPDATE "project" SET "status" = 'DONE' WHERE "id" = $1::uuid`,
        [seeded.projectId]),
      /ACCEPTANCE_MISSING/);

    // (h) an acceptance run that did not conclude PASS. What "did not PASS" means after 0179 is the
    // append-only conclusion projection, not the run's immutable `verdict` summary column: a run
    // that says FAIL can have a current projection in which every criterion is PASS because a later
    // event refuted the failure, and reading the summary would make that project unclosable behind
    // a row nothing may rewrite. So the fixture states the non-PASS as the model states it.
    const failed = await seedAcceptedProject(client, 'gate-fail',
      { verdict: 'FAIL', conclusion: 'FAIL' });
    assert.match(
      await refusal(client,
        `UPDATE "project" SET "status" = 'DONE', "accepted_run_id" = $2::uuid WHERE "id" = $1::uuid`,
        [failed.projectId, failed.runId]),
      /ACCEPTANCE_MISSING/);

    // And the converse, which is the reason the summary is not the input: a run whose summary is
    // FAIL but whose current projection is all PASS still closes the project.
    const refuted = await seedAcceptedProject(client, 'gate-refuted', { verdict: 'FAIL' });
    await client.query(
      `UPDATE "project" SET "status" = 'DONE', "accepted_run_id" = $2::uuid WHERE "id" = $1::uuid`,
      [refuted.projectId, refuted.runId]);
    assert.equal((await client.query(
      `SELECT "status"::text AS status FROM "project" WHERE "id" = $1::uuid`, [refuted.projectId],
    )).rows[0].status, 'DONE');

    // (i) an acceptance run that was superseded.
    const stale = await seedAcceptedProject(client, 'gate-stale', { superseded: true });
    assert.match(
      await refusal(client,
        `UPDATE "project" SET "status" = 'DONE', "accepted_run_id" = $2::uuid WHERE "id" = $1::uuid`,
        [stale.projectId, stale.runId]),
      /ACCEPTANCE_EVIDENCE_STALE/);

    // (j) the bypass the 0150 alphabetical-order comment names: writing the epoch in the same
    // statement that writes DONE. `project_acceptance_advance_epoch` sorts first and pins the
    // value the gate then reads, so a hand-written 0 does not become the epoch it compares.
    assert.match(
      await refusal(client,
        `UPDATE "project" SET "status" = 'DONE', "acceptance_epoch" = 0 WHERE "id" = $1::uuid`,
        [seeded.projectId]),
      /ACCEPTANCE_MISSING|ACCEPTANCE_EVIDENCE_STALE/);
    assert.equal((await client.query(
      `SELECT "status"::text AS status FROM "project" WHERE "id" = $1::uuid`, [seeded.projectId],
    )).rows[0].status, 'OPEN', 'the bypass left the project OPEN');

    // (k) a PASS run that belongs to the project and was not superseded still closes it.
    await client.query(
      `UPDATE "project" SET "status" = 'DONE', "accepted_run_id" = $2::uuid WHERE "id" = $1::uuid`,
      [seeded.projectId, seeded.runId]);
    const settled = (await client.query(
      `SELECT "status"::text AS status, "accepted_run_id"::text AS run
         FROM "project" WHERE "id" = $1::uuid`, [seeded.projectId])).rows[0];
    assert.deepEqual(settled, { status: 'DONE', run: seeded.runId });
  });

// (l)(m)(n) -----------------------------------------------------------------------------------------
suite('(l)-(n) the acceptance standard set itself is untouched and still concludes',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });

    for (const table of ['project_acceptance_criterion_definition', 'project_acceptance_criterion',
      'project_acceptance_conclusion', 'project_acceptance_run', 'project_acceptance_audit',
      'project_acceptance_criteria_confirmation']) {
      assert.equal((await client.query(
        `SELECT to_regclass($1)::text AS name`, [table])).rows[0].name, table);
    }
    // (l)(m) the columns a stated criterion, a criterion result and a conclusion are made of.
    const columns = async (table: string) => (await client.query(`
      SELECT a.attname FROM pg_attribute a
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attname`, [table])).rows.map((row) => row.attname as string);
    for (const field of ['text', 'verification_method', 'completion_criterion', 'revision',
      'content_hash']) {
      assert.ok((await columns('project_acceptance_criterion_definition')).includes(field), field);
    }
    for (const field of ['criterion_key', 'criterion_text', 'verdict', 'definition_id',
      'definition_revision']) {
      assert.ok((await columns('project_acceptance_criterion')).includes(field), field);
    }
    for (const field of ['verdict', 'decided_by', 'decided_by_id', 'decided_at',
      'evidence_version']) {
      assert.ok((await columns('project_acceptance_conclusion')).includes(field), field);
    }

    // (n) one stated criterion still reaches a PASS conclusion through the derivation the run
    // closure owns, with the canonical gate no longer folded into it.
    const seeded = await seedAcceptedProject(client, 'standing');
    const standing = await client.query(
      'SELECT * FROM project_acceptance_standing($1::uuid, 1::bigint)', [seeded.projectId]);
    assert.equal(standing.rows.length, 1);
    assert.equal(standing.rows[0].verdict, 'PASS');
    const derived = (await client.query(
      'SELECT project_acceptance_run_derive_conclusion($1::uuid) AS result', [seeded.runId],
    )).rows[0].result;
    assert.equal(derived.verdict, 'PASS');
    assert.equal(derived.concludable, true);
    assert.equal(derived.doneGate, undefined,
      'the run conclusion no longer folds a canonical gate into its digest');
    assert.match(derived.conclusionDigest, /^[0-9a-f]{64}$/);
  });

// (o)(p)(q)(r) --------------------------------------------------------------------------------------
suite('(o)-(r) the machinery beside this removal is intact and still writable', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  // (o) the EXECUTABLE admission/attempt ledger.
  for (const table of ['task_executable_admission', 'task_executable_attempt',
    'task_executable_diagnosis']) {
    assert.equal((await client.query(
      `SELECT to_regclass($1)::text AS name`, [table])).rows[0].name, table);
  }
  // (p) stood here: the failure continuation and successor tables, which this removal was told not
  // to touch and did not. Migration 0226 removed them — a different, later decision about the
  // failure router — so there is no relation left to count. What 0222 does to them is still
  // asserted where it belongs, in `canonical-done-gate-removal.spec.ts`, over 0222's frozen text.

  // (r) the 0193 writer fence, which names none of this and stays.
  assert.equal((await client.query(`
    SELECT count(*)::int AS count FROM pg_trigger
     WHERE NOT tgisinternal AND tgname = 'task_done_canonical_writer_fence'`)).rows[0].count, 1);

  // (q) an ordinary task/session/run_event write still commits, and (o) the twelve append-only
  // triggers that borrowed 0194's guard still refuse a rewrite.
  const seeded = await seedAcceptedProject(client, 'core-writes');
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  await client.query(
    `INSERT INTO "runner" ("id","owner_id","name","token_hash","status","max_concurrent",
                           "last_heartbeat_at","capabilities","capabilities_reported_at")
     VALUES ($1,$2,'removal runner',$3,'ONLINE'::"runner_status",4,now(),'{}',now())`,
    [runnerId, seeded.ownerId, `removal-${runnerId}`]);
  await client.query(
    `INSERT INTO "workspace" ("id","owner_id","runner_id","name","enabled")
     VALUES ($1,$2,$3,'removal workspace',true)`, [workspaceId, seeded.ownerId, runnerId]);
  await client.query(
    `INSERT INTO "task" ("id","owner_id","project_id","assignee_id","title","creator_type",
                         "creator_id","provider","status","updated_at")
     VALUES ($1,$2,$3,$4,'removal task','USER'::"creator_type",$2,'claude',
             'OPEN'::"task_status",now())`,
    [taskId, seeded.ownerId, seeded.projectId, workspaceId]);
  await client.query(
    `INSERT INTO "session" ("id","owner_id","creator_id","task_id","workspace_id",
                            "assigned_runner_id","title","prompt","provider","status","updated_at")
     VALUES ($1,$2,$2,$3,$4,$5,'removal session','run it','claude','PENDING'::"run_status",now())`,
    [sessionId, seeded.ownerId, taskId, workspaceId, runnerId]);
  await client.query(
    `INSERT INTO "run_event" ("id","session_id","seq","type","payload")
     VALUES ($1,$2,1,'assistant','{"text":"still writing"}'::jsonb)`,
    [randomUUID(), sessionId]);
  assert.equal((await client.query(
    `SELECT count(*)::int AS count FROM "run_event" WHERE "session_id" = $1::uuid`, [sessionId],
  )).rows[0].count, 1);

  const guarded = await client.query(`
    SELECT c.relname || '.' || t.tgname AS name
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND p.proname = 'outcome_append_only_guard'
     ORDER BY 1`);
  // Six after migration 0226 took the failure family's six with it: the two on
  // `task_executable_*` and the four on the `executable_runtime_*` / dead-man liveness wall. The
  // point of the assertion is unchanged — 0222 kept 0194's shared guard because subsystems it may
  // not touch fire it — so it is named exactly rather than counted loosely.
  assert.deepEqual(guarded.rows.map((row) => row.name), [
    'executable_dead_man_event.executable_dead_man_event_append_only',
    'executable_runtime_expectation.executable_runtime_expectation_append_only',
    'executable_runtime_expectation_event.executable_runtime_expectation_event_append_only',
    'executable_runtime_heartbeat.executable_runtime_heartbeat_append_only',
    'task_executable_attempt.task_executable_attempt_no_delete',
    'task_executable_diagnosis.task_executable_diagnosis_append_only',
  ], 'the shared append-only guard is what task_executable_* and executable_runtime_* rely on');
});
