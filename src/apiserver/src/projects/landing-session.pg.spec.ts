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
import { BadRequestException } from '@nestjs/common';
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
import { MergeReceiptService } from '../sessions/merge-receipt.service';
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
import {
  INTEGRATION_JOB_CLAIM,
  PROMOTION_AUTOMATIC_LAND,
  enqueueForDoneTask,
  queueLandingBehindTheWork,
} from './project-integration-job';
import { ensureLandingSession } from './landing-session';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectIntegrationRetryController } from './project-integration-retry.controller';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * Landing subjects and LANDING sessions (docs/project-integration-line-contract.md §2.9 LS1–LS3,
 * revision 12, migration 0436).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-session.pg.spec.ts
 *
 * Every case drives the product's own doors: DONE through the acceptance command, the heartbeat
 * that claims, the runner route that reports, the retry / owner-rerun / skip / decline / confirm
 * doors, and the settlement edges the facts commit. Nothing writes a job, a subject or a session
 * row directly except where a case creates the work session a DONE would have frozen.
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
  promotions: ProjectPromotionService;
  handoffs: ProjectHandoffService;
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
  const handoffs = new ProjectHandoffService(prisma as never);
  const tasks = new TasksService(prisma, sessions, realtime, handoffs, router, undefined, openItems);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  const ownerRetry = new ProjectIntegrationRetryController(openItems);
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
  return {
    db,
    sessions,
    tasks,
    api,
    jobs,
    openItems,
    ownerRetry,
    promotions: new ProjectPromotionService(prisma),
    handoffs,
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

async function world(
  stack: Stack,
  label: string,
  line: 'PROJECT_BRANCH' | 'MAIN' = 'PROJECT_BRANCH',
  automatic = true,
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@landing.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND],
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
    settings: { line },
  }));
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

interface Attempt {
  taskId: string;
  title: string;
  sessionId: string;
  branch: string;
}

function dequeue(stack: Stack, sessionId: string, runnerId: string) {
  return (stack.api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string } | null>;
  }).dequeueTurn(sessionId, runnerId, null);
}

async function answerTurn(stack: Stack, w: World, sessionId: string, turnId: string) {
  const last = await stack.db.runEvent.aggregate({ where: { sessionId }, _max: { seq: true } });
  await stack.api.events({ id: w.runnerId }, sessionId, {
    events: [{
      seq: (last._max.seq ?? 0) + 1,
      type: RunEventType.ASSISTANT,
      ts: new Date().toISOString(),
      turnId,
      payload: { text: 'the work is on the branch' },
    }],
  });
}

/** One code task carried to DONE through its own acceptance command, with the work session finished. */
async function doneTask(stack: Stack, w: World, label: string): Promise<Attempt> {
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
      branch,
      isolationStatus: 'worktree',
      baseSha: 'b'.repeat(40),
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
  await answerTurn(stack, w, sessionId, turnId);
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  const acceptance = await dequeue(stack, sessionId, w.runnerId);
  assert.equal(acceptance?.kind, 'shell', 'the acceptance command was queued for this task');
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId: acceptance!.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  assert.equal(await taskStatus(stack.db, declared.id), TaskStatus.DONE, 'the acceptance command agreed');
  await stack.db.session.update({
    where: { id: sessionId },
    data: { finishedAt: new Date(), worktreeBranch: branch, worktreeDirty: false },
  });
  return { taskId: declared.id, title, sessionId, branch };
}

function claim(stack: Stack, w: World, lease: string): Promise<IntegrationJobCommand[]> {
  return stack.jobs.dispatch({
    runnerId: w.runnerId,
    leaseOwner: lease,
    draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND],
  });
}

type Failure = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

function report(stack: Stack, w: World, job: IntegrationJobCommand, result: Failure) {
  return stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
}

const RED: Failure = {
  state: 'CHECK_FAILED',
  phase: 'CHECK',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'c'.repeat(40),
  testedSha: 'd'.repeat(40),
  testedTreeSha: 'e'.repeat(40),
  checks: [{
    name: 'MERGE_CHECK',
    command: 'exit 1',
    expectedExitCode: 0,
    exitCode: 1,
    timedOut: false,
    durationMs: 1,
    outputTail: 'FAIL\n',
  }],
};

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

/** A project-branch check's failure: the source is the commit the candidate was made from, so the
 *  platform's "this tip was already offered" read keeps matching the candidate it made. */
function promotionRed(sourceSha: string): Failure {
  return {
    ...RED,
    sourceSha,
    targetShaBefore: 'f'.repeat(40),
    upstreamSha: 'f'.repeat(40),
    testedSha: '2'.repeat(40),
    testedTreeSha: '3'.repeat(40),
  };
}

function promotionReady(sourceSha: string): Failure {
  return {
    ...promotionRed(sourceSha),
    state: 'READY',
    checks: [{
      name: 'MERGE_CHECK',
      command: 'exit 0',
      expectedExitCode: 0,
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      outputTail: 'ok\n',
    }],
    conflicts: [],
  };
}

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'exit 0',
  expectedExitCode: 0,
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
  outputTail: 'ok\n',
};

async function taskStatus(db: PrismaClient, taskId: string): Promise<TaskStatus> {
  return (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } })).status;
}

async function subjectOfJob(db: PrismaClient, jobId: string) {
  const job = await db.projectIntegrationJob.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      landingId: true, kind: true, generation: true, state: true, taskId: true,
      promotionId: true, skipMergeCheck: true,
    },
  });
  assert.ok(job.landingId, `job ${jobId} names no landing subject`);
  const landing = await db.projectLanding.findUniqueOrThrow({ where: { id: job.landingId! } });
  return { job, landing };
}

/** The job this step wants, claimed off the world's heartbeat. A beat may hand out more than one;
 *  the others are claimed too (they become RUNNING), which every assertion here accounts for. */
async function claimLanding(
  stack: Stack,
  w: World,
  lease: string,
  kind?: string,
): Promise<IntegrationJobCommand> {
  const jobs = await claim(stack, w, lease);
  const wanted = kind ? jobs.find((job) => job.kind === kind) : jobs[0];
  assert.ok(wanted, `the heartbeat was handed no ${kind ?? 'job'}: ${JSON.stringify(jobs.map((job) => job.kind))}`);
  return wanted;
}

const REASON = 'the merge check ran against a repaired baseline';

// ── one task segment ─────────────────────────────────────────────────────────────────────────────

test('one task segment collects the DONE, integration_retry, the owner rerun, the skipped check, the reopen DONE and the J-T1e backfill',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'segments');
      const task = await doneTask(stack, w, 'segments');

      const first = await claimLanding(stack, w, 'lease-1');
      assert.equal(first.kind, 'LAND_TASK');
      const { job: firstJob, landing } = await subjectOfJob(stack.db, first.jobId);
      assert.equal(landing.subject, 'TASK');
      assert.equal(landing.taskId, task.taskId);
      assert.equal(landing.promotionId, null);
      assert.equal(landing.episode, 1);
      assert.equal(landing.settledAt, null);
      assert.ok(firstJob.generation === 1);
      // LS1: the subject names a pre-generated session id, and the claim that just committed is
      // the compensation point that inserted its row.
      assert.equal(await stack.db.session.count({ where: { id: landing.sessionId } }), 1);
      assert.equal((await stack.db.session.findUniqueOrThrow({
        where: { id: landing.sessionId }, select: { sessionKind: true },
      })).sessionKind, 'LANDING');

      // The first generation fails: a failure is not a settlement fact.
      assert.equal((await report(stack, w, first, RED)).accepted, true);
      assert.equal((await stack.db.projectLanding.findUniqueOrThrow({ where: { id: landing.id } })).settledAt, null);

      // `integration_retry`, the coordinator's generation (and the H1 item's handler).
      const retried = await stack.openItems.retryIntegration(
        w.ownerId, w.projectId, task.taskId, { reason: REASON }, w.coordinatorSessionId,
      );
      const second = await claimLanding(stack, w, 'lease-2');
      assert.equal(second.jobId, retried.jobId);
      assert.equal((await subjectOfJob(stack.db, second.jobId)).landing.id, landing.id, 'generation 2 is the same segment');
      assert.equal((await report(stack, w, second, RED)).accepted, true);

      // The owner's rerun door (0380). It answers an item that is the owner's, so the coordinator
      // hands the newest failure over first — the same edge the owner card is drawn on.
      const ownerItem = await stack.db.projectOpenItem.findFirstOrThrow({
        where: { taskId: task.taskId, state: 'OPEN', kind: 'INTEGRATION_CHECK_FAILED' },
        orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      await stack.openItems.handOver(
        w.ownerId, w.projectId, ownerItem.id,
        { note: 'the owner decides whether this runs again' },
        { kind: 'SESSION', sessionId: w.coordinatorSessionId },
      );
      await stack.ownerRetry.retryIntegration(
        { userId: w.ownerId, email: `${w.ownerId}@landing.invalid` }, w.projectId, task.taskId,
        { reason: REASON },
      );
      const third = await claimLanding(stack, w, 'lease-3');
      assert.equal((await subjectOfJob(stack.db, third.jobId)).landing.id, landing.id, 'the owner rerun is the same segment');
      assert.equal((await report(stack, w, third, RED)).accepted, true);

      // `integration_skip_merge_check` — the generation whose merge check did not run.
      const skipped = await stack.ownerRetry.skipIntegrationMergeCheck(
        { userId: w.ownerId, email: `${w.ownerId}@landing.invalid` },
        w.projectId, task.taskId,
        { reason: 'the check cannot run on this machine' },
      );
      const skippedSubject = await subjectOfJob(stack.db, skipped.jobId);
      assert.equal(skippedSubject.job.state, 'QUEUED', 'the skip is queued, not claimed yet');
      assert.equal(skippedSubject.job.skipMergeCheck, true);
      assert.equal(skippedSubject.landing.id, landing.id);

      // A reopen stops the in-flight generation but does not settle the segment; the next DONE opens
      // no new one.
      await stack.tasks.update(w.ownerId, task.taskId, { status: 'OPEN', supersededByTaskId: null, terminalReason: null } as never);
      assert.equal((await stack.db.projectLanding.findUniqueOrThrow({ where: { id: landing.id } })).settledAt, null,
        'a reopen is not a settlement fact');
      await stack.db.$transaction(async (tx) => {
        await tx.task.update({ where: { id: task.taskId }, data: { status: TaskStatus.DONE } });
        const queued = await enqueueForDoneTask(tx, w.ownerId, task.taskId);
        assert.equal(queued.enqueued, true, `the second DONE queued a generation: ${JSON.stringify(queued)}`);
      });
      const fifth = await claimLanding(stack, w, 'lease-5');
      assert.equal((await subjectOfJob(stack.db, fifth.jobId)).landing.id, landing.id,
        'the DONE written after the reopen is the same segment');
      assert.equal((await report(stack, w, fifth, RED)).accepted, true);

      // J-T1e: the landing owed for the branch the work actually ended on. No generation is in
      // flight now, so `queueLandingBehindTheWork` — the same call the result transaction makes —
      // queues one, and it joins the segment.
      const late = randomUUID();
      const finishedAt = new Date();
      await stack.db.session.create({
        data: {
          id: late,
          ownerId: w.ownerId,
          creatorId: w.ownerId,
          taskId: task.taskId,
          workspaceId: w.workspaceId,
          assignedRunnerId: w.runnerId,
          title: `${task.title} (late)`,
          prompt: 'late',
          provider: 'claude',
          status: RunStatus.SUCCEEDED,
          dispatchOrigin: SessionDispatchOrigin.USER,
          startsTaskWork: true,
          branch: `orbit/${task.taskId}-late`,
          worktreeBranch: `orbit/${task.taskId}-late`,
          isolationStatus: 'worktree',
          baseSha: 'b'.repeat(40),
          finishedAt,
          worktreeDirty: false,
        },
      });
      const behind = await stack.db.$transaction((tx) => queueLandingBehindTheWork(tx, {
        ownerId: w.ownerId,
        projectId: w.projectId,
        taskId: task.taskId,
        sessions: [{
          sessionId: late,
          branch: `orbit/${task.taskId}-late`,
          worktreeBranch: null,
          finishedAt,
          runnerId: w.runnerId,
        }],
      }));
      assert.ok(behind, 'the backfill queued a landing');
      if (behind.kind !== 'LAND_TASK') assert.fail('the backfill queued a promotion, not a LAND_TASK');
      assert.equal((await subjectOfJob(stack.db, behind.jobId)).landing.id, landing.id,
        'the J-T1e backfill is the same segment');

      assert.equal(await stack.db.projectLanding.count({ where: { taskId: task.taskId } }), 1,
        'one task, one unsettled segment');
      // The segment kept one container: its first claim inserted the row, and every later
      // generation joined the same subject.
      assert.equal(await stack.db.session.count({ where: { id: landing.sessionId } }), 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── a merge round ────────────────────────────────────────────────────────────────────────────────

test('one merge round: superseded candidates, the Automatic re-check and the owner-confirmed stolen push share a subject; MERGED opens a new one',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'round');

      // Candidate A: a task lands on the project branch, and the landing's aftermath offers the
      // branch toward main.
      const a = await doneTask(stack, w, 'round-a');
      const landedA = { ...LANDED, landedSha: '1'.repeat(40), testedSha: '1'.repeat(40) };
      assert.equal((await report(stack, w, await claimLanding(stack, w, 'lease-a', 'LAND_TASK'), landedA)).accepted, true);
      const checkA = await claimLanding(stack, w, 'lease-a-check');
      assert.equal(checkA.kind, 'CHECK_PROMOTION');
      const candidateA = (await subjectOfJob(stack.db, checkA.jobId)).landing;
      assert.equal(candidateA.subject, 'PROMOTION');
      assert.equal(candidateA.episode, 1);
      assert.equal((await report(stack, w, checkA, promotionRed('1'.repeat(40)))).accepted, true);

      // Candidate B supersedes A (a second task lands while the round is open).
      const b = await doneTask(stack, w, 'round-b');
      const landedB = { ...LANDED, landedSha: '2'.repeat(40), testedSha: '2'.repeat(40) };
      assert.equal((await report(stack, w, await claimLanding(stack, w, 'lease-b', 'LAND_TASK'), landedB)).accepted, true);
      const checkB = await claimLanding(stack, w, 'lease-b-check');
      assert.equal(checkB.kind, 'CHECK_PROMOTION');
      assert.equal((await subjectOfJob(stack.db, checkB.jobId)).landing.id, candidateA.id,
        'candidate B joins the open round');
      assert.equal((await report(stack, w, checkB, promotionRed('2'.repeat(40)))).accepted, true);

      // Candidate C supersedes B.
      const c = await doneTask(stack, w, 'round-c');
      const landedC = { ...LANDED, landedSha: '3'.repeat(40), testedSha: '3'.repeat(40) };
      assert.equal((await report(stack, w, await claimLanding(stack, w, 'lease-c', 'LAND_TASK'), landedC)).accepted, true);
      const checkC = await claimLanding(stack, w, 'lease-c-check');
      assert.equal(checkC.kind, 'CHECK_PROMOTION');
      assert.equal((await subjectOfJob(stack.db, checkC.jobId)).landing.id, candidateA.id,
        'candidate C joins the same round');

      const promotionA = await stack.db.projectPromotion.findFirstOrThrow({
        where: { id: candidateA.promotionId! }, select: { id: true },
      });
      const promotionC = await stack.db.projectPromotion.findFirstOrThrow({
        where: { taskId: c.taskId, projectId: w.projectId }, select: { id: true, state: true },
      });
      assert.equal(promotionC.state, 'CHECKING');
      assert.notEqual(promotionC.id, promotionA.id, 'candidate C is a different candidate');

      // C's clean check: Automatic confirms and queues the first landing of the round.
      assert.equal((await report(stack, w, checkC, promotionReady('3'.repeat(40)))).accepted, true);
      const automaticLanding = await claimLanding(stack, w, 'lease-c-land', 'LAND_PROMOTION');
      assert.equal(automaticLanding.kind, 'LAND_PROMOTION');
      assert.equal((await subjectOfJob(stack.db, automaticLanding.jobId)).landing.id, candidateA.id,
        "Automatic's landing is the round's subject");

      // Main moved under it: the Automatic rule re-checks the same candidate on the new main.
      assert.equal((await report(stack, w, automaticLanding, {
        ...promotionReady('3'.repeat(40)), phase: 'FETCH', checks: [], conflicts: [],
      })).accepted, true);
      const recheck = await claimLanding(stack, w, 'lease-c-recheck', 'CHECK_PROMOTION');
      assert.equal(recheck.kind, 'CHECK_PROMOTION');
      assert.equal((await subjectOfJob(stack.db, recheck.jobId)).landing.id, candidateA.id,
        'the Automatic re-check is the same subject');

      // The owner's confirmed landing, and the generation its stolen push queues.
      await stack.db.project.update({ where: { id: w.projectId }, data: { coordinatorEnabled: false } });
      assert.equal((await report(stack, w, recheck, promotionReady('3'.repeat(40)))).accepted, true);
      await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, promotionC.id);
      const ownerLanding = await claimLanding(stack, w, 'lease-c-owner', 'LAND_PROMOTION');
      assert.equal(ownerLanding.kind, 'LAND_PROMOTION');
      assert.equal((await subjectOfJob(stack.db, ownerLanding.jobId)).landing.id, candidateA.id);
      assert.equal((await report(stack, w, ownerLanding, {
        ...RED,
        state: 'ERROR',
        phase: 'PUSH',
        errorCode: 'TARGET_MOVED',
        upstreamMovedCommits: { total: 1, commits: [{ sha: 'f'.repeat(40), subject: 'feat: someone else' }] },
      })).accepted, true);
      const stolen = await claimLanding(stack, w, 'lease-c-stolen', 'LAND_PROMOTION');
      assert.equal(stolen.kind, 'LAND_PROMOTION');
      assert.equal((await subjectOfJob(stack.db, stolen.jobId)).landing.id, candidateA.id,
        "the owner confirmation's next generation is the same subject");

      // It lands: the round settles MERGED.
      assert.equal((await report(stack, w, stolen, LANDED)).accepted, true);
      const settled = await stack.db.projectLanding.findUniqueOrThrow({ where: { id: candidateA.id } });
      assert.equal(settled.settledAs, 'MERGED');
      assert.ok(settled.settledAt);
      // MERGED closed the container the round's first claim opened.
      assert.equal(await stack.db.session.findUniqueOrThrow({
        where: { id: settled.sessionId }, select: { status: true },
      }).then((row) => row.status), RunStatus.SUCCEEDED);

      // The next candidate after MERGED opens a new round with a new subject.
      const d = await doneTask(stack, w, 'round-d');
      const landedD = { ...LANDED, landedSha: '4'.repeat(40), testedSha: '4'.repeat(40) };
      assert.equal((await report(stack, w, await claimLanding(stack, w, 'lease-d', 'LAND_TASK'), landedD)).accepted, true);
      const checkD = await claimLanding(stack, w, 'lease-d-check', 'CHECK_PROMOTION');
      const nextRound = (await subjectOfJob(stack.db, checkD.jobId)).landing;
      assert.notEqual(nextRound.id, candidateA.id, 'MERGED ends the round');
      assert.equal(nextRound.episode, 2);
      assert.equal(nextRound.promotionId, (await stack.db.projectIntegrationJob.findUniqueOrThrow({
        where: { id: checkD.jobId }, select: { promotionId: true },
      })).promotionId);
      assert.equal(nextRound.settledAt, null);
      void a; void b;
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── a MAIN-line candidate ────────────────────────────────────────────────────────────────────────

test('a MAIN-line candidate is the task segment, and a resubmitted candidate stays in it',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'main-line', 'MAIN');
      const task = await doneTask(stack, w, 'main-line');
      const check = await claimLanding(stack, w, 'lease-main-1');
      assert.equal(check.kind, 'CHECK_PROMOTION');
      const { landing } = await subjectOfJob(stack.db, check.jobId);
      assert.equal(landing.subject, 'TASK');
      assert.equal(landing.taskId, task.taskId);
      assert.equal((await report(stack, w, check, RED)).accepted, true);

      // The coordinator re-runs the check: the same candidate and the same segment.
      const retried = await stack.openItems.retryPromotionCheck(
        w.ownerId, w.projectId, (await stack.db.projectIntegrationJob.findUniqueOrThrow({
          where: { id: check.jobId }, select: { promotionId: true },
        })).promotionId!, { reason: REASON }, w.coordinatorSessionId,
      );
      assert.equal((await subjectOfJob(stack.db, retried.jobId)).landing.id, landing.id);
      // Finish the retried check so the next beat is the resubmission, not this job again.
      const retriedCheck = await claimLanding(stack, w, 'lease-main-retry', 'CHECK_PROMOTION');
      assert.equal(retriedCheck.jobId, retried.jobId);
      assert.equal((await report(stack, w, retriedCheck, RED)).accepted, true);

      // A reopened task written DONE again queues a candidate for the branch the work ended on. The
      // rework is a NEW session on a NEW branch; the second candidate for the old branch would be
      // refused by the one-live-candidate index, which is the same branch being one question.
      await stack.tasks.update(w.ownerId, task.taskId, { status: 'OPEN', supersededByTaskId: null, terminalReason: null } as never);
      const rework = randomUUID();
      const reworkBranch = `orbit/${task.taskId}-rework`;
      await stack.db.session.create({
        data: {
          id: rework,
          ownerId: w.ownerId,
          creatorId: w.ownerId,
          taskId: task.taskId,
          workspaceId: w.workspaceId,
          assignedRunnerId: w.runnerId,
          title: `${task.title} (rework)`,
          prompt: 'rework',
          provider: 'claude',
          status: RunStatus.SUCCEEDED,
          dispatchOrigin: SessionDispatchOrigin.USER,
          startsTaskWork: true,
          branch: reworkBranch,
          worktreeBranch: reworkBranch,
          isolationStatus: 'worktree',
          baseSha: 'b'.repeat(40),
          finishedAt: new Date(Date.now() + 1_000),
          worktreeDirty: false,
        },
      });
      await stack.db.$transaction(async (tx) => {
        await tx.task.update({ where: { id: task.taskId }, data: { status: TaskStatus.DONE } });
        assert.equal((await enqueueForDoneTask(tx, w.ownerId, task.taskId)).enqueued, true);
      });
      const resubmitted = await claimLanding(stack, w, 'lease-main-2');
      assert.equal(resubmitted.kind, 'CHECK_PROMOTION');
      const again = await subjectOfJob(stack.db, resubmitted.jobId);
      assert.equal(again.landing.id, landing.id, 'the resubmitted candidate is the same task segment');
      assert.equal(again.landing.episode, 1);
      assert.notEqual(again.job.promotionId, (await stack.db.projectIntegrationJob.findUniqueOrThrow({
        where: { id: check.jobId }, select: { promotionId: true },
      })).promotionId, 'a resubmission is a new candidate');
      assert.equal(await stack.db.projectLanding.count({ where: { taskId: task.taskId } }), 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── ensure ───────────────────────────────────────────────────────────────────────────────────────

test('ensure writes the LS1 row — LANDING, AWAITING_INPUT, no engine, creator, provider orbit, the source workspace — and settlement closes it',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'ensure');
      const task = await doneTask(stack, w, 'ensure');
      const job = await claimLanding(stack, w, 'lease-ensure');
      const { landing } = await subjectOfJob(stack.db, job.jobId);

      // The claim's dispatch already inserted it; ensure is the idempotent answer for a retry.
      const ensured = await ensureLandingSession(stack.db, landing.id, job.jobId);
      assert.equal(ensured?.created, false);
      assert.equal(ensured.sessionId, landing.sessionId);
      const session = await stack.db.session.findUniqueOrThrow({ where: { id: landing.sessionId } });
      assert.equal(session.sessionKind, 'LANDING');
      assert.equal(session.status, RunStatus.AWAITING_INPUT);
      assert.equal(session.startsTaskWork, false);
      assert.equal(session.assignedRunnerId, null);
      assert.equal(session.taskId, null);
      assert.equal(session.contextTaskId, null);
      assert.equal(session.parentSessionId, null);
      assert.equal(session.rootSessionId, null);
      assert.equal(session.lastTurnAt, null);
      assert.equal(session.title, `Land · ${task.title}`);
      assert.equal(session.titleManagedByProject, true);
      assert.equal(session.dispatchOrigin, SessionDispatchOrigin.USER);
      assert.equal(session.runSource, 'MANUAL');
      assert.equal(session.provider, 'orbit');
      assert.equal(session.providerBuiltin, true);
      assert.equal(session.engine, null);
      assert.equal(session.creatorId, w.ownerId);
      assert.equal(session.workspaceId, w.workspaceId, 'a TASK subject takes the source work session workspace');
      assert.deepEqual(session.mergeTargets, []);
      assert.match(session.prompt, /^Orbit runs this landing/);
      assert.equal(await stack.db.runEvent.count({ where: { sessionId: landing.sessionId } }), 0,
        'a LANDING session never produces run events');

      // Idempotent: a second ensure writes nothing.
      assert.deepEqual(await ensureLandingSession(stack.db, landing.id, job.jobId), { sessionId: landing.sessionId, created: false });
      assert.equal(await stack.db.session.count({ where: { id: landing.sessionId } }), 1);

      // The landing fact closes the container SUCCEEDED with completed_at.
      assert.equal((await report(stack, w, job, LANDED)).accepted, true);
      const settledSession = await stack.db.session.findUniqueOrThrow({ where: { id: landing.sessionId } });
      assert.equal(settledSession.status, RunStatus.SUCCEEDED);
      assert.ok(settledSession.completedAt);
      const settledLanding = await stack.db.projectLanding.findUniqueOrThrow({ where: { id: landing.id } });
      assert.equal(settledLanding.settledAs, 'LANDED');

      // A second episode gets its own subject, title and container; a cancellation closes it CANCELLED.
      await stack.tasks.update(w.ownerId, task.taskId, { status: 'OPEN', supersededByTaskId: null, terminalReason: null } as never);
      await stack.db.$transaction(async (tx) => {
        await tx.task.update({ where: { id: task.taskId }, data: { status: TaskStatus.DONE } });
        assert.equal((await enqueueForDoneTask(tx, w.ownerId, task.taskId)).enqueued, true);
      });
      const next = await claimLanding(stack, w, 'lease-ensure-2', 'LAND_TASK');
      const episode2 = (await subjectOfJob(stack.db, next.jobId)).landing;
      assert.equal(episode2.episode, 2);
      assert.notEqual(episode2.id, landing.id);
      assert.equal(await ensureLandingSession(stack.db, episode2.id, next.jobId).then((r) => r?.created), false,
        'the second episode\'s claim inserted its row; ensure joins it');
      const session2 = await stack.db.session.findUniqueOrThrow({ where: { id: episode2.sessionId } });
      assert.equal(session2.title, `Land · ${task.title} (#2)`);
      // End the attempt so no in-flight generation holds the settlement (LS3).
      assert.equal((await report(stack, w, next, RED)).accepted, true);
      await stack.tasks.update(w.ownerId, task.taskId, { status: TaskStatus.CANCELLED } as never);
      const cancelled = await stack.db.session.findUniqueOrThrow({ where: { id: episode2.sessionId } });
      assert.equal(cancelled.status, RunStatus.CANCELLED);
      assert.ok(cancelled.completedAt);
      assert.equal((await stack.db.projectLanding.findUniqueOrThrow({ where: { id: episode2.id } })).settledAs, 'CANCELLED');

      // A PROMOTION subject takes the project's coordinator workspace and its own title.
      const pw = await world(stack, 'ensure-promo');
      const p = await doneTask(stack, pw, 'ensure-promo');
      assert.equal((await report(stack, pw, await claimLanding(stack, pw, 'lease-ensure-p', 'LAND_TASK'), LANDED)).accepted, true);
      const promoJob = await claimLanding(stack, pw, 'lease-ensure-promo-check', 'CHECK_PROMOTION');
      const promoLanding = (await subjectOfJob(stack.db, promoJob.jobId)).landing;
      assert.equal(await ensureLandingSession(stack.db, promoLanding.id, promoJob.jobId).then((r) => r?.created), false,
        'the promotion round\'s claim inserted its row; ensure joins it');
      const promoSession = await stack.db.session.findUniqueOrThrow({ where: { id: promoLanding.sessionId } });
      assert.equal(promoSession.workspaceId, pw.workspaceId);
      assert.match(promoSession.title, /^Merge project\/.+ → main · #1$/);
      void p;
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── settlement edges ────────────────────────────────────────────────────────────────────────────

test('M-T13 receipts settle LANDED / ALREADY_LANDED; MOVE_TASK settles CANCELLED; a handled item settles HANDLED; a reopen and an abandon settle nothing',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      // M-T13: a receipt recorded outside the card retires the candidate and settles its task segment.
      const receiptWorld = await world(stack, 'receipt', 'MAIN');
      const receiptTask = await doneTask(stack, receiptWorld, 'receipt');
      const check = await claimLanding(stack, receiptWorld, 'lease-receipt');
      const receiptLanding = (await subjectOfJob(stack.db, check.jobId)).landing;
      const receipts = new MergeReceiptService(stack.db as unknown as PrismaService);
      await receipts.record(receiptWorld.ownerId, receiptTask.sessionId, {
        result: 'MERGED',
        sourceBranch: receiptTask.branch,
        sourceSha: 'a'.repeat(40),
        targetBranch: 'main',
        targetShaBefore: 'b'.repeat(40),
        targetShaAfter: 'c'.repeat(40),
      } as never, 'AGENT');
      const afterReceipt = await stack.db.projectLanding.findUniqueOrThrow({ where: { id: receiptLanding.id } });
      assert.equal(afterReceipt.settledAs, 'LANDED', 'a MERGED receipt is the segment landing fact');
      assert.ok(afterReceipt.settledAt);

      // ALREADY_MERGED is ALREADY_LANDED.
      const alreadyWorld = await world(stack, 'receipt-already', 'MAIN');
      const alreadyTask = await doneTask(stack, alreadyWorld, 'receipt-already');
      const alreadyCheck = await claimLanding(stack, alreadyWorld, 'lease-receipt-already');
      const alreadyLanding = (await subjectOfJob(stack.db, alreadyCheck.jobId)).landing;
      await receipts.record(alreadyWorld.ownerId, alreadyTask.sessionId, {
        result: 'ALREADY_MERGED',
        sourceBranch: alreadyTask.branch,
        sourceSha: 'a'.repeat(40),
        targetBranch: 'main',
      } as never, 'AGENT');
      assert.equal((await stack.db.projectLanding.findUniqueOrThrow({ where: { id: alreadyLanding.id } })).settledAs,
        'ALREADY_LANDED');

      // MOVE_TASK out of the project settles the source segment CANCELLED.
      const moveWorld = await world(stack, 'move');
      const moveTask = await doneTask(stack, moveWorld, 'move');
      const moveJob = await claimLanding(stack, moveWorld, 'lease-move', 'LAND_TASK');
      assert.equal((await report(stack, moveWorld, moveJob, RED)).accepted, true);
      const moveSegment = await stack.db.projectLanding.findFirstOrThrow({
        where: { taskId: moveTask.taskId, settledAt: null },
      });
      const target = randomUUID();
      const targetCoordinator = randomUUID();
      await stack.db.session.create({
        data: {
          id: targetCoordinator, ownerId: moveWorld.ownerId, creatorId: moveWorld.ownerId,
          workspaceId: moveWorld.workspaceId, assignedRunnerId: moveWorld.runnerId,
          title: 'target coordinator', prompt: 'target coordinator', provider: 'claude',
          status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
        },
      });
      await stack.db.project.create({
        data: {
          id: target, ownerId: moveWorld.ownerId, title: 'target', goal: 'take the task',
          coordinatorEnabled: false, coordinatorWorkspaceId: moveWorld.workspaceId,
          coordinatorSessionId: targetCoordinator,
        },
      });
      await stack.db.projectRuntime.upsert({ where: { projectId: target }, create: { projectId: target }, update: {} });
      const asked = await stack.tasks.update(moveWorld.ownerId, moveTask.taskId, {
        projectId: target, handoff: { reason: 'it serves the target project' },
      } as never, targetCoordinator).then(() => null, (error: unknown) => error as { getResponse(): { handoffId?: string; code?: string } });
      assert.equal(asked?.getResponse().code, 'CROSS_PROJECT_APPROVAL_REQUIRED');
      await stack.handoffs.decide(
        moveWorld.ownerId, moveWorld.ownerId, asked!.getResponse().handoffId!, 'APPROVE', new Date(), { kind: 'LOGIN' },
      );
      const movedSegment = await stack.db.projectLanding.findUniqueOrThrow({ where: { id: moveSegment.id } });
      assert.equal(movedSegment.settledAs, 'CANCELLED', 'a MOVE_TASK out of the project settles CANCELLED');
      assert.ok(movedSegment.settledAt);

      // A handled item (the fix-task path) settles HANDLED when nothing landed and nothing moves.
      const fixWorld = await world(stack, 'fix');
      const fixTask = await doneTask(stack, fixWorld, 'fix');
      const fixJob = await claimLanding(stack, fixWorld, 'lease-fix');
      assert.equal((await report(stack, fixWorld, fixJob, RED)).accepted, true);
      const fixSegment = (await subjectOfJob(stack.db, fixJob.jobId)).landing;
      const item = await stack.db.projectOpenItem.findFirstOrThrow({
        where: { taskId: fixTask.taskId, state: 'OPEN' },
        select: { id: true },
      });
      await stack.openItems.resolveOpenItem(
        fixWorld.ownerId, fixWorld.projectId, item.id,
        { note: 'a fix task now carries the remaining work' }, { kind: 'OWNER' },
      );
      const handled = await stack.db.projectLanding.findUniqueOrThrow({ where: { id: fixSegment.id } });
      assert.equal(handled.settledAs, 'HANDLED');
      assert.ok(handled.settledAt);

      // A reopen settles nothing.
      const reopenWorld = await world(stack, 'reopen');
      const reopenTask = await doneTask(stack, reopenWorld, 'reopen');
      await claimLanding(stack, reopenWorld, 'lease-reopen');
      const reopenSegment = await stack.db.projectLanding.findFirstOrThrow({
        where: { taskId: reopenTask.taskId, settledAt: null },
      });
      await stack.tasks.update(reopenWorld.ownerId, reopenTask.taskId, { status: 'OPEN', supersededByTaskId: null, terminalReason: null } as never);
      assert.equal((await stack.db.projectLanding.findUniqueOrThrow({ where: { id: reopenSegment.id } })).settledAt, null,
        'a reopen is not a settlement fact');

      // An abandon settles nothing either: the ERROR result is not a landing or a cancellation fact.
      const abandonWorld = await world(stack, 'abandon');
      const abandonTask = await doneTask(stack, abandonWorld, 'abandon');
      const abandonJob = await claimLanding(stack, abandonWorld, 'lease-abandon');
      const abandonSegment = (await subjectOfJob(stack.db, abandonJob.jobId)).landing;
      await stack.db.projectIntegrationJob.update({
        where: { id: abandonJob.jobId },
        data: { heartbeatAt: new Date(Date.now() - 20 * 60_000) },
      });
      await stack.jobs.abandon({
        jobId: abandonJob.jobId,
        projectId: abandonWorld.projectId,
        ownerId: abandonWorld.ownerId,
        by: 'owner',
      });
      assert.equal((await stack.db.projectLanding.findUniqueOrThrow({ where: { id: abandonSegment.id } })).settledAt, null,
        'abandoning an attempt does not settle its segment');
      assert.equal(await taskStatus(stack.db, abandonTask.taskId), TaskStatus.DONE);
    } finally {
      await stack.db.$disconnect();
    }
  });

/** The sentence an HttpException answers with, whichever shape its body has. */
function messageOf(error: BadRequestException): string {
  const body = error.getResponse() as string | { message?: unknown };
  return typeof body === 'string' ? body : String(body?.message ?? '');
}

test('a session or a task cannot be created on the reserved orbit provider', { skip, timeout: 120_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'orbit-reserved');
    for (const role of ['USER', 'ADMIN']) {
      // An admin's provider scope includes shared (owner_id NULL) rows, which is exactly the row the
      // migration parks on this slug; the refusal must come from the reserved value, not the row.
      await stack.db.user.update({ where: { id: w.ownerId }, data: { role: role as never } });
      await assert.rejects(
        stack.sessions.create(w.ownerId, {
          prompt: 'hello', title: `on orbit ${role}`, workspaceId: w.workspaceId, provider: 'orbit',
        }),
        (error: unknown) => error instanceof BadRequestException
          && messageOf(error).includes('provider not available: "orbit"'),
        `a ${role} must not create a session on the platform provider`,
      );
      await assert.rejects(
        stack.tasks.create(w.ownerId, {
          title: `pinned to orbit ${role}`,
          assigneeId: w.workspaceId,
          projectId: w.projectId,
          acceptanceCommand: 'exit 0',
          acceptanceExpectedExitCode: 0,
          provider: 'orbit',
        } as never),
        (error: unknown) => error instanceof BadRequestException
          && messageOf(error).includes('provider not available'),
        `a ${role} must not pin a task to the platform provider`,
      );
      assert.equal(await stack.db.session.count({ where: { title: `on orbit ${role}` } }), 0);
      assert.equal(await stack.db.task.count({ where: { title: `pinned to orbit ${role}` } }), 0);
    }
  } finally {
    await stack.db.$disconnect();
  }
});

// ── the derived label ───────────────────────────────────────────────────────────────────────────

test('a source work session reads the newest generation and its subject as sourceLanding', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'label');
    const task = await doneTask(stack, w, 'label');
    const job = await claimLanding(stack, w, 'lease-label');
    const { landing } = await subjectOfJob(stack.db, job.jobId);

    const detail = await stack.sessions.get(w.ownerId, task.sessionId);
    assert.equal(detail.sessionKind, 'CONVERSATION');
    assert.deepEqual(detail.sourceLanding, {
      landingSessionId: landing.sessionId,
      subject: 'TASK',
      state: 'RUNNING',
      settledAs: null,
      targetRef: job.targetRef,
    });

    assert.equal((await report(stack, w, job, LANDED)).accepted, true);
    // The landing's aftermath offers the project branch toward main, and that check names this same
    // source session: it is now the NEWEST generation, which is what the field reads.
    const settled = await stack.sessions.get(w.ownerId, task.sessionId);
    assert.equal(settled.sourceLanding?.subject, 'PROMOTION');
    assert.equal(settled.sourceLanding?.state, 'QUEUED');
    assert.equal(settled.sourceLanding?.settledAs, null);

    const other = await stack.sessions.get(w.ownerId, w.coordinatorSessionId);
    assert.equal(other.sourceLanding, null, 'a conversation that produced no landing work answers null');
  } finally {
    await stack.db.$disconnect();
  }
});

// ── the doors' own facts ───────────────────────────────────────────────────────────────────────

test('the landing view carries the queue’s Retry fact and J-T4’s push boundary for its attempt',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'doors');
      await doneTask(stack, w, 'doors');
      const job = await claimLanding(stack, w, 'lease-doors');
      const { landing } = await subjectOfJob(stack.db, job.jobId);

      // A claim inside its reporting window is not retried, and its first phase is nowhere near
      // the push. The page reads both as the server's answers.
      const fresh = await stack.sessions.get(w.ownerId, landing.sessionId);
      assert.equal(fresh.sessionKind, 'LANDING');
      assert.equal(fresh.landing.currentAttempt.retryable, false,
        'a claim inside its window is not one the owner’s Retry takes');
      assert.equal(fresh.landing.currentAttempt.pushBoundaryPassed, false);

      // A v2 claim that recorded its synchronous PUSH report is past J-T4's boundary, and the
      // view says so — the same row fact the stop and cancel doors read.
      await stack.db.projectIntegrationJob.update({
        where: { id: job.jobId },
        data: {
          progressProtocol: 'v2',
          pushReportedGeneration: BigInt(job.claimGeneration),
        },
      });
      const pushed = await stack.sessions.get(w.ownerId, landing.sessionId);
      assert.equal(pushed.landing.currentAttempt.pushBoundaryPassed, true,
        'the push boundary is push_reported_generation = claim_generation');

      // Silent past its lease: the timeout the Retry door takes. `retryable` is the in-flight
      // row's own answer (a timed-out LAND_TASK), not the page's reading of `timedOut`.
      await stack.db.projectIntegrationJob.update({
        where: { id: job.jobId },
        data: { heartbeatAt: new Date(Date.now() - 11 * 60_000) },
      });
      const silent = await stack.sessions.get(w.ownerId, landing.sessionId);
      assert.equal(silent.landing.currentAttempt.timedOut, true);
      assert.equal(silent.landing.currentAttempt.retryable, true);
    } finally {
      await stack.db.$disconnect();
    }
  });
