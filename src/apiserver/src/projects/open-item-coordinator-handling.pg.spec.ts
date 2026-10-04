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
  uuidToBase62,
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
 * An exception item through its coordinator's handling (`docs/project-integration-line-contract.md`
 * §4.7 H1–H5), for both of the item's scopes: a task's landing onto the project branch, and the
 * merge of the project branch into main — the item that names NO task, which until this had no door
 * the coordinator could answer it through and sat, escalated, in front of the owner.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/open-item-coordinator-handling.pg.spec.ts
 *
 * THE LIFECYCLE THIS PINS
 * -----------------------
 *  H1  the coordinator's rerun (`integration_retry`, with a taskId or a promotionId) leaves its items
 *      OPEN and being handled — never HANDLED while the job it queued is QUEUED or RUNNING;
 *  H2  the rerun landing (a task's) or passing its check (a candidate's) marks them RESOLVED /
 *      HANDLED with resolvedBy=COORDINATOR, the coordinator session, its reason and the job — beside
 *      the task or the candidate the item was always about;
 *  H3  the rerun failing again marks them SUPERSEDED / RETRIED, pointing at the new item the failure
 *      opened, which is open in front of somebody — no real failure is closed quietly;
 *  H4  an item the clock hands to the owner while its rerun runs is the owner's: never marked handled
 *      in the coordinator's name, and the failure it repeats stays the owner's too;
 *  H5  the read model says all of it — `handling` while it runs, `settled` with each `outcome` after.
 * And the owner-only edges around it: an escalated item refuses the coordinator's rerun and close, a
 * project that is not Automatic keeps its failures the owner's until the owner hands one back, and the
 * merge into main stays the owner's card or the Automatic setting's own rule — this door never
 * confirms one.
 *
 * WHAT DRIVES EACH CASE. The doors a runner knocks on, through the production wiring of
 * `promotion-items-moved-on.pg.spec.ts`: the result route, the heartbeat that hands jobs out, the
 * coordinator's rerun door and the owner's doors. What the runner did in git is the one thing
 * simulated, as the result it posts. Not destructive: every case owns freshly generated ids.
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

/** A runner of this build: it claims integration jobs, and lands an automatic merge only onto the
 *  checked tip. */
const CAPABLE = [INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND];

const TASK_BRANCH_TIP = 'a'.repeat(40);
const LINE_BEFORE = 'c'.repeat(40);
const LINE_FIRST = 'd'.repeat(40);
const LINE_FIRST_TREE = 'e'.repeat(40);
const MAIN_CHECKED = 'f'.repeat(40);
const CHECK_MERGE = '2'.repeat(40);
const CHECKED_TREE = '3'.repeat(40);
const MERGE_COMMIT = '4'.repeat(40);

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

const REASON = 'the merge check\'s runner-go baseline was repaired; the red was the baseline\'s, not the work\'s';

type Result = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

/** A task's landing whose combined-tree check came back red. */
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

/** A promotion check that found `source` merging cleanly onto main, every check green. */
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

/** A promotion check whose MERGE_CHECK came back red on the combined tree. */
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

/** One project integrating on a branch of its own, its coordinator between turns, Automatic as given. */
async function world(stack: Stack, label: string, automatic = true): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@handling.invalid`, name: label, passwordHash: 'x' },
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
      goal: 'every failure in front of somebody until something real answers it',
      coordinatorEnabled: automatic,
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
 *  queues its landing (§2.3 J-T1a). Returns the task and the session that did its work. */
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
      // The work stopped moving a minute ago (§2.6 J-T1a), so every claim below is after it.
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

/** The one job a heartbeat hands out, which has to be of the kind named. */
async function onlyClaim(stack: Stack, w: World, kind: string): Promise<IntegrationJobCommand> {
  const claimed = await stack.jobs.dispatch({
    runnerId: w.runnerId,
    leaseOwner: `lease-${w.label}`,
    draining: false,
    capabilities: CAPABLE,
  });
  assert.equal(claimed.length, 1, `expected one ${kind} to be handed out — ${await jobsOf(stack.db, w.projectId)}`);
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

/** A DONE task whose first landing came back red: the task landing card, with the coordinator. */
async function failedLanding(stack: Stack, w: World, label: string) {
  const task = await doneCodeTask(stack, w, label);
  const landing = await onlyClaim(stack, w, 'LAND_TASK');
  const answer = await report(stack, w, landing, RED_LANDING);
  assert.equal(answer.accepted, true);
  const [item] = await itemsWhere(stack.db, { taskId: task.taskId });
  assert.ok(item, 'the red landing opened an item');
  return { ...task, firstJobId: landing.jobId, itemId: item.id };
}

/**
 * A candidate for main blocked by its MERGE_CHECK: one task landed on the project branch, the
 * candidate its landing made (M-F1), and that candidate's check red (M-T3) — the item it opens names
 * the candidate and no task.
 */
async function blockedCandidate(stack: Stack, w: World) {
  const task = await doneCodeTask(stack, w, `${w.label}-first`);
  const landing = await onlyClaim(stack, w, 'LAND_TASK');
  assert.equal((await report(stack, w, landing, landed(LINE_BEFORE, LINE_FIRST, LINE_FIRST_TREE))).accepted, true);
  const check = await onlyClaim(stack, w, 'CHECK_PROMOTION');
  const failed = await report(stack, w, check, redCheck(LINE_FIRST));
  assert.equal(failed.accepted, true);
  const promotion = await stack.db.projectPromotion.findFirstOrThrow({
    where: { projectId: w.projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, state: true },
  });
  assert.equal(promotion.state, 'BLOCKED', 'a red MERGE_CHECK blocks the candidate');
  const items = await itemsWhere(stack.db, { promotionId: promotion.id });
  assert.equal(items.length, 1, `the red check opened one item — ${JSON.stringify(items)}`);
  assert.equal(items[0]!.taskId, null, 'about the candidate, and about no task');
  assert.equal(failed.openItemId, items[0]!.id);
  return { taskId: task.taskId, promotionId: promotion.id, checkJobId: check.jobId, itemId: items[0]!.id };
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────

const ITEM_FIELDS = {
  id: true, kind: true, state: true, assignee: true, assigneeReason: true, taskId: true,
  promotionId: true, integrationJobId: true, waitingSince: true, escalatedAt: true, payload: true,
  handlingJobId: true, handlingSessionId: true, handlingReason: true, handlingStartedAt: true,
  resolution: true, resolvedAt: true, resolvedBy: true, resolvedByUserId: true, resolvedBySessionId: true,
  resolvedByJobId: true, resolutionNote: true, supersededByItemId: true, createdAt: true,
} as const;

function itemsWhere(db: PrismaClient, where: { taskId?: string; promotionId?: string; projectId?: string }) {
  return db.projectOpenItem.findMany({
    where: { ...where, kind: { in: ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: ITEM_FIELDS,
  });
}

function item(db: PrismaClient, id: string) {
  return db.projectOpenItem.findUniqueOrThrow({ where: { id }, select: ITEM_FIELDS });
}

async function jobsOf(db: PrismaClient, projectId: string): Promise<string> {
  const rows = await db.projectIntegrationJob.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { kind: true, generation: true, state: true },
  });
  return `jobs: ${JSON.stringify(rows)}`;
}

/** "Open, and nobody has ended it": what an item in flight, unhandled or escalated must still be. */
function assertStillOpen(row: Awaited<ReturnType<typeof item>>, what: string): void {
  assert.equal(row.state, 'OPEN', `${what}: still open — ${JSON.stringify(row)}`);
  assert.equal(row.resolution, null, `${what}: no resolution, HANDLED least of all`);
  assert.equal(row.resolvedBy, null, `${what}: nobody is recorded as having ended it`);
  assert.equal(row.resolvedAt, null);
}

/** The coordinator's door, as the runner route calls it: the acting session is the header's. */
function retryTask(stack: Stack, w: World, taskId: string, reason = REASON, sessionId = w.coordinatorSessionId) {
  return stack.openItems.retryIntegration(w.ownerId, w.projectId, taskId, { reason }, sessionId);
}

function retryCandidate(stack: Stack, w: World, promotionId: string, reason = REASON, sessionId = w.coordinatorSessionId) {
  return stack.openItems.retryPromotionCheck(w.ownerId, w.projectId, promotionId, { reason }, sessionId);
}

async function denied(run: () => Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
  const thrown = await run().then(() => null, (error: unknown) => error);
  assert.ok(thrown instanceof HttpException, `the door answered instead of refusing: ${JSON.stringify(thrown)}`);
  const body = thrown.getResponse();
  const shaped = typeof body === 'string' ? { message: body } : (body as { code?: string; message?: string });
  return { status: thrown.getStatus(), code: shaped.code, message: shaped.message ?? '' };
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

/** The coordinator's own turns about an item, newest last. */
async function toldAbout(db: PrismaClient, sessionId: string, itemId: string): Promise<string[]> {
  const turns = await db.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { startsWith: `open-item:v1:${itemId}:` } },
    orderBy: { seq: 'asc' },
    select: { content: true },
  });
  return turns.map((turn) => turn.content ?? '');
}

// ── a task's landing ──────────────────────────────────────────────────────────────────────────

test('task landing, rerun lands: handling while it is queued and running, then HANDLED with the coordinator, its session, its reason, the job and the task',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'land-handled');
      const red = await failedLanding(stack, w, 'land-handled');
      // A second task's landing fails beside it and is never touched: an unhandled item stays open.
      const other = await failedLanding(stack, w, 'land-handled-other');

      let read = await stack.openItems.list(w.ownerId, w.projectId);
      assert.equal(read.withCoordinator.find((row) => row.itemId === red.itemId)?.handling, null,
        'nothing is handling it before the coordinator asks');
      assert.deepEqual(read.settled, []);

      const retried = await retryTask(stack, w, red.taskId);
      assert.deepEqual(retried.handlingItemIds, [red.itemId]);
      assert.equal(retried.generation, 2);

      // H1 — queued: open, handled by that job, and not HANDLED.
      let row = await item(stack.db, red.itemId);
      assertStillOpen(row, 'the item, with its rerun queued');
      assert.equal(row.handlingJobId, retried.jobId);
      assert.equal(row.handlingSessionId, w.coordinatorSessionId);
      assert.equal(row.handlingReason, REASON);
      assert.ok(row.handlingStartedAt);
      read = await stack.openItems.list(w.ownerId, w.projectId);
      const queued = read.withCoordinator.find((r) => r.itemId === red.itemId);
      assert.deepEqual(
        queued?.handling && { ...queued.handling, startedAt: undefined },
        { sessionId: w.coordinatorSessionId, userId: null, reason: REASON, startedAt: undefined, jobId: retried.jobId,
          jobKind: 'LAND_TASK', generation: 2, state: 'QUEUED' },
        'the read says it is being handled, by which job, and that the job is queued',
      );
      assert.equal(queued?.outcome, null);

      // H1 — running: still open, still not HANDLED.
      const rerun = await onlyClaim(stack, w, 'LAND_TASK');
      assert.equal(rerun.jobId, retried.jobId);
      read = await stack.openItems.list(w.ownerId, w.projectId);
      assert.equal(read.withCoordinator.find((r) => r.itemId === red.itemId)?.handling?.state, 'RUNNING');
      assertStillOpen(await item(stack.db, red.itemId), 'the item, with its rerun running');

      // H2 — the rerun lands.
      const answer = await report(stack, w, rerun, landed(LINE_BEFORE, LINE_FIRST, LINE_FIRST_TREE));
      assert.equal(answer.accepted, true);
      row = await item(stack.db, red.itemId);
      assert.equal(row.state, 'RESOLVED');
      assert.equal(row.resolution, 'HANDLED');
      assert.equal(row.resolvedBy, 'COORDINATOR');
      assert.equal(row.resolvedByUserId, null, 'no person is named for what the coordinator did');
      assert.equal(row.resolvedBySessionId, w.coordinatorSessionId);
      assert.equal(row.resolutionNote, REASON);
      assert.equal(row.resolvedByJobId, retried.jobId, 'the job that answered it');
      assert.equal(row.taskId, red.taskId, 'and the task it was about');
      assert.equal(row.integrationJobId, red.firstJobId, 'beside the generation that failed');
      assert.equal(row.supersededByItemId, null);
      // The landing is a fact with its own receipt — written by the line, not by anybody's say-so.
      const receipts = await stack.db.sessionMergeReceipt.findMany({
        where: { taskId: red.taskId },
        select: { result: true },
      });
      assert.deepEqual(receipts, [{ result: 'MERGED' }]);

      // The untouched item stays exactly as it was.
      assertStillOpen(await item(stack.db, other.itemId), 'the other task\'s item, which nobody handled');
      assert.equal((await item(stack.db, other.itemId)).handlingJobId, null);

      // H5 — the read: gone from the coordinator's group, in `settled` with its outcome.
      read = await stack.openItems.list(w.ownerId, w.projectId);
      assert.deepEqual(read.withCoordinator.map((r) => r.itemId), [other.itemId]);
      const settled = read.settled.find((r) => r.itemId === red.itemId);
      assert.ok(settled, 'the handled item is in the settled read');
      assert.deepEqual({ ...settled.outcome!, resolvedAt: undefined }, {
        state: 'RESOLVED',
        resolution: 'HANDLED',
        resolvedBy: 'COORDINATOR',
        resolvedByUserId: null,
        resolvedBySessionId: w.coordinatorSessionId,
        resolvedAt: undefined,
        note: REASON,
        jobId: retried.jobId,
        supersededByItemId: null,
      });
      assert.equal(settled.taskId, red.taskId);
      assert.deepEqual(settled.actions, [], 'nothing to press on a closed item');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('task landing, rerun fails again: the item ends SUPERSEDED / RETRIED pointing at the new failure, which is open in front of the coordinator',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'land-retried');
      const red = await failedLanding(stack, w, 'land-retried');
      const retried = await retryTask(stack, w, red.taskId);
      const rerun = await onlyClaim(stack, w, 'LAND_TASK');
      const answer = await report(stack, w, rerun, RED_LANDING);
      assert.equal(answer.accepted, true);

      const [first, second] = await itemsWhere(stack.db, { taskId: red.taskId });
      assert.equal(first?.id, red.itemId);
      assert.ok(second, 'the second failure opened its own item');
      assert.equal(answer.openItemId, second.id);
      // H3 — the old card: a traceable end, never just closed.
      assert.equal(first!.state, 'SUPERSEDED');
      assert.equal(first!.resolution, 'RETRIED');
      assert.equal(first!.resolvedBy, 'COORDINATOR');
      assert.equal(first!.resolvedBySessionId, w.coordinatorSessionId);
      assert.equal(first!.resolutionNote, REASON);
      assert.equal(first!.resolvedByJobId, retried.jobId);
      assert.equal(first!.supersededByItemId, second.id);
      // …and the new failure, in front of the coordinator, saying what was rerun and why.
      assertStillOpen(await item(stack.db, second.id), 'the new failure');
      assert.equal(second.assignee, 'COORDINATOR');
      assert.equal(second.assigneeReason, 'DEFAULT');
      assert.equal(second.integrationJobId, retried.jobId);
      assert.equal(second.handlingJobId, null, 'nobody is handling the new failure yet');
      const payload = second.payload as { generation?: number; retry?: { retryOfJobId?: string; reason?: string } };
      assert.equal(payload.generation, 2);
      assert.equal(payload.retry?.retryOfJobId, red.firstJobId);
      assert.equal(payload.retry?.reason, REASON);
      const told = await toldAbout(stack.db, w.coordinatorSessionId, second.id);
      assert.equal(told.length, 1, 'the coordinator is told about the new failure');
      assert.match(told[0]!, /这是这项任务的第 2 代落地，由协调会话要求重跑/);

      const read = await stack.openItems.list(w.ownerId, w.projectId);
      assert.deepEqual(read.withCoordinator.map((r) => r.itemId), [second.id]);
      assert.equal(read.settled.find((r) => r.itemId === red.itemId)?.outcome?.supersededByItemId, second.id);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── a merge of the project branch into main: the item that names no task ──────────────────────

test('merge into main, re-check passes: the candidate is checked again, the item HANDLED with the candidate and the job, and Automatic merges as it would have',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'promo-handled');
      const blocked = await blockedCandidate(stack, w);
      const retried = await retryCandidate(stack, w, blocked.promotionId);
      assert.equal(retried.promotionId, blocked.promotionId);
      assert.equal(retried.generation, 2);
      assert.equal(retried.retryOfJobId, blocked.checkJobId);
      assert.equal(retried.failureClass, 'CHECK_FAILED');
      assert.deepEqual(retried.handlingItemIds, [blocked.itemId]);

      // The candidate is checking again, under a job that says what it reruns, why and who asked.
      const candidate = await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: blocked.promotionId },
        select: { state: true, checkJobId: true, decidedAt: true },
      });
      assert.deepEqual(candidate, { state: 'CHECKING', checkJobId: retried.jobId, decidedAt: null });
      const job = await stack.db.projectIntegrationJob.findUniqueOrThrow({
        where: { id: retried.jobId },
        select: {
          kind: true, generation: true, state: true, taskId: true, promotionId: true, retryOfJobId: true,
          retryFailureClass: true, retryReason: true, retryRequestedBySessionId: true,
        },
      });
      assert.deepEqual(job, {
        kind: 'CHECK_PROMOTION', generation: 2, state: 'QUEUED', taskId: null, promotionId: blocked.promotionId,
        retryOfJobId: blocked.checkJobId, retryFailureClass: 'CHECK_FAILED', retryReason: REASON,
        retryRequestedBySessionId: w.coordinatorSessionId,
      });

      // H1 — queued, then running: open and handled, never HANDLED.
      const queued = await item(stack.db, blocked.itemId);
      assertStillOpen(queued, 'the candidate\'s item, with its check queued again');
      assert.equal(queued.handlingJobId, retried.jobId);
      let read = await stack.openItems.list(w.ownerId, w.projectId);
      const handling = read.withCoordinator.find((r) => r.itemId === blocked.itemId)?.handling;
      assert.equal(handling?.jobKind, 'CHECK_PROMOTION');
      assert.equal(handling?.state, 'QUEUED');
      const recheck = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      assert.equal(recheck.jobId, retried.jobId);
      assertStillOpen(await item(stack.db, blocked.itemId), 'the candidate\'s item, with its check running');

      // H2 — the check passes.
      const checked = await report(stack, w, recheck, cleanCheck(LINE_FIRST));
      assert.equal(checked.accepted, true);
      const row = await item(stack.db, blocked.itemId);
      assert.equal(row.state, 'RESOLVED');
      assert.equal(row.resolution, 'HANDLED');
      assert.equal(row.resolvedBy, 'COORDINATOR');
      assert.equal(row.resolvedBySessionId, w.coordinatorSessionId);
      assert.equal(row.resolutionNote, REASON);
      assert.equal(row.resolvedByJobId, retried.jobId);
      assert.equal(row.promotionId, blocked.promotionId, 'the audit names the candidate…');
      assert.equal(row.taskId, null, '…and no task, because there is none');
      assert.equal(row.integrationJobId, blocked.checkJobId, 'beside the check that failed');

      // The merge is the Automatic setting's own rule over a clean check (M-T11) — the handled item no
      // longer counted against it — and no owner card is opened.
      assert.equal(checked.openItemId, null);
      const confirmed = await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: blocked.promotionId },
        select: { state: true, confirmedAutomatically: true, confirmedByUserId: true },
      });
      assert.deepEqual(confirmed, { state: 'CONFIRMED', confirmedAutomatically: true, confirmedByUserId: null });
      const land = await onlyClaim(stack, w, 'LAND_PROMOTION');
      const merged = await report(stack, w, land, {
        state: 'LANDED',
        phase: 'VERIFY',
        sourceSha: LINE_FIRST,
        targetShaBefore: MAIN_CHECKED,
        upstreamSha: MAIN_CHECKED,
        testedSha: MERGE_COMMIT,
        testedTreeSha: CHECKED_TREE,
        landedSha: MERGE_COMMIT,
        landedTreeSha: CHECKED_TREE,
        aheadOfUpstream: 1,
      });
      assert.equal(merged.accepted, true);
      assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: blocked.promotionId }, select: { state: true },
      })).state, 'MERGED');
      assert.equal(await stack.db.projectOpenItem.count({ where: { projectId: w.projectId, state: 'OPEN' } }), 0,
        'nothing is left open in front of anybody');

      // H5 — the read keeps the audit of an item that had no task.
      read = await stack.openItems.list(w.ownerId, w.projectId);
      const settled = read.settled.find((r) => r.itemId === blocked.itemId);
      assert.equal(settled?.promotionId, blocked.promotionId);
      assert.equal(settled?.taskId, null);
      assert.equal(settled?.outcome?.resolution, 'HANDLED');
      assert.equal(settled?.outcome?.jobId, retried.jobId);
      assert.equal(settled?.outcome?.resolvedBySessionId, w.coordinatorSessionId);
      assert.equal(settled?.outcome?.note, REASON);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('merge into main, re-check fails again: the candidate is blocked again and the item SUPERSEDED by the new failure, which says what was rerun',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'promo-retried');
      const blocked = await blockedCandidate(stack, w);
      const retried = await retryCandidate(stack, w, blocked.promotionId);
      const recheck = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      const answer = await report(stack, w, recheck, redCheck(LINE_FIRST));
      assert.equal(answer.accepted, true);

      assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: blocked.promotionId }, select: { state: true },
      })).state, 'BLOCKED');
      const [first, second] = await itemsWhere(stack.db, { promotionId: blocked.promotionId });
      assert.equal(first?.id, blocked.itemId);
      assert.ok(second, 'the second red opened its own item');
      assert.equal(answer.openItemId, second.id);
      assert.equal(first!.state, 'SUPERSEDED');
      assert.equal(first!.resolution, 'RETRIED');
      assert.equal(first!.resolvedBy, 'COORDINATOR');
      assert.equal(first!.resolvedBySessionId, w.coordinatorSessionId);
      assert.equal(first!.resolutionNote, REASON);
      assert.equal(first!.resolvedByJobId, retried.jobId);
      assert.equal(first!.supersededByItemId, second.id);
      assertStillOpen(await item(stack.db, second.id), 'the new failure');
      assert.equal(second.assignee, 'COORDINATOR');
      assert.equal(second.taskId, null);
      assert.equal(second.integrationJobId, retried.jobId);
      const payload = second.payload as { generation?: number; retry?: { retryOfJobId?: string } };
      assert.equal(payload.generation, 2);
      assert.equal(payload.retry?.retryOfJobId, blocked.checkJobId);
      const told = await toldAbout(stack.db, w.coordinatorSessionId, second.id);
      assert.equal(told.length, 1);
      assert.match(told[0]!, /这是这个合入 main 的候选的第 2 次检查，由协调会话要求重跑/);
      assert.match(told[0]!, /promotionId 传 /);

      // And it can decide again: a third check, rerunning the second.
      const third = await retryCandidate(stack, w, blocked.promotionId, 'the CI machine was swapped out mid-run');
      assert.equal(third.generation, 3);
      assert.equal(third.retryOfJobId, retried.jobId);
      assert.deepEqual(third.handlingItemIds, [second.id]);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the coordinator closing a merge-into-main item with its reason: HANDLED, its session and reason, about the candidate',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'promo-closed');
      const blocked = await blockedCandidate(stack, w);
      const note = 'main was merged by hand from the project branch; the receipt is on the tasks';
      const closed = await stack.openItems.resolveOpenItem(w.ownerId, w.projectId, blocked.itemId, { note },
        { kind: 'SESSION', sessionId: w.coordinatorSessionId });
      assert.deepEqual(closed, { itemId: blocked.itemId, state: 'RESOLVED', resolution: 'HANDLED' });
      const row = await item(stack.db, blocked.itemId);
      assert.equal(row.resolvedBy, 'COORDINATOR');
      assert.equal(row.resolvedBySessionId, w.coordinatorSessionId);
      assert.equal(row.resolutionNote, note);
      assert.equal(row.resolvedByJobId, null, 'no job ended it');
      assert.equal(row.promotionId, blocked.promotionId);
      const read = await stack.openItems.list(w.ownerId, w.projectId);
      const settled = read.settled.find((r) => r.itemId === blocked.itemId);
      assert.equal(settled?.outcome?.note, note);
      assert.equal(settled?.outcome?.jobId, null);
      const again = await denied(() => stack.openItems.resolveOpenItem(w.ownerId, w.projectId, blocked.itemId,
        { note: 'twice' }, { kind: 'SESSION', sessionId: w.coordinatorSessionId }));
      assert.equal(again.code, 'OPEN_ITEM_NOT_OPEN', 'an ending is final');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── in flight, escalated, and the owner's ─────────────────────────────────────────────────────

test('escalated while its rerun ran: never HANDLED in the coordinator\'s name — the landing answers it as LANDED by the platform — and the coordinator\'s close is refused',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'land-escalated');
      const red = await failedLanding(stack, w, 'land-escalated');
      await retryTask(stack, w, red.taskId);
      await escalate(stack, red.itemId);

      const escalated = await item(stack.db, red.itemId);
      assertStillOpen(escalated, 'the escalated item');
      assert.equal(escalated.assignee, 'OWNER');
      assert.equal(escalated.assigneeReason, 'ESCALATED');
      const read = await stack.openItems.list(w.ownerId, w.projectId);
      const mine = read.needsYou.find((r) => r.itemId === red.itemId);
      assert.equal(mine?.handling?.state, 'QUEUED', 'the owner sees the rerun still in flight');
      assert.equal(mine?.outcome, null);

      // The owner's now: the coordinator may not close it, nor queue anything beside the rerun.
      const close = await denied(() => stack.openItems.resolveOpenItem(w.ownerId, w.projectId, red.itemId,
        { note: 'it is landing' }, { kind: 'SESSION', sessionId: w.coordinatorSessionId }));
      assert.equal(close.code, 'OPEN_ITEM_NOT_COORDINATOR_ITEM');
      const again = await denied(() => retryTask(stack, w, red.taskId));
      assert.equal(again.code, 'INTEGRATION_RETRY_IN_FLIGHT');

      const rerun = await onlyClaim(stack, w, 'LAND_TASK');
      await report(stack, w, rerun, landed(LINE_BEFORE, LINE_FIRST, LINE_FIRST_TREE));
      const row = await item(stack.db, red.itemId);
      assert.equal(row.state, 'RESOLVED');
      assert.equal(row.resolution, 'LANDED', 'answered by the landing, the fact every item about a task is answered by');
      assert.equal(row.resolvedBy, 'PLATFORM', 'not by the coordinator: it was the owner\'s by then');
      assert.equal(row.resolvedBySessionId, null);
      assert.equal(row.resolvedByJobId, null);
      assert.equal((await stack.openItems.list(w.ownerId, w.projectId)).settled.length, 0,
        'nothing the coordinator handled');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('escalated while its re-check ran: a passing check leaves the owner\'s item open and the merge waiting on the owner\'s card; a failing one hands the new failure to the owner',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      // Passing.
      const w = await world(stack, 'promo-escalated-pass');
      const blocked = await blockedCandidate(stack, w);
      await retryCandidate(stack, w, blocked.promotionId);
      await escalate(stack, blocked.itemId);
      const recheck = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      const checked = await report(stack, w, recheck, cleanCheck(LINE_FIRST));
      const held = await item(stack.db, blocked.itemId);
      assertStillOpen(held, 'the owner\'s item, whose re-check passed');
      assert.equal(held.assignee, 'OWNER');
      const candidate = await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: blocked.promotionId },
        select: { state: true, confirmedAutomatically: true, openItemId: true },
      });
      assert.equal(candidate.state, 'READY', 'not merged by Automatic: an item about it is the owner\'s');
      assert.equal(candidate.confirmedAutomatically, false);
      assert.ok(candidate.openItemId, 'the owner\'s merge card is opened');
      assert.equal(checked.openItemId, candidate.openItemId);
      const card = await stack.db.projectOpenItem.findUniqueOrThrow({
        where: { id: candidate.openItemId! },
        select: { kind: true, assignee: true, state: true },
      });
      assert.deepEqual(card, { kind: 'PROMOTION_APPROVAL', assignee: 'OWNER', state: 'OPEN' });
      // A candidate waiting on the owner's Merge is not the coordinator's to check again or to close.
      const recheckAgain = await denied(() => retryCandidate(stack, w, blocked.promotionId));
      assert.equal(recheckAgain.code, 'INTEGRATION_RETRY_NOT_APPLICABLE');
      assert.match(recheckAgain.message, /Merge to main/);
      const closeCard = await denied(() => stack.openItems.resolveOpenItem(w.ownerId, w.projectId,
        candidate.openItemId!, { note: 'merging' }, { kind: 'SESSION', sessionId: w.coordinatorSessionId }));
      assert.equal(closeCard.code, 'OPEN_ITEM_HAS_ITS_OWN_DOOR');
      const confirm = await denied(() => stack.promotions.confirm(
        { userId: w.ownerId, actingSessionId: w.coordinatorSessionId }, w.projectId, blocked.promotionId, LINE_FIRST));
      assert.equal(confirm.status, 403);
      assert.equal(confirm.code, 'PROMOTION_OWNER_ONLY', 'merging into main is the owner\'s press');

      // Failing.
      const v = await world(stack, 'promo-escalated-fail');
      const again = await blockedCandidate(stack, v);
      const retried = await retryCandidate(stack, v, again.promotionId);
      await escalate(stack, again.itemId);
      const ownersHold = await item(stack.db, again.itemId);
      const red = await onlyClaim(stack, v, 'CHECK_PROMOTION');
      const failed = await report(stack, v, red, redCheck(LINE_FIRST));
      const [first, second] = await itemsWhere(stack.db, { promotionId: again.promotionId });
      assert.equal(first!.state, 'SUPERSEDED');
      assert.equal(first!.resolution, 'RETRIED');
      assert.equal(first!.resolvedByJobId, retried.jobId);
      assert.equal(first!.supersededByItemId, second!.id);
      assert.equal(failed.openItemId, second!.id);
      assertStillOpen(await item(stack.db, second!.id), 'the new failure');
      assert.equal(second!.assignee, 'OWNER', 'the owner held the failure, and still does');
      assert.equal(second!.assigneeReason, 'ESCALATED');
      assert.deepEqual(second!.escalatedAt, ownersHold.escalatedAt);
      assert.deepEqual(second!.waitingSince, ownersHold.waitingSince, 'the owner\'s wait goes on');
      const refused = await denied(() => retryCandidate(stack, v, again.promotionId));
      assert.equal(refused.code, 'INTEGRATION_RETRY_OWNER_ITEM');
      assert.match(refused.message, /ESCALATED/);
      assert.equal(await stack.db.projectOpenItemDelivery.count({ where: { itemId: second!.id } }), 0,
        'nothing about it is handed back to the coordinator');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('escalated before anything was done: the owner\'s item refuses the coordinator\'s re-check and its close — until the owner hands it back',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'promo-owner');
      const blocked = await blockedCandidate(stack, w);
      await escalate(stack, blocked.itemId);
      const recheck = await denied(() => retryCandidate(stack, w, blocked.promotionId));
      assert.equal(recheck.status, 409);
      assert.equal(recheck.code, 'INTEGRATION_RETRY_OWNER_ITEM');
      const close = await denied(() => stack.openItems.resolveOpenItem(w.ownerId, w.projectId, blocked.itemId,
        { note: 'the baseline is fixed' }, { kind: 'SESSION', sessionId: w.coordinatorSessionId }));
      assert.equal(close.code, 'OPEN_ITEM_NOT_COORDINATOR_ITEM');
      assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: blocked.promotionId }, select: { state: true },
      })).state, 'BLOCKED', 'nothing moved');
      assert.equal(await stack.db.projectIntegrationJob.count({
        where: { promotionId: blocked.promotionId, kind: 'CHECK_PROMOTION' },
      }), 1, 'no check was queued');
      assertStillOpen(await item(stack.db, blocked.itemId), 'the owner\'s item');

      await stack.openItems.returnToCoordinator(w.ownerId, w.projectId, blocked.itemId);
      const retried = await retryCandidate(stack, w, blocked.promotionId);
      assert.deepEqual(retried.handlingItemIds, [blocked.itemId], 'handed back, the decision came with it');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('not Automatic: a blocked merge is the owner\'s from birth; handed back, the coordinator re-checks it, and the merge still waits on the owner\'s card',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'promo-manual', false);
      const blocked = await blockedCandidate(stack, w);
      const born = await item(stack.db, blocked.itemId);
      assert.equal(born.assignee, 'OWNER');
      assert.equal(born.assigneeReason, 'NO_COORDINATOR');
      const refused = await denied(() => retryCandidate(stack, w, blocked.promotionId));
      assert.equal(refused.code, 'INTEGRATION_RETRY_OWNER_ITEM');
      assert.match(refused.message, /not Automatic/);

      await stack.openItems.returnToCoordinator(w.ownerId, w.projectId, blocked.itemId);
      const retried = await retryCandidate(stack, w, blocked.promotionId);
      const recheck = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      const checked = await report(stack, w, recheck, cleanCheck(LINE_FIRST));
      const row = await item(stack.db, blocked.itemId);
      assert.equal(row.resolution, 'HANDLED', 'the item handed to the coordinator is handled by it');
      assert.equal(row.resolvedByJobId, retried.jobId);
      const candidate = await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: blocked.promotionId },
        select: { state: true, confirmedAutomatically: true, openItemId: true },
      });
      assert.equal(candidate.state, 'READY', 'without Automatic the merge is the owner\'s card');
      assert.equal(candidate.confirmedAutomatically, false);
      assert.equal(checked.openItemId, candidate.openItemId);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the door\'s edges: only the coordinator, with a reason, one check at a time, never a conflict, never another project\'s candidate',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'promo-edges');
      const blocked = await blockedCandidate(stack, w);
      const taskSession = await stack.db.session.findFirstOrThrow({
        where: { taskId: blocked.taskId }, select: { id: true },
      });
      const elsewhere = await world(stack, 'promo-edges-elsewhere');
      for (const [who, sessionId] of [
        ['the task\'s own session', taskSession.id],
        ['another project\'s coordinator', elsewhere.coordinatorSessionId],
        ['no session at all', ''],
      ] as const) {
        const refused = await denied(() => retryCandidate(stack, w, blocked.promotionId, REASON, sessionId));
        assert.equal(refused.status, 403, who);
        assert.equal(refused.code, 'INTEGRATION_RETRY_COORDINATOR_ONLY', who);
      }
      for (const reason of ['', '  \n ', 'x'.repeat(2_001)]) {
        const refused = await denied(() => retryCandidate(stack, w, blocked.promotionId, reason));
        assert.equal(refused.status, 400);
        assert.equal(refused.code, 'INTEGRATION_RETRY_REASON_REQUIRED');
      }
      const foreign = await denied(() => stack.openItems.retryPromotionCheck(
        elsewhere.ownerId, elsewhere.projectId, blocked.promotionId, { reason: REASON }, elsewhere.coordinatorSessionId));
      assert.equal(foreign.status, 404);
      assertStillOpen(await item(stack.db, blocked.itemId), 'the item, after every refusal');
      assert.equal((await item(stack.db, blocked.itemId)).handlingJobId, null, 'and nothing is handling it');

      // Two at once queue one check.
      const raced = await Promise.allSettled([
        retryCandidate(stack, w, blocked.promotionId, 'first press'),
        retryCandidate(stack, w, blocked.promotionId, 'second press'),
      ]);
      assert.equal(raced.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      const loser = raced.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      assert.equal(((loser?.reason as HttpException).getResponse() as { code: string }).code, 'INTEGRATION_RETRY_IN_FLIGHT');
      assert.equal(await stack.db.projectIntegrationJob.count({
        where: { promotionId: blocked.promotionId, kind: 'CHECK_PROMOTION', state: 'QUEUED' },
      }), 1);

      // A candidate stopped on a conflict with main is answered by a branch that changed, not a rerun.
      const c = await world(stack, 'promo-conflict');
      await doneCodeTask(stack, c, 'promo-conflict-first');
      const landing = await onlyClaim(stack, c, 'LAND_TASK');
      await report(stack, c, landing, landed(LINE_BEFORE, LINE_FIRST, LINE_FIRST_TREE));
      const check = await onlyClaim(stack, c, 'CHECK_PROMOTION');
      await report(stack, c, check, {
        state: 'CONFLICT',
        phase: 'MERGE',
        sourceSha: LINE_FIRST,
        targetShaBefore: MAIN_CHECKED,
        upstreamSha: MAIN_CHECKED,
        conflicts: ['src/web/src/pages/ProjectsPage.tsx'],
      });
      const conflicted = await stack.db.projectPromotion.findFirstOrThrow({
        where: { projectId: c.projectId }, select: { id: true, state: true },
      });
      assert.equal(conflicted.state, 'BLOCKED');
      const conflict = await denied(() => retryCandidate(stack, c, conflicted.id));
      assert.equal(conflict.code, 'INTEGRATION_RETRY_NOT_APPLICABLE');
      assert.match(conflict.message, /only a project branch that changed answers one/);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── the owner asking the coordinator again about a merge into main ────────────────────────────

test('escalated merge into main: the owner\'s card offers "Ask the coordinator again"; pressed, the coordinator\'s re-check is accepted as it was before the clock ran out, and Automatic merges as it would have',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'promo-ask-again');
      const blocked = await blockedCandidate(stack, w);
      await escalate(stack, blocked.itemId);

      // The owner's card: the way back to the coordinator, beside the merge card the row leads to.
      let read = await stack.openItems.list(w.ownerId, w.projectId);
      const owners = read.needsYou.find((row) => row.itemId === blocked.itemId);
      assert.ok(owners, 'the escalated item is in the owner\'s group');
      assert.equal(owners!.kind, 'INTEGRATION_CHECK_FAILED');
      assert.equal(owners!.promotionId, blocked.promotionId);
      assert.equal(owners!.taskId, null, 'about the candidate, and about no task');
      assert.equal(owners!.assigneeReason, 'ESCALATED');
      assert.deepEqual(owners!.actions, ['ASK_COORDINATOR_AGAIN', 'RETRY', 'REVIEW']);
      const before = await denied(() => retryCandidate(stack, w, blocked.promotionId));
      assert.equal(before.code, 'INTEGRATION_RETRY_OWNER_ITEM', 'until the press, the re-check is the owner\'s');

      // The press: the item is the coordinator's again, and it is told afresh how to answer it.
      const returned = await stack.openItems.returnToCoordinator(w.ownerId, w.projectId, blocked.itemId);
      assert.equal(returned.assignee, 'COORDINATOR');
      const handed = await item(stack.db, blocked.itemId);
      assertStillOpen(handed, 'the item handed back');
      assert.equal(handed.assignee, 'COORDINATOR');
      assert.equal(handed.assigneeReason, 'DEFAULT');
      assert.equal(handed.escalatedAt, null);
      // A turn of its own, keyed by the new assignment (`assigned_at` moves with `waiting_since`), not
      // the one the item was first delivered in.
      const told = await toldAbout(stack.db, w.coordinatorSessionId, blocked.itemId);
      assert.equal(told.length, 2, 'delivered when it opened, and again when the owner handed it back');
      const fresh = await stack.db.conversationTurn.findMany({
        where: {
          sessionId: w.coordinatorSessionId,
          clientTurnId: `open-item:v1:${blocked.itemId}:${returned.waitingSince.getTime()}`,
        },
        select: { content: true },
      });
      assert.equal(fresh.length, 1, 'the hand-back is a fresh turn on the coordinator');
      assert.match(fresh[0]!.content ?? '', /integration_retry/);
      assert.match(fresh[0]!.content ?? '', new RegExp(`promotionId 传 ${uuidToBase62(blocked.promotionId)}`));
      read = await stack.openItems.list(w.ownerId, w.projectId);
      assert.equal(read.needsYou.some((row) => row.itemId === blocked.itemId), false);
      assert.deepEqual(read.withCoordinator.find((row) => row.itemId === blocked.itemId)?.actions, ['RETRY', 'REVIEW'],
        'the coordinator\'s own item is not asked again');

      // The coordinator's re-check door takes it, on the authority it had before the item escalated.
      const retried = await retryCandidate(stack, w, blocked.promotionId);
      assert.equal(retried.retryOfJobId, blocked.checkJobId);
      assert.deepEqual(retried.handlingItemIds, [blocked.itemId], 'handed back, the decision came with it');
      const recheck = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      assert.equal(recheck.jobId, retried.jobId);
      const checked = await report(stack, w, recheck, cleanCheck(LINE_FIRST));
      assert.equal(checked.accepted, true);
      const row = await item(stack.db, blocked.itemId);
      assert.equal(row.resolution, 'HANDLED');
      assert.equal(row.resolvedBy, 'COORDINATOR');
      assert.equal(row.resolvedBySessionId, w.coordinatorSessionId);
      assert.equal(row.resolvedByJobId, retried.jobId);
      // Automatic's own rule over a clean check (M-T11), exactly as if the clock had never run out.
      assert.equal(checked.openItemId, null, 'no owner card is opened');
      assert.deepEqual(await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: blocked.promotionId },
        select: { state: true, confirmedAutomatically: true, confirmedByUserId: true },
      }), { state: 'CONFIRMED', confirmedAutomatically: true, confirmedByUserId: null });
    } finally {
      await stack.db.$disconnect();
    }
  });

test('not Automatic: asked again, the coordinator re-checks the blocked merge, and the merge card that follows keeps "Review" alone and stays the owner\'s to merge',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'promo-ask-manual', false);
      const blocked = await blockedCandidate(stack, w);
      let read = await stack.openItems.list(w.ownerId, w.projectId);
      const born = read.needsYou.find((row) => row.itemId === blocked.itemId);
      assert.equal(born?.assigneeReason, 'NO_COORDINATOR', 'the owner\'s from birth');
      assert.deepEqual(born?.actions, ['ASK_COORDINATOR_AGAIN', 'RETRY', 'REVIEW'],
        'the conversation exists, so the press is offered whatever the switch says');

      await stack.openItems.returnToCoordinator(w.ownerId, w.projectId, blocked.itemId);
      const retried = await retryCandidate(stack, w, blocked.promotionId);
      assert.deepEqual(retried.handlingItemIds, [blocked.itemId]);
      const recheck = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      const checked = await report(stack, w, recheck, cleanCheck(LINE_FIRST));
      const candidate = await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: blocked.promotionId },
        select: { state: true, confirmedAutomatically: true, openItemId: true },
      });
      assert.equal(candidate.state, 'READY', 'the re-check passing does not merge anything');
      assert.equal(candidate.confirmedAutomatically, false);
      assert.ok(candidate.openItemId);
      assert.equal(checked.openItemId, candidate.openItemId);

      // The merge card: the owner's, with the conversation there to ask, and still only "Review".
      read = await stack.openItems.list(w.ownerId, w.projectId);
      const approval = read.needsYou.find((row) => row.itemId === candidate.openItemId);
      assert.equal(approval?.kind, 'PROMOTION_APPROVAL');
      assert.equal(approval?.assignee, 'OWNER');
      assert.deepEqual(approval?.actions, ['REVIEW'], 'a merge card is decided on its own card, never asked again');
      const handBack = await stack.openItems.returnToCoordinator(w.ownerId, w.projectId, candidate.openItemId!)
        .then(() => null, (error: unknown) => error);
      assert.ok(handBack, 'pressed anyway, the merge card is not handed to the coordinator');
      assert.deepEqual(await stack.db.projectOpenItem.findUniqueOrThrow({
        where: { id: candidate.openItemId! }, select: { state: true, assignee: true },
      }), { state: 'OPEN', assignee: 'OWNER' });

      // Merging stays the owner's press: the coordinator can neither re-check a READY candidate, close
      // its card nor confirm it; the owner's confirm does.
      const recheckAgain = await denied(() => retryCandidate(stack, w, blocked.promotionId));
      assert.equal(recheckAgain.code, 'INTEGRATION_RETRY_NOT_APPLICABLE');
      assert.match(recheckAgain.message, /Merge to main/);
      const closeCard = await denied(() => stack.openItems.resolveOpenItem(w.ownerId, w.projectId,
        candidate.openItemId!, { note: 'merging' }, { kind: 'SESSION', sessionId: w.coordinatorSessionId }));
      assert.equal(closeCard.code, 'OPEN_ITEM_HAS_ITS_OWN_DOOR');
      const byCoordinator = await denied(() => stack.promotions.confirm(
        { userId: w.ownerId, actingSessionId: w.coordinatorSessionId }, w.projectId, blocked.promotionId, LINE_FIRST));
      assert.equal(byCoordinator.status, 403);
      assert.equal(byCoordinator.code, 'PROMOTION_OWNER_ONLY');
      await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, blocked.promotionId, LINE_FIRST);
      assert.deepEqual(await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: blocked.promotionId },
        select: { state: true, confirmedAutomatically: true, confirmedByUserId: true },
      }), { state: 'CONFIRMED', confirmedAutomatically: false, confirmedByUserId: w.ownerId });
    } finally {
      await stack.db.$disconnect();
    }
  });

test('no conversation left to ask: an escalated merge-into-main item offers "Review" alone, and the press is refused',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'promo-ask-nobody');
      const blocked = await blockedCandidate(stack, w);
      await escalate(stack, blocked.itemId);
      await stack.db.session.update({
        where: { id: w.coordinatorSessionId },
        data: { completedAt: new Date() },
      });
      const read = await stack.openItems.list(w.ownerId, w.projectId);
      assert.deepEqual(read.needsYou.find((row) => row.itemId === blocked.itemId)?.actions, ['RETRY', 'REVIEW']);
      const pressed = await denied(() => stack.openItems.returnToCoordinator(w.ownerId, w.projectId, blocked.itemId));
      assert.equal(pressed.status, 409);
      assert.equal(pressed.code, 'OPEN_ITEM_NO_COORDINATOR');
      assert.equal((await item(stack.db, blocked.itemId)).assignee, 'OWNER', 'nothing moved');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the open-item-coordinator-handling PostgreSQL target is explicitly disposable', { skip }, () => {
  assert.doesNotThrow(() => assertCoordinatorPgUrlIsIsolated(URL));
});
