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
import type { IntegrationJobCommand } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { applyIntegrationJobResult, dispatchIntegrationJobs } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { taskLandingSql } from './project-criterion-landing';
import { canonicalRepoUrl } from './project-integration-line';
import { landingFailureClass } from './project-integration-job';
import { openItemMessage, readOpenItemDeliveryCard } from './project-open-item';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';

/**
 * The PLATFORM delivery of a MAIN line, by commit (`docs/project-integration-line-contract.md` §10.5
 * O-L2, O-L5, O-L6, §2.6 J12, §10.9 items 4 and 6).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-named-by-commit.pg.spec.ts
 *
 *  (1) §10.9 6, O-L5: a TASK_BRANCH candidate is named by the commit its task delivered — inserted with
 *      `source_sha = delivered_sha` when its DONE froze the identity, and named in place, with its queued
 *      check, by the finish that freezes it when the DONE was written while the work still moved (O-L4
 *      3); work that ended on another branch than the one the candidate offers is left to that branch;
 *  (2) §10.9 6, O-L5: the check and the landing are handed only to the runner the source session ran
 *      on — another runner of the owner's, with a checkout of the same repository, is handed neither. A
 *      runner that declares integration-observe/v1 is handed both by commit; one that does not is handed
 *      the check without `sourceSha`, to resolve the branch as it always has, and the landing as today;
 *      the landing's M9 receipt opens no LANDED_WITHOUT_CONFIRMATION (§10.9 4);
 *  (3) §10.9 6, J12: a runner that does not hold the delivered commit answers WORK_COMMIT_MISSING — the
 *      candidate BLOCKED as an ERROR, INTEGRATION_ERROR for the coordinator, the class `integration_retry`
 *      reruns — and the retry checks it again by the same commit;
 *  (4) §10.9 4, O-L6: a check that finds the delivered commit already on main writes O-R1's receipt,
 *      retires the candidate SUPERSEDED with its item PROMOTION_MOVED_ON and opens
 *      LANDED_WITHOUT_CONFIRMATION — never BLOCKED; J9 then releases the dependent and J10 starts it; a
 *      replay leaves one receipt; a runner from before, resolving the branch, is answered the same way;
 *      an empty branch writes the receipt only when no session reported work (O-L7, O-R2);
 *  (5) §10.9 4: the owner's own Merge opens no LANDED_WITHOUT_CONFIRMATION, while a Merge pressed from a
 *      session does — both retiring the candidate (M-T13);
 *  (6) O-L2: an AGENT_PUSH project's DONE builds no candidate and queues no CHECK_PROMOTION — the
 *      observation carries the work — and the DONE that starts its line back-fills none either;
 *  (7) §10.5 O-L8: a TASK_BRANCH check's SOURCE_BRANCH_MISSING from a runner that does not declare
 *      integration-observe/v1 at that moment names that runner on its title, detail line, next step and
 *      delivery text, with its state, code, class and doors unmoved, and the rerun it asks for retires
 *      the candidate; every other SOURCE_BRANCH_MISSING keeps its words, a project branch its title;
 *  (8) §10.5 O-L8: a TASK_BRANCH candidate's failure, in each class, says what is true of a MAIN line on
 *      each door it is served from, with its state, code, class and doors unmoved; a project branch's
 *      keeps its words. What those words promise holds: a fix's landing and more commits on the branch
 *      leave the candidate and the item as they are, the merge always asks, and the item closes by hand.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const JOB = 'integration-job/v1';
const OBSERVE = 'integration-observe/v1';
/** A runner of this revision: it takes a TASK_BRANCH command named by its commit (O-L5). */
const CURRENT = [JOB, OBSERVE];
/** A runner from before it: integration jobs, and the branch it fetches. */
const LEGACY = [JOB];
const sha = (nibble: string) => nibble.repeat(40);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const UPSTREAM = sha('9');

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
  prisma: PrismaService;
  tasks: TasksService;
  confirmations: TaskOwnerConfirmationService;
  openItems: ProjectOpenItemService;
  promotions: ProjectPromotionService;
  runnerApi: RunnerApiController;
}

/** The services the doors live in, over one client. Nothing reaches a device. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const push = new Proxy({}, { get: () => () => Promise.resolve() }) as unknown as PushService;
  const openItems = new ProjectOpenItemService(prisma, sessions, push);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
  const runnerApi = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  return {
    db,
    prisma,
    tasks,
    confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime),
    openItems,
    promotions: new ProjectPromotionService(prisma),
    runnerApi,
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  workDir: string;
  projectId: string;
  coordinatorSessionId: string;
  repoUrl: string;
}

/**
 * One owner, the runner the work runs on (online, beating, declaring `capabilities`), its workspace, a
 * live coordinator conversation, and a project on a MAIN line — started unless `lineStarted` is false —
 * in the delivery mode asked for.
 */
async function world(
  stack: Stack,
  label: string,
  options: {
    deliveryMode?: 'PLATFORM' | 'AGENT_PUSH';
    capabilities?: string[];
    /** The owner started the project, so a released dependent starts by itself (J10). */
    started?: boolean;
    /** Whether a DONE already started the line (L3); false leaves the line to the next DONE. */
    lineStarted?: boolean;
    /** A branch of its own for the line, instead of main: its candidates are PROJECT_BRANCH ones. */
    projectBranch?: boolean;
  } = {},
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/${label}-${projectId.slice(0, 8)}.git`;
  const workDir = `/srv/${label}`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@promotion-by-commit.invalid`, name: label, passwordHash: 'x' },
  });
  await runner(stack, ownerId, runnerId, `${label}-runner`, options.capabilities ?? CURRENT);
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl, workDir },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `coordinator: ${label}`, prompt: `coordinator: ${label}`, provider: 'claude',
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true, numTurns: 1, startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'finished work lands by the commit it delivered',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
      ...(options.started ? { startedAt: new Date() } : {}),
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: canonicalRepoUrl(repoUrl)!, upstreamRef: 'refs/heads/main',
      integrationRef: options.projectBranch ? `refs/heads/project/${projectId}` : 'refs/heads/main',
      refAuthority: 'REMOTE', remoteName: 'origin',
      integrationRefSource: 'EXPLICIT', deliveryMode: options.deliveryMode ?? 'PLATFORM',
      ...(options.lineStarted === false ? {} : { integrationStartedAt: new Date() }),
    },
  });
  return { ownerId, runnerId, workspaceId, workDir, projectId, coordinatorSessionId, repoUrl };
}

/** A runner of the owner's, beating now, declaring `capabilities`. */
async function runner(stack: Stack, ownerId: string, id: string, name: string, capabilities: string[]): Promise<void> {
  await stack.db.runner.create({
    data: {
      id, ownerId, name, tokenHash: `hash-${id}`, status: RunnerStatus.ONLINE, capabilities, maxConcurrent: 4,
      capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(), heartbeatLeaseOwner: randomUUID(),
    },
  });
}

/** Another runner of the same owner, current, with a checkout of the same repository. */
async function anotherRunner(stack: Stack, w: World, label: string): Promise<string> {
  const id = randomUUID();
  await runner(stack, w.ownerId, id, `${label}-runner`, CURRENT);
  await stack.db.workspace.create({
    data: {
      id: randomUUID(), ownerId: w.ownerId, runnerId: id, name: `${label}-workspace`, enabled: true,
      repoUrl: w.repoUrl, workDir: `/srv/${label}`,
    },
  });
  return id;
}

/** A code task the owner confirms: OWNER_CONFIRMED, in progress, under the project. */
async function ownerTask(stack: Stack, w: World, title: string): Promise<string> {
  const task = await stack.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title, projectId: w.projectId,
      assigneeId: w.workspaceId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'OWNER_CONFIRMED',
    },
    select: { id: true },
  });
  return task.id;
}

interface WorkSession {
  branch: string;
  /** Where the checkout's HEAD ended, when the agent moved it off `branch`. */
  worktreeBranch?: string;
  branchSha: string;
  baseSha: string;
  /** Finished this long ago; omitted, the session is live (RUNNING, no finish). */
  finishedMinutesAgo?: number;
  /** The files the runner reported the session changed; omitted, none. */
  changedFiles?: unknown[];
}

/** A worktree session of the task's work, as the runner's reports left it. */
async function workSession(stack: Stack, w: World, taskId: string, s: WorkSession): Promise<string> {
  const id = randomUUID();
  const finished = s.finishedMinutesAgo !== undefined;
  await stack.db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: `work ${s.branch}`, prompt: 'work', provider: 'claude',
      status: finished ? RunStatus.SUCCEEDED : RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, isolationStatus: 'worktree',
      branch: s.branch, branchSha: s.branchSha, baseSha: s.baseSha, numTurns: 1,
      startedAt: minutesAgo(30), createdAt: minutesAgo(30), runtimeSessionId: randomUUID(),
      ...(s.worktreeBranch ? { worktreeBranch: s.worktreeBranch } : {}),
      ...(s.changedFiles ? { changedFiles: s.changedFiles as Prisma.InputJsonValue } : {}),
      ...(finished ? { finishedAt: minutesAgo(s.finishedMinutesAgo!) } : {}),
    },
  });
  return id;
}

/** The owner's Confirm — the OWNER_CONFIRMED door's DONE write, which freezes a settled identity. */
async function confirm(stack: Stack, w: World, taskId: string): Promise<void> {
  const receipt = await stack.confirmations.decide(
    w.ownerId, taskId, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM' } as never,
  );
  assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
}

/** A code task whose work finished on `branch` at `branchSha`, written DONE by the owner's Confirm. */
async function finishedTask(
  stack: Stack, w: World, title: string, s: Omit<WorkSession, 'finishedMinutesAgo'>,
): Promise<{ taskId: string; sessionId: string }> {
  const taskId = await ownerTask(stack, w, title);
  const sessionId = await workSession(stack, w, taskId, { ...s, finishedMinutesAgo: 2 });
  await confirm(stack, w, taskId);
  return { taskId, sessionId };
}

/** The runner's own finalize of a live session: what writes its `finished_at` (O-L4 3). */
async function finalize(stack: Stack, w: World, sessionId: string): Promise<void> {
  await stack.runnerApi.finalize({ id: w.runnerId } as never, sessionId, {
    status: RunStatus.SUCCEEDED, isolationStatus: 'worktree',
  } as never);
  const row = await stack.db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { finishedAt: true } });
  assert.ok(row.finishedAt, 'CONTROL: the finalize wrote the finish');
}

/** The task's delivered identity (§10.4), as three of its five columns. */
async function identityOf(stack: Stack, taskId: string) {
  const task = await stack.db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { deliveredSha: true, deliveredBranch: true, deliveredSessionId: true },
  });
  return { sha: task.deliveredSha, branch: task.deliveredBranch, sessionId: task.deliveredSessionId };
}

/** The task's one TASK_BRANCH candidate that is still live, or its newest. */
async function candidateOf(stack: Stack, taskId: string) {
  return stack.db.projectPromotion.findFirstOrThrow({
    where: { taskId, sourceKind: 'TASK_BRANCH' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true, state: true, sourceRef: true, sourceSha: true, sessionId: true, checkJobId: true,
      landJobId: true, blockedReason: true, openItemId: true,
    },
  });
}

function jobOf(stack: Stack, jobId: string) {
  return stack.db.projectIntegrationJob.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      id: true, kind: true, state: true, generation: true, sourceRef: true, sourceSha: true, sessionId: true,
      errorCode: true, checks: true, receiptIds: true, cancelRequestedAt: true, runnerId: true,
    },
  });
}

/** One heartbeat of a runner process asking for integration work (J-T2). */
function dispatch(stack: Stack, runnerId: string, leaseOwner: string, capabilities: string[]) {
  return dispatchIntegrationJobs(stack.prisma, { runnerId, leaseOwner, draining: false, capabilities });
}

/** The command one beat hands out for exactly this job, or undefined when it is handed nothing for it. */
async function handed(
  stack: Stack, runnerId: string, leaseOwner: string, capabilities: string[], jobId: string | null,
): Promise<IntegrationJobCommand | undefined> {
  assert.ok(jobId, 'CONTROL: there is a job to hand out');
  return (await dispatch(stack, runnerId, leaseOwner, capabilities)).find((command) => command.jobId === jobId);
}

function report(stack: Stack, w: World, command: IntegrationJobCommand, body: object) {
  return applyIntegrationJobResult(stack.prisma, {
    jobId: command.jobId, runnerId: w.runnerId, ownerId: w.ownerId,
    body: { claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, ...body } as never,
  });
}

/** A check that passed on the commit it worked from (M-S4). */
const passed = (sourceSha: string) => ({
  state: 'READY', phase: 'CHECK', sourceSha, upstreamSha: UPSTREAM, targetShaBefore: UPSTREAM,
  testedSha: sha('7'), testedTreeSha: sha('6'), aheadOfUpstream: 1, filesChanged: 1, checks: [], conflicts: [],
});

/** A check that found the commit it worked from already on the upstream (M-S2). */
const alreadyThere = (sourceSha: string) => ({
  state: 'ALREADY_LANDED', phase: 'MERGE', sourceSha, upstreamSha: UPSTREAM, targetShaBefore: UPSTREAM,
});

function receiptsOf(stack: Stack, taskId: string) {
  return stack.db.sessionMergeReceipt.findMany({
    where: { taskId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, result: true, targetBranch: true, sourceBranch: true, sourceSha: true, targetShaBefore: true,
      targetShaAfter: true, recordedBy: true, detail: true, sessionId: true,
    },
  });
}

async function landingOf(stack: Stack, taskId: string): Promise<string> {
  const [row] = await stack.db.$queryRaw<Array<{ landing: string }>>(Prisma.sql`
    SELECT (${Prisma.raw(taskLandingSql('t'))}) AS "landing" FROM "task" t WHERE t."id" = ${taskId}::uuid`);
  return row!.landing;
}

function itemsOf(stack: Stack, w: World, kind: string) {
  return stack.db.projectOpenItem.findMany({
    where: { projectId: w.projectId, kind },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, title: true, state: true, resolution: true, assignee: true, assigneeReason: true, dedupeKey: true,
      taskId: true, promotionId: true, integrationJobId: true, payload: true, handlingJobId: true,
    },
  });
}

// ═══ (1) named at insertion, and by the finish ════════════════════════════════════════════════

test('(1) §10.9 6, O-L5: a TASK_BRANCH candidate is named by the commit its task delivered — when its DONE inserts it, or by the finish that freezes it',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'named');

      // The DONE froze the identity, so the candidate it inserts already names that commit.
      const done = await finishedTask(stack, w, 'delivered at its DONE', {
        branch: 'orbit/named', branchSha: sha('a'), baseSha: sha('b'),
      });
      assert.deepEqual(await identityOf(stack, done.taskId),
        { sha: sha('a'), branch: 'orbit/named', sessionId: done.sessionId }, 'CONTROL: the DONE froze the identity');
      const named = await candidateOf(stack, done.taskId);
      assert.equal(named.state, 'CHECKING');
      assert.equal(named.sourceRef, 'refs/heads/orbit/named');
      assert.equal(named.sessionId, done.sessionId);
      assert.equal(named.sourceSha, sha('a'),
        'O-L5: the candidate is inserted with source_sha = delivered_sha, not left for its check to resolve');
      const check = await jobOf(stack, named.checkJobId!);
      assert.deepEqual([check.kind, check.state, check.sourceSha, check.sessionId],
        ['CHECK_PROMOTION', 'QUEUED', sha('a'), done.sessionId], 'and the check queued beside it names the same commit');

      // A DONE written while the work still moved: the candidate is inserted with nothing to name it by,
      // and the finish that freezes the identity names it, and the check queued for it, in place. A
      // project of its own, because one project's checks run one at a time (`#check:<project>`).
      const m = await world(stack, 'named-moving');
      const moving = await ownerTask(stack, m, 'still moving at its DONE');
      const live = await workSession(stack, m, moving, { branch: 'orbit/moving', branchSha: sha('c'), baseSha: sha('b') });
      await confirm(stack, m, moving);
      assert.deepEqual(await identityOf(stack, moving), { sha: null, branch: null, sessionId: null },
        'CONTROL: nothing is frozen while a session of the task can still commit');
      const unnamed = await candidateOf(stack, moving);
      assert.equal(unnamed.sourceSha, null, 'nothing names the delivered commit yet');
      assert.equal((await jobOf(stack, unnamed.checkJobId!)).sourceSha, null);
      assert.equal(await handed(stack, m.runnerId, 'named-1', CURRENT, unnamed.checkJobId), undefined,
        'CONTROL: the claim guard holds the check while the work moves');

      await finalize(stack, m, live);
      assert.deepEqual(await identityOf(stack, moving), { sha: sha('c'), branch: 'orbit/moving', sessionId: live },
        'CONTROL: the finish froze the identity');
      const nowNamed = await candidateOf(stack, moving);
      assert.equal(nowNamed.id, unnamed.id, 'the same candidate, not a second one');
      assert.equal(nowNamed.state, 'CHECKING');
      assert.equal(nowNamed.sourceSha, sha('c'),
        'O-L4 3: the finish that froze the identity named the candidate by it, in the same transaction');
      const nowChecked = await jobOf(stack, nowNamed.checkJobId!);
      assert.deepEqual([nowChecked.id, nowChecked.state, nowChecked.sourceSha], [unnamed.checkJobId, 'QUEUED', sha('c')],
        'and its queued check, which is handed out by that commit');
      const command = await handed(stack, m.runnerId, 'named-2', CURRENT, nowNamed.checkJobId);
      assert.equal(command?.sourceSha, sha('c'));

      // Work that ended on another branch than the one the candidate offers is not named by that
      // commit: the candidate is left to its branch, as it was before.
      const movedOff = await ownerTask(stack, w, 'moved off the branch it started on');
      await workSession(stack, w, movedOff, {
        branch: 'orbit/started-here', worktreeBranch: 'orbit/ended-there', branchSha: sha('d'), baseSha: sha('b'),
        finishedMinutesAgo: 2,
      });
      await confirm(stack, w, movedOff);
      assert.equal((await identityOf(stack, movedOff)).branch, 'orbit/ended-there', 'CONTROL: frozen on the branch it ended on');
      const elsewhere = await candidateOf(stack, movedOff);
      assert.equal(elsewhere.sourceRef, 'refs/heads/orbit/started-here');
      assert.equal(elsewhere.sourceSha, null,
        'the delivered commit is not the tip of the branch this candidate offers, so it is not named by it');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (2) who is handed it, and in what shape ══════════════════════════════════════════════════

test('(2) §10.9 6, O-L5: only the source session\'s runner is handed the check and the landing — by commit when it declares integration-observe/v1, as before when it does not; M9 opens no LANDED_WITHOUT_CONFIRMATION',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'routed');
      const elsewhere = await anotherRunner(stack, w, 'routed-elsewhere');
      const t = await finishedTask(stack, w, 'checked where it was made', {
        branch: 'orbit/routed', branchSha: sha('a'), baseSha: sha('b'),
      });
      const candidate = await candidateOf(stack, t.taskId);

      assert.equal(await handed(stack, elsewhere, 'elsewhere-1', CURRENT, candidate.checkJobId), undefined,
        'another runner of the owner, with a checkout of the same repository, is not handed the check: '
          + 'only the source session\'s runner holds the delivered commit');
      const check = await handed(stack, w.runnerId, 'source-1', CURRENT, candidate.checkJobId);
      assert.ok(check, 'the source session\'s runner is');
      assert.equal(check.kind, 'CHECK_PROMOTION');
      assert.equal(check.promotionSourceKind, 'TASK_BRANCH');
      assert.equal(check.sourceSha, sha('a'), 'named by its commit (O-L5)');
      assert.equal(check.sourceRef, 'refs/heads/orbit/routed');
      assert.equal(check.workDir, w.workDir);
      await report(stack, w, check, passed(sha('a')));
      const ready = await candidateOf(stack, t.taskId);
      assert.deepEqual([ready.state, ready.sourceSha], ['READY', sha('a')]);

      await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, candidate.id, sha('a'));
      const confirmed = await candidateOf(stack, t.taskId);
      assert.equal(confirmed.state, 'CONFIRMED');
      assert.equal(await handed(stack, elsewhere, 'elsewhere-2', CURRENT, confirmed.landJobId), undefined,
        'nor the landing, which a runner of this revision also takes by its commit');
      const land = await handed(stack, w.runnerId, 'source-2', CURRENT, confirmed.landJobId);
      assert.ok(land);
      assert.deepEqual([land.kind, land.promotionSourceKind, land.sourceSha], ['LAND_PROMOTION', 'TASK_BRANCH', sha('a')]);
      await report(stack, w, land, {
        state: 'LANDED', phase: 'VERIFY', sourceSha: sha('a'), upstreamSha: UPSTREAM, targetShaBefore: UPSTREAM,
        testedSha: sha('5'), testedTreeSha: sha('6'), landedSha: sha('5'), landedTreeSha: sha('6'), checks: [],
      });
      assert.equal((await candidateOf(stack, t.taskId)).state, 'MERGED');
      const [m9] = await receiptsOf(stack, t.taskId);
      assert.equal(m9.result, 'MERGED');
      assert.equal((m9.detail as { integrationJobId?: string }).integrationJobId, confirmed.landJobId);
      assert.deepEqual(await itemsOf(stack, w, 'LANDED_WITHOUT_CONFIRMATION'), [],
        '§10.9 4: a confirmed promotion\'s own receipt (M9) is not put in front of the owner again');

      // A runner from before this revision: the candidate is named all the same, but the check is
      // handed to it in the shape it knows — no commit, so it fetches the branch and resolves it — and
      // what it resolved is what the owner is asked about and what the landing is handed.
      const old = await world(stack, 'legacy', { capabilities: LEGACY });
      const lt = await finishedTask(stack, old, 'checked by a runner from before', {
        branch: 'orbit/legacy', branchSha: sha('c'), baseSha: sha('b'),
      });
      const legacy = await candidateOf(stack, lt.taskId);
      assert.equal(legacy.sourceSha, sha('c'), 'the row is named whichever runner will check it');
      const legacyCheck = await handed(stack, old.runnerId, 'legacy-1', LEGACY, legacy.checkJobId);
      assert.ok(legacyCheck, 'the source session\'s runner is handed the check, whatever it declares');
      assert.equal(legacyCheck.sourceSha, undefined,
        'a runner that has not declared integration-observe/v1 is not handed a check named by its commit');
      assert.equal(legacyCheck.promotionSourceKind, 'TASK_BRANCH');
      assert.equal(legacyCheck.sourceRef, 'refs/heads/orbit/legacy');
      await report(stack, old, legacyCheck, passed(sha('e')));
      const legacyReady = await candidateOf(stack, lt.taskId);
      assert.deepEqual([legacyReady.state, legacyReady.sourceSha], ['READY', sha('e')],
        'the tip it resolved off the branch is the commit the owner is asked about');
      await stack.promotions.confirm({ userId: old.ownerId }, old.projectId, legacy.id, sha('e'));
      const legacyLand = await handed(stack, old.runnerId, 'legacy-2', LEGACY, (await candidateOf(stack, lt.taskId)).landJobId);
      assert.ok(legacyLand);
      assert.deepEqual([legacyLand.kind, legacyLand.promotionSourceKind, legacyLand.sourceSha],
        ['LAND_PROMOTION', 'TASK_BRANCH', sha('e')], 'the landing in today\'s shape');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (3) WORK_COMMIT_MISSING ═══════════════════════════════════════════════════════════════════

test('(3) §10.9 6, J12: a runner without the delivered commit answers WORK_COMMIT_MISSING — INTEGRATION_ERROR for the coordinator, an ERROR to run again, and integration_retry checks it again by the same commit',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'missing');
      const t = await finishedTask(stack, w, 'made on a machine that lost it', {
        branch: 'orbit/missing', branchSha: sha('a'), baseSha: sha('b'),
      });
      const candidate = await candidateOf(stack, t.taskId);
      const check = await handed(stack, w.runnerId, 'missing-1', CURRENT, candidate.checkJobId);
      assert.ok(check);
      const answered = await report(stack, w, check, {
        state: 'ERROR', phase: 'FETCH', errorCode: 'WORK_COMMIT_MISSING',
        errorDetail: { sha: sha('a'), ref: 'refs/heads/orbit/missing', detail: `commit ${sha('a')} is not in this runner's repository` },
      });
      assert.equal(answered.answer.accepted, true);
      const job = await jobOf(stack, check.jobId);
      assert.deepEqual([job.state, job.errorCode], ['ERROR', 'WORK_COMMIT_MISSING']);
      assert.equal(landingFailureClass(job), 'ERROR', 'J12\'s new code fails as an ERROR');
      const blocked = await candidateOf(stack, t.taskId);
      assert.deepEqual([blocked.state, blocked.blockedReason, blocked.sourceSha], ['BLOCKED', 'ERROR', sha('a')]);
      const [item, ...more] = await itemsOf(stack, w, 'INTEGRATION_ERROR');
      assert.equal(more.length, 0);
      assert.equal(answered.answer.openItemId, item.id);
      assert.deepEqual([item.state, item.assignee, item.promotionId, item.integrationJobId],
        ['OPEN', 'COORDINATOR', candidate.id, check.jobId]);
      assert.equal((item.payload as { errorCode?: string }).errorCode, 'WORK_COMMIT_MISSING');

      const retried = await stack.openItems.retryPromotionCheck(
        w.ownerId, w.projectId, candidate.id, { reason: 'the commit is in this checkout again' }, w.coordinatorSessionId,
      );
      assert.equal(retried.failureClass, 'ERROR');
      assert.equal(retried.retryOfJobId, check.jobId);
      const rechecking = await candidateOf(stack, t.taskId);
      assert.deepEqual([rechecking.state, rechecking.checkJobId, rechecking.sourceSha],
        ['CHECKING', retried.jobId, sha('a')]);
      const rerun = await jobOf(stack, retried.jobId);
      assert.deepEqual([rerun.kind, rerun.generation, rerun.sourceSha], ['CHECK_PROMOTION', 2, sha('a')]);
      const [handling] = await itemsOf(stack, w, 'INTEGRATION_ERROR');
      assert.deepEqual([handling.state, handling.handlingJobId], ['OPEN', retried.jobId], 'H1: being handled by the rerun');
      const again = await handed(stack, w.runnerId, 'missing-2', CURRENT, retried.jobId);
      assert.equal(again?.sourceSha, sha('a'), 'checked again by the same commit');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (4) O-L6: the check sees the work on main ═══════════════════════════════════════════════

test('(4) §10.9 4, O-L6: a check that finds the delivered commit already on main writes the receipt, retires the candidate SUPERSEDED with its item PROMOTION_MOVED_ON and opens LANDED_WITHOUT_CONFIRMATION, pushed once after the commit — never BLOCKED; J9 releases the dependent and J10 starts it',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'seen', { started: true });
      const pushed = await ownerTask(stack, w, 'pushed to main past its card');
      const sessionId = await workSession(stack, w, pushed, {
        branch: 'orbit/seen', branchSha: sha('a'), baseSha: sha('b'), finishedMinutesAgo: 2,
      });
      const dependent = await stack.tasks.create(w.ownerId, {
        title: 'waits for the pushed work', projectId: w.projectId, assigneeId: w.workspaceId,
        autoRunWhenReady: true, completionCriterion: 'OWNER_CONFIRMED', dependsOnTaskIds: [pushed],
      } as never);
      await confirm(stack, w, pushed);
      const candidate = await candidateOf(stack, pushed);

      // A first check fails, so the candidate has an item about it when the work is found on main.
      const first = await handed(stack, w.runnerId, 'seen-1', CURRENT, candidate.checkJobId);
      assert.ok(first);
      await report(stack, w, first, { state: 'ERROR', phase: 'FETCH', errorCode: 'WORK_COMMIT_MISSING' });
      const [failure] = await itemsOf(stack, w, 'INTEGRATION_ERROR');
      assert.equal(failure.state, 'OPEN', 'CONTROL: the failed check opened its item');
      await assert.rejects(stack.tasks.execute(w.ownerId, dependent.id), /not landed|not on main/i,
        'CONTROL: J9 holds the dependent while the work is not known to be on main');

      const retried = await stack.openItems.retryPromotionCheck(
        w.ownerId, w.projectId, candidate.id, { reason: 'run it where the commit is' }, w.coordinatorSessionId,
      );
      const check = await handed(stack, w.runnerId, 'seen-2', CURRENT, retried.jobId);
      assert.ok(check);
      const applied = await report(stack, w, check, alreadyThere(sha('a')));
      assert.equal(applied.answer.accepted, true);
      assert.equal(applied.answer.state, 'ALREADY_LANDED');
      assert.equal(applied.answer.receiptIds.length, 1);

      // O-R1's receipt: the check is itself an observation.
      const [receipt, ...extra] = await receiptsOf(stack, pushed);
      assert.equal(extra.length, 0);
      assert.deepEqual(
        [receipt.result, receipt.targetBranch, receipt.sourceBranch, receipt.sourceSha, receipt.targetShaBefore,
          receipt.targetShaAfter, receipt.recordedBy, receipt.sessionId],
        ['ALREADY_MERGED', 'main', 'orbit/seen', sha('a'), UPSTREAM, null, 'RUNNER', sessionId],
      );
      assert.deepEqual(receipt.detail, { integrationJobId: check.jobId, observed: true });
      assert.deepEqual(applied.answer.receiptIds, [receipt.id]);
      const job = await jobOf(stack, check.jobId);
      assert.deepEqual([job.state, job.receiptIds, job.cancelRequestedAt], ['ALREADY_LANDED', [receipt.id], null],
        'the check answered, and its own retirement of the candidate did not ask it to stop');

      // M-T13, not M-T3.
      const retired = await candidateOf(stack, pushed);
      assert.equal(retired.id, candidate.id);
      assert.equal(retired.state, 'SUPERSEDED', 'retired by the receipt, never BLOCKED');
      assert.equal(retired.blockedReason, null);
      const [closed] = await itemsOf(stack, w, 'INTEGRATION_ERROR');
      assert.deepEqual([closed.id, closed.state, closed.resolution], [failure.id, 'RESOLVED', 'PROMOTION_MOVED_ON']);

      // O-R3: it reached main without the owner's confirmation.
      const [unconfirmed, ...twice] = await itemsOf(stack, w, 'LANDED_WITHOUT_CONFIRMATION');
      assert.equal(twice.length, 0);
      assert.deepEqual(
        [unconfirmed.taskId, unconfirmed.assignee, unconfirmed.assigneeReason, unconfirmed.dedupeKey, unconfirmed.state],
        [pushed, 'OWNER', 'DEFAULT', `UL:${pushed}:${receipt.id}`, 'OPEN'],
      );
      assert.deepEqual(unconfirmed.payload,
        { receiptId: receipt.id, recordedBy: 'RUNNER', targetBranch: 'main', sourceSha: sha('a'), observed: true });
      assert.equal(await landingOf(stack, pushed), 'ON_UPSTREAM');

      // J10, after the commit: what the receipt released is dispatched, and in a project that moves by
      // itself the dependent J9 now lets through starts on its own.
      const after = applied.after as {
        projectId: string; landedTaskId: string | null; landedTaskIds?: string[]; ownerItemIds?: string[];
      } | null;
      assert.ok(after);
      assert.deepEqual(after.landedTaskIds ?? [after.landedTaskId], [pushed]);
      // §7.6 V12 (owner 2026-10-28): the result hands the item it opened to the post-commit edge, which
      // pushes it once — the edge the result door's controller calls (`afterIntegrationResult`).
      assert.deepEqual(after.ownerItemIds, [unconfirmed.id], 'the result did not hand over the item it opened');
      const dispatched: string[] = [];
      const told: string[] = [];
      // The fifth argument is the owner-item notifier R29-9 adds; a tree without it ignores it.
      const j10 = new (MergeReceiptService as unknown as new (...args: unknown[]) => MergeReceiptService)(
        stack.prisma, undefined, {
          dispatchDependentsOf: (ownerId: string, doneTaskId: string) => {
            dispatched.push(doneTaskId);
            return stack.tasks.dispatchDependentsOf(ownerId, doneTaskId);
          },
        }, undefined, { notifyOwnerItem: async (itemId: string) => { told.push(itemId); } },
      );
      await (j10.deliverProjectFactsAfterCommit as (...args: unknown[]) => Promise<void>)
        .call(j10, after.projectId, after.landedTaskIds ?? after.landedTaskId, { ownerItemIds: after.ownerItemIds });
      assert.deepEqual(dispatched, [pushed], 'J10 dispatched what the receipt released');
      assert.equal(await stack.db.session.count({ where: { taskId: dependent.id } }), 1,
        'J10 started the dependent by itself');
      assert.deepEqual(told, [unconfirmed.id], 'the owner\'s phone was not told once');

      // A replayed result finds the job written down: one receipt.
      const replay = await report(stack, w, check, alreadyThere(sha('a')));
      assert.equal(replay.answer.accepted, false);
      assert.equal(replay.after, null, 'a replay hands nothing over to push again');
      assert.equal((await receiptsOf(stack, pushed)).length, 1);

      // A runner from before this revision resolved the branch, found it on main: the same answer.
      const old = await world(stack, 'seen-legacy', { capabilities: LEGACY });
      const lt = await finishedTask(stack, old, 'seen by a runner from before', {
        branch: 'orbit/seen-legacy', branchSha: sha('c'), baseSha: sha('b'),
      });
      const legacy = await candidateOf(stack, lt.taskId);
      const legacyCheck = await handed(stack, old.runnerId, 'seen-legacy-1', LEGACY, legacy.checkJobId);
      assert.ok(legacyCheck);
      await report(stack, old, legacyCheck, alreadyThere(sha('c')));
      const [legacyReceipt] = await receiptsOf(stack, lt.taskId);
      assert.deepEqual([legacyReceipt?.result, legacyReceipt?.sourceBranch, legacyReceipt?.sourceSha],
        ['ALREADY_MERGED', 'orbit/seen-legacy', sha('c')]);
      assert.equal((await candidateOf(stack, lt.taskId)).state, 'SUPERSEDED');
      assert.equal((await itemsOf(stack, old, 'LANDED_WITHOUT_CONFIRMATION')).length, 1);

      // O-L7 / O-R2: a branch that carried no commit of its own is on every line it forked from, so its
      // ALREADY_LANDED says nothing by itself. With no session that reported work, there was nothing to
      // land: the receipt, marked empty, raises nothing. With one that did, the work is elsewhere and no
      // receipt claims it — the candidate is BLOCKED as before.
      const empty = await finishedTask(stack, w, 'carried nothing', {
        branch: 'orbit/nothing', branchSha: sha('b'), baseSha: sha('b'),
      });
      const emptyCheck = await handed(stack, w.runnerId, 'seen-3', CURRENT, (await candidateOf(stack, empty.taskId)).checkJobId);
      assert.ok(emptyCheck);
      await report(stack, w, emptyCheck, alreadyThere(sha('b')));
      const [emptyReceipt] = await receiptsOf(stack, empty.taskId);
      assert.deepEqual(emptyReceipt?.detail, { integrationJobId: emptyCheck.jobId, observed: true, empty: true });
      assert.equal((await candidateOf(stack, empty.taskId)).state, 'SUPERSEDED');
      const workedElsewhere = await finishedTask(stack, w, 'worked somewhere this branch is not', {
        branch: 'orbit/elsewhere', branchSha: sha('b'), baseSha: sha('b'), changedFiles: [{ path: 'a.txt' }],
      });
      const elsewhereCheck = await handed(stack, w.runnerId, 'seen-4', CURRENT,
        (await candidateOf(stack, workedElsewhere.taskId)).checkJobId);
      assert.ok(elsewhereCheck);
      await report(stack, w, elsewhereCheck, alreadyThere(sha('b')));
      assert.deepEqual(await receiptsOf(stack, workedElsewhere.taskId), [], 'no receipt claims work that is not there');
      const stillBlocked = await candidateOf(stack, workedElsewhere.taskId);
      assert.deepEqual([stillBlocked.state, stillBlocked.blockedReason], ['BLOCKED', 'ALREADY_LANDED']);
      assert.deepEqual((await itemsOf(stack, w, 'LANDED_WITHOUT_CONFIRMATION')).map((item) => item.taskId), [pushed],
        'neither empty branch raised LANDED_WITHOUT_CONFIRMATION');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (5) the owner's own Merge ═══════════════════════════════════════════════════════════════

test('(5) §10.9 4: the owner\'s own Merge opens no LANDED_WITHOUT_CONFIRMATION, a Merge pressed from a session does — both retire the candidate',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'pressed');
      const pressed: Record<'USER' | 'AGENT', { taskId: string; candidateId: string }> = {} as never;
      for (const requestedBy of ['USER', 'AGENT'] as const) {
        const t = await finishedTask(stack, w, `merged by ${requestedBy}`, {
          branch: `orbit/pressed-${requestedBy}`, branchSha: sha('a'), baseSha: sha('b'),
        });
        const candidate = await candidateOf(stack, t.taskId);
        pressed[requestedBy] = { taskId: t.taskId, candidateId: candidate.id };
        await stack.db.$transaction((tx) => MergeReceiptService.fromRunnerMergeResult(tx, {
          ownerId: w.ownerId, sessionId: t.sessionId, taskId: t.taskId, projectId: w.projectId, result: 'MERGED',
          sourceBranch: `orbit/pressed-${requestedBy}`, sourceSha: sha('a'), targetBranch: 'main',
          targetShaBefore: sha('b'), targetShaAfter: sha('8'), rebaseBaseSha: sha('b'), conflicts: [], message: null,
          operationId: randomUUID(), requestedBy,
        }));
        assert.equal((await candidateOf(stack, t.taskId)).state, 'SUPERSEDED', `M-T13 retired the candidate (${requestedBy})`);
      }
      assert.deepEqual((await itemsOf(stack, w, 'LANDED_WITHOUT_CONFIRMATION')).map((item) => item.taskId),
        [pressed.AGENT.taskId], 'the owner\'s own press is the confirmation; a session\'s press is not');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (6) O-L2: AGENT_PUSH builds no candidate ════════════════════════════════════════════════

test('(6) O-L2: an AGENT_PUSH project\'s DONE builds no candidate and queues no CHECK_PROMOTION — the observation carries the work — and the DONE that starts its line back-fills none',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const routes = (w: World) => Promise.all([
        stack.db.projectPromotion.count({ where: { projectId: w.projectId } }),
        stack.db.projectIntegrationJob.count({ where: { projectId: w.projectId, kind: { in: ['CHECK_PROMOTION', 'LAND_PROMOTION'] } } }),
        stack.db.projectIntegrationJob.count({ where: { projectId: w.projectId, kind: 'OBSERVE_LANDING' } }),
      ]);

      const w = await world(stack, 'agent-push', { deliveryMode: 'AGENT_PUSH' });
      const t = await finishedTask(stack, w, 'pushed by its agent', { branch: 'orbit/agent-push', branchSha: sha('a'), baseSha: sha('b') });
      assert.equal((await identityOf(stack, t.taskId)).sha, sha('a'), 'CONTROL: the DONE froze the identity');
      assert.deepEqual(await routes(w), [0, 0, 1],
        'no candidate and no CHECK_PROMOTION: the owner authorized the agent\'s own push, and the observation (O-T1) sees it');

      // The DONE that starts the line (L3) back-fills the project's other finished code tasks — as
      // candidates on a PLATFORM MAIN line, as nothing at all here.
      const fresh = await world(stack, 'agent-push-fresh', { deliveryMode: 'AGENT_PUSH', lineStarted: false });
      const earlier = await stack.db.task.create({
        data: {
          ownerId: fresh.ownerId, creatorType: 'USER', creatorId: fresh.ownerId, title: 'finished before the line started',
          projectId: fresh.projectId, assigneeId: fresh.workspaceId, status: TaskStatus.DONE,
          completionCriterion: 'OWNER_CONFIRMED',
        },
        select: { id: true },
      });
      await workSession(stack, fresh, earlier.id, {
        branch: 'orbit/earlier', branchSha: sha('c'), baseSha: sha('b'), finishedMinutesAgo: 20,
      });
      await finishedTask(stack, fresh, 'starts the line', { branch: 'orbit/starts', branchSha: sha('d'), baseSha: sha('b') });
      const line = await stack.db.projectCodebase.findFirstOrThrow({
        where: { projectId: fresh.projectId }, select: { integrationStartedAt: true },
      });
      assert.ok(line.integrationStartedAt, 'CONTROL: this DONE started the line');
      const [promotions, promotionJobs] = await routes(fresh);
      assert.deepEqual([promotions, promotionJobs], [0, 0], 'nothing back-filled as a candidate');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (7) O-L8: the out-of-date runner's item ═════════════════════════════════════════════════

/** What a fetch of a branch the remote does not have answers (M-S1, `fetchRefFailure`). */
const branchMissing = (ref: string) => ({
  state: 'ERROR', phase: 'FETCH', errorCode: 'SOURCE_BRANCH_MISSING',
  errorDetail: { ref, detail: `fatal: couldn't find remote ref ${ref}` },
});

/** The next step this item's failure has on a project on main, when no task's branch is named. */
const REPAIR = 'The project branch cannot reach main until this integration is repaired — re-run it or ask the coordinator to fix it.';
/** The same failure of a TASK_BRANCH candidate, in its coordinator's cell (§10.5 O-L8). */
const REPAIR_TASK_BRANCH = 'This task’s branch cannot reach main until this integration is repaired — re-run it or file a fix task.';

/** The one sentence the delivery text gains, for a runner of this name. */
const doesNotDeclare = (name: string) => `Runner ${name} does not declare integration-observe/v1, so it looked for this task's `
  + 'branch on the remote by name. That says nothing about whether the task has work to land. '
  + 'Update the runner, then run integration_retry on this candidate.';

/**
 * The project's one failure of this kind, as each door serves it: its row, the open items read, the
 * delivery card and the turn its coordinator is told in.
 */
async function servedError(stack: Stack, w: World, kind = 'INTEGRATION_ERROR') {
  const [item, ...more] = await itemsOf(stack, w, kind);
  assert.ok(item, 'CONTROL: the failure opened an item');
  assert.equal(more.length, 0, 'one failure, one item');
  const listed = await stack.openItems.list(w.ownerId, w.projectId);
  const row = [...listed.needsYou, ...listed.withCoordinator].find((each) => each.itemId === item.id);
  assert.ok(row, 'CONTROL: the open items read lists it');
  const card = await readOpenItemDeliveryCard(stack.prisma, item.id, w.ownerId);
  assert.ok(card, 'CONTROL: it reads as a card');
  assert.equal(card.requiredAction, row.requiredAction, 'the card and the list say one next step');
  const told = openItemMessage({
    id: item.id, kind, title: item.title, projectId: w.projectId, taskId: item.taskId,
    promotionId: item.promotionId, payload: item.payload,
  });
  return {
    item, row, card, told,
    payload: item.payload as { outdatedRunner?: unknown; errorCode?: unknown; failureClass?: unknown; sourceKind?: unknown },
  };
}

/** The check of a TASK_BRANCH candidate for a task whose branch was never pushed and never moved off `base`. */
async function checkOfAnEmptyBranch(stack: Stack, w: World, label: string, capabilities: string[]) {
  const t = await finishedTask(stack, w, 'Backfill order stats', {
    branch: `orbit/${label}`, branchSha: sha('b'), baseSha: sha('b'), changedFiles: [],
  });
  const candidate = await candidateOf(stack, t.taskId);
  const check = await handed(stack, w.runnerId, `${label}-1`, capabilities, candidate.checkJobId);
  assert.ok(check, 'CONTROL: the source session\'s runner is handed the check');
  return { ...t, candidate, check };
}

test('(7) §10.5 O-L8: a TASK_BRANCH check\'s SOURCE_BRANCH_MISSING from a runner that does not declare integration-observe/v1 names that runner, with its state, code, class and doors unmoved, and the rerun it asks for retires the candidate',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const old = await world(stack, 'outdated', { capabilities: LEGACY });
      const { taskId, candidate, check } = await checkOfAnEmptyBranch(stack, old, 'outdated', LEGACY);
      assert.equal(check.sourceSha, undefined, 'CONTROL: this runner is handed no commit, so it looks for the branch by name');
      await report(stack, old, check, branchMissing('refs/heads/orbit/outdated'));

      const outdated = await servedError(stack, old);
      assert.equal(outdated.item.title, 'Integration error: merging “Backfill order stats” into main');
      assert.equal(outdated.row.detailLine, 'Runner outdated-runner is out of date: update it, then run this check again.');
      assert.equal(outdated.row.requiredAction, 'Update runner outdated-runner, then run this check again.');
      assert.equal(outdated.payload.outdatedRunner, 'outdated-runner', 'at the payload\'s top level');
      assert.ok(outdated.told.includes(`The integration job ended with an error: SOURCE_BRANCH_MISSING.\n${doesNotDeclare('outdated-runner')}\n`),
        `the sentence follows the error code:\n${outdated.told}`);

      // A runner that declares it: the same failure of the same kind of candidate, which is what the
      // new case's state, code, class and doors are held against. Its title is its source's (O-L8 names
      // the source there, not the runner), and nothing else about it changes.
      const current = await world(stack, 'declares');
      const named = await checkOfAnEmptyBranch(stack, current, 'declares', CURRENT);
      await report(stack, current, named.check, branchMissing('refs/heads/orbit/declares'));
      const today = await servedError(stack, current);
      assert.equal(today.item.title, 'Integration error: merging “Backfill order stats” into main');
      assert.equal(today.row.detailLine, '');
      assert.equal(today.row.requiredAction, REPAIR_TASK_BRANCH);
      assert.equal(today.payload.outdatedRunner, undefined);
      assert.doesNotMatch(today.told, /does not declare|out of date/);

      for (const [what, served, jobId, taskIdOf] of [
        ['the out-of-date runner', outdated, check.jobId, taskId],
        ['the current runner', today, named.check.jobId, named.taskId],
      ] as const) {
        const job = await jobOf(stack, jobId);
        assert.deepEqual([job.state, job.errorCode, landingFailureClass(job)], ['ERROR', 'SOURCE_BRANCH_MISSING', 'ERROR'], what);
        assert.deepEqual([served.item.state, served.item.assignee, served.item.assigneeReason, served.payload.errorCode, served.payload.failureClass],
          ['OPEN', 'COORDINATOR', 'DEFAULT', 'SOURCE_BRANCH_MISSING', 'ERROR'], what);
        const blocked = await candidateOf(stack, taskIdOf);
        assert.deepEqual([blocked.state, blocked.blockedReason, blocked.sourceSha], ['BLOCKED', 'ERROR', sha('b')],
          `${what}: a candidate still named by the commit it delivered`);
      }
      assert.deepEqual([outdated.row.kind, outdated.row.actions, outdated.row.primaryAction, outdated.row.facts?.errorCode],
        [today.row.kind, today.row.actions, today.row.primaryAction, today.row.facts?.errorCode], 'the same doors');
      assert.ok(outdated.row.actions.includes('RETRY'), 'CONTROL: and they include the rerun it asks for');

      // Its promise: the runner is updated, the rerun checks by the commit, and the line answers.
      await stack.db.runner.update({ where: { id: old.runnerId }, data: { capabilities: CURRENT } });
      const retried = await stack.openItems.retryPromotionCheck(
        old.ownerId, old.projectId, candidate.id, { reason: 'the runner is updated' }, old.coordinatorSessionId,
      );
      const byCommit = await handed(stack, old.runnerId, 'outdated-2', CURRENT, retried.jobId);
      assert.equal(byCommit?.sourceSha, sha('b'), 'the rerun names the commit');
      await report(stack, old, byCommit!, alreadyThere(sha('b')));
      assert.equal((await candidateOf(stack, taskId)).state, 'SUPERSEDED');
      const [closed] = await itemsOf(stack, old, 'INTEGRATION_ERROR');
      assert.deepEqual([closed.id, closed.state, closed.resolution], [outdated.item.id, 'RESOLVED', 'PROMOTION_MOVED_ON']);
      const [receipt] = await receiptsOf(stack, taskId);
      assert.deepEqual(receipt?.detail, { integrationJobId: retried.jobId, observed: true, empty: true });

      // The same code over real work: what it said about the task was indeed nothing. The rerun's check
      // passes, the owner is asked about the merge, and the item's settled row asks nothing any more.
      const working = await world(stack, 'outdated-work', { capabilities: LEGACY });
      const fix = await finishedTask(stack, working, 'Fix the order totals', {
        branch: 'orbit/outdated-work', branchSha: sha('a'), baseSha: sha('b'), changedFiles: [{ path: 'totals.ts' }],
      });
      const fixCandidate = await candidateOf(stack, fix.taskId);
      const firstCheck = await handed(stack, working.runnerId, 'outdated-work-1', LEGACY, fixCandidate.checkJobId);
      await report(stack, working, firstCheck!, branchMissing('refs/heads/orbit/outdated-work'));
      const failed = await servedError(stack, working);
      assert.equal(failed.row.requiredAction, 'Update runner outdated-work-runner, then run this check again.');
      await stack.db.runner.update({ where: { id: working.runnerId }, data: { capabilities: CURRENT } });
      const rerun = await stack.openItems.retryPromotionCheck(
        working.ownerId, working.projectId, fixCandidate.id, { reason: 'the runner is updated' }, working.coordinatorSessionId,
      );
      const secondCheck = await handed(stack, working.runnerId, 'outdated-work-2', CURRENT, rerun.jobId);
      assert.equal(secondCheck?.sourceSha, sha('a'));
      await report(stack, working, secondCheck!, passed(sha('a')));
      assert.equal((await candidateOf(stack, fix.taskId)).state, 'READY');
      const { settled } = await stack.openItems.list(working.ownerId, working.projectId);
      const settledRow = settled.find((each) => each.itemId === failed.item.id);
      assert.ok(settledRow, 'CONTROL: the rerun handled the item, so it reads as settled');
      assert.equal(settledRow.outcome?.resolution, 'HANDLED');
      assert.equal(settledRow.detailLine, '');
      assert.equal(settledRow.requiredAction, 'This item is already settled — no action is required.');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(7) §10.5 O-L8: the name is the runner\'s display name, else its name, and it is read at the moment of the result',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const shown = await world(stack, 'shown', { capabilities: LEGACY });
      await stack.db.runner.update({ where: { id: shown.runnerId }, data: { displayName: 'DeskMac' } });
      const first = await checkOfAnEmptyBranch(stack, shown, 'shown', LEGACY);
      await report(stack, shown, first.check, branchMissing('refs/heads/orbit/shown'));
      const served = await servedError(stack, shown);
      assert.equal(served.payload.outdatedRunner, 'DeskMac');
      assert.equal(served.row.detailLine, 'Runner DeskMac is out of date: update it, then run this check again.');
      assert.equal(served.row.requiredAction, 'Update runner DeskMac, then run this check again.');
      assert.match(served.told, /Runner DeskMac does not declare integration-observe\/v1/);

      // Updated between the claim and the result: it is not out of date any more, so it is not called so.
      const updated = await world(stack, 'updated', { capabilities: LEGACY });
      const second = await checkOfAnEmptyBranch(stack, updated, 'updated', LEGACY);
      await stack.db.runner.update({ where: { id: updated.runnerId }, data: { capabilities: CURRENT } });
      await report(stack, updated, second.check, branchMissing('refs/heads/orbit/updated'));
      const notAnyMore = await servedError(stack, updated);
      assert.equal(notAnyMore.payload.outdatedRunner, undefined);
      assert.equal(notAnyMore.row.requiredAction, REPAIR_TASK_BRANCH);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(7) §10.5 O-L8: every other SOURCE_BRANCH_MISSING from such a runner keeps its words, a project branch its title, and an item already open what it says',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      /** No field, no line, this source's next step, no such sentence: only the title differs by case. */
      const keepsItsWords = (served: Awaited<ReturnType<typeof servedError>>, requiredAction: string) => {
        assert.equal(served.payload.outdatedRunner, undefined);
        assert.equal(served.row.detailLine, '');
        assert.equal(served.row.requiredAction, requiredAction);
        assert.doesNotMatch(served.told, /does not declare|out of date/);
      };

      // A task branch's check, on such a runner, for another reason.
      const otherCode = await world(stack, 'other-code', { capabilities: LEGACY });
      const fetchFailed = await checkOfAnEmptyBranch(stack, otherCode, 'other-code', LEGACY);
      await report(stack, otherCode, fetchFailed.check, {
        state: 'ERROR', phase: 'FETCH', errorCode: 'FETCH_FAILED', errorDetail: { detail: 'the remote hung up' },
      });
      const failedFetch = await servedError(stack, otherCode);
      keepsItsWords(failedFetch, REPAIR_TASK_BRANCH);
      assert.equal(failedFetch.item.title, 'Integration error: merging “Backfill order stats” into main');

      // A task branch's landing: O-L8 is about the check, and the title is about the source.
      const landing = await world(stack, 'landing', { capabilities: LEGACY });
      const passing = await checkOfAnEmptyBranch(stack, landing, 'landing', LEGACY);
      await report(stack, landing, passing.check, passed(sha('c')));
      await stack.promotions.confirm({ userId: landing.ownerId }, landing.projectId, passing.candidate.id, sha('c'));
      const land = await handed(stack, landing.runnerId, 'landing-2', LEGACY,
        (await candidateOf(stack, passing.taskId)).landJobId);
      assert.equal(land?.kind, 'LAND_PROMOTION');
      await report(stack, landing, land!, branchMissing('refs/heads/orbit/landing'));
      const failedLanding = await servedError(stack, landing);
      keepsItsWords(failedLanding, REPAIR_TASK_BRANCH);
      assert.equal(failedLanding.item.title, 'Integration error: merging “Backfill order stats” into main');

      // A project branch's candidate: the branch the title names is there, and the code is about it.
      const line = await world(stack, 'project-line', { capabilities: LEGACY, projectBranch: true });
      const t = await finishedTask(stack, line, 'lands on the project branch', {
        branch: 'orbit/project-line', branchSha: sha('a'), baseSha: sha('b'),
      });
      const onTheLine = (await dispatch(stack, line.runnerId, 'project-line-1', LEGACY)).find((command) => command.kind === 'LAND_TASK');
      assert.ok(onTheLine, 'CONTROL: the DONE queued a landing on the project branch');
      await report(stack, line, onTheLine, {
        state: 'LANDED', phase: 'VERIFY', sourceSha: sha('a'), targetShaBefore: UPSTREAM, upstreamSha: UPSTREAM,
        testedSha: sha('c'), testedTreeSha: sha('e'), landedSha: sha('c'), landedTreeSha: sha('e'), aheadOfUpstream: 1,
      });
      assert.deepEqual((await receiptsOf(stack, t.taskId)).map((receipt) => receipt.result), ['MERGED'], 'CONTROL: it landed');
      const made = await stack.promotions.considerCandidate(line.projectId);
      assert.ok(made, 'CONTROL: the landing made a candidate');
      const lineCheck = (await dispatch(stack, line.runnerId, 'project-line-2', LEGACY)).find((command) => command.kind === 'CHECK_PROMOTION');
      assert.equal(lineCheck?.promotionSourceKind, 'PROJECT_BRANCH');
      await report(stack, line, lineCheck!, branchMissing(`refs/heads/project/${line.projectId}`));
      const failedLine = await servedError(stack, line);
      keepsItsWords(failedLine, REPAIR);
      assert.equal(failedLine.item.title, 'Integration error: merging the project branch into main');

      // A task's own landing on that line: named after the task, as it always was.
      const own = await world(stack, 'own-landing', { capabilities: LEGACY, projectBranch: true });
      await finishedTask(stack, own, 'lands by itself', { branch: 'orbit/own-landing', branchSha: sha('a'), baseSha: sha('b') });
      const ownLanding = (await dispatch(stack, own.runnerId, 'own-landing-1', LEGACY)).find((command) => command.kind === 'LAND_TASK');
      assert.ok(ownLanding, 'CONTROL: the DONE queued its landing');
      await report(stack, own, ownLanding, branchMissing('refs/heads/orbit/own-landing'));
      const [ownItem] = await itemsOf(stack, own, 'INTEGRATION_ERROR');
      assert.equal(ownItem?.title, 'Integration error: lands by itself');
      assert.equal((ownItem?.payload as { outdatedRunner?: unknown }).outdatedRunner, undefined);

      // An item opened before this revision keeps the title it was opened with and says nothing new.
      const before = await world(stack, 'opened-before', { capabilities: LEGACY });
      const opened = await checkOfAnEmptyBranch(stack, before, 'opened-before', LEGACY);
      const now = new Date();
      await stack.db.projectOpenItem.create({
        data: {
          projectId: before.projectId, ownerId: before.ownerId, kind: 'INTEGRATION_ERROR', state: 'OPEN',
          assignee: 'COORDINATOR', assigneeReason: 'DEFAULT', promotionId: opened.candidate.id,
          dedupeKey: `IE:${randomUUID()}`, title: 'Integration error: merging the project branch into main',
          payload: { jobKind: 'CHECK_PROMOTION', errorCode: 'SOURCE_BRANCH_MISSING', errorDetail: null, failureClass: 'ERROR', generation: 1 },
          waitingSince: now, assignedAt: now,
        },
      });
      const stillOpen = await servedError(stack, before);
      keepsItsWords(stillOpen, REPAIR);
      assert.equal(stillOpen.item.title, 'Integration error: merging the project branch into main');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (8) O-L8: a task branch's failure, in the words of a MAIN line ══════════════════════════════════

const RED_CHECK = { name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false, durationMs: 1_200, outputTail: 'not ok 1\n' };
const SLOW_CHECK = { name: 'TASK_ACCEPTANCE', command: 'go test ./...', expectedExitCode: 0, exitCode: null, timedOut: true, durationMs: 3_600_000, outputTail: '' };
const CONFLICTING = 'src/orders.ts';

/**
 * Each failure class as a runner reports it about the commit `source`, with the item it opens and what
 * that item's coordinator is told to do next, on a project on main: the task's branch, then the project's.
 */
const FAILURE_CLASSES: Array<{
  failureClass: 'CONFLICT' | 'CHECK_FAILED' | 'CHECK_TIMED_OUT' | 'ERROR';
  kind: string;
  state: string;
  body: (source: string) => object;
  taskBranch: string;
  projectBranch: string;
}> = [
  {
    failureClass: 'CONFLICT',
    kind: 'INTEGRATION_CONFLICT',
    state: 'CONFLICT',
    body: (source) => ({ state: 'CONFLICT', phase: 'REBASE', sourceSha: source, upstreamSha: UPSTREAM, targetShaBefore: UPSTREAM, conflicts: [CONFLICTING] }),
    taskBranch: 'This task’s branch cannot reach main until this conflict is repaired — file a task that puts its work on main.',
    projectBranch: 'The project branch cannot reach main until this promotion conflict is repaired — create a sync task or ask the coordinator to fix it.',
  },
  {
    failureClass: 'CHECK_FAILED',
    kind: 'INTEGRATION_CHECK_FAILED',
    state: 'CHECK_FAILED',
    body: (source) => ({
      state: 'CHECK_FAILED', phase: 'CHECK', sourceSha: source, upstreamSha: UPSTREAM, targetShaBefore: UPSTREAM,
      testedSha: sha('7'), testedTreeSha: sha('6'), checks: [RED_CHECK], conflicts: [],
    }),
    taskBranch: REPAIR_TASK_BRANCH,
    projectBranch: REPAIR,
  },
  {
    failureClass: 'CHECK_TIMED_OUT',
    kind: 'INTEGRATION_CHECK_FAILED',
    state: 'CHECK_FAILED',
    body: (source) => ({
      state: 'CHECK_FAILED', phase: 'CHECK', sourceSha: source, upstreamSha: UPSTREAM, targetShaBefore: UPSTREAM,
      testedSha: sha('7'), testedTreeSha: sha('6'), checks: [SLOW_CHECK], conflicts: [],
    }),
    taskBranch: 'This task’s branch cannot reach main until this check finishes — re-run it with a reason or file a fix task.',
    projectBranch: 'The project branch cannot reach main until this check finishes — re-run it with a reason or ask the coordinator to fix it.',
  },
  {
    failureClass: 'ERROR',
    kind: 'INTEGRATION_ERROR',
    state: 'ERROR',
    body: () => ({ state: 'ERROR', phase: 'FETCH', errorCode: 'FETCH_FAILED', errorDetail: { detail: 'the remote hung up' } }),
    taskBranch: REPAIR_TASK_BRANCH,
    projectBranch: REPAIR,
  },
];

/** A TASK_BRANCH candidate on a MAIN line whose check comes back with `body`. */
async function failedTaskBranch(stack: Stack, label: string, body: (source: string) => object) {
  const w = await world(stack, label);
  const t = await finishedTask(stack, w, 'Backfill order stats', {
    branch: `orbit/${label}`, branchSha: sha('a'), baseSha: sha('b'), changedFiles: [{ path: 'orders.ts' }],
  });
  const candidate = await candidateOf(stack, t.taskId);
  const check = await handed(stack, w.runnerId, `${label}-1`, CURRENT, candidate.checkJobId);
  assert.ok(check, 'CONTROL: the source session\'s runner is handed the check');
  assert.equal(check.promotionSourceKind, 'TASK_BRANCH');
  await report(stack, w, check, body(sha('a')));
  return { w, ...t, candidate, check };
}

/** A PROJECT_BRANCH candidate, the landing that made it behind it, whose check comes back with `body`. */
async function failedProjectBranch(stack: Stack, label: string, body: (source: string) => object) {
  const w = await world(stack, label, { projectBranch: true });
  const t = await finishedTask(stack, w, 'lands on the project branch', {
    branch: `orbit/${label}`, branchSha: sha('a'), baseSha: sha('b'), changedFiles: [{ path: 'orders.ts' }],
  });
  const landing = (await dispatch(stack, w.runnerId, `${label}-1`, CURRENT)).find((command) => command.kind === 'LAND_TASK');
  assert.ok(landing, 'CONTROL: the DONE queued a landing on the project branch');
  await report(stack, w, landing, {
    state: 'LANDED', phase: 'VERIFY', sourceSha: sha('a'), targetShaBefore: UPSTREAM, upstreamSha: UPSTREAM,
    testedSha: sha('c'), testedTreeSha: sha('e'), landedSha: sha('c'), landedTreeSha: sha('e'), aheadOfUpstream: 1,
  });
  assert.deepEqual((await receiptsOf(stack, t.taskId)).map((receipt) => receipt.result), ['MERGED'], 'CONTROL: it landed');
  assert.ok(await stack.promotions.considerCandidate(w.projectId), 'CONTROL: the landing made a candidate');
  const check = (await dispatch(stack, w.runnerId, `${label}-2`, CURRENT)).find((command) => command.kind === 'CHECK_PROMOTION');
  assert.equal(check?.promotionSourceKind, 'PROJECT_BRANCH');
  await report(stack, w, check!, body(sha('c')));
  return { w, check: check! };
}

test('(8) §10.5 O-L8: a TASK_BRANCH candidate\'s failure, in each class, says what is true of a MAIN line on each door it is served from; a project branch\'s keeps its words, and the state, code, class and doors do not move',
  { skip, timeout: 420_000 }, async () => {
    const stack = await connect();
    try {
      for (const { failureClass, kind, state, body, taskBranch, projectBranch } of FAILURE_CLASSES) {
        const label = failureClass.toLowerCase().replaceAll('_', '-');
        const ofTask = await failedTaskBranch(stack, `words-task-${label}`, body);
        const served = await servedError(stack, ofTask.w, kind);
        const what = `${failureClass}, a task's branch`;

        assert.equal(served.payload.sourceKind, 'TASK_BRANCH', `${what}: at the payload's top level`);
        assert.equal(served.row.requiredAction, taskBranch, `${what}: the list`);
        assert.equal(served.card.requiredAction, taskBranch, `${what}: the delivery card`);
        for (const words of [served.row.requiredAction, served.told]) {
          assert.doesNotMatch(words, /project branch/i, what);
          assert.doesNotMatch(words, /No task stands behind/, what);
          assert.match(words, /[Tt]his task’s branch/, what);
        }
        assert.match(served.told, /A task stands behind this item, the one its title names/, what);
        assert.match(served.item.title, /“Backfill order stats” into main$/, what);

        const ofProject = await failedProjectBranch(stack, `words-project-${label}`, body);
        const before = await servedError(stack, ofProject.w, kind);
        const whatBefore = `${failureClass}, a project branch`;
        assert.equal('sourceKind' in before.payload, false, `${whatBefore}: no such field`);
        assert.equal(before.row.requiredAction, projectBranch, `${whatBefore}: the list`);
        assert.equal(before.card.requiredAction, projectBranch, `${whatBefore}: the delivery card`);
        assert.match(before.told, /No task stands behind this item: it comes from the job of a promotion \(merging the project branch into main\)/, whatBefore);
        assert.match(before.item.title, /merging the project branch into main$/, whatBefore);

        // Only the words moved: the two read alike wherever the source does not decide.
        const job = await jobOf(stack, ofTask.check.jobId);
        const jobBefore = await jobOf(stack, ofProject.check.jobId);
        assert.deepEqual([job.state, job.errorCode, landingFailureClass(job)], [state, jobBefore.errorCode, failureClass], what);
        assert.deepEqual([jobBefore.state, landingFailureClass(jobBefore)], [state, failureClass], whatBefore);
        assert.deepEqual([served.item.state, served.item.assignee, served.item.assigneeReason, served.payload.failureClass, served.payload.errorCode],
          [before.item.state, before.item.assignee, before.item.assigneeReason, before.payload.failureClass, before.payload.errorCode], what);
        assert.deepEqual([served.row.kind, served.row.actions, served.row.primaryAction], [before.row.kind, before.row.actions, before.row.primaryAction],
          `${failureClass}: the same doors`);
        assert.equal(served.row.actions.includes('RETRY'), failureClass !== 'CONFLICT', `${failureClass}: a conflict has no rerun, and its words offer none`);
        assert.deepEqual((await candidateOf(stack, ofTask.taskId)).state, 'BLOCKED', what);
      }

      // The other job a candidate has: the landing, recorded the same way.
      const w = await world(stack, 'words-landing');
      const t = await finishedTask(stack, w, 'Backfill order stats', {
        branch: 'orbit/words-landing', branchSha: sha('a'), baseSha: sha('b'), changedFiles: [{ path: 'orders.ts' }],
      });
      const candidate = await candidateOf(stack, t.taskId);
      const check = await handed(stack, w.runnerId, 'words-landing-1', CURRENT, candidate.checkJobId);
      await report(stack, w, check!, passed(sha('a')));
      await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, candidate.id, sha('a'));
      const land = await handed(stack, w.runnerId, 'words-landing-2', CURRENT, (await candidateOf(stack, t.taskId)).landJobId);
      assert.equal(land?.kind, 'LAND_PROMOTION');
      await report(stack, w, land!, { state: 'CONFLICT', phase: 'REBASE', sourceSha: sha('a'), upstreamSha: UPSTREAM, targetShaBefore: UPSTREAM, conflicts: [CONFLICTING] });
      const failedLanding = await servedError(stack, w, 'INTEGRATION_CONFLICT');
      assert.equal(failedLanding.payload.sourceKind, 'TASK_BRANCH');
      assert.equal(failedLanding.row.requiredAction, FAILURE_CLASSES[0]!.taskBranch);
      assert.doesNotMatch(failedLanding.told, /project branch/i);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(8) §10.5 O-L8: what those words promise: a fix is a candidate of its own that always asks, its landing leaves this candidate and this item as they are, and the item closes by hand',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const { w, candidate } = await failedTaskBranch(stack, 'fix-of-a-branch', FAILURE_CLASSES[0]!.body);
      const { item } = await servedError(stack, w, 'INTEGRATION_CONFLICT');
      const assignedAt = () => stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item.id }, select: { assignedAt: true, state: true } });
      const before = await assignedAt();
      const { coordinatorEnabled } = await stack.db.project.findUniqueOrThrow({ where: { id: w.projectId }, select: { coordinatorEnabled: true } });
      assert.equal(coordinatorEnabled, true, 'CONTROL: Automatic is on, so "whatever the Automatic setting says" is what is being measured');

      // The rerun its words do not offer is one the door refuses.
      await assert.rejects(
        stack.openItems.retryPromotionCheck(w.ownerId, w.projectId, candidate.id, { reason: 'once more' }, w.coordinatorSessionId),
        (error: { getStatus?: () => number }) => error.getStatus?.() === 409,
      );

      // `task_create` with `fixesOpenItemId`, from the conversation the project is coordinated from. How
      // the task then reaches DONE is not what this measures, so it reaches it through this file's Confirm.
      const filed = await stack.tasks.create(w.ownerId, {
        title: 'Put the order stats on main', assigneeId: w.workspaceId, projectId: w.projectId,
        completionCriterion: 'EVIDENCE_JUDGMENT', fixesOpenItemId: item.id,
      } as never, undefined, w.coordinatorSessionId);
      await stack.db.task.update({
        where: { id: filed.id }, data: { status: TaskStatus.IN_PROGRESS, completionCriterion: 'OWNER_CONFIRMED' },
      });
      await workSession(stack, w, filed.id, {
        branch: 'orbit/the-fix', branchSha: sha('d'), baseSha: UPSTREAM, finishedMinutesAgo: 2, changedFiles: [{ path: 'orders.ts' }],
      });
      await confirm(stack, w, filed.id);

      // Its branch is a candidate of its own, with its own check and the owner's own card.
      const own = await candidateOf(stack, filed.id);
      assert.notEqual(own.id, candidate.id);
      assert.deepEqual([own.state, own.sourceRef, own.sourceSha], ['CHECKING', 'refs/heads/orbit/the-fix', sha('d')]);
      const ownCheck = await handed(stack, w.runnerId, 'fix-of-a-branch-2', CURRENT, own.checkJobId);
      await report(stack, w, ownCheck!, passed(sha('d')));
      const asked = await candidateOf(stack, filed.id);
      assert.equal(asked.state, 'READY', 'a clean check of a task\'s branch asks, with Automatic on');
      assert.ok(asked.openItemId, 'and the owner has its card');
      const { assignee: cardHolder } = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: asked.openItemId }, select: { assignee: true } });
      assert.equal(cardHolder, 'OWNER');

      // Its landing, all the way in.
      await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, own.id, sha('d'));
      const land = await handed(stack, w.runnerId, 'fix-of-a-branch-3', CURRENT, (await candidateOf(stack, filed.id)).landJobId);
      await report(stack, w, land!, {
        state: 'LANDED', phase: 'VERIFY', sourceSha: sha('d'), upstreamSha: UPSTREAM, targetShaBefore: UPSTREAM,
        testedSha: sha('5'), testedTreeSha: sha('6'), landedSha: sha('5'), landedTreeSha: sha('6'), checks: [],
      });
      assert.equal((await candidateOf(stack, filed.id)).state, 'MERGED', 'CONTROL: the fix is on main');

      // This candidate and this item are as they were, and the item was not brought back.
      const still = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.id }, select: { state: true, sourceSha: true } });
      assert.deepEqual([still.state, still.sourceSha], ['BLOCKED', sha('a')]);
      const after = await assignedAt();
      assert.equal(after.state, 'OPEN');
      assert.equal(after.assignedAt?.getTime(), before.assignedAt?.getTime(), 'not delivered again (X-D4 5 is a task landing\'s)');

      // The door the words close it with.
      const closed = await stack.openItems.resolveOpenItem(
        w.ownerId, w.projectId, item.id, { note: 'the fix carried this task\'s work onto main' },
        { kind: 'SESSION', sessionId: w.coordinatorSessionId },
      );
      assert.deepEqual([closed.state, closed.resolution], ['RESOLVED', 'HANDLED']);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(8) §10.5 O-L8: what those words promise: more commits on this task\'s branch do not change a blocked candidate',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const { w, taskId, candidate } = await failedTaskBranch(stack, 'more-commits', FAILURE_CLASSES[0]!.body);
      const { item } = await servedError(stack, w, 'INTEGRATION_CONFLICT');

      // `task_reopen`'s own body, a further commit on the same branch, and the DONE that delivers it.
      await stack.tasks.update(w.ownerId, taskId, { status: TaskStatus.OPEN, supersededByTaskId: null, terminalReason: null } as never);
      await workSession(stack, w, taskId, {
        branch: 'orbit/more-commits', branchSha: sha('c'), baseSha: sha('b'), finishedMinutesAgo: 1, changedFiles: [{ path: 'orders.ts' }],
      });
      await confirm(stack, w, taskId);
      assert.equal((await identityOf(stack, taskId)).sha, sha('c'), 'CONTROL: the task delivered the new commit');

      const candidates = await stack.db.projectPromotion.findMany({
        where: { taskId, sourceKind: 'TASK_BRANCH' }, select: { id: true, state: true, sourceSha: true, checkJobId: true },
      });
      assert.deepEqual(candidates, [{ id: candidate.id, state: 'BLOCKED', sourceSha: sha('a'), checkJobId: candidate.checkJobId }],
        'one branch is one question, and the blocked candidate is still asking it about the old commit');
      const [same, ...more] = await itemsOf(stack, w, 'INTEGRATION_CONFLICT');
      assert.deepEqual([same?.id, same?.state, more.length], [item.id, 'OPEN', 0]);
    } finally {
      await stack.db.$disconnect();
    }
  });
