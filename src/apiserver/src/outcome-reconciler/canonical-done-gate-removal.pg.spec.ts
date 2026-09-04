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
/**
 * A project with one authored criterion, and nothing that judges it.
 *
 * This used to seed an accepted project: a run, a per-run criterion verdict and a conclusion event,
 * so the 0150 gate had something to allow a DONE against. Migration 0229 removed all three tables
 * and the gate with them, so what a fixture can build now is the declaration.
 */
async function seedProject(client: Client, label: string): Promise<{
  ownerId: string; projectId: string; definitionId: string;
}> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const definitionId = randomUUID();
  await client.query(
    `INSERT INTO "user" ("id","email","password_hash","name")
     VALUES ($1,$2,'x','removal fixture')`,
    [ownerId, `${label}-${ownerId}@example.test`],
  );
  await client.query(
    `INSERT INTO "project" ("id","owner_id","title","goal","status","updated_at")
     VALUES ($1,$2,$3,'prove nothing decides any more','OPEN'::"project_status",now())`,
    [projectId, ownerId, `removal ${label}`],
  );
  await client.query(
    `INSERT INTO "project_acceptance_criterion_definition"
       ("id","project_id","ordinal","text","verification_method",
        "content_hash","semantic_hash","created_at","updated_at")
     VALUES ($1,$2,1,'The gate is gone','a person reads the criterion',
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
suite('(f) the four project triggers are gone too, by a later decision than this one',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });

    // 0222 removed 0197's `project_acceptance_done_insert_gate` and restored 0150's four. On
    // 2026-09-03 the account owner removed the whole project acceptance judgment, so migration
    // 0229 took those four as well. `project` now carries no acceptance trigger of any kind, and
    // 0150's load-bearing alphabetical firing order went with them — deliberately.
    const triggers = await client.query(`
      SELECT t.tgname
        FROM pg_trigger t
       WHERE t.tgrelid = 'project'::regclass AND NOT t.tgisinternal
         AND t.tgname LIKE 'project\\_acceptance\\_%'
       ORDER BY t.tgname`);
    assert.deepEqual(triggers.rows, []);

    // And neither gate function survives, under either name.
    const gates = await client.query(`
      SELECT proname FROM pg_proc
       WHERE proname IN ('project_acceptance_done_gate', 'project_canonical_done_gate')`);
    assert.deepEqual(gates.rows, []);
  });

// (g)(h)(i)(j)(k) -----------------------------------------------------------------------------------
suite('(g)-(k) nothing decides a project DONE: the write goes through, unconditionally',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });

    // Five cases used to be refused here — no accepted run, a non-PASS run, a superseded run, a
    // stale epoch, an open blocker. Every one of them is now the same case: a column write that
    // commits. Asserted positively rather than as five absent errors, because "no error was
    // raised" and "the statement did what it says" are different claims and only the second is
    // what the account owner asked for.
    for (const label of ['no-run', 'non-pass', 'superseded', 'stale-epoch', 'blocked']) {
      const seeded = await seedProject(client, label);
      const refused = await refusal(
        client, `UPDATE "project" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [seeded.projectId]);
      assert.equal(refused, '', `${label} was refused: ${refused}`);

      await client.query(
        `UPDATE "project" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [seeded.projectId]);
      assert.equal((await client.query(
        `SELECT "status"::text AS status FROM "project" WHERE "id" = $1::uuid`, [seeded.projectId],
      )).rows[0].status, 'DONE');

      // And the criterion it was never judged against is still stated, word for word.
      assert.equal((await client.query(
        `SELECT "text" FROM "project_acceptance_criterion_definition" WHERE "id" = $1::uuid`,
        [seeded.definitionId],
      )).rows[0].text, 'The gate is gone');
    }

    // The reverse door too: DONE back to OPEN, with nothing to acknowledge and no epoch to advance.
    const reopened = await seedProject(client, 'reopen');
    await client.query(
      `UPDATE "project" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [reopened.projectId]);
    await client.query(
      `UPDATE "project" SET "status" = 'OPEN' WHERE "id" = $1::uuid`, [reopened.projectId]);
    assert.equal((await client.query(
      `SELECT "status"::text AS status FROM "project" WHERE "id" = $1::uuid`, [reopened.projectId],
    )).rows[0].status, 'OPEN');
  });

// (l)(m)(n) -----------------------------------------------------------------------------------------
suite('(l)-(n) the acceptance standard set itself is untouched; the judging around it is gone',
  async (t) => {
    const client = await connect();
    t.after(async () => { await client.end(); });

    // The one relation that survived 0222, 0227, 0228 and 0229 in turn.
    assert.equal((await client.query(
      `SELECT to_regclass('project_acceptance_criterion_definition')::text AS name`,
    )).rows[0].name, 'project_acceptance_criterion_definition');
    for (const table of ['project_acceptance_criterion', 'project_acceptance_conclusion',
      'project_acceptance_run', 'project_acceptance_audit']) {
      assert.equal((await client.query(
        `SELECT to_regclass($1)::text AS name`, [table])).rows[0].name, null, table);
    }

    // (l)(m) the columns a stated criterion is made of. Migration 0233 took the four that wired a
    // criterion to the work serving it — a later and separate decision about which direction that
    // edge points — and 0234 then took the evaluation-plan lane those four fed. So what 0222 had
    // to leave alone is the declaration and its identity, and the six are asserted gone rather
    // than dropped from the list.
    const columns = (await client.query(`
      SELECT a.attname FROM pg_attribute a
       WHERE a.attrelid = 'project_acceptance_criterion_definition'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attname`)).rows.map((row) => row.attname as string);
    for (const field of ['text', 'verification_method', 'revision',
      'content_hash', 'semantic_hash']) {
      assert.ok(columns.includes(field), field);
    }
    for (const gone of ['completion_criterion', 'acceptance_command',
      'acceptance_expected_exit_code', 'evidence_task_id']) {
      assert.equal(columns.includes(gone), false, `${gone} was removed by migration 0233`);
    }
    for (const gone of ['evaluation_plan_revision', 'evaluation_plan_hash']) {
      assert.equal(columns.includes(gone), false, `${gone} was removed by migration 0234`);
    }

    // (n) a stated criterion is still normalized and hashed by the trigger 0229 kept, and there is
    // no standing function left to ask what it concluded.
    const seeded = await seedProject(client, 'standing');
    const stored = (await client.query(
      `SELECT "revision", "content_hash" FROM "project_acceptance_criterion_definition"
        WHERE "id" = $1::uuid`, [seeded.definitionId])).rows[0];
    assert.equal(stored.revision, 1);
    assert.notEqual(stored.content_hash, 'a'.repeat(64));
    assert.deepEqual((await client.query(
      `SELECT proname FROM pg_proc WHERE proname = 'project_acceptance_standing'`)).rows, []);
  });

// (o)(p)(q)(r) --------------------------------------------------------------------------------------
suite('(o)-(r) the machinery beside this removal is intact and still writable', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  // (o) stood here: the EXECUTABLE admission/attempt/diagnosis ledger, which this removal was
  // told not to touch and did not. Migration 0227 removed it — a different, later decision about
  // the acceptance runtime — so there is no relation left to look up. What 0222 does to it is
  // still asserted where it belongs, in `canonical-done-gate-removal.spec.ts`, over 0222's text.
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
  const seeded = await seedProject(client, 'core-writes');
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
  // Four after 0226 took the failure family's six and 0227 took the two on `task_executable_*`:
  // what is left is the `executable_runtime_*` / dead-man liveness wall. The point of the
  // assertion is unchanged — 0222 kept 0194's shared guard because subsystems it may not touch
  // fire it — so it is named exactly rather than counted loosely.
  assert.deepEqual(guarded.rows.map((row) => row.name), [
    'executable_dead_man_event.executable_dead_man_event_append_only',
    'executable_runtime_expectation.executable_runtime_expectation_append_only',
    'executable_runtime_expectation_event.executable_runtime_expectation_event_append_only',
    'executable_runtime_heartbeat.executable_runtime_heartbeat_append_only',
  ], 'the shared append-only guard is what executable_runtime_* relies on');
});
