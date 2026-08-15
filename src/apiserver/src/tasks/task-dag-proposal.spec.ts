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

test('removing a task\'s last prerequisite frees it but does not start it', async () => {
  // The trap this card exists to avoid, and one it fell into itself. BLOCKED -> NONE reads like a
  // release; the sweep requires a prerequisite that is DONE, so a task with none left is never
  // auto-started. Counting it as runnable promised runs that never happened.
  const { service } = serviceWith({ edges: [{ taskId: A, dependsOnTaskId: B }] });

  const preview = await service.previewDag(OWNER, LIST, [rm(A, B)]);

  assert.equal(preview.becomingRunnable, 0);
  assert.equal(preview.becomingManual, 1);
  assert.deepEqual(
    preview.changes.map((c) => [c.title, c.from, c.to]),
    [['A', 'BLOCKED', 'NONE']],
  );
});

test('a task released by a prerequisite that is already DONE does start', async () => {
  // The genuine release: it keeps a prerequisite, and that prerequisite is finished.
  const { service } = serviceWith({ edges: [{ taskId: A, dependsOnTaskId: B }] });

  const preview = await service.previewDag(OWNER, LIST, [rm(A, B), add(A, C)]);

  assert.equal(preview.becomingRunnable, 1);
  assert.equal(preview.becomingManual, 0);
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

test('a removal of an edge that is not there is not counted as a removal', async () => {
  // Found by re-applying an already-applied batch against the deployment: `added` was filtered
  // through effectiveOps and `removed` was not, so a no-op remove still reported "removed 1".
  // The count is what the agent repeats back to the human, and claiming a write that did not
  // happen is the precise kind of false confidence this feature exists to prevent.
  const { service, written } = serviceWith({ edges: [] });

  const result = await service.applyDag(OWNER, LIST, [rm(A, B)]);

  assert.equal(result.removed, 0);
  assert.deepEqual(written, []);
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

/**
 * The batch-create preview. Stubs honour their filters for the same reason as above: a `findMany`
 * that ignores `where` makes "this assignee has no runner" indistinguishable from "no assignee".
 */
function batchService(world: {
  runners?: Record<string, string | null>;
  statuses?: Record<string, string>;
} = {}) {
  const runners = world.runners ?? { w1: 'r1' };
  const statuses = world.statuses ?? {};
  const prisma = {
    workspace: {
      findMany: async ({ where }: any) =>
        Object.entries(runners)
          .filter(([id]) => !where?.id?.in || where.id.in.includes(id))
          .map(([id, runnerId]) => ({ id, name: id, runnerId })),
    },
    task: {
      findMany: async ({ where }: any) =>
        Object.entries(statuses)
          .filter(([id]) => !where?.id?.in || where.id.in.includes(id))
          .map(([id, status]) => ({ id, status })),
      count: async () => Object.keys(statuses).length,
    },
    taskList: { findMany: async () => [], findFirst: async () => ({ id: LIST, title: 'L' }) },
  };
  const service = new TasksService(prisma as never, {} as never, { publishForUser: () => undefined } as never);
  // Ownership assertions are covered by createMany's own tests; they are not what this measures.
  for (const m of ['assertOwnedWorkspace', 'assertOwnedList', 'assertUsableProvider', 'assertOwnedTasks']) {
    (service as unknown as Record<string, unknown>)[m] = async () => undefined;
  }
  return service;
}

test('a chain of fifty starts nothing until its root is started by hand', async () => {
  // Its root has no prerequisites, so the sweep never picks it up; the other 49 wait on it.
  const tasks = Array.from({ length: 50 }, (_, i) => ({
    title: `step ${i}`,
    ref: `s${i}`,
    assigneeId: 'w1',
    ...(i > 0 ? { dependsOnRefs: [`s${i - 1}`] } : {}),
  }));

  const p = await batchService().previewCreateMany(OWNER, { tasks } as never);

  assert.equal(p.taskCount, 50);
  assert.equal(p.startingNow, 0);
  assert.equal(p.blocked, 49);
  assert.equal(p.needsManualStart, 1);
});

test('fifty independent tasks start nothing — auto-run needs a prerequisite to have finished', async () => {
  // Caught by running the real approval flow: the card said one task would start within the
  // minute and it never did. AUTO_RUN_READY_SQL requires a prerequisite that is DONE, because
  // auto-run means "start when what you were waiting for finishes", not "start because nothing
  // is in the way" — `autoRunWhenReady` is documented as ignored with no prerequisites. The roots
  // of every fresh DAG land here, so the old reading promised fifty runs and delivered none.
  const tasks = Array.from({ length: 50 }, (_, i) => ({ title: `t ${i}`, assigneeId: 'w1' }));

  const p = await batchService().previewCreateMany(OWNER, { tasks } as never);

  assert.equal(p.startingNow, 0);
  assert.equal(p.blocked, 0);
  assert.equal(p.needsManualStart, 50);
});

test('a released task whose assignee has no runner cannot run, and is not called blocked', async () => {
  // Nothing finishing will release it — it waits for a person. Counting it as blocked would say
  // the batch is progressing when it is inert.
  const p = await batchService({ runners: { w1: null }, statuses: { old1: 'DONE' } }).previewCreateMany(
    OWNER,
    { tasks: [{ title: 'a', assigneeId: 'w1', dependsOnTaskIds: ['old1'] }] } as never,
  );

  assert.equal(p.startingNow, 0);
  assert.equal(p.blocked, 0);
  assert.equal(p.notDispatchable, 1);
});

test('auto-run switched off keeps a released task from starting', async () => {
  const p = await batchService({ statuses: { old1: 'DONE' } }).previewCreateMany(OWNER, {
    tasks: [{ title: 'a', assigneeId: 'w1', dependsOnTaskIds: ['old1'], autoRunWhenReady: false }],
  } as never);

  assert.equal(p.startingNow, 0);
  assert.equal(p.notDispatchable, 1);
});

test('an existing prerequisite that is already DONE does not block', async () => {
  const p = await batchService({ statuses: { old1: 'DONE' } }).previewCreateMany(OWNER, {
    tasks: [{ title: 'a', assigneeId: 'w1', dependsOnTaskIds: ['old1'] }],
  } as never);

  assert.equal(p.startingNow, 1);
});

test('an existing prerequisite still open does block', async () => {
  const p = await batchService({ statuses: { old1: 'IN_PROGRESS' } }).previewCreateMany(OWNER, {
    tasks: [{ title: 'a', assigneeId: 'w1', dependsOnTaskIds: ['old1'] }],
  } as never);

  assert.equal(p.startingNow, 0);
  assert.equal(p.blocked, 1);
});

test('the preview rejects what the write would reject, before anyone is asked', async () => {
  // A batch that could never land is a mistake to hand back, not a decision to interrupt someone
  // with. Same validation as createMany, shared rather than copied.
  await assert.rejects(
    () =>
      batchService().previewCreateMany(OWNER, {
        tasks: [{ title: 'a', dependsOnRefs: ['nope'] }],
      } as never),
    /must name an earlier task/,
  );
});
