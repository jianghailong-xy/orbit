import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
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
  uuidToBase62,
} from '@orbit/shared';
import { ConflictException, HttpException } from '@nestjs/common';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ReaperService } from '../realtime/reaper.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
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
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';
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
 * The same is read from the other end: the two gates that settle a task inside a transaction of
 * their own — the evidence judgment and the owner's own Confirm done — answer the item an earlier
 * attempt of that task left open, because the item is answered by the task SETTLING rather than by
 * whichever door happened to write the DONE.
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
  /** What a landing makes of the project branch (§3.4 M-F1): the one job that names no task. */
  promotions: ProjectPromotionService;
  convergence: CoordinatorConvergenceService;
  /** The item door the owner's card presses (§4.7). */
  openItems: ProjectOpenItemService;
  /** The judgment gate: an independent run's CONFIRM is what settles an EVIDENCE_JUDGMENT task. */
  evidence: TaskCompletionEvidenceService;
  /** The owner's own gate: their press in the app is what settles an OWNER_CONFIRMED task. */
  confirmations: TaskOwnerConfirmationService;
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
  // The two completion gates that write DONE inside a transaction of their own rather than through
  // `tasks.update` — the pair whose exception items an earlier build left open for ever. Wired to
  // the SAME `tasks` the doors below use, because that is what production wires: they reach the
  // item table only through it.
  const evidence = new TaskCompletionEvidenceService(prisma, tasks);
  const confirmations = new TaskOwnerConfirmationService(prisma, sessions, tasks);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  // Whoever an integration result has to tell reaches a device, and reaches it from here: the
  // controller announces the item its result opened (`notifyOwnerItem`, §7.6 V12) with no `await`
  // and nothing to return. Answering every method with a resolved promise is what makes the
  // fixture indifferent to WHICH door announces — this file asserts what the item and its turn say,
  // never what a phone showed.
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
  const promotions = new ProjectPromotionService(prisma);
  const reaper = new ReaperService(prisma, realtime, openItems);
  // A component that records a failure and never gets to deliver it: what the coordinator's own turn
  // ending has to compensate for.
  const silentReaper = new ReaperService(prisma, realtime);
  return {
    db, sessions, tasks, api, reaper, silentReaper, jobs, promotions, convergence, openItems,
    evidence, confirmations,
  };
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
 *
 * `coordinatorEnabled` is the owner's own switch and is orthogonal to that shape: off, the
 * conversation is still there and the platform simply stops handing it things on its own. A world
 * built off is the state a project lands in when nobody has confirmed what would settle it.
 */
async function world(stack: Stack, label: string, coordinator: CoordinatorShape,
                     options: { coordinatorEnabled?: boolean } = {}): Promise<World> {
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
      coordinatorEnabled: options.coordinatorEnabled ?? true,
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
    /** The criterion the task declares, for the doors that settle one of the two judgment lanes. */
    criterion?: 'EVIDENCE_JUDGMENT' | 'OWNER_CONFIRMED';
    /** Whether a Project's own release pass may pick this task up when something else completes. */
    autoRun?: boolean;
  } = {},
): Promise<Attempt> {
  const db = stack.db;
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const declared = await stack.tasks.create(w.ownerId, {
    title,
    assigneeId: w.workspaceId,
    projectId: w.projectId,
    ...(options.criterion ? { completionCriterion: options.criterion } : {}),
    ...(options.autoRun === undefined ? {} : { autoRunWhenReady: options.autoRun }),
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
  escalatedAt: Date | null;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedByUserId: string | null;
  resolvedBySessionId: string | null;
  resolutionNote: string | null;
  resolvedAt: Date | null;
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
           "escalate_at" AS "escalateAt", "escalated_at" AS "escalatedAt",
           "resolution", "resolved_by" AS "resolvedBy",
           "resolved_by_user_id" AS "resolvedByUserId",
           "resolved_by_session_id" AS "resolvedBySessionId",
           "resolution_note" AS "resolutionNote", "resolved_at" AS "resolvedAt"
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

/**
 * One task whose attempt ended with the task still OPEN, and the failure item that ending left.
 *
 * The runner it was attempted on never comes back and the reaper's sweep is what reads that:
 * `ATTEMPT_LOST_RUNNER_OFFLINE` is the one ending that leaves an item OPEN over a task that is not
 * itself FAILED, which is the state the two settling doors have to answer. A task written FAILED
 * would be the wrong fixture for either of them, and not by accident: both gates settle under
 * `status IN (OPEN, IN_PROGRESS)`, so a task that had already failed is not one they can complete.
 */
async function strandedAttempt(
  stack: Stack,
  w: World,
  label: string,
  criterion: 'EVIDENCE_JUDGMENT' | 'OWNER_CONFIRMED',
  autoRun = true,
): Promise<Attempt> {
  const lostRunner = randomUUID();
  await stack.db.runner.create({
    data: {
      id: lostRunner,
      ownerId: w.ownerId,
      name: `${label}-lost`,
      tokenHash: `hash-${lostRunner}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
    },
  });
  const a = await attempt(stack, w, label, {
    taskStatus: TaskStatus.IN_PROGRESS,
    runnerId: lostRunner,
    criterion,
    autoRun,
  });
  await sweep(stack.reaper);
  assert.equal(await taskStatus(stack.db, a.taskId), TaskStatus.OPEN, 'the task is back in the pool');
  const item = await onlyItemFor(stack.db, w, a.taskId, 'the stranded attempt left its item behind');
  assert.equal(item.kind, 'TASK_FAILED');
  assert.equal(item.state, 'OPEN');
  assert.equal(item.payload.how, 'ATTEMPT_LOST_RUNNER_OFFLINE');
  return a;
}

/** The project's one stated criterion, and the key an evidence envelope quotes it by. */
async function statedCriterion(stack: Stack, w: World, text: string): Promise<string> {
  const id = randomUUID();
  await stack.db.projectAcceptanceCriterionDefinition.create({
    data: {
      id,
      projectId: w.projectId,
      ordinal: 1,
      text,
      verificationMethod: 'the judgement door reads one CONFIRM against the current revision',
      // Written by the definition's own BEFORE trigger; the placeholder only has to satisfy the
      // column's 64-hex CHECK on the way in.
      contentHash: '0'.repeat(64),
    },
  });
  return uuidToBase62(id);
}

/** A run of ANOTHER task: the independent session a decision about this task may come from. */
async function independentRun(
  stack: Stack,
  w: World,
  label: string,
): Promise<{ taskId: string; sessionId: string }> {
  const review = await bareTask(stack, w, `${label}-review`);
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      taskId: review.taskId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title: `${label}-review`,
      prompt: 'judge the evidence',
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  return { taskId: review.taskId, sessionId };
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

/*
 * THE TWO GATES THAT WRITE DONE ON THEIR OWN
 * ==========================================
 * The evidence judgment and the owner's press in the app each settle a task inside a transaction of
 * their own, so neither goes through `TasksService.update` — and the answer to the task's open
 * exception items used to live only on that one path. A task that settled through either gate kept
 * the failure item an earlier attempt had opened: an assignee, a card in front of the owner, and a
 * promise the escalation notice had already made in so many words (the platform closes this itself
 * once the task runs again, is replaced, is cancelled, or completes). The promise was the only
 * thing missing an implementation.
 *
 * These three cases pin it where the fact is: the door that SETTLES the task answers its items,
 * whether or not that door is the one that opens them, and a door that runs without settling
 * anything answers nothing at all.
 */
const JUDGED_CRITERION =
  'the exception item a settled task left open is answered by whatever settled the task';

test('the evidence judgment settles the task, and answers the failure item an earlier attempt opened',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'judgment-settles', 'PARKED');
      const a = await strandedAttempt(stack, w, 'judgment-settles', 'EVIDENCE_JUDGMENT');
      const criterionKey = await statedCriterion(stack, w, JUDGED_CRITERION);
      await stack.db.toolCall.create({
        data: {
          sessionId: a.sessionId,
          name: 'Bash',
          toolUseId: 'toolu_stranded_judgment',
          input: { command: 'npm test -w @orbit/apiserver', description: 'the suite' },
          isError: false,
        },
      });
      await stack.evidence.submit(
        w.ownerId,
        a.taskId,
        { type: CreatorType.AGENT, id: w.workspaceId },
        {
          sourceSessionId: a.sessionId,
          evidence: {
            claim: 'the suite passed on this branch',
            criterion: { key: criterionKey, text: JUDGED_CRITERION },
            checks: [{ kind: 'TOOL_CALL', ref: 'toolu_stranded_judgment' }],
            gaps: [],
          },
        },
      );
      // Half of the negative control, inside the run that settles: submitting evidence is not
      // completing the task, and the item is exactly where it was. What closes it is the DONE.
      assert.equal(
        (await onlyItemFor(stack.db, w, a.taskId, 'nothing has settled yet')).state,
        'OPEN',
      );

      const review = await independentRun(stack, w, 'judgment-settles');
      await stack.evidence.decide(
        w.ownerId,
        a.taskId,
        { type: CreatorType.AGENT, id: w.workspaceId },
        { decidingSessionId: review.sessionId, evidenceRevision: '1', decision: 'CONFIRM' },
      );

      assert.equal(await taskStatus(stack.db, a.taskId), TaskStatus.DONE);
      const answered = await onlyItemFor(stack.db, w, a.taskId, 'the judgment settled the task');
      assert.equal(answered.state, 'RESOLVED');
      assert.equal(answered.resolution, 'TASK_DONE');
      assert.equal(answered.resolvedBy, 'PLATFORM');
      assert.ok(answered.resolvedAt, 'an answered item carries when it was answered');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the owner\'s own Confirm done settles the task, and answers the failure item an earlier attempt opened',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'owner-settles', 'PARKED');
      const a = await strandedAttempt(stack, w, 'owner-settles', 'OWNER_CONFIRMED');
      assert.equal(
        (await onlyItemFor(stack.db, w, a.taskId, 'nothing has settled yet')).state,
        'OPEN',
      );

      const receipt = await stack.confirmations.decide(
        w.ownerId,
        a.taskId,
        { door: 'USER', userId: w.ownerId },
        { decision: 'CONFIRM' },
      );

      assert.equal(receipt.completed, true, 'the owner\'s press is what settles this lane');
      assert.equal(await taskStatus(stack.db, a.taskId), TaskStatus.DONE);
      const answered = await onlyItemFor(stack.db, w, a.taskId, 'the owner settled the task');
      assert.equal(answered.state, 'RESOLVED');
      assert.equal(answered.resolution, 'TASK_DONE');
      assert.equal(answered.resolvedBy, 'PLATFORM');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('settling one task answers its item and leaves another task\'s item OPEN',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'settles-one', 'PARKED');
      const settled = await strandedAttempt(stack, w, 'settles-one', 'OWNER_CONFIRMED');
      // A second task in the same project, in the same state and with an item of its own: the
      // negative control for the fold. Resolving exceptions is keyed on the task that settled, and
      // a pass that answered every open item of the project — or answered one for the wrong task —
      // would take this one with it.
      //
      // Left out of auto-run on purpose, and it is what makes this a control rather than a race.
      // A Project RELEASES its ready tasks when something in it completes, and a task that is
      // picked up again answers its own failure item (`RETRIED`, §4.2's fourth fact) — correctly,
      // and for its own reasons. Opting this one out of auto-run keeps that second, unrelated
      // answer out of the assertion: what is being read here is whether the settling of the first
      // task reaches the second, and nothing else.
      const untouched = await strandedAttempt(stack, w, 'settles-other', 'OWNER_CONFIRMED', false);

      await stack.confirmations.decide(
        w.ownerId,
        settled.taskId,
        { door: 'USER', userId: w.ownerId },
        { decision: 'CONFIRM' },
      );

      assert.equal(await taskStatus(stack.db, settled.taskId), TaskStatus.DONE);
      assert.equal(await taskStatus(stack.db, untouched.taskId), TaskStatus.OPEN);
      assert.equal(
        (await onlyItemFor(stack.db, w, settled.taskId, 'the settled task')).state,
        'RESOLVED',
      );
      const stillOpen = await onlyItemFor(stack.db, w, untouched.taskId, 'the untouched task');
      assert.equal(stillOpen.state, 'OPEN', 'a task that is not DONE keeps its item');
      assert.equal(stillOpen.resolution, null);
      assert.equal(stillOpen.resolvedAt, null);
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

/**
 * The runner's claim, for a conversation whose queued turn has to be DELIVERED.
 *
 * `createTurn` on a conversation between turns files it PENDING, and the inbox hands a turn out
 * only to a session that is RUNNING — the claim is what makes the difference, and there is no
 * runner long-polling in this process to take it. Written here for the same reason `attempt` writes
 * the session row it starts from: the fixture stands in for the runner, not for the product.
 */
async function claimed(stack: Stack, sessionId: string): Promise<void> {
  await stack.db.session.updateMany({
    where: { id: sessionId, status: RunStatus.PENDING },
    data: { status: RunStatus.RUNNING },
  });
}

/**
 * The task goes back to work and passes its own acceptance a second time (§2.3 J-T1a).
 *
 * The doors are the two `claimedLanding` walked the first time — a message turn of the run that ends
 * SUCCEEDED is what queues the reserved shell turn, and the shell's exit code is what derives DONE —
 * over a task that has been DONE once already. That DONE transaction is what queues the task's next
 * landing generation: a task whose landing stopped is integrated again by being completed again.
 */
async function rework(stack: Stack, w: World, a: Attempt, label: string): Promise<void> {
  const asked = await stack.sessions.createTurn(w.ownerId, a.sessionId, {
    clientTurnId: randomUUID(),
    content: `${label}: the conflict is resolved on the branch`,
    intent: 'NEXT_TURN',
  });
  // The claim, then the poll: a queued turn is delivered to a RUNNING session, and a turn nobody
  // took is a turn nobody answered — completing one that was never handed out puts it back on the
  // queue rather than ending it.
  await claimed(stack, a.sessionId);
  const delivered = await dequeue(stack, a.sessionId, w.runnerId);
  assert.equal(delivered?.turnId, asked.turnId, 'the rework turn was handed to the runner');
  await answerTurn(stack, w.runnerId, a.sessionId, asked.turnId, 'the fix is pushed');
  await stack.api.turnComplete({ id: w.runnerId }, a.sessionId, {
    turnId: asked.turnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  const acceptance = await dequeue(stack, a.sessionId, w.runnerId);
  assert.equal(acceptance?.taskAcceptance, true, 'the reworked task runs its acceptance command again');
  await stack.api.turnComplete({ id: w.runnerId }, a.sessionId, {
    turnId: acceptance!.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  assert.equal(await taskStatus(stack.db, a.taskId), TaskStatus.DONE, 'the second acceptance held too');
}

/** What a runner reports for a job that landed: one tree tested and landed, as J2 demands. */
function reportLanding(stack: Stack, w: World, job: IntegrationJobCommand) {
  return reportFailure(stack, w, job, {
    state: 'LANDED',
    phase: 'PUSH',
    sourceSha: 'a'.repeat(40),
    targetShaBefore: 'c'.repeat(40),
    testedSha: 'd'.repeat(40),
    testedTreeSha: 'e'.repeat(40),
    landedSha: 'd'.repeat(40),
    landedTreeSha: 'e'.repeat(40),
    aheadOfUpstream: 1,
  });
}

test('a landing answers the conflict item an earlier generation of the same task left open',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await integratingWorld(stack, 'landed-after-conflict', 'PARKED');
      const { task, job } = await claimedLanding(stack, w, 'landed-after-conflict');
      await reportFailure(stack, w, job, {
        state: 'CONFLICT',
        phase: 'REBASE',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        conflicts: ['src/apiserver/src/projects/project-open-item.ts'],
      });
      const item = await onlyItemFor(stack.db, w, task.taskId, 'the first landing conflicted');
      assert.equal(item.state, 'OPEN');

      // The task is put back to work and passes its acceptance again, so its next generation is
      // queued by that DONE (J-T1a) — and this one lands.
      await stack.tasks.update(w.ownerId, task.taskId, { status: DeclaredTaskStatus.IN_PROGRESS });
      await rework(stack, w, task, 'landed-after-conflict');
      const [claimed] = await stack.jobs.dispatch({
        runnerId: w.runnerId,
        leaseOwner: 'lease-landed-after-conflict',
        draining: false,
        capabilities: [INTEGRATION_JOB_CLAIM],
      });
      assert.ok(claimed, `the second DONE queued no landing — ${await jobsOf(stack.db, w.projectId)}`);
      const answer = await reportLanding(stack, w, claimed!);
      assert.equal(answer.accepted, true);

      // §2.2 J-T5: the landing answers what was open about landing this task.
      const [after] = (await items(stack.db, w.projectId)).filter((row) => row.id === item.id);
      assert.equal(after?.state, 'RESOLVED', 'a landed task leaves no open integration item behind');
      assert.equal(after?.resolution, 'LANDED', 'the fact that answered it is the landing, not a retry');
      assert.equal(after?.resolvedBy, 'PLATFORM');
      assert.equal((await jobRow(stack.db, claimed!.jobId)).state, 'LANDED');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('cancelling the task closes the integration item its conflict left open',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await integratingWorld(stack, 'cancelled-after-conflict', 'PARKED');
      const { task, job } = await claimedLanding(stack, w, 'cancelled-after-conflict');
      await reportFailure(stack, w, job, {
        state: 'CONFLICT',
        phase: 'REBASE',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        conflicts: ['src/shared/src/dto.ts'],
      });
      const item = await onlyItemFor(stack.db, w, task.taskId, 'the landing conflicted');
      assert.equal(item.state, 'OPEN');

      await stack.tasks.update(w.ownerId, task.taskId, { status: DeclaredTaskStatus.CANCELLED });

      const [after] = (await items(stack.db, w.projectId)).filter((row) => row.id === item.id);
      assert.equal(after?.state, 'RESOLVED', 'a task nobody is going to land any more leaves no item');
      assert.equal(after?.resolution, 'TASK_CLOSED');
      assert.equal(after?.resolvedBy, 'PLATFORM');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the message an integration item is delivered as carries what its payload knows',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // A conflict: the file names are the one thing a reader acts on, and they live in the payload.
      const conflicted = await integratingWorld(stack, 'message-conflict', 'PARKED');
      const first = await claimedLanding(stack, conflicted, 'message-conflict');
      await reportFailure(stack, conflicted, first.job, {
        state: 'CONFLICT',
        phase: 'REBASE',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        conflicts: ['src/shared/src/dto.ts', 'src/apiserver/src/projects/project-open-item.ts'],
      });
      const item = await onlyItemFor(stack.db, conflicted, first.task.taskId, 'the landing conflicted');
      const [sent] = await itemTurns(stack.db, conflicted.coordinatorSessionId!);
      assert.ok(sent, 'the item was not queued on the coordinator');
      assert.ok(sent.content?.includes(item.title), 'the message does not even say what the exception is');
      for (const file of ['src/shared/src/dto.ts', 'src/apiserver/src/projects/project-open-item.ts']) {
        assert.ok(
          sent.content?.includes(file),
          `the message does not name the file the merge conflicted on: ${file} — ${sent.content}`,
        );
      }

      // A red check: which check disagreed, and what it returned.
      const checked = await integratingWorld(stack, 'message-check', 'PARKED');
      const second = await claimedLanding(stack, checked, 'message-check');
      await reportFailure(stack, checked, second.job, {
        state: 'CHECK_FAILED',
        phase: 'CHECK',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        testedSha: 'd'.repeat(40),
        testedTreeSha: 'e'.repeat(40),
        checks: [{
          name: 'MERGE_CHECK',
          command: 'npm test',
          expectedExitCode: 0,
          exitCode: 2,
          timedOut: false,
          durationMs: 10,
          outputTail: 'not ok 3 - the dto changed under it',
        }],
      });
      const [reported] = await itemTurns(stack.db, checked.coordinatorSessionId!);
      assert.ok(reported, 'the item was not queued on the coordinator');
      assert.ok(
        reported.content?.includes('MERGE_CHECK 的退出码是 2'),
        `the message does not say which check failed and what it returned — ${reported.content}`,
      );
      assert.ok(
        reported.content?.includes('not ok 3 - the dto changed under it'),
        'the check\'s own output is in the payload and not in the message',
      );

      // And an error: the code is all the payload has to say.
      const errored = await integratingWorld(stack, 'message-error', 'PARKED');
      const third = await claimedLanding(stack, errored, 'message-error');
      await reportFailure(stack, errored, third.job, {
        state: 'ERROR',
        phase: 'PUSH',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        errorCode: 'PUSH_REJECTED',
        errorDetail: { reason: 'the remote refused a non-fast-forward push' },
      });
      const [failed] = await itemTurns(stack.db, errored.coordinatorSessionId!);
      assert.ok(failed, 'the item was not queued on the coordinator');
      assert.ok(
        failed.content?.includes('PUSH_REJECTED'),
        `the message does not say what the error was — ${failed.content}`,
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an integration item survives a task write that is not one of its terminal facts',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // The control, green before and after the change on purpose: it is what says the harness runs
      // at all, and it holds the new branch to the X table — an item about a landing nobody has
      // called off is answered by the landing, and by nothing less than it.
      const w = await integratingWorld(stack, 'kept-open', 'PARKED');
      const { task, job } = await claimedLanding(stack, w, 'kept-open');
      await reportFailure(stack, w, job, {
        state: 'CONFLICT',
        phase: 'MAIN_SYNC',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        conflicts: ['README.md'],
      });
      const item = await onlyItemFor(stack.db, w, task.taskId, 'the landing conflicted');
      assert.equal(item.state, 'OPEN');

      // An ordinary edit is a task write, and every task write re-derives the project's items.
      await stack.tasks.update(w.ownerId, task.taskId, { title: `${task.title} (edited)` });

      const [after] = (await items(stack.db, w.projectId)).filter((row) => row.id === item.id);
      assert.equal(after?.state, 'OPEN', 'a task that is still to be landed keeps its open item');
      assert.equal(after?.resolution, null);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an item a job with no task opened still reaches the coordinator', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    // The one job that names no task is a promotion's (§3.4): `queuePromotionJob` writes `task_id`
    // NULL deliberately, because a promotion is not any single task's landing. So the item such a
    // job's failure opens names no task either — and `deliverForTasks`, which finds items by task,
    // is a read that can never find it.
    const w = await integratingWorld(stack, 'orphan-job', 'PARKED');
    const { job } = await claimedLanding(stack, w, 'orphan-job');
    const landed = await reportLanding(stack, w, job);
    assert.equal(landed.accepted, true, 'the landing that leaves something to promote');

    const candidate = await stack.promotions.considerCandidate(w.projectId);
    assert.ok(
      candidate,
      `the landing left no candidate, so no job without a task was queued — ${await jobsOf(stack.db, w.projectId)}`,
    );
    const claimed = await stack.jobs.dispatch({
      runnerId: w.runnerId,
      leaseOwner: 'lease-orphan-job',
      draining: false,
      capabilities: [INTEGRATION_JOB_CLAIM],
    });
    assert.equal(claimed.length, 1, `the promotion check was not handed out — ${await jobsOf(stack.db, w.projectId)}`);
    assert.equal(claimed[0]!.kind, 'CHECK_PROMOTION', 'the job that names no task is the promotion\'s');

    const answer = await reportFailure(stack, w, claimed[0]!, {
      state: 'ERROR',
      phase: 'CHECK',
      sourceSha: 'a'.repeat(40),
      targetShaBefore: 'c'.repeat(40),
      errorCode: 'REBASE_FAILED',
      errorDetail: { reason: 'the project branch would not rebase onto the upstream tip' },
    });
    assert.equal(answer.accepted, true);

    const [item] = (await items(stack.db, w.projectId)).filter((row) => row.kind === 'INTEGRATION_ERROR');
    assert.ok(item, `the job opened no item — ${await jobsOf(stack.db, w.projectId)}`);
    assert.equal(item.taskId, null, 'the job it is about names no task at all');
    assert.equal(answer.openItemId, item.id, 'the result names the item it opened');
    assert.deepEqual(
      (await itemTurns(stack.db, w.coordinatorSessionId!)).map((t) => t.clientTurnId),
      [turnKey(item)],
      'an item no task can be found by is owed the same delivery as any other',
    );
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

/**
 * §4.7's one owner door onto an item: sending an escalated one back.
 *
 * The item is produced the way it really becomes the owner's — a failure opens it with the
 * coordinator, and the project's own clock hands it over — rather than by writing `assignee` here,
 * so what the door is measured against is the state a reader of the card would be looking at.
 */
/** The project's own escalation clock, run by hand: one tick, after the window is spent. */
async function escalate(stack: Stack, w: World, a: Attempt): Promise<ItemRow> {
  const opened = await onlyItemFor(stack.db, w, a.taskId, 'the failure opened one item');
  assert.equal(opened.assignee, 'COORDINATOR');
  assert.ok(opened.escalateAt, 'a coordinator item is opened with the project\'s window on it');
  await stack.db.$executeRaw(
    Prisma.sql`UPDATE "project_open_item" SET "escalate_at" = now() - interval '1 minute'
                WHERE "id" = ${opened.id}::uuid`,
  );
  const swept = await new ProjectOpenItemEscalationService(
    stack.db as unknown as PrismaService,
  ).sweep();
  assert.deepEqual(swept.map((row) => row.itemId), [opened.id]);
  const item = (await items(stack.db, w.projectId)).find((row) => row.id === opened.id)!;
  assert.equal(item.assignee, 'OWNER');
  assert.equal(item.assigneeReason, 'ESCALATED');
  assert.ok(item.escalatedAt, 'the clock is what put it here');
  return item;
}

async function refusalOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConflictException) {
      return (error.getResponse() as { code?: string }).code;
    }
    throw error;
  }
  return undefined;
}

/**
 * §4.7's second terminal door onto an item: its assignee closes it, saying why.
 *
 * Read through an optional shape, for the reason the file's header gives: on a tree without the door
 * every case below has to fail on an assertion rather than on `tsc`, and `typeof` on a missing
 * method is exactly the red that names what is missing.
 */
interface ResolveDoor {
  resolveOpenItem?: (
    ownerId: string,
    projectId: string,
    itemId: string,
    given: { note: string },
    actor: { kind: 'OWNER' } | { kind: 'SESSION'; sessionId: string },
  ) => Promise<{ itemId: string; state: string; resolution: string }>;
}

/** The status and the code a refusal carries, from whichever HTTP shape it was thrown in. */
async function denied(run: () => Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
  const thrown = await run().then(() => null, (error: unknown) => error);
  assert.ok(thrown instanceof HttpException, `the door answered instead of refusing: ${thrown}`);
  const body = thrown.getResponse();
  const shaped = typeof body === 'string' ? { message: body } : (body as { code?: string; message?: string });
  return { status: thrown.getStatus(), code: shaped.code, message: shaped.message ?? '' };
}

/** One door, called by whoever is pressing it: the owner in the app, or the item's coordinator. */
function door(stack: Stack): (
  w: World,
  itemId: string,
  actor: { kind: 'OWNER' } | { kind: 'SESSION'; sessionId: string },
  note: string,
) => Promise<{ itemId: string; state: string; resolution: string }> {
  const items = stack.openItems as unknown as ResolveDoor;
  assert.equal(
    typeof items.resolveOpenItem,
    'function',
    'the assignee of an item needs a door to close it through (§4.7: nothing else can end an '
      + 'integration item whose work was landed off the line)',
  );
  return (w, itemId, actor, note) => items.resolveOpenItem!(w.ownerId, w.projectId, itemId, { note }, actor);
}

/** The item as it stands now, read the way every other case in this file reads one. */
async function itemNow(stack: Stack, w: World, itemId: string): Promise<ItemRow> {
  const row = (await items(stack.db, w.projectId)).find((candidate) => candidate.id === itemId);
  assert.ok(row, `item ${itemId} is gone from the project`);
  return row;
}

/** A landing the runner reported as conflicted, which is the item this whole door exists for. */
async function conflictedLanding(
  stack: Stack,
  label: string,
): Promise<{ w: World; task: Attempt; item: ItemRow }> {
  const w = await integratingWorld(stack, label, 'PARKED');
  const { task, job } = await claimedLanding(stack, w, label);
  await reportFailure(stack, w, job, {
    state: 'CONFLICT',
    phase: 'REBASE',
    sourceSha: 'a'.repeat(40),
    targetShaBefore: 'c'.repeat(40),
    conflicts: ['src/apiserver/src/projects/project-open-item.ts'],
  });
  const item = await onlyItemFor(stack.db, w, task.taskId, 'the landing conflicted');
  assert.equal(item.assignee, 'COORDINATOR');
  return { w, task, item };
}

/**
 * The coordinator closing a conflict it has already dealt with by hand.
 *
 * This is the case the door exists for, and it is the one the platform cannot decide for itself:
 * the work was landed by the coordinator's own replay (cherry-pick then a fast-forward), so the
 * task's branch tip is not an ancestor of anything and no job will ever report a landing for it.
 * What closes the item is the assignee saying so — with a reason, on the row, for whoever reads it.
 */
test('the coordinator closes a conflicting landing it handled, and the reason and the actor stay on the row',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const { w, item } = await conflictedLanding(stack, 'handled');
      const note = '已在集成线上：这批工作是协调会话自己重放落地的（cherry-pick + ff），'
        + '集成线重放同一条分支才会与 main 上那份内容相撞，没有东西要再集成一次';

      const closed = await door(stack)(w, item.id, { kind: 'SESSION', sessionId: w.coordinatorSessionId! }, note);
      assert.equal(closed.state, 'RESOLVED');
      assert.equal(closed.resolution, 'HANDLED', '§4.2: a hand-closed item reads HANDLED');

      const after = await itemNow(stack, w, item.id);
      assert.equal(after.state, 'RESOLVED');
      assert.equal(after.resolution, 'HANDLED');
      assert.equal(after.resolvedBy, 'COORDINATOR', 'the row says which side ended it');
      assert.equal(after.resolvedBySessionId, w.coordinatorSessionId, 'and which conversation');
      assert.equal(after.resolvedByUserId, null);
      assert.equal(after.resolutionNote, note, 'the reason is the audit trail §4.7 asks for');
      assert.ok(after.resolvedAt, 'and when');

      // The reader's view is what a card is drawn from, and the card is gone: the item is neither
      // waiting for the owner nor the coordinator's any more.
      const open = await stack.openItems.list(w.ownerId, w.projectId);
      assert.deepEqual(
        [...open.needsYou, ...open.withCoordinator].filter((row) => row.itemId === item.id),
        [],
        'a closed item is not on anybody\'s card',
      );
      // The delivery it was queued with is left exactly as it was: the turn in the coordinator's
      // conversation is the record of what it was told, and retracting a message already read is
      // not something a door can do.
      assert.equal((await itemTurns(stack.db, w.coordinatorSessionId!)).length, 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('nobody but the assignee closes an item: a stranger session and the owner\'s are both refused',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const { w, task, item } = await conflictedLanding(stack, 'not-assignee');
      const other = await integratingWorld(stack, 'not-assignee-elsewhere', 'PARKED');

      for (const [what, actor] of [
        ['the run that produced the branch', { kind: 'SESSION' as const, sessionId: task.sessionId }],
        ['another project\'s coordinator', { kind: 'SESSION' as const, sessionId: other.coordinatorSessionId! }],
      ] as const) {
        const refused = await denied(() => door(stack)(w, item.id, actor, 'nothing to do with me'));
        assert.equal(refused.status, 403, `${what} may not close this project's item`);
        assert.equal(refused.code, 'OPEN_ITEM_COORDINATOR_ONLY');
      }

      const after = await itemNow(stack, w, item.id);
      assert.equal(after.state, 'OPEN', 'a refusal closes nothing');
      assert.equal(after.resolution, null);
      assert.equal(after.resolutionNote, null, 'and writes no reason on a row nobody ended');
      assert.equal((await itemTurns(stack.db, w.coordinatorSessionId!)).length, 1, 'and queues no turn');

      // The clock can move an item out from under the conversation that was carrying it (§4.6
      // X-E1): once it is the owner's, the coordinator's press is the wrong one — the assignee the
      // door follows is the assignment the row has NOW.
      const escalated = await world(stack, 'not-assignee-escalated', 'PARKED');
      const started = await attempt(stack, escalated, 'not-assignee-escalated', { taskStatus: TaskStatus.IN_PROGRESS });
      await failTurn(stack, escalated, started);
      const ownerItem = await escalate(stack, escalated, started);
      const refused = await denied(() => door(stack)(escalated, ownerItem.id, {
        kind: 'SESSION',
        sessionId: escalated.coordinatorSessionId!,
      }, 'I am not the one holding this'));
      assert.equal(refused.status, 409);
      assert.equal(refused.code, 'OPEN_ITEM_NOT_COORDINATOR_ITEM');
      assert.equal((await itemNow(stack, escalated, ownerItem.id)).state, 'OPEN');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an item that has already ended keeps the ending it got, and cannot be rewritten by hand',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // Ended by a platform fact first — the task was cancelled, so nobody is going to land it
      // (§4.2) — and then pressed by the conversation that was carrying it.
      const { w, task, item } = await conflictedLanding(stack, 'already-ended');
      await stack.tasks.update(w.ownerId, task.taskId, { status: DeclaredTaskStatus.CANCELLED });
      const ended = await itemNow(stack, w, item.id);
      assert.equal(ended.resolution, 'TASK_CLOSED', 'the platform ended it on the task fact');

      const refused = await denied(() => door(stack)(w, item.id, {
        kind: 'SESSION',
        sessionId: w.coordinatorSessionId!,
      }, '说清楚为什么关掉它'));
      assert.equal(refused.status, 409);
      assert.equal(refused.code, 'OPEN_ITEM_NOT_OPEN');

      const after = await itemNow(stack, w, item.id);
      assert.equal(after.resolution, 'TASK_CLOSED', 'the ending it already had is the one it keeps');
      assert.equal(after.resolvedBy, 'PLATFORM');
      assert.equal(after.resolutionNote, null, 'and a second press does not write its reason over it');
      assert.equal(after.resolvedAt!.getTime(), ended.resolvedAt!.getTime());

      // The same for an item this door closed itself: one ending, and the row keeps it.
      const second = await conflictedLanding(stack, 'already-ended-twice');
      const close = door(stack);
      await close(second.w, second.item.id, {
        kind: 'SESSION',
        sessionId: second.w.coordinatorSessionId!,
      }, '第一次按下时说的理由');
      const again = await denied(() => close(second.w, second.item.id, {
        kind: 'SESSION',
        sessionId: second.w.coordinatorSessionId!,
      }, '第二次按下时说的理由'));
      assert.equal(again.code, 'OPEN_ITEM_NOT_OPEN');
      const kept = await itemNow(stack, second.w, second.item.id);
      assert.equal(kept.resolutionNote, '第一次按下时说的理由');
      assert.equal(kept.resolvedBy, 'COORDINATOR');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the coordinator withdraws its own question, and a question is not another session\'s to close',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'withdraw', 'PARKED');
      const asked = await stack.openItems.askOwner(w.ownerId, w.projectId, w.coordinatorSessionId!, {
        question: 'Two ready tasks both rewrite session_pool.go. Which one starts first?',
        clientQuestionId: 'withdraw-1',
      });
      const question = await itemNow(stack, w, asked.itemId);
      assert.equal(question.assignee, 'OWNER', 'a question is the owner\'s');
      assert.equal(question.dedupeKey, 'CQ:withdraw-1');

      // A stranger: the question is not a session's to end, and certainly not one that did not ask it.
      const bystander = await attempt(stack, w, 'withdraw', { taskStatus: TaskStatus.IN_PROGRESS });
      const refused = await denied(() => door(stack)(w, asked.itemId, {
        kind: 'SESSION',
        sessionId: bystander.sessionId,
      }, 'someone else\'s question'));
      assert.equal(refused.status, 409);
      assert.equal(refused.code, 'OPEN_ITEM_NOT_COORDINATOR_ITEM');
      assert.equal((await itemNow(stack, w, asked.itemId)).state, 'OPEN');

      // The one that asked it withdraws it (§5.2 R12), which is the one ending of a question that
      // is not the owner's answer.
      const withdrawn = await door(stack)(w, asked.itemId, {
        kind: 'SESSION',
        sessionId: w.coordinatorSessionId!,
      }, '自己搞清楚了：两条都改同一个文件，先起 t4');
      assert.equal(withdrawn.resolution, 'WITHDRAWN');
      const after = await itemNow(stack, w, asked.itemId);
      assert.equal(after.state, 'RESOLVED');
      assert.equal(after.resolvedBy, 'COORDINATOR');
      assert.equal(after.resolvedBySessionId, w.coordinatorSessionId);
      assert.equal(after.resolutionNote, '自己搞清楚了：两条都改同一个文件，先起 t4');
      const open = await stack.openItems.list(w.ownerId, w.projectId);
      assert.deepEqual(open.needsYou.filter((row) => row.itemId === asked.itemId), [], 'the card is gone');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the reason is required: a press with no note writes nothing', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const { w, item } = await conflictedLanding(stack, 'note-required');
    for (const note of ['', '   ', '\n\t ']) {
      const refused = await denied(() => door(stack)(w, item.id, {
        kind: 'SESSION',
        sessionId: w.coordinatorSessionId!,
      }, note));
      assert.equal(refused.status, 400, `a note of ${JSON.stringify(note)} is not a reason`);
    }
    const after = await itemNow(stack, w, item.id);
    assert.equal(after.state, 'OPEN', 'a press without a reason ends nothing');
    assert.equal(after.resolutionNote, null);
  } finally {
    await stack.db.$disconnect();
  }
});

test('the owner closes what is theirs, and the two kinds that have a press of their own are not closed by hand',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // The owner's press on an item the clock handed them (§4.6 X-E1): resolved_by USER, and the
      // row keeps both the reason and that it was a person rather than a conversation.
      const escalated = await world(stack, 'owner-closes', 'PARKED');
      const started = await attempt(stack, escalated, 'owner-closes', { taskStatus: TaskStatus.IN_PROGRESS });
      await failTurn(stack, escalated, started);
      const owned = await escalate(stack, escalated, started);
      const closed = await door(stack)(escalated, owned.id, { kind: 'OWNER' }, '看过了：这条失败是环境问题，重跑一次即可');
      assert.equal(closed.state, 'RESOLVED');
      assert.equal(closed.resolution, 'HANDLED');
      const after = await itemNow(stack, escalated, owned.id);
      assert.equal(after.resolvedBy, 'USER');
      assert.equal(after.resolvedByUserId, escalated.ownerId);
      assert.equal(after.resolvedBySessionId, null);
      assert.equal(after.resolutionNote, '看过了：这条失败是环境问题，重跑一次即可');

      // A promotion's card is the owner's to CONFIRM or DECLINE, and a pause is theirs to resume.
      // Closing either by hand would leave what it is about undecided with no card in front of
      // anybody, so the door refuses and names the press that does it (§4.2's per-kind endings).
      const promoted = await integratingWorld(stack, 'promotion-card', 'PARKED');
      const { job } = await claimedLanding(stack, promoted, 'promotion-card');
      await reportLanding(stack, promoted, job);
      const candidate = await stack.promotions.considerCandidate(promoted.projectId);
      assert.ok(candidate, `the landing left no candidate to promote — ${await jobsOf(stack.db, promoted.projectId)}`);
      const [check] = await stack.jobs.dispatch({
        runnerId: promoted.runnerId,
        leaseOwner: 'lease-promotion-card',
        draining: false,
        capabilities: [INTEGRATION_JOB_CLAIM],
      });
      assert.equal(check?.kind, 'CHECK_PROMOTION');
      const readied = await reportFailure(stack, promoted, check!, {
        state: 'READY',
        phase: 'CHECK',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        upstreamSha: 'f'.repeat(40),
        testedSha: 'd'.repeat(40),
        testedTreeSha: 'e'.repeat(40),
        aheadOfUpstream: 1,
        filesChanged: 3,
        checks: [],
      });
      assert.equal(readied.accepted, true);
      const card = (await items(stack.db, promoted.projectId)).find((row) => row.kind === 'PROMOTION_APPROVAL');
      assert.ok(card, `the passing check opened no approval card — ${await jobsOf(stack.db, promoted.projectId)}`);
      assert.equal(card.assignee, 'OWNER');

      const refused = await denied(() => door(stack)(promoted, card.id, { kind: 'OWNER' }, '不打算合了'));
      assert.equal(refused.status, 409);
      assert.equal(refused.code, 'OPEN_ITEM_HAS_ITS_OWN_DOOR');
      const kept = await itemNow(stack, promoted, card.id);
      assert.equal(kept.state, 'OPEN', 'the card is still in front of the owner, undecided');
      assert.equal(kept.resolutionNote, null);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('hands it back with the window restarted, and queues it on the coordinator afresh',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'return-back', 'PARKED');
      const a = await attempt(stack, w, 'return-back', { taskStatus: TaskStatus.IN_PROGRESS });
      await failTurn(stack, w, a);
      const before = await escalate(stack, w, a);
      const project = await stack.db.project.findUniqueOrThrow({
        where: { id: w.projectId },
        select: { exceptionEscalationSeconds: true },
      });

      const returned = await stack.openItems.returnToCoordinator(w.ownerId, w.projectId, before.id);
      assert.equal(returned.assignee, 'COORDINATOR');

      const after = (await items(stack.db, w.projectId)).find((row) => row.id === before.id)!;
      assert.equal(after.state, 'OPEN', 'nothing about it ended — the coordinator has it again');
      assert.equal(after.assignee, 'COORDINATOR');
      assert.equal(after.assigneeReason, 'DEFAULT', 'it is not anybody\'s exception now');
      assert.equal(after.escalatedAt, null);
      assert.ok(after.waitingSince.getTime() >= before.waitingSince.getTime());
      assert.ok(
        after.assignedAt.getTime() > before.assignedAt.getTime(),
        'the assignment moved, which is what makes the delivery a new turn',
      );
      // The clock the project set, restarted rather than kept: the two hours it already spent
      // are the ones that ran out (§4.6 X-E2).
      assert.equal(
        after.escalateAt!.getTime() - after.waitingSince.getTime(),
        project.exceptionEscalationSeconds * 1_000,
      );

      const turns = await itemTurns(stack.db, w.coordinatorSessionId!);
      const fresh = turns.filter(
        (turn) => turn.clientTurnId === `open-item:v1:${before.id}:${after.assignedAt.getTime()}`,
      );
      assert.equal(fresh.length, 1, 'the item was not queued on the coordinator again');
      assert.equal(fresh[0]!.status, 'PENDING');
      assert.match(fresh[0]!.content ?? '', new RegExp(`Task failed: ${a.title}`));
      const sent = (await deliveries(stack.db, w.projectId)).filter((row) => row.itemId === before.id);
      assert.equal(sent.length, 1, 'one item, one delivery row — re-armed, not duplicated');
      assert.equal(sent[0]!.clientTurnId, fresh[0]!.clientTurnId);
      assert.equal(sent[0]!.returnedAt, null);
      assert.equal(
        (await stack.db.session.findUniqueOrThrow({ where: { id: w.coordinatorSessionId! } })).status,
        RunStatus.PENDING,
        'a parked coordinator is woken for it',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('hands it back to a coordinator that is SWITCHED OFF, because the press is the owner\'s own',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // The account owner's report, 2026-09-22: a project confirmed but never started — a live,
      // bound coordinator conversation, the switch off, and its exceptions handed to the owner
      // because the platform had nowhere to put them. The card offered no way back, and the
      // switch's only door is the web project page.
      const w = await world(stack, 'return-switched-off', 'PARKED', { coordinatorEnabled: false });
      const a = await attempt(stack, w, 'return-switched-off', { taskStatus: TaskStatus.IN_PROGRESS });
      await failTurn(stack, w, a);
      const item = await onlyItemFor(stack.db, w, a.taskId, 'the failure opened one item');
      assert.equal(item.assignee, 'OWNER');
      assert.equal(item.assigneeReason, 'NO_COORDINATOR',
                   'the switch, not the clock, is what put it on the owner');

      // (1) The card is offered the press at all. `askable` is about there being a conversation —
      //     the same fact the count, the session row and the badge are drawn by.
      const view = await stack.openItems.list(w.ownerId, w.projectId);
      const row = view.needsYou.find((one) => one.itemId === item.id);
      assert.ok(row, 'the item is in the owner\'s group');
      assert.ok(row!.actions.includes('ASK_COORDINATOR_AGAIN'),
                'the door is offered rather than hidden');

      // (2) And it works: the item goes back to the conversation and is queued there afresh,
      //     rather than landing back on the owner on `deliver`'s next line.
      const returned = await stack.openItems.returnToCoordinator(w.ownerId, w.projectId, item.id);
      assert.equal(returned.assignee, 'COORDINATOR');
      const after = (await items(stack.db, w.projectId)).find((one) => one.id === item.id)!;
      assert.equal(after.assignee, 'COORDINATOR', 'the hand-back did not bounce back to the owner');
      assert.equal(after.assigneeReason, 'DEFAULT');
      const fresh = (await itemTurns(stack.db, w.coordinatorSessionId!)).filter(
        (turn) => turn.clientTurnId === `open-item:v1:${item.id}:${after.assignedAt.getTime()}`,
      );
      assert.equal(fresh.length, 1, 'the item was put in front of the conversation');
      assert.equal(fresh[0]!.status, 'PENDING');

      // (3) Nothing else moved: the press is one item, not an authorization. The project is still
      //     switched off, so nothing automatic starts reaching a coordinator that may not act.
      const project = await stack.db.project.findUniqueOrThrow({
        where: { id: w.projectId },
        select: { coordinatorEnabled: true },
      });
      assert.equal(project.coordinatorEnabled, false, 'the press did not start the project');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('refuses a second press: the item is the coordinator\'s again',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'return-twice', 'PARKED');
      const a = await attempt(stack, w, 'return-twice', { taskStatus: TaskStatus.IN_PROGRESS });
      await failTurn(stack, w, a);
      const item = await escalate(stack, w, a);

      await stack.openItems.returnToCoordinator(w.ownerId, w.projectId, item.id);
      // What the hand-back itself left, before anything is pressed twice.
      const returned = (await items(stack.db, w.projectId)).find((row) => row.id === item.id)!;
      // Told afresh, under the assignment the hand-back just made (X-D2) — so the conversation
      // holds the delivery the item was opened with and this one. That count is what the refusal
      // below is measured against.
      const queued = await itemTurns(stack.db, w.coordinatorSessionId!);
      assert.equal(queued.length, 2);

      assert.equal(
        await refusalOf(() => stack.openItems.returnToCoordinator(w.ownerId, w.projectId, item.id)),
        'OPEN_ITEM_ALREADY_COORDINATORS',
      );

      const after = (await items(stack.db, w.projectId)).find((row) => row.id === item.id)!;
      assert.equal(after.assignee, 'COORDINATOR');
      assert.equal(
        after.assignedAt.getTime(),
        returned.assignedAt.getTime(),
        'the refusal moved nothing',
      );
      // The refusal answered a state that had already moved, and queued nothing behind it.
      assert.equal((await itemTurns(stack.db, w.coordinatorSessionId!)).length, queued.length);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('refuses when there is no coordinator conversation to hand it to',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // X-D6: a project with nobody coordinating it opens the item on the owner in the first
      // place, which is exactly the item this press would be offering to hand back.
      const w = await world(stack, 'return-none', 'NONE');
      const a = await attempt(stack, w, 'return-none', { taskStatus: TaskStatus.IN_PROGRESS });
      await failTurn(stack, w, a);
      const item = await onlyItemFor(stack.db, w, a.taskId, 'the failure opened one item');
      assert.equal(item.assignee, 'OWNER');
      assert.equal(item.assigneeReason, 'NO_COORDINATOR');

      assert.equal(
        await refusalOf(() => stack.openItems.returnToCoordinator(w.ownerId, w.projectId, item.id)),
        'OPEN_ITEM_NO_COORDINATOR',
      );

      const after = (await items(stack.db, w.projectId)).find((row) => row.id === item.id)!;
      assert.equal(after.assignee, 'OWNER', 'nothing moved, so nothing was promised');
      assert.equal(after.waitingSince.getTime(), item.waitingSince.getTime());
    } finally {
      await stack.db.$disconnect();
    }
  });

test('refuses when the coordinator conversation has ended',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'return-ended', 'COMPLETED');
      const a = await attempt(stack, w, 'return-ended', { taskStatus: TaskStatus.IN_PROGRESS });
      await failTurn(stack, w, a);
      const item = await onlyItemFor(stack.db, w, a.taskId, 'the failure opened one item');
      assert.equal(item.assignee, 'OWNER');
      assert.equal(item.assigneeReason, 'COORDINATOR_ENDED');

      assert.equal(
        await refusalOf(() => stack.openItems.returnToCoordinator(w.ownerId, w.projectId, item.id)),
        'OPEN_ITEM_NO_COORDINATOR',
      );
      assert.equal(
        (await items(stack.db, w.projectId)).find((row) => row.id === item.id)!.assignee,
        'OWNER',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the open-item PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
