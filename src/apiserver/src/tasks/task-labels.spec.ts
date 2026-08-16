import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import { TasksService, normalizeTaskLabels, parseLabelsQuery } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const LIST_ID = '00000000-0000-7000-8000-0000000000aa';
const TASK_ID = '00000000-0000-7000-8000-0000000000b1';

function serviceWith(prisma: unknown): TasksService {
  return new TasksService(prisma as never, {} as never, {} as never);
}

/** Same recorder as task-list-pagination.spec: renders the tagged template PostgreSQL would get. */
function recordingQueryRaw(rows: (sql: string) => unknown[]) {
  const statements: string[] = [];
  const $queryRaw = async (strings: TemplateStringsArray, ...bound: unknown[]) => {
    const sql = Prisma.sql(strings, ...(bound as never[])).text;
    statements.push(sql);
    return rows(sql);
  };
  return { statements, $queryRaw };
}

test('stored labels are trimmed and deduplicated, keeping order and case', () => {
  assert.deepEqual(
    normalizeTaskLabels([' CC-MAIN-2017-34 ', 'shard-002', 'CC-MAIN-2017-34', '', '   ']),
    ['CC-MAIN-2017-34', 'shard-002'],
  );
  // Case is a fact about the label, not noise: folding would make the stored value differ from
  // the snapshot id it names.
  assert.deepEqual(normalizeTaskLabels(['CC-MAIN-2017-34', 'cc-main-2017-34']), [
    'CC-MAIN-2017-34',
    'cc-main-2017-34',
  ]);
});

test('label filters accept both comma-separated and repeated query parameters', () => {
  assert.deepEqual(parseLabelsQuery('a, b ,,a'), ['a', 'b']);
  // Repetition is the only way to send a label containing a comma.
  assert.deepEqual(parseLabelsQuery(['one,two', 'three']), ['one,two', 'three']);
  assert.deepEqual(parseLabelsQuery(undefined), []);
});

test('create stores the normalized labels it was given', async () => {
  let created: any;
  const service = serviceWith({
    task: {
      create: async (args: any) => {
        created = args.data;
        return { id: TASK_ID, ...args.data };
      },
    },
    taskList: { findMany: async () => [] },
  });

  await service.create(OWNER_ID, {
    title: 'ingest shard',
    labels: ['CC-MAIN-2017-34', ' CC-MAIN-2017-34 ', 'shard-002'],
  } as any);

  assert.deepEqual(created.labels, ['CC-MAIN-2017-34', 'shard-002']);
});

test('create without labels leaves the column at its default rather than writing []', async () => {
  let created: any;
  const service = serviceWith({
    task: {
      create: async (args: any) => {
        created = args.data;
        return { id: TASK_ID, ...args.data };
      },
    },
    taskList: { findMany: async () => [] },
  });

  await service.create(OWNER_ID, { title: 'no labels' } as any);

  assert.equal(created.labels, undefined);
});

test('update replaces the whole label set, and [] clears it', async () => {
  const writes: any[] = [];
  const service = serviceWith({
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        ownerId: OWNER_ID,
        status: TaskStatus.OPEN,
        labels: ['stale'],
        comments: [],
        sessions: [],
        dependsOn: [],
        dependedOnBy: [],
      }),
      update: async (args: any) => {
        writes.push(args.data);
        return { id: TASK_ID };
      },
      count: async () => 0,
    },
    taskDependency: { findMany: async () => [] },
  });

  await service.update(OWNER_ID, TASK_ID, { labels: ['a', 'a', ' b '] } as any);
  assert.deepEqual(writes[0].labels, ['a', 'b']);

  // Omitted means "leave them alone" — a merge would leave no way to remove one.
  await service.update(OWNER_ID, TASK_ID, { title: 'renamed' } as any);
  assert.equal(writes[1].labels, undefined);

  await service.update(OWNER_ID, TASK_ID, { labels: [] } as any);
  assert.deepEqual(writes[2].labels, []);
});

test('a label filter narrows the tab badges, not just the page', async () => {
  const countWheres: any[] = [];
  let groupByWhere: any;
  const service = serviceWith({
    $queryRaw: recordingQueryRaw(() => [{ count: 0 }]).$queryRaw,
    task: {
      findMany: async () => [],
      count: async (args: any) => {
        countWheres.push(args.where);
        return 0;
      },
      groupBy: async (args: any) => {
        groupByWhere = args.where;
        return [];
      },
    },
    session: { groupBy: async () => [] },
    taskDependency: { findMany: async () => [] },
  });

  await service.listPage(OWNER_ID, { labels: 'CC-MAIN-2017-34' });

  // The counts describe the scope. If the label only narrowed the page, "how far along is this
  // batch" would be answered with the whole owner's totals while looking like it had been.
  assert.deepEqual(groupByWhere.labels, { hasEvery: ['CC-MAIN-2017-34'] });
  for (const where of countWheres) {
    assert.deepEqual(where.labels, { hasEvery: ['CC-MAIN-2017-34'] });
  }
});

test('multiple labels require all of them, not any', async () => {
  let groupByWhere: any;
  const service = serviceWith({
    $queryRaw: recordingQueryRaw(() => [{ count: 0 }]).$queryRaw,
    task: {
      findMany: async () => [],
      count: async () => 0,
      groupBy: async (args: any) => {
        groupByWhere = args.where;
        return [];
      },
    },
    session: { groupBy: async () => [] },
    taskDependency: { findMany: async () => [] },
  });

  await service.listPage(OWNER_ID, { labels: 'CC-MAIN-2017-34,shard-002' });

  // ANY would make adding a second label widen the result, which reads backwards.
  assert.deepEqual(groupByWhere.labels, { hasEvery: ['CC-MAIN-2017-34', 'shard-002'] });
});

test('the Ready tab applies the label filter too, in its raw SQL', async () => {
  const raw = recordingQueryRaw(() => []);
  const service = serviceWith({
    $queryRaw: raw.$queryRaw,
    task: { findMany: async () => [], count: async () => 0, groupBy: async () => [] },
  });

  await service.listPage(OWNER_ID, { status: 'RUNNABLE', labels: 'CC-MAIN-2017-34' });

  // Ready is the one scope that reaches PostgreSQL as SQL rather than as a Prisma where, so a
  // filter added only to the object form is not a type error anywhere — it just stops applying
  // on this tab. Both the page query and the badge count must carry it.
  assert.ok(raw.statements.length >= 1);
  for (const statement of raw.statements) {
    assert.match(statement, /t\.labels @> ARRAY\[\$\d+\]::text\[\]/);
  }
});

test('label summary pivots one grouped scan into per-label status counts', async () => {
  const raw = recordingQueryRaw(() => [
    { label: 'CC-MAIN-2017-34', status: TaskStatus.DONE, n: 3, labelTotal: 2 },
    { label: 'CC-MAIN-2017-34', status: TaskStatus.OPEN, n: 1, labelTotal: 2 },
    { label: 'CC-MAIN-2013-20', status: TaskStatus.FAILED, n: 2, labelTotal: 2 },
  ]);
  const service = serviceWith({ $queryRaw: raw.$queryRaw });

  const result = await service.labelSummary(OWNER_ID);

  // One statement, whatever the number of labels — that is the whole point of the column.
  assert.equal(raw.statements.length, 1);
  // Label order, so the table does not reshuffle between two refreshes as work moves.
  assert.deepEqual(
    result.items.map((item) => item.label),
    ['CC-MAIN-2013-20', 'CC-MAIN-2017-34'],
  );
  assert.deepEqual(result.items[1], {
    label: 'CC-MAIN-2017-34',
    total: 4,
    open: 1,
    inProgress: 0,
    done: 3,
    failed: 0,
    cancelled: 0,
  });
  assert.equal(result.truncated, false);
});

test('label summary reports truncation instead of looking complete', async () => {
  const raw = recordingQueryRaw(() => [
    { label: 'only-one-returned', status: TaskStatus.OPEN, n: 1, labelTotal: 900 },
  ]);
  const service = serviceWith({ $queryRaw: raw.$queryRaw });

  const result = await service.labelSummary(OWNER_ID);

  assert.equal(result.labelTotal, 900);
  assert.equal(result.truncated, true);
});

test('label summary scopes to a list when asked', async () => {
  const raw = recordingQueryRaw(() => []);
  const service = serviceWith({ $queryRaw: raw.$queryRaw });

  await service.labelSummary(OWNER_ID, { listId: LIST_ID });

  assert.match(raw.statements[0], /t\.list_id = \$\d+::uuid/);
});

test('label summary rejects a list id that is not one', async () => {
  const service = serviceWith({ $queryRaw: async () => [] });
  await assert.rejects(() => service.labelSummary(OWNER_ID, { listId: 'not-a-uuid' }));
});
