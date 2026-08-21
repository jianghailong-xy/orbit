import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import { TASK_LIST_SELECT, TasksService } from './tasks.service';

/**
 * Scoping a task list to one project.
 *
 * The filter has to reach every query the request makes, not just the one that produces the rows.
 * `listPage` fans out into a Prisma page, a filtered count, four scope-wide aggregates and — on
 * the Ready tab — two hand-written SQL statements that are built from a *different* spelling of
 * the same scope. A filter added to the object form and missed in `taskScopeSql` is not a type
 * error anywhere: the Ready tab and the Ready badge just keep answering for the whole account,
 * beside five numbers that answer for the project. That failure is what most of this file is for.
 */

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const PROJECT_ID = '00000000-0000-7000-8000-0000000000aa';
const OTHER_PROJECT_ID = '00000000-0000-7000-8000-0000000000bb';

function serviceWith(prisma: unknown): TasksService {
  return new TasksService(prisma as never, {} as never, {} as never);
}

/** Renders each `$queryRaw` template the way PostgreSQL would see it, bound values included. */
function recordingQueryRaw(rows: (sql: string) => unknown[]) {
  const statements: { text: string; values: unknown[] }[] = [];
  const $queryRaw = async (strings: TemplateStringsArray, ...bound: unknown[]) => {
    const sql = Prisma.sql(strings, ...(bound as never[]));
    statements.push({ text: sql.text, values: sql.values });
    return rows(sql.text);
  };
  return { statements, $queryRaw };
}

function harness(rows: unknown[] = []) {
  const findManyArgs: any[] = [];
  const countWheres: any[] = [];
  const groupByWheres: any[] = [];
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
        return 11;
      },
      groupBy: async (args: any) => {
        groupByWheres.push(args.where);
        return [{ status: TaskStatus.OPEN, _count: { _all: 3 } }];
      },
    },
    session: { groupBy: async () => [] },
    taskDependency: { findMany: async () => [] },
  });
  return { service, raw, findManyArgs, countWheres, groupByWheres };
}

test('a project id narrows the page to that project, under the owner', async () => {
  const { service, findManyArgs } = harness();

  await service.listPage(OWNER_ID, { projectId: PROJECT_ID, counts: 'none' });

  assert.deepEqual(findManyArgs[0].where, { ownerId: OWNER_ID, projectId: PROJECT_ID });
});

// The tallies are the progress bar. Answering them for the whole account beside a page that shows
// one project is worse than not answering: the numbers look like the project's.
test('the project scopes the aggregates as well as the page', async () => {
  const { service, countWheres, groupByWheres } = harness();

  await service.listPage(OWNER_ID, { projectId: PROJECT_ID, status: 'OPEN' });

  for (const where of [...countWheres, ...groupByWheres]) {
    assert.equal(where.projectId, PROJECT_ID, `unscoped aggregate: ${JSON.stringify(where)}`);
    assert.equal(where.ownerId, OWNER_ID);
  }
  // The status filter narrows the page, never the scope-wide block.
  assert.equal(groupByWheres[0].status, undefined);
});

// NEGATIVE CONTROL. The Ready tab is the one status path that reaches PostgreSQL as hand-written
// SQL rather than as a Prisma `where`, so it is the one that can silently ignore a new filter.
// Both of its statements — the id ranking and the badge count — must carry the project.
test('the runnable ranking and its badge count are both scoped to the project', async () => {
  const { service, raw } = harness();

  await service.listPage(OWNER_ID, { projectId: PROJECT_ID, status: 'RUNNABLE' });

  assert.equal(raw.statements.length, 2);
  for (const statement of raw.statements) {
    assert.match(
      statement.text,
      /t\.project_id = \$\d+::uuid/,
      `runnable SQL ignores projectId: ${statement.text}`,
    );
    assert.ok(
      statement.values.includes(PROJECT_ID),
      `project id never bound: ${JSON.stringify(statement.values)}`,
    );
    // The project narrows the runnable predicate, it does not replace it.
    assert.match(statement.text, /t\.owner_id = \$\d+::uuid/);
    assert.match(statement.text, /t\.status <> 'DONE'::task_status/);
  }
  const [page, badge] = raw.statements;
  assert.match(page.text, /ORDER BY t\.created_at DESC, t\.id DESC/);
  assert.match(badge.text, /count\(\*\)::int/);
});

// The runnable badge is also computed for every OTHER tab, as part of the scope-wide block — so
// the raw statement has to be scoped even when nobody asked for RUNNABLE.
test('the runnable badge on an ordinary tab is scoped too', async () => {
  const { service, raw } = harness();

  await service.listPage(OWNER_ID, { projectId: PROJECT_ID, status: 'OPEN' });

  assert.equal(raw.statements.length, 1);
  assert.match(raw.statements[0].text, /count\(\*\)::int/);
  assert.match(raw.statements[0].text, /t\.project_id = \$\d+::uuid/);
  assert.ok(raw.statements[0].values.includes(PROJECT_ID));
});

test('a project combines with the list, label and status filters rather than replacing them', async () => {
  const { service, findManyArgs, groupByWheres } = harness();

  await service.listPage(OWNER_ID, {
    projectId: PROJECT_ID,
    listId: '00000000-0000-7000-8000-0000000000cc',
    labels: 'shard-3,CC-MAIN-2017-34',
    status: 'OPEN',
    counts: 'total',
  });

  assert.deepEqual(findManyArgs[0].where, {
    ownerId: OWNER_ID,
    listId: '00000000-0000-7000-8000-0000000000cc',
    projectId: PROJECT_ID,
    labels: { hasEvery: ['shard-3', 'CC-MAIN-2017-34'] },
    status: { in: [TaskStatus.OPEN] },
  });
  assert.equal(groupByWheres.length, 0, 'counts=total should skip the scope aggregates');
});

// A walk is where a dropped scope does the most damage: page one is the project's and every page
// after it is the account's, with nothing in the envelope saying so.
test('the project rides the cursor, on the page after the first', async () => {
  const createdAt = new Date('2026-08-01T12:00:00.000Z');
  const cursorId = '00000000-0000-7000-8000-000000000010';
  const { service, findManyArgs } = harness([{ id: cursorId, createdAt }, { id: cursorId, createdAt }]);

  const first = await service.listPage(OWNER_ID, {
    projectId: PROJECT_ID,
    limit: 1,
    counts: 'none',
  });
  assert.ok(first.nextCursor, 'a full page must hand back a cursor');

  await service.listPage(OWNER_ID, {
    projectId: PROJECT_ID,
    cursor: first.nextCursor!,
    counts: 'none',
  });

  const [filtered, keyset] = findManyArgs[1].where.AND;
  assert.deepEqual(filtered, { ownerId: OWNER_ID, projectId: PROJECT_ID });
  assert.equal(keyset.OR.length, 2, 'the keyset half of the cursor survives the scope');
});

// A project that does not exist and a project belonging to somebody else are the same answer: a
// filter that matched nothing. A 404 here would report whether an id exists to a caller with no
// right to know, and every other filter on this endpoint already answers empty.
test('an unknown or cross-owner project lists as empty, not as a 404', async () => {
  const wheres: any[] = [];
  const service = serviceWith({
    $queryRaw: async () => [{ count: 0 }],
    task: {
      findMany: async (args: any) => {
        wheres.push(args.where);
        return [];
      },
      count: async () => 0,
      groupBy: async () => [],
    },
    session: { groupBy: async () => [] },
    taskDependency: { findMany: async () => [] },
  });

  const page = await service.listPage(OWNER_ID, { projectId: OTHER_PROJECT_ID });

  assert.deepEqual(page.items, []);
  assert.equal(page.total, 0);
  assert.equal(page.counts?.total, 0);
  // Nothing looked the project up: no read of the project table, so nothing could disclose it.
  assert.deepEqual(wheres[0], { ownerId: OWNER_ID, projectId: OTHER_PROJECT_ID });
});

// The id reaches raw SQL as a `::uuid` cast, where a non-uuid is a 500 with nothing to act on.
test('a project id that is not a uuid is a 400 that names the field', async () => {
  const { service } = harness();

  await assert.rejects(
    () => service.listPage(OWNER_ID, { projectId: 'not-a-uuid', status: 'RUNNABLE' }),
    (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.match((error as BadRequestException).message, /project id/i);
      return true;
    },
  );
});

// Every pre-existing caller passes no project, and must keep seeing the account-wide answer: an
// absent filter has to leave no trace in either spelling of the scope.
test('omitting the project leaves the scope exactly as it was', async () => {
  const { service, raw, countWheres, groupByWheres } = harness();

  await service.listPage(OWNER_ID, { status: 'RUNNABLE' });

  for (const statement of raw.statements) {
    assert.doesNotMatch(statement.text, /project_id/);
  }
  for (const where of [...countWheres, ...groupByWheres]) {
    assert.ok(!('projectId' in where), `scope grew a projectId key: ${JSON.stringify(where)}`);
  }
});

test('an ordinary tab with no project is the same Prisma where it always was', async () => {
  const { service, findManyArgs } = harness();

  await service.listPage(OWNER_ID, { status: 'OPEN', counts: 'none' });

  assert.deepEqual(findManyArgs[0].where, {
    ownerId: OWNER_ID,
    status: { in: [TaskStatus.OPEN] },
  });
});

test('taskCounts, which has no project filter, is untouched by the new column', async () => {
  const { service, groupByWheres } = harness();

  await service.taskCounts(OWNER_ID, {});

  assert.deepEqual(groupByWheres[0], { ownerId: OWNER_ID });
});

/**
 * A coordinator listing its project's tasks needs to know which of them are subtasks, of what, and
 * what would settle each — questions the row could not answer before. Fetching them per row means
 * `GET /tasks/:id` per row, description included, which is exactly the download this select exists
 * to avoid.
 */
test('a list row carries the project, the parent and the acceptance criteria', () => {
  for (const field of ['projectId', 'parentTaskId', 'acceptanceCriteria']) {
    assert.equal(
      (TASK_LIST_SELECT as Record<string, unknown>)[field],
      true,
      `TASK_LIST_SELECT omits ${field}`,
    );
  }
});

// The reason this select exists at all: a description is ~500 bytes a row that no list renders,
// and `children`/`comments`/`sessions` are unbounded collections that turn one page into a
// fan-out. The three columns added above are scalars, and that is the line.
test('a list row still carries no description and no unbounded relation', () => {
  const select = TASK_LIST_SELECT as Record<string, unknown>;
  for (const field of ['description', 'children', 'comments', 'sessions', 'parent', 'project']) {
    assert.equal(select[field], undefined, `TASK_LIST_SELECT grew ${field}`);
  }
  // `_count` stays an aggregate over comments, not the comment rows themselves.
  assert.deepEqual(TASK_LIST_SELECT._count, { select: { comments: true } });
});

// The page hydrates through the same select on every status path, Ready included.
test('the runnable page hydrates rows through the shared list select', async () => {
  const ranked = [{ id: '00000000-0000-7000-8000-00000000000a' }];
  const findManyArgs: any[] = [];
  const raw = recordingQueryRaw((sql) => (sql.includes('count(*)') ? [{ count: 1 }] : ranked));
  const service = serviceWith({
    $queryRaw: raw.$queryRaw,
    task: {
      findMany: async (args: any) => {
        findManyArgs.push(args);
        return [{ id: ranked[0].id, createdAt: new Date('2026-08-01T00:00:00.000Z') }];
      },
      count: async () => 0,
      groupBy: async () => [],
    },
    session: { groupBy: async () => [] },
    taskDependency: { findMany: async () => [] },
  });

  await service.listPage(OWNER_ID, { projectId: PROJECT_ID, status: 'RUNNABLE' });

  assert.equal(findManyArgs[0].select, TASK_LIST_SELECT);
});

// RUNNING is the other tab whose filter is not a plain status column, so it gets the same check.
test('the running tab keeps its live-session filter and the project scope together', async () => {
  const { service, findManyArgs } = harness();

  await service.listPage(OWNER_ID, { projectId: PROJECT_ID, status: 'RUNNING', counts: 'none' });

  assert.deepEqual(findManyArgs[0].where, {
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    sessions: { some: { status: RunStatus.RUNNING } },
  });
});
