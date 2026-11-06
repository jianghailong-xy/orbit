/**
 * The facts that reach main, through the doors that record them (contracts/wiki.contract.json
 * `docs.follow.triggers`; docs/wiki-contract.md §29.1; task C4), on real PostgreSQL: every receipt here is written the
 * way production writes it, by the runner controller, and the wiki's follow job is asserted where the space keeps it.
 *
 *   (a) the runner's own merge result — a session's Merge pressed, queued, handed to its runner and answered — that
 *       lands the session's work on main makes the space's follow job with a merge fact: main before it, the commit it
 *       put there, the session's title;
 *   (b) a landing line's results through the integration result route: a MAIN line's task — its own branch offered to
 *       main as a TASK_BRANCH promotion, checked, confirmed by the owner and landed — and a project's promotion of its
 *       branch, which Automatic confirms. Each makes the space's follow job with a landing fact titled by the task and
 *       by the project, over the range from main before to the commit the landing put there;
 *   (c) a LAND_TASK landed onto the project's own branch, which is not main, makes none.
 *
 * The space is the owner's on the repository the workspace and the project's codebase name, with a confirmed plan
 * (`docs.follow.space`). No worker runs here: what is asserted is the job the facts made, before anything claims it.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-docs-follow-receipts.pg.spec.ts
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own space.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import { Client } from 'pg';

import {
  RunEventType,
  RunStatus as SharedRunStatus,
  WIKI_DOCS_FOLLOW,
  type IntegrationCheckResult,
  type IntegrationJobCommand,
  type IntegrationJobResultRequest,
} from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND } from '../projects/project-integration-job';
import { configureProjectIntegration } from '../projects/project-integration-line';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { ProjectPromotionService } from '../projects/project-promotion.service';
import type { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { normalizeRepoUrl } from './wiki.service';
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

// The commits the simulated runner reports: distinct, so an assertion that picked up the wrong one fails on the value.
const TASK_BRANCH_TIP = 'a'.repeat(40);
const LINE_BEFORE = 'c'.repeat(40);
const LANDED_ON_LINE = 'd'.repeat(40);
const LANDED_TREE = 'e'.repeat(40);
const MAIN_CHECKED = 'f'.repeat(40);
const CHECK_MERGE = '2'.repeat(40);
const CHECKED_TREE = '3'.repeat(40);
const MERGE_COMMIT = '4'.repeat(40);

const CAPABLE = [INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND];

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 1_200, outputTail: 'ok\n',
};

type Result = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

/** A check that found the work merging cleanly onto main, every check green. */
function cleanCheck(sourceSha: string): Result {
  return {
    state: 'READY', phase: 'CHECK', sourceSha, targetShaBefore: MAIN_CHECKED, upstreamSha: MAIN_CHECKED,
    testedSha: CHECK_MERGE, testedTreeSha: CHECKED_TREE, aheadOfUpstream: 1, filesChanged: 3, checks: [GREEN_CHECK], conflicts: [],
  };
}

/** The landing's push onto main: main was MAIN_CHECKED, and MERGE_COMMIT is what it put there. */
function landedOnMain(sourceSha: string): Result {
  return {
    state: 'LANDED', phase: 'VERIFY', sourceSha, targetShaBefore: MAIN_CHECKED, upstreamSha: MAIN_CHECKED,
    testedSha: MERGE_COMMIT, testedTreeSha: CHECKED_TREE, landedSha: MERGE_COMMIT, landedTreeSha: CHECKED_TREE, aheadOfUpstream: 2,
  };
}

interface Stack {
  db: PrismaClient;
  sessions: SessionsService;
  tasks: TasksService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
  promotions: ProjectPromotionService;
  realtime: RealtimeService;
}

/**
 * The production wiring over one client, as project-promotion-auto-authority.pg.spec.ts wires it: the runner controller
 * with the integration relay and the promotion service, so a landing's after-commit edge makes the promotion candidate
 * and follows the receipts as production does. `realtime` is real for the runner's merge, whose queue the runner
 * drains (session-merge-recovery.pg.spec.ts wires it so), and inert for the landing line, whose publishes reach nothing.
 */
async function connect(realtimeKind: 'real' | 'inert'): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = realtimeKind === 'real'
    ? new RealtimeService(db as never, {} as never)
    : new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  const promotions = new ProjectPromotionService(prisma);
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
  return { db, sessions, tasks, api, jobs, promotions, realtime };
}

interface World {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  repoUrl: string;
  spaceId: string;
}

/**
 * An owner with a runner, a workspace on a repository, and the wiki space of that repository with a confirmed plan —
 * the space the facts of this repository are followed in.
 */
async function world(stack: Stack, label: string): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/follow-${label}-${ownerId.slice(0, 8)}.git`;
  await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@docs-follow.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: CAPABLE, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl, workDir: `/srv/${label}` },
  });
  const space = await db.wikiSpace.create({
    data: { ownerId, slug: `follow-${label}`, title: `${label} space`, repoUrlNorm: normalizeRepoUrl(repoUrl) },
    select: { id: true },
  });
  await db.wikiPlan.create({
    data: {
      spaceId: space.id, ownerId, version: 1, status: 'confirmed', origin: 'owner', authorUserId: ownerId,
      confirmedByUserId: ownerId, confirmedAt: new Date(), categories: [], docsMin: 1, docsMax: 1, gate: {},
    },
  });
  return { label, ownerId, runnerId, workspaceId, repoUrl, spaceId: space.id };
}

/** A project of the world's repository, integrating on the line named, with Automatic as given. */
async function project(stack: Stack, w: World, line: 'MAIN' | 'PROJECT_BRANCH', automatic: boolean): Promise<{ id: string; title: string }> {
  const db = stack.db;
  const id = randomUUID();
  const title = `${w.label}: the ${line === 'MAIN' ? 'main-line' : 'branch'} project`;
  const coordinatorSessionId = randomUUID();
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
      title: `coordinator: ${w.label}`, prompt: `coordinator: ${w.label}`, provider: 'claude', status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER, titleManagedByProject: true, numTurns: 1, startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId, seq: 1, clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message', content: `coordinator: ${w.label}`, status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id, ownerId: w.ownerId, title, goal: 'its work reaches main', coordinatorEnabled: automatic,
      coordinatorWorkspaceId: w.workspaceId, coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, { ownerId: w.ownerId, projectId: id, settings: { line } }));
  return { id, title };
}

/**
 * A code task of the project settled DONE by its own acceptance command, through the runner's doors: its DONE is what
 * queues its integration — a LAND_TASK onto a project branch, a TASK_BRANCH candidate on a MAIN line.
 */
async function doneCodeTask(stack: Stack, w: World, projectId: string, label: string): Promise<{ taskId: string; title: string; sessionId: string }> {
  const db = stack.db;
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const declared = await stack.tasks.create(w.ownerId, {
    title, assigneeId: w.workspaceId, projectId, acceptanceCommand: 'exit 0', acceptanceExpectedExitCode: 0,
  });
  const sessionId = randomUUID();
  const turnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId: declared.id, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title, prompt: title, provider: 'claude', status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, startedAt: new Date(),
      finishedAt: new Date(Date.now() - 60_000), branch: `orbit/${label}-${randomUUID().slice(0, 6)}`, isolationStatus: 'worktree',
      baseSha: 'b'.repeat(40),
    },
  });
  await db.conversationTurn.create({
    data: {
      id: turnId, sessionId, seq: 1, clientTurnId: `message:${turnId}`, kind: 'message', content: 'execute the task',
      status: 'IN_FLIGHT', deliveredAt: new Date(),
    },
  });
  await stack.api.events({ id: w.runnerId }, sessionId, {
    events: [{ seq: 1, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId, payload: { text: 'the work is on the branch' } }],
  });
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, { turnId, status: SharedRunStatus.SUCCEEDED });
  const acceptance = await (stack.api as unknown as {
    dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<{ turnId: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, w.runnerId, null);
  assert.equal(acceptance?.taskAcceptance, true, 'the acceptance command was queued for the task');
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId: acceptance!.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'shell', shellExitCode: 0, shellOutput: '',
  });
  const task = await db.task.findUniqueOrThrow({ where: { id: declared.id }, select: { status: true } });
  assert.equal(task.status, TaskStatus.DONE, 'the acceptance command agreed');
  return { taskId: declared.id, title, sessionId };
}

/** The one integration job a heartbeat hands out, which has to be of the kind named. */
async function onlyClaim(stack: Stack, w: World, kind: string): Promise<IntegrationJobCommand> {
  const claimed = await stack.jobs.dispatch({ runnerId: w.runnerId, leaseOwner: `lease-${w.label}`, draining: false, capabilities: CAPABLE });
  assert.equal(claimed.length, 1, `expected one ${kind} to be handed out, got ${claimed.map((job) => job.kind).join(', ') || 'none'}`);
  assert.equal(claimed[0]!.kind, kind);
  return claimed[0]!;
}

/** The result a runner posts for a job it holds, over the route it posts it on: the integration result door. */
async function report(stack: Stack, w: World, job: IntegrationJobCommand, result: Result): Promise<void> {
  const answer = await stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...result,
  });
  assert.equal(answer.accepted, true, `the result route refused ${result.state}`);
}

interface FollowJob {
  id: string;
  state: string;
  priority: number;
  facts: Array<Record<string, unknown>>;
}

/** The space's follow jobs, oldest first, with the facts each carries. */
async function follows(stack: Stack, spaceId: string): Promise<FollowJob[]> {
  const rows = await stack.db.wikiJob.findMany({
    where: { spaceId, kind: WIKI_DOCS_FOLLOW.kind },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, state: true, priority: true, input: true },
  });
  return rows.map((row) => ({ id: row.id, state: row.state, priority: row.priority, facts: ((row.input as { facts?: Array<Record<string, unknown>> }).facts ?? []) }));
}

/** A fact as the assertions read it: what it is, the range of main it carries, and the title its versions will say. */
function factOf(fact: Record<string, unknown>) {
  return { kind: fact.kind, from: fact.from, sha: fact.sha, title: fact.title, chat: fact.chat };
}

// ── (a) the runner's own merge result ───────────────────────────────────────────────────────────

test('(a) a runner\'s merge result that lands a session on main makes the space\'s follow job with a merge fact',
  { skip, timeout: 120_000 }, async () => {
    const stack = await connect('real');
    try {
      const w = await world(stack, 'runner-merge');
      const sessionId = randomUUID();
      await stack.db.session.create({
        data: {
          id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
          title: 'Shorten the offline window', prompt: 'p', status: RunStatus.SUCCEEDED, branch: 'orbit/offline-window',
          isolationStatus: 'worktree',
        },
      });
      // The owner presses Merge; the runner's heartbeat is handed the operation and answers it merged into main.
      await stack.sessions.mergeToMain(w.ownerId, sessionId, 'main');
      const lease = randomUUID();
      const [operation] = await stack.realtime.drainMergeRequests(w.runnerId, lease);
      assert.ok(operation, 'the runner was handed the merge');
      assert.deepEqual(await follows(stack, w.spaceId), [], 'nothing is followed before main moved');
      await stack.api.mergeResult({ id: w.runnerId }, sessionId, {
        status: 'merged', operationId: operation.operationId, leaseOwner: lease,
        sourceSha: TASK_BRANCH_TIP, targetBranch: 'main', targetShaBefore: MAIN_CHECKED, mergedSha: MERGE_COMMIT,
      });
      const receipts = await stack.db.sessionMergeReceipt.findMany({ where: { sessionId }, select: { id: true, result: true, targetBranch: true } });
      assert.deepEqual(receipts.map((r) => [r.result, r.targetBranch]), [['MERGED', 'main']], 'the result route wrote its receipt');

      const jobs = await follows(stack, w.spaceId);
      assert.equal(jobs.length, 1, 'one receipt, one follow job');
      assert.deepEqual([jobs[0]!.state, jobs[0]!.priority], ['queued', WIKI_DOCS_FOLLOW.priorities.merge]);
      assert.deepEqual(jobs[0]!.facts.map(factOf),
        [{ kind: 'merge', from: MAIN_CHECKED, sha: MERGE_COMMIT, title: 'Shorten the offline window', chat: false }]);
      assert.equal(jobs[0]!.facts[0]!.receiptId, receipts[0]!.id);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── (b) a landing line's results: a MAIN line's task, a project's promotion ─────────────────────

test('(b) a MAIN line\'s task landed on main through the integration result route makes a landing fact titled by the task',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect('inert');
    try {
      const w = await world(stack, 'main-line');
      const p = await project(stack, w, 'MAIN', false);
      // On a MAIN line the task's own branch is offered to main (a TASK_BRANCH candidate): checked, then confirmed.
      const task = await doneCodeTask(stack, w, p.id, 'main-line-task');
      const check = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      assert.equal(check.promotionSourceKind, 'TASK_BRANCH');
      await report(stack, w, check, cleanCheck(TASK_BRANCH_TIP));
      assert.deepEqual(await follows(stack, w.spaceId), [], 'a check moves nothing on main');
      const candidate = await stack.db.projectPromotion.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      await stack.promotions.confirm({ userId: w.ownerId }, p.id, candidate.id, TASK_BRANCH_TIP);
      const land = await onlyClaim(stack, w, 'LAND_PROMOTION');
      await report(stack, w, land, landedOnMain(TASK_BRANCH_TIP));
      const receipts = await stack.db.sessionMergeReceipt.findMany({ where: { taskId: task.taskId, targetBranch: 'main' }, select: { id: true, result: true } });
      assert.deepEqual(receipts.map((r) => r.result), ['MERGED'], 'the landing wrote the task\'s receipt on main');

      const jobs = await follows(stack, w.spaceId);
      assert.equal(jobs.length, 1, 'the landing made the space\'s follow job');
      assert.deepEqual([jobs[0]!.state, jobs[0]!.priority], ['queued', WIKI_DOCS_FOLLOW.priorities.landing]);
      assert.deepEqual(jobs[0]!.facts.map(factOf), [{ kind: 'landing', from: MAIN_CHECKED, sha: MERGE_COMMIT, title: task.title, chat: false }]);
      assert.equal(jobs[0]!.facts[0]!.receiptId, receipts[0]!.id);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(b, c) a project\'s promotion landed on main makes a landing fact titled by the project; its task\'s LAND_TASK onto the project branch makes none',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect('inert');
    try {
      const w = await world(stack, 'promotion');
      const p = await project(stack, w, 'PROJECT_BRANCH', true);
      const task = await doneCodeTask(stack, w, p.id, 'promoted-task');
      // (c) The task lands onto the project's own branch: a receipt, but not into main, and no fact.
      const landing = await onlyClaim(stack, w, 'LAND_TASK');
      assert.match(landing.targetRef, /^refs\/heads\/project\//u);
      await report(stack, w, landing, {
        state: 'LANDED', phase: 'VERIFY', sourceSha: TASK_BRANCH_TIP, targetShaBefore: LINE_BEFORE, testedSha: LANDED_ON_LINE,
        testedTreeSha: LANDED_TREE, landedSha: LANDED_ON_LINE, landedTreeSha: LANDED_TREE, aheadOfUpstream: 1,
      });
      const onLine = await stack.db.sessionMergeReceipt.findMany({ where: { taskId: task.taskId }, select: { targetBranch: true, result: true } });
      assert.deepEqual(onLine.map((r) => [r.result, r.targetBranch.startsWith('project/')]), [['MERGED', true]], 'the LAND_TASK wrote its receipt on the project branch');
      assert.deepEqual(await follows(stack, w.spaceId), [], 'a landing onto a project branch is no fact: nothing is followed');

      // (b) The project's branch is promoted: its candidate (made by the landing's after-commit edge) is checked, Automatic
      // confirms it, and it lands on main — a receipt for each of its tasks, through the same result route.
      const check = await onlyClaim(stack, w, 'CHECK_PROMOTION');
      assert.equal(check.promotionSourceKind, 'PROJECT_BRANCH');
      await report(stack, w, check, cleanCheck(LANDED_ON_LINE));
      assert.deepEqual(await follows(stack, w.spaceId), [], 'a check moves nothing on main');
      const land = await onlyClaim(stack, w, 'LAND_PROMOTION');
      await report(stack, w, land, landedOnMain(LANDED_ON_LINE));
      const onMain = await stack.db.sessionMergeReceipt.findMany({ where: { taskId: task.taskId, targetBranch: 'main' }, select: { id: true, result: true } });
      assert.deepEqual(onMain.map((r) => r.result), ['MERGED'], 'the promotion wrote the task\'s receipt on main');

      const jobs = await follows(stack, w.spaceId);
      assert.equal(jobs.length, 1, 'the promotion made the space\'s follow job');
      assert.deepEqual([jobs[0]!.state, jobs[0]!.priority], ['queued', WIKI_DOCS_FOLLOW.priorities.landing]);
      assert.deepEqual(jobs[0]!.facts.map(factOf), [{ kind: 'landing', from: MAIN_CHECKED, sha: MERGE_COMMIT, title: p.title, chat: false }]);
      assert.equal(jobs[0]!.facts[0]!.receiptId, onMain[0]!.id);
    } finally {
      await stack.db.$disconnect();
    }
  });
