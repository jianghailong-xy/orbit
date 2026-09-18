import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { Client } from 'pg';

import {
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  RunEventType,
  RunStatus as SharedRunStatus,
  TaskStatus as DeclaredTaskStatus,
} from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ReaperService } from '../realtime/reaper.service';
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
  INTEGRATION_JOB_STATES,
  openItemKindForJobState,
} from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * Exception items (docs/project-integration-line-contract.md §4): a task FAILED from any door opens
 * one item with an assignee and a terminal state, and an item owed to the coordinator reaches it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-exception-todos.pg.spec.ts
 *
 * Every failure below is produced by a product door — the runner's `turnComplete` and `finalize`, the
 * reaper's own sweep, `TasksService.update` — never by writing a task row or calling the item code.
 * The items and their deliveries are read with SQL, so the same file compiles and runs against a tree
 * that has no item table at all: there, every case reads "nothing was opened" and fails on the
 * assertion rather than on a missing symbol.
 *
 * The integration sources (§4.2) are driven the same way: a code task's DONE queues its landing,
 * the runner claims it off the heartbeat and reports what happened to it, and the four terminal
 * states that file is left in — a conflict, a red check on the combined tree, an error, and a claim
 * with nowhere to run it — are walked one at a time.
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

interface Stack {
  db: PrismaClient;
  sessions: SessionsService;
  tasks: TasksService;
  api: RunnerApiController;
  reaper: ReaperService;
  /** The reaper as a component that records a failure and delivers nothing afterwards. */
  silentReaper: ReaperService;
  /** The heartbeat's half of the integration queue: what a runner claims and reports on. */
  jobs: IntegrationJobRelay;
  convergence: CoordinatorConvergenceService;
}

/** The production wiring over one client, with the real completion-input router behind task writes. */
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
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
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
  const reaper = new ReaperService(prisma, realtime, openItems);
  // A component that records a failure and never gets to deliver it: what the coordinator's own turn
  // ending has to compensate for.
  const silentReaper = new ReaperService(prisma, realtime);
  return { db, sessions, tasks, api, reaper, silentReaper, jobs, convergence };
}

type CoordinatorShape = 'PARKED' | 'RUNNING' | 'COMPLETED' | 'NONE';

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string | null;
  /** The coordinator's own turn that is running, when it was created RUNNING. */
  runningTurnId: string | null;
}

/**
 * One project and the conversation it is coordinated from, in the state a coordinator really is in.
 *
 *   * `PARKED`    — a live conversation between turns (`AWAITING_INPUT`);
 *   * `RUNNING`   — one turn in flight on its runner;
 *   * `COMPLETED` — filed as Completed by its owner: still `AWAITING_INPUT`, which `createTurn` on its
 *                   own would queue onto, so only the item delivery's own check keeps it closed;
 *   * `NONE`      — nobody has opened a coordinator for this project.
 */
async function world(stack: Stack, label: string, coordinator: CoordinatorShape): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@open-items.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  let coordinatorSessionId: string | null = null;
  let runningTurnId: string | null = null;
  if (coordinator !== 'NONE') {
    coordinatorSessionId = randomUUID();
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
        status: coordinator === 'RUNNING' ? RunStatus.RUNNING : RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        titleManagedByProject: true,
        numTurns: 1,
        startedAt: new Date(),
        runtimeSessionId: `runtime-${coordinatorSessionId}`,
        ...(coordinator === 'COMPLETED' ? { completedAt: new Date(), archivedAt: new Date() } : {}),
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
    if (coordinator === 'RUNNING') {
      runningTurnId = randomUUID();
      await db.conversationTurn.create({
        data: {
          id: runningTurnId,
          sessionId: coordinatorSessionId,
          seq: 2,
          clientTurnId: `message:${runningTurnId}`,
          kind: 'message',
          content: 'look at the project',
          status: 'IN_FLIGHT',
          deliveredAt: new Date(),
        },
      });
    }
  }
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: 'every failure has somebody who knows about it',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      ...(coordinatorSessionId ? { coordinatorSessionId } : {}),
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId, runningTurnId };
}

interface Attempt {
  taskId: string;
  title: string;
  sessionId: string;
  turnId: string;
}

/** A project task, declared through the product, with one run on it. */
async function attempt(
  stack: Stack,
  w: World,
  label: string,
  options: {
    session?: RunStatus;
    taskStatus?: TaskStatus;
    acceptance?: { command: string; expectedExitCode: number };
    supersedesTaskId?: string;
    runnerId?: string;
    /** The branch this run took a worktree on, which is what makes the task one to integrate. */
    branch?: string;
  } = {},
): Promise<Attempt> {
  const db = stack.db;
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const declared = await stack.tasks.create(w.ownerId, {
    title,
    assigneeId: w.workspaceId,
    projectId: w.projectId,
    ...(options.supersedesTaskId ? { supersedesTaskId: options.supersedesTaskId } : {}),
    ...(options.acceptance
      ? {
          acceptanceCommand: options.acceptance.command,
          acceptanceExpectedExitCode: options.acceptance.expectedExitCode,
        }
      : {}),
  });
  if (options.taskStatus) {
    await db.task.update({ where: { id: declared.id }, data: { status: options.taskStatus } });
  }
  const sessionId = randomUUID();
  const turnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      taskId: declared.id,
      workspaceId: w.workspaceId,
      assignedRunnerId: options.runnerId ?? w.runnerId,
      title,
      prompt: title,
      provider: 'claude',
      status: options.session ?? RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      startedAt: new Date(),
      ...(options.branch
        ? { branch: options.branch, isolationStatus: 'worktree', baseSha: 'b'.repeat(40) }
        : {}),
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
      status: options.session === RunStatus.AWAITING_INPUT ? 'ANSWERED' : 'IN_FLIGHT',
      deliveredAt: new Date(),
    },
  });
  return { taskId: declared.id, title, sessionId, turnId };
}

/** A task with no run on it at all, for the doors that need none. */
async function bareTask(
  stack: Stack,
  w: World,
  label: string,
  supersedesTaskId?: string,
): Promise<{ taskId: string; title: string }> {
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const declared = await stack.tasks.create(w.ownerId, {
    title,
    assigneeId: w.workspaceId,
    projectId: w.projectId,
    ...(supersedesTaskId ? { supersedesTaskId } : {}),
  });
  return { taskId: declared.id, title };
}

interface ItemRow {
  id: string;
  kind: string;
  state: string;
  assignee: string;
  assigneeReason: string;
  taskId: string | null;
  sessionId: string | null;
  dedupeKey: string;
  title: string;
  integrationJobId: string | null;
  payload: {
    how?: string;
    exitCode?: number;
    expectedExitCode?: number;
    error?: string;
    chain?: { rootTaskId: string; failuresInChain: number; limit: number };
    jobKind?: string;
    phase?: string;
    targetRef?: string;
    files?: string[];
    nothingLanded?: boolean;
    check?: { name: string; command: string; exitCode: number; expectedExitCode: number };
    branchUnchanged?: boolean;
    errorCode?: string;
  };
  waitingSince: Date;
  assignedAt: Date;
  escalateAt: Date | null;
  resolution: string | null;
  resolvedBy: string | null;
}

async function tableExists(db: PrismaClient, table: string): Promise<boolean> {
  const [row] = await db.$queryRaw<Array<{ present: boolean }>>(
    Prisma.sql`SELECT to_regclass(${`public.${table}`}::text) IS NOT NULL AS "present"`,
  );
  return row.present;
}

/** Every item this project has, oldest first; none on a database that has no item table. */
async function items(db: PrismaClient, projectId: string): Promise<ItemRow[]> {
  if (!(await tableExists(db, 'project_open_item'))) return [];
  return db.$queryRaw<ItemRow[]>(Prisma.sql`
    SELECT "id", "kind", "state", "assignee", "assignee_reason" AS "assigneeReason",
           "task_id" AS "taskId", "session_id" AS "sessionId", "dedupe_key" AS "dedupeKey",
           "integration_job_id" AS "integrationJobId",
           "title", "payload", "waiting_since" AS "waitingSince", "assigned_at" AS "assignedAt",
           "escalate_at" AS "escalateAt", "resolution", "resolved_by" AS "resolvedBy"
      FROM "project_open_item"
     WHERE "project_id" = ${projectId}::uuid
     ORDER BY "created_at", "id"`);
}

interface DeliveryRow {
  itemId: string;
  sessionId: string;
  purpose: string;
  clientTurnId: string;
  returnedAt: Date | null;
  returnCode: string | null;
}

async function deliveries(db: PrismaClient, projectId: string): Promise<DeliveryRow[]> {
  if (!(await tableExists(db, 'project_open_item_delivery'))) return [];
  return db.$queryRaw<DeliveryRow[]>(Prisma.sql`
    SELECT "item_id" AS "itemId", "session_id" AS "sessionId", "purpose",
           "client_turn_id" AS "clientTurnId", "returned_at" AS "returnedAt",
           "return_code" AS "returnCode"
      FROM "project_open_item_delivery"
     WHERE "project_id" = ${projectId}::uuid
     ORDER BY "created_at", "id"`);
}

/** The turns the platform queued on a conversation for an item. */
function itemTurns(db: PrismaClient, sessionId: string) {
  return db.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { startsWith: 'open-item:v1:' } },
    select: { id: true, seq: true, status: true, clientTurnId: true, content: true, deliveredAt: true },
    orderBy: { seq: 'asc' },
  });
}

/** What reached the coordinator ledger or the coordinator's conversation about one task, in one line. */
async function factsAbout(db: PrismaClient, w: World, taskId: string): Promise<string> {
  const wakes = await db.projectCoordinatorWake.count({ where: { projectId: w.projectId, subjectId: taskId } });
  const opened = (await items(db, w.projectId)).filter((item) => item.taskId === taskId).length;
  const turns = w.coordinatorSessionId ? (await itemTurns(db, w.coordinatorSessionId)).length : 0;
  return `wake rows: ${wakes}, open items: ${opened}, item turns on the coordinator: ${turns}`;
}

function turnKey(item: ItemRow): string {
  return `open-item:v1:${item.id}:${item.assignedAt.getTime()}`;
}

async function onlyItemFor(db: PrismaClient, w: World, taskId: string, what: string): Promise<ItemRow> {
  const opened = (await items(db, w.projectId)).filter((item) => item.taskId === taskId);
  assert.equal(opened.length, 1, `${what} — ${await factsAbout(db, w, taskId)}`);
  return opened[0]!;
}

function dequeue(stack: Stack, sessionId: string, runnerId: string) {
  return (stack.api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string; content?: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, runnerId, null);
}

function sweep(reaper: ReaperService): Promise<void> {
  return (reaper as unknown as { sweep(): Promise<void> }).sweep();
}

/** A failed run of an ordinary task turn, reported by the runner. */
async function failTurn(stack: Stack, w: World, a: Attempt, result = 'the engine gave up'): Promise<void> {
  const outcome = await stack.api.turnComplete({ id: w.runnerId }, a.sessionId, {
    turnId: a.turnId,
    status: SharedRunStatus.FAILED,
    result,
  });
  assert.deepEqual(outcome, { ok: true, status: RunStatus.FAILED });
}

/**
 * The engine's reply to a turn it ran, up the door the runner posts its transcript to.
 *
 * A turn is ANSWERED because something answered it, not because the engine stopped: a message turn
 * with none of the workspace's own reply events under it goes back to PENDING when it is completed
 * instead of ending. A fixture whose turn is meant to have ENDED — freeing the engine for whatever
 * is queued behind it — has to have been spoken in first.
 */
async function answerTurn(
  stack: Stack,
  runnerId: string,
  sessionId: string,
  turnId: string,
  text: string,
): Promise<void> {
  const last = await stack.db.runEvent.aggregate({ where: { sessionId }, _max: { seq: true } });
  await stack.api.events({ id: runnerId }, sessionId, {
    events: [{
      seq: (last._max.seq ?? 0) + 1,
      type: RunEventType.ASSISTANT,
      ts: new Date().toISOString(),
      turnId,
      payload: { text },
    }],
  });
}

/**
 * A project that integrates on a branch of its own (§1.2): its coordination workspace names a
 * repository, and the line is chosen through the door the owner's settings take rather than by
 * writing the binding here.
 *
 * `workDir` is what the runner would do the git work in. A workspace without one is the claim that
 * has nowhere to run — the fourth way the pipeline ends a job — so it is a parameter, not a constant.
 */
async function integratingWorld(
  stack: Stack,
  label: string,
  coordinator: CoordinatorShape,
  workDir: string | null = `/srv/${label}`,
): Promise<World> {
  const w = await world(stack, label, coordinator);
  await stack.db.workspace.update({
    where: { id: w.workspaceId },
    data: { repoUrl: `https://git.invalid/orbit/${label}.git`, workDir },
  });
  await stack.db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId: w.ownerId,
    projectId: w.projectId,
    settings: { line: 'PROJECT_BRANCH' },
  }));
  return w;
}

/**
 * One code task of this project, carried to the point where a runner holds its landing: DONE through
 * its own acceptance command, queued onto the project's branch by that same transaction (§2.3
 * J-T1a), and claimed off the heartbeat by the runner that will report on it (J-T2).
 *
 * Every step is a door a real runner knocks on, so what the cases below report a failure for is a
 * job the platform really queued and really handed out.
 */
async function claimedLanding(
  stack: Stack,
  w: World,
  label: string,
): Promise<{ task: Attempt; job: IntegrationJobCommand }> {
  const a = await attempt(stack, w, label, {
    acceptance: { command: 'exit 0', expectedExitCode: 0 },
    branch: `orbit/${label}`,
  });
  await answerTurn(stack, w.runnerId, a.sessionId, a.turnId, 'the work is on the branch');
  await stack.api.turnComplete({ id: w.runnerId }, a.sessionId, {
    turnId: a.turnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  const acceptance = await dequeue(stack, a.sessionId, w.runnerId);
  assert.equal(acceptance?.taskAcceptance, true, 'the acceptance command was queued for this task');
  await stack.api.turnComplete({ id: w.runnerId }, a.sessionId, {
    turnId: acceptance!.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  assert.equal(await taskStatus(stack.db, a.taskId), TaskStatus.DONE, 'the acceptance command agreed');

  const claimed = await stack.jobs.dispatch({
    runnerId: w.runnerId,
    leaseOwner: `lease-${label}`,
    draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM],
  });
  assert.equal(claimed.length, 1, `the DONE queued no landing — ${await jobsOf(stack.db, w.projectId)}`);
  return { task: a, job: claimed[0]! };
}

/** The result a runner posts for a job that did not land, over the route it posts it on. */
function reportFailure(
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

/** This project's integration jobs as one line, for the assertions that say one did not happen. */
async function jobsOf(db: PrismaClient, projectId: string): Promise<string> {
  const rows = await db.projectIntegrationJob.findMany({
    where: { projectId },
    select: { kind: true, generation: true, state: true, errorCode: true },
    orderBy: { createdAt: 'asc' },
  });
  return `jobs: ${JSON.stringify(rows)}`;
}

/** The job row as the platform left it, which is where "nothing landed" is written down. */
function jobRow(db: PrismaClient, jobId: string) {
  return db.projectIntegrationJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { state: true, phase: true, landedSha: true, receiptIds: true, errorCode: true },
  });
}

async function taskStatus(db: PrismaClient, taskId: string): Promise<TaskStatus> {
  return (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } })).status;
}

function assertEscalatesAfterDefault(item: ItemRow): void {
  assert.ok(item.escalateAt, 'an item with the coordinator carries the moment it goes to the owner');
  assert.equal(
    item.escalateAt!.getTime() - item.waitingSince.getTime(),
    7_200_000,
    'frozen at creation from the project default of two hours',
  );
}

test('a FAILED written by the runner\'s failed turn opens one item owned by the coordinator, and queues it on the coordinator',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'turn-failed', 'PARKED');
      const a = await attempt(stack, w, 'turn-failed', { taskStatus: TaskStatus.IN_PROGRESS });

      await failTurn(stack, w, a);
      assert.equal(await taskStatus(stack.db, a.taskId), TaskStatus.FAILED);
      // The runner retries a completion whose response it lost; the ACK makes the replay a no-op.
      await stack.api.turnComplete({ id: w.runnerId }, a.sessionId, {
        turnId: a.turnId,
        status: SharedRunStatus.FAILED,
        result: 'the engine gave up',
      });

      const item = await onlyItemFor(stack.db, w, a.taskId, 'the runner turn wrote FAILED');
      assert.equal(item.kind, 'TASK_FAILED');
      assert.equal(item.state, 'OPEN');
      assert.equal(item.assignee, 'COORDINATOR');
      assert.equal(item.assigneeReason, 'DEFAULT');
      assert.equal(item.sessionId, a.sessionId, 'the attempt that failed');
      assert.equal(item.dedupeKey, `TF:${a.taskId}:${a.sessionId}`);
      assert.equal(item.title, `Task failed: ${a.title}`);
      assert.equal(item.payload.how, 'RUN_FAILED');
      assert.equal(item.payload.error, 'the engine gave up');
      assert.deepEqual(item.payload.chain, { rootTaskId: a.taskId, failuresInChain: 1, limit: 3 });
      assertEscalatesAfterDefault(item);

      const turns = await itemTurns(stack.db, w.coordinatorSessionId!);
      assert.equal(turns.length, 1, 'the item was not queued on the coordinator');
      assert.equal(turns[0]!.clientTurnId, turnKey(item));
      assert.equal(turns[0]!.status, 'PENDING');
      assert.match(turns[0]!.content ?? '', new RegExp(`Task failed: ${a.title}`));
      const sent = await deliveries(stack.db, w.projectId);
      assert.deepEqual(
        sent.map((d) => ({ itemId: d.itemId, sessionId: d.sessionId, purpose: d.purpose, returnedAt: d.returnedAt })),
        [{ itemId: item.id, sessionId: w.coordinatorSessionId, purpose: 'ITEM', returnedAt: null }],
      );
      assert.equal(
        (await stack.db.session.findUniqueOrThrow({ where: { id: w.coordinatorSessionId! } })).status,
        RunStatus.PENDING,
        'a parked coordinator is woken for it',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an EXECUTABLE exit code that disagrees opens one item', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'exit-mismatch', 'PARKED');
    const a = await attempt(stack, w, 'exit-mismatch', { acceptance: { command: 'exit 7', expectedExitCode: 0 } });
    // The task's own turn is answered — the engine ran it and said so — which is what settles it
    // and leaves the acceptance shell turn as the next thing this session has to run.
    await answerTurn(stack, w.runnerId, a.sessionId, a.turnId, 'the task work is done');
    const finished = await stack.api.turnComplete({ id: w.runnerId }, a.sessionId, {
      turnId: a.turnId,
      status: SharedRunStatus.SUCCEEDED,
    });
    assert.deepEqual(finished, { ok: true, status: RunStatus.RUNNING });
    const acceptance = await dequeue(stack, a.sessionId, w.runnerId);
    assert.equal(acceptance?.taskAcceptance, true);
    const shell = spawnSync('bash', ['-lc', acceptance!.content!], { encoding: 'utf8' });
    assert.equal(shell.status, 7);
    const compared = await stack.api.turnComplete({ id: w.runnerId }, a.sessionId, {
      turnId: acceptance!.turnId,
      status: SharedRunStatus.SUCCEEDED,
      subtype: 'shell',
      shellExitCode: shell.status!,
      shellOutput: `${shell.stdout}${shell.stderr}`,
    });
    assert.deepEqual(compared, { ok: true, status: RunStatus.FAILED });
    assert.equal(await taskStatus(stack.db, a.taskId), TaskStatus.FAILED);

    const item = await onlyItemFor(stack.db, w, a.taskId, 'the disagreeing exit code wrote FAILED');
    assert.equal(item.payload.how, 'ACCEPTANCE_EXIT_MISMATCH');
    assert.equal(item.payload.exitCode, 7);
    assert.equal(item.payload.expectedExitCode, 0);
    assert.equal(item.assignee, 'COORDINATOR');
    assert.equal((await itemTurns(stack.db, w.coordinatorSessionId!)).length, 1);
  } finally {
    await stack.db.$disconnect();
  }
});

test('a FAILED written by runner finalize opens one item', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'finalize-failed', 'PARKED');
    const a = await attempt(stack, w, 'finalize-failed', { taskStatus: TaskStatus.IN_PROGRESS });

    await stack.api.finalize({ id: w.runnerId }, a.sessionId, {
      status: 'FAILED',
      error: 'the engine exited',
    } as never);
    assert.equal(await taskStatus(stack.db, a.taskId), TaskStatus.FAILED, 'finalize reclaimed the task as FAILED');

    const item = await onlyItemFor(stack.db, w, a.taskId, 'runner finalize wrote FAILED');
    assert.equal(item.payload.how, 'RUNNER_FINALIZED_FAILED');
    assert.equal(item.payload.error, 'the engine exited');
    assert.equal(item.sessionId, a.sessionId);
    assert.equal(item.assignee, 'COORDINATOR');
    const turns = await itemTurns(stack.db, w.coordinatorSessionId!);
    assert.deepEqual(turns.map((t) => t.clientTurnId), [turnKey(item)], 'finalize delivered it after its commit');
  } finally {
    await stack.db.$disconnect();
  }
});

test('a FAILED written by the reaper opens one item', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'reaper-failed', 'PARKED');
    const a = await attempt(stack, w, 'reaper-failed', {
      taskStatus: TaskStatus.IN_PROGRESS,
      session: RunStatus.AWAITING_INPUT,
    });
    // An older runner parked this run after an API error it reported as a successful turn.
    await stack.db.runEvent.create({
      data: {
        sessionId: a.sessionId,
        seq: 1,
        type: RunEventType.ASSISTANT,
        payload: { text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}' },
      },
    });

    await sweep(stack.reaper);
    assert.equal(await taskStatus(stack.db, a.taskId), TaskStatus.FAILED, 'the reaper reclaimed the task as FAILED');

    const item = await onlyItemFor(stack.db, w, a.taskId, 'the reaper wrote FAILED');
    assert.equal(item.payload.how, 'REAPED_API_ERROR');
    assert.match(item.payload.error ?? '', /^API Error: 400/);
    assert.equal(item.assignee, 'COORDINATOR');
    const turns = await itemTurns(stack.db, w.coordinatorSessionId!);
    assert.deepEqual(turns.map((t) => t.clientTurnId), [turnKey(item)], 'the reaper delivered it after its commit');
  } finally {
    await stack.db.$disconnect();
  }
});

test('a run the reaper takes back from a runner that went offline opens one item too', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'runner-offline', 'PARKED');
    const lostRunner = randomUUID();
    await stack.db.runner.create({
      data: {
        id: lostRunner,
        ownerId: w.ownerId,
        name: 'runner-offline-lost',
        tokenHash: `hash-${lostRunner}`,
        status: RunnerStatus.ONLINE,
        capabilities: [],
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const a = await attempt(stack, w, 'runner-offline', { taskStatus: TaskStatus.IN_PROGRESS, runnerId: lostRunner });

    await sweep(stack.reaper);
    assert.equal(await taskStatus(stack.db, a.taskId), TaskStatus.OPEN, 'the task is back in the pool');

    const item = await onlyItemFor(stack.db, w, a.taskId, 'the reaper took the run back from a lost runner');
    assert.equal(item.payload.how, 'ATTEMPT_LOST_RUNNER_OFFLINE');
    assert.equal(item.assignee, 'COORDINATOR');
  } finally {
    await stack.db.$disconnect();
  }
});

test('a FAILED filed through task_update opens one item, and closing the task resolves it', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'task-update-failed', 'PARKED');
    const t = await bareTask(stack, w, 'task-update-failed');

    await stack.tasks.update(w.ownerId, t.taskId, { status: DeclaredTaskStatus.FAILED });

    const item = await onlyItemFor(stack.db, w, t.taskId, 'task_update wrote FAILED');
    assert.equal(item.payload.how, 'REPORTED_FAILED');
    assert.equal(item.sessionId, null);
    assert.equal(item.dedupeKey, `TF:${t.taskId}:write:1`);
    assert.equal(item.assignee, 'COORDINATOR');
    assert.equal((await itemTurns(stack.db, w.coordinatorSessionId!)).length, 1);

    await stack.tasks.update(w.ownerId, t.taskId, { status: DeclaredTaskStatus.CANCELLED });
    const [closed] = (await items(stack.db, w.projectId)).filter((row) => row.taskId === t.taskId);
    assert.equal(closed?.state, 'RESOLVED', 'a cancelled task leaves no open item behind');
    assert.equal(closed?.resolution, 'TASK_CLOSED');
    assert.equal(closed?.resolvedBy, 'PLATFORM');
  } finally {
    await stack.db.$disconnect();
  }
});

test('a merge conflict opens one item owned by the coordinator, and queues it on the coordinator',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await integratingWorld(stack, 'conflict', 'PARKED');
      const { task, job } = await claimedLanding(stack, w, 'conflict');

      const answer = await reportFailure(stack, w, job, {
        state: 'CONFLICT',
        phase: 'REBASE',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        conflicts: ['src/apiserver/src/projects/project-open-item.ts'],
      });
      assert.equal(answer.accepted, true, 'the runner\'s result was taken');

      const item = await onlyItemFor(stack.db, w, task.taskId, 'the runner reported a conflict');
      assert.equal(item.kind, 'INTEGRATION_CONFLICT');
      assert.equal(item.state, 'OPEN');
      assert.equal(item.assignee, 'COORDINATOR', 'a conflict is the coordinator\'s to resolve');
      assert.equal(item.assigneeReason, 'DEFAULT');
      assert.equal(item.integrationJobId, job.jobId, 'the item names the job it is about');
      assert.equal(item.dedupeKey, `IC:${job.jobId}`);
      assert.equal(item.title, `Merge conflict: ${task.title}`);
      assert.deepEqual(item.payload.files, ['src/apiserver/src/projects/project-open-item.ts']);
      assert.equal(item.payload.phase, 'REBASE');
      assert.equal(item.payload.targetRef, job.targetRef);
      assert.equal(item.payload.nothingLanded, true);
      assert.equal(answer.openItemId, item.id, 'the result names the item it opened');
      assertEscalatesAfterDefault(item);

      // Nothing landed, and the job says so: the branch is where it was.
      const row = await jobRow(stack.db, job.jobId);
      assert.equal(row.state, 'CONFLICT');
      assert.equal(row.landedSha, null);
      assert.deepEqual(row.receiptIds, []);

      const turns = await itemTurns(stack.db, w.coordinatorSessionId!);
      assert.deepEqual(turns.map((t) => t.clientTurnId), [turnKey(item)], 'the result\'s own door delivered it');
      assert.equal(turns[0]!.status, 'PENDING');
      assert.match(turns[0]!.content ?? '', new RegExp(`Merge conflict: ${task.title}`));
      const sent = await deliveries(stack.db, w.projectId);
      assert.deepEqual(
        sent.map((d) => ({ itemId: d.itemId, sessionId: d.sessionId, purpose: d.purpose, returnedAt: d.returnedAt })),
        [{ itemId: item.id, sessionId: w.coordinatorSessionId, purpose: 'ITEM', returnedAt: null }],
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a check that failed on the combined tree opens one item owned by the coordinator, and nothing landed',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await integratingWorld(stack, 'check-failed', 'PARKED');
      const { task, job } = await claimedLanding(stack, w, 'check-failed');
      assert.deepEqual(
        job.checks.map((check) => ({ name: check.name, command: check.command })),
        [{ name: 'TASK_ACCEPTANCE', command: 'exit 0' }],
        'the task\'s own acceptance command is what runs again on the combined tree',
      );

      const answer = await reportFailure(stack, w, job, {
        state: 'CHECK_FAILED',
        phase: 'CHECK',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        testedSha: 'd'.repeat(40),
        testedTreeSha: 'e'.repeat(40),
        checks: [{
          name: 'TASK_ACCEPTANCE',
          command: 'exit 0',
          expectedExitCode: 0,
          exitCode: 1,
          timedOut: false,
          durationMs: 4_200,
          outputTail: 'not ok 3 - the other task moved the file this one reads',
        }],
      });
      assert.equal(answer.accepted, true);

      const item = await onlyItemFor(stack.db, w, task.taskId, 'the check on the combined tree failed');
      assert.equal(item.kind, 'INTEGRATION_CHECK_FAILED');
      assert.equal(item.assignee, 'COORDINATOR');
      assert.equal(item.assigneeReason, 'DEFAULT');
      assert.equal(item.dedupeKey, `ICF:${job.jobId}`);
      assert.equal(item.title, `Checks failed on the combined tree: ${task.title}`);
      assert.equal(item.payload.check?.name, 'TASK_ACCEPTANCE');
      assert.equal(item.payload.check?.exitCode, 1, 'the check that disagreed, not the last one reported');
      assert.equal(item.payload.check?.expectedExitCode, 0);
      assert.equal(item.payload.branchUnchanged, true);
      assert.equal(answer.openItemId, item.id);
      assertEscalatesAfterDefault(item);

      const row = await jobRow(stack.db, job.jobId);
      assert.equal(row.state, 'CHECK_FAILED');
      assert.equal(row.landedSha, null, 'a red check lands nothing');
      assert.deepEqual(row.receiptIds, [], 'and writes no receipt, so no dependent is released');

      const turns = await itemTurns(stack.db, w.coordinatorSessionId!);
      assert.deepEqual(turns.map((t) => t.clientTurnId), [turnKey(item)]);
      assert.deepEqual(
        (await deliveries(stack.db, w.projectId)).map((d) => ({ itemId: d.itemId, returnedAt: d.returnedAt })),
        [{ itemId: item.id, returnedAt: null }],
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('every state the integration pipeline fails on opens exactly one item, and the coordinator is told',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // The census reads the closed set rather than a list written out here: a state added to the
      // pipeline that opens no item, or opens one of a kind nobody expects, is caught by this.
      const failing = INTEGRATION_JOB_STATES.filter((state) => openItemKindForJobState(state) !== null);
      assert.deepEqual([...failing].sort(), ['CHECK_FAILED', 'CONFLICT', 'ERROR'],
        'the pipeline\'s failure states, as §2.6 closes them');

      for (const state of failing) {
        const label = `census-${state.toLowerCase().replace(/_/g, '-')}`;
        const w = await integratingWorld(stack, label, 'PARKED');
        const { task, job } = await claimedLanding(stack, w, label);
        const answer = await reportFailure(stack, w, job, {
          state,
          phase: state === 'CONFLICT' ? 'REBASE' : 'CHECK',
          sourceSha: 'a'.repeat(40),
          targetShaBefore: 'c'.repeat(40),
          ...(state === 'CONFLICT' ? { conflicts: ['src/shared/src/dto.ts'] } : {}),
          ...(state === 'CHECK_FAILED'
            ? {
                checks: [{
                  name: 'MERGE_CHECK' as const,
                  command: 'npm test',
                  expectedExitCode: 0,
                  exitCode: 2,
                  timedOut: false,
                  durationMs: 10,
                  outputTail: '',
                }],
              }
            : {}),
          ...(state === 'ERROR' ? { errorCode: 'PUSH_REJECTED' } : {}),
        });

        const item = await onlyItemFor(stack.db, w, task.taskId, `${state} opened no single item`);
        assert.equal(item.kind, openItemKindForJobState(state), `${state} opens its own kind of item`);
        assert.equal(item.state, 'OPEN', `${state} leaves somebody something to do`);
        assert.equal(item.assignee, 'COORDINATOR', `${state} is the coordinator\'s`);
        assert.equal(item.integrationJobId, job.jobId);
        assert.equal(answer.openItemId, item.id, `${state} tells the runner which item it opened`);
        assert.deepEqual(
          (await itemTurns(stack.db, w.coordinatorSessionId!)).map((t) => t.clientTurnId),
          [turnKey(item)],
          `${state} was not queued on the coordinator`,
        );
      }
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a claim with nowhere to run it opens an item the coordinator is told about', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    // The fourth way a landing ends, and the only one no runner reports: the workspace the source
    // session ran in names no working directory, so the claim is ended where it was made.
    const w = await integratingWorld(stack, 'unworkable', 'PARKED', null);
    const a = await attempt(stack, w, 'unworkable', {
      acceptance: { command: 'exit 0', expectedExitCode: 0 },
      branch: 'orbit/unworkable',
    });
    await answerTurn(stack, w.runnerId, a.sessionId, a.turnId, 'the work is on the branch');
    await stack.api.turnComplete({ id: w.runnerId }, a.sessionId, {
      turnId: a.turnId,
      status: SharedRunStatus.SUCCEEDED,
    });
    const acceptance = await dequeue(stack, a.sessionId, w.runnerId);
    await stack.api.turnComplete({ id: w.runnerId }, a.sessionId, {
      turnId: acceptance!.turnId,
      status: SharedRunStatus.SUCCEEDED,
      subtype: 'shell',
      shellExitCode: 0,
      shellOutput: '',
    });
    assert.equal(await taskStatus(stack.db, a.taskId), TaskStatus.DONE);

    const claimed = await stack.jobs.dispatch({
      runnerId: w.runnerId,
      leaseOwner: 'lease-unworkable',
      draining: false,
      capabilities: [INTEGRATION_JOB_CLAIM],
    });
    assert.deepEqual(claimed, [], 'a job with nowhere to run is not handed to the runner');

    const item = await onlyItemFor(stack.db, w, a.taskId, 'the unworkable claim was ended');
    assert.equal(item.kind, 'INTEGRATION_ERROR');
    assert.equal(item.assignee, 'COORDINATOR');
    assert.equal(item.payload.errorCode, 'INTEGRATION_REPOSITORY_UNKNOWN');
    assert.deepEqual(
      (await itemTurns(stack.db, w.coordinatorSessionId!)).map((t) => t.clientTurnId),
      [turnKey(item)],
      'an item opened away from a request is owed the same delivery as one opened on it',
    );
  } finally {
    await stack.db.$disconnect();
  }
});

test('an integration failure with no coordinator to hand it to is the owner\'s', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    // The assignee of an integration item is decided the same way a failed task's is, and it has its
    // own code to decide it (§4.2, X-D6): a project nobody coordinates has nobody to queue it on.
    const w = await integratingWorld(stack, 'conflict-unowned', 'NONE');
    const { task, job } = await claimedLanding(stack, w, 'conflict-unowned');
    await reportFailure(stack, w, job, {
      state: 'CONFLICT',
      phase: 'MAIN_SYNC',
      sourceSha: 'a'.repeat(40),
      targetShaBefore: 'c'.repeat(40),
      conflicts: ['docs/project-integration-line-contract.md'],
    });

    const item = await onlyItemFor(stack.db, w, task.taskId, 'the runner reported a conflict');
    assert.equal(item.kind, 'INTEGRATION_CONFLICT');
    assert.equal(item.assignee, 'OWNER');
    assert.equal(item.assigneeReason, 'NO_COORDINATOR');
    assert.equal(item.escalateAt, null, 'an item already with the owner has nobody to escalate to');
    assert.deepEqual(await deliveries(stack.db, w.projectId), [], 'an owner\'s item is not queued on a conversation');
  } finally {
    await stack.db.$disconnect();
  }
});

test('an item survives unread messages and is delivered after the running turn ends', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'busy-coordinator', 'RUNNING');
    const coordinator = w.coordinatorSessionId!;
    // The owner asked something while the coordinator was busy; it has not been read.
    const unread = await stack.sessions.createTurn(w.ownerId, coordinator, {
      clientTurnId: randomUUID(),
      content: 'what is the state of the project?',
      intent: 'NEXT_TURN',
    });
    const a = await attempt(stack, w, 'busy-coordinator', { taskStatus: TaskStatus.IN_PROGRESS });

    await failTurn(stack, w, a);

    const item = await onlyItemFor(stack.db, w, a.taskId, 'the runner turn wrote FAILED');
    const [queued] = await itemTurns(stack.db, coordinator);
    assert.ok(queued, `a busy coordinator is not a refusal — ${await factsAbout(stack.db, w, a.taskId)}`);
    assert.equal(queued.status, 'PENDING');
    assert.equal(queued.deliveredAt, null);
    assert.ok(queued.seq > unread.seq, 'it waits behind what the owner already sent');

    // Nothing else is written about the task: the coordinator's own turn ending is what hands it over.
    // The turn ends the ordinary way — it was answered — so it settles here instead of going back
    // to the queue in front of the messages already waiting behind it.
    await answerTurn(stack, w.runnerId, coordinator, w.runningTurnId!, 'the project is fine');
    const ended = await stack.api.turnComplete({ id: w.runnerId }, coordinator, {
      turnId: w.runningTurnId!,
      status: SharedRunStatus.SUCCEEDED,
    });
    assert.deepEqual(ended, { ok: true, status: RunStatus.RUNNING });
    const first = await dequeue(stack, coordinator, w.runnerId);
    assert.equal(first?.turnId, unread.turnId, 'the owner\'s message goes first');
    await answerTurn(stack, w.runnerId, coordinator, first!.turnId, 'the project is fine');
    await stack.api.turnComplete({ id: w.runnerId }, coordinator, {
      turnId: first!.turnId,
      status: SharedRunStatus.SUCCEEDED,
    });
    const second = await dequeue(stack, coordinator, w.runnerId);
    assert.equal(second?.turnId, queued.id, 'then the item');
    assert.match(second?.content ?? '', new RegExp(`Task failed: ${a.title}`));
    const [handed] = await itemTurns(stack.db, coordinator);
    assert.ok(handed?.deliveredAt, 'handed to the engine');
    assert.equal(handed?.clientTurnId, turnKey(item));
  } finally {
    await stack.db.$disconnect();
  }
});

test('an item no door delivered reaches the coordinator when its own turn ends', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'compensated', 'RUNNING');
    const coordinator = w.coordinatorSessionId!;
    const a = await attempt(stack, w, 'compensated', {
      taskStatus: TaskStatus.IN_PROGRESS,
      session: RunStatus.AWAITING_INPUT,
    });
    await stack.db.runEvent.create({
      data: { sessionId: a.sessionId, seq: 1, type: RunEventType.ASSISTANT, payload: { text: 'API Error: 400 blocked' } },
    });

    // Recorded by a component that dies before its post-commit delivery: the item is there and owed.
    await sweep(stack.silentReaper);
    const item = await onlyItemFor(stack.db, w, a.taskId, 'the reaper wrote FAILED');
    assert.equal(item.assignee, 'COORDINATOR');
    assert.deepEqual(await itemTurns(stack.db, coordinator), [], 'the component that recorded it delivered nothing');

    await stack.api.turnComplete({ id: w.runnerId }, coordinator, {
      turnId: w.runningTurnId!,
      status: SharedRunStatus.SUCCEEDED,
    });

    const turns = await itemTurns(stack.db, coordinator);
    assert.deepEqual(turns.map((t) => ({ key: t.clientTurnId, status: t.status })), [
      { key: turnKey(item), status: 'PENDING' },
    ], 'the coordinator\'s committed turn end is where an owed item is delivered');
  } finally {
    await stack.db.$disconnect();
  }
});

test('an item whose coordinator has ended, or that has none, goes to the owner', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const completed = await world(stack, 'coordinator-completed', 'COMPLETED');
    const a = await attempt(stack, completed, 'coordinator-completed', { taskStatus: TaskStatus.IN_PROGRESS });
    await failTurn(stack, completed, a);
    const ended = await onlyItemFor(stack.db, completed, a.taskId, 'the runner turn wrote FAILED');
    assert.equal(ended.assignee, 'OWNER');
    assert.equal(ended.assigneeReason, 'COORDINATOR_ENDED');
    assert.equal(ended.escalateAt, null, 'an item already with the owner has nobody to escalate to');
    assert.deepEqual(await itemTurns(stack.db, completed.coordinatorSessionId!), [], 'a completed conversation is not reopened');
    const session = await stack.db.session.findUniqueOrThrow({ where: { id: completed.coordinatorSessionId! } });
    assert.equal(session.status, RunStatus.AWAITING_INPUT, 'and not woken');

    const orphan = await world(stack, 'no-coordinator', 'NONE');
    const b = await attempt(stack, orphan, 'no-coordinator', { taskStatus: TaskStatus.IN_PROGRESS });
    await failTurn(stack, orphan, b);
    const unowned = await onlyItemFor(stack.db, orphan, b.taskId, 'the runner turn wrote FAILED');
    assert.equal(unowned.assignee, 'OWNER');
    assert.equal(unowned.assigneeReason, 'NO_COORDINATOR');
  } finally {
    await stack.db.$disconnect();
  }
});

test('a queued item turn drained by the coordinator\'s failed turn is returned and goes to the owner, not lost',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'drained', 'RUNNING');
      const coordinator = w.coordinatorSessionId!;
      const a = await attempt(stack, w, 'drained', { taskStatus: TaskStatus.IN_PROGRESS });
      await failTurn(stack, w, a);
      const item = await onlyItemFor(stack.db, w, a.taskId, 'the runner turn wrote FAILED');
      const [queued] = await itemTurns(stack.db, coordinator);
      assert.equal(queued?.status, 'PENDING', `nothing was queued — ${await factsAbout(stack.db, w, a.taskId)}`);

      // The coordinator's running turn fails, and its queue is drained with it.
      await stack.api.turnComplete({ id: w.runnerId }, coordinator, {
        turnId: w.runningTurnId!,
        status: SharedRunStatus.FAILED,
        result: 'API Error: 500 upstream',
      });

      const [drained] = await itemTurns(stack.db, coordinator);
      assert.equal(drained?.status, 'ANSWERED');
      assert.equal(drained?.deliveredAt, null, 'the engine never saw it');
      const [returned] = await deliveries(stack.db, w.projectId);
      assert.ok(returned?.returnedAt, 'the delivery says it was taken back unrun');
      assert.equal(returned?.returnCode, 'SESSION_ENDED');
      const [after] = (await items(stack.db, w.projectId)).filter((row) => row.id === item.id);
      assert.equal(after?.state, 'OPEN');
      assert.equal(after?.assignee, 'OWNER', 'an item its coordinator can no longer read is the owner\'s');
      assert.equal(after?.assigneeReason, 'COORDINATOR_ENDED');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the third failure in one successor chain goes straight to the owner', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'chain', 'PARKED');
    const first = await bareTask(stack, w, 'chain attempt 1');
    await stack.tasks.update(w.ownerId, first.taskId, { status: DeclaredTaskStatus.FAILED });
    const second = await bareTask(stack, w, 'chain attempt 2', first.taskId);
    await stack.tasks.update(w.ownerId, second.taskId, { status: DeclaredTaskStatus.FAILED });
    // A failure outside the chain is its own chain of one.
    const bystander = await bareTask(stack, w, 'not in the chain');
    await stack.tasks.update(w.ownerId, bystander.taskId, { status: DeclaredTaskStatus.FAILED });
    const third = await bareTask(stack, w, 'chain attempt 3', second.taskId);
    await stack.tasks.update(w.ownerId, third.taskId, { status: DeclaredTaskStatus.FAILED });

    const one = await onlyItemFor(stack.db, w, first.taskId, 'attempt 1 failed');
    const two = await onlyItemFor(stack.db, w, second.taskId, 'attempt 2 failed');
    const other = await onlyItemFor(stack.db, w, bystander.taskId, 'the bystander failed');
    const three = await onlyItemFor(stack.db, w, third.taskId, 'attempt 3 failed');

    assert.equal(one.assignee, 'COORDINATOR');
    assert.equal(one.state, 'RESOLVED', 'a successor took over from attempt 1');
    assert.equal(one.resolution, 'SUCCESSOR_FILED');
    assert.equal(two.assignee, 'COORDINATOR');
    assert.deepEqual(two.payload.chain, { rootTaskId: first.taskId, failuresInChain: 2, limit: 3 });
    assert.equal(other.assignee, 'COORDINATOR');
    assert.deepEqual(other.payload.chain, { rootTaskId: bystander.taskId, failuresInChain: 1, limit: 3 });

    assert.equal(three.assignee, 'OWNER');
    assert.equal(three.assigneeReason, 'CHAIN_LIMIT');
    assert.equal(three.escalateAt, null);
    assert.deepEqual(three.payload.chain, { rootTaskId: first.taskId, failuresInChain: 3, limit: 3 });
    const keys = (await itemTurns(stack.db, w.coordinatorSessionId!)).map((t) => t.clientTurnId);
    assert.ok(keys.includes(turnKey(two)) && keys.includes(turnKey(other)), 'the first two failures went to the coordinator');
    assert.ok(!keys.includes(turnKey(three)), 'the third is not sent to the coordinator at all');
  } finally {
    await stack.db.$disconnect();
  }
});

test('delivering an item spends nothing of the coordinator\'s fuse budget', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'budget', 'PARKED');
    const coordinator = w.coordinatorSessionId!;
    const t = await bareTask(stack, w, 'budget');
    await stack.tasks.update(w.ownerId, t.taskId, { status: DeclaredTaskStatus.FAILED });
    const [queued] = await itemTurns(stack.db, coordinator);
    assert.ok(queued, `nothing was queued — ${await factsAbout(stack.db, w, t.taskId)}`);

    // The runner claims the conversation, the engine reads the item and ends that turn.
    await stack.db.session.update({ where: { id: coordinator }, data: { status: RunStatus.RUNNING } });
    const handed = await dequeue(stack, coordinator, w.runnerId);
    assert.equal(handed?.turnId, queued.id);
    await stack.db.runEvent.create({
      data: { sessionId: coordinator, seq: 1, type: 'turn_end', payload: { subtype: 'success' }, turnId: queued.id },
    });
    await stack.api.turnComplete({ id: w.runnerId }, coordinator, { turnId: queued.id, status: SharedRunStatus.SUCCEEDED });

    const afterIngestion = async (): Promise<Date> => {
      const [{ now }] = await stack.db.$queryRaw<Array<{ now: Date }>>`
        SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS "now"`;
      return now;
    };
    const spent = await stack.convergence.assessSpend(w.projectId, await afterIngestion());
    assert.equal(spent.spend.selfStartedTurns, 0, 'the delivered item turn is not the coordinator\'s own spending');
    assert.equal(spent.paused, false);

    // The control: a turn the engine started by itself on the same conversation is counted.
    await stack.db.runEvent.create({
      data: { sessionId: coordinator, seq: 2, type: 'turn_end', payload: { subtype: 'success' }, turnId: null },
    });
    const control = await stack.convergence.assessSpend(w.projectId, await afterIngestion());
    assert.equal(control.spend.selfStartedTurns, 1, 'the measure this case relies on counts nothing at all');
  } finally {
    await stack.db.$disconnect();
  }
});

test('the open-item PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
