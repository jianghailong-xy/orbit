/**
 * `task_list.task_count` is an EXACT count, maintained by write — asserted against real PostgreSQL.
 *
 * The index endpoint used to ask Prisma for `_count: { select: { tasks: true } }`, which compiles
 * to a LEFT JOIN onto an unfiltered `GROUP BY list_id` over all of `task` (Prisma emits `WHERE
 * $4=$5` for the subquery's predicate). On 2026-09-17 that single statement was 22.1% of this
 * database's execution time: 1,606 calls in 6h37m at mean 230.98 ms, reading 111,717 rows to
 * produce 13 numbers, four times a minute. Migration 0280 replaced the recount with a column the
 * writes maintain.
 *
 * The only thing that can go wrong with a maintained counter is drift, so every case here asserts
 * the column against a `count(*)` of the same rows taken at that moment — never against a constant
 * that a wrong trigger and a wrong expectation could agree on. The cases are the write shapes that
 * reach `task.list_id` on this deployment, including the one no application code runs: deleting a
 * list clears its tasks' `list_id` through `onDelete: SetNull`, inside the database.
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

function rows(ownerId: string, listId: string | null, n: number, from = 0) {
  return Array.from({ length: n }, (_, i) => ({
    ownerId,
    listId,
    title: `task-${from + i}`,
    creatorType: CreatorType.USER,
    creatorId: ownerId,
    completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
  }));
}

/** The column, beside a recount of the same rows. Equality of these two IS the property. */
async function counted(db: PrismaClient, listId: string): Promise<{ stored: number; actual: number }> {
  const [row, actual] = await Promise.all([
    db.taskList.findUniqueOrThrow({ where: { id: listId }, select: { taskCount: true } }),
    db.task.count({ where: { listId } }),
  ]);
  return { stored: row.taskCount, actual };
}

test('every write shape that moves a task in or out of a list keeps the count exact', { skip }, async () => {
  const { db } = connect();
  try {
    const ownerId = await owner(db, 'exact');
    const a = await list(db, ownerId, 'A');
    const b = await list(db, ownerId, 'B');

    // A fresh list starts at zero, and one bulk insert — the shape that creates a 27,468-task list
    // in a single statement — is counted once per statement, not once per row.
    assert.deepEqual(await counted(db, a), { stored: 0, actual: 0 });
    await db.task.createMany({ data: rows(ownerId, a, 40) });
    assert.deepEqual(await counted(db, a), { stored: 40, actual: 40 });

    // A single create, through the same trigger.
    const one = await db.task.create({ data: rows(ownerId, a, 1, 40)[0] });
    assert.deepEqual(await counted(db, a), { stored: 41, actual: 41 });

    // Deletes, one row and many.
    await db.task.delete({ where: { id: one.id } });
    assert.deepEqual(await counted(db, a), { stored: 40, actual: 40 });
    const doomed = await db.task.findMany({ where: { listId: a }, take: 7, select: { id: true } });
    await db.task.deleteMany({ where: { id: { in: doomed.map((t) => t.id) } } });
    assert.deepEqual(await counted(db, a), { stored: 33, actual: 33 });

    // Re-listing: one statement that leaves one list and enters another. Both sides move, and the
    // control is that they move in opposite directions — a trigger that only ever added would
    // satisfy B's assertion and fail A's.
    const moving = await db.task.findMany({ where: { listId: a }, take: 5, select: { id: true } });
    await db.task.updateMany({ where: { id: { in: moving.map((t) => t.id) } }, data: { listId: b } });
    assert.deepEqual(await counted(db, a), { stored: 28, actual: 28 });
    assert.deepEqual(await counted(db, b), { stored: 5, actual: 5 });

    // Out of every list. `list_id IS NULL` is not a list's row and must not be counted as one.
    await db.task.updateMany({ where: { listId: b }, data: { listId: null } });
    assert.deepEqual(await counted(db, b), { stored: 0, actual: 0 });

    // Assigned the list it already has. The trigger cannot be narrowed to `UPDATE OF list_id`
    // (PostgreSQL refuses a column list beside a transition table), so this arrives looking exactly
    // like a move and must net to nothing.
    await db.task.updateMany({ where: { listId: a }, data: { listId: a } });
    assert.deepEqual(await counted(db, a), { stored: 28, actual: 28 });

    // The writes that are almost all of this table's traffic reach the trigger too, and must net to
    // nothing for the same reason — this is the case that keeps them from taking a list row lock.
    // `dispatch_hold` is the pause projector's own column, the multi-row write this deployment
    // does most of; a status write is here beside it because it is the other one.
    await db.task.updateMany({ where: { listId: a }, data: { dispatchHold: true } });
    assert.deepEqual(await counted(db, a), { stored: 28, actual: 28 });
    await db.task.updateMany({ where: { listId: a }, data: { status: TaskStatus.IN_PROGRESS } });
    assert.deepEqual(await counted(db, a), { stored: 28, actual: 28 });
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
    assert.deepEqual(await counted(db, survivor), { stored: 4, actual: 4 });
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
    // the column that now backs it.
    for (const l of index) {
      assert.deepEqual(Object.keys(l._count), ['tasks']);
      assert.equal((l as Record<string, unknown>).taskCount, undefined);
    }
    // `completed` still needs the total to compare the DONE count against, and still gets it.
    assert.deepEqual(index.map((l) => l.completed), [false, false, false]);

    // The statement this whole change is about. `_aggr_count_tasks` is the alias Prisma gives the
    // relation aggregate, and `WHERE $4=$5` its always-true placeholder; either one appearing again
    // means the unfiltered whole-table `GROUP BY list_id` is back.
    assert.ok(sql.length > 0, 'no SQL was captured, so the assertions below prove nothing');
    const aggregates = sql.filter((q) => q.includes('_aggr_count_tasks') || q.includes('$4=$5'));
    assert.deepEqual(aggregates, []);
    // The remaining reads of `task` are the two grouped ones that produce `runningTasks` and
    // `completed`; both are scoped to this owner's list ids, and neither is this one.
    for (const q of sql.filter((s) => s.includes('"public"."task"'))) {
      assert.match(q, /"list_id" IN \(/);
    }
  } finally {
    await db.$disconnect();
  }
});
