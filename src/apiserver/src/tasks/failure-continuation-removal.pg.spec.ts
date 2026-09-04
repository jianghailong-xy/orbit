import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { TRIGGER_WRITE_SOURCES } from '../common/db-write-inventory';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
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
 * The server half of the 0226 removal, against a real PostgreSQL that replayed every migration.
 *
 * `failure-continuation-removal.spec.ts` reads the migration text; this reads the catalog. They can
 * disagree — a `CREATE OR REPLACE` in a later file, a cascade nobody named — and only the server
 * settles which of the two is describing the database that actually exists.
 *
 * The positive half is the part that matters most, and it is not "the guard was a duplicate".
 * `failure_successor_task_binding_immutable` fired BEFORE UPDATE OF status, superseded_by_task_id,
 * superseded_at and terminal_reason on `task` — every supersession write in the database went
 * through it, and its second branch raised `FAILURE_SUCCESSOR_CURRENT_TASK_REQUIRES_HANDOFF` for
 * anything it did not recognise. So both supersession doors are driven here, through the real
 * service, on a real server, together with the negative that predates this project and must not
 * have been removed with it.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const RUN = randomUUID().slice(0, 8);

const DROPPED_RELATIONS = [
  'failure_continuation_attempt_receipt',
  'failure_continuation_obligation',
  'failure_continuation_owner_decision_inbox',
  'failure_continuation_project_attention',
  'failure_continuation_route_decision',
  'failure_continuation_wakeup_outbox',
  'failure_successor_current',
  'failure_successor_current_binding',
  'failure_successor_dependency_rebind',
  'failure_successor_handoff',
];

const DROPPED_TRIGGERS: ReadonlyArray<[string, string]> = [
  ['task', 'failure_successor_task_binding_immutable'],
  ['task_executable_attempt', 'task_executable_attempt_failure_continuation_receipt'],
  ['task_executable_continuation', 'task_executable_continuation_failure_wakeup'],
];

/** The tables criterion (g)/(h) is about: the two this removal wrote on, plus their neighbours. */
const CORE_TABLES = ['conversation_turn', 'run_event', 'session', 'task'];

/**
 * (j) `project_acceptance_*`, field for field. Copied from the census the 0224 removal suite
 * pinned, so "unchanged" means unchanged against the same statement of it rather than against
 * whatever this file happened to read first.
 *
 * The run, the per-run criterion, the conclusion and the audit were pinned here until
 * `0229_project_acceptance_judgment_removal` dropped the four of them — a later and separate
 * account-owner decision, which removed the project acceptance judgment whole and kept the stated
 * criteria. `project_acceptance_criteria_confirmation` went the same way in 0226, and
 * `0233_project_acceptance_criterion_wiring_removal` then took the four columns that pointed a
 * criterion at the work serving it — a third later decision, about which direction that edge
 * points. What is left is the authored declaration, still pinned column for column.
 */
const PROJECT_ACCEPTANCE_COLUMNS: Readonly<Record<string, string>> = {
  project_acceptance_criterion_definition:
    'id:uuid!, project_id:uuid!, ordinal:integer!, text:text!, revision:integer!, content_hash:character(64)!, created_at:timestamp(3) without time zone!, updated_at:timestamp(3) without time zone!, verification_method:text!, completion_criterion_override_reason:text, semantic_revision:integer!, semantic_hash:character(64)!, evaluation_plan_revision:integer!, evaluation_plan_hash:character(64)!',
};

function publishes(): RealtimeService {
  return new Proxy({}, {
    get: (_target, name) => (name === 'waitForInbox' ? async () => undefined : () => undefined),
  }) as unknown as RealtimeService;
}

interface World {
  db: PrismaClient;
  tasks: TasksService;
  api: RunnerApiController;
}

function connect(): World {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, publishes());
  return {
    db,
    tasks: new TasksService(prisma, sessions, publishes()),
    api: new RunnerApiController(
      prisma,
      queue,
      publishes(),
      {} as never,
      {} as never,
      {} as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
      undefined,
    ),
  };
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

// (a)(b) -----------------------------------------------------------------------------------------
suite('(a) the installed database has none of the relations, functions or types 0210-0213 built',
  async (t) => {
    const client = await connectSql();
    t.after(async () => { await client.end(); });

    const relations = (await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m')
          AND (c.relname LIKE 'failure\\_continuation\\_%' OR c.relname LIKE 'failure\\_successor\\_%')
        ORDER BY 1`)).rows.map((row) => row.name);
    assert.deepEqual(relations, [], `the failure family is still installed: ${relations.join(', ')}`);
    // Named one by one as well, so a reader sees the exact list rather than trusting a prefix.
    for (const name of DROPPED_RELATIONS) {
      const present = await client.query(
        `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1`, [name]);
      assert.equal(present.rowCount, 0, `${name} must be gone`);
    }

    const functions = (await client.query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND (p.proname LIKE 'failure\\_%' OR p.proname LIKE 'executable\\_failure\\_%')
        ORDER BY 1`)).rows.map((row) => row.name);
    assert.deepEqual(functions, [], `reducers survive the removal: ${functions.join(', ')}`);

    const types = (await client.query<{ name: string }>(
      `SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'executable_failure_site_source'`))
      .rows.map((row) => row.name);
    assert.deepEqual(types, [], '0213\'s enum must be dropped with the columns it typed');

    // No surviving body may reach for one either: plpgsql binds its callee at run time, so a
    // caller left behind compiles and then fails on first fire.
    const callers = (await client.query<{ name: string }>(`
      SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema')
         AND (p.prosrc ~ 'failure_continuation_|failure_successor_|executable_failure_'
              OR p.prosrc ~ 'failure_site_source|failure_site_digest')
       ORDER BY 1`)).rows.map((row) => row.name);
    assert.deepEqual(callers, [], `installed functions still reach for a dropped one: ${callers}`);

    // And the two columns, with the CHECK that constrained one of them. Both lived on
    // `task_executable_attempt`, which migration 0227 removed whole by a later decision -- so the
    // column read is written against the catalog rather than a regclass cast that would raise on
    // the missing relation, and it answers "absent" either way.
    const columns = (await client.query<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'task_executable_attempt'
          AND column_name IN ('failure_site_source', 'failure_site_digest')`))
      .rows.map((row) => row.name);
    assert.deepEqual(columns, []);
    const check = await client.query(
      `SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'task_executable_attempt'
          AND c.conname = 'task_executable_attempt_failure_site_digest_check'`);
    assert.equal(check.rowCount, 0);
  });

suite('(b) the three triggers on tables this project did not own are gone from the server',
  async (t) => {
    const client = await connectSql();
    t.after(async () => { await client.end(); });

    for (const [table, trigger] of DROPPED_TRIGGERS) {
      const present = await client.query(
        `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND c.relname = $1 AND t.tgname = $2`, [table, trigger]);
      assert.equal(present.rowCount, 0, `${trigger} must be gone from ${table}`);
    }

    // Three-way tie: `db-write-inventory.spec.ts` binds the inventory to a replay of every
    // migration, and this binds the same inventory to the server that replayed them. Neither side
    // can drift alone, which is what makes "one fewer" a detectable event rather than a hand edit.
    const installed = (await client.query<{ table: string; trigger: string }>(`
      SELECT c.relname AS "table", t.tgname AS "trigger"
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND n.nspname = 'public' AND c.relname = ANY($1::text[])
       ORDER BY 1, 2`, [CORE_TABLES])).rows;
    const registered = TRIGGER_WRITE_SOURCES
      .filter((entry) => CORE_TABLES.includes(entry.table))
      .map((entry) => ({ table: entry.table, trigger: entry.trigger }))
      .sort((left, right) => (
        `${left.table}|${left.trigger}` < `${right.table}|${right.trigger}` ? -1 : 1));
    assert.deepEqual(installed, registered,
      'the core tables\' installed triggers and the inventory must be the same set');

    // The supersession guards that predate this project are all still on `task` — the point of
    // (f), stated first as a catalog fact so a positive case cannot pass because nothing guards.
    const onTask = installed.filter((row) => row.table === 'task').map((row) => row.trigger);
    for (const kept of [
      'task_supersession_guard_insert',
      'task_supersession_guard_update',
      'task_supersession_live_session_guard',
      'task_supersession_successor_move_guard',
    ]) {
      assert.ok(onTask.includes(kept), `${kept} predates this project and must survive it`);
    }
  });

// (d)(e)(f) --------------------------------------------------------------------------------------
suite('(d)(e)(f) both supersession doors work, and the older refusal still refuses', async (t) => {
  const sql = await connectSql();
  const { db, tasks } = connect();
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  const { ownerId, workspaceId, projectId } = await owner(db, 'supersede');

  // (d) task_update carrying supersededByTaskId. Before 0226 this UPDATE fired
  // `failure_successor_task_binding_guard`, which found no handoff row for the predecessor, saw
  // the three supersession columns change, and refused anything the router had not routed.
  const failed = await tasks.create(ownerId, {
    title: 'the attempt that failed', projectId, assigneeId: workspaceId,
  });
  await tasks.update(ownerId, failed.id, { status: TaskStatus.FAILED } as never);
  const replacement = await tasks.create(ownerId, {
    title: 'the replacement', projectId, assigneeId: workspaceId,
  });
  const linked = await tasks.update(ownerId, failed.id, {
    supersededByTaskId: replacement.id,
  } as never) as { supersededByTaskId: string | null; terminalReason: string | null };
  assert.equal(linked.supersededByTaskId, replacement.id);
  assert.equal(linked.terminalReason, 'SUPERSEDED');
  const stored = await db.task.findUniqueOrThrow({ where: { id: failed.id } });
  assert.equal(stored.status, TaskStatus.FAILED, 'the original outcome is the fact being kept');
  assert.ok(stored.supersededAt, 'and the moment it was replaced is recorded');

  // (e) task_create carrying supersedesTaskId: the same link, written in the transaction that
  // creates the successor rather than in a second call.
  const cancelled = await tasks.create(ownerId, {
    title: 'the attempt that was dropped', projectId, assigneeId: workspaceId,
  });
  await tasks.update(ownerId, cancelled.id, { status: TaskStatus.CANCELLED } as never);
  const successor = await tasks.create(ownerId, {
    title: 'the second attempt', projectId, assigneeId: workspaceId,
    supersedesTaskId: cancelled.id,
  } as never);
  const retired = await db.task.findUniqueOrThrow({ where: { id: cancelled.id } });
  assert.equal(retired.supersededByTaskId, successor.id);
  assert.equal(retired.terminalReason, 'SUPERSEDED');
  assert.equal(retired.status, TaskStatus.CANCELLED);

  // (f) The negative that predates this project: an attempt that has not stopped may not be
  // replaced. Both doors, because the rule is one function and has to answer the same way at both.
  const open = await tasks.create(ownerId, {
    title: 'still running', projectId, assigneeId: workspaceId,
  });
  const wouldReplace = await tasks.create(ownerId, {
    title: 'premature replacement', projectId, assigneeId: workspaceId,
  });
  await assert.rejects(
    tasks.update(ownerId, open.id, { supersededByTaskId: wouldReplace.id } as never),
    /Only a CANCELLED or FAILED task can name a successor/,
  );
  await assert.rejects(
    tasks.create(ownerId, {
      title: 'premature replacement, other door', projectId, assigneeId: workspaceId,
      supersedesTaskId: open.id,
    } as never),
    /Only a CANCELLED or FAILED task can name a successor/,
  );
  // ...and a successor from another goal is still not a later attempt at this one.
  const elsewhere = randomUUID();
  await db.project.create({ data: { id: elsewhere, ownerId, title: 'another goal' } });
  await db.projectRuntime.upsert({
    where: { projectId: elsewhere }, create: { projectId: elsewhere }, update: {},
  });
  const foreign = await tasks.create(ownerId, {
    title: 'different goal', projectId: elsewhere, assigneeId: workspaceId,
  });
  await assert.rejects(
    tasks.update(ownerId, failed.id, { supersededByTaskId: foreign.id } as never),
    /same project/,
  );
  // Nothing in any of those refusals is the removed router's error code.
  const refusal = await tasks.update(ownerId, open.id, {
    supersededByTaskId: wouldReplace.id,
  } as never).then(() => '', (error: Error) => String(error.message ?? error));
  assert.equal(refusal.includes('FAILURE_SUCCESSOR'), false, refusal);
});

// (g)(h) -----------------------------------------------------------------------------------------
suite('(g)(h) ordinary task and session writes are unchanged', async (t) => {
  const sql = await connectSql();
  const { db, tasks } = connect();
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  await empty(sql);

  const { ownerId, runnerId, workspaceId, projectId } = await owner(db, 'ordinary');

  // (g) create, update, and a dependency edge between two of them.
  const first = await tasks.create(ownerId, {
    title: 'first', projectId, assigneeId: workspaceId,
  });
  const second = await tasks.create(ownerId, {
    title: 'second', projectId, assigneeId: workspaceId, dependsOnTaskIds: [first.id],
  } as never);
  assert.equal(
    await db.taskDependency.count({ where: { taskId: second.id, dependsOnTaskId: first.id } }), 1);
  const renamed = await tasks.update(ownerId, first.id, {
    title: 'first, renamed', status: TaskStatus.IN_PROGRESS,
  } as never) as { title: string; status: TaskStatus };
  assert.equal(renamed.title, 'first, renamed');
  assert.equal(renamed.status, TaskStatus.IN_PROGRESS);

  // `task_get` carried the failure-coordination rollup on every read, which meant it issued the
  // raw statement this removal deleted. It has to answer — not 500 — and it has to answer without
  // the field: a reader that still finds the key would report "no active failures" for a projection
  // that no longer exists.
  const detail = await tasks.get(ownerId, second.id) as Record<string, unknown>;
  assert.equal('failureCoordination' in detail, false,
    'task_get must not report a projection this removal deleted');
  assert.equal(detail.id, second.id);
  assert.deepEqual(detail.dependencyState, 'BLOCKED',
    'and everything task_get derives beside it still derives');
  // The project task page read the same projection per row. It must answer too.
  const page = await new ProjectsService(db as unknown as PrismaService)
    .taskPage(ownerId, projectId);
  assert.equal(page.items.length, 2);
  for (const item of page.items as Array<Record<string, unknown>>) {
    assert.equal('failureCoordination' in item, false,
      'the project task page must not report a projection this removal deleted');
  }

  // (h) a plain task-work session INSERT, its status transitions, and the real dispatch door.
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, taskId: first.id, workspaceId,
      assignedRunnerId: runnerId, title: 'work', prompt: 'work', provider: 'claude',
      status: RunStatus.PENDING, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
    },
  });
  for (const status of [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.RUNNING]) {
    const moved = await db.session.update({ where: { id: sessionId }, data: { status } });
    assert.equal(moved.status, status);
  }
  await db.session.update({ where: { id: sessionId }, data: { deletedAt: new Date() } });
  const answer = await tasks.execute(ownerId, first.id) as { ok: boolean; sessionId?: string };
  assert.equal(answer.ok, true, `execute refused: ${JSON.stringify(answer)}`);
  const dispatched = await db.session.findUniqueOrThrow({ where: { id: answer.sessionId! } });
  assert.equal(dispatched.taskId, first.id);
  assert.equal(dispatched.startsTaskWork, true);
});

// (i) ---------------------------------------------------------------------------------------------
suite('(i) an EXECUTABLE task still runs command -> verdict, failure included',
  async (t) => {
    const sql = await connectSql();
    const { db, tasks, api } = connect();
    t.after(async () => { await db.$disconnect(); await sql.end(); });
    await empty(sql);

    const { ownerId, runnerId, workspaceId, projectId } = await owner(db, 'executable');
    const declared = await tasks.create(ownerId, {
      title: 'executable', projectId, assigneeId: workspaceId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCriteria: 'The declared shell command exits with the expected code.',
      acceptanceCommand: 'test -f package.json',
      acceptanceExpectedExitCode: 0,
    } as never);
    const sessionId = randomUUID();
    const messageTurnId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, taskId: declared.id, workspaceId,
        assignedRunnerId: runnerId, title: 'exec', prompt: 'exec', provider: 'claude',
        status: RunStatus.RUNNING, engineTurnActive: true,
        dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      },
    });
    await db.conversationTurn.create({
      data: {
        id: messageTurnId, sessionId, seq: 1, clientTurnId: `message:${messageTurnId}`,
        kind: 'message', content: 'do the work', status: 'IN_FLIGHT',
      },
    });

    const finished = await api.turnComplete({ id: runnerId } as never, sessionId, {
      turnId: messageTurnId, status: SharedRunStatus.SUCCEEDED,
    } as never);
    assert.deepEqual(finished, { ok: true, status: RunStatus.RUNNING });

    const delivered = await (api as unknown as {
      dequeueTurn: (
        sessionId: string, runnerId: string, leaseGeneration: string | null, acceptsSteer: boolean,
        declaredCapabilities: readonly string[],
      ) => Promise<{ turnId: string; taskAcceptance?: boolean } | null>;
    }).dequeueTurn(sessionId, runnerId, null, false, []);
    assert.equal(delivered?.taskAcceptance, true, 'the acceptance command must be delivered');

    // A FAILING result: the exact write the two 0210 triggers fired on, delivered through the
    // lane 0227 left in place. It must write no receipt, obligation or outbox — because there is
    // nowhere left to write one.
    const settled = await api.turnComplete({ id: runnerId } as never, sessionId, {
      turnId: delivered!.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'shell',
      shellExitCode: 1,
      shellOutput: 'no such file',
    } as never);
    assert.equal((settled as { ok: boolean }).ok, true);
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: declared.id } })).status,
      TaskStatus.FAILED,
      'a failed command settles the task FAILED and routes it nowhere else: the continuation '
      + 'that used to keep the goal actionable is what this removal took',
    );
    // The result row this used to read went with the judgment machinery in 0228, and restoring
    // the comparison on 2026-09-03 did not bring it back. What the failure leaves is the status
    // and nothing else — no continuation, receipt, outbox or comment — which is what this suite
    // is actually about.
    assert.equal(await db.taskComment.count({ where: { taskId: declared.id } }), 0);
  });

// (j) ---------------------------------------------------------------------------------------------
suite('(j) every project_acceptance relation is unchanged, field by field', async (t) => {
  const client = await connectSql();
  t.after(async () => { await client.end(); });

  const census = (await client.query<{ table: string; signature: string }>(`
    SELECT c.relname AS "table",
           string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod)
                        || CASE WHEN a.attnotnull THEN '!' ELSE '' END, ', ' ORDER BY a.attnum)
             AS signature
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind IN ('r','v')
       AND c.relname LIKE 'project\\_acceptance\\_%'
     GROUP BY c.relname ORDER BY 1`)).rows;
  assert.deepEqual(
    Object.fromEntries(census.map((row) => [row.table, row.signature])),
    PROJECT_ACCEPTANCE_COLUMNS,
    'the acceptance wall must come through this removal with every column it went in with',
  );
});
