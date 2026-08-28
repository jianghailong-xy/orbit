/**
 * T10's L0 boundary through the real PostgreSQL transaction used by a runner.
 *
 * The request that represents the execution session never calls TasksService.update and carries
 * no Task status. A successful message queues one ordinary ConversationTurn of kind `shell`; its
 * exit code then derives the Task's terminal status in /turn-complete. This spec runs that exact
 * path so a mocked comparison cannot stand in for the database effect it claims.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable database accepted by the
 * coordinator PG safety guard, with all migrations (including 0177) applied.
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
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
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
  const completionInputs = new CompletionInputRouter(new CoordinatorWakeService(prisma));
  return new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    completionInputs,
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

suite('one declared command exits as expected, so the server derives DONE', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  const command = "test -f package.json";
  // Project-bound exercises the real project → task lock order taken by a status fact write.
  const f = await fixture(db, 'exit-zero', { command, expectedExitCode: 0 }, true);
  await assert.rejects(
    tasksService(db).create(f.ownerId, { title: 'half declaration', acceptanceCommand: 'true' }),
    /acceptanceCommand and acceptanceExpectedExitCode must be set or cleared together/,
  );
  const api = controller(db);
  const evidence = await new TaskCompletionEvidenceService(db as unknown as PrismaService).submit(
    f.ownerId,
    f.taskId,
    { type: 'AGENT', id: f.workspaceId },
    {
      sourceSessionId: f.sessionId,
      idempotencyKey: 'executable-fact',
      evidence: { command, artifact: 'package.json', observedBeforeAcceptance: true },
    },
  );
  assert.equal(evidence.judgmentRequest!.kind, 'EXECUTABLE');
  assert.equal(evidence.judgmentRequest!.recipientType, 'SYSTEM_EXECUTABLE_EVALUATOR');
  assert.equal(evidence.judgmentRequest!.recipientId, f.sessionId);
  await finishMessage(api, f);

  // The executor completed a turn and wrote no Task status. Only the L0 shell result may settle it.
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status, TaskStatus.OPEN);
  const acceptance = await dequeueAcceptance(api, f);
  assert.equal(acceptance.content, command);

  const rawOutput = 'first line\n  final line without trailing newline';
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: rawOutput,
  });
  assert.deepEqual(result, { ok: true, status: RunStatus.AWAITING_INPUT });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status, TaskStatus.DONE);
  const [request, commandResult] = await Promise.all([
    db.taskJudgmentRequest.findUniqueOrThrow({ where: { id: evidence.judgmentRequest!.id } }),
    db.taskExecutableJudgmentResult.findUniqueOrThrow({
      where: { requestId: evidence.judgmentRequest!.id },
    }),
  ]);
  assert.equal(request.status, 'DECIDED');
  assert.equal(request.decision, 'PASS');
  assert.equal(request.decidedByType, 'SYSTEM');
  assert.equal(request.decidedById, f.runnerId);
  assert.equal(commandResult.command, command);
  assert.equal(commandResult.expectedExitCode, 0);
  assert.equal(commandResult.actualExitCode, 0);
  assert.equal(commandResult.rawOutput, rawOutput);
  assert.equal(commandResult.recordedById, f.runnerId);
  const inputWake = await db.projectCoordinatorWake.findFirstOrThrow({
    where: { event: 'EXECUTABLE_RESULT_RECORDED', subjectId: request.id },
  });
  assert.equal(inputWake.status, 'CONSUMED');
  assert.equal(inputWake.consumerType, 'DERIVED_COMPLETION_EVALUATOR');
  assert.match(inputWake.subjectVersion, new RegExp(`^${commandResult.id}:`));
  await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: rawOutput,
  });
  assert.equal(
    await db.projectCoordinatorWake.count({
      where: { event: 'EXECUTABLE_RESULT_RECORDED', subjectId: request.id },
    }),
    1,
    'an unchanged command result is consumed once',
  );
  const comment = await db.taskComment.findFirstOrThrow({
    where: { taskId: f.taskId },
    orderBy: { createdAt: 'desc' },
  });
  assert.match(comment.body, /期望退出码：0[\s\S]*实际退出码：0[\s\S]*推导状态：DONE/);
  assert.ok(comment.body.endsWith(rawOutput), 'the raw combined output is stored untrimmed at the end');
  assert.equal(
    await db.projectBlocker.count(),
    0,
    'L0 settled the task mechanically, so the missing-judgment-path signal must not exist',
  );
  assert.doesNotMatch(comment.body, /ATTEMPT_ENDED_WITHOUT_JUDGMENT_PATH/);
  assert.doesNotMatch(comment.body, new RegExp(EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE));
});

suite('the real OPEN/no-evidence scenario runs true and stores its raw result', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  const f = await fixture(db, 'open-true', { command: 'true', expectedExitCode: 0 });
  const api = controller(db);
  assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: f.taskId } }), 0);
  assert.equal(await db.taskJudgmentRequest.count({ where: { taskId: f.taskId } }), 0);

  await finishMessage(api, f);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status, TaskStatus.OPEN);
  const acceptance = await dequeueAcceptance(api, f);
  assert.equal(acceptance.content, 'true');

  // This is the same bash contract the runner uses. `true` is genuinely executed here; its empty
  // stdout/stderr and numeric process status are then reported through the real runner endpoint.
  const shell = spawnSync('bash', ['-lc', acceptance.content!], { encoding: 'utf8' });
  assert.equal(shell.error, undefined);
  assert.equal(shell.status, 0);
  const rawOutput = `${shell.stdout}${shell.stderr}`;
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: shell.status!,
    shellOutput: rawOutput,
  });

  assert.deepEqual(result, { ok: true, status: RunStatus.AWAITING_INPUT });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status, TaskStatus.DONE);
  const comment = await db.taskComment.findFirstOrThrow({ where: { taskId: f.taskId } });
  assert.match(comment.body, /命令：true[\s\S]*期望退出码：0[\s\S]*实际退出码：0/);
  assert.ok(comment.body.endsWith(rawOutput), 'the empty raw output is stored without substitution');
});

suite('a different exit code derives FAILED, never OPEN', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  const f = await fixture(db, 'exit-nine', { command: 'exit 9', expectedExitCode: 0 });
  const api = controller(db);
  await finishMessage(api, f);
  const acceptance = await dequeueAcceptance(api, f);
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 9,
    shellOutput: 'assertion failed\n',
  });

  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });
  const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  assert.equal(task.status, TaskStatus.FAILED);
  assert.notEqual(task.status, TaskStatus.OPEN);
  const session = await db.session.findUniqueOrThrow({ where: { id: f.sessionId } });
  assert.equal(session.status, RunStatus.FAILED);
  assert.equal(
    await db.taskComment.count({
      where: {
        taskId: f.taskId,
        body: { contains: EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE },
      },
    }),
    0,
    'a declared L0 path remains the verdict owner even when its derived result is FAILED',
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

suite('an in-flight result cannot settle a declaration whose expected exit code changed', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  const command = 'printf stale';
  const f = await fixture(db, 'edited-expectation', { command, expectedExitCode: 0 });
  const api = controller(db);
  await finishMessage(api, f);
  const acceptance = await dequeueAcceptance(api, f);

  // Editing either half while the command is running creates a new declaration. The queued turn
  // remains durable evidence of what ran, but it cannot grade that new declaration.
  await tasksService(db).update(f.ownerId, f.taskId, { acceptanceExpectedExitCode: 7 });
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: 'stale',
  });

  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.OPEN,
    'no comparison means no guessed Task status',
  );
  const staleSignal = await db.taskComment.findFirstOrThrow({ where: { taskId: f.taskId } });
  assert.match(staleSignal.body, new RegExp(EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE));
  assert.match(staleSignal.body, /命令：printf stale[\s\S]*期望退出码：0/);
});

suite('an executable result from a different Session cannot consume the open request', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);

  const command = 'printf recipient-bound';
  const f = await fixture(db, 'wrong-evaluator', { command, expectedExitCode: 0 });
  const namedEvaluatorId = randomUUID();
  await db.session.create({
    data: {
      id: namedEvaluatorId,
      ownerId: f.ownerId,
      creatorId: f.ownerId,
      taskId: f.taskId,
      workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId,
      title: 'the evidence-bound evaluator',
      prompt: 'owns this judgment request',
      provider: 'claude',
      // A prior, terminal task Session may still be the source named by an evidence revision
      // while a recovered live Session is executing the command. Terminal keeps the fixture on
      // the legal side of the one-live-execution-claim invariant.
      status: RunStatus.SUCCEEDED,
      finishedAt: new Date(),
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: false,
    },
  });
  const evidence = await new TaskCompletionEvidenceService(
    db as unknown as PrismaService,
  ).submit(
    f.ownerId,
    f.taskId,
    { type: 'AGENT', id: f.workspaceId },
    {
      sourceSessionId: namedEvaluatorId,
      idempotencyKey: 'recipient-bound-executable-fact',
      evidence: { command, artifact: 'recipient-bound.txt' },
    },
  );
  assert.equal(evidence.judgmentRequest!.recipientId, namedEvaluatorId);

  const api = controller(db);
  await finishMessage(api, f);
  const acceptance = await dequeueAcceptance(api, f);
  const result = await api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: 'recipient-bound',
  });

  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.OPEN, 'the legacy L0 path cannot bypass an explicit request recipient');
  assert.equal((await db.taskJudgmentRequest.findUniqueOrThrow({
    where: { id: evidence.judgmentRequest!.id },
  })).status, 'OPEN');
  assert.equal(await db.taskExecutableJudgmentResult.count({
    where: { requestId: evidence.judgmentRequest!.id },
  }), 0);
  assert.equal(await db.taskComment.count({
    where: {
      taskId: f.taskId,
      body: { contains: EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE },
    },
  }), 1, 'a wrong evaluator leaves an actionable signal instead of a silent OPEN request');
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
