import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

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
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  IntegrationCheckResult,
  RunEventType,
  RunStatus as SharedRunStatus,
  TaskStatus as DeclaredTaskStatus,
} from '@orbit/shared';
import { HttpException } from '@nestjs/common';

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
import { INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND, shortBranchName } from './project-integration-job';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectIntegrationRetryController } from './project-integration-retry.controller';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * `integration_retry` (docs/project-integration-line-contract.md §2.3 J-T1b): a project's coordinator
 * runs a DONE task's failed landing again, with a reason, and gets exactly one new generation.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/integration-retry.pg.spec.ts
 *
 * WHAT IT REPRODUCES. On 2026-10-01 project 34Y7My8sqhKLWtmCQYv1l had three DONE tasks whose only
 * landing (generation 1) had ended CHECK_FAILED, nothing in flight, and the coordinator's items about
 * two of them already closed by hand: `task_start` only ran the task again, nothing could queue the
 * landing again, and the tasks downstream waited for ever. Every case below starts from that state —
 * a DONE task whose landing really was queued by its DONE, claimed off the heartbeat and reported
 * failed by the runner's own route — and goes on through the product's doors: the retry door the
 * runner route calls, the heartbeat that hands the new generation out, and the result route that
 * lands it or fails it again.
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
  sessions: SessionsService;
  tasks: TasksService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
  openItems: ProjectOpenItemService;
  ownerRetry: ProjectIntegrationRetryController;
}

/** The production wiring over one client, with the real completion-input router behind task writes. */
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
  const ownerRetry = new ProjectIntegrationRetryController(openItems);
  const push = new Proxy({}, { get: () => async () => undefined }) as never;
  // The result route as production wires it, down to the promotion service its aftermath asks to
  // consider the project branch for main (§3.4 M-F1) — which is what "the landing goes on to the
  // merge check" is made of.
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
  return { db, sessions, tasks, api, jobs, openItems, ownerRetry };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

/**
 * One project integrating on a branch of its own (§1.2), with the conversation it is coordinated
 * from parked between turns. `automatic` is the owner's switch (`coordinator_enabled`).
 */
async function world(stack: Stack, label: string, automatic = true): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@retry.invalid`, name: label, passwordHash: 'x' },
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
      goal: 'every finished task reaches the line',
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
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

interface Attempt {
  taskId: string;
  title: string;
  sessionId: string;
  turnId: string;
  branch: string;
}

function dequeue(stack: Stack, sessionId: string, runnerId: string) {
  return (stack.api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string; content?: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, runnerId, null);
}

/** The engine's reply to a turn it ran, up the door the runner posts its transcript to. */
async function answerTurn(stack: Stack, w: World, sessionId: string, turnId: string, text: string) {
  const last = await stack.db.runEvent.aggregate({ where: { sessionId }, _max: { seq: true } });
  await stack.api.events({ id: w.runnerId }, sessionId, {
    events: [{
      seq: (last._max.seq ?? 0) + 1,
      type: RunEventType.ASSISTANT,
      ts: new Date().toISOString(),
      turnId,
      payload: { text },
    }],
  });
}

/**
 * One code task carried to DONE through its own acceptance command — which queues its landing in the
 * same transaction (§2.3 J-T1a) — with the work session finished, as the runner leaves it.
 */
async function doneTask(
  stack: Stack,
  w: World,
  label: string,
  /** False for work that took no worktree: a DONE that has no branch to hand the line. */
  worktree = true,
): Promise<Attempt> {
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const branch = `orbit/${label}-${randomUUID().slice(0, 6)}`;
  const declared = await stack.tasks.create(w.ownerId, {
    title,
    assigneeId: w.workspaceId,
    projectId: w.projectId,
    acceptanceCommand: 'exit 0',
    acceptanceExpectedExitCode: 0,
  });
  const sessionId = randomUUID();
  const turnId = randomUUID();
  await stack.db.session.create({
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
      ...(worktree ? { branch, isolationStatus: 'worktree', baseSha: 'b'.repeat(40) } : {}),
    },
  });
  await stack.db.conversationTurn.create({
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
  await answerTurn(stack, w, sessionId, turnId, 'the work is on the branch');
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  const acceptance = await dequeue(stack, sessionId, w.runnerId);
  assert.equal(acceptance?.taskAcceptance, true, 'the acceptance command was queued for this task');
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId: acceptance!.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  assert.equal(await taskStatus(stack.db, declared.id), TaskStatus.DONE, 'the acceptance command agreed');
  // The runner commits the worktree when it FINISHES the session (SR13), and a landing is not handed
  // over before that (J-T1a): what the queue reads is the finish and where HEAD ended.
  await stack.db.session.update({
    where: { id: sessionId },
    data: worktree
      ? { finishedAt: new Date(), worktreeBranch: branch, worktreeDirty: false }
      : { finishedAt: new Date() },
  });
  return { taskId: declared.id, title, sessionId, turnId, branch };
}

/** The runner asking for work, as its heartbeat does. */
function claim(
  stack: Stack,
  w: World,
  lease: string,
  extraCapabilities: string[] = [],
): Promise<IntegrationJobCommand[]> {
  return stack.jobs.dispatch({
    runnerId: w.runnerId,
    leaseOwner: lease,
    draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM, ...extraCapabilities],
  });
}

type Failure = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

/** The result a runner posts, over the route it posts it on. */
function report(stack: Stack, w: World, job: IntegrationJobCommand, result: Failure) {
  return stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
}

const RED_MERGE_CHECK: Failure = {
  state: 'CHECK_FAILED',
  phase: 'CHECK',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'c'.repeat(40),
  testedSha: 'd'.repeat(40),
  testedTreeSha: 'e'.repeat(40),
  checks: [{
    name: 'MERGE_CHECK',
    command: 'npm test && go test ./...',
    expectedExitCode: 0,
    exitCode: 1,
    timedOut: false,
    durationMs: 1_609_148,
    outputTail: '--- FAIL: TestRealClaudeAcceptsASetModel (1.45s)\nFAIL\torbit\t551.473s',
  }],
};

const GREEN_MERGE_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'npm test',
  expectedExitCode: 0,
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
  outputTail: 'ok\n',
};

const TIMED_OUT_CHECK: Failure = {
  ...RED_MERGE_CHECK,
  checks: [{
    name: 'TASK_ACCEPTANCE',
    command: 'npm test && go test ./...',
    expectedExitCode: 0,
    exitCode: null,
    timedOut: true,
    durationMs: 3_600_000,
    outputTail: 'ok  \torbit/cmd/x\t0.1s',
  }],
};

const MACHINERY_ERROR: Failure = {
  state: 'ERROR',
  phase: 'PUSH',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'c'.repeat(40),
  errorCode: 'PUSH_REJECTED',
  errorDetail: { reason: 'the remote refused a non-fast-forward push' },
};

const CONFLICTED: Failure = {
  state: 'CONFLICT',
  phase: 'REBASE',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'c'.repeat(40),
  conflicts: ['src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts'],
};

/** What a runner reports for a job that landed: one tree tested and landed, as J2 demands. */
const LANDED: Failure = {
  state: 'LANDED',
  phase: 'PUSH',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'c'.repeat(40),
  testedSha: 'd'.repeat(40),
  testedTreeSha: 'e'.repeat(40),
  landedSha: 'd'.repeat(40),
  landedTreeSha: 'e'.repeat(40),
  aheadOfUpstream: 1,
};

/** A DONE task whose first landing the runner reported as failed in the given way. */
async function failedLanding(
  stack: Stack,
  w: World,
  label: string,
  failure: Failure = RED_MERGE_CHECK,
): Promise<{ task: Attempt; job: IntegrationJobCommand }> {
  const task = await doneTask(stack, w, label);
  const claimed = await claim(stack, w, `lease-${label}`);
  assert.equal(claimed.length, 1, `the DONE queued no landing — ${await jobsOf(stack.db, task.taskId)}`);
  const answer = await report(stack, w, claimed[0]!, failure);
  assert.equal(answer.accepted, true);
  return { task, job: claimed[0]! };
}

/** A project-branch candidate whose first CHECK_PROMOTION ended in a red check. */
async function failedPromotion(
  stack: Stack,
  w: World,
  label: string,
): Promise<{ promotionId: string; check: IntegrationJobCommand }> {
  const task = await doneTask(stack, w, label);
  const [landing] = await claim(stack, w, `lease-${label}-landing`);
  assert.ok(landing, 'the task landing was queued');
  const landed = await report(stack, w, landing!, LANDED);
  assert.equal(landed.accepted, true, 'the task landed on the project branch');
  const [check] = await claim(stack, w, `lease-${label}-check`);
  assert.equal(check?.kind, 'CHECK_PROMOTION', 'the landing queued a promotion check');
  const blocked = await report(stack, w, check!, {
    ...RED_MERGE_CHECK,
    sourceSha: 'd'.repeat(40),
    targetShaBefore: 'f'.repeat(40),
    upstreamSha: 'f'.repeat(40),
    testedSha: '2'.repeat(40),
    testedTreeSha: '3'.repeat(40),
  });
  assert.equal(blocked.accepted, true, 'the check failure blocked the candidate');
  const promotion = await stack.db.projectPromotion.findFirstOrThrow({
    where: { projectId: w.projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, state: true },
  });
  assert.equal(promotion.state, 'BLOCKED');
  return { promotionId: promotion.id, check: check! };
}

interface JobRow {
  id: string;
  generation: number;
  state: string;
  sourceRef: string;
  sessionId: string | null;
  retryOfJobId: string | null;
  retryFailureClass: string | null;
  retryReason: string | null;
  retryRequestedBySessionId: string | null;
  retryRequestedByUserId: string | null;
}

/** Every LAND_TASK of this task, oldest generation first. */
function landings(db: PrismaClient, taskId: string): Promise<JobRow[]> {
  return db.projectIntegrationJob.findMany({
    where: { taskId, kind: 'LAND_TASK' },
    orderBy: [{ generation: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      generation: true,
      state: true,
      sourceRef: true,
      sessionId: true,
      retryOfJobId: true,
      retryFailureClass: true,
      retryReason: true,
      retryRequestedBySessionId: true,
      retryRequestedByUserId: true,
    },
  });
}

async function jobsOf(db: PrismaClient, taskId: string): Promise<string> {
  return `landings: ${JSON.stringify((await landings(db, taskId)).map((job) => [job.generation, job.state]))}`;
}

async function taskStatus(db: PrismaClient, taskId: string): Promise<TaskStatus> {
  return (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } })).status;
}

interface ItemRow {
  id: string;
  kind: string;
  state: string;
  assignee: string;
  assigneeReason: string;
  integrationJobId: string | null;
  handlingJobId: string | null;
  handlingSessionId: string | null;
  handlingUserId: string | null;
  handlingReason: string | null;
  payload: {
    failureClass?: string;
    generation?: number;
    retry?: { retryOfJobId?: string; failureClass?: string; reason?: string; requestedBySessionId?: string; requestedByUserId?: string };
    check?: { name: string; timedOut?: boolean };
  };
  resolution: string | null;
  resolvedBy: string | null;
  resolvedBySessionId: string | null;
  resolvedByUserId: string | null;
  resolutionNote: string | null;
  supersededByItemId: string | null;
}

/** Every item about this task, oldest first. */
function itemsOf(db: PrismaClient, taskId: string): Promise<ItemRow[]> {
  return db.$queryRaw<ItemRow[]>(Prisma.sql`
    SELECT "id", "kind", "state", "assignee", "assignee_reason" AS "assigneeReason",
           "integration_job_id" AS "integrationJobId", "handling_job_id" AS "handlingJobId",
           "handling_session_id" AS "handlingSessionId", "handling_user_id" AS "handlingUserId",
           "handling_reason" AS "handlingReason",
           "payload", "resolution",
           "resolved_by" AS "resolvedBy", "resolved_by_user_id" AS "resolvedByUserId",
           "resolved_by_session_id" AS "resolvedBySessionId",
           "resolution_note" AS "resolutionNote", "superseded_by_item_id" AS "supersededByItemId"
      FROM "project_open_item"
     WHERE "task_id" = ${taskId}::uuid
     ORDER BY "created_at", "id"`);
}

/** The door as the runner route calls it: the acting session is the header's. */
function retry(stack: Stack, w: World, taskId: string, reason: string, sessionId?: string) {
  return stack.openItems.retryIntegration(
    w.ownerId,
    w.projectId,
    taskId,
    { reason },
    sessionId === undefined ? w.coordinatorSessionId : sessionId,
  );
}

/** The owner door as the user controller calls it; unlike the runner door it records a USER id. */
function ownerRetry(stack: Stack, w: World, taskId: string, reason: string) {
  return stack.ownerRetry.retryIntegration(
    { userId: w.ownerId, email: `${w.ownerId}@retry.invalid` },
    w.projectId,
    taskId,
    { reason },
  );
}

function ownerPromotionRetry(stack: Stack, w: World, promotionId: string, reason: string) {
  return stack.ownerRetry.retryPromotionCheck(
    { userId: w.ownerId, email: `${w.ownerId}@retry.invalid` },
    w.projectId,
    promotionId,
    { reason },
  );
}

/** The status and the code a refusal carries. */
async function denied(run: () => Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
  const thrown = await run().then(() => null, (error: unknown) => error);
  assert.ok(thrown instanceof HttpException, `the door answered instead of refusing: ${JSON.stringify(thrown)}`);
  const body = thrown.getResponse();
  const shaped = typeof body === 'string' ? { message: body } : (body as { code?: string; message?: string });
  return { status: thrown.getStatus(), code: shaped.code, message: shaped.message ?? '' };
}

const REASON = 'the merge check\'s runner-go baseline was repaired; the red was the baseline\'s, not this delivery\'s';

test('Automatic: the coordinator reruns a red landing with a reason — one new generation, the failure class and the reason kept, its item handled but still open',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-red');
      const { task, job } = await failedLanding(stack, w, 'retry-red');
      const [opened] = await itemsOf(stack.db, task.taskId);
      assert.equal(opened?.kind, 'INTEGRATION_CHECK_FAILED');
      assert.equal(opened?.assignee, 'COORDINATOR', 'Automatic hands the failure to the coordinator');
      assert.equal(opened?.payload.failureClass, 'CHECK_FAILED', 'the item is opened classified');
      assert.equal(opened?.payload.generation, 1);

      const retried = await retry(stack, w, task.taskId, `  ${REASON}  `);

      const rows = await landings(stack.db, task.taskId);
      assert.deepEqual(rows.map((row) => [row.generation, row.state]), [[1, 'CHECK_FAILED'], [2, 'QUEUED']],
        'exactly one new generation, queued behind the failed one');
      const second = rows[1]!;
      assert.equal(retried.jobId, second.id);
      assert.equal(retried.generation, 2);
      assert.equal(retried.taskId, task.taskId);
      assert.equal(retried.retryOfJobId, job.jobId);
      assert.equal(retried.failureClass, 'CHECK_FAILED');
      assert.equal(retried.reason, REASON, 'the reason is kept as given, trimmed');
      assert.equal(retried.sourceRef, `refs/heads/${task.branch}`);
      assert.deepEqual(retried.handlingItemIds, [opened!.id]);
      assert.equal(second.retryOfJobId, job.jobId, 'the new generation names the one it reruns');
      assert.equal(second.retryFailureClass, 'CHECK_FAILED', 'and what that one failed of');
      assert.equal(second.retryReason, REASON, 'and why it was asked for');
      assert.equal(second.retryRequestedBySessionId, w.coordinatorSessionId, 'and who asked');
      assert.equal(second.sessionId, task.sessionId);

      // §4.7 H1: asking for the rerun does not answer the item — the rerun has not landed yet.
      const [after] = await itemsOf(stack.db, task.taskId);
      assert.equal(after?.state, 'OPEN', 'the item about the failed landing stays open while the rerun is in flight');
      assert.equal(after?.resolution, null);
      assert.equal(after?.resolvedBy, null, 'and nobody is recorded as having handled it yet');
      assert.equal(after?.handlingJobId, second.id, 'it names the generation that will answer it');
      assert.equal(after?.handlingSessionId, w.coordinatorSessionId, 'who asked');
      assert.equal(after?.handlingReason, REASON, 'and why');
      assert.equal(after?.integrationJobId, job.jobId, 'and still points at the generation it was about');
      assert.equal(await taskStatus(stack.db, task.taskId), TaskStatus.DONE, 'the task itself is untouched');
      const receipts = await stack.db.sessionMergeReceipt.count({ where: { taskId: task.taskId } });
      assert.equal(receipts, 0, 'nothing claims the work landed before the line says so');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('in flight: a second rerun while the first is queued is refused, and two at once queue one generation',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-dedupe');
      const { task } = await failedLanding(stack, w, 'retry-dedupe');
      const raced = await Promise.allSettled([
        retry(stack, w, task.taskId, 'the baseline was repaired (first press)'),
        retry(stack, w, task.taskId, 'the baseline was repaired (second press)'),
      ]);
      const done = raced.filter((outcome) => outcome.status === 'fulfilled');
      const refused = raced.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      assert.equal(done.length, 1, `exactly one of two concurrent reruns goes through — ${await jobsOf(stack.db, task.taskId)}`);
      assert.equal(refused.length, 1);
      const reason = refused[0]!.reason as HttpException;
      assert.ok(reason instanceof HttpException, `the loser was refused, not crashed: ${reason}`);
      assert.equal(reason.getStatus(), 409);
      assert.equal((reason.getResponse() as { code: string }).code, 'INTEGRATION_RETRY_IN_FLIGHT');

      const again = await denied(() => retry(stack, w, task.taskId, 'one more time'));
      assert.equal(again.status, 409);
      assert.equal(again.code, 'INTEGRATION_RETRY_IN_FLIGHT');
      assert.match(again.message, /generation 2 of this task's landing is already QUEUED/);
      assert.deepEqual((await landings(stack.db, task.taskId)).map((row) => [row.generation, row.state]),
        [[1, 'CHECK_FAILED'], [2, 'QUEUED']], 'still one new generation');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('success: the rerun lands on the project branch, answers what was open, and the project branch goes on to its merge check',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-lands');
      const { task } = await failedLanding(stack, w, 'retry-lands');
      const retried = await retry(stack, w, task.taskId, REASON);

      const [handed] = await claim(stack, w, 'lease-retry-lands-2');
      assert.ok(handed, 'the heartbeat hands the rerun out like any landing');
      assert.equal(handed!.jobId, retried.jobId);
      assert.equal(handed!.sourceRef, `refs/heads/${task.branch}`);
      const answer = await report(stack, w, handed!, LANDED);
      assert.equal(answer.accepted, true);

      const rows = await landings(stack.db, task.taskId);
      assert.deepEqual(rows.map((row) => [row.generation, row.state]), [[1, 'CHECK_FAILED'], [2, 'LANDED']]);
      const line = await stack.db.projectCodebase.findFirstOrThrow({
        where: { projectId: w.projectId, slot: 'primary' },
        select: { integrationRef: true, upstreamRef: true },
      });
      assert.notEqual(line.integrationRef, line.upstreamRef, 'the project integrates on a branch of its own');
      const receipts = await stack.db.sessionMergeReceipt.findMany({
        where: { taskId: task.taskId },
        select: { targetBranch: true, result: true },
      });
      assert.deepEqual(receipts, [{ targetBranch: shortBranchName(line.integrationRef), result: 'MERGED' }],
        'the landing wrote the receipt the tasks downstream are released on, onto the project branch');
      assert.deepEqual((await itemsOf(stack.db, task.taskId)).filter((item) => item.state === 'OPEN'), [],
        'nothing is left open about a landing that happened');
      // §3.4 M-F1: the queue just got shorter, so the project branch is offered toward main and its
      // merge check is queued — the same thing any landing leads to.
      const check = await stack.db.projectIntegrationJob.findFirst({
        where: { projectId: w.projectId, kind: 'CHECK_PROMOTION' },
        select: { state: true },
      });
      assert.equal(check?.state, 'QUEUED', 'the project branch went on to its merge check toward main');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('failing again: the next red opens a classified item for the coordinator, naming the rerun and its reason — never the owner\'s',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-red-again');
      const { task, job: first } = await failedLanding(stack, w, 'retry-red-again');
      const retried = await retry(stack, w, task.taskId, REASON);
      const [handed] = await claim(stack, w, 'lease-retry-red-again-2');
      assert.equal(handed?.jobId, retried.jobId);
      const answer = await report(stack, w, handed!, TIMED_OUT_CHECK);
      assert.equal(answer.accepted, true);

      const all = await itemsOf(stack.db, task.taskId);
      const open = all.filter((item) => item.state === 'OPEN');
      assert.equal(open.length, 1, 'one new item about the second failure');
      const second = open[0]!;
      assert.equal(second.kind, 'INTEGRATION_CHECK_FAILED');
      assert.equal(second.assignee, 'COORDINATOR', 'still the coordinator\'s to decide');
      assert.equal(second.assigneeReason, 'DEFAULT', 'not escalated, not handed to the owner');
      assert.equal(second.integrationJobId, retried.jobId);
      assert.equal(second.payload.failureClass, 'CHECK_TIMED_OUT', 'classified off the timedOut flag');
      assert.equal(second.payload.generation, 2);
      assert.equal(second.payload.retry?.retryOfJobId, first.jobId);
      assert.equal(second.payload.retry?.failureClass, 'CHECK_FAILED');
      assert.equal(second.payload.retry?.reason, REASON);
      assert.equal(second.payload.retry?.requestedBySessionId, w.coordinatorSessionId);
      assert.equal(answer.openItemId, second.id);
      // §4.7 H3: the item the rerun was handling ends now, superseded by the one its failure opened.
      const handled = all.find((item) => item.id !== second.id)!;
      assert.equal(handled.state, 'SUPERSEDED');
      assert.equal(handled.resolution, 'RETRIED');
      assert.equal(handled.resolvedBy, 'COORDINATOR');
      assert.equal(handled.resolvedBySessionId, w.coordinatorSessionId);
      assert.equal(handled.resolutionNote, REASON);
      assert.equal(handled.supersededByItemId, second.id, 'and points at the new failure');

      // Nothing about it reaches the owner: no owner item, no blocker.
      const owners = await stack.db.projectOpenItem.count({ where: { projectId: w.projectId, assignee: 'OWNER' } });
      assert.equal(owners, 0, 'an ordinary landing decision is not the owner\'s question');
      const blockers = await stack.db.projectBlocker.count({ where: { projectId: w.projectId } });
      assert.equal(blockers, 0);

      // The coordinator is told, in a message that says what was rerun and why, and what to do now.
      const turns = await stack.db.conversationTurn.findMany({
        where: { sessionId: w.coordinatorSessionId, clientTurnId: { startsWith: 'open-item:v1:' } },
        orderBy: { seq: 'asc' },
        select: { content: true },
      });
      const told = turns.at(-1)?.content ?? '';
      assert.match(told, /失败分类：CHECK_TIMED_OUT/);
      assert.match(told, /这是这项任务的第 2 代落地，由协调会话要求重跑/);
      assert.ok(told.includes(REASON), `the message does not carry the rerun's reason — ${told}`);
      assert.match(told, /不要再原样重跑/);
      assert.match(told, /integration_retry/);
      assert.match(told, /task_start 只会再跑一遍任务、开一条新分支，不会重新排这次落地/);

      // And it can decide again: a third generation, rerunning the second.
      const third = await retry(stack, w, task.taskId, 'the runner was overloaded; the check now has the machine to itself');
      assert.equal(third.generation, 3);
      assert.equal(third.retryOfJobId, retried.jobId);
      assert.equal(third.failureClass, 'CHECK_TIMED_OUT');
      assert.deepEqual(third.handlingItemIds, [second.id]);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the rerun lands the branch the task\'s work ended on, not the one the failed generation was handed',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-moved');
      const { task } = await failedLanding(stack, w, 'retry-moved');
      // The task was run again after its landing failed — on a new branch, as task_start does — and
      // that later session is where its work now is.
      const later = randomUUID();
      const branch = `orbit/retry-moved-later-${randomUUID().slice(0, 6)}`;
      await stack.db.session.create({
        data: {
          id: later,
          ownerId: w.ownerId,
          creatorId: w.ownerId,
          taskId: task.taskId,
          workspaceId: w.workspaceId,
          assignedRunnerId: w.runnerId,
          title: 'the second run',
          prompt: 'the second run',
          provider: 'claude',
          status: RunStatus.SUCCEEDED,
          dispatchOrigin: SessionDispatchOrigin.USER,
          startsTaskWork: true,
          startedAt: new Date(),
          finishedAt: new Date(),
          branch,
          worktreeBranch: branch,
          isolationStatus: 'worktree',
          baseSha: 'b'.repeat(40),
          changedFiles: [{ path: 'src/runner-go/claude_runtime.go', additions: 3, deletions: 1 }],
        },
      });
      const retried = await retry(stack, w, task.taskId, 'the work moved to the second run\'s branch, which passed in full');
      assert.equal(retried.sourceRef, `refs/heads/${branch}`);
      const [, second] = await landings(stack.db, task.taskId);
      assert.equal(second?.sessionId, later);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('CHECK_TIMED_OUT and ERROR are rerun, a CONFLICT is not',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const timedOut = await world(stack, 'retry-timed-out');
      const slow = await failedLanding(stack, timedOut, 'retry-timed-out', TIMED_OUT_CHECK);
      const slowRetry = await retry(stack, timedOut, slow.task.taskId, 'the check ran out of its hour on a loaded runner');
      assert.equal(slowRetry.failureClass, 'CHECK_TIMED_OUT');
      assert.equal((await landings(stack.db, slow.task.taskId))[1]?.retryFailureClass, 'CHECK_TIMED_OUT');

      const errored = await world(stack, 'retry-error');
      const broken = await failedLanding(stack, errored, 'retry-error', MACHINERY_ERROR);
      const [errorItem] = await itemsOf(stack.db, broken.task.taskId);
      assert.equal(errorItem?.payload.failureClass, 'ERROR');
      const brokenRetry = await retry(stack, errored, broken.task.taskId, 'the push was rejected by a race; the remote is quiet now');
      assert.equal(brokenRetry.failureClass, 'ERROR');
      assert.equal(brokenRetry.generation, 2);

      const conflicted = await world(stack, 'retry-conflict');
      const clash = await failedLanding(stack, conflicted, 'retry-conflict', CONFLICTED);
      const [conflictItem] = await itemsOf(stack.db, clash.task.taskId);
      assert.equal(conflictItem?.payload.failureClass, 'CONFLICT');
      const refused = await denied(() => retry(stack, conflicted, clash.task.taskId, 'try again'));
      assert.equal(refused.status, 409);
      assert.equal(refused.code, 'INTEGRATION_RETRY_NOT_APPLICABLE');
      assert.match(refused.message, /CONFLICT/);
      assert.match(refused.message, /task_reopen/);
      assert.equal((await landings(stack.db, clash.task.taskId)).length, 1, 'nothing queued for a conflict');
      const [stillOpen] = await itemsOf(stack.db, clash.task.taskId);
      assert.equal(stillOpen?.state, 'OPEN', 'and its item is left for the decision it needs');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a MAIN_SYNC conflict is refused as well, and the refusal sends the absorb to the project line',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // §3.1 M3, read off the phase the job row recorded: the line conflicted absorbing the upstream,
      // so the same source run again conflicts in the same place, and the task's own work is not
      // what to change. What resolves it is a source branch that carries the absorb.
      const w = await world(stack, 'retry-main-sync');
      const clash = await failedLanding(stack, w, 'retry-main-sync', { ...CONFLICTED, phase: 'MAIN_SYNC' });
      const refused = await denied(() => retry(stack, w, clash.task.taskId, 'the ledger conflict is resolved'));
      assert.equal(refused.status, 409);
      assert.equal(refused.code, 'INTEGRATION_RETRY_NOT_APPLICABLE');
      assert.match(refused.message, /stopped at MAIN_SYNC/);
      assert.match(refused.message, /Absorb the upstream on the project line first/);
      assert.match(refused.message, /lands by J-S4 MERGE/);
      assert.equal((await landings(stack.db, clash.task.taskId)).length, 1, 'nothing queued for a conflict');
      const [stillOpen] = await itemsOf(stack.db, clash.task.taskId);
      assert.equal(stillOpen?.state, 'OPEN', 'and its item is left for the decision it needs');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the coordinator closed the item by hand: an Automatic project still reruns the landing (the state ③ was left in)',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-hand-closed');
      const { task, job } = await failedLanding(stack, w, 'retry-hand-closed');
      const [item] = await itemsOf(stack.db, task.taskId);
      await stack.openItems.resolveOpenItem(w.ownerId, w.projectId, item!.id, {
        note: 'the baseline is being repaired by another task; this landing is rerun once it is',
      }, { kind: 'SESSION', sessionId: w.coordinatorSessionId });
      assert.equal((await itemsOf(stack.db, task.taskId))[0]?.resolution, 'HANDLED');

      const retried = await retry(stack, w, task.taskId, REASON);
      assert.equal(retried.generation, 2);
      assert.equal(retried.retryOfJobId, job.jobId);
      assert.deepEqual(retried.handlingItemIds, [], 'nothing was open to handle');
      assert.equal((await itemsOf(stack.db, task.taskId))[0]?.resolutionNote,
        'the baseline is being repaired by another task; this landing is rerun once it is',
        'a closed item keeps the ending it got');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('not Automatic: the failure is the owner\'s and the coordinator is refused — until the owner hands it back',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-manual', false);
      const { task } = await failedLanding(stack, w, 'retry-manual');
      const [item] = await itemsOf(stack.db, task.taskId);
      assert.equal(item?.assignee, 'OWNER', 'without the switch a failed landing is the owner\'s from birth');
      assert.equal(item?.assigneeReason, 'NO_COORDINATOR');

      const refused = await denied(() => retry(stack, w, task.taskId, REASON));
      assert.equal(refused.status, 409);
      assert.equal(refused.code, 'INTEGRATION_RETRY_OWNER_ITEM');
      assert.match(refused.message, /NO_COORDINATOR/);
      assert.equal((await landings(stack.db, task.taskId)).length, 1, 'nothing queued');

      // The owner's own press puts the item in front of the coordinator, and with it the decision.
      await stack.openItems.returnToCoordinator(w.ownerId, w.projectId, item!.id);
      const retried = await retry(stack, w, task.taskId, REASON);
      assert.equal(retried.generation, 2);
      assert.deepEqual(retried.handlingItemIds, [item!.id]);

      // And a failure nobody handed over, in a project that is not Automatic, stays the owner's even
      // once its item is closed: the switch is the only standing grant, and it is off.
      const quiet = await world(stack, 'retry-manual-closed', false);
      const other = await failedLanding(stack, quiet, 'retry-manual-closed');
      const [otherItem] = await itemsOf(stack.db, other.task.taskId);
      await stack.openItems.resolveOpenItem(quiet.ownerId, quiet.projectId, otherItem!.id, {
        note: 'looked at it; leaving it for later',
      }, { kind: 'OWNER' });
      const manual = await denied(() => retry(stack, quiet, other.task.taskId, REASON));
      assert.equal(manual.status, 403);
      assert.equal(manual.code, 'INTEGRATION_RETRY_NOT_AUTOMATIC');
      assert.equal((await landings(stack.db, other.task.taskId)).length, 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('escalated: a failure that went to the owner on the clock is theirs, and the coordinator is refused',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-escalated');
      const { task } = await failedLanding(stack, w, 'retry-escalated');
      const [item] = await itemsOf(stack.db, task.taskId);
      await stack.db.$executeRaw(
        Prisma.sql`UPDATE "project_open_item" SET "escalate_at" = now() - interval '1 minute'
                    WHERE "id" = ${item!.id}::uuid`,
      );
      const swept = await new ProjectOpenItemEscalationService(stack.db as unknown as PrismaService).sweep();
      assert.deepEqual(swept.map((row) => row.itemId), [item!.id]);

      const refused = await denied(() => retry(stack, w, task.taskId, REASON));
      assert.equal(refused.status, 409);
      assert.equal(refused.code, 'INTEGRATION_RETRY_OWNER_ITEM');
      assert.match(refused.message, /ESCALATED/);
      assert.equal((await landings(stack.db, task.taskId)).length, 1, 'nothing queued');
      const [after] = await itemsOf(stack.db, task.taskId);
      assert.equal(after?.state, 'OPEN', 'the owner\'s item is left exactly as it was');
      assert.equal(after?.assignee, 'OWNER');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an open blocker waiting on the owner about the task refuses the rerun',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-blocked');
      const { task } = await failedLanding(stack, w, 'retry-blocked');
      const at = new Date();
      await stack.db.projectBlocker.create({
        data: {
          projectId: w.projectId,
          kind: 'AWAITING_USER_APPROVAL',
          owner: 'USER',
          recovery: 'HUMAN',
          severity: 'CRITICAL',
          requiredAction: 'decide whether the files outside the declaration belong to the work',
          nextCheckAt: at,
          subjectType: 'TASK',
          subjectId: task.taskId,
          detail: { reason: 'OUTSIDE_DECLARED_SCOPE' },
          dedupeKey: `AWAITING_USER_APPROVAL:OUTSIDE_DECLARED_SCOPE:${task.taskId}`,
          lifecycleGeneration: 1n,
          conditionVersion: 'c'.repeat(64),
          firstSeenAt: at,
          lastSeenAt: at,
        },
      });
      const refused = await denied(() => retry(stack, w, task.taskId, REASON));
      assert.equal(refused.status, 409);
      assert.equal(refused.code, 'INTEGRATION_RETRY_OWNER_BLOCKER');
      assert.equal((await landings(stack.db, task.taskId)).length, 1, 'nothing queued');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('only the project\'s coordinator: the task\'s own session, another project\'s coordinator and no session at all are refused',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-who');
      const { task } = await failedLanding(stack, w, 'retry-who');
      const elsewhere = await world(stack, 'retry-who-elsewhere');
      for (const [who, sessionId] of [
        ['the task\'s own session', task.sessionId],
        ['another project\'s coordinator', elsewhere.coordinatorSessionId],
        ['no session at all', ''],
      ] as const) {
        const refused = await denied(() => retry(stack, w, task.taskId, REASON, sessionId));
        assert.equal(refused.status, 403, who);
        assert.equal(refused.code, 'INTEGRATION_RETRY_COORDINATOR_ONLY', who);
      }
      assert.equal((await landings(stack.db, task.taskId)).length, 1, 'nothing queued by any of them');
      assert.equal((await itemsOf(stack.db, task.taskId))[0]?.state, 'OPEN', 'and the item is untouched');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a reason is required: empty, blank and over-long reasons write nothing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-reason');
      const { task } = await failedLanding(stack, w, 'retry-reason');
      for (const reason of ['', '   \n\t ', 'x'.repeat(2_001)]) {
        const refused = await denied(() => retry(stack, w, task.taskId, reason));
        assert.equal(refused.status, 400, JSON.stringify(reason.slice(0, 8)));
        assert.equal(refused.code, 'INTEGRATION_RETRY_REASON_REQUIRED');
      }
      assert.equal((await landings(stack.db, task.taskId)).length, 1);
      assert.equal((await itemsOf(stack.db, task.taskId))[0]?.state, 'OPEN');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('owner task retry records a USER requester, creates one generation, and deduplicates concurrent presses',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'owner-task-dedupe', false);
      const { task } = await failedLanding(stack, w, 'owner-task-dedupe');
      const [item] = await itemsOf(stack.db, task.taskId);
      assert.equal(item?.assignee, 'OWNER');

      const raced = await Promise.allSettled([
        ownerRetry(stack, w, task.taskId, 'the owner repaired the integration baseline'),
        ownerRetry(stack, w, task.taskId, 'the owner pressed twice'),
      ]);
      assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
      const loser = raced.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      assert.ok(loser?.reason instanceof HttpException);
      assert.equal((loser!.reason as HttpException).getStatus(), 409);
      assert.equal(((loser!.reason as HttpException).getResponse() as { code: string }).code,
        'INTEGRATION_RETRY_IN_FLIGHT');

      const rows = await landings(stack.db, task.taskId);
      assert.deepEqual(rows.map((row) => [row.generation, row.state]),
        [[1, 'CHECK_FAILED'], [2, 'QUEUED']], 'the two presses made one new generation');
      const second = rows[1]!;
      assert.equal(second.retryRequestedByUserId, w.ownerId);
      assert.equal(second.retryRequestedBySessionId, null);
      const [handling] = await itemsOf(stack.db, task.taskId);
      assert.equal(handling?.handlingJobId, second.id);
      assert.equal(handling?.handlingSessionId, null);
      assert.equal(handling?.handlingUserId, w.ownerId);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('owner task retry resolves as USER, or supersedes as USER with the next item still owned by the owner',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const successWorld = await world(stack, 'owner-task-handled', false);
      const success = await failedLanding(stack, successWorld, 'owner-task-handled');
      const retried = await ownerRetry(stack, successWorld, success.task.taskId, REASON);
      const [rerun] = await claim(stack, successWorld, 'owner-task-handled-rerun');
      assert.equal(rerun?.jobId, retried.jobId);
      await report(stack, successWorld, rerun!, LANDED);
      const [handled] = await itemsOf(stack.db, success.task.taskId);
      assert.equal(handled?.state, 'RESOLVED');
      assert.equal(handled?.resolution, 'HANDLED');
      assert.equal(handled?.resolvedBy, 'USER');
      assert.equal(handled?.resolvedByUserId, successWorld.ownerId);
      assert.equal(handled?.resolvedBySessionId, null);

      const retryWorld = await world(stack, 'owner-task-retried', false);
      const failed = await failedLanding(stack, retryWorld, 'owner-task-retried');
      const ownerRun = await ownerRetry(stack, retryWorld, failed.task.taskId, REASON);
      const [ownerJob] = await claim(stack, retryWorld, 'owner-task-retried-rerun');
      assert.equal(ownerJob?.jobId, ownerRun.jobId);
      const answer = await report(stack, retryWorld, ownerJob!, TIMED_OUT_CHECK);
      assert.equal(answer.accepted, true);
      const all = await itemsOf(stack.db, failed.task.taskId);
      const old = all.find((item) => item.handlingJobId === ownerJob!.jobId)!;
      const next = all.find((item) => item.id === answer.openItemId)!;
      assert.equal(old.state, 'SUPERSEDED');
      assert.equal(old.resolution, 'RETRIED');
      assert.equal(old.resolvedBy, 'USER');
      assert.equal(old.resolvedByUserId, retryWorld.ownerId);
      assert.equal(old.resolvedBySessionId, null);
      assert.equal(old.supersededByItemId, next.id);
      assert.equal(next.assignee, 'OWNER');
      assert.equal(next.payload.retry?.requestedByUserId, retryWorld.ownerId);
      assert.equal(next.payload.retry?.requestedBySessionId, null);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('owner task retry uses the shared refusal codes',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const reasonWorld = await world(stack, 'owner-refuse-reason', false);
      const reasonFailure = await failedLanding(stack, reasonWorld, 'owner-refuse-reason');
      const blank = await denied(() => ownerRetry(stack, reasonWorld, reasonFailure.task.taskId, '  '));
      assert.equal(blank.status, 400);
      assert.equal(blank.code, 'INTEGRATION_RETRY_REASON_REQUIRED');

      const wrongProjectId = randomUUID();
      await stack.db.project.create({
        data: { id: wrongProjectId, ownerId: reasonWorld.ownerId, title: 'another owner project', coordinatorEnabled: false },
      });
      const foreign = await stack.tasks.create(reasonWorld.ownerId, {
        title: 'another project\'s task',
        assigneeId: reasonWorld.workspaceId,
        projectId: wrongProjectId,
      });
      const wrong = await denied(() => ownerRetry(stack, reasonWorld, foreign.id, REASON));
      assert.equal(wrong.status, 403);
      assert.equal(wrong.code, 'INTEGRATION_RETRY_NOT_THIS_PROJECT');

      const ownerOnlyWorld = await world(stack, 'owner-refuse-owner-only', true);
      const ownerOnlyFailure = await failedLanding(stack, ownerOnlyWorld, 'owner-refuse-owner-only');
      const ownerItem = (await itemsOf(stack.db, ownerOnlyFailure.task.taskId))[0]!;
      const ownerOnly = await denied(() => ownerRetry(stack, ownerOnlyWorld, ownerOnlyFailure.task.taskId, REASON));
      assert.equal(ownerOnly.status, 403);
      assert.equal(ownerOnly.code, 'INTEGRATION_RETRY_OWNER_ONLY');
      assert.equal(ownerItem.assignee, 'COORDINATOR');

      const blockerWorld = await world(stack, 'owner-refuse-blocker', false);
      const blockerFailure = await failedLanding(stack, blockerWorld, 'owner-refuse-blocker');
      const now = new Date();
      await stack.db.projectBlocker.create({
        data: {
          projectId: blockerWorld.projectId,
          kind: 'AWAITING_USER_APPROVAL',
          owner: 'USER',
          recovery: 'HUMAN',
          severity: 'CRITICAL',
          requiredAction: 'decide',
          nextCheckAt: now,
          subjectType: 'TASK',
          subjectId: blockerFailure.task.taskId,
          detail: { reason: 'OWNER_RETRY_TEST' },
          dedupeKey: `OWNER_RETRY_TEST:${blockerFailure.task.taskId}`,
          lifecycleGeneration: 1n,
          conditionVersion: 'c'.repeat(64),
          firstSeenAt: now,
          lastSeenAt: now,
        },
      });
      const blocker = await denied(() => ownerRetry(stack, blockerWorld, blockerFailure.task.taskId, REASON));
      assert.equal(blocker.status, 409);
      assert.equal(blocker.code, 'INTEGRATION_RETRY_OWNER_BLOCKER');

      const conflictWorld = await world(stack, 'owner-refuse-conflict', false);
      const conflict = await failedLanding(stack, conflictWorld, 'owner-refuse-conflict', CONFLICTED);
      const conflictRefusal = await denied(() => ownerRetry(stack, conflictWorld, conflict.task.taskId, REASON));
      assert.equal(conflictRefusal.status, 409);
      assert.equal(conflictRefusal.code, 'INTEGRATION_RETRY_NOT_APPLICABLE');

      const flightWorld = await world(stack, 'owner-refuse-flight', false);
      const flight = await failedLanding(stack, flightWorld, 'owner-refuse-flight');
      await ownerRetry(stack, flightWorld, flight.task.taskId, REASON);
      const inFlight = await denied(() => ownerRetry(stack, flightWorld, flight.task.taskId, REASON));
      assert.equal(inFlight.status, 409);
      assert.equal(inFlight.code, 'INTEGRATION_RETRY_IN_FLIGHT');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('owner promotion recheck records USER and a READY result is automatically merged',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'owner-promotion-ready', true);
      await stack.db.runner.update({ where: { id: w.runnerId }, data: { capabilities: [INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND] } });
      const { promotionId } = await failedPromotion(stack, w, 'owner-promotion-ready');
      const [item] = await stack.db.projectOpenItem.findMany({
        where: { promotionId, state: 'OPEN' },
        orderBy: { createdAt: 'asc' },
      });
      assert.equal(item?.assignee, 'COORDINATOR');
      // Model the escalation clock handing the card to its owner while the check is blocked.
      await stack.db.projectOpenItem.update({
        where: { id: item!.id },
        data: { assignee: 'OWNER', assigneeReason: 'ESCALATED', assignedAt: new Date(), escalatedAt: new Date() },
      });
      const retried = await ownerPromotionRetry(stack, w, promotionId, REASON);
      const job = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: retried.jobId } });
      assert.equal(job.generation, 2);
      assert.equal(job.retryRequestedByUserId, w.ownerId);
      assert.equal(job.retryRequestedBySessionId, null);
      const handling = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item!.id } });
      assert.equal(handling.handlingJobId, retried.jobId);
      assert.equal(handling.handlingUserId, w.ownerId);
      assert.equal(handling.handlingSessionId, null);

      const [check] = await claim(stack, w, 'owner-promotion-ready-rerun');
      assert.equal(check?.jobId, retried.jobId);
      await report(stack, w, check!, {
        state: 'READY',
        phase: 'CHECK',
        sourceSha: 'd'.repeat(40),
        targetShaBefore: 'f'.repeat(40),
        upstreamSha: 'f'.repeat(40),
        testedSha: '2'.repeat(40),
        testedTreeSha: '3'.repeat(40),
        checks: [GREEN_MERGE_CHECK],
        conflicts: [],
      });
      const promotionAfterCheck = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: promotionId } });
      assert.equal(promotionAfterCheck.state, 'CONFIRMED');
      assert.equal(promotionAfterCheck.confirmedAutomatically, true);
      const closed = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item!.id } });
      assert.equal(closed.state, 'RESOLVED');
      assert.equal(closed.resolution, 'HANDLED');
      assert.equal(closed.resolvedBy, 'USER');
      assert.equal(closed.resolvedByUserId, w.ownerId);

      const [land] = await claim(stack, w, 'owner-promotion-ready-land', [PROMOTION_AUTOMATIC_LAND]);
      assert.equal(land?.kind, 'LAND_PROMOTION');
      await report(stack, w, land!, {
        state: 'LANDED',
        phase: 'PUSH',
        sourceSha: 'd'.repeat(40),
        targetShaBefore: 'f'.repeat(40),
        upstreamSha: 'f'.repeat(40),
        testedSha: '2'.repeat(40),
        testedTreeSha: '3'.repeat(40),
        landedSha: '4'.repeat(40),
        landedTreeSha: '3'.repeat(40),
        aheadOfUpstream: 1,
        checks: [GREEN_MERGE_CHECK],
        conflicts: [],
      });
      assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: promotionId } })).state, 'MERGED');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a task of another project is refused, as is one that is not DONE, one that landed, and one with no landing at all',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-state');
      // Another project of the same owner, whose failed landing the first project's coordinator
      // names under its own project.
      const otherProjectId = randomUUID();
      await stack.db.project.create({
        data: { id: otherProjectId, ownerId: w.ownerId, title: 'another goal', coordinatorEnabled: true },
      });
      const foreign = await stack.tasks.create(w.ownerId, {
        title: 'another project\'s task',
        assigneeId: w.workspaceId,
        projectId: otherProjectId,
      });
      const crossing = await denied(() => retry(stack, w, foreign.id, REASON));
      assert.equal(crossing.status, 403);
      assert.equal(crossing.code, 'INTEGRATION_RETRY_NOT_THIS_PROJECT');
      const missing = await denied(() => retry(stack, w, randomUUID(), REASON));
      assert.equal(missing.status, 404);

      // A task that was put back to work is not a finished delivery to land again.
      const reworked = await failedLanding(stack, w, 'retry-state-reworked');
      await stack.tasks.update(w.ownerId, reworked.task.taskId, { status: DeclaredTaskStatus.IN_PROGRESS });
      const notDone = await denied(() => retry(stack, w, reworked.task.taskId, REASON));
      assert.equal(notDone.status, 409);
      assert.equal(notDone.code, 'INTEGRATION_RETRY_NOT_APPLICABLE');
      assert.match(notDone.message, /not DONE/);

      // A landing that happened has nothing to rerun.
      const landed = await doneTask(stack, w, 'retry-state-landed');
      const [handed] = await claim(stack, w, 'lease-retry-state-landed');
      await report(stack, w, handed!, LANDED);
      const already = await denied(() => retry(stack, w, landed.taskId, REASON));
      assert.equal(already.status, 409);
      assert.equal(already.code, 'INTEGRATION_RETRY_NOT_APPLICABLE');
      assert.match(already.message, /LANDED/);

      // And a DONE task the line never had a landing of: its work took no worktree, so its DONE
      // queued nothing.
      const never = await doneTask(stack, w, 'retry-state-never', false);
      assert.equal((await landings(stack.db, never.taskId)).length, 0);
      const none = await denied(() => retry(stack, w, never.taskId, REASON));
      assert.equal(none.status, 409);
      assert.equal(none.code, 'INTEGRATION_RETRY_NOT_APPLICABLE');
      assert.match(none.message, /never had a landing/);
      assert.deepEqual(
        await Promise.all([foreign.id, reworked.task.taskId, landed.taskId, never.taskId]
          .map(async (id) => (await landings(stack.db, id)).length)),
        [0, 1, 1, 0],
        'none of these refusals queued anything',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the integration-retry PostgreSQL target is explicitly disposable', { skip }, () => {
  assert.doesNotThrow(() => assertCoordinatorPgUrlIsIsolated(URL));
});
