import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
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
import { CoordinatorDeliveryService } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import { criteriaFromDefinitions } from '../projects/project-acceptance';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { ProjectsService } from '../projects/projects.service';
import {
  EXCEPTION_WAKE_COORDINATOR_DISABLED,
  TASK_EXCEPTION_CONSUMER,
  TaskExceptionInputProducer,
} from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * Waking is not opening a session: the SAME fact lands in two different places, and the difference
 * is one acceptance criterion's coverage.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/task-wake-disposition.pg.spec.js
 *
 * WHY BOTH HALVES OF EVERY CASE ARE `ATTEMPT_ENDED_UNSETTLED`
 * ==========================================================
 * Deliberate, and the whole claim. A rule that answered by looking at the EVENT would be a lookup
 * table wearing a rule's clothes — and every event kind already had a fixed terminal before this,
 * so a case that paired two different kinds would pass over the old code too. Each case below
 * therefore fails two tasks the same way, in one project, through one door, and moves exactly one
 * thing between them: whether the criterion the failed task served still has other work outstanding.
 *
 * WHAT SETTLES THE WORK
 * =====================
 * Nothing here writes a task status. Every serving task declares an acceptance command that exits
 * 7 against a declared 0, and reaches FAILED the way production does it: `turnComplete` queues the
 * command, `dequeueTurn` reserves it, bash runs it, and `turnComplete` compares the code it
 * returned with the declared one under the task's own row lock.
 *
 * WHY EVERY PROJECT KEEPS A CHORE OPEN
 * ====================================
 * So the project can never settle. `PROJECT_TASKS_SETTLED` is the one fact that already opened a
 * judgment session before this unit existed, and a case that let a project settle could not tell
 * the session it asserts from the session that door opens. Every case asserts that door delivered
 * nothing.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';
/** The declaration every serving task carries, so its FAILED is a comparison that happened. */
const ACCEPTANCE = { acceptanceCommand: 'exit 7', acceptanceExpectedExitCode: 0 };

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
  projects: ProjectsService;
}

/** The production wiring, over one client. Nothing here is doubled: there is no seam to take. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorConvergenceService(prisma),
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new WakeDispositionService(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new CriterionUnlandedProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router);
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    // No attempt-budget meter: `ATTEMPT_BUDGET_SPENT` is a different fact with its own producer,
    // and a second event kind in these ledgers would make "which fact opened this session" a
    // question the assertions could not answer.
    undefined,
    undefined,
    tasks,
  );
  const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma));
  return { db, api, tasks, projects };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The task that serves no criterion and never finishes, so the project cannot settle. */
  choreTaskId: string;
}

async function fixture(
  stack: Stack,
  label: string,
  options: { coordinatorEnabled?: boolean } = {},
): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@wake-disposition.invalid`,
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
      goal: '唤醒不等于开会话',
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: workspaceId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  const chore = await stack.tasks.create(ownerId, {
    title: `${label} 与任何标准无关的杂活`,
    assigneeId: workspaceId,
    projectId,
    completionCriterion: 'EVIDENCE_JUDGMENT',
  } as never);
  return { ownerId, runnerId, workspaceId, projectId, choreTaskId: chore.id };
}

/** State the whole collection through the owner's own path, and read the stable keys back. */
async function state(stack: Stack, f: Fixture, texts: string[]) {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems);
}

/** File one piece of EXECUTABLE work against a criterion, through the door that resolves the key. */
async function serve(stack: Stack, f: Fixture, criterionKey: string, title: string) {
  const declared = await stack.tasks.create(f.ownerId, {
    title,
    assigneeId: f.workspaceId,
    projectId: f.projectId,
    criterionKey,
    ...ACCEPTANCE,
  } as never);
  assert.equal(declared.completionCriterion, 'EXECUTABLE');
  assert.equal(declared.status, TaskStatus.OPEN, 'the declaration is not a status');
  return declared.id;
}

/**
 * End one task's attempt badly, the way production ends most of them: a declared acceptance
 * command whose exit code disagrees with the one the task declared.
 *
 * The whole route is the product's own — an attempt session, the model turn that ends, the shell
 * turn the same transaction queues, a real bash exit code, and the comparison `turnComplete` makes
 * under the task's row lock. This function never writes `task.status`.
 */
async function failByAcceptance(stack: Stack, f: Fixture, taskId: string, label: string) {
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: f.ownerId,
      creatorId: f.ownerId,
      taskId,
      workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId,
      title: label,
      prompt: label,
      provider: 'claude',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await stack.db.conversationTurn.create({
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
  const opened = await stack.api.turnComplete({ id: f.runnerId }, sessionId, {
    turnId: messageTurnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  assert.deepEqual(opened, { ok: true, status: RunStatus.RUNNING });

  const next = await (stack.api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string; content?: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, f.runnerId, null);
  assert.ok(next);
  assert.equal(next.kind, 'shell');
  assert.equal(next.taskAcceptance, true);
  assert.equal(next.content, ACCEPTANCE.acceptanceCommand, 'the queued command is the declared one');

  const shell = spawnSync('bash', ['-lc', next.content!], { encoding: 'utf8' });
  assert.equal(shell.error, undefined);
  assert.equal(shell.status, 7);
  const ended = await stack.api.turnComplete({ id: f.runnerId }, sessionId, {
    turnId: next.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: shell.status!,
    shellOutput: `${shell.stdout}${shell.stderr}`,
  });
  assert.deepEqual(ended, { ok: true, status: RunStatus.FAILED });

  assert.equal(
    (await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status,
    TaskStatus.FAILED,
    'the comparison between the declared code and the one bash returned is what wrote this status',
  );
}

const WAKE_COLUMNS = {
  event: true,
  subjectType: true,
  subjectId: true,
  status: true,
  refusalCode: true,
  consumerType: true,
  sessionId: true,
  detail: true,
} as const;

function exceptionWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'ATTEMPT_ENDED_UNSETTLED' },
    select: WAKE_COLUMNS,
  });
}

/** The one ledger row this task's ended attempt left. Looked up by subject, never by row order. */
async function wakeOf(db: PrismaClient, projectId: string, taskId: string) {
  const rows = await exceptionWakes(db, projectId);
  const mine = rows.filter((row) => row.subjectId === taskId);
  assert.equal(mine.length, 1, `the ended attempt on ${taskId} left ${mine.length} ledger rows`);
  return mine[0]!;
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

/** Nothing below may reach the door that opened judgment sessions before this unit existed. */
async function assertProjectNeverSettled(stack: Stack, f: Fixture) {
  assert.equal(
    (await stack.db.task.findUniqueOrThrow({ where: { id: f.choreTaskId } })).status,
    TaskStatus.OPEN,
  );
  assert.deepEqual(
    await stack.db.projectCoordinatorWake.findMany({
      where: { projectId: f.projectId, event: 'PROJECT_TASKS_SETTLED' },
    }),
    [],
    'a settled-project wake could have opened the session this case attributes to a failure',
  );
}

test('the same failure is recorded when its criterion still has work, and judged when it does not',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'two-terminals');
      const [covered, alone] = await state(stack, f, [
        '这条标准有两件活服务它', '这条标准只有一件活服务它',
      ]);
      const withSibling = await serve(stack, f, covered!.key, '两件活里先失败的那一件');
      const stillOpen = await serve(stack, f, covered!.key, '两件活里还没跑的那一件');
      const onlyWork = await serve(stack, f, alone!.key, '服务第二条标准的唯一一件活');

      // ── the event that changes nothing: its criterion still has work outstanding ─────────────
      await failByAcceptance(stack, f, withSibling, 'failed-with-a-sibling');
      const recorded = await wakeOf(stack.db, f.projectId, withSibling);
      assert.equal(recorded.status, 'CONSUMED', 'a failure that changed no coverage opened a session');
      assert.equal(recorded.consumerType, TASK_EXCEPTION_CONSUMER);
      assert.equal(recorded.sessionId, null);

      // Not a refusal. The switch is on and convergence allowed this wake — it simply was not
      // worth interrupting anybody for, and those are two different rows in this ledger.
      assert.notEqual(recorded.status, 'REFUSED');
      assert.equal(recorded.refusalCode, null);

      assert.deepEqual(
        await judgmentSessions(stack.db, f.ownerId), [],
        'a failure whose criterion still has work outstanding woke somebody',
      );
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: stillOpen } })).status,
        TaskStatus.OPEN,
        'the outstanding work is what made the first failure change nothing',
      );

      // ── the event that changes everything: it was the only work serving its criterion ────────
      await failByAcceptance(stack, f, onlyWork, 'failed-alone');
      const judged = await wakeOf(stack.db, f.projectId, onlyWork);
      assert.equal(judged.status, 'SESSION_OPENED');
      assert.equal(judged.consumerType, null);

      const opened = await judgmentSessions(stack.db, f.ownerId);
      assert.equal(opened.length, 1, 'the criterion that lost its only work woke nobody');
      assert.equal(
        judged.sessionId, opened[0]!.id,
        'the ledger row must name the session it opened, or the two are unrelated facts',
      );

      // ── and the rule really told them apart ──────────────────────────────────────────────────
      assert.notEqual(
        recorded.status, judged.status,
        'both facts stopped in the same square: nothing distinguished them',
      );
      assert.equal(
        recorded.event, judged.event,
        'the two rows must be the SAME event, or the rule could be a lookup on the event kind',
      );
      for (const row of [recorded, judged]) {
        assert.equal((row.detail as Record<string, unknown>).taskStatus, TaskStatus.FAILED);
        assert.equal(row.subjectType, 'TASK');
      }

      await assertProjectNeverSettled(stack, f);
      assert.equal((await exceptionWakes(stack.db, f.projectId)).length, 2);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a switched-off coordinator records both kinds of event and opens neither',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      // ── the control, and it is what makes the negative mean anything ─────────────────────────
      // "Nobody was woken" is true of a switched-off project, of a broken rule, and of a delivery
      // that never happened. So the same shape runs first with the switch ON: if the decisive
      // failure below does not open a session HERE, the assertions after it are asserting nothing.
      const on = await fixture(stack, 'switch-on');
      const [onlyOn] = await state(stack, on, ['开关开着时这条标准只有一件活']);
      const onWork = await serve(stack, on, onlyOn!.key, '开关开着时唯一的一件活');
      await failByAcceptance(stack, on, onWork, 'switched-on');

      assert.equal((await wakeOf(stack.db, on.projectId, onWork)).status, 'SESSION_OPENED');
      assert.equal(
        (await judgmentSessions(stack.db, on.ownerId)).length, 1,
        'the control never opened a session, so the negative below proves nothing',
      );
      await assertProjectNeverSettled(stack, on);

      // ── and now the same two shapes with the switch off ──────────────────────────────────────
      const off = await fixture(stack, 'switch-off', { coordinatorEnabled: false });
      const [covered, alone] = await state(stack, off, [
        '开关关着时这条标准有两件活', '开关关着时这条标准只有一件活',
      ]);
      const withSibling = await serve(stack, off, covered!.key, '开关关着时先失败的那一件');
      await serve(stack, off, covered!.key, '开关关着时还没跑的那一件');
      const onlyWork = await serve(stack, off, alone!.key, '开关关着时唯一的一件活');

      await failByAcceptance(stack, off, withSibling, 'switched-off-covered');
      await failByAcceptance(stack, off, onlyWork, 'switched-off-alone');

      // Not "zero rows": the ledger claims before it authorizes, so a fact that travelled the whole
      // way and was refused leaves EXACTLY ONE row saying so. Both kinds of event travelled — the
      // one that would have been recorded and the one that would have been judged — and the switch
      // refused both on the same terms, which is what proves the terminal chooser runs BESIDE
      // authorization rather than in front of it.
      for (const [taskId, kind] of [[withSibling, 'covered'], [onlyWork, 'alone']] as const) {
        const row = await wakeOf(stack.db, off.projectId, taskId);
        assert.equal(row.status, 'REFUSED', `the ${kind} failure was not refused`);
        assert.equal(row.refusalCode, EXCEPTION_WAKE_COORDINATOR_DISABLED);
        assert.equal(row.sessionId, null);
        assert.equal(row.consumerType, null);
        assert.notEqual(row.status, 'SESSION_OPENED');
      }
      assert.deepEqual(
        await judgmentSessions(stack.db, off.ownerId), [],
        'a switched-off coordinator was woken',
      );

      // The switch is not read by the door that delivers: the work failed exactly as it would have
      // with the switch on, and only the wake was refused.
      for (const taskId of [withSibling, onlyWork]) {
        assert.equal(
          (await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status,
          TaskStatus.FAILED,
        );
      }
      await assertProjectNeverSettled(stack, off);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the wake-disposition PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
