import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CreatorType, PrismaClient, TaskStatus } from '@prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { BLOCKING_MAX_UNFINISHED_TASKS } from './project-panorama-blocking';
import { ProjectsService } from './projects.service';
import { prismaClientFor } from '../prisma/prisma-client';

/**
 * `GET /projects/:id/panorama/blocking` against a real, fully migrated PostgreSQL.
 *
 * The whole answer is one recursive `$queryRaw`, and every property worth having is a property of
 * the SQL rather than of any function around it: the transitive reach, the `UNION` that stops a
 * diamond counting a task twice, the restriction to the unfinished subgraph, the one-row-per-
 * project totals that survive an empty ranking. A fake Prisma returns whatever it was told to and
 * would agree with a wrong query as readily as a right one.
 *
 * Each scenario builds its own owner and project and every query is scoped by both, so the specs
 * cannot see each other's fixtures and nothing here truncates a table it did not create. Its writes
 * are still confined to an isolated disposable server (see coordinator-pg-test-safety), proved
 * before the first one.
 *
 *   docker run -d --name pcc-blocking-pg16 -e POSTGRES_PASSWORD=pcc_blocking \
 *     -e POSTGRES_USER=pcc_blocking -e POSTGRES_DB=pcc_blocking \
 *     -p 127.0.0.1:55642:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://pcc_blocking:pcc_blocking@127.0.0.1:55642/pcc_blocking \
 *     npx prisma migrate deploy
 *   COORDINATOR_PG_URL=postgresql://pcc_blocking:pcc_blocking@127.0.0.1:55642/pcc_blocking \
 *     COORDINATOR_PG_EXPECTED_DATABASE=pcc_blocking COORDINATOR_PG_EXPECTED_USER=pcc_blocking \
 *     COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(psql -tAc \
 *       'SELECT system_identifier FROM pg_control_system()') \
 *     node --test build/projects/project-panorama-blocking.pg.spec.js
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
  /** `ids` inverted, so a ranked row can be reported by the name the spec gave it. */
  names: Record<string, string>;
  /** The title the fixture wrote for a name — what the endpoint returns and orders ties by. */
  title(name: string): string;
}

/**
 * One owner, one project, and the tasks and edges of `spec` — written with `createMany` because
 * one scenario below is deliberately two thousand tasks large.
 */
async function fixture(
  db: PrismaClient,
  label: string,
  spec: Record<string, TaskSpec>,
): Promise<Fixture> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@blocking.invalid`, name: label, passwordHash: 'x' },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: label } });

  const ids: Record<string, string> = {};
  const names: Record<string, string> = {};
  for (const name of Object.keys(spec)) {
    ids[name] = randomUUID();
    names[ids[name]] = name;
  }
  const title = (name: string) => `${label}-${name}`;
  await db.task.createMany({
    data: Object.entries(spec).map(([name, one]) => ({
      id: ids[name],
      ownerId,
      projectId,
      title: title(name),
      creatorType: CreatorType.USER,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      creatorId: ownerId,
      status: one.status ?? TaskStatus.OPEN,
    })),
  });
  const edges = Object.entries(spec).flatMap(([name, one]) =>
    (one.dependsOn ?? []).map((prerequisite) => ({
      taskId: ids[name],
      dependsOnTaskId: ids[prerequisite],
    })),
  );
  if (edges.length > 0) await db.taskDependency.createMany({ data: edges });
  return { ownerId, projectId, ids, names, title };
}

/** `count` tasks in one straight line, `<prefix>1` depending on nothing. */
function chain(prefix: string, count: number, dependsOn: string[] = []): Record<string, TaskSpec> {
  const spec: Record<string, TaskSpec> = {};
  for (let n = 1; n <= count; n += 1) {
    spec[`${prefix}${n}`] = { dependsOn: n === 1 ? dependsOn : [`${prefix}${n - 1}`] };
  }
  return spec;
}

test('the blocking leaderboard ranks unfinished tasks by transitive downstream reach',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);

    const db = prismaClientFor(URL);
    const prisma = db as unknown as PrismaService;
    const projects = new ProjectsService(prisma);

    try {
      // ---- A: a chain, a diamond, two islands, and two finished prerequisites ------------------
      //
      //   done1, done2 = DONE, both prerequisites of c1
      //   c1 -> c2 -> c3 -> c4 -> c5 -> c6         (six tasks, five steps)
      //   dA -> dB -> dD, dA -> dC -> dD           (the diamond: dD reachable two ways)
      //   i1, i2                                   (no edges at all)
      //
      // so by hand, transitively: c1 5, c2 4, c3 3, c4 2, c5 1, c6 0; dA 3, dB 1, dC 1, dD 0;
      // i1 i2 0. Twelve unfinished tasks, eight of which block something.
      const a = await fixture(db, 'blocking-a', {
        done1: { status: TaskStatus.DONE },
        done2: { status: TaskStatus.DONE },
        ...chain('c', 6, ['done1', 'done2']),
        dA: {},
        dB: { dependsOn: ['dA'] },
        dC: { dependsOn: ['dA'] },
        dD: { dependsOn: ['dB', 'dC'] },
        i1: {},
        i2: {},
      });
      /** The scenario's ranking, named — `[['c1', 5], …]` — for whole-list comparison. */
      const ranked = async (limit?: number) => {
        const board = await projects.panoramaBlocking(a.ownerId, a.projectId,
          limit === undefined ? {} : { limit: String(limit) });
        return board.items.map((item) => [a.names[item.taskId], item.downstreamBlocked]);
      };

      await t.test('the chain head tops the ranking with the whole chain behind it', async () => {
        const board = await projects.panoramaBlocking(a.ownerId, a.projectId, { limit: '50' });
        const first = board.items[0];
        assert.equal(a.names[first.taskId], 'c1');
        // Five, not one: c1 has exactly ONE direct dependent, and a ranking by direct edges would
        // tie it with every other link in the chain. Reaching through the chain is the endpoint.
        assert.equal(first.downstreamBlocked, 5);
        assert.equal(first.title, a.title('c1'));
        assert.equal(first.status, TaskStatus.OPEN);
      });

      await t.test('a diamond credits the shared descendant once, not once per path', async () => {
        const board = await projects.panoramaBlocking(a.ownerId, a.projectId, { limit: '50' });
        const dA = board.items.find((item) => a.names[item.taskId] === 'dA');
        assert.ok(dA, 'dA blocks three tasks and must be ranked');
        // dB, dC, dD — and dD is reachable both via dB and via dC. UNION ALL would count it twice
        // and report 4; on a wider diamond it would keep multiplying, which is the failure this
        // number exists to catch.
        assert.equal(dA.downstreamBlocked, 3);
      });

      await t.test('the whole ranking is exactly the tasks that block something, in order',
        async () => {
          // Not a restatement of the two tests above: this pins the shape of the WHOLE list, which
          // is where a task appearing twice, an island sneaking in at zero, or a finished
          // prerequisite outranking everything would show up.
          assert.deepEqual(await ranked(50), [
            ['c1', 5],
            ['c2', 4],
            ['c3', 3],
            ['dA', 3],
            ['c4', 2],
            ['c5', 1],
            ['dB', 1],
            ['dC', 1],
          ]);
        });

      await t.test('an island and a leaf are absent rather than ranked at zero', async () => {
        const board = await projects.panoramaBlocking(a.ownerId, a.projectId, { limit: '50' });
        const listed = board.items.map((item) => a.names[item.taskId]);
        // i1/i2 have no edges; c6/dD are the ends of their chains. Nothing is waiting on any of
        // them, so "unblock this to release N" has nothing to say about them.
        for (const name of ['i1', 'i2', 'c6', 'dD']) {
          assert.ok(!listed.includes(name), `${name} blocks nothing and must not be ranked`);
        }
      });

      await t.test('a DONE prerequisite is not a blocker, however much is behind it', async () => {
        const board = await projects.panoramaBlocking(a.ownerId, a.projectId, { limit: '50' });
        const listed = board.items.map((item) => a.names[item.taskId]);
        // done1/done2 sit in front of the whole six-task chain, so an implementation that walked
        // the raw graph would rank them FIRST, at 6 apiece — above the real answer.
        assert.ok(!listed.includes('done1'));
        assert.ok(!listed.includes('done2'));
        assert.ok(board.items.every((item) => item.status !== TaskStatus.DONE));
      });

      await t.test('remainingCount is every unfinished task, not the ranked ones', async () => {
        const board = await projects.panoramaBlocking(a.ownerId, a.projectId, { limit: '50' });
        // Twelve unfinished against eight ranked: the bar track is the project, so the difference
        // between the two numbers is exactly what the card is drawing.
        assert.equal(board.remainingCount, 12);
        assert.equal(board.items.length, 8);
        const unfinished = await db.task.count({
          where: {
            projectId: a.projectId,
            status: { notIn: [TaskStatus.DONE, TaskStatus.CANCELLED] },
          },
        });
        assert.equal(board.remainingCount, unfinished);
        assert.equal(board.truncated, null);
      });

      await t.test('limit cuts the ranking without reordering or renumbering it', async () => {
        assert.deepEqual(await ranked(2), [['c1', 5], ['c2', 4]]);
        // The default the endpoint documents, and the size the card draws.
        assert.deepEqual(await ranked(), [
          ['c1', 5],
          ['c2', 4],
          ['c3', 3],
          ['dA', 3],
          ['c4', 2],
        ]);
        assert.equal((await ranked(1)).length, 1);
      });

      await t.test('a limit outside the allowed range is refused, not clamped', async () => {
        for (const limit of ['0', '-1', '51', 'abc', '1.5', '']) {
          await assert.rejects(
            () => projects.panoramaBlocking(a.ownerId, a.projectId, { limit }),
            (error: unknown) => error instanceof BadRequestException,
            `limit=${JSON.stringify(limit)}`,
          );
        }
      });

      // ---- B: the chain is cut by a task that is already finished ------------------------------
      await t.test('a finished task in the middle breaks the chain rather than bridging it',
        async () => {
          const b = await fixture(db, 'blocking-b', {
            head: {},
            middle: { status: TaskStatus.DONE, dependsOn: ['head'] },
            tail: { dependsOn: ['middle'] },
          });
          const board = await projects.panoramaBlocking(b.ownerId, b.projectId, { limit: '50' });
          // Settling `head` releases nothing: `tail` waits on `middle`, and `middle` is done. An
          // implementation that walked the raw graph and only filtered the ROOTS would report
          // head blocking 1 (or 2) and send somebody to work on a task that frees nobody.
          assert.deepEqual(board.items, []);
          assert.equal(board.remainingCount, 2);
        });

      // ---- C: a cancelled task is settled too --------------------------------------------------
      await t.test('a CANCELLED task is neither ranked nor counted as remaining', async () => {
        const c = await fixture(db, 'blocking-c', {
          root: {},
          stopped: { status: TaskStatus.CANCELLED, dependsOn: ['root'] },
          live: { dependsOn: ['root'] },
        });
        const board = await projects.panoramaBlocking(c.ownerId, c.projectId, { limit: '50' });
        assert.deepEqual(
          board.items.map((item) => [c.names[item.taskId], item.downstreamBlocked]),
          [['root', 1]],
          'root blocks `live` only — nothing is owed to a cancelled task',
        );
        assert.equal(board.remainingCount, 2);
      });

      // ---- D: the size the deployment actually reaches ------------------------------------------
      await t.test('the closure handles the largest real project (118 tasks)', async () => {
        const d = await fixture(db, 'blocking-d', chain('t', 118));
        const started = process.hrtime.bigint();
        const board = await projects.panoramaBlocking(d.ownerId, d.projectId, { limit: '3' });
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        assert.equal(board.remainingCount, 118);
        // 117 pairs from the head, 116 from the next: the closure over a 118-long chain is 6,903
        // (root, reached) pairs, and this is the run that proves walking them is affordable.
        assert.deepEqual(
          board.items.map((item) => [d.names[item.taskId], item.downstreamBlocked]),
          [['t1', 117], ['t2', 116], ['t3', 115]],
        );
        assert.equal(board.truncated, null);
        assert.ok(ms < 5_000, `118-task closure took ${ms.toFixed(0)}ms`);
        console.log(`blocking-closure-118-tasks ${ms.toFixed(0)}ms`);
      });

      // ---- E: past the cap, and saying so ------------------------------------------------------
      await t.test('over the cap the walk is skipped and the answer says it was', async () => {
        const over = BLOCKING_MAX_UNFINISHED_TASKS + 1;
        // A chain across the first eleven tasks, so a build with no guard would return a ranking
        // here rather than an empty one — the assertion below distinguishes "guard tripped" from
        // "nothing to rank".
        const spec: Record<string, TaskSpec> = chain('t', 11);
        for (let n = 12; n <= over; n += 1) spec[`t${n}`] = {};
        const e = await fixture(db, 'blocking-e', spec);

        const started = process.hrtime.bigint();
        const board = await projects.panoramaBlocking(e.ownerId, e.projectId, { limit: '5' });
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        assert.equal(board.remainingCount, over, 'the total is still counted');
        assert.deepEqual(board.items, []);
        assert.deepEqual(board.truncated, {
          reason: 'TOO_MANY_UNFINISHED_TASKS',
          maxTasks: BLOCKING_MAX_UNFINISHED_TASKS,
        });
        console.log(`blocking-closure-over-cap ${ms.toFixed(0)}ms`);

        // The same project one task smaller answers in full, which is what makes the number above
        // a cap rather than the size at which the query happens to stop working.
        await db.task.delete({ where: { id: e.ids[`t${over}`] } });
        const under = await projects.panoramaBlocking(e.ownerId, e.projectId, { limit: '1' });
        assert.equal(under.remainingCount, BLOCKING_MAX_UNFINISHED_TASKS);
        assert.equal(under.truncated, null);
        assert.deepEqual(
          under.items.map((item) => [e.names[item.taskId], item.downstreamBlocked]),
          [['t1', 10]],
        );
      });

      // ---- F: an empty project ------------------------------------------------------------------
      await t.test('a project with no tasks answers with zero and an empty ranking', async () => {
        const empty = await fixture(db, 'blocking-f', {});
        const board = await projects.panoramaBlocking(empty.ownerId, empty.projectId);
        assert.deepEqual(board, { remainingCount: 0, items: [], truncated: null });
      });

      // ---- G: the door, not just the query ------------------------------------------------------
      await t.test('another owner cannot read this project', async () => {
        await assert.rejects(
          () => projects.panoramaBlocking(randomUUID(), a.projectId),
          (error: unknown) => error instanceof NotFoundException,
        );
      });
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });
