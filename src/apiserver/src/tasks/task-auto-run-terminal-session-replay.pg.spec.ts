import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  CreatorType,
  PrismaClient,
  ProjectAutomationPolicy,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { AUTO_RUN_RETRY_BACKOFF_MS } from './task-retry-policy';
import { TASK_RUN_TRIGGER } from './task-run-identity';
import { TASK_RUN_ACTION } from './task-run-receipt';
import { TasksService } from './tasks.service';

/**
 * A reconcile pass must not report — or pay for — a dispatch it only replayed.
 *
 * `reconcileReadyTasks` names each automatic dispatch after the moment it acts on,
 * `dep:<task>:<task_dispatch_epoch>`, and `execute` answers a request whose receipt is COMPLETED
 * from that receipt before anything else. A run ending moves no epoch — 0137's transition table is
 * task-row facts only — so once an auto-run task's run was stopped or had failed while the task
 * stayed OPEN, every later sweep selected the task again, spent a materialisation slot on it, was
 * handed `{ ok: true, sessionId: <the ended run> }` and logged `reconciled ready task … -> auto-run`
 * for a run that never happened. On 2026-09-12 six production tasks did this once a minute, the
 * oldest for three weeks, and nothing else was ever going to start them.
 *
 * The fix takes such a task out of the candidate set and says why on the task read
 * (`autoRunSkipped`). Both cases drive the real sweep over a real PostgreSQL, against a runner with
 * ONE slot and a second task waiting for it, so "the replay spent no slot" is not an absence to
 * assert but a run that has to exist: the waiting task starts in the same pass. They are the two
 * candidate scans the fix changes — the independent-task scan with a run a person stopped, and the
 * dependency scan with a run that failed.
 *
 * Every read of `autoRunSkipped` comes after the sweep has been checked, and through a view in which
 * the field is optional: a tree without the fix still compiles this file, and goes red first on the
 * replay itself rather than on a property it does not have.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface Services {
  db: PrismaClient;
  tasks: TasksService;
}

interface World {
  ownerId: string;
  runnerId: string;
  agentId: string;
}

function connect(): Services {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return { db, tasks: new TasksService(prisma, sessions, publishes) };
}

/** An owner, one online runner with exactly ONE slot, and one workspace bound to it. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), agentId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@replay.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(),
      // The budget under test. One slot per sweep, so whichever task the sweep spends it on is
      // visible as the only run that pass starts.
      maxConcurrent: 1,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.agentId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-agent`,
      enabled: true,
    },
  });
  return ids;
}

/** A project with room for three running tasks, so its own budget never decides anything here. */
async function project(
  db: PrismaClient,
  ids: World,
  label: string,
  coordinatorEnabled: boolean,
): Promise<string> {
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId, ownerId: ids.ownerId, title: label, coordinatorEnabled,
      maxConcurrentTasks: 3, automationPolicy: ProjectAutomationPolicy.AUTO,
    },
  });
  await establishProjectContractForPgTest(db, ids.ownerId, projectId, label);
  return projectId;
}

/** An OPEN task opted into auto-run, assigned to the one workspace. */
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
      id, ownerId: ids.ownerId, projectId, assigneeId: ids.agentId, title,
      creatorType: CreatorType.USER, creatorId: ids.ownerId, provider: 'claude',
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: TaskStatus.OPEN, autoRunWhenReady: true, dispatchHold: false,
      ...extra,
    },
  });
  return id;
}

const workRuns = (db: PrismaClient, taskId: string) =>
  db.session.findMany({
    where: { taskId, startsTaskWork: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, dispatchOrigin: true },
  });

/** WHICH MOMENT a task is at, straight off the row the trigger writes. */
async function epochOf(db: PrismaClient, taskId: string): Promise<bigint> {
  const [row] = await db.$queryRaw<Array<{ epoch: bigint }>>`
    SELECT "epoch" FROM "task_dispatch_epoch" WHERE "task_id" = ${taskId}::uuid`;
  assert.ok(row, `task ${taskId} has no dispatch epoch row`);
  return row.epoch;
}

/** The receipt a delivery of `token` is answered from. */
async function receiptOf(
  db: PrismaClient,
  ownerId: string,
  token: string,
): Promise<{ status: string; result: unknown } | undefined> {
  const [row] = await db.$queryRaw<Array<{ status: string; result: unknown }>>`
    SELECT "status", "result" FROM "task_run_request"
     WHERE "owner_id" = ${ownerId}::uuid
       AND "action_kind" = ${TASK_RUN_ACTION.execute}
       AND "request_token" = ${token}`;
  return row;
}

/**
 * One pass of the ready sweep, called as the service's one timer calls it, with every line
 * `TasksService` logged during the pass. The dispatch line is only ever logged, so the log is the
 * evidence for "the sweep counted this as a dispatch".
 */
async function sweep(s: Services): Promise<string[]> {
  const lines: string[] = [];
  const record = (line: unknown) => void lines.push(String(line));
  const service = s.tasks as unknown as {
    logger: unknown;
    reconcileReadyTasks(): Promise<void>;
  };
  const logger = service.logger;
  service.logger = {
    log: record, warn: record, error: record, debug: record, verbose: record, fatal: record,
  };
  try {
    await service.reconcileReadyTasks();
  } finally {
    service.logger = logger;
  }
  return lines;
}

const dispatchLine = (taskId: string) => `reconciled ready task ${taskId} -> auto-run`;

interface AutoRunSkippedView {
  autoRunSkipped?: {
    code: string;
    dispatchEpoch: string;
    sessionId: string | null;
    sessionStatus: string | null;
    requiredAction: string;
  } | null;
}

/** What the task read says about why the sweep leaves this task alone. */
async function autoRunSkippedOf(s: Services, ownerId: string, taskId: string) {
  return ((await s.tasks.get(ownerId, taskId)) as unknown as AutoRunSkippedView).autoRunSkipped;
}

/** The reason's facts, and a non-empty instruction beside them. */
function assertSkippedBecause(
  actual: AutoRunSkippedView['autoRunSkipped'],
  expected: { dispatchEpoch: bigint; sessionId: string; sessionStatus: RunStatus },
): void {
  const { requiredAction, ...facts } = actual ?? {};
  assert.deepEqual(facts, {
    code: 'MOMENT_ALREADY_DISPATCHED',
    dispatchEpoch: expected.dispatchEpoch.toString(),
    sessionId: expected.sessionId,
    sessionStatus: expected.sessionStatus,
  }, 'the task read does not say that this moment already had its run');
  assert.match(requiredAction ?? '', /\S/, 'the reason carries no instruction');
}

test('an auto-run whose session was CANCELLED is not replayed by the next reconcile: no dispatch '
  + 'line, no slot spent, and the task read says why',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'replay-cancelled');
    // The typical production shape (34MzF6KKYFp47FGmRTrFP): an independent task under a coordinated
    // project. Created a day apart because the independent scan dispatches oldest first, and which
    // of the two gets the one slot is the comparison this case turns on.
    const projectId = await project(s.db, ids, 'replay-cancelled', true);
    const stopped = await seedTask(s.db, ids, projectId, 'stopped', {
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const waiting = await seedTask(s.db, ids, projectId, 'waiting', {
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    // The read's control: ready in every other respect but held, so no sweep ever dispatches its
    // moment and there is nothing about one for its read to explain.
    const held = await seedTask(s.db, ids, projectId, 'held', { dispatchHold: true });

    const first = await sweep(s);
    const [run] = await workRuns(s.db, stopped);
    assert.ok(run, 'the first sweep did not start the older task, so nothing below is a replay');
    assert.equal(run.dispatchOrigin, SessionDispatchOrigin.LEGACY_SWEEP);
    // The line the second sweep is checked for, seen by this recorder while it IS true: its absence
    // below is then an absence of the line, not of a recorder that never saw one.
    assert.ok(first.includes(dispatchLine(stopped)), `no dispatch line: ${JSON.stringify(first)}`);
    assert.equal((await workRuns(s.db, waiting)).length, 0,
      'both tasks started, so the runner has more than the one slot this case is about');

    const moment = await epochOf(s.db, stopped);
    const token = TASK_RUN_TRIGGER.dependency(stopped, moment);
    assert.deepEqual((await receiptOf(s.db, ids.ownerId, token))?.result,
      { ok: true, sessionId: run.id });

    // A person stops the run: the task list's Stop, which cancels through SessionsService.
    assert.equal((await s.tasks.batchStop(ids.ownerId, [stopped])).stopped, 1);
    assert.equal(
      (await s.db.session.findUniqueOrThrow({ where: { id: run.id } })).status,
      RunStatus.CANCELLED,
    );

    // THE STATE THE DEFECT LIVES IN, read rather than assumed: still OPEN and opted in, the moment
    // unmoved by the cancellation, and that moment's receipt still answering with the run.
    const task = await s.db.task.findUniqueOrThrow({
      where: { id: stopped }, select: { status: true, autoRunWhenReady: true },
    });
    assert.equal(task.status, TaskStatus.OPEN);
    assert.equal(task.autoRunWhenReady, true);
    assert.equal(await epochOf(s.db, stopped), moment,
      'the cancellation moved the dispatch moment, so the next sweep would not be a replay');
    assert.equal((await receiptOf(s.db, ids.ownerId, token))?.status, 'COMPLETED');

    const second = await sweep(s);

    // (1) The replay is not counted as a dispatch.
    assert.ok(!second.includes(dispatchLine(stopped)),
      `the sweep reported a dispatch of the stopped task it only replayed: ${JSON.stringify(second)}`);
    assert.equal((await workRuns(s.db, stopped)).length, 1,
      'the stopped task was started again by the sweep');
    // ...and it cost no slot: the runner's one slot went, in this same pass, to the task that was
    // waiting for it.
    assert.equal((await workRuns(s.db, waiting)).length, 1,
      'the waiting task did not start — the slot was spent on the replay');
    assert.ok(second.includes(dispatchLine(waiting)), JSON.stringify(second));

    // (2) Where the task went: out of the ready set, with the reason on its read.
    assertSkippedBecause(await autoRunSkippedOf(s, ids.ownerId, stopped), {
      dispatchEpoch: moment, sessionId: run.id, sessionStatus: RunStatus.CANCELLED,
    });
    // ...and only there: not on a task whose live run is what holds it, nor on one whose moment has
    // had no automatic run at all.
    assert.equal(await autoRunSkippedOf(s, ids.ownerId, waiting), null);
    assert.equal(await autoRunSkippedOf(s, ids.ownerId, held), null);
  } finally {
    await s.db.$disconnect();
  }
});

test('the dependency scan stops offering a task whose moment\'s run FAILED, and the slot goes to '
  + 'the next task',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'replay-failed');
    // The other five production tasks: a DONE prerequisite, in a project with no coordinator.
    const legacy = await project(s.db, ids, 'replay-failed-legacy', false);
    const prerequisite = await seedTask(s.db, ids, legacy, 'prerequisite', {
      status: TaskStatus.DONE, autoRunWhenReady: false,
    });
    const failing = await seedTask(s.db, ids, legacy, 'failing');
    await s.db.taskDependency.create({ data: { taskId: failing, dependsOnTaskId: prerequisite } });
    // The task the slot should go to instead. Independent and under a coordinated project, so the
    // sweep reaches it only after the dependency scan's rows: a replay, if there is one, comes first.
    const coordinated = await project(s.db, ids, 'replay-failed-coordinated', true);
    const waiting = await seedTask(s.db, ids, coordinated, 'waiting');

    const first = await sweep(s);
    const [run] = await workRuns(s.db, failing);
    assert.ok(run, 'the first sweep did not start the dependent task, so nothing below is a replay');
    assert.ok(first.includes(dispatchLine(failing)), `no dispatch line: ${JSON.stringify(first)}`);
    assert.equal((await workRuns(s.db, waiting)).length, 0,
      'both tasks started, so the runner has more than the one slot this case is about');
    const moment = await epochOf(s.db, failing);

    // The run fails, and long enough ago that the failure backoff has let go of the task — as the
    // production rows had: failed on 2026-08-23, still replayed on 2026-09-12. Inside the window the
    // sweep holds the task off for that reason instead, and the pass would not be a replay at all.
    const longAgo = new Date(
      Date.now() - 2 * AUTO_RUN_RETRY_BACKOFF_MS[AUTO_RUN_RETRY_BACKOFF_MS.length - 1],
    );
    await s.db.session.update({
      where: { id: run.id },
      data: {
        status: RunStatus.FAILED, error: 'the engine exited before the work was done',
        createdAt: longAgo, finishedAt: longAgo,
      },
    });
    assert.equal(
      (await s.db.task.findUniqueOrThrow({ where: { id: failing } })).status, TaskStatus.OPEN,
    );
    assert.equal(await epochOf(s.db, failing), moment,
      'the failure moved the dispatch moment, so the next sweep would not be a replay');
    assert.equal(
      (await receiptOf(s.db, ids.ownerId, TASK_RUN_TRIGGER.dependency(failing, moment)))?.status,
      'COMPLETED',
    );

    const second = await sweep(s);

    assert.ok(!second.includes(dispatchLine(failing)),
      `the sweep reported a dispatch of the failed task it only replayed: ${JSON.stringify(second)}`);
    assert.equal((await workRuns(s.db, failing)).length, 1,
      'the failed task was started again by the sweep');
    assert.equal((await workRuns(s.db, waiting)).length, 1,
      'the waiting task did not start — the slot was spent on the replay');
    assert.ok(second.includes(dispatchLine(waiting)), JSON.stringify(second));

    assertSkippedBecause(await autoRunSkippedOf(s, ids.ownerId, failing), {
      dispatchEpoch: moment, sessionId: run.id, sessionStatus: RunStatus.FAILED,
    });

    // What the reason leaves to a person still works: Run Now names its own request and answers to
    // no moment. Once that run holds the task, the read stops blaming the moment.
    const manual = await s.tasks.execute(ids.ownerId, failing, undefined, `manual-${RUN}`);
    assert.equal(manual.ok, true, `Run Now refused: ${JSON.stringify(manual)}`);
    assert.notEqual(manual.sessionId, run.id);
    assert.equal((await workRuns(s.db, failing)).length, 2);
    assert.equal(await autoRunSkippedOf(s, ids.ownerId, failing), null);
  } finally {
    await s.db.$disconnect();
  }
});
