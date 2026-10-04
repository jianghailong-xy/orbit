import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  CreatorType, Prisma, PrismaClient, ProjectStatus, RunnerStatus, RunStatus,
  SessionDispatchOrigin, TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { readProjectListRollups } from './project-list-rollup';
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
  /** The summary the amber count reads. Optional: only the rail's scenarios assert on it. */
  attention?: Record<string, unknown>;
  /** The coordinator's pulse. Optional for the same reason. */
  coordinatorActivity?: { working: boolean; lastTurnAt: Date | null } | null;
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
      // A DONE project needs no evidence to be DONE since migration 0229 removed the check
      // that required one; this fixture is only about how a finished project is BUCKETED.
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
  overrides: Partial<Prisma.TaskUncheckedCreateInput> = {},
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
      assigneeId, status, completionCriterion: 'EVIDENCE_JUDGMENT',
      ...overrides,
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
      //   cross    OPEN       a1 OPEN (free)  a2 OPEN -> b1 (ANOTHER project, OPEN)  a3 IN_PROGRESS
      //                       a4 DONE         a5 CANCELLED  a6 OPEN -> a3 (IN_PROGRESS)
      //   failed   CANCELLED  b1 OPEN (free)  b2 FAILED  b3 OPEN -> b2 (abandoned)  b4 DONE
      //   empty    OPEN       no tasks at all
      const crossId = await makeProject(db, ownerId, 'cross-project prerequisites');
      // Filed CANCELLED so the `?status=` narrowing has something to select, and so the
      // cross-project edge below points INTO a project the unfiltered index still has to look
      // through. It is also the fixture's one cancelled goal, which is what b1's lane below is
      // about: no door starts a task of a cancelled project, so a task that owes nothing is still
      // not Ready. The Ready lane is pinned on the cross project, whose a1 is free the same way.
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
          // explicitly resolved or replaced. b1 owes nothing and is blocked anyway: its project is
          // CANCELLED, and the READY lane offers only what a door would accept.
          assert.deepEqual(listed.get(failedId)!.buckets,
            { running: 0, ready: 0, blocked: 2, awaitingVerification: 0,
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
        // Three: eight before 0220, six after it took the completion-ACK overlay away, four after
        // 0224 took the control-plane obligation overlay, and two after this removal took the
        // failure-coordination overlay. The third is back with `2d76676df`, which made this read
        // answer "what must the owner do" and not only "how many blockers": the OPEN exception
        // items behind them are aggregated per project and kind, alongside the task rollup and
        // the blockers. Three page-wide readers, one `$queryRaw` get each — `projects.service.spec`
        // pins the same three on a stubbed client. The integration bindings that commit added too
        // are read with `projectCodebase.findMany`, which is not a `$queryRaw` get and so is not
        // in this number. The property under test is that the count is page-wide rather than per
        // project, so the number moves when a whole reader does; it is read off a run rather than
        // reasoned out.
        assert.equal(rawQueries, 3,
          'canonical task lanes, blockers and the items behind them stay page-wide');
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
          const cancelled = (await projects.list(ownerId, ProjectStatus.CANCELLED)) as unknown as Listed[];
          assert.deepEqual(cancelled.map((row) => row.id), [failedId]);
          // The narrowed aggregate scopes which projects it GROUPS and nothing else: the row it
          // returns is the same seven numbers the unfiltered index and the project's own page
          // compute for it — b1 blocked because the goal is cancelled, b3 blocked on the FAILED
          // prerequisite it cannot start on, b2 explicit in FAILED, b4 DONE.
          assert.deepEqual(cancelled[0].buckets, {
            running: 0, ready: 0, blocked: 2, awaitingVerification: 0,
            done: 1, failed: 1, cancelled: 0,
          });
          assert.deepEqual(cancelled[0].buckets, (await page.panorama(ownerId, failedId)).buckets);

          const open = (await projects.list(ownerId, ProjectStatus.OPEN)) as unknown as Listed[];
          assert.deepEqual(open.map((row) => row.id).sort(), [crossId, emptyId].sort());
          // Which projects are grouped is all the narrowing scopes, so what it returns for the ones
          // it keeps is what the unfiltered index returns for them — compared lane for lane rather
          // than spelled out again, since agreement is the claim in this title. The lanes the
          // prerequisite edges decide are in that comparison too: they are read from the whole task
          // table, whoever the rows being grouped belong to. A narrowed rollup that scoped the
          // lookup alongside the grouping, or re-derived READY for the projects it kept, parts from
          // the index here.
          assert.deepEqual(
            open.find((row) => row.id === crossId)!.buckets,
            (await byId()).get(crossId)!.buckets,
          );
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

/**
 * The READY lane is narrowed before it walks: only a row whose every prerequisite is DONE or
 * retired is asked the dependency walk. That is sound only while a RETIRED prerequisite is let
 * through to the walk, because its chain can end in a DONE successor that satisfies the edge — so
 * these are the rows a shortcut reading "every prerequisite DONE" would get wrong, beside the ones
 * the guard exists to stop.
 */
test('a prerequisite replaced by finished work leaves its dependent ready, and the page agrees',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);

    const db = prismaClientFor(URL);
    const projects = new ProjectsService(db as unknown as PrismaService);

    /** Retire `id` in favour of `successor`: terminal first, then the link, as SU4 requires. */
    const supersede = async (id: string, successor: string): Promise<void> => {
      await db.task.update({
        where: { id },
        data: { supersededByTaskId: successor, terminalReason: 'SUPERSEDED', supersededAt: new Date() },
      });
    };

    try {
      const ownerId = randomUUID();
      await db.user.create({
        data: { id: ownerId, email: `retired-${ownerId}@rollup.invalid`, name: 'retired', passwordHash: 'x' },
      });

      //   r1 OPEN -> p1 DONE                                  -> ready
      //   r2 OPEN -> p2 CANCELLED, replaced by p2b DONE       -> ready    (retired; chain ends DONE)
      //   r3 OPEN -> p3 CANCELLED, replaced by p3b OPEN       -> blocked  (retired; chain ends OPEN)
      //   r4 OPEN -> p4 OPEN                                  -> blocked  (the row the guard stops)
      //   p3b and p4 have no prerequisites                    -> ready
      const projectId = await makeProject(db, ownerId, 'replaced attempts');
      const p1 = await makeTask(db, ownerId, projectId, 'p1', TaskStatus.DONE);
      const p2 = await makeTask(db, ownerId, projectId, 'p2', TaskStatus.CANCELLED);
      const p2b = await makeTask(db, ownerId, projectId, 'p2b', TaskStatus.DONE);
      const p3 = await makeTask(db, ownerId, projectId, 'p3', TaskStatus.CANCELLED);
      const p3b = await makeTask(db, ownerId, projectId, 'p3b', TaskStatus.OPEN);
      const p4 = await makeTask(db, ownerId, projectId, 'p4', TaskStatus.OPEN);
      await supersede(p2, p2b);
      await supersede(p3, p3b);
      for (const [title, prerequisite] of [['r1', p1], ['r2', p2], ['r3', p3], ['r4', p4]] as const) {
        const dependent = await makeTask(db, ownerId, projectId, title, TaskStatus.OPEN);
        await db.taskDependency.create({ data: { taskId: dependent, dependsOnTaskId: prerequisite } });
      }

      const listed = async (): Promise<Listed> => {
        const rows = (await projects.list(ownerId)) as unknown as Listed[];
        return rows.find((row) => row.id === projectId)!;
      };

      await t.test('a retired prerequisite is judged by where its chain ends', async () => {
        assert.deepEqual((await listed()).buckets, {
          running: 0, ready: 4, blocked: 2, awaitingVerification: 0,
          done: 2, failed: 0, cancelled: 2,
        });
      });

      await t.test('the index and the project page report the same seven numbers', async () => {
        assert.deepEqual((await listed()).buckets, (await projects.panorama(ownerId, projectId)).buckets);
      });
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });

/**
 * What the index costs the database, beside what it counts: however many tasks an owner has, the
 * read writes no temp file.
 *
 * It used to. `WITH classified AS MATERIALIZED (...) ... GROUP BY` held every classified task in a
 * tuplestore, and a tuplestore that outgrows work_mem goes to disk: 4.4 MB per call for the owner
 * of a 110,247-task project, written and never read, each time the sidebar polled. Production runs
 * a 4 MB work_mem; here it is PostgreSQL's floor, 64 kB, so two thousand tasks stand in for a
 * hundred thousand. The paired positive holds the same rows the way the old read did, on the same
 * fixture and setting, and must spill: otherwise the fixture is too small for zero to mean
 * anything.
 */
test('the index writes no temp file, however many tasks it classifies',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);

    const db = prismaClientFor(URL);
    const projects = new ProjectsService(db as unknown as PrismaService);

    interface PlanNode {
      'Node Type': string;
      'Temp Written Blocks'?: number;
      Plans?: PlanNode[];
    }
    /** Every node of `sql`'s executed plan that wrote temp blocks, at a 64 kB work_mem. */
    const spillsOf = async (sql: string, values: unknown[]): Promise<string[]> => {
      await identity.query('BEGIN');
      try {
        await identity.query(`SET LOCAL work_mem = '64kB'`);
        const explained = await identity.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values);
        const spilled: string[] = [];
        const walk = (node: PlanNode): void => {
          const written = node['Temp Written Blocks'] ?? 0;
          if (written > 0) spilled.push(`${node['Node Type']}: ${written} temp blocks written`);
          for (const child of node.Plans ?? []) walk(child);
        };
        walk(explained.rows[0]['QUERY PLAN'][0].Plan);
        return spilled;
      } finally {
        await identity.query('ROLLBACK');
      }
    };

    try {
      const ownerId = randomUUID();
      await db.user.create({
        data: {
          id: ownerId, email: `spill-${ownerId}@rollup.invalid`, name: 'spill', passwordHash: 'x',
        },
      });
      const projectId = await makeProject(db, ownerId, 'two thousand tasks');
      // The first through `makeTask`, which binds the owner a workspace on an online runner; one in
      // fifty of the rest OPEN, so the RUNNING and READY arms and their subplans run at 64 kB too.
      await makeTask(db, ownerId, projectId, 'first', TaskStatus.DONE);
      await db.task.createMany({
        data: Array.from({ length: 2_000 }, (_, i) => ({
          id: randomUUID(), ownerId, projectId, title: `task ${i}`,
          creatorType: CreatorType.USER, creatorId: ownerId,
          assigneeId: workspaceByOwner.get(ownerId)!,
          status: i % 50 === 0 ? TaskStatus.OPEN : TaskStatus.DONE,
          completionCriterion: 'EVIDENCE_JUDGMENT' as const,
        })),
      });

      await t.test('holding every task at once spills on this fixture', async () => {
        const held = await spillsOf(
          `WITH held AS MATERIALIZED (
             SELECT t."project_id", t."updated_at", t."status"::text AS "status"
               FROM "task" t WHERE t."owner_id" = $1::uuid
           )
           SELECT count(*) FROM held`,
          [ownerId],
        );
        assert.notDeepEqual(held, [], 'a tuplestore of these rows outgrows 64 kB');
      });

      await t.test('the statement the index sends writes none', async () => {
        let sent: Prisma.Sql | undefined;
        const capturing = {
          $queryRaw: async (query: Prisma.Sql) => {
            sent = query;
            return [];
          },
        } as unknown as PrismaService;
        await readProjectListRollups(capturing, ownerId);
        assert.ok(sent, 'the index read was captured');
        assert.deepEqual(await spillsOf(sent.text, sent.values), []);
      });

      await t.test('and still counts all of them, as the project page does', async () => {
        const rows = (await projects.list(ownerId)) as unknown as Listed[];
        assert.equal(rows.length, 1);
        assert.equal(rows[0]._count.tasks, 2_001);
        assert.deepEqual(rows[0].buckets, {
          running: 0, ready: 40, blocked: 0, awaitingVerification: 0,
          done: 1_961, failed: 0, cancelled: 0,
        });
        assert.deepEqual(rows[0].buckets, (await projects.panorama(ownerId, projectId)).buckets);
      });
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });

/**
 * `GET /projects/sidebar` — the rail's read — against `GET /projects`, on real PostgreSQL.
 *
 * The rail is polled every 15 seconds by every open tab, so it may not classify every task of
 * every project the way the index does. It reaches `running` from the rows that CAN be RUNNING —
 * IN_PROGRESS, or held by a live work session — and applies the classifier to those. That is a
 * claim about a SUPERSET, and only a real database can check it: a candidate set that leaves one
 * RUNNING row out still returns a number, wrong by one, silently, on the one surface whose job is
 * to say whether work is moving.
 *
 * So every scenario asserts the rail against the index for the same fixture AND against the hand
 * count, because agreement between two reads that share a mistake is not agreement with the work.
 * The gate row here is the mistake they would share: IN_PROGRESS with a live session on it, which
 * the canonical expression still refuses to call work in flight.
 */
test('the rail reaches the index’s running count from the rows that can be running',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);

    const db = prismaClientFor(URL);

    // Counts what the rail's read actually spends. It is polled from every open tab, so the
    // property to hold is the one the index's read holds: a constant number of page-wide readers,
    // not one per project.
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

    const rail = new ProjectsService(counting);
    // The parity side reads through the plain client, so a fault in the proxy cannot make both
    // sides of a comparison wrong in the same direction.
    const index = new ProjectsService(db as unknown as PrismaService);

    interface RailRow {
      id: string;
      status: string;
      buckets: { running: number };
      taskCounts: { done: number; failed: number; total: number };
      lastActivityAt: Date | null;
      attention: Record<string, unknown>;
      coordinatorActivity: { working: boolean; lastTurnAt: Date | null } | null;
    }

    /** A session on a task — the only place a dispatched run is written down. */
    const session = async (
      ownerId: string,
      taskId: string | null,
      status: RunStatus,
      extra: Partial<Prisma.SessionUncheckedCreateInput> = {},
    ): Promise<string> => {
      const id = randomUUID();
      await db.session.create({
        data: {
          id, ownerId, creatorId: ownerId, taskId, title: `run of ${taskId}`, prompt: 'do it',
          status, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
          ...extra,
        },
      });
      return id;
    };

    try {
      const ownerId = randomUUID();
      await db.user.create({
        data: { id: ownerId, email: `rail-${ownerId}@rollup.invalid`, name: 'rail', passwordHash: 'x' },
      });

      //   r1 OPEN + RUNNING session           -> running   (a dispatched run)
      //   r2 OPEN + PENDING session           -> running   (queued: the task is taken)
      //   r3 IN_PROGRESS, no session          -> running   (the row the status alone carries)
      //   r4 OPEN, never dispatched           -> ready     (not in flight)
      //   r5 DONE                             -> done
      //   r6 gate, IN_PROGRESS + live session -> AWAITING_VERIFICATION, NOT running
      //   r7 OPEN + AWAITING_INPUT, wake source -> running (parked, and something will move it)
      //   r8 OPEN + AWAITING_INPUT, nothing pending -> ready (idle in the plain sense)
      const railId = await makeProject(db, ownerId, 'the rail');
      const r1 = await makeTask(db, ownerId, railId, 'r1', TaskStatus.OPEN);
      const r2 = await makeTask(db, ownerId, railId, 'r2', TaskStatus.OPEN);
      const r3 = await makeTask(db, ownerId, railId, 'r3', TaskStatus.IN_PROGRESS);
      const r4 = await makeTask(db, ownerId, railId, 'r4', TaskStatus.OPEN);
      const r5 = await makeTask(db, ownerId, railId, 'r5', TaskStatus.DONE);
      const r7 = await makeTask(db, ownerId, railId, 'r7', TaskStatus.OPEN);
      const r8 = await makeTask(db, ownerId, railId, 'r8', TaskStatus.OPEN);
      // A task that does no work of its own and is settled only by an independent check: it is
      // judged by where its verifier stands, BEFORE its stored status. Left IN_PROGRESS with
      // nothing passing it, it waits on a check rather than being in flight — the one row a
      // candidate set read as "IN_PROGRESS means running" would count and the index would not.
      const r6 = await makeTask(db, ownerId, railId, 'r6', TaskStatus.IN_PROGRESS, {
        completionCriterion: 'VERIFICATION',
        completionPolicy: 'VERIFICATION_PASSED',
        verifiesTaskId: null,
      });
      await session(ownerId, r1, RunStatus.RUNNING);
      await session(ownerId, r2, RunStatus.PENDING);
      await session(ownerId, r6, RunStatus.RUNNING);
      // Parked at AWAITING_INPUT with a runner-hosted job still running: nothing is producing
      // output right now, and the job's exit will wake the session — so the task is being worked
      // on. The same session without a wake source (r8) is idle, and its task is ready to run.
      await session(ownerId, r7, RunStatus.AWAITING_INPUT, { runningBgJobs: ['bgj-rail'] });
      await session(ownerId, r8, RunStatus.AWAITING_INPUT);
      // Every write in the project is pinned to an instant the fixture chose, so `lastActivityAt`
      // is a known number rather than whenever the rows happened to be inserted — and r4 holds the
      // newest of them.
      const wrote = Date.now() - 3_600_000;
      let tick = 0;
      for (const id of [r1, r2, r3, r5, r6, r7, r8]) {
        tick += 1_000;
        await db.task.update({ where: { id }, data: { updatedAt: new Date(wrote + tick) } });
      }
      const newest = new Date(wrote + 60_000);
      await db.task.update({ where: { id: r4 }, data: { updatedAt: newest } });
      // A blocker the owner owns, so `attention` is not the empty shape on both sides: a rail that
      // forgot to send it at all must fail the comparison rather than tie on nothing.
      await db.projectBlocker.create({
        data: {
          id: randomUUID(), projectId: railId, kind: 'MERGE_CONFLICT', owner: 'USER',
          recovery: 'HUMAN', severity: 'WARNING', requiredAction: 'approve the merge',
          nextCheckAt: new Date(), subjectType: 'PROJECT', subjectId: railId,
          dedupeKey: `rail-${railId}`, lifecycleGeneration: 1n, conditionVersion: 'd'.repeat(64),
          firstSeenAt: new Date(), lastSeenAt: new Date(),
        },
      });

      // An open project with no tasks at all: no group in the aggregate, and the rail still lists
      // it — with nothing in flight and no activity, rather than with missing fields.
      const emptyId = await makeProject(db, ownerId, 'nothing filed yet');
      // A coordinator mid-turn with no task of its project running: the dot lights on the
      // conversation, which no task row records.
      const turnAt = new Date(Date.now() - 5_000);
      const coordinatorId = randomUUID();
      await db.session.create({
        data: {
          id: coordinatorId, ownerId, creatorId: ownerId, title: 'the conversation on it',
          prompt: 'coordinate', status: RunStatus.RUNNING,
          dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false, lastTurnAt: turnAt,
        },
      });
      const coordinatedId = await makeProject(db, ownerId, 'coordinated, nothing dispatched');
      await db.project.update({
        where: { id: coordinatedId }, data: { coordinatorSessionId: coordinatorId },
      });
      await makeTask(db, ownerId, coordinatedId, 'q1', TaskStatus.OPEN);
      // A closed project whose task is being run right now: work in flight, off the rail.
      const closedId = await makeProject(db, ownerId, 'closed with a run', ProjectStatus.CANCELLED);
      const c1 = await makeTask(db, ownerId, closedId, 'c1', TaskStatus.OPEN);
      await session(ownerId, c1, RunStatus.RUNNING);

      const railRows = async (): Promise<Map<string, RailRow>> => {
        const rows = (await rail.listSidebar(ownerId)) as unknown as RailRow[];
        return new Map(rows.map((row) => [row.id, row]));
      };
      const indexRows = async (): Promise<Map<string, Listed>> => {
        const rows = (await index.list(ownerId)) as unknown as Listed[];
        return new Map(rows.map((row) => [row.id, row]));
      };

      await t.test('the rail counts the rows the index calls running, and the hand count', async () => {
        const rows = await railRows();
        assert.deepEqual([...rows.keys()].sort(), [railId, emptyId, coordinatedId].sort(),
          'open projects only — the rail is not a second index');
        assert.equal(rows.get(railId)!.buckets.running, 4,
          'a dispatched run, a queued run, an IN_PROGRESS row and a parked one with a wake source');
        assert.equal((await indexRows()).get(railId)!.buckets.running, 4,
          'the index agrees about the four, so the rail is not counting a lane of its own');
        // The two rows a candidate set could get wrong, each in its own direction: the gate row is
        // IN_PROGRESS with a live session and is NOT work in flight, while the parked row is not
        // executing anything and IS. Neither verdict is readable off the status.
        assert.equal(
          await db.task.count({ where: { projectId: railId, status: TaskStatus.IN_PROGRESS } }),
          2, 'two rows are IN_PROGRESS, and only one of them is in flight');
        assert.deepEqual((await indexRows()).get(railId)!.buckets,
          { running: 4, ready: 2, blocked: 0, awaitingVerification: 1,
            done: 1, failed: 0, cancelled: 0 },
          'the gate row waits on its check, and the parked row with nothing pending is ready');
      });

      await t.test('the rail sends only the field it draws, and the same activity instant', async () => {
        const rows = await railRows();
        const row = rows.get(railId)!;
        assert.deepEqual(Object.keys(row.buckets), ['running'],
          'the rail draws one lane, and the read does not compute the other six');
        assert.equal(row.status, 'OPEN');
        assert.deepEqual(row.lastActivityAt, newest,
          'max(updated_at) over the project’s tasks, not the fixture’s build time');
        assert.deepEqual(row.lastActivityAt, (await indexRows()).get(railId)!.lastActivityAt,
          'the same instant the index orders the same project by');

        const empty = rows.get(emptyId)!;
        assert.equal(empty.buckets.running, 0);
        assert.equal(empty.lastActivityAt, null,
          'nothing has happened in it, and its createdAt would be activity nobody performed');
      });

      await t.test('attention and the coordinator pulse are the index’s own answers', async () => {
        const rows = await railRows();
        const listed = await indexRows();
        for (const projectId of [railId, emptyId, coordinatedId]) {
          assert.deepEqual(rows.get(projectId)!.attention, listed.get(projectId)!.attention,
            `the amber count and the page must read one summary for ${projectId}`);
          assert.deepEqual(rows.get(projectId)!.coordinatorActivity,
            listed.get(projectId)!.coordinatorActivity);
        }
        assert.equal((rows.get(railId)!.attention as { userBlockers: number }).userBlockers, 1,
          'and that summary is the computed one, not the empty stand-in');
        assert.equal(rows.get(emptyId)!.coordinatorActivity, null,
          'no coordinator bound is null, not absent');
        // The dot lights on the coordinator’s turn while no task of the project runs.
        assert.deepEqual(rows.get(coordinatedId)!.buckets, { running: 0 });
        assert.deepEqual(rows.get(coordinatedId)!.coordinatorActivity,
          { working: true, lastTurnAt: turnAt });
      });

      await t.test('another owner’s run colours nobody else’s rail', async () => {
        const strangerId = randomUUID();
        await db.user.create({
          data: { id: strangerId, email: `sr-${strangerId}@rollup.invalid`, name: 'sr', passwordHash: 'x' },
        });
        const theirsId = await makeProject(db, strangerId, 'theirs');
        const s1 = await makeTask(db, strangerId, theirsId, 's1', TaskStatus.OPEN);
        await session(strangerId, s1, RunStatus.RUNNING);

        const rows = await railRows();
        assert.equal(rows.has(theirsId), false, 'not the reader’s project');
        assert.equal(rows.get(railId)!.buckets.running, 4,
          'a live session in somebody else’s project does not light this one');
      });

      await t.test('the rail’s read is page-wide, not one query per project', async () => {
        rawQueries = 0;
        assert.equal((await rail.listSidebar(ownerId)).length, 3);
        // Three: the running count and the activity instant, the blockers behind the amber count,
        // and the open items behind them. The project rows themselves are a `findMany`. The
        // property under test is that this number does not grow with the number of projects, which
        // is what the rail’s 15-second cadence needs.
        assert.equal(rawQueries, 3, 'canonical running count, blockers and the items behind them');
      });

      await t.test('taskCounts matches the maintained status tally and excludes CANCELLED', async () => {
        const failed = await makeTask(db, ownerId, railId, 'failed', TaskStatus.FAILED);
        await makeTask(db, ownerId, railId, 'another failure', TaskStatus.FAILED);
        const cancelled = await makeTask(db, ownerId, railId, 'cancelled', TaskStatus.CANCELLED);
        await makeTask(db, ownerId, railId, 'another cancellation', TaskStatus.CANCELLED);
        await makeTask(db, ownerId, railId, 'third cancellation', TaskStatus.CANCELLED);

        const assertTally = async (expected: RailRow['taskCounts']) => {
          const tally = await db.projectTaskStatusCount.findMany({
            where: { projectId: railId }, select: { status: true, count: true },
          });
          assert.deepEqual(tally.filter((row) => row.count > 0).map((row) => row.status).sort(),
            Object.values(TaskStatus).sort(), 'the fixture contains every task status');
          const counts = {
            done: tally.find((row) => row.status === TaskStatus.DONE)?.count ?? 0,
            failed: tally.find((row) => row.status === TaskStatus.FAILED)?.count ?? 0,
            total: tally.filter((row) => row.status !== TaskStatus.CANCELLED)
              .reduce((sum, row) => sum + row.count, 0),
          };
          const rows = await railRows();
          assert.deepEqual(rows.get(railId)!.taskCounts, counts,
            'the wire counts agree with project_task_status_count');
          assert.deepEqual(counts, expected);
          const retired = tally.find((row) => row.status === TaskStatus.CANCELLED)!.count;
          assert.ok(retired > 0, 'CANCELLED tasks make the total exclusion observable');
          assert.equal(counts.total + retired, tally.reduce((sum, row) => sum + row.count, 0));
          assert.deepEqual(rows.get(emptyId)!.taskCounts, { done: 0, failed: 0, total: 0 });
          assert.deepEqual(rows.get(coordinatedId)!.taskCounts, { done: 0, failed: 0, total: 1 },
            'a neighbouring project receives only its own tally');
        };

        await assertTally({ done: 1, failed: 2, total: 10 });
        await db.task.update({ where: { id: failed }, data: { status: TaskStatus.OPEN } });
        await db.task.update({ where: { id: cancelled }, data: { status: TaskStatus.OPEN } });
        await assertTally({ done: 1, failed: 1, total: 11 });
      });
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });
