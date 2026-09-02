import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import { TasksService } from './tasks.service';
import { recordingQueryRaw } from './query-raw-test-helper';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';

function serviceWith(prisma: unknown): TasksService {
  return new TasksService(prisma as never, {} as never, {} as never);
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
  const raw = recordingQueryRaw((sql) =>
    sql.includes('count(*)') ? [{ count: 3 }] : rows.map(({ id }) => ({ id })),
  );
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
  // Filtered total + running + queued stay Prisma counts. Raw SQL is exactly one scope-wide Ready
  // badge plus one bounded overlay for every row on this page — never one query per row.
  assert.equal(countWheres.length, 3);
  assert.equal(raw.statements.length, 2);
  assert.equal(raw.statements.filter(({ text }) => /count\(\*\)::int/.test(text)).length, 1);
  assert.equal(raw.statements.filter(({ text }) => /t\.id IN \(/.test(text)).length, 1);
  assert.deepEqual(
    raw.statements.map(({ invocation }) => invocation),
    ['tagged-template', 'sql-object'],
  );
});

test('runnable filter is applied before pagination with the same rules as the Run action', async () => {
  const raw = recordingQueryRaw(() => []);
  const service = serviceWith({
    $queryRaw: raw.$queryRaw,
    task: { findMany: async () => [], count: async () => 0, groupBy: async () => [] },
  });

  await service.listPage(OWNER_ID, { status: 'RUNNABLE' });

  // The page ranking and the badge count must both gate on the Run-button conditions: not
  // finished or paused, assigned to an enabled workspace with a runner, no work run already in
  // flight, no outstanding prerequisite, and no aggregate-only parent. Spelled as NOT EXISTS so
  // PostgreSQL can short-circuit per row.
  assert.equal(raw.statements.length, 2);
  for (const { text: sql } of raw.statements) {
    assert.match(sql, /t\.owner_id = \$\d+::uuid/);
    assert.match(sql, /t\.status <> 'DONE'::task_status/);
    assert.match(sql, /t\.dispatch_hold = false/);
    assert.match(
      sql,
      /EXISTS \([\s\S]*FROM workspace a[\s\S]*a\.runner_id IS NOT NULL[\s\S]*a\.enabled = true/,
    );
    assert.match(
      sql,
      /NOT EXISTS \([\s\S]*FROM session s[\s\S]*s\.deleted_at IS NULL[\s\S]*s\.starts_task_work = true[\s\S]*'PENDING'::run_status, 'RUNNING'::run_status/,
    );
    // A missing/cross-owner/cyclic tail returns NULL. The inner NOT EXISTS then remains true and
    // the outer anti-join blocks the task, so malformed dependency data cannot fail open.
    assert.match(
      sql,
      /NOT EXISTS \(\s*SELECT 1 FROM task_dependency dep[\s\S]*AND NOT EXISTS \(\s*SELECT 1\s*FROM task chain_task[\s\S]*chain_task\.id = task_dependency_tail_id\(dep\.depends_on_task_id\)[\s\S]*chain_task\.status = 'DONE'/,
    );
    // A DONE tail releases only inside the current verification epoch and scope.
    assert.match(sql, /epoch_any\."owner_id" = epoch_any_subject\."owner_id"/);
    assert.match(sql, /epoch_any\."project_id" IS NOT DISTINCT FROM epoch_any_subject\."project_id"/);
    // The two request clauses here — an OPEN request closing an older PASS, and a DECIDED PASS
    // standing in for the check's own facts — went with `task_judgment_request` on 2026-09-02.
    // A check's own status, verdict, settled run and applied ledger action are the whole predicate
    // now, which is what the surviving clauses below assert.
    assert.doesNotMatch(sql, /task_judgment_request/);
    assert.match(sql, /epoch_check\."verdict" = 'PASS'/);
    assert.match(sql, /epoch_check\."verdict_revision" > 0/);
    // Legacy PASS remains fail-closed on live/successful run evidence and application in-project.
    assert.match(
      sql,
      /NOT EXISTS \(\s*SELECT 1 FROM "session" passed_live[\s\S]*passed_live\."status"::text IN \('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'\)/,
    );
    assert.match(
      sql,
      /AND EXISTS \(\s*SELECT 1 FROM "session" passed_run[\s\S]*passed_run\."status"::text = 'SUCCEEDED'[\s\S]*passed_run\."end_reason" = 'task_done'/,
    );
    assert.match(
      sql,
      /epoch_check\."project_id" IS NULL OR EXISTS \(\s*SELECT 1 FROM "project_action" passed_action[\s\S]*passed_action\."status"::text = 'APPLIED'/,
    );
    assert.match(sql, /t\.completion_policy = 'MANUAL'::task_completion_policy/);
    assert.match(sql, /aggregate_child\.parent_task_id = t\.id/);
  }
  const [page, badge] = raw.statements;
  assert.match(page.text, /ORDER BY t\.created_at DESC, t\.id DESC/);
  assert.match(badge.text, /count\(\*\)::int/);
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
  assert.equal(raw.statements.filter(({ text }) => text.includes('count(*)')).length, 1);
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
