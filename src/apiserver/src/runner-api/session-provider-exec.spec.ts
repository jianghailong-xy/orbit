import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionProviderExec } from './session-provider-exec';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';

/** One session read as a SubAgent run on its parent's credential reads it, writing nothing. */
function tx(session: Record<string, unknown>) {
  return {
    session: {
      findUnique: async () => ({
        id: SESSION_ID,
        ownerId: OWNER_ID,
        model: 'claude-opus-5',
        usesRuntimeDefaultModel: true,
        assignedRunner: null,
        ...session,
      }),
      updateMany: async () => assert.fail('sessionProviderExec writes nothing'),
    },
    user: { findUnique: async () => ({ role: 'ADMIN' }) },
    modelProvider: { findFirst: async () => null },
  } as never;
}

const queue = {} as never;

test('a SubAgent routed onto a built-in engine runs on the session env laid over the workspace env', async () => {
  const envChangedAt = new Date('2026-11-13T08:00:00Z');
  const resolved = await sessionProviderExec(
    tx({
      provider: 'codex',
      providerBuiltin: true,
      engine: 'codex',
      env: { FOO: 'session', ONLY_SESSION: '1', ORBIT_X: 'never' },
      envChangedAt,
      workspace: { env: { FOO: 'workspace', ONLY_WORKSPACE: '1' } },
    }),
    queue,
    SESSION_ID,
    { engine: 'claude', provider: 'claude', model: 'claude-opus-5' },
  );

  assert.equal(resolved.refusal, undefined);
  assert.equal(resolved.exec?.env?.FOO, 'session');
  assert.equal(resolved.exec?.env?.ONLY_SESSION, '1');
  assert.equal(resolved.exec?.env?.ONLY_WORKSPACE, '1');
  assert.equal(resolved.exec?.env?.ORBIT_X, undefined);
  assert.equal(resolved.envChangedAt, envChangedAt);
});
