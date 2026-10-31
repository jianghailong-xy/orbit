import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { ConfigService } from '@nestjs/config';
import {
  Prisma,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import type { IntegrationJobCommand as SharedIntegrationJobCommand } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay, dispatchIntegrationJobs } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { queueLandingObservation } from './landing-observation';
import { readOwnerDecisionSignals, readOwnerDecisionsBySession } from './owner-decision-signal';
import { taskLandingSql } from './project-criterion-landing';
import { canonicalRepoUrl } from './project-integration-line';
import { readProjectListAttention } from './project-list-attention';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * Revision 29's deploy-time pass (`docs/project-integration-line-contract.md` §10.9 「迁移」 2), and the
 * owner's decision of 2026-10-28 on `LANDED_WITHOUT_CONFIRMATION`: pushed once, counted in Needs-you.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-observation-backfill.pg.spec.ts
 *
 *  (1) the freeze's scope (O-L4): in a project whose line has started, a DONE code task not known to be
 *      on the line is frozen from its rows when its work has stopped and names its commit — not when
 *      the work still moves, the identity cannot be named, the task is codeless, already landed or not
 *      DONE, nor in a project whose line has not started; one OBSERVE_LANDING per project
 *      (`trigger: DEPLOY`), handed only the frozen tasks, and no history rewritten;
 *  (2) the round (10-28's shape on a PLATFORM MAIN line): the observation — after a failed look queued
 *      again (O-J4) — writes the receipts, M-T13 retires the BLOCKED candidates and closes their items,
 *      J10 starts the dependent by itself; O-R3 opens ONE `UL:backfill:<projectId>` listing the tasks
 *      and their receipts, and no item per task; it is pushed exactly once, after the commit, counted
 *      in Needs-you (the signal, the session summary, the badge) and the project list, and no longer
 *      after the owner's Accept;
 *  (3) after the round, an ordinary observation's O-R3 opens one item per task again, pushed once;
 *  (4) a second run, two runs at once and two project transactions at once leave one freeze, one
 *      observation and one item; a replayed result pushes nothing;
 *  (5) not seen: an AGENT_PUSH project opens LANDING_UNOBSERVED; a PLATFORM project writes nothing and
 *      leaves its candidate to its own pipeline.
 *
 * Not destructive: every case owns freshly generated ids, and asserts on its own rows only — the pass
 * itself reads the whole database, which `run-pg-spec.sh` gives each spec file to itself.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

// What this spec reads that the tree before R29-9 does not have is spelled locally and loaded by name,
// so the file compiles there and every case is red for want of the behaviour rather than of a type.
type IntegrationJobCommand = SharedIntegrationJobCommand & {
  observeTasks?: Array<{ taskId: string; deliveredSha: string; baseSha: string | null }>;
};
interface BackfillProject {
  projectId: string;
  frozen: string[];
  left: Array<{ taskId: string; settlement: string }>;
  observation: { jobId: string; queued: boolean } | null;
}
interface BackfillModule {
  runLandingObservationBackfill(prisma: PrismaService, options: {
    databaseUrl: string;
    lockTimeoutMs?: number;
    log?: { log(message: string): void; warn(message: string): void; error(message: string): void };
  }): Promise<{ projects: BackfillProject[]; failures: unknown[] }>;
  backfillProject(tx: Prisma.TransactionClient, input: {
    ownerId: string; projectId: string; taskIds: readonly string[];
  }): Promise<BackfillProject>;
}
const backfill: BackfillModule = (() => {
  const name = './landing-observation-backfill';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(name) as BackfillModule;
  } catch {
    const missing = (): never => assert.fail('there is no deploy-time landing backfill');
    return { runLandingObservationBackfill: missing, backfillProject: missing };
  }
})();
const CAPABLE = ['integration-job/v1', 'integration-observe/v1', 'integration-progress/v2'];
const sha = (nibble: string) => nibble.repeat(40);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined };

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

/** What the owner's devices were told (§7.6 V12): each `notifyOwnerItem` call, whether the item it
 *  named was committed when it was made, and what APNs was handed for it. */
interface Pushes {
  calls: Array<{ itemId: string; committed: boolean }>;
  sent: Array<{ kind: string; title: string; body: string; openItemID: string; collapseId?: string }>;
  /** Every push started so far has finished. */
  settled(): Promise<void>;
}

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  tasks: TasksService;
  openItems: ProjectOpenItemService;
  receipts: MergeReceiptService;
  api: RunnerApiController;
  /** The real push, reading the database; only the transport is replaced. */
  push: PushService;
  pushes: Pushes;
}

function enabledConfig(): ConfigService {
  const values: Record<string, string> = {
    APNS_KEY_ID: 'key-id', APNS_TEAM_ID: 'team-id', APNS_KEY: Buffer.from('test-key').toString('base64'),
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/**
 * The services the doors live in, over one client: the result door is the runner controller's own
 * (`integrationJobResult`), whose post-commit edge delivers the landing's facts, starts what it
 * released (J10) and pushes the owner items it opened. The push is the real `PushService` reading the
 * database, its transport replaced; each call records whether the item was committed when it came —
 * read through the pool, never through the transaction that opened it.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const push = new PushService(prisma, enabledConfig());
  const pushes: Pushes = { calls: [], sent: [], settled: async () => undefined };
  const pending: Array<Promise<unknown>> = [];
  pushes.settled = async () => {
    await Promise.all(pending);
  };
  (push as unknown as { targets: () => Promise<unknown[]> }).targets = async () =>
    [{ token: 'device', environment: 'sandbox', platform: 'ios' }];
  (push as unknown as { deliver: (...args: unknown[]) => Promise<number> }).deliver = async (
    _tokens: unknown, body: unknown, _type: unknown, _priority: unknown, collapseId?: unknown,
  ) => {
    const payload = JSON.parse(String(body)) as {
      kind: string; openItemID: string; aps: { alert: { title: string; body: string } };
    };
    pushes.sent.push({
      kind: payload.kind, title: payload.aps.alert.title, body: payload.aps.alert.body,
      openItemID: payload.openItemID, collapseId: collapseId as string | undefined,
    });
    return 1;
  };
  const notifier = {
    notifyOwnerItem: (itemId: string): Promise<void> => {
      const done = (async () => {
        const committed = await db.projectOpenItem.findUnique({ where: { id: itemId }, select: { id: true } });
        pushes.calls.push({ itemId, committed: committed !== null });
        await push.notifyOwnerItem(itemId);
      })();
      pending.push(done);
      return done;
    },
  };
  const openItems = new ProjectOpenItemService(prisma, sessions, notifier as unknown as PushService);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
  // The fifth argument is the owner-item notifier R29-9 adds; a tree without it ignores it.
  const receipts = new (MergeReceiptService as unknown as new (...args: unknown[]) => MergeReceiptService)(
    prisma, undefined, tasks, undefined, notifier,
  );
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    notifier as unknown as PushService,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
    receipts,
    sessions,
    openItems,
    new IntegrationJobRelay(prisma, openItems),
  );
  return { db, prisma, tasks, openItems, receipts, api, push, pushes };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  codebaseId: string;
  repository: string;
}

/**
 * One owner, one runner that observes (online, beating, both capabilities), the workspace the work ran
 * in, a live coordinator conversation, and a project on a MAIN line in the delivery mode asked for —
 * its line started unless asked otherwise, as every project that integrated before revision 29.
 */
async function world(
  stack: Stack,
  label: string,
  options: { deliveryMode?: 'PLATFORM' | 'AGENT_PUSH'; started?: boolean; lineStarted?: boolean } = {},
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/${label}-${projectId.slice(0, 8)}.git`;
  const repository = canonicalRepoUrl(repoUrl)!;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@landing-backfill.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: CAPABLE, maxConcurrent: 4, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      heartbeatLeaseOwner: randomUUID(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl, workDir: `/srv/${label}`,
    },
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
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId, seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message', content: `coordinator: ${label}`, status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'what reached main before revision 29 is seen there',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
      ...(options.started ? { startedAt: new Date() } : {}),
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const codebase = await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: repository, upstreamRef: 'refs/heads/main',
      integrationRef: 'refs/heads/main', refAuthority: 'REMOTE', remoteName: 'origin',
      integrationRefSource: 'EXPLICIT', deliveryMode: options.deliveryMode ?? 'PLATFORM',
      ...(options.lineStarted === false ? {} : { integrationStartedAt: minutesAgo(600) }),
    },
    select: { id: true },
  });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId, codebaseId: codebase.id, repository };
}

interface Work {
  /** The branch the work ended on; null for a session that took no worktree branch. */
  branch: string;
  /** The tip the runner reported; null when none was reported. */
  branchSha: string | null;
  baseSha: string;
  /** Still running (no finish): the work has not stopped moving. */
  moving?: boolean;
}

interface Historical {
  taskId: string;
  sessionId: string;
  branch: string;
  title: string;
}

/**
 * A task as revision 28 left it: written DONE (or not, when asked) by a door that froze nothing, its
 * work session on a worktree branch as the runner's reports left it.
 */
async function historicalTask(
  stack: Stack,
  w: World,
  title: string,
  work: Work,
  options: { status?: TaskStatus; codeless?: boolean } = {},
): Promise<Historical> {
  const task = await stack.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title, projectId: w.projectId,
      assigneeId: w.workspaceId, status: options.status ?? TaskStatus.DONE, completionCriterion: 'OWNER_CONFIRMED',
      ...(options.codeless ? { codeless: true, codelessReason: 'a decision, no code' } : {}),
    },
    select: { id: true },
  });
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId: task.id, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title, prompt: title, provider: 'claude',
      status: work.moving ? RunStatus.RUNNING : RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, isolationStatus: 'worktree',
      branch: work.branch, branchSha: work.branchSha, baseSha: work.baseSha, numTurns: 1,
      startedAt: minutesAgo(300), createdAt: minutesAgo(300), runtimeSessionId: randomUUID(),
      changedFiles: [{ path: `src/${title.replace(/\W+/g, '-')}.ts`, additions: 12, deletions: 1 }] as Prisma.InputJsonValue,
      ...(work.moving ? {} : { finishedAt: minutesAgo(240), completedAt: minutesAgo(240) }),
    },
  });
  return { taskId: task.id, sessionId, branch: work.branch, title };
}

/**
 * 10-28's candidate: the task's branch offered to main, its check answered and the candidate BLOCKED —
 * `ERROR` (the check's SOURCE_BRANCH_MISSING) or `ALREADY_LANDED` — with the coordinator's failure item
 * about it still open.
 */
async function blockedCandidate(
  stack: Stack,
  w: World,
  t: Historical,
  blockedReason: 'ERROR' | 'ALREADY_LANDED',
): Promise<{ promotionId: string; itemId: string }> {
  const promotion = await stack.db.projectPromotion.create({
    data: {
      projectId: w.projectId, ownerId: w.ownerId, codebaseId: w.codebaseId, sourceKind: 'TASK_BRANCH',
      taskId: t.taskId, sessionId: t.sessionId, sourceRef: `refs/heads/${t.branch}`, upstreamRef: 'refs/heads/main',
      includedTaskIds: [t.taskId], state: 'BLOCKED', blockedReason, decidedAt: minutesAgo(200),
      createdAt: minutesAgo(230),
    },
    select: { id: true },
  });
  const item = await stack.db.projectOpenItem.create({
    data: {
      projectId: w.projectId, ownerId: w.ownerId, kind: 'INTEGRATION_ERROR', state: 'OPEN',
      assignee: 'COORDINATOR', assigneeReason: 'DEFAULT', promotionId: promotion.id,
      dedupeKey: `IE:promotion:${promotion.id}`, title: `Could not check ${t.branch}`,
      payload: { errorCode: 'SOURCE_BRANCH_MISSING', failureClass: 'ERROR', jobKind: 'CHECK_PROMOTION' },
      waitingSince: minutesAgo(200), assignedAt: minutesAgo(200),
    },
    select: { id: true },
  });
  return { promotionId: promotion.id, itemId: item.id };
}

/** The pass as the server runs it at boot, over the whole database, on a client of its own. */
async function runPass(url = URL!, lockTimeoutMs?: number) {
  const client = prismaClientFor(url);
  try {
    return await backfill.runLandingObservationBackfill(client as unknown as PrismaService, {
      databaseUrl: url, log: QUIET, ...(lockTimeoutMs ? { lockTimeoutMs } : {}),
    });
  } finally {
    await client.$disconnect();
  }
}

function delivered(stack: Stack, taskId: string) {
  return stack.db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      deliveredSha: true, deliveredBaseSha: true, deliveredBranch: true, deliveredSessionId: true,
      deliveredAt: true,
    },
  });
}

function observations(stack: Stack, w: World) {
  return stack.db.projectIntegrationJob.findMany({
    where: { projectId: w.projectId, kind: 'OBSERVE_LANDING' },
    orderBy: { generation: 'asc' },
    select: { id: true, state: true, generation: true, receiptIds: true },
  });
}

async function triggerOf(stack: Stack, jobId: string): Promise<string | undefined> {
  const enqueued = await stack.db.projectIntegrationJobEvent.findFirst({
    where: { jobId, key: 'enqueued' }, select: { data: true },
  });
  return (enqueued?.data as { trigger?: string } | null)?.trigger;
}

/** The observation one beat of the world's runner hands out (J-T2), or undefined. */
async function claimObservation(stack: Stack, w: World, leaseOwner: string): Promise<IntegrationJobCommand | undefined> {
  const commands = await dispatchIntegrationJobs(stack.prisma, {
    runnerId: w.runnerId, leaseOwner, draining: false, capabilities: CAPABLE,
  });
  return commands.find((command) => command.kind === 'OBSERVE_LANDING') as IntegrationJobCommand | undefined;
}

/** A runner's answer through the controller's own door, whose post-commit edge is the server's. */
function answer(stack: Stack, w: World, command: IntegrationJobCommand, body: Record<string, unknown>) {
  return stack.api.integrationJobResult({ id: w.runnerId, ownerId: w.ownerId }, command.jobId, {
    claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, ...body,
  } as never);
}

/** OBSERVED, with every handed task answered `onUpstream` as given (default: seen). */
function observedBody(command: IntegrationJobCommand, onUpstream: (taskId: string) => boolean = () => true) {
  return {
    state: 'OBSERVED', phase: 'OBSERVE', upstreamSha: sha('9'), targetShaBefore: sha('9'),
    observations: (command.observeTasks ?? []).map((task) => ({
      taskId: task.taskId, deliveredSha: task.deliveredSha, baseSha: task.baseSha,
      onUpstream: onUpstream(task.taskId), onIntegrationLine: null, empty: false, fullyApplied: null,
    })),
  };
}

function unconfirmedItems(stack: Stack, w: World) {
  return stack.db.projectOpenItem.findMany({
    where: { projectId: w.projectId, kind: 'LANDED_WITHOUT_CONFIRMATION' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, state: true, resolution: true, assignee: true, assigneeReason: true, dedupeKey: true,
      taskId: true, sessionId: true, title: true, payload: true, escalateAt: true, remindAt: true,
    },
  });
}

async function landingOf(stack: Stack, taskId: string): Promise<string> {
  const [row] = await stack.db.$queryRaw<Array<{ landing: string }>>(Prisma.sql`
    SELECT (${Prisma.raw(taskLandingSql('t'))}) AS "landing" FROM "task" t WHERE t."id" = ${taskId}::uuid`);
  return row!.landing;
}

/** What the owner's surfaces count for this world (§7.1 V1, §7.6 V13). */
async function counted(stack: Stack, w: World) {
  const attention = (await readProjectListAttention(stack.prisma, w.ownerId)).get(w.projectId);
  const signals = (await readOwnerDecisionSignals(stack.db as never, w.ownerId))
    .filter((signal) => signal.projectId === w.projectId && signal.kind === 'OWNER_ITEM');
  const summary = (await readOwnerDecisionsBySession(stack.db as never, w.ownerId)).get(w.coordinatorSessionId);
  return {
    projectList: (attention?.ownerItems ?? []).map((owned) => [String(owned.kind), owned.count]),
    needsYou: signals.flatMap((signal) => (signal.items ?? []).map((owned) => [String(owned.kind), owned.itemId])),
    summary: (summary?.ownerItems ?? []).map((owned) => [String(owned.kind), owned.title]),
    badge: (await stack.push.needsYouSessions(w.ownerId)).includes(w.coordinatorSessionId),
  };
}

// ═══ (1) the freeze's scope ═════════════════════════════════════════════════════════════════════

test('(1) §10.9 迁移 2, O-L4: only finished code work that has stopped moving and names its commit is frozen, in a project whose line has started — one observation per project, queued by the pass, no history rewritten',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'scope');
      const settled = await historicalTask(stack, w, 'settled', {
        branch: 'orbit/settled', branchSha: sha('a'), baseSha: sha('b'),
      });
      const alsoSettled = await historicalTask(stack, w, 'also-settled', {
        branch: 'orbit/also-settled', branchSha: sha('c'), baseSha: sha('b'),
      });
      const moving = await historicalTask(stack, w, 'still-moving', {
        branch: 'orbit/still-moving', branchSha: sha('d'), baseSha: sha('b'), moving: true,
      });
      const unknown = await historicalTask(stack, w, 'no-tip', {
        branch: 'orbit/no-tip', branchSha: null, baseSha: sha('b'),
      });
      const codeless = await historicalTask(stack, w, 'codeless', {
        branch: 'orbit/codeless', branchSha: sha('e'), baseSha: sha('b'),
      }, { codeless: true });
      const notDone = await historicalTask(stack, w, 'still-open', {
        branch: 'orbit/still-open', branchSha: sha('f'), baseSha: sha('b'),
      }, { status: TaskStatus.IN_PROGRESS });
      const landed = await historicalTask(stack, w, 'already-landed', {
        branch: 'orbit/already-landed', branchSha: sha('1'), baseSha: sha('b'),
      });
      // The owner's own receipt: O-R3 owes nobody a word about it.
      await stack.receipts.record(w.ownerId, landed.sessionId, {
        result: 'MERGED', sourceSha: sha('1'), targetBranch: 'main', targetShaAfter: sha('2'),
      }, 'USER');
      assert.equal(await landingOf(stack, landed.taskId), 'ON_UPSTREAM', 'CONTROL: that one is known to be on main');
      const candidate = await blockedCandidate(stack, w, settled, 'ERROR');
      const before = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.promotionId } });
      const unstarted = await world(stack, 'scope-unstarted', { lineStarted: false });
      const elsewhere = await historicalTask(stack, unstarted, 'line-not-started', {
        branch: 'orbit/line-not-started', branchSha: sha('3'), baseSha: sha('b'),
      });
      await stack.pushes.settled();
      const pushedBefore = stack.pushes.calls.length;

      const run = await runPass();
      const mine = run.projects.find((project) => project.projectId === w.projectId);
      assert.ok(mine, 'the pass did not look at the project');
      assert.deepEqual([...mine.frozen].sort(), [settled.taskId, alsoSettled.taskId].sort(),
        'the pass freezes exactly the settled work that names its commit');
      assert.deepEqual(
        Object.fromEntries(mine.left.map((task) => [task.taskId, task.settlement])),
        { [moving.taskId]: 'WORK_MOVING', [unknown.taskId]: 'IDENTITY_UNKNOWN' },
        'the work still moving and the identity nobody can name are left as they are',
      );
      assert.equal(run.projects.some((project) => project.projectId === unstarted.projectId), false,
        'a project whose line never started is not looked at');

      // O-L4: the identity, from the session the work ended on.
      const frozen = await delivered(stack, settled.taskId);
      assert.equal(frozen.deliveredSha, sha('a'));
      assert.equal(frozen.deliveredBaseSha, sha('b'));
      assert.equal(frozen.deliveredBranch, 'orbit/settled');
      assert.equal(frozen.deliveredSessionId, settled.sessionId);
      assert.ok(frozen.deliveredAt);
      for (const left of [moving, unknown, codeless, notDone, landed, elsewhere]) {
        assert.equal((await delivered(stack, left.taskId)).deliveredAt, null, `${left.title} was frozen`);
      }

      // One observation for the project, queued by the pass and handed only the frozen tasks.
      const [queued, ...more] = await observations(stack, w);
      assert.equal(more.length, 0, 'one observation per project');
      assert.equal(queued.state, 'QUEUED');
      assert.deepEqual(mine.observation, { jobId: queued.id, queued: true });
      assert.equal(await triggerOf(stack, queued.id), 'DEPLOY');
      assert.deepEqual(await observations(stack, unstarted), []);
      const command = await claimObservation(stack, w, 'scope-observer');
      assert.ok(command, 'the observing runner is handed the pass\'s observation');
      assert.equal(command.jobId, queued.id);
      assert.deepEqual(
        (command.observeTasks ?? []).map((task) => task.taskId).sort(),
        [settled.taskId, alsoSettled.taskId].sort(),
      );

      // Nothing rewritten, nothing invented: the candidate stands as the check left it, no receipt or
      // item appeared, and nobody's phone rang.
      const after = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.promotionId } });
      assert.deepEqual(
        [after.state, after.blockedReason, after.sourceSha, after.updatedAt.getTime()],
        [before.state, before.blockedReason, before.sourceSha, before.updatedAt.getTime()],
      );
      assert.equal(await stack.db.sessionMergeReceipt.count({ where: { taskId: settled.taskId } }), 0);
      assert.deepEqual(await unconfirmedItems(stack, w), []);
      await stack.pushes.settled();
      assert.equal(stack.pushes.calls.length, pushedBefore);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (2) the round ══════════════════════════════════════════════════════════════════════════════

test('(2) §10.9 迁移 2, O-R1 O-R3, owner 2026-10-28: the round writes the receipts, M-T13 retires the BLOCKED candidates, J10 starts the dependent; one UL:backfill for the PLATFORM project, pushed once after the commit, counted in Needs-you and the project list until Accept',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'round', { started: true });
      const first = await historicalTask(stack, w, 'pushed first', {
        branch: 'orbit/pushed-first', branchSha: sha('a'), baseSha: sha('b'),
      });
      const second = await historicalTask(stack, w, 'pushed second', {
        branch: 'orbit/pushed-second', branchSha: sha('c'), baseSha: sha('b'),
      });
      const missing = await blockedCandidate(stack, w, first, 'ERROR');
      const alreadyLanded = await blockedCandidate(stack, w, second, 'ALREADY_LANDED');
      const dependent = await stack.tasks.create(w.ownerId, {
        title: 'waits for the first', projectId: w.projectId, assigneeId: w.workspaceId,
        autoRunWhenReady: true, completionCriterion: 'OWNER_CONFIRMED', dependsOnTaskIds: [first.taskId],
      } as never);
      await assert.rejects(stack.tasks.execute(w.ownerId, dependent.id), /not landed|not on main/i,
        'CONTROL: J9 holds the dependent, as it did all day on 10-28');

      await runPass();
      const [deploy] = await observations(stack, w);
      assert.equal(await triggerOf(stack, deploy.id), 'DEPLOY');

      // O-J4: the first look fails and is queued again — still the pass's round.
      const failing = await claimObservation(stack, w, 'round-observer-1');
      assert.ok(failing);
      await answer(stack, w, failing, {
        state: 'ERROR', phase: 'FETCH', errorCode: 'FETCH_FAILED',
        errorDetail: { ref: 'refs/heads/main', detail: 'could not read from remote' },
      });
      const [, retry] = await observations(stack, w);
      assert.ok(retry, 'O-J4 queued the next look');
      assert.equal(await triggerOf(stack, retry.id), 'FAILED_OBSERVATION');

      const command = await claimObservation(stack, w, 'round-observer-2');
      assert.ok(command);
      assert.equal(command.jobId, retry.id);
      await stack.pushes.settled();
      const pushedBefore = stack.pushes.calls.length;
      const applied = await answer(stack, w, command, observedBody(command));
      assert.equal(applied.accepted, true);
      assert.equal(applied.state, 'OBSERVED');
      assert.equal(applied.receiptIds.length, 2);

      // O-R1: a receipt per task; M-T13 retires both BLOCKED candidates and closes their items.
      for (const t of [first, second]) {
        const [receipt, ...extra] = await stack.db.sessionMergeReceipt.findMany({ where: { taskId: t.taskId } });
        assert.equal(extra.length, 0);
        assert.equal(receipt.result, 'ALREADY_MERGED');
        assert.equal(receipt.targetBranch, 'main');
        assert.equal(receipt.sourceBranch, t.branch);
        assert.equal(receipt.recordedBy, 'RUNNER');
        assert.deepEqual(receipt.detail, { integrationJobId: retry.id, observed: true });
        assert.equal(await landingOf(stack, t.taskId), 'ON_UPSTREAM');
      }
      for (const blocked of [missing, alreadyLanded]) {
        const retired = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: blocked.promotionId } });
        assert.equal(retired.state, 'SUPERSEDED', 'M-T13 retired the BLOCKED candidate');
        const closed = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: blocked.itemId } });
        assert.deepEqual([closed.state, closed.resolution], ['RESOLVED', 'PROMOTION_MOVED_ON']);
      }
      // J10, from the controller's own post-commit edge: the dependent started by itself.
      assert.equal(await stack.db.session.count({ where: { taskId: dependent.id } }), 1,
        'J10 started the dependent by itself');

      // O-R3, once for the project: UL:backfill:<projectId>, listing the tasks and their receipts.
      const receiptOf = async (taskId: string) =>
        (await stack.db.sessionMergeReceipt.findFirstOrThrow({ where: { taskId } })).id;
      const items = await unconfirmedItems(stack, w);
      assert.equal(items.length, 1, 'one item for the project, not one per task');
      const [item] = items;
      assert.equal(item.dedupeKey, `UL:backfill:${w.projectId}`);
      assert.deepEqual([item.state, item.assignee, item.assigneeReason], ['OPEN', 'OWNER', 'DEFAULT']);
      assert.deepEqual([item.taskId, item.sessionId, item.escalateAt, item.remindAt], [null, null, null, null],
        'about no single task, never escalated, never reminded');
      assert.equal(item.title, 'Reached main without your confirmation: 2 tasks');
      const payload = item.payload as { backfill?: boolean; jobId?: string; targetBranch?: string; receipts?: unknown[] };
      assert.equal(payload.backfill, true);
      assert.equal(payload.jobId, retry.id);
      assert.equal(payload.targetBranch, 'main');
      assert.deepEqual(
        [...(payload.receipts ?? [])].sort((a, b) =>
          String((a as { taskId: string }).taskId).localeCompare(String((b as { taskId: string }).taskId))),
        await Promise.all([first, second].sort((a, b) => a.taskId.localeCompare(b.taskId)).map(async (t) => ({
          taskId: t.taskId, title: t.title, receiptId: await receiptOf(t.taskId), recordedBy: 'RUNNER',
          targetBranch: 'main', sourceSha: t.taskId === first.taskId ? sha('a') : sha('c'), observed: true,
        }))),
      );

      // Pushed exactly once, after the commit, in the words §7.6 V12 gives it.
      await stack.pushes.settled();
      assert.deepEqual(stack.pushes.calls.slice(pushedBefore), [{ itemId: item.id, committed: true }]);
      const sent = stack.pushes.sent.filter((push) => push.openItemID === item.id);
      assert.deepEqual(sent, [{
        kind: 'landed-without-confirmation', title: 'Landed without your confirmation',
        body: `Reached main without your confirmation: 2 tasks · ${'round project'}`, openItemID: item.id,
        collapseId: `owner-item-${item.id}`,
      }]);

      // Counted like a merge approval: the project list, the Needs-you signal, the conversation's
      // summary and the badge.
      assert.deepEqual(await counted(stack, w), {
        projectList: [['LANDED_WITHOUT_CONFIRMATION', 1]],
        needsYou: [['LANDED_WITHOUT_CONFIRMATION', item.id]],
        summary: [['LANDED_WITHOUT_CONFIRMATION', 'Reached main without your confirmation: 2 tasks']],
        badge: true,
      });
      // Drawn among the owner's items, led by Accept; it names no task, so there is no session to open.
      const list = await stack.openItems.list(w.ownerId, w.projectId);
      const drawn = list.needsYou.find((candidate) => candidate.itemId === item.id);
      assert.ok(drawn, 'the owner\'s open items do not draw it');
      assert.deepEqual(drawn.actions, ['ACCEPT']);
      // A later delivery for the tasks does not ring the phone again.
      await stack.openItems.deliverForTasks([first.taskId, second.taskId]);
      await stack.pushes.settled();
      assert.equal(stack.pushes.calls.filter((call) => call.itemId === item.id).length, 1, 'pushed twice');

      // Accept ends it, and nothing counts it any more.
      const accepted = await stack.openItems.acceptOpenItem(w.ownerId, w.projectId, item.id);
      assert.deepEqual(accepted, { itemId: item.id, state: 'RESOLVED', resolution: 'ACCEPTED' });
      assert.deepEqual(await counted(stack, w), { projectList: [], needsYou: [], summary: [], badge: false });
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (3) after the round ════════════════════════════════════════════════════════════════════════

test('(3) §10.9: after the round, an ordinary observation\'s O-R3 opens one item per task again, pushed once after the commit',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'after-round');
      const old = await historicalTask(stack, w, 'from before', {
        branch: 'orbit/from-before', branchSha: sha('a'), baseSha: sha('b'),
      });
      await runPass();
      const round = await claimObservation(stack, w, 'after-round-1');
      assert.ok(round);
      await answer(stack, w, round, observedBody(round));
      const [backfillItem] = await unconfirmedItems(stack, w);
      assert.equal(backfillItem?.dedupeKey, `UL:backfill:${w.projectId}`);

      // Work finished after the deploy: its identity frozen at its DONE, then looked at by the door.
      const fresh = await historicalTask(stack, w, 'from after', {
        branch: 'orbit/from-after', branchSha: sha('c'), baseSha: sha('b'),
      });
      await stack.db.task.update({
        where: { id: fresh.taskId },
        data: {
          deliveredSha: sha('c'), deliveredBaseSha: sha('b'), deliveredBranch: 'orbit/from-after',
          deliveredSessionId: fresh.sessionId, deliveredAt: new Date(),
        },
      });
      await stack.db.$transaction((tx) => queueLandingObservation(tx, {
        ownerId: w.ownerId, projectId: w.projectId, trigger: 'OBSERVE_DOOR',
      }));
      const ordinary = await claimObservation(stack, w, 'after-round-2');
      assert.ok(ordinary);
      assert.deepEqual((ordinary.observeTasks ?? []).map((task) => task.taskId), [fresh.taskId]);
      await stack.pushes.settled();
      const pushedBefore = stack.pushes.calls.length;
      await answer(stack, w, ordinary, observedBody(ordinary));

      const receipt = await stack.db.sessionMergeReceipt.findFirstOrThrow({ where: { taskId: fresh.taskId } });
      const items = await unconfirmedItems(stack, w);
      assert.deepEqual(items.map((item) => item.dedupeKey),
        [`UL:backfill:${w.projectId}`, `UL:${fresh.taskId}:${receipt.id}`]);
      const perTask = items[1]!;
      assert.equal(perTask.taskId, fresh.taskId);
      assert.equal(perTask.title, 'Reached main without your confirmation: from after');
      await stack.pushes.settled();
      assert.deepEqual(stack.pushes.calls.slice(pushedBefore), [{ itemId: perTask.id, committed: true }]);
      assert.deepEqual(stack.pushes.sent.filter((push) => push.openItemID === perTask.id).map((push) => push.body),
        ['Reached main without your confirmation: from after · after-round project']);
      assert.ok(old);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (4) idempotent ═════════════════════════════════════════════════════════════════════════════

test('(4) §10.9: a second run, two runs at once and two project transactions at once leave one freeze, one observation and one item; a replayed result pushes nothing',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      // Two replicas starting together: the advisory lock lets one pass at a time, and the second finds
      // nothing left.
      const w = await world(stack, 'twice');
      const t = await historicalTask(stack, w, 'seen once', {
        branch: 'orbit/seen-once', branchSha: sha('a'), baseSha: sha('b'),
      });
      const [left, right] = await Promise.all([runPass(), runPass()]);
      const frozenBy = [left, right].map((run) =>
        run.projects.find((project) => project.projectId === w.projectId)?.frozen ?? []);
      assert.deepEqual(frozenBy.flat(), [t.taskId], 'the two runs froze it once between them');
      const firstFreeze = (await delivered(stack, t.taskId)).deliveredAt;
      assert.equal((await observations(stack, w)).length, 1, 'one observation between them');

      // A later start: nothing left to freeze, nothing queued.
      const again = await runPass();
      assert.equal(again.projects.some((project) => project.projectId === w.projectId), false);
      assert.deepEqual((await delivered(stack, t.taskId)).deliveredAt, firstFreeze, 'the identity was frozen again');
      assert.equal((await observations(stack, w)).length, 1);

      // The round answers; a replayed result, and a pass after it, add nothing — and ring nothing.
      const command = await claimObservation(stack, w, 'twice-observer');
      assert.ok(command);
      await answer(stack, w, command, observedBody(command));
      await stack.pushes.settled();
      const pushedAfterRound = stack.pushes.calls.length;
      const replay = await answer(stack, w, command, observedBody(command));
      assert.equal(replay.accepted, false);
      await runPass();
      await stack.pushes.settled();
      assert.equal(stack.pushes.calls.length, pushedAfterRound, 'a replay or a later pass rang the phone');
      assert.equal((await unconfirmedItems(stack, w)).length, 1);
      assert.equal(await stack.db.sessionMergeReceipt.count({ where: { taskId: t.taskId } }), 1);
      assert.equal((await observations(stack, w)).length, 1, 'a pass after the round queued another look');

      // Two project transactions at once, outside the advisory lock: the owner's graph mutex and the
      // compare-and-set on delivered_at leave one freeze and one observation.
      const raced = await world(stack, 'raced');
      const one = await historicalTask(stack, raced, 'raced one', {
        branch: 'orbit/raced-one', branchSha: sha('c'), baseSha: sha('b'),
      });
      const two = await historicalTask(stack, raced, 'raced two', {
        branch: 'orbit/raced-two', branchSha: sha('d'), baseSha: sha('b'),
      });
      const otherClient = prismaClientFor(URL!);
      try {
        const input = { ownerId: raced.ownerId, projectId: raced.projectId, taskIds: [one.taskId, two.taskId] };
        const outcomes = await Promise.all([
          stack.db.$transaction((tx) => backfill.backfillProject(tx, input), { timeout: 60_000 }),
          otherClient.$transaction((tx) => backfill.backfillProject(tx, input), { timeout: 60_000 }),
        ]);
        assert.deepEqual(outcomes.map((outcome) => outcome.frozen.length).sort(), [0, 2],
          'one transaction froze both, the other found them frozen');
        assert.deepEqual(outcomes.map((outcome) => outcome.observation === null).sort(), [false, true]);
      } finally {
        await otherClient.$disconnect();
      }
      assert.equal((await observations(stack, raced)).length, 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (5) not seen ═══════════════════════════════════════════════════════════════════════════════

test('(5) §10.9: work the round does not see opens LANDING_UNOBSERVED in an AGENT_PUSH project, and writes nothing in a PLATFORM project, whose candidate is left to its own pipeline',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const pushed = await world(stack, 'unseen-push', { deliveryMode: 'AGENT_PUSH' });
      const elsewhere = await historicalTask(stack, pushed, 'pushed elsewhere', {
        branch: 'orbit/pushed-elsewhere', branchSha: sha('a'), baseSha: sha('b'),
      });
      const platform = await world(stack, 'unseen-platform');
      const waiting = await historicalTask(stack, platform, 'waits for its merge', {
        branch: 'orbit/waits-for-its-merge', branchSha: sha('c'), baseSha: sha('b'),
      });
      const candidate = await blockedCandidate(stack, platform, waiting, 'ERROR');

      await runPass();
      assert.equal((await observations(stack, pushed)).length, 1, 'one observation for the AGENT_PUSH project');
      assert.equal((await observations(stack, platform)).length, 1, 'one observation for the PLATFORM project');

      const look = await claimObservation(stack, pushed, 'unseen-push-observer');
      assert.ok(look);
      await answer(stack, pushed, look, observedBody(look, () => false));
      const [unobserved, ...more] = await stack.db.projectOpenItem.findMany({
        where: { projectId: pushed.projectId, kind: 'LANDING_UNOBSERVED' },
      });
      assert.equal(more.length, 0);
      assert.equal(unobserved.taskId, elsewhere.taskId);
      assert.equal(unobserved.dedupeKey, `LU:${elsewhere.taskId}:${sha('a')}`);
      assert.equal((unobserved.payload as { reason?: string }).reason, 'NOT_ON_LINE');
      assert.equal(unobserved.assignee, 'COORDINATOR');

      const platformLook = await claimObservation(stack, platform, 'unseen-platform-observer');
      assert.ok(platformLook);
      await answer(stack, platform, platformLook, observedBody(platformLook, () => false));
      assert.deepEqual(await stack.db.projectOpenItem.findMany({
        where: { projectId: platform.projectId, kind: { in: ['LANDING_UNOBSERVED', 'LANDED_WITHOUT_CONFIRMATION'] } },
      }), []);
      assert.equal(await landingOf(stack, waiting.taskId), 'NOT_KNOWN');
      const still = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.promotionId } });
      assert.equal(still.state, 'BLOCKED', 'the PLATFORM candidate is left to its own pipeline');
    } finally {
      await stack.db.$disconnect();
    }
  });
