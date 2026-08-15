import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService } from './tasks.service';
import { DagOp } from './task-dag';

const OWNER = '00000000-0000-7000-8000-000000000001';
const LIST = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const A = '550e8400-e29b-41d4-a716-446655440000';
const B = '550e8400-e29b-41d4-a716-446655440001';
const C = '550e8400-e29b-41d4-a716-446655440002';

const add = (taskId: string, dependsOnTaskId: string): DagOp => ({ op: 'add', taskId, dependsOnTaskId });
const rm = (taskId: string, dependsOnTaskId: string): DagOp => ({ op: 'remove', taskId, dependsOnTaskId });

interface World {
  edges?: Array<{ taskId: string; dependsOnTaskId: string }>;
  tasks?: Record<string, { title: string; status: string; listId: string | null }>;
  /** Edges the apply transaction sees, when they differ from what the preview saw. */
  edgesAtApply?: Array<{ taskId: string; dependsOnTaskId: string }>;
}

/**
 * Stubs that honour the filters the service passes. `task.count` in particular must apply its
 * `where`, or the list-membership check passes with the check deleted — the failure mode that
 * survived three separate tests earlier in this work.
 */
function serviceWith(world: World) {
  const tasks = world.tasks ?? {
    [A]: { title: 'A', status: 'OPEN', listId: LIST },
    [B]: { title: 'B', status: 'OPEN', listId: LIST },
    [C]: { title: 'C', status: 'DONE', listId: LIST },
  };
  const edges = world.edges ?? [];
  const written: Array<{ kind: string; taskId: string; dependsOnTaskId: string }> = [];
  const rows = (where: any) =>
    Object.entries(tasks).filter(([id, t]) => {
      if (where?.id?.in && !where.id.in.includes(id)) return false;
      if (where?.listId !== undefined && t.listId !== where.listId) return false;
      return true;
    });
  const dependencyClient = (source: () => Array<{ taskId: string; dependsOnTaskId: string }>) => ({
    findMany: async () => source().map((e) => ({ ...e })),
    deleteMany: async ({ where }: any) => {
      written.push({ kind: 'delete', taskId: where.taskId, dependsOnTaskId: where.dependsOnTaskId });
      return { count: 1 };
    },
    createMany: async ({ data }: any) => {
      for (const d of data) written.push({ kind: 'create', ...d });
      return { count: data.length };
    },
  });
  const prisma = {
    taskList: {
      findFirst: async ({ where }: any) =>
        where.id === LIST && where.ownerId === OWNER ? { id: LIST, title: 'FineWeb' } : null,
    },
    task: {
      count: async ({ where }: any) => rows(where).length,
      findMany: async ({ where }: any) => rows(where).map(([id, t]) => ({ id, ...t })),
    },
    taskDependency: dependencyClient(() => edges),
    $transaction: async (fn: any) =>
      fn({
        $queryRaw: async () => [],
        taskDependency: dependencyClient(() => world.edgesAtApply ?? edges),
      }),
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    { publishForUser: () => undefined } as never,
  );
  // reconcileReadyTasks runs after a successful apply and is not what these tests are about.
  (service as unknown as { reconcileReadyTasks: () => Promise<void> }).reconcileReadyTasks =
    async () => {};
  return { service, written };
}

test('a preview reports which tasks become runnable, which is what is being approved', async () => {
  const { service } = serviceWith({ edges: [{ taskId: A, dependsOnTaskId: B }] });

  const preview = await service.previewDag(OWNER, LIST, [rm(A, B)]);

  assert.equal(preview.becomingRunnable, 1);
  assert.deepEqual(
    preview.changes.map((c) => [c.title, c.from, c.to]),
    [['A', 'BLOCKED', 'NONE']],
  );
});

test('a preview names tasks by title, since ids are not what a human approves', async () => {
  const { service } = serviceWith({});

  const preview = await service.previewDag(OWNER, LIST, [add(A, C)]);

  assert.deepEqual(preview.ops[0].taskTitle, 'A');
  assert.deepEqual(preview.ops[0].dependsOnTitle, 'C');
});

test('a preview writes nothing', async () => {
  const { service, written } = serviceWith({});

  await service.previewDag(OWNER, LIST, [add(A, B)]);

  assert.deepEqual(written, []);
});

test('a cycle is reported as a path rather than rejected outright', async () => {
  // The preview describes; applyDag is what refuses. Reporting it here lets the proposer see
  // which edge closed the loop instead of being told only that one exists.
  const { service } = serviceWith({ edges: [{ taskId: B, dependsOnTaskId: A }] });

  const preview = await service.previewDag(OWNER, LIST, [add(A, B)]);

  assert.ok(preview.cycle);
  assert.ok(preview.cycle.every((c) => c.title));
});

test('a task outside the list cannot be restructured through that list', async () => {
  // Otherwise "restructure this list" is not a bounded thing to approve: the card names one
  // campaign and the batch reaches into another.
  const { service } = serviceWith({
    tasks: {
      [A]: { title: 'A', status: 'OPEN', listId: 'another-list' },
      [B]: { title: 'B', status: 'OPEN', listId: LIST },
    },
  });

  await assert.rejects(() => service.previewDag(OWNER, LIST, [add(A, B)]), /must belong to the list/);
});

test('a prerequisite outside the list is allowed — cross-list waits are ordinary', async () => {
  const { service } = serviceWith({
    tasks: {
      [A]: { title: 'A', status: 'OPEN', listId: LIST },
      [B]: { title: 'B', status: 'DONE', listId: 'another-list' },
    },
  });

  const preview = await service.previewDag(OWNER, LIST, [add(A, B)]);

  assert.equal(preview.ops.length, 1);
});

test("a list the caller does not own is not found", async () => {
  const { service } = serviceWith({});

  await assert.rejects(
    () => service.previewDag('00000000-0000-7000-8000-000000000009', LIST, [add(A, B)]),
    /task list not found/,
  );
});

test('an empty batch is refused rather than silently approved', async () => {
  const { service } = serviceWith({});

  await assert.rejects(() => service.previewDag(OWNER, LIST, []), /no dependency changes/);
});

test('a self-edge is refused', async () => {
  const { service } = serviceWith({});

  await assert.rejects(() => service.previewDag(OWNER, LIST, [add(A, A)]), /cannot depend on itself/);
});

test('applying writes the removals and the additions', async () => {
  const { service, written } = serviceWith({ edges: [{ taskId: A, dependsOnTaskId: B }] });

  const result = await service.applyDag(OWNER, LIST, [rm(A, B), add(A, C)]);

  assert.deepEqual(result.removed, 1);
  assert.deepEqual(result.added, 1);
  assert.deepEqual(
    written.map((w) => `${w.kind} ${w.taskId === A ? 'A' : w.taskId}->${w.dependsOnTaskId === B ? 'B' : 'C'}`),
    ['delete A->B', 'create A->C'],
  );
});

test('an addition already present is not written again', async () => {
  // An approval can be applied twice — a retried tool call, a re-delivered turn — and the second
  // must settle rather than collide on the unique key.
  const { service, written } = serviceWith({ edges: [{ taskId: A, dependsOnTaskId: B }] });

  const result = await service.applyDag(OWNER, LIST, [add(A, B), add(A, C)]);

  assert.equal(result.added, 1);
  assert.equal(written.filter((w) => w.kind === 'create').length, 1);
});

test('applying refuses when the graph moved under an open approval', async () => {
  // The one the re-validation exists for: a human decides at human speed, and another edit in
  // between can turn a legal batch into one that closes a loop.
  const { service, written } = serviceWith({
    edges: [],
    edgesAtApply: [{ taskId: B, dependsOnTaskId: A }],
  });

  await assert.rejects(() => service.applyDag(OWNER, LIST, [add(A, B)]), /graph changed/);
  assert.deepEqual(written.filter((w) => w.kind === 'create'), []);
});

test('applying a batch that would create a cycle refuses before opening a transaction', async () => {
  const { service, written } = serviceWith({ edges: [{ taskId: B, dependsOnTaskId: A }] });

  await assert.rejects(() => service.applyDag(OWNER, LIST, [add(A, B)]), /would create a cycle/);
  assert.deepEqual(written, []);
});
