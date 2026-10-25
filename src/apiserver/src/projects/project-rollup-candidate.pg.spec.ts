import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient, ProjectStatus, RunnerStatus, RunStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { readProjectListRollups } from './project-list-rollup';
import { projectRollupCandidateRowsSql, rebuildProjectRollupCandidates } from './project-rollup-candidate';
import { projectTaskWorkStateSql } from './project-task-work-state';

/**
 * `project_rollup_candidate` (0441) against the predicates it stands for, on real PostgreSQL.
 *
 * `GET /projects` counts every task into the lane its stored status implies and asks the shared
 * classifier only about the tasks this table names (and the ones a work session carries). That is
 * exact for as long as the table is a SUPERSET of the tasks that can leave their status's lane —
 * `projectRollupCandidateRowsSql`, spliced from the classifier's own READY guard and gate test — and
 * the triggers that keep it are a second spelling of those predicates, in SQL. So the claim here is
 * the one a stale or narrowed trigger would break, checked after every single write rather than at
 * the end:
 *
 *  - every task the predicates name is in the table, through task inserts, status changes,
 *    retirements and supersessions, gate flips, project moves, dependency edges added, re-pointed
 *    and deleted, and tasks deleted from under their dependents;
 *  - the list's seven numbers equal what classifying EVERY task with the shared expression gives;
 *  - a rebuild leaves exactly the predicates' set, and never drops a row a transaction it cannot
 *    see has appended.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 * `scripts/run-pg-spec.sh src/apiserver/src/projects/project-rollup-candidate.pg.spec.ts`
 */

const URL = process.env.COORDINATOR_PG_URL;

const STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'FAILED', 'CANCELLED'] as const;
type Status = (typeof STATUSES)[number];
const LANES = {
  RUNNING: 'running',
  READY: 'ready',
  BLOCKED: 'blocked',
  AWAITING_VERIFICATION: 'awaitingVerification',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

/** Seeded so a failing step can be replayed exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Owner {
  id: string;
  workspaceId: string;
  /** Projects tasks may be filed under, the CANCELLED one included. */
  projects: string[];
}

async function makeOwner(db: PrismaClient, label: string, cancelledProject: boolean): Promise<Owner> {
  const id = randomUUID();
  await db.user.create({
    data: { id, email: `${label}-${id}@candidate.invalid`, name: label, passwordHash: 'x' },
  });
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId: id, name: `candidate runner ${id}`, tokenHash: `candidate-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: id, runnerId, name: `candidate workspace ${id}`, enabled: true },
  });
  const projects: string[] = [];
  for (const status of [ProjectStatus.OPEN, ProjectStatus.OPEN,
    ...(cancelledProject ? [ProjectStatus.CANCELLED] : [])]) {
    const projectId = randomUUID();
    await db.project.create({ data: { id: projectId, ownerId: id, title: `${label} ${status}`, status } });
    projects.push(projectId);
  }
  return { id, workspaceId, projects };
}

/**
 * One task, written the way a bulk import writes it. An ordinary task declares EXECUTABLE, so the
 * DONE writer fence (0193/0230) admits a later `status = 'DONE'`; a gate row declares VERIFICATION
 * with `VERIFICATION_PASSED`, the shape the classifier's AWAITING_VERIFICATION lane reads.
 */
async function insertTask(
  pg: Client, owner: Owner, projectId: string | null, status: Status, gate: boolean,
): Promise<string> {
  const id = randomUUID();
  await pg.query(
    `INSERT INTO "task" ("id", "title", "owner_id", "project_id", "creator_type", "creator_id",
                         "assignee_id", "status", "completion_criterion", "completion_policy",
                         "acceptance_command", "acceptance_expected_exit_code", "updated_at")
     VALUES ($1, $2, $3, $4, 'USER', $3, $5, $6::"task_status", $7::"task_completion_criterion",
             $8::"task_completion_policy", $9, $10, now())`,
    [id, `task ${id.slice(0, 8)}`, owner.id, projectId, owner.workspaceId, status,
      gate ? 'VERIFICATION' : 'EXECUTABLE', gate ? 'VERIFICATION_PASSED' : 'MANUAL',
      gate ? null : 'true', gate ? null : 0],
  );
  return id;
}

/** Rows the predicates name and the table does not: the one thing that may never exist. */
async function missing(pg: Client): Promise<string[]> {
  const { rows } = await pg.query<{ owner_id: string; id: string }>(
    `SELECT e."owner_id"::text AS "owner_id", e."id"::text AS "id"
       FROM (${projectRollupCandidateRowsSql('t')}) e("owner_id", "id")
     EXCEPT
     SELECT c."owner_id"::text, c."task_id"::text FROM "project_rollup_candidate" c`,
  );
  return rows.map((row) => `${row.owner_id}/${row.id}`).sort();
}

/** The table, folded, against the predicates' set: after a rebuild these are the same rows. */
async function tableDiffersFromExact(pg: Client): Promise<string[]> {
  const { rows } = await pg.query<{ side: string; owner_id: string; id: string }>(
    `WITH exact AS (
       SELECT e."owner_id"::text AS "owner_id", e."id"::text AS "id"
         FROM (${projectRollupCandidateRowsSql('t')}) e("owner_id", "id")
     ), held AS (
       SELECT DISTINCT c."owner_id"::text AS "owner_id", c."task_id"::text AS "id"
         FROM "project_rollup_candidate" c
     )
     SELECT 'missing' AS "side", * FROM (SELECT * FROM exact EXCEPT SELECT * FROM held) m
     UNION ALL
     SELECT 'stale', * FROM (SELECT * FROM held EXCEPT SELECT * FROM exact) s`,
  );
  return rows.map((row) => `${row.side} ${row.owner_id}/${row.id}`).sort();
}

interface Expected {
  taskCount: number;
  buckets: Record<(typeof LANES)[keyof typeof LANES], number>;
  lastActivityAt: number | null;
}

/**
 * The oracle: every task of the owner classified by the shared expression, un-narrowed — the
 * reading the list used to compute in full, per task, before 0441.
 */
async function classifiedEveryTask(pg: Client, ownerId: string): Promise<Map<string, Expected>> {
  // Epoch milliseconds rather than a Date: node-postgres reads a zoneless timestamp in the
  // process's zone, Prisma reads it as UTC, and the two would part by the host's offset.
  const { rows } = await pg.query<{ project_id: string; work_state: keyof typeof LANES; n: number; last: string }>(
    `SELECT t."project_id"::text AS "project_id", (${projectTaskWorkStateSql('t')})::text AS "work_state",
            count(*)::int AS "n", floor(extract(epoch FROM max(t."updated_at")) * 1000)::bigint::text AS "last"
       FROM "task" t
      WHERE t."owner_id" = $1::uuid AND t."project_id" IS NOT NULL
      GROUP BY 1, 2`,
    [ownerId],
  );
  const byProject = new Map<string, Expected>();
  for (const row of rows) {
    const entry = byProject.get(row.project_id) ?? {
      taskCount: 0,
      buckets: { running: 0, ready: 0, blocked: 0, awaitingVerification: 0, done: 0, failed: 0, cancelled: 0 },
      lastActivityAt: null,
    };
    entry.taskCount += row.n;
    entry.buckets[LANES[row.work_state]] += row.n;
    entry.lastActivityAt = Math.max(entry.lastActivityAt ?? 0, Number(row.last));
    byProject.set(row.project_id, entry);
  }
  return byProject;
}

async function assertListIsTheClassifier(
  pg: Client, prisma: PrismaService, owners: Owner[], at: string,
): Promise<void> {
  for (const owner of owners) {
    const expected = await classifiedEveryTask(pg, owner.id);
    const listed = await readProjectListRollups(prisma, owner.id);
    const actual = new Map([...listed].map(([projectId, rollup]) => [projectId, {
      taskCount: rollup.taskCount,
      buckets: rollup.buckets,
      lastActivityAt: rollup.lastActivityAt?.getTime() ?? null,
    }]));
    assert.deepEqual(actual, expected, `${at}: the list parts from the classifier for owner ${owner.id}`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test('every write that can take a task out of its status’s lane names it, and the list stays the classifier’s',
  { skip: !URL, timeout: 600_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const pg = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await pg.connect();
    await verifyCoordinatorPgIdentity(pg);
    const db = prismaClientFor(URL);
    const prisma = db as unknown as PrismaService;

    try {
      const random = mulberry32(441);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
      const owners = [await makeOwner(db, 'first', true), await makeOwner(db, 'second', false)];

      // Every task this spec has written and not deleted, in creation order: an edge only ever
      // points from a later task to an earlier one, so the graph stays acyclic whatever the steps.
      const tasks: Array<{ id: string; owner: Owner }> = [];
      const addTask = async (owner: Owner): Promise<void> => {
        // Mostly OPEN, the population the READY guard decides; one in eight a gate row; one in
        // ten outside any project, which the list never counts and the table never needs.
        const status = random() < 0.55 ? 'OPEN' : pick(STATUSES);
        const projectId = random() < 0.1 ? null : pick(owner.projects);
        tasks.push({ id: await insertTask(pg, owner, projectId, status, random() < 0.125), owner });
      };
      for (let i = 0; i < 70; i += 1) await addTask(pick(owners));
      // Cross-owner and cross-project edges included: the guard reads the prerequisite wherever it
      // is filed, and so must the trigger that notices it finishing.
      for (let i = 0; i < 90; i += 1) {
        const dependent = 1 + Math.floor(random() * (tasks.length - 1));
        const prerequisite = Math.floor(random() * dependent);
        await pg.query(
          `INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id")
           VALUES (gen_random_uuid(), $1, $2) ON CONFLICT DO NOTHING`,
          [tasks[dependent].id, tasks[prerequisite].id],
        );
      }
      assert.deepEqual(await missing(pg), [], 'the inserts named every task they had to');
      await assertListIsTheClassifier(pg, prisma, owners, 'after the seed');

      // A rebuild first, so what follows starts from the exact set: a trigger that misses a write
      // is then caught by the very next check, not hidden behind a row an INSERT left there.
      await rebuildProjectRollupCandidates(prisma);
      assert.deepEqual(await tableDiffersFromExact(pg), [], 'a rebuild leaves exactly the predicates’ set');
      await assertListIsTheClassifier(pg, prisma, owners, 'after the first rebuild');

      const live = () => tasks[Math.floor(random() * tasks.length)];
      const steps: Array<[string, () => Promise<unknown>]> = [
        ['status', async () => pg.query(
          `UPDATE "task" SET "status" = $2::"task_status"
            WHERE "id" = $1 AND "terminal_reason" IS NULL`,
          [live().id, pick(STATUSES)])],
        ['retire', async () => pg.query(
          `UPDATE "task" SET "terminal_reason" = 'ABANDONED', "superseded_at" = now()
            WHERE "id" = $1 AND "status" IN ('CANCELLED', 'FAILED') AND "terminal_reason" IS NULL`,
          [live().id])],
        ['supersede', async () => {
          const retired = live();
          const successor = tasks.filter((task) => task.owner === retired.owner && task.id !== retired.id);
          if (successor.length === 0) return undefined;
          return pg.query(
            `UPDATE "task" SET "terminal_reason" = 'SUPERSEDED', "superseded_at" = now(),
                    "superseded_by_task_id" = $2
              WHERE "id" = $1 AND "status" IN ('CANCELLED', 'FAILED') AND "terminal_reason" IS NULL
                AND "project_id" IS NOT DISTINCT FROM (SELECT "project_id" FROM "task" WHERE "id" = $2)`,
            [retired.id, pick(successor).id]);
        }],
        ['unretire', async () => pg.query(
          `UPDATE "task" SET "terminal_reason" = NULL, "superseded_by_task_id" = NULL, "superseded_at" = NULL
            WHERE "id" = $1`,
          [live().id])],
        ['reopen a retired task', async () => pg.query(
          `UPDATE "task" SET "terminal_reason" = NULL, "superseded_by_task_id" = NULL,
                  "superseded_at" = NULL, "status" = 'OPEN'
            WHERE "id" = $1 AND "terminal_reason" IS NOT NULL`,
          [live().id])],
        ['gate', async () => pg.query(
          `UPDATE "task"
              SET "completion_policy" = CASE WHEN "completion_policy" = 'MANUAL'
                                             THEN 'VERIFICATION_PASSED' ELSE 'MANUAL' END::"task_completion_policy",
                  "completion_criterion" = CASE WHEN "completion_policy" = 'MANUAL'
                                                THEN 'VERIFICATION' ELSE 'EXECUTABLE' END::"task_completion_criterion",
                  "acceptance_command" = CASE WHEN "completion_policy" = 'MANUAL' THEN NULL ELSE 'true' END,
                  "acceptance_expected_exit_code" = CASE WHEN "completion_policy" = 'MANUAL' THEN NULL ELSE 0 END
            WHERE "id" = $1 AND "verifies_task_id" IS NULL`,
          [live().id])],
        ['move', async () => {
          const task = live();
          return pg.query(`UPDATE "task" SET "project_id" = $2 WHERE "id" = $1`,
            [task.id, random() < 0.15 ? null : pick(task.owner.projects)]);
        }],
        ['edge added', async () => {
          if (tasks.length < 2) return undefined;
          const dependent = 1 + Math.floor(random() * (tasks.length - 1));
          return pg.query(
            `INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id")
             VALUES (gen_random_uuid(), $1, $2) ON CONFLICT DO NOTHING`,
            [tasks[dependent].id, tasks[Math.floor(random() * dependent)].id]);
        }],
        ['edge deleted', async () => pg.query(
          `DELETE FROM "task_dependency"
            WHERE "id" = (SELECT "id" FROM "task_dependency" ORDER BY random() LIMIT 1)`)],
        ['edge re-pointed', async () => pg.query(
          `UPDATE "task_dependency" edge SET "depends_on_task_id" = $1
            WHERE edge."id" = (SELECT "id" FROM "task_dependency" ORDER BY random() LIMIT 1)
              AND edge."task_id" <> $1
              AND NOT EXISTS (SELECT 1 FROM "task_dependency" twin
                               WHERE twin."task_id" = edge."task_id" AND twin."depends_on_task_id" = $1)`,
          [live().id])],
        ['task added', async () => addTask(pick(owners))],
        ['task deleted', async () => {
          const index = Math.floor(random() * tasks.length);
          const [gone] = tasks.splice(index, 1);
          // A successor is let go of first, as the services do: the link is ON DELETE SET NULL,
          // which the supersession CHECK would refuse on a row still marked SUPERSEDED.
          await pg.query(
            `UPDATE "task" SET "superseded_by_task_id" = NULL, "terminal_reason" = NULL, "superseded_at" = NULL
              WHERE "superseded_by_task_id" = $1`, [gone.id]);
          return pg.query(`DELETE FROM "task" WHERE "id" = $1`, [gone.id]);
        }],
        ['work session', async () => {
          const task = live();
          const running = await db.session.findFirst({
            where: { taskId: task.id, status: RunStatus.RUNNING }, select: { id: true },
          });
          if (running) {
            return db.session.update({ where: { id: running.id }, data: { status: RunStatus.SUCCEEDED } });
          }
          return db.session.create({
            data: {
              ownerId: task.owner.id, creatorId: task.owner.id, taskId: task.id, title: 'a run',
              prompt: 'do it', status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER,
              startsTaskWork: true,
            },
          });
        }],
      ];

      const refused = new Map<string, number>();
      const applied = new Map<string, number>();
      for (let step = 1; step <= 320; step += 1) {
        const [kind, run] = pick(steps);
        try {
          await run();
          applied.set(kind, (applied.get(kind) ?? 0) + 1);
        } catch (error) {
          // The database's own guards refuse some of these (a supersession cycle, a move that would
          // strand a successor, a DONE the writer fence does not admit). A refused write changed
          // nothing, which is a step like any other for the claim under test.
          // Only a refusal is a step: a constraint, or a guard raising one of its upper-case codes.
          // Anything else — a trigger that no longer parses, a column that moved — fails the spec.
          refused.set(kind, (refused.get(kind) ?? 0) + 1);
          if (!(error instanceof Error)
            || !/violates|duplicate key|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u.test(error.message)) {
            throw error;
          }
        }
        assert.deepEqual(await missing(pg), [], `step ${step} (${kind}) left a task the list must classify unnamed`);
        if (step % 20 === 0) await assertListIsTheClassifier(pg, prisma, owners, `step ${step}`);
        if (step % 80 === 0) {
          await rebuildProjectRollupCandidates(prisma);
          assert.deepEqual(await tableDiffersFromExact(pg), [], `the rebuild at step ${step} is not the exact set`);
          await assertListIsTheClassifier(pg, prisma, owners, `after the rebuild at step ${step}`);
        }
      }
      // The steps that are about the trigger have to have happened, not merely been drawn: a run in
      // which every supersession was refused proves nothing about supersession.
      for (const kind of ['status', 'retire', 'supersede', 'gate', 'move', 'edge added', 'edge deleted',
        'edge re-pointed', 'task added', 'task deleted', 'work session']) {
        assert.ok((applied.get(kind) ?? 0) > 0, `no "${kind}" step was applied (refused ${refused.get(kind) ?? 0})`);
      }
    } finally {
      await db.$disconnect();
      await pg.end();
    }
  });

test('a rebuild keeps every row appended by a transaction it cannot see, and waits for none',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const pg = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await pg.connect();
    await verifyCoordinatorPgIdentity(pg);
    const writer = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await writer.connect();
    await verifyCoordinatorPgIdentity(writer);
    const db = prismaClientFor(URL);
    const prisma = db as unknown as PrismaService;

    const held = async (taskId: string): Promise<boolean> =>
      (await pg.query(`SELECT 1 FROM "project_rollup_candidate" WHERE "task_id" = $1`, [taskId])).rowCount! > 0;

    try {
      const owner = await makeOwner(db, 'concurrent', false);
      const [projectId] = owner.projects;

      await t.test('a task inserted OPEN in a transaction still open while the rebuild runs', async () => {
        await writer.query('BEGIN');
        const fresh = await insertTask(writer, owner, projectId, 'OPEN', false);
        await withTimeout(rebuildProjectRollupCandidates(prisma), 20_000, 'the rebuild beside an open Task insert');
        await writer.query('COMMIT');
        assert.equal(await held(fresh), true, 'the rebuild deleted a row its snapshot could not see');
        assert.deepEqual(await missing(pg), []);
        await assertListIsTheClassifier(pg, prisma, [owner], 'after the open insert committed');
      });

      // The interleaving an append-only table exists to survive: the dependent's prerequisite
      // finishes in a transaction that the rebuild's snapshot does not include.
      await t.test('a prerequisite finished in a transaction still open while the rebuild runs', async () => {
        const prerequisite = await insertTask(pg, owner, projectId, 'OPEN', false);
        const dependent = await insertTask(pg, owner, projectId, 'OPEN', false);
        await pg.query(
          `INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id") VALUES (gen_random_uuid(), $1, $2)`,
          [dependent, prerequisite]);
        await rebuildProjectRollupCandidates(prisma);
        assert.equal(await held(dependent), false, 'a dependent of an OPEN prerequisite is not a candidate');

        await writer.query('BEGIN');
        await writer.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1`, [prerequisite]);
        await withTimeout(rebuildProjectRollupCandidates(prisma), 20_000, 'the rebuild beside an open status write');
        assert.equal(await held(dependent), false, 'nothing committed yet names it');
        await writer.query('COMMIT');
        assert.equal(await held(dependent), true, 'the dependent of a finished prerequisite was lost');
        assert.deepEqual(await missing(pg), []);
        await assertListIsTheClassifier(pg, prisma, [owner], 'after the prerequisite finished');
        const listed = (await readProjectListRollups(prisma, owner.id)).get(projectId)!;
        assert.ok(listed.buckets.ready >= 1, 'the dependent reads READY, its one prerequisite DONE');
      });

      await t.test('an edge deleted in a transaction still open while the rebuild runs', async () => {
        const prerequisite = await insertTask(pg, owner, projectId, 'OPEN', false);
        const dependent = await insertTask(pg, owner, projectId, 'OPEN', false);
        await pg.query(
          `INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id") VALUES (gen_random_uuid(), $1, $2)`,
          [dependent, prerequisite]);
        await rebuildProjectRollupCandidates(prisma);
        assert.equal(await held(dependent), false);

        await writer.query('BEGIN');
        await writer.query(`DELETE FROM "task_dependency" WHERE "task_id" = $1`, [dependent]);
        await withTimeout(rebuildProjectRollupCandidates(prisma), 20_000, 'the rebuild beside an open edge delete');
        await writer.query('COMMIT');
        assert.equal(await held(dependent), true, 'the task an edge stopped holding was lost');
        await assertListIsTheClassifier(pg, prisma, [owner], 'after the edge went');
      });
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
      await db.$disconnect();
      await pg.end();
    }
  });
