import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma, PrismaClient, ProjectStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { readProjectListRollups } from './project-list-rollup';
import { rebuildProjectRollupCandidates } from './project-rollup-candidate';
import { projectTaskWorkStateSql } from './project-task-work-state';

/**
 * `GET /projects` reads the task rows it has to classify and no others — on real PostgreSQL,
 * against the plan.
 *
 * This file used to pin the opposite end of the same read: 0395 made the classification of EVERY
 * task an index-only scan over `task_project_rollup_covering_idx`, and this asserted `Heap Fetches:
 * 0` on it. That scan is gone by design (0441): each status's default lane is counted off
 * `project_task_status_count`, and the shared classifier runs only on the rows
 * `project_rollup_candidate` names and the tasks a work session carries. On production the scan
 * had cost 71–96 ms on its own, and the classification riding on it 400–1,178 ms; what is pinned now
 * is that neither comes back.
 *
 * WHAT IS ASSERTED
 * ================
 * Over every node of the executed plan that reads `task`, the rows it returns times its loops — the
 * task rows the statement touches — and three facts about that number on a 10,000-task project:
 *
 *  - before a rebuild every OPEN task is still a candidate (each was appended when it was
 *    inserted), and the statement classifies all of them. That is the control: it is what reading
 *    every task looks like on this fixture, so the bound below means something;
 *  - after the rebuild the candidates are the one chain head that can run, and the statement
 *    touches a handful of task rows for the whole page — none of them through a sequential scan;
 *  - both runs return what classifying every task with the shared expression returns, in the same
 *    snapshot: the seven buckets, the total and `lastActivityAt` of every project.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 * `scripts/run-pg-spec.sh src/apiserver/src/projects/project-rollup-covering-plan.pg.spec.ts`
 */

const URL = process.env.COORDINATOR_PG_URL;

/** One project's tasks: enough that touching each of them is unmistakable in the plan. */
const CHAIN_TASKS = 5_000;
const DONE_TASKS = 5_000;
/**
 * Generous for "the candidates, their probes and one activity probe per project": the run measured
 * while this was written touched 5 — the chain's head and the four projects' activity probes.
 */
const TOUCHED_TASK_ROWS_BOUND = 100;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
}

/** Every node of the plan that reads `task`, with the rows it returned across its loops. */
function taskReads(plan: PlanNode): Array<{ node: string; rows: number }> {
  const reads: Array<{ node: string; rows: number }> = [];
  const walk = (node: PlanNode): void => {
    if (node['Relation Name'] === 'task') {
      reads.push({
        node: `${node['Node Type']}${node['Index Name'] ? ` using ${node['Index Name']}` : ''}`,
        rows: (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 0),
      });
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  return reads;
}

async function makeProject(db: PrismaClient, ownerId: string, title: string): Promise<string> {
  const id = randomUUID();
  await db.project.create({ data: { id, ownerId, title, status: ProjectStatus.OPEN } });
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

test('the rollup touches the task rows it classifies and no others',
  { skip: !URL, timeout: 600_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);
    const db = prismaClientFor(URL);

    try {
      const ownerId = randomUUID();
      await db.user.create({
        data: {
          id: ownerId, email: `rollup-${ownerId}@candidates.invalid`, name: 'candidates',
          passwordHash: 'x',
        },
      });
      // A workspace on an online runner, so the chain's head is a task a person could Run and the
      // READY lane has something to say.
      const runnerId = randomUUID();
      const workspaceId = randomUUID();
      await db.runner.create({
        data: {
          id: runnerId, ownerId, name: `candidates runner ${ownerId}`, tokenHash: `candidates-${runnerId}`,
          status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
        },
      });
      await db.workspace.create({
        data: { id: workspaceId, ownerId, runnerId, name: `candidates workspace ${ownerId}`, enabled: true },
      });

      // The production shape in small: one project holding a long chain of OPEN work, each task
      // waiting on the one before it, beside a body of finished work and a few small projects.
      const big = await makeProject(db, ownerId, 'big');
      await identity.query(
        `INSERT INTO "task"("id", "title", "owner_id", "project_id", "creator_type", "creator_id",
                            "assignee_id", "status", "completion_criterion", "acceptance_command",
                            "acceptance_expected_exit_code", "created_at", "updated_at")
         SELECT gen_random_uuid(), 'step ' || i, $1::uuid, $2::uuid, 'USER', $1::uuid, $3::uuid, 'OPEN',
                'EXECUTABLE', 'true', 0,
                timestamp '2026-10-01' + make_interval(secs => i),
                timestamp '2026-10-01' + make_interval(secs => i)
           FROM generate_series(1, $4::int) AS i`,
        [ownerId, big, workspaceId, CHAIN_TASKS],
      );
      await identity.query(
        `INSERT INTO "task_dependency"("id", "task_id", "depends_on_task_id")
         SELECT gen_random_uuid(), step."id", step."previous"
           FROM (SELECT t."id", lag(t."id") OVER (ORDER BY t."created_at") AS "previous"
                   FROM "task" t WHERE t."project_id" = $1::uuid) step
          WHERE step."previous" IS NOT NULL`,
        [big],
      );
      await identity.query(
        `INSERT INTO "task"("id", "title", "owner_id", "project_id", "creator_type", "creator_id",
                            "status", "completion_criterion", "updated_at")
         SELECT gen_random_uuid(), 'done ' || i, $1::uuid, $2::uuid, 'USER', $1::uuid, 'DONE',
                'EVIDENCE_JUDGMENT', timestamp '2026-09-01' + make_interval(secs => i)
           FROM generate_series(1, $3::int) AS i`,
        [ownerId, big, DONE_TASKS],
      );
      for (let i = 0; i < 3; i += 1) {
        await identity.query(
          `INSERT INTO "task"("id", "title", "owner_id", "project_id", "creator_type", "creator_id",
                              "status", "completion_criterion", "updated_at")
           SELECT gen_random_uuid(), 'small ' || i, $1::uuid, $2::uuid, 'USER', $1::uuid, 'DONE',
                  'EVIDENCE_JUDGMENT', timestamp '2026-08-01' + make_interval(secs => i)
             FROM generate_series(1, 40) AS i`,
          [ownerId, await makeProject(db, ownerId, `small ${i}`)],
        );
      }
      // Statistics and the visibility map, as autovacuum would leave them.
      await identity.query('VACUUM ANALYZE "task"');
      await identity.query('VACUUM ANALYZE "task_dependency"');
      await identity.query('ANALYZE "project_rollup_candidate"');

      const statement = await rollupStatement(ownerId);
      // Every task classified with the shared expression, un-narrowed: the answer the read has to
      // keep giving, computed the way the list computed it before 0441.
      const oracle = `
        SELECT t."project_id" AS "projectId",
               count(*)::int AS "taskCount",
               (count(*) FILTER (WHERE s."workState" = 'RUNNING'))::int AS "running",
               (count(*) FILTER (WHERE s."workState" = 'READY'))::int AS "ready",
               (count(*) FILTER (WHERE s."workState" = 'BLOCKED'))::int AS "blocked",
               (count(*) FILTER (WHERE s."workState" = 'AWAITING_VERIFICATION'))::int AS "awaitingVerification",
               (count(*) FILTER (WHERE s."workState" = 'DONE'))::int AS "done",
               (count(*) FILTER (WHERE s."workState" = 'FAILED'))::int AS "failed",
               (count(*) FILTER (WHERE s."workState" = 'CANCELLED'))::int AS "cancelled",
               max(t."updated_at") AS "lastActivityAt"
          FROM "task" t
         CROSS JOIN LATERAL (SELECT (${projectTaskWorkStateSql('t')})::text AS "workState") s
         WHERE t."owner_id" = $1::uuid AND t."project_id" IS NOT NULL
         GROUP BY t."project_id"`;
      const columns = `"projectId", "taskCount", "running", "ready", "blocked", "awaitingVerification",
                       "done", "failed", "cancelled",
                       (extract(epoch FROM "lastActivityAt") * 1000)::bigint::text AS ms`;

      const run = async () => {
        await identity.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        try {
          // As production runs (jit = off for its role and database): compiling these plans costs
          // this server seconds that production never pays, and a timeout here would be about JIT.
          await identity.query('SET LOCAL jit = off');
          const explained = await identity.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, statement.values);
          const listed = await identity.query(
            `SELECT ${columns} FROM (${statement.text}) rollup ORDER BY 1`, statement.values);
          const classified = await identity.query(
            `SELECT ${columns} FROM (${oracle}) everything ORDER BY 1`, [ownerId]);
          return {
            reads: taskReads(explained.rows[0]['QUERY PLAN'][0].Plan as PlanNode),
            listed: listed.rows.map((row) => Object.values(row).join(' ')),
            classified: classified.rows.map((row) => Object.values(row).join(' ')),
          };
        } finally {
          await identity.query('ROLLBACK');
        }
      };
      const touched = (reads: Array<{ rows: number }>) => reads.reduce((sum, read) => sum + read.rows, 0);

      // The control: every OPEN task was appended as it was inserted, so all of them are classified.
      const before = await run();
      assert.ok(touched(before.reads) >= CHAIN_TASKS,
        `the control touched only ${touched(before.reads)} task rows: ${JSON.stringify(before.reads)}`);
      assert.deepEqual(before.listed, before.classified, 'a stale candidate set still gives the classifier’s answer');

      await rebuildProjectRollupCandidates(db as unknown as PrismaService);
      await identity.query('ANALYZE "project_rollup_candidate"');
      const after = await run();
      assert.ok(touched(after.reads) <= TOUCHED_TASK_ROWS_BOUND,
        `the rollup touched ${touched(after.reads)} task rows after the rebuild: ${JSON.stringify(after.reads)}`);
      for (const read of after.reads) {
        assert.doesNotMatch(read.node, /^Seq Scan/, `the rollup read task through ${read.node}`);
      }
      assert.deepEqual(after.listed, after.classified, 'the narrowed read gives the classifier’s answer');
      assert.deepEqual(after.listed, before.listed, 'the rebuild moved no number');

      assert.equal(after.listed.length, 4, 'every project with tasks is reported');
      const [bigRow] = after.listed.filter((row) => row.startsWith(big));
      // The head of the chain can run; every other step waits on the one before it.
      assert.equal(bigRow, `${big} ${CHAIN_TASKS + DONE_TASKS} 0 1 ${CHAIN_TASKS - 1} 0 ${DONE_TASKS} 0 0 `
        + `${Date.UTC(2026, 9, 1) + CHAIN_TASKS * 1000}`);
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });
