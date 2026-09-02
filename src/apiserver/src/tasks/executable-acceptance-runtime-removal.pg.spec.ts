import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  PrismaClient,
  ProjectStatus,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
  TaskVerdict,
} from '@prisma/client';
import { RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * The server half of the 0227 removal, against a real PostgreSQL that replayed every migration.
 *
 * `executable-acceptance-runtime-removal.spec.ts` reads the migration text; this reads the catalog
 * and then drives the paths the text cannot speak for. They can disagree — a `CREATE OR REPLACE`
 * in a later file, a cascade nobody named — and only the server settles which is describing the
 * database that actually exists.
 *
 * The positive half is what matters most here, because this removal takes the DONE fence's
 * EXECUTABLE branch away: an EXECUTABLE task must still reach DONE on a matching exit code and
 * FAILED on any other, through the lane 0177 and 0181 provide, with the failing run's exit code
 * and complete output still readable afterwards. Everything the removal was told not to touch —
 * VERIFICATION, the project DONE gate, ordinary task/session/run_event writes — is driven too.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const RUN = randomUUID().slice(0, 8);

const DROPPED_RELATIONS = [
  'task_executable_admission',
  'task_executable_attempt',
  'task_executable_backfill_batch',
  'task_executable_backfill_item',
  'task_executable_continuation',
  'task_executable_diagnosis',
];

const DROPPED_FUNCTIONS = [
  'executable_acceptance_import_bootstrap_legacy_timeout',
  'executable_acceptance_mark_stale_attempts',
  'executable_acceptance_plan_digest',
  'n19_fineweb_executable_backfill_step',
  'n19_fineweb_executable_classify',
  'n19_fineweb_executable_inventory',
  'n19_fineweb_executable_prepare',
  'n19_fineweb_executable_rollback_step',
  'project_acceptance_run_closure_guard',
  'project_acceptance_run_conclude',
  'project_acceptance_run_derive_conclusion',
  'project_acceptance_run_stalled_obligations',
  'project_acceptance_run_state_value',
  'project_acceptance_run_states',
  'task_executable_admission_immutable_guard',
  'task_executable_attempt_start_guard',
  'task_executable_attempt_termination_guard',
  'task_executable_plan_bind',
];

const DROPPED_TYPES = [
  'executable_acceptance_admission_decision',
  'executable_acceptance_continuation_kind',
  'executable_acceptance_legacy_termination',
  'executable_acceptance_termination_kind',
  'project_acceptance_run_conclusion_basis',
  'project_acceptance_run_obligation_kind',
  'project_acceptance_run_state',
];

/** 0141 and 0192's verification guards: ten triggers this removal may not touch. */
const VERIFICATION_TRIGGERS = [
  'task_judgment_verifier_delete_guard',
  'task_judgment_verifier_terminal_guard',
  'task_open_verification_request_carrier_guard',
  'task_verification_carrier_status_derive_insert',
  'task_verification_carrier_status_derive_update',
  'task_verification_verdict_atomic_insert',
  'task_verification_verdict_atomic_update',
];

/**
 * 0150 and 0172's four project triggers, in the order PostgreSQL fires BEFORE ROW triggers: by
 * name. `..._advance_epoch` must stay ahead of `..._done_gate`, because the gate compares the
 * epoch the advance pinned. Renaming either one silently reorders them.
 */
const PROJECT_ACCEPTANCE_TRIGGERS = [
  'project_acceptance_advance_epoch',
  'project_acceptance_criteria_fact',
  'project_acceptance_done_gate',
  'project_acceptance_epoch_audit',
];

function publishes(): RealtimeService {
  return new Proxy({}, {
    get: (_target, name) => (name === 'waitForInbox' ? async () => undefined : () => undefined),
  }) as unknown as RealtimeService;
}

function tasksService(db: PrismaClient): TasksService {
  const prisma = db as unknown as PrismaService;
  return new TasksService(
    prisma,
    new SessionsService(
      prisma,
      { notifySessionQueued: () => undefined } as unknown as QueueService,
      publishes(),
    ),
    publishes(),
  );
}

function controller(db: PrismaClient): RunnerApiController {
  const prisma = db as unknown as PrismaService;
  return new RunnerApiController(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes(),
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
  );
}

async function connectSql(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function empty(sql: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(`
    TRUNCATE "run_event", "conversation_turn", "task", "session", "workspace", "runner",
             "project_runtime", "project", "user" RESTART IDENTITY CASCADE
  `);
}

async function owner(db: PrismaClient, label: string) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${RUN}-${ownerId}@removal.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: `${label}-project` } });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, runnerId, workspaceId, projectId };
}

interface Delivered {
  turnId: string;
  kind: string;
  content?: string;
  taskAcceptance?: boolean;
}

/** Run one EXECUTABLE task end to end and return the status the exit code derived. */
async function runAcceptance(
  db: PrismaClient,
  w: { ownerId: string; runnerId: string; workspaceId: string; projectId: string },
  label: string,
  command: string,
  expectedExitCode: number,
  reportedExitCode: number,
  shellOutput: string,
): Promise<{ taskId: string; status: TaskStatus }> {
  const api = controller(db);
  const declared = await tasksService(db).create(w.ownerId, {
    title: label,
    assigneeId: w.workspaceId,
    projectId: w.projectId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The declared shell command exits with the expected code.',
    acceptanceCommand: command,
    acceptanceExpectedExitCode: expectedExitCode,
  });
  assert.equal(declared.status, TaskStatus.OPEN);
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId: declared.id,
      workspaceId: w.workspaceId, assignedRunnerId: w.runnerId, title: label, prompt: label,
      provider: 'claude', status: RunStatus.RUNNING, engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
    },
  });
  await db.conversationTurn.create({
    data: {
      id: messageTurnId, sessionId, seq: 1, clientTurnId: `message:${messageTurnId}`,
      kind: 'message', content: 'do the work', status: 'IN_FLIGHT',
    },
  });
  // Finishing the agent's own turn is what mints the one reserved acceptance shell turn.
  await api.turnComplete({ id: w.runnerId } as never, sessionId, {
    turnId: messageTurnId, status: SharedRunStatus.SUCCEEDED,
  } as never);
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: declared.id } })).status,
    TaskStatus.OPEN,
    'a finished agent turn does not settle the task by itself',
  );
  const delivered = await (api as unknown as {
    dequeueTurn: (
      sessionId: string, runnerId: string, leaseGeneration: string | null, acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ) => Promise<Delivered | null>;
  }).dequeueTurn(sessionId, w.runnerId, null, false, []);
  assert.ok(delivered, 'the acceptance command must be delivered');
  assert.equal(delivered.kind, 'shell');
  assert.equal(delivered.taskAcceptance, true);
  assert.equal(delivered.content, command);
  await api.turnComplete({ id: w.runnerId } as never, sessionId, {
    turnId: delivered.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'shell',
    shellExitCode: reportedExitCode,
    shellOutput,
  } as never);
  const settled = await db.task.findUniqueOrThrow({ where: { id: declared.id } });
  return { taskId: declared.id, status: settled.status };
}

// (a) ----------------------------------------------------------------------------------------------
suite('(a) the installed database has none of the relations, functions or types 0227 removes',
  async (t) => {
    const client = await connectSql();
    t.after(async () => { await client.end(); });

    const relations = (await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m')
          AND c.relname LIKE 'task\\_executable\\_%'
        ORDER BY 1`)).rows.map((row) => row.name);
    // 0181's recorded command result was the one member of this family this removal left behind.
    // 0228 took it the same day, with the rest of the judgment machinery, so the family is empty.
    assert.deepEqual(relations, []);
    for (const name of DROPPED_RELATIONS) {
      const present = await client.query(
        `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1`, [name]);
      assert.equal(present.rowCount, 0, `${name} must be gone`);
    }

    for (const name of DROPPED_FUNCTIONS) {
      const present = await client.query(
        `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1`, [name]);
      assert.equal(present.rowCount, 0, `${name} must be gone`);
    }
    for (const name of DROPPED_TYPES) {
      const present = await client.query(
        `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typname = $1`, [name]);
      assert.equal(present.rowCount, 0, `${name} must be gone`);
    }

    // No surviving body may reach for one either: plpgsql binds its callee at run time, so a
    // caller left behind compiles and then fails on first fire.
    const callers = (await client.query<{ name: string }>(`
      SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')
         AND (p.prosrc ~ 'task_executable_(admission|attempt|continuation|diagnosis|backfill)'
              OR p.prosrc ~ 'executable_acceptance_(plan_digest|mark_stale|import_bootstrap)'
              OR p.prosrc ~ 'project_acceptance_run_(conclude|derive_conclusion|state)'
              OR p.prosrc ~ 'n19_fineweb_executable')
       ORDER BY 1`)).rows.map((row) => row.name);
    assert.deepEqual(callers, [], `installed functions still reach for a dropped one: ${callers}`);

    // And every negotiation column with them.
    const columns = (await client.query<{ table: string; name: string }>(`
      SELECT table_name AS table, column_name AS name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'task' AND column_name IN (
                'acceptance_timeout_seconds', 'acceptance_owner_timeout_ceiling_seconds',
                'acceptance_policy_timeout_ceiling_seconds', 'acceptance_schema_revision',
                'acceptance_capability_revision', 'acceptance_command_digest',
                'acceptance_evaluation_plan_digest', 'execution_attempt_count'))
           OR (table_name = 'runner' AND column_name LIKE 'acceptance\\_runtime\\_%')
           OR (table_name = 'project_acceptance_run' AND column_name LIKE 'conclusion\\_%'))
       ORDER BY 1, 2`)).rows;
    assert.deepEqual(columns, [], `negotiation columns survive: ${JSON.stringify(columns)}`);
  });

// (d)(e)(f)(g) -------------------------------------------------------------------------------------
suite('(d)(e) 0141 and 0192 keep every verification guard', async (t) => {
  const client = await connectSql();
  t.after(async () => { await client.end(); });

  const installed = (await client.query<{ name: string }>(
    `SELECT t.tgname AS name FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY 1`,
    [VERIFICATION_TRIGGERS],
  )).rows.map((row) => row.name);
  assert.deepEqual(installed, [...VERIFICATION_TRIGGERS].sort());
});

suite('(f)(g) a VERIFICATION subject is still settled by a PASS and only by a PASS', async (t) => {
  const sql = await connectSql();
  const db = prismaClientFor(URL!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);
  const w = await owner(db, 'verification');
  const tasks = tasksService(db);

  const declare = async (title: string) => tasks.create(w.ownerId, {
    title,
    projectId: w.projectId,
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'VERIFICATION_PASSED',
    acceptanceCriteria: 'An independent verifier records PASS.',
  });
  const check = async (subjectId: string, title: string, verdict: TaskVerdict) => {
    const verifier = await tasks.create(w.ownerId, {
      title, projectId: w.projectId, verifiesTaskId: subjectId, completionCriterion: 'VERIFICATION',
    });
    await tasks.update(w.ownerId, verifier.id, { verdict });
    return verifier.id;
  };
  const statusOf = async (id: string) =>
    (await db.task.findUniqueOrThrow({ where: { id } })).status;

  // (g) the negative, on its own subject: a FAIL verdict concludes the verifier and leaves the
  // subject exactly where it was.
  const rejected = await declare('subject an independent check rejected');
  const failing = await check(rejected.id, '[VERIFY] rejected', TaskVerdict.FAIL);
  assert.equal(await statusOf(rejected.id), TaskStatus.OPEN, 'FAIL must not settle the subject');
  assert.equal(await statusOf(failing), TaskStatus.DONE, 'but it does conclude the verifier');

  // (f) the positive, on its own: an independent PASS still derives DONE for the subject.
  const accepted = await declare('subject an independent check passed');
  assert.equal(await statusOf(accepted.id), TaskStatus.OPEN);
  const passing = await check(accepted.id, '[VERIFY] accepted', TaskVerdict.PASS);
  assert.equal(await statusOf(accepted.id), TaskStatus.DONE,
    'an independent PASS still settles a VERIFICATION subject');
  assert.equal(await statusOf(passing), TaskStatus.DONE, 'and the carrier settles with it');
});

// (h)(i)(j)(k) -------------------------------------------------------------------------------------
suite('(h)(k) 0150/0172 keep their four triggers, their names and their firing order', async (t) => {
  const client = await connectSql();
  t.after(async () => { await client.end(); });

  const installed = (await client.query<{ name: string }>(
    `SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = 'project' AND t.tgname LIKE 'project\\_acceptance\\_%'
      ORDER BY t.tgname`)).rows.map((row) => row.name);
  assert.deepEqual(installed, PROJECT_ACCEPTANCE_TRIGGERS);
  // The whole point of the names: PostgreSQL fires BEFORE ROW triggers alphabetically, so the
  // advance has to sort before the gate that reads what it pinned.
  assert.ok(installed.indexOf('project_acceptance_advance_epoch')
    < installed.indexOf('project_acceptance_done_gate'));

  // (k) the run table itself is 0127's and stays; only 0215's closing move went.
  const run = await client.query(`SELECT to_regclass('project_acceptance_run')::text AS name`);
  assert.equal(run.rows[0].name, 'project_acceptance_run');
  const guards = (await client.query<{ name: string }>(
    `SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = 'project_acceptance_run' ORDER BY 1`))
    .rows.map((row) => row.name);
  assert.deepEqual(guards,
    ['project_acceptance_run_epoch_guard', 'project_acceptance_run_immutable_guard']);

  // (p) the three protected acceptance relations are here and writable — the removal issues no
  // statement against them (proved over its text in the other half of this suite).
  for (const table of ['project_acceptance_criterion_definition', 'project_acceptance_criterion',
    'project_acceptance_conclusion']) {
    const present = await client.query(`SELECT to_regclass($1)::text AS name`, [table]);
    assert.equal(present.rows[0].name, table, `${table} must still exist`);
  }
});

suite('(i)(j) the project DONE gate still refuses a hand-written DONE and still admits a real one',
  async (t) => {
    const sql = await connectSql();
    const db = prismaClientFor(URL!);
    t.after(async () => { await db.$disconnect(); await sql.end(); });
    await empty(sql);
    const w = await owner(db, 'done-gate');

    // (i) the negative: a direct status write with a zero epoch and no accepted run is refused by
    // the database, not by a service the caller could go around.
    await assert.rejects(
      sql.query(`UPDATE "project" SET "status" = 'DONE', "acceptance_epoch" = 0
                  WHERE "id" = $1::uuid`, [w.projectId]),
      /ACCEPTANCE_MISSING/,
      'the 0150 gate must still refuse a DONE with no evidence',
    );

    // (j) the positive: one stated criterion, one live run in the current epoch, one PASS
    // conclusion. 0215's `conclusion_basis` is gone, so the run has nothing to close with — what
    // the gate reads is the per-criterion projection, exactly as it did before 0215 added one.
    const definitionId = randomUUID();
    const runId = randomUUID();
    const criterionKey = 'the-gate-still-decides';
    await sql.query(
      `INSERT INTO "project_acceptance_criterion_definition"
         ("id","project_id","ordinal","text","verification_method","completion_criterion",
          "content_hash","semantic_hash","evaluation_plan_hash","created_at","updated_at")
       VALUES ($1,$2,1,'The gate still decides','a judgment reads the gate',
               'EVIDENCE_JUDGMENT'::"task_completion_criterion",$3,$4,$5,now(),now())`,
      [definitionId, w.projectId, 'a'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
    );
    const criteriaDigest = (await sql.query(
      'SELECT project_acceptance_definition_digest($1::uuid) AS digest', [w.projectId],
    )).rows[0].digest as string;
    await sql.query(
      `UPDATE "project" SET "acceptance_criteria_digest" = $2 WHERE "id" = $1::uuid`,
      [w.projectId, criteriaDigest],
    );
    await sql.query(
      `INSERT INTO "project_acceptance_run"
         ("id","project_id","attempt","criteria_snapshot","criteria_revision","input_digest",
          "result_digest","verdict","decided_by","digest_version","acceptance_epoch",
          "completed_at","created_at")
       VALUES ($1,$2,1,'[]'::jsonb,$3,$4,$5,'PASS'::"project_acceptance_verdict",
               'COORDINATOR_AGENT',4,0,now(),now())`,
      [runId, w.projectId, criteriaDigest, 'b'.repeat(64), 'c'.repeat(64)],
    );
    await sql.query(
      `INSERT INTO "project_acceptance_criterion"
         ("id","run_id","project_id","ordinal","criterion_key","criterion_text","definition_id",
          "definition_revision","verdict","created_at")
       VALUES ($1,$2,$3,1,$4,'The gate still decides',$5,1,
               'PASS'::"project_acceptance_verdict",now())`,
      [randomUUID(), runId, w.projectId, criterionKey, definitionId],
    );
    await sql.query(
      `INSERT INTO "project_acceptance_conclusion"
         ("id","project_id","evidence_run_id","evidence_version","ordinal","criterion_key",
          "criterion_text","definition_id","definition_revision","verdict","decided_by",
          "decided_by_id","decided_at")
       VALUES ($1,$2,$3,1,1,$4,'The gate still decides',$5,1,
               'PASS'::"project_acceptance_verdict",'USER',$6,now())`,
      [randomUUID(), w.projectId, runId, criterionKey, definitionId, w.ownerId],
    );
    await sql.query(
      `UPDATE "project" SET "status" = 'DONE', "accepted_run_id" = $2::uuid WHERE "id" = $1::uuid`,
      [w.projectId, runId],
    );
    assert.equal(
      (await db.project.findUniqueOrThrow({ where: { id: w.projectId } })).status,
      ProjectStatus.DONE,
      'a project whose stated criteria all PASS on a live run still reaches DONE',
    );
  });

// (u)(v) -------------------------------------------------------------------------------------------
suite('(u)(v) 0177 and 0181 survive byte for byte and stay writable', async (t) => {
  const sql = await connectSql();
  const db = prismaClientFor(URL!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  // (u) the two columns, with their exact types and nullability, and the CHECK that pairs them.
  const columns = (await sql.query<{ name: string; type: string; nullable: string }>(
    `SELECT column_name AS name, data_type AS type, is_nullable AS nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'task'
        AND column_name IN ('acceptance_command', 'acceptance_expected_exit_code')
      ORDER BY 1`)).rows;
  assert.deepEqual(columns, [
    { name: 'acceptance_command', type: 'text', nullable: 'YES' },
    { name: 'acceptance_expected_exit_code', type: 'integer', nullable: 'YES' },
  ]);
  const check = (await sql.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'task' AND c.conname = 'task_executable_acceptance_pair'`)).rows;
  assert.equal(check.length, 1, '0177\'s CHECK must still be installed');
  // Byte for byte, as the server renders it: the pair moves together, a command may not be blank,
  // and an EXECUTABLE declaration may not also be a verifier or a child-aggregating task.
  assert.equal(check[0].def,
    'CHECK ((((acceptance_command IS NULL) AND (acceptance_expected_exit_code IS NULL)) '
    + "OR ((acceptance_command IS NOT NULL) AND (btrim(acceptance_command) <> ''::text) "
    + 'AND (acceptance_expected_exit_code IS NOT NULL) '
    + "AND (completion_policy = 'MANUAL'::task_completion_policy) "
    + 'AND (verifies_task_id IS NULL))))');

  // (v) 0181's two relations were the evidence source this suite pointed at an hour before the
  // account owner had them removed as well (0228). What survives is the half they were kept FOR:
  // the declaration. A task still carries its command and expected exit code, and still refuses
  // half a pair.
  for (const gone of ['task_judgment_request', 'task_executable_judgment_result']) {
    const present = await sql.query(`SELECT to_regclass($1)::text AS name`, [gone]);
    assert.equal(present.rows[0].name, null, `${gone} was removed by 0228`);
  }
  const w = await owner(db, 'judgment-write');
  const result = await runAcceptance(
    db, w, 'writable', 'printf ok', 0, 0, 'ok',
  );
  assert.equal(result.status, TaskStatus.OPEN,
    'nothing derives a status from an exit code any more');
  const declared = await db.task.findUniqueOrThrow({ where: { id: result.taskId } });
  assert.equal(declared.acceptanceCommand, 'printf ok');
  assert.equal(declared.acceptanceExpectedExitCode, 0);
  assert.equal(declared.completionCriterion, 'EXECUTABLE');
});

// (x)(y) -------------------------------------------------------------------------------------------
suite('(x)(y) an EXECUTABLE task derives neither DONE nor FAILED, and keeps its declaration',
  async (t) => {
    const sql = await connectSql();
    const db = prismaClientFor(URL!);
    t.after(async () => { await db.$disconnect(); await sql.end(); });
    await empty(sql);
    const w = await owner(db, 'executable');

    // 0228 removed the comparison this suite was written around, at the account owner's
    // direction and one migration after this one. Both halves of it now answer the same way.

    // (x) a matching exit code derives nothing.
    const passed = await runAcceptance(
      db, w, 'exec-pass', 'test -f package.json', 0, 0, 'package.json is here',
    );
    assert.equal(passed.status, TaskStatus.OPEN,
      'exit 0 against expected 0 derives nothing: EXECUTABLE has no implementation');

    // (x) and so does any other code — the conservative FAILED went with the optimistic DONE.
    const failed = await runAcceptance(
      db, w, 'exec-fail', 'test -f absent.json', 0, 1, 'no such file\nline two',
    );
    assert.equal(failed.status, TaskStatus.OPEN);

    // (y) and the failing run is no longer diagnosable from a durable row: this is consequence 3
    // of the 2026-09-02 decision, accepted explicitly. One human-facing comment says so, and the
    // declaration the command came from is untouched.
    const declaration = await db.task.findUniqueOrThrow({ where: { id: failed.taskId } });
    assert.equal(declaration.acceptanceCommand, 'test -f absent.json');
    assert.equal(declaration.acceptanceExpectedExitCode, 0);
    assert.equal(await db.taskComment.count({ where: { taskId: failed.taskId } }), 1);

    // The DONE fence agrees from the database side: with the judgment lane gone too, a task with
    // no verification fact cannot be written DONE by hand.
    await assert.rejects(
      sql.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [failed.taskId]),
      /TASK_DONE_CANONICAL_FACT_REQUIRED/,
      'the 0193 fence must still refuse a DONE with no canonical fact',
    );
  });

// (l)(m)(n)(o) -------------------------------------------------------------------------------------
suite('(l)(m)(n)(o) ordinary task, session, run_event and child-row writes are unaffected',
  async (t) => {
    const sql = await connectSql();
    const db = prismaClientFor(URL!);
    t.after(async () => { await db.$disconnect(); await sql.end(); });
    await empty(sql);
    const w = await owner(db, 'ordinary');
    const tasks = tasksService(db);

    // (l) create, update, depend, supersede.
    const first = await tasks.create(w.ownerId, {
      title: 'ordinary first', projectId: w.projectId, assigneeId: w.workspaceId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    });
    const second = await tasks.create(w.ownerId, {
      title: 'ordinary second', projectId: w.projectId, assigneeId: w.workspaceId,
      completionCriterion: 'EVIDENCE_JUDGMENT', dependsOnTaskIds: [first.id],
    });
    await tasks.update(w.ownerId, second.id, { title: 'ordinary second, renamed' });
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: second.id } })).title,
      'ordinary second, renamed',
    );
    const replacement = await tasks.create(w.ownerId, {
      title: 'ordinary first, again', projectId: w.projectId, assigneeId: w.workspaceId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    });
    await tasks.update(w.ownerId, first.id, {
      status: 'CANCELLED', supersededByTaskId: replacement.id,
    } as never);
    const superseded = await db.task.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(superseded.supersededByTaskId, replacement.id);
    assert.equal(superseded.terminalReason, 'SUPERSEDED');
    assert.equal((await db.taskDependency.count({ where: { taskId: second.id } })), 1);

    // (m) session creation, its status transitions and the real dispatch door.
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId: replacement.id,
        workspaceId: w.workspaceId, assignedRunnerId: w.runnerId, title: 'work', prompt: 'work',
        provider: 'claude', status: RunStatus.PENDING,
        dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      },
    });
    for (const status of [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.RUNNING]) {
      assert.equal(
        (await db.session.update({ where: { id: sessionId }, data: { status } })).status, status);
    }
    await db.session.update({ where: { id: sessionId }, data: { deletedAt: new Date() } });
    const dispatched = await tasks.execute(w.ownerId, replacement.id) as
      { ok: boolean; sessionId?: string };
    assert.equal(dispatched.ok, true, `execute refused: ${JSON.stringify(dispatched)}`);
    assert.equal(
      (await db.session.findUniqueOrThrow({ where: { id: dispatched.sessionId! } })).startsTaskWork,
      true,
    );

    // (n) run_event.
    const event = await db.runEvent.create({
      data: {
        sessionId: dispatched.sessionId!, seq: 1, type: 'ASSISTANT',
        payload: { text: 'ordinary run event' },
      },
    });
    assert.equal(Number(event.seq), 1);
    assert.equal(event.type, 'ASSISTANT');

    // (o) the everyday children: a comment, a dependency and a merge receipt.
    const comment = await db.taskComment.create({
      data: {
        id: randomUUID(), taskId: replacement.id, authorType: 'USER', authorId: w.ownerId,
        body: 'ordinary comment',
      },
    });
    assert.equal(comment.body, 'ordinary comment');
    const receipt = await db.sessionMergeReceipt.create({
      data: {
        id: randomUUID(), ownerId: w.ownerId, sessionId: dispatched.sessionId!,
        taskId: replacement.id, projectId: w.projectId,
        result: 'MERGED', sourceBranch: 'ordinary', sourceSha: 'a'.repeat(40),
        targetBranch: 'main', targetShaBefore: 'b'.repeat(40), targetShaAfter: 'c'.repeat(40),
        recordedBy: 'RUNNER', idempotencyKey: `ordinary-${RUN}`,
      },
    });
    assert.equal(receipt.targetBranch, 'main');
  });

// (q) ----------------------------------------------------------------------------------------------
suite('(q) the core tables keep every trigger that predates this project', async (t) => {
  const client = await connectSql();
  t.after(async () => { await client.end(); });

  // Measured on origin/main at the start of this task and then reduced by exactly the one trigger
  // this removal takes off `task`. Only the tables this removal touched are counted: pinning a
  // table it never wrote on would make a sibling removal's work show up as a failure here.
  const counts = Object.fromEntries((await client.query<{ table: string; n: number }>(
    `SELECT c.relname AS table, count(*)::int AS n FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN ('task', 'session', 'run_event')
      GROUP BY 1 ORDER BY 1`)).rows.map((row) => [row.table, row.n]));
  assert.deepEqual(counts, { run_event: 1, session: 10, task: 27 });

  // And the one that went is named, so a reader can tell a removal from an accident.
  const gone = await client.query(
    `SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'task_executable_plan_bind'`);
  assert.equal(gone.rowCount, 0);
  // `session_dispatch_dependency_check` is 0200's too and stays: it is task dependency
  // resolution, not acceptance, and it gates every task-work session dispatch in the database.
  const kept = await client.query(
    `SELECT 1 FROM pg_trigger WHERE NOT tgisinternal
      AND tgname = 'session_dispatch_dependency_check'`);
  assert.equal(kept.rowCount, 1);
});

suite('the PostgreSQL target is a disposable database', async () => {
  const client = await connectSql();
  await client.end();
});
