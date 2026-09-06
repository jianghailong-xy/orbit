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
import { TasksService } from './tasks.service';

/**
 * Finishing a task releases the NEXT one, including when nothing was waiting on it.
 *
 * `dispatchDependentsOf` answers "what did this completion unblock", and a project filed as a batch
 * of mutually independent tasks has no answer to give: no edge names any of them, the auto-run
 * sweep requires a candidate to HAVE one, and the batch stops after whatever a person started by
 * hand. On 2026-09-05 that was eight tasks pushed through one at a time by a person watching.
 *
 * `dispatchIndependentSiblingsOf` is the pass that starts the next one. What it must NOT do is
 * become a way around the three vetoes that already exist — a task's own `auto_run_when_ready`
 * opt-in, the `dispatch_hold` a paused list writes, and the project's `max_concurrent_tasks` — nor
 * change anything about the dependency dispatch it sits beside.
 *
 * Asserted against a real PostgreSQL and by COUNTING SESSIONS, never by observing a call: "was it
 * released" is the question, and the only honest evidence for it is the run that exists afterwards.
 * Every control here differs from its positive in exactly one column, in the same fixture, so a
 * pass that simply started everything and a pass that started nothing both fail.
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

/** An owner with one online runner and one workspace bound to it. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), agentId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@release.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(),
      // Room for every task a fixture here means to start. The materialisation budget spends the
      // runner's own cap, so leaving it at the default of 1 would make a control group look like a
      // regression: the second task would be held by the RUNNER rather than by the veto under test.
      maxConcurrent: 8,
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

/** A coordinated project with a real completion contract, and room for three tasks by default. */
async function project(
  db: PrismaClient,
  ids: World,
  label: string,
  opts: { coordinatorEnabled?: boolean; maxConcurrentTasks?: number } = {},
): Promise<string> {
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId, ownerId: ids.ownerId, title: label,
      coordinatorEnabled: opts.coordinatorEnabled ?? true,
      maxConcurrentTasks: opts.maxConcurrentTasks ?? 3,
      automationPolicy: ProjectAutomationPolicy.AUTO,
    },
  });
  await establishProjectContractForPgTest(db, ids.ownerId, projectId, label);
  return projectId;
}

/**
 * One task of the shape this pass exists for: filed under a project, assigned to a workspace on a
 * live runner, opted into auto-run, and depending on nothing. Every control below is this same
 * call with ONE field overridden, which is what makes the comparison a controlled one.
 */
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

const sessionCount = (db: PrismaClient, taskId: string) =>
  db.session.count({ where: { taskId } });

/** How many prerequisites a task actually has — the fixture's own claim, read rather than assumed. */
async function prerequisiteCount(db: PrismaClient, taskId: string): Promise<number> {
  return db.taskDependency.count({ where: { taskId } });
}

/**
 * The production completion edge, called exactly as the runner door and the verification path call
 * it. Nothing here reaches past it into the pass under test: what a completion does is the subject.
 */
const completionEdge = (s: Services, ownerId: string, doneTaskId: string) =>
  s.tasks.dispatchDependentsAfterCompletion(ownerId, doneTaskId);

/** The new pass alone, for the one assertion that is about which tasks are NOT its business. */
const releaseSiblings = (s: Services, ownerId: string, doneTaskId: string) =>
  (s.tasks as unknown as {
    dispatchIndependentSiblingsOf(ownerId: string, doneTaskId: string): Promise<void>;
  }).dispatchIndependentSiblingsOf(ownerId, doneTaskId);

// -------------------------------------------------------------------------------------------------
// (1)(2)(3) The release itself, with both vetoes as controls in the same fixture.
// -------------------------------------------------------------------------------------------------

test('a finished task releases the independent siblings that opted in, and only those',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await world(s.db, 'release-optins');
      const projectId = await project(s.db, ids, 'release-optins');
      const finished = await seedTask(s.db, ids, projectId, 'finished', {
        status: TaskStatus.DONE,
      });
      // The subject: no prerequisites, an assignee on a live runner, opted in, not held.
      const released = await seedTask(s.db, ids, projectId, 'released');
      // The two controls, each one field away from the subject and nothing else.
      const held = await seedTask(s.db, ids, projectId, 'held', { dispatchHold: true });
      const optedOut = await seedTask(s.db, ids, projectId, 'opted out', {
        autoRunWhenReady: false,
      });

      // The fixture's central claim, read off the database rather than asserted about itself: none
      // of these tasks has an edge, so `dispatchDependentsOf` cannot be what starts any of them.
      for (const id of [released, held, optedOut]) {
        assert.equal(await prerequisiteCount(s.db, id), 0);
      }

      await completionEdge(s, ids.ownerId, finished);

      assert.equal(await sessionCount(s.db, released), 1,
        'nothing started the next independent task — finishing one released nothing');
      // ...and it is a run an automatic door opened, not merely a row: a person pressing Run would
      // leave a USER origin behind, which would make this assertion pass for the wrong reason.
      const [run] = await s.db.session.findMany({
        where: { taskId: released }, select: { dispatchOrigin: true, startsTaskWork: true },
      });
      assert.equal(run.dispatchOrigin, SessionDispatchOrigin.LEGACY_SWEEP);
      assert.equal(run.startsTaskWork, true);

      assert.equal(await sessionCount(s.db, held), 0,
        'a held task was released — dispatch_hold is a pause and this pass walked through it');
      assert.equal(await sessionCount(s.db, optedOut), 0,
        'a task that opted out of auto-run was released — auto_run_when_ready decided nothing');
    } finally {
      await s.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (4) The dependency dispatch, unchanged.
// -------------------------------------------------------------------------------------------------

test('the dependency dispatch is unchanged: a dependent starts only once every prerequisite is DONE',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await world(s.db, 'release-dependents');
      const projectId = await project(s.db, ids, 'release-dependents');

      // Two dependents in one fixture, alike in everything except whether the prerequisites they
      // name are all finished. Both prerequisite pairs are seeded in their final state, so what
      // separates the two dependents is the dependency predicate and nothing that happened in
      // between.
      const blockedDone = await seedTask(s.db, ids, projectId, 'landed prerequisite', {
        status: TaskStatus.DONE,
      });
      // Opted out of auto-run so that it STAYS open: it is the outstanding prerequisite this half
      // of the fixture is about, and the pass under test would otherwise legitimately start it.
      const blockedOpen = await seedTask(s.db, ids, projectId, 'outstanding prerequisite', {
        autoRunWhenReady: false,
      });
      const blocked = await seedTask(s.db, ids, projectId, 'blocked dependent');
      await s.db.taskDependency.create({ data: { taskId: blocked, dependsOnTaskId: blockedDone } });
      await s.db.taskDependency.create({ data: { taskId: blocked, dependsOnTaskId: blockedOpen } });

      const releasedFirst = await seedTask(s.db, ids, projectId, 'first prerequisite', {
        status: TaskStatus.DONE,
      });
      const releasedSecond = await seedTask(s.db, ids, projectId, 'second prerequisite', {
        status: TaskStatus.DONE,
      });
      const released = await seedTask(s.db, ids, projectId, 'released dependent');
      await s.db.taskDependency.create({
        data: { taskId: released, dependsOnTaskId: releasedFirst },
      });
      await s.db.taskDependency.create({
        data: { taskId: released, dependsOnTaskId: releasedSecond },
      });

      // A prerequisite completing with another still open releases nothing — the behaviour this
      // project must not have quietly widened.
      await completionEdge(s, ids.ownerId, blockedDone);
      assert.equal(await sessionCount(s.db, blocked), 0,
        'a dependent started with a prerequisite still open');
      assert.equal(await sessionCount(s.db, blockedOpen), 0,
        'the outstanding prerequisite was started, so the dependent above proves nothing');

      // The new pass ALONE, on a dependent that is ready in every other sense: having prerequisites
      // at all is what puts a task outside its candidate set, and this is the assertion that says
      // the two passes divide the work rather than overlapping on it.
      await releaseSiblings(s, ids.ownerId, releasedFirst);
      assert.equal(await sessionCount(s.db, released), 0,
        'the independent-sibling pass started a task that has prerequisites');

      // ...and the dependency dispatch still starts it, from the same completion edge.
      await completionEdge(s, ids.ownerId, releasedFirst);
      assert.equal(await sessionCount(s.db, released), 1,
        'a fully released dependent was not started by its prerequisite completing');
      assert.equal(await prerequisiteCount(s.db, released), 2,
        'the fixture stopped being about a task with prerequisites');
      assert.equal(await prerequisiteCount(s.db, blocked), 2);
    } finally {
      await s.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (5) The project's concurrency budget.
// -------------------------------------------------------------------------------------------------

test("the release does not exceed the project's concurrency budget",
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await world(s.db, 'release-budget');
      // One slot for the whole project. The runner has eight, so anything held back here is held
      // by the project's budget and by nothing else.
      const projectId = await project(s.db, ids, 'release-budget', { maxConcurrentTasks: 1 });
      const finished = await seedTask(s.db, ids, projectId, 'finished', {
        status: TaskStatus.DONE,
      });
      // Two ready tasks and one slot. The older one goes first, which is what makes the assertions
      // below a controlled comparison rather than a coin toss.
      const older = await seedTask(s.db, ids, projectId, 'older', {
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const newer = await seedTask(s.db, ids, projectId, 'newer', {
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      });

      await completionEdge(s, ids.ownerId, finished);
      assert.equal(await sessionCount(s.db, older), 1, 'the one free slot went unused');
      assert.equal(await sessionCount(s.db, newer), 0,
        'both tasks started on a project whose budget is one — the cap was bypassed');

      // The slot is occupied by a live session now, and a second completion must not open another.
      await completionEdge(s, ids.ownerId, finished);
      assert.equal(await sessionCount(s.db, newer), 0,
        'a full budget did not hold the next task back');

      // The paired positive, one column away: the same fixture, the same completion, a budget of
      // two. Without it the assertions above would also hold for a pass that released nothing.
      await s.db.project.update({
        where: { id: projectId }, data: { maxConcurrentTasks: 2 },
      });
      await completionEdge(s, ids.ownerId, finished);
      assert.equal(await sessionCount(s.db, newer), 1,
        'the widened budget released nothing — the cap was not what held this task back');
    } finally {
      await s.db.$disconnect();
    }
  });

// -------------------------------------------------------------------------------------------------
// (6) The switch.
// -------------------------------------------------------------------------------------------------

test('a project whose coordinator is switched off releases nothing',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await world(s.db, 'release-switch');
      // Two projects of one owner, identical in every respect except the switch. Both completions
      // are driven through the same edge in the same run, so the difference between the two counts
      // below cannot be anything else.
      const on = await project(s.db, ids, 'release-switch-on', { coordinatorEnabled: true });
      const off = await project(s.db, ids, 'release-switch-off', { coordinatorEnabled: false });
      const finishedOn = await seedTask(s.db, ids, on, 'finished', { status: TaskStatus.DONE });
      const finishedOff = await seedTask(s.db, ids, off, 'finished', { status: TaskStatus.DONE });
      const releasedOn = await seedTask(s.db, ids, on, 'released');
      const releasedOff = await seedTask(s.db, ids, off, 'released');

      await completionEdge(s, ids.ownerId, finishedOn);
      await completionEdge(s, ids.ownerId, finishedOff);

      assert.equal(await sessionCount(s.db, releasedOn), 1,
        'the coordinated project released nothing — the control below proves nothing on its own');
      assert.equal(await sessionCount(s.db, releasedOff), 0,
        'a project with its coordinator switched off had the next task released on its behalf');
    } finally {
      await s.db.$disconnect();
    }
  });
