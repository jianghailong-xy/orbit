/**
 * "Does this project move" is started and not paused — asserted against real PostgreSQL.
 *
 * A project's tasks start by themselves only while its owner has started it (`started_at`, 0331)
 * and has not paused it (`paused_at`, 0334). Every automatic door is held to that one answer
 * (`project-pause-dispatch.ts`): the release of a task that depends on nothing, a prerequisite
 * finishing — the instant path and the sweep — a schedule coming due, and the retry policy; an
 * agent's `task_start` is refused, and Automatic merges nothing into main. The owner's own Run is
 * not held, and Automatic (`coordinator_enabled`) is no longer the switch: a started project that
 * is not paused releases its independent tasks whichever way Automatic is set.
 *
 * WHAT DRIVES EACH CASE. The doors themselves, never a SQL fragment: a DONE is written by the
 * owner's Confirm done (`TaskOwnerConfirmationService.decide`), which is a production completion
 * edge; the sweeps run as the service's one timer calls them; `task_start` is the runner's
 * controller; the owner's Run is `TasksService.execute` as `TasksController` calls it; the merge is
 * the runner's heartbeat and result routes; pause, resume and the older Automatic switch are the
 * owner's HTTP doors, through the real controller, pipe and interceptor.
 *
 * EVERY REFUSAL HAS A TWIN THAT MOVES. The projects of one case differ in the one fact under test —
 * not started, paused, moving with Automatic on, moving with Automatic off — and are driven through
 * the same door in the same run, so a door that started everything and one that started nothing
 * both fail. And every held fixture is then started or resumed and driven again: the same tasks
 * start, so what held them was the project and nothing else.
 *
 * "Never offered" is asserted on the run door's receipts, not only on sessions: the door opens its
 * receipt before any of its own gates, so a scan that selected a held task and was refused further
 * down would leave one.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/project-pause-dispatch.pg.spec.ts
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import {
  IntegrationCheckResult,
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  RunEventType,
  RunStatus as SharedRunStatus,
  uuidToBase62,
} from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorDeliveryService } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectFuseService } from '../projects/project-fuse.service';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND } from '../projects/project-integration-job';
import { configureProjectIntegration } from '../projects/project-integration-line';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { ProjectPromotionService } from '../projects/project-promotion.service';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { ProjectsController } from '../projects/projects.controller';
import { ProjectsService } from '../projects/projects.service';
import { SessionAttemptService } from '../projects/session-attempt.service';
import { TaskCheckpointService } from '../projects/task-checkpoint.service';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerTasksController } from '../runner-api/runner-tasks.controller';
import { SessionsService } from '../sessions/sessions.service';
import { AUTO_RUN_RETRY_BACKOFF_MS } from './task-retry-policy';
import { TaskOwnerConfirmationService } from './task-owner-confirmation.service';
import { TasksService } from './tasks.service';

declare global {
  interface BigInt { toJSON(): string; }
}
// `main.ts` installs this before it creates the app, and a project response needs it: Prisma maps
// `project.config_revision` to a native BigInt, which `JSON.stringify` throws on. Without it every
// PATCH below answers 500 — a real server-shaped failure, but not the one under test.
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0334_project_paused/migration.sql'),
  'utf8',
);

// ── the world ─────────────────────────────────────────────────────────────────────────────────────

/** What one control-plane publish said. */
interface Published {
  ownerId: string;
  type: RunEventType;
  id: string;
}

interface Services {
  db: PrismaClient;
  tasks: TasksService;
  projects: ProjectsService;
  acceptance: ProjectAcceptanceService;
  confirmations: TaskOwnerConfirmationService;
  runnerTasks: RunnerTasksController;
  /** What `TasksService.now` answers — the instant the retry policy decides against. */
  clock: { now: Date };
  /** Every owner-scoped publish, in order. */
  published: Published[];
}

/** A realtime service that records the owner-scoped publishes and answers everything else inertly. */
function recordingRealtime(published: Published[]): RealtimeService {
  return new Proxy({}, {
    get: (_target, name) => name === 'publishForUser'
      ? (ownerId: string, type: RunEventType, id: string) => void published.push({ ownerId, type, id })
      : () => undefined,
  }) as unknown as RealtimeService;
}

function connect(): Services {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const published: Published[] = [];
  const realtime = recordingRealtime(published);
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    realtime,
  );
  const tasks = new TasksService(prisma, sessions, realtime);
  const clock = { now: new Date() };
  (tasks as unknown as { now: () => Date }).now = () => clock.now;
  const acceptance = new ProjectAcceptanceService(prisma, sessions);
  return {
    db,
    tasks,
    projects: new ProjectsService(prisma, acceptance, sessions, realtime),
    acceptance,
    confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime),
    runnerTasks: new RunnerTasksController(tasks, {} as never, {} as never),
    clock,
    published,
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

/** An owner with one online runner, room for every run a case starts, and a workspace on it. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@pause.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(),
      // Room for every start a case makes, so "not started" can only mean the gate under test.
      maxConcurrent: 64,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-agent`,
      enabled: true,
    },
  });
  return ids;
}

/**
 * How a project stands. Automatic is ON in the two held ones: whatever holds them back, it is not
 * the Automatic switch — and the fourth one is moving with Automatic OFF.
 */
type Motion = 'UNSTARTED' | 'PAUSED' | 'MOVING' | 'MOVING_AUTOMATIC_OFF';

const HELD: readonly Motion[] = ['UNSTARTED', 'PAUSED'];
const MOVES: readonly Motion[] = ['MOVING', 'MOVING_AUTOMATIC_OFF'];

/**
 * A project with a real completion contract (one criterion, so an unstarted one is waiting on its
 * owner's start card) and room for eight tasks. Started ones carry a start; the paused one is then
 * paused through the owner's own door.
 */
async function project(s: Services, ids: World, label: string, motion: Motion): Promise<string> {
  const projectId = randomUUID();
  await s.db.project.create({
    data: {
      id: projectId, ownerId: ids.ownerId, title: `${label}-${RUN}`,
      coordinatorEnabled: motion !== 'MOVING_AUTOMATIC_OFF',
      maxConcurrentTasks: 8,
      ...(motion === 'UNSTARTED' ? {} : { startedAt: new Date() }),
    },
  });
  await establishProjectContractForPgTest(s.db, ids.ownerId, projectId, `${label}-${RUN}`);
  if (motion === 'PAUSED') {
    const paused = await s.projects.pause(ids.ownerId, projectId);
    assert.equal(paused.pausedReason, 'OWNER');
  }
  return projectId;
}

/** Four projects, one per motion. */
async function projects(s: Services, ids: World, label: string): Promise<Record<Motion, string>> {
  return {
    UNSTARTED: await project(s, ids, `${label}-unstarted`, 'UNSTARTED'),
    PAUSED: await project(s, ids, `${label}-paused`, 'PAUSED'),
    MOVING: await project(s, ids, `${label}-moving`, 'MOVING'),
    MOVING_AUTOMATIC_OFF: await project(s, ids, `${label}-automatic-off`, 'MOVING_AUTOMATIC_OFF'),
  };
}

/** A task of this project, assigned to the world's workspace, OPEN, not opted into auto-run. */
async function seedTask(
  db: PrismaClient,
  ids: World,
  projectId: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id, ownerId: ids.ownerId, projectId, assigneeId: ids.workspaceId, title: `${title}-${RUN}`,
      creatorType: CreatorType.USER, creatorId: ids.ownerId, provider: 'claude',
      completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.OPEN,
      autoRunWhenReady: false, dispatchHold: false,
      ...extra,
    },
  });
  return id;
}

const runs = (db: PrismaClient, taskId: string) =>
  db.session.count({ where: { taskId, startsTaskWork: true } });

/** Whether a door was OFFERED the task: the run door writes a receipt even for a refusal. */
const offered = (db: PrismaClient, ownerId: string, taskId: string) =>
  db.taskRunRequest.count({ where: { ownerId, fingerprint: `task:${taskId}` } });

async function origin(db: PrismaClient, taskId: string): Promise<SessionDispatchOrigin | undefined> {
  const [run] = await db.session.findMany({
    where: { taskId, startsTaskWork: true },
    select: { dispatchOrigin: true },
  });
  return run?.dispatchOrigin;
}

/** The sweeps, called exactly as the service's one timer calls them. */
async function sweep(tasks: TasksService): Promise<void> {
  const timer = tasks as unknown as {
    reconcileReadyTasks(): Promise<void>;
    dispatchDueScheduledTasks(): Promise<void>;
  };
  await timer.reconcileReadyTasks();
  await timer.dispatchDueScheduledTasks();
}

/** The owner's Confirm done on an OWNER_CONFIRMED task: a production DONE, and its completion edge. */
async function confirmDone(s: Services, ids: World, taskId: string): Promise<void> {
  const receipt = await s.confirmations.decide(
    ids.ownerId, taskId, { door: 'USER', userId: ids.ownerId }, { decision: 'CONFIRM' },
  );
  assert.equal(receipt.completed, true, 'the owner\'s confirmation did not settle the task');
  const task = await s.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } });
  assert.equal(task.status, TaskStatus.DONE);
}

/** Start an unstarted project through the owner's start door, on main, with Automatic on. */
async function start(s: Services, ids: World, projectId: string): Promise<void> {
  const standing = await s.acceptance.standardSetConfirmation(ids.ownerId, projectId);
  await s.acceptance.startProject(ids.ownerId, projectId, {
    criteriaDigest: standing.currentVersion.digest,
    line: 'MAIN',
    automatic: true,
    maxConcurrentTasks: 8,
    mergeCheckCommand: null,
  });
}

/** Every held project of a case, made to move the way its owner would: started, or resumed. */
async function letMove(s: Services, ids: World, held: Record<Motion, string>): Promise<void> {
  await start(s, ids, held.UNSTARTED);
  const resumed = await s.projects.resume(ids.ownerId, held.PAUSED);
  assert.equal(resumed.pausedAt, null);
}

/** The refusal an action threw, as a status, a code and the words. */
async function refusalOf(action: () => Promise<unknown>): Promise<{ status: number; code?: string; message?: string }> {
  try {
    await action();
  } catch (error) {
    const e = error as { getStatus?: () => number; getResponse?: () => unknown };
    const body = e.getResponse?.() as { code?: string; message?: string } | undefined;
    return { status: e.getStatus?.() ?? 0, code: body?.code, message: body?.message };
  }
  return assert.fail('the call was expected to be refused and was not');
}

// ═══ (1) a prerequisite finishing: the completion edge ═════════════════════════════════════════════

test('(1) a DONE releases nothing in a project that is not started or is paused, and releases its '
  + 'dependents and independent tasks in one that moves, Automatic on or off',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'edge');
    const p = await projects(s, ids, 'edge');
    // In every project the same three tasks: the one the owner confirms, a task that depends on it,
    // and one that depends on nothing. Only the first is not opted into auto-run.
    const fx = {} as Record<Motion, { finished: string; dependent: string; independent: string }>;
    for (const motion of Object.keys(p) as Motion[]) {
      const finished = await seedTask(s.db, ids, p[motion], `${motion}-finished`, {
        completionCriterion: 'OWNER_CONFIRMED',
      });
      const dependent = await seedTask(s.db, ids, p[motion], `${motion}-dependent`, { autoRunWhenReady: true });
      await s.db.taskDependency.create({ data: { taskId: dependent, dependsOnTaskId: finished } });
      const independent = await seedTask(s.db, ids, p[motion], `${motion}-independent`, {
        autoRunWhenReady: true,
      });
      fx[motion] = { finished, dependent, independent };
    }

    // The owner confirms the first task done in every project — the write, and the edge it runs.
    for (const motion of Object.keys(p) as Motion[]) await confirmDone(s, ids, fx[motion].finished);

    for (const motion of MOVES) {
      assert.equal(await runs(s.db, fx[motion].dependent), 1,
        `CONTROL ${motion}: a prerequisite finishing did not start its dependent`);
      assert.equal(await runs(s.db, fx[motion].independent), 1,
        `CONTROL ${motion}: a DONE did not release the independent task — ${motion === 'MOVING_AUTOMATIC_OFF'
          ? 'Automatic off still held it back' : 'the fixture shows nothing'}`);
      assert.equal(await origin(s.db, fx[motion].dependent), SessionDispatchOrigin.LEGACY_SWEEP,
        'the dependent was started by something other than the automatic door');
    }
    for (const motion of HELD) {
      for (const which of ['dependent', 'independent'] as const) {
        assert.equal(await runs(s.db, fx[motion][which]), 0,
          `a DONE started the ${which} task of a ${motion} project`);
        assert.equal(await offered(s.db, ids.ownerId, fx[motion][which]), 0,
          `the completion edge offered the ${which} task of a ${motion} project to the run door`);
      }
    }

    // The same fixture once it moves: started, and resumed. Nothing finishes again, so it is the
    // sweep that picks up what the pause held — held, not lost.
    await letMove(s, ids, p);
    await sweep(s.tasks);
    for (const motion of HELD) {
      assert.equal(await runs(s.db, fx[motion].dependent), 1,
        `the ${motion} project's dependent did not start once the project moved`);
      assert.equal(await runs(s.db, fx[motion].independent), 1,
        `the ${motion} project's independent task did not start once the project moved`);
    }
  } finally {
    await s.db.$disconnect();
  }
});

// ═══ (2) the sweeps: prerequisites, independent tasks, schedules ═══════════════════════════════════

test('(2) the sweeps start nothing in a project that is not started or is paused — a satisfied '
  + 'prerequisite, an independent task, a schedule come due — and start all three in one that moves',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'sweep');
    const p = await projects(s, ids, 'sweep');
    const due = new Date(Date.now() - 60_000);
    const fx = {} as Record<Motion, { dependent: string; independent: string; scheduled: string }>;
    for (const motion of Object.keys(p) as Motion[]) {
      const prerequisite = await seedTask(s.db, ids, p[motion], `${motion}-prerequisite`, {
        status: TaskStatus.DONE,
      });
      const dependent = await seedTask(s.db, ids, p[motion], `${motion}-dependent`, { autoRunWhenReady: true });
      await s.db.taskDependency.create({ data: { taskId: dependent, dependsOnTaskId: prerequisite } });
      fx[motion] = {
        dependent,
        independent: await seedTask(s.db, ids, p[motion], `${motion}-independent`, { autoRunWhenReady: true }),
        // Not opted into auto-run: a schedule is its own trigger.
        scheduled: await seedTask(s.db, ids, p[motion], `${motion}-scheduled`, { runAt: due }),
      };
    }

    await sweep(s.tasks);

    for (const motion of MOVES) {
      for (const which of ['dependent', 'independent', 'scheduled'] as const) {
        assert.equal(await runs(s.db, fx[motion][which]), 1,
          `CONTROL ${motion}: the sweep did not start the ${which} task, so the fixture shows nothing`);
      }
      assert.equal(
        (await s.db.task.findUniqueOrThrow({ where: { id: fx[motion].scheduled } })).runAt, null,
        `CONTROL ${motion}: the appointment kept was not consumed`,
      );
    }
    for (const motion of HELD) {
      for (const which of ['dependent', 'independent', 'scheduled'] as const) {
        assert.equal(await runs(s.db, fx[motion][which]), 0,
          `the sweep started the ${which} task of a ${motion} project`);
        assert.equal(await offered(s.db, ids.ownerId, fx[motion][which]), 0,
          `the sweep offered the ${which} task of a ${motion} project to the run door`);
      }
      assert.deepEqual(
        (await s.db.task.findUniqueOrThrow({ where: { id: fx[motion].scheduled } })).runAt, due,
        `the appointment of a ${motion} project was spent on a start that did not happen`,
      );
    }

    // Started and resumed: the same tasks, on the next pass of the same sweeps.
    await letMove(s, ids, p);
    await sweep(s.tasks);
    for (const motion of HELD) {
      for (const which of ['dependent', 'independent', 'scheduled'] as const) {
        assert.equal(await runs(s.db, fx[motion][which]), 1,
          `the ${which} task of the ${motion} project did not start once the project moved`);
      }
    }
  } finally {
    await s.db.$disconnect();
  }
});

// ═══ (3) the retry policy ══════════════════════════════════════════════════════════════════════════

test('(3) a paused project retries nothing — the moment stays where it was — and resumed, the retry comes',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'retry');
    // Two projects moving alike, one of which the owner pauses once its task's run has failed. A
    // project that was never started cannot be here: nothing automatic ever ran in one.
    const held = await project(s, ids, 'retry-held', 'MOVING');
    const twin = await project(s, ids, 'retry-twin', 'MOVING');
    const retried = async (projectId: string, label: string) => {
      const prerequisite = await seedTask(s.db, ids, projectId, `${label}-prerequisite`, {
        status: TaskStatus.DONE,
      });
      const task = await seedTask(s.db, ids, projectId, `${label}-fails`, { autoRunWhenReady: true });
      await s.db.taskDependency.create({ data: { taskId: task, dependsOnTaskId: prerequisite } });
      return task;
    };
    const heldTask = await retried(held, 'held');
    const twinTask = await retried(twin, 'twin');
    const epochOf = async (taskId: string) => (await s.db.taskDispatchEpoch.findUniqueOrThrow({
      where: { taskId }, select: { epoch: true },
    })).epoch;
    const workRuns = (taskId: string) => s.db.session.findMany({
      where: { taskId, startsTaskWork: true }, orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true },
    });

    // Both run once, and both runs fail with the task left OPEN — the shape the retry policy is for.
    await sweep(s.tasks);
    const [heldRun] = await workRuns(heldTask);
    const [twinRun] = await workRuns(twinTask);
    assert.ok(heldRun && twinRun, 'the first sweep did not start both tasks');
    for (const run of [heldRun, twinRun]) {
      await s.db.session.update({
        where: { id: run.id },
        data: { status: RunStatus.FAILED, error: null, finishedAt: new Date() },
      });
    }
    const heldMoment = await epochOf(heldTask);
    const twinMoment = await epochOf(twinTask);

    // The owner pauses one of them, and the backoff window passes for both.
    await s.projects.pause(ids.ownerId, held);
    s.clock.now = new Date(
      Math.max(heldRun.createdAt.getTime(), twinRun.createdAt.getTime()) + AUTO_RUN_RETRY_BACKOFF_MS[0] + 1_000,
    );
    await sweep(s.tasks);

    assert.equal(await epochOf(twinTask), twinMoment + 1n, 'CONTROL: the twin\'s run was not re-armed');
    assert.equal((await workRuns(twinTask)).length, 2, 'CONTROL: the twin was not retried');
    assert.equal(await epochOf(heldTask), heldMoment,
      'the retry policy re-armed a task of a paused project');
    assert.equal((await workRuns(heldTask)).length, 1, 'a paused project\'s task was retried');

    // Resumed: the same retry, on the next pass.
    await s.projects.resume(ids.ownerId, held);
    await sweep(s.tasks);
    assert.equal(await epochOf(heldTask), heldMoment + 1n, 'the resumed project\'s run was not re-armed');
    assert.equal((await workRuns(heldTask)).length, 2, 'the resumed project\'s task was not retried');
  } finally {
    await s.db.$disconnect();
  }
});

// ═══ (4) the runner's task_start, and the owner's Run ═════════════════════════════════════════════

test('(4) an agent\'s task_start is refused 409 while the project is not started or is paused, and '
  + 'the owner\'s own Run still starts the task',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'start');
    const p = await projects(s, ids, 'start');
    const agentTask = {} as Record<Motion, string>;
    const ownerTask = {} as Record<Motion, string>;
    for (const motion of Object.keys(p) as Motion[]) {
      agentTask[motion] = await seedTask(s.db, ids, p[motion], `${motion}-agent`);
      ownerTask[motion] = await seedTask(s.db, ids, p[motion], `${motion}-owner`);
    }
    // `task_start` as the MCP tool and `orbit task start` reach it: the runner's controller.
    const taskStart = (taskId: string, triggerId: string) =>
      s.runnerTasks.executeTask({ ownerId: ids.ownerId } as never, taskId, undefined, { triggerId } as never);

    const unstarted = await refusalOf(() => taskStart(agentTask.UNSTARTED, `agent-unstarted-${RUN}`));
    assert.equal(unstarted.status, 409);
    assert.equal(unstarted.code, 'PROJECT_NOT_STARTED');

    const paused = await refusalOf(() => taskStart(agentTask.PAUSED, `agent-paused-${RUN}`));
    assert.equal(paused.status, 409);
    assert.equal(paused.code, 'PROJECT_PAUSED');
    assert.match(paused.message ?? '', /is paused/);
    assert.match(paused.message ?? '', /Resume project/);
    assert.ok(paused.message?.includes(uuidToBase62(agentTask.PAUSED)), 'the refusal names the task');
    assert.ok(paused.message?.includes(uuidToBase62(p.PAUSED)), 'the refusal names the project');
    for (const motion of HELD) {
      assert.equal(await runs(s.db, agentTask[motion]), 0, `task_start started a task of a ${motion} project`);
    }

    for (const motion of MOVES) {
      await taskStart(agentTask[motion], `agent-${motion}-${RUN}`);
      assert.equal(await runs(s.db, agentTask[motion]), 1,
        `CONTROL ${motion}: task_start did not start the task, so the refusals show nothing`);
    }

    // The owner's own Run is not held by either — the door `TasksController.execute` calls.
    for (const motion of HELD) {
      await s.tasks.execute(ids.ownerId, ownerTask[motion], undefined, `owner-${motion}-${RUN}`);
      assert.equal(await runs(s.db, ownerTask[motion]), 1,
        `the owner's Run did not start a task of a ${motion} project`);
      assert.equal(await origin(s.db, ownerTask[motion]), SessionDispatchOrigin.USER);
    }

    // Not frozen: the same call starts the task once the project moves.
    await letMove(s, ids, p);
    for (const motion of HELD) {
      await taskStart(agentTask[motion], `agent-${motion === 'UNSTARTED' ? 'unstarted' : 'paused'}-${RUN}`);
      assert.equal(await runs(s.db, agentTask[motion]), 1,
        `the same task_start did not start the task once the ${motion} project moved`);
    }
  } finally {
    await s.db.$disconnect();
  }
});

// ═══ (4b) at most N tasks at a time ════════════════════════════════════════════════════════════════

/** A moving project whose `max_concurrent_tasks` is the one under test. */
async function cappedProject(s: Services, ids: World, label: string, cap: number): Promise<string> {
  const projectId = await project(s, ids, label, 'MOVING');
  await s.db.project.update({ where: { id: projectId }, data: { maxConcurrentTasks: cap } });
  return projectId;
}

/** Two auto-run tasks that both wait on one prerequisite, seeded as `prerequisite` says. */
async function twoDependents(
  s: Services,
  ids: World,
  projectId: string,
  label: string,
  prerequisite: Record<string, unknown>,
): Promise<{ prerequisite: string; dependents: [string, string] }> {
  const first = await seedTask(s.db, ids, projectId, `${label}-prerequisite`, prerequisite);
  const dependents: [string, string] = [
    await seedTask(s.db, ids, projectId, `${label}-first`, { autoRunWhenReady: true }),
    await seedTask(s.db, ids, projectId, `${label}-second`, { autoRunWhenReady: true }),
  ];
  for (const dependent of dependents) {
    await s.db.taskDependency.create({ data: { taskId: dependent, dependsOnTaskId: first } });
  }
  return { prerequisite: first, dependents };
}

const started = async (db: PrismaClient, taskIds: readonly string[]) =>
  (await Promise.all(taskIds.map((id) => runs(db, id)))).reduce((sum, n) => sum + n, 0);

test('(4b) a prerequisite finishing starts no more of a project\'s tasks than it may run at once — '
  + 'on the completion edge and on the sweep, for schedules too, and with Run Now past it',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'cap');

    // ── the completion edge: the owner confirms the prerequisite done ─────────────────────────────
    const edgeOne = await cappedProject(s, ids, 'cap-edge-one', 1);
    const edgeTwo = await cappedProject(s, ids, 'cap-edge-two', 2);
    const one = await twoDependents(s, ids, edgeOne, 'edge-one', { completionCriterion: 'OWNER_CONFIRMED' });
    const two = await twoDependents(s, ids, edgeTwo, 'edge-two', { completionCriterion: 'OWNER_CONFIRMED' });
    await confirmDone(s, ids, one.prerequisite);
    await confirmDone(s, ids, two.prerequisite);
    assert.equal(await started(s.db, two.dependents), 2,
      'CONTROL: a project with room for two did not start both, so the one below shows nothing');
    assert.equal(await started(s.db, one.dependents), 1,
      'a prerequisite finishing started past its project\'s limit of one');
    const held = (await runs(s.db, one.dependents[0])) === 1 ? one.dependents[1] : one.dependents[0];
    assert.equal(await offered(s.db, ids.ownerId, held), 0,
      'the completion edge offered the task its project had no room for to the run door');

    // ── the sweep: the same shape, the prerequisite already DONE, nothing finishing ────────────────
    const sweepOne = await cappedProject(s, ids, 'cap-sweep-one', 1);
    const sweepTwo = await cappedProject(s, ids, 'cap-sweep-two', 2);
    const three = await twoDependents(s, ids, sweepOne, 'sweep-one', { status: TaskStatus.DONE });
    const four = await twoDependents(s, ids, sweepTwo, 'sweep-two', { status: TaskStatus.DONE });
    // A task that depends on nothing, in a project of one beside a released dependent: the two scans
    // of one sweep share the project's room, they do not each spend it.
    const mixedOne = await cappedProject(s, ids, 'cap-mixed-one', 1);
    const mixed = await twoDependents(s, ids, mixedOne, 'mixed-one', { status: TaskStatus.DONE });
    await s.db.taskDependency.deleteMany({ where: { taskId: mixed.dependents[1] } });
    // Two schedules come due in a project of one, and in its twin of two.
    const scheduledOne = await cappedProject(s, ids, 'cap-scheduled-one', 1);
    const scheduledTwo = await cappedProject(s, ids, 'cap-scheduled-two', 2);
    const due = new Date(Date.now() - 60_000);
    const schedules = async (projectId: string, label: string): Promise<[string, string]> => [
      await seedTask(s.db, ids, projectId, `${label}-first`, { runAt: due }),
      await seedTask(s.db, ids, projectId, `${label}-second`, { runAt: due }),
    ];
    const dueOne = await schedules(scheduledOne, 'scheduled-one');
    const dueTwo = await schedules(scheduledTwo, 'scheduled-two');

    await sweep(s.tasks);

    assert.equal(await started(s.db, four.dependents), 2, 'CONTROL: the sweep did not start both in a project of two');
    assert.equal(await started(s.db, three.dependents), 1, 'the sweep started past its project\'s limit of one');
    assert.equal(await started(s.db, mixed.dependents), 1,
      'the sweep\'s two scans each spent a project\'s one slot');
    assert.equal(await started(s.db, dueTwo), 2, 'CONTROL: both schedules of a project of two did not start');
    assert.equal(await started(s.db, dueOne), 1, 'two schedules came due and started past their project\'s limit');

    // Held, not lost: once the running one lets its slot go, the next sweep starts the other.
    const [running] = await s.db.session.findMany({
      where: { taskId: { in: three.dependents }, startsTaskWork: true }, select: { id: true },
    });
    await s.db.session.update({
      where: { id: running!.id }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
    });
    await sweep(s.tasks);
    assert.deepEqual(await Promise.all(three.dependents.map((id) => runs(s.db, id))), [1, 1],
      'the task the limit held back did not start once a slot was free');

    // The owner's own Run is not held by the limit: the project of one is full, and it starts.
    const ownerTask = await seedTask(s.db, ids, scheduledOne, 'owner-run');
    await s.tasks.execute(ids.ownerId, ownerTask, undefined, `owner-over-cap-${RUN}`);
    assert.equal(await runs(s.db, ownerTask), 1, 'the owner\'s Run was held by the project\'s limit');
  } finally {
    await s.db.$disconnect();
  }
});

// ═══ (5) merging into main ═════════════════════════════════════════════════════════════════════════

/** What a runner of this build says about itself: it claims integration jobs, and lands only onto
 *  the checked tip on an automatic landing. */
const CAPABLE = [INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND];
const TASK_BRANCH_TIP = 'a'.repeat(40);
const LINE_BEFORE = 'c'.repeat(40);
const LANDED_ON_LINE = 'd'.repeat(40);
const LANDED_TREE = 'e'.repeat(40);
const MAIN_CHECKED = 'f'.repeat(40);
const CHECK_MERGE = '2'.repeat(40);
const CHECKED_TREE = '3'.repeat(40);

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'npm test',
  expectedExitCode: 0,
  exitCode: 0,
  timedOut: false,
  durationMs: 1_200,
  outputTail: 'ok\n',
};

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  projects: ProjectsService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
}

/** The production wiring the merge runs through: task writes behind the real completion-input
 *  router, and the runner controller with the integration relay and the promotion service. */
function connectMerges(): Stack {
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
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    new Proxy({}, { get: () => async () => undefined }) as never,
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
  const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma), sessions, realtime);
  return { db, tasks, projects, api, jobs };
}

interface LineWorld {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
}

/** A started project on its own branch with Automatic on — the one kind that merges by itself. */
async function lineWorld(stack: Stack, label: string): Promise<LineWorld> {
  const db = stack.db;
  const ids = {
    ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID(), projectId: randomUUID(),
  };
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@pause.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`, tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: CAPABLE, capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-workspace`,
      enabled: true, repoUrl: `https://git.invalid/orbit/${label}.git`, workDir: `/srv/${label}`,
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId: ids.ownerId, creatorId: ids.ownerId,
      workspaceId: ids.workspaceId, assignedRunnerId: ids.runnerId, title: `coordinator: ${label}`,
      prompt: `coordinator: ${label}`, provider: 'claude', status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER, titleManagedByProject: true, numTurns: 1,
      startedAt: new Date(), runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId, seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId), kind: 'message',
      content: `coordinator: ${label}`, status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: ids.projectId, ownerId: ids.ownerId, title: `${label} project`,
      goal: 'a paused project merges nothing into main by itself',
      coordinatorEnabled: true, coordinatorWorkspaceId: ids.workspaceId, coordinatorSessionId,
      startedAt: new Date(),
    },
  });
  await db.projectRuntime.upsert({ where: { projectId: ids.projectId }, create: { projectId: ids.projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId: ids.ownerId, projectId: ids.projectId, settings: { line: 'PROJECT_BRANCH' },
  }));
  return { label, ...ids };
}

/** A code task of the project settled DONE by its own acceptance command, through the runner's
 *  doors — the DONE that queues its landing on the project branch. A paused project's running
 *  work finishes: nothing here is held. */
async function doneCodeTask(stack: Stack, w: LineWorld): Promise<string> {
  const db = stack.db;
  const title = `${w.label} ${randomUUID().slice(0, 8)}`;
  const declared = await stack.tasks.create(w.ownerId, {
    title, assigneeId: w.workspaceId, projectId: w.projectId,
    acceptanceCommand: 'exit 0', acceptanceExpectedExitCode: 0,
  });
  const sessionId = randomUUID();
  const turnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId: declared.id,
      workspaceId: w.workspaceId, assignedRunnerId: w.runnerId, title, prompt: title,
      provider: 'claude', status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true, startedAt: new Date(), finishedAt: new Date(Date.now() - 60_000),
      branch: `orbit/${w.label}`, isolationStatus: 'worktree', baseSha: 'b'.repeat(40),
    },
  });
  await db.conversationTurn.create({
    data: {
      id: turnId, sessionId, seq: 1, clientTurnId: `message:${turnId}`, kind: 'message',
      content: 'execute the task', status: 'IN_FLIGHT', deliveredAt: new Date(),
    },
  });
  await stack.api.events({ id: w.runnerId }, sessionId, {
    events: [{
      seq: 1, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId,
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
    turnId: acceptance!.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'shell',
    shellExitCode: 0, shellOutput: '',
  });
  const task = await db.task.findUniqueOrThrow({ where: { id: declared.id }, select: { status: true } });
  assert.equal(task.status, TaskStatus.DONE, 'the acceptance command agreed');
  return declared.id;
}

function heartbeat(stack: Stack, w: LineWorld): Promise<IntegrationJobCommand[]> {
  return stack.jobs.dispatch({ runnerId: w.runnerId, leaseOwner: `lease-${w.label}`, draining: false, capabilities: CAPABLE });
}

function report(
  stack: Stack,
  w: LineWorld,
  job: IntegrationJobCommand,
  result: Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>,
) {
  return stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...result,
  });
}

async function onlyClaim(stack: Stack, w: LineWorld, kind: string): Promise<IntegrationJobCommand> {
  const claimed = await heartbeat(stack, w);
  assert.equal(claimed.length, 1, `expected one ${kind} to be handed out`);
  assert.equal(claimed[0]!.kind, kind);
  return claimed[0]!;
}

/** One task DONE and landed on the project branch, and the promotion check of it in a runner's hands. */
async function checkInHand(stack: Stack, w: LineWorld): Promise<IntegrationJobCommand> {
  await doneCodeTask(stack, w);
  const landing = await onlyClaim(stack, w, 'LAND_TASK');
  const landed = await report(stack, w, landing, {
    state: 'LANDED', phase: 'VERIFY', sourceSha: TASK_BRANCH_TIP, targetShaBefore: LINE_BEFORE,
    testedSha: LANDED_ON_LINE, testedTreeSha: LANDED_TREE, landedSha: LANDED_ON_LINE,
    landedTreeSha: LANDED_TREE, aheadOfUpstream: 1,
  });
  assert.equal(landed.accepted, true, 'the task landed on the project branch');
  return onlyClaim(stack, w, 'CHECK_PROMOTION');
}

/** A check that found the project branch merging cleanly onto main, every check green. */
function reportClean(stack: Stack, w: LineWorld, check: IntegrationJobCommand) {
  return report(stack, w, check, {
    state: 'READY', phase: 'CHECK', sourceSha: LANDED_ON_LINE, targetShaBefore: MAIN_CHECKED,
    upstreamSha: MAIN_CHECKED, testedSha: CHECK_MERGE, testedTreeSha: CHECKED_TREE,
    aheadOfUpstream: 1, filesChanged: 3, checks: [GREEN_CHECK], conflicts: [],
  });
}

async function mergeState(db: PrismaClient, projectId: string) {
  const promotion = await db.projectPromotion.findFirstOrThrow({
    where: { projectId }, orderBy: { createdAt: 'desc' },
    select: { state: true, confirmedAutomatically: true, landJobId: true, mergedSha: true, openItemId: true },
  });
  const cards = await db.projectOpenItem.findMany({
    where: { projectId, kind: 'PROMOTION_APPROVAL', state: 'OPEN' },
    select: { id: true, assignee: true },
  });
  const landings = await db.projectIntegrationJob.findMany({
    where: { projectId, kind: 'LAND_PROMOTION' },
    select: { state: true, confirmedAutomatically: true, landedSha: true },
  });
  return { promotion, cards, landings };
}

test('(5) a paused project merges nothing into main by itself: a clean check goes to the owner as '
  + 'the card, and a landing queued before the pause is handed back',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const stack = connectMerges();
  try {
    // Paused before its check comes back: the READY is the owner's card, exactly as with Automatic off.
    const pausedFirst = await lineWorld(stack, 'merge-paused');
    await stack.projects.pause(pausedFirst.ownerId, pausedFirst.projectId);
    const pausedCheck = await checkInHand(stack, pausedFirst);
    assert.equal((await reportClean(stack, pausedFirst, pausedCheck)).accepted, true);
    const asked = await mergeState(stack.db, pausedFirst.projectId);
    assert.equal(asked.promotion.state, 'READY', 'a paused project\'s candidate did not wait for the owner');
    assert.equal(asked.promotion.confirmedAutomatically, false, 'Automatic confirmed a paused project\'s merge');
    assert.deepEqual(asked.cards.map((card) => card.assignee), ['OWNER'], 'no card was put in front of the owner');
    assert.equal(asked.promotion.openItemId, asked.cards[0]!.id);
    assert.deepEqual(asked.landings, [], 'a landing into main was queued for a paused project');

    // CONTROL: the same world, not paused, is merged by the setting — and then paused before the
    // heartbeat hands the landing out, which takes the yes back.
    const moving = await lineWorld(stack, 'merge-moving');
    const movingCheck = await checkInHand(stack, moving);
    await reportClean(stack, moving, movingCheck);
    const confirmed = await mergeState(stack.db, moving.projectId);
    assert.equal(confirmed.promotion.state, 'CONFIRMED',
      'CONTROL: the moving project was not merged by its setting, so the case above shows nothing');
    assert.equal(confirmed.promotion.confirmedAutomatically, true);
    assert.deepEqual(confirmed.cards, []);
    assert.deepEqual(confirmed.landings.map((job) => job.state), ['QUEUED']);

    await stack.projects.pause(moving.ownerId, moving.projectId);
    assert.deepEqual(await heartbeat(stack, moving), [], 'a paused project\'s automatic landing was handed out');
    const handedBack = await mergeState(stack.db, moving.projectId);
    assert.equal(handedBack.promotion.state, 'READY', 'the landing was not handed back to the owner');
    assert.equal(handedBack.promotion.confirmedAutomatically, false);
    assert.equal(handedBack.promotion.mergedSha, null, 'something was merged');
    assert.deepEqual(handedBack.cards.map((card) => card.assignee), ['OWNER']);
    assert.deepEqual(handedBack.landings.map((job) => [job.state, job.landedSha]), [['READY', null]],
      'the automatic landing did not end without landing');

    // CONTROL for the handout: a third world, not paused, gets its landing handed out.
    const handedOut = await lineWorld(stack, 'merge-handed-out');
    await reportClean(stack, handedOut, await checkInHand(stack, handedOut));
    const landing = await onlyClaim(stack, handedOut, 'LAND_PROMOTION');
    assert.equal(landing.automatic, true, 'CONTROL: the unpaused project\'s landing was not handed out');
  } finally {
    await stack.db.$disconnect();
  }
});

// ═══ (6) the backfill ══════════════════════════════════════════════════════════════════════════════

test('(6) the backfill pauses a started project whose Automatic is off, and nothing else',
{ skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const sql = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const s = connect();
  try {
    await verifyCoordinatorPgIdentity(sql);
    const ids = await world(s.db, 'backfill');
    const at = new Date('2026-09-01T00:00:00.000Z');
    const seed = async (label: string, data: Record<string, unknown>) => {
      const id = randomUUID();
      await s.db.project.create({ data: { id, ownerId: ids.ownerId, title: `backfill ${label}`, ...data } });
      return id;
    };
    const startedOff = await seed('started, Automatic off', { startedAt: at, coordinatorEnabled: false });
    const startedOn = await seed('started, Automatic on', { startedAt: at, coordinatorEnabled: true });
    const unstartedOff = await seed('not started, Automatic off', { coordinatorEnabled: false });
    const unstartedOn = await seed('not started, Automatic on', { coordinatorEnabled: true });
    const alreadyPaused = await seed('already paused by its owner', {
      startedAt: at, coordinatorEnabled: false, pausedAt: at, pausedReason: 'OWNER',
    });
    const ids5 = [startedOff, startedOn, unstartedOff, unstartedOn, alreadyPaused];

    // Replayed straight out of the migration, inside a transaction this test rolls back: the
    // statement runs over every project in the database, and the others are not this case's.
    const from = MIGRATION.indexOf('UPDATE "project"');
    assert.ok(from >= 0, 'the backfill is no longer where this file reads it from');
    const backfill = MIGRATION.slice(from, MIGRATION.indexOf(';', from) + 1);
    await sql.query('BEGIN');
    try {
      await sql.query(backfill);
      const { rows } = await sql.query<{ id: string; paused_at: Date | null; paused_reason: string | null }>(
        `SELECT "id", "paused_at", "paused_reason" FROM "project" WHERE "id" = ANY($1::uuid[])`, [ids5],
      );
      const state = new Map(rows.map((row) => [row.id, row]));
      assert.ok(state.get(startedOff)?.paused_at, 'a started project with Automatic off was not paused');
      assert.equal(state.get(startedOff)?.paused_reason, 'LEGACY_AUTOMATIC_OFF');
      for (const [label, id] of [
        ['a started project with Automatic on', startedOn],
        ['a project nobody started, Automatic off', unstartedOff],
        ['a project nobody started, Automatic on', unstartedOn],
      ] as const) {
        assert.equal(state.get(id)?.paused_at, null, `${label} was paused`);
        assert.equal(state.get(id)?.paused_reason, null);
      }
      assert.deepEqual(
        [state.get(alreadyPaused)?.paused_at?.toISOString(), state.get(alreadyPaused)?.paused_reason],
        [at.toISOString(), 'OWNER'],
        'the backfill rewrote a pause that was already there',
      );
    } finally {
      await sql.query('ROLLBACK');
    }

    // What the backfilled state then means, through the doors: the project it paused starts
    // nothing, and its twin with Automatic on does.
    await s.db.project.update({
      where: { id: startedOff }, data: { pausedAt: at, pausedReason: 'LEGACY_AUTOMATIC_OFF' },
    });
    await establishProjectContractForPgTest(s.db, ids.ownerId, startedOff, 'backfill started, Automatic off');
    await establishProjectContractForPgTest(s.db, ids.ownerId, startedOn, 'backfill started, Automatic on');
    const heldTask = await seedTask(s.db, ids, startedOff, 'backfilled-independent', { autoRunWhenReady: true });
    const twinTask = await seedTask(s.db, ids, startedOn, 'twin-independent', { autoRunWhenReady: true });
    await sweep(s.tasks);
    assert.equal(await runs(s.db, twinTask), 1, 'CONTROL: the twin with Automatic on started nothing');
    assert.equal(await runs(s.db, heldTask), 0, 'a project the backfill paused started its task');
  } finally {
    await s.db.$disconnect();
    await sql.end();
  }
});

// ═══ (7)(8) the owner's doors: the older Automatic switch, pause and resume ════════════════════════

test('the owner\'s doors: the older Automatic switch keeps its meaning, and pause and resume are the owner\'s',
{ skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  const ids = await world(s.db, 'doors');
  t.after(async () => {
    await s.db.$disconnect().catch(() => undefined);
  });

  // ── the doors, over real HTTP: the real controller, pipe and interceptor ─────────────────────────
  const refuse = (name: string) => () => {
    throw new Error(`${name} must not be reached by this probe`);
  };
  @Module({
    controllers: [ProjectsController],
    providers: [
      { provide: ProjectsService, useValue: s.projects },
      { provide: ProjectAcceptanceService, useValue: s.acceptance },
      { provide: ProjectHandoffService, useValue: { listForProject: refuse('handoffs') } },
      { provide: SessionAttemptService, useValue: { describe: refuse('attempts') } },
      { provide: TaskCheckpointService, useValue: { record: refuse('checkpoints') } },
      { provide: ProjectOpenItemService, useValue: { list: refuse('open items') } },
      { provide: ProjectFuseService, useValue: { resume: refuse('the fuse') } },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: ids.ownerId }) } },
      { provide: PrismaService, useValue: s.db },
    ],
  })
  class PauseDoorModule {}

  const app = await NestFactory.create(PauseDoorModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  /** A request as a browser makes it: the project addressed in base62. */
  async function call(
    method: 'POST' | 'PATCH',
    projectId: string,
    suffix: string,
    body?: Record<string, unknown>,
    sessionHeader?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${base}/api/projects/${uuidToBase62(projectId)}${suffix}`, {
      method,
      headers: {
        authorization: 'Bearer the-account-owner',
        'content-type': 'application/json',
        ...(sessionHeader ? { 'x-orbit-session-id': sessionHeader } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }
  const patch = (projectId: string, body: Record<string, unknown>) => call('PATCH', projectId, '', body);
  const pause = (projectId: string, session?: string) => call('POST', projectId, '/pause', undefined, session);
  const resume = (projectId: string, session?: string) => call('POST', projectId, '/resume', undefined, session);

  /** The row, read with SQL-shaped Prisma rather than through the service that wrote it. */
  async function row(projectId: string) {
    const p = await s.db.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { coordinatorEnabled: true, pausedAt: true, pausedReason: true, configRevision: true },
    });
    return { automatic: p.coordinatorEnabled, pausedAt: p.pausedAt, reason: p.pausedReason, revision: p.configRevision };
  }
  const changedPublishes = (projectId: string) =>
    s.published.filter((event) => event.type === RunEventType.PROJECT_CHANGED && event.id === projectId).length;

  /** Whether the project moves, asked of the sweep with a fresh independent task. */
  async function sweepStarts(projectId: string, label: string): Promise<boolean> {
    const task = await seedTask(s.db, ids, projectId, label, { autoRunWhenReady: true });
    await sweep(s.tasks);
    return (await runs(s.db, task)) === 1;
  }

  await t.test('(7) the older switch: off pauses a started project, on lifts that pause', async () => {
    const projectId = await project(s, ids, 'legacy-switch', 'MOVING');
    assert.equal(await sweepStarts(projectId, 'before'), true, 'CONTROL: the project did not move to begin with');
    const before = await row(projectId);

    const off = await patch(projectId, { coordinatorEnabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    const paused = await row(projectId);
    assert.equal(paused.automatic, false);
    assert.ok(paused.pausedAt, 'switching Automatic off on an older client did not pause the project');
    assert.equal(paused.reason, 'LEGACY_AUTOMATIC_OFF');
    assert.equal(paused.revision, before.revision + 1n, 'Automatic is an authorization field: one bump');
    assert.equal(off.json.pausedReason, 'LEGACY_AUTOMATIC_OFF', 'the answer does not say it paused');
    assert.equal(changedPublishes(projectId), 1, 'the pause was not announced');
    assert.equal(await sweepStarts(projectId, 'switched-off'), false,
      'switched off on an older client, the project still started a task on its own');

    const on = await patch(projectId, { coordinatorEnabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    const lifted = await row(projectId);
    assert.equal(lifted.automatic, true);
    assert.equal(lifted.pausedAt, null, 'switching it back on did not lift the pause its off wrote');
    assert.equal(lifted.reason, null);
    assert.equal(changedPublishes(projectId), 2, 'the resume was not announced');
    assert.equal(await sweepStarts(projectId, 'switched-on'), true, 'switched back on, the project did not move');
  });

  await t.test('(7) the older switch never lifts the owner\'s own pause, and does not pause what was never started', async () => {
    const projectId = await project(s, ids, 'legacy-owner-pause', 'MOVING');
    const pressed = await pause(projectId);
    assert.equal(pressed.status, 201, JSON.stringify(pressed.json));
    const ownerPause = await row(projectId);
    assert.equal(ownerPause.reason, 'OWNER');

    await patch(projectId, { coordinatorEnabled: false });
    const stillOwner = await row(projectId);
    assert.equal(stillOwner.automatic, false);
    assert.deepEqual([stillOwner.pausedAt, stillOwner.reason], [ownerPause.pausedAt, 'OWNER'],
      'the older switch rewrote the owner\'s pause');
    await patch(projectId, { coordinatorEnabled: true });
    const stillPaused = await row(projectId);
    assert.equal(stillPaused.automatic, true);
    assert.deepEqual([stillPaused.pausedAt, stillPaused.reason], [ownerPause.pausedAt, 'OWNER'],
      'the older switch lifted a pause the owner pressed');
    assert.equal(await sweepStarts(projectId, 'owner-paused'), false, 'the owner\'s pause did not hold');

    const unstarted = await project(s, ids, 'legacy-unstarted', 'UNSTARTED');
    await patch(unstarted, { coordinatorEnabled: false });
    const notStarted = await row(unstarted);
    assert.equal(notStarted.automatic, false);
    assert.equal(notStarted.pausedAt, null, 'a project nobody started was paused');
  });

  await t.test('(7) the newer field says who decides and leaves the pause alone', async () => {
    const projectId = await project(s, ids, 'automatic-field', 'MOVING');
    const before = await row(projectId);
    const off = await patch(projectId, { automatic: false });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    const manual = await row(projectId);
    assert.equal(manual.automatic, false);
    assert.equal(manual.pausedAt, null, '`automatic: false` paused the project');
    assert.equal(manual.revision, before.revision + 1n);
    assert.equal(await sweepStarts(projectId, 'automatic-off'), true,
      'Automatic off stopped a started, unpaused project from releasing its task');

    // A pause the older switch wrote is not lifted by the newer field either.
    await patch(projectId, { coordinatorEnabled: true });
    await patch(projectId, { coordinatorEnabled: false });
    assert.equal((await row(projectId)).reason, 'LEGACY_AUTOMATIC_OFF');
    await patch(projectId, { automatic: true });
    const stillPaused = await row(projectId);
    assert.equal(stillPaused.automatic, true);
    assert.equal(stillPaused.reason, 'LEGACY_AUTOMATIC_OFF', '`automatic: true` lifted a pause');

    const both = await patch(projectId, { automatic: true, coordinatorEnabled: true });
    assert.equal(both.status, 400, 'both spellings of Automatic in one request were accepted');
  });

  await t.test('(8) pause and resume refuse a request from a session, 403, and write nothing', async () => {
    const projectId = await project(s, ids, 'pause-door', 'MOVING');
    const announced = changedPublishes(projectId);

    const agentPause = await pause(projectId, `session-${RUN}`);
    assert.equal(agentPause.status, 403);
    assert.equal(agentPause.json.code, 'PROJECT_PAUSE_OWNER_ONLY');
    assert.equal((await row(projectId)).pausedAt, null, 'a refused pause paused the project');
    assert.equal(changedPublishes(projectId), announced, 'a refused pause was announced');

    const ownerPause = await pause(projectId);
    assert.equal(ownerPause.status, 201, 'CONTROL: the owner\'s own pause was refused');
    assert.equal(ownerPause.json.projectId, uuidToBase62(projectId));
    assert.ok(ownerPause.json.pausedAt);
    assert.equal(ownerPause.json.pausedReason, 'OWNER');
    const paused = await row(projectId);
    assert.ok(paused.pausedAt);
    assert.equal(changedPublishes(projectId), announced + 1);
    // Pausing again changes nothing and announces nothing.
    assert.equal((await pause(projectId)).status, 201);
    assert.deepEqual((await row(projectId)).pausedAt, paused.pausedAt);
    assert.equal(changedPublishes(projectId), announced + 1);

    const agentResume = await resume(projectId, `session-${RUN}`);
    assert.equal(agentResume.status, 403);
    assert.equal(agentResume.json.code, 'PROJECT_PAUSE_OWNER_ONLY');
    assert.deepEqual((await row(projectId)).pausedAt, paused.pausedAt, 'a refused resume resumed the project');

    const ownerResume = await resume(projectId);
    assert.equal(ownerResume.status, 201, 'CONTROL: the owner\'s own resume was refused');
    assert.equal(ownerResume.json.pausedAt, null);
    assert.equal((await row(projectId)).pausedAt, null);
    assert.equal(changedPublishes(projectId), announced + 2);
    // Neither door is an authorization write: the revision a coordinator reads did not move.
    assert.equal((await row(projectId)).revision, paused.revision);

    const unstarted = await project(s, ids, 'pause-unstarted', 'UNSTARTED');
    const early = await pause(unstarted);
    assert.equal(early.status, 409);
    assert.equal(early.json.code, 'PROJECT_NOT_STARTED');
    assert.equal((await row(unstarted)).pausedAt, null);
  });
});
