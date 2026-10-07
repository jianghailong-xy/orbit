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
import { readProjectListRollups } from './project-list-rollup';

/**
 * `GET /projects` classifies its projects' tasks without visiting the Task heap — on real
 * PostgreSQL, against the plan.
 *
 * The rollup asks one question per project — how many of your tasks are in each of seven lanes —
 * and the CASE that answers it (project-task-work-state.ts) reads eleven columns of each task row.
 * `task_project_rollup_covering_idx` has carried five of them since migration 0178 and the other
 * six were added as INCLUDE payload by 0395, which is the whole of this spec's subject: with the
 * eleven-column index the classification is answered from the index (`Heap Fetches: 0`), and
 * without it PostgreSQL fetches a heap row per task — 111,708 heap rows and 243 MB of buffers for
 * 107 projects, measured on production 2026-10-07.
 *
 * WHAT IS ASSERTED
 * ================
 * The scan that CLASSIFIES — the one returning the project's tasks, where every other scan of
 * `task` in this statement is a probe returning at most one row — and two facts about it:
 *
 *  - with the index, it is an Index Only Scan over `task_project_rollup_covering_idx` reporting
 *    zero heap fetches. Zero is the property the INCLUDE payload exists for; the moment the
 *    classifier reads a twelfth column, this scan fetches a heap row per task again and the
 *    assertion says so — there is no other symptom, because every count still comes back correct.
 *  - without it, the same scan reads the big project's every task from the heap. That is the
 *    control, and it is also what keeps the fixture honest: a table small enough to sit in cache,
 *    or one whose rows are narrow enough that the planner never had a reason to prefer the index,
 *    would satisfy the first assertion without telling the two paths apart.
 *
 * Both runs return the same rows, asserted here as the answer to "this is an access path, not a new
 * answer": the same seven bucket counts and the same `lastActivityAt`, from both.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 * `scripts/run-pg-spec.sh src/apiserver/src/projects/project-rollup-covering-plan.pg.spec.ts`
 */

const URL = process.env.COORDINATOR_PG_URL;
const INDEX = 'task_project_rollup_covering_idx';

/**
 * One project's tasks, enough that reading them from the heap is unmistakably not reading an
 * index, and few enough to seed in one statement. `description` is padded so the heap pages this
 * read would touch dwarf the index's — on production the same table is 2.3 KB a row.
 */
const BIG_PROJECT_TASKS = 20_000;
const TASK_PADDING = 'x'.repeat(700);

interface PlanNode {
  'Node Type': string;
  'Parent Relationship'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Heap Fetches'?: number;
  Plans?: PlanNode[];
}

/**
 * The scan that classifies: of every scan of `task` in the statement, the one that returns the
 * most rows across its loops. The classifier is the only one of them that returns a project's worth
 * — the verification, dependency and epoch probes are lookups, one row or none per loop.
 */
function classifyingScan(plan: PlanNode): PlanNode | null {
  let best: PlanNode | null = null;
  let bestRows = -1;
  const walk = (node: PlanNode): void => {
    if (node['Relation Name'] === 'task') {
      const rows = (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 0);
      if (rows > bestRows) {
        bestRows = rows;
        best = node;
      }
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  return best;
}

/** Owner-scoped tasks under one project, all DONE, each with a heap-sized description. */
async function seed(
  identity: Client, ownerId: string, projectId: string, n: number, updatedAt: Date,
): Promise<void> {
  await identity.query(
    `INSERT INTO "task"(
       "id", "title", "description", "owner_id", "project_id", "creator_type", "creator_id",
       "status", "completion_criterion", "updated_at"
     )
     SELECT gen_random_uuid(), 'work ' || i, $4, $1::uuid, $2::uuid, 'USER', $1::uuid, 'DONE',
            'EVIDENCE_JUDGMENT', $3::timestamp - make_interval(secs => i)
       FROM generate_series(0, $5::int - 1) AS i`,
    [ownerId, projectId, updatedAt.toISOString().replace('Z', ''), TASK_PADDING, n],
  );
}

async function makeProject(
  db: PrismaClient, ownerId: string, title: string, status: ProjectStatus = ProjectStatus.OPEN,
): Promise<string> {
  const id = randomUUID();
  await db.project.create({ data: { id, ownerId, title, status } });
  return id;
}

/** The statement the list sends, as the service builds it, without running it. */
async function rollupStatement(ownerId: string): Promise<Prisma.Sql> {
  let sent: Prisma.Sql | undefined;
  const capturing = {
    $queryRaw: async (query: Prisma.Sql) => {
      sent = query;
      return [];
    },
  } as unknown as PrismaService;
  await readProjectListRollups(capturing, ownerId);
  assert.ok(sent, 'the rollup read was captured');
  return sent;
}

test('the rollup classifies each project\'s tasks from the index, never the heap',
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
          id: ownerId, email: `rollup-${ownerId}@covering.invalid`, name: 'covering',
          passwordHash: 'x',
        },
      });
      const now = new Date('2026-10-07T00:00:00.000Z');
      const big = await makeProject(db, ownerId, 'big');
      await seed(identity, ownerId, big, BIG_PROJECT_TASKS, now);
      for (let i = 0; i < 3; i += 1) {
        await seed(identity, ownerId, await makeProject(db, ownerId, `small ${i}`), 40,
          new Date(now.getTime() - (i + 1) * 3_600_000));
      }
      // Statistics and the visibility map, because an index-only scan answers from both and
      // neither exists after a bulk load until autovacuum gets round to it.
      await identity.query('VACUUM ANALYZE "task"');

      const statement = await rollupStatement(ownerId);
      const run = async (dropIndex: boolean) => {
        await identity.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        try {
          if (dropIndex) await identity.query(`DROP INDEX "${INDEX}"`);
          const explained = await identity.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, statement.values);
          const rows = await identity.query(
            `SELECT "projectId", "taskCount", "running", "ready", "blocked",
                    "awaitingVerification", "done", "failed", "cancelled",
                    (extract(epoch FROM "lastActivityAt") * 1000)::bigint::text AS ms
               FROM (${statement.text}) rollup ORDER BY 1`,
            statement.values);
          return {
            scan: classifyingScan(explained.rows[0]['QUERY PLAN'][0].Plan as PlanNode),
            rows: rows.rows.map((row) => Object.values(row).join(' ')),
          };
        } finally {
          await identity.query('ROLLBACK');
        }
      };

      const withIndex = await run(false);
      const withoutIndex = await run(true);

      // The control first: without the index the classifier reads the big project's every task
      // from the heap. A fixture where this fails could not tell the two paths apart.
      assert.ok(withoutIndex.scan, 'the rollup scans task at all');
      assert.ok(((withoutIndex.scan['Actual Rows'] ?? 0) * (withoutIndex.scan['Actual Loops'] ?? 1))
        >= BIG_PROJECT_TASKS,
      `the control read only ${withoutIndex.scan['Actual Rows']} rows per loop over `
        + `${withoutIndex.scan['Actual Loops']} loops`);

      assert.ok(withIndex.scan, 'the rollup scans task at all');
      assert.equal(withIndex.scan['Node Type'], 'Index Only Scan', 'the classification is index-only');
      assert.equal(withIndex.scan['Index Name'], INDEX, `${INDEX} does not serve the classification`);
      assert.equal(withIndex.scan['Heap Fetches'], 0, 'a heap fetch per task is what this index exists to remove');
      assert.ok(((withIndex.scan['Actual Rows'] ?? 0) * (withIndex.scan['Actual Loops'] ?? 1))
        >= BIG_PROJECT_TASKS,
      'the index served the classifying scan, not some other one');

      // The same answer from both paths, in one snapshot each and over the same rows.
      assert.deepEqual(withIndex.rows, withoutIndex.rows);
      assert.equal(withIndex.rows.length, 4, 'every project with tasks is reported');
      assert.ok(withIndex.rows.some((row) => row.includes(`${BIG_PROJECT_TASKS} `)),
        'the big project reports its whole population');
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });
