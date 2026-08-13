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

  await t.test('built-in kimi: dispatches directly with its own default', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'kimi',
      customRow: null,
      sessionModel: null,
      agentModel: null,
      agentEnv: null,
    });
    assert.equal(exec.provider, 'kimi');
    assert.equal(exec.model, 'kimi-code/kimi-for-coding');
  });

  const kimiRow = (over: Record<string, unknown> = {}) =>
    row({
      runtime: 'kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKeyEnc: encryptSecret('sk-moon'),
      defaultModel: 'kimi-k2.7-code',
      ...over,
    });

  await t.test('configured kimi provider: the Kimi CLI runs on this row, not the runner sign-in', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'moonshot',
      customRow: kimiRow(),
      sessionModel: null,
      agentModel: null,
      agentEnv: { KEEP: '1' },
    });
    assert.equal(exec.provider, 'kimi');
    assert.equal(exec.model, 'kimi-k2.7-code');
    // The CLI activates its injected provider only with the whole set present; a missing half
    // silently leaves the session on whatever account that machine is signed into.
    assert.equal(exec.env?.KIMI_MODEL_NAME, 'kimi-k2.7-code');
    assert.equal(exec.env?.KIMI_MODEL_API_KEY, 'sk-moon');
    assert.equal(exec.env?.KIMI_MODEL_BASE_URL, 'https://api.moonshot.ai/v1');
    assert.equal(exec.env?.KIMI_MODEL_PROVIDER_TYPE, 'kimi');
    assert.equal(exec.env?.KEEP, '1');
    // Nothing Anthropic-shaped rides along — that pair is what used to send this key to Claude.
    assert.equal(exec.env?.ANTHROPIC_BASE_URL, undefined);
    assert.equal(exec.env?.ANTHROPIC_AUTH_TOKEN, undefined);
  });

  await t.test('configured kimi provider: the chosen model travels in the environment', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'moonshot',
      customRow: kimiRow(),
      sessionModel: 'kimi-k3',
      agentModel: null,
      agentEnv: null,
    });
    // Kimi's ACP `model` option would switch the session back to the runner's own sign-in, so
    // KIMI_MODEL_NAME is the only place the picked model can reach the CLI.
    assert.equal(exec.model, 'kimi-k3');
    assert.equal(exec.env?.KIMI_MODEL_NAME, 'kimi-k3');
  });

  await t.test('built-in opencode: model and agent env pass through untouched', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'opencode',
      customRow: null,
      sessionModel: 'anthropic/claude-sonnet-4-5',
      agentModel: null,
      agentEnv: { KEEP: '1' },
    });
    assert.equal(exec.provider, 'opencode');
    assert.equal(exec.model, 'anthropic/claude-sonnet-4-5');
    // Nothing is added alongside the agent's own env — the control plane injects no credential.
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

  await t.test("a vendor on the runtime CLI's own endpoint follows the runner's live catalogue", () => {
    // The preset's list is a fallback for these rows, not a catalogue — so a model-less session
    // must dispatch (and materialize) the newest model the installed CLI reports, exactly as the
    // pickers already show it. Otherwise a BYOK Anthropic provider keeps starting on the shipped
    // fallback long after its successor landed.
    const anthropic = () =>
      row({ presetSlug: 'anthropic', followsPreset: true, defaultModel: 'claude-opus-4-8' });
    const catalogue = { claude: [{ value: 'claude-opus-6', label: 'Opus 6' }] };
    const fromCatalogue = resolveProviderExec({
      declaredProvider: 'anthropic',
      customRow: anthropic(),
      sessionModel: null,
      modelCatalog: catalogue,
    });
    assert.equal(fromCatalogue.model, 'claude-opus-6');
    // The runtime's own reported default outranks the catalogue, as in the pickers.
    const fromRuntime = resolveProviderExec({
      declaredProvider: 'anthropic',
      customRow: anthropic(),
      sessionModel: null,
      runtimeDefaultModels: { claude: 'claude-sonnet-5' },
      modelCatalog: catalogue,
    });
    assert.equal(fromRuntime.model, 'claude-sonnet-5');
    // An explicit session pick still wins over both.
    const picked = resolveProviderExec({
      declaredProvider: 'anthropic',
      customRow: anthropic(),
      sessionModel: 'claude-haiku-4-5-20251001',
      runtimeDefaultModels: { claude: 'claude-sonnet-5' },
      modelCatalog: catalogue,
    });
    assert.equal(picked.model, 'claude-haiku-4-5-20251001');
  });

  await t.test('a third-party vendor keeps its own default despite the runner catalogue', () => {
    // The runner probes its own Claude CLI, which says nothing about what DeepSeek serves: reading
    // that catalogue here would dispatch a claude model id at an endpoint that has never heard of
    // it. Only the vendors whose endpoint IS that CLI's follow it.
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row({ presetSlug: 'deepseek', followsPreset: true, defaultModel: null }),
      sessionModel: null,
      runtimeDefaultModels: { claude: 'claude-opus-6' },
      modelCatalog: { claude: [{ value: 'claude-opus-6', label: 'Opus 6' }] },
    });
    assert.equal(exec.model, providerPreset('deepseek')!.defaultModel);
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

  // Otherwise Claude Code opens every turn by warning that unsetting the key would restore
  // claude.ai connectors — advice that would break the provider it was injected for.
  await t.test('custom provider turns claude.ai connectors off instead of being warned about them', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row(),
      sessionModel: null,
      agentModel: null,
      agentEnv: null,
    });
    assert.equal(exec.env?.ENABLE_CLAUDEAI_MCP_SERVERS, '0');
  });

  // A codex-runtime provider never launches the claude CLI, so the flag has nothing to say there.
  await t.test('codex-runtime provider gets only the OpenAI-compatible vars', () => {
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek',
      customRow: row({ runtime: 'codex' }),
      sessionModel: null,
      agentModel: null,
      agentEnv: null,
    });
    assert.deepEqual(Object.keys(exec.env ?? {}).sort(), ['OPENAI_API_KEY', 'OPENAI_BASE_URL']);
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
});
