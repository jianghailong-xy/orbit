import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isRunNotifyTurn, runNotifyContent } from './run-notify';

test('M3 notice renders the run, mode and message; a closed notice tells the coordinator to stop', async () => {
  const from = randomUUID(), to = randomUUID(), id = randomUUID();
  let state = 'OPEN';
  const db = {
    sessionRequest: { findFirst: async ({ where }: any) => {
      assert.deepEqual(where, { id, toSessionId: to, kind: 'RUN_NOTIFY' });
      return { ownerId: 'owner', fromSessionId: from, requestPreview: 'The build finished.', state };
    } },
    session: { findFirst: async ({ select }: any) => select.task
      ? { task: { id: randomUUID(), title: 'Build the client' } }
      : { id: from, title: 'Run', taskId: null, workspace: null, engine: 'codex', permissionMode: 'default', owner: { preferences: {} } } },
  };
  const key = `run-notify:v1:${id}`;
  assert.equal(isRunNotifyTurn(key), true);
  assert.equal(await runNotifyContent(db as any, to, 'ordinary'), null);
  const content = await runNotifyContent(db as any, to, key);
  assert.match(content!, /from-mode="default"/);
  assert.match(content!, /Build the client/);
  assert.match(content!, /Message: The build finished\./);
  assert.match(content!, /It did not reach the account owner/);
  assert.match(content!, /Nothing is waiting for your reply/);
  state = 'EXPIRED';
  assert.match((await runNotifyContent(db as any, to, `${key}:retry:nonce`))!, /Nothing to answer; end your turn/);
});
