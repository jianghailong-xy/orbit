/**
 * EXECUTABLE end to end: one exit-code comparison, DONE or FAILED, and nothing written down.
 *
 * This file has been the record of three decisions in a row. It asserted the comparison; then
 * 0227/0228 removed it and it asserted that a completed acceptance turn moved nothing; and on
 * 2026-09-03 the account owner asked for the comparison back — "根据 exit code 来简单判断，不需要
 * 实际记录数据" — which is what it asserts now. The middle state is gone, not softened: a suite
 * that still said "a matching exit code derives nothing" would be describing a control plane
 * nobody is running.
 *
 * What is driven here is the real runner path — `turnComplete`, `dequeueTurn`, `turnComplete` —
 * against a real PostgreSQL transaction with 0193's DONE fence installed, because the fence is
 * the half of this that a unit test cannot reach.
 *
 * The three claims:
 *
 *   * 0177's `acceptance_command` / `acceptance_expected_exit_code` pair is still writable,
 *     readable, editable, clearable, and still enforced as a pair by its CHECK;
 *   * a matching exit code derives DONE and a mismatching one derives FAILED, in both cases
 *     WITHOUT the needs-human signal and WITHOUT a single row recording the code or the output;
 *   * a turn that produces no exit code at all still reaches the needs-human signal, which is
 *     what that signal is now for.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable database accepted by the
 * coordinator PG safety guard, with all migrations (including 0177 and 0230) applied.
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
  // Clearing the pair MOVES the criterion, so since 2026-09-05 it costs a sentence: the door in
  // `task-completion-criterion-change-guard.ts` is judged on the criterion a write LANDS on, and
  // this write lands on EVIDENCE_JUDGMENT without ever naming it. Saying why is the whole price.
  const cleared = await tasks.update(f.ownerId, f.taskId, {
    acceptanceCommand: null,
    acceptanceExpectedExitCode: null,
    completionCriterionOverrideReason:
      'The command is being withdrawn, so EXECUTABLE has nothing left to run and this task '
      + 'settles on its evidence instead.',
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
    completionCriterionOverrideReason: 'The command is back, and it is what settles this task.',
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

suite('a matching exit code derives DONE, and records nothing', async (t) => {
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
  const request = {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: shell.status!,
    shellOutput: `${shell.stdout}${shell.stderr}`,
  };
  // "不需要实际记录数据" is the account owner's whole instruction, so this is checked against the
  // catalog rather than against a list somebody has to remember to extend: every table in the
  // database is counted before and after, and NONE of them may gain a row. A list of table names
  // would go stale the first time a well-meaning repair added a seventh place to write to.
  const census = async (): Promise<Map<string, number>> => {
    const tables = (await sql.query<{ name: string }>(`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`)).rows.map((row) => row.name);
    const counted = new Map<string, number>();
    for (const name of tables) {
      const rows = await sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${name}"`);
      counted.set(name, Number(rows.rows[0].n));
    }
    return counted;
  };
  const rowsBefore = await census();
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, request);
  const rowsAfter = await census();
  const grew = [...rowsAfter].filter(([name, n]) => n > (rowsBefore.get(name) ?? 0))
    .map(([name, n]) => `${name}: ${rowsBefore.get(name)} -> ${n}`);
  assert.deepEqual(grew, [],
    'the judgment recorded a row somewhere; the exit code is a comparison input, not data');
  assert.deepEqual([...rowsBefore.keys()], [...rowsAfter.keys()],
    'the judgment created a table');
  // The session parks rather than failing: the comparison agreed, so nothing about this run went
  // wrong. Before this change every reserved acceptance turn ended RunStatus.FAILED.
  assert.deepEqual(result, { ok: true, status: RunStatus.AWAITING_INPUT });

  const after = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  assert.equal(after.status, TaskStatus.DONE,
    'exit 0 against expected 0 is the whole criterion, and it derives DONE');
  assert.equal(after.acceptanceCommand, 'true', 'and the declaration is untouched by the attempt');
  assert.equal(after.acceptanceExpectedExitCode, 0);
  assert.equal(after.completionCriterion, 'EXECUTABLE');

  // The needs-human signal is NOT on this path any more. It guards a turn that produced nothing
  // comparable, and this one produced a 0; a comment here would mean the comparison did not run.
  assert.deepEqual(await db.taskComment.findMany({ where: { taskId: f.taskId } }), []);

  // The one place either number survives is `session.error`, and only on the failing side —
  // an UPDATE of a column that already existed, on the run's own row. Here it stays null.
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: f.sessionId } })).error, null);

  // Replay: the compare-and-set is the idempotency boundary, so a retried callback finds the task
  // no longer in a pending status and changes nothing.
  await api.turnComplete({ id: f.runnerId }, f.sessionId, request);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status, TaskStatus.DONE);
  assert.equal(await db.taskComment.count({ where: { taskId: f.taskId } }), 0);
});

suite('a different exit code derives FAILED, and records nothing either', async (t) => {
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
  // Genuinely executed, exactly as the runner would.
  const shell = spawnSync('bash', ['-lc', acceptance.content!], { encoding: 'utf8' });
  assert.equal(shell.status, 7);
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: shell.status!,
    shellOutput: `${shell.stdout}${shell.stderr}`,
  });
  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.FAILED,
    'a comparable, mismatching exit code is the conservative FAILED',
  );
  // Not the unavailable signal: the command was compared, it simply disagreed. A comment here
  // would say the opposite of what happened.
  assert.deepEqual(await db.taskComment.findMany({ where: { taskId: f.taskId } }), []);
  // Where the failure IS legible, and the only place either number is written: the run's own
  // error string. That is the "diagnosis moves to the session" the owner accepted.
  const session = await db.session.findUniqueOrThrow({ where: { id: f.sessionId } });
  assert.equal(session.status, RunStatus.FAILED);
  assert.equal(session.error, 'acceptance command exited 7; expected 0');
});

suite('the DONE fence is what the derived status passes through, and it still refuses others',
  async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    const db = prismaClientFor(URL!);
    t.after(async () => {
      await db.$disconnect();
      await sql.end();
    });
    await empty(sql);

    // 0193's trigger is a BEFORE UPDATE on `task` and 0228 left EXECUTABLE with no lane through
    // it, so the restored comparison would have been rolled back one statement after it ran.
    // 0230 adds the lane. What it can check is the declaration — the only durable fact an
    // EXECUTABLE task has once nothing is recorded — so this pins both directions of that.
    const f = await fixture(db, 'fence', { command: 'true', expectedExitCode: 0 });
    await sql.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [f.taskId]);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
      TaskStatus.DONE);

    // An EVIDENCE_JUDGMENT task is still refused: this migration added ONE lane and none of the
    // others moved. (i) — EVIDENCE_JUDGMENT was not restored by the side door either.
    const other = await fixture(db, 'fence-evidence', null);
    await assert.rejects(
      sql.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [other.taskId]),
      /TASK_DONE_CANONICAL_FACT_REQUIRED/,
      'a task with no canonical fact and no executable declaration is still refused',
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

  // The signal was kept, and this is the case it was kept FOR: `shellExitCode` absent means no
  // comparison happened, so FAILED would assert something about a command that never reported.
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

suite('a SUCCEEDED acceptance turn that omits the exit code also reaches the signal', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  // The rolling-upgrade shape: a runner old enough to complete the turn successfully without
  // sending `shellExitCode`. The comparison has one side and therefore does not happen; the task
  // must not be guessed either way.
  const f = await fixture(db, 'no-exit-code', { command: 'true', expectedExitCode: 0 });
  const api = controller(db);
  await finishMessage(api, f);
  const acceptance = await dequeueAcceptance(api, f);
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellOutput: '',
  });
  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.OPEN,
    'no exit code is not a status: the task stays actionable rather than being guessed',
  );
  const comments = await db.taskComment.findMany({ where: { taskId: f.taskId } });
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, new RegExp(EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE));
});

suite('an exit code judged against a declaration that moved is not judged at all', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  // The expectation is part of the queued turn's client id. Editing the declaration while the
  // command runs makes the result an answer to a question nobody is asking, so it reaches the
  // signal rather than settling the new declaration.
  const f = await fixture(db, 'edited-declaration', { command: 'true', expectedExitCode: 0 });
  const api = controller(db);
  await finishMessage(api, f);
  const acceptance = await dequeueAcceptance(api, f);
  await tasksService(db).update(f.ownerId, f.taskId, {
    acceptanceCommand: 'true', acceptanceExpectedExitCode: 3,
  });
  await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.OPEN,
    'a stale expectation cannot be compared against the current declaration',
  );
  const comments = await db.taskComment.findMany({ where: { taskId: f.taskId } });
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, new RegExp(EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE));
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
