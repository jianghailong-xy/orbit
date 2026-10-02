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
  integrationDedupeKey,
  integrationItemTitle,
} from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { recordIntegrationFailure, recordPromotionApproval } from './project-open-item';
import { ProjectOpenItemService } from './project-open-item.service';
import { promotionDedupeKey, promotionItemTitle } from './project-promotion';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * A promotion candidate that leaves the live states takes the failures about it with it
 * (`docs/project-integration-line-contract.md` §4.2, `PROMOTION_MOVED_ON`).
 *
 * WHAT THIS IS FOR
 * ----------------
 * A candidate's check or landing that fails opens an INTEGRATION_* item naming the candidate
 * (`promotion_id`) and no task. Until this rule the only item a candidate closed on its way out was
 * the owner's approval card (`project_promotion.open_item_id`): superseded, declined, cancelled or
 * merged, its failures stayed OPEN — escalated to the owner about a candidate that no longer
 * existed, and counted by M-T11 against every later candidate of the project, so a project with
 * Automatic on merged nothing by itself again. And a result that came back for a candidate that had
 * already ended was dropped by the promotion and still opened its failure.
 *
 * Seen on 2026-10-02 in 「项目收尾重做」: a CHECK_PROMOTION that timed out opened an
 * INTEGRATION_CHECK_FAILED, a later candidate of the same branch merged, and the item stayed open —
 * escalated to the owner, and holding off every automatic merge of the project.
 *
 * THE CASES
 * ---------
 *  (1) a BLOCKED candidate superseded by a new landing: its failure is SUPERSEDED /
 *      PROMOTION_MOVED_ON / PLATFORM in the transaction that made the new candidate — and an item
 *      about a task's own landing on the same project is left alone;
 *  (2) the refile path: a candidate retired because its check looked at a branch the work did not
 *      end on goes through the same supersession, and a failure about it goes with it;
 *  (3) the owner declining a BLOCKED candidate: its failure is RESOLVED / PROMOTION_MOVED_ON /
 *      PLATFORM, and its approval card still says the owner declined it;
 *  (4) a merge the owner called back: the CHECK_FAILED its landing reports afterwards opens nothing;
 *  (5) BLOCKED → fixed → superseded → MERGED with Automatic on: the candidate that replaced the
 *      blocked one is merged by itself — M-T11 no longer counts the old failure — and the project
 *      ends with no open item about any of its candidates.
 *
 * WHAT DRIVES EACH CASE. The doors a runner knocks on, through the same controller and relay
 * production wiring as `project-promotion-auto-authority.pg.spec.ts`; what the runner did in git is
 * the one thing simulated, as the result it posts. Cases (2) and (3) each also write one row that no
 * door writes today, and say why where they do.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-items-moved-on.pg.spec.ts
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

/** What a runner of this build says about itself: it claims integration jobs, and it hands a moved
 *  main back instead of re-checking it on an automatic landing. */
const CAPABLE = [INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND];

// The commits the simulated runner reports. Distinct, so an assertion that picked up the wrong one
// fails on the value instead of passing on a coincidence.
const TASK_BRANCH_TIP = 'a'.repeat(40);
const LINE_BEFORE = 'c'.repeat(40);
/** Where the first task landed on the project branch: the source of the candidate that is blocked. */
const LINE_FIRST = 'd'.repeat(40);
const LINE_FIRST_TREE = 'e'.repeat(40);
/** Where the fix landed after it: the source of the candidate that replaces the blocked one. */
const LINE_FIXED = '6'.repeat(40);
const LINE_FIXED_TREE = '7'.repeat(40);
/** main as every promotion check below found it. */
const MAIN_CHECKED = 'f'.repeat(40);
const CHECK_MERGE = '2'.repeat(40);
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
const RED_CHECK: IntegrationCheckResult = { ...GREEN_CHECK, exitCode: 1, outputTail: '1 failing\n' };

/** The item kinds a promotion job's failure opens (§4.2). */
const INTEGRATION_KINDS = ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'];

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
  promotions: ProjectPromotionService;
}

/**
 * The production wiring over one client: the real completion-input router behind task writes, and
 * the runner controller with the integration relay AND the promotion service, so a landing's
 * after-commit edge makes the candidate (M-F1) — and supersedes the one standing — the way it does in
 * production rather than by a call this file makes.
 */
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
  return { db, tasks, api, jobs, promotions };
}

interface World {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
}

/**
 * One project in a repository, integrating on the line named, with a coordinator conversation
 * between turns and the owner's Automatic setting as given.
 */
async function world(
  stack: Stack,
  label: string,
  options: { line: 'PROJECT_BRANCH' | 'MAIN'; automatic: boolean },
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@items-moved-on.invalid`, name: label, passwordHash: 'x' },
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
      goal: 'a todo in front of anybody is about something that is still in the way',
      coordinatorEnabled: options.automatic,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId,
    projectId,
    settings: { line: options.line },
  }));
  return { label, ownerId, runnerId, workspaceId, projectId };
}

/**
 * A code task of this project settled DONE by its own acceptance command, through the runner's
 * doors: the work turn answered and completed, the acceptance command queued and passed. Its DONE
 * is what queues its integration (§2.3 J-T1a).
 */
async function doneCodeTask(stack: Stack, w: World, label: string): Promise<string> {
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
      // The task's work has stopped moving (§2.6 J-T1a): a minute ago, so every claim that follows
      // is unambiguously later than it.
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
  return declared.id;
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

/** The result a runner posts for a job it holds, over the route it posts it on. */
function report(
  stack: Stack,
  w: World,
  job: IntegrationJobCommand,
  result: Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>,
) {
  return stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
}

/** A landing on the project branch, from the tip it found to the commit it made. */
function landed(before: string, sha: string, tree: string): Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'> {
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
function cleanCheck(source: string): Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'> {
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

/** A check that merged `source` onto main and found a check red. */
function redCheck(source: string): Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'> {
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

/** A code task DONE and landed on the project branch, through the line's own queue. */
async function landOnLine(stack: Stack, w: World, label: string, before: string, sha: string, tree: string): Promise<string> {
  const taskId = await doneCodeTask(stack, w, label);
  const landing = await onlyClaim(stack, w, 'LAND_TASK');
  const answer = await report(stack, w, landing, landed(before, sha, tree));
  assert.equal(answer.accepted, true, `${label} landed on the project branch`);
  return taskId;
}

/**
 * A PROJECT_BRANCH project carried to a BLOCKED candidate: one task landed on the project branch, the
 * candidate its landing made (M-F1), and that candidate's check reported red (M-T3) — with the one
 * item a red check opens, about the candidate and about no task.
 */
async function blockedCandidate(stack: Stack, w: World): Promise<{ taskId: string; promotionId: string; itemId: string }> {
  const taskId = await landOnLine(stack, w, `${w.label}-first`, LINE_BEFORE, LINE_FIRST, LINE_FIRST_TREE);
  const check = await onlyClaim(stack, w, 'CHECK_PROMOTION');
  const failed = await report(stack, w, check, redCheck(LINE_FIRST));
  assert.equal(failed.accepted, true);
  const promotion = await promotionOf(stack.db, w.projectId);
  assert.equal(promotion.state, 'BLOCKED', 'a red check blocks the candidate');
  const items = await integrationItems(stack.db, w.projectId);
  assert.equal(items.length, 1, `the red check opened one item — ${JSON.stringify(items)}`);
  const item = items[0]!;
  assert.equal(item.kind, 'INTEGRATION_CHECK_FAILED');
  assert.equal(item.state, 'OPEN', 'and while the candidate stands, its failure is somebody\'s to look at');
  assert.equal(item.promotionId, promotion.id, 'the item is about the candidate');
  assert.equal(item.taskId, null, '…and about no task');
  assert.equal(failed.openItemId, item.id);
  return { taskId, promotionId: promotion.id, itemId: item.id };
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────

const PROMOTION_FIELDS = {
  id: true, state: true, sourceRef: true, sourceSha: true, sessionId: true, upstreamRef: true,
  includedTaskIds: true, checkJobId: true, openItemId: true, confirmedAutomatically: true,
  mergedSha: true,
} as const;

/** The project's newest candidate. */
function promotionOf(db: PrismaClient, projectId: string) {
  return db.projectPromotion.findFirstOrThrow({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: PROMOTION_FIELDS,
  });
}

function promotionById(db: PrismaClient, promotionId: string) {
  return db.projectPromotion.findUniqueOrThrow({ where: { id: promotionId }, select: PROMOTION_FIELDS });
}

const ITEM_FIELDS = {
  id: true, kind: true, state: true, promotionId: true, taskId: true, resolution: true,
  resolvedBy: true, resolvedByUserId: true, resolvedAt: true,
} as const;

/** Every integration failure of the project, open or not, oldest first. */
function integrationItems(db: PrismaClient, projectId: string) {
  return db.projectOpenItem.findMany({
    where: { projectId, kind: { in: INTEGRATION_KINDS } },
    orderBy: { createdAt: 'asc' },
    select: ITEM_FIELDS,
  });
}

function itemById(db: PrismaClient, itemId: string) {
  return db.projectOpenItem.findUniqueOrThrow({ where: { id: itemId }, select: ITEM_FIELDS });
}

/** The open integration failures M-T11 counts against the project's next candidate. */
function openIntegrationItems(db: PrismaClient, projectId: string) {
  return db.projectOpenItem.count({ where: { projectId, state: 'OPEN', kind: { in: INTEGRATION_KINDS } } });
}

async function jobsOf(db: PrismaClient, projectId: string): Promise<string> {
  const rows = await db.projectIntegrationJob.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { kind: true, generation: true, state: true, errorCode: true },
  });
  return `jobs: ${JSON.stringify(rows)}`;
}

/** Everything "the platform closed it because its candidate moved on" leaves on an item, said once. */
function assertMovedOn(
  item: Awaited<ReturnType<typeof itemById>>,
  state: 'SUPERSEDED' | 'RESOLVED',
  what: string,
): void {
  assert.equal(item.state, state, `${what} is closed — ${JSON.stringify(item)}`);
  assert.equal(item.resolution, 'PROMOTION_MOVED_ON', `${what}: the fact it was closed on`);
  assert.equal(item.resolvedBy, 'PLATFORM', `${what}: closed by the platform, nobody pressed anything`);
  assert.equal(item.resolvedByUserId, null);
  assert.ok(item.resolvedAt, `${what}: and when`);
}

// ── (1) superseded by a new landing ────────────────────────────────────────────────────────────

test('(1) a BLOCKED candidate superseded by a new landing takes its failure with it: SUPERSEDED, PROMOTION_MOVED_ON, PLATFORM',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'superseded', { line: 'PROJECT_BRANCH', automatic: false });
      const blocked = await blockedCandidate(stack, w);

      // Two more tasks finish: the fix, which lands, and one whose own landing conflicts — an item
      // about a task's landing on this same project, which no candidate moving on may close.
      await doneCodeTask(stack, w, `${w.label}-fix`);
      const otherTaskId = await doneCodeTask(stack, w, `${w.label}-other`);
      const fix = await onlyClaim(stack, w, 'LAND_TASK');
      assert.match(fix.sourceRef, /-fix$/, 'the queue hands the landings out in the order they were queued');
      await report(stack, w, fix, landed(LINE_FIRST, LINE_FIXED, LINE_FIXED_TREE));
      assert.equal((await promotionById(stack.db, blocked.promotionId)).state, 'BLOCKED',
        'the queue is not empty yet, so nothing is offered in the blocked candidate\'s place');
      const other = await onlyClaim(stack, w, 'LAND_TASK');
      await report(stack, w, other, {
        state: 'CONFLICT',
        phase: 'REBASE',
        sourceSha: TASK_BRANCH_TIP,
        targetShaBefore: LINE_FIXED,
        conflicts: ['src/web/src/pages/ProjectsPage.tsx'],
      });

      // The queue is empty now, so the landing that finished last made the candidate that replaces
      // the blocked one (M-T6) — and retired the blocked one in the same transaction.
      const retired = await promotionById(stack.db, blocked.promotionId);
      assert.equal(retired.state, 'SUPERSEDED', `the blocked candidate was replaced — ${await jobsOf(stack.db, w.projectId)}`);
      const replacing = await promotionOf(stack.db, w.projectId);
      assert.notEqual(replacing.id, blocked.promotionId);
      assert.equal(replacing.state, 'CHECKING');
      assert.equal(replacing.sourceSha, LINE_FIXED, 'the new candidate offers the tip the fix left');

      assertMovedOn(await itemById(stack.db, blocked.itemId), 'SUPERSEDED', 'the blocked candidate\'s failure');
      const others = (await integrationItems(stack.db, w.projectId)).filter((item) => item.id !== blocked.itemId);
      assert.equal(others.length, 1, `the other task's conflict opened its item — ${JSON.stringify(others)}`);
      assert.equal(others[0]!.taskId, otherTaskId);
      assert.equal(others[0]!.promotionId, null, 'it is about a task\'s landing, not about any candidate');
      assert.equal(others[0]!.state, 'OPEN', '…so a candidate moving on leaves it exactly where it was');
      assert.equal(others[0]!.resolution, null);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── (2) the refile path ────────────────────────────────────────────────────────────────────────

test('(2) the refile path: a candidate retired because its check looked at a branch the work did not end on takes its failure with it',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // A MAIN line, so a DONE offers the task branch itself (M-F2) — promotion-candidate-freeze's
      // case (2): the work started on one branch and ended on another, and the DONE froze the retry
      // created beside it, which carries nothing.
      const w = await world(stack, 'refiled', { line: 'MAIN', automatic: false });
      const taskId = randomUUID();
      await stack.db.task.create({
        data: {
          id: taskId,
          ownerId: w.ownerId,
          projectId: w.projectId,
          title: 'the work whose DONE froze a branch it had already left',
          status: TaskStatus.DONE,
          creatorType: 'AGENT',
          creatorId: w.ownerId,
          completionCriterion: 'EXECUTABLE',
        },
      });
      const whereItWent = `orbit/where-it-went-${taskId.slice(0, 6)}`;
      const startedHere = `orbit/started-here-${taskId.slice(0, 6)}`;
      const workSession = async (branch: string, createdAt: Date, finishedAt: Date) => {
        const id = randomUUID();
        await stack.db.session.create({
          data: {
            id,
            ownerId: w.ownerId,
            creatorId: w.ownerId,
            taskId,
            workspaceId: w.workspaceId,
            assignedRunnerId: w.runnerId,
            title: `ran ${branch}`,
            prompt: 'do the work',
            branch,
            isolationStatus: 'worktree',
            createdAt,
            status: RunStatus.SUCCEEDED,
            finishedAt,
            worktreeBranch: branch,
            worktreeDirty: false,
          },
        });
        return id;
      };
      const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
      const held = await workSession(whereItWent, minutesAgo(40), minutesAgo(5));
      await workSession(startedHere, minutesAgo(30), minutesAgo(29));
      const queued = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, taskId));
      assert.ok(queued.enqueued && queued.kind === 'PROMOTION', `the DONE queued no candidate: ${JSON.stringify(queued)}`);

      // The one row no door writes today: a failure about a candidate that is still being checked. A
      // failing check blocks its candidate, and nothing puts a blocked one back to CHECKING without
      // closing its old failures as it does — but the refile retires whatever stands on the branch
      // through the same supersession as a landing does, and this is what holds it to the same close.
      // Written by the helper the relay opens one with, so the row has the relay's shape.
      const failure = await stack.db.$transaction((tx) => recordIntegrationFailure(tx, {
        projectId: w.projectId,
        ownerId: w.ownerId,
        jobId: queued.jobId,
        taskId: null,
        sessionId: null,
        promotionId: queued.promotionId,
        state: 'CHECK_FAILED',
        title: integrationItemTitle('CHECK_FAILED', 'CHECK_PROMOTION', ''),
        dedupeKey: integrationDedupeKey('CHECK_FAILED', queued.jobId),
        payload: { jobKind: 'CHECK_PROMOTION' },
      }));
      assert.ok(failure, 'the failure about the candidate was recorded');

      const check = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      assert.equal(check.sourceRef, `refs/heads/${startedHere}`, 'the check is about the branch the DONE froze');
      const answer = await report(stack, w, check, {
        state: 'READY',
        phase: 'CHECK',
        sourceSha: TASK_BRANCH_TIP,
        upstreamSha: MAIN_CHECKED,
        testedTreeSha: CHECKED_TREE,
        aheadOfUpstream: 1,
        filesChanged: 1,
        checks: [],
        conflicts: [],
      });
      assert.equal(answer.accepted, true);

      // Retired, and the branch the work is on got the candidate it was owed — as before.
      assert.equal((await promotionById(stack.db, queued.promotionId)).state, 'SUPERSEDED',
        'the candidate about a branch the work did not end on was retired');
      const owed = await promotionOf(stack.db, w.projectId);
      assert.notEqual(owed.id, queued.promotionId);
      assert.equal(owed.sourceRef, `refs/heads/${whereItWent}`);
      assert.equal(owed.sessionId, held);
      assert.equal(owed.state, 'CHECKING');

      assertMovedOn(await itemById(stack.db, failure.itemId), 'SUPERSEDED', 'the retired candidate\'s failure');
      assert.equal(await openIntegrationItems(stack.db, w.projectId), 0, 'nothing about the retired candidate is left open');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── (3) declined ───────────────────────────────────────────────────────────────────────────────

test('(3) the owner declining a BLOCKED candidate closes its failure, and its card still says the owner declined it',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'declined', { line: 'PROJECT_BRANCH', automatic: false });
      const blocked = await blockedCandidate(stack, w);

      // The one row no door writes today: an approval card still open beside a BLOCKED candidate's
      // failure. A card is opened on READY and answered by the press, so today the two never stand on
      // one candidate together — but the decline answers both in one transaction, and the platform's
      // close of the failure must not take the place of the owner's answer on the card. Opened by the
      // helper the relay opens a card with, and named by the candidate the way the relay names it.
      const promotion = await promotionById(stack.db, blocked.promotionId);
      const cardId = await stack.db.$transaction(async (tx) => {
        const opened = await recordPromotionApproval(tx, {
          projectId: w.projectId,
          ownerId: w.ownerId,
          promotionId: promotion.id,
          jobId: promotion.checkJobId!,
          taskId: null,
          sessionId: promotion.sessionId,
          title: promotionItemTitle(promotion.upstreamRef, promotion.includedTaskIds.length),
          dedupeKey: promotionDedupeKey(promotion.id),
          payload: { promotionId: promotion.id, taskIds: promotion.includedTaskIds },
        });
        assert.ok(opened, 'the card was opened');
        await tx.projectPromotion.update({ where: { id: promotion.id }, data: { openItemId: opened } });
        return opened;
      });

      const view = await stack.promotions.decline({ userId: w.ownerId }, w.projectId, promotion.id);
      assert.equal(view.state, 'DECLINED');

      assertMovedOn(await itemById(stack.db, blocked.itemId), 'RESOLVED', 'the declined candidate\'s failure');
      const card = await itemById(stack.db, cardId);
      assert.equal(card.state, 'RESOLVED');
      assert.equal(card.resolution, 'DECLINED', 'the card keeps the owner\'s answer');
      assert.equal(card.resolvedBy, 'USER');
      assert.equal(card.resolvedByUserId, w.ownerId);
      assert.equal(await openIntegrationItems(stack.db, w.projectId), 0);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── (4) cancelled, then the late result ────────────────────────────────────────────────────────

test('(4) a CHECK_FAILED that comes back after the owner called the merge back opens nothing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'cancelled', { line: 'PROJECT_BRANCH', automatic: false });
      await landOnLine(stack, w, `${w.label}-first`, LINE_BEFORE, LINE_FIRST, LINE_FIRST_TREE);
      const check = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      await report(stack, w, check, cleanCheck(LINE_FIRST));
      const promotion = await promotionOf(stack.db, w.projectId);
      assert.equal(promotion.state, 'READY');
      await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, promotion.id, LINE_FIRST);
      const land = await onlyClaim(stack, w, 'LAND_PROMOTION');

      // The owner calls the merge back while the runner is in its checks: the job is asked to stop,
      // and the candidate ends now (M-T10).
      const view = await stack.promotions.cancel({ userId: w.ownerId }, w.projectId, promotion.id);
      assert.equal(view.state, 'CANCELLED');

      // The checks had already run, and come back red.
      const late = await report(stack, w, land, redCheck(LINE_FIRST));
      assert.equal(late.accepted, true, 'the runner\'s report is taken');
      assert.equal(late.openItemId, null, '…and opens nothing');
      assert.deepEqual(await integrationItems(stack.db, w.projectId), [],
        'no failure is opened about a candidate nobody is waiting on any more');
      const job = await stack.db.projectIntegrationJob.findUniqueOrThrow({
        where: { id: land.jobId },
        select: { state: true, cancelRequestedAt: true },
      });
      assert.equal(job.state, 'CHECK_FAILED', 'the report is kept where it belongs: on the job row');
      assert.ok(job.cancelRequestedAt, 'the job it reported on was the one asked to stop');
      assert.equal((await promotionById(stack.db, promotion.id)).state, 'CANCELLED',
        'and the candidate keeps the answer it already had');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── (5) BLOCKED → fixed → superseded → MERGED, with Automatic on ───────────────────────────────

test('(5) BLOCKED → fixed → superseded → MERGED with Automatic on: merged by itself, and nothing about a candidate is left open',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'fixed', { line: 'PROJECT_BRANCH', automatic: true });
      const blocked = await blockedCandidate(stack, w);
      assert.equal(await openIntegrationItems(stack.db, w.projectId), 1,
        'while it stands, the failure is one M-T11 counts against every merge of this project');

      // The fix lands; the candidate its landing makes replaces the blocked one, and the failure goes
      // with the candidate it was about.
      const fixTaskId = await landOnLine(stack, w, `${w.label}-fix`, LINE_FIRST, LINE_FIXED, LINE_FIXED_TREE);
      assert.equal((await promotionById(stack.db, blocked.promotionId)).state, 'SUPERSEDED');
      assertMovedOn(await itemById(stack.db, blocked.itemId), 'SUPERSEDED', 'the blocked candidate\'s failure');

      // M-T11: nothing it counts is open, so the replacing candidate's clean check is confirmed by the
      // setting — no card in front of the owner.
      const check = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      const checked = await report(stack, w, check, cleanCheck(LINE_FIXED));
      assert.equal(checked.openItemId, null, 'no card was opened');
      const confirmed = await promotionOf(stack.db, w.projectId);
      assert.notEqual(confirmed.id, blocked.promotionId);
      assert.equal(confirmed.state, 'CONFIRMED',
        `the superseded candidate's failure no longer holds the merge back — ${await jobsOf(stack.db, w.projectId)}`);
      assert.equal(confirmed.confirmedAutomatically, true);

      // …read once more when the landing is handed out, and it goes out.
      const land = await onlyClaim(stack, w, 'LAND_PROMOTION');
      assert.equal(land.automatic, true);
      const merged = await report(stack, w, land, {
        state: 'LANDED',
        phase: 'VERIFY',
        sourceSha: LINE_FIXED,
        targetShaBefore: MAIN_CHECKED,
        upstreamSha: MAIN_CHECKED,
        testedSha: MERGE_COMMIT,
        testedTreeSha: CHECKED_TREE,
        landedSha: MERGE_COMMIT,
        landedTreeSha: CHECKED_TREE,
        aheadOfUpstream: 2,
      });
      assert.equal(merged.accepted, true);
      const after = await promotionById(stack.db, confirmed.id);
      assert.equal(after.state, 'MERGED');
      assert.equal(after.mergedSha, MERGE_COMMIT);

      // The project ends with nothing open about any candidate it ever had, and both tasks on main.
      const open = await stack.db.projectOpenItem.findMany({
        where: { projectId: w.projectId, state: 'OPEN', promotionId: { not: null } },
        select: { id: true, kind: true, promotionId: true },
      });
      assert.deepEqual(open, [], 'no promotion item is left open');
      assert.equal(await openIntegrationItems(stack.db, w.projectId), 0, 'nor any integration failure');
      for (const taskId of [blocked.taskId, fixTaskId]) {
        const receipts = await stack.db.sessionMergeReceipt.count({ where: { taskId, targetBranch: 'main' } });
        assert.equal(receipts, 1, 'the work of both tasks is on main');
      }
    } finally {
      await stack.db.$disconnect();
    }
  });
