import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CreatorType, PrismaClient, RunStatus, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectsService } from './projects.service';

/**
 * `GET /projects/:id/dependency-graph` against a real, fully migrated PostgreSQL.
 *
 * The endpoint answers in `marks` — a mark being one task, a folded run of them, or one stage of
 * a repeated motif — and the fold's own rules are asserted without a database in
 * `project-graph-fold.spec.ts`. Every fixture here is far below the fold threshold, so each mark
 * is one task and these cases read as they always did.
 *
 * What is under test is not "does it return rows" but the three properties that made it a new
 * endpoint instead of a reuse of `GET /tasks/:id/dependency-graph` pointed at the project's first
 * task. Each has a case below named after it:
 *
 *   1. every task in the project is a node — including one no edge touches, which a walk out of
 *      one focus can never reach;
 *   2. the graph stops at the project boundary, which that walk (scoped by owner alone) does not;
 *   3. edges come back prerequisite → dependent, the direction the arrows are drawn in and the
 *      opposite of how `task_dependency`'s own column names read.
 *
 * A unit test over the service could assert the mapping, but not (1) or (2): both are properties
 * of what the QUERY selects, and both were already true of the code this replaced when it was
 * written against a mocked client.
 *
 * The server is disposable and proved so before the first write (`coordinator-pg-test-safety.ts`).
 */

const URL = process.env.COORDINATOR_PG_URL;

interface Fixture {
  ownerId: string;
  projectId: string;
  ids: Record<string, string>;
}

interface TaskSpec {
  status?: TaskStatus;
  parent?: string;
  /** Names of the tasks this one waits on. */
  after?: string[];
}

/** One owner, one project, and the tasks and edges named in `spec`, created in declaration order. */
async function project(
  db: PrismaClient,
  label: string,
  spec: Record<string, TaskSpec>,
  reuse?: { ownerId: string },
): Promise<Fixture> {
  const ownerId = reuse?.ownerId ?? randomUUID();
  const projectId = randomUUID();
  if (!reuse) {
    await db.user.create({
      data: { id: ownerId, email: `${label}-${ownerId}@pdg.invalid`, name: label, passwordHash: 'x' },
    });
  }
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
        creatorId: ownerId,
        status: one.status ?? TaskStatus.OPEN,
        parentTaskId: one.parent ? ids[one.parent] : null,
      },
    });
  }
  for (const [name, one] of Object.entries(spec)) {
    for (const prerequisite of one.after ?? []) {
      await db.taskDependency.create({
        data: { taskId: ids[name], dependsOnTaskId: ids[prerequisite] },
      });
    }
  }
  return { ownerId, projectId, ids };
}

/**
 * A session on a task, which is the only place a dispatched run is written down.
 *
 * `Task.status` stays OPEN through a whole run — nothing writes IN_PROGRESS at dispatch — so a
 * fixture that only sets statuses cannot tell whether the graph knows about live work at all.
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
    },
  });
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "session", "task_dependency", "task", "project", "user" RESTART IDENTITY CASCADE
  `);
}

test('the project dependency graph on PostgreSQL', { skip: !URL, timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await identity.connect();
  await emptyWorld(identity);

  const db = prismaClientFor(URL);
  // `dependencyGraph` reads nothing but Prisma, and nothing it calls reaches a session. Handing it
  // a real SessionsService would need half the module graph to answer a question about tasks.
  const service = new ProjectsService(db as unknown as PrismaService);

  try {
    await t.test('carries every task in the project, including one no edge touches', async () => {
      const fixture = await project(db, 'whole', {
        head: {},
        middle: { after: ['head'] },
        tail: { after: ['middle'] },
        // The case a walk out of a focus task structurally cannot reach: nothing points at it and
        // it points at nothing, so it is in NO connected component but its own.
        loner: {},
      });

      const graph = await service.dependencyGraph(fixture.ownerId, fixture.projectId);

      assert.deepEqual(
        graph.marks.map((mark) => mark.id).sort(),
        Object.values(fixture.ids).sort(),
      );
      assert.equal(graph.truncated, false);
      assert.equal(graph.folded, false, 'four tasks are drawn as four tasks');
      assert.equal(graph.taskCount, 4);
      assert.equal(graph.edges.length, 2);
    });

    await t.test('points edges prerequisite → dependent, not the way the columns read', async () => {
      const fixture = await project(db, 'direction', { first: {}, second: { after: ['first'] } });

      const graph = await service.dependencyGraph(fixture.ownerId, fixture.projectId);

      assert.deepEqual(graph.edges, [
        { sourceMarkId: fixture.ids.first, targetMarkId: fixture.ids.second },
      ]);
    });

    await t.test('stops at the project boundary in both directions', async () => {
      const here = await project(db, 'here', { mine: {} });
      const there = await project(db, 'there', { theirs: {} }, { ownerId: here.ownerId });
      // A real cross-project edge, in the owner's own account — exactly what the owner-scoped walk
      // out of a focus task would follow onto this page.
      await db.taskDependency.create({
        data: { taskId: here.ids.mine, dependsOnTaskId: there.ids.theirs },
      });

      const graph = await service.dependencyGraph(here.ownerId, here.projectId);

      assert.deepEqual(graph.marks.map((mark) => mark.id), [here.ids.mine]);
      assert.deepEqual(graph.edges, [], 'an edge with one end outside the project is not drawn');
    });

    await t.test('carries parentTaskId, which is what the tree is folded into boxes by', async () => {
      const fixture = await project(db, 'tree', {
        parent: {},
        child: { parent: 'parent' },
        orphan: {},
      });

      const graph = await service.dependencyGraph(fixture.ownerId, fixture.projectId);
      const byId = new Map(graph.marks.map((mark) => [mark.id, mark]));

      assert.equal(byId.get(fixture.ids.child)?.parentTaskId, fixture.ids.parent);
      assert.equal(byId.get(fixture.ids.parent)?.parentTaskId, null);
      assert.equal(byId.get(fixture.ids.orphan)?.parentTaskId, null);
      // Membership is a field on a node and never a row in `edges`: the client draws a box from
      // this, and an edge here would be a line meaning "is part of".
      assert.deepEqual(graph.edges, []);
    });

    await t.test('reports the run on a task, which the status column does not', async () => {
      const fixture = await project(db, 'live', { dispatched: {}, waiting: {}, done: {}, idle: {} });
      // The same owner's next project, also running: a flag that leaked across this boundary would
      // put a spinner on a task nobody dispatched.
      const neighbour = await project(db, 'neighbour', { theirs: {} }, { ownerId: fixture.ownerId });
      await session(db, fixture.ownerId, fixture.ids.dispatched, RunStatus.RUNNING);
      await session(db, fixture.ownerId, fixture.ids.waiting, RunStatus.PENDING);
      await session(db, fixture.ownerId, neighbour.ids.theirs, RunStatus.RUNNING);
      // A finished session says nothing about now. (A task cannot carry a live PENDING and a live
      // RUNNING at once — `session_task_execution_claim_idx` refuses the second — so the pair the
      // flags disambiguate is unreachable here by construction.)
      await session(db, fixture.ownerId, fixture.ids.done, RunStatus.SUCCEEDED);

      const graph = await service.dependencyGraph(fixture.ownerId, fixture.projectId);
      const byId = new Map(graph.marks.map((mark) => [mark.id, mark]));
      const state = (name: string) => {
        const mark = byId.get(fixture.ids[name]);
        assert.ok(mark && mark.kind === 'TASK');
        // Every one of these rows is OPEN: that is the whole reason the flags have to exist.
        assert.equal(mark.status, TaskStatus.OPEN, `${name} was never written IN_PROGRESS`);
        return { running: mark.running, queued: mark.queued };
      };

      assert.deepEqual(state('dispatched'), { running: true, queued: false });
      assert.deepEqual(state('waiting'), { running: false, queued: true });
      assert.deepEqual(state('done'), { running: false, queued: false });
      assert.deepEqual(state('idle'), { running: false, queued: false });
    });

    await t.test('answers an empty project with an empty graph rather than an error', async () => {
      const fixture = await project(db, 'empty', {});

      const graph = await service.dependencyGraph(fixture.ownerId, fixture.projectId);

      assert.deepEqual(graph.marks, []);
      assert.deepEqual(graph.edges, []);
      assert.equal(graph.taskCount, 0);
      assert.equal(graph.truncated, false);
    });

    await t.test('is a 404 for another account, not a smaller graph', async () => {
      const fixture = await project(db, 'guarded', { only: {} });
      const stranger = await project(db, 'stranger', {});

      await assert.rejects(
        () => service.dependencyGraph(stranger.ownerId, fixture.projectId),
        /not found/i,
      );
    });
  } finally {
    await db.$disconnect();
    await identity.end();
  }
});
