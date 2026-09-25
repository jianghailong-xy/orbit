/**
 * `task.priority` decides which of a list's ready tasks takes the list's free slot — and changes
 * nothing while nobody sets it. Against a real PostgreSQL, through the real sweep, the real
 * completion edge and the real edit door, counting the sessions that exist afterwards rather than
 * watching a call.
 *
 * Every case runs in a list whose cap is ONE, so each pass has exactly one slot to hand out and the
 * run it materialises is the whole of its decision. Between passes that run is finished — the
 * session ends, the task reaches DONE — which frees the slot for the next pass and takes the task
 * out of every candidate set, so a list drains one decision at a time.
 *
 *   (1) Two OPEN tasks of one list, both with their prerequisites DONE: the one given the higher
 *       priority is dispatched first. The fixture reads the sweep's own order before anything is
 *       raised, and raises the task that order put LAST — so what puts it first can only be the
 *       priority. The tasks nobody raised follow in the sweep's own order.
 *   (2) Nothing raised: every pass dispatches the first of the list's candidates in the order its
 *       own scan returned them — the rule the loop has always followed (the scan states no ORDER
 *       BY, and the loop walks it front to back), so the order is the one it was before the column
 *       existed.
 *   (3) The completion edge — which starts a task the moment its last prerequisite finishes — does
 *       not hand the list's free slot to the task it released while a higher-priority task of the
 *       list is waiting; the next sweep gives that slot to the higher one. With nothing raised it
 *       takes the slot on the spot, as it always did.
 *   (4) One completion releasing two tasks of one list, with room for both, starts both in the same
 *       pass, the higher first: a pass's own releases do not outrank each other out of the slot.
 *   (5) The edit door writes the column (a number sets it, null returns it to 0, omission keeps it)
 *       and the list page reads it back.
 *   (6) The list page's minPriority floor holds on every tab — the Ready tab too, which reaches the
 *       database through its own SQL — and scopes the badges the way a label does.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-dispatch-priority.pg.spec.ts
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { CreatorType, PrismaClient, RunStatus, RunnerStatus, TaskStatus } from '@prisma/client';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { completeHumanTaskForPgTest } from './task-completion-test-helper';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

/**
 * The sweep's dependency scan, as that scan returned it, once per pass: the ids in the order the
 * loop walks them. Recorded on the way past rather than restated, because "the order the scan
 * returned" is only the order THIS statement returned in THIS database, and a restatement would be
 * a second statement with a plan of its own.
 */
type ScanLog = string[][];

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  scans: ScanLog;
}

/** The dependency scan: the sweep's one tagged statement that joins the disk columns and no project. */
function isDependencyScan(args: unknown[]): boolean {
  try {
    const { text } = renderRawQuery(args);
    return text.includes('work_dir_free_bytes') && !text.includes('coordinator_enabled');
  } catch {
    return false;
  }
}

function connect(): Stack {
  const db = prismaClientFor(URL!);
  const scans: ScanLog = [];
  // The service's client, with the scan's answer copied down on its way back and every other call
  // passed through untouched — the other statements keep their own promise type, which the
  // client's batch transactions insist on.
  const watched = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== '$queryRaw') return typeof value === 'function' ? value.bind(target) : value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (!isDependencyScan(args)) return result;
        return result.then((rows) => {
          scans.push((rows as Array<{ id: string }>).map((row) => row.id));
          return rows;
        });
      };
    },
  });
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    db as unknown as PrismaService,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return {
    db,
    tasks: new TasksService(watched as unknown as PrismaService, sessions, publishes),
    scans,
  };
}

/** An owner with one online runner and one workspace bound to it, roomier than any list here. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId,
      email: `${label}-${RUN}-${ids.ownerId}@priority.invalid`,
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
      // Never what an assertion here measures: every case is about the LIST's one slot.
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
      workDir: '/tmp',
    },
  });
  return ids;
}

async function seedList(db: PrismaClient, ids: World, title: string, maxConcurrent: number) {
  const list = await db.taskList.create({
    data: { id: randomUUID(), ownerId: ids.ownerId, title: `${title}-${RUN}`, maxConcurrent },
    select: { id: true },
  });
  return list.id;
}

/** One task of the list, opted into auto-run and assigned — the shape a campaign's list is made of. */
async function seedTask(
  db: PrismaClient,
  ids: World,
  listId: string,
  title: string,
  opts: { prerequisites?: string[]; status?: TaskStatus } = {},
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
      status: opts.status ?? TaskStatus.OPEN,
      autoRunWhenReady: true,
      dispatchHold: false,
    },
    select: { id: true },
  });
  for (const prerequisite of opts.prerequisites ?? []) {
    await db.taskDependency.create({ data: { taskId: id, dependsOnTaskId: prerequisite } });
  }
  return id;
}

/** The runs the list is holding: what the materialisation budget and the claim both count. */
async function queued(db: PrismaClient, listId: string): Promise<Array<{ id: string; taskId: string }>> {
  const rows = await db.session.findMany({
    where: { batchId: listId, status: { in: ['PENDING', 'RUNNING'] } },
    select: { id: true, taskId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => ({ id: row.id, taskId: row.taskId! }));
}

const sessionsOfTask = (db: PrismaClient, taskId: string) => db.session.count({ where: { taskId } });

/** The real auto-run sweep, as the timer runs it. */
const sweep = (stack: Stack) =>
  (stack.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

/**
 * The list's one run, finished: the session ends and its task reaches DONE, so the slot is free
 * again and the task is no candidate of anything any more. Returns which task it was.
 */
async function finishTheRun(stack: Stack, ids: World, listId: string): Promise<string> {
  const runs = await queued(stack.db, listId);
  assert.equal(runs.length, 1, `the list holds ${runs.length} runs under a cap of one`);
  const [run] = runs;
  await stack.db.session.update({
    where: { id: run.id },
    data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
  });
  await completeHumanTaskForPgTest(stack.db, ids.ownerId, run.taskId, 'finished run');
  return run.taskId;
}

const suite = URL ? test : test.skip;

suite('a list\'s free slot goes to its highest priority, and nothing moves while none is set', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const stack = connect();
  const { db, tasks } = stack;
  t.after(async () => {
    await db.$disconnect();
  });

  /** Five READY tasks in one list, created in this order, each waiting on one DONE prerequisite. */
  async function fiveReady(label: string, maxConcurrent: number) {
    const ids = await world(db, label);
    const listId = await seedList(db, ids, label, maxConcurrent);
    const done = await seedTask(db, ids, listId, 'p', { status: TaskStatus.DONE });
    const ready: string[] = [];
    for (const name of ['t1', 't2', 't3', 't4', 't5']) {
      ready.push(await seedTask(db, ids, listId, name, { prerequisites: [done] }));
    }
    return { ids, listId, ready };
  }

  /** The fixture's own tasks in one recorded scan, in that scan's order. */
  const scanned = (scan: string[], ours: readonly string[]) => scan.filter((id) => ours.includes(id));

  await t.test('(1) of two ready tasks in one list, the higher priority is dispatched first', async () => {
    const f = await fiveReady('raised', 0);

    // The sweep's own order, read with the list's cap at zero so this pass dispatches nothing: the
    // order the loop would walk if nothing were raised.
    const before = stack.scans.length;
    await sweep(stack);
    assert.equal((await queued(db, f.listId)).length, 0, 'a list with no room materialised a run');
    const order = scanned(stack.scans[before], f.ready);
    assert.equal(order.length, 5, `the scan did not offer all five READY tasks: ${order}`);

    // Raise the task that order puts LAST, and one from the middle beneath it — through the edit
    // door, which is what a coordinator's `task_update` reaches.
    const last = order[4];
    const middle = order[2];
    await tasks.update(f.ids.ownerId, last, { priority: 7 });
    await tasks.update(f.ids.ownerId, middle, { priority: 3 });
    await db.taskList.update({ where: { id: f.listId }, data: { maxConcurrent: 1 } });

    const dispatched: string[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      await sweep(stack);
      dispatched.push(await finishTheRun(stack, f.ids, f.listId));
    }
    assert.deepEqual(
      dispatched,
      [last, middle, ...order.filter((id) => id !== last && id !== middle)],
      'the raised tasks did not go first, highest first, with the rest in the sweep\'s own order',
    );
  });

  await t.test('(2) with nothing raised, every pass dispatches the first candidate its own scan returned', async () => {
    const f = await fiveReady('unraised', 1);
    const dispatched: string[] = [];
    const firstScanned: string[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      const before = stack.scans.length;
      await sweep(stack);
      // The pass's own scan — read back, not restated — and the first of this list's tasks in it.
      const scan = scanned(stack.scans[before], f.ready);
      assert.equal(scan.length, 5 - pass, `pass ${pass} scanned ${scan.length} of the list's tasks`);
      firstScanned.push(scan[0]);
      dispatched.push(await finishTheRun(stack, f.ids, f.listId));
    }
    assert.deepEqual(dispatched, firstScanned, 'a pass with nothing raised left the scan\'s order');
    assert.deepEqual([...dispatched].sort(), [...f.ready].sort(), 'not every task was dispatched once');
    t.diagnostic(
      `unraised dispatch order by creation index: ${dispatched.map((id) => f.ready.indexOf(id) + 1).join(',')}`,
    );
  });

  /**
   * A list with one slot: `first` and `waiting` READY on a DONE prerequisite, and `released`
   * waiting on `gate` — a prerequisite in ANOTHER list, so finishing it frees nothing of this one.
   */
  async function completionWorld(label: string, raise: { first: number; waiting: number }) {
    const ids = await world(db, label);
    const listId = await seedList(db, ids, label, 1);
    const otherListId = await seedList(db, ids, `${label}-upstream`, 1);
    const done = await seedTask(db, ids, listId, 'p', { status: TaskStatus.DONE });
    const first = await seedTask(db, ids, listId, 'first', { prerequisites: [done] });
    const waiting = await seedTask(db, ids, listId, 'waiting', { prerequisites: [done] });
    // Not auto-run: nothing but this case starts it, so it cannot take the other list's slot first.
    const gate = await seedTask(db, ids, otherListId, 'gate');
    await db.task.update({ where: { id: gate }, data: { autoRunWhenReady: false } });
    const released = await seedTask(db, ids, listId, 'released', { prerequisites: [gate] });
    if (raise.first) await tasks.update(ids.ownerId, first, { priority: raise.first });
    if (raise.waiting) await tasks.update(ids.ownerId, waiting, { priority: raise.waiting });
    return { ids, listId, first, waiting, gate, released };
  }

  await t.test('(3) the completion edge leaves the free slot to the higher-priority task waiting for it', async () => {
    const f = await completionWorld('edge-yields', { first: 10, waiting: 5 });

    await sweep(stack);
    assert.deepEqual((await queued(db, f.listId)).map((run) => run.taskId), [f.first]);

    // `released` becomes READY, and the list's one slot comes free, in that order — the state the
    // completion edge is about to act in, with `waiting` (priority 5) still waiting for the slot.
    await completeHumanTaskForPgTest(db, f.ids.ownerId, f.gate, 'gate');
    await finishTheRun(stack, f.ids, f.listId);
    await tasks.dispatchDependentsAfterCompletion(f.ids.ownerId, f.gate);

    assert.equal(await sessionsOfTask(db, f.released), 0, 'the completion edge took the slot of a higher priority');
    assert.equal((await queued(db, f.listId)).length, 0);
    const left = await db.task.findUniqueOrThrow({ where: { id: f.released }, select: { status: true } });
    assert.equal(left.status, 'OPEN', 'the task left to the sweep left the durable queue');

    // The next sweep deals the slot by priority.
    await sweep(stack);
    assert.deepEqual((await queued(db, f.listId)).map((run) => run.taskId), [f.waiting]);
  });

  await t.test('(3, control) with nothing raised the completion edge takes the free slot on the spot, as before', async () => {
    const f = await completionWorld('edge-unraised', { first: 0, waiting: 0 });

    await sweep(stack);
    const started = (await queued(db, f.listId)).map((run) => run.taskId);
    assert.equal(started.length, 1);
    const stillWaiting = started[0] === f.first ? f.waiting : f.first;

    await completeHumanTaskForPgTest(db, f.ids.ownerId, f.gate, 'gate');
    await finishTheRun(stack, f.ids, f.listId);
    await tasks.dispatchDependentsAfterCompletion(f.ids.ownerId, f.gate);

    assert.deepEqual((await queued(db, f.listId)).map((run) => run.taskId), [f.released]);
    assert.equal(await sessionsOfTask(db, stillWaiting), 0);
  });

  await t.test('(4) one completion releasing two tasks of a list with room for both starts both, the higher first', async () => {
    const ids = await world(db, 'two-released');
    const listId = await seedList(db, ids, 'two-released', 2);
    const otherListId = await seedList(db, ids, 'two-released-upstream', 1);
    const gate = await seedTask(db, ids, otherListId, 'gate');
    await db.task.update({ where: { id: gate }, data: { autoRunWhenReady: false } });
    const low = await seedTask(db, ids, listId, 'low', { prerequisites: [gate] });
    const high = await seedTask(db, ids, listId, 'high', { prerequisites: [gate] });
    await tasks.update(ids.ownerId, high, { priority: 3 });

    await completeHumanTaskForPgTest(db, ids.ownerId, gate, 'gate');
    await tasks.dispatchDependentsAfterCompletion(ids.ownerId, gate);

    // Both, in this one pass: the list has room for two, and neither of them outranks the other out
    // of it — a pass's own releases are dealt among themselves, not measured against each other.
    assert.deepEqual((await queued(db, listId)).map((run) => run.taskId).sort(), [high, low].sort());
    // The higher one first. Compared rather than sorted by: two inserts can share a millisecond.
    const createdAt = async (taskId: string) =>
      (await db.session.findFirstOrThrow({ where: { taskId }, select: { createdAt: true } })).createdAt;
    assert.ok((await createdAt(high)) <= (await createdAt(low)), 'the lower priority was started first');
  });

  await t.test('(5) the edit door sets, clears and keeps the priority, and the list page reads it', async () => {
    const ids = await world(db, 'edit-door');
    const listId = await seedList(db, ids, 'edit-door', 1);
    const task = await seedTask(db, ids, listId, 'edited');
    const stored = async () =>
      (await db.task.findUniqueOrThrow({ where: { id: task }, select: { priority: true } })).priority;

    assert.equal(await stored(), 0, 'a task nobody raised does not read 0');
    await tasks.update(ids.ownerId, task, { priority: 82 });
    assert.equal(await stored(), 82);
    await tasks.update(ids.ownerId, task, { title: `renamed-${RUN}` });
    assert.equal(await stored(), 82, 'an edit that does not name the priority moved it');

    const page = await tasks.listPage(ids.ownerId, { listId, counts: 'none' });
    assert.deepEqual(
      page.items.map((row: { id: string; priority?: number }) => [row.id, row.priority]),
      [[task, 82]],
      'the list page does not carry the priority',
    );

    await tasks.update(ids.ownerId, task, { priority: null });
    assert.equal(await stored(), 0, 'null did not return the task to the default');
  });

  await t.test('(6) minPriority scopes the list page on every tab, the Ready tab and its badges included', async () => {
    // Five READY tasks — runnable, since their prerequisite is DONE and nothing has run them — two
    // of them raised. No sweep runs in this case, so all five stay exactly where they are.
    const f = await fiveReady('min-priority-scope', 1);
    await tasks.update(f.ids.ownerId, f.ready[1], { priority: 2 });
    await tasks.update(f.ids.ownerId, f.ready[3], { priority: 5 });
    const raised = [f.ready[1], f.ready[3]].sort();
    const ids = (page: { items: Array<{ id: string }> }) => page.items.map((row) => row.id).sort();

    // The Ready tab is answered by its own SQL (taskScopeSql), not the Prisma where the other tabs
    // share, so it is the one that could quietly ignore the floor.
    const ready = await tasks.listPage(f.ids.ownerId, { listId: f.listId, status: 'RUNNABLE', minPriority: 1 });
    assert.deepEqual(ids(ready), raised, 'the Ready tab ignored minPriority');
    // A scope, like labels: the badges count the same two tasks the page lists.
    const counts = (ready as { counts?: { total: number; runnable: number } }).counts;
    assert.deepEqual([counts?.total, counts?.runnable], [2, 2], 'the badges did not count the raised tasks alone');

    const open = await tasks.listPage(f.ids.ownerId, { listId: f.listId, status: 'OPEN', minPriority: '1', counts: 'none' });
    assert.deepEqual(ids(open), raised, 'the OPEN tab ignored minPriority');

    // The control: without the floor the same tab lists all five.
    const everything = await tasks.listPage(f.ids.ownerId, { listId: f.listId, status: 'RUNNABLE', counts: 'none' });
    assert.deepEqual(ids(everything), [...f.ready].sort());
  });
});
