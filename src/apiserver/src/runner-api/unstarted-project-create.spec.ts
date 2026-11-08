import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import {
  AUTOMATIC_COORDINATOR_DECIDES_MESSAGE,
  coordinatorCreateAllowedBy,
  START_CARD_REVIEWS_MESSAGE,
} from './unstarted-project-create';

const PROJECT = '01a19d33-bdd5-769c-b8e8-35bd3fb0df58';

function ask(project: Record<string, unknown> | null) {
  return coordinatorCreateAllowedBy(
    { project: { findFirst: async () => project } } as never,
    { id: 'coordinator', ownerId: 'owner' },
    'orbit_task_create',
    { projectId: uuidToBase62(PROJECT) },
  );
}

const started = (permissionMode: string | null, accountDefault: string | null, coordinatorEnabled = true) => ({
  startedAt: new Date(),
  coordinatorEnabled,
  coordinatorSession: { permissionMode, engine: 'claude' },
  owner: { preferences: accountDefault ? { defaultPermissionMode: accountDefault } : {} },
});

test('Automatic answers for a coordinator no narrower than the account default', async () => {
  for (const [mode, accountDefault] of [
    ['auto', null],
    ['bypassPermissions', null],
    ['dontAsk', null],
    [null, null],
    ['default', 'default'],
    ['plan', 'plan'],
    ['default', 'plan'],
  ]) {
    assert.equal(await ask(started(mode, accountDefault)), AUTOMATIC_COORDINATOR_DECIDES_MESSAGE, `${mode}, ${accountDefault}`);
  }
});

test('Automatic does not answer for a coordinator narrower than the account default: a person is asked', async () => {
  for (const [mode, accountDefault] of [
    ['default', null],
    ['acceptEdits', null],
    ['plan', null],
    ['default', 'auto'],
    ['plan', 'default'],
    ['dontAsk', 'bypassPermissions'],
  ]) {
    assert.equal(await ask(started(mode, accountDefault)), null, `${mode}, ${accountDefault}`);
  }
});

test('the start card answers for any coordinator, and Automatic off is asked as before', async () => {
  assert.equal(await ask({ ...started('plan', null), startedAt: null }), START_CARD_REVIEWS_MESSAGE);
  assert.equal(await ask(started('auto', null, false)), null);
  assert.equal(await ask(null), null);
});
