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
 * Second independent acceptance pass over the `GET /projects` bucket rollup, written fresh for
 * the convergence-branch audit (this session) — different fixture shapes, different fuzz seeds,
 * and two extra self-consistency invariants the earlier passes did not assert:
 *
 *   - ready + blocked must equal the OPEN count (the two buckets PARTITION the OPEN tasks, so a
 *     rollup that invents its own OPEN population cannot be caught by a parity check that shares
 *     the mistake — this catches it).
 *   - running must equal the IN_PROGRESS count.
 *
 * The parity claim (list buckets == readProjectPanorama buckets, field for field) is asserted on
 * every fixture below exactly as the earlier passes do, because agreement between the two surfaces
 * is the contract under test.
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

async function makeUser(db: PrismaClient): Promise<string> {
  const id = randomUUID();
  await db.user.create({
    data: { id, email: `audit-${id}@audit.invalid`, name: 'audit', passwordHash: 'x' },
  });
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId: id, name: `audit runner ${id}`, tokenHash: `audit-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: id, runnerId, name: `audit workspace ${id}`, enabled: true },
  });
  workspaceByOwner.set(id, workspaceId);
  return id;
}

const workspaceByOwner = new Map<string, string>();

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
  const id = randomUUID();
  const assigneeId = workspaceByOwner.get(ownerId);
  if (!assigneeId) throw new Error(`no fixture workspace for ${ownerId}`);
  await db.task.create({
    data: {
      id, ownerId, projectId, title, creatorType: CreatorType.USER, creatorId: ownerId,
      assigneeId, status,
    },
  });
  return id;
}

/**
 * A session on a task. The dispatcher writes one of these and leaves `Task.status` at OPEN, so
 * this is the only row in the database that says a task is being worked on right now.
 */
async function makeSession(
  db: PrismaClient,
  ownerId: string,
  taskId: string,
  status: RunStatus,
): Promise<void> {
  await db.session.create({
    data: {
      ownerId, creatorId: ownerId, taskId, title: `run of ${taskId}`, prompt: 'do it', status,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
    },
  });
}

/** Seeded so a failing round can be replayed exactly. Seeds here start at 9000 — a range no
 * earlier pass used, so this fuzz is not a rerun of theirs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('GET /projects buckets, second independent pass', { skip: !URL, timeout: 900_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await identity.connect();
  await verifyCoordinatorPgIdentity(identity);

  const db = prismaClientFor(URL);

  // Counts what `list` actually spends in $queryRaw. The parity side reads through the plain
  // client, so a fault in the proxy cannot make both sides wrong in the same direction.
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

  const svc = new ProjectsService(counting);
  const plain = new ProjectsService(db as unknown as PrismaService);

  try {
    await t.test('the four named boundaries, hand-counted, self-consistent AND equal to the page', async () => {
      const owner = await makeUser(db);
      const other = await makeUser(db);

      // ---- cross-project prerequisites -------------------------------------------------------
      // pA's tasks wait on tasks filed in pB (another of MY projects) and in a stranger's project.
      const pA = await makeProject(db, owner, 'cross-dependent');
      const pB = await makeProject(db, owner, 'cross-upstream');
      const bOpen = await makeTask(db, owner, pB, 'b-open', TaskStatus.OPEN);
      const bDone = await makeTask(db, owner, pB, 'b-done', TaskStatus.DONE);
      const bInProg = await makeTask(db, owner, pB, 'b-in-progress', TaskStatus.IN_PROGRESS);
      const pStranger = await makeProject(db, other, 'stranger-upstream');
      const sOpen = await makeTask(db, other, pStranger, 's-open', TaskStatus.OPEN);

      // t1 -> OPEN in another project (blocked); t2 -> DONE in another project (ready);
      // t3 -> IN_PROGRESS in another project (blocked — a running prerequisite still owes work);
      // t4 -> OPEN in another OWNER's project (blocked); t5 free (ready); t6 IN_PROGRESS (running).
      const t1 = await makeTask(db, owner, pA, 't1', TaskStatus.OPEN);
      const t2 = await makeTask(db, owner, pA, 't2', TaskStatus.OPEN);
      const t3 = await makeTask(db, owner, pA, 't3', TaskStatus.OPEN);
      const t4 = await makeTask(db, owner, pA, 't4', TaskStatus.OPEN);
      await makeTask(db, owner, pA, 't5', TaskStatus.OPEN);
      await makeTask(db, owner, pA, 't6', TaskStatus.IN_PROGRESS);
      await db.taskDependency.create({ data: { taskId: t1, dependsOnTaskId: bOpen } });
      await db.taskDependency.create({ data: { taskId: t2, dependsOnTaskId: bDone } });
      await db.taskDependency.create({ data: { taskId: t3, dependsOnTaskId: bInProg } });
      await db.taskDependency.create({ data: { taskId: t4, dependsOnTaskId: sOpen } });

      // ---- CANCELLED and FAILED prerequisites ------------------------------------------------
      const pC = await makeProject(db, owner, 'settled-prereqs');
      const c1 = await makeTask(db, owner, pC, 'c1', TaskStatus.CANCELLED);
      const f1 = await makeTask(db, owner, pC, 'f1', TaskStatus.FAILED);
      const c2 = await makeTask(db, owner, pC, 'c2', TaskStatus.OPEN); // -> c1 only: ready
      const c3 = await makeTask(db, owner, pC, 'c3', TaskStatus.OPEN); // -> c1 + open: blocked
      const c4 = await makeTask(db, owner, pC, 'c4', TaskStatus.OPEN); // free
      const c5 = await makeTask(db, owner, pC, 'c5', TaskStatus.OPEN); // -> f1 only: ready
      await db.taskDependency.create({ data: { taskId: c2, dependsOnTaskId: c1 } });
      await db.taskDependency.create({ data: { taskId: c3, dependsOnTaskId: c1 } });
      await db.taskDependency.create({ data: { taskId: c3, dependsOnTaskId: c4 } });
      await db.taskDependency.create({ data: { taskId: c5, dependsOnTaskId: f1 } });

      // ---- empty project ----------------------------------------------------------------------
      const pE = await makeProject(db, owner, 'empty');

      const rows = (await svc.list(owner)) as unknown as Listed[];
      const byId = new Map(rows.map((r) => [r.id, r]));
      assert.equal(rows.length, 4, 'exactly the four projects are listed');

      // pA: t1 blocked, t2 ready, t3 blocked, t4 blocked, t5 ready, t6 running.
      assert.deepEqual(byId.get(pA)!.buckets, {
        running: 1, ready: 2, blocked: 3, awaitingVerification: 0,
        done: 0, failed: 0, cancelled: 0,
      },
        'cross-project and cross-owner prerequisites block; DONE ones do not');
      // pB: b-open ready, b-done done, b-in-progress running.
      assert.deepEqual(byId.get(pB)!.buckets, {
        running: 1, ready: 1, blocked: 0, awaitingVerification: 0,
        done: 1, failed: 0, cancelled: 0,
      });
      // pC: c1 cancelled; f1 failed; c2 ready; c3 blocked; c4 ready; c5 ready.
      assert.deepEqual(byId.get(pC)!.buckets, {
        running: 0, ready: 1, blocked: 3, awaitingVerification: 0,
        done: 0, failed: 1, cancelled: 1,
      },
        'CANCELLED and FAILED prerequisites keep dependents outside executable Ready');
      assert.equal(byId.get(pC)!._count.tasks, 6, 'FAILED still counts toward the total');
      assert.equal(Object.values(byId.get(pC)!.buckets).reduce((s, n) => s + n, 0), 6,
        'the exhaustive buckets include the FAILED task');
      // pE: empty.
      assert.deepEqual(byId.get(pE)!.buckets, ZEROES, 'empty project is seven zeroes');
      assert.equal(byId.get(pE)!.lastActivityAt, null);
      assert.equal(byId.get(pE)!._count.tasks, 0);
      for (const key of Object.keys(ZEROES)) {
        assert.ok(key in byId.get(pE)!.buckets, `${key} present on an empty project`);
      }

      // ---- self-consistency: the two OPEN-partition buckets must cover OPEN exactly -----------
      for (const pid of [pA, pB, pC, pE]) {
        const row = byId.get(pid)!;
        const openCount = await db.task.count({ where: { projectId: pid, status: TaskStatus.OPEN } });
        const inProgressCount = await db.task.count({ where: { projectId: pid, status: TaskStatus.IN_PROGRESS } });
        assert.equal(row.buckets.ready + row.buckets.blocked, openCount,
          `${pid}: ready + blocked must partition the OPEN tasks`);
        assert.equal(row.buckets.running, inProgressCount, `${pid}: running must equal the IN_PROGRESS tasks`);
      }

      // ---- and the same seven numbers the project page reports ---------------------------------
      for (const pid of [pA, pB, pC, pE]) {
        const { buckets } = await plain.panorama(owner, pid);
        assert.deepEqual(byId.get(pid)!.buckets, buckets, `index vs page for ${pid}`);
      }
    });

    await t.test('randomized parity against readProjectPanorama, seeds 9000+', async () => {
      const STATUSES = [
        TaskStatus.OPEN, TaskStatus.OPEN, TaskStatus.OPEN,
        TaskStatus.IN_PROGRESS, TaskStatus.DONE,
        TaskStatus.CANCELLED, TaskStatus.FAILED,
      ];
      let comparedProjects = 0;
      let edgesMade = 0;
      const foreign: string[] = [];

      for (let round = 0; round < 60; round += 1) {
        const rnd = mulberry32(9000 + round);
        const owner = await makeUser(db);
        const projectCount = 1 + Math.floor(rnd() * 4);
        const projectIds: string[] = [];
        const taskIds: string[] = [];

        for (let p = 0; p < projectCount; p += 1) {
          const status = rnd() < 0.2 ? ProjectStatus.CANCELLED : ProjectStatus.OPEN;
          const pid = await makeProject(db, owner, `a${round}p${p}`, status);
          projectIds.push(pid);
          const taskCount = Math.floor(rnd() * 14);
          for (let i = 0; i < taskCount; i += 1) {
            const st = STATUSES[Math.floor(rnd() * STATUSES.length)];
            taskIds.push(await makeTask(db, owner, pid, `a${round}p${p}t${i}`, st));
          }
        }

        // Edges only from a later-created task to an earlier one, so the graph stays acyclic.
        // Cross-project edges arise naturally; some point at a FOREIGN owner's task.
        for (let i = 1; i < taskIds.length; i += 1) {
          const fanIn = Math.floor(rnd() * 3);
          for (let k = 0; k < fanIn; k += 1) {
            const useForeign = foreign.length > 0 && rnd() < 0.15;
            const target = useForeign
              ? foreign[Math.floor(rnd() * foreign.length)]
              : taskIds[Math.floor(rnd() * i)];
            if (target === taskIds[i]) continue;
            try {
              await db.taskDependency.create({ data: { taskId: taskIds[i], dependsOnTaskId: target } });
              edgesMade += 1;
            } catch {
              /* duplicate edge from the unique index — the graph just did not grow */
            }
          }
        }
        if (taskIds.length > 0) foreign.push(taskIds[0]);

        const rows = (await svc.list(owner)) as unknown as Listed[];
        assert.equal(rows.length, projectCount, `round ${round}: every project listed`);
        for (const row of rows) {
          const { buckets } = await plain.panorama(owner, row.id);
          assert.deepEqual(
            row.buckets,
            buckets,
            `round ${round} (seed ${9000 + round}), project ${row.id}: index ${JSON.stringify(row.buckets)} vs page ${JSON.stringify(buckets)}`,
          );
          const openCount = await db.task.count({ where: { projectId: row.id, status: TaskStatus.OPEN } });
          assert.equal(row.buckets.ready + row.buckets.blocked, openCount,
            `round ${round}: ready + blocked must partition OPEN for ${row.id}`);
          const newest = await db.task.aggregate({
            where: { projectId: row.id },
            _max: { updatedAt: true },
          });
          assert.deepEqual(row.lastActivityAt, newest._max.updatedAt,
            `round ${round}, project ${row.id}: lastActivityAt is max(task.updated_at)`);
          comparedProjects += 1;
        }
      }
      assert.ok(comparedProjects >= 100, `compared ${comparedProjects} projects`);
      assert.ok(edgesMade >= 100, `built ${edgesMade} edges`);
      console.log(`[audit-fuzz] ${comparedProjects} projects, ${edgesMade} edges compared`);
    });

    /**
     * The blind spot in both invariants above.
     *
     * `running must equal the IN_PROGRESS count` and `ready + blocked must partition the OPEN
     * tasks` are the two self-consistency checks this pass was written to add — and both are
     * statements of the OLD bucket definition. They hold on every fixture above only because no
     * fixture above contains a Session row, which makes "IN_PROGRESS" and "IN_PROGRESS or
     * dispatched" the same set. A dispatched run does not touch `Task.status` at all, so the
     * moment one exists both invariants are false as written, and the corrected forms are the two
     * asserted below.
     */
    await t.test('a dispatched OPEN task counts as running, and the invariants shift with it', async () => {
      const owner = await makeUser(db);
      const other = await makeUser(db);

      // pLive: two dispatched (one RUNNING, one PENDING), one settled run, one free, one blocked,
      // one finished task with a live re-run against it.
      const pLive = await makeProject(db, owner, 'dispatched');
      const running = await makeTask(db, owner, pLive, 'running', TaskStatus.OPEN);
      const queued = await makeTask(db, owner, pLive, 'queued', TaskStatus.OPEN);
      const settled = await makeTask(db, owner, pLive, 'settled', TaskStatus.OPEN);
      const free = await makeTask(db, owner, pLive, 'free', TaskStatus.OPEN);
      const waiting = await makeTask(db, owner, pLive, 'waiting', TaskStatus.OPEN);
      const finished = await makeTask(db, owner, pLive, 'finished', TaskStatus.DONE);
      await db.taskDependency.create({ data: { taskId: waiting, dependsOnTaskId: free } });
      await makeSession(db, owner, running, RunStatus.RUNNING);
      await makeSession(db, owner, queued, RunStatus.PENDING);
      // A run that ENDED says nothing about now; a live re-run against work already DONE must not
      // take it back out of `done`, which is what the progress reading counts with.
      await makeSession(db, owner, settled, RunStatus.SUCCEEDED);
      await makeSession(db, owner, finished, RunStatus.RUNNING);

      // pQuiet: same owner, no sessions at all — the control that keeps the promotion attributable
      // to the session rather than to anything the owner has.
      const pQuiet = await makeProject(db, owner, 'quiet');
      await makeTask(db, owner, pQuiet, 'q1', TaskStatus.OPEN);
      await makeTask(db, owner, pQuiet, 'q2', TaskStatus.IN_PROGRESS);

      // A stranger's live session, so a `live` subquery that forgot its owner filter shows up.
      const pStranger = await makeProject(db, other, 'not mine');
      const strangerTask = await makeTask(db, other, pStranger, 'x1', TaskStatus.OPEN);
      await makeSession(db, other, strangerTask, RunStatus.RUNNING);

      const byId = new Map(((await svc.list(owner)) as unknown as Listed[]).map((r) => [r.id, r]));

      assert.deepEqual(byId.get(pLive)!.buckets, {
        running: 2, ready: 2, blocked: 1, awaitingVerification: 0,
        done: 1, failed: 0, cancelled: 0,
      },
        'a RUNNING and a PENDING session each hold their OPEN task; a SUCCEEDED one does not');
      assert.deepEqual(byId.get(pQuiet)!.buckets, {
        running: 1, ready: 1, blocked: 0, awaitingVerification: 0,
        done: 0, failed: 0, cancelled: 0,
      },
        'a project with no sessions is bucketed exactly as before');

      // ---- the two invariants, in their corrected form ---------------------------------------
      for (const pid of [pLive, pQuiet]) {
        const row = byId.get(pid)!;
        const open = await db.task.count({ where: { projectId: pid, status: TaskStatus.OPEN } });
        const inProgress = await db.task.count({ where: { projectId: pid, status: TaskStatus.IN_PROGRESS } });
        const dispatched = await db.task.count({
          where: {
            projectId: pid,
            status: TaskStatus.OPEN,
            sessions: { some: { ownerId: owner, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } } },
          },
        });
        assert.equal(row.buckets.running, inProgress + dispatched,
          `${pid}: running is the IN_PROGRESS tasks PLUS the dispatched OPEN ones`);
        assert.equal(row.buckets.ready + row.buckets.blocked + dispatched, open,
          `${pid}: ready + blocked + dispatched partitions the OPEN tasks`);
        assert.equal(
          Object.values(row.buckets).reduce((s, n) => s + n, 0),
          await db.task.count({ where: { projectId: pid } }),
          `${pid}: every task is in exactly one bucket`,
        );
      }

      // ---- and the page still reports the same seven numbers ----------------------------------
      for (const pid of [pLive, pQuiet]) {
        const { buckets } = await plain.panorama(owner, pid);
        assert.deepEqual(byId.get(pid)!.buckets, buckets, `index vs page for ${pid}`);
      }
      assert.equal(byId.has(pStranger), false, 'the stranger’s project is not in my index');
    });

    await t.test('the whole index uses a bounded page-wide query set, not one per project', async () => {
      const owner = await makeUser(db);
      const p1 = await makeProject(db, owner, 'q1');
      const p2 = await makeProject(db, owner, 'q2');
      await makeTask(db, owner, p1, 'q1t', TaskStatus.OPEN);
      await makeTask(db, owner, p2, 'q2t', TaskStatus.IN_PROGRESS);
      rawQueries = 0;
      const rows = await svc.list(owner);
      assert.equal(rows.length, 2);
      // Four since 0224 removed the control-plane obligation overlay — two of the six, because
      // this proxy counts every GET of `$queryRaw` and that reader probed for the delegate before
      // spending one — after 0220 removed the completion-ACK overlay's two page-wide reads.
      assert.equal(rawQueries, 4,
        'one bounded set of page-wide canonical aggregates, including failure coordination');
    });
  } finally {
    await db.$disconnect();
    await identity.end();
  }
});
