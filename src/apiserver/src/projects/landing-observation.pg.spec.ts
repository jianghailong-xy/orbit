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
import {
  RunEventType,
  RunStatus as SharedRunStatus,
  type IntegrationJobCommand as SharedIntegrationJobCommand,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  applyIntegrationJobResult,
  dispatchIntegrationJobs,
  IntegrationJobRefused,
  receiveIntegrationJobProgress,
  releaseIntegrationJob,
} from '../runner-api/integration-job-relay';
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
import { canonicalRepoUrl, configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { readTaskIntegrationViews } from './project-task-integration';
import * as integrationJob from './project-integration-job';

/**
 * The landing observation, server side (`docs/project-integration-line-contract.md` §10.6, §10.9):
 * the queue, the triggers, the claim and the result of OBSERVE_LANDING.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-observation.pg.spec.ts
 *
 *  (1) §10.9 1, O-T1 O-J2 O-R1: an AGENT_PUSH task pushed straight to main, its task branch never
 *      published — its DONE queues the observation, the claim hands it the frozen identity, the
 *      OBSERVED result writes one ALREADY_MERGED receipt, and in the started project J9 releases the
 *      dependent and J10 starts it by itself, with no item opened; the task reads AWAITING_OBSERVATION with its delivered sha, then ON_UPSTREAM; a replay and
 *      a second observation of the same task leave one receipt;
 *  (2) J-T9, the late answer: a silent observation is ended ERROR · RUNNER_LOST by the next trigger,
 *      the one queued behind it is claimed and answers, and the silent claim's answer is refused —
 *      still one receipt;
 *  (3) §10.9 3, O-R2: an empty branch whose task no session reported work for gets a receipt; one
 *      whose session did gets LANDING_UNOBSERVED (WORK_ELSEWHERE); work in another repository is not
 *      observed at all;
 *  (4) O-R4: work not seen in an AGENT_PUSH project opens LANDING_UNOBSERVED once per delivered
 *      commit, APPLIED_AS_OTHER_COMMITS when every change is already there; a PLATFORM project
 *      writes nothing;
 *  (5) O-T2, O-T3, O-T4: a work session's turn, a receipt and the owner choosing AGENT_PUSH each queue
 *      an observation of a project with a task waiting — and none of a project with none — while a
 *      PLATFORM DONE (O-T1 is AGENT_PUSH's) queues none;
 *  (6) the fold: triggers fold into the one queued observation, a trigger after its claim queues the
 *      next generation, and a claim handed back while one is queued is SUPERSEDED;
 *  (7) the claim: only a runner that declares integration-observe/v1 is handed one; the source
 *      session's runner first while it would take it; RUNNER_LOCAL only to the authority;
 *  (8) O-J4: an ERROR is queued again, the third in a row opens IE:observe:<projectId> for the
 *      coordinator and queues nothing more, and the next OBSERVED resolves it JOB_MOVED_ON;
 *  (9) O-R3: LANDED_WITHOUT_CONFIRMATION opens for an observed receipt, an agent's merge_receipt and
 *      a Merge pressed from a session in a PLATFORM project on a MAIN line — and not for the owner's
 *      own receipt or Merge, a Merge that names no presser, a second receipt of work already on main,
 *      a confirmed promotion's (M9) receipt, a project branch, or AGENT_PUSH;
 * (10) the kind decides: OBSERVE and OBSERVED are refused on a landing;
 * (11) the lease: a claim whose process went silent is handed to it again under the same claim
 *      (J-T3a), and taken over by another process of the same runner (J-T3), whose answer is the one
 *      taken.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

// What this spec reads that the tree before R29-5 does not have is spelled locally and loaded by name,
// so the file compiles there and every case is red for want of the behaviour rather than of a type.
interface IntegrationObservation {
  taskId: string;
  deliveredSha: string;
  baseSha: string | null;
  onUpstream: boolean;
  onIntegrationLine: boolean | null;
  empty: boolean;
  fullyApplied: boolean | null;
}
type IntegrationJobCommand = SharedIntegrationJobCommand & {
  observeTasks?: Array<{ taskId: string; deliveredSha: string; baseSha: string | null }>;
};
interface ObservationModule {
  queueLandingObservation(tx: Prisma.TransactionClient, input: {
    ownerId: string; projectId: string; trigger: string;
  }): Promise<{ jobId: string; queued: boolean } | null>;
  openLandedWithoutConfirmationIfOwed(tx: Prisma.TransactionClient, receiptId: string): Promise<string | null>;
}
const observation: ObservationModule = (() => {
  const name = './landing-observation';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(name) as ObservationModule;
  } catch {
    const missing = (): never => assert.fail('there is no landing-observation module');
    return { queueLandingObservation: missing, openLandedWithoutConfirmationIfOwed: missing };
  }
})();
const JOB = 'integration-job/v1';
const OBSERVE = 'integration-observe/v1';
const V2 = 'integration-progress/v2';
const CAPABLE = [JOB, OBSERVE, V2];
const sha = (nibble: string) => nibble.repeat(40);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
// Read through the module, so this file compiles on a tree from before the observation existed and
// is red there for want of it.
const observeCapability = (): string => {
  const value = (integrationJob as { INTEGRATION_OBSERVE_CLAIM?: string }).INTEGRATION_OBSERVE_CLAIM;
  assert.equal(value, OBSERVE, 'there is no integration-observe/v1 capability');
  return value!;
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
  tasks: TasksService;
  sessions: SessionsService;
  confirmations: TaskOwnerConfirmationService;
  receipts: MergeReceiptService;
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
    sessions,
    confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime),
    // J10's dispatcher is the real one: a released dependent is started, as the running server does.
    receipts: new MergeReceiptService(prisma, undefined, tasks),
    runnerApi,
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  repository: string;
  repoUrl: string;
}

/**
 * One owner, one runner that observes (online, beating, both capabilities), the workspace the work
 * runs in, a coordinator conversation that is live, and a project whose line has started — a MAIN
 * line or a branch of its own, in the delivery mode asked for.
 */
async function world(
  stack: Stack,
  label: string,
  options: {
    line?: 'MAIN' | 'PROJECT_BRANCH';
    deliveryMode?: 'PLATFORM' | 'AGENT_PUSH';
    runnerLocal?: boolean;
    /** The owner started the project, so a released dependent starts by itself (J10). */
    started?: boolean;
  } = {},
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
    data: { id: ownerId, email: `${label}-${ownerId}@landing-observation.invalid`, name: label, passwordHash: 'x' },
  });
  await runner(stack, ownerId, runnerId, `${label}-runner`, CAPABLE);
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl,
      workDir: `/srv/${label}`,
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
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'finished work is seen where it is',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
      ...(options.started ? { startedAt: new Date() } : {}),
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const integrationRef = (options.line ?? 'MAIN') === 'MAIN'
    ? 'refs/heads/main'
    : `refs/heads/project/${projectId.slice(0, 8)}`;
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: repository, upstreamRef: 'refs/heads/main', integrationRef,
      refAuthority: options.runnerLocal ? 'RUNNER_LOCAL' : 'REMOTE',
      authorityRunnerId: options.runnerLocal ? runnerId : null,
      remoteName: 'origin', integrationRefSource: 'EXPLICIT',
      integrationStartedAt: new Date(), deliveryMode: options.deliveryMode ?? 'PLATFORM',
    },
  });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId, repository, repoUrl };
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
  branchSha: string;
  baseSha: string;
  /** Finished this long ago; omitted, the session is live (RUNNING, no finish). */
  finishedMinutesAgo?: number;
  /** The files the runner reported the session changed; omitted, none. */
  changedFiles?: unknown[];
  /** The workspace it ran in: omitted, the world's. */
  workspaceId?: string;
}

/** A worktree session of the task's work, as the runner's reports left it. */
async function workSession(stack: Stack, w: World, taskId: string, s: WorkSession): Promise<string> {
  const id = randomUUID();
  const finished = s.finishedMinutesAgo !== undefined;
  await stack.db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: s.workspaceId ?? w.workspaceId,
      assignedRunnerId: w.runnerId, title: `work ${s.branch}`, prompt: 'work', provider: 'claude',
      status: finished ? RunStatus.SUCCEEDED : RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, isolationStatus: 'worktree',
      branch: s.branch, branchSha: s.branchSha, baseSha: s.baseSha, numTurns: 1,
      startedAt: minutesAgo(30), createdAt: minutesAgo(30), runtimeSessionId: randomUUID(),
      ...(s.changedFiles ? { changedFiles: s.changedFiles as Prisma.InputJsonValue } : {}),
      ...(finished ? { finishedAt: minutesAgo(s.finishedMinutesAgo!) } : {}),
    },
  });
  return id;
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

/** The owner's Confirm done — the OWNER_CONFIRMED door's DONE write. */
async function confirm(stack: Stack, w: World, taskId: string): Promise<void> {
  const receipt = await stack.confirmations.decide(
    w.ownerId, taskId, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM' } as never,
  );
  assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
}

function observations(stack: Stack, w: World) {
  return stack.db.projectIntegrationJob.findMany({
    where: { projectId: w.projectId, kind: 'OBSERVE_LANDING' },
    orderBy: { generation: 'asc' },
    select: {
      id: true, state: true, generation: true, idempotencyKey: true, serialKey: true, taskId: true,
      sessionId: true, promotionId: true, landingId: true, targetRef: true, sourceRef: true,
      upstreamRef: true, errorCode: true, errorDetail: true, observations: true, receiptIds: true,
      upstreamSha: true, targetShaBefore: true, runnerId: true,
    },
  });
}

/** One heartbeat of a runner process asking for integration work (J-T2). */
function dispatch(stack: Stack, runnerId: string, leaseOwner: string, capabilities = CAPABLE) {
  return dispatchIntegrationJobs(stack.prisma, { runnerId, leaseOwner, draining: false, capabilities });
}

/** The observation one beat hands out, or undefined. */
async function claimObservation(
  stack: Stack, runnerId: string, leaseOwner: string, capabilities = CAPABLE,
): Promise<IntegrationJobCommand | undefined> {
  return (await dispatch(stack, runnerId, leaseOwner, capabilities))
    .find((command) => command.kind === 'OBSERVE_LANDING') as IntegrationJobCommand | undefined;
}

/** What a runner reports for a task it looked at. */
function seen(task: { taskId: string; deliveredSha: string; baseSha: string | null }, answer: Partial<IntegrationObservation>): IntegrationObservation {
  return {
    taskId: task.taskId, deliveredSha: task.deliveredSha, baseSha: task.baseSha,
    onUpstream: false, onIntegrationLine: null, empty: false, fullyApplied: null,
    ...answer,
  };
}

/** The OBSERVED result of a claim. */
function observed(command: IntegrationJobCommand, found: IntegrationObservation[], tip = sha('9')) {
  return {
    claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, state: 'OBSERVED' as const,
    phase: 'OBSERVE' as const, upstreamSha: tip, targetShaBefore: tip, observations: found,
  };
}

function report(stack: Stack, w: World, command: IntegrationJobCommand, body: object, runnerId = w.runnerId) {
  return applyIntegrationJobResult(stack.prisma, {
    jobId: command.jobId, runnerId, ownerId: w.ownerId, body: body as never,
  });
}

function receiptsOf(stack: Stack, taskId: string) {
  return stack.db.sessionMergeReceipt.findMany({
    where: { taskId },
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

function openItems(stack: Stack, w: World, kind: string) {
  return stack.db.projectOpenItem.findMany({
    where: { projectId: w.projectId, kind },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, state: true, resolution: true, assignee: true, assigneeReason: true, dedupeKey: true,
      taskId: true, integrationJobId: true, payload: true, title: true,
    },
  });
}

/** The observation door's own enqueue (O-T5's call, R29-7's door), in a transaction of its own. */
function observeAgain(stack: Stack, w: World) {
  return stack.db.$transaction((tx) => observation.queueLandingObservation(tx, {
    ownerId: w.ownerId, projectId: w.projectId, trigger: 'OBSERVE_DOOR',
  }));
}

// ═══ (1) §10.9 1 ═══════════════════════════════════════════════════════════════════════════════

test('(1) §10.9 1, O-T1 O-J2 O-R1: a task pushed straight to main, its branch never published — the observation\'s receipt lets J9 release the dependent and J10 start it by itself; a replay and a second observation leave one receipt',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      observeCapability();
      const w = await world(stack, 'pushed', { line: 'MAIN', deliveryMode: 'AGENT_PUSH', started: true });
      const pushed = await ownerTask(stack, w, 'pushed straight to main');
      const workSessionId = await workSession(stack, w, pushed, {
        branch: 'orbit/pushed', branchSha: sha('a'), baseSha: sha('b'), finishedMinutesAgo: 2,
      });
      const dependent = await stack.tasks.create(w.ownerId, {
        title: 'waits for the pushed work', projectId: w.projectId, assigneeId: w.workspaceId,
        autoRunWhenReady: true, completionCriterion: 'OWNER_CONFIRMED', dependsOnTaskIds: [pushed],
      } as never);
      assert.deepEqual(await observations(stack, w), [], 'CONTROL: nothing is observed before the DONE');

      await confirm(stack, w, pushed);
      // O-T1: the DONE froze the identity, and queued the observation in its own transaction.
      const [queued, ...more] = await observations(stack, w);
      assert.equal(more.length, 0);
      assert.equal(queued.state, 'QUEUED');
      assert.equal(queued.generation, 1);
      assert.equal(queued.idempotencyKey, `ij:v1:OBSERVE_LANDING:${w.projectId}:1`);
      assert.equal(queued.serialKey, `${w.repository}#observe:${w.projectId}`);
      assert.deepEqual(
        [queued.taskId, queued.sessionId, queued.promotionId, queued.landingId], [null, null, null, null],
        '§10.4: an observation names no task, session, promotion or landing',
      );
      assert.deepEqual([queued.targetRef, queued.sourceRef, queued.upstreamRef],
        ['refs/heads/main', 'refs/heads/main', 'refs/heads/main']);
      const enqueued = await stack.db.projectIntegrationJobEvent.findFirst({
        where: { jobId: queued.id, kind: 'ENQUEUED' }, select: { data: true, text: true },
      });
      assert.equal((enqueued?.data as { trigger?: string }).trigger, 'IDENTITY_FROZEN');
      assert.equal(enqueued?.text, 'Queued to look for finished work on main');

      // §10.9's read model: waiting to be seen, on the commit it names.
      const waiting = (await readTaskIntegrationViews(stack.prisma, w.ownerId, w.projectId, [pushed])).get(pushed)!;
      assert.equal(waiting.state as string, 'AWAITING_OBSERVATION');
      assert.equal((waiting as { deliveredSha?: string | null }).deliveredSha, sha('a'));
      // J9: the dependent cannot start while the work is not known to be on main.
      await assert.rejects(stack.tasks.execute(w.ownerId, dependent.id), /not landed|not on main/i);

      // O-J2: the claim hands the observing runner the frozen identity.
      const command = await claimObservation(stack, w.runnerId, 'observer-1');
      assert.ok(command, 'the observing runner is handed the observation');
      assert.equal(command.jobId, queued.id);
      assert.deepEqual(command.observeTasks, [{ taskId: pushed, deliveredSha: sha('a'), baseSha: sha('b') }]);
      assert.equal(command.workDir, '/srv/pushed');
      assert.deepEqual(command.checks, []);
      assert.equal(command.reportBeforePush, true, 'a v2 claim reports as every v2 claim does');
      assert.equal(command.refAuthority, 'REMOTE');
      // J-T4: its OBSERVE step is accepted.
      const step = await receiveIntegrationJobProgress(stack.prisma, w.runnerId, command.jobId, {
        claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, phase: 'OBSERVE', round: 1,
      });
      assert.equal(step.accepted, true);

      const found = [seen({ taskId: pushed, deliveredSha: sha('a'), baseSha: sha('b') }, { onUpstream: true })];
      const applied = await report(stack, w, command, observed(command, found, sha('c')));
      assert.equal(applied.answer.accepted, true);
      assert.equal(applied.answer.state, 'OBSERVED');
      assert.equal(applied.answer.receiptIds.length, 1);
      const after = applied.after as { projectId: string; landedTaskIds?: string[] } | null;
      assert.deepEqual(after?.landedTaskIds, [pushed]);

      // O-R1's receipt, through MergeReceiptService.
      const [receipt, ...extra] = await receiptsOf(stack, pushed);
      assert.equal(extra.length, 0);
      assert.equal(receipt.result, 'ALREADY_MERGED');
      assert.equal(receipt.targetBranch, 'main');
      assert.equal(receipt.sourceBranch, 'orbit/pushed');
      assert.equal(receipt.sourceSha, sha('a'));
      assert.equal(receipt.targetShaBefore, sha('c'));
      assert.equal(receipt.targetShaAfter, null);
      assert.equal(receipt.recordedBy, 'RUNNER');
      assert.equal(receipt.sessionId, workSessionId);
      assert.deepEqual(receipt.detail, { integrationJobId: queued.id, observed: true });
      const [done] = await observations(stack, w);
      assert.equal(done.state, 'OBSERVED');
      assert.deepEqual(done.receiptIds, [receipt.id]);
      assert.equal(done.upstreamSha, sha('c'));
      assert.deepEqual(done.observations, found);
      assert.equal(await landingOf(stack, pushed), 'ON_UPSTREAM');
      assert.equal(
        (await readTaskIntegrationViews(stack.prisma, w.ownerId, w.projectId, [pushed])).get(pushed)!.state,
        'ON_UPSTREAM',
      );
      // AGENT_PUSH is the owner's standing authorization (O-L2): nothing is put in front of them.
      assert.deepEqual(await openItems(stack, w, 'LANDED_WITHOUT_CONFIRMATION'), []);

      // J10, after the commit: the landing's dependents are dispatched through the real dispatcher, and
      // in a project that moves by itself the dependent J9 now lets through starts on its own.
      const dispatched: string[] = [];
      const j10 = new MergeReceiptService(stack.prisma, undefined, {
        dispatchDependentsOf: (ownerId: string, doneTaskId: string) => {
          dispatched.push(doneTaskId);
          return stack.tasks.dispatchDependentsOf(ownerId, doneTaskId);
        },
      });
      await (j10.deliverProjectFactsAfterCommit as (...args: unknown[]) => Promise<void>)
        .call(j10, after!.projectId, after!.landedTaskIds, { observed: true });
      assert.deepEqual(dispatched, [pushed], 'J10 dispatched what the receipt released');
      assert.equal(await stack.db.session.count({ where: { taskId: dependent.id } }), 1,
        'J10 started the dependent by itself: nobody recorded a receipt, retried or answered an item');
      assert.deepEqual(await stack.db.projectOpenItem.findMany({ where: { projectId: w.projectId } }), [],
        'no item was opened on the way');
      assert.deepEqual((await observations(stack, w)).map((job) => job.state), ['OBSERVED'],
        'O-T3: the observation\'s own receipts queue no second look');

      // A replayed result finds the job written down.
      const replay = await report(stack, w, command, observed(command, found, sha('c')));
      assert.equal(replay.answer.accepted, false);
      assert.equal(replay.answer.state, 'OBSERVED');
      // A second observation of the same task, arriving after the first: no task waits, and an answer
      // about the landed task writes nothing.
      const second = await observeAgain(stack, w);
      assert.equal(second?.queued, true);
      const again = await claimObservation(stack, w.runnerId, 'observer-2');
      assert.ok(again);
      assert.deepEqual(again.observeTasks, [], 'the landed task is not waiting any more');
      const late = await report(stack, w, again, observed(again, found));
      assert.equal(late.answer.accepted, true);
      assert.deepEqual(late.answer.receiptIds, []);
      assert.equal((await receiptsOf(stack, pushed)).length, 1, 'one receipt however often it is seen');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (2) J-T9 and the late answer ════════════════════════════════════════════════════════════

test('(2) J-T9: a silent observation is ended ERROR · RUNNER_LOST by the next trigger, the next one answers, and the silent claim\'s late answer is refused — one receipt',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'silent', { line: 'MAIN', deliveryMode: 'AGENT_PUSH' });
      const { taskId } = await finishedTask(stack, w, 'seen late', {
        branch: 'orbit/seen-late', branchSha: sha('d'), baseSha: sha('e'),
      });
      const first = await claimObservation(stack, w.runnerId, 'observer-gone');
      assert.ok(first);
      // The runner went quiet: no report for longer than the lease.
      await stack.db.$executeRaw(Prisma.sql`
        UPDATE "project_integration_job"
           SET "heartbeat_at" = now() - interval '11 minutes', "claimed_at" = now() - interval '11 minutes'
         WHERE "id" = ${first.jobId}::uuid`);

      const next = await observeAgain(stack, w);
      const [ended, queued] = await observations(stack, w);
      assert.equal(ended.id, first.jobId);
      assert.equal(ended.state, 'ERROR');
      assert.equal(ended.errorCode, 'RUNNER_LOST', 'an observation never pushes (J12)');
      assert.equal((ended.errorDetail as { pushOutcome?: string }).pushOutcome, 'NOT_PUSHED');
      assert.equal(queued.state, 'QUEUED');
      assert.equal(queued.generation, 2);
      assert.equal(next?.jobId, queued.id);
      assert.ok(await stack.db.projectIntegrationJobEvent.findFirst({ where: { jobId: first.jobId, kind: 'TIMED_OUT' } }));
      assert.deepEqual(await stack.db.projectOpenItem.findMany({ where: { projectId: w.projectId } }), [],
        'O-J4: no integration item for one failure, and X-E5 opens none for an observation');

      const second = await claimObservation(stack, w.runnerId, 'observer-new');
      assert.ok(second);
      assert.deepEqual(second.observeTasks?.map((task) => task.taskId), [taskId]);
      const found = [seen({ taskId, deliveredSha: sha('d'), baseSha: sha('e') }, { onUpstream: true })];
      // J-T4's fence: the silent claim's answer, arriving now, is not taken.
      const refused = await report(stack, w, first, observed(first, found));
      assert.equal(refused.answer.accepted, false);
      assert.equal(refused.answer.state, 'ERROR');
      assert.deepEqual(await receiptsOf(stack, taskId), []);
      const taken = await report(stack, w, second, observed(second, found));
      assert.equal(taken.answer.accepted, true);
      assert.equal((await receiptsOf(stack, taskId)).length, 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (3) §10.9 3: the empty branch ═══════════════════════════════════════════════════════════

test('(3) §10.9 3, O-R2: an empty branch with no work reported gets a receipt; one whose session reported work gets WORK_ELSEWHERE; work in another repository is not observed',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'empty', { line: 'MAIN', deliveryMode: 'AGENT_PUSH' });
      const nothing = await finishedTask(stack, w, 'nothing of its own', {
        branch: 'orbit/nothing', branchSha: sha('1'), baseSha: sha('1'),
      });
      const elsewhere = await finishedTask(stack, w, 'work done elsewhere', {
        branch: 'orbit/elsewhere', branchSha: sha('2'), baseSha: sha('2'),
        changedFiles: [{ path: 'src/elsewhere.ts', status: 'M' }],
      });
      const otherWorkspace = randomUUID();
      await stack.db.workspace.create({
        data: {
          id: otherWorkspace, ownerId: w.ownerId, runnerId: w.runnerId, name: 'another repository', enabled: true,
          repoUrl: 'https://git.invalid/orbit/another-repository.git', workDir: '/srv/another',
        },
      });
      const foreign = await finishedTask(stack, w, 'work in another repository', {
        branch: 'orbit/foreign', branchSha: sha('3'), baseSha: sha('4'), workspaceId: otherWorkspace,
      });

      const command = await claimObservation(stack, w.runnerId, 'observer');
      assert.ok(command);
      assert.deepEqual(command.observeTasks?.map((task) => task.taskId).sort(),
        [nothing.taskId, elsewhere.taskId].sort(), 'O-L7: work in another repository is not this line\'s');
      assert.ok(!command.observeTasks?.some((task) => task.taskId === foreign.taskId));
      const applied = await report(stack, w, command, observed(command, [
        seen({ taskId: nothing.taskId, deliveredSha: sha('1'), baseSha: sha('1') }, { empty: true, onUpstream: true, fullyApplied: false }),
        seen({ taskId: elsewhere.taskId, deliveredSha: sha('2'), baseSha: sha('2') }, { empty: true, onUpstream: true, fullyApplied: false }),
      ]));
      assert.equal(applied.answer.accepted, true);

      const [receipt, ...extra] = await receiptsOf(stack, nothing.taskId);
      assert.equal(extra.length, 0);
      assert.equal(receipt.result, 'ALREADY_MERGED');
      assert.equal(receipt.targetBranch, 'main');
      assert.equal(receipt.sourceSha, sha('1'));
      assert.deepEqual(receipt.detail, { integrationJobId: command.jobId, observed: true, empty: true });
      assert.equal(await landingOf(stack, nothing.taskId), 'ON_UPSTREAM', 'J8: nothing to land releases J9');

      assert.deepEqual(await receiptsOf(stack, elsewhere.taskId), [], 'a session reported work: no receipt');
      const [unobserved, ...more] = await openItems(stack, w, 'LANDING_UNOBSERVED');
      assert.equal(more.length, 0);
      assert.equal(unobserved.taskId, elsewhere.taskId);
      assert.equal(unobserved.state, 'OPEN');
      assert.equal(unobserved.dedupeKey, `LU:${elsewhere.taskId}:${sha('2')}`);
      assert.equal((unobserved.payload as { reason?: string }).reason, 'WORK_ELSEWHERE');
      assert.deepEqual(applied.after?.openItemIds, [unobserved.id], 'the item is delivered to its holder');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (4) O-R4 ════════════════════════════════════════════════════════════════════════════════

test('(4) O-R4: work not seen in an AGENT_PUSH project opens LANDING_UNOBSERVED once per commit, APPLIED_AS_OTHER_COMMITS when every change is there; PLATFORM writes nothing',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'unseen', { line: 'MAIN', deliveryMode: 'AGENT_PUSH' });
      const missing = await finishedTask(stack, w, 'not pushed', { branch: 'orbit/missing', branchSha: sha('5'), baseSha: sha('6') });
      const rebased = await finishedTask(stack, w, 'pushed as other commits', { branch: 'orbit/rebased', branchSha: sha('7'), baseSha: sha('6') });
      for (const leaseOwner of ['observer-1', 'observer-2']) {
        if (leaseOwner === 'observer-2') await observeAgain(stack, w);
        const command = await claimObservation(stack, w.runnerId, leaseOwner);
        assert.ok(command);
        await report(stack, w, command, observed(command, [
          seen({ taskId: missing.taskId, deliveredSha: sha('5'), baseSha: sha('6') }, { fullyApplied: false }),
          seen({ taskId: rebased.taskId, deliveredSha: sha('7'), baseSha: sha('6') }, { fullyApplied: true }),
        ]));
      }
      const items = await openItems(stack, w, 'LANDING_UNOBSERVED');
      assert.deepEqual(items.map((item) => [item.taskId, (item.payload as { reason?: string }).reason, item.state]).sort(),
        [[missing.taskId, 'NOT_ON_LINE', 'OPEN'], [rebased.taskId, 'APPLIED_AS_OTHER_COMMITS', 'OPEN']].sort(),
        'one item per delivered commit, however often it is not seen');
      assert.equal(items.find((item) => item.taskId === missing.taskId)?.assignee, 'COORDINATOR');

      const p = await world(stack, 'unseen-platform', { line: 'MAIN', deliveryMode: 'PLATFORM' });
      const waiting = await finishedTask(stack, p, 'waits for its own pipeline', { branch: 'orbit/waits', branchSha: sha('8'), baseSha: sha('6') });
      await observeAgain(stack, p);
      const command = await claimObservation(stack, p.runnerId, 'platform-observer');
      assert.ok(command);
      assert.deepEqual(command.observeTasks?.map((task) => task.taskId), [waiting.taskId],
        '§10.6: a PLATFORM project is observed too');
      await report(stack, p, command, observed(command, [
        seen({ taskId: waiting.taskId, deliveredSha: sha('8'), baseSha: sha('6') }, { fullyApplied: false }),
      ]));
      assert.deepEqual(await openItems(stack, p, 'LANDING_UNOBSERVED'), []);
      assert.deepEqual(await receiptsOf(stack, waiting.taskId), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (5) O-T2, O-T3, O-T4 ═══════════════════════════════════════════════════════════════════

/** A work session's turn, through the runner's own doors: the lease, the turn, its events, its end. */
async function completeTurn(stack: Stack, w: World, sessionId: string): Promise<void> {
  const api = stack.runnerApi;
  const turn = await stack.db.conversationTurn.create({
    data: { sessionId, seq: 1, clientTurnId: `turn-${randomUUID()}`, kind: 'message', content: 'push it', status: 'PENDING' },
    select: { id: true },
  });
  const runnerRef = { id: w.runnerId };
  const leaseOwner = randomUUID();
  const generation = randomUUID();
  await api.takeoverLeases(runnerRef, sessionId, { leaseOwner, expectedLeaseOwner: null } as never);
  await api.activateLeases(runnerRef, sessionId, { leaseGeneration: generation, leaseOwner } as never);
  const handed = await (api as unknown as {
    dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<{ turnId?: string } | null>;
  }).dequeueTurn.call(api, sessionId, w.runnerId, generation);
  assert.equal(handed?.turnId, turn.id, 'CONTROL: the turn was handed to the runner');
  await api.events(runnerRef, sessionId, {
    leaseOwner,
    events: [
      { seq: 1, type: RunEventType.USER, ts: new Date().toISOString(), turnId: turn.id, payload: { text: 'push it' } },
      { seq: 2, type: RunEventType.TURN_END, ts: new Date().toISOString(), turnId: turn.id, payload: { subtype: 'success', numTurns: 1 } },
    ],
  } as never);
  await api.turnComplete(runnerRef, sessionId, {
    turnId: turn.id, leaseOwner, status: SharedRunStatus.SUCCEEDED, result: 'pushed', subtype: 'success',
    numTurns: 1, costUsd: 0,
  } as never);
}

test('(5) O-T2, O-T3, O-T4 each queue an observation of a project with a task waiting, and none of a project with none; a PLATFORM DONE queues none',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      // O-T1 is AGENT_PUSH's: a PLATFORM DONE has its own route.
      const turned = await world(stack, 'turn', { line: 'MAIN', deliveryMode: 'PLATFORM' });
      const waiting = await finishedTask(stack, turned, 'waiting', { branch: 'orbit/waiting', branchSha: sha('a'), baseSha: sha('b') });
      assert.deepEqual(await observations(stack, turned), [], 'a PLATFORM DONE queues no observation');
      // O-T2: another task's work session finishes a turn — its agent may just have pushed.
      const working = await ownerTask(stack, turned, 'still working');
      const live = await workSession(stack, turned, working, { branch: 'orbit/working', branchSha: sha('c'), baseSha: sha('b') });
      await completeTurn(stack, turned, live);
      const [afterTurn] = await observations(stack, turned);
      assert.equal(afterTurn?.state, 'QUEUED', 'O-T2 queued the observation');
      const turnEvent = await stack.db.projectIntegrationJobEvent.findFirst({ where: { jobId: afterTurn.id, kind: 'ENQUEUED' } });
      assert.equal((turnEvent?.data as { trigger?: string }).trigger, 'TURN_COMPLETE');
      void waiting;

      // ...and none where nothing waits.
      const quiet = await world(stack, 'quiet', { line: 'MAIN', deliveryMode: 'PLATFORM' });
      const quietTask = await ownerTask(stack, quiet, 'quiet work');
      const quietSession = await workSession(stack, quiet, quietTask, { branch: 'orbit/quiet', branchSha: sha('d'), baseSha: sha('b') });
      await completeTurn(stack, quiet, quietSession);
      assert.deepEqual(await observations(stack, quiet), [], 'O-T2: nothing waits, nothing is looked at');

      // O-T3: a receipt committed — the line may have moved.
      const receipted = await world(stack, 'receipt', { line: 'MAIN', deliveryMode: 'PLATFORM' });
      await finishedTask(stack, receipted, 'waiting too', { branch: 'orbit/waiting-too', branchSha: sha('e'), baseSha: sha('b') });
      const other = await finishedTask(stack, receipted, 'merged by hand elsewhere', {
        branch: 'orbit/elsewhere', branchSha: sha('f'), baseSha: sha('b'),
      });
      assert.deepEqual(await observations(stack, receipted), []);
      await stack.receipts.record(receipted.ownerId, other.sessionId, {
        result: 'MERGED', sourceSha: sha('f'), targetBranch: 'release/1', targetShaAfter: sha('0'),
      }, 'AGENT');
      const [afterReceipt] = await observations(stack, receipted);
      assert.equal(afterReceipt?.state, 'QUEUED', 'O-T3 queued the observation');
      const receiptEvent = await stack.db.projectIntegrationJobEvent.findFirst({ where: { jobId: afterReceipt.id, kind: 'ENQUEUED' } });
      assert.equal((receiptEvent?.data as { trigger?: string }).trigger, 'RECEIPT');

      // O-T4: the owner turns the project to AGENT_PUSH.
      const switched = await world(stack, 'switched', { line: 'MAIN', deliveryMode: 'PLATFORM' });
      await finishedTask(stack, switched, 'pushed before the switch', { branch: 'orbit/before', branchSha: sha('1'), baseSha: sha('b') });
      assert.deepEqual(await observations(stack, switched), []);
      await stack.db.$transaction((tx) => configureProjectIntegration(tx, {
        ownerId: switched.ownerId, projectId: switched.projectId, settings: { deliveryMode: 'AGENT_PUSH' },
      }));
      const [afterSwitch] = await observations(stack, switched);
      assert.equal(afterSwitch?.state, 'QUEUED', 'O-T4 queued the observation in the write that chose AGENT_PUSH');
      const switchEvent = await stack.db.projectIntegrationJobEvent.findFirst({ where: { jobId: afterSwitch.id, kind: 'ENQUEUED' } });
      assert.equal((switchEvent?.data as { trigger?: string }).trigger, 'DELIVERY_MODE');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (6) the fold ═══════════════════════════════════════════════════════════════════════════

test('(6) triggers fold into the one queued observation; one after its claim queues the next generation; a claim handed back while one is queued is SUPERSEDED',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'fold', { line: 'MAIN', deliveryMode: 'AGENT_PUSH' });
      await finishedTask(stack, w, 'one', { branch: 'orbit/one', branchSha: sha('a'), baseSha: sha('b') });
      await finishedTask(stack, w, 'two', { branch: 'orbit/two', branchSha: sha('c'), baseSha: sha('b') });
      const [first, ...none] = await observations(stack, w);
      assert.equal(none.length, 0, 'the second DONE folded into the first observation');
      const folded = await observeAgain(stack, w);
      assert.deepEqual(folded, { jobId: first.id, queued: false });

      const command = await claimObservation(stack, w.runnerId, 'observer');
      assert.equal(command?.jobId, first.id);
      assert.equal(command?.observeTasks?.length, 2, 'both DONE tasks are looked for by the one observation');
      const behind = await observeAgain(stack, w);
      assert.equal(behind?.queued, true);
      const afterClaim = await observations(stack, w);
      assert.deepEqual(afterClaim.map((job) => [job.generation, job.state]), [[1, 'RUNNING'], [2, 'QUEUED']]);
      assert.deepEqual(await observeAgain(stack, w), { jobId: behind!.jobId, queued: false });

      // J-T11 while the next one is queued: the one handed back does not become a second queued one.
      const released = await releaseIntegrationJob(stack.prisma, {
        jobId: first.id, runnerId: w.runnerId, ownerId: w.ownerId,
        body: { claimGeneration: command!.claimGeneration, leaseOwner: command!.leaseOwner },
      });
      assert.deepEqual(released as object, { released: true, state: 'SUPERSEDED' });
      assert.deepEqual((await observations(stack, w)).map((job) => [job.generation, job.state]),
        [[1, 'SUPERSEDED'], [2, 'QUEUED']]);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (7) the claim ══════════════════════════════════════════════════════════════════════════

test('(7) only a runner that declares integration-observe/v1 is handed an observation; the source runner first while it would take it; RUNNER_LOCAL only to the authority',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'claim', { line: 'MAIN', deliveryMode: 'AGENT_PUSH' });
      await finishedTask(stack, w, 'seen by whom', { branch: 'orbit/whom', branchSha: sha('a'), baseSha: sha('b') });
      // A runner that takes integration jobs but does not observe is handed none, and the job waits.
      assert.equal(await claimObservation(stack, w.runnerId, 'old-runner', [JOB, V2]), undefined);
      assert.equal((await observations(stack, w))[0].state, 'QUEUED');

      // A second runner of the owner's with a checkout of the same repository, spelled another way.
      const second = randomUUID();
      await runner(stack, w.ownerId, second, 'claim-second', CAPABLE);
      await stack.db.workspace.create({
        data: {
          id: randomUUID(), ownerId: w.ownerId, runnerId: second, name: 'second checkout', enabled: true,
          repoUrl: w.repoUrl.replace(/\.git$/, '/'), workDir: '/srv/second',
        },
      });
      assert.equal(await claimObservation(stack, second, 'second-runner'), undefined,
        'the source runner would take it now, and only it holds the delivered commits');
      // The source runner stops observing (an older process): any runner that can reach the repository.
      await stack.db.runner.update({ where: { id: w.runnerId }, data: { capabilities: [JOB, V2] } });
      const command = await claimObservation(stack, second, 'second-runner');
      assert.ok(command, 'the second runner is handed it');
      assert.equal(command.workDir, '/srv/second');

      // RUNNER_LOCAL: the authority runner alone, whoever else could reach the repository.
      const local = await world(stack, 'local', { line: 'MAIN', deliveryMode: 'AGENT_PUSH', runnerLocal: true });
      await finishedTask(stack, local, 'local work', { branch: 'orbit/local', branchSha: sha('c'), baseSha: sha('b') });
      const outsider = randomUUID();
      await runner(stack, local.ownerId, outsider, 'local-outsider', CAPABLE);
      await stack.db.workspace.create({
        data: {
          id: randomUUID(), ownerId: local.ownerId, runnerId: outsider, name: 'outsider checkout', enabled: true,
          repoUrl: local.repoUrl, workDir: '/srv/outsider',
        },
      });
      await stack.db.runner.update({ where: { id: local.runnerId }, data: { status: RunnerStatus.OFFLINE } });
      assert.equal(await claimObservation(stack, outsider, 'outsider'), undefined, 'not the authority');
      assert.ok(await claimObservation(stack, local.runnerId, 'authority'), 'the authority runner is handed it');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (8) O-J4 ═══════════════════════════════════════════════════════════════════════════════

test('(8) O-J4: an ERROR is queued again; the third in a row opens IE:observe:<projectId> for the coordinator and queues nothing; the next OBSERVED resolves it JOB_MOVED_ON',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'failing', { line: 'MAIN', deliveryMode: 'AGENT_PUSH' });
      const { taskId } = await finishedTask(stack, w, 'behind a fetch that fails', {
        branch: 'orbit/fails', branchSha: sha('a'), baseSha: sha('b'),
      });
      let item: string | null = null;
      for (const attempt of [1, 2, 3]) {
        const command = await claimObservation(stack, w.runnerId, `observer-${attempt}`);
        assert.ok(command, `attempt ${attempt} was handed out`);
        const failed = await report(stack, w, command, {
          claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, state: 'ERROR', phase: 'FETCH',
          errorCode: 'FETCH_FAILED', errorDetail: { ref: 'refs/heads/main', detail: 'could not read from remote' },
        });
        assert.equal(failed.answer.accepted, true);
        const jobs = await observations(stack, w);
        const integration = await stack.db.projectOpenItem.findMany({
          where: { projectId: w.projectId, kind: { startsWith: 'INTEGRATION_' } },
        });
        if (attempt < 3) {
          assert.deepEqual(jobs.map((job) => job.state), [...Array(attempt).fill('ERROR'), 'QUEUED'],
            `attempt ${attempt}: queued again while the task waits`);
          assert.deepEqual(integration, [], `attempt ${attempt}: no integration item`);
          assert.equal(failed.answer.openItemId, null);
        } else {
          assert.deepEqual(jobs.map((job) => job.state), ['ERROR', 'ERROR', 'ERROR'], 'the third failure queues nothing');
          assert.equal(integration.length, 1);
          const [opened] = await openItems(stack, w, 'INTEGRATION_ERROR');
          assert.equal(opened.dedupeKey, `IE:observe:${w.projectId}`);
          assert.equal(opened.assignee, 'COORDINATOR');
          assert.equal(opened.taskId, null);
          assert.equal(opened.integrationJobId, command.jobId);
          assert.equal(opened.title, 'Integration error: looking for finished work on main');
          assert.equal((opened.payload as { jobKind?: string }).jobKind, 'OBSERVE_LANDING');
          assert.equal(failed.answer.openItemId, opened.id);
          item = opened.id;
        }
      }
      // O-T5's enqueue, and an observation that answers.
      await observeAgain(stack, w);
      const command = await claimObservation(stack, w.runnerId, 'observer-4');
      assert.ok(command);
      await report(stack, w, command, observed(command, [
        seen({ taskId, deliveredSha: sha('a'), baseSha: sha('b') }, { onUpstream: true }),
      ]));
      const resolved = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item! }, select: { state: true, resolution: true } });
      assert.deepEqual(resolved, { state: 'RESOLVED', resolution: 'JOB_MOVED_ON' });
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (9) O-R3 ═══════════════════════════════════════════════════════════════════════════════

test('(9) O-R3: work that reached a PLATFORM project\'s main without the owner\'s confirmation is put in front of the owner — and only that',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'unconfirmed', { line: 'MAIN', deliveryMode: 'PLATFORM' });
      const lines = async () => (await openItems(stack, w, 'LANDED_WITHOUT_CONFIRMATION'))
        .map((item) => ({ taskId: item.taskId, assignee: item.assignee, reason: item.assigneeReason, key: item.dedupeKey, payload: item.payload }));

      // An observation sees a task on main that its candidate was still checking.
      const pushed = await finishedTask(stack, w, 'pushed past the card', { branch: 'orbit/past', branchSha: sha('a'), baseSha: sha('b') });
      await observeAgain(stack, w);
      const command = await claimObservation(stack, w.runnerId, 'observer');
      assert.ok(command);
      await report(stack, w, command, observed(command, [
        seen({ taskId: pushed.taskId, deliveredSha: sha('a'), baseSha: sha('b') }, { onUpstream: true }),
      ]));
      const [observedReceipt] = await receiptsOf(stack, pushed.taskId);
      assert.deepEqual(await lines(), [{
        taskId: pushed.taskId, assignee: 'OWNER', reason: 'DEFAULT', key: `UL:${pushed.taskId}:${observedReceipt.id}`,
        payload: { receiptId: observedReceipt.id, recordedBy: 'RUNNER', targetBranch: 'main', sourceSha: sha('a'), observed: true },
      }]);
      const candidate = await stack.db.projectPromotion.findFirst({ where: { taskId: pushed.taskId }, select: { state: true } });
      assert.equal(candidate?.state, 'SUPERSEDED', 'M-T13 retired the candidate in the same transaction');

      // An agent's merge_receipt onto main opens one; the owner's own does not.
      const byAgent = await finishedTask(stack, w, 'fast-forwarded by an agent', { branch: 'orbit/agent', branchSha: sha('c'), baseSha: sha('b') });
      await stack.receipts.record(w.ownerId, byAgent.sessionId, {
        result: 'ALREADY_MERGED', sourceSha: sha('c'), targetBranch: 'main',
      }, 'AGENT');
      const byOwner = await finishedTask(stack, w, 'fast-forwarded by the owner', { branch: 'orbit/owner', branchSha: sha('d'), baseSha: sha('b') });
      await stack.receipts.record(w.ownerId, byOwner.sessionId, {
        result: 'ALREADY_MERGED', sourceSha: sha('d'), targetBranch: 'main',
      }, 'USER');
      // A second receipt of work already on main is not that event again.
      await stack.receipts.record(w.ownerId, byAgent.sessionId, {
        result: 'MERGED', sourceSha: sha('e'), targetBranch: 'main', targetShaAfter: sha('f'),
      }, 'AGENT');
      assert.deepEqual((await lines()).map((line) => line.taskId).sort(), [pushed.taskId, byAgent.taskId].sort());

      // The Merge button: pressed from a session opens one; the owner's press, and a press nobody
      // recorded (an operation queued before the door recorded it), do not.
      const merged: Record<string, string> = {};
      for (const requestedBy of ['AGENT', 'USER', null] as const) {
        const t = await finishedTask(stack, w, `merged · ${requestedBy ?? 'unrecorded'}`, {
          branch: `orbit/merged-${requestedBy ?? 'unrecorded'}`, branchSha: sha('9'), baseSha: sha('b'),
        });
        merged[requestedBy ?? 'unrecorded'] = t.taskId;
        await stack.db.$transaction((tx) => MergeReceiptService.fromRunnerMergeResult(tx, {
          ownerId: w.ownerId, sessionId: t.sessionId, taskId: t.taskId, projectId: w.projectId, result: 'MERGED',
          sourceBranch: `orbit/merged-${requestedBy ?? 'unrecorded'}`, sourceSha: sha('9'), targetBranch: 'main',
          targetShaBefore: sha('b'), targetShaAfter: sha('8'), rebaseBaseSha: sha('b'), conflicts: [], message: null,
          operationId: randomUUID(), requestedBy,
        } as never));
      }
      const owned = (await lines()).map((line) => line.taskId);
      assert.ok(owned.includes(merged.AGENT), 'a Merge pressed from a session');
      assert.ok(!owned.includes(merged.USER), 'the owner\'s own Merge');
      assert.ok(!owned.includes(merged.unrecorded), 'a Merge whose presser was not recorded');
      const [agentMerge] = await receiptsOf(stack, merged.AGENT);
      assert.equal((agentMerge.detail as { requestedBy?: string }).requestedBy, 'AGENT');

      // The Merge door records who pressed with the operation.
      const toMerge = await finishedTask(stack, w, 'to be merged', { branch: 'orbit/to-merge', branchSha: sha('7'), baseSha: sha('b') });
      await stack.sessions.mergeToMain(w.ownerId, toMerge.sessionId, 'main', undefined, { requestedBy: 'USER' } as never);
      const [queuedMerge] = await stack.db.$queryRaw<Array<{ mergeStatus: string; mergeRequestedBy: string | null }>>(Prisma.sql`
        SELECT "merge_status" AS "mergeStatus", "merge_requested_by" AS "mergeRequestedBy"
          FROM "session" WHERE "id" = ${toMerge.sessionId}::uuid`);
      assert.deepEqual(queuedMerge, { mergeStatus: 'pending', mergeRequestedBy: 'USER' });

      // M9: a confirmed promotion's own landing is not put in front of the owner again.
      const promoted = await finishedTask(stack, w, 'promoted', { branch: 'orbit/promoted', branchSha: sha('6'), baseSha: sha('b') });
      const m9Receipt = await stack.db.$transaction(async (tx) => {
        const codebase = await tx.projectCodebase.findFirstOrThrow({
          where: { projectId: w.projectId }, select: { id: true, canonicalRepoUrl: true, integrationRef: true, upstreamRef: true },
        });
        const candidate = await tx.projectPromotion.findFirstOrThrow({ where: { taskId: promoted.taskId }, select: { id: true } });
        const landJob = await integrationJob.queuePromotionJob(tx, {
          kind: 'LAND_PROMOTION',
          promotion: {
            id: candidate.id, projectId: w.projectId, ownerId: w.ownerId, codebaseId: codebase.id,
            sourceRef: 'refs/heads/orbit/promoted', sourceSha: sha('6'), upstreamRef: 'refs/heads/main',
            sessionId: promoted.sessionId,
          },
          canonicalRepoUrl: codebase.canonicalRepoUrl,
        });
        const [id] = await MergeReceiptService.fromIntegrationJob(tx, {
          ownerId: w.ownerId, sessionId: promoted.sessionId, taskId: promoted.taskId, projectId: w.projectId,
          jobId: landJob, state: 'LANDED', sourceBranch: 'orbit/promoted', targetBranch: 'main', sourceSha: sha('6'),
          targetShaBefore: sha('b'), landedSha: sha('5'), rebaseBaseSha: sha('b'), testedTreeSha: null,
          landedTreeSha: null, mainSyncSha: null,
        });
        return { id, opened: await observation.openLandedWithoutConfirmationIfOwed(tx, id) };
      });
      assert.equal(m9Receipt.opened, null, 'M9');

      // A project branch is not main, and AGENT_PUSH is the owner's standing authorization.
      for (const [label, options] of [
        ['unconfirmed-branch', { line: 'PROJECT_BRANCH', deliveryMode: 'PLATFORM' }],
        ['unconfirmed-push', { line: 'MAIN', deliveryMode: 'AGENT_PUSH' }],
      ] as const) {
        const other = await world(stack, label, options);
        const t = await finishedTask(stack, other, 'on main by an agent', { branch: 'orbit/agent-main', branchSha: sha('4'), baseSha: sha('b') });
        await stack.receipts.record(other.ownerId, t.sessionId, {
          result: 'ALREADY_MERGED', sourceSha: sha('4'), targetBranch: 'main',
        }, 'AGENT');
        assert.deepEqual(await openItems(stack, other, 'LANDED_WITHOUT_CONFIRMATION'), [], label);
      }
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (10) the kind decides ═════════════════════════════════════════════════════════════════

test('(10) OBSERVE and OBSERVED are an observation\'s alone: a landing that reports either is refused',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'kind', { line: 'PROJECT_BRANCH', deliveryMode: 'PLATFORM' });
      await finishedTask(stack, w, 'lands on the project branch', { branch: 'orbit/lands', branchSha: sha('a'), baseSha: sha('b') });
      const landing = (await dispatch(stack, w.runnerId, 'lander')).find((command) => command.kind === 'LAND_TASK');
      assert.ok(landing, 'CONTROL: the landing was claimed');
      await assert.rejects(
        receiveIntegrationJobProgress(stack.prisma, w.runnerId, landing.jobId, {
          claimGeneration: landing.claimGeneration, leaseOwner: landing.leaseOwner, phase: 'OBSERVE',
        }),
        (error: unknown) => error instanceof IntegrationJobRefused && error.refusal === 'INVALID_RESULT'
          && error.message === 'a LAND_TASK job has no OBSERVE step',
      );
      await assert.rejects(
        report(stack, w, landing, observed(landing, [])),
        (error: unknown) => error instanceof IntegrationJobRefused && error.refusal === 'INVALID_RESULT'
          && error.message === 'OBSERVED is not a result of a LAND_TASK job',
      );
      const job = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: landing.jobId }, select: { state: true, phase: true } });
      assert.deepEqual(job, { state: 'RUNNING', phase: 'FETCH' }, 'nothing was written');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (11) the lease ═════════════════════════════════════════════════════════════════════════

test('(11) J-T3a and J-T3: a silent observation is handed to its own process again under the same claim, and taken over by another process of the runner',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'lease', { line: 'MAIN', deliveryMode: 'AGENT_PUSH' });
      const { taskId } = await finishedTask(stack, w, 'observed twice', { branch: 'orbit/twice', branchSha: sha('a'), baseSha: sha('b') });
      const first = await claimObservation(stack, w.runnerId, 'process-1');
      assert.ok(first);
      const silence = () => stack.db.$executeRaw(Prisma.sql`
        UPDATE "project_integration_job"
           SET "heartbeat_at" = now() - interval '11 minutes', "claimed_at" = now() - interval '11 minutes'
         WHERE "id" = ${first.jobId}::uuid`);
      // The command never reached the process: its next beat, past the lease, is handed it again,
      // under the claim it was made under.
      await silence();
      const again = await claimObservation(stack, w.runnerId, 'process-1');
      assert.equal(again?.jobId, first.jobId);
      assert.equal(again?.claimGeneration, first.claimGeneration, 'J-T3a: the same claim, not a new one');
      assert.deepEqual(again?.observeTasks?.map((task) => task.taskId), [taskId]);

      // Another process of the same runner takes the silent claim over: a new claim, and the old one's
      // answer is refused by the fence.
      await silence();
      const taken = await claimObservation(stack, w.runnerId, 'process-2');
      assert.equal(taken?.jobId, first.jobId);
      assert.equal(BigInt(taken!.claimGeneration), BigInt(first.claimGeneration) + 1n);
      const found = [seen({ taskId, deliveredSha: sha('a'), baseSha: sha('b') }, { onUpstream: true })];
      await assert.rejects(report(stack, w, first, observed(first, found)),
        (error: unknown) => error instanceof IntegrationJobRefused && error.refusal === 'STALE_CLAIM');
      const answered = await report(stack, w, taken!, observed(taken!, found));
      assert.equal(answered.answer.accepted, true);
      assert.equal((await receiptsOf(stack, taskId)).length, 1);
      const takeover = await stack.db.projectIntegrationJobEvent.findFirst({
        where: { jobId: first.jobId, kind: 'TAKEN_OVER' }, select: { claimGeneration: true },
      });
      assert.equal(takeover?.claimGeneration, BigInt(taken!.claimGeneration));
    } finally {
      await stack.db.$disconnect();
    }
  });
