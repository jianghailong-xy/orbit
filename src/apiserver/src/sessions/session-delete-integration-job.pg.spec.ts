/**
 * Deleting a SESSION that a landing was about, on real PostgreSQL, through the two doors that delete
 * one: the owner's purge from Trash (`SessionsService.remove`, then `SessionsService.purge`) and the
 * hourly Trash purge (`ReaperService.purgeTrash`).
 *
 * WHAT WAS BROKEN
 * ---------------
 * `project_integration_job.session_id` was a foreign key `ON DELETE SET NULL` (0281), and the table's
 * BEFORE UPDATE trigger refuses any UPDATE of a job that is no longer QUEUED or RUNNING
 * (`project_integration_job_terminal_guard`, J4). Purging a session makes the key write
 * `session_id = NULL` on every job that names it — an UPDATE of a finished row — so the guard raises
 * `P0001 PROJECT_INTEGRATION_JOB_TERMINAL`, the DELETE rolls back whole, and the owner's purge
 * answers 500. The reaper's purge is ONE `deleteMany` over every session past retention, so a single
 * such session kept all of them in Trash, hour after hour.
 *
 * 0424 drops the key, and `session_id` stays on the row as a history reference with no foreign key —
 * what `task_id` became in 0423 (`src/apiserver/src/tasks/task-delete-integration-job.pg.spec.ts`).
 * A purge writes nothing of the job; a reader that needs the session looks it up by id and reads
 * "not found" as the NULL the key used to write.
 *
 * Every job here is made the way the product makes one: a code task settles DONE through its own
 * acceptance command, which queues its landing; the runner's heartbeat claims it; the result route
 * takes what the runner says it did. What the runner did in git is the one thing simulated.
 *
 * THE CASES
 * ---------
 *  (a) The owner purges a landed task's work session from Trash. The purge goes through, and the
 *      LANDED job is the row it was — state, shas, `receipt_ids`, its id, the id of the session it was
 *      queued from — with `updated_at` unmoved: nothing wrote it. The landing facts read that session
 *      while it is there and read it as gone once it is.
 *  (b) The hourly Trash purge, with two sessions past retention: one a failed landing (CHECK_FAILED)
 *      was about, and one nothing was about. One `deleteMany` takes both.
 *  (c) A landing still RUNNING when its session is purged, and reported LANDED afterwards. The result
 *      is recorded. The receipt it would have written is not — that row's `session_id` IS a foreign
 *      key, and the session is gone — which is exactly what the job's NULL `session_id` used to make
 *      it do; the job row goes on naming the session.
 *  (d) The control: an ordinary rewrite of a finished job row is STILL refused by J4, the key's own
 *      `session_id = NULL` included. Without it, a fix that dropped the trigger too would pass
 *      (a)–(c).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-delete-integration-job.pg.spec.ts
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own rows.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import { Client } from 'pg';

import {
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  RunEventType,
  RunStatus as SharedRunStatus,
  TRASH_RETENTION_DAYS,
} from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { readLandingJobsByTask } from '../projects/project-criterion-landing';
import { INTEGRATION_JOB_CLAIM } from '../projects/project-integration-job';
import { configureProjectIntegration } from '../projects/project-integration-line';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { QueueService } from '../queue/queue.service';
import { ReaperService } from '../realtime/reaper.service';
import { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { TasksService } from '../tasks/tasks.service';
import { SessionsService } from './sessions.service';

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
const DAY_MS = 24 * 60 * 60_000;

// The commits the simulated runner reports. Distinct, so an assertion that picked up the wrong one
// fails on the value instead of passing on a coincidence.
const TASK_BRANCH_TIP = 'a'.repeat(40);
const LINE_BEFORE = 'c'.repeat(40);
const LANDED_ON_LINE = 'd'.repeat(40);
const LANDED_TREE = 'e'.repeat(40);

type Result = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

const LANDED: Result = {
  state: 'LANDED',
  phase: 'VERIFY',
  sourceSha: TASK_BRANCH_TIP,
  targetShaBefore: LINE_BEFORE,
  testedSha: LANDED_ON_LINE,
  testedTreeSha: LANDED_TREE,
  landedSha: LANDED_ON_LINE,
  landedTreeSha: LANDED_TREE,
  aheadOfUpstream: 1,
};

const RED_MERGE_CHECK: Result = {
  state: 'CHECK_FAILED',
  phase: 'CHECK',
  sourceSha: TASK_BRANCH_TIP,
  targetShaBefore: LINE_BEFORE,
  testedSha: LANDED_ON_LINE,
  testedTreeSha: LANDED_TREE,
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

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  sessions: SessionsService;
  reaper: ReaperService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
}

/** The runner routes, the session doors and the reaper over one client, as production wires them. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  // Every realtime call is a no-op: nothing here reaches a device or a runner process.
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
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
  return { db, tasks, sessions, reaper: new ReaperService(prisma, realtime, openItems), api, jobs };
}

interface World {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
}

/** One project landing on a branch of its own, worked on one runner's checkout. */
async function world(stack: Stack, label: string): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@session-delete.invalid`, name: label, passwordHash: 'x' },
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
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: 'a session can be deleted after its work has landed',
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
  return { label, ownerId, runnerId, workspaceId, projectId };
}

/**
 * A code task of this project settled DONE by its own acceptance command, through the runner's doors.
 * Its DONE is what queues its landing (§2.3 J-T1a). The work session has finished — the column the
 * claim guard reads — so the landing is handed out at the next heartbeat.
 */
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
      branch: `orbit/${label}`,
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

/** The task's landing in the runner's hands: claimed at a heartbeat, RUNNING. */
async function landingInHand(
  stack: Stack,
  w: World,
  label: string,
): Promise<{ taskId: string; sessionId: string; job: IntegrationJobCommand }> {
  const task = await doneCodeTask(stack, w, label);
  const claimed = await stack.jobs.dispatch({
    runnerId: w.runnerId, leaseOwner: `lease-${w.label}`, draining: false, capabilities: CAPABLE,
  });
  assert.equal(claimed.length, 1, 'the heartbeat handed out the one landing');
  assert.equal(claimed[0]!.kind, 'LAND_TASK');
  return { ...task, job: claimed[0]! };
}

/** The result a runner posts for a job it holds, over the route it posts it on. */
async function report(stack: Stack, w: World, job: IntegrationJobCommand, result: Result): Promise<void> {
  const answer = await stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
  assert.equal(answer.accepted, true, `the result route refused ${result.state}`);
}

/** The whole job row as it stands, so a case can say the delete did not write it at all. */
function jobRow(db: PrismaClient, id: string) {
  return db.projectIntegrationJob.findUniqueOrThrow({ where: { id } });
}

/** The reaper's hourly sweep, called as its timer calls it. */
function purgeTrash(reaper: ReaperService): Promise<void> {
  return (reaper as unknown as { purgeTrash(): Promise<void> }).purgeTrash();
}

test('(a) the owner purges a landed task\'s work session from Trash, and its landing keeps every fact',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'purge-landed');
      const { taskId, sessionId, job } = await landingInHand(stack, w, 'purge-landed');
      await report(stack, w, job, LANDED);
      const before = await jobRow(stack.db, job.jobId);
      assert.equal(before.state, 'LANDED');
      assert.equal(before.sessionId, sessionId);
      assert.equal(before.receiptIds.length, 1, 'the landing wrote its receipt');
      const [facts] = (await readLandingJobsByTask(stack.db as unknown as PrismaService, [taskId])).get(taskId)!;
      assert.notEqual(facts!.session, null, 'while the session is there, the landing facts read it');

      await stack.sessions.remove(w.ownerId, sessionId);
      // THE REPRODUCTION. Before 0424 this rejected with the guard's P0001
      // (PROJECT_INTEGRATION_JOB_TERMINAL), raised by the foreign key's own `session_id = NULL`
      // UPDATE of the finished job, and the whole DELETE rolled back: a 500 from the purge route.
      await stack.sessions.purge(w.ownerId, sessionId);

      assert.equal(await stack.db.session.count({ where: { id: sessionId } }), 0, 'the session is gone');
      const after = await jobRow(stack.db, job.jobId);
      assert.equal(after.state, 'LANDED', 'the job still says it landed');
      assert.equal(after.sessionId, sessionId, 'and still names the session it was queued from');
      assert.equal(after.taskId, taskId);
      assert.deepEqual(after.receiptIds, before.receiptIds, 'the receipt association survives');
      assert.equal(after.landedSha, LANDED_ON_LINE);
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(),
        'no write of the row happened at all: the purge did not touch it');
      assert.deepEqual(after, before, 'every column is what it was');
      const [gone] = (await readLandingJobsByTask(stack.db as unknown as PrismaService, [taskId])).get(taskId)!;
      assert.equal(gone!.session, null, 'and the landing facts read the session as gone, as the NULL used to say');
      assert.equal(gone!.state, 'LANDED');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(b) the hourly Trash purge takes a failed landing\'s session and its neighbour in one sweep',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'reaper');
      const { sessionId: failed, job } = await landingInHand(stack, w, 'reaper-failed');
      await report(stack, w, job, RED_MERGE_CHECK);
      const before = await jobRow(stack.db, job.jobId);
      assert.equal(before.state, 'CHECK_FAILED');
      // A session nothing is about, sitting in the same Trash: the sweep's ordinary work.
      const neighbour = await stack.db.session.create({
        data: {
          ownerId: w.ownerId, creatorId: w.ownerId, title: 'a chat', prompt: 'p',
          status: RunStatus.SUCCEEDED,
        },
        select: { id: true },
      });
      for (const id of [failed, neighbour.id]) await stack.sessions.remove(w.ownerId, id);
      // Past retention: the one thing a test cannot wait for, so the row's clock is moved instead.
      await stack.db.session.updateMany({
        where: { id: { in: [failed, neighbour.id] } },
        data: { deletedAt: new Date(Date.now() - (TRASH_RETENTION_DAYS + 1) * DAY_MS) },
      });

      // THE REPRODUCTION. Before 0424 the one `deleteMany` rejected with P0001
      // (PROJECT_INTEGRATION_JOB_TERMINAL) and took nothing — the neighbour stayed too, every hour.
      await purgeTrash(stack.reaper);

      assert.equal(await stack.db.session.count({ where: { id: { in: [failed, neighbour.id] } } }), 0,
        'both sessions past retention are gone');
      const after = await jobRow(stack.db, job.jobId);
      assert.equal(after.state, 'CHECK_FAILED');
      assert.equal(after.sessionId, failed, 'the failed landing still names its session');
      assert.deepEqual(after.checks, before.checks, 'why it failed is still on the row');
      assert.deepEqual(after, before, 'and nothing of the row was written');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(c) a landing still running when its session is purged records its result, with no receipt for a session that is gone',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'in-flight');
      const { taskId, sessionId, job } = await landingInHand(stack, w, 'in-flight');
      await stack.sessions.remove(w.ownerId, sessionId);
      await stack.sessions.purge(w.ownerId, sessionId);
      const running = await jobRow(stack.db, job.jobId);
      assert.equal(running.state, 'RUNNING');
      assert.equal(running.sessionId, sessionId, 'the purge did not write the job either: it still names its session');

      // The runner pushed and says so. `session_merge_receipt.session_id` is a foreign key, so a
      // receipt naming the purged session cannot be written (23503) — and with the key on the job,
      // its `session_id` was NULL here and no receipt was written. The result must be taken as before.
      await report(stack, w, job, LANDED);

      const after = await jobRow(stack.db, job.jobId);
      assert.equal(after.state, 'LANDED', 'the landing is recorded');
      assert.equal(after.landedSha, LANDED_ON_LINE);
      assert.equal(after.landedTreeSha, LANDED_TREE);
      assert.deepEqual(after.receiptIds, [], 'no receipt: its row would name a session that is gone');
      assert.equal(after.sessionId, sessionId, 'the job goes on naming the session it was queued from');
      assert.equal(after.taskId, taskId);
      assert.equal(await stack.db.sessionMergeReceipt.count({ where: { taskId } }), 0);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(d) the guard is untouched: rewriting a finished job row is still refused (J4)',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'guard-control');
      const { job } = await landingInHand(stack, w, 'guard-control');
      await report(stack, w, job, LANDED);
      const refused = (error: unknown) => {
        assert.match(String((error as Error).message), /PROJECT_INTEGRATION_JOB_TERMINAL/u,
          'a finished row is refused with the guard\'s own word');
        return true;
      };
      // The control for every case above: the fix must not have been "drop the trigger".
      await assert.rejects(
        stack.db.projectIntegrationJob.update({ where: { id: job.jobId }, data: { state: 'CANCELLED' } }),
        refused,
      );
      // ...including the very write the dropped key used to make, made by hand.
      await assert.rejects(
        stack.db.projectIntegrationJob.update({ where: { id: job.jobId }, data: { sessionId: null } }),
        refused,
      );
      const row = await jobRow(stack.db, job.jobId);
      assert.equal(row.state, 'LANDED', 'and the row is where it was');
      assert.notEqual(row.sessionId, null);
    } finally {
      await stack.db.$disconnect();
    }
  });
