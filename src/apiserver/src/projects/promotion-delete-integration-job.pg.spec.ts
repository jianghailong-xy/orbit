/**
 * Deleting the TASK or the SESSION a promotion was about, on real PostgreSQL: the task through
 * `TasksService.remove`, the session through the owner's purge from Trash (`SessionsService.remove`,
 * then `SessionsService.purge`), and the promotions made the way the product makes them — a landing's
 * after-commit edge files the candidate, the runner checks it, the owner merges or declines it.
 *
 * WHAT WAS BROKEN
 * ---------------
 * `project_promotion.task_id` and `session_id` were foreign keys `ON DELETE SET NULL` (0286), and
 * `project_promotion_terminal_guard` refuses any UPDATE of a promotion that is MERGED, DECLINED,
 * CANCELLED or SUPERSEDED. Deleting the task or the session makes the key write NULL into every
 * promotion that names it, so a finished promotion raised `P0001 PROJECT_PROMOTION_TERMINAL`, the
 * DELETE rolled back whole, and the delete answered 500. A candidate still live on a MAIN line
 * (`TASK_BRANCH`) refused the same task delete through `project_promotion_task_branch_chk` (23514).
 * The session side carried the jobs' key as well: a promotion's check and landing name the same
 * session as the landing that made it (`project_integration_job.session_id`, 0281, guarded by J4).
 *
 * 0424 drops all three keys. The ids stay on the rows as history references with no foreign key, and
 * the two writers that copy them into a column that IS one — the receipts a merge into main writes
 * (`session_merge_receipt.session_id` and `task_id`) — look them up first and write what the NULL
 * used to make them write.
 *
 * THE CASES
 * ---------
 *  (a) A promotion the owner merged: the task it carried is deleted, and the promotion keeps every
 *      fact — state, shas, `receipt_ids`, its id, the task and session it names — unwritten.
 *  (b) The same merged promotion's work session is purged from Trash; the promotion and all three
 *      jobs that name the session (the landing, the check, the merge) keep every fact, unwritten.
 *  (c) A promotion the owner declined: its session purged and its task deleted, both unwritten.
 *  (d) A candidate still live on a MAIN line: its task deleted (the 23514), the candidate unwritten.
 *  (e) A merge into main still running when the work session it carries is purged: the merge is
 *      recorded, and no receipt names the session that is gone — what the NULL used to make it do.
 *  (f) A merge into main still running when the task it carries is deleted: the merge is recorded,
 *      and the receipt names no task — what SET NULL would have left of one written a moment before.
 *  (g) The control: rewriting a finished promotion is STILL refused by its guard, the keys' own
 *      `task_id = NULL` / `session_id = NULL` included, and the live candidate's CHECK still refuses
 *      a task_id of NULL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-delete-integration-job.pg.spec.ts
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own rows.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
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
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND } from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';

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

// The commits the simulated runner reports. Distinct, so an assertion that picked up the wrong one
// fails on the value instead of passing on a coincidence.
const TASK_BRANCH_TIP = 'a'.repeat(40);
const LINE_BEFORE = 'c'.repeat(40);
/** Where the task landed on the project branch: the source the promotion offers. */
const LANDED_ON_LINE = 'd'.repeat(40);
const LANDED_TREE = 'e'.repeat(40);
/** main as the promotion check found it. */
const MAIN_CHECKED = 'f'.repeat(40);
const CHECK_MERGE = '2'.repeat(40);
/** The combined tree the check passed on. */
const CHECKED_TREE = '3'.repeat(40);
/** The merge commit the landing made on main. */
const MERGE_COMMIT = '4'.repeat(40);

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'npm test',
  expectedExitCode: 0,
  exitCode: 0,
  timedOut: false,
  durationMs: 1_200,
  outputTail: 'ok\n',
};

type Result = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

/** A check that found the project branch merging cleanly onto main, every check green. */
const CLEAN_CHECK: Result = {
  state: 'READY',
  phase: 'CHECK',
  sourceSha: LANDED_ON_LINE,
  targetShaBefore: MAIN_CHECKED,
  upstreamSha: MAIN_CHECKED,
  testedSha: CHECK_MERGE,
  testedTreeSha: CHECKED_TREE,
  aheadOfUpstream: 1,
  filesChanged: 3,
  checks: [GREEN_CHECK],
  conflicts: [],
};

/** The merge the owner confirmed, on main. */
const MERGED_ON_MAIN: Result = {
  state: 'LANDED',
  phase: 'VERIFY',
  sourceSha: LANDED_ON_LINE,
  targetShaBefore: MAIN_CHECKED,
  upstreamSha: MAIN_CHECKED,
  testedSha: MERGE_COMMIT,
  testedTreeSha: CHECKED_TREE,
  landedSha: MERGE_COMMIT,
  landedTreeSha: CHECKED_TREE,
};

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  sessions: SessionsService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
  promotions: ProjectPromotionService;
}

/**
 * The runner controller with the integration relay AND the promotion service, so a landing's
 * after-commit edge makes the candidate (M-F1) the way production does rather than by a call this
 * file makes; the task and session doors over the same client.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  const promotions = new ProjectPromotionService(prisma);
  // A device is never reached from here: every announcement resolves and says nothing.
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
  return { db, tasks, sessions, api, jobs, promotions };
}

interface World {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
}

/** One project in a repository, integrating on the line named, with the owner's Automatic off. */
async function world(stack: Stack, label: string, line: 'PROJECT_BRANCH' | 'MAIN'): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@promotion-delete.invalid`, name: label, passwordHash: 'x' },
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
      goal: 'a promotion outlives the task and the session it was about',
      coordinatorEnabled: false,
      coordinatorWorkspaceId: workspaceId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, { ownerId, projectId, settings: { line } }));
  return { label, ownerId, runnerId, workspaceId, projectId };
}

/**
 * A code task of this project settled DONE by its own acceptance command, through the runner's
 * doors. Its DONE queues its integration (§2.3 J-T1a): a landing on a project branch, a candidate on
 * a MAIN line. Its work session has finished, so nothing holds what is queued.
 */
async function doneCodeTask(stack: Stack, w: World): Promise<{ taskId: string; sessionId: string }> {
  const db = stack.db;
  const title = `${w.label} ${randomUUID().slice(0, 8)}`;
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
      branch: `orbit/${w.label}`,
      worktreeBranch: `orbit/${w.label}`,
      worktreeDirty: false,
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
    runnerId: w.runnerId, leaseOwner: `lease-${w.label}`, draining: false, capabilities: CAPABLE,
  });
  assert.equal(claimed.length, 1, `expected one ${kind} to be handed out`);
  assert.equal(claimed[0]!.kind, kind);
  return claimed[0]!;
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

interface Candidate {
  taskId: string;
  sessionId: string;
  promotionId: string;
}

/**
 * A PROJECT_BRANCH project carried to the owner's question: one task DONE, its landing reported
 * LANDED on the project branch, the candidate the landing's after-commit edge filed (M-F1), and its
 * check reported clean — READY, with the owner's card open.
 */
async function readyCandidate(stack: Stack, w: World): Promise<Candidate> {
  const task = await doneCodeTask(stack, w);
  await report(stack, w, await onlyClaim(stack, w, 'LAND_TASK'), {
    state: 'LANDED',
    phase: 'VERIFY',
    sourceSha: TASK_BRANCH_TIP,
    targetShaBefore: LINE_BEFORE,
    testedSha: LANDED_ON_LINE,
    testedTreeSha: LANDED_TREE,
    landedSha: LANDED_ON_LINE,
    landedTreeSha: LANDED_TREE,
    aheadOfUpstream: 1,
  });
  await report(stack, w, await onlyClaim(stack, w, 'CHECK_PROMOTION'), CLEAN_CHECK);
  const promotion = await stack.db.projectPromotion.findFirstOrThrow({
    where: { projectId: w.projectId },
    select: { id: true, state: true, taskId: true, sessionId: true },
  });
  assert.equal(promotion.state, 'READY', 'the candidate waits for the owner');
  assert.equal(promotion.taskId, task.taskId, 'the candidate names the task that landed last');
  assert.equal(promotion.sessionId, task.sessionId, 'and that landing\'s work session');
  return { ...task, promotionId: promotion.id };
}

/** The owner pressed Merge and the merge into main is in a runner's hands. */
async function mergeInHand(stack: Stack, w: World): Promise<Candidate & { land: IntegrationJobCommand }> {
  const candidate = await readyCandidate(stack, w);
  await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, candidate.promotionId, LANDED_ON_LINE);
  return { ...candidate, land: await onlyClaim(stack, w, 'LAND_PROMOTION') };
}

/** The owner pressed Merge and the merge is on main: MERGED, with the receipt that says so. */
async function mergedPromotion(stack: Stack, w: World): Promise<Candidate> {
  const { land, ...candidate } = await mergeInHand(stack, w);
  await report(stack, w, land, MERGED_ON_MAIN);
  const merged = await promotionRow(stack.db, candidate.promotionId);
  assert.equal(merged.state, 'MERGED');
  assert.equal(merged.receiptIds.length, 1, 'the merge wrote the receipt that the task is on main');
  return candidate;
}

/** Whole rows as they stand, so a case can say the delete did not write them at all. */
function promotionRow(db: PrismaClient, id: string) {
  return db.projectPromotion.findUniqueOrThrow({ where: { id } });
}

function jobRows(db: PrismaClient, projectId: string) {
  return db.projectIntegrationJob.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
}

async function purgeSession(stack: Stack, w: World, sessionId: string): Promise<void> {
  await stack.sessions.remove(w.ownerId, sessionId);
  await stack.sessions.purge(w.ownerId, sessionId);
}

test('(a) the task a merged promotion carried can be deleted, and the promotion keeps every fact',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'merged-task', 'PROJECT_BRANCH');
      const { taskId, sessionId, promotionId } = await mergedPromotion(stack, w);
      const before = await promotionRow(stack.db, promotionId);
      const jobsBefore = await jobRows(stack.db, w.projectId);

      // THE REPRODUCTION. Before 0424 this rejected with the guard's P0001
      // (PROJECT_PROMOTION_TERMINAL), raised by the key's own `task_id = NULL` UPDATE of the merged
      // promotion, and the whole DELETE rolled back: a 500 from the delete route.
      await stack.tasks.remove(w.ownerId, taskId);

      assert.equal(await stack.db.task.count({ where: { id: taskId } }), 0, 'the task is gone');
      const after = await promotionRow(stack.db, promotionId);
      assert.equal(after.state, 'MERGED', 'the promotion still says it merged');
      assert.equal(after.mergedSha, MERGE_COMMIT);
      assert.equal(after.sourceSha, LANDED_ON_LINE);
      assert.equal(after.mergeTreeSha, CHECKED_TREE);
      assert.deepEqual(after.receiptIds, before.receiptIds, 'the receipt association survives');
      assert.equal(after.taskId, taskId, 'it still names the task it was about');
      assert.equal(after.sessionId, sessionId);
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(),
        'no write of the row happened at all: the delete did not touch it');
      assert.deepEqual(after, before, 'every column is what it was');
      assert.deepEqual(await jobRows(stack.db, w.projectId), jobsBefore, 'and no job of the line was written either');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(b) the work session a merged promotion and its three jobs name can be purged from Trash',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'merged-session', 'PROJECT_BRANCH');
      const { taskId, sessionId, promotionId } = await mergedPromotion(stack, w);
      const before = await promotionRow(stack.db, promotionId);
      const jobsBefore = await jobRows(stack.db, w.projectId);
      assert.deepEqual(jobsBefore.map((job) => [job.kind, job.state, job.sessionId]), [
        ['LAND_TASK', 'LANDED', sessionId],
        ['CHECK_PROMOTION', 'READY', sessionId],
        ['LAND_PROMOTION', 'LANDED', sessionId],
      ], 'the landing, the check and the merge all name the work session');

      // THE REPRODUCTION. Before 0424 this rejected with P0001 — the first of the four keys to fire
      // on a finished row: three jobs (J4) and the promotion — and the whole DELETE rolled back.
      await purgeSession(stack, w, sessionId);

      assert.equal(await stack.db.session.count({ where: { id: sessionId } }), 0, 'the session is gone');
      const after = await promotionRow(stack.db, promotionId);
      assert.equal(after.state, 'MERGED');
      assert.equal(after.sessionId, sessionId, 'the promotion still names the session');
      assert.equal(after.taskId, taskId);
      assert.deepEqual(after, before, 'and nothing of it was written');
      assert.deepEqual(await jobRows(stack.db, w.projectId), jobsBefore,
        'nor of the three jobs: each still names the session, with its state and shas');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(c) a promotion the owner declined keeps every fact when its session is purged and its task deleted',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'declined', 'PROJECT_BRANCH');
      const { taskId, sessionId, promotionId } = await readyCandidate(stack, w);
      await stack.promotions.decline({ userId: w.ownerId }, w.projectId, promotionId);
      const before = await promotionRow(stack.db, promotionId);
      assert.equal(before.state, 'DECLINED');
      const jobsBefore = await jobRows(stack.db, w.projectId);

      await purgeSession(stack, w, sessionId);
      await stack.tasks.remove(w.ownerId, taskId);

      assert.equal(await stack.db.session.count({ where: { id: sessionId } }), 0);
      assert.equal(await stack.db.task.count({ where: { id: taskId } }), 0);
      const after = await promotionRow(stack.db, promotionId);
      assert.equal(after.state, 'DECLINED', 'the owner\'s answer stands');
      assert.equal(after.taskId, taskId);
      assert.equal(after.sessionId, sessionId);
      assert.deepEqual(after, before, 'and nothing of the row was written');
      assert.deepEqual(await jobRows(stack.db, w.projectId), jobsBefore);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(d) a task whose branch is a live candidate on a MAIN line can be deleted, and the candidate is left as it was',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'main-line', 'MAIN');
      const { taskId, sessionId } = await doneCodeTask(stack, w);
      const candidate = await stack.db.projectPromotion.findFirstOrThrow({ where: { projectId: w.projectId } });
      assert.equal(candidate.sourceKind, 'TASK_BRANCH');
      assert.equal(candidate.state, 'CHECKING');
      assert.equal(candidate.taskId, taskId);
      assert.equal(candidate.sessionId, sessionId);

      // THE REPRODUCTION. Before 0424 the key's `task_id = NULL` got past the guard (the candidate is
      // live) and was refused by `project_promotion_task_branch_chk` instead: 23514, a 500.
      await stack.tasks.remove(w.ownerId, taskId);

      assert.equal(await stack.db.task.count({ where: { id: taskId } }), 0, 'the task is gone');
      assert.deepEqual(await promotionRow(stack.db, candidate.id), candidate,
        'the candidate is not the delete\'s to rewrite: it still names the task, unwritten');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(e) a merge into main still running when the work session it carries is purged is recorded, with no receipt for a session that is gone',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'merge-session-gone', 'PROJECT_BRANCH');
      const { taskId, sessionId, promotionId, land } = await mergeInHand(stack, w);
      await purgeSession(stack, w, sessionId);

      // The runner merged and says so. A receipt names its session through a foreign key, and this
      // one is gone: with the keys in place the landing's `session_id` read NULL here and no receipt
      // was written. The merge must be taken exactly as then — not refused with a 23503.
      await report(stack, w, land, MERGED_ON_MAIN);

      const after = await promotionRow(stack.db, promotionId);
      assert.equal(after.state, 'MERGED', 'the merge is recorded');
      assert.equal(after.mergedSha, MERGE_COMMIT);
      assert.deepEqual(after.receiptIds, [], 'no receipt: its row would name a session that is gone');
      assert.equal(after.sessionId, sessionId, 'the promotion goes on naming the session');
      assert.equal(await stack.db.sessionMergeReceipt.count({ where: { taskId, targetBranch: 'main' } }), 0);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(f) a merge into main still running when the task it carries is deleted is recorded, with a receipt that names no task',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'merge-task-gone', 'PROJECT_BRANCH');
      const { taskId, sessionId, promotionId, land } = await mergeInHand(stack, w);
      await stack.tasks.remove(w.ownerId, taskId);

      // The task is gone and its landing still names it (0423). The receipt's `task_id` is a foreign
      // key: a receipt written a moment before the delete would have been left naming no task, so
      // that is the receipt written now — not a 23503 that leaves a merge on main unrecorded.
      await report(stack, w, land, MERGED_ON_MAIN);

      const after = await promotionRow(stack.db, promotionId);
      assert.equal(after.state, 'MERGED', 'the merge is recorded');
      assert.equal(after.mergedSha, MERGE_COMMIT);
      assert.equal(after.taskId, taskId, 'the promotion goes on naming the task');
      assert.equal(after.receiptIds.length, 1, 'the session\'s work on main has its receipt');
      const receipt = await stack.db.sessionMergeReceipt.findUniqueOrThrow({ where: { id: after.receiptIds[0]! } });
      assert.equal(receipt.sessionId, sessionId);
      assert.equal(receipt.taskId, null, 'naming no task, as the deleted task\'s receipts all do');
      assert.equal(receipt.targetBranch, 'main');
      assert.equal(receipt.targetShaAfter, MERGE_COMMIT);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(g) the guard and the CHECK are untouched: a finished promotion is still never rewritten',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'guard-control', 'PROJECT_BRANCH');
      const { promotionId } = await readyCandidate(stack, w);
      await stack.promotions.decline({ userId: w.ownerId }, w.projectId, promotionId);
      const terminal = (error: unknown) => {
        assert.match(String((error as Error).message), /PROJECT_PROMOTION_TERMINAL/u,
          'a finished promotion is refused with the guard\'s own word');
        return true;
      };
      // The control for every case above: the fix must not have been "drop the trigger".
      await assert.rejects(
        stack.db.projectPromotion.update({ where: { id: promotionId }, data: { state: 'CANCELLED' } }),
        terminal,
      );
      // ...including the very writes the dropped keys used to make, made by hand.
      await assert.rejects(
        stack.db.projectPromotion.update({ where: { id: promotionId }, data: { taskId: null } }),
        terminal,
      );
      await assert.rejects(
        stack.db.projectPromotion.update({ where: { id: promotionId }, data: { sessionId: null } }),
        terminal,
      );
      assert.equal((await promotionRow(stack.db, promotionId)).state, 'DECLINED', 'and the row is where it was');

      // A live MAIN-line candidate is past the guard, and its CHECK still says it must name a task.
      const main = await world(stack, 'check-control', 'MAIN');
      await doneCodeTask(stack, main);
      const live = await stack.db.projectPromotion.findFirstOrThrow({ where: { projectId: main.projectId } });
      await assert.rejects(
        stack.db.projectPromotion.update({ where: { id: live.id }, data: { taskId: null } }),
        (error: unknown) => {
          assert.match(String((error as Error).message), /project_promotion_task_branch_chk/u);
          return true;
        },
      );
    } finally {
      await stack.db.$disconnect();
    }
  });
