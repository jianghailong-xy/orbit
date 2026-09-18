import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CreatorType, PrismaClient, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectsService } from './projects.service';
import {
  ProjectTaskDependencyFacts,
  projectTaskDependencyFactsSql,
} from './project-dependency-facts';
import { prismaClientFor } from '../prisma/prisma-client';

/**
 * `topoLevel` on `GET /projects/:id/tasks/page` is a fact about the WHOLE project's graph, and
 * this spec exists because the query that answers it no longer reads the whole project.
 *
 * The walk now climbs from the page's own rows through their prerequisites and runs inside that
 * closure, which is what took one page of the 109,872-task project in this deployment from 55.6 s
 * to 0.3 s. The risk that buys is silent and unlosable by a unit test: a page-bounded walk that
 * started its levels at the page instead of at the project's sources would return small, plausible
 * numbers, and the chain-progress strip would quietly start saying "step 3" about step 348.
 *
 * So every case here reads a page that is a STRICT SUBSET of its project and asserts the level
 * against the same project's whole-graph walk (`projectTaskDependencyFactsSql`, which panorama
 * reads) rather than against a number typed into the test.
 *
 * Needs a disposable PostgreSQL; `scripts/run-pg-spec.sh` provides one:
 *
 *   scripts/run-pg-spec.sh src/apiserver/src/projects/project-task-page-topo-level.pg.spec.ts
 */

const URL = process.env.COORDINATOR_PG_URL;

interface Fixture {
  ownerId: string;
  projectId: string;
  ids: Record<string, string>;
}

/** An owner with one project holding `spec`'s tasks, each waiting on the ones it names. */
async function fixture(
  db: PrismaClient,
  label: string,
  spec: Record<string, string[]>,
  into?: Fixture,
): Promise<Fixture> {
  const ownerId = into?.ownerId ?? randomUUID();
  const projectId = into?.projectId ?? randomUUID();
  if (!into) {
    await db.user.create({
      data: { id: ownerId, email: `${label}-${ownerId}@topo.invalid`, name: label, passwordHash: 'x' },
    });
    await db.project.create({ data: { id: projectId, ownerId, title: label } });
  }
  const ids: Record<string, string> = { ...(into?.ids ?? {}) };
  for (const name of Object.keys(spec)) ids[name] = randomUUID();
  for (const name of Object.keys(spec)) {
    await db.task.create({
      data: {
        id: ids[name],
        ownerId,
        projectId,
        title: `${label}-${name}`,
        creatorType: CreatorType.USER,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        creatorId: ownerId,
        status: TaskStatus.OPEN,
      },
    });
  }
  for (const [name, prerequisites] of Object.entries(spec)) {
    for (const prerequisite of prerequisites) {
      await db.taskDependency.create({
        data: { taskId: ids[name], dependsOnTaskId: ids[prerequisite] },
      });
    }
  }
  return { ownerId, projectId, ids };
}

/** `count` tasks in one straight line, the first waiting on nothing. */
function chain(count: number): Record<string, string[]> {
  const spec: Record<string, string[]> = {};
  for (let n = 1; n <= count; n += 1) spec[`t${n}`] = n > 1 ? [`t${n - 1}`] : [];
  return spec;
}

/** The whole-project walk's answer, which the page's page-bounded walk has to agree with. */
async function levelsFromWholeProjectWalk(
  prisma: PrismaService,
  { ownerId, projectId }: Fixture,
): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<ProjectTaskDependencyFacts[]>(
    projectTaskDependencyFactsSql(ownerId, projectId),
  );
  return new Map(rows.map((row) => [row.taskId, row.topoLevel]));
}

test('a page reports the whole graph\'s longest path, not the page\'s own',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);

    const db = prismaClientFor(URL);
    const prisma = db as unknown as PrismaService;
    const projects = new ProjectsService(prisma);

    try {
      await t.test('the tail of a 40-task chain is level 39, on a page that holds 5 rows',
        async () => {
          const line = await fixture(db, 'chain', chain(40));
          const whole = await levelsFromWholeProjectWalk(prisma, line);

          const { items, nextCursor } = await projects.taskPage(line.ownerId, line.projectId, {
            limit: '5',
          });

          // A strict subset, or this proves nothing: the page must not be the project.
          assert.equal(items.length, 5);
          assert.notEqual(nextCursor, null);
          for (const item of items) {
            const expected = whole.get(item.id);
            assert.equal(typeof expected, 'number');
            assert.equal((item as { topoLevel: number }).topoLevel, expected);
          }
          // And the numbers are the chain's own depths, so a walk that agreed with a walk that was
          // also wrong would still be caught.
          assert.deepEqual(
            [...items].map((item) => (item as { topoLevel: number }).topoLevel).sort((a, b) => a - b),
            [35, 36, 37, 38, 39],
          );
        });

      await t.test('a diamond gives the longest way down, not the shortest', async () => {
        // detour: a -> b -> c -> d, and a -> d directly. `d` sits at 3, not 1.
        const shape = await fixture(db, 'diamond', {
          a: [], b: ['a'], c: ['b'], d: ['a', 'c'], e: ['d'],
        });
        const whole = await levelsFromWholeProjectWalk(prisma, shape);
        assert.equal(whole.get(shape.ids.d), 3);

        const { items } = await projects.taskPage(shape.ownerId, shape.projectId, { limit: '2' });

        assert.equal(items.length, 2);
        for (const item of items) {
          assert.equal((item as { topoLevel: number }).topoLevel, whole.get(item.id));
        }
      });

      await t.test('a prerequisite in another project holds the row without deepening it',
        async () => {
          const here = await fixture(db, 'here', chain(6));
          const elsewhere = randomUUID();
          await db.project.create({
            data: { id: elsewhere, ownerId: here.ownerId, title: 'elsewhere' },
          });
          const outsider = randomUUID();
          await db.task.create({
            data: {
              id: outsider,
              ownerId: here.ownerId,
              projectId: elsewhere,
              title: 'outsider',
              creatorType: CreatorType.USER,
              completionCriterion: 'EVIDENCE_JUDGMENT',
              creatorId: here.ownerId,
              status: TaskStatus.OPEN,
            },
          });
          // The head of the chain now waits on a task of another project.
          await db.taskDependency.create({
            data: { taskId: here.ids.t1, dependsOnTaskId: outsider },
          });

          const whole = await levelsFromWholeProjectWalk(prisma, here);
          const { items } = await projects.taskPage(here.ownerId, here.projectId, { limit: '6' });
          const shown = new Map(items.map((item) => [item.id, item as unknown as {
            topoLevel: number; unmetCount: number; dependencyState: string;
          }]));

          // Level counts edges INSIDE the project, so t1 is still a source at 0 — and the page and
          // the whole-project walk still agree, which is the invariant under test.
          assert.equal(shown.get(here.ids.t1)?.topoLevel, 0);
          assert.equal(whole.get(here.ids.t1), 0);
          assert.equal(shown.get(here.ids.t6)?.topoLevel, 5);
          for (const [id, item] of shown) assert.equal(item.topoLevel, whole.get(id));
          // The edge is not ignored, it is just not part of the shape: t1 is still waiting on it.
          assert.equal(shown.get(here.ids.t1)?.unmetCount, 1);
          assert.equal(shown.get(here.ids.t1)?.dependencyState, 'BLOCKED');
        });
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });
