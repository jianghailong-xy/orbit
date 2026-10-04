import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
import {
  Prisma,
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
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import { INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND } from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * "Chat about this" on an exception item, as `GET /projects/:id/open-items` serves it
 * (`docs/project-integration-line-contract.md` §4.8; `openItemChat`), for both of the item's scopes
 * — a task's landing onto the project branch, and the merge of that branch into main, whose item
 * names no task:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/open-item-chat.pg.spec.ts
 *
 * WHAT THIS PINS
 * --------------
 *  - every row says where its handling stands — with the coordinator, being handled by its rerun,
 *    the owner's, handled, superseded — and names the project's coordinator conversation as where a
 *    message about it goes;
 *  - the chat is offered at every one of those stages but the superseded one, which it refuses with
 *    that reason, and it is refused with a reason of its own where there is no conversation to take
 *    the message or the one there is cannot take it;
 *  - it adds no door: the escalated item's presses, and the candidate's single way in, are what they
 *    were, and the coordinator's rerun and the merge into main are refused exactly as before.
 *
 * WHAT DRIVES EACH CASE. The doors a runner knocks on, through the production wiring
 * `open-item-coordinator-handling.pg.spec.ts` uses: the result route, the heartbeat that hands jobs
 * out, the coordinator's rerun door and the clock that hands an item to the owner. What the runner
 * did in git is the one thing simulated, as the result it posts. Not destructive: every case owns
 * freshly generated ids.
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

const TASK_BRANCH_TIP = 'a'.repeat(40);
const LINE_BEFORE = 'c'.repeat(40);
const LINE_FIRST = 'd'.repeat(40);
const LINE_FIRST_TREE = 'e'.repeat(40);
const MAIN_CHECKED = 'f'.repeat(40);
const CHECK_MERGE = '2'.repeat(40);
const CHECKED_TREE = '3'.repeat(40);

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
  outputTail: '--- FAIL: TestRealClaudeAcceptsASetModel (1.45s)\nFAIL\torbit\t551.473s',
};

const REASON = 'the merge check\'s baseline was repaired; the red was the baseline\'s, not the work\'s';

type Result = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

const RED_LANDING: Result = {
  state: 'CHECK_FAILED',
  phase: 'CHECK',
  sourceSha: TASK_BRANCH_TIP,
  targetShaBefore: LINE_BEFORE,
  testedSha: CHECK_MERGE,
  testedTreeSha: CHECKED_TREE,
  checks: [RED_CHECK],
};

function landed(before: string, sha: string, tree: string): Result {
  return {
    state: 'LANDED',
    phase: 'VERIFY',
    sourceSha: TASK_BRANCH_TIP,
    targetShaBefore: before,
    testedSha: sha,
    testedTreeSha: tree,
    landedSha: sha,
    landedTreeSha: tree,
    aheadOfUpstream: 1,
  };
}

function cleanCheck(source: string): Result {
  return {
    state: 'READY',
    phase: 'CHECK',
    sourceSha: source,
    targetShaBefore: MAIN_CHECKED,
    upstreamSha: MAIN_CHECKED,
    testedSha: CHECK_MERGE,
    testedTreeSha: CHECKED_TREE,
    aheadOfUpstream: 1,
    filesChanged: 3,
    checks: [GREEN_CHECK],
    conflicts: [],
  };
}

function redCheck(source: string): Result {
  return {
    state: 'CHECK_FAILED',
    phase: 'CHECK',
    sourceSha: source,
    targetShaBefore: MAIN_CHECKED,
    upstreamSha: MAIN_CHECKED,
    testedSha: CHECK_MERGE,
    testedTreeSha: CHECKED_TREE,
    checks: [RED_CHECK],
  };
}

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
  promotions: ProjectPromotionService;
  openItems: ProjectOpenItemService;
  escalation: ProjectOpenItemEscalationService;
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const convergence = new CoordinatorConvergenceService(prisma);
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      convergence,
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new CriterionUnlandedProducer(prisma, convergence),
  );
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router, undefined, openItems);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  const promotions = new ProjectPromotionService(prisma);
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
    promotions,
  );
  return {
    db, tasks, api, jobs, promotions, openItems,
    escalation: new ProjectOpenItemEscalationService(prisma),
  };
}

interface World {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

/** One Automatic project integrating on a branch of its own, its coordinator between turns. */
async function world(stack: Stack, label: string): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@chat.invalid`, name: label, passwordHash: 'x' },
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
      goal: 'every exception card has a conversation to take it to',
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
  return { label, ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

/** A code task settled DONE by its own acceptance command, through the runner's doors — which
 *  queues its landing (§2.3 J-T1a). */
async function doneCodeTask(stack: Stack, w: World, label: string): Promise<{ taskId: string; sessionId: string }> {
  const db = stack.db;
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const declared = await stack.tasks.create(w.ownerId, {
    title,
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
      title,
      prompt: title,
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
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, { turnId, status: SharedRunStatus.SUCCEEDED });
  const acceptance = await (stack.api as unknown as {
    dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) =>
      Promise<{ turnId: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, w.runnerId, null);
  assert.equal(acceptance?.taskAcceptance, true, 'the acceptance command was queued for the task');
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId: acceptance!.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  const task = await db.task.findUniqueOrThrow({ where: { id: declared.id }, select: { status: true } });
  assert.equal(task.status, TaskStatus.DONE, 'the acceptance command agreed');
  return { taskId: declared.id, sessionId };
}

async function onlyClaim(stack: Stack, w: World, kind: string): Promise<IntegrationJobCommand> {
  const claimed = await stack.jobs.dispatch({
    runnerId: w.runnerId,
    leaseOwner: `lease-${w.label}`,
    draining: false,
    capabilities: CAPABLE,
  });
  assert.equal(claimed.length, 1, `expected one ${kind} to be handed out`);
  assert.equal(claimed[0]!.kind, kind);
  return claimed[0]!;
}

function report(stack: Stack, w: World, job: IntegrationJobCommand, result: Result) {
  return stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
}

function itemsWhere(db: PrismaClient, where: { taskId?: string; promotionId?: string }) {
  return db.projectOpenItem.findMany({
    where: { ...where, kind: { in: ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, state: true, assignee: true, taskId: true, promotionId: true },
  });
}

/** A DONE task whose first landing came back red: the task-scoped item, with the coordinator. */
async function failedLanding(stack: Stack, w: World, label: string) {
  const task = await doneCodeTask(stack, w, label);
  const landing = await onlyClaim(stack, w, 'LAND_TASK');
  assert.equal((await report(stack, w, landing, RED_LANDING)).accepted, true);
  const [item] = await itemsWhere(stack.db, { taskId: task.taskId });
  assert.ok(item, 'the red landing opened an item');
  return { ...task, itemId: item.id };
}

/** A candidate for main blocked by its MERGE_CHECK — the promotion-scoped item, which names the
 *  candidate and no task. */
async function blockedCandidate(stack: Stack, w: World) {
  await doneCodeTask(stack, w, `${w.label}-first`);
  const landing = await onlyClaim(stack, w, 'LAND_TASK');
  assert.equal((await report(stack, w, landing, landed(LINE_BEFORE, LINE_FIRST, LINE_FIRST_TREE))).accepted, true);
  const check = await onlyClaim(stack, w, 'CHECK_PROMOTION');
  assert.equal((await report(stack, w, check, redCheck(LINE_FIRST))).accepted, true);
  const promotion = await stack.db.projectPromotion.findFirstOrThrow({
    where: { projectId: w.projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, state: true },
  });
  assert.equal(promotion.state, 'BLOCKED', 'a red MERGE_CHECK blocks the candidate');
  const [item] = await itemsWhere(stack.db, { promotionId: promotion.id });
  assert.ok(item, 'the red check opened an item');
  assert.equal(item.taskId, null, 'about the candidate, and about no task');
  return { promotionId: promotion.id, itemId: item.id };
}

/** The one clock (§4.6), made due for this item and run: it becomes the owner's. */
async function escalate(stack: Stack, itemId: string): Promise<void> {
  await stack.db.$executeRaw(
    Prisma.sql`UPDATE "project_open_item" SET "escalate_at" = now() - interval '1 minute'
                WHERE "id" = ${itemId}::uuid`,
  );
  const swept = await stack.escalation.sweep();
  assert.ok(swept.some((row) => row.itemId === itemId), 'the clock handed the item to the owner');
}

async function denied(run: () => Promise<unknown>): Promise<{ status: number; code?: string }> {
  const thrown = await run().then(() => null, (error: unknown) => error);
  assert.ok(thrown instanceof HttpException, `the door answered instead of refusing: ${JSON.stringify(thrown)}`);
  const body = thrown.getResponse();
  const shaped = typeof body === 'string' ? {} : (body as { code?: string });
  return { status: thrown.getStatus(), code: shaped.code };
}

/** One row of the read, wherever it is: owed to somebody, or settled. */
async function rowOf(stack: Stack, w: World, itemId: string) {
  const read = await stack.openItems.list(w.ownerId, w.projectId);
  const groups = { needsYou: read.needsYou, withCoordinator: read.withCoordinator, settled: read.settled };
  for (const [group, rows] of Object.entries(groups)) {
    const row = rows.find((candidate) => candidate.itemId === itemId);
    if (row) return { group, row };
  }
  assert.fail(`item ${itemId} is in no group of the read`);
}

// ── a task's landing ──────────────────────────────────────────────────────────────────────────

test('task-scoped: with the coordinator, being handled, superseded, then the owner\'s — the chat goes to the coordinator conversation at every stage but the superseded one, and adds no door',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'chat-task');
      const red = await failedLanding(stack, w, 'chat-task');

      let read = await rowOf(stack, w, red.itemId);
      assert.equal(read.group, 'withCoordinator');
      assert.equal(read.row.taskId, red.taskId, 'about the task');
      assert.equal(read.row.promotionId, null);
      assert.deepEqual(read.row.chat, {
        sessionId: w.coordinatorSessionId,
        stage: 'WITH_COORDINATOR',
        refusal: null,
      });
      assert.deepEqual(read.row.actions, ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
        'the coordinator\'s doors are what they were');

      // H1: the coordinator's rerun is in flight — the item is being handled, and still chattable.
      await stack.openItems.retryIntegration(w.ownerId, w.projectId, red.taskId, { reason: REASON },
        w.coordinatorSessionId);
      read = await rowOf(stack, w, red.itemId);
      assert.deepEqual(read.row.chat, {
        sessionId: w.coordinatorSessionId,
        stage: 'HANDLING',
        refusal: null,
      });

      // H3: the rerun fails again — the old card is superseded, and a chat about it is refused in
      // favour of the item that took its place.
      const rerun = await onlyClaim(stack, w, 'LAND_TASK');
      const answer = await report(stack, w, rerun, RED_LANDING);
      const second = answer.openItemId!;
      assert.ok(second && second !== red.itemId, 'the second failure opened its own item');
      read = await rowOf(stack, w, red.itemId);
      assert.equal(read.group, 'settled');
      assert.equal(read.row.outcome?.supersededByItemId, second);
      assert.deepEqual(read.row.chat, {
        sessionId: w.coordinatorSessionId,
        stage: 'SUPERSEDED',
        refusal: 'SUPERSEDED',
      });
      read = await rowOf(stack, w, second);
      assert.deepEqual(read.row.chat, {
        sessionId: w.coordinatorSessionId,
        stage: 'WITH_COORDINATOR',
        refusal: null,
      });

      // §4.6: the clock hands the new failure to the owner — still a conversation to have, with the
      // owner's own presses exactly what they were, and the coordinator's rerun still refused.
      await escalate(stack, second);
      read = await rowOf(stack, w, second);
      assert.equal(read.group, 'needsYou');
      assert.deepEqual(read.row.chat, {
        sessionId: w.coordinatorSessionId,
        stage: 'WITH_OWNER',
        refusal: null,
      });
      assert.deepEqual(read.row.actions, ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'CANCEL_TASK'],
        'the owner\'s doors are what they were: the chat is not one of them');
      const rerunAgain = await denied(() => stack.openItems.retryIntegration(w.ownerId, w.projectId,
        red.taskId, { reason: REASON }, w.coordinatorSessionId));
      assert.equal(rerunAgain.status, 409);
      assert.equal(rerunAgain.code, 'INTEGRATION_RETRY_OWNER_ITEM', 'the owner\'s item is not the coordinator\'s to rerun');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── a merge of the project branch into main: the item that names no task ──────────────────────

test('promotion-scoped: the blocked merge\'s item — with the coordinator, being handled, handled — carries the chat at each stage',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'chat-promo');
      const blocked = await blockedCandidate(stack, w);

      let read = await rowOf(stack, w, blocked.itemId);
      assert.equal(read.group, 'withCoordinator');
      assert.equal(read.row.promotionId, blocked.promotionId, 'about the candidate');
      assert.equal(read.row.taskId, null, 'and about no task');
      assert.deepEqual(read.row.chat, {
        sessionId: w.coordinatorSessionId,
        stage: 'WITH_COORDINATOR',
        refusal: null,
      });
      assert.deepEqual(read.row.actions, ['REVIEW'], 'the merge card is still the one way in');

      await stack.openItems.retryPromotionCheck(w.ownerId, w.projectId, blocked.promotionId,
        { reason: REASON }, w.coordinatorSessionId);
      read = await rowOf(stack, w, blocked.itemId);
      assert.deepEqual(read.row.chat, {
        sessionId: w.coordinatorSessionId,
        stage: 'HANDLING',
        refusal: null,
      });

      // H2: the re-check passes — handled, and a chat about how is still one to have.
      const recheck = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      assert.equal((await report(stack, w, recheck, cleanCheck(LINE_FIRST))).accepted, true);
      read = await rowOf(stack, w, blocked.itemId);
      assert.equal(read.group, 'settled');
      assert.equal(read.row.outcome?.resolution, 'HANDLED');
      assert.deepEqual(read.row.chat, {
        sessionId: w.coordinatorSessionId,
        stage: 'HANDLED',
        refusal: null,
      });
    } finally {
      await stack.db.$disconnect();
    }
  });

test('promotion-scoped, escalated ("It is yours"): the chat is open to the owner, and the merge into main and the coordinator\'s re-check stay refused exactly as before',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'chat-promo-owner');
      const blocked = await blockedCandidate(stack, w);
      await escalate(stack, blocked.itemId);

      const read = await rowOf(stack, w, blocked.itemId);
      assert.equal(read.group, 'needsYou');
      assert.equal(read.row.assignee, 'OWNER');
      assert.deepEqual(read.row.chat, {
        sessionId: w.coordinatorSessionId,
        stage: 'WITH_OWNER',
        refusal: null,
      });
      assert.deepEqual(read.row.actions, ['REVIEW'], 'no new door beside the merge card');

      // The owner-only edges, unmoved by a chat being on offer.
      const recheck = await denied(() => stack.openItems.retryPromotionCheck(w.ownerId, w.projectId,
        blocked.promotionId, { reason: REASON }, w.coordinatorSessionId));
      assert.equal(recheck.code, 'INTEGRATION_RETRY_OWNER_ITEM');
      const bySession = await denied(() => stack.promotions.confirm(
        { userId: w.ownerId, actingSessionId: w.coordinatorSessionId }, w.projectId, blocked.promotionId, LINE_FIRST));
      assert.equal(bySession.status, 403);
      assert.equal(bySession.code, 'PROMOTION_OWNER_ONLY', 'merging into main is the owner\'s press');
      const blockedMerge = await denied(() => stack.promotions.confirm(
        { userId: w.ownerId }, w.projectId, blocked.promotionId, LINE_FIRST));
      assert.equal(blockedMerge.status, 409);
      assert.equal(blockedMerge.code, 'PROMOTION_NOT_READY', 'and a blocked candidate is not one it can make');
      assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: blocked.promotionId }, select: { state: true },
      })).state, 'BLOCKED', 'nothing moved');
      assert.equal(await stack.db.projectIntegrationJob.count({
        where: { promotionId: blocked.promotionId, kind: { in: ['CHECK_PROMOTION', 'LAND_PROMOTION'] } },
      }), 1, 'no check or landing was queued beside the one that failed');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── where the message cannot go ──────────────────────────────────────────────────────────────

test('refused with its reason where there is no conversation to take the message — and a conversation that ended but can be resumed is still one its owner may write to',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'chat-nowhere');
      const red = await failedLanding(stack, w, 'chat-nowhere');

      // Ended, and resumable: the platform will not hand it a turn, a person may.
      await stack.db.session.update({
        where: { id: w.coordinatorSessionId },
        data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
      });
      await stack.db.runner.update({ where: { id: w.runnerId }, data: { lastHeartbeatAt: new Date() } });
      let read = await rowOf(stack, w, red.itemId);
      assert.deepEqual(read.row.chat, {
        sessionId: w.coordinatorSessionId,
        stage: 'WITH_COORDINATOR',
        refusal: null,
      });

      // In Trash: there is a conversation, and it cannot take a message.
      await stack.db.session.update({ where: { id: w.coordinatorSessionId }, data: { deletedAt: new Date() } });
      read = await rowOf(stack, w, red.itemId);
      assert.deepEqual(read.row.chat, {
        sessionId: w.coordinatorSessionId,
        stage: 'WITH_COORDINATOR',
        refusal: 'COORDINATOR_UNAVAILABLE',
      });

      // No conversation bound at all.
      await stack.db.project.update({ where: { id: w.projectId }, data: { coordinatorSessionId: null } });
      read = await rowOf(stack, w, red.itemId);
      assert.deepEqual(read.row.chat, {
        sessionId: null,
        stage: 'WITH_COORDINATOR',
        refusal: 'NO_COORDINATOR',
      });
      assert.deepEqual(read.row.actions, ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
        'refusing the chat takes no door away either');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the open-item-chat PostgreSQL target is explicitly disposable', { skip }, () => {
  assert.doesNotThrow(() => assertCoordinatorPgUrlIsIsolated(URL));
});
