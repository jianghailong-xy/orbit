import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RunStatus } from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const FOCUS = '550e8400-e29b-41d4-a716-446655440000';
const TASK_B = '550e8400-e29b-41d4-a716-446655440001';
const TASK_C = '550e8400-e29b-41d4-a716-446655440002';
const TASK_D = '550e8400-e29b-41d4-a716-446655440003';
const TASK_E = '550e8400-e29b-41d4-a716-446655440004';

type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  autoRunWhenReady: boolean;
};

type StoredEdge = { taskId: string; dependsOnTaskId: string };

const tasks = new Map<string, TaskRow>([
  [FOCUS, { id: FOCUS, title: 'Focus', status: TaskStatus.OPEN, autoRunWhenReady: true }],
  [TASK_B, { id: TASK_B, title: 'B', status: TaskStatus.DONE, autoRunWhenReady: true }],
  [TASK_C, { id: TASK_C, title: 'C', status: TaskStatus.OPEN, autoRunWhenReady: false }],
  [TASK_D, { id: TASK_D, title: 'D', status: TaskStatus.DONE, autoRunWhenReady: true }],
  [TASK_E, { id: TASK_E, title: 'E', status: TaskStatus.FAILED, autoRunWhenReady: true }],
]);

const diamondEdges: StoredEdge[] = [
  // Stored as dependent -> prerequisite.
  { taskId: FOCUS, dependsOnTaskId: TASK_B },
  { taskId: FOCUS, dependsOnTaskId: TASK_C },
  { taskId: TASK_B, dependsOnTaskId: TASK_D },
  { taskId: TASK_C, dependsOnTaskId: TASK_D },
  { taskId: TASK_C, dependsOnTaskId: TASK_E },
];

function graphFixture(edges: StoredEdge[] = diamondEdges, ownsFocus = true) {
  const traversalBatches: string[][] = [];
  const stateBatches: string[][] = [];
  const boundaryChecks: string[][] = [];
  const traversalWheres: any[] = [];
  const traversalTakes: number[] = [];
  let focusLookup: any;
  let busyWhere: any;

  const prisma = {
    task: {
      findFirst: async (args: any) => {
        focusLookup = args;
        return ownsFocus && args.where.ownerId === OWNER_ID ? tasks.get(args.where.id) ?? null : null;
      },
    },
    taskDependency: {
      findMany: async (args: any) => {
        const ids = args.where.taskId.in as string[];
        // Traversal selects full task metadata. Keep the fallback branch to fail loudly if a
        // future change starts materializing status rows again instead of using groupBy counts.
        if (args.select.dependsOnTask.select.id) {
          traversalBatches.push([...ids]);
          traversalWheres.push(args.where);
          traversalTakes.push(args.take);
          return edges
            .filter((edge) => ids.includes(edge.taskId))
            .map((edge) => ({
              ...edge,
              dependsOnTask: tasks.get(edge.dependsOnTaskId),
            }));
        }
        stateBatches.push([...ids]);
        return edges
          .filter((edge) => ids.includes(edge.taskId))
          .map((edge) => ({
            taskId: edge.taskId,
            dependsOnTask: { status: tasks.get(edge.dependsOnTaskId)?.status },
          }));
      },
      groupBy: async (args: any) => {
        const ids = args.where.taskId.in as string[];
        stateBatches.push([...ids]);
        const status = args.where.dependsOnTask?.status;
        const allowedStatuses =
          typeof status === 'string'
            ? new Set([status])
            : status?.in
              ? new Set(status.in as string[])
              : null;
        const counts = new Map<string, number>();
        for (const edge of edges) {
          if (!ids.includes(edge.taskId)) continue;
          const prerequisiteStatus = tasks.get(edge.dependsOnTaskId)?.status;
          if (allowedStatuses && (!prerequisiteStatus || !allowedStatuses.has(prerequisiteStatus))) {
            continue;
          }
          counts.set(edge.taskId, (counts.get(edge.taskId) ?? 0) + 1);
        }
        return [...counts].map(([taskId, count]) => ({ taskId, _count: { _all: count } }));
      },
      count: async (args: any) => {
        const ids = args.where.taskId.in as string[];
        boundaryChecks.push([...ids]);
        return edges.filter((edge) => ids.includes(edge.taskId)).length;
      },
    },
    session: {
      groupBy: async (args: any) => {
        busyWhere = args.where;
        return [
          { taskId: TASK_B, status: RunStatus.RUNNING, _count: { _all: 1 } },
          { taskId: TASK_C, status: RunStatus.PENDING, _count: { _all: 1 } },
        ];
      },
    },
  };

  return {
    service: new TasksService(prisma as never, {} as never, {} as never),
    traversalBatches,
    stateBatches,
    boundaryChecks,
    traversalWheres,
    traversalTakes,
    focusLookup: () => focusLookup,
    busyWhere: () => busyWhere,
  };
}

test('dependency graph is exposed as an owner-scoped GET route and forwards its bounds', async () => {
  const seen: any[] = [];
  const expected = { focusTaskId: FOCUS, nodes: [], edges: [] };
  const controller = new TasksController({
    dependencyGraph: async (...args: any[]) => {
      seen.push(...args);
      return expected;
    },
  } as never);

  const result = await controller.dependencyGraph(
    { userId: OWNER_ID, email: 'owner@example.com' },
    FOCUS,
    'upstream',
    '4',
    '50',
  );

  assert.equal(result, expected);
  assert.deepEqual(seen, [OWNER_ID, FOCUS, { direction: 'upstream', maxDepth: '4', maxNodes: '50' }]);
  const handler = TasksController.prototype.dependencyGraph;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), ':id/dependency-graph');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);
});

test('multi-level graph deduplicates diamond nodes and orients every edge prerequisite-first', async () => {
  const fixture = graphFixture();

  const result = await fixture.service.dependencyGraph(OWNER_ID, FOCUS);

  assert.deepEqual(
    result.nodes.map(({ id, depth, dependencyState, running, queued }) => ({
      id,
      depth,
      dependencyState,
      running,
      queued,
    })),
    [
      { id: FOCUS, depth: 0, dependencyState: 'BLOCKED', running: false, queued: false },
      { id: TASK_B, depth: 1, dependencyState: 'READY', running: true, queued: false },
      { id: TASK_C, depth: 1, dependencyState: 'BLOCKED_FAILED', running: false, queued: true },
      { id: TASK_D, depth: 2, dependencyState: 'NONE', running: false, queued: false },
      { id: TASK_E, depth: 2, dependencyState: 'NONE', running: false, queued: false },
    ],
  );
  assert.deepEqual(result.edges, [
    { sourceTaskId: TASK_B, targetTaskId: FOCUS },
    { sourceTaskId: TASK_C, targetTaskId: FOCUS },
    { sourceTaskId: TASK_D, targetTaskId: TASK_B },
    { sourceTaskId: TASK_D, targetTaskId: TASK_C },
    { sourceTaskId: TASK_E, targetTaskId: TASK_C },
  ]);
  assert.deepEqual(result.counts, {
    upstream: 4,
    total: 5,
    done: 2,
    remaining: 1,
    failed: 1,
  });
  assert.equal(result.maxDepth, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.limits, { maxDepth: 8, maxNodes: 100, maxEdges: 400 });

  // One traversal query per breadth-first layer, not one per task.
  assert.deepEqual(fixture.traversalBatches, [[FOCUS], [TASK_B, TASK_C], [TASK_D, TASK_E]]);
  assert.deepEqual(fixture.traversalTakes, [401, 399, 396]);
  assert.equal(fixture.stateBatches.length, 3);
  assert.ok(
    fixture.stateBatches.every(
      (batch) =>
        batch.length === 5 &&
        new Set(batch).size === 5 &&
        [FOCUS, TASK_B, TASK_C, TASK_D, TASK_E].every((id) => batch.includes(id)),
    ),
  );
  assert.ok(
    fixture.traversalWheres.every(
      (where) => where.task.ownerId === OWNER_ID && where.dependsOnTask.ownerId === OWNER_ID,
    ),
  );
  assert.equal(fixture.busyWhere().ownerId, OWNER_ID);
  assert.deepEqual(
    new Set(fixture.busyWhere().taskId.in),
    new Set([FOCUS, TASK_B, TASK_C, TASK_D, TASK_E]),
  );
});

test('depth and node limits report only genuinely hidden upstream work as truncated', async () => {
  const depthLimited = graphFixture();
  const depthResult = await depthLimited.service.dependencyGraph(OWNER_ID, FOCUS, {
    maxDepth: '1',
  });
  assert.deepEqual(depthResult.nodes.map((node) => node.id), [FOCUS, TASK_B, TASK_C]);
  assert.deepEqual(depthLimited.boundaryChecks, [[TASK_B, TASK_C]]);
  assert.equal(depthResult.maxDepth, 1);
  assert.equal(depthResult.truncated, true);

  const nodeLimited = graphFixture();
  const nodeResult = await nodeLimited.service.dependencyGraph(OWNER_ID, FOCUS, {
    maxNodes: 3,
  });
  assert.deepEqual(nodeResult.nodes.map((node) => node.id), [FOCUS, TASK_B, TASK_C]);
  assert.deepEqual(nodeResult.edges, [
    { sourceTaskId: TASK_B, targetTaskId: FOCUS },
    { sourceTaskId: TASK_C, targetTaskId: FOCUS },
  ]);
  assert.equal(nodeResult.maxDepth, 1);
  assert.equal(nodeResult.truncated, true);
  assert.deepEqual(nodeLimited.boundaryChecks, []);

  const completeAtBoundary = graphFixture([
    { taskId: FOCUS, dependsOnTaskId: TASK_B },
  ]);
  const completeResult = await completeAtBoundary.service.dependencyGraph(OWNER_ID, FOCUS, {
    maxDepth: 1,
  });
  assert.deepEqual(completeAtBoundary.boundaryChecks, [[TASK_B]]);
  assert.equal(completeResult.truncated, false);
});

test('graph rejects invalid input and never exposes a non-owned focus task', async () => {
  const invalid = graphFixture();
  await assert.rejects(() => invalid.service.dependencyGraph(OWNER_ID, 'not-a-uuid'), /task not found/);
  await assert.rejects(
    () => invalid.service.dependencyGraph(OWNER_ID, FOCUS, { direction: 'downstream' }),
    /direction must be upstream/,
  );
  await assert.rejects(
    () => invalid.service.dependencyGraph(OWNER_ID, FOCUS, { maxDepth: 0 }),
    /maxDepth must be/,
  );
  await assert.rejects(
    () => invalid.service.dependencyGraph(OWNER_ID, FOCUS, { maxNodes: 501 }),
    /maxNodes must be/,
  );
  assert.equal(invalid.focusLookup(), undefined);

  const notOwned = graphFixture(diamondEdges, false);
  await assert.rejects(() => notOwned.service.dependencyGraph(OWNER_ID, FOCUS), /task not found/);
  assert.deepEqual(notOwned.focusLookup().where, { id: FOCUS, ownerId: OWNER_ID });
  assert.deepEqual(notOwned.traversalBatches, []);
});
