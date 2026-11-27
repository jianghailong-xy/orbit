/**
 * The line-sync item (docs/design/project-line-upstream-sync.md, agreed by the owner 2026-11-24: D1 the platform
 * syncs main inside each landing, D2 queued landings wait behind the item and go in order, D3 the coordinator files
 * one sync task from it). Project 34xLkkpjrrFbUzGhsgy7f, criterion 7Q2BNgzITOqOjHdj6oVzME: a project branch absorbs
 * new upstream commits without reopening an already-DONE task, and a conflict reaches the coordinator as an item
 * that does not require reworking a finished task.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/line-sync-hold.pg.spec.ts
 *
 * Every case runs over the product's own doors: a DONE task's landing queued by its DONE, claimed off the
 * heartbeat, and reported by the runner's result route; the coordinator's retry and hand-close doors; the
 * blocked-line sweep. The git half (the sync task's branch lands by MERGE, and the held landing then lands
 * unchanged) is runner-go's TestIntegrationHeldLandingLandsAfterSyncTask (R1).
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  Prisma,
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';
import {
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  RunEventType,
  RunStatus as SharedRunStatus,
  uuidToBase62,
} from '@orbit/shared';
import { HttpException } from '@nestjs/common';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { withWord, WORD_SELECT } from '../test-support/session-word';
import { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { seedPromotionRequest } from '../test-support/promotion-request';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { lineSyncDedupeKey } from './line-sync-hold';
import { doorsForOpenItem } from './open-item-doors';
import { INTEGRATION_JOB_CLAIM, settleDeliveredIdentityAfterFinish } from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectIntegrationRetryController } from './project-integration-retry.controller';
import { LINE_BLOCKED_THRESHOLD_MS, lineBlockedOwnerKey } from './project-line-blocked';
import { ProjectLineBlockedService } from './project-line-blocked.service';
import { openItemMessage, recordIntegrationFailure } from './project-open-item';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { readTaskIntegrationViews } from './project-task-integration';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { TaskRunStoppedProducer } from './task-run-stopped.producer';
import { WakeDispositionService } from './wake-disposition.service';
import '../test-support/dequeue-under-lease';

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
  promotions: ProjectPromotionService;
  lineBlocked: ProjectLineBlockedService;
  pushed: Array<{ ownerId: string; projectId: string; title: string; body: string }>;
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
  const pushed: Stack['pushed'] = [];
  const delivery = new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions);
  const lineBlocked = new ProjectLineBlockedService(
    prisma, new TaskRunStoppedProducer(prisma, convergence, delivery), delivery,
    { notifyProjectOrphan: async (input: Stack['pushed'][number]) => { pushed.push(input); } } as unknown as PushService,
  );
  return {
    db, sessions, tasks, api, jobs, openItems, ownerRetry, promotions: new ProjectPromotionService(prisma), lineBlocked, pushed,
  };
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
      turnState: null,
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
      turnState: 'IN_FLIGHT',
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
  // W4 false on purpose (§12.3 condition 1): every case in this file is about the coordinator's and the
  // owner's doors to a failed landing, so its failure must go to the coordinator as before revision 42.
  // A person ends the work session while its acceptance command runs; the command passes and writes DONE,
  // but the session ended with `end_reason = 'ended'`, not with its task's DONE, so it is never handed the
  // failure. Left to its DONE's own end (`task_done`), the failure would be the session's (W-T1 — the
  // landing-fix specs' cases).
  await stack.sessions.end(w.ownerId, sessionId);
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId: acceptance!.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  assert.equal(await taskStatus(stack.db, declared.id), TaskStatus.DONE, 'the acceptance command agreed');
  assert.equal(
    (await stack.db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { endReason: true } })).endReason,
    'ended', 'CONTROL: the work session is one a person ended, which W4 does not hand a failure',
  );
  // The runner commits the worktree when it FINISHES the session (SR13), and a landing is not handed
  // over before that (J-T1a): what the queue reads is the finish and where HEAD ended.
  await stack.db.$transaction(async (tx) => {
    // The finish settles the DONE's delivered identity in the transaction that writes it, as every
    // finish door does — and decides the route a DONE written while this work moved left to it
    // (§10.5 O-L4 3, §12.15 P-M1).
    const finished = await tx.session.update({
      where: { id: sessionId },
      data: worktree
        ? { turnState: null, finishedAt: new Date(), worktreeBranch: branch, worktreeDirty: false }
        : { turnState: null, finishedAt: new Date() },
      select: { id: true, ownerId: true, taskId: true, startsTaskWork: true },
    });
    await settleDeliveredIdentityAfterFinish(tx, finished);
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
async function report(stack: Stack, w: World, job: IntegrationJobCommand, result: Failure) {
  if (job.kind === 'LAND_TASK') await seedPromotionRequest(stack.db, w.projectId);
  return stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
}


const U = '1'.repeat(40);
const U2 = '2'.repeat(40);
const T0 = '3'.repeat(40);

/** J-S2 path ③: absorbing main into the line's tip conflicted, before the task's commits were looked at. */
function mainSyncConflict(upstreamSha = U, sourceSha = 'a'.repeat(40)): Failure {
  return {
    state: 'CONFLICT', phase: 'MAIN_SYNC', sourceSha, targetShaBefore: T0, upstreamSha,
    conflicts: ['src/apiserver/prisma/migrations/ledger.txt'],
  };
}

/** What a runner reports for a job that landed: one tree tested and landed, as J2 demands. */
const LANDED: Failure = {
  state: 'LANDED', phase: 'PUSH', sourceSha: 'a'.repeat(40), targetShaBefore: T0, upstreamSha: U,
  testedSha: 'd'.repeat(40), testedTreeSha: 'e'.repeat(40), landedSha: 'd'.repeat(40), landedTreeSha: 'e'.repeat(40),
  aheadOfUpstream: 1,
};

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
    /** §2.9 LS1: the landing session the attempt belongs to; null when the job had no subject. */
    landingSessionId?: string | null;
    /** The round the failed claim last reported; null when no report measured one. */
    round?: number | null;
    errorDetail?: Record<string, unknown> | null;
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


/** The status and the code a refusal carries. */
async function denied(run: () => Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
  const thrown = await run().then(() => null, (error: unknown) => error);
  assert.ok(thrown instanceof HttpException, `the door answered instead of refusing: ${JSON.stringify(thrown)}`);
  const body = thrown.getResponse();
  const shaped = typeof body === 'string' ? { message: body } : (body as { code?: string; message?: string });
  return { status: thrown.getStatus(), code: shaped.code, message: shaped.message ?? '' };
}

/** The task a claimed landing is about (the command names its job, not its task). */
async function taskOf(db: PrismaClient, job: IntegrationJobCommand | undefined): Promise<string | null> {
  if (!job) return null;
  return (await db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId }, select: { taskId: true } })).taskId;
}

/** The project's line-sync items, oldest first. */
function lineSyncItems(db: PrismaClient, projectId: string) {
  return db.projectOpenItem.findMany({
    where: { projectId, dedupeKey: { startsWith: 'IMS:' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/** What queued a job, as its ENQUEUED fact says. */
async function enqueueCause(db: PrismaClient, jobId: string): Promise<string | null> {
  const event = await db.projectIntegrationJobEvent.findFirst({ where: { jobId, kind: 'ENQUEUED' }, select: { data: true } });
  return ((event?.data ?? null) as { cause?: string } | null)?.cause ?? null;
}

/** The parts of a DONE task a reopen, a revival or a landing-fix hand-off would change. */
async function doneShape(db: PrismaClient, taskId: string, sessionId: string) {
  const task = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      status: true, deliveredSha: true, deliveredBranch: true, deliveredSessionId: true, deliveredAt: true,
      attemptGeneration: true, completionFenceRevision: true,
    },
  });
  // The session's word is the projector's over its facts (deploy D3, task T14).
  const session = withWord(await db.session.findUniqueOrThrow({
    where: { id: sessionId }, select: { ...WORD_SELECT, finishedAt: true, endReason: true },
  }), 'finishedAt', 'endReason');
  const reopened = await db.taskReopenIntent.count({ where: { taskId } });
  const sessions = await db.session.count({ where: { taskId } });
  return { task, session, reopened, sessions };
}

/** The coordinator's deliveries of an item, oldest first. */
function deliveries(db: PrismaClient, itemId: string) {
  return db.projectOpenItemDelivery.findMany({
    where: { itemId, purpose: 'ITEM' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { sessionId: true, clientTurnId: true },
  });
}

/** A DONE task filed as the line-sync item's sync task (`task_create` with fixesOpenItemId). */
async function syncTask(stack: Stack, w: World, itemId: string, label: string): Promise<Attempt> {
  const sync = await doneTask(stack, w, label);
  await stack.db.task.update({ where: { id: sync.taskId }, data: { fixesOpenItemId: itemId } });
  return sync;
}

test('P1: main moves and conflicts — one task-less line-sync item for the coordinator, the DONE task untouched and held, '
  + 'a sync task resolves it, and every held landing goes in order',
{ skip, timeout: 300_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'line-sync-p1');
    const x = await doneTask(stack, w, 'p1-x');
    const y = await doneTask(stack, w, 'p1-y');
    const before = await doneShape(stack.db, x.taskId, x.sessionId);
    assert.equal(before.task.status, TaskStatus.DONE);

    const [xLanding] = await claim(stack, w, 'p1-x');
    assert.equal(await taskOf(stack.db, xLanding), x.taskId, 'X landed first, in DONE order');
    const answer = await report(stack, w, xLanding!, mainSyncConflict());
    assert.equal(answer.accepted, true);

    // 1. Exactly one OPEN line-sync item: about the line, no task, the coordinator's, delivered to it.
    const serialKey = (await stack.db.projectIntegrationJob.findUniqueOrThrow({
      where: { id: xLanding!.jobId }, select: { serialKey: true },
    })).serialKey;
    const items = await lineSyncItems(stack.db, w.projectId);
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.state, 'OPEN');
    assert.equal(item.kind, 'INTEGRATION_CONFLICT');
    assert.equal(item.taskId, null, 'the line-sync item names no task');
    assert.equal(item.dedupeKey, lineSyncDedupeKey(serialKey));
    assert.equal(item.assignee, 'COORDINATOR');
    assert.equal(item.workSessionId, null, 'no task work session was offered the conflict');
    assert.equal(answer.openItemId, item.id);
    const payload = item.payload as { subject?: string; heldTaskIds?: string[]; attempts?: unknown[]; upstreamSha?: string };
    assert.equal(payload.subject, 'LINE');
    assert.deepEqual(payload.heldTaskIds, [x.taskId]);
    assert.equal(payload.attempts?.length, 1);
    assert.equal(payload.upstreamSha, U);
    const delivered = await deliveries(stack.db, item.id);
    assert.equal(delivered.length, 1, 'delivered to the coordinator once');
    assert.equal(delivered[0]!.sessionId, w.coordinatorSessionId);
    assert.equal((await itemsOf(stack.db, x.taskId)).length, 0, 'no item is filed as X\'s failure');

    // 2. X is still DONE and untouched: same delivered identity, generation and fence; its session not revived,
    //    no landing-fix turn, no reopen.
    assert.deepEqual(await doneShape(stack.db, x.taskId, x.sessionId), before);

    // 3. X's next generation is QUEUED with cause MAIN_SYNC_HELD; Y's landing is QUEUED; neither is claimed, and both
    //    read WAITING_MAIN_SYNC naming the item.
    const xJobs = await landings(stack.db, x.taskId);
    assert.deepEqual(xJobs.map((job) => [job.generation, job.state]), [[1, 'CONFLICT'], [2, 'QUEUED']]);
    assert.equal(await enqueueCause(stack.db, xJobs[1]!.id), 'MAIN_SYNC_HELD');
    assert.equal(xJobs[1]!.sourceRef, xJobs[0]!.sourceRef, 'the same delivery is queued again');
    assert.deepEqual((await landings(stack.db, y.taskId)).map((job) => job.state), ['QUEUED']);
    assert.equal((await claim(stack, w, 'p1-held')).length, 0, 'the line is held: nothing is claimed');
    const views = await readTaskIntegrationViews(stack.db as unknown as PrismaService, w.ownerId, w.projectId,
      [x.taskId, y.taskId]);
    for (const taskId of [x.taskId, y.taskId]) {
      const view = views.get(taskId)!;
      assert.equal(view.state, 'QUEUED', 'held, not failed');
      assert.equal(view.landTask?.blockingReason?.code, 'WAITING_MAIN_SYNC');
      assert.equal(view.landTask?.blockingReason?.openItemId, item.id);
    }

    // 4. The item's doors touch no task, and its message says so; integration_retry on X answers IN_FLIGHT naming it.
    const doors = doorsForOpenItem({ kind: item.kind, assignee: item.assignee, taskId: item.taskId, payload: item.payload });
    const names = doors.map((door) => door.name);
    for (const forbidden of ['task_reopen', 'task_comment', 'integration_retry', 'task_update']) {
      assert.ok(!names.includes(forbidden), `the line-sync cell holds ${forbidden}`);
    }
    assert.ok(doors.some((door) => door.id === 'task-create-line-sync' && door.resolving));
    const message = openItemMessage({ ...item, landedFixes: [], workSession: false } as never);
    assert.match(message, /No task's work caused it, and no task needs reopening or rework/);
    assert.match(message, new RegExp(`fixesOpenItemId: ${uuidToBase62(item.id)}`));
    assert.doesNotMatch(message, /task_reopen|task_comment/);
    const refused = await denied(() => retry(stack, w, x.taskId, 'the ledger is resolved'));
    assert.equal(refused.status, 409);
    assert.equal(refused.code, 'INTEGRATION_RETRY_IN_FLIGHT');
    assert.ok(refused.message.includes(uuidToBase62(item.id)), refused.message);
    assert.match(refused.message, /goes ahead by itself/);
    assert.equal((await landings(stack.db, x.taskId)).length, 2, 'the refusal queued nothing');

    // 5. The coordinator files one sync task from the item. It alone is claimed despite the hold, and its LANDED
    //    closes the item, by the platform.
    const sync = await syncTask(stack, w, item.id, 'p1-sync');
    const [syncLanding] = await claim(stack, w, 'p1-sync');
    assert.equal(await taskOf(stack.db, syncLanding), sync.taskId, 'the sync task is let through the hold');
    await report(stack, w, syncLanding!, { ...LANDED, upstreamSha: U, targetShaBefore: T0 });
    const closed = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(closed.state, 'RESOLVED');
    assert.equal(closed.resolution, 'LANDED');
    assert.equal(closed.resolvedBy, 'PLATFORM');
    assert.equal(closed.resolvedByJobId, syncLanding!.jobId);

    // 6. The held landings are claimed in enqueue order (Y queued at its DONE, X's held generation after the
    //    conflict) and land. X is DONE throughout and reads landed on the line.
    const order: string[] = [];
    for (const lease of ['p1-next-1', 'p1-next-2']) {
      const [next] = await claim(stack, w, lease);
      assert.ok(next, 'a held landing was released');
      order.push((await taskOf(stack.db, next))!);
      await report(stack, w, next!, LANDED);
    }
    assert.deepEqual(order, [y.taskId, x.taskId]);
    const drained = await claim(stack, w, 'p1-drained');
    assert.deepEqual(drained.filter((job) => job.kind === 'LAND_TASK'), [], 'no landing is left (a promotion check may be)');
    const after = await doneShape(stack.db, x.taskId, x.sessionId);
    assert.equal(after.task.status, TaskStatus.DONE);
    assert.deepEqual({ ...after, task: { ...after.task } }, before, 'X was never reopened, revived or re-identified');
    const landedView = (await readTaskIntegrationViews(stack.db as unknown as PrismaService, w.ownerId, w.projectId,
      [x.taskId])).get(x.taskId)!;
    assert.equal(landedView.state, 'ON_INTEGRATION_LINE');
    assert.equal((await lineSyncItems(stack.db, w.projectId)).filter((row) => row.state === 'OPEN').length, 0);
  } finally {
    await stack.db.$disconnect();
  }
});

test('P2: the sync task\'s landing conflicts against a newer main — no second item, the attempt is added and the item '
  + 'delivered again, nothing is queued for the sync task, and nothing can be claimed',
{ skip, timeout: 300_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'line-sync-p2');
    const x = await doneTask(stack, w, 'p2-x');
    const [xLanding] = await claim(stack, w, 'p2-x');
    await report(stack, w, xLanding!, mainSyncConflict());
    const [item] = await lineSyncItems(stack.db, w.projectId);
    assert.ok(item);

    const sync = await syncTask(stack, w, item!.id, 'p2-sync');
    const [syncLanding] = await claim(stack, w, 'p2-sync');
    assert.equal(await taskOf(stack.db, syncLanding), sync.taskId);
    const syncSha = 'f'.repeat(40);
    await report(stack, w, syncLanding!, mainSyncConflict(U2, syncSha));

    const items = await lineSyncItems(stack.db, w.projectId);
    assert.equal(items.length, 1, 'never a second line-sync item');
    const again = items[0]!;
    assert.equal(again.id, item!.id);
    assert.equal(again.state, 'OPEN');
    const payload = again.payload as { heldTaskIds?: string[]; attempts?: Array<{ taskId?: string; sourceSha?: string }> };
    assert.deepEqual(payload.heldTaskIds, [x.taskId], 'the sync task is not held');
    assert.deepEqual(payload.attempts?.map((attempt) => attempt.taskId), [x.taskId, sync.taskId]);
    assert.ok(again.assignedAt.getTime() > item!.assignedAt.getTime(), 'delivered again under a new key');
    assert.equal(again.waitingSince.getTime(), item!.waitingSince.getTime(), 'the wait goes on from the first conflict');
    assert.equal(again.escalateAt?.getTime(), item!.escalateAt?.getTime());
    // One delivery row per item and conversation, moved to the new key (`open-item:v1:<id>:<assignedAtMs>`), and a
    // second turn queued on the coordinator under it.
    const [redelivered] = await deliveries(stack.db, item!.id);
    assert.ok(redelivered!.clientTurnId.endsWith(`:${again.assignedAt.getTime()}`), redelivered!.clientTurnId);
    assert.equal(await stack.db.conversationTurn.count({
      where: { sessionId: w.coordinatorSessionId, clientTurnId: { startsWith: `open-item:v1:${item!.id}:` } },
    }), 2, 'the coordinator was told twice: at the first conflict and at the sync task\'s');
    assert.deepEqual((await landings(stack.db, sync.taskId)).map((job) => job.state), ['CONFLICT'],
      'nothing is queued for the sync task: its branch cannot change without a new commit');
    assert.equal((await claim(stack, w, 'p2-held')).length, 0, 'nothing is claimable: no spin');
    assert.equal(await stack.db.task.findUniqueOrThrow({ where: { id: x.taskId }, select: { status: true } })
      .then((row) => row.status), TaskStatus.DONE);
    const message = openItemMessage({ ...again, landedFixes: [], workSession: false } as never);
    assert.match(message, new RegExp(`start the new one by merging ${syncSha.slice(0, 7)}`));
  } finally {
    await stack.db.$disconnect();
  }
});

test('P3: closing the item by hand releases the queue; a landing that still conflicts opens a new item, never two OPEN',
{ skip, timeout: 300_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'line-sync-p3');
    const x = await doneTask(stack, w, 'p3-x');
    const y = await doneTask(stack, w, 'p3-y');
    const [xLanding] = await claim(stack, w, 'p3-x');
    await report(stack, w, xLanding!, mainSyncConflict());
    const [item] = await lineSyncItems(stack.db, w.projectId);
    await stack.openItems.resolveOpenItem(w.ownerId, w.projectId, item!.id,
      { note: 'main is about to change the ledger itself' }, { kind: 'SESSION', sessionId: w.coordinatorSessionId });
    const handled = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item!.id } });
    assert.equal(handled.state, 'RESOLVED');
    assert.equal(handled.resolution, 'HANDLED');

    const [next] = await claim(stack, w, 'p3-next');
    assert.equal(await taskOf(stack.db, next), y.taskId, 'the queue moved, in enqueue order');
    await report(stack, w, next!, mainSyncConflict());
    const items = await lineSyncItems(stack.db, w.projectId);
    assert.equal(items.length, 2);
    assert.equal(items.filter((row) => row.state === 'OPEN').length, 1, 'one OPEN line-sync item per line');
    const reopened = items.find((row) => row.state === 'OPEN')!;
    assert.notEqual(reopened.id, item!.id);
    assert.deepEqual((reopened.payload as { heldTaskIds?: string[] }).heldTaskIds, [y.taskId]);
    // X's held generation and Y's are both waiting again; neither task was reopened.
    assert.equal((await claim(stack, w, 'p3-held')).length, 0);
    for (const taskId of [x.taskId, y.taskId]) {
      assert.equal((await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status, TaskStatus.DONE);
    }
  } finally {
    await stack.db.$disconnect();
  }
});

test('P4: a baseline item (K4) and a line-sync item open together — each lets only its own fix through, so nothing '
  + 'is claimed twice and nothing spins',
{ skip, timeout: 300_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'line-sync-p4');
    const a = await doneTask(stack, w, 'p4-a');
    const b = await doneTask(stack, w, 'p4-b');
    const [aLanding] = await claim(stack, w, 'p4-a');
    assert.equal(await taskOf(stack.db, aLanding), a.taskId);
    // K4 needs B through first: A's MAIN_SYNC conflict holds every landing, so B's baseline red is staged
    // by closing the line-sync item for a moment and reopening it after.
    await report(stack, w, aLanding!, mainSyncConflict());
    const [sync] = await lineSyncItems(stack.db, w.projectId);
    await stack.openItems.resolveOpenItem(w.ownerId, w.projectId, sync!.id, { note: 'stage K4' },
      { kind: 'SESSION', sessionId: w.coordinatorSessionId });
    const [bLanding] = await claim(stack, w, 'p4-b');
    assert.equal(await taskOf(stack.db, bLanding), b.taskId);
    await report(stack, w, bLanding!, {
      state: 'CHECK_FAILED', phase: 'CHECK', sourceSha: 'a'.repeat(40), targetShaBefore: T0, upstreamSha: U,
      testedSha: 'd'.repeat(40), testedTreeSha: 'e'.repeat(40), baselineRed: true,
      checks: [{
        name: 'MERGE_CHECK', scope: 'BASELINE', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false,
        durationMs: 1, outputTail: 'red on its own', treeSha: '9'.repeat(40),
      }],
    } as Failure);
    const baseline = await stack.db.projectOpenItem.findFirstOrThrow({
      where: { projectId: w.projectId, dedupeKey: { startsWith: 'ICB:' }, state: 'OPEN' },
    });
    // A's held generation is next in the queue; K4 holds it, so the line-sync item comes back from a fresh sync.
    const [aHeld] = await landings(stack.db, a.taskId).then((jobs) => jobs.filter((job) => job.state === 'QUEUED'));
    assert.ok(aHeld, 'A\'s held generation is queued');
    assert.equal((await claim(stack, w, 'p4-both-held')).length, 0, 'K4 holds A and B');
    // Reopen the line-sync item over the same failed job, as a later conflict would.
    await stack.db.projectOpenItem.create({
      data: {
        projectId: w.projectId, ownerId: w.ownerId, kind: 'INTEGRATION_CONFLICT', state: 'OPEN', assignee: 'COORDINATOR',
        assigneeReason: 'DEFAULT', taskId: null, integrationJobId: aLanding!.jobId, dedupeKey: sync!.dedupeKey,
        title: sync!.title, payload: sync!.payload as Prisma.InputJsonValue, waitingSince: new Date(), assignedAt: new Date(),
      },
    });
    const lineSync = (await lineSyncItems(stack.db, w.projectId)).find((row) => row.state === 'OPEN')!;
    const baselineFix = await syncTask(stack, w, baseline.id, 'p4-baseline-fix');
    const syncFix = await syncTask(stack, w, lineSync.id, 'p4-sync-fix');
    // Each fix is exempt from its own item's hold and held by the other's: nothing is claimed, so nothing is claimed
    // twice with the same source.
    assert.equal((await claim(stack, w, 'p4-cross-held')).length, 0, 'each hold holds the other item\'s fix');
    for (const fix of [baselineFix, syncFix]) {
      assert.deepEqual((await landings(stack.db, fix.taskId)).map((job) => job.state), ['QUEUED']);
    }
    // The coordinator gets out by closing one item: the line-sync item. The baseline fix lands, which closes K4.
    await stack.openItems.resolveOpenItem(w.ownerId, w.projectId, lineSync.id, { note: 'main fixes it' },
      { kind: 'SESSION', sessionId: w.coordinatorSessionId });
    const [first] = await claim(stack, w, 'p4-out');
    assert.equal(await taskOf(stack.db, first), baselineFix.taskId, 'only the baseline fix is let through K4');
    await report(stack, w, first!, LANDED);
    assert.equal((await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: baseline.id } })).state, 'RESOLVED');
  } finally {
    await stack.db.$disconnect();
  }
});

test('P5: a legacy task-level MAIN_SYNC item keeps its cell and doors, and the bridge queues its task\'s landing again '
  + 'once the line has main, which closes it — the task is never reopened',
{ skip, timeout: 300_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'line-sync-p5');
    const x = await doneTask(stack, w, 'p5-x');
    const y = await doneTask(stack, w, 'p5-y');
    // The item as the code before docs/design/project-line-upstream-sync.md filed it: X's landing ended CONFLICT at
    // MAIN_SYNC and the item names X. Written the way that code wrote it — the job's terminal state, then
    // recordIntegrationFailure with the task — because today's result route opens the line-sync item instead.
    const [xLanding] = await claim(stack, w, 'p5-x');
    const legacyId = await stack.db.$transaction(async (tx) => {
      await tx.projectIntegrationJob.update({
        where: { id: xLanding!.jobId },
        data: { state: 'CONFLICT', phase: 'MAIN_SYNC', finishedAt: new Date() },
      });
      const opened = await recordIntegrationFailure(tx, {
        projectId: w.projectId, ownerId: w.ownerId, jobId: xLanding!.jobId, taskId: x.taskId, sessionId: x.sessionId,
        state: 'CONFLICT', title: `Merge conflict: ${x.title}`, dedupeKey: `IC:${xLanding!.jobId}`,
        payload: { jobKind: 'LAND_TASK', phase: 'MAIN_SYNC', failureClass: 'CONFLICT', files: ['ledger.txt'] },
      });
      return opened!.itemId;
    });
    const legacy = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: legacyId } });
    const legacyDoors = doorsForOpenItem({ kind: legacy.kind, assignee: legacy.assignee, taskId: legacy.taskId,
      payload: legacy.payload }).map((door) => door.name);
    assert.ok(legacyDoors.includes('task_reopen'), 'the legacy cell keeps its doors');
    assert.equal((await claim(stack, w, 'p5-held')).length, 0, 'the legacy item holds Y (old M2)');

    // A fix task filed against the legacy item lands (exempt as before). The bridge: that landing gives the line
    // main, so X's next landing is queued (MAIN_SYNC_HELD) — no reopen.
    const fix = await syncTask(stack, w, legacy.id, 'p5-fix');
    const [fixLanding] = await claim(stack, w, 'p5-fix');
    assert.equal(await taskOf(stack.db, fixLanding), fix.taskId);
    await report(stack, w, fixLanding!, LANDED);
    const xJobs = await landings(stack.db, x.taskId);
    assert.deepEqual(xJobs.map((job) => job.state), ['CONFLICT', 'QUEUED']);
    assert.equal(await enqueueCause(stack.db, xJobs[1]!.id), 'MAIN_SYNC_HELD');
    assert.equal(await stack.db.taskReopenIntent.count({ where: { taskId: x.taskId } }), 0);
    // X's own landing is exempt from its legacy item (§3.1 M3) and is claimed before Y; its LANDED closes the item.
    const [xAgain] = await claim(stack, w, 'p5-x-again');
    assert.equal(await taskOf(stack.db, xAgain), x.taskId);
    await report(stack, w, xAgain!, LANDED);
    const closed = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(closed.state, 'RESOLVED');
    assert.equal(closed.resolution, 'LANDED');
    const [yLanding] = await claim(stack, w, 'p5-y');
    assert.equal(await taskOf(stack.db, yLanding), y.taskId, 'the line moves again');
    assert.equal((await stack.db.task.findUniqueOrThrow({ where: { id: x.taskId } })).status, TaskStatus.DONE);
  } finally {
    await stack.db.$disconnect();
  }
});

test('T4 with a line-sync item: no sync task filed past the threshold tells the coordinator once, and the owner after '
  + 'exceptionEscalationSeconds; once a sync task is filed, its run is the one that must act',
{ skip, timeout: 300_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'line-sync-t4');
    const x = await doneTask(stack, w, 't4-x');
    const y = await doneTask(stack, w, 't4-y');
    const [xLanding] = await claim(stack, w, 't4-x');
    await report(stack, w, xLanding!, mainSyncConflict());
    const [item] = await lineSyncItems(stack.db, w.projectId);
    const opened = item!.waitingSince.getTime();
    const notices = () => stack.db.projectCoordinatorWake.findMany({
      where: { projectId: w.projectId, event: 'TASK_RUN_STOPPED', subjectVersion: { contains: `:line:${item!.id}:` } },
      select: { subjectId: true, detail: true },
    });

    // Inside the threshold: nothing.
    await stack.lineBlocked.tick(new Date(opened + LINE_BLOCKED_THRESHOLD_MS - 60_000));
    assert.equal((await notices()).length, 0);
    // Past it, with no sync task filed: one notice, saying so, about the held line.
    const past = new Date(opened + LINE_BLOCKED_THRESHOLD_MS + 60_000);
    // (The sweep reads every project of this database, so this case counts its own project's notices.)
    await stack.lineBlocked.tick(past);
    assert.equal((await notices()).length, 1);
    await stack.lineBlocked.tick(past);
    assert.equal((await notices()).length, 1, 'once per item');
    const [notice] = await notices();
    const detail = notice!.detail as { awaitingSyncTask?: boolean; blockedLine?: { held?: Array<{ taskId: string }> } };
    assert.equal(detail.awaitingSyncTask, true);
    assert.deepEqual(detail.blockedLine?.held?.map((task) => task.taskId).sort(), [x.taskId, y.taskId].sort());
    // The coordinator took the item up long ago; the owner is told after the project's escalation window anyway.
    const project = await stack.db.project.findUniqueOrThrow({ where: { id: w.projectId } });
    const late = new Date(Date.now() + project.exceptionEscalationSeconds * 1_000 + LINE_BLOCKED_THRESHOLD_MS + 120_000);
    await stack.lineBlocked.tick(late);
    assert.equal(stack.pushed.filter((push) => push.projectId === w.projectId).length, 1, 'the owner is told once');
    assert.equal(await stack.db.projectOrphanNotice.count({ where: { orphanKey: lineBlockedOwnerKey(item!.id) } }), 1);
    await stack.lineBlocked.tick(late);
    assert.equal(stack.pushed.filter((push) => push.projectId === w.projectId).length, 1);
  } finally {
    await stack.db.$disconnect();
  }
});

/** A baseline-red result over (U, T0), as K3 reports it. */
const BASELINE_RED: Failure = {
  state: 'CHECK_FAILED', phase: 'CHECK', sourceSha: 'a'.repeat(40), targetShaBefore: T0, upstreamSha: U,
  testedSha: 'd'.repeat(40), testedTreeSha: 'e'.repeat(40), baselineRed: true,
  checks: [{
    name: 'MERGE_CHECK', scope: 'BASELINE', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false,
    durationMs: 1, outputTail: 'red on its own', treeSha: '9'.repeat(40),
  }],
} as Failure;

test('§4.6 item 3, the K5 question: a baseline fix whose own landing is red again on the baseline queues nothing and '
  + 'is not claimable; a line-sync fix that conflicts again is not (the invariant this design keeps)',
{ skip, timeout: 300_000 }, async () => {
  const stack = await connect();
  try {
    // K5, as it stands: the fix task is exempt from its own baseline item, and its red result queues it again.
    const w = await world(stack, 'line-sync-k5');
    await doneTask(stack, w, 'k5-a');
    const [aLanding] = await claim(stack, w, 'k5-a');
    await report(stack, w, aLanding!, BASELINE_RED);
    const baseline = await stack.db.projectOpenItem.findFirstOrThrow({
      where: { projectId: w.projectId, dedupeKey: { startsWith: 'ICB:' }, state: 'OPEN' },
    });
    const fix = await syncTask(stack, w, baseline.id, 'k5-fix');
    const [fixLanding] = await claim(stack, w, 'k5-fix');
    assert.equal(await taskOf(stack.db, fixLanding), fix.taskId);
    await report(stack, w, fixLanding!, BASELINE_RED);
    const fixJobs = await landings(stack.db, fix.taskId);
    // The fix is exempt from its own baseline item, so a held generation would be claimed at once and run the same
    // red check on the same source: none is queued, nothing is claimable, and the item is in front of the coordinator
    // again under a new key.
    assert.deepEqual(fixJobs.map((job) => job.state), ['CHECK_FAILED']);
    assert.equal((await claim(stack, w, 'k5-fix-again')).length, 0, 'K5: the red fix is not claimed again');
    const again = await stack.db.projectOpenItem.findFirstOrThrow({
      where: { projectId: w.projectId, dedupeKey: { startsWith: 'ICB:' }, state: 'OPEN' },
    });
    assert.equal(again.id, baseline.id, 'the same baseline item');
    assert.ok(again.assignedAt.getTime() > baseline.assignedAt.getTime(), 'delivered to the coordinator again');

    // The line-sync item keeps the invariant instead (§4.2's exception): its sync task's second conflict queues
    // nothing, so nothing is claimable.
    const v = await world(stack, 'line-sync-k5-sync');
    await doneTask(stack, v, 'k5-x');
    const [xLanding] = await claim(stack, v, 'k5-x');
    await report(stack, v, xLanding!, mainSyncConflict());
    const [item] = await lineSyncItems(stack.db, v.projectId);
    const sync = await syncTask(stack, v, item!.id, 'k5-sync');
    const [syncLanding] = await claim(stack, v, 'k5-sync');
    await report(stack, v, syncLanding!, mainSyncConflict(U2));
    assert.deepEqual((await landings(stack.db, sync.taskId)).map((job) => job.state), ['CONFLICT']);
    assert.equal((await claim(stack, v, 'k5-sync-again')).length, 0);
  } finally {
    await stack.db.$disconnect();
  }
});
