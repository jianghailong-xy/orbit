import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SESSION_CREATE_ALLOWANCE_MESSAGE, sessionCreateAllowedBy } from './session-create-allowance';

function ask(
  toolName: string,
  input: unknown,
  { created = 0, mode = 'auto' as string | null, accountDefault = null as string | null, session = true } = {},
) {
  return sessionCreateAllowedBy(
    {
      session: {
        findFirst: async () =>
          session
            ? { permissionMode: mode, engine: 'claude', owner: { preferences: accountDefault ? { defaultPermissionMode: accountDefault } : {} } }
            : null,
      },
      task: { count: async () => created },
    } as never,
    { id: 'session', ownerId: 'owner' },
    toolName,
    input,
  );
}

const batch = (n: number) => ({ tasks: Array.from({ length: n }, (_, i) => ({ title: `t${i}` })) });

test('a session under 8 created tasks is answered without a card', async () => {
  assert.equal(await ask('orbit_task_create', { title: 'a' }), SESSION_CREATE_ALLOWANCE_MESSAGE);
  assert.equal(await ask('orbit_task_create', { title: 'a' }, { created: 6 }), SESSION_CREATE_ALLOWANCE_MESSAGE);
  assert.equal(await ask('orbit_task_batch', batch(7)), SESSION_CREATE_ALLOWANCE_MESSAGE);
  assert.equal(await ask('orbit_task_batch', batch(3), { created: 4 }), SESSION_CREATE_ALLOWANCE_MESSAGE);
});

test('the create that would reach 8 is asked, and every one after it', async () => {
  assert.equal(await ask('orbit_task_create', { title: 'a' }, { created: 7 }), null);
  assert.equal(await ask('orbit_task_create', { title: 'a' }, { created: 12 }), null);
  assert.equal(await ask('orbit_task_batch', batch(8)), null);
  assert.equal(await ask('orbit_task_batch', batch(4), { created: 4 }), null);
});

test('a session narrower than the account default is asked', async () => {
  assert.equal(await ask('orbit_task_create', {}, { mode: 'plan' }), null);
  assert.equal(await ask('orbit_task_create', {}, { mode: 'default', accountDefault: 'auto' }), null);
  assert.equal(await ask('orbit_task_create', {}, { mode: 'plan', accountDefault: 'plan' }), SESSION_CREATE_ALLOWANCE_MESSAGE);
  assert.equal(await ask('orbit_task_create', {}, { mode: null, accountDefault: 'default' }), SESSION_CREATE_ALLOWANCE_MESSAGE);
});

test('other cards, unreadable input and an unknown session are asked', async () => {
  assert.equal(await ask('orbit_dag_change', { listId: 'x', ops: [] }), null);
  assert.equal(await ask('Bash', { command: 'ls' }), null);
  assert.equal(await ask('orbit_task_batch', { tasks: 'x' }), null);
  assert.equal(await ask('orbit_task_batch', { tasks: [] }), null);
  assert.equal(await ask('orbit_task_create', {}, { session: false }), null);
});
