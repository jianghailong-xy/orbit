import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import { Client } from 'pg';

import {
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
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import {
  INTEGRATION_JOB_CLAIM,
  REOPEN_LANDING_HANDLING_REASON,
} from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { openItemOwed } from './project-open-item';
import { ProjectOpenItemService } from './project-open-item.service';
import { readTaskIntegrationViews } from './project-task-integration';

/**
 * The landing generation created by a real DONE after task_reopen is an H1 hand-off, not a fresh
 * blank card. This spec deliberately drives the runner doors and the integration result route, so
 * the five edges below share the transaction boundaries production uses:
 *
 *   conflict -> reopen -> DONE      old card is OPEN/handling the new LAND_TASK
 *   new generation LANDED            old card is HANDLED
 *   new generation conflicts again    old card is RETRIED and a new card is OPEN
 *   active MAIN_SYNC handling         another task is not held by the old card; a new stop is
 *                                      still a blocker
 *   active handling                  no coordinator delivery or clock escalation
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/reopen-landing-handling.pg.spec.ts
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

const CAPABLE = [INTEGRATION_JOB_CLAIM];
type Result = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

const MERGE_CONFLICT: Result = {
  state: 'CONFLICT',
  phase: 'MERGE',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'b'.repeat(40),
  conflicts: ['src/reopened.ts'],
};

const MAIN_SYNC_CONFLICT: Result = {
  state: 'CONFLICT',
  phase: 'MAIN_SYNC',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'b'.repeat(40),
  upstreamSha: 'c'.repeat(40),
  conflicts: ['src/upstream.ts'],
};

const LANDED: Result = {
  state: 'LANDED',
  phase: 'VERIFY',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'b'.repeat(40),
  testedSha: 'd'.repeat(40),
  testedTreeSha: 'e'.repeat(40),
  landedSha: 'd'.repeat(40),
  landedTreeSha: 'e'.repeat(40),
  aheadOfUpstream: 1,
};

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
  openItems: ProjectOpenItemService;
  escalation: ProjectOpenItemEscalationService;
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => async () => [] }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
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
  );
  return {
    db,
    tasks,
    api,
    jobs,
    openItems,
    escalation: new ProjectOpenItemEscalationService(prisma),
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  leaseOwner: string;
}

async function world(stack: Stack, label: string): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@reopen.invalid`, name: label, passwordHash: 'x' },
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
      goal: 'a reopened landing is still somebody\'s work',
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
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId, leaseOwner: `lease-${label}` };
}

async function createTask(stack: Stack, w: World, label: string): Promise<string> {
  const task = await stack.tasks.create(w.ownerId, {
    title: `${label} ${randomUUID().slice(0, 8)}`,
    assigneeId: w.workspaceId,
    projectId: w.projectId,
    acceptanceCommand: 'exit 0',
    acceptanceExpectedExitCode: 0,
  });
  return task.id;
}

/** Complete one task through the runner's acceptance turn. The caller may use it after a reopen. */
async function completeTask(stack: Stack, w: World, taskId: string, label: string): Promise<{ sessionId: string; branch: string }> {
  const title = (await stack.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { title: true } })).title;
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const branch = `orbit/${label}-${randomUUID().slice(0, 6)}`;
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      taskId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title,
      prompt: title,
      provider: 'claude',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      startedAt: new Date(),
      branch,
      isolationStatus: 'worktree',
      baseSha: '9'.repeat(40),
      changedFiles: [{ path: 'src/reopened.ts', additions: 1, deletions: 0 }],
    },
  });
  await stack.db.conversationTurn.create({
    data: {
      id: turnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${turnId}`,
      kind: 'message',
      content: 'execute the repaired work',
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
      payload: { text: 'the repaired work is on the branch' },
    }],
  });
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  const acceptance = await (stack.api as unknown as {
    dequeueTurn: (sessionId: string, runnerId: string, lease: string | null) =>
      Promise<{ turnId: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, w.runnerId, null);
  assert.equal(acceptance?.taskAcceptance, true, 'acceptance was queued for the reopened task');
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId: acceptance!.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  assert.equal(
    (await stack.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } })).status,
    TaskStatus.DONE,
  );
  // Integration conflict happens after the task work session has ended. Keep the fixture's old run
  // out of the execution-claim index before the task_reopen analogue creates the next run.
  await stack.db.session.update({
    where: { id: sessionId },
    data: {
      status: RunStatus.CANCELLED,
      completedAt: new Date(),
      finishedAt: new Date(),
      worktreeBranch: branch,
      worktreeDirty: false,
    },
  });
  return { sessionId, branch };
}

async function reopen(stack: Stack, w: World, taskId: string): Promise<void> {
  const reopened = await stack.tasks.update(w.ownerId, taskId, {
    status: TaskStatus.OPEN,
    supersededByTaskId: null,
    terminalReason: null,
  } as never);
  assert.equal(reopened.status, TaskStatus.OPEN);
}

async function claim(stack: Stack, w: World, kind = 'LAND_TASK'): Promise<IntegrationJobCommand> {
  const jobs = await stack.jobs.dispatch({
    runnerId: w.runnerId,
    leaseOwner: w.leaseOwner,
    draining: false,
    capabilities: CAPABLE,
  });
  assert.equal(jobs.length, 1, `expected one ${kind} job, got ${JSON.stringify(jobs)}`);
  assert.equal(jobs[0]!.kind, kind);
  return jobs[0]!;
}

async function report(stack: Stack, w: World, job: IntegrationJobCommand, result: Result) {
  return stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
}

async function failFirst(
  stack: Stack,
  w: World,
  label: string,
  result: Result = MERGE_CONFLICT,
): Promise<{ taskId: string; firstJobId: string; firstItemId: string }> {
  const taskId = await createTask(stack, w, label);
  await completeTask(stack, w, taskId, `${label}-first`);
  const first = await claim(stack, w);
  assert.equal((await report(stack, w, first, result)).accepted, true);
  const item = await stack.db.projectOpenItem.findFirstOrThrow({
    where: { taskId, kind: { in: ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, state: true },
  });
  assert.equal(item.state, 'OPEN');
  return { taskId, firstJobId: first.jobId, firstItemId: item.id };
}

async function queueReopenedGeneration(stack: Stack, w: World, taskId: string, label: string) {
  await reopen(stack, w, taskId);
  const second = await completeTask(stack, w, taskId, `${label}-second`);
  const job = await stack.db.projectIntegrationJob.findFirstOrThrow({
    where: { taskId, kind: 'LAND_TASK', generation: 2 },
    select: { id: true, generation: true, state: true, sessionId: true },
  });
  assert.equal(job.state, 'QUEUED');
  assert.equal(job.sessionId, second.sessionId);
  return { ...second, jobId: job.id };
}

async function openItem(stack: Stack, id: string) {
  return stack.db.projectOpenItem.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      state: true,
      assignee: true,
      integrationJobId: true,
      handlingJobId: true,
      handlingSessionId: true,
      handlingUserId: true,
      handlingReason: true,
      resolution: true,
      resolvedBy: true,
      resolvedBySessionId: true,
      resolvedByUserId: true,
      resolvedByJobId: true,
      resolutionNote: true,
      supersededByItemId: true,
    },
  });
}

test('reopen -> DONE hands the old integration card to the new generation, then LANDED handles it and active handling is not redelivered or escalated',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'reopen-landed');
      const failed = await failFirst(stack, w, 'reopen-landed');
      const beforeDeliveries = await stack.db.projectOpenItemDelivery.count({ where: { itemId: failed.firstItemId } });
      const reopened = await queueReopenedGeneration(stack, w, failed.taskId, 'reopen-landed');
      let old = await openItem(stack, failed.firstItemId);
      assert.equal(old.state, 'OPEN');
      assert.equal(old.handlingJobId, reopened.jobId);
      assert.equal(old.handlingSessionId, reopened.sessionId);
      assert.equal(old.handlingUserId, null);
      assert.equal(old.handlingReason, REOPEN_LANDING_HANDLING_REASON);

      const owed = await stack.db.$queryRaw<Array<{ owed: boolean }>>(Prisma.sql`
        SELECT ${openItemOwed('item')} AS "owed"
          FROM "project_open_item" item
         WHERE item."id" = ${failed.firstItemId}::uuid`);
      assert.equal(owed[0]?.owed, true, 'H1 remains OPEN and owed until H2/H3');
      const read = await stack.openItems.list(w.ownerId, w.projectId);
      assert.ok(read.withCoordinator.some((row) => row.itemId === failed.firstItemId),
        'the H1 card remains in the owed reader');

      // The queued and running states are both protected from a second turn and from the clock.
      await stack.openItems.deliverForTasks([failed.taskId]);
      await stack.openItems.deliverOwed(w.projectId);
      await stack.db.$executeRaw(Prisma.sql`
        UPDATE "project_open_item" SET "escalate_at" = now() - interval '1 minute'
         WHERE "id" = ${failed.firstItemId}::uuid`);
      assert.deepEqual((await stack.escalation.sweep()).filter((row) => row.itemId === failed.firstItemId), []);
      assert.equal(
        await stack.db.projectOpenItemDelivery.count({ where: { itemId: failed.firstItemId } }),
        beforeDeliveries,
        'a queued H1 item is not delivered again',
      );

      const rerun = await claim(stack, w);
      assert.equal(rerun.jobId, reopened.jobId);
      await stack.openItems.deliverForTasks([failed.taskId]);
      await stack.openItems.deliverOwed(w.projectId);
      assert.deepEqual((await stack.escalation.sweep()).filter((row) => row.itemId === failed.firstItemId), []);
      old = await openItem(stack, failed.firstItemId);
      assert.equal(old.assignee, 'COORDINATOR');
      assert.equal(await stack.db.projectOpenItemDelivery.count({ where: { itemId: failed.firstItemId } }), beforeDeliveries);

      assert.equal((await report(stack, w, rerun, LANDED)).accepted, true);
      old = await openItem(stack, failed.firstItemId);
      assert.equal(old.state, 'RESOLVED');
      assert.equal(old.resolution, 'HANDLED');
      assert.equal(old.resolvedBy, 'COORDINATOR');
      assert.equal(old.resolvedBySessionId, reopened.sessionId);
      assert.equal(old.resolvedByUserId, null);
      assert.equal(old.resolvedByJobId, reopened.jobId);
      assert.equal(old.resolutionNote, REOPEN_LANDING_HANDLING_REASON);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a reopened generation that conflicts again RETRIES the old card and opens a new card',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'reopen-retried');
      const failed = await failFirst(stack, w, 'reopen-retried');
      const reopened = await queueReopenedGeneration(stack, w, failed.taskId, 'reopen-retried');
      const rerun = await claim(stack, w);
      assert.equal(rerun.jobId, reopened.jobId);
      const answer = await report(stack, w, rerun, MERGE_CONFLICT);
      assert.equal(answer.accepted, true);
      const old = await openItem(stack, failed.firstItemId);
      assert.equal(old.state, 'SUPERSEDED');
      assert.equal(old.resolution, 'RETRIED');
      assert.equal(old.resolvedBy, 'COORDINATOR');
      assert.equal(old.resolvedBySessionId, reopened.sessionId);
      assert.equal(old.resolvedByJobId, reopened.jobId);
      assert.equal(old.resolutionNote, REOPEN_LANDING_HANDLING_REASON);
      assert.ok(old.supersededByItemId);
      const fresh = await openItem(stack, old.supersededByItemId!);
      assert.equal(fresh.state, 'OPEN');
      assert.equal(fresh.integrationJobId, reopened.jobId);
      assert.equal(fresh.handlingJobId, null);
      assert.equal(fresh.resolution, null);
      assert.equal(answer.openItemId, fresh.id);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an active hand-off of MAIN_SYNC no longer blocks another task, but a new MAIN_SYNC stop does',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'reopen-main-sync');
      const failed = await failFirst(stack, w, 'reopen-main-sync', MAIN_SYNC_CONFLICT);
      const reopened = await queueReopenedGeneration(stack, w, failed.taskId, 'reopen-main-sync');
      const otherTaskId = await createTask(stack, w, 'reopen-main-sync-other');
      await completeTask(stack, w, otherTaskId, 'reopen-main-sync-other');
      const otherJob = await stack.db.projectIntegrationJob.findFirstOrThrow({
        where: { taskId: otherTaskId, kind: 'LAND_TASK' },
        select: { id: true },
      });
      const prisma = stack.db as unknown as PrismaService;
      let views = await readTaskIntegrationViews(prisma, w.ownerId, w.projectId, [otherTaskId]);
      assert.notEqual(views.get(otherTaskId)?.landTask?.blockingReason?.code, 'WAITING_MAIN_SYNC',
        'the old MAIN_SYNC card is being handled by the reopened generation');

      const repair = await claim(stack, w);
      assert.equal(repair.jobId, reopened.jobId);
      assert.equal((await report(stack, w, repair, MAIN_SYNC_CONFLICT)).accepted, true);
      views = await readTaskIntegrationViews(prisma, w.ownerId, w.projectId, [otherTaskId]);
      assert.equal(views.get(otherTaskId)?.landTask?.blockingReason?.code, 'WAITING_MAIN_SYNC',
        'H3 opens a fresh MAIN_SYNC blocker when the new generation stops again');
      assert.equal(views.get(otherTaskId)?.landTask?.blockingReason?.jobId, repair.jobId);
      assert.notEqual(otherJob.id, repair.jobId);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the PostgreSQL target is explicitly disposable', { skip }, () => {
  assert.doesNotThrow(() => assertCoordinatorPgUrlIsIsolated(URL));
});
