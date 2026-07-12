import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encryptSecret } from './provider-crypto';
import { isBuiltinProvider, resolveProviderExec } from './custom-provider';

const row = (over: Partial<Parameters<typeof resolveProviderExec>[0]['customRow'] & object> = {}) => ({
  runtime: 'claude',
  baseUrl: 'https://api.deepseek.com/anthropic',
  apiKeyEnc: encryptSecret('sk-ds'),
  defaultModel: 'deepseek-chat',
  enabled: true,
  ...over,
});

test('custom-provider', async (t) => {
  process.env.PROVIDER_SECRET_KEY = 'test-master-key';

  await t.test('isBuiltinProvider: built-ins and unset are built-in; a slug is not', () => {
    assert.equal(isBuiltinProvider('claude'), true);
    assert.equal(isBuiltinProvider('codex'), true);
    assert.equal(isBuiltinProvider(null), true);
    assert.equal(isBuiltinProvider(undefined), true);
    assert.equal(isBuiltinProvider('deepseek'), false);
  });

  await t.test('built-in claude: model kept, agent env passed through, no injection', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'claude',
      customRow: null,
      sessionModel: 'claude-opus-4-8',
      agentModel: null,
      agentEnv: { FOO: 'bar' },
    });
    assert.equal(exec.provider, 'claude');
    assert.equal(exec.model, 'claude-opus-4-8');
    assert.deepEqual(exec.env, { FOO: 'bar' });
  });

  await t.test('built-in codex: a stale claude-* model is coerced to the codex default', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'codex',
      customRow: null,
      sessionModel: 'claude-opus-4-8',
      agentModel: null,
      agentEnv: null,
    });
    assert.equal(exec.provider, 'codex');
    assert.equal(exec.model, 'gpt-5.6-sol');
  });

  await t.test('custom provider: borrows claude, injects anthropic env, keeps its own model', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row(),
      sessionModel: null,
      agentModel: null,
      agentEnv: { KEEP: '1' },
    });
    assert.equal(exec.provider, 'claude'); // runner-facing runtime
    assert.equal(exec.model, 'deepseek-chat'); // provider default
    assert.equal(exec.env?.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(exec.env?.ANTHROPIC_AUTH_TOKEN, 'sk-ds');
    assert.equal(exec.env?.KEEP, '1'); // agent env preserved
  });

  await t.test('custom provider: an explicit session model wins over the provider default', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row(),
      sessionModel: 'deepseek-reasoner',
      agentModel: null,
      agentEnv: null,
    });
    assert.equal(exec.model, 'deepseek-reasoner');
  });

  await t.test('provider env overrides a user-typed agent env of the same name', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row({ baseUrl: 'https://real', apiKeyEnc: encryptSecret('realkey') }),
      sessionModel: null,
      agentModel: null,
      agentEnv: { ANTHROPIC_BASE_URL: 'https://user-typed' },
    });
    assert.equal(exec.env?.ANTHROPIC_BASE_URL, 'https://real');
    assert.equal(exec.env?.ANTHROPIC_AUTH_TOKEN, 'realkey');
  });

  await t.test('a disabled custom row falls back to the claude runtime with no injected env', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row({ enabled: false }),
      sessionModel: null,
      agentModel: 'claude-opus-4-8',
      agentEnv: { A: '1' },
    });
    assert.equal(exec.provider, 'claude');
    assert.equal(exec.model, 'claude-opus-4-8');
    assert.deepEqual(exec.env, { A: '1' });
  });
});
