import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { TasksService } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';

function serviceWith(prisma: unknown): TasksService {
  return new TasksService(prisma as never, {} as never, {} as never);
}

/**
 * Counts the aggregate queries a request actually issues.
 *
 * The scope-wide block is four of them (a groupBy, two session counts and the runnable
 * predicate) over the owner's whole task table, and it returns the same numbers whatever tab is
 * open — so the point of `counts=total` is that those four do not run.
 */
function harness() {
  const calls = { groupBy: 0, counts: 0, raw: 0 };
  const prisma = {
    task: {
      findMany: async () => [],
      count: async () => {
        calls.counts += 1;
        return 7;
      },
      groupBy: async () => {
        calls.groupBy += 1;
        return [];
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...bound: unknown[]) => {
      calls.raw += 1;
      Prisma.sql(strings, ...(bound as never[]));
      return [{ count: 3 }];
    },
    session: { groupBy: async () => [] },
    taskDependency: { findMany: async () => [] },
  };
  return { service: serviceWith(prisma), calls };
}

test('the default still answers with both the filtered total and the scope counts', async () => {
  const { service, calls } = harness();

  const page = await service.listPage(OWNER_ID);

  assert.ok(page.counts, 'counts present');
  assert.equal(typeof page.total, 'number');
  assert.equal(calls.groupBy, 1, 'the status groupBy ran');
});

test('counts=total keeps the filtered total and skips the scope aggregates', async () => {
  const { service, calls } = harness();

  const page = await service.listPage(OWNER_ID, { counts: 'total' });

  assert.equal(typeof page.total, 'number', 'total is what a tab still needs');
  assert.equal((page as { counts?: unknown }).counts, undefined);
  // The four scope aggregates are the whole cost being avoided.
  assert.equal(calls.groupBy, 0, 'no status groupBy');
  assert.equal(calls.raw, 0, 'no runnable predicate');
});

test('counts=total on Ready returns the authoritative runnable total, not page length', async () => {
  const { service, calls } = harness();

  const page = await service.listPage(OWNER_ID, { status: 'RUNNABLE', counts: 'total' });

  assert.equal(page.items.length, 0);
  assert.equal(page.total, 3);
  // One query ranks the Ready page; the second counts every matching row in the scope.
  assert.equal(calls.raw, 2);
});

test('counts=none drops both, as paging needs neither', async () => {
  const { service, calls } = harness();

  const page = await service.listPage(OWNER_ID, { counts: 'none' });

  assert.equal((page as { total?: unknown }).total, undefined);
  assert.equal((page as { counts?: unknown }).counts, undefined);
  assert.equal(calls.groupBy, 0);
  assert.equal(calls.counts, 0, 'not even the filtered count');
});

test('an unknown counts mode is rejected rather than silently treated as the default', async () => {
  const { service } = harness();
  await assert.rejects(() => service.listPage(OWNER_ID, { counts: 'some' }));
});

test('the standalone counts endpoint reads the scope, never the tab', async () => {
  const { service, calls } = harness();

  const counts = await service.taskCounts(OWNER_ID, { labels: 'CC-MAIN-2017-34' });

  assert.equal(calls.groupBy, 1);
  assert.equal(typeof counts.total, 'number');
  assert.equal(typeof counts.runnable, 'number');
});
