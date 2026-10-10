import assert from 'node:assert/strict';
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

import {
  IntegrationCheckResult,
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  RunEventType,
  RunStatus as SharedRunStatus,
} from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND } from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';
import { doorsForOpenItem } from './open-item-doors';

/**
 * The complete promotion-failure path: a real CHECK_PROMOTION failure opens one item, the
 * coordinator receives the message made from that row, and the named integration_retry door can
 * queue the next check with the candidate's id.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-failure-coordinator-path.pg.spec.ts
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

const CAPABLE = [INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND];

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
  openItems: ProjectOpenItemService;
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const convergence = new CoordinatorConvergenceService(prisma);
  const wake = new CoordinatorWakeService(prisma);
  const judgments = new CoordinatorJudgmentService(prisma, wake, sessions);
  const deliveries = new CoordinatorDeliveryService(prisma, wake, sessions);
  const router = new CompletionInputRouter(
    wake,
    new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, deliveries),
    new CriterionUnlandedProducer(prisma, convergence),
  );
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router, undefined, openItems);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  const push = new Proxy({}, { get: () => async () => undefined }) as never;
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    push,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
    undefined,
    undefined,
    openItems,
    jobs,
    undefined,
    new ProjectPromotionService(prisma),
  );
  return { db, tasks, api, jobs, openItems };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

async function world(stack: Stack, label: string): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@promotion-path.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: CAPABLE,
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
      repoUrl: `https://git.invalid/orbit/${label}.git`,
      workDir: `/srv/${label}`,
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `coordinator: ${label}`,
      prompt: `coordinator: ${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      numTurns: 1,
      startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: `coordinator: ${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: 'a failed promotion must leave a usable door',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId,
    projectId,
    settings: { line: 'PROJECT_BRANCH' },
  }));
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

async function doneCodeTask(stack: Stack, w: World, label: string): Promise<string> {
  const db = stack.db;
  const declared = await stack.tasks.create(w.ownerId, {
    title: `${label} ${randomUUID().slice(0, 8)}`,
    assigneeId: w.workspaceId,
    projectId: w.projectId,
    acceptanceCommand: 'exit 0',
    acceptanceExpectedExitCode: 0,
  });
  const sessionId = randomUUID();
  const turnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      taskId: declared.id,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title: declared.title,
      prompt: declared.title,
      provider: 'claude',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      startedAt: new Date(),
      finishedAt: new Date(Date.now() - 60_000),
      branch: `orbit/${label}-${randomUUID().slice(0, 6)}`,
      isolationStatus: 'worktree',
      baseSha: 'b'.repeat(40),
    },
  });
  await db.conversationTurn.create({
    data: {
      id: turnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${turnId}`,
      kind: 'message',
      content: 'execute the task',
      status: 'IN_FLIGHT',
      deliveredAt: new Date(),
    },
  });
  await stack.api.events({ id: w.runnerId }, sessionId, {
    events: [{
      seq: 1,
      type: RunEventType.ASSISTANT,
      ts: new Date().toISOString(),
      turnId,
      payload: { text: 'the work is on the branch' },
    }],
  });
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  const acceptance = await (stack.api as unknown as {
    dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) =>
      Promise<{ turnId: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, w.runnerId, null);
  assert.equal(acceptance?.taskAcceptance, true);
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId: acceptance!.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  const task = await db.task.findUniqueOrThrow({ where: { id: declared.id }, select: { status: true } });
  assert.equal(task.status, TaskStatus.DONE);
  return declared.id;
}

type Result = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'npm test && go test ./...',
  expectedExitCode: 0,
  exitCode: 0,
  timedOut: false,
  durationMs: 1_200,
  outputTail: 'ok\n',
};

const RED_CHECK: IntegrationCheckResult = {
  ...GREEN_CHECK,
  exitCode: 1,
  outputTail: 'FAIL\n',
};

function landed(): Result {
  return {
    state: 'LANDED',
    phase: 'VERIFY',
    sourceSha: 'd'.repeat(40),
    targetShaBefore: 'c'.repeat(40),
    testedSha: 'd'.repeat(40),
    testedTreeSha: 'e'.repeat(40),
    landedSha: 'd'.repeat(40),
    landedTreeSha: 'e'.repeat(40),
    aheadOfUpstream: 1,
  };
}

async function claim(stack: Stack, w: World, leaseOwner: string): Promise<IntegrationJobCommand> {
  const jobs = await stack.jobs.dispatch({
    runnerId: w.runnerId,
    leaseOwner,
    draining: false,
    capabilities: CAPABLE,
  });
  assert.equal(jobs.length, 1);
  return jobs[0]!;
}

function report(stack: Stack, w: World, job: IntegrationJobCommand, result: Result) {
  return stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
}

async function failedPromotion(stack: Stack, w: World): Promise<{ promotionId: string; itemId: string }> {
  await doneCodeTask(stack, w, 'promotion-door');
  const landing = await claim(stack, w, 'landing');
  assert.equal(landing.kind, 'LAND_TASK');
  assert.equal((await report(stack, w, landing, landed())).accepted, true);
  const check = await claim(stack, w, 'promotion-check');
  assert.equal(check.kind, 'CHECK_PROMOTION');
  const result: Result = {
    state: 'CHECK_FAILED',
    phase: 'CHECK',
    sourceSha: 'd'.repeat(40),
    targetShaBefore: 'f'.repeat(40),
    upstreamSha: 'f'.repeat(40),
    testedSha: '2'.repeat(40),
    testedTreeSha: '3'.repeat(40),
    checks: [RED_CHECK],
  };
  const answer = await report(stack, w, check, result);
  assert.equal(answer.accepted, true);
  const promotion = await stack.db.projectPromotion.findFirstOrThrow({
    where: { projectId: w.projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, state: true },
  });
  assert.equal(promotion.state, 'BLOCKED');
  const item = await stack.db.projectOpenItem.findFirstOrThrow({
    where: { projectId: w.projectId, promotionId: promotion.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return { promotionId: promotion.id, itemId: item.id };
}

async function turnsAbout(db: PrismaClient, sessionId: string, itemId: string): Promise<string[]> {
  const rows = await db.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { startsWith: `open-item:v1:${itemId}:` } },
    orderBy: { seq: 'asc' },
    select: { content: true },
  });
  return rows.map((row) => row.content ?? '');
}

test('a failed promotion gives the coordinator only usable named doors, and integration_retry(promotionId) succeeds',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'promotion-door');
      const failed = await failedPromotion(stack, w);
      const row = await stack.db.projectOpenItem.findUniqueOrThrow({
        where: { id: failed.itemId },
        select: {
          id: true, kind: true, assignee: true, taskId: true, promotionId: true,
          payload: true, state: true,
        },
      });
      assert.equal(row.state, 'OPEN');
      assert.equal(row.assignee, 'COORDINATOR');
      assert.equal(row.taskId, null);
      assert.equal(row.promotionId, failed.promotionId);

      const doors = doorsForOpenItem({
        kind: row.kind,
        assignee: row.assignee,
        taskId: row.taskId,
        promotionId: row.promotionId,
        askable: false,
        payload: row.payload,
      });
      const availableMcps = new Set(doors.flatMap((door) => door.mcp ? [door.mcp] : []));
      const messages = await turnsAbout(stack.db, w.coordinatorSessionId, failed.itemId);
      assert.equal(messages.length, 1, 'the failure was delivered once to the coordinator');
      const message = messages[0]!;
      for (const mcp of ['integration_retry', 'task_create', 'ask_owner', 'open_item_hand_over', 'open_item_resolve']) {
        assert.match(message, new RegExp(`\\b${mcp}\\b`), `${mcp} was not named`);
        assert.ok(availableMcps.has(mcp), `${mcp} is named but not a door for this row`);
      }
      assert.doesNotMatch(message, /promotion_recheck/);
      assert.doesNotMatch(message, /supersedesTaskId/);
      assert.match(message, /promotionId/);
      assert.match(message, /go test.*10-minute/);

      const retried = await stack.openItems.retryPromotionCheck(
        w.ownerId,
        w.projectId,
        failed.promotionId,
        { reason: 'the check runner was transiently unavailable; retrying the candidate' },
        w.coordinatorSessionId,
      );
      assert.equal(retried.promotionId, failed.promotionId);
      assert.equal(retried.generation, 2);
      assert.deepEqual(retried.handlingItemIds, [failed.itemId]);
    } finally {
      await stack.db.$disconnect();
    }
  });
