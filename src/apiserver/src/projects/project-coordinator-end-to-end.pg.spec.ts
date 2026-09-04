/**
 * T8's one-piece replay over the real PostgreSQL write paths.
 *
 * This is deliberately one scenario rather than a collection of T1–T7 examples: a project is
 * created coordinated, a prerequisite release is recovered by T1's backstop, the resulting task
 * fails through the runner transaction, T2/T3/T4 open a one-shot judgment, that judgment exercises
 * T6 by filing replacement work, and T7 observes the dynamically grown task set settle before an
 * acceptance run is opened from the next judgment.
 *
 * Destructive: COORDINATOR_PG_URL must pass coordinator-pg-test-safety and point at a disposable
 * database with all migrations applied. Run this spec alone; do not share its PostgreSQL target.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  CreatorType,
  PrismaClient,
  ProjectStatus,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
  TaskStatus,
  TaskVerdict,
} from '@prisma/client';
import { RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { completeHumanTaskForPgTest } from '../tasks/task-completion-test-helper';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { AttemptEndedUnsettledProducer } from './attempt-ended-unsettled.producer';
import { CompletionInputRouter } from './completion-input-router.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { establishProjectContractForPgTest } from './project-contract-test-helper';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

interface Stack {
  db: PrismaClient;
  sessions: SessionsService;
  tasks: TasksService;
  projects: ProjectsService;
  acceptance: ProjectAcceptanceService;
  runnerApi: RunnerApiController;
  attemptEnded: AttemptEndedUnsettledProducer;
  settled: ProjectTasksSettledProducer;
}

function realtimeStub(): RealtimeService {
  return new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
}

function buildStack(db: PrismaClient): Stack {
  const prisma = db as unknown as PrismaService;
  const realtime = realtimeStub();
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const acceptance = new ProjectAcceptanceService(prisma);
  const convergence = new CoordinatorConvergenceService(prisma);
  const judgments = new CoordinatorJudgmentService(
    prisma,
    new CoordinatorWakeService(prisma),
    sessions,
  );
  const attemptEnded = new AttemptEndedUnsettledProducer(prisma, judgments, convergence);
  const settled = new ProjectTasksSettledProducer(prisma, judgments, convergence);
  const tasks = new TasksService(prisma, sessions, realtime);
  return {
    db,
    sessions,
    tasks,
    projects: new ProjectsService(prisma, acceptance, sessions),
    acceptance,
    attemptEnded,
    settled,
    runnerApi: new RunnerApiController(
      prisma,
      queue,
      realtime,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
    ),
  };
}

async function settleEveryProjectTask(
  stack: Stack,
  ownerId: string,
  projectId: string,
): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    const unfinished = await stack.db.task.findMany({
      where: {
        projectId,
        status: { notIn: [TaskStatus.DONE, TaskStatus.CANCELLED] },
      },
      select: { id: true, verifiesTaskId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (unfinished.length === 0) return;
    for (const task of unfinished) {
      if (task.verifiesTaskId) {
        await stack.tasks.update(
          ownerId,
          task.id,
          { status: TaskStatus.DONE, verdict: TaskVerdict.PASS } as never,
        );
      } else {
        await completeHumanTaskForPgTest(stack.db, ownerId, task.id, `T8-${task.id}`);
      }
    }
  }
  assert.fail('the dynamically grown T8 project did not settle within twelve rounds');
}

suite('T8 replays create → auto-dispatch → failed attempt → judgment work → settlement → acceptance',
  { timeout: 240_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    await sql.query('TRUNCATE "user" RESTART IDENTITY CASCADE');

    const db = prismaClientFor(URL!);
    const stack = buildStack(db);
    t.after(async () => {
      await db.$disconnect();
      await sql.end();
    });

    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const seedSessionId = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        email: `t8-${ownerId}@coordinator.invalid`,
        name: 'T8 owner',
        passwordHash: 'x',
      },
    });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: 'T8 disposable runner',
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        lastHeartbeatAt: new Date(),
        maxConcurrent: 16,
        capabilities: [],
        capabilitiesReportedAt: new Date(),
      },
    });
    await db.workspace.create({
      data: {
        id: workspaceId,
        ownerId,
        runnerId,
        name: 'T8 workspace',
        enabled: true,
      },
    });
    await db.session.create({
      data: {
        id: seedSessionId,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
        title: 'T8 project seed',
        prompt: 'Create the project',
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        runSource: SessionRunSource.MANUAL,
      },
    });

    const project = await stack.projects.create(
      ownerId,
      {
        title: 'T8 integrated replay',
        acceptanceCriteriaItems: [
          '失败后的一次性判断会话能创建有 criterionKey 的替代任务',
          '全部项目任务终态后从 main 证据记录一次分支观察',
        ].map((text) => ({
          text,
          verificationMethod: `A person checks: ${text}`,
        })),
      },
      { sessionId: seedSessionId, workspaceId },
    );
    assert.equal(project.coordinatorEnabled, true);
    assert.equal(project.coordinatorWorkspaceId, workspaceId);
    await establishProjectContractForPgTest(db, ownerId, project.id, 'T8 integrated replay');

    // Create the edge before releasing it. The production signoff service owns the instant
    // dependency trigger; the explicit sweep immediately afterwards proves that its backstop is
    // idempotent with the already-committed dispatch receipt.
    const prerequisite = await stack.tasks.create(ownerId, {
      title: 'T8 prerequisite',
      projectId: project.id,
      assigneeId: workspaceId,
      autoRunWhenReady: false,
    });
    const firstAttempt = await stack.tasks.create(ownerId, {
      title: 'T8 work that intentionally fails once',
      projectId: project.id,
      assigneeId: workspaceId,
      autoRunWhenReady: true,
      dependsOnTaskIds: [prerequisite.id],
    });
    await completeHumanTaskForPgTest(db, ownerId, prerequisite.id, 'T8-prerequisite');
    await (stack.tasks as unknown as { reconcileReadyTasks(): Promise<void> })
      .reconcileReadyTasks();

    const firstRun = await db.session.findFirstOrThrow({
      where: { taskId: firstAttempt.id, startsTaskWork: true, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(firstRun.dispatchOrigin, SessionDispatchOrigin.LEGACY_SWEEP);
    assert.equal(firstRun.runSource, SessionRunSource.TASK_LIST_AUTO);

    // Reproduce the runner's claimed turn, then fail it through the production transaction. The
    // post-commit hook must re-read FAILED/FAILED and open a judgment; the spec never calls the
    // producer itself.
    const turnId = randomUUID();
    await db.task.update({
      where: { id: firstAttempt.id },
      data: { status: TaskStatus.IN_PROGRESS },
    });
    await db.session.update({
      where: { id: firstRun.id },
      data: { status: RunStatus.RUNNING, startedAt: new Date() },
    });
    await db.conversationTurn.create({
      data: {
        id: turnId,
        sessionId: firstRun.id,
        seq: 1,
        clientTurnId: `message:${turnId}`,
        kind: 'message',
        content: 'fail once so the coordinator judges the committed attempt',
        status: 'IN_FLIGHT',
      },
    });
    const failed = await stack.runnerApi.turnComplete({ id: runnerId }, firstRun.id, {
      turnId,
      status: SharedRunStatus.FAILED,
      result: 'T8 intentional first-attempt failure',
      numTurns: 1,
    });
    // Historical T8 calls the retired producer explicitly. It is no longer wired to runner
    // lifecycle; N7 production routing is driven only by criterion inputs.
    await stack.attemptEnded.afterCommit(firstRun.id);
    assert.equal(failed.status, RunStatus.FAILED);
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: firstAttempt.id } })).status,
      TaskStatus.FAILED,
    );

    const failedWake = await db.projectCoordinatorWake.findFirstOrThrow({
      where: { projectId: project.id, event: 'ATTEMPT_ENDED_UNSETTLED' },
    });
    assert.equal(failedWake.status, 'SESSION_OPENED');
    assert.ok(failedWake.sessionId);
    const failureJudgment = await db.session.findUniqueOrThrow({
      where: { id: failedWake.sessionId! },
    });
    assert.equal(failureJudgment.dispatchOrigin, SessionDispatchOrigin.PROJECT_COORDINATOR);
    assert.equal(
      await db.projectConvergenceDecision.count({ where: { projectId: project.id } }),
      1,
      'the failed-attempt wake must pass through T4 before opening its judgment',
    );

    // Execute the action the one-shot judgment is authorized to take. T6 requires the stated
    // criterion key, and SU7 records the replacement in the same transaction as the new task.
    const stated: any = await stack.projects.get(ownerId, project.id);
    const replacement = await stack.tasks.create(
      ownerId,
      {
        title: 'T8 judgment replacement',
        description: 'Replacement filed by the failed-attempt judgment.',
        projectId: project.id,
        assigneeId: workspaceId,
        autoRunWhenReady: true,
        dependsOnTaskIds: [prerequisite.id],
        criterionKey: stated.acceptanceCriteriaItems[0].contentHash.slice(0, 32),
        supersedesTaskId: firstAttempt.id,
      },
      { type: CreatorType.AGENT, id: workspaceId },
      failureJudgment.id,
    );
    assert.equal(replacement.creatorSessionId, failureJudgment.id);
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: firstAttempt.id } })).supersededByTaskId,
      replacement.id,
    );
    await db.session.update({
      where: { id: failureJudgment.id },
      data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
    });

    await (stack.tasks as unknown as { reconcileReadyTasks(): Promise<void> })
      .reconcileReadyTasks();
    const replacementRun = await db.session.findFirstOrThrow({
      where: { taskId: replacement.id, startsTaskWork: true, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(replacementRun.dispatchOrigin, SessionDispatchOrigin.LEGACY_SWEEP);

    // Retire the failed attempt, then close replacement and any verification work the acceptance
    // facts dynamically file. The last real TasksService write invokes T7 after commit.
    await stack.tasks.update(ownerId, firstAttempt.id, { status: TaskStatus.CANCELLED } as never);
    await settleEveryProjectTask(stack, ownerId, project.id);
    await stack.settled.afterCommit([project.id]);
    const terminalTasks = await db.task.findMany({
      where: { projectId: project.id },
      select: { id: true, status: true },
    });
    assert.ok(terminalTasks.length >= 3);
    const settledStatuses = new Set<TaskStatus>([TaskStatus.DONE, TaskStatus.CANCELLED]);
    assert.ok(
      terminalTasks.every((task) => settledStatuses.has(task.status)),
      'every task, including dynamically created verification work, must be terminal',
    );

    const settledWake = await db.projectCoordinatorWake.findFirstOrThrow({
      where: { projectId: project.id, event: 'PROJECT_TASKS_SETTLED' },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(settledWake.status, 'SESSION_OPENED');
    assert.ok(settledWake.sessionId);
    assert.notEqual(settledWake.sessionId, failureJudgment.id);
    assert.equal(
      await db.projectConvergenceDecision.count({ where: { projectId: project.id } }),
      2,
      'the settled-task wake must also pass through the same durable T4 brake',
    );

    const merged = await stack.acceptance.recordMergeEvidence(ownerId, project.id, {
      requirementId: 'T8_INTEGRATED_REPLAY',
      targetBranch: 'main',
      contentHash: '8'.repeat(64),
      source: 'T8_PG_SPEC',
      detail: { observation: 'the integrated test represents verified target-branch content' },
    });
    assert.equal(merged.changed, true);
    assert.equal(merged.refGeneration, '1');
    // And that is where the replay ends now. Migration 0229 removed the project acceptance
    // judgment, so the settled-task wake opens a coordinator session and observes the branch, and
    // nothing evaluates the two criteria the project states. They stay stated and unjudged.
    const stillStated = await db.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: project.id },
      orderBy: { ordinal: 'asc' },
    });
    assert.equal(stillStated.length, 2);
    assert.equal(
      (await db.project.findUniqueOrThrow({ where: { id: project.id } })).status,
      ProjectStatus.OPEN,
      'every task settled and the project is still OPEN: nothing concludes a criterion',
    );
  });
