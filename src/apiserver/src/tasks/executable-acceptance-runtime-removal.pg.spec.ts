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

/** 0141 and 0192's verification guards: the four triggers this removal may not touch. */
const VERIFICATION_TRIGGERS = [
  'task_verification_carrier_status_derive_insert',
  'task_verification_carrier_status_derive_update',
  'task_verification_verdict_atomic_insert',
  'task_verification_verdict_atomic_update',
];

/**
 * 0192's other three guards used to be on this list. They went on 2026-09-02 with 0228, because
 * each one reads `task_judgment_request`: `assert_verification_request_carrier_state` — which
 * `task_open_verification_request_carrier_guard` on `task` does nothing but call — is four EXISTS
 * clauses over that table. A guard that queries a dropped relation is not a guard, it is the next
 * production error. Named here so this suite still fails if one of them comes back.
 */
const VERIFICATION_TRIGGERS_REMOVED_BY_0228 = [
  'task_judgment_verifier_delete_guard',
  'task_judgment_verifier_terminal_guard',
  'task_open_verification_request_carrier_guard',
];

/**
 * 0150 and 0172's four project triggers. This list used to be an ORDER: PostgreSQL fires BEFORE ROW
 * triggers by name, and `..._advance_epoch` had to sort ahead of `..._done_gate` because the gate
 * compared the epoch the advance pinned. `0229_project_acceptance_judgment_removal` dropped all
 * four on the account owner's instruction, so the constraint is gone with the things it ordered and
 * the list survives only to be asserted empty.
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

  const named = async (names: readonly string[]) => (await client.query<{ name: string }>(
    `SELECT t.tgname AS name FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY 1`,
    [names],
  )).rows.map((row) => row.name);

  assert.deepEqual(await named(VERIFICATION_TRIGGERS), [...VERIFICATION_TRIGGERS].sort());
  assert.deepEqual(await named(VERIFICATION_TRIGGERS_REMOVED_BY_0228), []);
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
suite('(h)(k) 0227 named none of 0150/0172\'s four triggers, and 0229 removed all four', async (t) => {
  const client = await connectSql();
  t.after(async () => { await client.end(); });

  // 0227 left every one of these standing; `0229_project_acceptance_judgment_removal` — a later and
  // separate account-owner decision, which removed the project acceptance judgment whole — took all
  // four. The wall this suite guards is 0227's surgical reach, and the text proving 0227 issues no
  // statement against them is `executable-acceptance-runtime-removal.spec.ts`; what the catalog can
  // still say is that nothing named `project_acceptance_*` fires on `project` any more.
  const installed = (await client.query<{ name: string }>(
    `SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = 'project' AND t.tgname LIKE 'project\\_acceptance\\_%'
      ORDER BY t.tgname`)).rows.map((row) => row.name);
  for (const gone of PROJECT_ACCEPTANCE_TRIGGERS) {
    assert.equal(installed.includes(gone), false, `${gone} survives 0229`);
  }
  assert.deepEqual(installed, []);

  // (k) the run table was 0127's, and 0227 took only 0215's closing move from it — the guard, not
  // the table. 0229 took the table, its two remaining guards and the two relations beside it.
  for (const table of ['project_acceptance_run', 'project_acceptance_criterion',
    'project_acceptance_conclusion', 'project_acceptance_audit']) {
    const present = await client.query(`SELECT to_regclass($1)::text AS name`, [table]);
    assert.equal(present.rows[0].name, null, `${table} went with 0229`);
  }

  // (p) and the relation neither removal ever issued a statement against: the stated criteria, the
  // declarations that outlived every machine built to judge them.
  const definitions = await client.query(
    `SELECT to_regclass('project_acceptance_criterion_definition')::text AS name`);
  assert.equal(definitions.rows[0].name, 'project_acceptance_criterion_definition');
});

suite('(i)(j) 0227 left the DONE gate alone, and after 0229 there is no gate left to leave alone',
  async (t) => {
    const sql = await connectSql();
    const db = prismaClientFor(URL!);
    t.after(async () => { await db.$disconnect(); await sql.end(); });
    await empty(sql);
    const w = await owner(db, 'done-gate');

    // (i) what this asserted when 0227 landed: a hand-written DONE with no accepted run was refused
    // by the database with ACCEPTANCE_MISSING, and the point was that 0227 had not weakened it.
    // `0229_project_acceptance_judgment_removal` then removed the gate, the epoch and the accepted
    // run together, on the account owner's instruction. The same statement — minus the two columns
    // that no longer exist — now commits, and no service stands behind the database either.
    await sql.query(`UPDATE "project" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [w.projectId]);
    assert.equal(
      (await db.project.findUniqueOrThrow({ where: { id: w.projectId } })).status,
      ProjectStatus.DONE,
      'nothing refuses a hand-written DONE any more',
    );

    // (j) what 0227 was actually answerable for on this side, and what 0229 kept: the stated
    // criteria. A declaration still takes, still normalizes, and still reads back through the
    // projection the rest of the server uses. It is judged by nothing.
    const definitionId = randomUUID();
    await sql.query(
      `INSERT INTO "project_acceptance_criterion_definition"
         ("id","project_id","ordinal","text","verification_method","completion_criterion",
          "content_hash","semantic_hash","evaluation_plan_hash","created_at","updated_at")
       VALUES ($1,$2,1,'The declaration outlives the judgment','a reader reads it',
               'EVIDENCE_JUDGMENT'::"task_completion_criterion",$3,$4,$5,now(),now())`,
      [definitionId, w.projectId, 'a'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
    );
    const projection = (await sql.query<{ criteria: string }>(
      'SELECT project_acceptance_definition_projection($1::uuid) AS criteria', [w.projectId],
    )).rows[0].criteria;
    assert.equal(projection, '1. The declaration outlives the judgment');
    const digest = (await sql.query<{ digest: string }>(
      'SELECT project_acceptance_definition_digest($1::uuid) AS digest', [w.projectId],
    )).rows[0].digest;
    assert.match(digest, /^[0-9a-f]{64}$/);
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
  assert.equal(result.status, TaskStatus.DONE,
    'the exit code derives the status, with none of this migration\'s runtime in front of it');
  const declared = await db.task.findUniqueOrThrow({ where: { id: result.taskId } });
  assert.equal(declared.acceptanceCommand, 'printf ok');
  assert.equal(declared.acceptanceExpectedExitCode, 0);
  assert.equal(declared.completionCriterion, 'EXECUTABLE');
});

// (x)(y) -------------------------------------------------------------------------------------------
suite('(x)(y) an EXECUTABLE task derives its status from the exit code alone, and keeps its declaration',
  async (t) => {
    const sql = await connectSql();
    const db = prismaClientFor(URL!);
    t.after(async () => { await db.$disconnect(); await sql.end(); });
    await empty(sql);
    const w = await owner(db, 'executable');

    // The comparison this suite was written around was removed by 0228 and restored on
    // 2026-09-03. What THIS migration removed is the layer that used to sit in front of it — the
    // admission negotiation, the typed attempt, the continuation — and none of it came back. So
    // both halves are driven again, and what is asserted is that the naked comparison is enough.

    // (x) a matching exit code derives DONE, with no admission and no attempt row in the way.
    const passed = await runAcceptance(
      db, w, 'exec-pass', 'test -f package.json', 0, 0, 'package.json is here',
    );
    assert.equal(passed.status, TaskStatus.DONE,
      'exit 0 against expected 0 derives DONE, straight from the lease');

    // (x) and any other code derives the conservative FAILED, through the same one comparison.
    const failed = await runAcceptance(
      db, w, 'exec-fail', 'test -f absent.json', 0, 1, 'no such file\nline two',
    );
    assert.equal(failed.status, TaskStatus.FAILED);

    // (y) and the failing run is still not diagnosable from a durable row: this is consequence 3
    // of the 2026-09-02 decision, which restoring the comparison deliberately did not undo. No
    // attempt, no continuation, no comment — and the declaration the command came from is intact.
    const declaration = await db.task.findUniqueOrThrow({ where: { id: failed.taskId } });
    assert.equal(declaration.acceptanceCommand, 'test -f absent.json');
    assert.equal(declaration.acceptanceExpectedExitCode, 0);
    assert.equal(await db.taskComment.count({ where: { taskId: failed.taskId } }), 0);

    // The DONE fence from the database side. 0230 gave it an EXECUTABLE lane, because with
    // nothing recorded the declaration is the only fact it can check — so a task that HAS one is
    // admitted, and a task whose declaration was cleared is not. The wall that stops an actor
    // writing DONE by hand is `TasksService.update`, which refuses it for every criterion.
    await sql.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [failed.taskId]);
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: failed.taskId } })).status,
      TaskStatus.DONE,
    );
    await sql.query(
      `UPDATE "task" SET "status" = 'OPEN', "acceptance_command" = NULL,
              "acceptance_expected_exit_code" = NULL,
              "completion_criterion" = 'EVIDENCE_JUDGMENT'::"task_completion_criterion"
        WHERE "id" = $1::uuid`,
      [failed.taskId],
    );
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
  // this removal takes off `task` — and by the three 0228 takes off it the same day, which is why
  // 27 became 24. Only the tables these removals touched are counted: pinning a table neither
  // wrote on would make some third removal's work show up as a failure here.
  //
  // `session` went 10 -> 11 when 0231 added `session_source_freeze_guard` with the SOURCE
  // snapshot. That is an ADDITION by a sibling change, and this suite is about what THIS removal
  // subtracted, so the number moves and the claim does not: `task` is still 24 and `run_event`
  // still 1.
  const counts = Object.fromEntries((await client.query<{ table: string; n: number }>(
    `SELECT c.relname AS table, count(*)::int AS n FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN ('task', 'session', 'run_event')
      GROUP BY 1 ORDER BY 1`)).rows.map((row) => [row.table, row.n]));
  assert.deepEqual(counts, { run_event: 1, session: 11, task: 24 });

  // And every one that went is named, so a reader can tell a removal from an accident.
  for (const trigger of [
    'task_executable_plan_bind',                         // 0227, this removal
    'task_judgment_verifier_delete_guard',               // 0228
    'task_judgment_verifier_terminal_guard',             // 0228
    'task_open_verification_request_carrier_guard',      // 0228
  ]) {
    const gone = await client.query(
      `SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = $1`, [trigger]);
    assert.equal(gone.rowCount, 0, `${trigger} is still installed`);
  }
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
