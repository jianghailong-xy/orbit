/**
 * EXECUTABLE after 2026-09-02: the declaration is intact, and nothing satisfies it.
 *
 * This file used to assert the other half — that a matching exit code derived DONE and a
 * mismatching one derived FAILED. The account owner had that evaluator deleted along with the
 * judgment machinery, to be rebuilt, and was explicit that the DECLARATION and its data stay. So
 * the same real runner path is driven here, through the same real PostgreSQL transaction, and
 * what is asserted is both halves of the new state:
 *
 *   * 0177's `acceptance_command` / `acceptance_expected_exit_code` pair is still writable,
 *     readable, editable, clearable, and still enforced as a pair by its CHECK;
 *   * a completed acceptance turn — matching exit code or not — moves no Task status.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable database accepted by the
 * coordinator PG safety guard, with all migrations (including 0177 and 0227) applied.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE } from './reclaim-stalled-task';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  taskId: string;
  sessionId: string;
  messageTurnId: string;
}

function controller(db: PrismaClient): RunnerApiController {
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const realtime = {
    publishSessionUpdated: () => undefined,
    publishTaskChanged: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
    publish: () => undefined,
    notifyInbox: () => undefined,
    waitForInbox: async () => undefined,
  } as unknown as RealtimeService;
  const prisma = db as unknown as PrismaService;
  return new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
  );
}

function tasksService(db: PrismaClient): TasksService {
  return new TasksService(
    db as unknown as PrismaService,
    { create: () => { throw new Error('this fixture never dispatches through TasksService'); } } as never,
    {
      publishForUser: () => undefined,
      publishTaskChanged: () => undefined,
    } as never,
  );
}

async function empty(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "task", "session", "workspace", "runner", "project_runtime", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function fixture(
  db: PrismaClient,
  label: string,
  acceptance: { command: string; expectedExitCode: number } | null,
  projectBound = false,
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@t10.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: `${label}-runner`, tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  const projectId = projectBound ? randomUUID() : undefined;
  if (projectId) {
    await db.project.create({ data: { id: projectId, ownerId, title: `${label}-project` } });
    await db.projectRuntime.upsert({
      where: { projectId },
      create: { projectId },
      update: {},
    });
  }
  const declared = await tasksService(db).create(ownerId, {
    title: label,
    assigneeId: workspaceId,
    projectId,
    acceptanceCommand: acceptance?.command,
    acceptanceExpectedExitCode: acceptance?.expectedExitCode,
  });
  const taskId = declared.id;
  assert.equal(declared.acceptanceCommand, acceptance?.command ?? null);
  assert.equal(declared.acceptanceExpectedExitCode, acceptance?.expectedExitCode ?? null);
  assert.equal(
    declared.status,
    TaskStatus.OPEN,
    'dispatch does not invent an interim status before the criterion has an input',
  );
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      taskId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: label,
      prompt: label,
      provider: 'claude',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await db.conversationTurn.create({
    data: {
      id: messageTurnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${messageTurnId}`,
      kind: 'message',
      content: 'execute the task',
      status: 'IN_FLIGHT',
    },
  });
  return { ownerId, runnerId, workspaceId, taskId, sessionId, messageTurnId };
}

async function finishMessage(api: RunnerApiController, f: Fixture): Promise<void> {
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: f.messageTurnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  assert.deepEqual(result, { ok: true, status: RunStatus.RUNNING });
}

async function dequeueAcceptance(api: RunnerApiController, f: Fixture) {
  const next = await (api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string; content?: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(f.sessionId, f.runnerId, null);
  assert.ok(next);
  assert.equal(next.kind, 'shell');
  assert.equal(next.taskAcceptance, true);
  return next;
}

suite('the declaration is stored, editable, clearable and still enforced as a pair', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  const tasks = tasksService(db);
  const f = await fixture(db, 'declaration', { command: 'test -f package.json', expectedExitCode: 0 });
  const stored = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  assert.equal(stored.completionCriterion, 'EXECUTABLE');
  assert.equal(stored.acceptanceCommand, 'test -f package.json');
  assert.equal(stored.acceptanceExpectedExitCode, 0);

  // Half a declaration is still refused: the pair is the fact, and the CHECK that says so is
  // 0177's, which this change did not touch.
  await assert.rejects(
    tasks.create(f.ownerId, { title: 'half declaration', acceptanceCommand: 'true' }),
    /acceptanceCommand and acceptanceExpectedExitCode must be set or cleared together/,
  );
  await assert.rejects(
    sql.query(`UPDATE "task" SET "acceptance_expected_exit_code" = NULL WHERE "id" = $1`,
      [f.taskId]),
    /task_executable_acceptance_pair/,
    'raw SQL cannot leave a task with one half of the pair either',
  );

  // Editable, and clearable together.
  const edited = await tasks.update(f.ownerId, f.taskId, {
    acceptanceCommand: 'npm run build',
    acceptanceExpectedExitCode: 0,
  });
  assert.equal(edited.acceptanceCommand, 'npm run build');
  assert.equal(edited.acceptanceExpectedExitCode, 0);
  const cleared = await tasks.update(f.ownerId, f.taskId, {
    acceptanceCommand: null,
    acceptanceExpectedExitCode: null,
  });
  assert.equal(cleared.acceptanceCommand, null);
  assert.equal(cleared.acceptanceExpectedExitCode, null);
  // Clearing the pair re-resolves the criterion, exactly as it did before this change: an
  // undeclared task is EVIDENCE_JUDGMENT. That is `resolveTaskCompletionCriterion`'s pre-existing
  // compatibility rule and was not this removal's to alter — worth pinning, because "the
  // declaration is preserved" must not quietly become "the criterion is frozen".
  assert.equal(cleared.completionCriterion, 'EVIDENCE_JUDGMENT');
  const redeclared = await tasks.update(f.ownerId, f.taskId, {
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'test -f package.json',
    acceptanceExpectedExitCode: 0,
  });
  assert.equal(redeclared.completionCriterion, 'EXECUTABLE');
  assert.equal(redeclared.acceptanceCommand, 'test -f package.json');

  // And the machinery that used to consume it is gone from this database entirely.
  const relations = await sql.query<{ relname: string }>(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname IN (
       'task_judgment_request', 'task_executable_judgment_result', 'task_judgment_inbox_item',
       'task_judgment_push_delivery', 'task_judgment_backfill_batch')
  `);
  assert.deepEqual(relations.rows, []);
});

suite('a matching exit code no longer derives DONE', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  const f = await fixture(db, 'open-true', { command: 'true', expectedExitCode: 0 }, true);
  const api = controller(db);
  await finishMessage(api, f);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status, TaskStatus.OPEN);

  // The turn is still queued FROM the declaration: the command an agent sees is the one stored.
  const acceptance = await dequeueAcceptance(api, f);
  assert.equal(acceptance.content, 'true');

  // The same bash contract the runner uses. `true` is genuinely executed and reported back.
  const shell = spawnSync('bash', ['-lc', acceptance.content!], { encoding: 'utf8' });
  assert.equal(shell.error, undefined);
  assert.equal(shell.status, 0);
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: shell.status!,
    shellOutput: `${shell.stdout}${shell.stderr}`,
  });
  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });

  const after = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  assert.equal(after.status, TaskStatus.OPEN,
    'exit 0 against expected 0 derives nothing: EXECUTABLE has no implementation');
  assert.equal(after.acceptanceCommand, 'true', 'and the declaration is untouched by the attempt');
  assert.equal(after.acceptanceExpectedExitCode, 0);
  assert.equal(after.completionCriterion, 'EXECUTABLE');

  // What the session gets instead is the pre-existing needs-human signal, unchanged: there is no
  // comparable result because there is nothing left to compare it.
  const comments = await db.taskComment.findMany({ where: { taskId: f.taskId } });
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, new RegExp(EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE));
});

suite('a different exit code does not derive FAILED either', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  const f = await fixture(db, 'exit-seven', { command: 'exit 7', expectedExitCode: 0 });
  const api = controller(db);
  await finishMessage(api, f);
  const acceptance = await dequeueAcceptance(api, f);
  await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 7,
    shellOutput: 'exit 7',
  });
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.OPEN,
    'a mismatching exit code is not a conservative FAILED: the comparison itself is gone',
  );
});

suite('an acceptance turn without a comparable shell result emits a needs-human signal', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  const f = await fixture(db, 'missing-shell-result', { command: 'true', expectedExitCode: 0 });
  const api = controller(db);
  await finishMessage(api, f);
  const acceptance = await dequeueAcceptance(api, f);
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.FAILED,
    subtype: 'shell',
    result: 'runner did not return shellExitCode/shellOutput',
  });

  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.OPEN,
    'a transport failure is not a criterion result and cannot guess Task FAILED',
  );
  const comments = await db.taskComment.findMany({ where: { taskId: f.taskId } });
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /需要人工介入：EXECUTABLE 验收未能判定/);
  assert.match(comments[0].body, /命令：true[\s\S]*期望退出码：0/);
  assert.match(comments[0].body, /runner did not return shellExitCode\/shellOutput/);
  assert.match(comments[0].body, new RegExp(EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE));

  await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.FAILED,
    subtype: 'shell',
    result: 'runner did not return shellExitCode/shellOutput',
  });
  assert.equal(
    await db.taskComment.count({ where: { taskId: f.taskId } }),
    1,
    'a retried turn-complete cannot duplicate the signal',
  );
});

suite('a task with no command keeps the pre-T10 turn-complete behaviour', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  const f = await fixture(db, 'no-command', null);
  const api = controller(db);
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: f.messageTurnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  assert.deepEqual(result, { ok: true, status: RunStatus.AWAITING_INPUT });
  assert.equal(
    await db.conversationTurn.count({ where: { sessionId: f.sessionId, kind: 'shell' } }),
    0,
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status, TaskStatus.OPEN);
});
