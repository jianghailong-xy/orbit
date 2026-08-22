import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma, RunStatus } from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import { TasksService } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';

function serviceWith(prisma: unknown): TasksService {
  return new TasksService(prisma as never, {} as never, {} as never);
}

/**
 * Capture the statement each `$queryRaw` call would send to PostgreSQL. The runnable (Ready)
 * predicate is built as nested `Prisma.sql` fragments, so re-tagging the template is what
 * splices them back into one statement the assertions can read. `.text` (not `.sql`) is the
 * PostgreSQL rendering, with `$1` placeholders rather than `?`.
 */
function recordingQueryRaw(rows: (sql: string) => unknown[]) {
  const statements: string[] = [];
  const $queryRaw = async (strings: TemplateStringsArray, ...bound: unknown[]) => {
    const sql = Prisma.sql(strings, ...(bound as never[])).text;
    statements.push(sql);
    return rows(sql);
  };
  return { statements, $queryRaw };
}

test('legacy list handles more than PostgreSQL bind limit without a giant task-id query', async () => {
  const tasks = Array.from({ length: 40_001 }, (_, i) => ({ id: `task-${i}` }));
  const dependencyChunks: string[][] = [];
  let busyWhere: any;
  const service = serviceWith({
    task: { findMany: async () => tasks },
    session: {
      groupBy: async (args: any) => {
        busyWhere = args.where;
        return [];
      },
    },
    taskDependency: {
      findMany: async (args: any) => {
        dependencyChunks.push(args.where.taskId.in);
        return [];
      },
    },
  });

  const result = await service.list(OWNER_ID);

  assert.equal(result.length, 40_001);
  assert.equal(busyWhere.ownerId, OWNER_ID);
  assert.deepEqual(busyWhere.taskId, { not: null });
  assert.equal(dependencyChunks.length, 9);
  assert.equal(dependencyChunks.flat().length, 40_001);
  assert.ok(dependencyChunks.every((chunk) => chunk.length <= 5_000));
});

test('paged list applies database filters, caps rows, and returns aggregate counts', async () => {
  const createdAt = new Date('2026-08-01T12:00:00.000Z');
  const rows = [
    { id: '00000000-0000-7000-8000-000000000010', createdAt, status: TaskStatus.OPEN },
    { id: '00000000-0000-7000-8000-000000000009', createdAt, status: TaskStatus.OPEN },
    { id: '00000000-0000-7000-8000-000000000008', createdAt, status: TaskStatus.OPEN },
  ];
  let findManyArgs: any;
  const countWheres: any[] = [];
  const raw = recordingQueryRaw(() => [{ count: 3 }]);
  const service = serviceWith({
    $queryRaw: raw.$queryRaw,
    task: {
      findMany: async (args: any) => {
        findManyArgs = args;
        return rows;
      },
      count: async (args: any) => {
        countWheres.push(args.where);
        if (args.where.sessions?.some?.status === RunStatus.RUNNING) return 1;
        if (args.where.sessions?.some?.status === RunStatus.PENDING) return 2;
        return 17;
      },
      groupBy: async () => [
        { status: TaskStatus.OPEN, _count: { _all: 12 } },
        { status: TaskStatus.DONE, _count: { _all: 5 } },
      ],
    },
    session: {
      groupBy: async () => [
        { taskId: rows[0].id, status: RunStatus.RUNNING, _count: { _all: 1 } },
        { taskId: rows[1].id, status: RunStatus.PENDING, _count: { _all: 1 } },
      ],
    },
    taskDependency: { findMany: async () => [] },
  });

  const result = await service.listPage(OWNER_ID, {
    limit: 2,
    status: 'ONGOING',
    listId: 'none',
    q: 'FineWeb',
  });

  assert.equal(findManyArgs.take, 3);
  assert.equal(findManyArgs.where.ownerId, OWNER_ID);
  assert.equal(findManyArgs.where.listId, null);
  assert.deepEqual(findManyArgs.where.status.in, [TaskStatus.OPEN, TaskStatus.IN_PROGRESS]);
  assert.equal(findManyArgs.where.title.contains, 'FineWeb');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].running, true);
  assert.equal(result.items[1].queued, true);
  assert.ok(result.nextCursor);
  assert.equal(result.total, 17);
  assert.deepEqual(result.counts, {
    total: 17,
    open: 12,
    inProgress: 0,
    done: 5,
    failed: 0,
    cancelled: 0,
    running: 1,
    queued: 2,
    runnable: 3,
  });
  // filtered total + running + queued stay Prisma counts; the runnable badge is the one raw query.
  assert.equal(countWheres.length, 3);
  assert.equal(raw.statements.length, 1);
  assert.match(raw.statements[0], /count\(\*\)::int/);
});

test('runnable filter is applied before pagination with the same rules as the Run action', async () => {
  const raw = recordingQueryRaw(() => []);
  const service = serviceWith({
    $queryRaw: raw.$queryRaw,
    task: { findMany: async () => [], count: async () => 0, groupBy: async () => [] },
  });

  await service.listPage(OWNER_ID, { status: 'RUNNABLE' });

  // The page ranking and the badge count must both gate on all four Run-button conditions:
  // not finished, assigned to a workspace with a runner, nothing already in flight, no
  // outstanding prerequisite. Spelled as NOT EXISTS so PostgreSQL can short-circuit per row.
  assert.equal(raw.statements.length, 2);
  for (const sql of raw.statements) {
    assert.match(sql, /t\.owner_id = \$\d+::uuid/);
    assert.match(sql, /t\.status <> 'DONE'::task_status/);
    assert.match(sql, /EXISTS \(SELECT 1 FROM workspace a[\s\S]*a\.runner_id IS NOT NULL\)/);
    assert.match(
      sql,
      /NOT EXISTS \([\s\S]*FROM session s[\s\S]*'PENDING'::run_status, 'RUNNING'::run_status/,
    );
    assert.match(
      sql,
      /NOT EXISTS \([\s\S]*FROM task_dependency dep[\s\S]*WITH RECURSIVE chain/,
    );
  }
  const [page, badge] = raw.statements;
  assert.match(page, /ORDER BY t\.created_at DESC, t\.id DESC/);
  assert.match(badge, /count\(\*\)::int/);
});

test('runnable page ranks ids in SQL, then hydrates those rows in ranked order', async () => {
  const ranked = [
    { id: '00000000-0000-7000-8000-00000000000a' },
    { id: '00000000-0000-7000-8000-00000000000b' },
  ];
  let hydrateArgs: any;
  const raw = recordingQueryRaw((sql) => (sql.includes('count(*)') ? [{ count: 9 }] : ranked));
  const service = serviceWith({
    $queryRaw: raw.$queryRaw,
    task: {
      // findMany answers by id and, like PostgreSQL, in no particular order.
      findMany: async (args: any) => {
        hydrateArgs = args;
        return [
          { id: ranked[1].id, createdAt: new Date('2026-08-01T00:00:00.000Z') },
          { id: ranked[0].id, createdAt: new Date('2026-08-02T00:00:00.000Z') },
        ];
      },
      count: async () => 0,
      groupBy: async () => [],
    },
    session: { groupBy: async () => [] },
    taskDependency: { findMany: async () => [] },
  });

  const result = await service.listPage(OWNER_ID, { status: 'RUNNABLE' });

  assert.deepEqual(hydrateArgs.where, { id: { in: [ranked[0].id, ranked[1].id] } });
  assert.equal(hydrateArgs.select.description, undefined);
  assert.deepEqual(
    result.items.map((item: any) => item.id),
    [ranked[0].id, ranked[1].id],
  );
});

test('runnable tab counts the runnable predicate once and reuses it as the filtered total', async () => {
  const raw = recordingQueryRaw(() => [{ count: 42 }]);
  const prismaCounts: any[] = [];
  const service = serviceWith({
    $queryRaw: raw.$queryRaw,
    task: {
      findMany: async () => [],
      count: async (args: any) => {
        prismaCounts.push(args.where);
        return 0;
      },
      groupBy: async () => [],
    },
  });

  const result = await service.listPage(OWNER_ID, { status: 'RUNNABLE' });

  // Two raw statements: the page ranking and ONE badge count — not one per number.
  assert.equal(raw.statements.filter((sql) => sql.includes('count(*)')).length, 1);
  assert.equal(result.total, 42);
  assert.equal(result.counts?.runnable, 42);
  // The running/queued tallies are unrelated to the Ready predicate and still run.
  assert.equal(prismaCounts.length, 2);
});

test('counts=none returns the page without the aggregate block', async () => {
  const raw = recordingQueryRaw(() => [{ count: 7 }]);
  const prismaCounts: any[] = [];
  let groupByCalls = 0;
  const service = serviceWith({
    $queryRaw: raw.$queryRaw,
    task: {
      findMany: async () => [],
      count: async (args: any) => {
        prismaCounts.push(args.where);
        return 0;
      },
      groupBy: async () => {
        groupByCalls += 1;
        return [];
      },
    },
  });

  const result = await service.listPage(OWNER_ID, { counts: 'none' });

  assert.deepEqual(result, { items: [], nextCursor: null });
  assert.equal(groupByCalls, 0);
  assert.equal(prismaCounts.length, 0);
  assert.equal(raw.statements.length, 0);
  await assert.rejects(() => service.listPage(OWNER_ID, { counts: 'all' }), /counts must be/);
});

test('running filter is applied before pagination from live session state', async () => {
  let findManyWhere: any;
  const service = serviceWith({
    $queryRaw: recordingQueryRaw(() => [{ count: 0 }]).$queryRaw,
    task: {
      findMany: async (args: any) => {
        findManyWhere = args.where;
        return [];
      },
      count: async () => 0,
      groupBy: async () => [],
    },
  });

  await service.listPage(OWNER_ID, { status: 'RUNNING' });

  assert.deepEqual(findManyWhere, {
    ownerId: OWNER_ID,
    sessions: { some: { status: RunStatus.RUNNING } },
  });
});

test('paged list rejects invalid bounds and filters before querying Prisma', async () => {
  const service = serviceWith({});
  await assert.rejects(() => service.listPage(OWNER_ID, { limit: 201 }), /limit must be/);
  await assert.rejects(() => service.listPage(OWNER_ID, { status: 'UNKNOWN' }), /invalid task status/);
  await assert.rejects(() => service.listPage(OWNER_ID, { cursor: 'not-a-cursor' }), /invalid task cursor/);
});
