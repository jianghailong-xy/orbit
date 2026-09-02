import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskCompletionCriterion,
  TaskCompletionPolicy,
} from '@prisma/client';
import { Client } from 'pg';

import { TRIGGER_WRITE_SOURCES } from '../common/db-write-inventory';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { manualRunnableTaskSql } from './manual-runnable-task-sql';
import { TasksService } from './tasks.service';

/**
 * The catalog half of the 0224 removal, against a real PostgreSQL that replayed every migration,
 * plus the positive half: the ordinary writes those triggers used to fire on.
 *
 * `verification-subject-guard-removal.spec.ts` reads the migration text; this reads the server.
 * They can disagree — a `CREATE OR REPLACE` in a later file, a cascade nobody named — and only the
 * server settles which of the two is describing the database that actually exists.
 *
 * The positive half is the part that matters most. Two of the three triggers sat on `session` and
 * fired on every task-work INSERT and on every status UPDATE; the third fired on `task`. Removing a
 * guard is not safe merely because the guard was a duplicate, so this drives the real service and
 * the real server and asserts the outcome.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const RUN = randomUUID().slice(0, 8);

/** The three triggers 0207 installed, and the two functions behind them. */
const DROPPED_TRIGGERS: ReadonlyArray<[string, string]> = [
  ['session', 'session_verification_subject_guard_insert'],
  ['session', 'session_verification_subject_guard_update'],
  ['task', 'task_verification_subject_live_session_guard'],
];
const DROPPED_FUNCTIONS = [
  'session_verification_subject_guard',
  'task_verification_subject_live_session_guard',
];

/**
 * The tables criterion (g) is about: the ones 0207 wrote on, plus the two beside them that every
 * ordinary session write touches. `project` is a core table but not one this removal goes near, and
 * a sibling removal landing on it must not fail this suite for something that is not this removal.
 */
const CORE_TABLES = ['conversation_turn', 'run_event', 'session', 'task'];

/** The Ready predicate every Run surface shares, spliced against the alias this file queries. */
const MANUAL_RUNNABLE = manualRunnableTaskSql('t');

const PROJECT_ACCEPTANCE_COLUMNS: Readonly<Record<string, string>> = {
  project_acceptance_audit:
    'id:uuid!, project_id:uuid!, kind:text!, run_id:uuid, reason:text, detail:jsonb!, created_at:timestamp(3) without time zone!',
  project_acceptance_conclusion:
    'id:uuid!, project_id:uuid!, evidence_run_id:uuid!, evidence_version:bigint!, ordinal:integer!, criterion_key:text!, criterion_text:text!, definition_id:uuid, definition_revision:integer, verdict:project_acceptance_verdict!, summary:text, evidence:jsonb!, evidence_task_id:uuid, evidence_session_id:uuid, decided_by:text!, decided_by_id:uuid!, acting_session_id:uuid, decided_at:timestamp(3) without time zone!, created_at:timestamp(3) without time zone!',
  project_acceptance_criteria_confirmation:
    'id:uuid!, project_id:uuid!, criteria_digest:character(64)!, confirmed_by_type:text!, confirmed_by_id:uuid!, acting_session_id:uuid, confirmed_at:timestamp(3) without time zone!, created_at:timestamp(3) without time zone!',
  project_acceptance_criterion:
    'id:uuid!, run_id:uuid!, project_id:uuid!, ordinal:integer!, criterion_key:text!, criterion_text:text!, verdict:project_acceptance_verdict, summary:text, evidence:jsonb!, evidence_task_id:uuid, evidence_session_id:uuid, decided_at:timestamp(3) without time zone, created_at:timestamp(3) without time zone!, definition_id:uuid, definition_revision:integer, completion_criterion:task_completion_criterion!, acceptance_command:text, acceptance_expected_exit_code:integer',
  project_acceptance_criterion_definition:
    'id:uuid!, project_id:uuid!, ordinal:integer!, text:text!, revision:integer!, content_hash:character(64)!, created_at:timestamp(3) without time zone!, updated_at:timestamp(3) without time zone!, verification_method:text!, completion_criterion:task_completion_criterion!, acceptance_command:text, acceptance_expected_exit_code:integer, evidence_task_id:uuid, completion_criterion_override_reason:text, semantic_revision:integer!, semantic_hash:character(64)!, evaluation_plan_revision:integer!, evaluation_plan_hash:character(64)!',
  project_acceptance_run:
    'id:uuid!, project_id:uuid!, attempt:bigint!, criteria_snapshot:text!, criteria_revision:character(64)!, input_digest:character(64)!, result_digest:character(64), verdict:project_acceptance_verdict, decided_by:text!, coordinator_agent_id:uuid, coordinator_session_id:uuid, project_action_id:uuid, superseded_at:timestamp(3) without time zone, superseded_reason:text, started_at:timestamp(3) without time zone!, completed_at:timestamp(3) without time zone, created_at:timestamp(3) without time zone!, digest_version:integer!, acceptance_epoch:bigint!, criteria_snapshot_v2:jsonb, conclusion_basis:project_acceptance_run_conclusion_basis, conclusion_digest:character(64), conclusion_window_seconds:integer!',
};

interface World {
  db: PrismaClient;
  tasks: TasksService;
  sessions: SessionsService;
}

function connect(): World {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return { db, tasks: new TasksService(prisma, sessions, publishes), sessions };
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
  return { ownerId, runnerId, workspaceId };
}

// (a) --------------------------------------------------------------------------------------------
suite('(a) the installed database has neither 0207 trigger nor either of its functions', async (t) => {
  const client = await connectSql();
  t.after(async () => { await client.end(); });

  for (const [table, trigger] of DROPPED_TRIGGERS) {
    const present = await client.query(
      `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relname = $1 AND t.tgname = $2`,
      [table, trigger],
    );
    assert.equal(present.rowCount, 0, `${trigger} must be gone from ${table}`);
  }
  for (const fn of DROPPED_FUNCTIONS) {
    const present = await client.query(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.proname = $1`,
      [fn],
    );
    assert.equal(present.rowCount, 0, `${fn}() must be dropped, not left unreachable`);
  }
  // No surviving body may call one either: plpgsql binds its callee at run time, so a caller left
  // behind would compile and then fail on first fire.
  const callers = await client.query(`
    SELECT n.nspname || '.' || p.proname AS name
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog','information_schema')
       AND (p.prosrc LIKE '%session\\_verification\\_subject\\_guard%'
            OR p.prosrc LIKE '%task\\_verification\\_subject\\_live\\_session\\_guard%'
            OR p.prosrc LIKE '%TASK\\_VERIFICATION\\_SUBJECT\\_LIVE\\_SESSION%')
     ORDER BY 1`);
  assert.deepEqual(callers.rows, [], 'no installed function may still reach for a dropped one');
});

suite('(a) 0130\'s similarly named guard is untouched', async (t) => {
  const client = await connectSql();
  t.after(async () => { await client.end(); });

  const trigger = await client.query(
    `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = 'task' AND t.tgname = 'task_verification_subject_guard'`);
  assert.equal(trigger.rowCount, 1, '0130\'s task_verification_subject_guard must still be installed');
  assert.match(trigger.rows[0].def, /BEFORE INSERT OR UPDATE OF verifies_task_id ON public\.task/);
  const body = (await client.query(
    `SELECT pg_get_functiondef('task_verification_subject_guard()'::regprocedure) AS def`,
  )).rows[0].def as string;
  assert.match(body, /TASK_VERIFICATION_SUBJECT_BUSY/);
  assert.match(body, /TASK_VERIFICATION_SUBJECT_SUPERSEDED/);
});

// (g) --------------------------------------------------------------------------------------------
suite('(g) the core tables carry exactly the triggers the inventory registers, minus 0207\'s', async (t) => {
  const client = await connectSql();
  t.after(async () => { await client.end(); });

  const installed = await client.query(`
    SELECT c.relname AS "table", t.tgname AS "trigger"
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname = 'public' AND c.relname = ANY($1::text[])
     ORDER BY 1, 2`, [CORE_TABLES]);
  const registered = TRIGGER_WRITE_SOURCES
    .filter((entry) => CORE_TABLES.includes(entry.table))
    .map((entry) => ({ table: entry.table, trigger: entry.trigger }))
    .sort((left, right) => (`${left.table}|${left.trigger}` < `${right.table}|${right.trigger}` ? -1 : 1));
  // Three-way tie: `db-write-inventory.spec.ts` binds this inventory to a replay of every
  // migration, and this binds the same inventory to the server that replayed them. Neither side
  // can drift alone, which is what makes "one fewer" a detectable event rather than a hand edit.
  assert.deepEqual(installed.rows, registered,
    'the core tables\' installed triggers and the inventory must be the same set');
  assert.equal(installed.rowCount, 40,
    'these four tables carried 43 triggers before 0224 and carry 40 after it');
  for (const [, trigger] of DROPPED_TRIGGERS) {
    assert.equal(installed.rows.some((row) => row.trigger === trigger), false);
  }
});

// (h) --------------------------------------------------------------------------------------------
suite('(h) every project_acceptance relation is unchanged, field by field', async (t) => {
  const client = await connectSql();
  t.after(async () => { await client.end(); });

  const census = await client.query(`
    SELECT c.relname AS name,
           string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod)
                        || CASE WHEN a.attnotnull THEN '!' ELSE '' END, ', ' ORDER BY a.attnum)
             AS columns
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind IN ('r','v') AND c.relname LIKE 'project\\_acceptance\\_%'
     GROUP BY c.relname ORDER BY 1`);
  assert.deepEqual(
    Object.fromEntries(census.rows.map((row) => [row.name, row.columns])),
    PROJECT_ACCEPTANCE_COLUMNS,
    'the acceptance wall must come through this removal with every column it went in with',
  );

  // Its own tables' guards too, all eleven of them. The `project_acceptance_*`-named triggers that
  // sit on `project` rather than on this family are deliberately outside the assertion: they are
  // the project DONE gate, a sibling removal is entitled to change them, and failing this suite for
  // that would be the same mistake as measuring subtraction against `main...HEAD`.
  const triggers = await client.query(`
    SELECT c.relname || '|' || t.tgname AS name
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname = 'public'
       AND c.relname LIKE 'project\\_acceptance\\_%'
     ORDER BY 1`);
  assert.deepEqual(triggers.rows.map((row) => row.name), [
    'project_acceptance_audit|project_acceptance_audit_append_only',
    'project_acceptance_conclusion|project_acceptance_conclusion_immutable',
    'project_acceptance_conclusion|project_acceptance_conclusion_reconcile',
    'project_acceptance_conclusion|project_acceptance_conclusion_validate',
    'project_acceptance_criteria_confirmation|project_acceptance_confirmation_immutable',
    'project_acceptance_criterion_definition|project_acceptance_definition_normalize',
    'project_acceptance_criterion_definition|zz_project_completion_contract_definition',
    'project_acceptance_criterion|project_acceptance_criterion_immutable_guard',
    'project_acceptance_run|project_acceptance_run_closure_guard',
    'project_acceptance_run|project_acceptance_run_epoch_guard',
    'project_acceptance_run|project_acceptance_run_immutable_guard',
  ]);
});

// (d) --------------------------------------------------------------------------------------------
suite('(d) ordinary session creation, the status transitions and context attachment still work', async (t) => {
  const sql = await connectSql();
  const { db, tasks } = connect();
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  const { ownerId, runnerId, workspaceId } = await owner(db, 'session-writes');
  const task = await tasks.create(ownerId, { title: 'dispatch me', assigneeId: workspaceId });

  // A plain task-work INSERT — the exact shape `session_verification_subject_guard_insert` fired
  // on, and the one that read `task` to answer.
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, taskId: task.id, workspaceId,
      assignedRunnerId: runnerId, title: 'work', prompt: 'work', provider: 'claude',
      status: RunStatus.PENDING, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
    },
  });
  // ...and every transition the UPDATE guard fired on: status, and starts_task_work itself.
  for (const status of [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.RUNNING]) {
    const moved = await db.session.update({ where: { id: sessionId }, data: { status } });
    assert.equal(moved.status, status);
  }
  const relinked = await db.session.update({
    where: { id: sessionId }, data: { startsTaskWork: false },
  });
  assert.equal(relinked.startsTaskWork, false);
  await db.session.update({ where: { id: sessionId }, data: { startsTaskWork: true } });

  // Attaching context: the coordinator-context columns 0208 added and this task keeps. They are
  // read on every delivery and written on turn completion, so a session that cannot carry them is
  // a session whose coordinator loses its standing instructions.
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId, ownerId, title: 'context attach',
      coordinatorSessionId: sessionId, coordinatorWorkspaceId: workspaceId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const attached = await db.session.update({
    where: { id: sessionId },
    data: {
      inboxLeaseGeneration: randomUUID(),
      coordinatorContextEpoch: 41,
      coordinatorContextAckKey: 'a'.repeat(64),
    },
  });
  assert.equal(attached.coordinatorContextEpoch, 41);
  assert.equal(attached.coordinatorContextAckKey, 'a'.repeat(64));
  // A newer compaction boundary invalidates the acknowledgement, which is the whole protocol.
  const compacted = await db.session.update({
    where: { id: sessionId },
    data: { coordinatorContextEpoch: 77, coordinatorContextAckKey: null },
  });
  assert.equal(compacted.coordinatorContextEpoch, 77);
  assert.equal(compacted.coordinatorContextAckKey, null);

  // The real dispatch door, which is what a person pressing Execute reaches.
  await db.session.update({ where: { id: sessionId }, data: { deletedAt: new Date() } });
  const answer = await tasks.execute(ownerId, task.id) as {
    ok: boolean; sessionId?: string; skipped?: string;
  };
  assert.equal(answer.ok, true, `execute refused: ${JSON.stringify(answer)}`);
  const dispatched = await db.session.findUniqueOrThrow({ where: { id: answer.sessionId! } });
  assert.equal(dispatched.taskId, task.id);
  assert.equal(dispatched.startsTaskWork, true);
  assert.equal(dispatched.coordinatorContextEpoch, 0, 'and a fresh session starts at epoch zero');
});

// (e) --------------------------------------------------------------------------------------------
suite('(e) conversation turns still write, including the coordinator-context stamp', async (t) => {
  const sql = await connectSql();
  const { db, tasks } = connect();
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  const { ownerId, runnerId, workspaceId } = await owner(db, 'turn-writes');
  const task = await tasks.create(ownerId, { title: 'turns', assigneeId: workspaceId });
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, taskId: task.id, workspaceId,
      assignedRunnerId: runnerId, title: 'turns', prompt: 'turns', provider: 'claude',
      status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
    },
  });

  const turnId = randomUUID();
  await db.conversationTurn.create({
    data: {
      id: turnId, sessionId, seq: 1, clientTurnId: `message:${turnId}`, kind: 'message',
      content: 'do the work', status: 'PENDING',
    },
  });
  const contextKey = 'b'.repeat(64);
  const leased = await db.conversationTurn.update({
    where: { id: turnId },
    data: {
      status: 'IN_FLIGHT', deliveredAt: new Date(), leaseGeneration: randomUUID(),
      coordinatorContextKey: contextKey,
    },
  });
  assert.equal(leased.status, 'IN_FLIGHT');
  assert.equal(leased.coordinatorContextKey, contextKey);
  const answered = await db.conversationTurn.update({
    where: { id: turnId }, data: { status: 'ANSWERED', answeredAt: new Date() },
  });
  assert.equal(answered.status, 'ANSWERED');
  assert.equal(answered.coordinatorContextKey, contextKey,
    'the stamp survives completion — it is what the acknowledgement is compared against');
});

// (f) --------------------------------------------------------------------------------------------
suite('(f) verification tasks are still created and dispatched, and the rule still holds', async (t) => {
  const sql = await connectSql();
  const { db, tasks } = connect();
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  const { ownerId, runnerId, workspaceId } = await owner(db, 'verification');
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, ownerId, title: 'verification' } });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  const subject = await tasks.create(ownerId, {
    title: 'subject', projectId, assigneeId: workspaceId,
  });
  // Creating the check and pointing it at its subject: `verifies_task_id` is what 0130's kept
  // guard polices, and what 0207's dropped one also read.
  const verifier = await tasks.create(ownerId, {
    title: 'verifier', projectId, assigneeId: workspaceId, verifiesTaskId: subject.id,
  });
  assert.equal(verifier.verifiesTaskId, subject.id);

  // A live task-work session on the subject, and then the shape change 0207's `task` trigger
  // refused outright. It is allowed now: the transition is bookkeeping, and the service door — not
  // the database — is what decides whether such a task may acquire work.
  const liveId = randomUUID();
  await db.session.create({
    data: {
      id: liveId, ownerId, creatorId: ownerId, taskId: subject.id, workspaceId,
      assignedRunnerId: runnerId, title: 'live', prompt: 'live', provider: 'claude',
      status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
    },
  });
  const becameSubject = await db.task.update({
    where: { id: subject.id },
    data: {
      completionCriterion: TaskCompletionCriterion.VERIFICATION,
      completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
    },
  });
  assert.equal(becameSubject.completionCriterion, TaskCompletionCriterion.VERIFICATION);
  assert.equal(becameSubject.verifiesTaskId, null);

  // The rule 0207 duplicated, still enforced where it was always enforced: Run Now refuses, and
  // it refuses by name rather than by dropping the request.
  await assert.rejects(
    tasks.execute(ownerId, subject.id),
    /completed by its independent verifier/,
  );
  // And the Ready predicate every other surface shares agrees.
  const runnable = await db.$queryRawUnsafe<Array<{ runnable: boolean }>>(
    `SELECT (${MANUAL_RUNNABLE}) AS runnable FROM "task" t WHERE t."id" = $1::uuid`,
    subject.id,
  );
  assert.deepEqual(runnable, [{ runnable: false }]);

  // The check itself has work of its own, and dispatching it still works end to end.
  await db.session.update({ where: { id: liveId }, data: { deletedAt: new Date() } });
  const answer = await tasks.execute(ownerId, verifier.id) as { ok: boolean; sessionId?: string };
  assert.equal(answer.ok, true, `dispatching the verifier was refused: ${JSON.stringify(answer)}`);
  const dispatched = await db.session.findUniqueOrThrow({ where: { id: answer.sessionId! } });
  assert.equal(dispatched.taskId, verifier.id);
  assert.equal(dispatched.startsTaskWork, true);
});
