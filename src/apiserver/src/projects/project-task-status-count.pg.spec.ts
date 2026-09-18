/**
 * `project_task_status_count` is an EXACT tally, maintained by write — asserted against real
 * PostgreSQL.
 *
 * `ProjectsService.get` used to ask Prisma for `task.groupBy({ by: ['status'], where: { projectId }
 * })`. Its filter is real and its index is the right one, and neither bounds the cost: what the
 * statement costs is how many ROWS the project has. One project on this deployment holds 109,872 of
 * the table's 111,738 rows, so for that project the read was a traversal of the whole covering
 * index — `Index Only Scan using task_project_rollup_covering_idx`, 3,679 buffers and 76–124 ms,
 * both measured on production 2026-09-18 — against a page whose whole point is that its cost does
 * not depend on how big the project is. Migration 0282 replaced the recount with rows the writes
 * maintain.
 *
 * The only thing that can go wrong with a maintained counter is drift, so every case here asserts
 * the rows against a `group by` of the same tasks taken at that moment — never against a constant
 * that a wrong trigger and a wrong expectation could agree on. The cases are the write shapes that
 * reach `task.project_id` and `task.status` on this deployment, including the one no application
 * code runs.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';
import { CreatorType, PrismaClient, TaskCompletionCriterion, TaskStatus } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

/** A client that reports the SQL it sends, so a case can assert on the statement and not only its
 *  answer. */
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

async function owner(db: PrismaClient, label: string): Promise<string> {
  const ownerId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${RUN}-${ownerId}@project-tally.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  return ownerId;
}

async function project(db: PrismaClient, ownerId: string, title: string): Promise<string> {
  return (await db.project.create({ data: { ownerId, title } })).id;
}

function rows(
  ownerId: string,
  projectId: string | null,
  n: number,
  status: TaskStatus,
  from = 0,
) {
  return Array.from({ length: n }, (_, i) => ({
    ownerId,
    projectId,
    status,
    title: `task-${from + i}`,
    creatorType: CreatorType.USER,
    creatorId: ownerId,
    completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
  }));
}

/**
 * The maintained rows beside a recount of the same tasks. Equality of these two IS the property —
 * and it is asserted per STATUS, because a trigger that got the total right by moving every row
 * into one bucket would satisfy a total-only comparison.
 */
async function tally(db: PrismaClient, projectId: string) {
  const [stored, actual] = await Promise.all([
    db.projectTaskStatusCount.findMany({
      where: { projectId, count: { gt: 0 } },
      select: { status: true, count: true },
      orderBy: { status: 'asc' },
    }),
    db.task.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
  ]);
  return {
    stored: Object.fromEntries(stored.map((row) => [row.status, row.count])),
    actual: Object.fromEntries(actual.map((row) => [row.status, row._count._all])),
  };
}

const exact = async (db: PrismaClient, projectId: string, because: string) => {
  const { stored, actual } = await tally(db, projectId);
  assert.deepEqual(stored, actual, because);
};

test('every write shape that moves a task in, out of, or within a project keeps the tally exact', {
  skip,
}, async () => {
  const { db } = connect();
  try {
    const ownerId = await owner(db, 'exact');
    const a = await project(db, ownerId, 'A');
    const b = await project(db, ownerId, 'B');

    // A project nobody has filed work under has no rows at all — which is the state the read has
    // always served as an empty map and a zero total, and still does.
    assert.deepEqual(await tally(db, a), { stored: {}, actual: {} });
    assert.deepEqual(await db.projectTaskStatusCount.findMany({ where: { projectId: a } }),
      [], 'nothing to count means no rows, not rows holding zero');

    // One bulk insert — the shape that created this deployment's 109,872-task project — is counted
    // once per statement, not once per row, and split by status rather than totalled.
    await db.task.createMany({ data: rows(ownerId, a, 40, TaskStatus.OPEN) });
    assert.deepEqual((await tally(db, a)).stored, { OPEN: 40 });
    await db.task.createMany({ data: rows(ownerId, a, 9, TaskStatus.DONE, 40) });
    assert.deepEqual((await tally(db, a)).stored, { DONE: 9, OPEN: 40 });

    // A single create, through the same trigger.
    const one = await db.task.create({ data: rows(ownerId, a, 1, TaskStatus.IN_PROGRESS, 49)[0] });
    assert.deepEqual((await tally(db, a)).stored, { DONE: 9, IN_PROGRESS: 1, OPEN: 40 });

    // Deletes, one row and many.
    await db.task.delete({ where: { id: one.id } });
    await exact(db, a, 'a deleted task leaves its status');
    const doomed = await db.task.findMany({
      where: { projectId: a, status: TaskStatus.OPEN }, take: 7, select: { id: true },
    });
    await db.task.deleteMany({ where: { id: { in: doomed.map((t) => t.id) } } });
    assert.deepEqual((await tally(db, a)).stored, { DONE: 9, OPEN: 33 });

    // Moving work to another project: one statement that leaves one project and enters another.
    // Both sides move and they move in OPPOSITE directions — a trigger that only ever added would
    // satisfy B's assertion and fail A's.
    const moving = await db.task.findMany({
      where: { projectId: a, status: TaskStatus.OPEN }, take: 5, select: { id: true },
    });
    await db.task.updateMany({
      where: { id: { in: moving.map((t) => t.id) } }, data: { projectId: b },
    });
    assert.deepEqual((await tally(db, a)).stored, { DONE: 9, OPEN: 28 });
    assert.deepEqual((await tally(db, b)).stored, { OPEN: 5 });

    // Out of every project. `project_id IS NULL` is not a project's row and must not be counted as
    // one — the same rule 0280 states for `list_id`.
    await db.task.updateMany({ where: { projectId: b }, data: { projectId: null } });
    assert.deepEqual((await tally(db, b)).stored, {});

    // A STATUS change, which is the axis `task_list.task_count` does not have. It must move a row
    // between two buckets of the SAME project and leave the project's total where it was — so a
    // trigger that only tracked membership would pass every total and fail here.
    //
    // IN_PROGRESS rather than DONE: 0193's fence refuses a bare `UPDATE ... SET status = 'DONE'`
    // without the canonical completion facts, and what is under test here is the tally, not that
    // fence. The DONE bucket is populated by creation instead, which no fence gates.
    await db.task.updateMany({
      where: { projectId: a, status: TaskStatus.OPEN }, data: { status: TaskStatus.IN_PROGRESS },
    });
    assert.deepEqual((await tally(db, a)).stored, { DONE: 9, IN_PROGRESS: 28 });
    await exact(db, a, 'a status change moves a count between buckets rather than out of the project');

    // The project it already has. The trigger cannot be narrowed to `UPDATE OF project_id`
    // (PostgreSQL refuses a column list beside a transition table), so this arrives looking exactly
    // like a move and must net to nothing.
    await db.task.updateMany({ where: { projectId: a }, data: { projectId: a } });
    await exact(db, a, 'writing the project a task already has is not a move');

    // The writes that are almost all of this table's traffic reach the trigger too, and must net to
    // nothing for the same reason — this is the case that keeps a 27,468-task pause from taking a
    // project's tally rows. `dispatch_hold` is the pause projector's own column; the status write
    // beside it is the one that DOES move a count, and `title` is here to show the netting is by
    // (project, status) rather than by "did any column change".
    await db.task.updateMany({ where: { projectId: a }, data: { dispatchHold: true } });
    await exact(db, a, 'a hold write changes no count');
    await db.task.updateMany({ where: { projectId: a }, data: { title: 'renamed' } });
    await exact(db, a, 'an edit that is not a status or a move changes no count');
  } finally {
    await db.$disconnect();
  }
});

test('a status whose count falls to zero leaves no key, and a re-opened one comes back', { skip },
  async () => {
    const { db } = connect();
    try {
      const ownerId = await owner(db, 'vanish');
      const id = await project(db, ownerId, 'vanish');
      await db.task.createMany({ data: rows(ownerId, id, 3, TaskStatus.FAILED) });
      assert.deepEqual((await tally(db, id)).stored, { FAILED: 3 });

      // Emptying a status leaves the row holding zero. The read filters those out, so the map a
      // caller decodes is still "the statuses this project has" — the shape the groupBy produced,
      // which `ProjectsPage.tsx` states as its contract ("statuses with no tasks are absent ...
      // entirely") and reads with `?? 0`.
      await db.task.updateMany({
        where: { projectId: id, status: TaskStatus.FAILED }, data: { status: TaskStatus.CANCELLED },
      });
      assert.deepEqual((await tally(db, id)).stored, { CANCELLED: 3 });
      const raw = await db.projectTaskStatusCount.findMany({
        where: { projectId: id }, select: { status: true, count: true }, orderBy: { status: 'asc' },
      });
      assert.deepEqual(raw, [{ status: TaskStatus.CANCELLED, count: 3 }, { status: TaskStatus.FAILED, count: 0 }],
        'the zero row is kept, and it is the read that decides not to serve it');

      // And the bucket is reachable again without a second mechanism: the row is already there for
      // this status, which is what makes upserting rather than inserting the right shape.
      await db.task.updateMany({
        where: { projectId: id, status: TaskStatus.CANCELLED }, data: { status: TaskStatus.FAILED },
      });
      assert.deepEqual((await tally(db, id)).stored, { FAILED: 3 });
      await exact(db, id, 'a status that emptied and refilled is exact again');
    } finally {
      await db.$disconnect();
    }
  });

test('the detail read answers from the tally, and no statement of it aggregates the project’s tasks',
  { skip }, async () => {
    const { db, sql } = connect();
    try {
      const ownerId = await owner(db, 'read');
      const small = await project(db, ownerId, 'small');
      const large = await project(db, ownerId, 'large');
      await db.task.createMany({ data: rows(ownerId, small, 2, TaskStatus.OPEN) });
      await db.task.createMany({ data: rows(ownerId, large, 23, TaskStatus.OPEN) });
      await db.task.createMany({ data: rows(ownerId, large, 11, TaskStatus.DONE, 23) });
      // Another owner's tasks, to prove the numbers below are this project's and not the table's.
      const stranger = await owner(db, 'stranger');
      const theirs = await project(db, stranger, 'theirs');
      await db.task.createMany({ data: rows(stranger, theirs, 7, TaskStatus.OPEN) });

      const projects = new ProjectsService(
        db as unknown as PrismaService, new ProjectAcceptanceService(db as unknown as PrismaService));

      sql.length = 0;
      const read = await projects.get(ownerId, large) as unknown as {
        tasksByStatus: Record<string, number>;
        _count: { tasks: number };
      };

      // Two sizes with different splits, so a bug that returned one project's tally for every
      // project, or flattened the statuses into a total, fails here rather than passing on a
      // project that happened to be uniform.
      assert.deepEqual(read.tasksByStatus, { DONE: 11, OPEN: 23 });
      assert.equal(read._count.tasks, 34);

      // The regression this whole change is about is not a COUNT of statements: `task.groupBy` is
      // ONE statement, at either size, so any per-read count is satisfied by putting it back. What
      // separated it from a lookup was never its number — it was that its cost was the project's
      // row count. This asserts the shape instead, over the one read whose SQL is in the log.
      assert.ok(sql.length > 0, 'no SQL was captured, so the assertions below prove nothing');
      const offenders = sql.filter((q) => /FROM\s+"public"\."task"[\s\S]*?GROUP BY/iu.test(q));
      assert.deepEqual(offenders, [],
        'the detail read must not aggregate this project’s tasks');
      const tallyReads = sql.filter((q) => q.includes('"project_task_status_count"'));
      assert.equal(tallyReads.length, 1, 'exactly one statement reads the tally');
      assert.match(tallyReads[0], /"project_id" = \$\d+/u);
      assert.match(tallyReads[0], /"count" > \$\d+/u,
        'the zero rows are filtered here, which is what keeps the served map partial');

      // The wire shape callers decode, unchanged: `_count.tasks` beside `tasksByStatus`, and no
      // leak of the relation that now backs them.
      assert.deepEqual(Object.keys(read._count), ['tasks']);
      assert.equal((read as Record<string, unknown>).taskStatusCounts, undefined);

      // And a second size, so a bug that returned one project's tally for every project fails here
      // rather than passing on a read that was only ever asked about one.
      const smaller = await projects.get(ownerId, small) as unknown as {
        tasksByStatus: Record<string, number>;
      };
      assert.deepEqual(smaller.tasksByStatus, { OPEN: 2 });
    } finally {
      await db.$disconnect();
    }
  });

test('a project with no work answers an empty map and a zero total, not a missing one', { skip },
  async () => {
    const { db } = connect();
    try {
      const ownerId = await owner(db, 'empty');
      const id = await project(db, ownerId, 'empty');
      const projects = new ProjectsService(
        db as unknown as PrismaService, new ProjectAcceptanceService(db as unknown as PrismaService));

      const read = await projects.get(ownerId, id) as unknown as {
        tasksByStatus: Record<string, number>;
        _count: { tasks: number };
      };
      // An empty object means "no tasks" here, never "counts unavailable" — the field being absent
      // is what would mean that, and it is present. Same distinction the page makes.
      assert.deepEqual(read.tasksByStatus, {});
      assert.equal(read._count.tasks, 0);
    } finally {
      await db.$disconnect();
    }
  });
