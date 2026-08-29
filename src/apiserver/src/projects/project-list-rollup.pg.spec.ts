import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  CreatorType, PrismaClient, ProjectStatus, RunnerStatus, RunStatus,
  SessionDispatchOrigin, TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectsService } from './projects.service';
import { prismaClientFor } from '../prisma/prisma-client';

/**
 * `GET /projects` — the buckets and `lastActivityAt` it now carries — on real PostgreSQL.
 *
 * The claim under test is agreement, and it cannot be checked anywhere else. The list computes its
 * buckets with ONE aggregate grouped by project; the project page computes the same seven numbers
 * with a per-project recursive CTE. Two queries, one meaning: a reader who sees `blocked: 3` in the
 * index and `blocked: 2` on the page has been told the project changed while they clicked. So every
 * scenario below asserts the list's buckets against `readProjectPanorama`'s for the same project id
 * rather than against a hand-written literal alone — the literal proves the count, the comparison
 * proves the two surfaces cannot drift apart.
 *
 * It is a PG spec and not a unit test because none of this exists in a pure function: `unmetCount`
 * is a join, the buckets are `FILTER`ed aggregates, and the whole thing is `$queryRaw`, where a
 * renamed column compiles, runs and serves `undefined`.
 *
 * Each scenario builds its own owner and every query is scoped by it, so the specs cannot see each
 * other's fixtures and nothing here truncates a table it did not create.
 *
 *   docker run -d --name pcc-rollup-pg16 -e POSTGRES_PASSWORD=pcc_rollup \
 *     -e POSTGRES_USER=pcc_rollup -e POSTGRES_DB=pcc_rollup \
 *     -p 127.0.0.1:55641:5432 postgres:16
 *   DATABASE_URL=postgresql://pcc_rollup:pcc_rollup@127.0.0.1:55641/pcc_rollup \
 *     npx prisma migrate deploy
 *   COORDINATOR_PG_URL=postgresql://pcc_rollup:pcc_rollup@127.0.0.1:55641/pcc_rollup \
 *     COORDINATOR_PG_EXPECTED_DATABASE=pcc_rollup COORDINATOR_PG_EXPECTED_USER=pcc_rollup \
 *     COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(psql -tAc \
 *       'SELECT system_identifier FROM pg_control_system()') \
 *     node --test build/projects/project-list-rollup.pg.spec.js
 */

const URL = process.env.COORDINATOR_PG_URL;

const ZEROES = {
  running: 0, ready: 0, blocked: 0, awaitingVerification: 0, done: 0, failed: 0, cancelled: 0,
};

interface Listed {
  id: string;
  buckets: typeof ZEROES;
  lastActivityAt: Date | null;
  _count: { tasks: number };
}

async function makeProject(
  db: PrismaClient,
  ownerId: string,
  title: string,
  status: ProjectStatus = ProjectStatus.OPEN,
): Promise<string> {
  const id = randomUUID();
  await db.project.create({
    data: {
      id,
      ownerId,
      title,
      status,
      // `project_done_evidence_chk` (migration 0127): a DONE project is bound to an acceptance run
      // or stamped legacy, with no third shape. This fixture is only about how a finished project
      // is BUCKETED, so it takes the legacy stamp — the same one 0127 wrote onto every project that
      // was already DONE — rather than staging a whole acceptance run to satisfy a constraint that
      // has nothing to do with what is being measured.
      ...(status === ProjectStatus.DONE ? { legacyAcceptedAt: new Date() } : {}),
    },
  });
  return id;
}

async function makeTask(
  db: PrismaClient,
  ownerId: string,
  projectId: string,
  title: string,
  status: TaskStatus,
): Promise<string> {
  let assigneeId = workspaceByOwner.get(ownerId);
  if (!assigneeId) {
    const runnerId = randomUUID();
    assigneeId = randomUUID();
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: `rollup runner ${ownerId}`, tokenHash: `rollup-${runnerId}`,
        status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      },
    });
    await db.workspace.create({
      data: { id: assigneeId, ownerId, runnerId, name: `rollup workspace ${ownerId}`, enabled: true },
    });
    workspaceByOwner.set(ownerId, assigneeId);
  }
  const id = randomUUID();
  await db.task.create({
    data: {
      id, ownerId, projectId, title, creatorType: CreatorType.USER, creatorId: ownerId,
      assigneeId, status,
    },
  });
  return id;
}

const workspaceByOwner = new Map<string, string>();

test('the project index buckets every project in one pass and agrees with the project page',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);

    const db = prismaClientFor(URL);

    // Counts what `list` actually spends. The whole point of the grouped aggregate is that this
    // number does not grow with the number of projects, and only a real client can show that.
    let rawQueries = 0;
    const counting = new Proxy(db, {
      get(target, property, receiver) {
        if (property === '$queryRaw') {
          rawQueries += 1;
          return (target as PrismaClient).$queryRaw.bind(target);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as PrismaService;

    const projects = new ProjectsService(counting);
    // The parity side reads through the plain client, so a fault in the proxy cannot make both
    // sides of the comparison wrong in the same direction.
    const page = new ProjectsService(db as unknown as PrismaService);

    try {
      const ownerId = randomUUID();
      await db.user.create({
        data: { id: ownerId, email: `rollup-${ownerId}@rollup.invalid`, name: 'rollup', passwordHash: 'x' },
      });

      // ---- Three projects, filed oldest first so `createdAt desc` is a known order -------------
      //
      //   cross    OPEN   a1 OPEN (free)  a2 OPEN -> b1 (ANOTHER project, OPEN)  a3 IN_PROGRESS
      //                   a4 DONE         a5 CANCELLED  a6 OPEN -> a3 (IN_PROGRESS)
      //   failed   DONE   b1 OPEN (free)  b2 FAILED  b3 OPEN -> b2 (abandoned)   b4 DONE
      //   empty    OPEN   no tasks at all
      const crossId = await makeProject(db, ownerId, 'cross-project prerequisites');
      // Filed DONE so the `?status=` narrowing has something to select, and so the cross-project
      // edge below points INTO a project the unfiltered index still has to look through.
      const failedId = await makeProject(db, ownerId, 'a run that broke', ProjectStatus.CANCELLED);
      const emptyId = await makeProject(db, ownerId, 'nothing filed yet');

      const b1 = await makeTask(db, ownerId, failedId, 'b1', TaskStatus.OPEN);
      const b2 = await makeTask(db, ownerId, failedId, 'b2', TaskStatus.FAILED);
      const b3 = await makeTask(db, ownerId, failedId, 'b3', TaskStatus.OPEN);
      await makeTask(db, ownerId, failedId, 'b4', TaskStatus.DONE);
      await db.taskDependency.create({ data: { taskId: b3, dependsOnTaskId: b2 } });

      await makeTask(db, ownerId, crossId, 'a1', TaskStatus.OPEN);
      const a2 = await makeTask(db, ownerId, crossId, 'a2', TaskStatus.OPEN);
      const a3 = await makeTask(db, ownerId, crossId, 'a3', TaskStatus.IN_PROGRESS);
      await makeTask(db, ownerId, crossId, 'a4', TaskStatus.DONE);
      await makeTask(db, ownerId, crossId, 'a5', TaskStatus.CANCELLED);
      const a6 = await makeTask(db, ownerId, crossId, 'a6', TaskStatus.OPEN);
      await db.taskDependency.create({ data: { taskId: a2, dependsOnTaskId: b1 } });
      // The other half of "unmet": a prerequisite that is IN_PROGRESS still owes the work, so its
      // dependent is blocked. Without this edge every scenario here would still pass if `unmet`
      // were narrowed to OPEN alone.
      await db.taskDependency.create({ data: { taskId: a6, dependsOnTaskId: a3 } });

      // Another owner's project, with tasks, so a leak would show up as an extra row or a bucket
      // counting somebody else's work.
      const strangerId = randomUUID();
      await db.user.create({
        data: { id: strangerId, email: `stranger-${strangerId}@rollup.invalid`, name: 's', passwordHash: 'x' },
      });
      const strangerProject = await makeProject(db, strangerId, 'not yours');
      await makeTask(db, strangerId, strangerProject, 's1', TaskStatus.IN_PROGRESS);

      const byId = async (): Promise<Map<string, Listed>> => {
        const rows = (await projects.list(ownerId)) as unknown as Listed[];
        return new Map(rows.map((row) => [row.id, row]));
      };

      await t.test('the buckets match the hand count, cross-project prerequisites included',
        async () => {
          const listed = await byId();
          assert.deepEqual([...listed.keys()].sort(), [crossId, failedId, emptyId].sort());

          // a2 waits on b1, which is OPEN and filed under a DIFFERENT project. It is waiting, so
          // it is blocked — a bucket that called it ready would send a reader hunting for a
          // dispatch refusal that does not exist.
          assert.deepEqual(listed.get(crossId)!.buckets,
            { running: 1, ready: 1, blocked: 2, awaitingVerification: 0,
              done: 1, failed: 0, cancelled: 1 });

          // b2 is explicit in FAILED, and task_start refuses b3 until that failed prerequisite is
          // explicitly resolved or replaced.
          assert.deepEqual(listed.get(failedId)!.buckets,
            { running: 0, ready: 1, blocked: 1, awaitingVerification: 0,
              done: 1, failed: 1, cancelled: 0 });
          assert.equal(listed.get(failedId)!._count.tasks, 4, 'FAILED still counts toward the total');
          assert.equal(
            Object.values(listed.get(failedId)!.buckets).reduce((sum, n) => sum + n, 0),
            4,
            'the exhaustive buckets include the FAILED task in the project denominator',
          );
        });

      await t.test('an empty project reports seven zeroes and no activity, not missing fields',
        async () => {
          const empty = (await byId()).get(emptyId)!;
          assert.deepEqual(empty.buckets, ZEROES);
          assert.equal(empty._count.tasks, 0);
          // Null rather than a stand-in: nothing has happened here, and the project's own
          // createdAt substituted in would be activity nobody performed.
          assert.equal(empty.lastActivityAt, null);
          for (const key of Object.keys(ZEROES)) {
            assert.ok(key in empty.buckets, `${key} is present, not absent`);
          }
        });

      await t.test('every bucket equals what the project page computes for the same project',
        async () => {
          const listed = await byId();
          for (const projectId of [crossId, failedId, emptyId]) {
            const { buckets } = await page.panorama(ownerId, projectId);
            // The whole reason this file exists: one grouped aggregate and one recursive CTE have
            // to answer the same question the same way, field for field.
            assert.deepEqual(listed.get(projectId)!.buckets, buckets, `buckets differ for ${projectId}`);
          }
        });

      await t.test('the whole index has a constant page-wide read count, not one per project', async () => {
        rawQueries = 0;
        const rows = await projects.list(ownerId);
        assert.equal(rows.length, 3);
        assert.equal(rawQueries, 7,
          'canonical task lanes, blockers, ratification and control-plane obligations stay page-wide');
      });

      await t.test('lastActivityAt is the latest task write, and Project.updatedAt is not',
        async () => {
          const listed = await byId();
          const newest = await db.task.aggregate({
            where: { projectId: crossId },
            _max: { updatedAt: true },
          });
          assert.deepEqual(listed.get(crossId)!.lastActivityAt, newest._max.updatedAt);

          // The counterexample the comment in `ProjectListRollup` claims: move a task, and the
          // project ROW does not move. Anything reading `Project.updatedAt` would report the day
          // somebody last renamed the project while its work ran all week.
          const before = listed.get(crossId)!;
          const projectRowBefore = await db.project.findUniqueOrThrow({ where: { id: crossId } });
          await db.task.update({
            where: { id: a2 },
            data: { status: TaskStatus.IN_PROGRESS },
          });
          const after = (await byId()).get(crossId)!;
          const projectRowAfter = await db.project.findUniqueOrThrow({ where: { id: crossId } });

          assert.ok(
            after.lastActivityAt! > before.lastActivityAt!,
            'a task changing status is activity',
          );
          assert.deepEqual(projectRowAfter.updatedAt, projectRowBefore.updatedAt,
            'the project row did not move, which is why it cannot be the source');
          // And the buckets followed the same write: a2 left OPEN/blocked for IN_PROGRESS,
          // while a6 stayed blocked on a3, which is still running.
          assert.deepEqual(after.buckets,
            { running: 2, ready: 1, blocked: 1, awaitingVerification: 0,
              done: 1, failed: 0, cancelled: 1 });
        });

      await t.test('?status= narrows the projects and still buckets the ones it returns',
        async () => {
          const done = (await projects.list(ownerId, ProjectStatus.CANCELLED)) as unknown as Listed[];
          assert.deepEqual(done.map((row) => row.id), [failedId]);
          // The narrowed aggregate scopes which projects it groups, never which tasks a
          // prerequisite may be looked up in: b3's FAILED prerequisite is still found.
          assert.deepEqual(done[0].buckets, {
            running: 0, ready: 1, blocked: 1, awaitingVerification: 0,
            done: 1, failed: 1, cancelled: 0,
          });
          assert.deepEqual(done[0].buckets, (await page.panorama(ownerId, failedId)).buckets);

          const open = (await projects.list(ownerId, ProjectStatus.OPEN)) as unknown as Listed[];
          assert.deepEqual(open.map((row) => row.id).sort(), [crossId, emptyId].sort());
        });

      await t.test('another owner’s work is in nobody else’s buckets', async () => {
        const mine = await byId();
        assert.equal(mine.has(strangerProject), false);
        const theirs = (await projects.list(strangerId)) as unknown as Listed[];
        assert.deepEqual(theirs.map((row) => row.id), [strangerProject]);
        assert.deepEqual(theirs[0].buckets, {
          running: 1, ready: 0, blocked: 0, awaitingVerification: 0,
          done: 0, failed: 0, cancelled: 0,
        });
      });
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });

/**
 * The dispatched work `Task.status` does not carry.
 *
 * Every scenario above builds `running` out of `TaskStatus.IN_PROGRESS`, and no Session row exists
 * anywhere in them — which is exactly why they cannot see this. A run opened by the dispatcher
 * leaves its task OPEN for the whole run; nothing writes IN_PROGRESS at dispatch. So on a fixture
 * made of task statuses alone, "running = IN_PROGRESS" and "running = IN_PROGRESS or dispatched"
 * are the same number, and the index can hold the first definition while the project page holds
 * the second without a single test going red.
 *
 * That is not a hypothetical: it is what the deployment reported. Two projects with an agent
 * working in them read `running: 0, ready: 1` on the index and `running: 1, ready: 0` on their own
 * page, which put them in the STALLED section of the list — under a header reading "nothing
 * running" — while the work was in flight.
 *
 * Own owner, own projects: nothing above sees these rows, and the counts here are unaffected by
 * anything above.
 */
test('a dispatched task is running in the index rather than ready, and the page agrees',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);

    const db = prismaClientFor(URL);
    const projects = new ProjectsService(db as unknown as PrismaService);

    /** A session on a task — the only place a dispatched run is written down. */
    const session = async (ownerId: string, taskId: string, status: RunStatus): Promise<void> => {
      await db.session.create({
        data: {
          ownerId, creatorId: ownerId, taskId, title: `run of ${taskId}`, prompt: 'do it', status,
          dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
        },
      });
    };

    try {
      const ownerId = randomUUID();
      await db.user.create({
        data: { id: ownerId, email: `live-${ownerId}@rollup.invalid`, name: 'live', passwordHash: 'x' },
      });

      //   d1 OPEN + RUNNING session    -> running   (the case the old definition missed)
      //   d2 OPEN + PENDING session    -> running   (queued is held too: the task is taken)
      //   d3 OPEN + SUCCEEDED session  -> ready     (a settled run says nothing about now)
      //   d4 OPEN, never dispatched    -> ready
      //   d5 OPEN -> d4                -> blocked   (a prerequisite still owes work)
      //   d6 DONE + RUNNING session    -> done      (only an OPEN task is promoted)
      const liveId = await makeProject(db, ownerId, 'three agents at work');
      const d1 = await makeTask(db, ownerId, liveId, 'd1', TaskStatus.OPEN);
      const d2 = await makeTask(db, ownerId, liveId, 'd2', TaskStatus.OPEN);
      const d3 = await makeTask(db, ownerId, liveId, 'd3', TaskStatus.OPEN);
      const d4 = await makeTask(db, ownerId, liveId, 'd4', TaskStatus.OPEN);
      const d5 = await makeTask(db, ownerId, liveId, 'd5', TaskStatus.OPEN);
      const d6 = await makeTask(db, ownerId, liveId, 'd6', TaskStatus.DONE);
      await db.taskDependency.create({ data: { taskId: d5, dependsOnTaskId: d4 } });
      await session(ownerId, d1, RunStatus.RUNNING);
      await session(ownerId, d2, RunStatus.PENDING);
      await session(ownerId, d3, RunStatus.SUCCEEDED);
      await session(ownerId, d6, RunStatus.RUNNING);

      const listed = async (owner: string): Promise<Map<string, Listed>> => {
        const rows = (await projects.list(owner)) as unknown as Listed[];
        return new Map(rows.map((row) => [row.id, row]));
      };

      await t.test('a live session moves its task out of ready and into running', async () => {
        const row = (await listed(ownerId)).get(liveId)!;
        assert.deepEqual(row.buckets, {
          running: 2, ready: 2, blocked: 1, awaitingVerification: 0,
          done: 1, failed: 0, cancelled: 0,
        });
        // Stated separately from the line above, because it is the claim that matters and the
        // deepEqual would still read plausibly with both numbers wrong by one in opposite
        // directions: NOT ONE of the six tasks is IN_PROGRESS, so under the old definition this
        // project reports `running: 0, ready: 4` and the list calls it stalled.
        assert.equal(
          await db.task.count({ where: { projectId: liveId, status: TaskStatus.IN_PROGRESS } }),
          0,
          'no task row carries IN_PROGRESS — the runs are only in the session table',
        );
        assert.equal(row.buckets.running, 2, 'the two dispatched OPEN tasks are the running ones');
      });

      await t.test('the buckets still partition the project exactly once', async () => {
        const row = (await listed(ownerId)).get(liveId)!;
        const total = await db.task.count({ where: { projectId: liveId } });
        const sum = Object.values(row.buckets).reduce((total, value) => total + value, 0);
        assert.equal(sum, total, 'six tasks, counted once each');
        // The OPEN population is now split THREE ways, not two: a dispatched OPEN task left
        // ready/blocked for running. An invariant that still read `ready + blocked = OPEN` would
        // be asserting the old definition.
        const open = await db.task.count({ where: { projectId: liveId, status: TaskStatus.OPEN } });
        assert.equal(row.buckets.ready + row.buckets.blocked + 2, open,
          'ready + blocked + the dispatched OPEN tasks covers OPEN once each');
      });

      await t.test('the index and the project page report the same seven numbers', async () => {
        const row = (await listed(ownerId)).get(liveId)!;
        const { buckets } = await projects.panorama(ownerId, liveId);
        // The whole point: `readProjectPanorama` has counted live sessions since the definition
        // moved, and this is where the index is caught still holding the older one.
        assert.deepEqual(row.buckets, buckets, 'index vs page over a dispatched project');
      });

      await t.test('another owner’s live session colours their project and not mine', async () => {
        const strangerId = randomUUID();
        await db.user.create({
          data: { id: strangerId, email: `sl-${strangerId}@rollup.invalid`, name: 'sl', passwordHash: 'x' },
        });
        const mineId = await makeProject(db, ownerId, 'nothing dispatched here');
        await makeTask(db, ownerId, mineId, 'm1', TaskStatus.OPEN);
        const theirsId = await makeProject(db, strangerId, 'theirs');
        const s1 = await makeTask(db, strangerId, theirsId, 's1', TaskStatus.OPEN);
        await session(strangerId, s1, RunStatus.RUNNING);

        assert.deepEqual((await listed(ownerId)).get(mineId)!.buckets,
          { running: 0, ready: 1, blocked: 0, awaitingVerification: 0,
            done: 0, failed: 0, cancelled: 0 },
          'a live session in somebody else’s project does not promote my task');
        // And the join is not simply dead: the same session DOES promote the task it points at.
        assert.deepEqual((await listed(strangerId)).get(theirsId)!.buckets,
          { running: 1, ready: 0, blocked: 0, awaitingVerification: 0,
            done: 0, failed: 0, cancelled: 0 });
        assert.deepEqual((await listed(strangerId)).get(theirsId)!.buckets,
          (await projects.panorama(strangerId, theirsId)).buckets);
      });
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });
