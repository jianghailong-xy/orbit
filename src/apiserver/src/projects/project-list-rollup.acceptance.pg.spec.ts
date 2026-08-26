import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CreatorType, PrismaClient, ProjectStatus, RunStatus, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectsService } from './projects.service';
import { prismaClientFor } from '../prisma/prisma-client';

/**
 * INDEPENDENT acceptance of the `GET /projects` bucket rollup: written against the CONTRACT
 * (`readProjectPanorama`'s five numbers), not against the delivered spec's fixtures.
 *
 * Two things the delivered spec does not do, and this one does:
 *   - a CANCELLED prerequisite. The delivered fixture cancels a task nothing depends on, so a
 *     rollup that treated CANCELLED as still-owing would pass it. Here a task's only prerequisite
 *     is CANCELLED, and it must read `ready`.
 *   - randomized parity. 60 random owners, each a random set of projects, task statuses and
 *     dependency edges (in-project, cross-project and cross-OWNER), every project compared
 *     bucket-for-bucket against `readProjectPanorama`. Hand-picked fixtures prove the cases
 *     somebody thought of; this one looks for the case nobody did.
 */

const URL = process.env.COORDINATOR_PG_URL;
const ZEROES = { running: 0, ready: 0, blocked: 0, done: 0, cancelled: 0 };

interface Listed {
  id: string;
  buckets: { running: number; ready: number; blocked: number; done: number; cancelled: number };
  lastActivityAt: Date | null;
  _count: { tasks: number };
}

async function makeUser(db: PrismaClient): Promise<string> {
  const id = randomUUID();
  await db.user.create({
    data: { id, email: `acc-${id}@acc.invalid`, name: 'acc', passwordHash: 'x' },
  });
  return id;
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
  await db.task.create({
    data: { id, ownerId, projectId, title, creatorType: CreatorType.USER, creatorId: ownerId, status },
  });
  return id;
}

/**
 * A dispatched run. `Task.status` is left at OPEN by the dispatcher, so the Session row is the
 * only record in the database that this task is being worked on right now.
 */
async function makeSession(
  db: PrismaClient,
  ownerId: string,
  taskId: string,
  status: RunStatus,
): Promise<void> {
  await db.session.create({
    data: { ownerId, creatorId: ownerId, taskId, title: `run of ${taskId}`, prompt: 'do it', status },
  });
}

/** Seeded so a failing round can be replayed exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('GET /projects buckets, independently', { skip: !URL, timeout: 900_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await identity.connect();
  await verifyCoordinatorPgIdentity(identity);

  const db = prismaClientFor(URL);
  const svc = new ProjectsService(db as unknown as PrismaService);

  try {
    await t.test('the four named boundaries, hand-counted AND equal to the project page', async () => {
      const owner = await makeUser(db);
      const other = await makeUser(db);

      // p_empty : no tasks at all.
      const pEmpty = await makeProject(db, owner, 'empty');

      // p_cross : t1 OPEN waits on a task filed in ANOTHER of my projects (still OPEN)
      //           t2 OPEN waits on a task owned by ANOTHER USER (still OPEN)
      //           t3 OPEN waits on a DONE task -> ready
      const pCross = await makeProject(db, owner, 'cross');
      // p_upstream : holds the prerequisites p_cross waits on.
      const pUp = await makeProject(db, owner, 'upstream');
      const upOpen = await makeTask(db, owner, pUp, 'up-open', TaskStatus.OPEN);
      const upDone = await makeTask(db, owner, pUp, 'up-done', TaskStatus.DONE);
      const pStranger = await makeProject(db, other, 'stranger');
      const strangerOpen = await makeTask(db, other, pStranger, 'stranger-open', TaskStatus.OPEN);

      const t1 = await makeTask(db, owner, pCross, 't1', TaskStatus.OPEN);
      const t2 = await makeTask(db, owner, pCross, 't2', TaskStatus.OPEN);
      const t3 = await makeTask(db, owner, pCross, 't3', TaskStatus.OPEN);
      await db.taskDependency.create({ data: { taskId: t1, dependsOnTaskId: upOpen } });
      await db.taskDependency.create({ data: { taskId: t2, dependsOnTaskId: strangerOpen } });
      await db.taskDependency.create({ data: { taskId: t3, dependsOnTaskId: upDone } });

      // p_cancelled : c1 CANCELLED; c2 OPEN whose ONLY prerequisite is c1 -> ready, not blocked;
      //               c3 OPEN with two prerequisites, one CANCELLED and one OPEN -> blocked.
      const pCancelled = await makeProject(db, owner, 'cancelled-prereq');
      const c1 = await makeTask(db, owner, pCancelled, 'c1', TaskStatus.CANCELLED);
      const c2 = await makeTask(db, owner, pCancelled, 'c2', TaskStatus.OPEN);
      const c3 = await makeTask(db, owner, pCancelled, 'c3', TaskStatus.OPEN);
      const c4 = await makeTask(db, owner, pCancelled, 'c4', TaskStatus.OPEN);
      await db.taskDependency.create({ data: { taskId: c2, dependsOnTaskId: c1 } });
      await db.taskDependency.create({ data: { taskId: c3, dependsOnTaskId: c1 } });
      await db.taskDependency.create({ data: { taskId: c3, dependsOnTaskId: c4 } });

      // p_failed : f1 FAILED (no bucket, still in _count); f2 OPEN on f1 -> ready;
      //            f3 IN_PROGRESS; f4 DONE; f5 CANCELLED.
      const pFailed = await makeProject(db, owner, 'failed');
      const f1 = await makeTask(db, owner, pFailed, 'f1', TaskStatus.FAILED);
      const f2 = await makeTask(db, owner, pFailed, 'f2', TaskStatus.OPEN);
      await makeTask(db, owner, pFailed, 'f3', TaskStatus.IN_PROGRESS);
      await makeTask(db, owner, pFailed, 'f4', TaskStatus.DONE);
      await makeTask(db, owner, pFailed, 'f5', TaskStatus.CANCELLED);
      await db.taskDependency.create({ data: { taskId: f2, dependsOnTaskId: f1 } });

      const rows = (await svc.list(owner)) as unknown as Listed[];
      const byId = new Map(rows.map((r) => [r.id, r]));

      // --- hand counts -------------------------------------------------------------------
      assert.deepEqual(byId.get(pEmpty)!.buckets, ZEROES, 'empty project is five zeroes');
      assert.equal(byId.get(pEmpty)!.lastActivityAt, null);
      assert.equal(byId.get(pEmpty)!._count.tasks, 0);
      for (const key of Object.keys(ZEROES)) {
        assert.ok(key in byId.get(pEmpty)!.buckets, `${key} present on an empty project`);
      }

      assert.deepEqual(
        byId.get(pCross)!.buckets,
        { running: 0, ready: 1, blocked: 2, done: 0, cancelled: 0 },
        'a prerequisite in another project — or another OWNER’s project — still blocks',
      );

      assert.deepEqual(
        byId.get(pCancelled)!.buckets,
        { running: 0, ready: 2, blocked: 1, done: 0, cancelled: 1 },
        'CANCELLED prerequisite frees its dependent; a second OPEN prerequisite still holds it',
      );

      assert.deepEqual(
        byId.get(pFailed)!.buckets,
        { running: 1, ready: 1, blocked: 0, done: 1, cancelled: 1 },
        'FAILED is in no bucket and a FAILED prerequisite frees its dependent',
      );
      assert.equal(byId.get(pFailed)!._count.tasks, 5, 'FAILED still counts toward the total');
      assert.equal(
        Object.values(byId.get(pFailed)!.buckets).reduce((s, n) => s + n, 0),
        4,
        'the one task the buckets omit is exactly the FAILED one',
      );

      // --- and the same five numbers the project page reports ----------------------------
      for (const projectId of [pEmpty, pCross, pUp, pCancelled, pFailed]) {
        const { buckets } = await svc.panorama(owner, projectId);
        assert.deepEqual(byId.get(projectId)!.buckets, buckets, `index vs page for ${projectId}`);
      }
    });

    /**
     * The fifth boundary, and the one the four above cannot reach: a task that is being WORKED ON.
     *
     * The contract this file is written against is `readProjectPanorama`'s, and that contract says
     * `running` is "IN_PROGRESS, or OPEN with a live session on it" while `ready` is "OPEN, no
     * live session, nothing owed" — because dispatch opens a Session and leaves `Task.status` at
     * OPEN for the whole run. Nothing else in this file builds a Session, so every fixture above
     * exercises only the half of that contract the task status carries, and an implementation
     * that had never heard of the other half would pass all of them.
     *
     * `ready` decides whether the index calls a project ready to start, so a dispatched task
     * counted there is not an off-by-one: it is a project with an agent working in it, listed
     * under a header that claims nothing is running.
     */
    await t.test('a live session is what makes a task running, not its status column', async () => {
      const owner = await makeUser(db);
      const other = await makeUser(db);

      // p_live, with every case the contract distinguishes, and NOT ONE task set to IN_PROGRESS:
      //   dispatched OPEN + RUNNING   -> running
      //   queued     OPEN + PENDING   -> running   (a queued run holds the task too)
      //   ended      OPEN + SUCCEEDED -> ready     (a run that finished is not a run in flight)
      //   free       OPEN, no session -> ready
      //   waiting    OPEN -> free     -> blocked   (unmet wins: it was never dispatched)
      //   held       OPEN -> free, + RUNNING       -> running (dispatched beats blocked, as on the page)
      //   closed     DONE + RUNNING   -> done      (only an OPEN task is promoted)
      const pLive = await makeProject(db, owner, 'live');
      const dispatched = await makeTask(db, owner, pLive, 'dispatched', TaskStatus.OPEN);
      const queued = await makeTask(db, owner, pLive, 'queued', TaskStatus.OPEN);
      const ended = await makeTask(db, owner, pLive, 'ended', TaskStatus.OPEN);
      const free = await makeTask(db, owner, pLive, 'free', TaskStatus.OPEN);
      const waiting = await makeTask(db, owner, pLive, 'waiting', TaskStatus.OPEN);
      const held = await makeTask(db, owner, pLive, 'held', TaskStatus.OPEN);
      const closed = await makeTask(db, owner, pLive, 'closed', TaskStatus.DONE);
      await db.taskDependency.create({ data: { taskId: waiting, dependsOnTaskId: free } });
      await db.taskDependency.create({ data: { taskId: held, dependsOnTaskId: free } });
      await makeSession(db, owner, dispatched, RunStatus.RUNNING);
      await makeSession(db, owner, queued, RunStatus.PENDING);
      await makeSession(db, owner, ended, RunStatus.SUCCEEDED);
      await makeSession(db, owner, held, RunStatus.RUNNING);
      await makeSession(db, owner, closed, RunStatus.RUNNING);

      // p_stranger: a live session under ANOTHER owner. The contract scopes `live` by owner, and
      // a subquery that dropped that filter would still pass every assertion above.
      const pStranger = await makeProject(db, other, 'stranger-live');
      const strangerTask = await makeTask(db, other, pStranger, 'x1', TaskStatus.OPEN);
      await makeSession(db, other, strangerTask, RunStatus.RUNNING);

      const byId = new Map(((await svc.list(owner)) as unknown as Listed[]).map((r) => [r.id, r]));

      assert.deepEqual(
        byId.get(pLive)!.buckets,
        { running: 3, ready: 2, blocked: 1, done: 1, cancelled: 0 },
        'a live session promotes its OPEN task out of ready — and out of blocked — into running',
      );
      // Named on its own, because the deepEqual above is exactly what the OLD definition would
      // also produce if these tasks were IN_PROGRESS, and the point is that none of them is.
      assert.equal(
        await db.task.count({ where: { projectId: pLive, status: TaskStatus.IN_PROGRESS } }),
        0,
        'not one task row says IN_PROGRESS: `running: 3` comes entirely from the session table',
      );
      assert.equal(
        Object.values(byId.get(pLive)!.buckets).reduce((s, n) => s + n, 0),
        await db.task.count({ where: { projectId: pLive } }),
        'the seven tasks are still counted once each',
      );
      assert.equal(byId.has(pStranger), false, 'another owner’s project is not in my index');

      // ---- and the page, which is the contract this file is written against --------------------
      for (const pid of [pLive]) {
        const { buckets } = await svc.panorama(owner, pid);
        assert.deepEqual(byId.get(pid)!.buckets, buckets, `index vs page for ${pid}`);
      }
      const theirs = ((await svc.list(other)) as unknown as Listed[]).find((r) => r.id === pStranger)!;
      assert.deepEqual(theirs.buckets, { running: 1, ready: 0, blocked: 0, done: 0, cancelled: 0 },
        'the same session DOES promote the task it actually points at');
      assert.deepEqual(theirs.buckets, (await svc.panorama(other, pStranger)).buckets);
    });

    await t.test('randomized parity against readProjectPanorama, 60 owners', async () => {
      const STATUSES = [
        TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.DONE,
        TaskStatus.CANCELLED, TaskStatus.FAILED,
      ];
      let comparedProjects = 0;
      let edgesMade = 0;
      const foreign: string[] = [];

      for (let round = 0; round < 60; round += 1) {
        const rnd = mulberry32(1000 + round);
        const owner = await makeUser(db);
        const projectCount = 1 + Math.floor(rnd() * 5);
        const projectIds: string[] = [];
        const taskIds: string[] = [];

        for (let p = 0; p < projectCount; p += 1) {
          const status = rnd() < 0.25 ? ProjectStatus.DONE : ProjectStatus.OPEN;
          const pid = await makeProject(db, owner, `r${round}p${p}`, status);
          projectIds.push(pid);
          const taskCount = Math.floor(rnd() * 12);
          for (let i = 0; i < taskCount; i += 1) {
            const st = STATUSES[Math.floor(rnd() * STATUSES.length)];
            taskIds.push(await makeTask(db, owner, pid, `r${round}p${p}t${i}`, st));
          }
        }

        // Edges only from a later-created task to an earlier one, so the graph stays acyclic
        // (the recursive side would otherwise hit its depth cap and stop being a fair
        // comparison). Cross-project edges arise naturally; some point at a FOREIGN owner's
        // task, which is the scope both sides claim to share.
        for (let i = 1; i < taskIds.length; i += 1) {
          const fanIn = Math.floor(rnd() * 3);
          for (let k = 0; k < fanIn; k += 1) {
            const useForeign = foreign.length > 0 && rnd() < 0.12;
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
          const { buckets } = await svc.panorama(owner, row.id);
          assert.deepEqual(
            row.buckets,
            buckets,
            `round ${round} (seed ${1000 + round}), project ${row.id}: index ${JSON.stringify(row.buckets)} vs page ${JSON.stringify(buckets)}`,
          );
          const newest = await db.task.aggregate({
            where: { projectId: row.id },
            _max: { updatedAt: true },
          });
          assert.deepEqual(row.lastActivityAt, newest._max.updatedAt,
            `round ${round}, project ${row.id}: lastActivityAt is max(task.updated_at)`);
          comparedProjects += 1;
        }
      }
      // Not an assertion about the implementation — a guard that the fuzz actually built graphs.
      assert.ok(comparedProjects >= 100, `compared ${comparedProjects} projects`);
      assert.ok(edgesMade >= 100, `built ${edgesMade} edges`);
      console.log(`[fuzz] ${comparedProjects} projects, ${edgesMade} edges compared`);
    });
  } finally {
    await db.$disconnect();
    await identity.end();
  }
});
