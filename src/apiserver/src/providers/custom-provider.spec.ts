import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encryptSecret } from './provider-crypto';
import { AgentProvider, providerPreset } from '@orbit/shared';
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
    assert.equal(isBuiltinProvider('kimi'), true);
    assert.equal(isBuiltinProvider('kimi', false), false);
    assert.equal(isBuiltinProvider('opencode'), true);
    assert.equal(isBuiltinProvider(null), true);
    assert.equal(isBuiltinProvider(undefined), true);
    assert.equal(isBuiltinProvider('deepseek'), false);
  });

  await t.test('a stale old-replica kimi identity is fenced to the historical Claude fallback', () => {
    const exec = resolveProviderExec({
      declaredProvider: AgentProvider.KIMI,
      declaredProviderBuiltin: false,
      customRow: null,
      sessionModel: 'kimi-k2.7-code',
    });
    assert.equal(exec.provider, AgentProvider.CLAUDE);
    assert.equal(exec.model, 'claude-opus-5');
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

  await t.test('built-in resolution follows session > legacy bridge > runtime > catalog > static', () => {
    const base = {
      declaredProvider: AgentProvider.CODEX,
      customRow: null,
      runtimeDefaultModels: { codex: 'gpt-runtime' },
      agentModel: null,
      modelCatalog: { codex: [{ value: 'gpt-catalog', label: 'Catalog' }] },
    };
    assert.equal(resolveProviderExec({ ...base, sessionModel: 'gpt-session' }).model, 'gpt-session');
    assert.equal(resolveProviderExec({ ...base, sessionModel: null }).model, 'gpt-runtime');
    assert.equal(
      resolveProviderExec({
        ...base,
        sessionModel: null,
        agentModel: 'gpt-legacy-agent',
        usesRuntimeDefaultModel: false,
      }).model,
      'gpt-legacy-agent',
    );
    assert.equal(
      resolveProviderExec({ ...base, sessionModel: null, runtimeDefaultModels: {} }).model,
      'gpt-catalog',
    );
    assert.equal(
      resolveProviderExec({
        ...base,
        sessionModel: null,
        runtimeDefaultModels: {},
        agentModel: 'gpt-legacy-agent',
        usesRuntimeDefaultModel: false,
      }).model,
      'gpt-legacy-agent',
    );
    assert.equal(
      resolveProviderExec({
        ...base,
        sessionModel: null,
        runtimeDefaultModels: {},
        agentModel: null,
        modelCatalog: {},
      }).model,
      'gpt-5.6-sol',
    );
  });

  await t.test('cross-runtime defaults are skipped and a legacy pin keeps old safety coercion', () => {
    const exec = resolveProviderExec({
      declaredProvider: AgentProvider.CODEX,
      customRow: null,
      sessionModel: null,
      runtimeDefaultModels: { codex: 'claude-opus-5' },
      agentModel: null,
      modelCatalog: { codex: [{ value: 'gpt-catalog', label: 'Catalog' }] },
    });
    assert.equal(exec.model, 'gpt-catalog');

    const legacy = resolveProviderExec({
      declaredProvider: AgentProvider.CODEX,
      customRow: null,
      sessionModel: null,
      runtimeDefaultModels: { codex: 'gpt-runtime' },
      agentModel: 'claude-opus-5',
      usesRuntimeDefaultModel: false,
    });
    assert.equal(legacy.model, 'gpt-5.6-sol');

    // Explicit session values keep the old coercion contract instead of silently choosing a
    // different catalog entry than the user asked for.
    const explicit = resolveProviderExec({
      declaredProvider: AgentProvider.CODEX,
      customRow: null,
      sessionModel: 'claude-opus-5',
      modelCatalog: { codex: [{ value: 'gpt-catalog', label: 'Catalog' }] },
    });
    assert.equal(explicit.model, 'gpt-5.6-sol');
  });

  await t.test('configured providers ignore runner runtime/catalog defaults', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row(),
      sessionModel: null,
      runtimeDefaultModels: { claude: 'claude-opus-5' },
      agentModel: null,
      modelCatalog: { claude: [{ value: 'claude-sonnet-5', label: 'Sonnet' }] },
    });
    assert.equal(exec.model, 'deepseek-chat');
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

  await t.test('built-in kimi: dispatches directly with its default and no Claude token', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'kimi',
      customRow: null,
      sessionModel: null,
      agentModel: null,
      agentEnv: null,
      claudeOauthToken: 'sk-ant-oat-abc',
    });
    assert.equal(exec.provider, 'kimi');
    assert.equal(exec.model, 'kimi-code/kimi-for-coding');
    assert.equal(exec.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });

  await t.test('configured provider runtime remains limited to Claude/Codex semantics', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'legacy-row',
      customRow: row({ runtime: 'kimi' }),
      sessionModel: null,
      agentModel: null,
      agentEnv: null,
    });
    assert.equal(exec.provider, 'claude');
    assert.equal(exec.env?.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  });

  await t.test('built-in opencode: model and agent env pass through without a Claude token', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'opencode',
      customRow: null,
      sessionModel: 'anthropic/claude-sonnet-4-5',
      agentModel: null,
      agentEnv: { KEEP: '1' },
      claudeOauthToken: 'sk-ant-oat-must-not-leak',
    });
    assert.equal(exec.provider, 'opencode');
    assert.equal(exec.model, 'anthropic/claude-sonnet-4-5');
    assert.equal(exec.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.deepEqual(exec.env, { KEEP: '1' });
  });

  await t.test('preset-backed provider: a retired stored default yields to the catalogue', () => {
    // The row was created when Anthropic's preset defaulted to a model we no longer list; nothing
    // has been saved since, so only the preset link can keep dispatch off a dead model id.
    const exec = resolveProviderExec({
      declaredProvider: 'anthropic',
      customRow: row({ presetSlug: 'anthropic', followsPreset: true, defaultModel: 'claude-opus-4-0' }),
      sessionModel: null,
      agentModel: null,
    });
    assert.equal(exec.model, providerPreset('anthropic')!.defaultModel);
    // An explicit pick still wins over both.
    const picked = resolveProviderExec({
      declaredProvider: 'anthropic',
      customRow: row({ presetSlug: 'anthropic', followsPreset: true, defaultModel: 'claude-opus-4-0' }),
      sessionModel: 'claude-haiku-4-5-20251001',
      agentModel: null,
    });
    assert.equal(picked.model, 'claude-haiku-4-5-20251001');
  });

  await t.test('custom provider preserves a legacy Agent pin until claim materializes it', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row(),
      sessionModel: '  \t ',
      agentModel: 'hidden-legacy-agent-model',
      usesRuntimeDefaultModel: false,
      agentEnv: { KEEP: '1' },
    });
    assert.equal(exec.provider, 'claude'); // runner-facing runtime
    assert.equal(exec.model, 'hidden-legacy-agent-model');
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

  await t.test('a disabled custom row preserves its legacy Agent pin during rolling deploy', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row({ enabled: false }),
      sessionModel: null,
      agentModel: 'claude-opus-4-8',
      usesRuntimeDefaultModel: false,
      runtimeDefaultModels: { claude: 'claude-sonnet-5' },
      agentEnv: { A: '1' },
    });
    assert.equal(exec.provider, 'claude');
    assert.equal(exec.model, 'claude-opus-4-8');
    assert.deepEqual(exec.env, { A: '1' });
  });

  await t.test('new model-less sessions ignore legacy Agent pins and use Runtime defaults', () => {
    const exec = resolveProviderExec({
      declaredProvider: AgentProvider.CODEX,
      customRow: null,
      sessionModel: null,
      usesRuntimeDefaultModel: true,
      agentModel: 'gpt-legacy-agent',
      runtimeDefaultModels: { codex: 'gpt-runtime' },
    });
    assert.equal(exec.model, 'gpt-runtime');
  });

  await t.test('old-replica model-less sessions retain the old static fallback without an Agent', () => {
    const exec = resolveProviderExec({
      declaredProvider: AgentProvider.CODEX,
      customRow: null,
      sessionModel: null,
      usesRuntimeDefaultModel: false,
      agentModel: null,
      runtimeDefaultModels: { codex: 'gpt-runtime' },
    });
    assert.equal(exec.model, 'gpt-5.6-sol');
  });

  // The account-level subscription token supplies credentials for the BUILT-IN claude runtime
  // on every runner; it must not leak into another built-in runtime, and must not override a
  // configured provider (which carries its own key) or an agent that hand-set the variable.
  await t.test('subscription token: injected for built-in claude, alongside agent env', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'claude',
      customRow: null,
      sessionModel: null,
      agentModel: null,
      agentEnv: { KEEP: '1' },
      claudeOauthToken: 'sk-ant-oat-abc',
    });
    assert.equal(exec.provider, 'claude');
    assert.equal(exec.env?.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-abc');
    assert.equal(exec.env?.KEEP, '1');
  });

  await t.test('subscription token: never injected for the codex runtime', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'codex',
      customRow: null,
      sessionModel: null,
      agentModel: null,
      agentEnv: null,
      claudeOauthToken: 'sk-ant-oat-abc',
    });
    assert.equal(exec.provider, 'codex');
    assert.equal(exec.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });

  await t.test('subscription token: a configured provider keeps its own credentials', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row(),
      sessionModel: null,
      agentModel: null,
      agentEnv: null,
      claudeOauthToken: 'sk-ant-oat-abc',
    });
    assert.equal(exec.env?.ANTHROPIC_AUTH_TOKEN, 'sk-ds');
    assert.equal(exec.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });

  await t.test('subscription token: an agent that hand-set the variable wins', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'claude',
      customRow: null,
      sessionModel: null,
      agentModel: null,
      agentEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'agent-owned' },
      claudeOauthToken: 'sk-ant-oat-abc',
    });
    assert.equal(exec.env?.CLAUDE_CODE_OAUTH_TOKEN, 'agent-owned');
  });

  // A named subscription account (authMode "subscription"): one Claude account picked per agent.
  // Its secret is a setup-token, not an API key, so it must reach the runner as
  // CLAUDE_CODE_OAUTH_TOKEN and must NOT redirect the endpoint the way an API-key row does.
  await t.test('subscription account: injects the token and no endpoint', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'work-account',
      customRow: row({
        authMode: 'subscription',
        apiKeyEnc: encryptSecret('sk-ant-oat-work'),
        baseUrl: 'https://api.anthropic.com',
        presetSlug: 'anthropic',
        followsPreset: true,
        defaultModel: null,
      }),
      sessionModel: null,
      agentModel: null,
      agentEnv: null,
    });
    assert.equal(exec.provider, 'claude');
    assert.equal(exec.env?.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-work');
    assert.equal(exec.env?.ANTHROPIC_BASE_URL, undefined);
    assert.equal(exec.env?.ANTHROPIC_AUTH_TOKEN, undefined);
  });

  // The escape hatch people used before accounts existed keeps working: for a credential-only
  // row, agent env wins — the opposite of an API-key row, whose endpoint must not be overridable.
  await t.test('subscription account: an agent that hand-set the variable still wins', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'work-account',
      customRow: row({
        authMode: 'subscription',
        apiKeyEnc: encryptSecret('sk-ant-oat-work'),
        defaultModel: null,
      }),
      sessionModel: null,
      agentModel: null,
      agentEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'agent-owned', KEEP: '1' },
    });
    assert.equal(exec.env?.CLAUDE_CODE_OAUTH_TOKEN, 'agent-owned');
    assert.equal(exec.env?.KEEP, '1');
  });

  await t.test('api-key provider still overrides a hand-typed endpoint', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row(),
      sessionModel: null,
      agentModel: null,
      agentEnv: { ANTHROPIC_BASE_URL: 'https://evil.example', KEEP: '1' },
    });
    assert.equal(exec.env?.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(exec.env?.ANTHROPIC_AUTH_TOKEN, 'sk-ds');
    assert.equal(exec.env?.KEEP, '1');
  });

  // A rotated encryption key must degrade to the runner's own login, never fail the dispatch.
  await t.test('subscription account: an undecryptable token injects nothing', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'work-account',
      customRow: row({ authMode: 'subscription', apiKeyEnc: 'not:valid:ciphertext', defaultModel: null }),
      sessionModel: null,
      agentModel: null,
      agentEnv: { KEEP: '1' },
    });
    assert.equal(exec.provider, 'claude');
    assert.equal(exec.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(exec.env?.KEEP, '1');
  });

  await t.test('no token configured leaves the built-in claude env untouched', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'claude',
      customRow: null,
      sessionModel: null,
      agentModel: null,
      agentEnv: { A: '1' },
      claudeOauthToken: null,
    });
    assert.deepEqual(exec.env, { A: '1' });
  });
});
