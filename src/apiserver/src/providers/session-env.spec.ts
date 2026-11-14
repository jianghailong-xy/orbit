import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AgentProvider, type RunnerEngineHealth } from '@orbit/shared';
import { encryptSecret } from './provider-crypto';
import { engineBaseEnv, resolveProviderExec } from './custom-provider';

/**
 * The env an engine starts on: the workspace's, the session's own (Session.env) over it, and whatever
 * dispatch injects — a configured provider's endpoint and key, a built-in account's directory — over
 * both. ORBIT_* names never come from the session's env.
 */

const keyRow = () => ({
  runtime: 'claude',
  baseUrl: 'https://api.deepseek.com/anthropic',
  apiKeyEnc: encryptSecret('sk-ds'),
  defaultModel: 'deepseek-chat',
  enabled: true,
});

const WORK = '3fa91c2e';
const workHome = `/root/.orbit/codex-accounts/${WORK}`;
const codexRunner = {
  engines: [{
    engine: 'codex',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' },
      { id: WORK, home: workHome, codexHome: workHome, auth: 'yes' },
    ],
  }] as RunnerEngineHealth[],
  defaultRemoved: null,
  accountPauses: null,
  planUsage: null,
};

const builtinClaude = (workspaceEnv: Record<string, string> | null, sessionEnv?: unknown) =>
  resolveProviderExec({ declaredProvider: 'claude', customRow: null, sessionModel: 'claude-opus-4-8', workspaceEnv, sessionEnv }).env;

test('session env over workspace env', async (t) => {
  process.env.PROVIDER_SECRET_KEY = 'test-master-key';

  await t.test('workspace only: the workspace env is passed through as it was', () => {
    assert.deepEqual(builtinClaude({ FOO: 'ws' }), { FOO: 'ws' });
    assert.deepEqual(builtinClaude({ FOO: 'ws' }, null), { FOO: 'ws' });
    assert.deepEqual(builtinClaude({ FOO: 'ws' }, {}), { FOO: 'ws' });
    assert.equal(builtinClaude(null, null), undefined);
  });

  await t.test('session overrides workspace on the same name and adds its own', () => {
    assert.deepEqual(builtinClaude({ FOO: 'ws', KEEP: '1' }, { FOO: 'session', BAR: 'b' }), { FOO: 'session', KEEP: '1', BAR: 'b' });
    // A session's env stands on its own when the workspace has none.
    assert.deepEqual(builtinClaude(null, { BAR: 'b' }), { BAR: 'b' });
  });

  await t.test('a configured provider\'s injected vars still override the session\'s', () => {
    const env = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: keyRow(),
      sessionModel: null,
      workspaceEnv: { ANTHROPIC_BASE_URL: 'https://workspace-typed', KEEP: '1' },
      sessionEnv: { ANTHROPIC_BASE_URL: 'https://session-typed', ANTHROPIC_AUTH_TOKEN: 'sk-session', MINE: 'm' },
    }).env;
    assert.equal(env?.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(env?.ANTHROPIC_AUTH_TOKEN, 'sk-ds');
    assert.equal(env?.KEEP, '1');
    assert.equal(env?.MINE, 'm');
  });

  await t.test('a built-in account\'s directory still overrides the session\'s', () => {
    const env = resolveProviderExec({
      engine: AgentProvider.CODEX,
      declaredProvider: AgentProvider.CODEX,
      declaredProviderBuiltin: true,
      customRow: null,
      sessionModel: null,
      workspaceEnv: { KEEP: '1' },
      sessionEnv: { CODEX_HOME: '/root/.codex', MINE: 'm' },
      codexAccount: WORK,
      runner: codexRunner,
    }).env;
    assert.deepEqual(env, { KEEP: '1', MINE: 'm', CODEX_HOME: workHome });
  });

  await t.test('ORBIT_* never comes from the session env', () => {
    assert.deepEqual(
      builtinClaude({ ORBIT_FROM_WORKSPACE: 'w' }, { ORBIT_TASK_ID: 'x', orbit_lower: 'y', ORBIT_FROM_WORKSPACE: 'z', OK: '1' }),
      { ORBIT_FROM_WORKSPACE: 'w', OK: '1' },
    );
    // Nor a Cursor key smuggled in through it.
    const cursor = resolveProviderExec({
      engine: AgentProvider.CURSOR,
      declaredProvider: AgentProvider.CURSOR,
      customRow: null,
      sessionModel: null,
      sessionEnv: { ORBIT_CURSOR_API_KEY: 'k' },
    }).env;
    assert.equal(cursor?.ORBIT_CURSOR_API_KEY, undefined);
  });

  await t.test('engineBaseEnv: non-string values are left out; nothing at all is null', () => {
    assert.deepEqual(engineBaseEnv({ A: '1' }, { B: 2, C: '3' }), { A: '1', C: '3' });
    assert.equal(engineBaseEnv(null, null), null);
    assert.equal(engineBaseEnv(undefined, ['x']), null);
  });
});
