/**
 * `task.priority`, in the parts that need no database: the order the automatic doors deal a list's
 * slots in, the edit door that writes the column, and the one request shape it accepts.
 *
 * The same behaviour against a real PostgreSQL — the sweep, the completion edge, the update door and
 * the runner's HTTP door — is `task-dispatch-priority.pg.spec.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TaskStatus } from '@orbit/shared';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { TASK_PRIORITY_MAX, TASK_PRIORITY_MIN, UpdateTaskDto } from './dto';
import { TasksService, orderWithinLists } from './tasks.service';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';

type Candidate = { id: string; listId: string | null; priority: number };
const c = (id: string, listId: string | null, priority = 0): Candidate => ({ id, listId, priority });
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

// ---------------------------------------------------------------------------
// The order.
// ---------------------------------------------------------------------------

test('with nothing raised the order is the one the pass read, row for row', () => {
  const read = [c('a1', 'A'), c('b1', 'B'), c('x', null), c('a2', 'A'), c('b2', 'B'), c('a3', 'A')];
  const ordered = orderWithinLists(read);
  assert.deepEqual(ids(ordered), ids(read));
  // The same objects, not copies: nothing about a candidate is rewritten on the way through.
  ordered.forEach((row, i) => assert.equal(row, read[i]));
});

test("a raised task takes its list's first position, and no other list's row moves", () => {
  const read = [c('a1', 'A'), c('b1', 'B'), c('a2', 'A'), c('x', null), c('a3', 'A', 5), c('b2', 'B')];
  assert.deepEqual(ids(orderWithinLists(read)), ['a3', 'b1', 'a1', 'x', 'a2', 'b2']);
});

test('equal priorities keep the order they were read in, and a lowered task goes last in its list', () => {
  const read = [c('a1', 'A', -1), c('a2', 'A', 2), c('a3', 'A'), c('a4', 'A', 2), c('a5', 'A')];
  assert.deepEqual(ids(orderWithinLists(read)), ['a2', 'a4', 'a3', 'a5', 'a1']);
});

test('a task in no list keeps its place whatever it carries: it has no queue to be ahead in', () => {
  const read = [c('x1', null), c('a1', 'A'), c('x2', null, 9), c('a2', 'A', 1)];
  assert.deepEqual(ids(orderWithinLists(read)), ['x1', 'a2', 'x2', 'a1']);
});

// ---------------------------------------------------------------------------
// The field.
// ---------------------------------------------------------------------------

test('update is three-state on the wire: omitted keeps it, a number sets it, null returns it to 0', async () => {
  const writes: any[] = [];
  const client: Record<string, unknown> = {
    $queryRaw: async () => [],
    task: {
      findFirst: async () => ({
        id: TASK_ID,
        ownerId: OWNER_ID,
        status: TaskStatus.OPEN,
        comments: [],
        sessions: [],
        dependsOn: [],
        dependedOnBy: [],
      }),
      update: async ({ data }: any) => (writes.push(data), { id: TASK_ID }),
      count: async () => 0,
    },
    taskDependency: { findMany: async () => [] },
    attachment: { findMany: async () => [] },
  };
  client.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(client);
  const service = new TasksService(client as never, {} as never, { publishForUser: () => undefined } as never);

  await service.update(OWNER_ID, TASK_ID, { title: 'renamed' } as any);
  assert.equal(writes[0].priority, undefined, 'omitted must leave the stored priority alone');
  await service.update(OWNER_ID, TASK_ID, { priority: 82 } as any);
  assert.equal(writes[1].priority, 82);
  await service.update(OWNER_ID, TASK_ID, { priority: null } as any);
  assert.equal(writes[2].priority, 0, 'null is the clear, and the column is never empty');
  await service.update(OWNER_ID, TASK_ID, { priority: -3 } as any);
  assert.equal(writes[3].priority, -3);
});

test('the DTO takes an integer in the column\'s range, or null, and nothing else', async () => {
  const errors = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(UpdateTaskDto, body))).flatMap((e) => Object.keys(e.constraints ?? {}));

  for (const ok of [0, 1, 82, -5, TASK_PRIORITY_MIN, TASK_PRIORITY_MAX, null]) {
    assert.deepEqual(await errors({ priority: ok }), [], `refused ${ok}`);
  }
  assert.deepEqual(await errors({}), []);
  assert.deepEqual(await errors({ priority: 1.5 }), ['isInt']);
  // A number spelled as text is not coerced: the edit door names types, it does not guess them.
  assert.ok((await errors({ priority: '5' })).includes('isInt'));
  assert.deepEqual(await errors({ priority: TASK_PRIORITY_MAX + 1 }), ['max']);
  assert.deepEqual(await errors({ priority: TASK_PRIORITY_MIN - 1 }), ['min']);
});

// ---------------------------------------------------------------------------
// The doors, over doubles: what each of them dispatches when a list has one slot.
// ---------------------------------------------------------------------------

/**
 * The ready sweep with everything but its order stubbed: the dependency scan answers `rows`, the
 * independent scan answers nothing, no quota, disk or backoff holds anything, and the lists have
 * the room `room` says. What it hands to the run door, in order, is the answer.
 */
async function sweepOver(rows: Candidate[], room: Record<string, number>): Promise<string[]> {
  const dispatched: string[] = [];
  const service = new TasksService({
    $queryRaw: async (...args: unknown[]) => {
      const query = renderRawQuery(args);
      if (query.shape !== 'tagged-template' || query.text.includes('coordinator_enabled')) return [];
      return rows.map((row) => ({
        ...row,
        ownerId: OWNER_ID,
        workspaceId: 'workspace-1',
        runnerId: 'runner-1',
        freeBytes: null,
        minFreeDiskMb: null,
        dispatchEpoch: 0n,
      }));
    },
  } as never, {} as never, {} as never);
  const internals = service as any;
  internals.rearmEndedAutoRuns = async () => undefined;
  internals.quotaGate = async () => ({ blocked: new Map(), blind: new Set() });
  internals.autoRunHoldOff = async () => new Set();
  internals.recordListEvent = async () => undefined;
  internals.materialisationBudget = async () => ({
    runner: new Map(),
    list: new Map(Object.entries(room)),
  });
  internals.dispatchReadyTask = async (_owner: string, id: string) => (dispatched.push(id), { ok: true });
  internals.logger = { log: () => undefined, warn: () => undefined, error: () => undefined };
  await internals.reconcileReadyTasks();
  return dispatched;
}

test("the sweep gives a list's one slot to its highest priority, and the next list its own as before", async () => {
  const read = [c('a1', 'A'), c('b1', 'B'), c('a2', 'A', 3), c('a3', 'A')];
  assert.deepEqual(await sweepOver(read, { A: 1, B: 1 }), ['a2', 'b1']);
  // The control: the same pass with nothing raised takes the first of each list, as it always has.
  assert.deepEqual(await sweepOver(read.map((row) => ({ ...row, priority: 0 })), { A: 1, B: 1 }), ['a1', 'b1']);
});

/**
 * The completion edge for one finished task that released `released`, all READY, auto-run and
 * assigned, with `room` in their lists and `outranking` as the database's answer to what each list
 * holds above them. Returns what it dispatched and every statement it sent.
 */
async function completionOver(
  released: Candidate[],
  room: Record<string, number>,
  outranking: Array<{ listId: string; priority: number }>,
) {
  const dispatched: string[] = [];
  const statements: string[] = [];
  const service = new TasksService({
    $queryRaw: async (...args: unknown[]) => {
      const { text } = renderRawQuery(args);
      statements.push(text);
      if (text.includes('WITH RECURSIVE chain AS')) return released.map((row) => ({ taskId: row.id }));
      if (text.includes('min_priority')) return outranking;
      return [];
    },
    task: {
      findMany: async () => released.map((row) => ({
        ...row,
        status: TaskStatus.OPEN,
        autoRunWhenReady: true,
        runAt: null,
        assignee: { id: 'workspace-1', runnerId: 'runner-1' },
        dispatchEpoch: { epoch: 1n },
      })),
    },
  } as never, {} as never, {} as never);
  const internals = service as any;
  internals.dependencyStatesFor = async () => new Map(released.map((row) => [row.id, 'READY']));
  internals.materialisationBudget = async () => ({
    runner: new Map(),
    list: new Map(Object.entries(room)),
  });
  internals.dispatchReadyTask = async (_owner: string, id: string) => (dispatched.push(id), { ok: true });
  await service.dispatchDependentsOf(OWNER_ID, 'done-task');
  return { dispatched, statements };
}

test('the completion edge leaves a released task to the sweep while its list holds higher-priority ready work', async () => {
  const outranked = await completionOver([c('d', 'A')], { A: 1 }, [{ listId: 'A', priority: 5 }]);
  assert.deepEqual(outranked.dispatched, [], 'the slot belongs to the higher-priority task waiting for it');

  // Nothing ranked above it: started on the spot, exactly as before the column existed.
  const alone = await completionOver([c('d', 'A')], { A: 1 }, []);
  assert.deepEqual(alone.dispatched, ['d']);

  // A tie is not outranking: equal priorities keep the order they already had.
  const tie = await completionOver([c('d', 'A', 5)], { A: 1 }, [{ listId: 'A', priority: 5 }]);
  assert.deepEqual(tie.dispatched, ['d']);
});

test('the completion edge asks once per pass however many it released, and not at all for tasks in no list', async () => {
  const many = await completionOver(
    [c('d1', 'A'), c('d2', 'A', 2), c('d3', 'B'), c('x', null)],
    { A: 5, B: 5 },
    [],
  );
  assert.deepEqual(many.dispatched, ['d2', 'd1', 'd3', 'x'], "each list's own releases go by priority");
  assert.equal(many.statements.filter((text) => text.includes('min_priority')).length, 1);

  const unlisted = await completionOver([c('x1', null), c('x2', null)], {}, []);
  assert.deepEqual(unlisted.dispatched, ['x1', 'x2']);
  assert.equal(unlisted.statements.filter((text) => text.includes('min_priority')).length, 0);
});

test('a lowered task is left to the sweep without a question: everything nobody raised outranks it', async () => {
  const lowered = await completionOver([c('d', 'A', -1)], { A: 1 }, []);
  assert.deepEqual(lowered.dispatched, []);
  assert.equal(lowered.statements.filter((text) => text.includes('min_priority')).length, 0);
});
