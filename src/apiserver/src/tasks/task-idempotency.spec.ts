import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TasksService } from './tasks.service';

const OWNER = 'owner-1';
const SESSION = '550e8400-e29b-41d4-a716-446655440000';

/**
 * A prisma double whose turn and idempotency lookups are steerable per test, and which records
 * every task.create so a test can assert the key that was (or was not) stamped. `inFlightTurn` is
 * the id currentTurnId() resolves to (null = no live turn); `existingByKey` is what a pre-check /
 * within-batch find resolves to (null = nothing exists yet).
 */
function fixture(opts: { inFlightTurn: string | null; existingByKey?: (key: string) => any }) {
  const creates: any[] = [];
  const findUniqueKeys: string[] = [];
  const existingByKey = opts.existingByKey ?? (() => null);
  const task = {
    findUnique: async ({ where }: any) => {
      findUniqueKeys.push(where.idempotencyKey);
      return existingByKey(where.idempotencyKey);
    },
    create: async ({ data }: any) => {
      creates.push(data);
      // `ownerId` on the way back because the winner lookup checks it: `idempotency_key` is unique
      // across the whole table, so a key held by another tenant is a typed conflict rather than a
      // miss, and a double that omitted the column would be testing a row the database cannot hold.
      return { id: `task-${creates.length}`, ownerId: OWNER, ...data };
    },
    count: async () => 0,
  };
  // The ordered pre-locks the canonical order takes before a task write (common/lock-order.ts):
  // the owner graph mutex, the lists, and the creator Session. All raw, all returning nothing
  // this fixture reads — recorded only so a caller could assert one was taken.
  const locks: string[] = [];
  const $queryRaw = async (strings: TemplateStringsArray) => {
    locks.push(strings.join('?').replace(/\s+/g, ' ').trim());
    return [];
  };
  const prisma = {
    task,
    $queryRaw,
    taskDependency: { createMany: async () => ({ count: 0 }) },
    session: { findFirst: async () => ({ id: SESSION }) },
    conversationTurn: {
      findFirst: async () => (opts.inFlightTurn ? { id: opts.inFlightTurn } : null),
      count: async () => 0,
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) =>
      fn({ task, $queryRaw, taskDependency: prisma.taskDependency }),
  };
  const service = new TasksService(prisma as never, {} as never, {
    publishTaskChanged: () => {},
  } as never);
  return { service, creates, findUniqueKeys, locks };
}

test('a task created twice inside one turn collapses onto the first', async () => {
  // First run: nothing exists yet, so it creates and captures the stamped key.
  const first = fixture({ inFlightTurn: 'turn-A' });
  await first.service.create(OWNER, { title: 'Ship the fix' }, undefined, SESSION);
  assert.equal(first.creates.length, 1, 'first run creates the task');
  const key = first.creates[0].idempotencyKey;
  assert.ok(key && typeof key === 'string', 'an in-turn create is stamped with a key');

  // Second run of the SAME turn: the pre-check finds the original and returns it, creating nothing.
  const replay = fixture({ inFlightTurn: 'turn-A', existingByKey: (k) => (k === key
      ? { id: 'task-orig', ownerId: OWNER, creatorSessionId: SESSION,
          title: 'Ship the fix', description: null, idempotencyKey: k }
      : null) });
  const got = await replay.service.create(OWNER, { title: 'Ship the fix' }, undefined, SESSION);
  assert.equal(replay.creates.length, 0, 'the re-run creates nothing');
  assert.equal((got as any).id, 'task-orig', 'the re-run returns the original task');
});

test('the same task in two different turns is NOT collapsed', async () => {
  const a = fixture({ inFlightTurn: 'turn-A' });
  await a.service.create(OWNER, { title: 'Fix the bug' }, undefined, SESSION);
  const b = fixture({ inFlightTurn: 'turn-B' });
  await b.service.create(OWNER, { title: 'Fix the bug' }, undefined, SESSION);
  assert.notEqual(
    a.creates[0].idempotencyKey,
    b.creates[0].idempotencyKey,
    'turn id is part of the key, so distinct turns never merge',
  );
});

test('a create with no live turn is not stamped and never pre-checks', async () => {
  const f = fixture({ inFlightTurn: null });
  await f.service.create(OWNER, { title: 'Standalone' }, undefined, SESSION);
  assert.equal(f.creates.length, 1);
  assert.equal(f.creates[0].idempotencyKey, undefined, 'no turn => no key => old behavior');
  assert.equal(f.findUniqueKeys.length, 0, 'no key means no idempotency lookup at all');
});

test('a re-run of a batch collapses every item and skips their edges', async () => {
  // First run stamps two distinct items; capture their keys.
  const first = fixture({ inFlightTurn: 'turn-A' });
  await first.service.createMany(OWNER, { tasks: [{ title: 'A' }, { title: 'B' }] }, undefined, SESSION);
  assert.equal(first.creates.length, 2, 'first batch run creates both items');
  const keys = new Set(first.creates.map((c) => c.idempotencyKey));
  assert.equal(keys.size, 2, 'distinct items get distinct keys');

  // Re-run: both keys already exist, so nothing is created.
  const replay = fixture({
    inFlightTurn: 'turn-A',
    // Each winner carries what the database would: the item's own title under its own key, so the
    // validator can rebuild the key from the row and agree it is this item's earlier attempt.
    existingByKey: (k) => {
      const original = first.creates.find((row) => row.idempotencyKey === k);
      return original
        ? {
            id: `orig-${k.slice(0, 4)}`,
            ownerId: OWNER,
            creatorSessionId: SESSION,
            title: original.title,
            description: original.description ?? null,
            idempotencyKey: k,
          }
        : null;
    },
  });
  const rows = await replay.service.createMany(OWNER, { tasks: [{ title: 'A' }, { title: 'B' }] }, undefined, SESSION);
  assert.equal(replay.creates.length, 0, 'the batch re-run creates nothing');
  assert.equal(rows.length, 2, 'it still returns both existing tasks in order');
});
