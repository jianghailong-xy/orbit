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
  TaskStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { reclaimStalledTask } from './reclaim-stalled-task';
import { TasksService } from './tasks.service';

/**
 * A project's "At most N tasks at a time" is spent on work that is moving, not on a task session
 * parked with nothing that will wake it — against a real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/project-budget-idle-session.pg.spec.ts
 *
 * WHAT WAS WRONG
 * ==============
 * 2026-10-26, a project with room for three. Task C1b found a bug, ended its turn with nothing left
 * running, and sat at AWAITING_INPUT waiting for the task that would fix it. That fix task opted
 * into auto-run and had no prerequisites, and it stayed unstarted for 13 hours with no refusal and
 * no skip recorded on it. O3 was RUNNING, A6 was parked on a background job, and C1b's idle session
 * filled the third slot: the budget counted a task as occupying a slot while any of its sessions
 * was PENDING, RUNNING, AWAITING_INPUT or INTERRUPTED (TASK_OCCUPYING), so a session that nothing
 * would ever wake held its slot for as long as it stayed open. The fix started only after a person
 * ended C1b's session and started the fix by hand.
 *
 * WHAT IS ASSERTED, AND HOW
 * =========================
 * The budget counts a task while one of its work sessions CARRIES it (sessions/task-work-carrier.ts):
 * a turn queued or running, or a session parked at AWAITING_INPUT with a wake source. Every case
 * drives a production door and counts the sessions that exist afterwards, never a call:
 *
 *   (1) the incident, replayed: the fix starts on the next ready sweep and nobody ends anything,
 *       and the run it gets fills the slot again, so the sweep after it starts nothing more;
 *   (2) a session a person INTERRUPTED frees its slot too;
 *   (3) what still holds a slot holds it: PENDING, RUNNING, and AWAITING_INPUT with each wake source
 *       alone. Each case is its own control, one column away: the same session with that one thing
 *       gone frees the slot, so a budget that held regardless fails it as loudly as one that held
 *       nothing;
 *   (4) every automatic door that spends the budget reads the same count: the scheduled sweep, the
 *       dependency edge, its read ahead of a completion (`assumeCompleted`, the `settling` count),
 *       and the independent release on a completion;
 *   (5) the owner's message to an idle task session is not limited by the budget, the session it
 *       wakes counts again, and while it does no automatic door goes past the cap;
 *   (6) only the budget's count changed: the candidate scans still refuse a task whose own session
 *       is parked, the stall reclaim still leaves it alone, and the claim index still admits one
 *       live session per task.
 *
 * Not fixed here, and pinned by (3)'s watch row: a session waiting on a sibling task through
 * `task_await` holds an ACTIVE RESUME_SESSION watch, so it carries its task, holds its slot, and can
 * still deadlock a full project.
 *
 * Not destructive: every case owns freshly generated ids. The sweeps are deployment-wide, so each
 * case reads only the counts of its own rows.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface Stack {
  db: PrismaClient;
  sessions: SessionsService;
  tasks: TasksService;
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
  return { db, sessions, tasks: new TasksService(prisma, sessions, publishes) };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
}

/**
 * An owner with one online runner, a workspace bound to it, and a started project with room for
 * `cap` tasks at a time. The runner has room for eight, so whatever is held back below is held by
 * the project's budget and by nothing else.
 */
async function world(db: PrismaClient, label: string, cap: number): Promise<World> {
  const w: World = {
    ownerId: randomUUID(),
    runnerId: randomUUID(),
    workspaceId: randomUUID(),
    projectId: randomUUID(),
  };
  await db.user.create({
    data: {
      id: w.ownerId, email: `${label}-${RUN}-${w.ownerId}@project-budget.invalid`, name: label,
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
  await db.project.create({
    data: {
      id: w.projectId, ownerId: w.ownerId, title: label, coordinatorEnabled: true,
      maxConcurrentTasks: cap, startedAt: new Date(),
    },
  });
  await establishProjectContractForPgTest(db, w.ownerId, w.projectId, label);
  return w;
}

/**
 * A task of the project, assigned to the workspace on the live runner: by default the shape the
 * automatic doors start by themselves — OPEN, opted into auto-run, depending on nothing.
 */
async function seedTask(
  db: PrismaClient,
  w: World,
  title: string,
  extra: Partial<Prisma.TaskUncheckedCreateInput> = {},
): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id, ownerId: w.ownerId, projectId: w.projectId, assigneeId: w.workspaceId, title,
      creatorType: CreatorType.USER, creatorId: w.ownerId, provider: 'claude',
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: TaskStatus.OPEN, autoRunWhenReady: true, dispatchHold: false,
      ...extra,
    },
  });
  return id;
}

/** A task still being worked on, and the work session it was dispatched to. */
interface Holder {
  taskId: string;
  sessionId: string;
}

/**
 * A task still outstanding (IN_PROGRESS unless `task` says otherwise) and its work session at
 * `status` with `parked` on it — the columns under test, and nothing else. The session has run its
 * opening turn, as every parked run has: its brief is on it, answered.
 */
async function holding(
  db: PrismaClient,
  w: World,
  title: string,
  status: RunStatus,
  parked: Partial<Prisma.SessionUncheckedCreateInput> = {},
  task: Partial<Prisma.TaskUncheckedCreateInput> = {},
): Promise<Holder> {
  const taskId = await seedTask(db, w, title, { status: TaskStatus.IN_PROGRESS, ...task });
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId,
      workspaceId: w.workspaceId, assignedRunnerId: w.runnerId, title: `${title} run`,
      prompt: 'the task brief', provider: 'claude', status,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      startedAt: new Date(Date.now() - 60 * 60_000), numTurns: 1,
      ...parked,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId, seq: 1, kind: 'message', content: 'the task brief',
      clientTurnId: SessionsService.initialTurnClientId(sessionId), status: 'ANSWERED',
    },
  });
  return { taskId, sessionId };
}

/** A runner-hosted `bg_run` job the session started and that will wake it when it exits. */
const BACKGROUND_JOB: Partial<Prisma.SessionUncheckedCreateInput> = {
  runningBgShells: ['bgj_matrix'],
  runningBgJobs: ['bgj_matrix'],
  runningBgJobActivity: { bgj_matrix: Date.now() - 30_000 },
};

/** The job ended without waking anybody: nothing left on the session that will. */
const endBackgroundJob = (db: PrismaClient, sessionId: string) => db.session.update({
  where: { id: sessionId },
  data: { runningBgShells: [], runningBgJobs: [], runningBgJobActivity: {} },
});

/** How many runs a task has: whether an automatic door started it is a session that now exists. */
const runs = (db: PrismaClient, taskId: string) => db.session.count({ where: { taskId } });

/** The once-a-minute ready sweep, called exactly as the service's one timer calls it. */
const readySweep = (s: Stack) =>
  (s.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

/** The scheduled sweep, on the same timer. */
const scheduledSweep = (s: Stack) =>
  (s.tasks as unknown as { dispatchDueScheduledTasks(): Promise<void> }).dispatchDueScheduledTasks();

/** The production completion edge: the dependency dispatch, then the independent release. */
const completionEdge = (s: Stack, ownerId: string, doneTaskId: string) =>
  s.tasks.dispatchDependentsAfterCompletion(ownerId, doneTaskId);

/** The room the automatic doors read for the project: its cap less what it has occupied. */
async function room(s: Stack, projectId: string): Promise<number | undefined> {
  const budget = await (s.tasks as unknown as {
    projectBudget(projectIds: string[]): Promise<Map<string, number>>;
  }).projectBudget([projectId]);
  return budget.get(projectId);
}

// -------------------------------------------------------------------------------------------------
// (1) The incident, replayed.
// -------------------------------------------------------------------------------------------------

test('(1) the 2026-10-26 incident: a session parked with nothing to wake it frees its slot, and the '
  + 'fix task starts on the next sweep with nobody ending anything',
{ skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'incident', 3);
    const o3 = await holding(s.db, w, 'O3', RunStatus.RUNNING);
    const a6 = await holding(s.db, w, 'A6', RunStatus.AWAITING_INPUT, BACKGROUND_JOB);
    // Ended its turn with no background job, to wait for the fix: idle in the plain sense.
    const c1b = await holding(s.db, w, 'C1b', RunStatus.AWAITING_INPUT);
    // The fix, raised as it was in the incident, and one more ready task behind it: one slot is
    // free, so exactly one of them may start, and the raised one goes first.
    const fix = await seedTask(s.db, w, 'the fix C1b waits for', { priority: 3 });
    const next = await seedTask(s.db, w, 'the next task in the queue');

    await readySweep(s);

    assert.equal(await runs(s.db, fix), 1,
      'the fix task was not started: an idle AWAITING_INPUT session still holds a slot');
    assert.equal(await runs(s.db, next), 0,
      'two tasks started on the one slot the idle session left free');
    // Nobody ended or started anything by hand: the waiting session is exactly where it was, and
    // each of the three tasks still has the one run it had.
    const waiting = await s.db.session.findUniqueOrThrow({
      where: { id: c1b.sessionId }, select: { status: true, endReason: true },
    });
    assert.deepEqual(waiting, { status: RunStatus.AWAITING_INPUT, endReason: null },
      'the waiting session was ended or woken to make room');
    for (const held of [o3, a6, c1b]) {
      assert.equal(await runs(s.db, held.taskId), 1, 'a slot holder was given a second run');
    }

    // The fix's run now holds the slot the idle session left, so the project is at its cap: the
    // next sweep starts nothing more.
    assert.equal(await room(s, w.projectId), 0, 'the fix task\'s queued run is not counted');
    await readySweep(s);
    assert.equal(await runs(s.db, next), 0, 'the sweep went past the project\'s cap of three');
  } finally {
    await s.db.$disconnect();
  }
});

// -------------------------------------------------------------------------------------------------
// (2) A person's stop.
// -------------------------------------------------------------------------------------------------

test('(2) a session a person INTERRUPTED does not hold a slot either',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const w = await world(s.db, 'interrupted', 1);
      const stopped = await holding(s.db, w, 'stopped by a person', RunStatus.INTERRUPTED);
      const ready = await seedTask(s.db, w, 'ready');

      await readySweep(s);

      assert.equal(await runs(s.db, ready), 1,
        'the project\'s one slot is still held by a run a person stopped');
      const after = await s.db.session.findUniqueOrThrow({
        where: { id: stopped.sessionId }, select: { status: true },
      });
      assert.equal(after.status, RunStatus.INTERRUPTED, 'the stopped session was moved to make room');
    } finally {
      await s.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (3) What still holds a slot.
// -------------------------------------------------------------------------------------------------

/** A watch that resumes this session — what `task_await`, `session_await` and `watch_create` leave. */
const observingWatch = (db: PrismaClient, ownerId: string, sessionId: string) => db.watch.create({
  data: {
    ownerId,
    observerType: 'SESSION',
    observerSessionId: sessionId,
    predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
    mode: 'ONE_SHOT',
    action: 'RESUME_SESSION',
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
  },
});

/** Its turn ended with nothing left to wake it. */
const turnEnded = (db: PrismaClient, sessionId: string) => db.session.update({
  where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT },
});

/**
 * Each way a work session still carries its task, alone, with what takes exactly that away and
 * leaves the session parked with nothing to wake it.
 */
const HOLDERS: Array<{
  name: string;
  status: RunStatus;
  parked?: Partial<Prisma.SessionUncheckedCreateInput>;
  arm?: (db: PrismaClient, ownerId: string, sessionId: string) => Promise<unknown>;
  release: (db: PrismaClient, sessionId: string) => Promise<unknown>;
}> = [
  {
    name: 'a PENDING session (a turn queued for a runner slot)',
    status: RunStatus.PENDING,
    release: turnEnded,
  },
  {
    name: 'a RUNNING session (a turn in flight)',
    status: RunStatus.RUNNING,
    release: turnEnded,
  },
  {
    name: 'AWAITING_INPUT with a running background job (running_bg_jobs)',
    status: RunStatus.AWAITING_INPUT,
    parked: BACKGROUND_JOB,
    release: endBackgroundJob,
  },
  {
    // The known gap: this is also what a session waiting on a sibling task through task_await
    // looks like, so that wait still holds its slot.
    name: 'AWAITING_INPUT waiting on a watch it observes (task_await / session_await / watch_create)',
    status: RunStatus.AWAITING_INPUT,
    arm: observingWatch,
    release: (db, sessionId) => db.watch.updateMany({
      where: { observerSessionId: sessionId }, data: { state: 'CANCELLED', nextEvaluateAt: null },
    }),
  },
  {
    name: 'AWAITING_INPUT with a pending scheduled wake-up (schedule_wakeup)',
    status: RunStatus.AWAITING_INPUT,
    arm: (db, _ownerId, sessionId) => db.sessionScheduledWakeup.create({
      data: {
        sessionId, delaySeconds: 1800, reason: 'check on the matrix',
        dueAt: new Date(Date.now() + 30 * 60_000),
      },
    }),
    release: (db, sessionId) => db.sessionScheduledWakeup.updateMany({
      where: { sessionId, state: 'PENDING' }, data: { state: 'CANCELLED', settledAt: new Date() },
    }),
  },
  {
    name: 'AWAITING_INPUT with an armed auto-retry (retry_at)',
    status: RunStatus.AWAITING_INPUT,
    parked: { retryAt: new Date(Date.now() + 20 * 60_000) },
    release: (db, sessionId) => db.session.update({
      where: { id: sessionId }, data: { retryAt: null },
    }),
  },
  {
    name: 'AWAITING_INPUT with sub-agents still running (running_subagents)',
    status: RunStatus.AWAITING_INPUT,
    parked: { runningSubagents: ['toolu_subagent'] },
    release: (db, sessionId) => db.session.update({
      where: { id: sessionId }, data: { runningSubagents: [] },
    }),
  },
  {
    name: 'AWAITING_INPUT with an active engine turn (engine_turn_active)',
    status: RunStatus.AWAITING_INPUT,
    parked: { engineTurnActive: true },
    release: (db, sessionId) => db.session.update({
      where: { id: sessionId }, data: { engineTurnActive: false },
    }),
  },
];

for (const [index, holder] of HOLDERS.entries()) {
  test(`(3) ${holder.name} still holds its slot, and frees it once that is gone`,
    { skip, timeout: 120_000 }, async () => {
      assertCoordinatorPgUrlIsIsolated(URL!);
      const s = connect();
      try {
        const w = await world(s.db, `holder-${index}`, 1);
        const held = await holding(s.db, w, 'the slot holder', holder.status, holder.parked);
        await holder.arm?.(s.db, w.ownerId, held.sessionId);
        const ready = await seedTask(s.db, w, 'ready');

        await readySweep(s);

        assert.equal(await runs(s.db, ready), 0,
          `the project's one slot was given away while ${holder.name} still held it`);
        assert.equal(await room(s, w.projectId), 0);

        // One column away: the same session, with the one thing that kept it moving gone.
        await holder.release(s.db, held.sessionId);
        await readySweep(s);

        assert.equal(await runs(s.db, ready), 1,
          'the slot stayed held once nothing could wake the session');
        assert.equal(await runs(s.db, held.taskId), 1, 'the slot holder was given a second run');
      } finally {
        await s.db.$disconnect();
      }
    });
}

// -------------------------------------------------------------------------------------------------
// (4) Every door that spends the budget reads the same count.
// -------------------------------------------------------------------------------------------------

test('(4a) the scheduled sweep: a due task waits behind a parked session with a wake source, and '
  + 'starts once nothing can wake it',
{ skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'scheduled', 1);
    const held = await holding(s.db, w, 'parked on a job', RunStatus.AWAITING_INPUT, BACKGROUND_JOB);
    // Not opted into auto-run, so the schedule is the only thing that starts it.
    const due = await seedTask(s.db, w, 'due', {
      autoRunWhenReady: false, runAt: new Date(Date.now() - 60_000),
    });

    await scheduledSweep(s);
    assert.equal(await runs(s.db, due), 0, 'the schedule started a task on a full project');
    const kept = await s.db.task.findUniqueOrThrow({ where: { id: due }, select: { runAt: true } });
    assert.notEqual(kept.runAt, null, 'a schedule held back for a slot was consumed');

    await endBackgroundJob(s.db, held.sessionId);
    await scheduledSweep(s);
    assert.equal(await runs(s.db, due), 1,
      'the due task did not start once the only session in its project was idle');
  } finally {
    await s.db.$disconnect();
  }
});

test('(4b) the dependency edge: a released dependent waits behind a parked session with a wake '
  + 'source, and starts once nothing can wake it',
{ skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'dependency-edge', 1);
    const held = await holding(s.db, w, 'parked on a job', RunStatus.AWAITING_INPUT, BACKGROUND_JOB);
    const prerequisite = await seedTask(s.db, w, 'prerequisite', { status: TaskStatus.DONE });
    const dependent = await seedTask(s.db, w, 'dependent');
    await s.db.taskDependency.create({ data: { taskId: dependent, dependsOnTaskId: prerequisite } });

    await completionEdge(s, w.ownerId, prerequisite);
    assert.equal(await runs(s.db, dependent), 0, 'the edge started a dependent on a full project');

    await endBackgroundJob(s.db, held.sessionId);
    await completionEdge(s, w.ownerId, prerequisite);
    assert.equal(await runs(s.db, dependent), 1,
      'the dependent did not start once the only session in its project was idle');
  } finally {
    await s.db.$disconnect();
  }
});

test('(4c) the release read ahead of a completion (assumeCompleted) counts the same way, with the '
  + 'finishing task\'s own slot given back',
{ skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'settling', 1);
    // The task about to be confirmed DONE: its own run holds the one slot, which its DONE gives back.
    const finishing = await holding(s.db, w, 'finishing', RunStatus.RUNNING);
    const idle = await holding(s.db, w, 'waiting for a person', RunStatus.AWAITING_INPUT);
    const dependent = await seedTask(s.db, w, 'dependent');
    await s.db.taskDependency.create({
      data: { taskId: dependent, dependsOnTaskId: finishing.taskId },
    });

    const ahead = await s.tasks.dependentRelease(w.ownerId, finishing.taskId, { assumeCompleted: true });
    assert.deepEqual(ahead.start.map((released) => released.id), [dependent],
      'the read ahead of the completion counted the idle session against the budget');
    assert.deepEqual(ahead.waitingForSlot, []);

    // One column away: the waiting session given a wake source holds the slot again.
    await s.db.session.update({ where: { id: idle.sessionId }, data: BACKGROUND_JOB });
    const held = await s.tasks.dependentRelease(w.ownerId, finishing.taskId, { assumeCompleted: true });
    assert.deepEqual(held.start, [], 'a parked session with a wake source did not hold its slot');
    assert.deepEqual(held.waitingForSlot, [dependent]);
  } finally {
    await s.db.$disconnect();
  }
});

test('(4d) the independent release on a completion: a sibling waits behind a parked session with a '
  + 'wake source, and starts once nothing can wake it',
{ skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'independent-release', 1);
    const held = await holding(s.db, w, 'parked on a job', RunStatus.AWAITING_INPUT, BACKGROUND_JOB);
    const finished = await seedTask(s.db, w, 'finished', { status: TaskStatus.DONE });
    const sibling = await seedTask(s.db, w, 'sibling');

    await completionEdge(s, w.ownerId, finished);
    assert.equal(await runs(s.db, sibling), 0, 'the release started a sibling on a full project');

    await endBackgroundJob(s.db, held.sessionId);
    await completionEdge(s, w.ownerId, finished);
    assert.equal(await runs(s.db, sibling), 1,
      'the sibling did not start once the only session in its project was idle');
  } finally {
    await s.db.$disconnect();
  }
});

// -------------------------------------------------------------------------------------------------
// (5) The owner's message.
// -------------------------------------------------------------------------------------------------

test('(5) the owner\'s message to an idle task session is not held by the budget, and the session '
  + 'it wakes counts again',
{ skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'owner-message', 1);
    const waiting = await holding(s.db, w, 'waiting for the owner', RunStatus.AWAITING_INPUT);
    const first = await seedTask(s.db, w, 'first', { createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const second = await seedTask(s.db, w, 'second', { createdAt: new Date('2026-01-02T00:00:00.000Z') });

    // The idle session leaves the one slot free, and the sweep fills it.
    await readySweep(s);
    assert.equal(await runs(s.db, first), 1, 'the idle session still holds the project\'s one slot');
    assert.equal(await runs(s.db, second), 0);
    assert.equal(await room(s, w.projectId), 0);

    // The owner answers the waiting session while the project is at its cap. A message is a turn on
    // a session that already exists, not an automatic start, and nothing about the budget is asked.
    await s.sessions.createTurn(w.ownerId, waiting.sessionId, {
      clientTurnId: randomUUID(), content: 'the fix has landed; go on',
    });
    const woken = await s.db.session.findUniqueOrThrow({
      where: { id: waiting.sessionId }, select: { status: true },
    });
    assert.equal(woken.status, RunStatus.PENDING, 'the owner\'s message did not queue a turn');
    assert.equal(await s.db.conversationTurn.count({ where: { sessionId: waiting.sessionId } }), 2);

    // Working again, it counts again: two tasks on a cap of one, and no automatic door adds a third.
    assert.equal(await room(s, w.projectId), -1, 'the woken session is not counted against the budget');
    await readySweep(s);
    assert.equal(await runs(s.db, second), 0, 'the sweep started a task on a project past its cap');

    // The first task's run ends with nothing to wake it: the woken session alone holds the slot.
    await s.db.session.updateMany({
      where: { taskId: first }, data: { status: RunStatus.AWAITING_INPUT },
    });
    await readySweep(s);
    assert.equal(await runs(s.db, second), 0, 'the woken session stopped counting while it works');

    // And once its turn is answered with nothing left to wake it, the slot is the queue's again.
    await s.db.conversationTurn.updateMany({
      where: { sessionId: waiting.sessionId }, data: { status: 'ANSWERED' },
    });
    await turnEnded(s.db, waiting.sessionId);
    await readySweep(s);
    assert.equal(await runs(s.db, second), 1, 'the slot stayed held after the woken session went idle');
  } finally {
    await s.db.$disconnect();
  }
});

// -------------------------------------------------------------------------------------------------
// (6) Only the budget's count changed.
// -------------------------------------------------------------------------------------------------

test('(6) an idle session frees its budget slot, while the candidate scans, the stall reclaim and '
  + 'the claim index still see it occupying its own task',
{ skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'occupying', 2);
    // An auto-run task with no prerequisites whose run is parked idle while the task stayed OPEN:
    // the ready sweep would offer it if its own session did not still occupy it.
    const parkedOpen = await holding(s.db, w, 'parked, task still open', RunStatus.AWAITING_INPUT, {},
      { status: TaskStatus.OPEN });
    const stalled = await holding(s.db, w, 'parked, task in progress', RunStatus.AWAITING_INPUT);
    const ready = await seedTask(s.db, w, 'ready');

    await readySweep(s);

    assert.equal(await runs(s.db, ready), 1, 'two idle sessions still filled a budget of two');
    // The candidate scan still reads TASK_OCCUPYING: the parked task was not offered, so nothing
    // resumed its session or opened a second run beside it.
    assert.equal(await runs(s.db, parkedOpen.taskId), 1, 'a second run was opened beside a parked one');
    const parked = await s.db.session.findUniqueOrThrow({
      where: { id: parkedOpen.sessionId }, select: { status: true },
    });
    assert.equal(parked.status, RunStatus.AWAITING_INPUT, 'the sweep resumed a parked session');
    assert.equal(await s.db.conversationTurn.count({ where: { sessionId: parkedOpen.sessionId } }), 1,
      'the sweep handed the task brief to its parked session');
    assert.equal(await s.db.taskRunRequest.count({
      where: { ownerId: w.ownerId, fingerprint: `task:${parkedOpen.taskId}` },
    }), 0, 'the sweep offered a task its own session still occupies');

    // The stall reclaim still reads TASK_OCCUPYING: a task whose run is parked is not stalled.
    const reclaimed = await s.db.$transaction((tx) => reclaimStalledTask(tx, stalled.taskId));
    assert.equal(reclaimed, false, 'the stall reclaim moved a task whose session is parked');
    const task = await s.db.task.findUniqueOrThrow({
      where: { id: stalled.taskId }, select: { status: true },
    });
    assert.equal(task.status, TaskStatus.IN_PROGRESS);

    // The claim index still admits one live session per task, idle or not.
    await assert.rejects(
      s.db.session.create({
        data: {
          id: randomUUID(), ownerId: w.ownerId, creatorId: w.ownerId, taskId: stalled.taskId,
          workspaceId: w.workspaceId, assignedRunnerId: w.runnerId, title: 'a second run',
          prompt: 'the task brief', provider: 'claude', status: RunStatus.PENDING,
          dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'P2002', 'refused, but not as a unique violation');
        assert.match(String((error as Error).message), /session_task_execution_claim_idx/,
          'refused, but not by the execution claim index');
        return true;
      },
      'a second live session was admitted beside a parked one',
    );
  } finally {
    await s.db.$disconnect();
  }
});
