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
import { INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2, PROMOTION_AUTOMATIC_LAND } from './project-integration-job';
import { MAX_TIMELINE_SECTIONS } from './landing-timeline';
import { readLandingView } from './landing-view';
import { readProjectIntegrationRead } from './project-integration-line';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectIntegrationRetryController } from './project-integration-retry.controller';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * The landing timeline (docs/project-integration-line-contract.md §2.9 LS2/LS4, migration 0438), on
 * real PostgreSQL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-integration-event.pg.spec.ts
 *
 * WHAT IS REPLAYED. Every case drives the product's own doors: a task's DONE through its acceptance
 * command, the heartbeat that claims and takes over, the progress and result routes, the retry and
 * owner-rerun doors, the promotion confirmation and its landing, the stop and abandon doors, and
 * the receipt that retires a candidate. Nothing inserts an event row except the paging case and the claim-fallback
 * fixture, which say so where they do.
 *
 * WHAT IS ASSERTED. The order of a section's lines, the sections' titles (`Generation N`,
 * `Merge check · N`, `Merge to main · N`), the signature on a line whose fact a person or a
 * conversation caused, J-T13's moved commits with the control plane's `outsideQueue` and the
 * cross-account redaction (`{ reason: 'ANOTHER_ACCOUNT' }` and no ids), the timeout causes the job
 * row cannot tell apart, the claim / takeover / hand-back facts, and that replaying one fact writes
 * one row. Every case also holds the LS6 rule this ledger must not break: no row of `run_event`
 * belongs to a LANDING session.
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
  tasks: TasksService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
  openItems: ProjectOpenItemService;
  ownerRetry: ProjectIntegrationRetryController;
  promotions: ProjectPromotionService;
  receipts: MergeReceiptService;
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
    tasks,
    api,
    jobs,
    openItems,
    ownerRetry,
    promotions: new ProjectPromotionService(prisma),
    receipts: new MergeReceiptService(prisma),
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
    data: { id: ownerId, email: `${label}-${ownerId}@timeline.invalid`, name: label, passwordHash: 'x' },
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
    capabilities: [INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2, PROMOTION_AUTOMATIC_LAND],
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

/** The same result through the relay itself: the transaction and everything that follows from it,
 *  without the controller's after-commit edges (delivering items, considering the next candidate).
 *  Promotion cases use it so a considered candidate cannot change the queue under the case. */
async function reportDirect(
  stack: Stack,
  w: World,
  job: IntegrationJobCommand,
  result: Failure,
): Promise<void> {
  const applied = await stack.jobs.applyResult(job.jobId, w.runnerId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  }, w.ownerId);
  assert.equal(applied.answer.accepted, true, `the result was refused: ${JSON.stringify(applied.answer)}`);
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
    durationMs: 62_000,
    outputTail: 'FAIL\n',
  }],
};

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'exit 0',
  expectedExitCode: 0,
  exitCode: 0,
  timedOut: false,
  durationMs: 62_000,
  outputTail: 'ok\n',
};

const GREEN: Failure = {
  state: 'LANDED',
  phase: 'PUSH',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'c'.repeat(40),
  testedSha: 'd'.repeat(40),
  testedTreeSha: 'e'.repeat(40),
  landedSha: 'd'.repeat(40),
  landedTreeSha: 'e'.repeat(40),
  aheadOfUpstream: 1,
  checks: [GREEN_CHECK],
};

/** A project-branch check's failure: the source is the commit the candidate was made from. */
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
    checks: [{ ...GREEN_CHECK, command: 'exit 0' }],
    conflicts: [],
  };
}

async function taskStatus(db: PrismaClient, taskId: string): Promise<TaskStatus> {
  return (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } })).status;
}

async function subjectOfJob(db: PrismaClient, jobId: string) {
  const job = await db.projectIntegrationJob.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      id: true, landingId: true, kind: true, generation: true, state: true, taskId: true,
      promotionId: true, skipMergeCheck: true, claimGeneration: true,
    },
  });
  assert.ok(job.landingId, `job ${jobId} names no landing subject`);
  const landing = await db.projectLanding.findUniqueOrThrow({ where: { id: job.landingId! } });
  return { job, landing };
}

async function claimLanding(
  stack: Stack,
  w: World,
  lease: string,
  kind?: string,
): Promise<IntegrationJobCommand> {
  const jobs = await claim(stack, w, lease);
  const wanted = kind ? jobs.find((job) => job.kind === kind) : jobs[0];
  if (!wanted) {
    const all = await stack.db.projectIntegrationJob.findMany({
      where: { projectId: w.projectId },
      select: { id: true, kind: true, state: true, taskId: true, phase: true },
    });
    assert.fail(
      `the heartbeat was handed no ${kind ?? 'job'}: handed ${JSON.stringify(jobs.map((job) => job.kind))}; `
      + `project jobs ${JSON.stringify(all)}`,
    );
  }
  return wanted!;
}

/** One attempt's stored facts, in the order the reader draws them: claim, round (none first),
 *  the fact's instant, the ledger's sequence. */
async function eventsOf(db: PrismaClient, jobId: string) {
  return db.projectIntegrationJobEvent.findMany({
    where: { jobId },
    orderBy: [
      { claimGeneration: 'asc' },
      { round: { sort: 'asc', nulls: 'first' } },
      { at: 'asc' },
      { seq: 'asc' },
    ],
    select: {
      key: true, kind: true, claimGeneration: true, round: true, checkName: true, checkIndex: true,
      actorType: true, actorSessionId: true, actorUserId: true, reason: true, data: true, text: true, at: true,
    },
  });
}

/** The landing view's timeline for one subject, through the reader every client uses. */
async function timelineOf(stack: Stack, w: World, landingSessionId: string) {
  const view = await readLandingView(stack.db as unknown as PrismaService, w.ownerId, landingSessionId);
  assert.ok(view, 'the landing view is served from its subject');
  assert.ok(view!.timeline, 'the landing view carries the ordered timeline');
  return view!.timeline!;
}

/** LS6: nothing about a landing is a transcript row. */
async function assertNoLandingRunEvents(stack: Stack, landingSessionId: string) {
  assert.equal(
    await stack.db.runEvent.count({ where: { sessionId: landingSessionId } }),
    0,
    'a LANDING session has no run_event rows',
  );
}

// ── one task's landing ──────────────────────────────────────────────────────────────────────────

test('a LAND_TASK records enqueue, claim, round, check and landing, in order, in one Generation section',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'timeline-task');
      const task = await doneTask(stack, w, 'timeline-task');
      const queuedJob = await stack.db.projectIntegrationJob.findFirstOrThrow({
        where: { taskId: task.taskId, kind: 'LAND_TASK' }, select: { id: true },
      });
      const { landing } = await subjectOfJob(stack.db, queuedJob.id);

      // The enqueue is a fact of the DONE transaction.
      const enqueued = await eventsOf(stack.db, queuedJob.id);
      assert.deepEqual(enqueued.map((row) => row.kind), ['ENQUEUED']);
      assert.match(enqueued[0].text, /queued to land on/);

      const landingJob = await claimLanding(stack, w, 'lease-1', 'LAND_TASK');
      // A v2 report names the round and the check in flight; the check's start is its own fact.
      const startedAt = new Date();
      const progress = await stack.api.integrationJobProgress({ id: w.runnerId }, landingJob.jobId, {
        claimGeneration: landingJob.claimGeneration,
        leaseOwner: landingJob.leaseOwner,
        phase: 'CHECK',
        round: 1,
        check: { name: 'MERGE_CHECK', index: 1, count: 1, budgetSeconds: 60, startedAt: startedAt.toISOString() },
      });
      assert.equal(progress.accepted, true);

      assert.equal((await report(stack, w, landingJob, { ...GREEN, checks: [GREEN_CHECK] })).accepted, true);

      // The claim and the takeover are backfilled after the claim statement commits.
      const events = await eventsOf(stack.db, landingJob.jobId);
      assert.deepEqual(
        events.map((row) => row.kind),
        ['ENQUEUED', 'CLAIMED', 'CHECK_STARTED', 'ROUND', 'STEP', 'CHECK_FINISHED', 'RESULT'],
      );
      const claimed = events.find((row) => row.kind === 'CLAIMED')!;
      assert.equal(claimed.actorType, 'RUNNER');
      assert.equal(claimed.claimGeneration, 1n);
      assert.match(claimed.text, /Claimed by runner timeline-task-runner · claim 1/);
      const [round] = events.filter((row) => row.kind === 'ROUND');
      assert.equal(round.round, 1);
      // The relay names the M from the job's kind: a LAND_TASK's claim runs at most 3 rounds (J5).
      assert.equal(round.text, 'Round 1 of 3');
      const [reportedStart] = events.filter((row) => row.kind === 'CHECK_STARTED');
      assert.equal(reportedStart.checkName, 'MERGE_CHECK');
      assert.ok(Math.abs(reportedStart.at.getTime() - startedAt.getTime()) < 2_000,
        'the check start is the runner\'s own instant');
      const [finished] = events.filter((row) => row.kind === 'CHECK_FINISHED');
      assert.match(finished.text, /Merge check passed · 1m 02s/);
      const [result] = events.filter((row) => row.kind === 'RESULT');
      assert.equal((result.data as Record<string, unknown>).state, 'LANDED');
      assert.match(result.text, /Landed on project\//);

      // The landing view's ordered timeline: one section, titled for the generation.
      const timeline = await timelineOf(stack, w, landing.sessionId);
      assert.equal(timeline.sections.length, 1);
      assert.equal(timeline.sections[0].title, 'Generation 1');
      assert.equal(timeline.sections[0].state, 'LANDED');
      assert.deepEqual(
        timeline.sections[0].entries.map((entry) => entry.kind),
        ['ENQUEUED', 'CLAIMED', 'CHECK_STARTED', 'ROUND', 'STEP', 'CHECK_FINISHED', 'RESULT'],
      );
      assert.ok(timeline.sections[0].entries.every((entry) => entry.id !== null), 'stored facts carry their row id');
      assert.equal(timeline.truncated, false);
      // Every line's sentence is the server's, English, and no client has to compose one.
      assert.ok(timeline.sections[0].entries.every((entry) => entry.text.length > 0));

      await assertNoLandingRunEvents(stack, landing.sessionId);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── failures, reruns and replay ────────────────────────────────────────────────────────────────

test('a failure, the coordinator rerun and the owner rerun each sign their own line; a replayed result adds nothing',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'timeline-rerun');
      const task = await doneTask(stack, w, 'timeline-rerun');
      const first = await claimLanding(stack, w, 'lease-1', 'LAND_TASK');
      const { landing } = await subjectOfJob(stack.db, first.jobId);
      assert.equal((await report(stack, w, first, RED)).accepted, true);

      const afterFirst = await eventsOf(stack.db, first.jobId);
      assert.ok(afterFirst.some((row) => row.kind === 'RESULT'
        && (row.data as Record<string, unknown>).state === 'CHECK_FAILED'));
      const handed = afterFirst.find((row) => row.kind === 'HANDED_TO')!;
      assert.equal(handed.actorType, 'COORDINATOR');
      assert.equal((handed.data as Record<string, unknown>).assignee, 'COORDINATOR');

      // Replaying the same result is the same fact: nothing is written twice.
      const replay = await report(stack, w, first, RED);
      assert.equal(replay.accepted, false, 'a resent result finds the job terminal');
      assert.equal((await eventsOf(stack.db, first.jobId)).length, afterFirst.length);

      // The coordinator's rerun: a second generation, signed, with the reason it gave.
      const retried = await stack.openItems.retryIntegration(
        w.ownerId, w.projectId, task.taskId, { reason: 'the baseline was repaired' }, w.coordinatorSessionId,
      );
      const second = await claimLanding(stack, w, 'lease-2', 'LAND_TASK');
      assert.equal(second.jobId, retried.jobId);
      assert.equal((await report(stack, w, second, RED)).accepted, true);

      // The owner's rerun (0380): the newest failure is handed over first, as it would be to reach
      // the owner's card, and the owner's door then queues the third generation.
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
        { userId: w.ownerId, email: `${w.ownerId}@timeline.invalid` }, w.projectId, task.taskId,
        { reason: 'run it once more by hand' },
      );
      const third = await claimLanding(stack, w, 'lease-3', 'LAND_TASK');
      const thirdSubject = await subjectOfJob(stack.db, third.jobId);
      assert.equal(thirdSubject.landing.id, landing.id, 'every generation is the same segment');

      const timeline = await timelineOf(stack, w, landing.sessionId);
      assert.deepEqual(timeline.sections.map((section) => section.title), ['Generation 1', 'Generation 2', 'Generation 3']);
      // The rerun signature is derived, not copied: the coordinator's session, the owner's user.
      const secondRetry = timeline.sections[1].entries.find((entry) => entry.kind === 'RETRY')!;
      assert.equal(secondRetry.id, null, 'a derived line has no event row');
      assert.equal(secondRetry.actor?.type, 'COORDINATOR');
      assert.equal(secondRetry.actor?.sessionId, w.coordinatorSessionId);
      assert.match(secondRetry.text, /Rerun by the coordinator · the baseline was repaired/);
      const thirdRetry = timeline.sections[2].entries.find((entry) => entry.kind === 'RETRY')!;
      assert.equal(thirdRetry.actor?.type, 'OWNER');
      assert.equal(thirdRetry.actor?.userId, w.ownerId);
      assert.match(thirdRetry.text, /Rerun by the owner · run it once more by hand/);
      // 0368's handling line sits beside the generation that took over the item — its claim, not
      // claim 0 — so it is drawn with that attempt and after the generation whose failure it answers.
      const handledEntry = timeline.sections[1].entries.find((entry) => entry.kind === 'HANDLING')!;
      assert.equal(handledEntry.claim, 1);
      assert.ok(timeline.sections[1].entries.indexOf(handledEntry)
        > timeline.sections[1].entries.findIndex((entry) => entry.kind === 'ENQUEUED'));
      const failureEntry = timeline.sections[0].entries.find((entry) => entry.kind === 'RESULT')!;
      assert.match(failureEntry.text, /Check failed · nothing was pushed/);
      const sectionOf = (entry: unknown) => timeline.sections
        .findIndex((section) => (section.entries as unknown[]).includes(entry));
      assert.ok(sectionOf(handledEntry) > sectionOf(failureEntry),
        'the handling line comes after the failure line it answers');

      await assertNoLandingRunEvents(stack, landing.sessionId);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── the merge round: Automatic's recheck, and the owner-confirmed next generation ──────────────

test('a stolen push records the moved commits: Automatic re-checks, the owner confirmation queues its next generation, another account keeps its ids to itself',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'timeline-round');
      const task = await doneTask(stack, w, 'timeline-round');
      const landingJob = await claimLanding(stack, w, 'lease-a', 'LAND_TASK');
      assert.equal((await report(stack, w, landingJob, { ...GREEN, checks: [GREEN_CHECK] })).accepted, true);

      const check = await claimLanding(stack, w, 'lease-a-check', 'CHECK_PROMOTION');
      const { landing: round, job: checkJob } = await subjectOfJob(stack.db, check.jobId);
      assert.equal(round.subject, 'PROMOTION');
      const promotionId = checkJob.promotionId!;
      // A clean check: Automatic confirms, and queues the round's first landing.
      await reportDirect(stack, w, check, promotionReady('1'.repeat(40)));
      const automaticLanding = await claimLanding(stack, w, 'lease-a-land', 'LAND_PROMOTION');
      assert.equal(automaticLanding.kind, 'LAND_PROMOTION');

      // The automatic landing reached PUSH and the remote would not take it: the runner answers
      // READY with the commits main gained, the refusal is recorded on this landing, and the
      // candidate is checked again — the v4 board draws both lines, refusal first.
      const movedThree = {
        total: 3,
        commits: [
          { sha: '4'.repeat(40), subject: 'feat(macos): a window that reopens' },
          { sha: '5'.repeat(40), subject: 'fix(web): a table that scrolls' },
          { sha: '6'.repeat(40), subject: 'chore: a dependency bump' },
        ],
      };
      await reportDirect(stack, w, automaticLanding, {
        ...promotionReady('1'.repeat(40)), phase: 'PUSH', checks: [], conflicts: [],
        upstreamMovedCommits: movedThree,
      });
      const recheck = await claimLanding(stack, w, 'lease-a-recheck', 'CHECK_PROMOTION');
      const recheckEvents = await eventsOf(stack.db, automaticLanding.jobId);
      const recheckOnMoved = recheckEvents.find((row) => row.kind === 'RECHECK_ON_MOVED_MAIN')!;
      assert.match(recheckOnMoved.text, /main moved 3 commits since the check — checking again on the new main/);
      assert.equal(((recheckOnMoved.data as Record<string, unknown>).upstreamMovedCommits as { total: number }).total, 3);
      const nextJobId = String((recheckOnMoved.data as Record<string, unknown>).nextJobId);
      const [nextRow, claimedRow] = await Promise.all([
        stack.db.projectIntegrationJob.findUniqueOrThrow({
          where: { id: nextJobId },
          select: { id: true, kind: true, state: true, generation: true, promotionId: true, landingId: true },
        }),
        stack.db.projectIntegrationJob.findUniqueOrThrow({
          where: { id: recheck.jobId },
          select: { id: true, kind: true, state: true, generation: true, promotionId: true, landingId: true },
        }),
      ]);
      assert.equal(nextJobId, recheck.jobId, JSON.stringify({ nextRow, claimedRow }));
      assert.equal(nextRow.kind, 'CHECK_PROMOTION');
      assert.equal(nextRow.landingId, round.id);

      // Automatic off: the clean recheck opens the owner's card, and the owner confirms.
      await stack.db.project.update({ where: { id: w.projectId }, data: { coordinatorEnabled: false } });
      await reportDirect(stack, w, recheck, promotionReady('1'.repeat(40)));
      await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, promotionId);
      const ownerLanding = await claimLanding(stack, w, 'lease-a-owner', 'LAND_PROMOTION');
      assert.equal(ownerLanding.kind, 'LAND_PROMOTION');

      // One of the commits main gained was landed by ANOTHER account's queue, one by this
      // account's own earlier landing, one by nobody. The other account's ids must not appear.
      const ownerLandingRow = await stack.db.projectIntegrationJob.findUniqueOrThrow({
        where: { id: ownerLanding.jobId },
        select: { serialKey: true },
      });
      const codebase = await stack.db.projectCodebase.findFirstOrThrow({
        where: { projectId: w.projectId }, select: { id: true, canonicalRepoUrl: true },
      });
      /** A landing this fixture says put `sha` on main, under one account's own project. */
      const landedFixture = async (input: {
        ownerId: string; projectId: string; codebaseId: string; sha: string; suffix: string;
      }) => {
        const promotionId = randomUUID();
        await stack.db.projectPromotion.create({
          data: {
            id: promotionId,
            projectId: input.projectId,
            ownerId: input.ownerId,
            codebaseId: input.codebaseId,
            sourceKind: 'PROJECT_BRANCH',
            sourceRef: `refs/heads/project/${input.suffix}`,
            upstreamRef: 'refs/heads/main',
            includedTaskIds: [],
            state: 'MERGED',
            mergedSha: input.sha,
            mergedAt: new Date(Date.now() - 60_000),
            confirmedAutomatically: true,
          },
        });
        const jobId = randomUUID();
        await stack.db.projectIntegrationJob.create({
          data: {
            id: jobId,
            projectId: input.projectId,
            ownerId: input.ownerId,
            codebaseId: input.codebaseId,
            kind: 'LAND_PROMOTION',
            generation: 1,
            serialKey: ownerLandingRow.serialKey,
            targetRef: 'refs/heads/main',
            upstreamRef: 'refs/heads/main',
            sourceRef: `refs/heads/project/${input.suffix}`,
            state: 'LANDED',
            landedSha: input.sha,
            landedTreeSha: input.sha,
            testedSha: input.sha,
            testedTreeSha: input.sha,
            promotionId,
            idempotencyKey: `fixture:${input.suffix}:${jobId}`,
            finishedAt: new Date(Date.now() - 60_000),
          },
        });
        return { jobId, promotionId };
      };
      const own = await landedFixture({
        ownerId: w.ownerId, projectId: w.projectId, codebaseId: codebase.id,
        sha: '4'.repeat(40), suffix: 'own',
      });
      // Another account: its own project and binding, the same repository and target ref — that
      // pair is the whole of J1's serial key, which is how this landing is read as the one that
      // put the commit there.
      const otherOwner = randomUUID();
      await stack.db.user.create({
        data: { id: otherOwner, email: `other-${otherOwner}@timeline.invalid`, name: 'other', passwordHash: 'x' },
      });
      const otherProjectId = randomUUID();
      await stack.db.project.create({
        data: { id: otherProjectId, ownerId: otherOwner, title: 'the other account project' },
      });
      const otherCodebase = await stack.db.projectCodebase.create({
        data: {
          ownerId: otherOwner,
          projectId: otherProjectId,
          canonicalRepoUrl: codebase.canonicalRepoUrl,
          upstreamRef: 'refs/heads/main',
          integrationRef: 'refs/heads/main',
          refAuthority: 'REMOTE',
        },
        select: { id: true },
      });
      const other = await landedFixture({
        ownerId: otherOwner, projectId: otherProjectId, codebaseId: otherCodebase.id,
        sha: '5'.repeat(40), suffix: 'other',
      });
      await reportDirect(stack, w, ownerLanding, {
        ...RED,
        state: 'ERROR',
        phase: 'PUSH',
        errorCode: 'TARGET_MOVED',
        checks: [],
        upstreamMovedCommits: movedThree,
      });

      const ownerEvents = await eventsOf(stack.db, ownerLanding.jobId);
      const next = ownerEvents.find((row) => row.kind === 'NEXT_GENERATION')!;
      assert.match(next.text, /main moved 3 commits since the check — re-checking before merging/);
      const refused = ownerEvents.find((row) => row.kind === 'PUSH_REFUSED')!;
      assert.match(
        refused.text,
        /Push refused · main moved 3 commits, 1 from outside the queue \(chore: a dependency bump\)/,
      );
      const moved = (refused.data as { upstreamMovedCommits: { commits: Array<Record<string, unknown>> } })
        .upstreamMovedCommits;
      assert.equal(moved.commits.length, 3);
      const bySha = new Map(moved.commits.map((commit) => [commit.sha as string, commit]));
      // Landed by this account's own landing: ids are this account's to read.
      assert.deepEqual(bySha.get('4'.repeat(40))?.outsideQueue, false);
      assert.deepEqual(bySha.get('4'.repeat(40))?.landedBy, { jobId: own.jobId, promotionId: own.promotionId });
      // Landed by another account: the reason and nothing else — no job, no promotion.
      assert.equal(bySha.get('5'.repeat(40))?.outsideQueue, false);
      assert.deepEqual(bySha.get('5'.repeat(40))?.landedBy, { reason: 'ANOTHER_ACCOUNT' });
      assert.equal(JSON.stringify(bySha.get('5'.repeat(40))).includes(other.jobId), false,
        'another account\'s job id never reaches this account\'s timeline');
      // From outside any queue.
      assert.equal(bySha.get('6'.repeat(40))?.outsideQueue, true);

      // The owner confirmation's next generation is queued and is the same round.
      const nextGeneration = await stack.db.projectIntegrationJob.findFirstOrThrow({
        where: { promotionId, kind: 'LAND_PROMOTION', generation: 3 },
        select: { id: true, landingId: true },
      });
      assert.equal(nextGeneration.landingId, round.id);

      // The round's timeline is sectioned by attempt: Merge check · 1, Merge to main · 1, Merge
      // check · 2, Merge to main · 2, and the next generation the refused push queued — and the
      // confirmation and the automatic attempt are derived.
      const timeline = await timelineOf(stack, w, round.sessionId);
      assert.deepEqual(timeline.sections.map((section) => section.title), [
        'Merge check · 1', 'Merge to main · 1', 'Merge check · 2', 'Merge to main · 2', 'Merge to main · 3',
      ]);
      const firstLanding = timeline.sections[1].entries;
      const confirmation = firstLanding.find((entry) => entry.kind === 'CONFIRMATION')!;
      assert.equal(confirmation.actor?.type, 'AUTOMATIC');
      const attempt = firstLanding.find((entry) => entry.kind === 'AUTOMATIC_ATTEMPT')!;
      assert.match(attempt.text, /Automatic merge 1 of 3/);
      // The v4 board order: the automatic landing's refused push is drawn with the commits main
      // gained, before the answer and the recheck it decided; the owner-confirmed landing's ends
      // with the next generation, after the push it was refused.
      const automaticEntries = timeline.sections[1].entries;
      assert.deepEqual(
        automaticEntries.map((entry) => entry.kind),
        ['CONFIRMATION', 'AUTOMATIC_ATTEMPT', 'ENQUEUED', 'CLAIMED', 'PUSH_REFUSED', 'RESULT', 'RECHECK_ON_MOVED_MAIN'],
      );
      const automaticRefused = automaticEntries.find((entry) => entry.kind === 'PUSH_REFUSED')!;
      assert.match(
        automaticRefused.text,
        /Push refused · main moved 3 commits, 3 from outside the queue \(feat\(macos\): a window that reopens, fix\(web\): a table that scrolls, chore: a dependency bump\)/,
      );
      assert.ok(
        automaticEntries.indexOf(automaticRefused)
          < automaticEntries.findIndex((entry) => entry.kind === 'RECHECK_ON_MOVED_MAIN'),
      );
      const ownerSection = timeline.sections[3].entries;
      assert.deepEqual(
        ownerSection.map((entry) => entry.kind),
        ['ENQUEUED', 'CLAIMED', 'PUSH_REFUSED', 'RESULT', 'NEXT_GENERATION'],
      );
      // The owner's press is the candidate's current confirmation, drawn on the attempt it put on
      // the queue (the next generation after the refused push), signed with the person.
      const ownerConfirmation = timeline.sections[4].entries.find((entry) => entry.kind === 'CONFIRMATION')!;
      assert.equal(ownerConfirmation.actor?.type, 'OWNER');
      assert.equal(ownerConfirmation.actor?.userId, w.ownerId);
      // That next generation runs and its merge check goes red: the candidate is blocked, and a
      // blocked candidate is what leaves its round open for the later one below (a candidate still
      // in flight owns the round; M-F1/M-F4 do not offer a second one beside it).
      const nextGenerationLanding = await claimLanding(stack, w, 'lease-a-next', 'LAND_PROMOTION');
      await reportDirect(stack, w, nextGenerationLanding, promotionRed('1'.repeat(40)));
      // The promotion's current state is a subject-level fact about the candidate the newest
      // attempt names, never replayed history.
      const state = timeline.facts.find((fact) => fact.kind === 'PROMOTION_STATE')!;
      assert.equal((state.data as Record<string, unknown>).promotionId, promotionId);

      // A second candidate joins the open round with a generation 1 of its own. Sections are
      // numbered by their order within the subject, so its check is `Merge check · 3` — never a
      // second `Merge check · 1` under one heading.
      const successor = await doneTask(stack, w, 'timeline-round-successor');
      const successorLanding = await claimLanding(stack, w, 'lease-successor', 'LAND_TASK');
      assert.equal((await report(stack, w, successorLanding, { ...GREEN, checks: [GREEN_CHECK] })).accepted, true);
      const successorCheck = await claimLanding(stack, w, 'lease-successor-check', 'CHECK_PROMOTION');
      const successorSubject = await subjectOfJob(stack.db, successorCheck.jobId);
      assert.equal(successorSubject.landing.id, round.id, 'the later candidate joins the open round');
      assert.equal(successorSubject.job.generation, 1, 'its own per-candidate generation is 1');
      const numbered = await timelineOf(stack, w, round.sessionId);
      assert.deepEqual(numbered.sections.map((section) => section.title), [
        'Merge check · 1', 'Merge to main · 1', 'Merge check · 2', 'Merge to main · 2', 'Merge to main · 3',
        'Merge check · 3',
      ]);
      assert.ok(successor.taskId.length > 0);

      await assertNoLandingRunEvents(stack, round.sessionId);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── takeover and hand-back ────────────────────────────────────────────────────────────────────

test('a takeover and a stopped runner\'s hand-back are facts of their own', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'timeline-takeover');
    const task = await doneTask(stack, w, 'timeline-takeover');
    const first = await claimLanding(stack, w, 'lease-1', 'LAND_TASK');
    const { landing } = await subjectOfJob(stack.db, first.jobId);

    // The runner that held the claim went silent: its lease runs out and a new process takes it.
    await stack.db.projectIntegrationJob.update({
      where: { id: first.jobId },
      data: { heartbeatAt: new Date(Date.now() - 11 * 60_000) },
    });
    const takeover = await claimLanding(stack, w, 'lease-2', 'LAND_TASK');
    assert.equal(takeover.jobId, first.jobId);
    assert.equal(takeover.claimGeneration, '2');

    const events = await eventsOf(stack.db, first.jobId);
    const claimed = events.find((row) => row.kind === 'CLAIMED')!;
    assert.equal(claimed.claimGeneration, 1n);
    const taken = events.find((row) => row.kind === 'TAKEN_OVER')!;
    assert.equal(taken.claimGeneration, 2n);
    assert.match(taken.text, /Taken over by a new process on runner timeline-takeover-runner · claim 2/);

    // A stopping runner hands the claim it took back: the row keeps only claim + 1, and the line
    // says who gave it back and when.
    const released = await stack.jobs.release(first.jobId, w.runnerId, {
      claimGeneration: takeover.claimGeneration,
      leaseOwner: takeover.leaseOwner,
    }, w.ownerId);
    assert.deepEqual(released.answer, { released: true, state: 'QUEUED' });
    const releasedEvents = await eventsOf(stack.db, first.jobId);
    const releasedRow = releasedEvents.find((row) => row.kind === 'RELEASED')!;
    assert.equal(releasedRow.claimGeneration, 2n);
    assert.match(releasedRow.text, /Handed back by runner timeline-takeover-runner · claim 2/);

    const timeline = await timelineOf(stack, w, landing.sessionId);
    // J-T11 bumps the row's claim generation to the one a later claim will take, but nobody holds
    // it: the released attempt is back in the queue, and the timeline draws no claim for it.
    const releasedJob = await stack.db.projectIntegrationJob.findUniqueOrThrow({
      where: { id: first.jobId }, select: { state: true, claimGeneration: true },
    });
    assert.equal(releasedJob.state, 'QUEUED');
    assert.equal(releasedJob.claimGeneration, 3n);
    assert.deepEqual(
      timeline.sections[0].entries.map((entry) => entry.kind),
      ['ENQUEUED', 'CLAIMED', 'TAKEN_OVER', 'RELEASED'],
    );
    assert.equal(task.taskId.length > 0, true);
  } finally {
    await stack.db.$disconnect();
  }
});

// ── timeouts the row cannot tell apart ────────────────────────────────────────────────────────

test('a timeout ended by the candidate\'s recheck gate and by M-T13 says which door ended it',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      // (a) The candidate's recheck gate ends a silent check.
      const w = await world(stack, 'timeline-recheck');
      const task = await doneTask(stack, w, 'timeline-recheck');
      const landingJob = await claimLanding(stack, w, 'lease-1', 'LAND_TASK');
      assert.equal((await report(stack, w, landingJob, { ...GREEN, checks: [GREEN_CHECK] })).accepted, true);
      const check = await claimLanding(stack, w, 'lease-check', 'CHECK_PROMOTION');
      const { job: checkJob } = await subjectOfJob(stack.db, check.jobId);
      await stack.db.projectIntegrationJob.update({
        where: { id: check.jobId },
        data: { heartbeatAt: new Date(Date.now() - 11 * 60_000) },
      });
      await stack.openItems.retryPromotionCheckAsOwner(
        w.ownerId, w.projectId, checkJob.promotionId!, { reason: 'the runner stopped reporting' },
      );
      const recheckEvents = await eventsOf(stack.db, check.jobId);
      const recheckTimeout = recheckEvents.find((row) => row.kind === 'TIMED_OUT')!;
      assert.equal((recheckTimeout.data as Record<string, unknown>).cause, 'RECHECK');
      assert.match(recheckTimeout.text, /Timed out · no report for/);
      assert.equal(recheckTimeout.actorType, 'PLATFORM');
      // The timeout end moves the row's claim generation to the next one, which nobody ever took:
      // the attempt is drawn with the claim that was taken and the timeout, and no phantom claim.
      const recheckRound = (await subjectOfJob(stack.db, check.jobId)).landing;
      const recheckTimeline = await timelineOf(stack, w, recheckRound.sessionId);
      const recheckSection = recheckTimeline.sections.find((section) => section.jobId === check.jobId)!;
      assert.deepEqual(
        recheckSection.entries.map((entry) => entry.kind),
        ['ENQUEUED', 'CLAIMED', 'TIMED_OUT', 'RESULT_FALLBACK'],
      );
      assert.equal(task.taskId.length > 0, true);

      // (b) M-T13's retirement ends a silent check of a candidate whose work a receipt says landed.
      const main = await world(stack, 'timeline-m13', 'MAIN');
      const offered = await doneTask(stack, main, 'timeline-m13');
      const offeredCheck = await claimLanding(stack, main, 'lease-m13', 'CHECK_PROMOTION');
      assert.equal(offeredCheck.kind, 'CHECK_PROMOTION');
      const { job: offeredJob } = await subjectOfJob(stack.db, offeredCheck.jobId);
      await stack.db.projectIntegrationJob.update({
        where: { id: offeredCheck.jobId },
        data: { heartbeatAt: new Date(Date.now() - 11 * 60_000) },
      });
      await stack.receipts.record(main.ownerId, offered.sessionId, {
        result: 'MERGED',
        sourceSha: 'a'.repeat(40),
        targetBranch: 'main',
        targetShaBefore: 'c'.repeat(40),
        targetShaAfter: 'a'.repeat(40),
      }, 'AGENT');
      const promotion = await stack.db.projectPromotion.findUniqueOrThrow({
        where: { id: offeredJob.promotionId! }, select: { state: true },
      });
      assert.equal(promotion.state, 'SUPERSEDED');
      const m13Events = await eventsOf(stack.db, offeredCheck.jobId);
      const m13Timeout = m13Events.find((row) => row.kind === 'TIMED_OUT')!;
      assert.equal((m13Timeout.data as Record<string, unknown>).cause, 'M13');
      // Same shape at the other door: the retirement ends the attempt, and the generation it
      // bumps to was never claimed.
      const offeredRound = (await subjectOfJob(stack.db, offeredCheck.jobId)).landing;
      const m13Timeline = await timelineOf(stack, main, offeredRound.sessionId);
      const m13Section = m13Timeline.sections.find((section) => section.jobId === offeredCheck.jobId)!;
      assert.deepEqual(
        m13Section.entries.map((entry) => entry.kind),
        ['ENQUEUED', 'CLAIMED', 'TIMED_OUT', 'RESULT_FALLBACK'],
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── facts carry the claim and round they ended ──────────────────────────────────────────────

test('a stop or a timeout that ends round 2 is drawn after round 2\'s lines', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'timeline-round2');
    const stoppedTask = await doneTask(stack, w, 'timeline-round2-stop');
    const stopped = await claimLanding(stack, w, 'lease-stop', 'LAND_TASK');
    const { landing: stoppedLanding } = await subjectOfJob(stack.db, stopped.jobId);
    for (const round of [1, 2]) {
      assert.equal((await stack.api.integrationJobProgress({ id: w.runnerId }, stopped.jobId, {
        claimGeneration: stopped.claimGeneration,
        leaseOwner: stopped.leaseOwner,
        phase: 'CHECK',
        round,
      })).accepted, true);
    }
    assert.equal((await stack.openItems.stopTaskIntegrationAsOwner(
      w.ownerId, w.projectId, stoppedTask.taskId, undefined,
    )).state, 'CANCELLING');
    const [stopEvent] = (await eventsOf(stack.db, stopped.jobId)).filter((row) => row.kind === 'STOP_REQUESTED');
    assert.equal(stopEvent.claimGeneration, 1n);
    assert.equal(stopEvent.round, 2);
    const stoppedTimeline = await timelineOf(stack, w, stoppedLanding.sessionId);
    const stoppedEntries = stoppedTimeline.sections[0].entries;
    const roundTwo = stoppedEntries.findIndex((entry) => entry.kind === 'ROUND' && entry.round === 2);
    assert.ok(roundTwo >= 0);
    assert.equal(stoppedEntries[roundTwo].text, 'Round 2 of 3');
    assert.ok(stoppedEntries.findIndex((entry) => entry.kind === 'STOP_REQUESTED') > roundTwo);
    // The runner answers the ask, which frees the serial slot for the next case (J1).
    assert.equal((await report(stack, w, stopped, { state: 'CANCELLED', phase: 'CHECK', checks: [] })).accepted, true);

    // A timed-out landing is ended by the owner's rerun door; its TIMED_OUT line belongs to the
    // round it stopped in, not to round 0.
    const timedTask = await doneTask(stack, w, 'timeline-round2-timeout');
    const timed = await claimLanding(stack, w, 'lease-timeout', 'LAND_TASK');
    const { landing: timedLanding } = await subjectOfJob(stack.db, timed.jobId);
    for (const round of [1, 2]) {
      assert.equal((await stack.api.integrationJobProgress({ id: w.runnerId }, timed.jobId, {
        claimGeneration: timed.claimGeneration,
        leaseOwner: timed.leaseOwner,
        phase: 'CHECK',
        round,
      })).accepted, true);
    }
    await stack.db.projectIntegrationJob.update({
      where: { id: timed.jobId },
      data: { heartbeatAt: new Date(Date.now() - 11 * 60_000) },
    });
    await stack.ownerRetry.retryIntegration(
      { userId: w.ownerId, email: `${w.ownerId}@timeline.invalid` }, w.projectId, timedTask.taskId,
      { reason: 'the runner stopped reporting' },
    );
    const [timeoutEvent] = (await eventsOf(stack.db, timed.jobId)).filter((row) => row.kind === 'TIMED_OUT');
    assert.equal(timeoutEvent.round, 2);
    assert.equal(timeoutEvent.claimGeneration, 1n);
    const timedTimeline = await timelineOf(stack, w, timedLanding.sessionId);
    const timedEntries = timedTimeline.sections[0].entries;
    const timedRoundTwo = timedEntries.findIndex((entry) => entry.kind === 'ROUND' && entry.round === 2);
    assert.ok(timedRoundTwo >= 0);
    assert.ok(timedEntries.findIndex((entry) => entry.kind === 'TIMED_OUT') > timedRoundTwo);
  } finally {
    await stack.db.$disconnect();
  }
});

test('a merge check\'s ROUND line names no M: it has one round per claim', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'timeline-check-round');
    await doneTask(stack, w, 'timeline-check-round');
    const landingJob = await claimLanding(stack, w, 'lease-1', 'LAND_TASK');
    assert.equal((await report(stack, w, landingJob, { ...GREEN, checks: [GREEN_CHECK] })).accepted, true);
    const check = await claimLanding(stack, w, 'lease-check', 'CHECK_PROMOTION');
    assert.equal((await stack.api.integrationJobProgress({ id: w.runnerId }, check.jobId, {
      claimGeneration: check.claimGeneration,
      leaseOwner: check.leaseOwner,
      phase: 'CHECK',
      round: 1,
    })).accepted, true);
    const [round] = (await eventsOf(stack.db, check.jobId)).filter((row) => row.kind === 'ROUND');
    assert.equal(round.round, 1);
    assert.equal(round.text, 'Round 1');
  } finally {
    await stack.db.$disconnect();
  }
});

// ── answers asked too early are recorded ────────────────────────────────────────────────────

test('an answer asked before the work settled is recorded: requeued, or stopped and cancelled',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'timeline-too-early');
      const task = await doneTask(stack, w, 'timeline-too-early');
      const first = await claimLanding(stack, w, 'lease-1', 'LAND_TASK');
      const { landing } = await subjectOfJob(stack.db, first.jobId);
      // The work session finishes AFTER the claim: the answer is about a branch that could still
      // move, and the relay neither writes it down nor leaves the attempt without a line.
      const early = (): Failure => ({
        state: 'ALREADY_LANDED', phase: 'FETCH', sourceSha: 'b'.repeat(40),
        targetShaBefore: 'c'.repeat(40), testedSha: 'd'.repeat(40), testedTreeSha: 'e'.repeat(40), checks: [],
      });
      await stack.db.session.update({
        where: { id: task.sessionId },
        data: { finishedAt: new Date(Date.now() + 1_000), worktreeBranch: task.branch },
      });
      const requeued = await report(stack, w, first, early());
      assert.equal(requeued.accepted, true);
      assert.equal(requeued.state, 'QUEUED');
      const [requeuedEvent] = (await eventsOf(stack.db, first.jobId)).filter((row) => row.kind === 'REQUEUED');
      assert.equal(requeuedEvent.claimGeneration, 1n);
      assert.match(requeuedEvent.text, /Sent back to the queue/);

      // The same attempt claimed again, then stopped: the too-early answer ends it CANCELLED, and
      // the cancellation is the door's own fact.
      const second = await claimLanding(stack, w, 'lease-2', 'LAND_TASK');
      assert.equal(second.jobId, first.jobId);
      assert.equal((await stack.openItems.stopTaskIntegrationAsOwner(
        w.ownerId, w.projectId, task.taskId, undefined,
      )).state, 'CANCELLING');
      await stack.db.session.update({
        where: { id: task.sessionId },
        data: { finishedAt: new Date(Date.now() + 2_000) },
      });
      const cancelled = await report(stack, w, second, early());
      assert.equal(cancelled.accepted, true);
      assert.equal(cancelled.state, 'CANCELLED');
      const [cancelledEvent] = (await eventsOf(stack.db, first.jobId)).filter((row) => row.kind === 'CANCELLED');
      assert.equal(cancelledEvent.claimGeneration, 2n);
      // This attempt ran and answered; only the queued generation is "cancelled before it ran".
      assert.match(cancelledEvent.text, /cancelled when the answer came back/);
      await assertNoLandingRunEvents(stack, landing.sessionId);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a candidate check that answered before its task work settled goes back to the queue',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'timeline-check-too-early');
      const task = await doneTask(stack, w, 'timeline-check-too-early');
      const landingJob = await claimLanding(stack, w, 'lease-1', 'LAND_TASK');
      assert.equal((await report(stack, w, landingJob, { ...GREEN, checks: [GREEN_CHECK] })).accepted, true);
      const check = await claimLanding(stack, w, 'lease-check', 'CHECK_PROMOTION');
      const { landing: round } = await subjectOfJob(stack.db, check.jobId);
      // The work the candidate is about finishes AFTER the check was claimed: the tip it resolves
      // could still move, so its READY is the same question asked too early.
      await stack.db.session.update({
        where: { id: task.sessionId },
        data: { finishedAt: new Date(Date.now() + 1_000) },
      });
      const early = await report(stack, w, check, promotionReady('1'.repeat(40)));
      assert.equal(early.accepted, true);
      assert.equal(early.state, 'QUEUED');
      const [requeued] = (await eventsOf(stack.db, check.jobId)).filter((row) => row.kind === 'REQUEUED');
      assert.equal(requeued.claimGeneration, 1n);
      assert.match(requeued.text, /Sent back to the queue/);
      const checkSection = (await timelineOf(stack, w, round.sessionId)).sections
        .find((section) => section.jobId === check.jobId)!;
      assert.deepEqual(checkSection.entries.map((entry) => entry.kind), ['ENQUEUED', 'CLAIMED', 'REQUEUED']);
      await assertNoLandingRunEvents(stack, round.sessionId);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── a claim whose backfill never landed ─────────────────────────────────────────────────────

test('a claim whose backfill was lost is still drawn from the committed job row', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'timeline-claim-fallback');
    const task = await doneTask(stack, w, 'timeline-claim-fallback');
    const realJob = await stack.db.projectIntegrationJob.findFirstOrThrow({
      where: { taskId: task.taskId, kind: 'LAND_TASK' }, select: { id: true, landingId: true },
    });
    const { landing } = await subjectOfJob(stack.db, realJob.id);
    // The real generation is stopped (a queued generation ends CANCELLED on the spot), leaving the
    // task with no in-flight landing to collide with the fixture below.
    await stack.openItems.stopTaskIntegrationAsOwner(w.ownerId, w.projectId, task.taskId, undefined);
    // A claimed attempt whose CLAIMED fact never made it to the ledger — the after-commit backfill
    // can fail, and this is the row it leaves. No event row is inserted for it here.
    const codebase = await stack.db.projectCodebase.findFirstOrThrow({
      where: { projectId: w.projectId }, select: { id: true, integrationRef: true, upstreamRef: true },
    });
    const claimedJobId = randomUUID();
    await stack.db.projectIntegrationJob.create({
      data: {
        id: claimedJobId,
        projectId: w.projectId,
        ownerId: w.ownerId,
        codebaseId: codebase.id,
        kind: 'LAND_TASK',
        generation: 2,
        taskId: task.taskId,
        sessionId: task.sessionId,
        landingId: landing.id,
        serialKey: `fixture:claim-fallback:${claimedJobId}`,
        targetRef: codebase.integrationRef,
        upstreamRef: codebase.upstreamRef,
        sourceRef: `refs/heads/${task.branch}`,
        state: 'RUNNING',
        runnerId: w.runnerId,
        claimedAt: new Date(),
        heartbeatAt: new Date(),
        claimGeneration: 1n,
        idempotencyKey: `fixture:claim-fallback:${claimedJobId}`,
      },
    });
    const timeline = await timelineOf(stack, w, landing.sessionId);
    const section = timeline.sections.find((row) => row.jobId === claimedJobId)!;
    const claim = section.entries.find((entry) => entry.kind === 'CLAIMED' || entry.kind === 'TAKEN_OVER')!;
    assert.equal(claim.id, null, 'the line is derived from the row, not stored');
    assert.equal(claim.claim, 1);
    assert.equal(claim.actor?.type, 'RUNNER');
    assert.match(claim.text, /Claimed by runner timeline-claim-fallback-runner · claim 1/);
    await assertNoLandingRunEvents(stack, landing.sessionId);
  } finally {
    await stack.db.$disconnect();
  }
});

// ── a truncated subject ──────────────────────────────────────────────────────────────────────

test('a subject with more attempts than the timeline lists numbers its sections by their real attempt',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'timeline-truncated');
      const task = await doneTask(stack, w, 'timeline-truncated');
      const realJob = await stack.db.projectIntegrationJob.findFirstOrThrow({
        where: { taskId: task.taskId, kind: 'LAND_TASK' }, select: { id: true, createdAt: true },
      });
      const { landing } = await subjectOfJob(stack.db, realJob.id);
      // The real generation is stopped so it ends CANCELLED, like the fixture attempts after it.
      await stack.openItems.stopTaskIntegrationAsOwner(w.ownerId, w.projectId, task.taskId, undefined);
      // More attempts than the timeline lists. This case inserts the later generations straight
      // into the queue on purpose: a queue reaches forty-five attempts only through forty-four
      // reruns, and the section numbering past the cut is what has to be proven, not the reruns.
      // Each is queued a second after the one before, so the subject's order is the insert order.
      const codebase = await stack.db.projectCodebase.findFirstOrThrow({
        where: { projectId: w.projectId }, select: { id: true, integrationRef: true, upstreamRef: true },
      });
      const total = MAX_TIMELINE_SECTIONS + 5;
      await stack.db.projectIntegrationJob.createMany({
        data: Array.from({ length: total - 1 }, (_, index) => {
          const id = randomUUID();
          return {
            id,
            projectId: w.projectId,
            ownerId: w.ownerId,
            codebaseId: codebase.id,
            kind: 'LAND_TASK',
            generation: index + 2,
            taskId: task.taskId,
            sessionId: task.sessionId,
            landingId: landing.id,
            serialKey: `fixture:truncated:${id}`,
            targetRef: codebase.integrationRef,
            upstreamRef: codebase.upstreamRef,
            sourceRef: `refs/heads/${task.branch}`,
            state: 'CANCELLED',
            finishedAt: new Date(realJob.createdAt.getTime() + (index + 1) * 1_000),
            idempotencyKey: `fixture:truncated:${id}`,
            createdAt: new Date(realJob.createdAt.getTime() + (index + 1) * 1_000),
          };
        }),
      });
      const timeline = await timelineOf(stack, w, landing.sessionId);
      assert.equal(timeline.truncated, true);
      assert.equal(timeline.sections.length, MAX_TIMELINE_SECTIONS);
      // The newest attempts are listed, each numbered by its place among ALL the subject's attempts:
      // the first listed is attempt 6 of 45, and the newest is attempt 45, not a renumbered 40.
      assert.equal(timeline.sections[0].title, `Generation ${total - MAX_TIMELINE_SECTIONS + 1}`);
      assert.equal(timeline.sections.at(-1)!.title, `Generation ${total}`);
      assert.deepEqual(
        timeline.sections.map((section) => section.title),
        Array.from({ length: MAX_TIMELINE_SECTIONS },
          (_, index) => `Generation ${total - MAX_TIMELINE_SECTIONS + 1 + index}`),
      );
      assert.equal(timeline.sections.at(-1)!.generation, total);
      await assertNoLandingRunEvents(stack, landing.sessionId);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── the owner's stop and abandon ─────────────────────────────────────────────────────────────

test('the owner\'s stop and abandon are signed, and a queued stop says it never ran',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'timeline-stop');
      // A QUEUED generation: stopped and cancelled in one transaction.
      const queuedTask = await doneTask(stack, w, 'timeline-stop-queued');
      const queuedJob = await stack.db.projectIntegrationJob.findFirstOrThrow({
        where: { taskId: queuedTask.taskId, kind: 'LAND_TASK' }, select: { id: true },
      });
      const stopped = await stack.openItems.stopTaskIntegrationAsOwner(
        w.ownerId, w.projectId, queuedTask.taskId, undefined,
      );
      assert.equal(stopped.state, 'CANCELLED');
      const cancelled = await eventsOf(stack.db, queuedJob.id);
      const cancelledRow = cancelled.find((row) => row.kind === 'CANCELLED')!;
      assert.equal(cancelledRow.actorType, 'OWNER');
      assert.equal(cancelledRow.actorUserId, w.ownerId);
      assert.match(cancelledRow.text, /Stopped · cancelled before it ran/);

      // A RUNNING generation inside its lease: asked, not claimed as ended.
      const runningTask = await doneTask(stack, w, 'timeline-stop-running');
      const running = await claimLanding(stack, w, 'lease-running', 'LAND_TASK');
      assert.equal((await stack.openItems.stopTaskIntegrationAsOwner(
        w.ownerId, w.projectId, runningTask.taskId, undefined,
      )).state, 'CANCELLING');
      const asked = (await eventsOf(stack.db, running.jobId)).find((row) => row.kind === 'STOP_REQUESTED')!;
      assert.equal(asked.actorType, 'OWNER');
      assert.equal(asked.actorUserId, w.ownerId);
      assert.match(asked.text, /Stop requested · claim 1/);
      // The runner reads the ask and answers CANCELLED, which frees the serial slot (J1).
      assert.equal((await report(stack, w, running, {
        state: 'CANCELLED', phase: 'FETCH', checks: [],
      })).accepted, true);

      // An abandoned generation: the platform ends work nobody is reporting, and the line says who.
      const abandonedTask = await doneTask(stack, w, 'timeline-abandon');
      const abandoned = await claimLanding(stack, w, 'lease-abandon', 'LAND_TASK');
      await stack.db.projectIntegrationJob.update({
        where: { id: abandoned.jobId },
        data: { heartbeatAt: new Date(Date.now() - 11 * 60_000) },
      });
      await stack.jobs.abandon({
        jobId: abandoned.jobId,
        projectId: w.projectId,
        ownerId: w.ownerId,
        by: 'owner',
        reason: 'the machine is gone for the day',
      });
      const abandonedEvents = await eventsOf(stack.db, abandoned.jobId);
      const abandonedRow = abandonedEvents.find((row) => row.kind === 'ABANDONED')!;
      assert.equal(abandonedRow.actorType, 'OWNER');
      assert.equal(abandonedRow.actorUserId, w.ownerId);
      assert.equal(abandonedRow.reason, 'the machine is gone for the day');
      assert.match(abandonedRow.text, /Abandoned by the owner · the machine is gone for the day/);
      assert.ok(abandonedEvents.some((row) => row.kind === 'RESULT'
        && (row.data as Record<string, unknown>).abandoned === true));
      // J-T10's abandonment carries the same limitSeconds a timeout does, but it is a decision
      // somebody took — the timeline draws the abandon line and never a timeout on top of it.
      assert.equal(abandonedEvents.some((row) => row.kind === 'TIMED_OUT'), false);
      const abandonedTimeline = await timelineOf(
        stack, w, (await subjectOfJob(stack.db, abandoned.jobId)).landing.sessionId,
      );
      // The abandon's CAS moves the claim generation to the next one, which nobody took: the
      // attempt is drawn with the claim that ran, the answer it never gave, who it was handed to
      // and the abandon — and no phantom claim on the generation the row now names.
      const abandonedSection = abandonedTimeline.sections.find(
        (section) => section.jobId === abandoned.jobId,
      )!;
      assert.deepEqual(
        abandonedSection.entries.map((entry) => entry.kind),
        ['ENQUEUED', 'CLAIMED', 'RESULT', 'HANDED_TO', 'ABANDONED'],
      );
      assert.equal(abandonedTimeline.sections.some(
        (section) => section.entries.some((entry) => entry.kind === 'TIMED_OUT'),
      ), false);
      assert.equal(abandonedTask.taskId.length > 0, true);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── the runner read's timeline page ─────────────────────────────────────────────────────────

test('the runner read pages one attempt\'s timeline by claim and round, and continues by cursor',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'timeline-page');
      const task = await doneTask(stack, w, 'timeline-page');
      const job = await stack.db.projectIntegrationJob.findFirstOrThrow({
        where: { taskId: task.taskId, kind: 'LAND_TASK' }, select: { id: true },
      });
      // More facts than a page holds, so the continuation is exercised. This case inserts them
      // straight into the ledger on purpose: a queue produces a handful per attempt, and the page
      // size is what has to be proven, not the queue.
      await stack.db.projectIntegrationJobEvent.createMany({
        data: Array.from({ length: 150 }, (_, index) => ({
          jobId: job.id,
          key: `page-fixture:${index}`,
          kind: 'STEP',
          claimGeneration: index < 105 ? 1n : 2n,
          round: 1,
          phase: 'FETCH',
          text: `Fixture line ${index}`,
        })),
      });
      const prisma = stack.db as unknown as PrismaService;
      const project = await stack.db.project.findUniqueOrThrow({
        where: { id: w.projectId }, select: { title: true, exceptionEscalationSeconds: true },
      });
      const first = await readProjectIntegrationRead(
        prisma, { id: w.projectId, title: project.title, exceptionEscalationSeconds: project.exceptionEscalationSeconds },
        { jobId: job.id, claim: 1 },
      );
      assert.ok(first.timeline);
      assert.equal(first.timeline!.entries.length, 100, 'one page holds a hundred facts');
      assert.ok(first.timeline!.nextCursor);
      assert.ok(first.timeline!.entries.every((entry) => entry.claim === 1));
      // A fact appended after the first page, with an older `at` than every line on it: continuing
      // on the instant would starve it for ever, so the page continues on the ledger's sequence and
      // it must be served.
      await stack.db.projectIntegrationJobEvent.create({
        data: {
          jobId: job.id,
          key: 'page-backdated',
          kind: 'CHECK_STARTED',
          claimGeneration: 1n,
          round: 1,
          checkName: 'MERGE_CHECK',
          checkIndex: 1,
          phase: 'CHECK',
          text: 'Backdated line',
          at: new Date(Date.now() - 3_600_000),
        },
      });
      const second = await readProjectIntegrationRead(
        prisma, { id: w.projectId, title: project.title, exceptionEscalationSeconds: project.exceptionEscalationSeconds },
        { jobId: job.id, claim: 1, timelineCursor: first.timeline!.nextCursor! },
      );
      assert.equal(second.timeline!.entries.length, 6);
      assert.ok(second.timeline!.entries.some((entry) => entry.text === 'Backdated line'),
        'a fact appended after the page is served by the next one, whatever its instant');
      assert.equal(second.timeline!.nextCursor, null);
      const claimTwo = await readProjectIntegrationRead(
        prisma, { id: w.projectId, title: project.title, exceptionEscalationSeconds: project.exceptionEscalationSeconds },
        { jobId: job.id, claim: 2, round: 1 },
      );
      assert.equal(claimTwo.timeline!.entries.length, 45);
      assert.ok(claimTwo.timeline!.entries.every((entry) => entry.claim === 2 && entry.round === 1));
      // Round 0 is the narrowing that names the facts with no round — the enqueue — the way the
      // sort places them.
      const roundZero = await readProjectIntegrationRead(
        prisma, { id: w.projectId, title: project.title, exceptionEscalationSeconds: project.exceptionEscalationSeconds },
        { jobId: job.id, round: 0 },
      );
      assert.equal(roundZero.timeline!.entries.length, 1);
      assert.equal(roundZero.timeline!.entries[0].kind, 'ENQUEUED');
      assert.equal(roundZero.timeline!.entries[0].round, null);
      // The page echo carries the continuation the caller passed.
      assert.equal(second.pagination.timelineCursor, first.timeline!.nextCursor);
    } finally {
      await stack.db.$disconnect();
    }
  });
