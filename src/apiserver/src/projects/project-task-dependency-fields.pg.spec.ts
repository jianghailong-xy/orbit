import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionContext } from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { firstValueFrom, of } from 'rxjs';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  connectIsolatedPg,
  emptyWorld,
  publicId,
  rawUuidPaths,
  task,
  world,
} from './project-e2e-harness';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * The four dependency facts `GET /projects/:id/tasks/page` derives, against a real PostgreSQL.
 *
 * Every one of them is computed by SQL — a recursive CTE for the level, filtered aggregates for
 * the tallies — so a unit test with a stubbed client can only show that the service asks for them
 * and hands them on. Whether the level is a LONGEST path, whether a cancelled prerequisite is
 * excluded from `unmetCount` and still escalates the state, and whether the graph pass sees tasks
 * that are not on the page are all properties of the query, and this is where they are checked.
 *
 * Destructive, and gated on the same isolation proof as its sibling suites: the server must
 * declare itself disposable before the fixture writes anything.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** What a page row says about the graph, with the row's identity for a legible failure. */
function graphOf(item: unknown) {
  const { title, unmetCount, blocksCount, topoLevel, dependencyState } = item as Record<
    string,
    unknown
  >;
  return { title, unmetCount, blocksCount, topoLevel, dependencyState };
}

/** The payload as a client receives it: through the interceptor that rewrites ids to Base62. */
function served(payload: unknown): Promise<unknown> {
  const context = {
    getClass: () => ProjectsController,
    getHandler: () => ProjectsController.prototype.taskPage,
  } as unknown as ExecutionContext;
  return firstValueFrom(new PublicIdInterceptor().intercept(context, { handle: () => of(payload) }));
}

test('project task page: the derived dependency fields', { skip, timeout: 300_000 }, async (t) => {
  const identity = await connectIsolatedPg(URL);
  await emptyWorld(identity);
  const db = prismaClientFor(URL!);
  // `taskPage` reads and nothing else, so the service is built directly rather than through the
  // whole control-loop rig: the doors this suite opens are one method and one interceptor.
  const projects = new ProjectsService(db as unknown as PrismaService, {} as never, {} as never);

  /*
   * A chain, a four-prerequisite convergence node, and an island — the three shapes the level
   * calculation can get wrong, in one project:
   *
   *   head ──▶ mid ──▶ tail ──┐
   *     │       │             ├──▶ merge          iso   (no edges at all)
   *     └───────┴─────────────┘        ▲
   *                          dead ─────┘   (CANCELLED, and a SUBTASK of head)
   *
   * `dead` is deliberately not at the root level: the graph pass has to see the whole project,
   * not the page, or `merge` would look like it has three prerequisites and `head` like it blocks
   * one fewer task than it does.
   */
  const w = await world(db, 'pcc-deps');
  const iso = await task(db, w, 'iso');
  const head = await task(db, w, 'head');
  const mid = await task(db, w, 'mid', { dependsOn: [head] });
  const tail = await task(db, w, 'tail', { dependsOn: [mid] });
  const dead = await task(db, w, 'dead', {
    status: TaskStatus.CANCELLED,
    parentTaskId: head,
  });
  const merge = await task(db, w, 'merge', { dependsOn: [head, mid, tail, dead] });

  const rootPage = await projects.taskPage(w.ownerId, w.projectId);
  const byId = new Map(rootPage.items.map((item) => [(item as { id: string }).id, item]));

  await t.test('a task nothing waits on is READY at level 0, whether or not it has an island', () => {
    // The island and the chain head are the same answer for two different reasons: one has no
    // edges at all, the other has only outgoing ones. Neither is waiting, so neither is BLOCKED —
    // and `NONE` is not a word this payload uses.
    assert.deepEqual(graphOf(byId.get(iso)), {
      title: 'iso',
      unmetCount: 0,
      blocksCount: 0,
      topoLevel: 0,
      dependencyState: 'READY',
    });
    assert.deepEqual(graphOf(byId.get(head)), {
      title: 'head',
      unmetCount: 0,
      // AC3: mid and merge both name it, and nothing else does.
      blocksCount: 2,
      topoLevel: 0,
      dependencyState: 'READY',
    });
  });

  await t.test('the level is the LONGEST prerequisite path, not the shortest', () => {
    assert.equal((byId.get(mid) as { topoLevel: number }).topoLevel, 1);
    assert.equal((byId.get(tail) as { topoLevel: number }).topoLevel, 2);
    // `merge` is reachable from `head` in one hop and in three. It belongs below everything it
    // waits on, so it sits at 3 — a shortest-path or a first-touch level would say 1 and draw the
    // convergence node above two of its own prerequisites.
    assert.equal((byId.get(merge) as { topoLevel: number }).topoLevel, 3);
  });

  await t.test('a cancelled prerequisite is not unmet, and still escalates the state', () => {
    // AC2 and AC4 on the same row, which is the point: `unmetCount` answers "how many are still
    // coming" and CANCELLED is not one of them, while `dependencyState` answers "can this ever
    // run" and CANCELLED is exactly why it cannot. A single count cannot say both.
    assert.deepEqual(graphOf(byId.get(merge)), {
      title: 'merge',
      unmetCount: 3,
      blocksCount: 0,
      topoLevel: 3,
      dependencyState: 'BLOCKED_FAILED',
    });
    // A task waiting on live work is BLOCKED, and its own status has nothing to do with it.
    assert.equal((byId.get(mid) as { dependencyState: string }).dependencyState, 'BLOCKED');
    assert.equal((byId.get(mid) as { unmetCount: number }).unmetCount, 1);
  });

  await t.test('the graph pass covers the project, not the page', async () => {
    // `dead` is a subtask, so it never appears on the root page — yet it is counted as one of
    // `merge`'s prerequisites above, and its own row knows what it blocks.
    assert.equal(byId.has(dead), false, 'a subtask is not part of the root level');
    const children = await projects.taskPage(w.ownerId, w.projectId, { parentId: head });
    assert.deepEqual(children.items.map((i) => (i as { id: string }).id), [dead]);
    assert.deepEqual(graphOf(children.items[0]), {
      title: 'dead',
      // Its own CANCELLED status is not a statement about its prerequisites, and it has none.
      unmetCount: 0,
      blocksCount: 1,
      topoLevel: 0,
      dependencyState: 'READY',
    });
  });

  await t.test('AC5: the paging semantics are untouched', async () => {
    // Root level only, and all five of them.
    assert.deepEqual(
      rootPage.items.map((i) => (i as { title: string }).title).sort(),
      ['head', 'iso', 'merge', 'mid', 'tail'],
    );
    assert.equal(rootPage.nextCursor, null, 'a page that did not fill has nowhere to continue');

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result: { items: unknown[]; nextCursor: string | null } = await projects.taskPage(
        w.ownerId,
        w.projectId,
        { limit: 2, ...(cursor ? { cursor } : {}) },
      );
      assert.ok(result.items.length <= 2, 'limit bounds the page');
      // Every row on every page carries the fields — paging does not drop the graph pass.
      for (const item of result.items) {
        assert.equal(typeof (item as { topoLevel: unknown }).topoLevel, 'number');
      }
      seen.push(...result.items.map((i) => (i as { id: string }).id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, null, 'the walk ended by running out of rows, not by the loop guard');
    assert.equal(seen.length, 5, 'nothing was repeated and nothing was lost');
    assert.equal(new Set(seen).size, 5);
  });

  await t.test('the served payload keeps the tallies as tallies and the ids as Base62', async () => {
    const payload = (await served(rootPage)) as { items: Array<Record<string, unknown>> };

    assert.deepEqual(rawUuidPaths(payload), [], 'no raw uuid may leave the endpoint');
    const row = payload.items.find((i) => i.title === 'merge')!;
    assert.equal(row.id, publicId(merge));
    // None of the four names is id-shaped, so the interceptor leaves them exactly as computed —
    // a tally called something like `blockedById` would have been Base62-encoded into nonsense.
    assert.deepEqual(
      { u: row.unmetCount, b: row.blocksCount, t: row.topoLevel, s: row.dependencyState },
      { u: 3, b: 0, t: 3, s: 'BLOCKED_FAILED' },
    );
  });

  await t.test('a 118-node project is one pass, not one query per node', async () => {
    // The size of the project this was written for. The shape is a spine with a shortcut edge
    // across every node, which is what makes a path-enumerating recursion blow up: each node is
    // reachable by exponentially many distinct paths, and only deduplicating (node, level) pairs
    // keeps the walk polynomial.
    const big = await world(db, 'pcc-deps-118');
    const spine: string[] = [];
    for (let i = 0; i < 118; i += 1) {
      const dependsOn = spine.length
        ? [spine[spine.length - 1], ...(spine.length > 1 ? [spine[spine.length - 2]] : [])]
        : [];
      spine.push(await task(db, big, `n${i}`, { dependsOn }));
    }

    const started = process.hrtime.bigint();
    const page = await projects.taskPage(big.ownerId, big.projectId, { limit: 200 });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    const levels = new Map(
      page.items.map((i) => [(i as { title: string }).title, (i as { topoLevel: number }).topoLevel]),
    );
    assert.equal(levels.size, 118);
    // The shortcut never shortens anything: the longest path to n117 is still the whole spine.
    assert.equal(levels.get('n0'), 0);
    assert.equal(levels.get('n117'), 117);
    assert.equal(levels.get('n59'), 59);
    // Not a benchmark — a fence. A per-row recursion over this graph does not finish in seconds.
    assert.ok(elapsedMs < 10_000, `the page took ${elapsedMs.toFixed(0)}ms`);
  });

  await db.$disconnect();
  await identity.end();
});
