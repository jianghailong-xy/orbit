/**
 * `task_list.task_count` and `task_list.task_done_count` are EXACT counts, maintained by write —
 * asserted against real PostgreSQL.
 *
 * The index endpoint used to ask Prisma for `_count: { select: { tasks: true } }`, which compiles
 * to a LEFT JOIN onto an unfiltered `GROUP BY list_id` over all of `task` (Prisma emits `WHERE
 * $4=$5` for the subquery's predicate). On 2026-09-17 that single statement was 22.1% of this
 * database's execution time: 1,606 calls in 6h37m at mean 230.98 ms, reading 111,717 rows to
 * produce 13 numbers, four times a minute. Migration 0280 replaced the recount with a column the
 * writes maintain. 0287 gave it a second number — the DONE half of `completed` — which until then
 * was still a grouped read over `task` on the same poll path (12,048 calls, mean 8.38 ms, 10.8M
 * buffers over 32h50m, 2026-09-19).
 *
 * The only thing that can go wrong with a maintained counter is drift, so every case here asserts
 * each column against a `count(*)` of the same rows taken at that moment — never against a constant
 * that a wrong trigger and a wrong expectation could agree on. The cases are the write shapes that
 * reach `task.list_id` and `task.status` on this deployment, including the one no application code
 * runs: deleting a list clears its tasks' `list_id` through `onDelete: SetNull`, inside the
 * database. The DONE count gets its own case per write path, because a trigger that forgot it on
 * one branch would be repaired by the next branch a single end-to-end sequence runs through.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';
import { CreatorType, PrismaClient, TaskCompletionCriterion, TaskStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TaskListsService } from './task-lists.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

/** A client that reports the SQL it sends, so a case can assert on the statement and not only its
 * answer. */
function connect(): { db: PrismaClient; sql: string[] } {
  const sql: string[] = [];
  const db = new PrismaClient({
    adapter: new PrismaPg(URL!),
    log: [{ emit: 'event', level: 'query' }],
  });
  (db as unknown as { $on: (e: 'query', cb: (q: { query: string }) => void) => void })
    .$on('query', (q) => sql.push(q.query));
  return { db, sql };
}

function lists(db: PrismaClient): TaskListsService {
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  return new TaskListsService(db as unknown as PrismaService, publishes, {} as never);
}

async function owner(db: PrismaClient, label: string): Promise<string> {
  const ownerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@count.invalid`, name: label, passwordHash: 'x' },
  });
  return ownerId;
}

async function list(db: PrismaClient, ownerId: string, title: string): Promise<string> {
  return (await db.taskList.create({ data: { ownerId, title } })).id;
}

function rows(ownerId: string, listId: string | null, n: number, from = 0, status?: TaskStatus) {
  return Array.from({ length: n }, (_, i) => ({
    ownerId,
    listId,
    title: `task-${from + i}`,
    creatorType: CreatorType.USER,
    creatorId: ownerId,
    completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
    ...(status ? { status } : {}),
  }));
}

/**
 * Both columns, beside a recount of the same rows. Equality of each pair IS the property — and
 * each pair is asserted at every step rather than only where a case is about it, so a write that
 * maintains one number and not the other cannot hide behind a step that was not looking.
 */
async function counted(
  db: PrismaClient, listId: string,
): Promise<{ total: number; done: number; recountTotal: number; recountDone: number }> {
  const [row, recountTotal, recountDone] = await Promise.all([
    db.taskList.findUniqueOrThrow({
      where: { id: listId }, select: { taskCount: true, taskDoneCount: true },
    }),
    db.task.count({ where: { listId } }),
    db.task.count({ where: { listId, status: TaskStatus.DONE } }),
  ]);
  return {
    total: row.taskCount,
    done: row.taskDoneCount,
    recountTotal,
    recountDone,
  };
}

test('every write shape that moves a task in or out of a list keeps the count exact', { skip }, async () => {
  const { db } = connect();
  try {
    const ownerId = await owner(db, 'exact');
    const a = await list(db, ownerId, 'A');
    const b = await list(db, ownerId, 'B');

    // A fresh list starts at zero, and one bulk insert — the shape that creates a 27,468-task list
    // in a single statement — is counted once per statement, not once per row.
    assert.deepEqual(await counted(db, a), { total: 0, done: 0, recountTotal: 0, recountDone: 0 });
    await db.task.createMany({ data: rows(ownerId, a, 40) });
    assert.deepEqual(await counted(db, a), { total: 40, done: 0, recountTotal: 40, recountDone: 0 });

    // A single create, through the same trigger.
    const one = await db.task.create({ data: rows(ownerId, a, 1, 40)[0] });
    assert.deepEqual(await counted(db, a), { total: 41, done: 0, recountTotal: 41, recountDone: 0 });

    // Deletes, one row and many.
    await db.task.delete({ where: { id: one.id } });
    assert.deepEqual(await counted(db, a), { total: 40, done: 0, recountTotal: 40, recountDone: 0 });
    const doomed = await db.task.findMany({ where: { listId: a }, take: 7, select: { id: true } });
    await db.task.deleteMany({ where: { id: { in: doomed.map((t) => t.id) } } });
    assert.deepEqual(await counted(db, a), { total: 33, done: 0, recountTotal: 33, recountDone: 0 });

    // Re-listing: one statement that leaves one list and enters another. Both sides move, and the
    // control is that they move in opposite directions — a trigger that only ever added would
    // satisfy B's assertion and fail A's.
    const moving = await db.task.findMany({ where: { listId: a }, take: 5, select: { id: true } });
    await db.task.updateMany({ where: { id: { in: moving.map((t) => t.id) } }, data: { listId: b } });
    assert.deepEqual(await counted(db, a), { total: 28, done: 0, recountTotal: 28, recountDone: 0 });
    assert.deepEqual(await counted(db, b), { total: 5, done: 0, recountTotal: 5, recountDone: 0 });

    // Out of every list. `list_id IS NULL` is not a list's row and must not be counted as one.
    await db.task.updateMany({ where: { listId: b }, data: { listId: null } });
    assert.deepEqual(await counted(db, b), { total: 0, done: 0, recountTotal: 0, recountDone: 0 });

    // Assigned the list it already has. The trigger cannot be narrowed to `UPDATE OF list_id`
    // (PostgreSQL refuses a column list beside a transition table), so this arrives looking exactly
    // like a move and must net to nothing.
    await db.task.updateMany({ where: { listId: a }, data: { listId: a } });
    assert.deepEqual(await counted(db, a), { total: 28, done: 0, recountTotal: 28, recountDone: 0 });

    // The writes that are almost all of this table's traffic reach the trigger too, and must net to
    // nothing — this is the case that keeps them from taking a list row lock. `dispatch_hold` is
    // the pause projector's own column, the multi-row write this deployment does most of; a status
    // write that does not cross DONE is here beside it because it is the other one, and since 0287
    // it is also the case that proves such a write leaves the DONE count alone.
    await db.task.updateMany({ where: { listId: a }, data: { dispatchHold: true } });
    assert.deepEqual(await counted(db, a), { total: 28, done: 0, recountTotal: 28, recountDone: 0 });
    await db.task.updateMany({ where: { listId: a }, data: { status: TaskStatus.IN_PROGRESS } });
    assert.deepEqual(await counted(db, a), { total: 28, done: 0, recountTotal: 28, recountDone: 0 });
  } finally {
    await db.$disconnect();
  }
});

test('deleting a list re-lists its tasks inside the database, and the surviving counts stay true', { skip }, async () => {
  const { db } = connect();
  try {
    const ownerId = await owner(db, 'cascade');
    const doomed = await list(db, ownerId, 'doomed');
    const survivor = await list(db, ownerId, 'survivor');
    await db.task.createMany({ data: rows(ownerId, doomed, 9) });
    await db.task.createMany({ data: rows(ownerId, survivor, 4, 9) });

    // `Task.listId` is onDelete: SetNull — the UPDATE that clears these rows is issued by the
    // referential action, so no application code is on this path and only a database-side counter
    // sees it. The tasks outlive the list.
    await db.taskList.delete({ where: { id: doomed } });
    assert.equal(await db.task.count({ where: { ownerId, listId: null } }), 9);
    assert.deepEqual(await counted(db, survivor), { total: 4, done: 0, recountTotal: 4, recountDone: 0 });
  } finally {
    await db.$disconnect();
  }
});

/**
 * The DONE count, on the four write paths, each asserted where it happens rather than at the end.
 *
 * Splitting it by path is the whole point: a trigger that maintains `task_count` on all four and
 * `task_done_count` on three has to fail here. One sequence asserting only its final total would
 * not catch that — a later path that does maintain the number would silently repair what an
 * earlier one got wrong, and the run would be green.
 */
test('each write path maintains the DONE count: insert, status, re-list, delete', { skip }, async () => {
  const { db } = connect();
  try {
    const ownerId = await owner(db, 'done');
    const a = await list(db, ownerId, 'A');
    const b = await list(db, ownerId, 'B');

    // INSERT. Bulk and single, and the only path that can raise this count from zero — so a broken
    // insert branch has nothing after it to hide the zero behind.
    await db.task.createMany({ data: rows(ownerId, a, 3, 0, TaskStatus.DONE) });
    assert.deepEqual(await counted(db, a), { total: 3, done: 3, recountTotal: 3, recountDone: 3 });
    const single = await db.task.create({ data: rows(ownerId, a, 1, 3, TaskStatus.DONE)[0] });
    assert.deepEqual(await counted(db, a), { total: 4, done: 4, recountTotal: 4, recountDone: 4 });

    // UPDATE(status), out of DONE. Both directions are asserted separately because a branch that
    // only ever added to the DONE count passes one and fails the other.
    await db.task.updateMany({ where: { id: single.id }, data: { status: TaskStatus.FAILED } });
    assert.deepEqual(await counted(db, a), { total: 4, done: 3, recountTotal: 4, recountDone: 3 });
    const cancelled = await db.task.findMany({
      where: { listId: a, status: TaskStatus.DONE }, take: 2, select: { id: true },
    });
    await db.task.updateMany({
      where: { id: { in: cancelled.map((t) => t.id) } }, data: { status: TaskStatus.CANCELLED },
    });
    assert.deepEqual(await counted(db, a), { total: 4, done: 1, recountTotal: 4, recountDone: 1 });

    // A status write that stays inside the non-DONE states, over every such row at once: +1 and -1
    // to the same list under the FILTER's predicate, so this number must net to nothing while the
    // task count does too.
    await db.task.updateMany({
      where: { listId: a, status: { not: TaskStatus.DONE } }, data: { status: TaskStatus.IN_PROGRESS },
    });
    assert.deepEqual(await counted(db, a), { total: 4, done: 1, recountTotal: 4, recountDone: 1 });

    // UPDATE(list_id): a DONE task moved between lists moves both numbers, and the control is that
    // they move in opposite directions — a trigger that credited the destination without debiting
    // the source satisfies B and fails A.
    const moved = await db.task.findMany({
      where: { listId: a, status: TaskStatus.DONE }, take: 1, select: { id: true },
    });
    await db.task.updateMany({ where: { id: { in: moved.map((t) => t.id) } }, data: { listId: b } });
    assert.deepEqual(await counted(db, a), { total: 3, done: 0, recountTotal: 3, recountDone: 0 });
    assert.deepEqual(await counted(db, b), { total: 1, done: 1, recountTotal: 1, recountDone: 1 });

    // The same move, out of every list instead of into another one. `list_id IS NULL` is not a
    // list's row, and the DONE count has to leave with the row — this is the shape where a stale
    // number would keep a list's badge lit with nothing in it.
    await db.task.updateMany({ where: { listId: b }, data: { listId: null } });
    assert.deepEqual(await counted(db, b), { total: 0, done: 0, recountTotal: 0, recountDone: 0 });

    // DELETE. A DONE row and the non-DONE rows, one at a time and in bulk, so the subtraction is
    // proven status-aware rather than `count(*)` wearing the other column's name.
    await db.task.createMany({ data: rows(ownerId, a, 1, 10, TaskStatus.DONE) });
    await db.task.createMany({ data: rows(ownerId, a, 1, 11) });
    assert.deepEqual(await counted(db, a), { total: 5, done: 1, recountTotal: 5, recountDone: 1 });
    const doomed = await db.task.findMany({ where: { listId: a }, select: { id: true, status: true } });
    await db.task.delete({ where: { id: doomed.find((t) => t.status === TaskStatus.DONE)!.id } });
    assert.deepEqual(await counted(db, a), { total: 4, done: 0, recountTotal: 4, recountDone: 0 });
    await db.task.deleteMany({
      where: { id: { in: doomed.filter((t) => t.status !== TaskStatus.DONE).map((t) => t.id) } },
    });
    assert.deepEqual(await counted(db, a), { total: 0, done: 0, recountTotal: 0, recountDone: 0 });
  } finally {
    await db.$disconnect();
  }
});

/**
 * `completed` is the badge the number exists for, so it is asserted where a reader sees it — through
 * the service, on the three boundaries that can lie: an empty list, a task cancelled out of DONE,
 * and every task moved out.
 */
test('completed is at least one task and every one DONE, through the index read', { skip }, async () => {
  const { db } = connect();
  try {
    const ownerId = await owner(db, 'badge');
    const a = await list(db, ownerId, 'a');
    const b = await list(db, ownerId, 'b');
    await list(db, ownerId, 'empty');
    await db.task.createMany({
      data: [
        ...rows(ownerId, a, 2, 0, TaskStatus.DONE),
        ...rows(ownerId, b, 2, 2, TaskStatus.DONE),
        ...rows(ownerId, b, 1, 4),
      ],
    });
    const badge = async () =>
      Object.fromEntries((await lists(db).list(ownerId)).map((l) => [l.title, l.completed]));

    // An empty list is not a finished one: no tasks is the `total > 0` half, which the DONE count
    // alone cannot state. `a` is finished, `b` has one task that is not DONE.
    assert.deepEqual(await badge(), { a: true, b: false, empty: false });

    // DONE -> CANCELLED. The task stays in the list, so the total is unchanged and only the DONE
    // count moves — the badge has to follow that one number.
    const one = await db.task.findMany({ where: { listId: a }, take: 1, select: { id: true } });
    await db.task.updateMany({ where: { id: { in: one.map((t) => t.id) } }, data: { status: TaskStatus.CANCELLED } });
    assert.deepEqual(await badge(), { a: false, b: false, empty: false });

    // Back to DONE — through the fence, so this is the same shape production has: DONE is a
    // projection of a declared completion fact, and the EXECUTABLE lane is the one such a row can
    // carry without a verdict or children. Then every task moved out of the list: a list with no
    // tasks is not finished, and the count has to leave with the rows.
    await db.task.updateMany({
      where: { id: { in: one.map((t) => t.id) } },
      data: {
        status: TaskStatus.DONE,
        completionCriterion: TaskCompletionCriterion.EXECUTABLE,
        acceptanceCommand: 'true',
        acceptanceExpectedExitCode: 0,
      },
    });
    assert.deepEqual(await badge(), { a: true, b: false, empty: false });
    await db.task.updateMany({ where: { listId: a }, data: { listId: null } });
    assert.deepEqual(await badge(), { a: false, b: false, empty: false });

    // And the other direction: a list becomes finished when its last task does, with nothing
    // re-counted to notice.
    await db.task.updateMany({
      where: { listId: b, status: { not: TaskStatus.DONE } },
      data: {
        status: TaskStatus.DONE,
        completionCriterion: TaskCompletionCriterion.EXECUTABLE,
        acceptanceCommand: 'true',
        acceptanceExpectedExitCode: 0,
      },
    });
    assert.deepEqual(await badge(), { a: false, b: true, empty: false });
  } finally {
    await db.$disconnect();
  }
});

test('the index answers _count.tasks from the column, and stops aggregating the task table', { skip }, async () => {
  const { db, sql } = connect();
  try {
    const ownerId = await owner(db, 'index');
    const big = await list(db, ownerId, 'big');
    const small = await list(db, ownerId, 'small');
    await list(db, ownerId, 'empty');
    await db.task.createMany({ data: rows(ownerId, big, 23) });
    await db.task.createMany({ data: rows(ownerId, small, 2, 23) });
    // Another owner's tasks, to prove the numbers below are this owner's and not the table's.
    const stranger = await owner(db, 'stranger');
    await db.task.createMany({ data: rows(stranger, await list(db, stranger, 'theirs'), 11) });

    sql.length = 0;
    const index = await lists(db).list(ownerId);

    // Three distinct counts, so a bug that returned one number for every list, or zero for all of
    // them, fails here rather than passing on a list that happened to be empty.
    assert.deepEqual(
      Object.fromEntries(index.map((l) => [l.title, l._count.tasks])),
      { big: 23, small: 2, empty: 0 },
    );
    // The shape the shipped macOS/iOS clients decode, unchanged: `_count.tasks`, and no leak of
    // the columns that now back it.
    for (const l of index) {
      assert.deepEqual(Object.keys(l._count), ['tasks']);
      assert.equal((l as Record<string, unknown>).taskCount, undefined);
      assert.equal((l as Record<string, unknown>).taskDoneCount, undefined);
    }
    // `completed` still needs the total to compare the DONE count against, and both are now read
    // off the list row rather than counted.
    assert.deepEqual(index.map((l) => l.completed), [false, false, false]);

    // The statement this whole change is about. `_aggr_count_tasks` is the alias Prisma gives the
    // relation aggregate, and `WHERE $4=$5` its always-true placeholder; either one appearing again
    // means the unfiltered whole-table `GROUP BY list_id` is back.
    assert.ok(sql.length > 0, 'no SQL was captured, so the assertions below prove nothing');
    const aggregates = sql.filter((q) => q.includes('_aggr_count_tasks') || q.includes('$4=$5'));
    assert.deepEqual(aggregates, []);

    // Exactly one statement still reads `task`: the grouped one that produces `runningTasks`,
    // scoped to this owner's list ids. The second one — `status = 'DONE'` grouped by `list_id`,
    // which 0287 removed — brings this count to 2, which is the assertion that holds that removal
    // in place rather than leaving it to the comment above.
    const taskReads = sql.filter((s) => s.includes('"public"."task"'));
    assert.deepEqual(
      taskReads.length,
      1,
      `expected exactly one read of task, got ${taskReads.length}:\n${taskReads.join('\n')}`,
    );
    assert.match(taskReads[0], /"list_id" IN \(/);
  } finally {
    await db.$disconnect();
  }
});
