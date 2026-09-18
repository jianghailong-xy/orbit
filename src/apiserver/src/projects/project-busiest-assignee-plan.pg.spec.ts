/**
 * `busiestAssignee` reads ONE PROJECT's rows, not the table's — asserted against real PostgreSQL.
 *
 * The statement the service sends, captured here from Prisma rather than written out by hand, is
 * `task.groupBy({ by: ['assigneeId'], where: { projectId, assigneeId: { not: null }, assignee: {
 * deletedAt: null } }, _count: { _all: true }, orderBy: ..., take: 1 })` — "which workspace most of
 * this project's tasks are assigned to", the landing a project that has never had a coordinator is
 * offered.
 *
 * `take: 1` does not bound it. A GROUP BY has to see every row of the project before the LIMIT can
 * choose one, and nothing bounded that on this deployment: one project holds 109,872 of the
 * table's 111,740 rows (98.33%), `task_project_rollup_covering_idx` carries the project predicate
 * but not `assignee_id` (so it cannot be read index-only for this projection) and
 * `task_assignee_id_idx` carries `assignee_id` but not `project_id` (so a plan through it fetches a
 * heap row per non-null task). Measured on production 2026-09-18, the plan was a Parallel Seq Scan
 * of the 160 MB heap — 20,535 buffers and 86.9 ms to produce one row. Migration 0283 added the
 * partial btree `task_project_assignee_idx` that lets PostgreSQL answer it index-only.
 *
 * WHAT IS ASSERTED, AND WHY IT IS A RATIO
 * =======================================
 * The buffers the statement reads against the pages the table has. An absolute threshold would be a
 * statement about this fixture's size — the mistake this project has paid for three times, most
 * recently with a 1000 MB index budget that two days of growth swallowed. The ratio is the property
 * the migration exists for and it does not rot: the read costs the PROJECT's pages, so the table
 * can grow and the number stays where it is.
 *
 * The plan SHAPE is asserted beside it, because a ratio can be satisfied by a table small enough to
 * sit in cache, which is not the same claim. Between the two, dropping the index, narrowing it, or
 * letting its predicate drift far enough that PostgreSQL can no longer prove the statement implies
 * it are all red — and that drift is the failure with no other symptom: the rows come back correct
 * either way, and only the plan says which one happened.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 * `scripts/run-pg-spec.sh src/apiserver/src/projects/project-busiest-assignee-plan.pg.spec.ts`
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails, titles and token hashes are unique, and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

/**
 * One project's tasks in the fixture, and the width of each.
 *
 * The size is chosen so the planner's own costing picks the index rather than being told to: at
 * ~1.4 kB a row this heap is ~4,000 pages and the index over it is ~30, and a Seq Scan that has to
 * read all of them cannot win. Row width is not decoration either — production's Task rows average
 * 1.5 kB because of `description` and `acceptance_criteria`, and a fixture of narrow rows would
 * change which plan is cheapest for reasons that have nothing to do with what is being asserted.
 */
const BIG_PROJECT_TASKS = 24_000;
const FILLER = 'x'.repeat(1_200);

function connect(): { db: PrismaClient; sql: Array<{ query: string; params: string }> } {
  const sql: Array<{ query: string; params: string }> = [];
  const db = new PrismaClient({
    adapter: new PrismaPg(URL!),
    log: [{ emit: 'event', level: 'query' }],
  });
  (db as unknown as {
    $on: (e: 'query', cb: (q: { query: string; params: string }) => void) => void;
  }).$on('query', (q) => sql.push({ query: q.query, params: q.params }));
  return { db, sql };
}

interface World {
  ownerId: string;
  liveWorkspaceId: string;
  trashedWorkspaceId: string;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${RUN}-${ownerId}@busiest-assignee.invalid`,
      name: label, passwordHash: 'x',
    },
  });
  const runnerId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `runner ${label} ${RUN}`, tokenHash: `token-${runnerId}`,
      capabilities: [], status: 'ONLINE',
    },
  });
  const workspace = async (name: string, deletedAt: Date | null): Promise<string> => {
    const id = randomUUID();
    await db.workspace.create({
      data: { id, ownerId, runnerId, name: `${name} ${RUN}`, enabled: true, deletedAt },
    });
    return id;
  };
  return {
    ownerId,
    liveWorkspaceId: await workspace('live', null),
    trashedWorkspaceId: await workspace('trashed', new Date()),
  };
}

/** Bulk rows, in the shape `task` requires: a foreign key's worth of ids and the declared criterion. */
async function seed(
  db: PrismaClient, ids: World, projectId: string | null, workspaceId: string | null, n: number,
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "task"(
       "id", "title", "description", "owner_id", "project_id", "assignee_id", "creator_type",
       "creator_id", "status", "auto_run_when_ready", "dispatch_hold", "completion_criterion",
       "updated_at"
     )
     SELECT gen_random_uuid(), 'work ' || i, $5::text, $1::uuid, $2::uuid, $3::uuid, 'USER',
            $1::uuid, 'OPEN', true, false, 'EVIDENCE_JUDGMENT', now()
       FROM generate_series(1, $4::int) AS i`,
    ids.ownerId,
    projectId,
    workspaceId,
    n,
    FILLER,
  );
}

/**
 * The statement the service sends, as Prisma compiled it, with its bind parameters inlined.
 *
 * Captured rather than written out here on purpose: the SQL a `groupBy` compiles to is a moving
 * part of Prisma — this one carries an `OFFSET $3` the previous client did not — and the join
 * condition it builds for `assignee: { deletedAt: null }` has changed spelling across versions
 * while meaning the same thing. A hand-copied string would stop testing the statement the service
 * issues the day either moved, which is the drift a plan assertion is supposed to catch.
 */
async function serviceStatement(
  db: PrismaClient, sql: Array<{ query: string; params: string }>, projectId: string,
): Promise<string> {
  sql.length = 0;
  await db.task.groupBy({
    by: ['assigneeId'],
    where: { projectId, assigneeId: { not: null }, assignee: { deletedAt: null } },
    _count: { _all: true },
    orderBy: { _count: { assigneeId: 'desc' } },
    take: 1,
  });
  const sent = sql.find((entry) => /GROUP BY/i.test(entry.query));
  assert.ok(sent, `no GROUP BY reached the server; Prisma sent: ${sql.map((s) => s.query).join(' | ')}`);
  const params: unknown[] = JSON.parse(sent.params);
  const inlined = sent.query.replace(/\$(\d+)/g, (_match, n: string) => {
    const value = params[Number(n) - 1];
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return `'${String(value).replaceAll("'", "''")}'`;
  });
  assert.doesNotMatch(inlined, /\$\d/, 'a bind parameter was left in place');
  return inlined;
}

/** The buffers the TOP node of a plan reports — which is the whole statement's total. */
function buffers(plan: string): number {
  const match = /Buffers: shared hit=(\d+)(?: read=(\d+))?/.exec(plan);
  assert.ok(match, `the plan reports no buffers:\n${plan}`);
  return Number(match[1]) + Number(match[2] ?? 0);
}

/**
 * Statistics and visibility, because `EXPLAIN` answers from both and neither is there after a bulk
 * load: autoanalyze runs on its own clock, and `heap fetches` stays non-zero until a VACUUM sets
 * the visibility map. Production's `task` is 20,476 of 20,485 pages all-visible, so this is the
 * state the fixture is being made to match rather than a convenience.
 */
async function settle(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe('VACUUM "task"');
  await db.$executeRawUnsafe('ANALYZE "task"');
}

async function explain(db: PrismaClient, statement: string, analyze: boolean): Promise<string> {
  const rows = await db.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
    `EXPLAIN ${analyze ? '(ANALYZE, BUFFERS) ' : ''}${statement}`,
  );
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

test('the read is served by task_project_assignee_idx, and cannot be served by a Seq Scan', {
  skip,
}, async () => {
  const { db, sql } = connect();
  try {
    const ids = await world(db, 'plan');
    const projectId = (await db.project.create({
      data: { ownerId: ids.ownerId, title: `big ${RUN}` },
    })).id;
    await seed(db, ids, projectId, ids.liveWorkspaceId, BIG_PROJECT_TASKS);
    // Rows outside the project, because "costs the project, not the table" is only a claim about a
    // table with something else in it — and these are the pages a Seq Scan would have to read.
    for (let i = 0; i < 4; i += 1) {
      const other = (await db.project.create({
        data: { ownerId: ids.ownerId, title: `other ${i} ${RUN}` },
      })).id;
      await seed(db, ids, other, ids.liveWorkspaceId, 400);
    }
    await settle(db);

    const statement = await serviceStatement(db, sql, projectId);
    // `SET LOCAL` and the EXPLAIN in one transaction, so the setting is the one that governs this
    // plan. Forced, so the answer does not depend on the planner's mood: with `enable_seqscan` off,
    // a plan that still names `task_project_assignee_idx` proves the index covers the statement's
    // shape. Without the index the planner falls back to `task_project_id_idx` and fetches a heap
    // row per task — which is why naming the index is worth asserting rather than "some index".
    const forced = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN ${statement}`);
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    assert.match(forced, /Index Only Scan using task_project_assignee_idx/,
      `the statement is not served by the index:\n${forced}`);
    assert.doesNotMatch(forced, /Seq Scan on (?:public\.)?task\b/,
      `the statement still scans the table:\n${forced}`);
  } finally {
    await db.$disconnect();
  }
});

test('on a table this size the read costs the project and not the table', { skip }, async () => {
  const { db, sql } = connect();
  try {
    const ids = await world(db, 'cost');
    const projectId = (await db.project.create({
      data: { ownerId: ids.ownerId, title: `cost ${RUN}` },
    })).id;
    await seed(db, ids, projectId, ids.liveWorkspaceId, BIG_PROJECT_TASKS);
    for (let i = 0; i < 4; i += 1) {
      const other = (await db.project.create({
        data: { ownerId: ids.ownerId, title: `filler ${i} ${RUN}` },
      })).id;
      await seed(db, ids, other, ids.liveWorkspaceId, 400);
    }
    await settle(db);

    const statement = await serviceStatement(db, sql, projectId);
    const plan = await explain(db, statement, true);
    const [table] = await db.$queryRawUnsafe<Array<{ pages: number }>>(
      `SELECT relpages AS pages FROM pg_class WHERE relname = 'task'`,
    );

    assert.match(plan, /Index Only Scan using task_project_assignee_idx/,
      `the planner abandoned the index on a table this size:\n${plan}`);
    // No heap access at all, which is the arithmetic the ratio rests on: the plan reads the index
    // and visits no row. This is what a VACUUM above buys, and it is also what production's `task`
    // looks like — 20,476 of its 20,485 pages are all-visible.
    assert.match(plan, /Heap Fetches: 0/, `the plan visited the heap:\n${plan}`);

    const read = buffers(plan);
    const pages = Number(table.pages);
    assert.ok(read * 10 < pages,
      `the statement read ${read} buffers of a ${pages}-page table — the read is following the `
      + `table rather than the project:\n${plan}`);
  } finally {
    await db.$disconnect();
  }
});

test('the read still answers the same question, soft-deleted workspaces included', { skip },
  async () => {
    const { db, sql } = connect();
    try {
      const ids = await world(db, 'semantics');
      const project = async (title: string): Promise<string> => (await db.project.create({
        data: { ownerId: ids.ownerId, title: `${title} ${RUN}` },
      })).id;
      const groupBy = async (projectId: string): Promise<string[]> => {
        const rows = await db.$queryRawUnsafe<Array<{ assignee_id: string }>>(
          await serviceStatement(db, sql, projectId),
        );
        return rows.map((row) => row.assignee_id);
      };

      // The soft-deleted workspace holds MORE of this project's tasks than the live one. Borrowing a
      // workspace `sessions.create` refuses produces a coordinator that cannot be opened at all, so
      // the filter is the answer and not a tie-break: the live workspace wins on 3 tasks against 7,
      // and the deleted one must never come back.
      const mixed = await project('mixed');
      await seed(db, ids, mixed, ids.trashedWorkspaceId, 7);
      await seed(db, ids, mixed, ids.liveWorkspaceId, 3);
      assert.deepEqual(await groupBy(mixed), [ids.liveWorkspaceId],
        'the busiest assignee is the live workspace, whatever the deleted one holds');

      // A project whose work all sits in a deleted workspace has no landing at all — which the
      // service answers with null and the endpoint with `NO_TASK_ASSIGNEE`, never with that
      // workspace.
      const orphaned = await project('orphaned');
      await seed(db, ids, orphaned, ids.trashedWorkspaceId, 5);
      assert.deepEqual(await groupBy(orphaned), []);

      // Unassigned tasks are not an assignee either: `assignee_id IS NOT NULL` keeps them out of
      // the grouping, so a project of nothing but unassigned work has no landing rather than a
      // landing named null.
      const unassigned = await project('unassigned');
      await seed(db, ids, unassigned, null, 4);
      assert.deepEqual(await groupBy(unassigned), []);

      // And the tie-break the ORDER BY exists for: the busiest wins, not the first by id.
      const tie = await project('tie');
      await seed(db, ids, tie, ids.liveWorkspaceId, 2);
      const second = (await db.workspace.create({
        data: {
          id: randomUUID(), ownerId: ids.ownerId, name: `second ${RUN}`, enabled: true,
          runnerId: (await db.runner.findFirstOrThrow({
            where: { ownerId: ids.ownerId }, select: { id: true },
          })).id,
        },
      })).id;
      await seed(db, ids, tie, second, 9);
      assert.deepEqual(await groupBy(tie), [second]);
    } finally {
      await db.$disconnect();
    }
  });
