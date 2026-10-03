import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  CreatorType,
  Prisma,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
import { uuidToBase62, type TaskRunReason } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { readProjectPanorama } from '../projects/project-panorama';
import { readProjectReadyToRun } from '../projects/project-ready-to-run';
import { ProjectsService } from '../projects/projects.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TaskListsService } from '../task-lists/task-lists.service';
import { manualRunnableTaskSql } from '../tasks/manual-runnable-task-sql';
import { taskRunResumeTurnId } from '../tasks/task-run-identity';
import { TasksService } from '../tasks/tasks.service';
import { BG_JOB_ACTIVITY_STALE_AFTER_MS } from './background-job-activity';
import { SessionsService } from './sessions.service';

/**
 * A work session parked at AWAITING_INPUT with something that will wake it is still running its
 * task — on every surface that shows the task, and at every door that would start it — against a
 * real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/task-work-carrier.pg.spec.ts
 *
 * WHAT WAS WRONG
 * ==============
 * 2026-10-02: a task's work session ended its turn to wait for the full pg matrix it had started
 * with `bg_run(wakeOnExit)`. Its row read `status = AWAITING_INPUT`, `running_bg_jobs =
 * {bgj_fffcde016b95}`, and the project page drew the task as Ready to run: the Run queue said
 * "1 ready" with a Run button and counted nothing running. Display and manual Run read only
 * PENDING/RUNNING, on the premise that a parked session is idle. Pressing Run, `task_start` or bulk
 * Run then found no PENDING/RUNNING session and took the RESUME branch, handing the whole task brief
 * to the waiting session as a new turn.
 *
 * WHAT IS ASSERTED, AND HOW
 * =========================
 * One case per wake source (sessions/task-work-carrier.ts): the work session is AWAITING_INPUT with
 * that one source and nothing else, and every reader is asked through its production door — the
 * project task page (workState), the project graph (mark), the Run queue, the panorama buckets, the
 * shared manual-run predicate, `TasksService.withRunning`, and the task list's three counts. Then
 * the two Run doors: `execute` (what POST /tasks/:id/execute, `task_start` and `orbit task start`
 * call) must answer 409 naming the session, `batchExecute` must skip it, and neither may add a
 * `conversation_turn` to the waiting session.
 *
 * Every "it is running" case is paired with the cases that must stay as they were: a session whose
 * only process is a `service` (a dev server never ends, so it never wakes anyone), one with nothing
 * to wake it, and one a person INTERRUPTED — each READY, and Run continues that same session
 * (RESUME), with exactly one new turn. A predicate that called every parked session busy would fail
 * those as loudly as the old one fails the rest.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  sessions: SessionsService;
  tasks: TasksService;
  projects: ProjectsService;
  lists: TaskListsService;
}

function connect(): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return {
    db,
    prisma,
    sessions,
    tasks: new TasksService(prisma, sessions, publishes),
    projects: new ProjectsService(prisma),
    lists: new TaskListsService(prisma, publishes, sessions),
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  listId: string;
  taskId: string;
  /** The work session that has been running the task. */
  sessionId: string;
}

/**
 * An owner with an online runner, a workspace bound to it, a project, a list, one task in both, and
 * the task's work session at `status` with `parked` on it — the columns under test, nothing else.
 * The session has run its opening turn already, as every parked run has: its brief is on it,
 * answered, so a press that continues it adds exactly one turn.
 */
async function world(
  db: PrismaClient,
  label: string,
  parked: Partial<Prisma.SessionUncheckedCreateInput> = {},
  status: RunStatus = RunStatus.AWAITING_INPUT,
): Promise<World> {
  const w: World = {
    ownerId: randomUUID(),
    runnerId: randomUUID(),
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    listId: randomUUID(),
    taskId: randomUUID(),
    sessionId: randomUUID(),
  };
  await db.user.create({
    data: {
      id: w.ownerId, email: `${label}-${RUN}-${w.ownerId}@task-work-carrier.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: w.runnerId, ownerId: w.ownerId, name: `${label}-runner`, tokenHash: `hash-${w.runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: {
      id: w.workspaceId, ownerId: w.ownerId, runnerId: w.runnerId, name: `${label}-agent`,
      enabled: true,
    },
  });
  await db.project.create({ data: { id: w.projectId, ownerId: w.ownerId, title: `${label} project` } });
  await db.taskList.create({ data: { id: w.listId, ownerId: w.ownerId, title: `${label} list` } });
  await db.task.create({
    data: {
      id: w.taskId, ownerId: w.ownerId, projectId: w.projectId, listId: w.listId,
      assigneeId: w.workspaceId, title: `${label} task`, creatorType: CreatorType.USER,
      creatorId: w.ownerId, provider: 'claude', completionCriterion: 'OWNER_CONFIRMED',
    },
  });
  await db.session.create({
    data: {
      id: w.sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId: w.taskId,
      workspaceId: w.workspaceId, assignedRunnerId: w.runnerId, title: `${label} run`,
      prompt: 'the task brief', provider: 'claude', status,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      startedAt: new Date(Date.now() - 60 * 60_000), numTurns: 1,
      ...parked,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: w.sessionId, seq: 1, kind: 'message', content: 'the task brief',
      clientTurnId: SessionsService.initialTurnClientId(w.sessionId), status: 'ANSWERED',
    },
  });
  return w;
}

/** What every surface that shows the task says about it, each read through its own door. */
async function readEverywhere(stack: Stack, w: World) {
  const page = await stack.projects.taskPage(w.ownerId, w.projectId, { limit: '100' });
  const item = page.items.find((row) => row.id === w.taskId);
  assert.ok(item, 'the task is missing from its project page');
  const graph = await stack.projects.dependencyGraph(w.ownerId, w.projectId);
  const mark = graph.marks.find((candidate) => candidate.id === w.taskId);
  assert.ok(mark && mark.kind === 'TASK', 'the task is not drawn as itself on the project graph');
  const queue = await readProjectReadyToRun(stack.prisma, w.ownerId, w.projectId, 10);
  const panorama = await readProjectPanorama(stack.prisma, w.ownerId, w.projectId);
  const manual = await stack.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT t.id FROM task t
     WHERE t.id = ${w.taskId}::uuid AND ${Prisma.raw(manualRunnableTaskSql('t'))}`);
  const [withRunning] = await stack.tasks.withRunning(w.ownerId, [{ id: w.taskId }], true);
  const row = await stack.tasks.listRow(w.ownerId, w.taskId);
  const index = (await stack.lists.list(w.ownerId)).find((list) => list.id === w.listId);
  const detail = (await stack.lists.get(w.ownerId, w.listId)).tasks.find((task) => task.id === w.taskId);
  const summary = await stack.lists.summary(w.ownerId, w.listId);
  return {
    /** The project page's lane, and the reason beside it. */
    page: { workState: item.workState, runReason: item.runReason, runStalled: item.runStalled },
    /** The project graph's node. */
    graph: {
      running: mark.running,
      queued: mark.queued,
      workState: mark.workState,
      runReason: mark.runReason,
      runStalled: mark.runStalled,
    },
    /** Every Run queue row for the task: there must never be two. */
    queue: queue.items
      .filter((candidate) => candidate.taskId === w.taskId)
      .map(({ runState, sessionId, runReason, runStalled }) =>
        ({ runState, sessionId, runReason, runStalled })),
    counts: { ready: queue.readyCount, queued: queue.queuedCount, running: queue.runningCount },
    panorama: { running: panorama.buckets.running, ready: panorama.buckets.ready },
    /** The shared manual-run predicate, asked directly, and as the Ready tab asks it. */
    manualRunnable: manual.length === 1,
    runnable: row.runnable,
    withRunning: {
      running: withRunning.running,
      queued: withRunning.queued,
      runReason: withRunning.runReason,
      runStalled: withRunning.runStalled,
    },
    list: {
      runningTasks: index?.runningTasks,
      running: detail?.running,
      liveSessions: summary.liveSessions,
    },
  };
}

/** Every surface says RUNNING, with `reason`, and offers the session rather than Run. */
function assertCarried(
  seen: Awaited<ReturnType<typeof readEverywhere>>,
  w: World,
  reason: TaskRunReason,
  stalled = false,
) {
  assert.deepEqual(seen.page, { workState: 'RUNNING', runReason: reason, runStalled: stalled },
    'the project page does not say the task is running');
  assert.deepEqual(seen.graph, {
    running: true, queued: false, workState: 'RUNNING', runReason: reason, runStalled: stalled,
  }, 'the project graph does not draw the task as running');
  assert.deepEqual(seen.queue, [
    { runState: 'RUNNING', sessionId: w.sessionId, runReason: reason, runStalled: stalled },
  ], 'the Run queue must show ONE row for the task, RUNNING, with the session to open');
  assert.deepEqual(seen.counts, { ready: 0, queued: 0, running: 1 });
  assert.deepEqual(seen.panorama, { running: 1, ready: 0 });
  assert.equal(seen.manualRunnable, false, 'the task is in the manually runnable set');
  assert.equal(seen.runnable, false, 'the Ready tab offers the task');
  assert.deepEqual(seen.withRunning, {
    running: true, queued: false, runReason: reason, runStalled: stalled,
  }, 'withRunning does not say the task is running');
  assert.deepEqual(seen.list, { runningTasks: 1, running: true, liveSessions: 1 },
    'the task list does not count the task as running');
}

/** Every surface says READY, offers Run, and counts nothing running. */
function assertReady(seen: Awaited<ReturnType<typeof readEverywhere>>) {
  assert.deepEqual(seen.page, { workState: 'READY', runReason: null, runStalled: false });
  assert.deepEqual(seen.graph, {
    running: false, queued: false, workState: 'READY', runReason: null, runStalled: false,
  });
  assert.deepEqual(seen.queue, [
    { runState: 'READY', sessionId: null, runReason: null, runStalled: false },
  ]);
  assert.deepEqual(seen.counts, { ready: 1, queued: 0, running: 0 });
  assert.deepEqual(seen.panorama, { running: 0, ready: 1 });
  assert.equal(seen.manualRunnable, true);
  assert.equal(seen.runnable, true);
  assert.deepEqual(seen.withRunning, {
    running: false, queued: false, runReason: null, runStalled: false,
  });
  assert.deepEqual(seen.list, { runningTasks: 0, running: false, liveSessions: 0 });
}

const turnsOn = (db: PrismaClient, sessionId: string) =>
  db.conversationTurn.count({ where: { sessionId } });

/** Both Run doors refuse the task, name the session, and hand it nothing. */
async function assertRunRefused(stack: Stack, w: World) {
  const turns = await turnsOn(stack.db, w.sessionId);

  const refusal = await stack.tasks
    .execute(w.ownerId, w.taskId, undefined, `press-${randomUUID()}`)
    .then(() => null, (error: unknown) => error as { status?: number; response?: Record<string, unknown> });
  assert.ok(refusal, 'Run started a task whose session is still carrying it');
  assert.equal(refusal.status, 409);
  assert.equal(refusal.response?.code, 'TASK_ALREADY_RUNNING');
  assert.equal(refusal.response?.conflictingSessionId, uuidToBase62(w.sessionId),
    'the 409 must name the session that is carrying the task');
  assert.equal(refusal.response?.conflictingSessionStatus, RunStatus.AWAITING_INPUT);

  const batch = await stack.tasks.batchExecute(w.ownerId, [w.taskId], undefined, randomUUID());
  assert.equal(batch.dispatched, 0);
  assert.deepEqual(batch.skipped.map((skipped) => skipped.id), [w.taskId],
    'bulk Run must classify the task as skipped');
  assert.match(batch.skipped[0].reason, new RegExp(uuidToBase62(w.sessionId)));

  assert.equal(await turnsOn(stack.db, w.sessionId), turns,
    'the task brief was delivered into the session that is waiting');
  const after = await stack.db.session.findUniqueOrThrow({
    where: { id: w.sessionId }, select: { status: true },
  });
  assert.equal(after.status, RunStatus.AWAITING_INPUT, 'the waiting session was woken by Run');
  assert.equal(await stack.db.session.count({ where: { taskId: w.taskId } }), 1,
    'and no second run was opened beside it');
}

/** Run continues the parked session itself: one new turn on it, under the press's own key. */
async function assertRunResumes(stack: Stack, w: World) {
  const turns = await turnsOn(stack.db, w.sessionId);
  const press = `press-${randomUUID()}`;

  const started = await stack.tasks.execute(w.ownerId, w.taskId, undefined, press);

  assert.equal(started.sessionId, w.sessionId, 'Run must continue the parked session (RESUME)');
  assert.equal(await turnsOn(stack.db, w.sessionId), turns + 1);
  assert.equal(await stack.db.conversationTurn.count({
    where: { sessionId: w.sessionId, clientTurnId: taskRunResumeTurnId(press, w.sessionId) },
  }), 1, 'the task brief is the new turn, under the key the press names');
  assert.equal(await stack.db.session.count({ where: { taskId: w.taskId } }), 1);
}

/** A watch that resumes this session — what `task_await`, `session_await` and `watch_create` leave. */
const observingWatch = (db: PrismaClient, w: World) => db.watch.create({
  data: {
    ownerId: w.ownerId,
    observerType: 'SESSION',
    observerSessionId: w.sessionId,
    predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
    mode: 'ONE_SHOT',
    action: 'RESUME_SESSION',
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
  },
});

/** One wake source per case, alone on an otherwise idle AWAITING_INPUT work session. */
const WAKE_SOURCES: Array<{
  name: string;
  reason: TaskRunReason;
  parked?: Partial<Prisma.SessionUncheckedCreateInput>;
  arm?: (db: PrismaClient, w: World) => Promise<unknown>;
}> = [
  {
    name: 'a runner-hosted background job it started (running_bg_jobs)',
    reason: 'BACKGROUND_JOB',
    parked: {
      runningBgShells: ['bgj_fffcde016b95'],
      runningBgJobs: ['bgj_fffcde016b95'],
      runningBgJobActivity: { bgj_fffcde016b95: Date.now() - 30_000 },
    },
  },
  {
    name: 'an ACTIVE RESUME_SESSION watch it observes (task_await / session_await / watch_create)',
    reason: 'WAITING',
    arm: observingWatch,
  },
  {
    name: 'a PENDING scheduled wake-up (schedule_wakeup)',
    reason: 'WAITING',
    arm: (db, w) => db.sessionScheduledWakeup.create({
      data: {
        sessionId: w.sessionId, delaySeconds: 1800, reason: 'check on the matrix',
        dueAt: new Date(Date.now() + 30 * 60_000),
      },
    }),
  },
  {
    name: 'a sub-agent still in flight (running_subagents)',
    reason: 'TURN',
    parked: { runningSubagents: ['toolu_subagent'] },
  },
  {
    name: 'a turn the engine is generating on its own (engine_turn_active)',
    reason: 'TURN',
    parked: { engineTurnActive: true },
  },
  {
    name: 'an armed auto-retry (retry_at)',
    reason: 'WAITING',
    parked: { retryAt: new Date(Date.now() + 20 * 60_000) },
  },
];

for (const [index, source] of WAKE_SOURCES.entries()) {
  test(`AWAITING_INPUT with ${source.name} is RUNNING everywhere, and Run refuses it`,
    { skip, timeout: 120_000 }, async () => {
      assertCoordinatorPgUrlIsIsolated(URL!);
      const stack = connect();
      try {
        const w = await world(stack.db, `wake-${index}`, source.parked);
        await source.arm?.(stack.db, w);

        assertCarried(await readEverywhere(stack, w), w, source.reason);
        await assertRunRefused(stack, w);
      } finally {
        await stack.db.$disconnect();
      }
    });
}

test('a background job that has been silent past the threshold keeps the task RUNNING, flagged stalled',
  { skip, timeout: 120_000 }, async () => {
    // The lane is not narrowed by the clients' ten-minute freshness: a job that writes nothing is
    // still a process that will wake its session when it ends — a compile's silent phase looks
    // exactly like this. The flag rides beside the reason instead.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const w = await world(stack.db, 'stalled-job', {
        runningBgShells: ['bgj_quiet'],
        runningBgJobs: ['bgj_quiet'],
        runningBgJobActivity: { bgj_quiet: Date.now() - BG_JOB_ACTIVITY_STALE_AFTER_MS - 60_000 },
      });

      assertCarried(await readEverywhere(stack, w), w, 'BACKGROUND_JOB', true);
      await assertRunRefused(stack, w);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a PENDING work session is still QUEUED, not RUNNING, wherever a row says which',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const w = await world(stack.db, 'queued', {}, RunStatus.PENDING);

      const seen = await readEverywhere(stack, w);
      assert.equal(seen.page.workState, 'RUNNING', 'a queued run is work in flight on the page lane');
      assert.equal(seen.graph.queued, true);
      assert.equal(seen.graph.running, false);
      assert.deepEqual(seen.queue, [
        { runState: 'QUEUED', sessionId: w.sessionId, runReason: 'TURN', runStalled: false },
      ]);
      assert.deepEqual(seen.counts, { ready: 0, queued: 1, running: 0 });
      assert.equal(seen.withRunning.queued, true);
      assert.equal(seen.withRunning.running, false);
      assert.equal(seen.manualRunnable, false);
    } finally {
      await stack.db.$disconnect();
    }
  });

const IDLE: Array<{
  name: string;
  status: RunStatus;
  parked?: Partial<Prisma.SessionUncheckedCreateInput>;
  arm?: (db: PrismaClient, w: World) => Promise<unknown>;
}> = [
  {
    // `running_bg_shells` without `running_bg_jobs`: a `service` the agent left running on purpose.
    // It never ends, so it never wakes the session.
    name: 'AWAITING_INPUT whose only process is a service (running_bg_shells, no running_bg_jobs)',
    status: RunStatus.AWAITING_INPUT,
    parked: { runningBgShells: ['bgj_devserver'] },
  },
  {
    name: 'AWAITING_INPUT with nothing that will wake it',
    status: RunStatus.AWAITING_INPUT,
  },
  {
    // Not a wake source but a person's stop: Run on an interrupted session means "go on", whatever
    // it was waiting for when it was stopped.
    name: 'INTERRUPTED, even with a background job and a watch',
    status: RunStatus.INTERRUPTED,
    parked: {
      runningBgShells: ['bgj_left_behind'],
      runningBgJobs: ['bgj_left_behind'],
      runningBgJobActivity: { bgj_left_behind: Date.now() },
    },
    arm: observingWatch,
  },
];

for (const [index, idle] of IDLE.entries()) {
  test(`${idle.name} stays READY, and Run continues that session`,
    { skip, timeout: 120_000 }, async () => {
      assertCoordinatorPgUrlIsIsolated(URL!);
      const stack = connect();
      try {
        const w = await world(stack.db, `idle-${index}`, idle.parked, idle.status);
        await idle.arm?.(stack.db, w);

        assertReady(await readEverywhere(stack, w));
        await assertRunResumes(stack, w);
      } finally {
        await stack.db.$disconnect();
      }
    });
}

test('a watch that no longer resumes the session — ended, or a NOTIFY_USER one — is not a wake source',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const w = await world(stack.db, 'spent-watches');
      const matched = await observingWatch(stack.db, w);
      await stack.db.watch.update({ where: { id: matched.id }, data: { state: 'CANCELLED' } });
      await stack.db.watch.create({
        data: {
          ownerId: w.ownerId,
          observerType: 'USER',
          predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
          mode: 'ONE_SHOT',
          action: 'NOTIFY_USER',
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
      });
      await stack.db.sessionScheduledWakeup.create({
        data: {
          sessionId: w.sessionId, delaySeconds: 60, reason: 'already delivered', state: 'DELIVERED',
          dueAt: new Date(Date.now() - 60_000), settledAt: new Date(),
        },
      });

      assertReady(await readEverywhere(stack, w));
    } finally {
      await stack.db.$disconnect();
    }
  });
