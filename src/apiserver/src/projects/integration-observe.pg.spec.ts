import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
import {
  Prisma,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
  type Runner,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { applyIntegrationJobResult, dispatchIntegrationJobs } from '../runner-api/integration-job-relay';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  canonicalRepoUrl,
  projectIntegrationView,
  readInFlightJobs,
  readProjectCodebase,
  readProjectIntegrationView,
  readProjectListBindings,
} from './project-integration-line';
import { ProjectIntegrationRetryController } from './project-integration-retry.controller';
import { ProjectsController } from './projects.controller';
import { recordLandingUnobserved, type LandingUnobserved } from './project-open-item';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * The observation door, `integration_observe` (`docs/project-integration-line-contract.md` §10.8,
 * §4.7 「再观测一次」, §10.6 O-T5): the coordinator's runner door and the owner's user door.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/integration-observe.pg.spec.ts
 *
 *  (1) the coordinator's door (O-T5): with the project's current coordinator in X-Orbit-Session-Id
 *      it queues one OBSERVE_LANDING (its ENQUEUED fact says OBSERVE_DOOR) and marks, by H1, the
 *      coordinator's OPEN LANDING_UNOBSERVED whose task waits to be observed — not one whose identity
 *      is unknown, not the owner's — and the read model shows it handled by that observation; a second
 *      press folds into the queued one and the item carries the newer reason;
 *  (2) the owner's door: the same observation, the owner's own LANDING_UNOBSERVED marked with the
 *      owner as the one who asked, and an acting session refused 403 INTEGRATION_OBSERVE_OWNER_CHANNEL_ONLY;
 *  (3) who may ask: another session (a work session of the project, another project's coordinator),
 *      a blank header and no header are refused 403 INTEGRATION_OBSERVE_COORDINATOR_ONLY, another
 *      account's project is a 404 on both doors — and none of them writes anything;
 *  (4) the reason: missing, blank or over 2000 characters is 400 INTEGRATION_OBSERVE_REASON_REQUIRED on
 *      both doors, and nothing is written;
 *  (5) O-T5 queues even with nothing waiting, and a project with no repository bound is 409
 *      INTEGRATION_REPOSITORY_UNKNOWN with nothing written;
 *  (6) after it: an observation that does not see the commit leaves the item OPEN and no longer
 *      handled, with no second item; one that sees it closes it RESOLVED / LANDED;
 *  (7) IE:observe (§10.6 O-J4): its coordinator message names integration_observe, the hand-over now
 *      accepts it (its cell holds the door), and the observation the door queues resolves it
 *      JOB_MOVED_ON when it answers;
 *  (8) O-X1 for IE:observe (§10.7): while a task of the project waits to be observed, open_item_resolve
 *      refuses it 409 OPEN_ITEM_CONDITION_STANDS on the coordinator's runner door and the owner's user
 *      door, naming integration_observe and open_item_hand_over and nothing else, and writes nothing;
 *      once nothing waits, either door closes it by hand as before;
 *  (9) A-Q23: an observation is not an integration attempt — with only a queued OBSERVE_LANDING the
 *      integration view's inFlightJobs is empty and the project list counts nothing in flight, while a
 *      LAND_TASK beside it is listed and counted; the line's own queue still holds both.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own rows. What this spec
 * reaches that the tree before R29-7 does not have is read through a local type, so the file compiles
 * there and each case is red for want of the door rather than of a type.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const JOB = 'integration-job/v1';
const OBSERVE = 'integration-observe/v1';
const CAPABLE = [JOB, OBSERVE, 'integration-progress/v2'];
const sha = (nibble: string) => nibble.repeat(40);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** What the door answers (R29-7). */
interface IntegrationObserved {
  projectId: string;
  jobId: string;
  generation: number;
  queued: boolean;
  reason: string;
  handlingItemIds: string[];
}
type RunnerObserveDoor = {
  observeIntegration?(runner: Runner, sessionId: string | undefined, id: string, dto: { reason?: unknown }): Promise<IntegrationObserved>;
};
type OwnerObserveDoor = {
  observeIntegration?(user: { userId: string }, id: string, dto: { reason?: unknown }, actingSessionId: string | undefined): Promise<IntegrationObserved>;
};

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
  openItems: ProjectOpenItemService;
  runnerDoor: RunnerProjectsController;
  ownerDoor: ProjectIntegrationRetryController;
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const push = new Proxy({}, { get: () => () => Promise.resolve() }) as unknown as PushService;
  const openItems = new ProjectOpenItemService(prisma, sessions, push);
  // The coordinator's door spends no orchestration credential: it starts no session.
  const runnerDoor = new RunnerProjectsController(
    {} as never,
    {} as never,
    {} as never,
    { assert: async () => assert.fail('an observation spends no orchestration credential') } as never,
    openItems,
  );
  const ownerDoor = new ProjectIntegrationRetryController(openItems);
  return { db, prisma, openItems, runnerDoor, ownerDoor };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

/**
 * One owner, a runner that observes, the workspace the work runs in, the live conversation the
 * project is coordinated from, and — unless `bound` is false — an AGENT_PUSH project on main whose
 * line has started.
 */
async function world(
  stack: Stack, label: string, options: { bound?: boolean; line?: 'MAIN' | 'PROJECT_BRANCH' } = {},
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/${label}-${projectId.slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@integration-observe.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: CAPABLE, maxConcurrent: 4, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      heartbeatLeaseOwner: randomUUID(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl, workDir: `/srv/${label}` },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `coordinator: ${label}`, prompt: `coordinator: ${label}`, provider: 'claude',
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true, numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId, seq: 1, clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message', content: `coordinator: ${label}`, status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'finished work is seen where it is',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId, startedAt: new Date(),
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  if (options.bound !== false) {
    // AGENT_PUSH is a MAIN line's alone (§10.4's CHECK); a project branch delivers by the platform.
    const projectBranch = options.line === 'PROJECT_BRANCH';
    await db.projectCodebase.create({
      data: {
        ownerId, projectId, canonicalRepoUrl: canonicalRepoUrl(repoUrl)!, upstreamRef: 'refs/heads/main',
        integrationRef: projectBranch ? `refs/heads/project/${projectId.slice(0, 8)}` : 'refs/heads/main',
        refAuthority: 'REMOTE', remoteName: 'origin', integrationRefSource: 'EXPLICIT',
        integrationStartedAt: new Date(), deliveryMode: projectBranch ? 'PLATFORM' : 'AGENT_PUSH',
      },
    });
  }
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

interface Done {
  taskId: string;
  sessionId: string;
  branch: string;
  deliveredSha: string | null;
}

/**
 * A finished code task: DONE, its worktree session finished, and — unless `frozen` is false — the
 * delivered identity O-L4 froze, which is what makes it wait to be observed (§10.6).
 */
async function doneTask(stack: Stack, w: World, title: string, tip: string, options: { frozen?: boolean } = {}): Promise<Done> {
  const taskId = randomUUID();
  const sessionId = randomUUID();
  const branch = `orbit/${title}`;
  const frozen = options.frozen !== false;
  await stack.db.task.create({
    data: {
      id: taskId, ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title, projectId: w.projectId,
      assigneeId: w.workspaceId, status: TaskStatus.DONE, completionCriterion: 'OWNER_CONFIRMED',
    },
  });
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title, prompt: title, provider: 'claude', status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, isolationStatus: 'worktree',
      branch, branchSha: tip, baseSha: sha('b'), numTurns: 1, startedAt: minutesAgo(30), createdAt: minutesAgo(30),
      finishedAt: minutesAgo(2), runtimeSessionId: randomUUID(),
    },
  });
  if (frozen) {
    await stack.db.task.update({
      where: { id: taskId },
      data: {
        deliveredSha: tip, deliveredBaseSha: sha('b'), deliveredBranch: branch, deliveredSessionId: sessionId,
        deliveredAt: minutesAgo(2),
      },
    });
  }
  return { taskId, sessionId, branch, deliveredSha: frozen ? tip : null };
}

/** §10.7's LANDING_UNOBSERVED about `t`, opened the way O-R4 and O-T1 open it, then given to `assignee`. */
async function unobserved(
  stack: Stack, w: World, t: Done, assignee: 'COORDINATOR' | 'OWNER', over: Partial<LandingUnobserved> = {},
): Promise<string> {
  const opened = await stack.db.$transaction((tx) => recordLandingUnobserved(tx, {
    taskId: t.taskId,
    reason: t.deliveredSha ? 'NOT_ON_LINE' : 'IDENTITY_UNKNOWN',
    deliveredSha: t.deliveredSha,
    baseSha: sha('b'),
    branch: t.branch,
    sessionId: t.sessionId,
    observedUpstreamSha: sha('9'),
    observedLineSha: sha('9'),
    observedAt: minutesAgo(1),
    jobId: null,
    ...over,
  }));
  assert.ok(opened, 'CONTROL: the item opened');
  if (assignee === 'OWNER') {
    await stack.db.projectOpenItem.update({
      where: { id: opened.itemId },
      data: { assignee: 'OWNER', assigneeReason: 'HANDED_OVER', escalateAt: null, escalatedAt: new Date() },
    });
  }
  return opened.itemId;
}

function runnerOf(w: World): Runner {
  return { id: w.runnerId, ownerId: w.ownerId } as Runner;
}

/** The coordinator's door, `POST /runner/projects/:id/integration/observe`. */
function observeAsSession(stack: Stack, w: World, sessionId: string | undefined, body: { reason?: unknown }, projectId = w.projectId) {
  const door = (stack.runnerDoor as unknown as RunnerObserveDoor).observeIntegration;
  assert.ok(door, 'there is no runner observe door (POST /runner/projects/:id/integration/observe)');
  return door.call(stack.runnerDoor, runnerOf(w), sessionId, projectId, body);
}

/** The owner's door, `POST /projects/:id/integration/observe`. */
function observeAsOwner(stack: Stack, w: World, body: { reason?: unknown }, actingSessionId?: string, projectId = w.projectId) {
  const door = (stack.ownerDoor as unknown as OwnerObserveDoor).observeIntegration;
  assert.ok(door, 'there is no owner observe door (POST /projects/:id/integration/observe)');
  return door.call(stack.ownerDoor, { userId: w.ownerId }, projectId, body, actingSessionId);
}

interface Refusal {
  status: number;
  code: string | undefined;
  message: string;
}

/** What a door answered, when it refused. */
async function refusal(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse() as string | { code?: string; message?: unknown };
      return typeof body === 'string'
        ? { status: error.getStatus(), code: undefined, message: body }
        : { status: error.getStatus(), code: body.code, message: String(body.message ?? '') };
    }
    throw error;
  }
  return assert.fail('the door did not refuse');
}

function observations(stack: Stack, w: World) {
  return stack.db.projectIntegrationJob.findMany({
    where: { projectId: w.projectId, kind: 'OBSERVE_LANDING' },
    orderBy: { generation: 'asc' },
    select: { id: true, state: true, generation: true },
  });
}

function itemRow(stack: Stack, id: string) {
  return stack.db.projectOpenItem.findUniqueOrThrow({
    where: { id },
    select: {
      id: true, state: true, resolution: true, assignee: true, assigneeReason: true, handlingJobId: true,
      handlingSessionId: true, handlingUserId: true, handlingReason: true, handlingStartedAt: true,
    },
  });
}

/** The `handling` the open-items read model gives the item (§4.7 H5), or null. */
async function handlingRead(stack: Stack, w: World, itemId: string) {
  const view = await stack.openItems.list(w.ownerId, w.projectId) as unknown as Record<string, unknown>;
  const rows = Object.values(view).filter(Array.isArray).flat() as Array<{ itemId: string; handling?: unknown }>;
  const row = rows.find((candidate) => candidate.itemId === itemId);
  assert.ok(row, `the read model does not list item ${itemId}`);
  return (row.handling ?? null) as null | { jobId: string; jobKind: string; state: string; sessionId: string | null; userId: string | null; reason: string };
}

/** One heartbeat of the world's runner, and the observation it was handed. */
async function claimObservation(stack: Stack, w: World) {
  const commands = await dispatchIntegrationJobs(stack.prisma, {
    runnerId: w.runnerId, leaseOwner: randomUUID(), draining: false, capabilities: CAPABLE,
  });
  const command = commands.find((candidate) => candidate.kind === 'OBSERVE_LANDING') as
    | (typeof commands[number] & { observeTasks?: Array<{ taskId: string; deliveredSha: string; baseSha: string | null }> })
    | undefined;
  assert.ok(command, 'CONTROL: the runner was handed the observation');
  return command;
}

/** The OBSERVED answer of a claim: every task it was handed, `seen` or not on the upstream. */
function answer(stack: Stack, w: World, command: Awaited<ReturnType<typeof claimObservation>>, seen: (taskId: string) => boolean) {
  return applyIntegrationJobResult(stack.prisma, {
    jobId: command.jobId,
    runnerId: w.runnerId,
    ownerId: w.ownerId,
    body: {
      claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, state: 'OBSERVED', phase: 'OBSERVE',
      upstreamSha: sha('9'), targetShaBefore: sha('9'),
      observations: (command.observeTasks ?? []).map((task) => ({
        taskId: task.taskId, deliveredSha: task.deliveredSha, baseSha: task.baseSha,
        onUpstream: seen(task.taskId), onIntegrationLine: null, empty: false, fullyApplied: null,
      })),
    } as never,
  });
}

// ═══ (1) the coordinator's door ══════════════════════════════════════════════════════════════

test('(1) §10.8 O-T5: the coordinator\'s door queues an observation and marks, by H1, its own LANDING_UNOBSERVED whose task waits to be observed; a second press folds into it',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'observe-coordinator');
      const waiting = await doneTask(stack, w, 'pushed-after-done', sha('1'));
      const unknown = await doneTask(stack, w, 'identity-unknown', sha('2'), { frozen: false });
      const ownersTask = await doneTask(stack, w, 'owners-item', sha('3'));
      const mine = await unobserved(stack, w, waiting, 'COORDINATOR');
      const cannotBeSeen = await unobserved(stack, w, unknown, 'COORDINATOR');
      const owners = await unobserved(stack, w, ownersTask, 'OWNER');

      const first = await observeAsSession(stack, w, ` ${w.coordinatorSessionId} `, { reason: '  the agent pushed after DONE  ' });
      const jobs = await observations(stack, w);
      assert.equal(jobs.length, 1, 'one observation is queued');
      assert.deepEqual(jobs.map((job) => job.state), ['QUEUED']);
      assert.equal(first.jobId, jobs[0]!.id);
      assert.equal(first.queued, true);
      assert.equal(first.generation, jobs[0]!.generation);
      assert.equal(first.reason, 'the agent pushed after DONE', 'the reason is kept trimmed');
      assert.deepEqual(first.handlingItemIds, [mine], 'H1 marks only the coordinator\'s item an observation can answer');
      const [enqueued] = await stack.db.projectIntegrationJobEvent.findMany({
        where: { jobId: first.jobId, kind: 'ENQUEUED' }, select: { data: true },
      });
      assert.equal((enqueued?.data as { trigger?: string } | undefined)?.trigger, 'OBSERVE_DOOR', 'the enqueue names O-T5');

      const marked = await itemRow(stack, mine);
      assert.equal(marked.state, 'OPEN', 'being handled is not being closed');
      assert.equal(marked.handlingJobId, first.jobId);
      assert.equal(marked.handlingSessionId, w.coordinatorSessionId);
      assert.equal(marked.handlingUserId, null);
      assert.equal(marked.handlingReason, 'the agent pushed after DONE');
      assert.ok(marked.handlingStartedAt);
      for (const untouched of [cannotBeSeen, owners]) {
        assert.equal((await itemRow(stack, untouched)).handlingJobId, null,
          'an item the observation cannot answer, or the owner\'s, is not marked by the coordinator\'s press');
      }
      const read = await handlingRead(stack, w, mine);
      assert.ok(read, 'the read model does not show the item handled');
      assert.equal(read.jobId, first.jobId);
      assert.equal(read.jobKind, 'OBSERVE_LANDING');
      assert.equal(read.state, 'QUEUED');
      assert.equal(read.sessionId, w.coordinatorSessionId);
      assert.equal(read.reason, 'the agent pushed after DONE');

      // A second press while it is queued folds into it: one job, the newer reason on the item.
      const second = await observeAsSession(stack, w, w.coordinatorSessionId, { reason: 'and once more after the second push' });
      assert.equal(second.queued, false, 'the second press folded into the queued observation');
      assert.equal(second.jobId, first.jobId);
      assert.equal((await observations(stack, w)).length, 1);
      assert.deepEqual(second.handlingItemIds, [mine]);
      const remarked = await itemRow(stack, mine);
      assert.equal(remarked.handlingJobId, first.jobId);
      assert.equal(remarked.handlingReason, 'and once more after the second push');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (2) the owner's door ══════════════════════════════════════════════════════════════════════

test('(2) §10.8: the owner\'s door queues the same observation and marks the owner\'s own LANDING_UNOBSERVED; an acting session is refused',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'observe-owner');
      const coordinatorsTask = await doneTask(stack, w, 'coordinators-item', sha('4'));
      const ownersTask = await doneTask(stack, w, 'owners-item', sha('5'));
      const coordinators = await unobserved(stack, w, coordinatorsTask, 'COORDINATOR');
      const owners = await unobserved(stack, w, ownersTask, 'OWNER');

      const refused = await refusal(() => observeAsOwner(stack, w, { reason: 'from a session' }, w.coordinatorSessionId));
      assert.equal(refused.status, 403);
      assert.equal(refused.code, 'INTEGRATION_OBSERVE_OWNER_CHANNEL_ONLY');
      assert.equal((await observations(stack, w)).length, 0, 'the refused press queued nothing');

      const pressed = await observeAsOwner(stack, w, { reason: 'I pushed the fix to main by hand' });
      const jobs = await observations(stack, w);
      assert.equal(jobs.length, 1);
      assert.equal(pressed.jobId, jobs[0]!.id);
      assert.equal(pressed.queued, true);
      assert.deepEqual(pressed.handlingItemIds, [owners], 'H1 marks only the owner\'s item for the owner\'s press');
      const marked = await itemRow(stack, owners);
      assert.equal(marked.state, 'OPEN');
      assert.equal(marked.handlingJobId, pressed.jobId);
      assert.equal(marked.handlingUserId, w.ownerId, 'the owner is the one who asked');
      assert.equal(marked.handlingSessionId, null);
      assert.equal(marked.handlingReason, 'I pushed the fix to main by hand');
      assert.equal((await itemRow(stack, coordinators)).handlingJobId, null);
      const read = await handlingRead(stack, w, owners);
      assert.equal(read?.userId, w.ownerId);
      assert.equal(read?.jobKind, 'OBSERVE_LANDING');

      // The coordinator's press after it folds into the same observation and marks its own item.
      const folded = await observeAsSession(stack, w, w.coordinatorSessionId, { reason: 'the coordinator asks too' });
      assert.equal(folded.queued, false);
      assert.equal(folded.jobId, pressed.jobId);
      assert.deepEqual(folded.handlingItemIds, [coordinators]);
      assert.equal((await itemRow(stack, owners)).handlingUserId, w.ownerId, 'the owner\'s mark is left as it was');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (3) who may ask ═══════════════════════════════════════════════════════════════════════════

test('(3) §10.8: only the project\'s current coordinator conversation or the owner may ask — any other session, a blank or missing header is 403, another account\'s project 404, and nothing is written',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'observe-who');
      const other = await world(stack, 'observe-stranger');
      const t = await doneTask(stack, w, 'waits', sha('6'));
      const item = await unobserved(stack, w, t, 'COORDINATOR');

      for (const [label, sessionId] of [
        ['the task\'s own work session', t.sessionId],
        ['another project\'s coordinator', other.coordinatorSessionId],
        ['a blank header', '   '],
        ['no header', undefined],
      ] as const) {
        const refused = await refusal(() => observeAsSession(stack, w, sessionId, { reason: 'look again' }));
        assert.equal(refused.status, 403, `${label}: ${refused.message}`);
        assert.equal(refused.code, 'INTEGRATION_OBSERVE_COORDINATOR_ONLY', label);
      }
      // Another account's project is not there at all: the stranger's own coordinator on its own
      // machine, and the stranger as the account owner.
      const strangerRunner = await refusal(() => observeAsSession(stack, other, other.coordinatorSessionId, { reason: 'look' }, w.projectId));
      assert.equal(strangerRunner.status, 404);
      const strangerOwner = await refusal(() => observeAsOwner(stack, other, { reason: 'look' }, undefined, w.projectId));
      assert.equal(strangerOwner.status, 404);

      assert.equal((await observations(stack, w)).length, 0, 'no refused press queued anything');
      assert.equal((await itemRow(stack, item)).handlingJobId, null, 'no refused press marked the item');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (4) the reason ════════════════════════════════════════════════════════════════════════════

test('(4) §10.8: a missing, blank or over-long reason is 400 INTEGRATION_OBSERVE_REASON_REQUIRED on both doors, and nothing is written',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'observe-reason');
      const t = await doneTask(stack, w, 'waits', sha('7'));
      const item = await unobserved(stack, w, t, 'COORDINATOR');
      for (const [label, body] of [
        ['no reason', {}],
        ['an empty reason', { reason: '' }],
        ['a blank reason', { reason: ' \n\t ' }],
        ['a reason that is not a string', { reason: 42 }],
        ['a reason over 2000 characters', { reason: 'x'.repeat(2001) }],
      ] as const) {
        for (const [door, press] of [
          ['the coordinator\'s door', () => observeAsSession(stack, w, w.coordinatorSessionId, body)],
          ['the owner\'s door', () => observeAsOwner(stack, w, body)],
        ] as const) {
          const refused = await refusal(press);
          assert.equal(refused.status, 400, `${door}, ${label}: ${refused.message}`);
          assert.equal(refused.code, 'INTEGRATION_OBSERVE_REASON_REQUIRED', `${door}, ${label}`);
        }
      }
      assert.equal((await observations(stack, w)).length, 0);
      assert.equal((await itemRow(stack, item)).handlingJobId, null);
      // Exactly 2000 characters is a reason.
      const longest = await observeAsSession(stack, w, w.coordinatorSessionId, { reason: 'y'.repeat(2000) });
      assert.equal(longest.reason.length, 2000);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (5) nothing waiting; nothing bound ════════════════════════════════════════════════════════

test('(5) O-T5: the door queues an observation even with nothing waiting; a project with no repository bound is 409 INTEGRATION_REPOSITORY_UNKNOWN',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'observe-idle');
      const pressed = await observeAsSession(stack, w, w.coordinatorSessionId, { reason: 'nothing waits, look anyway' });
      assert.equal(pressed.queued, true, 'O-T5 queues as it is asked');
      assert.deepEqual(pressed.handlingItemIds, []);
      assert.equal((await observations(stack, w)).length, 1);

      const unbound = await world(stack, 'observe-unbound', { bound: false });
      for (const press of [
        () => observeAsSession(stack, unbound, unbound.coordinatorSessionId, { reason: 'look' }),
        () => observeAsOwner(stack, unbound, { reason: 'look' }),
      ]) {
        const refused = await refusal(press);
        assert.equal(refused.status, 409, refused.message);
        assert.equal(refused.code, 'INTEGRATION_REPOSITORY_UNKNOWN');
      }
      assert.equal((await observations(stack, unbound)).length, 0);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (6) after the observation ═════════════════════════════════════════════════════════════════

test('(6) §10.8: an observation that does not see the commit leaves the item OPEN, no longer handled and not doubled; one that sees it closes it RESOLVED / LANDED',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'observe-after');
      const t = await doneTask(stack, w, 'late-push', sha('8'));
      const item = await unobserved(stack, w, t, 'COORDINATOR');

      const first = await observeAsSession(stack, w, w.coordinatorSessionId, { reason: 'the push may be there now' });
      const notYet = await claimObservation(stack, w);
      assert.equal(notYet.jobId, first.jobId);
      assert.deepEqual((notYet.observeTasks ?? []).map((task) => task.taskId), [t.taskId]);
      assert.equal((await handlingRead(stack, w, item))?.state, 'RUNNING', 'handled while the observation runs');
      await answer(stack, w, notYet, () => false);
      const still = await itemRow(stack, item);
      assert.equal(still.state, 'OPEN', 'not seen: the item stands');
      assert.equal(await handlingRead(stack, w, item), null, 'the observation ended, so nothing is handling the item');
      assert.equal(await stack.db.projectOpenItem.count({ where: { taskId: t.taskId, kind: 'LANDING_UNOBSERVED' } }), 1,
        'the same commit opens no second item');

      const again = await observeAsSession(stack, w, w.coordinatorSessionId, { reason: 'pushed for real this time' });
      assert.notEqual(again.jobId, first.jobId, 'the next press queues the next generation');
      assert.equal(again.queued, true);
      assert.deepEqual(again.handlingItemIds, [item]);
      const seen = await claimObservation(stack, w);
      await answer(stack, w, seen, (taskId) => taskId === t.taskId);
      const landed = await itemRow(stack, item);
      assert.equal(landed.state, 'RESOLVED');
      assert.equal(landed.resolution, 'LANDED', 'seen: the receipt closes it as landed (O-R1)');
      assert.equal(await stack.db.sessionMergeReceipt.count({ where: { taskId: t.taskId } }), 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (7) IE:observe ═════════════════════════════════════════════════════════════════════════════

test('(7) §10.6 O-J4 §10.8: IE:observe names integration_observe to its coordinator, can be handed to the owner, and the observation the door queues resolves it JOB_MOVED_ON',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'observe-error');
      const t = await doneTask(stack, w, 'waits-behind-a-fetch', sha('a'));
      // The item O-J4 opens at the third failure in a row, as `observationFailed` writes it.
      const now = new Date();
      const opened = await stack.db.projectOpenItem.create({
        data: {
          projectId: w.projectId, ownerId: w.ownerId, kind: 'INTEGRATION_ERROR', state: 'OPEN', assignee: 'COORDINATOR',
          assigneeReason: 'DEFAULT', dedupeKey: `IE:observe:${w.projectId}`, title: 'Integration error: observing main',
          payload: {
            jobKind: 'OBSERVE_LANDING', phase: 'FETCH', targetRef: 'refs/heads/main', errorCode: 'FETCH_FAILED',
            errorDetail: { message: 'could not read from remote repository' }, failureClass: 'ERROR', failures: 3, generation: 3,
          } as Prisma.InputJsonValue,
          waitingSince: now, assignedAt: now, escalateAt: new Date(now.getTime() + 7_200_000),
        },
        select: { id: true },
      });

      await stack.openItems.deliver(opened.id);
      const [turn] = await stack.db.conversationTurn.findMany({
        where: { sessionId: w.coordinatorSessionId, seq: { gt: 1 } }, select: { content: true },
      });
      assert.ok(turn, 'CONTROL: the item was delivered to the coordinator');
      assert.match(turn.content ?? '', /\bintegration_observe\b/, 'the coordinator is not told which door ends it');
      assert.doesNotMatch(turn.content ?? '', /\bnull\b/);

      // The observation the coordinator asks for answers, and the item about the failures is moot.
      const pressed = await observeAsSession(stack, w, w.coordinatorSessionId, { reason: 'the runner can fetch again' });
      assert.deepEqual(pressed.handlingItemIds, [], 'IE:observe is not a LANDING_UNOBSERVED: H1 does not mark it');
      const command = await claimObservation(stack, w);
      assert.deepEqual((command.observeTasks ?? []).map((task) => task.taskId), [t.taskId]);
      await answer(stack, w, command, () => true);
      const resolved = await itemRow(stack, opened.id);
      assert.equal(resolved.state, 'RESOLVED');
      assert.equal(resolved.resolution, 'JOB_MOVED_ON');

      // A second one, handed to the owner: the hand-over is in its cell's allow-list now.
      const second = await stack.db.projectOpenItem.create({
        data: {
          projectId: w.projectId, ownerId: w.ownerId, kind: 'INTEGRATION_ERROR', state: 'OPEN', assignee: 'COORDINATOR',
          assigneeReason: 'DEFAULT', dedupeKey: `IE:observe:${w.projectId}`, title: 'Integration error: observing main',
          payload: { jobKind: 'OBSERVE_LANDING', phase: 'FETCH', targetRef: 'refs/heads/main', errorCode: 'FETCH_FAILED', failureClass: 'ERROR', failures: 3, generation: 6 },
          waitingSince: now, assignedAt: now, escalateAt: new Date(now.getTime() + 7_200_000),
        },
        select: { id: true },
      });
      const handed = await stack.runnerDoor.handOverOpenItem(
        runnerOf(w), w.coordinatorSessionId, w.projectId, second.id, { note: 'only the owner can give the runner a deploy key' },
      ) as unknown as { assignee: string };
      assert.equal(handed.assignee, 'OWNER');
      const row = await itemRow(stack, second.id);
      assert.equal(row.assignee, 'OWNER');
      assert.equal(row.assigneeReason, 'HANDED_OVER');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (8) O-X1 for IE:observe ═════════════════════════════════════════════════════════════════════

/** The item O-J4 opens at the third failure in a row, as `observationFailed` writes it. */
async function observationErrorItem(stack: Stack, w: World, generation: number): Promise<string> {
  const now = new Date();
  const opened = await stack.db.projectOpenItem.create({
    data: {
      projectId: w.projectId, ownerId: w.ownerId, kind: 'INTEGRATION_ERROR', state: 'OPEN', assignee: 'COORDINATOR',
      assigneeReason: 'DEFAULT', dedupeKey: `IE:observe:${w.projectId}`, title: 'Integration error: observing main',
      payload: {
        jobKind: 'OBSERVE_LANDING', phase: 'FETCH', targetRef: 'refs/heads/main', errorCode: 'FETCH_FAILED',
        failureClass: 'ERROR', failures: 3, generation,
      },
      waitingSince: now, assignedAt: now, escalateAt: new Date(now.getTime() + 7_200_000),
    },
    select: { id: true },
  });
  return opened.id;
}

test('(8) §10.7 O-X1: IE:observe is not closed by hand while a task waits to be observed — 409 OPEN_ITEM_CONDITION_STANDS on both doors, naming integration_observe and open_item_hand_over — and closes by hand once nothing waits',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'observe-hand-close');
      const waiting = await doneTask(stack, w, 'waits-to-be-observed', sha('c'));
      const first = await observationErrorItem(stack, w, 3);
      // The owner's own door is the user API's resolve route; the coordinator's is the runner's.
      const ownerResolveDoor = new ProjectsController(
        {} as never, {} as never, {} as never, {} as never, {} as never, stack.openItems, {} as never,
      );
      const asCoordinator = (itemId: string, note: string) => stack.runnerDoor.resolveOpenItem(
        runnerOf(w), w.coordinatorSessionId, w.projectId, itemId, { note });
      const asOwner = (itemId: string, note: string) => ownerResolveDoor.resolveOpenItem(
        { userId: w.ownerId } as never, w.projectId, itemId, { note });
      const before = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: first } });

      for (const [label, press] of [['the coordinator\'s runner door', asCoordinator], ['the owner\'s user door', asOwner]] as const) {
        const refused = await refusal(() => press(first, 'the runner can fetch the repository again'));
        assert.equal(refused.status, 409, `${label}: ${refused.message}`);
        assert.equal(refused.code, 'OPEN_ITEM_CONDITION_STANDS', label);
        // §4.7 T17: only the doors this cell really has that move the wait.
        for (const door of ['integration_observe', 'open_item_hand_over']) {
          assert.match(refused.message, new RegExp(`\\b${door}\\b`), `${label}: the refusal does not name ${door}`);
        }
        for (const door of ['integration_retry', 'merge_receipt', 'task_reopen', 'open_item_resolve']) {
          assert.doesNotMatch(refused.message, new RegExp(`\\b${door}\\b`), `${label}: the refusal names ${door}`);
        }
      }
      const after = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: first } });
      assert.deepEqual(after, before, 'a refused hand-close wrote nothing');

      // The wait is gone: the task's work is recorded on main (the agent's merge_receipt), so no task
      // of the project waits to be observed, and the item closes by hand as it always did.
      await new MergeReceiptService(stack.prisma).record(w.ownerId, waiting.sessionId, {
        result: 'ALREADY_MERGED', sourceSha: sha('c'), targetBranch: 'main',
      }, 'AGENT');
      assert.deepEqual(await asCoordinator(first, 'the work reached main by hand'),
        { itemId: first, state: 'RESOLVED', resolution: 'HANDLED' });
      const second = await observationErrorItem(stack, w, 6);
      assert.deepEqual(await asOwner(second, 'nothing waits to be observed any more'),
        { itemId: second, state: 'RESOLVED', resolution: 'HANDLED' });
      const closed = await stack.db.projectOpenItem.findUniqueOrThrow({
        where: { id: second }, select: { resolvedBy: true, resolvedByUserId: true },
      });
      assert.deepEqual(closed, { resolvedBy: 'USER', resolvedByUserId: w.ownerId });
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (9) A-Q23: the in-flight reads leave observations out ═══════════════════════════════════════

test('(9) §10.6 A-Q23: with only a queued OBSERVE_LANDING, inFlightJobs is empty and the project list counts nothing in flight; a LAND_TASK beside it is listed; the line\'s own queue holds both',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'observe-not-a-landing', { line: 'PROJECT_BRANCH' });
      const asked = await observeAsOwner(stack, w, { reason: 'look at the line' });
      assert.equal(asked.queued, true, 'CONTROL: an observation is queued');
      const view = async () => readProjectIntegrationView(stack.prisma, w.projectId,
        projectIntegrationView(await readProjectCodebase(stack.prisma, w.projectId), 7200));
      const listed = async () => (await readProjectListBindings(stack.prisma, [w.projectId])).get(w.projectId)?.integration;

      // GET /projects/:id/integration and project_get: no landing is in flight.
      const alone = await view();
      assert.deepEqual(alone.inFlightJobs, [], 'a queued observation is listed as a landing in flight');
      assert.equal(alone.inFlight, null);
      assert.equal(alone.queuedCount, 0);
      // The project list and the session list's project row: nothing in flight, nothing to describe.
      const row = await listed();
      assert.ok(row, 'CONTROL: the project list reads the line');
      assert.equal(row.activeJobCount, 0, 'the project list counts the observation as a job in flight');
      assert.equal(row.inFlight, undefined);
      // The line's own queue (project_integration_get, the timeouts, the doors) still holds it.
      assert.deepEqual((await readInFlightJobs(stack.prisma, w.projectId)).map((job) => job.kind), ['OBSERVE_LANDING']);

      // A LAND_TASK beside it is listed and counted as before.
      const t = await doneTask(stack, w, 'lands-on-the-branch', sha('d'));
      const landingJobId = randomUUID();
      const branchRef = `refs/heads/project/${w.projectId.slice(0, 8)}`;
      await stack.db.projectIntegrationJob.create({
        data: {
          id: landingJobId, projectId: w.projectId, ownerId: w.ownerId,
          codebaseId: (await readProjectCodebase(stack.prisma, w.projectId))!.id,
          kind: 'LAND_TASK', generation: 1, taskId: t.taskId, sessionId: t.sessionId, state: 'QUEUED',
          serialKey: `${w.projectId}:${branchRef}`, idempotencyKey: `ij:v1:LAND_TASK:${t.taskId}:1`,
          targetRef: branchRef, upstreamRef: 'refs/heads/main', sourceRef: `refs/heads/${t.branch}`,
        },
      });
      const beside = await view();
      assert.deepEqual((beside.inFlightJobs ?? []).map((job) => [job.jobId, job.kind]), [[landingJobId, 'LAND_TASK']]);
      assert.equal(beside.inFlight?.kind, 'LAND_TASK');
      assert.equal(beside.queuedCount, 1);
      const rowBeside = await listed();
      assert.equal(rowBeside?.activeJobCount, 1);
      assert.equal(rowBeside?.inFlight?.kind, 'LAND_TASK');
      assert.deepEqual((await readInFlightJobs(stack.prisma, w.projectId)).map((job) => job.kind).sort(),
        ['LAND_TASK', 'OBSERVE_LANDING']);
    } finally {
      await stack.db.$disconnect();
    }
  });
