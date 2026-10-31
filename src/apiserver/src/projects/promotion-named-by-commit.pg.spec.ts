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
 *      observation carries the work — and the DONE that starts its line back-fills none either.
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
      integrationRef: 'refs/heads/main', refAuthority: 'REMOTE', remoteName: 'origin',
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
      id: true, state: true, resolution: true, assignee: true, assigneeReason: true, dedupeKey: true,
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
