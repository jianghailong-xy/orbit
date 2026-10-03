import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma, PrismaClient, ProjectStatus } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { readProjectSidebarRollups } from './project-list-rollup';

/**
 * The rail's `lastActivityAt` is one backward probe per project — asserted on real PostgreSQL.
 *
 * `GET /projects/sidebar` is polled every 15 seconds by every open tab, and `lastActivityAt` is
 * `max(updated_at)` over each OPEN project's tasks. Until migration 0361 nothing indexed that
 * question in the order it asks it, so PostgreSQL answered it by reading every task of every open
 * project: on production, 2026-10-03, 110,340 index entries and 9,054 of the statement's 10,421
 * buffers to produce 30 rows. `task_project_activity_idx` puts `updated_at` directly after the
 * project, and the statement's own `max()` becomes the min/max path: `Limit` over a BACKWARD scan
 * of the project's range, one row per project.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT A BUFFER COUNT
 * ==================================================
 * The task rows the statement reads for `lastActivityAt`, against the tasks the open projects hold.
 * (`running` is a SubPlan of its own, driven by its candidate set, so it is left out of the count;
 * `project-list-rollup.pg.spec.ts` owns it.) A buffer threshold would be a claim about this
 * fixture's size, the mistake this project has paid for three times; the rows read are the
 * property the index exists for, and they do not move with the table: one per project, however
 * many tasks each holds. The same statement with the index dropped, inside a
 * transaction that is rolled back, is the control — it must read the big project's every row, so
 * the assertion cannot pass on a fixture too small to tell the two paths apart. Both runs return
 * the same rows, which is the claim that matters most: this is an access path, not a new answer.
 *
 * The path is fragile in one way nothing else would notice. The min/max rewrite applies only while
 * the LATERAL is a lone `max()` over one table, so an aggregate added beside it — a `count(*)` "for
 * free" — silently puts the whole walk back, with every row still correct. Only the plan says.
 *
 * WHICH WRITES MOVE THE ANSWER
 * ============================
 * The second test walks the writes that change a project's newest task write, including the three
 * that LOWER it — a delete, a move to another project, and an `updated_at` written backwards (raw
 * SQL that stamps a precomputed `${now}` or a transaction-start `CURRENT_TIMESTAMP` can land earlier
 * than a write already committed). A maintained "newest write" column would have had to recompute
 * on each of those; an index has nothing to remember, and this pins that the answer follows them.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 * `scripts/run-pg-spec.sh src/apiserver/src/projects/project-sidebar-activity-plan.pg.spec.ts`
 */

const URL = process.env.COORDINATOR_PG_URL;
const INDEX = 'task_project_activity_idx';

/**
 * One project's tasks. Enough that reading them all is unmistakably not reading one per project,
 * and few enough to seed in a single statement.
 */
const BIG_PROJECT_TASKS = 20_000;

interface PlanNode {
  'Node Type': string;
  'Parent Relationship'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Scan Direction'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
}

interface Probe {
  /** Every task row the `lastActivityAt` side's scans of `task` returned, across all their loops. */
  taskRowsRead: number;
  /** The scans of this index, each with the node it sits under. */
  probes: Array<{ node: PlanNode; parent: PlanNode | null }>;
}

function probe(plan: PlanNode): Probe {
  const found: Probe = { taskRowsRead: 0, probes: [] };
  const walk = (node: PlanNode, parent: PlanNode | null): void => {
    // `running` is a correlated scalar subquery, so it is a SubPlan of its own: driven by its
    // candidate set rather than by the project, and not what this index is for. Outside it the
    // statement is the project scan and the `lastActivityAt` LATERAL, whose min/max probe is an
    // InitPlan, not a SubPlan.
    if (node['Parent Relationship'] === 'SubPlan') return;
    if (node['Relation Name'] === 'task') {
      found.taskRowsRead += (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 0);
    }
    if (node['Index Name'] === INDEX) found.probes.push({ node, parent });
    for (const child of node.Plans ?? []) walk(child, node);
  };
  walk(plan, null);
  return found;
}

/** Owner-scoped tasks under one project, each `updated_at` one second older than the last. */
async function seed(
  identity: Client, ownerId: string, projectId: string, n: number, newest: Date,
): Promise<void> {
  await identity.query(
    `INSERT INTO "task"(
       "id", "title", "owner_id", "project_id", "creator_type", "creator_id", "status",
       "completion_criterion", "updated_at"
     )
     SELECT gen_random_uuid(), 'work ' || i, $1::uuid, $2::uuid, 'USER', $1::uuid, 'DONE',
            'EVIDENCE_JUDGMENT', $3::timestamp - make_interval(secs => i)
       FROM generate_series(0, $4::int - 1) AS i`,
    [ownerId, projectId, newest.toISOString().replace('Z', ''), n],
  );
}

async function makeProject(
  db: PrismaClient, ownerId: string, title: string, status: ProjectStatus = ProjectStatus.OPEN,
): Promise<string> {
  const id = randomUUID();
  await db.project.create({ data: { id, ownerId, title, status } });
  return id;
}

/** The statement the rail sends, as the service builds it, without running it. */
async function sidebarStatement(ownerId: string): Promise<Prisma.Sql> {
  let sent: Prisma.Sql | undefined;
  const capturing = {
    $queryRaw: async (query: Prisma.Sql) => {
      sent = query;
      return [];
    },
  } as unknown as PrismaService;
  await readProjectSidebarRollups(capturing, ownerId);
  assert.ok(sent, 'the sidebar read was captured');
  return sent;
}

test('the rail reads one task per open project for lastActivityAt, not every task it holds',
  { skip: !URL, timeout: 300_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);
    const db = prismaClientFor(URL);

    try {
      const ownerId = randomUUID();
      await db.user.create({
        data: {
          id: ownerId, email: `activity-${ownerId}@sidebar.invalid`, name: 'activity',
          passwordHash: 'x',
        },
      });
      const now = new Date('2026-10-03T00:00:00.000Z');
      const big = await makeProject(db, ownerId, 'big');
      await seed(identity, ownerId, big, BIG_PROJECT_TASKS, now);
      for (let i = 0; i < 3; i += 1) {
        await seed(identity, ownerId, await makeProject(db, ownerId, `small ${i}`), 40,
          new Date(now.getTime() - (i + 1) * 3_600_000));
      }
      await makeProject(db, ownerId, 'no tasks yet');
      // Not on the rail at all: the read is OPEN projects only, so this one's tasks are never read.
      await seed(identity, ownerId, await makeProject(db, ownerId, 'finished', ProjectStatus.DONE),
        400, now);
      const openProjects = 5;
      // Statistics and visibility, because EXPLAIN answers from both and neither exists after a
      // bulk load until autovacuum gets round to it.
      await identity.query('VACUUM ANALYZE "task"');

      const statement = await sidebarStatement(ownerId);
      const run = async (dropIndex: boolean) => {
        await identity.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        try {
          if (dropIndex) await identity.query(`DROP INDEX "${INDEX}"`);
          const explained = await identity.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, statement.values);
          // Epoch milliseconds, worked out in SQL: node-pg reads a `timestamp without time zone` in
          // the process's own zone, and this host's is not UTC.
          const rows = await identity.query(
            `SELECT "projectId", (extract(epoch FROM "lastActivityAt") * 1000)::bigint::text AS ms
               FROM (${statement.text}) rail ORDER BY 1`,
            statement.values);
          return {
            found: probe(explained.rows[0]['QUERY PLAN'][0].Plan as PlanNode),
            rows: rows.rows.map((row) => `${row.projectId} ${row.ms}`),
          };
        } finally {
          await identity.query('ROLLBACK');
        }
      };

      const withIndex = await run(false);
      const withoutIndex = await run(true);

      // The control first: without the index the statement reads the big project's every task.
      // A fixture where this fails could not tell the two paths apart.
      assert.ok(withoutIndex.found.taskRowsRead >= BIG_PROJECT_TASKS,
        `the control read only ${withoutIndex.found.taskRowsRead} task rows`);

      assert.ok(withIndex.found.probes.length > 0, `${INDEX} does not serve the read`);
      for (const { node, parent } of withIndex.found.probes) {
        assert.equal(node['Scan Direction'], 'Backward', 'the maximum is read from the end of the range');
        assert.equal(parent?.['Node Type'], 'Limit', 'one row per probe: the min/max path');
        assert.equal(node['Actual Loops'], openProjects, 'one probe per open project');
        assert.ok((node['Actual Rows'] ?? 0) <= 1, 'each probe returns at most one row');
      }
      assert.ok(withIndex.found.taskRowsRead * 100 < BIG_PROJECT_TASKS,
        `the read returned ${withIndex.found.taskRowsRead} task rows for ${openProjects} projects`);

      // The same answer from both paths, in one snapshot each and over the same rows.
      assert.deepEqual(withIndex.rows, withoutIndex.rows);
      assert.equal(withIndex.rows.length, openProjects);
      assert.ok(withIndex.rows.some((row) => row === `${big} ${now.getTime()}`),
        'the big project reports its newest task write');
      assert.ok(withIndex.rows.some((row) => row.endsWith(' null')),
        'a project without tasks reports null');
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });

test('lastActivityAt follows the writes that raise it and the three that lower it',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);
    const db = prismaClientFor(URL);

    try {
      const ownerId = randomUUID();
      await db.user.create({
        data: {
          id: ownerId, email: `writes-${ownerId}@sidebar.invalid`, name: 'writes', passwordHash: 'x',
        },
      });
      const a = await makeProject(db, ownerId, 'a');
      const b = await makeProject(db, ownerId, 'b');
      const at = (s: number) => new Date(Date.UTC(2026, 9, 3, 0, 0, s));
      // Three tasks in `a` at :01, :02 and :03, and one in `b` at :05.
      const ids: string[] = [];
      for (const [project, second] of [[a, 1], [a, 2], [a, 3], [b, 5]] as const) {
        const id = randomUUID();
        await identity.query(
          `INSERT INTO "task"("id", "title", "owner_id", "project_id", "creator_type", "creator_id",
                              "status", "completion_criterion", "updated_at")
           VALUES ($1, 'w', $2, $3, 'USER', $2, 'OPEN', 'EVIDENCE_JUDGMENT', $4::timestamp)`,
          [id, ownerId, project, at(second).toISOString().replace('Z', '')]);
        ids.push(id);
      }
      const [a1, , a3, b5] = ids;
      await identity.query('ANALYZE "task"');

      const rail = async () => {
        const read = await readProjectSidebarRollups(db as unknown as PrismaService, ownerId);
        return {
          a: read.get(a)?.lastActivityAt?.toISOString() ?? null,
          b: read.get(b)?.lastActivityAt?.toISOString() ?? null,
        };
      };
      const iso = (s: number) => at(s).toISOString();

      assert.deepEqual(await rail(), { a: iso(3), b: iso(5) });

      await t.test('an update through Prisma stamps @updatedAt and raises it', async () => {
        const updated = await db.task.update({ where: { id: a1 }, data: { priority: 1 } });
        assert.ok(updated.updatedAt.getTime() > at(3).getTime());
        assert.deepEqual(await rail(), { a: updated.updatedAt.toISOString(), b: iso(5) });
        // Put it back below :03 the way raw SQL can: an earlier stamp than the row already had.
        await identity.query(`UPDATE "task" SET "updated_at" = $2::timestamp WHERE "id" = $1`,
          [a1, at(1).toISOString().replace('Z', '')]);
        assert.deepEqual(await rail(), { a: iso(3), b: iso(5) },
          'a backwards write to the newest task lowers the answer to the next newest');
      });

      await t.test('deleting the newest task lowers it', async () => {
        await identity.query(`DELETE FROM "task" WHERE "id" = $1`, [a3]);
        assert.deepEqual(await rail(), { a: iso(2), b: iso(5) });
      });

      await t.test('moving the newest task to another project lowers one and can raise the other',
        async () => {
          await identity.query(`UPDATE "task" SET "project_id" = $2 WHERE "id" = $1`, [b5, a]);
          assert.deepEqual(await rail(), { a: iso(5), b: null },
            'b has no tasks left, so it reports null like a project that never had one');
          await identity.query(`UPDATE "task" SET "project_id" = $2 WHERE "id" = $1`, [b5, b]);
          assert.deepEqual(await rail(), { a: iso(2), b: iso(5) });
        });

      await t.test('an insert stamped older than the newest leaves it where it was', async () => {
        await identity.query(
          `INSERT INTO "task"("id", "title", "owner_id", "project_id", "creator_type", "creator_id",
                              "status", "completion_criterion", "updated_at")
           VALUES (gen_random_uuid(), 'old', $1, $2, 'USER', $1, 'OPEN', 'EVIDENCE_JUDGMENT',
                   $3::timestamp)`,
          [ownerId, a, at(0).toISOString().replace('Z', '')]);
        assert.deepEqual(await rail(), { a: iso(2), b: iso(5) },
          'the :02 task is still the one answering for a');
      });
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });
