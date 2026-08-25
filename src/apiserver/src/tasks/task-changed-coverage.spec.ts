import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService, TASK_CHANGED_MAX_ROWS } from './tasks.service';

const OWNER = '550e8400-e29b-41d4-a716-446655440000';
const TASK = '550e8400-e29b-41d4-a716-446655440001';
const PARENT = '550e8400-e29b-41d4-a716-446655440002';
const DEPENDENT = '550e8400-e29b-41d4-a716-446655440003';

type AffectedRow = { id: string | null; requiresResync: boolean };

function fixture(answer: AffectedRow[] | Error) {
  const published: unknown[][] = [];
  let sql = '';
  const prisma = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      sql = strings.join('?');
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const service = new TasksService(prisma as never, {} as never, {
    publishForUser: (...args: unknown[]) => void published.push(args),
  } as never);
  (service as unknown as { logger: unknown }).logger = {
    warn: () => undefined,
    error: () => undefined,
    log: () => undefined,
  };
  return {
    published,
    sql: () => sql,
    publishAffected: (
      direct: Array<string | null | undefined>,
      facts: Array<string | null | undefined>,
    ) => (service as unknown as {
      publishAffectedTaskRows(
        ownerId: string,
        directIds: Array<string | null | undefined>,
        factIds: Array<string | null | undefined>,
      ): Promise<void>;
    }).publishAffectedTaskRows(OWNER, direct, facts),
    publishKnown: (ids: string[]) => (service as unknown as {
      publishKnownTaskRows(ownerId: string, taskIds: string[]): void;
    }).publishKnownTaskRows(OWNER, ids),
  };
}

test('dependency-fact publication includes every bounded derived row exactly once', async () => {
  const f = fixture([
    { id: null, requiresResync: false },
    { id: DEPENDENT, requiresResync: false },
    { id: TASK, requiresResync: false },
  ]);

  await f.publishAffected([TASK, PARENT, TASK], [TASK]);

  assert.deepEqual(f.published, [[
    OWNER,
    'task_changed',
    { taskIds: [TASK, PARENT, DEPENDENT], resync: false },
  ]]);
  assert.doesNotMatch(f.sql(), /ORDER BY/i, 'the overflow cap must not hide a full sort');
  assert.doesNotMatch(f.sql(), /WITH RECURSIVE/i, 'a reverse supersession fan-out resyncs');
  assert.match(f.sql(), /family_probe[\s\S]*LIMIT \?/i, 'the family CTE itself is capped');
});

test('a reverse supersession-chain dependency is conservatively a resync', async () => {
  const f = fixture([{ id: null, requiresResync: true }]);

  await f.publishAffected([TASK], [TASK]);

  assert.deepEqual(f.published, [[
    OWNER,
    'task_changed',
    { taskIds: [], resync: true },
  ]]);
});

test('an over-budget dependency fan-out is never truncated into an incremental event', async () => {
  const rows = Array.from({ length: TASK_CHANGED_MAX_ROWS + 1 }, (_, index) => ({
    id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
    requiresResync: false,
  }));
  const f = fixture([{ id: null, requiresResync: false }, ...rows]);

  await f.publishAffected([TASK], [TASK]);

  assert.deepEqual(f.published[0], [
    OWNER,
    'task_changed',
    { taskIds: [], resync: true },
  ]);
});

test('a failed completeness read fails closed to resync', async () => {
  const f = fixture(new Error('database unavailable'));

  await f.publishAffected([TASK], [TASK]);

  assert.deepEqual(f.published, [[
    OWNER,
    'task_changed',
    { taskIds: [], resync: true },
  ]]);
});

test('a known bulk set over the wire budget resyncs instead of slicing ids', () => {
  const f = fixture([]);
  const ids = Array.from({ length: TASK_CHANGED_MAX_ROWS + 1 }, (_, index) =>
    `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`);

  f.publishKnown(ids);

  assert.deepEqual(f.published, [[
    OWNER,
    'task_changed',
    { taskIds: [], resync: true },
  ]]);
});

test('an over-budget fact seed set resyncs without starting an expansion query', async () => {
  const f = fixture([]);
  const ids = Array.from({ length: TASK_CHANGED_MAX_ROWS + 1 }, (_, index) =>
    `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`);

  await f.publishAffected([TASK], ids);

  assert.equal(f.sql(), '');
  assert.deepEqual(f.published, [[
    OWNER,
    'task_changed',
    { taskIds: [], resync: true },
  ]]);
});

test('batch assignment publishes every bounded row it actually changed', async () => {
  const published: unknown[][] = [];
  const tx = {
    $queryRaw: async () => [{ id: OWNER }],
    task: { updateMany: async () => ({ count: 2 }) },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  const service = new TasksService(prisma, {} as never, {
    publishForUser: (...args: unknown[]) => void published.push(args),
  } as never);
  (service as unknown as {
    assertOwnedWorkspace(ownerId: string, workspaceId?: string | null): Promise<void>;
  }).assertOwnedWorkspace = async () => undefined;

  assert.deepEqual(await service.batchAssign(OWNER, [PARENT, TASK], null), { updated: 2 });
  assert.deepEqual(published, [[
    OWNER,
    'task_changed',
    { taskIds: [TASK, PARENT], resync: false },
  ]]);
});

test('a partial batch assignment fails closed instead of disclosing matching ids', async () => {
  const published: unknown[][] = [];
  const tx = {
    $queryRaw: async () => [{ id: OWNER }],
    task: { updateMany: async () => ({ count: 1 }) },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  const service = new TasksService(prisma, {} as never, {
    publishForUser: (...args: unknown[]) => void published.push(args),
  } as never);
  (service as unknown as {
    assertOwnedWorkspace(ownerId: string, workspaceId?: string | null): Promise<void>;
  }).assertOwnedWorkspace = async () => undefined;

  assert.deepEqual(await service.batchAssign(OWNER, [TASK, PARENT], null), { updated: 1 });
  assert.deepEqual(published, [[
    OWNER,
    'task_changed',
    { taskIds: [], resync: true },
  ]]);
});

test('removing a comment publishes the row whose comment tally changed', async () => {
  const published: unknown[][] = [];
  const prisma = {
    taskComment: {
      findFirst: async () => ({ id: 'comment-1' }),
      delete: async () => ({ id: 'comment-1' }),
    },
  } as never;
  const service = new TasksService(prisma, {} as never, {
    publishForUser: (...args: unknown[]) => void published.push(args),
  } as never);
  (service as unknown as {
    loadDetail(ownerId: string, taskId: string): Promise<unknown>;
  }).loadDetail = async () => ({ id: TASK });

  assert.deepEqual(await service.removeComment(OWNER, TASK, 'comment-1'), { ok: true });
  assert.deepEqual(published, [[
    OWNER,
    'task_changed',
    { taskIds: [TASK], resync: false },
  ]]);
});
