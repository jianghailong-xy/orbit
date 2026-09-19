import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  CreatorType,
  PrismaClient,
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
import { AUTO_RUN_RETRY_BACKOFF_MS, MAX_AUTO_RUN_FAILURES } from './task-retry-policy';
import { TASK_RUN_TRIGGER } from './task-run-identity';
import { TASK_RUN_ACTION } from './task-run-receipt';
import { TasksService } from './tasks.service';

/**
 * An auto-run task whose run ended while the task stayed OPEN is retried at a NEW dispatch moment:
 * under the failure backoff, the failure limit and the quota gate, and never after a run somebody
 * asked to stop.
 *
 * The account owner's decision, 2026-09-14. Before it nothing moved such a task on. A Session ending
 * advances no `task_dispatch_epoch`, so the moment's `dep:<task>:<epoch>` receipt kept answering with
 * the run that ended: replayed every minute until AUTO_RUN_MOMENT_DISPATCHED_SQL took the task out of
 * the candidate set, and left alone for good after that. `TasksService.rearmEndedAutoRuns` is the
 * policy, and `autoRunSkipped` on the task read reports the same decision it acts on.
 *
 * Every case drives the real sweep over a real PostgreSQL, called as the service's one timer calls
 * it, with one clock under the case's control: `TasksService.now`, the instant the backoff, the quota
 * gate and the read decide against. Each window is probed a second either side of its edge, measured
 * from the failed run's own `created_at`, so nothing here waits on wall time or depends on it.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

/** Claude Code's refusal once the 5-hour window is spent — one of the usage-limit markers. */
const QUOTA_ERROR = "You've hit your session limit · resets 6:20pm (Europe/Berlin)";

const DAY_MS = 24 * 60 * 60_000;

interface Services {
  db: PrismaClient;
  sessions: SessionsService;
  tasks: TasksService;
  /** What `TasksService.now` answers. A case moves it; nothing else reads it. */
  clock: { now: Date };
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
  const tasks = new TasksService(prisma, sessions, publishes);
  const clock = { now: new Date() };
  (tasks as unknown as { now: () => Date }).now = () => clock.now;
  return { db, sessions, tasks, clock };
}

interface World {
  ownerId: string;
  runnerId: string;
  agentId: string;
  /** No coordinator, so the dependency scan is what starts this project's tasks. */
  projectId: string;
  /** A finished task for every dependent to wait on. */
  prerequisiteId: string;
}

/** An owner, an online runner with room for every run a case starts, its workspace, a prerequisite. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = {
    ownerId: randomUUID(),
    runnerId: randomUUID(),
    agentId: randomUUID(),
    projectId: randomUUID(),
    prerequisiteId: randomUUID(),
  };
  await db.user.create({
    data: {
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@retry.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(),
      // A slot never decides whether a retry happened here: that is the replay spec's subject.
      maxConcurrent: 10,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.agentId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-agent`,
      enabled: true,
    },
  });
  await db.project.create({
    data: {
      id: ids.projectId, ownerId: ids.ownerId, title: label, coordinatorEnabled: false,
      maxConcurrentTasks: 10,
    },
  });
  await establishProjectContractForPgTest(db, ids.ownerId, ids.projectId, label);
  await db.task.create({
    data: {
      id: ids.prerequisiteId, ownerId: ids.ownerId, projectId: ids.projectId,
      assigneeId: ids.agentId, title: 'prerequisite', creatorType: CreatorType.USER,
      creatorId: ids.ownerId, provider: 'claude', completionCriterion: 'EVIDENCE_JUDGMENT',
      status: TaskStatus.DONE, autoRunWhenReady: false,
    },
  });
  return ids;
}

/** An OPEN auto-run task whose one prerequisite is DONE: READY, so the sweep starts it. */
async function dependentTask(db: PrismaClient, ids: World, title: string): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id, ownerId: ids.ownerId, projectId: ids.projectId, assigneeId: ids.agentId, title,
      creatorType: CreatorType.USER, creatorId: ids.ownerId, provider: 'claude',
      completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.OPEN, autoRunWhenReady: true,
      dispatchHold: false,
    },
  });
  await db.taskDependency.create({ data: { taskId: id, dependsOnTaskId: ids.prerequisiteId } });
  return id;
}

const workRuns = (db: PrismaClient, taskId: string) =>
  db.session.findMany({
    where: { taskId, startsTaskWork: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, status: true, dispatchOrigin: true, createdAt: true },
  });

/** The run ends FAILED as the runner's /finalize leaves it: `error` is whatever the runner sent. */
async function failRun(db: PrismaClient, sessionId: string, error: string | null): Promise<void> {
  await db.session.update({
    where: { id: sessionId },
    data: { status: RunStatus.FAILED, error, finishedAt: new Date() },
  });
}

/** WHICH MOMENT a task is at, straight off the row. */
async function epochOf(db: PrismaClient, taskId: string): Promise<bigint> {
  const [row] = await db.$queryRaw<Array<{ epoch: bigint }>>`
    SELECT "epoch" FROM "task_dispatch_epoch" WHERE "task_id" = ${taskId}::uuid`;
  assert.ok(row, `task ${taskId} has no dispatch epoch row`);
  return row.epoch;
}

/** What a moment's automatic dispatch was answered with. */
async function answerOf(db: PrismaClient, ownerId: string, taskId: string, epoch: bigint) {
  const [row] = await db.$queryRaw<Array<{ result: unknown }>>`
    SELECT "result" FROM "task_run_request"
     WHERE "owner_id" = ${ownerId}::uuid
       AND "action_kind" = ${TASK_RUN_ACTION.execute}
       AND "request_token" = ${TASK_RUN_TRIGGER.dependency(taskId, epoch)}
       AND "status" = 'COMPLETED'`;
  return row?.result;
}

/** One pass of the ready sweep, with every line `TasksService` logged during it. */
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
const rearms = (lines: string[], taskId: string) =>
  lines.filter((line) => line.startsWith(`re-armed auto-run task ${taskId} `)).length;

interface AutoRunSkippedView {
  autoRunSkipped?: {
    code: string;
    dispatchEpoch: string;
    sessionId: string | null;
    sessionStatus: string | null;
    endReason?: string | null;
    retryAt?: Date | null;
    requiredAction: string;
  } | null;
}

async function autoRunSkippedOf(s: Services, ownerId: string, taskId: string) {
  return ((await s.tasks.get(ownerId, taskId)) as unknown as AutoRunSkippedView).autoRunSkipped;
}

/** The read's facts exactly, and a non-empty instruction beside them. */
function assertSkipped(
  actual: AutoRunSkippedView['autoRunSkipped'],
  expected: {
    code: string;
    dispatchEpoch: bigint;
    sessionId: string;
    sessionStatus: RunStatus;
    endReason: string | null;
    retryAt: Date | null;
  },
  message: string,
): void {
  const { requiredAction, ...facts } = actual ?? {};
  assert.deepEqual(facts, { ...expected, dispatchEpoch: expected.dispatchEpoch.toString() }, message);
  assert.match(requiredAction ?? '', /\S/, `${message} (and it carries no instruction)`);
}

/** `promise`, or a failure naming what never happened. The timer never holds the process open. */
async function waitFor(promise: Promise<void>, ms: number, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms);
    timer.unref();
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test('a FAILED auto-run is retried once its backoff window has passed: one new Session, at a new '
  + 'dispatch moment',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'retry-failed');
    const task = await dependentTask(s.db, ids, 'fails once');

    const first = await sweep(s);
    const [run] = await workRuns(s.db, task);
    assert.ok(run, `the first sweep started nothing: ${JSON.stringify(first)}`);
    const moment = await epochOf(s.db, task);
    assert.deepEqual(await answerOf(s.db, ids.ownerId, task, moment), { ok: true, sessionId: run.id });

    // It fails with no error text, which is what the runner's /finalize leaves when the engine died
    // without a message: the one failure the budget does not count unless it says so.
    await failRun(s.db, run.id, null);
    assert.equal(
      (await s.db.task.findUniqueOrThrow({ where: { id: task } })).status, TaskStatus.OPEN,
    );
    assert.equal(await epochOf(s.db, task), moment, 'the failure itself moved the moment');

    // A second before the first window ends: nothing starts, and the read says until when.
    const windowEnds = new Date(run.createdAt.getTime() + AUTO_RUN_RETRY_BACKOFF_MS[0]);
    s.clock.now = new Date(windowEnds.getTime() - 1_000);
    const inside = await sweep(s);
    assert.equal((await workRuns(s.db, task)).length, 1,
      `retried inside its backoff window: ${JSON.stringify(inside)}`);
    assert.equal(await epochOf(s.db, task), moment, 're-armed inside its backoff window');
    assert.ok(!inside.includes(dispatchLine(task)), JSON.stringify(inside));
    assertSkipped(await autoRunSkippedOf(s, ids.ownerId, task), {
      code: 'RETRY_BACKOFF', dispatchEpoch: moment, sessionId: run.id,
      sessionStatus: RunStatus.FAILED, endReason: null, retryAt: windowEnds,
    }, 'the read does not say the task waits out its backoff window');

    // A second after: exactly one new Session, and it is the NEW moment's own request.
    s.clock.now = new Date(windowEnds.getTime() + 1_000);
    const past = await sweep(s);
    const runs = await workRuns(s.db, task);
    assert.equal(runs.length, 2, `expected exactly one retry: ${JSON.stringify(past)}`);
    const retry = runs.find((r) => r.id !== run.id)!;
    assert.equal(retry.status, RunStatus.PENDING);
    assert.equal(retry.dispatchOrigin, SessionDispatchOrigin.LEGACY_SWEEP);
    assert.equal(await epochOf(s.db, task), moment + 1n, 'the retry was not given a new moment');
    assert.deepEqual(await answerOf(s.db, ids.ownerId, task, moment + 1n),
      { ok: true, sessionId: retry.id }, 'the new Session is not the new moment\'s dispatch');
    // ...while the old moment still answers with the old run: nothing was replayed or rewritten.
    assert.deepEqual(await answerOf(s.db, ids.ownerId, task, moment), { ok: true, sessionId: run.id });
    assert.equal(rearms(past, task), 1, JSON.stringify(past));
    assert.ok(past.includes(dispatchLine(task)), JSON.stringify(past));
    assert.equal(await autoRunSkippedOf(s, ids.ownerId, task), null);
  } finally {
    await s.db.$disconnect();
  }
});

test('retries stop at MAX_AUTO_RUN_FAILURES, one new Session per backoff window on the way, and the '
  + 'read says the limit was reached',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'retry-limit');
    const task = await dependentTask(s.db, ids, 'keeps failing');
    await sweep(s);
    assert.equal((await workRuns(s.db, task)).length, 1, 'the first sweep did not start the task');

    for (let failed = 1; failed <= MAX_AUTO_RUN_FAILURES; failed += 1) {
      const current = (await workRuns(s.db, task)).find((r) => r.status === RunStatus.PENDING);
      assert.ok(current, `attempt ${failed} has no run to fail`);
      await failRun(s.db, current.id, `attempt ${failed}: the engine exited before the work was done`);
      if (failed === MAX_AUTO_RUN_FAILURES) break;

      // After the n-th failure the window is AUTO_RUN_RETRY_BACKOFF_MS[n - 1], from that run's start.
      const windowEnds = current.createdAt.getTime() + AUTO_RUN_RETRY_BACKOFF_MS[failed - 1];
      s.clock.now = new Date(windowEnds - 1_000);
      const inside = await sweep(s);
      assert.equal((await workRuns(s.db, task)).length, failed,
        `failure ${failed}: retried before its window ended: ${JSON.stringify(inside)}`);
      s.clock.now = new Date(windowEnds + 1_000);
      const past = await sweep(s);
      // A second pass in the same window starts nothing more: the retry is what holds the task.
      const again = await sweep(s);
      assert.equal((await workRuns(s.db, task)).length, failed + 1,
        `failure ${failed}: expected exactly one retry: ${JSON.stringify({ past, again })}`);
    }

    const runs = await workRuns(s.db, task);
    assert.equal(runs.length, MAX_AUTO_RUN_FAILURES);
    assert.ok(runs.every((r) => r.status === RunStatus.FAILED), JSON.stringify(runs));
    const moment = await epochOf(s.db, task);
    const answer = await answerOf(s.db, ids.ownerId, task, moment) as { sessionId: string };
    const last = runs.find((r) => r.id === answer.sessionId);
    assert.ok(last, 'the current moment does not name the last failed run');

    // A day past the last failure, long past every window: the limit is what holds it now.
    s.clock.now = new Date(last.createdAt.getTime() + DAY_MS);
    const after = await sweep(s);
    assert.equal((await workRuns(s.db, task)).length, MAX_AUTO_RUN_FAILURES,
      `retried past the failure limit: ${JSON.stringify(after)}`);
    assert.equal(await epochOf(s.db, task), moment, 're-armed past the failure limit');
    assert.equal(rearms(after, task), 0, JSON.stringify(after));
    assert.ok(!after.includes(dispatchLine(task)), JSON.stringify(after));
    assertSkipped(await autoRunSkippedOf(s, ids.ownerId, task), {
      code: 'RETRY_LIMIT_REACHED', dispatchEpoch: moment, sessionId: last.id,
      sessionStatus: RunStatus.FAILED, endReason: null, retryAt: null,
    }, 'the read does not say the failure limit was reached');

    // What that reason leaves to a person still works: Run Now answers to no moment and no budget.
    const manual = await s.tasks.execute(ids.ownerId, task, undefined, `manual-${RUN}`);
    assert.equal(manual.ok, true, `Run Now refused: ${JSON.stringify(manual)}`);
    assert.equal((await workRuns(s.db, task)).length, MAX_AUTO_RUN_FAILURES + 1);
    assert.equal(await autoRunSkippedOf(s, ids.ownerId, task), null);
  } finally {
    await s.db.$disconnect();
  }
});

test('a run somebody stopped is not retried, a CANCELLED run nobody asked for is retried under the '
  + 'same backoff, and the read tells them apart',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'retry-stopped');
    const stopped = await dependentTask(s.db, ids, 'stopped from the task list');
    const filed = await dependentTask(s.db, ids, 'filed away');
    const dropped = await dependentTask(s.db, ids, 'cancelled by the runner');
    const first = await sweep(s);
    const onlyRun = async (taskId: string) => {
      const runs = await workRuns(s.db, taskId);
      assert.equal(runs.length, 1, `the first sweep did not start ${taskId}: ${JSON.stringify(first)}`);
      return runs[0];
    };
    const stoppedRun = await onlyRun(stopped);
    const filedRun = await onlyRun(filed);
    const droppedRun = await onlyRun(dropped);
    const moments = new Map<string, bigint>();
    for (const taskId of [stopped, filed, dropped]) moments.set(taskId, await epochOf(s.db, taskId));

    // A person stops one from the task list (batchStop, through SessionsService.cancel)...
    assert.equal((await s.tasks.batchStop(ids.ownerId, [stopped])).stopped, 1);
    // ...and files another away (Complete)...
    await s.sessions.complete(ids.ownerId, filedRun.id);
    // ...while the third ends CANCELLED with nobody asking: the row the runner's /finalize leaves for
    // a cancel it reports on its own, with no end reason and no filing.
    await s.db.session.update({
      where: { id: droppedRun.id },
      data: { status: RunStatus.CANCELLED, finishedAt: new Date() },
    });
    const ended = new Map((await s.db.session.findMany({
      where: { id: { in: [stoppedRun.id, filedRun.id, droppedRun.id] } },
      select: { id: true, status: true, endReason: true, completedAt: true },
    })).map((row) => [row.id, row]));
    assert.deepEqual(
      [stoppedRun, filedRun, droppedRun].map((run) =>
        [ended.get(run.id)?.status, ended.get(run.id)?.endReason, ended.get(run.id)?.completedAt != null]),
      [
        [RunStatus.CANCELLED, 'cancelled', false],
        [RunStatus.CANCELLED, 'completed', true],
        [RunStatus.CANCELLED, null, false],
      ],
      'the three runs did not end the three ways this case is about',
    );

    // A second inside the first window: the unrequested cancel spends the budget like a failure, so
    // it waits too — a retried end that spent nothing would be retried every minute.
    const windowEnds = new Date(droppedRun.createdAt.getTime() + AUTO_RUN_RETRY_BACKOFF_MS[0]);
    s.clock.now = new Date(windowEnds.getTime() - 1_000);
    const inside = await sweep(s);
    assert.equal((await workRuns(s.db, dropped)).length, 1,
      `an unrequested cancel was retried with no backoff: ${JSON.stringify(inside)}`);
    assertSkipped(await autoRunSkippedOf(s, ids.ownerId, dropped), {
      code: 'RETRY_BACKOFF', dispatchEpoch: moments.get(dropped)!, sessionId: droppedRun.id,
      sessionStatus: RunStatus.CANCELLED, endReason: null, retryAt: windowEnds,
    }, 'the read does not say the cancelled run waits out its backoff window');

    // A day later it is retried, in the same pass that leaves both stopped runs where they are.
    s.clock.now = new Date(droppedRun.createdAt.getTime() + DAY_MS);
    const later = await sweep(s);
    assert.equal((await workRuns(s.db, dropped)).length, 2,
      `the unrequested cancel was not retried: ${JSON.stringify(later)}`);
    assert.equal(await epochOf(s.db, dropped), moments.get(dropped)! + 1n);
    assert.equal(rearms(later, dropped), 1, JSON.stringify(later));
    const requested: Array<[string, { id: string }, string]> = [
      [stopped, stoppedRun, 'cancelled'],
      [filed, filedRun, 'completed'],
    ];
    for (const [taskId, run, endReason] of requested) {
      assert.equal((await workRuns(s.db, taskId)).length, 1,
        `a run ended with ${endReason} was retried: ${JSON.stringify(later)}`);
      assert.equal(await epochOf(s.db, taskId), moments.get(taskId),
        `a run ended with ${endReason} was re-armed`);
      assert.equal(rearms(later, taskId), 0, JSON.stringify(later));
      assert.ok(!later.includes(dispatchLine(taskId)), JSON.stringify(later));
      assertSkipped(await autoRunSkippedOf(s, ids.ownerId, taskId), {
        code: 'STOPPED_ON_REQUEST', dispatchEpoch: moments.get(taskId)!, sessionId: run.id,
        sessionStatus: RunStatus.CANCELLED, endReason, retryAt: null,
      }, `the read does not say the run ended with ${endReason} was stopped on request`);
    }

    // What that reason leaves to a person still works.
    const manual = await s.tasks.execute(ids.ownerId, stopped, undefined, `manual-${RUN}`);
    assert.equal(manual.ok, true, `Run Now refused: ${JSON.stringify(manual)}`);
    assert.equal((await workRuns(s.db, stopped)).length, 2);
    assert.equal(await autoRunSkippedOf(s, ids.ownerId, stopped), null);
  } finally {
    await s.db.$disconnect();
  }
});

test('a run the provider quota killed waits for the reset, and quota failures do not count toward '
  + 'the retry limit',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'retry-quota');
    const task = await dependentTask(s.db, ids, 'killed by the quota');
    await sweep(s);
    const [run] = await workRuns(s.db, task);
    assert.ok(run, 'the first sweep did not start the task');
    const moment = await epochOf(s.db, task);

    // The account's 5-hour window is spent, and the runner reports when it resets.
    const resetsAt = new Date(run.createdAt.getTime() + 60 * 60_000);
    await s.db.runner.update({
      where: { id: ids.runnerId },
      data: {
        planUsage: {
          provider: 'claude', fiveHour: { utilization: 100, resetsAt: resetsAt.toISOString() },
        },
      },
    });
    await failRun(s.db, run.id, QUOTA_ERROR);
    // More quota-killed runs than the failure limit, each started by hand. Counted, they would have
    // retired the task long before the window reopens.
    for (let attempt = 0; attempt < MAX_AUTO_RUN_FAILURES; attempt += 1) {
      const manual = await s.tasks.execute(ids.ownerId, task, undefined, `quota-${attempt}-${RUN}`);
      assert.equal(manual.ok, true, `Run Now refused: ${JSON.stringify(manual)}`);
      await failRun(s.db, manual.sessionId!, QUOTA_ERROR);
    }
    assert.equal((await workRuns(s.db, task)).length, MAX_AUTO_RUN_FAILURES + 1);
    assert.equal(await epochOf(s.db, task), moment, 'the runs started by hand moved the moment');

    // A minute before the reset: nothing starts, nothing is re-armed, and the read names the reset.
    s.clock.now = new Date(resetsAt.getTime() - 60_000);
    const waiting = await sweep(s);
    assert.equal((await workRuns(s.db, task)).length, MAX_AUTO_RUN_FAILURES + 1,
      `dispatched into a spent quota: ${JSON.stringify(waiting)}`);
    assert.equal(await epochOf(s.db, task), moment, 're-armed while the quota was spent');
    assert.equal(rearms(waiting, task), 0, JSON.stringify(waiting));
    assert.ok(!waiting.includes(dispatchLine(task)), JSON.stringify(waiting));
    assertSkipped(await autoRunSkippedOf(s, ids.ownerId, task), {
      code: 'QUOTA_EXHAUSTED', dispatchEpoch: moment, sessionId: run.id,
      sessionStatus: RunStatus.FAILED, endReason: null, retryAt: resetsAt,
    }, 'the read does not say the task waits for the quota to reset');

    // A second after it: the retry goes ahead, because none of those quota failures was spent.
    s.clock.now = new Date(resetsAt.getTime() + 1_000);
    const reset = await sweep(s);
    const runs = await workRuns(s.db, task);
    assert.equal(runs.length, MAX_AUTO_RUN_FAILURES + 2,
      `not retried once the quota reset: ${JSON.stringify(reset)}`);
    const retry = runs.find((r) => r.status === RunStatus.PENDING);
    assert.ok(retry, 'no retry is waiting for the runner');
    assert.equal(await epochOf(s.db, task), moment + 1n);
    assert.deepEqual(await answerOf(s.db, ids.ownerId, task, moment + 1n), { ok: true, sessionId: retry.id });
    assert.equal(await autoRunSkippedOf(s, ids.ownerId, task), null);
  } finally {
    await s.db.$disconnect();
  }
});

test('two reconcile passes racing over one ended run re-arm it once and open exactly one new Session',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  // Two service stacks over two pools, as two replicas, or one replica's overlapping passes, are.
  const a = connect();
  const b = connect();
  try {
    const ids = await world(a.db, 'retry-race');
    const task = await dependentTask(a.db, ids, 'raced over');
    await sweep(a);
    const [run] = await workRuns(a.db, task);
    assert.ok(run, 'the first sweep did not start the task');
    const moment = await epochOf(a.db, task);
    await failRun(a.db, run.id, 'the engine exited before the work was done');
    a.clock.now = new Date(run.createdAt.getTime() + AUTO_RUN_RETRY_BACKOFF_MS[0] + 1_000);
    b.clock.now = a.clock.now;

    // Both passes decide before either one writes. Each holds right after its failure budget is read
    // (the last read before the re-arm) until the other has read its own — without this the two
    // could simply run one after the other, and the case would prove nothing about a race.
    let decided = 0;
    let release!: () => void;
    const bothDecided = new Promise<void>((resolve) => { release = resolve; });
    for (const side of [a, b]) {
      const service = side.tasks as unknown as {
        autoRunHoldOff: (...args: unknown[]) => Promise<unknown>;
      };
      const readBudget = service.autoRunHoldOff.bind(side.tasks);
      let held = false;
      service.autoRunHoldOff = async (...args: unknown[]) => {
        const answer = await readBudget(...args);
        if (!held) {
          held = true;
          decided += 1;
          if (decided === 2) release();
          await waitFor(bothDecided, 60_000, 'the other pass never reached its retry decision');
        }
        return answer;
      };
    }

    const [fromA, fromB] = await Promise.all([sweep(a), sweep(b)]);
    assert.equal(decided, 2, `a pass never decided: ${JSON.stringify({ fromA, fromB })}`);

    const runs = await workRuns(a.db, task);
    assert.equal(runs.length, 2,
      `the race opened ${runs.length - 1} new Sessions: ${JSON.stringify({ fromA, fromB })}`);
    const retry = runs.find((r) => r.id !== run.id)!;
    assert.equal(await epochOf(a.db, task), moment + 1n,
      'the two passes did not move the moment on exactly once');
    assert.equal(rearms(fromA, task) + rearms(fromB, task), 1,
      `both passes reported re-arming: ${JSON.stringify({ fromA, fromB })}`);
    assert.deepEqual(await answerOf(a.db, ids.ownerId, task, moment + 1n), { ok: true, sessionId: retry.id });
  } finally {
    await a.db.$disconnect();
    await b.db.$disconnect();
  }
});
