/**
 * A DONE task's newest LAND_TASK on real PostgreSQL, as the task's page (`GET /tasks/:id`), the
 * project's task rows (`GET /projects/:id/tasks`) and the project's integration view
 * (`GET /projects/:id/integration`) read it (docs/project-integration-line-contract.md §2.7a).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-task-integration.pg.spec.ts
 *
 * WHY THROUGH THE DOORS. A task is DONE well before its work is on the line: the landing queues,
 * waits, runs and lands or stops, and until this read nothing on either page said which — or why a
 * queued landing was not moving (2026-10-03: a generation sat QUEUED behind another task's open
 * MAIN_SYNC conflict and read as a stalled project). So every transition here is made the way the
 * product makes it: the DONE enqueues through the task's own acceptance, the runner's heartbeat
 * claims (and refuses to claim), the progress route moves the phase, and the result route lands,
 * fails or conflicts. Each queue reason is asserted beside the claim it explains — a reason the
 * claim does not agree with would be a story, not a reason. The task stays DONE throughout.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
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
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  RunEventType,
  RunStatus as SharedRunStatus,
  type TaskIntegrationView,
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
import { ProjectAcceptanceService } from './project-acceptance.service';
import { INTEGRATION_JOB_CLAIM } from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { readTaskIntegrationViews } from './project-task-integration';
import { ProjectsService } from './projects.service';

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
  projects: ProjectsService;
  api: RunnerApiController;
}

/** The runner routes and the two page services over one client, as production wires them. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  // Every realtime call is a no-op that answers like an empty drain, which is what the heartbeat
  // reads back from the ones it drains.
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
  return { db, tasks, projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma)), api };
}

interface World {
  ownerId: string;
  runnerId: string;
  runnerName: string;
  workspaceId: string;
  projectId: string;
  lease: string;
}

/** One project landing on a branch of its own (§1.2), worked on one runner's checkout. */
async function world(stack: Stack, label: string): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const runnerName = `${label}-runner`;
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@land-task.invalid`, name: label, passwordHash: 'x' },
  });
  // A runner whose process has not yet beaten with a lease or declared integration jobs.
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: runnerName,
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
  // Coordinated from that workspace, whose remote is the repository the line lands in; with the
  // owner's Automatic off, so a stop is handed to the owner rather than to a conversation.
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: 'every finished task reaches the line',
      coordinatorEnabled: false,
      coordinatorWorkspaceId: workspaceId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId,
    projectId,
    settings: { line: 'PROJECT_BRANCH' },
  }));
  return { ownerId, runnerId, runnerName, workspaceId, projectId, lease: randomUUID() };
}

interface Done {
  taskId: string;
  title: string;
  sessionId: string;
}

/** The engine's reply to a turn it ran, up the door the runner posts its transcript to. */
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

/**
 * One code task carried to DONE by its own acceptance command — which queues its landing in the
 * same transaction (§2.3 J-T1a). `finished` is whether the runner has finished the work session
 * (SR13); until it has, the branch can still move and the claim holds the landing back.
 */
async function doneTask(stack: Stack, w: World, label: string, finished = true): Promise<Done> {
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
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, { turnId, status: SharedRunStatus.SUCCEEDED });
  const acceptance = await (stack.api as unknown as {
    dequeueTurn: (sessionId: string, runnerId: string, lease: string | null) =>
      Promise<{ turnId: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, w.runnerId, null);
  assert.equal(acceptance?.taskAcceptance, true, 'the acceptance command was queued for this task');
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId: acceptance!.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  assert.equal(await taskStatus(stack.db, declared.id), TaskStatus.DONE, 'the acceptance command agreed');
  if (finished) await finishWork(stack, sessionId, branch);
  return { taskId: declared.id, title, sessionId };
}

/** The runner finishing the work session: it commits the worktree and reports where HEAD ended. */
async function finishWork(stack: Stack, sessionId: string, branch?: string) {
  const session = await stack.db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { branch: true } });
  await stack.db.session.update({
    where: { id: sessionId },
    data: { finishedAt: new Date(), worktreeBranch: branch ?? session.branch, worktreeDirty: false },
  });
}

/** The runner's heartbeat, which is also how it claims integration jobs (§2.3 J-T2). */
async function beat(
  stack: Stack,
  w: World,
  opts: { capable?: boolean; draining?: boolean } = {},
): Promise<IntegrationJobCommand[]> {
  const answer = await stack.api.heartbeat(
    { id: w.runnerId, version: null },
    { status: 'ONLINE', idleCapacity: 1, leaseOwner: w.lease, draining: opts.draining ?? false } as never,
    opts.capable === false ? undefined : INTEGRATION_JOB_CLAIM,
  );
  return (answer.integrationJobs ?? []).filter((job) => job.kind === 'LAND_TASK');
}

type Result = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

/** The result a runner posts, over the route it posts it on. */
async function report(stack: Stack, w: World, job: IntegrationJobCommand, result: Result) {
  const answer = await stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
  assert.equal(answer.accepted, true, `the result route refused ${result.state}`);
}

const LANDED: Result = {
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

const RED_MERGE_CHECK: Result = {
  state: 'CHECK_FAILED',
  phase: 'CHECK',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'c'.repeat(40),
  testedSha: 'd'.repeat(40),
  testedTreeSha: 'e'.repeat(40),
  checks: [{
    name: 'MERGE_CHECK',
    command: 'npm test',
    expectedExitCode: 0,
    exitCode: 1,
    timedOut: false,
    durationMs: 61_000,
    outputTail: 'not ok 1 - a red the combined tree found',
  }],
};

const SYNC_CONFLICT: Result = {
  state: 'CONFLICT',
  phase: 'MAIN_SYNC',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'c'.repeat(40),
  upstreamSha: 'f'.repeat(40),
  conflicts: ['src/shared/src/project-progress.ts', 'src/web/src/index.css'],
};

async function taskStatus(db: PrismaClient, taskId: string): Promise<TaskStatus> {
  return (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } })).status;
}

/** Clocks that move between two reads: a queued wait and a running check. */
function settled(view: TaskIntegrationView<Date>) {
  return {
    ...view,
    checksRunningForMs: view.checksRunningForMs === null ? null : 'live',
    landTask: view.landTask
      ? { ...view.landTask, waitMs: view.landTask.state === 'QUEUED' ? 'live' : view.landTask.waitMs }
      : view.landTask,
  };
}

/**
 * The task through all three reads: the task's page, the project's task rows and — when the task
 * is one of its current landings — the integration view. They must agree to the field, and the
 * task's own status must still be DONE. Returns the task page's answer.
 */
async function read(stack: Stack, w: World, task: Done): Promise<TaskIntegrationView<Date>> {
  const detail = await stack.tasks.get(w.ownerId, task.taskId) as {
    status: string; integration: TaskIntegrationView<Date>;
  };
  const page = await stack.projects.taskPage(w.ownerId, w.projectId);
  const row = page.items.find((item) => item.id === task.taskId);
  assert.ok(row, 'the task is on its project page');
  assert.equal(detail.status, 'DONE', 'a landing never changes the task status');
  assert.equal(row.status, 'DONE');
  assert.deepEqual(settled(row.integration), settled(detail.integration), 'the task rows and the task page agree');
  const line = await stack.projects.integration(w.ownerId, w.projectId);
  const current = line.landTasks?.find((entry) => entry.taskId === task.taskId);
  if (current) {
    assert.equal(current.taskTitle, task.title);
    assert.deepEqual(settled(current.integration), settled(detail.integration), 'the integration view and the task page agree');
  }
  return detail.integration;
}

/** The integration view's current landings, as (title, newest state) pairs in its order. */
async function currentLandings(stack: Stack, w: World): Promise<Array<[string, string | undefined]>> {
  const line = await stack.projects.integration(w.ownerId, w.projectId);
  assert.ok(line.landTasks, 'this server describes the current landings');
  return line.landTasks.map((entry) => [entry.taskTitle, entry.integration.landTask?.state]);
}

test('a DONE task’s landing through the heartbeat and result routes: every queue reason the claim agrees with, then RUNNING, LANDED and CHECK_FAILED on all three pages',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'land-path');

      // ── QUEUED, and why ───────────────────────────────────────────────────────────────────
      const first = await doneTask(stack, w, 'first');
      const queued = await read(stack, w, first);
      assert.equal(queued.state, 'QUEUED');
      const job = queued.landTask!;
      assert.equal(job.state, 'QUEUED');
      assert.equal(job.generation, '1');
      assert.equal(job.phase, null);
      const codebase = await stack.db.projectCodebase.findFirstOrThrow({
        where: { projectId: w.projectId }, select: { integrationRef: true },
      });
      assert.equal(job.targetRef, codebase.integrationRef, 'the target is the ref the job froze from the line');
      assert.match(job.targetRef, /^refs\/heads\/project\//);
      assert.equal(job.startedAt, null);
      assert.equal(job.heartbeatAt, null);
      assert.equal(job.finishedAt, null);
      assert.ok(job.waitMs >= 0 && job.waitMs <= Date.now() - job.queuedAt.getTime());
      // The runner row was written by a process with no lease and no integration capability.
      assert.deepEqual(job.blockingReason, {
        code: 'WAITING_RUNNER',
        summary: `Waiting for runner ${w.runnerName}: its version does not take integration jobs`,
      });
      assert.deepEqual(await beat(stack, w, { capable: false }), [], 'an incapable heartbeat claims nothing');
      assert.equal((await read(stack, w, first)).landTask?.blockingReason?.code, 'WAITING_RUNNER');

      assert.deepEqual(await beat(stack, w, { draining: true }), [], 'a draining heartbeat claims nothing');
      assert.equal((await read(stack, w, first)).landTask?.blockingReason?.summary,
        `Waiting for runner ${w.runnerName}: it is draining and takes no new jobs`);

      await stack.db.runner.update({ where: { id: w.runnerId }, data: { status: RunnerStatus.OFFLINE } });
      assert.equal((await read(stack, w, first)).landTask?.blockingReason?.summary,
        `Waiting for runner ${w.runnerName}: it is offline`);
      // ONLINE on the row but silent past the session queue's threshold reads offline as well.
      await stack.db.runner.update({
        where: { id: w.runnerId },
        data: { status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(Date.now() - 5 * 60_000) },
      });
      assert.equal((await read(stack, w, first)).landTask?.blockingReason?.summary,
        `Waiting for runner ${w.runnerName}: it is offline`);
      await stack.db.workspace.update({ where: { id: w.workspaceId }, data: { runnerId: null } });
      assert.equal((await read(stack, w, first)).landTask?.blockingReason?.summary,
        'Waiting for a runner: the work’s workspace has no runner to land it');
      await stack.db.workspace.update({ where: { id: w.workspaceId }, data: { runnerId: w.runnerId } });

      // A second task whose work session is still open: the claim leaves it alone.
      const second = await doneTask(stack, w, 'second', false);
      const held = (await read(stack, w, second)).landTask!;
      assert.equal(held.state, 'QUEUED');
      assert.deepEqual(held.blockingReason, {
        code: 'WAITING_TASK_WORK',
        summary: 'Waiting to land: the task’s work session is still running, and its branch can still move',
      });

      // ── RUNNING ───────────────────────────────────────────────────────────────────────────
      // A capable, leased beat claims the first — and only the first: the second's work is open.
      const claimed = await beat(stack, w);
      assert.deepEqual(claimed.map((c) => c.jobId), [job.jobId], 'the claim took exactly what the reasons said it could');
      const running = await read(stack, w, first);
      assert.equal(running.state, 'RUNNING');
      const runningJob = running.landTask!;
      assert.equal(runningJob.state, 'RUNNING');
      assert.equal(runningJob.phase, 'FETCH');
      assert.ok(runningJob.startedAt && runningJob.heartbeatAt);
      assert.equal(runningJob.blockingReason, null);
      assert.equal(runningJob.waitMs, runningJob.startedAt.getTime() - runningJob.queuedAt.getTime(),
        'the queue wait stops at the claim');
      assert.equal(running.checksRunningForMs, null, 'fetching is not checking');
      assert.equal((await read(stack, w, second)).landTask?.blockingReason?.code, 'WAITING_TASK_WORK',
        'an open work session is named before the busy branch');

      // The second's work finishes: now only the running landing on the same branch holds it.
      await finishWork(stack, second.sessionId);
      const serial = (await read(stack, w, second)).landTask!;
      assert.deepEqual(serial.blockingReason, {
        code: 'WAITING_SERIAL_SLOT',
        summary: `Waiting to land: the landing of “${first.title}” is running on this branch first`,
        jobId: job.jobId,
      });
      assert.deepEqual(await beat(stack, w), [], 'the busy branch is not claimed twice');

      const progress = await stack.api.integrationJobProgress({ id: w.runnerId }, job.jobId, {
        claimGeneration: claimed[0]!.claimGeneration,
        leaseOwner: claimed[0]!.leaseOwner,
        phase: 'CHECK',
      });
      assert.deepEqual(progress, { accepted: true });
      const checking = await read(stack, w, first);
      assert.equal(checking.landTask?.phase, 'CHECK');
      assert.notEqual(checking.checksRunningForMs, null);
      assert.ok(checking.landTask!.heartbeatAt!.getTime() >= runningJob.heartbeatAt!.getTime());

      // ── LANDED ────────────────────────────────────────────────────────────────────────────
      await report(stack, w, claimed[0]!, LANDED);
      const landed = await read(stack, w, first);
      assert.equal(landed.state, 'ON_INTEGRATION_LINE', 'the receipt says where the work is');
      assert.equal(landed.landTask?.state, 'LANDED');
      assert.equal(landed.landTask?.generation, '1');
      assert.equal(landed.landTask?.blockingReason, null);
      assert.ok(landed.landTask?.finishedAt);
      assert.equal(landed.landTask?.waitMs, runningJob.waitMs, 'a finished attempt keeps the wait it had');

      // Nothing holds the second any more but the next heartbeat.
      assert.deepEqual((await read(stack, w, second)).landTask?.blockingReason, {
        code: 'WAITING_DISPATCH',
        summary: `Waiting to land: next for runner ${w.runnerName}, which claims it on its next heartbeat`,
      });
      assert.deepEqual(await currentLandings(stack, w), [[second.title, 'QUEUED'], [first.title, 'LANDED']],
        'the queue first, then the last landing');

      // ── CHECK_FAILED ──────────────────────────────────────────────────────────────────────
      const next = await beat(stack, w);
      assert.equal(next.length, 1);
      assert.equal((await read(stack, w, second)).landTask?.state, 'RUNNING');
      await report(stack, w, next[0]!, RED_MERGE_CHECK);
      const red = await read(stack, w, second);
      assert.equal(red.state, 'CHECK_FAILED', 'the exception item still decides the row');
      assert.ok(red.openItemId);
      assert.equal(red.landTask?.state, 'CHECK_FAILED');
      assert.equal(red.landTask?.phase, 'CHECK');
      assert.deepEqual(red.landTask?.blockingReason, {
        code: 'CHECK_FAILED',
        summary: 'Checks failed on the combined tree: the merge check exited 1 (expected 0)',
      });
      assert.deepEqual(await currentLandings(stack, w), [[second.title, 'CHECK_FAILED'], [first.title, 'LANDED']],
        'a stop stays current beside the last landing, not only as an exception card');

      // A stop that a later receipt settled (the work merged another way) is history.
      await stack.db.sessionMergeReceipt.create({
        data: {
          ownerId: w.ownerId,
          projectId: w.projectId,
          taskId: second.taskId,
          sessionId: second.sessionId,
          result: 'MERGED',
          sourceBranch: 'orbit/second',
          sourceSha: 'a'.repeat(40),
          targetBranch: codebase.integrationRef!.replace(/^refs\/heads\//, ''),
          targetShaAfter: 'd'.repeat(40),
          recordedBy: 'RUNNER',
          idempotencyKey: `hand-merge:${second.taskId}`,
        },
      });
      const merged = await read(stack, w, second);
      assert.equal(merged.state, 'ON_INTEGRATION_LINE');
      assert.equal(merged.landTask?.state, 'CHECK_FAILED', 'the attempt itself is not rewritten');
      assert.deepEqual(await currentLandings(stack, w), [[first.title, 'LANDED']]);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an open MAIN_SYNC conflict holds the next landing as a project-line sync, exempts the conflicted task’s own next generation, and lets go when that lands',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'land-sync');
      await beat(stack, w);

      const conflicted = await doneTask(stack, w, 'conflicted');
      const claimed = await beat(stack, w);
      assert.equal(claimed.length, 1);
      await report(stack, w, claimed[0]!, SYNC_CONFLICT);
      const stopped = await read(stack, w, conflicted);
      assert.equal(stopped.state, 'CONFLICT');
      assert.ok(stopped.openItemId, 'the conflict opened its item');
      assert.equal(stopped.landTask?.phase, 'MAIN_SYNC');
      assert.deepEqual(stopped.landTask?.blockingReason, {
        code: 'CONFLICT',
        summary: 'Stopped at a conflict: upstream could not be merged into the target branch (2 conflicting files)',
      });

      // Another task's landing on the same branch waits for the line, and says on whose conflict.
      const later = await doneTask(stack, w, 'later');
      const waiting = (await read(stack, w, later)).landTask!;
      assert.deepEqual(waiting.blockingReason, {
        code: 'WAITING_MAIN_SYNC',
        summary: `Waiting for the project line to sync: the landing of “${conflicted.title}” could not merge upstream into this branch, and its conflict is still open`,
        jobId: claimed[0]!.jobId,
        openItemId: stopped.openItemId,
      });
      assert.deepEqual(await beat(stack, w), [], 'M2: the claim holds it too');

      // A cancel asked of it is named first: the claim skips a cancelled job whatever else holds it.
      await stack.db.projectIntegrationJob.update({ where: { id: waiting.jobId }, data: { cancelRequestedAt: new Date() } });
      assert.equal((await read(stack, w, later)).landTask?.blockingReason?.code, 'CANCELLING');
      await stack.db.projectIntegrationJob.update({ where: { id: waiting.jobId }, data: { cancelRequestedAt: null } });

      // The conflicted task's own next generation — the one carrying the absorb (§3.1 M3) — is
      // exempt from its own item: queued as the reopen route queues it, it is next for the runner.
      const first = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: claimed[0]!.jobId } });
      const regenerated = await stack.db.projectIntegrationJob.create({
        data: {
          ownerId: first.ownerId,
          projectId: first.projectId,
          codebaseId: first.codebaseId,
          kind: 'LAND_TASK',
          taskId: first.taskId,
          sessionId: first.sessionId,
          serialKey: first.serialKey,
          targetRef: first.targetRef,
          upstreamRef: first.upstreamRef,
          sourceRef: first.sourceRef,
          generation: 2,
          idempotencyKey: `ij:v1:LAND_TASK:${first.taskId}:2`,
        },
      });
      const repair = await read(stack, w, conflicted);
      assert.equal(repair.state, 'CONFLICT', 'its item stays open until the repair lands');
      assert.equal(repair.landTask?.jobId, regenerated.id);
      assert.equal(repair.landTask?.generation, '2');
      assert.equal(repair.landTask?.state, 'QUEUED');
      assert.equal(repair.landTask?.blockingReason?.code, 'WAITING_DISPATCH');
      assert.deepEqual(await currentLandings(stack, w), [[later.title, 'QUEUED'], [conflicted.title, 'QUEUED']],
        'the queue in enqueue order, each with its own reason');

      const repairClaim = await beat(stack, w);
      assert.deepEqual(repairClaim.map((c) => c.jobId), [regenerated.id], 'the claim agrees: the repair goes, the later one waits');
      assert.equal((await read(stack, w, later)).landTask?.blockingReason?.code, 'WAITING_MAIN_SYNC',
        'the project line still has to sync first');
      await report(stack, w, repairClaim[0]!, LANDED);

      const repaired = await read(stack, w, conflicted);
      assert.equal(repaired.state, 'ON_INTEGRATION_LINE');
      assert.equal(repaired.landTask?.state, 'LANDED');
      assert.notEqual((await stack.db.projectOpenItem.findUniqueOrThrow({
        where: { id: stopped.openItemId! }, select: { state: true },
      })).state, 'OPEN', 'the landing closed the item');
      assert.equal((await read(stack, w, later)).landTask?.blockingReason?.code, 'WAITING_DISPATCH');
      assert.deepEqual((await beat(stack, w)).map((c) => c.jobId), [waiting.jobId], 'the queue moved on its own');
      assert.equal((await read(stack, w, later)).landTask?.state, 'RUNNING');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the read is scoped: another owner or another project reads nothing; a reopened task’s stop is not a current landing',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'land-scope');
      await beat(stack, w);
      const task = await doneTask(stack, w, 'scoped');
      const claimed = await beat(stack, w);
      await report(stack, w, claimed[0]!, RED_MERGE_CHECK);
      const prisma = stack.db as unknown as PrismaService;
      assert.equal((await readTaskIntegrationViews(prisma, w.ownerId, w.projectId, [task.taskId])).size, 1);
      assert.equal((await readTaskIntegrationViews(prisma, randomUUID(), w.projectId, [task.taskId])).size, 0);
      assert.equal((await readTaskIntegrationViews(prisma, w.ownerId, randomUUID(), [task.taskId])).size, 0);
      await assert.rejects(stack.projects.integration(randomUUID(), w.projectId), /not found/);
      assert.deepEqual(await currentLandings(stack, w), [[task.title, 'CHECK_FAILED']]);

      // Reopened for another go: its next DONE queues a new generation, so this stop is history on
      // the project's view, while the task's own page still says what its last attempt did.
      await stack.db.task.update({ where: { id: task.taskId }, data: { status: TaskStatus.OPEN } });
      assert.deepEqual(await currentLandings(stack, w), []);
      const detail = await stack.tasks.get(w.ownerId, task.taskId) as { integration: TaskIntegrationView<Date> };
      assert.equal(detail.integration.landTask?.state, 'CHECK_FAILED');
    } finally {
      await stack.db.$disconnect();
    }
  });
