import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  CreatorType, PrismaClient, RunnerStatus, RunStatus, SessionDispatchOrigin, TaskStatus,
} from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectsService } from './projects.service';
import { prismaClientFor } from '../prisma/prisma-client';

/**
 * `GET /projects/:id/panorama` against a real, fully migrated PostgreSQL.
 *
 * Every number this endpoint returns is produced by one recursive query and none of it exists in a
 * pure function: the `ready`/`blocked` split is a `FILTER` over a join, the longest dependency path
 * is a recursive CTE, and the whole thing is `$queryRaw`, where a renamed column compiles, runs and
 * serves `undefined`. A fake Prisma could only agree with itself about all three.
 *
 * Each scenario builds its own owner and project and every query is scoped by both, so the specs
 * cannot see each other's fixtures and nothing here truncates a table it did not create. Its writes
 * are still confined to an isolated disposable server (see coordinator-pg-test-safety), which is
 * proved before the first one.
 *
 *   docker run -d --name pcc-panorama-pg16 -e POSTGRES_PASSWORD=pcc_panorama \
 *     -e POSTGRES_USER=pcc_panorama -e POSTGRES_DB=pcc_panorama \
 *     -p 127.0.0.1:55640:5432 postgres:16
 *   DATABASE_URL=postgresql://pcc_panorama:pcc_panorama@127.0.0.1:55640/pcc_panorama \
 *     npx prisma migrate deploy
 *   COORDINATOR_PG_URL=postgresql://pcc_panorama:pcc_panorama@127.0.0.1:55640/pcc_panorama \
 *     COORDINATOR_PG_EXPECTED_DATABASE=pcc_panorama COORDINATOR_PG_EXPECTED_USER=pcc_panorama \
 *     COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(psql -tAc \
 *       'SELECT system_identifier FROM pg_control_system()') \
 *     node --test build/projects/project-panorama-buckets.pg.spec.js
 */

const URL = process.env.COORDINATOR_PG_URL;

interface TaskSpec {
  status?: TaskStatus;
  /** Names of tasks in the same spec that this one waits on. */
  dependsOn?: string[];
}

interface Fixture {
  ownerId: string;
  projectId: string;
  ids: Record<string, string>;
}

async function fixture(
  db: PrismaClient,
  label: string,
  spec: Record<string, TaskSpec>,
): Promise<Fixture> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@panorama.invalid`, name: label, passwordHash: 'x' },
  });
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label} runner`,
      tokenHash: `panorama-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label} workspace`, enabled: true },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: label } });

  const ids: Record<string, string> = {};
  for (const name of Object.keys(spec)) ids[name] = randomUUID();
  for (const [name, one] of Object.entries(spec)) {
    await db.task.create({
      data: {
        id: ids[name],
        ownerId,
        projectId,
        title: `${label}-${name}`,
        creatorType: CreatorType.USER,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        creatorId: ownerId,
        assigneeId: workspaceId,
        status: one.status ?? TaskStatus.OPEN,
      },
    });
  }
  for (const [name, one] of Object.entries(spec)) {
    for (const prerequisite of one.dependsOn ?? []) {
      await db.taskDependency.create({
        data: { taskId: ids[name], dependsOnTaskId: ids[prerequisite] },
      });
    }
  }
  return { ownerId, projectId, ids };
}

/**
 * A session on a task — the only place a dispatched run is written down.
 *
 * `Task.status` stays OPEN for the whole run (nothing writes IN_PROGRESS at dispatch), so a
 * fixture built from statuses alone cannot tell whether the buckets know about live work.
 */
async function session(
  db: PrismaClient,
  ownerId: string,
  taskId: string,
  status: RunStatus,
): Promise<void> {
  await db.session.create({
    data: {
      ownerId,
      creatorId: ownerId,
      taskId,
      title: `run of ${taskId}`,
      prompt: 'do the thing',
      status,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
}

/** `count` tasks in one straight line, `first` depending on nothing. */
function chain(count: number, statuses: Record<number, TaskStatus> = {}): Record<string, TaskSpec> {
  const spec: Record<string, TaskSpec> = {};
  for (let n = 1; n <= count; n += 1) {
    spec[`t${n}`] = { status: statuses[n] ?? TaskStatus.OPEN, ...(n > 1 ? { dependsOn: [`t${n - 1}`] } : {}) };
  }
  return spec;
}

test('the project panorama buckets OPEN by readiness and judges the graph shape',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);

    const db = prismaClientFor(URL);
    const prisma = db as unknown as PrismaService;
    const projects = new ProjectsService(prisma);

    try {
      // ---- A: a ten-task chain, three finished, one running -----------------------------------
      //
      //   t1 t2 t3 = DONE   t4 = OPEN (its only prerequisite is DONE)   t5 = IN_PROGRESS
      //   t6 .. t10 = OPEN, each waiting on the one before it
      //
      // so by hand: running 1, ready 1, blocked 5, done 3, cancelled 0.
      const a = await fixture(db, 'chain-a', chain(10, {
        1: TaskStatus.DONE,
        2: TaskStatus.DONE,
        3: TaskStatus.DONE,
        5: TaskStatus.IN_PROGRESS,
      }));

      await t.test('the buckets match the hand count and partition OPEN exactly', async () => {
        const { buckets } = await projects.panorama(a.ownerId, a.projectId);
        assert.deepEqual(buckets, {
          running: 1, ready: 1, blocked: 5, awaitingVerification: 0,
          done: 3, failed: 0, cancelled: 0,
        });

        // Not a restatement of the line above: `ready` and `blocked` are two independent counts,
        // and the failure this catches is one of them double-counting or dropping a task — which
        // leaves both numbers individually plausible and their sum wrong.
        const open = await db.task.count({
          where: { projectId: a.projectId, status: TaskStatus.OPEN },
        });
        assert.equal(buckets.ready + buckets.blocked, open, 'ready + blocked covers OPEN once each');
        const total = await db.task.count({ where: { projectId: a.projectId } });
        assert.equal(
          Object.values(buckets).reduce((sum, value) => sum + value, 0),
          total,
        );
      });

      await t.test('a chain reads as a chain, and its depth is the whole chain', async () => {
        const { shape } = await projects.panorama(a.ownerId, a.projectId);
        assert.equal(shape.taskCount, 10);
        assert.equal(shape.edgeCount, 9);
        assert.equal(shape.ratio, 0.9);
        // Edges, not tasks: ten tasks in a line are nine steps apart, and it is the step count the
        // "step N of M" reading needs.
        assert.equal(shape.maxDepth, 9);
        assert.equal(shape.form, 'chain');
      });

      // ---- B: eight tasks, fourteen edges ------------------------------------------------------
      await t.test('a dense small graph reads as a mesh', async () => {
        const b = await fixture(db, 'mesh-b', {
          t1: {},
          t2: {},
          t3: { dependsOn: ['t1', 't2'] },
          t4: { dependsOn: ['t1', 't2'] },
          t5: { dependsOn: ['t3', 't4'] },
          t6: { dependsOn: ['t3', 't4'] },
          t7: { dependsOn: ['t3', 't5', 't6'] },
          t8: { dependsOn: ['t5', 't6', 't7'] },
        });
        const { shape } = await projects.panorama(b.ownerId, b.projectId);
        assert.equal(shape.taskCount, 8);
        assert.equal(shape.edgeCount, 14);
        assert.equal(shape.ratio, 1.75);
        assert.equal(shape.form, 'mesh', 'ratio over 1.5 under 30 tasks is worth drawing');
        // t1 -> t3 -> t5 -> t7 -> t8 is the longest path, and the diamonds around it must not make
        // the walk count a task twice.
        assert.equal(shape.maxDepth, 4);
      });

      // ---- C: nothing at all -------------------------------------------------------------------
      await t.test('an empty project answers in zeroes with a definite form', async () => {
        const empty = await fixture(db, 'empty-c', {});
        const panorama = await projects.panorama(empty.ownerId, empty.projectId);
        assert.deepEqual(panorama.buckets, {
          running: 0, ready: 0, blocked: 0, awaitingVerification: 0,
          done: 0, failed: 0, cancelled: 0,
        });
        assert.deepEqual(panorama.shape, {
          taskCount: 0,
          edgeCount: 0,
          // 0/0 is not a number and would reach the client as null; the shape of nothing is a chain.
          ratio: 0,
          maxDepth: 0,
          form: 'chain',
        });
      });

      // ---- D: a prerequisite that was called off -----------------------------------------------
      await t.test('a CANCELLED prerequisite is a failed dependency, not executable work',
        async () => {
          const d = await fixture(db, 'cancelled-d', {
            t1: { status: TaskStatus.CANCELLED },
            t2: { dependsOn: ['t1'] },
            t3: { dependsOn: ['t2'] },
          });
          const { buckets } = await projects.panorama(d.ownerId, d.projectId);
          // task_start refuses a cancelled prerequisite until a person resolves/replaces it. The
          // exact execute predicate therefore keeps both OPEN rows out of Ready.
          assert.deepEqual(buckets, {
            running: 0, ready: 0, blocked: 2, awaitingVerification: 0,
            done: 0, failed: 0, cancelled: 1,
          });
        });

      // ---- F: the dispatched work the status column does not carry ------------------------------
      await t.test('a live session moves its task from ready into running', async () => {
        const f = await fixture(db, 'live-f', {
          dispatched: {},
          waiting: {},
          idle: {},
          blocked: { dependsOn: ['idle'] },
          finished: { status: TaskStatus.DONE },
        });
        // Every one of these rows stays OPEN: this is the state the header used to report as
        // "0 running, 3 ready" while three agents were working, and then call stalled.
        await session(db, f.ownerId, f.ids.dispatched, RunStatus.RUNNING);
        await session(db, f.ownerId, f.ids.waiting, RunStatus.PENDING);
        // A settled session says nothing about now; a re-run against finished work must not take
        // it back out of `done`.
        await session(db, f.ownerId, f.ids.idle, RunStatus.SUCCEEDED);
        await session(db, f.ownerId, f.ids.finished, RunStatus.RUNNING);

        const { buckets } = await projects.panorama(f.ownerId, f.projectId);

        assert.deepEqual(buckets, {
          running: 2, ready: 1, blocked: 1, awaitingVerification: 0,
          done: 1, failed: 0, cancelled: 0,
        });
        const total = await db.task.count({ where: { projectId: f.projectId } });
        assert.equal(
          Object.values(buckets).reduce((sum, value) => sum + value, 0),
          total,
          'the buckets still partition the project exactly once',
        );
      });

      await t.test('a live session in another project does not colour this one', async () => {
        const mine = await fixture(db, 'mine-f', { only: {} });
        const theirs = await fixture(db, 'theirs-f', { only: {} });
        await session(db, theirs.ownerId, theirs.ids.only, RunStatus.RUNNING);

        const { buckets } = await projects.panorama(mine.ownerId, mine.projectId);

        assert.deepEqual(buckets, {
          running: 0, ready: 1, blocked: 0, awaitingVerification: 0,
          done: 0, failed: 0, cancelled: 0,
        });
      });

      // ---- The size the deployment actually reaches --------------------------------------------
      await t.test('the recursive walk handles the largest real project (118 tasks)', async () => {
        const long = await fixture(db, 'long-e', chain(118, { 1: TaskStatus.DONE }));
        const { buckets, shape } = await projects.panorama(long.ownerId, long.projectId);
        assert.equal(shape.taskCount, 118);
        assert.equal(shape.edgeCount, 117);
        assert.equal(shape.maxDepth, 117);
        assert.equal(shape.form, 'chain', '117/118 is under the mesh ratio and over the task cap');
        assert.deepEqual(buckets, {
          running: 0, ready: 1, blocked: 116, awaitingVerification: 0,
          done: 1, failed: 0, cancelled: 0,
        });
      });

      // ---- The door, not just the query --------------------------------------------------------
      await t.test('another owner cannot read this project', async () => {
        await assert.rejects(
          () => projects.panorama(randomUUID(), a.projectId),
          (error: unknown) => error instanceof NotFoundException,
        );
      });
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });
