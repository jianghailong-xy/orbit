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

import { RunStatus as SharedRunStatus, TaskStatus as DeclaredTaskStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AttemptBudgetMeterService } from '../projects/attempt-budget-meter.service';
import { COORDINATOR_DISABLED } from '../projects/attempt-budget-meter';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { ConvergenceLedgerService } from '../projects/convergence-ledger.service';
import { EMPTY_PROGRESS_VECTOR, scopeHash } from '../projects/convergence-progress';
import { PROJECT_NOT_CONVERGING } from '../projects/coordinator-convergence';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { WakeFact } from '../projects/coordinator-wake';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { SessionAttemptService } from '../projects/session-attempt.service';
import {
  EXCEPTION_WAKE_COORDINATOR_DISABLED,
  TASK_EXCEPTION_CONSUMER,
  TaskExceptionInputProducer,
} from '../projects/task-exception-input.producer';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * What a task's ABNORMAL end owes the coordinator, and what may not be allowed to authorize it.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/task-exception-delivery.pg.spec.js
 *
 * Its two siblings cover the ordinary end: `task-write-settled-delivery.pg.spec.ts` a status that
 * was WRITTEN, `task-executable-settled-delivery.pg.spec.ts` one an exit code DERIVED. Neither can
 * see this, because `taskCompleted` is reported only for a derived DONE — the failing half of that
 * same callback reached nothing at all before the wiring under test here.
 *
 * Two things are asserted about every case, and the second is the point:
 *
 *   1. the fact reaches `project_coordinator_wake` at all, keyed on the attempt that ended; and
 *   2. it got there through `convergence.authorizeWake` and NOT through
 *      `CompletionInputRouter`'s always-allow default. An exception is exactly the input with no
 *      natural bound — "it failed, so open a successor, which failed, so open another" — so a
 *      wake authorized by a function that says yes to everything is the perpetual motion machine
 *      with a ledger row per revolution.
 *
 * Nothing below constructs a producer and calls it. Every case goes through a product door: the
 * runner's `turnComplete`, or `TasksService.update`.
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

/** A convergence service that refuses every wake, with the real unit's own refusal code. */
function refusingConvergence(): CoordinatorConvergenceService {
  return {
    authorizeWake: async () => ({ allowed: false as const, refusalCode: PROJECT_NOT_CONVERGING }),
  } as unknown as CoordinatorConvergenceService;
}

interface Stack {
  db: PrismaClient;
  api: RunnerApiController;
  tasks: TasksService;
  router: CompletionInputRouter;
  attempts: SessionAttemptService;
}

/**
 * The production wiring, over one client.
 *
 * `convergence` is the only seam: passing a refusing double is how a case asks "was this fact
 * authorized HERE", because a delivery that ate the router's default would never consult it and
 * would land CONSUMED instead of REFUSED.
 *
 * `wrapRouter` is the other: the case about the default authorizer substitutes a throwing sentinel
 * for an omitted fourth argument, so a call site that relies on the default fails loudly.
 */
async function connect(options: {
  convergence?: CoordinatorConvergenceService;
  wrapRouter?: (router: CompletionInputRouter) => CompletionInputRouter;
} = {}): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const convergence = options.convergence ?? new CoordinatorConvergenceService(prisma);
  const real = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorConvergenceService(prisma),
    ),
    new TaskExceptionInputProducer(prisma, convergence),
  );
  const router = options.wrapRouter ? options.wrapRouter(real) : real;
  const attempts = new SessionAttemptService(prisma, new ConvergenceLedgerService(prisma));
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router);
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    new AttemptBudgetMeterService(
      prisma,
      attempts,
      new CoordinatorWakeService(prisma),
      convergence,
    ),
    undefined,
    tasks,
  );
  return { db, api, tasks, router, attempts };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  messageTurnId: string;
}

/**
 * A project with one task and one session that is genuinely an attempt on it.
 *
 * The task is declared through `TasksService.create` when it has an acceptance command, so the
 * EXECUTABLE criterion is derived by the product rather than written into the row.
 */
async function fixture(
  stack: Stack,
  label: string,
  options: {
    coordinatorEnabled?: boolean;
    acceptance?: { command: string; expectedExitCode: number };
  } = {},
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
      email: `${label}-${ownerId}@task-exception.invalid`,
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
      goal: '让异常也被人决定下一步',
      acceptanceCriterionDefinitions: {
        create: [{
          ordinal: 1,
          text: '异常产出事实',
          verificationMethod: '整轮 full-api',
          contentHash: '0'.repeat(64),
        }],
      },
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: workspaceId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  const declared = await stack.tasks.create(ownerId, {
    title: label,
    assigneeId: workspaceId,
    projectId,
    ...(options.acceptance
      ? {
          acceptanceCommand: options.acceptance.command,
          acceptanceExpectedExitCode: options.acceptance.expectedExitCode,
        }
      : {}),
  });
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
      startedAt: new Date(),
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
  return { ownerId, runnerId, workspaceId, projectId, taskId: declared.id, sessionId, messageTurnId };
}

/** The model turn ends; the same transaction queues the declared command as a shell turn. */
async function finishMessage(stack: Stack, f: Fixture): Promise<void> {
  const result = await stack.api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: f.messageTurnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  assert.deepEqual(result, { ok: true, status: RunStatus.RUNNING });
}

async function dequeueAcceptance(stack: Stack, f: Fixture) {
  const next = await (stack.api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string; content?: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(f.sessionId, f.runnerId, null);
  assert.ok(next);
  assert.equal(next.taskAcceptance, true);
  return next;
}

/** The runner's own bash contract, so the compared number is one a shell really produced. */
function runAcceptance(command: string): { exitCode: number; output: string } {
  const shell = spawnSync('bash', ['-lc', command], { encoding: 'utf8' });
  assert.equal(shell.error, undefined);
  return { exitCode: shell.status!, output: `${shell.stdout}${shell.stderr}` };
}

/**
 * Drive a declared acceptance command all the way to its comparison, and return the task's status.
 *
 * Nothing here writes `task.status`: the only inputs are the queued command and the number bash
 * handed back, which is the settle path production actually takes.
 */
async function deriveFailedByExitCode(stack: Stack, f: Fixture): Promise<void> {
  await finishMessage(stack, f);
  const acceptance = await dequeueAcceptance(stack, f);
  const ran = runAcceptance(acceptance.content!);
  assert.equal(ran.exitCode, 7);
  const result = await stack.api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: ran.exitCode,
    shellOutput: ran.output,
  });
  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });
  assert.equal(
    (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
    TaskStatus.FAILED,
    'a comparable, disagreeing exit code is the conservative FAILED',
  );
}

/**
 * End the attempt without settling the task: a reserved acceptance turn whose result cannot be
 * compared at all.
 *
 * This is the older-runner case the controller names in as many words — the shell exit code is
 * absent, so nothing is compared and nothing may be concluded about the task. The session ends and
 * the task does not, which is precisely `ATTEMPT_ENDED_UNSETTLED`'s other reading.
 */
async function endAttemptWithoutSettling(stack: Stack, f: Fixture): Promise<void> {
  await finishMessage(stack, f);
  const acceptance = await dequeueAcceptance(stack, f);
  const result = await stack.api.turnComplete({ id: f.runnerId }, f.sessionId, {
    turnId: acceptance.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellOutput: 'the runner reported no exit code at all',
  });
  assert.deepEqual(result, { ok: true, status: RunStatus.FAILED });
  const after = await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  assert.ok(
    after.status === TaskStatus.OPEN || after.status === TaskStatus.IN_PROGRESS,
    'nothing was compared, so nothing was concluded about the task',
  );
}

function exceptionWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'ATTEMPT_ENDED_UNSETTLED' },
    select: {
      id: true, projectId: true, subjectId: true, subjectVersion: true,
      status: true, refusalCode: true, sessionId: true, consumerType: true, detail: true,
    },
    orderBy: { id: 'asc' },
  });
}

function budgetWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'ATTEMPT_BUDGET_SPENT' },
    select: {
      id: true, projectId: true, subjectId: true, subjectVersion: true,
      status: true, refusalCode: true, sessionId: true,
    },
    orderBy: { id: 'asc' },
  });
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

/** Push this attempt's CONTEXT over its frozen limit, using the session's own reported columns. */
async function spendContext(stack: Stack, f: Fixture): Promise<void> {
  const task = await stack.db.task.findUniqueOrThrow({
    where: { id: f.taskId },
    select: { title: true, description: true, acceptanceCriteria: true },
  });
  await stack.attempts.open(f.ownerId, f.taskId, {
    attemptKey: `dispatch:${f.sessionId}`,
    sessionId: f.sessionId,
    hypothesis: 'spend the context window and see who is told',
    progressVector: { ...EMPTY_PROGRESS_VECTOR, scopeHash: scopeHash(task) },
    observedAt: new Date(),
  });
  await stack.db.session.update({
    where: { id: f.sessionId },
    data: { contextTokens: 200_000, contextWindow: 200_000 },
  });
}

test('a task the runner door fails delivers ATTEMPT_ENDED_UNSETTLED, keyed on the attempt',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'exception-derived-failed', {
        acceptance: { command: 'exit 7', expectedExitCode: 0 },
      });
      assert.deepEqual(
        await exceptionWakes(stack.db, f.projectId), [],
        'nothing is abnormal while the declared command is still running',
      );

      await deriveFailedByExitCode(stack, f);

      const wakes = await exceptionWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the derived FAILED never reached the wake ledger');
      assert.equal(wakes[0]!.projectId, f.projectId);
      assert.equal(wakes[0]!.subjectId, f.taskId, 'the subject is the task that failed');
      assert.equal(
        wakes[0]!.subjectVersion, f.sessionId,
        'and its version is the attempt, so a second attempt on this task is a second fact',
      );
      assert.equal(wakes[0]!.status, 'CONSUMED');
      assert.equal(wakes[0]!.consumerType, TASK_EXCEPTION_CONSUMER);
      assert.equal(
        (wakes[0]!.detail as { taskStatus?: string }).taskStatus, TaskStatus.FAILED,
        'the reading that distinguishes a failure from an attempt that merely ended',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an attempt that ends with its task still open delivers the same fact',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'exception-unsettled', {
        acceptance: { command: 'true', expectedExitCode: 0 },
      });
      await endAttemptWithoutSettling(stack, f);

      const wakes = await exceptionWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'an attempt that ended over an open task woke nobody');
      assert.equal(wakes[0]!.subjectVersion, f.sessionId);
      assert.equal(wakes[0]!.status, 'CONSUMED');
      assert.notEqual(
        (wakes[0]!.detail as { taskStatus?: string }).taskStatus, TaskStatus.FAILED,
        'this reading is the OPEN one — the task was not concluded, the attempt was',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a run that files its own FAILED through the task door delivers it too',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'exception-self-reported');
      // The attempt ends first, as it does in production: FAILED is a run's conservative
      // self-report about work that has already stopped.
      await stack.db.session.update({
        where: { id: f.sessionId },
        data: { status: RunStatus.FAILED },
      });
      await stack.tasks.update(f.ownerId, f.taskId, { status: DeclaredTaskStatus.FAILED });

      const wakes = await exceptionWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the task write path delivered no exception fact');
      assert.equal(wakes[0]!.subjectId, f.taskId);
      assert.equal(wakes[0]!.subjectVersion, f.sessionId);
      assert.equal(wakes[0]!.status, 'CONSUMED');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the exception delivery is handed rows the transaction has already committed',
  { skip, timeout: 180_000 }, async () => {
    // A second client, therefore a second connection pool: what it can see is what anybody
    // outside the writing transaction can see. A delivery made from inside `update`'s transaction
    // would read the status the task had BEFORE the write, or block on its row lock.
    const outside = prismaClientFor(URL!);
    const observed: Array<{ taskIds: string[]; statuses: string[] }> = [];
    const probe = (real: CompletionInputRouter) => new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'routeTaskExceptions') {
          return async (taskIds: ReadonlyArray<string | null | undefined>) => {
            const named = taskIds.filter((id): id is string => !!id);
            const rows = await outside.task.findMany({
              where: { id: { in: named } },
              select: { status: true },
              orderBy: { id: 'asc' },
            });
            observed.push({ taskIds: named, statuses: rows.map((row) => row.status) });
            return [];
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const stack = await connect({ wrapRouter: probe });
    try {
      const f = await fixture(stack, 'exception-after-commit');
      // `dependsOnTaskIds` puts this write on `update`'s interactive-transaction branch, where
      // "inside or outside the transaction" is a real difference rather than one autocommit
      // statement that has already ended.
      await stack.tasks.update(
        f.ownerId, f.taskId, { status: DeclaredTaskStatus.FAILED, dependsOnTaskIds: [] },
      );

      assert.ok(observed.length > 0, 'the committed write delivered nothing to the router');
      assert.ok(
        observed.some((call) => call.taskIds.includes(f.taskId)),
        'the delivery did not name the task the write touched',
      );
      for (const call of observed) {
        assert.deepEqual(
          call.statuses, ['FAILED'],
          'the delivery ran before its own write was visible outside the transaction',
        );
      }
    } finally {
      await outside.$disconnect();
      await stack.db.$disconnect();
    }
  });

test('a failed task is refused by convergence, not waved through by a default',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect({ convergence: refusingConvergence() });
    try {
      const f = await fixture(stack, 'exception-not-converging', {
        acceptance: { command: 'exit 7', expectedExitCode: 0 },
      });
      await deriveFailedByExitCode(stack, f);

      const wakes = await exceptionWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the fact did not travel far enough to be refused');
      assert.equal(
        wakes[0]!.status, 'REFUSED',
        'a project that is not converging still consumed the exception — the default was eaten',
      );
      assert.equal(wakes[0]!.refusalCode, PROJECT_NOT_CONVERGING);
      assert.equal(wakes[0]!.sessionId, null);
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an attempt that ended over an open task is refused by convergence the same way',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect({ convergence: refusingConvergence() });
    try {
      const f = await fixture(stack, 'exception-unsettled-not-converging', {
        acceptance: { command: 'true', expectedExitCode: 0 },
      });
      await endAttemptWithoutSettling(stack, f);

      const wakes = await exceptionWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, PROJECT_NOT_CONVERGING);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a spent attempt budget is refused by convergence too',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect({ convergence: refusingConvergence() });
    try {
      const f = await fixture(stack, 'budget-not-converging');
      await spendContext(stack, f);
      // An ordinary turn ending. T5 charges the budget where the spend is COMMITTED, which is
      // this callback — nothing here calls the meter directly.
      await stack.api.turnComplete({ id: f.runnerId }, f.sessionId, {
        turnId: f.messageTurnId,
        status: SharedRunStatus.SUCCEEDED,
      });

      const wakes = await budgetWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the spent budget never reached the wake ledger');
      assert.equal(wakes[0]!.subjectVersion, f.sessionId);
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, PROJECT_NOT_CONVERGING);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a spent attempt budget reaches the ledger through the runner door itself',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'budget-spent-wire');
      await spendContext(stack, f);
      await stack.api.turnComplete({ id: f.runnerId }, f.sessionId, {
        turnId: f.messageTurnId,
        status: SharedRunStatus.SUCCEEDED,
      });

      const wakes = await budgetWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.subjectId, f.taskId);
      assert.notEqual(wakes[0]!.status, 'REFUSED');
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * The fourth argument, asserted by taking the default away.
 *
 * `ALLOW_COMMITTED_INPUT` is not exported and this does not reach into the module to swap it: it
 * substitutes a THROWING sentinel wherever `route` is called without a fourth argument, which is
 * exactly the situation the default exists to cover. A call site that relied on the default cannot
 * survive that, and the control below proves the sentinel is really armed.
 */
test('the exception path does not eat route()\'s default authorizer',
  { skip, timeout: 180_000 }, async () => {
    let defaulted = 0;
    const sentinel = async () => {
      defaulted += 1;
      throw new Error('route() fell back to its default authorizer');
    };
    const substitute = (real: CompletionInputRouter) => new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'route') {
          return (
            fact: WakeFact,
            consumer: Parameters<CompletionInputRouter['route']>[1],
            deliver?: Parameters<CompletionInputRouter['route']>[2],
            authorize?: Parameters<CompletionInputRouter['route']>[3],
          ) => target.route(fact, consumer, deliver, authorize ?? sentinel);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const stack = await connect({ wrapRouter: substitute });
    try {
      const f = await fixture(stack, 'exception-explicit-authorizer', {
        acceptance: { command: 'exit 7', expectedExitCode: 0 },
      });
      await deriveFailedByExitCode(stack, f);

      const wakes = await exceptionWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1);
      assert.equal(
        wakes[0]!.status, 'CONSUMED',
        'the exception delivery reached the sentinel, so it passes no authorizer of its own',
      );
      assert.equal(defaulted, 0, 'the exception path fell back to the default authorizer');

      // The control: a caller that DOES omit the fourth argument gets the sentinel. Without this
      // the case above would pass just as well over a router that ignores the substitution.
      await assert.rejects(
        () => stack.router.route(
          {
            event: 'COMPLETION_EVIDENCE_REVISED',
            projectId: f.projectId,
            subjectType: 'TASK',
            subjectId: f.taskId,
            subjectVersion: 'default-authorizer-control',
          },
          'JUDGMENT_REQUEST_DERIVER',
        ),
        /default authorizer/,
        'the sentinel is not armed, so the assertion above proves nothing',
      );
      assert.equal(defaulted, 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a failed task under a switched-off coordinator produces nothing and wakes nobody',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'exception-disabled-failed', {
        coordinatorEnabled: false,
        acceptance: { command: 'exit 7', expectedExitCode: 0 },
      });
      await deriveFailedByExitCode(stack, f);

      // No judgment session, and no wake holding the fact's key. What IS written is the refusal:
      // the ledger claims before it authorizes, so "it silently did nothing" is not a state this
      // path can be in — and the one row is the only proof the fact reached the ledger at all.
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      const wakes = await exceptionWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the failed task never reached the wake ledger');
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, EXCEPTION_WAKE_COORDINATOR_DISABLED);
      assert.equal(wakes[0]!.sessionId, null);
      assert.equal(wakes[0]!.consumerType, null);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an attempt that ended over an open task wakes nobody either, when the switch is off',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'exception-disabled-unsettled', {
        coordinatorEnabled: false,
        acceptance: { command: 'true', expectedExitCode: 0 },
      });
      await endAttemptWithoutSettling(stack, f);

      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      const wakes = await exceptionWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the ended attempt never reached the wake ledger');
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, EXCEPTION_WAKE_COORDINATOR_DISABLED);
      assert.equal(wakes[0]!.sessionId, null);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a spent budget under a switched-off coordinator wakes nobody',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'budget-disabled', { coordinatorEnabled: false });
      await spendContext(stack, f);
      await stack.api.turnComplete({ id: f.runnerId }, f.sessionId, {
        turnId: f.messageTurnId,
        status: SharedRunStatus.SUCCEEDED,
      });

      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      const wakes = await budgetWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the spent budget never reached the wake ledger');
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, COORDINATOR_DISABLED);
      assert.equal(wakes[0]!.sessionId, null);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the task-exception PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
