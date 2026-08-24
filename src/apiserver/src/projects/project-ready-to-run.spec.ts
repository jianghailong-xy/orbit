import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { readProjectReadyToRun } from './project-ready-to-run';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const PROJECT_ID = '00000000-0000-7000-8000-000000000002';

function harness(rows: unknown[]) {
  const statements: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: async (statement: Prisma.Sql) => {
      statements.push(statement);
      return rows;
    },
  } as unknown as PrismaService;
  return { prisma, statements };
}

test('the ready queue keeps zero-impact leaves and carries the exact manual-run gates', async () => {
  const { prisma, statements } = harness([
    {
      readyCount: 4,
      impactTruncated: false,
      taskId: '00000000-0000-7000-8000-000000000011',
      title: 'Root task',
      status: 'OPEN',
      downstreamBlocked: 9,
    },
    {
      readyCount: 4,
      impactTruncated: false,
      taskId: '00000000-0000-7000-8000-000000000012',
      title: 'Runnable leaf',
      status: 'OPEN',
      downstreamBlocked: 0,
    },
  ]);

  const result = await readProjectReadyToRun(prisma, OWNER_ID, PROJECT_ID, 5);

  assert.equal(result.readyCount, 4, 'the total is not truncated to the two returned rows');
  assert.deepEqual(
    result.items.map(({ title, downstreamBlocked }) => [title, downstreamBlocked]),
    [
      ['Root task', 9],
      ['Runnable leaf', 0],
    ],
  );
  assert.equal(result.impactTruncated, null);

  assert.equal(statements.length, 1);
  const [{ text, values }] = statements;
  assert.ok(values.includes(OWNER_ID));
  assert.ok(values.includes(PROJECT_ID));
  assert.ok(values.includes(5));
  assert.match(text, /t\.status <> 'DONE'::task_status/);
  assert.match(text, /t\.dispatch_hold = false/);
  assert.match(text, /a\.runner_id IS NOT NULL/);
  assert.match(text, /a\.enabled = true/);
  assert.match(text, /s\.deleted_at IS NULL/);
  assert.match(text, /s\.starts_task_work = true/);
  assert.match(text, /s\.status IN \('PENDING'::run_status, 'RUNNING'::run_status\)/);
  assert.match(text, /NOT EXISTS \(\s*SELECT 1 FROM task_dependency dep/);
  assert.match(text, /t\.completion_policy = 'MANUAL'::task_completion_policy/);
  assert.match(text, /aggregate_child\.parent_task_id = t\.id/);
  assert.match(text, /LEFT JOIN reach ON reach\.root = candidate\.id/);
  assert.match(text, /count\(DISTINCT reach\.node\)::int/);
  assert.match(text, /ORDER BY "downstreamBlocked" DESC, candidate\.title ASC/);
});

test('an empty queue preserves its count row and returns no fake task', async () => {
  const { prisma } = harness([
    {
      readyCount: 0,
      impactTruncated: false,
      taskId: null,
      title: null,
      status: null,
      downstreamBlocked: null,
    },
  ]);

  const result = await readProjectReadyToRun(prisma, OWNER_ID, PROJECT_ID, 5);

  assert.deepEqual(result, { readyCount: 0, items: [], impactTruncated: null });
});

test('a truncated impact walk leaves ready rows runnable and reports why ranking is absent', async () => {
  const { prisma } = harness([
    {
      readyCount: 1,
      impactTruncated: true,
      taskId: '00000000-0000-7000-8000-000000000013',
      title: 'Still runnable',
      status: 'OPEN',
      downstreamBlocked: null,
    },
  ]);

  const result = await readProjectReadyToRun(prisma, OWNER_ID, PROJECT_ID, 5);

  assert.equal(result.items[0].title, 'Still runnable');
  assert.equal(result.items[0].downstreamBlocked, null);
  assert.deepEqual(result.impactTruncated, {
    reason: 'TOO_MANY_UNFINISHED_TASKS',
    maxTasks: 2000,
  });
});
