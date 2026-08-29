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
  supersededByTaskId?: string | null;
  terminalReason?: string | null;
  verifiesTaskId?: string | null;
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

function graphFixture(
  edges: StoredEdge[] = diamondEdges,
  ownsFocus = true,
  taskRows: ReadonlyMap<string, TaskRow> = tasks,
) {
  const traversalBatches: string[][] = [];
  const factBatches: string[][] = [];
  const degreeBatches: string[][] = [];
  const successorBatches: string[][] = [];
  const successorWheres: any[] = [];
  const boundaryChecks: string[][] = [];
  const traversalWheres: any[] = [];
  const inducedWheres: any[] = [];
  const traversalTakes: number[] = [];
  let focusLookup: any;
  let nodeRefreshWhere: any;
  let busyWhere: any;

  const graphTask = (task: TaskRow) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    autoRunWhenReady: task.autoRunWhenReady,
  });
  const chainFact = (task: TaskRow) => ({
    id: task.id,
    status: task.status,
    supersededByTaskId: task.supersededByTaskId ?? null,
    terminalReason: task.terminalReason ?? null,
  });

  const prisma = {
    task: {
      findFirst: async (args: any) => {
        focusLookup = args;
        const task = taskRows.get(args.where.id);
        return ownsFocus && args.where.ownerId === OWNER_ID && task ? graphTask(task) : null;
      },
      count: async (args: any) => {
        if (args.where.ownerId !== OWNER_ID) return 0;
        return (args.where.id.in as string[]).filter((id) => taskRows.has(id)).length;
      },
      findMany: async (args: any) => {
        if (!ownsFocus || (args.where.ownerId !== undefined && args.where.ownerId !== OWNER_ID)) {
          return [];
        }
        const requested = (args.where.id?.in ?? []) as string[];
        // Verification-epoch discovery asks only for checks or checked subjects. Every task in the
        // base graph is ordinary, so do not let a permissive double turn all of them into epochs.
        if (requested.length > 0 && Array.isArray(args.where.OR) && args.select?.verifiesTaskId) {
          return requested.flatMap((id) => {
            const task = taskRows.get(id);
            if (!task) return [];
            const checked = [...taskRows.values()].some((row) => row.verifiesTaskId === id);
            return task.verifiesTaskId != null || checked
              ? [{ id: task.id, verifiesTaskId: task.verifiesTaskId ?? null }]
              : [];
          });
        }
        if (args.select?.supersededByTaskId && args.select?.terminalReason) {
          successorBatches.push([...requested]);
          successorWheres.push(args.where);
          return requested.flatMap((id) => {
            const task = taskRows.get(id);
            return task ? [chainFact(task)] : [];
          });
        }
        nodeRefreshWhere = args.where;
        return requested.flatMap((id) => {
          const task = taskRows.get(id);
          return task ? [graphTask(task)] : [];
        });
      },
    },
    taskDependency: {
      findMany: async (args: any) => {
        const matchesScalar = (value: string, filter: any): boolean => {
          if (!filter) return true;
          if (typeof filter === 'string') return value === filter;
          if (filter.in && !(filter.in as string[]).includes(value)) return false;
          if (filter.notIn && (filter.notIn as string[]).includes(value)) return false;
          return true;
        };
        const matches = (edge: StoredEdge, where: any): boolean => {
          if (where.OR && !(where.OR as any[]).some((clause) => matches(edge, clause))) return false;
          // §13.3 DEP reads the edges whose PREREQUISITE has a verification epoch, so the
          // prerequisite-row half of the filter has to be honoured here — no task in this fixture
          // is a check or is checked, which is the answer that keeps the epoch read from firing.
          if (where.dependsOnTask) {
            const prerequisite = taskRows.get(edge.dependsOnTaskId) as any;
            if (!prerequisite) return false;
            const clause = where.dependsOnTask;
            if (clause.status && prerequisite.status !== clause.status) return false;
            const hasEpoch = (test: any): boolean =>
              (test.verifiesTaskId?.not === null && prerequisite.verifiesTaskId != null)
              || (test.verifiedBy?.some !== undefined
                && edges.some((other) => other.dependsOnTaskId === edge.dependsOnTaskId
                  && (taskRows.get(other.taskId) as any)?.verifiesTaskId === edge.dependsOnTaskId));
            if (clause.OR && !(clause.OR as any[]).some(hasEpoch)) return false;
          }
          return (
            matchesScalar(edge.taskId, where.taskId) &&
            matchesScalar(edge.dependsOnTaskId, where.dependsOnTaskId)
          );
        };
        const matchingEdges = edges.filter((edge) => matches(edge, args.where)).slice(0, args.take);

        // Traversal hydrates both endpoints. The induced-edge query below selects ids only.
        if (args.select.task?.select?.id && args.select.dependsOnTask?.select?.id) {
          const ids = args.where.OR
            ? ((args.where.OR[0].taskId?.in ?? args.where.OR[0].dependsOnTaskId?.in) as string[])
            : ((args.where.taskId?.in ?? args.where.dependsOnTaskId?.in) as
                | string[]
                | undefined);
          const directAnchor =
            typeof args.where.taskId === 'string'
              ? args.where.taskId
              : typeof args.where.dependsOnTaskId === 'string'
                ? args.where.dependsOnTaskId
                : undefined;
          traversalBatches.push(ids ? [...ids] : directAnchor ? [directAnchor] : []);
          traversalWheres.push(args.where);
          traversalTakes.push(args.take);
          return matchingEdges.map((edge) => ({
            ...edge,
            task: graphTask(taskRows.get(edge.taskId)!),
            dependsOnTask: graphTask(taskRows.get(edge.dependsOnTaskId)!),
          }));
        }
        if (args.select.dependsOnTask?.select?.status) {
          const ids = (args.where.taskId?.in ?? []) as string[];
          factBatches.push([...ids]);
          return matchingEdges.flatMap((edge) => {
            const prerequisite = taskRows.get(edge.dependsOnTaskId);
            return prerequisite
              ? [{ ...edge, dependsOnTask: chainFact(prerequisite) }]
              : [];
          });
        }
        inducedWheres.push(args.where);
        return matchingEdges;
      },
      groupBy: async (args: any) => {
        const groupedByDependent = args.by[0] === 'dependsOnTaskId';
        const ids = (groupedByDependent
          ? args.where.dependsOnTaskId.in
          : args.where.taskId.in) as string[];
        if (!groupedByDependent) degreeBatches.push([...ids]);
        const status = args.where.dependsOnTask?.status;
        const allowedStatuses =
          typeof status === 'string'
            ? new Set([status])
            : status?.in
              ? new Set(status.in as string[])
              : null;
        const counts = new Map<string, number>();
        for (const edge of edges) {
          const groupedId = groupedByDependent ? edge.dependsOnTaskId : edge.taskId;
          if (!ids.includes(groupedId)) continue;
          const prerequisiteStatus = taskRows.get(edge.dependsOnTaskId)?.status;
          if (allowedStatuses && (!prerequisiteStatus || !allowedStatuses.has(prerequisiteStatus))) {
            continue;
          }
          counts.set(groupedId, (counts.get(groupedId) ?? 0) + 1);
        }
        return [...counts].map(([id, count]) =>
          groupedByDependent
            ? { dependsOnTaskId: id, _count: { _all: count } }
            : { taskId: id, _count: { _all: count } },
        );
      },
      count: async (args: any) => {
        const ids = args.where.OR
          ? ((args.where.OR[0].taskId?.in ?? args.where.OR[0].dependsOnTaskId?.in) as string[])
          : (args.where.taskId?.in as string[] | undefined);
        if (Array.isArray(ids)) boundaryChecks.push([...ids]);
        const matchesScalar = (value: string, filter: any): boolean => {
          if (!filter) return true;
          if (typeof filter === 'string') return value === filter;
          if (filter.in && !(filter.in as string[]).includes(value)) return false;
          if (filter.notIn && (filter.notIn as string[]).includes(value)) return false;
          return true;
        };
        const matches = (edge: StoredEdge, where: any): boolean => {
          if (where.OR && !(where.OR as any[]).some((clause) => matches(edge, clause))) return false;
          return (
            matchesScalar(edge.taskId, where.taskId) &&
            matchesScalar(edge.dependsOnTaskId, where.dependsOnTaskId)
          );
        };
        return edges.filter((edge) => matches(edge, args.where)).length;
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
    factBatches,
    degreeBatches,
    successorBatches,
    successorWheres,
    boundaryChecks,
    traversalWheres,
    inducedWheres,
    traversalTakes,
    focusLookup: () => focusLookup,
    nodeRefreshWhere: () => nodeRefreshWhere,
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
  } as never, {} as never);

  const result = await controller.dependencyGraph(
    { userId: OWNER_ID, email: 'owner@example.com' },
    FOCUS,
    'both',
    '4',
    '50',
    'true',
  );

  assert.equal(result, expected);
  assert.deepEqual(seen, [
    OWNER_ID,
    FOCUS,
    { direction: 'both', maxDepth: '4', maxNodes: '50', pairUnary: 'true' },
  ]);
  const handler = TasksController.prototype.dependencyGraph;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), ':id/dependency-graph');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);
});

test('dependency graph expansion is exposed as an owner-scoped POST delta route', async () => {
  const seen: any[] = [];
  const expected = { nodes: [], edges: [], remainingCount: 0 };
  const controller = new TasksController({
    expandDependencyGraph: async (...args: any[]) => {
      seen.push(...args);
      return expected;
    },
  } as never, {} as never);
  const dto = {
    anchorTaskId: FOCUS,
    direction: 'prerequisites' as const,
    knownTaskIds: [FOCUS],
    loadedNeighborTaskIds: [],
    limit: 25,
    cursor: 'opaque',
  };

  const result = await controller.expandDependencyGraph(
    { userId: OWNER_ID, email: 'owner@example.com' },
    FOCUS,
    dto,
  );

  assert.equal(result, expected);
  assert.deepEqual(seen, [OWNER_ID, FOCUS, dto]);
  const handler = TasksController.prototype.expandDependencyGraph;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), ':id/dependency-graph/expand');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
});

test('dependency graph node refresh is exposed as an owner-scoped POST route', async () => {
  const seen: any[] = [];
  const expected = { nodes: [] };
  const controller = new TasksController({
    dependencyGraphNodes: async (...args: any[]) => {
      seen.push(...args);
      return expected;
    },
  } as never, {} as never);

  const result = await controller.dependencyGraphNodes(
    { userId: OWNER_ID, email: 'owner@example.com' },
    FOCUS,
    { taskIds: [FOCUS, TASK_B] },
  );

  assert.equal(result, expected);
  assert.deepEqual(seen, [OWNER_ID, FOCUS, [FOCUS, TASK_B]]);
  const handler = TasksController.prototype.dependencyGraphNodes;
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), ':id/dependency-graph/nodes');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.POST);
});

test('node refresh deduplicates in request order and returns current graph payloads', async () => {
  const fixture = graphFixture();
  const result = await fixture.service.dependencyGraphNodes(OWNER_ID, FOCUS, [
    FOCUS,
    TASK_B,
    TASK_B,
    TASK_C,
  ]);

  assert.deepEqual(result.nodes, [
    {
      ...tasks.get(FOCUS),
      running: false,
      queued: false,
      prerequisiteCount: 2,
      dependentCount: 0,
      dependencyState: 'BLOCKED',
    },
    {
      ...tasks.get(TASK_B),
      running: true,
      queued: false,
      prerequisiteCount: 1,
      dependentCount: 1,
      dependencyState: 'READY',
    },
    {
      ...tasks.get(TASK_C),
      running: false,
      queued: true,
      prerequisiteCount: 2,
      dependentCount: 1,
      dependencyState: 'BLOCKED_FAILED',
    },
  ]);
  assert.deepEqual(result.edges, [
    { sourceTaskId: TASK_B, targetTaskId: FOCUS },
    { sourceTaskId: TASK_C, targetTaskId: FOCUS },
  ]);
  assert.deepEqual(
    result.collapsedGroups.map(({ anchorTaskId, direction, hiddenCount }) => ({
      anchorTaskId,
      direction,
      hiddenCount,
    })),
    [
      { anchorTaskId: TASK_B, direction: 'prerequisites', hiddenCount: 1 },
      { anchorTaskId: TASK_C, direction: 'prerequisites', hiddenCount: 2 },
    ],
  );
  assert.deepEqual(result.missingTaskIds, []);
  assert.equal(result.truncatedEdges, false);
  assert.deepEqual(fixture.nodeRefreshWhere(), {
    ownerId: OWNER_ID,
    id: { in: [FOCUS, TASK_B, TASK_C] },
  });
  assert.equal(fixture.busyWhere().ownerId, OWNER_ID);
  assert.deepEqual(fixture.busyWhere().taskId.in, [FOCUS, TASK_B, TASK_C]);
});

test('node refresh validates focus and bounds while reporting non-focus missing tasks', async () => {
  const fixture = graphFixture();
  await assert.rejects(
    () => fixture.service.dependencyGraphNodes(OWNER_ID, FOCUS, [TASK_B]),
    /must include the focus task/,
  );
  await assert.rejects(
    () => fixture.service.dependencyGraphNodes(OWNER_ID, FOCUS, [FOCUS, 'not-a-uuid']),
    /must be UUIDs/,
  );
  await assert.rejects(
    () => fixture.service.dependencyGraphNodes(OWNER_ID, 'not-a-uuid', [FOCUS]),
    /task not found/,
  );
  const tooMany = Array.from(
    { length: 1_001 },
    (_, index) => `00000000-0000-7000-8003-${index.toString(16).padStart(12, '0')}`,
  );
  await assert.rejects(
    () => fixture.service.dependencyGraphNodes(OWNER_ID, tooMany[0], tooMany),
    /at most 1000 tasks/,
  );
  const unknown = '550e8400-e29b-41d4-a716-446655449999';
  const partial = await fixture.service.dependencyGraphNodes(OWNER_ID, FOCUS, [FOCUS, unknown]);
  assert.deepEqual(partial.nodes.map((node) => node.id), [FOCUS]);
  assert.deepEqual(partial.edges, []);
  assert.deepEqual(partial.missingTaskIds, [unknown]);
  assert.equal(partial.truncatedEdges, false);
  assert.deepEqual(fixture.nodeRefreshWhere(), {
    ownerId: OWNER_ID,
    id: { in: [FOCUS, unknown] },
  });

  const notOwned = graphFixture(diamondEdges, false);
  await assert.rejects(
    () => notOwned.service.dependencyGraphNodes(OWNER_ID, FOCUS, [FOCUS]),
    /task not found/,
  );
});

test('node refresh replaces added and deleted edges and exposes new dependency groups', async () => {
  const mutableEdges: StoredEdge[] = [{ taskId: FOCUS, dependsOnTaskId: TASK_B }];
  const fixture = graphFixture(mutableEdges);
  const requested = [FOCUS, TASK_B, TASK_C];

  const before = await fixture.service.dependencyGraphNodes(OWNER_ID, FOCUS, requested);
  assert.deepEqual(before.edges, [{ sourceTaskId: TASK_B, targetTaskId: FOCUS }]);

  mutableEdges.splice(0, mutableEdges.length,
    { taskId: FOCUS, dependsOnTaskId: TASK_C },
    { taskId: TASK_B, dependsOnTaskId: TASK_D },
  );
  const after = await fixture.service.dependencyGraphNodes(OWNER_ID, FOCUS, requested);

  assert.deepEqual(after.edges, [{ sourceTaskId: TASK_C, targetTaskId: FOCUS }]);
  assert.equal(
    after.edges.some(
      (edge) => edge.sourceTaskId === TASK_B && edge.targetTaskId === FOCUS,
    ),
    false,
  );
  assert.deepEqual(
    after.collapsedGroups.map(({ anchorTaskId, direction, hiddenCount }) => ({
      anchorTaskId,
      direction,
      hiddenCount,
    })),
    [{ anchorTaskId: TASK_B, direction: 'prerequisites', hiddenCount: 1 }],
  );
});

test('node refresh keeps non-focus tenant misses opaque and every topology query scoped', async () => {
  const crossTenantTaskId = '550e8400-e29b-41d4-a716-446655449998';
  const fixture = graphFixture();
  const result = await fixture.service.dependencyGraphNodes(OWNER_ID, FOCUS, [
    FOCUS,
    TASK_B,
    crossTenantTaskId,
  ]);

  assert.deepEqual(result.nodes.map((node) => node.id), [FOCUS, TASK_B]);
  assert.deepEqual(result.missingTaskIds, [crossTenantTaskId]);
  assert.ok(
    fixture.inducedWheres.every(
      (where) => where.task.ownerId === OWNER_ID && where.dependsOnTask.ownerId === OWNER_ID,
    ),
  );
  assert.equal(fixture.busyWhere().ownerId, OWNER_ID);
});

test('node refresh caps dense induced edges and turns omitted relations into boundaries', async () => {
  const denseIds = Array.from(
    { length: 64 },
    (_, index) => `550e8400-e29b-41d4-a716-4466554420${String(index).padStart(2, '0')}`,
  );
  const denseTasks = new Map<string, TaskRow>(
    denseIds.map((id, index) => [
      id,
      { id, title: `Refresh dense ${index}`, status: TaskStatus.OPEN, autoRunWhenReady: true },
    ]),
  );
  const denseEdges: StoredEdge[] = [];
  for (let source = 0; source < denseIds.length; source += 1) {
    for (let target = source + 1; target < denseIds.length; target += 1) {
      denseEdges.push({ taskId: denseIds[target], dependsOnTaskId: denseIds[source] });
    }
  }
  const fixture = graphFixture(denseEdges, true, denseTasks);
  const result = await fixture.service.dependencyGraphNodes(
    OWNER_ID,
    denseIds[0],
    denseIds,
  );

  assert.equal(result.nodes.length, 64);
  assert.equal(result.edges.length, 2_000);
  assert.equal(result.truncatedEdges, true);
  assert.equal(
    result.collapsedGroups.reduce((sum, group) => sum + group.hiddenCount, 0),
    32,
  );
  assert.deepEqual(result.missingTaskIds, []);
  assert.ok(
    fixture.inducedWheres.every(
      (where) => where.task.ownerId === OWNER_ID && where.dependsOnTask.ownerId === OWNER_ID,
    ),
  );
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
    downstream: 0,
    connected: 4,
    lateral: 0,
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
  assert.deepEqual(fixture.traversalTakes, [401, 401, 401]);
  assert.equal(fixture.factBatches.length, 1);
  assert.ok(
    fixture.factBatches.every(
      (batch) =>
        batch.length === 5 &&
        new Set(batch).size === 5 &&
        [FOCUS, TASK_B, TASK_C, TASK_D, TASK_E].every((id) => batch.includes(id)),
    ),
  );
  assert.equal(fixture.degreeBatches.length, 1);
  assert.ok(
    fixture.degreeBatches.every(
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
  assert.ok(
    fixture.inducedWheres.every(
      (where) => where.task.ownerId === OWNER_ID && where.dependsOnTask.ownerId === OWNER_ID,
    ),
  );
  assert.equal(fixture.busyWhere().ownerId, OWNER_ID);
  assert.deepEqual(
    new Set(fixture.busyWhere().taskId.in),
    new Set([FOCUS, TASK_B, TASK_C, TASK_D, TASK_E]),
  );
});

test('graph state follows a multi-hop successor tail without rewriting the stored edge', async () => {
  const successorRows = new Map(tasks);
  successorRows.set(TASK_B, {
    ...tasks.get(TASK_B)!,
    status: TaskStatus.FAILED,
    supersededByTaskId: TASK_C,
    terminalReason: 'SUPERSEDED',
  });
  successorRows.set(TASK_C, {
    ...tasks.get(TASK_C)!,
    status: TaskStatus.CANCELLED,
    supersededByTaskId: TASK_D,
    terminalReason: 'SUPERSEDED',
  });
  successorRows.set(TASK_D, {
    ...tasks.get(TASK_D)!,
    status: TaskStatus.DONE,
    supersededByTaskId: null,
    terminalReason: null,
  });
  const fixture = graphFixture(
    [{ taskId: FOCUS, dependsOnTaskId: TASK_B }],
    true,
    successorRows,
  );

  const result = await fixture.service.dependencyGraph(OWNER_ID, FOCUS);

  assert.deepEqual(result.nodes.map(({ id, dependencyState }) => ({ id, dependencyState })), [
    { id: FOCUS, dependencyState: 'READY' },
    { id: TASK_B, dependencyState: 'NONE' },
  ]);
  assert.deepEqual(result.edges, [{ sourceTaskId: TASK_B, targetTaskId: FOCUS }]);
  assert.deepEqual(fixture.successorBatches, [[TASK_C], [TASK_D]]);
  assert.ok(fixture.successorWheres.every((where) => where.ownerId === OWNER_ID));
});

test('missing, deleted, and cyclic successor tails keep graph state fail-closed', async () => {
  const missing = '550e8400-e29b-41d4-a716-446655449997';
  const cases: Array<[string, (rows: Map<string, TaskRow>) => void]> = [
    ['missing successor row', (rows) => {
      rows.set(TASK_B, {
        ...tasks.get(TASK_B)!,
        status: TaskStatus.CANCELLED,
        supersededByTaskId: missing,
        terminalReason: 'SUPERSEDED',
      });
    }],
    ['deleted successor pointer', (rows) => {
      rows.set(TASK_B, {
        ...tasks.get(TASK_B)!,
        status: TaskStatus.CANCELLED,
        supersededByTaskId: null,
        terminalReason: 'SUPERSEDED',
      });
    }],
    ['successor cycle', (rows) => {
      rows.set(TASK_B, {
        ...tasks.get(TASK_B)!,
        status: TaskStatus.CANCELLED,
        supersededByTaskId: TASK_C,
        terminalReason: 'SUPERSEDED',
      });
      rows.set(TASK_C, {
        ...tasks.get(TASK_C)!,
        status: TaskStatus.DONE,
        supersededByTaskId: TASK_B,
        terminalReason: 'SUPERSEDED',
      });
    }],
  ];

  for (const [name, arrange] of cases) {
    const rows = new Map(tasks);
    arrange(rows);
    const fixture = graphFixture(
      [{ taskId: FOCUS, dependsOnTaskId: TASK_B }],
      true,
      rows,
    );
    const result = await fixture.service.dependencyGraph(OWNER_ID, FOCUS);

    assert.deepEqual(result.nodes.map((node) => node.id), [FOCUS, TASK_B], name);
    assert.equal(
      result.nodes.find((node) => node.id === FOCUS)?.dependencyState,
      'BLOCKED',
      name,
    );
    assert.ok(fixture.successorWheres.every((where) => where.ownerId === OWNER_ID), name);
  }
});

test('both direction discovers the full weakly connected diamond from a root prerequisite', async () => {
  const fixture = graphFixture();

  const result = await fixture.service.dependencyGraph(OWNER_ID, TASK_D, { direction: 'both' });

  assert.deepEqual(
    result.nodes.map(({ id, depth }) => ({ id, depth })),
    [
      { id: TASK_D, depth: 0 },
      { id: TASK_B, depth: 1 },
      { id: TASK_C, depth: 1 },
      { id: TASK_E, depth: 2 },
      { id: FOCUS, depth: 2 },
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
    upstream: 0,
    downstream: 3,
    connected: 4,
    lateral: 1,
    total: 5,
    done: 0,
    remaining: 0,
    failed: 0,
  });
  assert.equal(result.direction, 'both');
  assert.equal(result.maxDepth, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(fixture.traversalBatches, [
    [TASK_D],
    [TASK_D],
    [TASK_B, TASK_C],
    [TASK_B, TASK_C],
    [TASK_E, FOCUS],
    [TASK_E, FOCUS],
  ]);
  assert.ok(
    fixture.traversalWheres.every(
      (where) =>
        where.task.ownerId === OWNER_ID &&
        where.dependsOnTask.ownerId === OWNER_ID &&
        (!!where.taskId?.in !== !!where.dependsOnTaskId?.in),
    ),
  );
  assert.ok(
    fixture.inducedWheres.every(
      (where) => where.task.ownerId === OWNER_ID && where.dependsOnTask.ownerId === OWNER_ID,
    ),
  );
});

test('both direction classifies ancestors, descendants, and lateral nodes from the middle', async () => {
  const result = await graphFixture().service.dependencyGraph(OWNER_ID, TASK_C, {
    direction: 'both',
  });

  assert.deepEqual(
    result.nodes.map(({ id, depth }) => ({ id, depth })),
    [
      { id: TASK_C, depth: 0 },
      { id: TASK_D, depth: 1 },
      { id: FOCUS, depth: 1 },
      { id: TASK_E, depth: 1 },
      { id: TASK_B, depth: 2 },
    ],
  );
  assert.deepEqual(result.counts, {
    upstream: 2,
    downstream: 1,
    connected: 4,
    lateral: 1,
    total: 5,
    done: 1,
    remaining: 0,
    failed: 1,
  });
  assert.equal(result.maxDepth, 2);
  assert.equal(result.truncated, false);
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

test('both direction detects only relationships beyond depth and node boundaries as truncated', async () => {
  const depthLimited = graphFixture();
  const depthResult = await depthLimited.service.dependencyGraph(OWNER_ID, TASK_D, {
    direction: 'both',
    maxDepth: 1,
  });
  assert.deepEqual(depthResult.nodes.map((node) => node.id), [TASK_D, TASK_B, TASK_C]);
  assert.deepEqual(depthLimited.boundaryChecks, [[TASK_B, TASK_C]]);
  assert.equal(depthResult.maxDepth, 1);
  assert.equal(depthResult.truncated, true);

  const nodeLimited = graphFixture();
  const nodeResult = await nodeLimited.service.dependencyGraph(OWNER_ID, TASK_D, {
    direction: 'both',
    maxNodes: 3,
  });
  assert.deepEqual(nodeResult.nodes.map((node) => node.id), [TASK_D, TASK_B, TASK_C]);
  assert.deepEqual(nodeResult.edges, [
    { sourceTaskId: TASK_D, targetTaskId: TASK_B },
    { sourceTaskId: TASK_D, targetTaskId: TASK_C },
  ]);
  assert.equal(nodeResult.truncated, true);

  const completeAtBoundary = graphFixture([{ taskId: TASK_B, dependsOnTaskId: TASK_D }]);
  const completeResult = await completeAtBoundary.service.dependencyGraph(OWNER_ID, TASK_D, {
    direction: 'both',
    maxDepth: 1,
  });
  assert.deepEqual(completeAtBoundary.boundaryChecks, [[TASK_B]]);
  assert.equal(completeResult.truncated, false);
});

test('both direction fairly admits direct tasks from each side under a fan-out budget', async () => {
  const focus = '550e8400-e29b-41d4-a716-446655449000';
  const prerequisites = Array.from(
    { length: 13 },
    (_, index) => `550e8400-e29b-41d4-a716-4466554491${String(index).padStart(2, '0')}`,
  );
  const dependent = '550e8400-e29b-41d4-a716-446655449200';
  const fanTasks = new Map<string, TaskRow>(
    [focus, ...prerequisites, dependent].map((id, index) => [
      id,
      { id, title: `Fan ${index}`, status: TaskStatus.OPEN, autoRunWhenReady: true },
    ]),
  );
  const fanEdges: StoredEdge[] = [
    ...prerequisites.map((dependsOnTaskId) => ({ taskId: focus, dependsOnTaskId })),
    { taskId: dependent, dependsOnTaskId: focus },
  ];

  const result = await graphFixture(fanEdges, true, fanTasks).service.dependencyGraph(
    OWNER_ID,
    focus,
    { direction: 'both', maxNodes: 3 },
  );

  assert.deepEqual(result.nodes.map((node) => node.id), [focus, prerequisites[0], dependent]);
  assert.deepEqual(result.edges, [
    { sourceTaskId: prerequisites[0], targetTaskId: focus },
    { sourceTaskId: focus, targetTaskId: dependent },
  ]);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.truncationReasons, ['maxNodes', 'maxEdges']);
  assert.deepEqual(
    result.nodes.map(({ id, prerequisiteCount, dependentCount }) => ({
      id,
      prerequisiteCount,
      dependentCount,
    })),
    [
      { id: focus, prerequisiteCount: 13, dependentCount: 1 },
      { id: prerequisites[0], prerequisiteCount: 0, dependentCount: 1 },
      { id: dependent, prerequisiteCount: 1, dependentCount: 0 },
    ],
  );
  assert.equal(result.collapsedGroups.length, 1);
  assert.deepEqual(
    {
      ...result.collapsedGroups[0],
      cursor: typeof result.collapsedGroups[0].cursor,
    },
    {
      anchorTaskId: focus,
      direction: 'prerequisites',
      hiddenCount: 12,
      cursor: 'string',
    },
  );
});

test('dense both-direction snapshots enforce maxEdges while retaining a discovery path', async () => {
  const denseIds = Array.from(
    { length: 10 },
    (_, index) => `550e8400-e29b-41d4-a716-4466554400${String(index).padStart(2, '0')}`,
  );
  const denseTasks = new Map<string, TaskRow>(
    denseIds.map((id, index) => [
      id,
      { id, title: `Dense ${index}`, status: TaskStatus.OPEN, autoRunWhenReady: true },
    ]),
  );
  const denseEdges: StoredEdge[] = [];
  // Put non-discovery cross-edges first so the response must reserve room for root edges
  // that fall beyond the database-order prefix.
  for (let source = 1; source < denseIds.length; source += 1) {
    for (let target = source + 1; target < denseIds.length; target += 1) {
      denseEdges.push({ taskId: denseIds[target], dependsOnTaskId: denseIds[source] });
    }
  }
  for (let target = 1; target < denseIds.length; target += 1) {
    denseEdges.push({ taskId: denseIds[target], dependsOnTaskId: denseIds[0] });
  }
  const exactCap = await graphFixture(denseEdges.slice(0, 40), true, denseTasks).service.dependencyGraph(
    OWNER_ID,
    denseIds[0],
    { direction: 'both', maxNodes: 10 },
  );
  assert.equal(exactCap.nodes.length, 10);
  assert.equal(exactCap.edges.length, 40);
  assert.equal(exactCap.truncated, false);

  const result = await graphFixture(denseEdges, true, denseTasks).service.dependencyGraph(
    OWNER_ID,
    denseIds[0],
    { direction: 'both', maxNodes: 10 },
  );

  assert.equal(result.nodes.length, 10);
  assert.equal(result.edges.length, 40);
  assert.equal(result.limits.maxEdges, 40);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.truncationReasons, ['maxEdges']);
  assert.deepEqual(result.counts, {
    upstream: 0,
    downstream: 9,
    connected: 9,
    lateral: 0,
    total: 10,
    done: 0,
    remaining: 0,
    failed: 0,
  });
  for (const dependent of denseIds.slice(1)) {
    assert.ok(
      result.edges.some(
        (edge) => edge.sourceTaskId === denseIds[0] && edge.targetTaskId === dependent,
      ),
      `missing discovery edge to ${dependent}`,
    );
  }
});

test('pairUnary samples complete W/P pairs within maxNodes while remaining opt-in', async () => {
  const check = '550e8400-e29b-41d4-a716-446655444000';
  const works = Array.from(
    { length: 4 },
    (_, index) => `550e8400-e29b-41d4-a716-4466554441${String(index).padStart(2, '0')}`,
  );
  const parquets = Array.from(
    { length: 4 },
    (_, index) => `550e8400-e29b-41d4-a716-4466554442${String(index).padStart(2, '0')}`,
  );
  const pairTasks = new Map<string, TaskRow>(
    [check, ...works, ...parquets].map((id, index) => [
      id,
      { id, title: `Pair ${index}`, status: TaskStatus.OPEN, autoRunWhenReady: true },
    ]),
  );
  const pairEdges: StoredEdge[] = [
    ...works.map((dependsOnTaskId) => ({ taskId: check, dependsOnTaskId })),
    ...works.map((taskId, index) => ({ taskId, dependsOnTaskId: parquets[index] })),
  ];

  const defaultResult = await graphFixture(pairEdges, true, pairTasks).service.dependencyGraph(
    OWNER_ID,
    check,
    { direction: 'both', maxNodes: 5 },
  );
  assert.equal(defaultResult.pairUnary, false);
  assert.deepEqual(defaultResult.nodes.map((node) => node.id), [check, ...works]);
  assert.equal(
    defaultResult.collapsedGroups.filter(
      (group) => group.direction === 'prerequisites' && works.includes(group.anchorTaskId),
    ).length,
    4,
  );

  const pairedResult = await graphFixture(pairEdges, true, pairTasks).service.dependencyGraph(
    OWNER_ID,
    check,
    { direction: 'both', maxNodes: 5, pairUnary: true },
  );
  assert.equal(pairedResult.pairUnary, true);
  assert.equal(pairedResult.nodes.length, 5);
  assert.deepEqual(pairedResult.nodes.map((node) => node.id), [
    check,
    works[0],
    parquets[0],
    works[1],
    parquets[1],
  ]);
  assert.deepEqual(pairedResult.edges, [
    { sourceTaskId: works[0], targetTaskId: check },
    { sourceTaskId: works[1], targetTaskId: check },
    { sourceTaskId: parquets[0], targetTaskId: works[0] },
    { sourceTaskId: parquets[1], targetTaskId: works[1] },
  ]);
  assert.deepEqual(pairedResult.collapsedGroups.map(({ anchorTaskId, direction, hiddenCount }) => ({
    anchorTaskId,
    direction,
    hiddenCount,
  })), [{ anchorTaskId: check, direction: 'prerequisites', hiddenCount: 2 }]);
  assert.deepEqual(pairedResult.truncationReasons, ['maxNodes']);
  assert.equal(pairedResult.maxDepth, 2);
});

test('pairUnary queues its companion at the real BFS depth before traversing farther', async () => {
  const chainEdges: StoredEdge[] = [
    { taskId: FOCUS, dependsOnTaskId: TASK_B },
    { taskId: TASK_B, dependsOnTaskId: TASK_C },
    { taskId: TASK_C, dependsOnTaskId: TASK_D },
  ];
  const result = await graphFixture(chainEdges).service.dependencyGraph(OWNER_ID, FOCUS, {
    direction: 'both',
    pairUnary: true,
  });

  assert.deepEqual(result.nodes.map(({ id, depth }) => ({ id, depth })), [
    { id: FOCUS, depth: 0 },
    { id: TASK_B, depth: 1 },
    { id: TASK_C, depth: 2 },
    { id: TASK_D, depth: 3 },
  ]);
  assert.equal(result.truncated, false);
});

test('high-fan-out branches expand in deterministic batches with exact remaining counts', async () => {
  const focus = '550e8400-e29b-41d4-a716-446655448000';
  const prerequisites = Array.from(
    { length: 6 },
    (_, index) => `550e8400-e29b-41d4-a716-4466554481${String(index).padStart(2, '0')}`,
  );
  const fanTasks = new Map<string, TaskRow>(
    [focus, ...prerequisites].map((id, index) => [
      id,
      { id, title: `Paged ${index}`, status: TaskStatus.OPEN, autoRunWhenReady: true },
    ]),
  );
  const fixture = graphFixture(
    prerequisites.map((dependsOnTaskId) => ({ taskId: focus, dependsOnTaskId })),
    true,
    fanTasks,
  );
  const initial = await fixture.service.dependencyGraph(OWNER_ID, focus, {
    direction: 'both',
    maxNodes: 3,
  });
  const group = initial.collapsedGroups[0];
  const initialKnown = initial.nodes.map((node) => node.id);
  const initialLoaded = initial.edges
    .filter((edge) => edge.targetTaskId === focus)
    .map((edge) => edge.sourceTaskId);

  assert.deepEqual(initialKnown, [focus, prerequisites[0], prerequisites[1]]);
  assert.deepEqual(initialLoaded, [prerequisites[0], prerequisites[1]]);
  assert.equal(group.hiddenCount, 4);

  const first = await fixture.service.expandDependencyGraph(OWNER_ID, focus, {
    anchorTaskId: focus,
    direction: 'prerequisites',
    knownTaskIds: initialKnown,
    loadedNeighborTaskIds: initialLoaded,
    limit: 2,
    cursor: group.cursor!,
  });

  assert.deepEqual(first.nodes.map((node) => node.id), prerequisites.slice(2, 4));
  assert.deepEqual(first.edges, [
    { sourceTaskId: prerequisites[2], targetTaskId: focus },
    { sourceTaskId: prerequisites[3], targetTaskId: focus },
  ]);
  assert.ok(first.nodes.every((node) => node.prerequisiteCount === 0));
  assert.ok(first.nodes.every((node) => node.dependentCount === 1));
  assert.equal(first.remainingCount, 2);
  assert.equal(typeof first.nextCursor, 'string');
  assert.equal(first.capacityReached, false);
  assert.equal(first.limits.maxNodes, 1_000);
  assert.deepEqual(first.collapsedGroups, [
    {
      anchorTaskId: focus,
      direction: 'prerequisites',
      hiddenCount: 2,
      cursor: first.nextCursor,
    },
  ]);

  const secondKnown = [...initialKnown, ...first.nodes.map((node) => node.id)];
  const secondLoaded = [...initialLoaded, ...first.edges.map((edge) => edge.sourceTaskId)];
  const second = await fixture.service.expandDependencyGraph(OWNER_ID, focus, {
    anchorTaskId: focus,
    direction: 'prerequisites',
    knownTaskIds: secondKnown,
    loadedNeighborTaskIds: secondLoaded,
    limit: 2,
    cursor: first.nextCursor!,
  });

  assert.deepEqual(second.nodes.map((node) => node.id), prerequisites.slice(4));
  assert.equal(second.edges.length, 2);
  assert.equal(second.remainingCount, 0);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second.collapsedGroups, []);
  assert.ok(
    fixture.traversalWheres
      .slice(-2)
      .every(
        (where) => where.task.ownerId === OWNER_ID && where.dependsOnTask.ownerId === OWNER_ID,
      ),
  );
  assert.ok(
    fixture.inducedWheres
      .slice(-2)
      .every(
        (where) => where.task.ownerId === OWNER_ID && where.dependsOnTask.ownerId === OWNER_ID,
      ),
  );
});

test('expansion batches hydrate one unary continuation for every new direct neighbor', async () => {
  const check = '550e8400-e29b-41d4-a716-446655445000';
  const workA = '550e8400-e29b-41d4-a716-446655445001';
  const workB = '550e8400-e29b-41d4-a716-446655445002';
  const parquetA = '550e8400-e29b-41d4-a716-446655445003';
  const parquetB = '550e8400-e29b-41d4-a716-446655445004';
  const rows = new Map<string, TaskRow>(
    [check, workA, workB, parquetA, parquetB].map((id, index) => [
      id,
      { id, title: `Unary ${index}`, status: TaskStatus.OPEN, autoRunWhenReady: true },
    ]),
  );
  const fixture = graphFixture(
    [
      { taskId: check, dependsOnTaskId: workA },
      { taskId: check, dependsOnTaskId: workB },
      { taskId: workA, dependsOnTaskId: parquetA },
      { taskId: workB, dependsOnTaskId: parquetB },
    ],
    true,
    rows,
  );
  const initial = await fixture.service.dependencyGraph(OWNER_ID, check, {
    direction: 'both',
    maxNodes: 1,
  });
  const group = initial.collapsedGroups[0];

  const result = await fixture.service.expandDependencyGraph(OWNER_ID, check, {
    anchorTaskId: check,
    direction: 'prerequisites',
    knownTaskIds: [check],
    loadedNeighborTaskIds: [],
    limit: 2,
    cursor: group.cursor!,
  });

  assert.deepEqual(result.nodes.map((node) => node.id), [workA, workB, parquetA, parquetB]);
  assert.deepEqual(result.edges, [
    { sourceTaskId: workA, targetTaskId: check },
    { sourceTaskId: workB, targetTaskId: check },
    { sourceTaskId: parquetA, targetTaskId: workA },
    { sourceTaskId: parquetB, targetTaskId: workB },
  ]);
  assert.equal(result.autoExpandedNodeCount, 2);
  assert.equal(result.remainingCount, 0);
  assert.deepEqual(result.collapsedGroups, []);
});

test('expansion returns a missing diamond edge without duplicating an already-known node', async () => {
  const focus = '550e8400-e29b-41d4-a716-446655447000';
  const prerequisites = Array.from(
    { length: 4 },
    (_, index) => `550e8400-e29b-41d4-a716-4466554471${String(index).padStart(2, '0')}`,
  );
  const fanTasks = new Map<string, TaskRow>(
    [focus, ...prerequisites].map((id, index) => [
      id,
      { id, title: `Diamond ${index}`, status: TaskStatus.OPEN, autoRunWhenReady: true },
    ]),
  );
  const fixture = graphFixture(
    prerequisites.map((dependsOnTaskId) => ({ taskId: focus, dependsOnTaskId })),
    true,
    fanTasks,
  );
  const initial = await fixture.service.dependencyGraph(OWNER_ID, focus, {
    direction: 'both',
    maxNodes: 3,
  });
  const group = initial.collapsedGroups[0];
  const loaded = initial.edges.map((edge) => edge.sourceTaskId);
  // Simulate prerequisite[2] becoming visible via another parent before this branch
  // expands. It is known, but its edge into focus is not loaded yet.
  const result = await fixture.service.expandDependencyGraph(OWNER_ID, focus, {
    anchorTaskId: focus,
    direction: 'prerequisites',
    knownTaskIds: [...initial.nodes.map((node) => node.id), prerequisites[2]],
    loadedNeighborTaskIds: loaded,
    limit: 1,
    cursor: group.cursor!,
  });

  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.edges, [{ sourceTaskId: prerequisites[2], targetTaskId: focus }]);
  assert.equal(result.remainingCount, 1);
});

test('expansion cursors are bound to owner, focus, anchor, and branch direction', async () => {
  const fixture = graphFixture();
  const initial = await fixture.service.dependencyGraph(OWNER_ID, FOCUS, {
    direction: 'both',
    maxNodes: 2,
  });
  const group = initial.collapsedGroups[0];
  const base = {
    anchorTaskId: group.anchorTaskId,
    direction: group.direction,
    knownTaskIds: initial.nodes.map((node) => node.id),
    loadedNeighborTaskIds: initial.edges
      .filter((edge) => edge.targetTaskId === group.anchorTaskId)
      .map((edge) => edge.sourceTaskId),
    cursor: group.cursor!,
  };

  await assert.rejects(
    () =>
      fixture.service.expandDependencyGraph(OWNER_ID, FOCUS, {
        ...base,
        direction: base.direction === 'prerequisites' ? 'dependents' : 'prerequisites',
      }),
    /cursor does not match/,
  );
  await assert.rejects(
    () => fixture.service.expandDependencyGraph(OWNER_ID, FOCUS, { ...base, cursor: 'broken' }),
    /invalid dependency graph expansion cursor/,
  );
  await assert.rejects(
    () =>
      fixture.service.expandDependencyGraph('00000000-0000-7000-8000-000000000099', FOCUS, base),
    /cursor does not match/,
  );
});

test('expansion validates limits and snapshot-set invariants before querying adjacency', async () => {
  const fixture = graphFixture();
  const initial = await fixture.service.dependencyGraph(OWNER_ID, FOCUS, {
    direction: 'both',
    maxNodes: 2,
  });
  const group = initial.collapsedGroups[0];
  const base = {
    anchorTaskId: group.anchorTaskId,
    direction: group.direction,
    knownTaskIds: initial.nodes.map((node) => node.id),
    loadedNeighborTaskIds: initial.edges
      .filter((edge) => edge.targetTaskId === group.anchorTaskId)
      .map((edge) => edge.sourceTaskId),
    cursor: group.cursor!,
  };

  await assert.rejects(
    () => fixture.service.expandDependencyGraph(OWNER_ID, FOCUS, { ...base, limit: 0 }),
    /limit must be/,
  );
  await assert.rejects(
    () => fixture.service.expandDependencyGraph(OWNER_ID, FOCUS, { ...base, limit: 101 }),
    /limit must be/,
  );
  await assert.rejects(
    () =>
      fixture.service.expandDependencyGraph(OWNER_ID, FOCUS, {
        ...base,
        knownTaskIds: [...base.knownTaskIds, base.knownTaskIds[0]],
      }),
    /must not contain duplicates/,
  );
  await assert.rejects(
    () =>
      fixture.service.expandDependencyGraph(OWNER_ID, FOCUS, {
        ...base,
        loadedNeighborTaskIds: [TASK_E],
      }),
    /must be present in knownTaskIds/,
  );
  const tooMany = Array.from(
    { length: 1_001 },
    (_, index) => `00000000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
  );
  await assert.rejects(
    () =>
      fixture.service.expandDependencyGraph(OWNER_ID, FOCUS, {
        ...base,
        knownTaskIds: tooMany,
      }),
    /at most 1000 tasks/,
  );
});

test('paged expansion has a 1000-node hard cap without inheriting the 500-node GET cap', async () => {
  const focus = '550e8400-e29b-41d4-a716-446655446000';
  const otherIds = Array.from(
    { length: 1_000 },
    (_, index) => `00000000-0000-7000-8001-${index.toString(16).padStart(12, '0')}`,
  );
  const allIds = [focus, ...otherIds];
  const largeTasks = new Map<string, TaskRow>(
    allIds.map((id, index) => [
      id,
      { id, title: `Large ${index}`, status: TaskStatus.OPEN, autoRunWhenReady: true },
    ]),
  );
  const hidden = otherIds[otherIds.length - 1];
  const fixture = graphFixture([{ taskId: focus, dependsOnTaskId: hidden }], true, largeTasks);
  const initial = await fixture.service.dependencyGraph(OWNER_ID, focus, {
    direction: 'both',
    maxNodes: 1,
  });
  const group = initial.collapsedGroups[0];
  const knownTaskIds = allIds.filter((id) => id !== hidden);
  assert.equal(knownTaskIds.length, 1_000);

  const result = await fixture.service.expandDependencyGraph(OWNER_ID, focus, {
    anchorTaskId: focus,
    direction: 'prerequisites',
    knownTaskIds,
    loadedNeighborTaskIds: [],
    cursor: group.cursor!,
  });

  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.edges, []);
  assert.equal(result.remainingCount, 1);
  assert.equal(result.capacityReached, true);
  assert.equal(result.nextCursor, null);
  assert.equal(result.limits.maxNodes, 1_000);
});

test('the node cap still pages zero-cost missing edges to known diamond neighbors', async () => {
  const focus = '550e8400-e29b-41d4-a716-446655443000';
  const otherIds = Array.from(
    { length: 1_000 },
    (_, index) => `00000000-0000-7000-8002-${index.toString(16).padStart(12, '0')}`,
  );
  const knownA = otherIds[0];
  const knownB = otherIds[1];
  const hiddenNew = otherIds[otherIds.length - 1];
  const allIds = [focus, ...otherIds];
  const largeTasks = new Map<string, TaskRow>(
    allIds.map((id, index) => [
      id,
      { id, title: `Capped ${index}`, status: TaskStatus.OPEN, autoRunWhenReady: true },
    ]),
  );
  // The unknown edge sorts first in the fixture. A single mixed query would hit it,
  // exhaust node capacity, and fail to reach the two later known-neighbor edges.
  const fixture = graphFixture(
    [
      { taskId: focus, dependsOnTaskId: hiddenNew },
      { taskId: focus, dependsOnTaskId: knownA },
      { taskId: focus, dependsOnTaskId: knownB },
    ],
    true,
    largeTasks,
  );
  const initial = await fixture.service.dependencyGraph(OWNER_ID, focus, {
    direction: 'both',
    maxNodes: 1,
  });
  const knownTaskIds = allIds.filter((id) => id !== hiddenNew);
  const cursor = initial.collapsedGroups[0].cursor!;

  const first = await fixture.service.expandDependencyGraph(OWNER_ID, focus, {
    anchorTaskId: focus,
    direction: 'prerequisites',
    knownTaskIds,
    loadedNeighborTaskIds: [],
    limit: 1,
    cursor,
  });
  assert.deepEqual(first.nodes, []);
  assert.deepEqual(first.edges, [{ sourceTaskId: knownA, targetTaskId: focus }]);
  assert.equal(first.remainingCount, 2);
  assert.equal(first.capacityReached, true);
  assert.equal(typeof first.nextCursor, 'string');

  const second = await fixture.service.expandDependencyGraph(OWNER_ID, focus, {
    anchorTaskId: focus,
    direction: 'prerequisites',
    knownTaskIds,
    loadedNeighborTaskIds: [knownA],
    limit: 1,
    cursor: first.nextCursor!,
  });
  assert.deepEqual(second.nodes, []);
  assert.deepEqual(second.edges, [{ sourceTaskId: knownB, targetTaskId: focus }]);
  assert.equal(second.remainingCount, 1);
  assert.equal(second.capacityReached, true);
  assert.equal(second.nextCursor, null);
});

test('graph rejects invalid input and never exposes a non-owned focus task', async () => {
  const invalid = graphFixture();
  await assert.rejects(() => invalid.service.dependencyGraph(OWNER_ID, 'not-a-uuid'), /task not found/);
  await assert.rejects(
    () => invalid.service.dependencyGraph(OWNER_ID, FOCUS, { direction: 'downstream' }),
    /direction must be upstream or both/,
  );
  await assert.rejects(
    () => invalid.service.dependencyGraph(OWNER_ID, FOCUS, { maxDepth: 0 }),
    /maxDepth must be/,
  );
  await assert.rejects(
    () => invalid.service.dependencyGraph(OWNER_ID, FOCUS, { maxNodes: 501 }),
    /maxNodes must be/,
  );
  await assert.rejects(
    () => invalid.service.dependencyGraph(OWNER_ID, FOCUS, { pairUnary: 'yes' }),
    /pairUnary must be true or false/,
  );
  assert.equal(invalid.focusLookup(), undefined);

  const notOwned = graphFixture(diamondEdges, false);
  await assert.rejects(() => notOwned.service.dependencyGraph(OWNER_ID, FOCUS), /task not found/);
  assert.deepEqual(notOwned.focusLookup().where, { id: FOCUS, ownerId: OWNER_ID });
  assert.deepEqual(notOwned.traversalBatches, []);
});
