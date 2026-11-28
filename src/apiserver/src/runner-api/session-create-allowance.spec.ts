import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cardFreeTaskCreates,
  DEFAULT_CARD_FREE_TASK_CREATES,
  SESSION_CREATE_ALLOWANCE_MESSAGE,
  sessionCreateAllowedBy,
} from './session-create-allowance';

function ask(
  toolName: string,
  input: unknown,
  {
    created = 0,
    mode = 'auto' as string | null,
    accountDefault = null as string | null,
    allowance = undefined as unknown,
    session = true,
    coordinated = [] as Array<{ id: string; startedAt: Date | null }>,
    counted = undefined as ((where: unknown) => void) | undefined,
  } = {},
) {
  const preferences: Record<string, unknown> = {};
  if (accountDefault) preferences.defaultPermissionMode = accountDefault;
  if (allowance !== undefined) preferences.cardFreeTaskCreates = allowance;
  return sessionCreateAllowedBy(
    {
      session: {
        findFirst: async () => (session ? { permissionMode: mode, engine: 'claude', owner: { preferences } } : null),
      },
      task: { count: async ({ where }: { where: unknown }) => (counted?.(where), created) },
      project: { findMany: async () => coordinated },
    } as never,
    { id: 'session', ownerId: 'owner' },
    toolName,
    input,
  );
}

const batch = (n: number) => ({ tasks: Array.from({ length: n }, (_, i) => ({ title: `t${i}` })) });

test('the default is 8', () => {
  assert.equal(DEFAULT_CARD_FREE_TASK_CREATES, 8);
});

test('by default a session files 8 tasks without a card', async () => {
  assert.equal(await ask('orbit_task_create', { title: 'a' }), SESSION_CREATE_ALLOWANCE_MESSAGE);
  assert.equal(await ask('orbit_task_create', { title: 'a' }, { created: 7 }), SESSION_CREATE_ALLOWANCE_MESSAGE);
  assert.equal(await ask('orbit_task_batch', batch(8)), SESSION_CREATE_ALLOWANCE_MESSAGE);
  assert.equal(await ask('orbit_task_batch', batch(3), { created: 5 }), SESSION_CREATE_ALLOWANCE_MESSAGE);
});

test('the create that would go past 8 is asked, and every one after it', async () => {
  assert.equal(await ask('orbit_task_create', { title: 'a' }, { created: 8 }), null);
  assert.equal(await ask('orbit_task_create', { title: 'a' }, { created: 12 }), null);
  assert.equal(await ask('orbit_task_batch', batch(9)), null);
  assert.equal(await ask('orbit_task_batch', batch(4), { created: 5 }), null);
});

test("the account's cardFreeTaskCreates replaces the default", async () => {
  assert.equal(await ask('orbit_task_create', {}, { allowance: 0 }), null);
  assert.equal(await ask('orbit_task_create', {}, { allowance: 2, created: 1 }), SESSION_CREATE_ALLOWANCE_MESSAGE);
  assert.equal(await ask('orbit_task_create', {}, { allowance: 2, created: 2 }), null);
  assert.equal(await ask('orbit_task_batch', batch(20), { allowance: 20 }), SESSION_CREATE_ALLOWANCE_MESSAGE);
});

test('a stored value that is not a whole number from 0 to 50 reads as the default', () => {
  for (const bad of [-1, 51, 2.5, '3', null, true, {}]) assert.equal(cardFreeTaskCreates({ cardFreeTaskCreates: bad }), 8, String(bad));
  assert.equal(cardFreeTaskCreates(null), 8);
  assert.equal(cardFreeTaskCreates({ cardFreeTaskCreates: 50 }), 50);
});

test('a session that cannot start work in Auto is asked regardless of the account default', async () => {
  assert.equal(await ask('orbit_task_create', {}, { mode: 'plan' }), null);
  assert.equal(await ask('orbit_task_create', {}, { mode: 'default', accountDefault: 'auto' }), null);
  assert.equal(await ask('orbit_task_create', {}, { mode: 'plan', accountDefault: 'plan' }), null);
  assert.equal(await ask('orbit_task_create', {}, { mode: null, accountDefault: 'default' }), null);
});

test('other cards, unreadable input and an unknown session are asked', async () => {
  assert.equal(await ask('orbit_dag_change', { listId: 'x', ops: [] }), null);
  assert.equal(await ask('Bash', { command: 'ls' }), null);
  assert.equal(await ask('orbit_task_batch', { tasks: 'x' }), null);
  assert.equal(await ask('orbit_task_batch', { tasks: [] }), null);
  assert.equal(await ask('orbit_task_create', {}, { session: false }), null);
});

test("a coordinator's tasks filed before its project started are left out of the count", async () => {
  const started = new Date('2026-11-26T10:00:00Z');
  const wheres: unknown[] = [];
  await ask('orbit_task_create', {}, {
    coordinated: [{ id: 'p1', startedAt: null }, { id: 'p2', startedAt: started }],
    counted: (where) => wheres.push(where),
  });
  await ask('orbit_task_create', {}, { counted: (where) => wheres.push(where) });
  assert.deepEqual(wheres, [
    {
      creatorSessionId: 'session',
      OR: [{ projectId: null }, { NOT: { OR: [{ projectId: 'p1' }, { projectId: 'p2', createdAt: { lt: started } }] } }],
    },
    { creatorSessionId: 'session' },
  ]);
});
