import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { TaskStatus } from '@orbit/shared';
import { TaskListsService } from '../task-lists/task-lists.service';
import { TasksService } from './tasks.service';
import { recordingQueryRaw } from './query-raw-test-helper';

/**
 * The Tasks page's scope: the tasks filed under no project (`projectId=none`).
 *
 * A project's tasks live on the project's page, where the project decides whether they run. On
 * this deployment they are 111,233 of 111,937 tasks, so a Tasks page that also listed them — and
 * counted them — reported "Done 1,980 / 111,937" over a Ready list of the owner's own work. The
 * scope has to reach every read the page makes: the rows, the tallies, the pinned strip, the label
 * table and the Ready tab's hand-written SQL, or one of them keeps answering for the whole account
 * beside four that answer for the page.
 */

const OWNER_ID = '00000000-0000-7000-8000-000000000001';

function serviceWith(prisma: unknown): TasksService {
  return new TasksService(prisma as never, {} as never, {} as never);
}

function harness(rows: unknown[] = [], extra: Record<string, unknown> = {}) {
  const findManyArgs: any[] = [];
  const countWheres: any[] = [];
  const groupByWheres: any[] = [];
  const projectCountWheres: any[] = [];
  const raw = recordingQueryRaw(() => [{ count: 4 }]);
  const service = serviceWith({
    $queryRaw: raw.$queryRaw,
    task: {
      findMany: async (args: any) => {
        findManyArgs.push(args);
        return rows;
      },
      count: async (args: any) => {
        countWheres.push(args.where);
        return 111_233;
      },
      groupBy: async (args: any) => {
        groupByWheres.push(args.where);
        return [{ status: TaskStatus.DONE, _count: { _all: 648 } }];
      },
    },
    project: {
      count: async (args: any) => {
        projectCountWheres.push(args.where);
        return 71;
      },
    },
    session: { groupBy: async () => [], findMany: async () => [] },
    taskDependency: { findMany: async () => [] },
    ...extra,
  });
  return { service, raw, findManyArgs, countWheres, groupByWheres, projectCountWheres };
}

test('none narrows the page to the tasks filed under no project', async () => {
  const { service, findManyArgs } = harness();

  await service.listPage(OWNER_ID, { projectId: 'none', counts: 'none' });

  assert.deepEqual(findManyArgs[0].where, { ownerId: OWNER_ID, projectId: null });
});

test('none scopes the page tallies as well as the rows', async () => {
  const { service, countWheres, groupByWheres } = harness();

  await service.listPage(OWNER_ID, { projectId: 'none', status: 'OPEN' });

  assert.ok(groupByWheres.length > 0 && countWheres.length > 0);
  for (const where of [...countWheres, ...groupByWheres]) {
    assert.equal(where.projectId, null, `aggregate answers for the whole account: ${JSON.stringify(where)}`);
    assert.equal(where.ownerId, OWNER_ID);
  }
});

// NEGATIVE CONTROL for the one path that is SQL rather than a Prisma where: without the IS NULL
// clause the Ready tab lists the 276 runnable FineWeb shards over the 50 tasks the page is for.
test('the Ready ranking and its badge carry `t.project_id IS NULL`', async () => {
  const { service, raw } = harness();

  await service.listPage(OWNER_ID, { projectId: 'none', status: 'RUNNABLE' });

  assert.equal(raw.statements.length, 2);
  for (const statement of raw.statements) {
    assert.match(statement.text, /t\.project_id IS NULL/, `Ready SQL ignores the scope: ${statement.text}`);
    assert.doesNotMatch(statement.text, /t\.project_id = \$\d+::uuid/);
  }
});

test('the counts endpoint under none says how many tasks it leaves on project pages', async () => {
  const { service, groupByWheres, countWheres, projectCountWheres } = harness();

  const counts = await service.taskCounts(OWNER_ID, { projectId: 'none' });

  assert.equal(groupByWheres[0].projectId, null);
  assert.deepEqual(counts.inProjects, { tasks: 111_233, projects: 71 });
  // Owner-wide, and only the project side of the line.
  assert.ok(
    countWheres.some((where) => where.ownerId === OWNER_ID
      && where.projectId && where.projectId.not === null && Object.keys(where).length === 2),
    `no owner-wide in-projects count: ${JSON.stringify(countWheres)}`,
  );
  assert.deepEqual(projectCountWheres[0], { ownerId: OWNER_ID, tasks: { some: {} } });
});

test('the counts of one project, or of no scope at all, carry no in-projects block', async () => {
  for (const query of [{}, { projectId: '00000000-0000-7000-8000-0000000000aa' }]) {
    const { service, projectCountWheres } = harness();
    const counts = await service.taskCounts(OWNER_ID, query);
    assert.equal(counts.inProjects, undefined, JSON.stringify(query));
    assert.equal(projectCountWheres.length, 0, 'asked the project table without being asked to');
  }
});

test('the pinned strip under none holds only tasks filed under no project', async () => {
  const { service, findManyArgs, countWheres } = harness();

  await service.activeTasks(OWNER_ID, { projectId: 'none' });

  assert.equal(findManyArgs[0].where.projectId, null);
  assert.equal(countWheres[0].projectId, null);
  assert.ok(Array.isArray(findManyArgs[0].where.OR), 'the live-state predicate survives the scope');
});

test('the label table under none reads only tasks filed under no project', async () => {
  const raw = recordingQueryRaw(() => []);
  const service = serviceWith({ $queryRaw: raw.$queryRaw });

  await service.labelSummary(OWNER_ID, { projectId: 'none' });

  assert.equal(raw.statements.length, 1);
  assert.match(raw.statements[0].text, /t\.project_id IS NULL/);
});

test('a project scope that is neither none nor a uuid is a 400', async () => {
  const { service } = harness();
  for (const read of [
    () => service.taskCounts(OWNER_ID, { projectId: 'nope' }),
    () => service.activeTasks(OWNER_ID, { projectId: 'nope' }),
    () => service.labelSummary(OWNER_ID, { projectId: 'nope' }),
  ]) {
    await assert.rejects(read, (error: unknown) => error instanceof BadRequestException);
  }
});

// ── Waiting for your confirmation ─────────────────────────────────────────────────────────────

const WAITING = '00000000-0000-7000-8000-0000000000c1';
const PLAIN = '00000000-0000-7000-8000-0000000000c2';
const SETTLED = '00000000-0000-7000-8000-0000000000c3';
const SESSION = '00000000-0000-7000-8000-0000000000d1';

function row(id: string, completionCriterion: string, status: string) {
  return { id, completionCriterion, status, createdAt: new Date('2026-09-26T08:00:00Z') };
}

test('a row says when its OWNER_CONFIRMED run is waiting on the owner', async () => {
  const requestReads: any[] = [];
  const { service } = harness(
    [row(WAITING, 'OWNER_CONFIRMED', 'IN_PROGRESS'), row(PLAIN, 'EXECUTABLE', 'OPEN')],
    {
      taskOwnerConfirmationRequest: {
        findMany: async (args: any) => {
          requestReads.push(args.where);
          return [{
            id: 'req-1', taskId: WAITING, sessionId: SESSION,
            requestedAt: new Date('2026-09-26T08:05:00Z'), task: { projectId: null },
          }];
        },
        findFirst: async () => ({ id: 'req-1', sessionId: SESSION, decisions: [] }),
      },
      session: { groupBy: async () => [], findMany: async () => [{ id: SESSION }] },
    },
  );

  const page = await service.listPage(OWNER_ID, { projectId: 'none', counts: 'none' });

  const byId = Object.fromEntries(page.items.map((item: any) => [item.id, item.awaitingOwnerConfirmation]));
  assert.deepEqual(byId, { [WAITING]: true, [PLAIN]: false });
  assert.equal(requestReads.length, 1);
});

// A page with no unsettled OWNER_CONFIRMED row cannot be waiting on anybody, so it asks nothing —
// which is also every page most owners ever load.
test('a page with nothing that could be waiting asks the confirmation table nothing', async () => {
  let asked = false;
  const { service } = harness(
    [row(PLAIN, 'EXECUTABLE', 'OPEN'), row(SETTLED, 'OWNER_CONFIRMED', 'DONE')],
    {
      taskOwnerConfirmationRequest: {
        findMany: async () => {
          asked = true;
          return [];
        },
      },
    },
  );

  const page = await service.listPage(OWNER_ID, { projectId: 'none', counts: 'none' });

  assert.equal(asked, false);
  assert.ok(page.items.every((item: any) => item.awaitingOwnerConfirmation === false));
});

// ── The lists index ───────────────────────────────────────────────────────────────────────────

test('each list says how many of its tasks are filed under no project', async () => {
  const outsideWheres: any[] = [];
  const service = new TaskListsService(
    {
      taskList: {
        findMany: async () => [
          { id: 'fineweb', title: 'FineWeb shards', taskCount: 27_468, taskDoneCount: 49 },
          { id: 'nce3', title: 'NCE3', taskCount: 32, taskDoneCount: 32 },
          { id: 'empty', title: 'Empty', taskCount: 0, taskDoneCount: 0 },
        ],
      },
      task: {
        groupBy: async (args: any) => {
          if ('projectId' in args.where) {
            outsideWheres.push(args.where);
            return [{ listId: 'nce3', _count: { _all: 32 } }];
          }
          return [];
        },
      },
    } as never,
    { publishForUser: () => undefined } as never,
    {} as never,
  );

  const lists = await service.list(OWNER_ID);

  const outside = Object.fromEntries(lists.map((list: any) => [list.id, list.tasksOutsideProjects]));
  assert.deepEqual(outside, { fineweb: 0, nce3: 32, empty: 0 });
  assert.deepEqual(outsideWheres[0], { listId: { in: ['fineweb', 'nce3', 'empty'] }, projectId: null });
});

// ── How long a running row has been going ────────────────────────────────────────────────────

test('a running row says when its oldest live run began; a queued one says nothing', async () => {
  const started = new Date('2026-09-26T07:58:00Z');
  const { service } = harness(
    [row(WAITING, 'EXECUTABLE', 'IN_PROGRESS'), row(PLAIN, 'EXECUTABLE', 'OPEN')],
    {
      session: {
        groupBy: async () => [
          { taskId: WAITING, status: 'RUNNING', _count: { _all: 1 }, _min: { startedAt: started } },
          { taskId: PLAIN, status: 'PENDING', _count: { _all: 1 }, _min: { startedAt: null } },
        ],
        findMany: async () => [],
      },
    },
  );

  const page = await service.listPage(OWNER_ID, { projectId: 'none', counts: 'none' });

  const byId = Object.fromEntries(page.items.map((item: any) => [item.id, [item.running, item.queued, item.runningSince]]));
  assert.deepEqual(byId[WAITING], [true, false, started]);
  assert.deepEqual(byId[PLAIN], [false, true, null]);
});
