import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { RunStatus as SharedRunStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import {
  ProjectTasksSettledProducer,
  SETTLED_WAKE_COORDINATOR_DISABLED,
  type SettledProjectDelivery,
} from '../projects/project-tasks-settled.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * The settle path production actually takes, and the delivery it owes the coordinator.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/task-executable-settled-delivery.pg.spec.js
 *
 * Its sibling `task-write-settled-delivery.pg.spec.ts` drives the delivery from `TasksService`,
 * where a status is WRITTEN. That is the rarer half of production: most tasks reach a terminal
 * status because a declared acceptance command exited and the runner callback compared its code
 * against `acceptanceExpectedExitCode`. Nothing in this file writes a status — the only inputs
 * are a queued shell turn and the number bash handed back — so what is asserted here is that the
 * DERIVED status reaches the same delivery, and not a second one built beside it.
 *
 * The route is the product's own: `turnComplete` (the model turn) queues the declared command,
 * `dequeueTurn` reserves it, `turnComplete` (the shell turn) compares the code under the task's
 * lock and writes DONE or FAILED through 0193's fence. The DONE case then leaves that transaction
 * and reaches the completion edge every criterion shares, which is where the settled project is
 * delivered. The controller is constructed with the real `TasksService` because that argument IS
 * the wire under test; a fixture that passes `undefined` for it — as the specs about the
 * comparison itself do — cannot see this at all.
 *
 * The wake ledger's guards are the producer's own and are asserted as such: the switched-off
 * coordinator below is refused with the producer's own code AFTER the delivery reached it, which
 * is a different fact from a caller that decided not to deliver.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

interface Stack {
  db: PrismaClient;
  /** The runner door, holding the one `TasksService` the production module gives it. */
  api: RunnerApiController;
  tasks: TasksService;
  /** Every `PROJECT_TASKS_SETTLED` outcome the router reported, in delivery order. */
  deliveries: SettledProjectDelivery[];
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const real = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorConvergenceService(prisma),
    ),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );

  // The real router, observed rather than replaced: a Proxy that records what each delivery
  // ANSWERED and hands the answer back. A refusal and `NOT_SETTLED` are outcomes the ledger alone
  // cannot always show — one of them writes no row — so the cases below assert both what came
  // back and what landed.
  const deliveries: SettledProjectDelivery[] = [];
  const router = new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'routeSettledProjects') {
        return async (projectIds: ReadonlyArray<string | null | undefined>) => {
          const answered = await target.routeSettledProjects(projectIds);
          deliveries.push(...answered);
          return answered;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const tasks = new TasksService(prisma, sessions, realtime, undefined, router);
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
  );
  return { db, api, tasks, deliveries };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  messageTurnId: string;
  /** Present only when the case asked for a task the derivation below cannot settle. */
  unfinishedTaskId?: string;
}

async function fixture(
  stack: Stack,
  label: string,
  acceptance: { command: string; expectedExitCode: number },
  options: { coordinatorEnabled?: boolean; unfinishedSibling?: boolean } = {},
): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@executable-settled.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 唤醒项目`,
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: workspaceId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  // A task the acceptance command below cannot settle, for the cases that need the project to
  // still have work outstanding. IN_PROGRESS is not a completion claim, so no fence is involved.
  let unfinishedTaskId: string | undefined;
  if (options.unfinishedSibling) {
    unfinishedTaskId = randomUUID();
    await db.task.create({
      data: {
        id: unfinishedTaskId,
        ownerId,
        projectId,
        assigneeId: workspaceId,
        title: `${label} 未完成的同伴`,
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        status: TaskStatus.IN_PROGRESS,
      },
    });
  }

  const declared = await stack.tasks.create(ownerId, {
    title: label,
    assigneeId: workspaceId,
    projectId,
    acceptanceCommand: acceptance.command,
    acceptanceExpectedExitCode: acceptance.expectedExitCode,
  });
  assert.equal(declared.completionCriterion, 'EXECUTABLE');
  assert.equal(declared.status, TaskStatus.OPEN, 'the declaration is not a status');

  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      taskId: declared.id,
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
  return {
    ownerId,
    runnerId,
    workspaceId,
    projectId,
    taskId: declared.id,
    sessionId,
    messageTurnId,
    unfinishedTaskId,
  };
}

/** The model turn ends; the same transaction queues the declared command as a shell turn. */
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

/** The runner's own bash contract, so the compared number is one a shell really produced. */
function runAcceptance(command: string): { exitCode: number; output: string } {
  const shell = spawnSync('bash', ['-lc', command], { encoding: 'utf8' });
  assert.equal(shell.error, undefined);
  return { exitCode: shell.status!, output: `${shell.stdout}${shell.stderr}` };
}

function reportAcceptance(
  api: RunnerApiController,
  f: Fixture,
  turnId: string,
  exitCode: number,
  output: string,
) {
  return api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: exitCode,
    shellOutput: output,
  });
}

function settledWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'PROJECT_TASKS_SETTLED' },
    select: { id: true, projectId: true, status: true, refusalCode: true, sessionId: true },
    orderBy: { id: 'asc' },
  });
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

test('an acceptance exit code that matches derives DONE and delivers the settled project',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'derived-done-wakes', { command: 'true', expectedExitCode: 0 });
      await finishMessage(stack.api, f);
      const acceptance = await dequeueAcceptance(stack.api, f);
      assert.equal(acceptance.content, 'true', 'the queued command is the declared one');
      assert.deepEqual(
        await settledWakes(stack.db, f.projectId), [],
        'nothing is settled while the only task in the project is still running its command',
      );

      const ran = runAcceptance(acceptance.content!);
      assert.equal(ran.exitCode, 0);
      const result = await reportAcceptance(stack.api, f, acceptance.turnId, ran.exitCode, ran.output);
      assert.deepEqual(result, { ok: true, status: RunStatus.AWAITING_INPUT });

      const after = await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } });
      assert.equal(
        after.status, TaskStatus.DONE,
        'the comparison between 0 and the declared 0 is the only thing that wrote this status',
      );

      const wakes = await settledWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the derived DONE settled the project and delivered nothing');
      assert.equal(wakes[0]!.projectId, f.projectId);
      assert.equal(wakes[0]!.status, 'SESSION_OPENED');
      assert.deepEqual(stack.deliveries, [{ projectId: f.projectId, outcome: 'OPENED' }]);
      // The consequence the row is FOR: one judgment session, named by the wake that opened it.
      const opened = await judgmentSessions(stack.db, f.ownerId);
      assert.equal(opened.length, 1);
      assert.equal(wakes[0]!.sessionId, opened[0]!.id);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an acceptance exit code that disagrees derives FAILED and settles nothing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(
        stack, 'derived-failed', { command: 'exit 7', expectedExitCode: 0 },
        { unfinishedSibling: true },
      );
      await finishMessage(stack.api, f);
      const acceptance = await dequeueAcceptance(stack.api, f);
      const ran = runAcceptance(acceptance.content!);
      assert.equal(ran.exitCode, 7);
      const result = await reportAcceptance(stack.api, f, acceptance.turnId, ran.exitCode, ran.output);
      assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });

      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
        TaskStatus.FAILED,
        'a comparable, disagreeing exit code is the conservative FAILED',
      );
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: f.unfinishedTaskId! } })).status,
        TaskStatus.IN_PROGRESS,
        'and the project it belongs to still has work nobody has finished',
      );

      // A failure is not a settled task set. Whether this edge delivers at all is the abnormal
      // fact wiring's question, not this one's; what may not happen is a project being called
      // settled while two of its tasks are anything but.
      assert.deepEqual(await settledWakes(stack.db, f.projectId), []);
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      assert.deepEqual(
        stack.deliveries.filter((delivery) => delivery.outcome !== 'NOT_SETTLED'), [],
        'a project with two unsettled tasks reported something other than NOT_SETTLED',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an acceptance killed at its budget reports -1, derives FAILED and settles nothing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(
        stack, 'killed-at-budget', { command: 'sleep 86400', expectedExitCode: 0 },
        { unfinishedSibling: true },
      );
      await finishMessage(stack.api, f);
      const acceptance = await dequeueAcceptance(stack.api, f);
      assert.equal(acceptance.content, 'sleep 86400');

      // The command is deliberately NOT run: a process killed at its budget never returns a code
      // of its own, and -1 is what the runner reports for it (`runner-go/shell.go`, SIGKILL leaves
      // Go's ExitCode() at -1). Since 0227 removed the typed termination, that -1 is compared like
      // any other number, so this is a complete and honest report of that turn.
      const result = await reportAcceptance(
        stack.api, f, acceptance.turnId, -1,
        '[orbit: killed at this shell turn\'s budget]',
      );
      assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });

      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
        TaskStatus.FAILED,
        '-1 is a code that disagrees with the declared 0, and derives FAILED like any other',
      );
      // The comparison ran, so the needs-human signal did not: a comment here would mean the turn
      // produced nothing comparable, which is the opposite of what happened.
      assert.deepEqual(await stack.db.taskComment.findMany({ where: { taskId: f.taskId } }), []);
      assert.deepEqual(await settledWakes(stack.db, f.projectId), []);
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      assert.deepEqual(
        stack.deliveries.filter((delivery) => delivery.outcome !== 'NOT_SETTLED'), [],
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the switched-off coordinator is refused by the producer, not short-circuited by the caller',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(
        stack, 'derived-done-disabled', { command: 'true', expectedExitCode: 0 },
        { coordinatorEnabled: false },
      );
      await finishMessage(stack.api, f);
      const acceptance = await dequeueAcceptance(stack.api, f);
      const ran = runAcceptance(acceptance.content!);
      await reportAcceptance(stack.api, f, acceptance.turnId, ran.exitCode, ran.output);
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
        TaskStatus.DONE,
      );

      // The switch is not read by the door that delivers. The fact travelled the whole way and
      // was refused where the permission lives, which is why there is an answer to record at all:
      // a caller returning early would have produced no delivery and no row.
      assert.deepEqual(stack.deliveries, [{ projectId: f.projectId, outcome: 'REFUSED' }]);
      const wakes = await settledWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, SETTLED_WAKE_COORDINATOR_DISABLED);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a derived DONE under a switched-off coordinator wakes nobody',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(
        stack, 'derived-done-wakes-nobody', { command: 'true', expectedExitCode: 0 },
        { coordinatorEnabled: false },
      );
      await finishMessage(stack.api, f);
      const acceptance = await dequeueAcceptance(stack.api, f);
      const ran = runAcceptance(acceptance.content!);
      await reportAcceptance(stack.api, f, acceptance.turnId, ran.exitCode, ran.output);
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
        TaskStatus.DONE,
        'the derivation itself is unaffected by the switch — only the wake is',
      );

      // No judgment session, and no wake holding the fact's key. What IS written is the refusal:
      // the ledger claims before it authorizes, so "it silently did nothing" is not a state this
      // path can be in, and the one row proves the derived DONE reached the ledger at all.
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      const wakes = await settledWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the derived DONE never reached the wake ledger');
      assert.equal(wakes[0]!.sessionId, null);
      assert.notEqual(wakes[0]!.status, 'SESSION_OPENED');
    } finally {
      await stack.db.$disconnect();
    }
  });
