/**
 * A pause is DECIDED in O(1) and applied by a projector — asserted against real PostgreSQL.
 *
 * This is the 2026-09-14 outage, as a property. PATCHing `paused` on four 27,468-task lists used to
 * run `task.updateMany({ dispatch_hold })` inside the request's transaction, which holds the owner
 * graph mutex: 5+ minutes per sweep, every same-owner request queued behind it, clients timing out
 * and re-running the whole O(n) unit until the pool itself was gone. What is asserted here is that
 * the request transaction no longer does that, that the tasks still get converged, and that they
 * get converged in a way a crash cannot wedge.
 *
 * Five things, each with a control that would fail if the assertion were measuring nothing:
 *
 *   (1) the PATCH is O(1) and the owner scope is FREE — proved by a second connection taking the
 *       same lock the PATCH takes, with `lock_timeout='500ms'`, after the PATCH has returned. The
 *       control holds that lock on purpose and shows the probe really does fail when it is held.
 *   (2) the projection converges the whole 27,468-task list, through the kick the PATCH fires;
 *       (2b) the automatic dispatch candidate sweeps select none of a paused list, and (2c) a list
 *       whose kick never arrived is converged by the catch-up scan alone. The candidate case runs
 *       the REAL sweeps rather than reading the rows they would have read: the run door opens a
 *       receipt before any of its own gates, so a task the sweep offered leaves a receipt whether
 *       or not it started.
 *   (3) a sweep that dies mid-list strands nothing: the watermark is the worklist, so the next run
 *       resumes, converges, and rewrites none of the rows the first run had already applied.
 *   (4) decisions that arrive while a sweep is in flight settle on the LAST one, and a same-value
 *       PATCH is a no-op that bumps no epoch and writes no row.
 *   (5) a list left behind is not silent: it warns through the service logger once the lag passes
 *       the bound, and does not warn again on every tick before that.
 *   (6) the chunk page against the incident's list size: what one sweep transaction reads, and the
 *       plan it reads it with.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { Logger } from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  ProjectAutomationPolicy,
  RunnerStatus,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { completeHumanTaskForPgTest } from '../tasks/task-completion-test-helper';
import { TasksService } from '../tasks/tasks.service';
import {
  PAUSE_PROJECTION_LAG_WARN_MS,
  TaskListPauseProjectorService,
  type PauseProjectionOptions,
} from './task-list-pause-projector.service';
import { TaskListsService } from './task-lists.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);
/** The list in the incident, to the row. */
const BIG_LIST_SIZE = 27_468;

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

interface Stack {
  db: PrismaClient;
  lists: TaskListsService;
  projector: TaskListPauseProjectorService;
  tasks: TasksService;
}

/**
 * A world with one online runner and one workspace bound to it, and a list service backed by a
 * projector built from `options`.
 *
 * The projector is passed in rather than reached for: it is the seam these cases are written
 * around, and two of them deliberately run with the sweeps switched off — which is what "a
 * projector that is down" looks like from the request path.
 */
function connect(options: PauseProjectionOptions = {}): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  const projector = new TaskListPauseProjectorService(prisma, options);
  return {
    db,
    projector,
    lists: new TaskListsService(prisma, publishes, sessions, projector),
    tasks: new TasksService(prisma, sessions, publishes),
  };
}

/** An owner with one online runner and one workspace bound to it. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId,
      email: `${label}-${RUN}-${ids.ownerId}@pause.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId,
      ownerId: ids.ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId,
      ownerId: ids.ownerId,
      runnerId: ids.runnerId,
      name: `${label}-agent`,
      enabled: true,
    },
  });
  return ids;
}

const seedList = (db: PrismaClient, ids: World, title: string, paused = false) =>
  db.taskList.create({
    data: { id: randomUUID(), ownerId: ids.ownerId, title: `${title}-${RUN}`, paused },
    select: { id: true, title: true },
  });

/**
 * A list's tasks in bulk, the way the incident's list existed: many rows, one INSERT, every index
 * on `task` maintained by it. `held` is the value `dispatch_hold` starts at.
 *
 * Nothing here is a candidate for the sweeps: no edges and no project, so neither auto-run
 * predicate can select one. That is deliberate in the cases that use this — they are about the
 * projection's cost and convergence, not about what dispatch does with the result.
 */
async function seedTasks(
  db: PrismaClient,
  ids: World,
  listId: string,
  count: number,
  opts: { held?: boolean; autoRun?: boolean; assignee?: boolean } = {},
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "task"(
       "id", "title", "owner_id", "list_id", "creator_type", "creator_id", "status",
       "auto_run_when_ready", "dispatch_hold", "assignee_id", "completion_criterion", "updated_at"
     )
     SELECT gen_random_uuid(), 'paused work ' || i, $1::uuid, $2::uuid, 'USER', $1::uuid, 'OPEN',
            $4::boolean, $5::boolean, $6::uuid, 'EVIDENCE_JUDGMENT', now()
       FROM generate_series(1, $3::int) AS i`,
    ids.ownerId,
    listId,
    count,
    opts.autoRun ?? true,
    opts.held ?? false,
    opts.assignee === false ? null : ids.workspaceId,
  );
}

/** One task of the shape the auto-run sweep is looking for: OPEN, opted in, assigned, unheld. */
async function seedCandidate(
  db: PrismaClient,
  ids: World,
  listId: string,
  title: string,
): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      ownerId: ids.ownerId,
      listId,
      assigneeId: ids.workspaceId,
      title: `${title}-${RUN}`,
      creatorType: CreatorType.USER,
      creatorId: ids.ownerId,
      provider: 'claude',
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: TaskStatus.OPEN,
      autoRunWhenReady: true,
      dispatchHold: false,
    },
    select: { id: true },
  });
  return id;
}

const held = (db: PrismaClient, listId: string) =>
  db.task.count({ where: { listId, dispatchHold: true } });
const unheld = (db: PrismaClient, listId: string) =>
  db.task.count({ where: { listId, dispatchHold: false } });

const listState = async (db: PrismaClient, listId: string) =>
  db.taskList.findUniqueOrThrow({
    where: { id: listId },
    select: { paused: true, pauseEpoch: true, pauseAppliedEpoch: true },
  });

/** Every task's `updated_at`, by id — for the "an applied row is not rewritten" assertion. */
async function updatedAtById(db: PrismaClient, listId: string): Promise<Map<string, number>> {
  const rows = await db.task.findMany({
    where: { listId },
    select: { id: true, updatedAt: true },
    orderBy: { id: 'asc' },
  });
  return new Map(rows.map((row) => [row.id, row.updatedAt.getTime()]));
}

/**
 * Wait for the projection to finish, with the bound the project states for it. Polls through a
 * separate query rather than awaiting the sweep, because the sweep a PATCH starts is deliberately
 * not awaited by the PATCH.
 */
async function converge(
  db: PrismaClient,
  listId: string,
  { timeoutMs = 60_000, size }: { timeoutMs?: number; size?: number } = {},
): Promise<number> {
  const startedAt = performance.now();
  for (;;) {
    const state = await listState(db, listId);
    const done = size === undefined ? 0 : await held(db, listId);
    if (state.pauseAppliedEpoch === state.pauseEpoch && (size === undefined || done === size)) {
      return performance.now() - startedAt;
    }
    if (performance.now() - startedAt > timeoutMs) {
      assert.fail(
        `the projection did not converge within ${timeoutMs}ms: `
          + `pause_epoch=${state.pauseEpoch}, pause_applied_epoch=${state.pauseAppliedEpoch}, `
          + `held=${done}${size === undefined ? '' : ` of ${size}`}`,
      );
    }
    await delay(50);
  }
}

/**
 * Take the owner graph mutex on a SECOND connection — the lock `writePolicy` holds — and let it go.
 *
 * `lock_timeout` is what makes this an assertion rather than a wait: if the mutex is held by
 * something else, this fails in 500ms with 55P03 instead of queueing behind a sweep that might take
 * minutes. That is the whole complaint of 2026-09-14 expressed as a query.
 */
async function acquireOwnerScope(ownerId: string, label: string): Promise<void> {
  const client = new Client({ connectionString: URL! });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '500ms'`);
    await client.query('SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE', [ownerId]);
    await client.query('COMMIT');
  } catch (e) {
    throw new Error(`${label}: the owner scope was not free: ${e instanceof Error ? e.message : e}`);
  } finally {
    await client.end();
  }
}

/** Hold the owner scope open on its own connection, for the control that proves the probe bites. */
async function holdOwnerScope(ownerId: string): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: URL! });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE', [ownerId]);
  return async () => {
    await client.query('ROLLBACK');
    await client.end();
  };
}

/** Captures what the service logged, so the warning can be asserted where a reader sees it. */
function captureWarnings() {
  const warnings: string[] = [];
  const original = Logger.prototype.warn;
  Logger.prototype.warn = function (message: unknown) {
    warnings.push(String(message));
  } as never;
  return { warnings, restore: () => (Logger.prototype.warn = original) };
}

/** Whether the sweep OFFERED a task to the run door — a receipt exists even for a refusal. */
const offeredToRunDoor = (db: PrismaClient, ownerId: string, taskId: string) =>
  db.taskRunRequest.count({ where: { ownerId, fingerprint: `task:${taskId}` } });

// ---------------------------------------------------------------------------------------------
// (1) The decision is O(1), and the owner scope is free when the PATCH returns.
// ---------------------------------------------------------------------------------------------

test('(1) pausing a 27,468-task list writes no task row and leaves the owner scope free', { skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  // The projector is down, which is the state the probe needs to be about the REQUEST: with a
  // sweep running, the owner mutex is legitimately taken by the projection's chunks, and this case
  // would be measuring them instead.
  const s = connect({ enabled: false });
  try {
    const ids = await world(s.db, 'o1');
    const list = await seedList(s.db, ids, 'o1');
    const seededAt = performance.now();
    await seedTasks(s.db, ids, list.id, BIG_LIST_SIZE);
    console.log(`(1) seeded ${BIG_LIST_SIZE} tasks in ${Math.round(performance.now() - seededAt)}ms`);

    const startedAt = performance.now();
    await s.lists.update(ids.ownerId, list.id, { paused: true });
    const patchMs = Math.round(performance.now() - startedAt);

    // The decision landed...
    const state = await listState(s.db, list.id);
    assert.equal(state.paused, true, 'the pause was not decided');
    assert.equal(state.pauseEpoch, 1, 'the decision did not bump the epoch');
    assert.equal(state.pauseAppliedEpoch, 0, 'the projection claimed to have happened in the request');

    // ...and nothing else did. This is the assertion the incident is about: a policy write that
    // touches `task` at all is one that will touch 27,468 rows of it under the owner mutex.
    assert.equal(await held(s.db, list.id), 0, 'the PATCH wrote task rows');
    assert.equal(await unheld(s.db, list.id), BIG_LIST_SIZE);

    // A second connection takes the same lock the PATCH takes. 500ms, or it fails.
    await acquireOwnerScope(ids.ownerId, 'immediately after the PATCH');
    console.log(`(1) PATCH of a ${BIG_LIST_SIZE}-task list took ${patchMs}ms; owner scope free`);

    // The control: hold the owner scope on another connection and the same probe MUST fail. Without
    // this, "the scope was free" would be equally consistent with a probe that never waits at all.
    const release = await holdOwnerScope(ids.ownerId);
    await assert.rejects(
      () => acquireOwnerScope(ids.ownerId, 'control'),
      /owner scope was not free/,
      'the lock_timeout probe did not fail with the owner scope held, so it proves nothing',
    );
    await release();
    await acquireOwnerScope(ids.ownerId, 'after the control released it');

    // Cleanup, after every assertion above: this list is left paused and unprojected on purpose,
    // and it is 27,468 rows of work a later case's fleet-wide catch-up would otherwise pay for.
    await new TaskListPauseProjectorService(
      s.db as unknown as PrismaService,
    ).sweep(list.id);
  } finally {
    await s.db.$disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// (2) Convergence at the incident's scale, and the candidate sweeps selecting none of it.
// ---------------------------------------------------------------------------------------------

test('(2) the projection converges a 27,468-task pause within the bound', { skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'o2');
    const list = await seedList(s.db, ids, 'o2');
    await seedTasks(s.db, ids, list.id, BIG_LIST_SIZE);

    const startedAt = performance.now();
    await s.lists.update(ids.ownerId, list.id, { paused: true });

    // The PATCH kicks the projector, and this waits for that kick's sweep — not for a catch-up
    // tick, which is the 60s guarantee rather than the latency.
    const took = await converge(s.db, list.id, { size: BIG_LIST_SIZE });
    const state = await listState(s.db, list.id);
    console.log(
      `(2) converged ${BIG_LIST_SIZE} tasks in ${Math.round(performance.now() - startedAt)}ms `
        + `(kick path ${Math.round(took)}ms)`,
    );

    assert.equal(state.pauseAppliedEpoch, state.pauseEpoch, 'the watermark did not catch up');
    assert.equal(await held(s.db, list.id), BIG_LIST_SIZE, 'not every task is held');
    assert.equal(await unheld(s.db, list.id), 0, 'a task of a paused list is still dispatchable');

    // Resuming converges the other way, and leaving nothing held is the property dispatch reads.
    await s.lists.update(ids.ownerId, list.id, { paused: false });
    await converge(s.db, list.id, { size: 0 });
    const resumed = await listState(s.db, list.id);
    assert.equal(resumed.pauseEpoch, 2);
    assert.equal(resumed.pauseAppliedEpoch, 2);
    assert.equal(await held(s.db, list.id), 0, 'a task stayed held after the resume');
  } finally {
    await s.db.$disconnect();
  }
});

test('(2b) both automatic candidate sweeps select nothing from a paused list, while their controls start', { skip, timeout: 180_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const ids = await world(s.db, 'o2b');
    const pausedList = await seedList(s.db, ids, 'o2b-paused');
    const openList = await seedList(s.db, ids, 'o2b-open');
    // The independent pass is scoped to a coordinated Project, so one is needed for that half of
    // the fixture — and it is the same Project for BOTH lists, which is the point: the pass has to
    // tell them apart on the tasks alone.
    const projectId = randomUUID();
    await s.db.project.create({
      data: {
        id: projectId,
        ownerId: ids.ownerId,
        title: `o2b-${RUN}`,
        coordinatorEnabled: true,
        maxConcurrentTasks: 8,
        automationPolicy: ProjectAutomationPolicy.AUTO,
      },
    });
    await establishProjectContractForPgTest(s.db, ids.ownerId, projectId, `o2b-${RUN}`);

    /**
     * One task of each shape the two predicates exist for. Every task is otherwise the exact thing
     * the sweep is looking for: OPEN, opted in, assigned to a workspace on a live runner, unheld.
     * The pair differs in ONE column — the list it is filed under — which is what makes the
     * comparison a controlled one.
     */
    const withPrerequisite = async (listId: string, label: string) => {
      const prerequisite = await seedCandidate(s.db, ids, listId, `prereq-${label}`);
      await completeHumanTaskForPgTest(s.db, ids.ownerId, prerequisite, `prereq-${label}`);
      const candidate = await seedCandidate(s.db, ids, listId, label);
      await s.db.taskDependency.create({
        data: { taskId: candidate, dependsOnTaskId: prerequisite },
      });
      return { candidate, prerequisite };
    };
    const independent = async (listId: string, label: string) => {
      const id = await seedCandidate(s.db, ids, listId, label);
      await s.db.task.update({ where: { id }, data: { projectId } });
      return id;
    };

    // AUTO_RUN_READY_SQL's pair: a task with one satisfied edge, so it is a candidate on the
    // dependency scan. PROJECT_INDEPENDENT_READY_SQL's pair: a task of a coordinated project with
    // no edges at all, so it is a candidate on the independent scan. `reconcileReadyTasks` runs
    // both predicates in one pass — the second scan is merged into the first — so one call is the
    // evidence for both.
    const edgePaused = await withPrerequisite(pausedList.id, 'edge-paused');
    const edgeOpen = await withPrerequisite(openList.id, 'edge-open');
    const indepPaused = await independent(pausedList.id, 'independent-paused');
    const indepOpen = await independent(openList.id, 'independent-open');

    // Decide the pause and converge it. Nothing here is a test of the projector — that is (2).
    await s.lists.update(ids.ownerId, pausedList.id, { paused: true });
    const pausedTasks = await s.db.task.count({ where: { listId: pausedList.id } });
    await converge(s.db, pausedList.id, { size: pausedTasks });
    assert.equal(await held(s.db, pausedList.id), pausedTasks, 'not every task is held');

    // The sweep, called exactly as the timer calls it.
    await (s.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

    for (const [label, taskId] of [
      ['a task with a satisfied prerequisite', edgePaused.candidate],
      ['an independent task of a coordinated project', indepPaused],
    ] as const) {
      assert.equal(
        await offeredToRunDoor(s.db, ids.ownerId, taskId),
        0,
        `the sweep offered ${label} from a paused list to the run door — the receipt exists even `
          + 'when the door refuses, so a session count cannot see this',
      );
    }
    for (const [label, taskId] of [
      ['a task with a satisfied prerequisite', edgeOpen.candidate],
      ['an independent task of a coordinated project', indepOpen],
    ] as const) {
      assert.equal(
        await offeredToRunDoor(s.db, ids.ownerId, taskId),
        1,
        `no ${label} outside the paused list was offered, so the assertions above are about the `
          + 'fixture rather than about the pause',
      );
      assert.equal(
        await s.db.session.count({ where: { taskId } }),
        1,
        `a ${label} outside the paused list did not start, so this fixture cannot show the pause `
          + 'stops anything',
      );
    }
    // And the tasks of the paused list were genuinely converged, not merely unpublished: the
    // predicate reads this column and nothing else.
    assert.equal(await unheld(s.db, pausedList.id), 0);
  } finally {
    await s.db.$disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// (2c) The guarantee behind the kick: a restart, or a kick that never arrived, still converges.
// ---------------------------------------------------------------------------------------------

test('(2c) a list whose kick never fired is converged by the catch-up scan alone', { skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  // The decision is taken with the sweeps off, so no kick reaches anything: this is the state a
  // process that restarted between the commit and the kick leaves behind.
  const deciding = connect({ enabled: false });
  try {
    const ids = await world(deciding.db, 'o2c');
    const list = await seedList(deciding.db, ids, 'o2c');
    await seedTasks(deciding.db, ids, list.id, 7, { assignee: false });
    await deciding.lists.update(ids.ownerId, list.id, { paused: true });
    assert.equal(await held(deciding.db, list.id), 0, 'something projected without a projector');

    // The next tick, on a projector that has just started. It has no memory of the kick because
    // there was none — the watermark is the whole handoff.
    const restarted = new TaskListPauseProjectorService(deciding.db as unknown as PrismaService);
    const tick = await restarted.catchUp();
    assert.ok(tick.lists >= 1, 'the catch-up scan found no list behind, so it converged nothing');
    assert.equal(tick.lagging, 0, 'the list is still behind after the catch-up swept it');
    const state = await listState(deciding.db, list.id);
    assert.equal(state.pauseAppliedEpoch, state.pauseEpoch);
    assert.equal(await held(deciding.db, list.id), 7, 'the catch-up did not converge the list');
  } finally {
    await deciding.db.$disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// (3) A projector that dies mid-list: the watermark resumes it, and it rewrites nothing twice.
// ---------------------------------------------------------------------------------------------

test('(3) a sweep killed after its first chunk resumes from the watermark and rewrites nothing already applied', { skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  // The decision is taken with the sweeps off, so the state a killed projector leaves behind is
  // built deliberately rather than raced for.
  const deciding = connect({ enabled: false });
  try {
    const ids = await world(deciding.db, 'o3');
    const list = await seedList(deciding.db, ids, 'o3');
    await seedTasks(deciding.db, ids, list.id, 5, { assignee: false });
    await deciding.lists.update(ids.ownerId, list.id, { paused: true });

    // A projector that starts later and stops after ONE committed chunk — exactly what a process
    // killed mid-sweep leaves: some chunks applied, the watermark unmoved. Driven one list at a
    // time, so what it reports is what THIS list cost.
    const prisma = deciding.db as unknown as PrismaService;
    const crashing = new TaskListPauseProjectorService(prisma, { chunkSize: 2, maxChunksPerPass: 1 });
    const first = await crashing.sweep(list.id);
    assert.equal(first.changed, 2, 'the crashing run did not apply exactly one page');
    assert.equal(await held(deciding.db, list.id), 2, 'the first chunk is not the one that landed');
    assert.equal(
      (await listState(deciding.db, list.id)).pauseAppliedEpoch,
      0,
      'an interrupted pass advanced the watermark, so nothing would resume it',
    );

    const beforeSecond = await updatedAtById(deciding.db, list.id);
    const appliedIds = [...beforeSecond.keys()].slice(0, 2);

    // The catch-up tick after the crash. Same worklist, no cursor anywhere — it re-reads from the
    // start of the list and re-applies only what is missing.
    const recovered = await new TaskListPauseProjectorService(prisma).sweep(list.id);
    assert.equal(recovered.changed, 3, 'the resumed run did not finish the remaining tasks');
    await converge(deciding.db, list.id, { size: 5 });
    const state = await listState(deciding.db, list.id);
    assert.equal(state.pauseAppliedEpoch, 1);
    assert.equal(await unheld(deciding.db, list.id), 0);

    // The rows the first run applied were re-read by the second and NOT rewritten: this is the
    // `dispatch_hold <> target` guard, and it is why a crash costs nothing but the time.
    const afterSecond = await updatedAtById(deciding.db, list.id);
    for (const id of appliedIds) {
      assert.equal(
        afterSecond.get(id),
        beforeSecond.get(id),
        'a task the first run had already applied was rewritten (updated_at moved)',
      );
    }

    // And a sweep of an already-converged list rewrites nothing at all, which is what makes the
    // watermark safe to re-read on every tick.
    const idle = await new TaskListPauseProjectorService(prisma).sweep(list.id);
    assert.equal(idle.changed, 0, 'a converged list was rewritten');
    assert.equal((await listState(deciding.db, list.id)).pauseAppliedEpoch, 1);

    // The control for the counter itself: a list whose tasks ALREADY carry the target reports zero
    // changed rows, so "changed === 0" is not being read as a broken counter above.
    const settled = await seedList(deciding.db, ids, 'o3-settled');
    await seedTasks(deciding.db, ids, settled.id, 3, { held: false, assignee: false });
    await deciding.db.taskList.update({
      where: { id: settled.id },
      data: { paused: false, pauseEpoch: 1, pauseAppliedEpoch: 0 },
    });
    const nothingToDo = await new TaskListPauseProjectorService(prisma).sweep(settled.id);
    assert.equal(nothingToDo.changed, 0, 'a list that was already at its target was rewritten');
    assert.equal((await listState(deciding.db, settled.id)).pauseAppliedEpoch, 1);
  } finally {
    await deciding.db.$disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// (4) Interleavings: the last decision wins, and the same value decides nothing.
// ---------------------------------------------------------------------------------------------

test('(4) a resume that lands mid-sweep wins, and a same-value PATCH bumps no epoch', { skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const deciding = connect({ enabled: false });
  try {
    const ids = await world(deciding.db, 'o4');
    const list = await seedList(deciding.db, ids, 'o4');
    await seedTasks(deciding.db, ids, list.id, 6, { assignee: false });
    const prisma = deciding.db as unknown as PrismaService;

    await deciding.lists.update(ids.ownerId, list.id, { paused: true });
    assert.equal((await listState(deciding.db, list.id)).pauseEpoch, 1);

    // The same value again, twice. Neither is a decision: no epoch, and therefore no work for a
    // projector to reclaim. A client that times out and re-sends the same PATCH is the ordinary
    // case, and on 2026-09-14 it was what turned one slow write into fourteen minutes of them.
    await deciding.lists.update(ids.ownerId, list.id, { paused: true });
    await deciding.lists.update(ids.ownerId, list.id, { paused: true, note: 'still paused' });
    assert.equal(
      (await listState(deciding.db, list.id)).pauseEpoch,
      1,
      'a same-value pause bumped the epoch, which asks for a projection of nothing',
    );
    // The control for that: a PATCH that DOES change the value bumps by exactly one. Without it,
    // "no bump" would also be consistent with an epoch that never moves at all.
    await deciding.lists.update(ids.ownerId, list.id, { paused: false });
    assert.equal((await listState(deciding.db, list.id)).pauseEpoch, 2);

    // Back to paused, and this time let a sweep get one chunk in before the decision changes.
    await deciding.lists.update(ids.ownerId, list.id, { paused: true });
    assert.equal((await listState(deciding.db, list.id)).pauseEpoch, 3);
    const partial = new TaskListPauseProjectorService(prisma, { chunkSize: 2, maxChunksPerPass: 1 });
    assert.equal((await partial.sweep(list.id)).changed, 2);
    assert.equal(await held(deciding.db, list.id), 2, 'the partial sweep did not hold its one page');

    // The resume lands while that sweep is "stopped". It is a NEW decision, and the tasks have to
    // end up at the newest one — not at the one the interrupted pass was applying.
    await deciding.lists.update(ids.ownerId, list.id, { paused: false });
    const state = await listState(deciding.db, list.id);
    assert.equal(state.pauseEpoch, 4);

    const final = await new TaskListPauseProjectorService(prisma).sweep(list.id);
    await converge(deciding.db, list.id, { size: 0 });
    const settled = await listState(deciding.db, list.id);
    assert.equal(settled.pauseAppliedEpoch, settled.pauseEpoch, 'the watermark is behind the decision');
    assert.equal(await held(deciding.db, list.id), 0, 'a task the interrupted pass held stayed held');
    assert.equal(final.changed, 2, 'the resumed run should have had to undo exactly the two held rows');

    // The same-value no-op over the wire one more time: with the list already at its target and the
    // watermark caught up, a repeat PATCH leaves every counter where it was.
    await deciding.lists.update(ids.ownerId, list.id, { paused: false });
    const repeat = await listState(deciding.db, list.id);
    assert.deepEqual(repeat, { paused: false, pauseEpoch: 4, pauseAppliedEpoch: 4 });
  } finally {
    await deciding.db.$disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// (5) A list left behind is not silent.
// ---------------------------------------------------------------------------------------------

test('(5) a list whose projection is stuck warns once when the lag passes the bound', { skip, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect({ enabled: false });
  try {
    const ids = await world(s.db, 'o5');
    const list = await seedList(s.db, ids, 'o5');
    await seedTasks(s.db, ids, list.id, 3, { assignee: false });
    await s.lists.update(ids.ownerId, list.id, { paused: true });

    const t0 = new Date();
    const { warnings, restore } = captureWarnings();
    // Only the lines about THIS list. A retry inside any sweep also logs a warning, and this case
    // must be about the lag signal rather than about whether the run happened to hit a conflict.
    const aboutTheList = () => warnings.filter((line) => line.includes(list.id));
    try {
      // A tick right after the decision: the list IS behind, and that is not yet worth a warning.
      const first = await s.projector.catchUp(t0);
      assert.equal(first.lagging, 1, 'the scan did not see the list it should have seen');
      assert.deepEqual(aboutTheList(), [], 'a list was warned about before the bound elapsed');

      // A tick past the bound. Still no projector, so still behind — and now somebody is told.
      const second = await s.projector.catchUp(new Date(t0.getTime() + PAUSE_PROJECTION_LAG_WARN_MS + 1_000));
      assert.equal(second.lagging, 1);
      assert.equal(aboutTheList().length, 1, 'a list stuck past the bound was never reported');
      assert.match(aboutTheList()[0], /pause_epoch=1/);
      assert.match(aboutTheList()[0], /pause_applied_epoch=0/);

      // And not on every tick after that: the next tick, still inside a fresh bound, is silent.
      const third = await s.projector.catchUp(
        new Date(t0.getTime() + PAUSE_PROJECTION_LAG_WARN_MS + 1_000 + PAUSE_PROJECTION_LAG_WARN_MS / 2),
      );
      assert.equal(third.lagging, 1);
      assert.equal(aboutTheList().length, 1, 'the warning repeats every tick, which is how a signal '
        + 'this important becomes noise');

      // The control: converge the list with a real projector and the same tick is silent about it —
      // so the warning above is about the LAG, not about the list existing.
      await new TaskListPauseProjectorService(s.db as unknown as PrismaService).sweep(list.id);
      const caughtUp = await listState(s.db, list.id);
      assert.equal(caughtUp.pauseAppliedEpoch, 1);
      const after = await s.projector.catchUp(new Date(t0.getTime() + PAUSE_PROJECTION_LAG_WARN_MS * 4));
      assert.equal(after.lagging, 0, 'a converged list is still reported as behind');
      assert.equal(aboutTheList().length, 1, 'the converged list was warned about');
    } finally {
      restore();
    }
  } finally {
    await s.db.$disconnect();
  }
});

// ---------------------------------------------------------------------------------------------
// The chunk page: what one sweep transaction reads, against the list from the incident.
// ---------------------------------------------------------------------------------------------

test('(6) the chunk SELECT is an index page, not a scan of the list, at the incident list size', { skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect({ enabled: false });
  try {
    const ids = await world(s.db, 'o6');
    const list = await seedList(s.db, ids, 'o6');
    await seedTasks(s.db, ids, list.id, BIG_LIST_SIZE, { assignee: false });

    /**
     * Statistics before the plan, and this is not tidiness.
     *
     * `EXPLAIN` answers from pg_statistic, and after a bulk load those are whatever autoanalyze has
     * got round to — which runs on its own clock, in the background, against a threshold. So the
     * planner's estimate for `list_id = $1` on this same 27,468-row list was `rows=1` on one run of
     * this file and `rows=3` on the next, and that estimate is the whole decision: at `rows=1` the
     * sort of the list looks nearly free and wins on cost, and at anything honest the range scan
     * does. Measured, on this list, both plans back to back:
     *
     *   Limit -> Sort (top-N heapsort 176kB) -> Index Scan using task_list_id_idx (rows=27468)
     *   Limit -> Index Only Scan using task_list_id_id_idx (rows=2000, Heap Fetches: 2000)
     *
     * The second is the one 0276 exists for; the first is the shape that costs the list per chunk.
     * Analyzing here makes the input to that decision deterministic rather than a race with the
     * autovacuum launcher, and it is what the database of an operator who had just loaded this data
     * would look like anyway.
     */
    await s.db.$executeRawUnsafe(`ANALYZE "task"`);

    /**
     * The chunk SELECT as the sweep issues it, and the plan PostgreSQL answers it with.
     *
     * A page must cost a page. The shape that costs the LIST instead is an index scan of every row
     * in it plus a top-N heapsort of them all, which is what the plan used to be: on this list,
     * 27,468 rows read and a 176kB sort for every 2,000-row chunk. `(list_id, id)` (0276) is what
     * turns that into a range scan that stops when the page is full, and the assertions below are
     * about exactly that difference — the plan is printed too, because a reviewer should be able to
     * read the rest of it.
     */
    const explain = async (cursor: string | null): Promise<string> => {
      const rows = await s.db.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN (ANALYZE, BUFFERS)
         SELECT "id" FROM "task"
          WHERE "list_id" = $1::uuid
            AND ($2::uuid IS NULL OR "id" > $2::uuid)
          ORDER BY "id"
          LIMIT 2000`,
        list.id,
        cursor,
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    };
    /**
     * The most rows any node of the plan actually produced.
     *
     * This is the cost property itself rather than a proxy for it: `ANALYZE` output never lies about
     * what a node did, so "no node produced more than a couple of pages" is exactly "this chunk did
     * not read the list", whatever plan the planner picked on the day. A sort of the list has to
     * read it first, so the shape assertions below can only pass while this one does — and if they
     * ever disagree, the number is the one that is about the incident.
     */
    const widestNode = (text: string): number =>
      Math.max(
        ...[...text.matchAll(/actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/g)].map((m) => Number(m[1])),
      );
    const keysetPage = (text: string, label: string): void => {
      assert.doesNotMatch(
        text,
        /Sort\s+\(cost/,
        `${label}: the page is sorted as a whole, so each chunk pays for the list rather than for `
          + 'the page',
      );
      assert.doesNotMatch(text, /Seq Scan/, `${label}: the page is a sequential scan of task`);
      assert.match(
        text,
        /task_list_id_id_idx/,
        `${label}: the page is not served by the (list_id, id) index the page shape depends on`,
      );
      const widest = widestNode(text);
      assert.ok(
        widest <= 4000,
        `${label}: a node of this plan produced ${widest} rows against a 2,000-row page, so a chunk `
          + `pays for the list (${BIG_LIST_SIZE} rows) rather than for the page`,
      );
    };

    // The first page of a sweep — the cursor is null, so this is the widest range one asks for.
    const first = await s.db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "task"
        WHERE "list_id" = $1::uuid AND ($2::uuid IS NULL OR "id" > $2::uuid)
        ORDER BY "id" LIMIT 2000`,
      list.id,
      null,
    );
    assert.equal(first.length, 2000, 'the page is not the size the sweep asked for');
    const firstPlan = await explain(null);
    console.log(`(6) first page (no cursor) on a ${BIG_LIST_SIZE}-task list:\n${firstPlan}`);
    keysetPage(firstPlan, 'first page');

    // ...and the page a running sweep actually asks for, which is the one thirteen of this list's
    // fourteen pages carry a cursor for. This is the shape the incident's cost lives in.
    const cursor = first[first.length - 1].id;
    const pagePlan = await explain(cursor);
    console.log(`(6) chunk page (with cursor) on a ${BIG_LIST_SIZE}-task list:\n${pagePlan}`);
    keysetPage(pagePlan, 'chunk page');

    const second = await s.db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "task"
        WHERE "list_id" = $1::uuid AND "id" > $2::uuid
        ORDER BY "id" LIMIT 2000`,
      list.id,
      cursor,
    );
    assert.equal(second.length, 2000);
    assert.ok(
      first.every((row) => row.id < second[0].id),
      'the second page overlaps or precedes the first, so the cursor is not advancing by id',
    );
    const overlap = new Set(first.map((row) => row.id));
    assert.equal(
      second.filter((row) => overlap.has(row.id)).length,
      0,
      'a row appeared in two consecutive pages',
    );
  } finally {
    await s.db.$disconnect();
  }
});
