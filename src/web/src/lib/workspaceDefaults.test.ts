import { describe, expect, it } from 'vitest';
import { AgentProvider, type RunnerModelCatalog } from '@orbit/shared';
import {
  clampPermissionModeForModel,
  CLAUDE_EFFORT_OPTIONS,
  CODEX_EFFORT_OPTIONS,
  contextWindowFor,
  defaultEngineOf,
  defaultModelFor,
  defaultModelKey,
  effectiveSessionEffort,
  effectiveSessionModel,
  effortOptionsFor,
  KIMI_EFFORT_OPTIONS,
  KIMI_MODEL_OPTIONS,
  livePinnedModel,
  modelOptionsFor,
  newSessionEffortFor,
  newSessionModelFor,
  normalizeEffortFor,
  OPENCODE_EFFORT_OPTIONS,
  ANTIGRAVITY_EFFORT_OPTIONS,
  ANTIGRAVITY_MODEL_OPTIONS,
  permissionModeSupported,
  providerEngines,
  providerIdentityResolved,
  rememberedModel,
  sessionEngineOf,
  sessionPick,
  supportsAuto,
  type ConfiguredProvider,
} from './workspaceDefaults';

const { CLAUDE, CODEX, KIMI, ANTIGRAVITY, OPENCODE, DSH } = AgentProvider;

describe('remembered new-session models', () => {
  const catalog: RunnerModelCatalog = { codex: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
  ] };
  const defaults = { codex: 'gpt-5.6-sol' };
  it('uses only this engine and provider’s last pick and drops retired models', () => {
    expect(newSessionModelFor(CODEX, 'codex', { 'codex:codex': 'gpt-6.1-sol' }, catalog, null, defaults)).toBe('gpt-6.1-sol');
    expect(newSessionModelFor(CODEX, 'codex', { 'claude:claude': 'claude-sonnet-5' }, catalog, null, defaults)).toBe('gpt-5.6-sol');
    expect(newSessionModelFor(CODEX, 'codex', { 'codex:codex': 'gpt-retired' }, catalog, null, defaults)).toBe('gpt-5.6-sol');
  });
  it('keeps a remembered model while the catalog is unavailable, including OpenCode’s empty choice', () => {
    expect(newSessionModelFor(CODEX, 'codex', { 'codex:codex': 'gpt-6.1-sol' }, null, null, defaults)).toBe('gpt-6.1-sol');
    expect(newSessionModelFor(OPENCODE, 'opencode', { 'opencode:opencode': '' }, null, null, { opencode: 'some/model' })).toBe('');
  });
});

describe('the model remembered per engine and provider (contract §6.5)', () => {
  const deepseek: ConfiguredProvider = {
    slug: 'deepseek',
    label: 'DeepSeek',
    runtime: 'claude',
    presetSlug: 'deepseek',
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    engines: ['claude', 'opencode', 'dsh'],
  };
  const configured = [deepseek];

  it('is written under `<engine>:<provider>`', () => {
    expect(defaultModelKey(DSH, 'deepseek-2')).toBe('dsh:deepseek-2');
    expect(defaultModelKey(CODEX, 'codex')).toBe('codex:codex');
  });

  it('keeps one key’s pick on each engine apart', () => {
    const picks = { 'claude:deepseek': 'deepseek-v4-pro', 'dsh:deepseek': 'acp-token-flash' };
    expect(rememberedModel(CLAUDE, 'deepseek', picks, configured)).toBe('deepseek-v4-pro');
    expect(rememberedModel(DSH, 'deepseek', picks, configured)).toBe('acp-token-flash');
    expect(rememberedModel(OPENCODE, 'deepseek', picks, configured)).toBeUndefined();
  });

  it('reads what an older client remembered, on the engine the provider runs on by default only', () => {
    // A bare slug was the engine it ran on before engines were their own field.
    expect(rememberedModel(CLAUDE, 'deepseek', { deepseek: 'deepseek-v4-flash' }, configured)).toBe('deepseek-v4-flash');
    expect(rememberedModel(DSH, 'deepseek', { deepseek: 'deepseek-v4-flash' }, configured)).toBeUndefined();
    expect(rememberedModel(CODEX, 'codex', { codex: 'gpt-6.1-sol' })).toBe('gpt-6.1-sol');
    // OpenCode's old keys: `opencode/<slug>` named the key inside its value; `opencode` its own pick.
    expect(rememberedModel(OPENCODE, 'deepseek', { 'opencode/deepseek': 'orbit-deepseek/deepseek-v4-pro' }, configured)).toBe(
      'deepseek-v4-pro',
    );
    expect(rememberedModel(OPENCODE, 'deepseek', { 'opencode/deepseek': 'orbit-glm/glm-5' }, configured)).toBeUndefined();
    expect(rememberedModel(OPENCODE, 'opencode', { opencode: 'anthropic/claude-sonnet-4' })).toBe('anthropic/claude-sonnet-4');
    expect(rememberedModel(OPENCODE, 'opencode', { opencode: 'orbit-deepseek/deepseek-v4-pro' })).toBeUndefined();
    // The pair's own key wins over an old one.
    expect(rememberedModel(CLAUDE, 'deepseek', { deepseek: 'old', 'claude:deepseek': 'new' }, configured)).toBe('new');
  });
});

describe('which engines a provider runs on (the compatibility table, read off GET /providers)', () => {
  const key = (over: Partial<ConfiguredProvider>): ConfiguredProvider => ({ slug: 'k', label: 'K', runtime: 'claude', models: [], ...over });

  it('gives an engine’s own sign-in its engine, OpenCode’s own configuration OpenCode', () => {
    expect(providerEngines('claude')).toEqual(['claude']);
    expect(providerEngines('kimi')).toEqual(['kimi']);
    expect(providerEngines('opencode')).toEqual(['opencode']);
    expect(defaultEngineOf('antigravity')).toBe('antigravity');
  });

  it('reads a key’s engines as the server sends them, the default first', () => {
    const deepseek = key({ slug: 'deepseek', presetSlug: 'deepseek', engines: ['claude', 'opencode', 'dsh'] });
    expect(providerEngines('deepseek', [deepseek])).toEqual(['claude', 'opencode', 'dsh']);
    expect(defaultEngineOf('deepseek', [deepseek])).toBe('claude');
    // A subscription token runs on Claude Code alone — only the server can tell.
    expect(providerEngines('max', [key({ slug: 'max', engines: ['claude'] })])).toEqual(['claude']);
  });

  it('reads a row from a payload without `engines` (an account pool) by its protocol, and OpenCode where it says so', () => {
    expect(providerEngines('pool', [key({ slug: 'pool', runtime: 'codex' })])).toEqual(['codex']);
    expect(providerEngines('gw', [key({ slug: 'gw', runtime: 'kimi', runsOnOpenCode: true })])).toEqual(['kimi', 'opencode']);
    expect(providerEngines('old-dsh', [key({ slug: 'old-dsh', runtime: 'dsh' })])).toEqual(['dsh']);
    // A protocol no engine speaks runs nowhere, rather than on Claude Code by default.
    expect(providerEngines('odd', [key({ slug: 'odd', runtime: 'nonsense' })])).toEqual([]);
  });

  it('places the legacy built-in `dsh` on DeepSeek Harness, and knows nothing of a provider since removed', () => {
    expect(providerEngines('dsh', [])).toEqual(['dsh']);
    expect(providerEngines('gone', [])).toEqual([]);
    expect(defaultEngineOf('gone', [])).toBeNull();
  });

  it('keeps a session on the engine it recorded, whichever provider it is on', () => {
    const deepseek = key({ slug: 'deepseek', engines: ['claude', 'opencode', 'dsh'] });
    expect(sessionEngineOf('dsh', 'deepseek', [deepseek])).toBe('dsh');
    expect(sessionEngineOf('opencode', 'gone', [])).toBe('opencode');
    // A row an older replica wrote: placed by its provider, and on Claude Code when that is gone too.
    expect(sessionEngineOf(null, 'deepseek', [deepseek])).toBe('claude');
    expect(sessionEngineOf(undefined, 'codex')).toBe('codex');
    expect(sessionEngineOf(null, 'gone', [])).toBe('claude');
  });

  it('reads an OpenCode session an older client started on a key as that key, with its bare model', () => {
    expect(sessionPick(OPENCODE, 'opencode', 'orbit-deepseek/deepseek-v4-pro')).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    expect(sessionPick(OPENCODE, 'opencode', 'anthropic/claude-sonnet-4')).toEqual({ provider: 'opencode', model: 'anthropic/claude-sonnet-4' });
    expect(sessionPick(OPENCODE, 'deepseek', 'deepseek-v4-pro')).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    expect(sessionPick(CLAUDE, 'claude', 'orbit-deepseek/x')).toEqual({ provider: 'claude', model: 'orbit-deepseek/x' });
  });
});

describe('Claude model capabilities', () => {
  it('knows the current tiers without a static picker list', () => {
    // Claude/Codex options come from the runner catalog only, so there is no list to assert —
    // what still lives here are the per-model traits the CLI cannot report.
    expect(modelOptionsFor(CLAUDE, 'claude')).toEqual([]);
    expect(contextWindowFor('claude-fable-5')).toBe(1_000_000);
    expect(supportsAuto('claude-opus-5', CLAUDE, 'claude')).toBe(true);
    expect(supportsAuto('claude-fable-5', CLAUDE, 'claude')).toBe(true);
    expect(supportsAuto('claude-sonnet-5', CLAUDE, 'claude')).toBe(true);
    expect(supportsAuto('claude-haiku-4-5', CLAUDE, 'claude')).toBe(false);
    // Claude is the only engine that gates Auto per model; Codex has it for any model.
    expect(supportsAuto('gpt-5.6-sol', CODEX, 'codex')).toBe(true);
  });

  it('clamps Auto when the effective Runtime default cannot run it', () => {
    expect(clampPermissionModeForModel('auto', 'claude-haiku-4-5', CLAUDE, 'claude')).toBe('default');
    expect(clampPermissionModeForModel('auto', 'claude-opus-5', CLAUDE, 'claude')).toBe('auto');
    expect(clampPermissionModeForModel('plan', 'claude-haiku-4-5', CLAUDE, 'claude')).toBe('plan');
  });

  it('takes Auto from the assigned runner’s catalog rather than a list in the repo', () => {
    // The picker follows the CLI installed on the machine that will run the session, exactly as
    // the model list and the context window already do. Opus 5.5 is the case that failed: its
    // runner reported it and could run Auto on it, while the composer offered Default only.
    const catalog: RunnerModelCatalog = {
      claude: [
        { value: 'claude-opus-5-5', label: 'Opus 5.5', permissionModes: ['default', 'auto'] },
        { value: 'claude-opus-5', label: 'Opus 5', permissionModes: ['default', 'plan'] },
      ],
    };
    expect(supportsAuto('claude-opus-5-5', CLAUDE, 'claude', null, catalog)).toBe(true);
    expect(clampPermissionModeForModel('auto', 'claude-opus-5-5', CLAUDE, 'claude', null, catalog)).toBe(
      'auto',
    );
    // And a row that withholds Auto wins over the fallback list, which still lists Opus 5.
    expect(supportsAuto('claude-opus-5', CLAUDE, 'claude', null, catalog)).toBe(false);
    expect(clampPermissionModeForModel('auto', 'claude-opus-5', CLAUDE, 'claude', null, catalog)).toBe(
      'default',
    );
    // A model the runner has not reported keeps the fallback answer — silence is not "no".
    expect(supportsAuto('claude-sonnet-5', CLAUDE, 'claude', null, catalog)).toBe(true);
  });
});

describe('Codex model efforts', () => {
  const catalog: RunnerModelCatalog = {
    codex: [
      {
        value: 'gpt-5.6-sol',
        label: 'GPT-5.6-Sol',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
    ],
  };

  it('uses the selected model catalog, including max and Ultra', () => {
    expect(effortOptionsFor(CODEX, 'codex', 'gpt-5.6-sol', catalog)).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'xHigh' },
      { value: 'max', label: 'Max' },
      { value: 'ultra', label: 'Ultra' },
    ]);
    expect(normalizeEffortFor(CODEX, 'codex', 'ultra', 'gpt-5.6-sol', catalog)).toBe('ultra');
    expect(normalizeEffortFor(CODEX, 'codex', 'max', 'gpt-5.6-sol', catalog)).toBe('max');
    expect(normalizeEffortFor(CODEX, 'codex', 'minimal', 'gpt-5.6-sol', catalog)).toBe('');
  });

  it('keeps a closed fallback vocabulary when no catalog row is available', () => {
    expect(effortOptionsFor(CODEX, 'codex')).toEqual(CODEX_EFFORT_OPTIONS);
    expect(normalizeEffortFor(CODEX, 'codex', 'ultra')).toBe('ultra');
    expect(normalizeEffortFor(CODEX, 'codex', 'project-custom')).toBe('');
  });

  it('keeps the account last-picked Ultra over a stale workspace Max', () => {
    expect(
      newSessionEffortFor(CODEX, 'codex', 'ultra', 'max', 'gpt-5.6-sol', catalog),
    ).toBe('ultra');
    expect(newSessionEffortFor(CODEX, 'codex', '', 'max', 'gpt-5.6-sol', catalog)).toBe('');
    expect(
      newSessionEffortFor(CODEX, 'codex', undefined, 'max', 'gpt-5.6-sol', catalog),
    ).toBe('max');
  });
});

describe('effort, permission and Auto by the engine, never the provider’s slug', () => {
  // A Responses gateway key and a DeepSeek key: neither slug names an engine. Read by slug, both were
  // Claude — so a Codex session on the gateway was offered Claude's efforts.
  const gateway: ConfiguredProvider = {
    slug: 'openai-gateway',
    label: 'OpenAI gateway',
    runtime: 'codex',
    models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }],
    engines: ['codex', 'opencode'],
  };
  const deepseek: ConfiguredProvider = {
    slug: 'deepseek',
    label: 'DeepSeek',
    runtime: 'claude',
    presetSlug: 'deepseek',
    models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    engines: ['claude', 'opencode', 'dsh'],
  };
  const configured = [gateway, deepseek];
  const catalog: RunnerModelCatalog = {
    dsh: [{ value: 'acp-pro', label: 'DeepSeek V4 Pro', reasoningLevels: ['off', 'high', 'max'] }],
  };

  it('offers Codex’s levels to a Codex session on a key, and OpenCode’s variants to OpenCode on one', () => {
    expect(effortOptionsFor(CODEX, 'openai-gateway', 'gpt-5.6-sol', null, configured)).toEqual(CODEX_EFFORT_OPTIONS);
    expect(normalizeEffortFor(CODEX, 'openai-gateway', 'minimal', 'gpt-5.6-sol', null, configured)).toBe('minimal');
    expect(effortOptionsFor(OPENCODE, 'deepseek', 'deepseek-v4-pro', null, configured)).toEqual(OPENCODE_EFFORT_OPTIONS);
    expect(effortOptionsFor(KIMI, 'moonshot', 'kimi-k3', null, [])).toEqual(KIMI_EFFORT_OPTIONS);
  });

  it('offers DeepSeek Harness its own catalogue’s levels on whichever DeepSeek key, and Claude’s on Claude Code', () => {
    expect(effortOptionsFor(DSH, 'deepseek', 'acp-pro', catalog, configured).map((option) => option.value)).toEqual([
      '',
      'off',
      'high',
      'max',
    ]);
    expect(normalizeEffortFor(DSH, 'deepseek', 'medium', 'acp-pro', catalog, configured)).toBe('');
    expect(effortOptionsFor(CLAUDE, 'deepseek', 'deepseek-v4-pro', catalog, configured)).toEqual(CLAUDE_EFFORT_OPTIONS);
  });

  it('refuses the permission modes DeepSeek Harness refuses, whichever key it runs on', () => {
    expect(permissionModeSupported('plan', DSH)).toBe(false);
    expect(permissionModeSupported('auto', DSH)).toBe(true);
    expect(permissionModeSupported('plan', CLAUDE)).toBe(true);
    expect(clampPermissionModeForModel('plan', 'acp-pro', DSH, 'deepseek', configured, catalog)).toBe('default');
  });

  it('leaves Auto to a key’s own model space on Claude Code', () => {
    expect(supportsAuto('deepseek-v4-pro', CLAUDE, 'deepseek', configured)).toBe(true);
    expect(supportsAuto('deepseek-v4-pro', CLAUDE, 'claude', configured)).toBe(false);
  });
});

describe('Kimi runtime defaults', () => {
  // What `kimi provider list --json` reports on a signed-in runner: the two K2.7 aliases
  // declare no thinking levels at all, while K3 declares low/high/max.
  const kimiCatalog = {
    kimi: [
      { value: 'kimi-code/kimi-for-coding', label: 'K2.7 Coding', contextWindow: 262_144 },
      { value: 'kimi-code/k3', label: 'K3', contextWindow: 1_048_576,
        reasoningLevels: ['low', 'high', 'max'] },
    ],
  };

  it('falls back to the managed Kimi coding model when no runner catalog is available', () => {
    expect(KIMI_MODEL_OPTIONS).toEqual([
      { value: 'kimi-code/kimi-for-coding', label: 'Kimi for Coding' },
    ]);
    expect(modelOptionsFor(KIMI, 'kimi')).toEqual(KIMI_MODEL_OPTIONS);
    expect(defaultModelFor(KIMI, 'kimi')).toBe('kimi-code/kimi-for-coding');
    expect(contextWindowFor('kimi-code/kimi-for-coding')).toBe(262_144);
    expect(supportsAuto('kimi-code/kimi-for-coding', KIMI, 'kimi')).toBe(true);
    expect(supportsAuto('local-kimi-alias', KIMI, 'kimi')).toBe(true);
  });

  it('lists every model the runner reports, with its own context window', () => {
    expect(modelOptionsFor(KIMI, 'kimi', kimiCatalog)).toEqual([
      { value: 'kimi-code/kimi-for-coding', label: 'K2.7 Coding' },
      { value: 'kimi-code/k3', label: 'K3' },
    ]);
    expect(contextWindowFor('kimi-code/k3', kimiCatalog)).toBe(1_048_576);
  });

  it('offers Kimi efforts without Codex-only minimal when the model is unknown', () => {
    expect(effortOptionsFor(KIMI, 'kimi')).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ]);

    expect(normalizeEffortFor(KIMI, 'kimi', 'minimal')).toBe('low');
    expect(normalizeEffortFor(KIMI, 'kimi', 'medium')).toBe('high');
    expect(normalizeEffortFor(KIMI, 'kimi', 'xhigh')).toBe('max');
    expect(normalizeEffortFor(KIMI, 'kimi', 'high')).toBe('high');
  });

  it("offers each Kimi model only the thinking levels it declares", () => {
    // K2.7 Coding rejects every level with invalid_params, so Default is the whole picker.
    expect(effortOptionsFor(KIMI, 'kimi', 'kimi-code/kimi-for-coding', kimiCatalog)).toEqual([
      { value: '', label: 'Default' },
    ]);
    expect(effortOptionsFor(KIMI, 'kimi', 'kimi-code/k3', kimiCatalog)).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ]);

    expect(normalizeEffortFor(KIMI, 'kimi', 'max', 'kimi-code/kimi-for-coding', kimiCatalog))
      .toBe('');
    expect(normalizeEffortFor(KIMI, 'kimi', 'max', 'kimi-code/k3', kimiCatalog)).toBe('max');
    // Vocabulary mapping still runs before the model's own list is consulted.
    expect(normalizeEffortFor(KIMI, 'kimi', 'xhigh', 'kimi-code/k3', kimiCatalog)).toBe('max');
    expect(normalizeEffortFor(KIMI, 'kimi', 'medium', 'kimi-code/k3', kimiCatalog)).toBe('high');
    // A model the catalog does not report (KIMI_MODEL_* alias) keeps its value.
    expect(normalizeEffortFor(KIMI, 'kimi', 'max', 'local-kimi-alias', kimiCatalog)).toBe('max');
  });
});

describe('Efforts a self-hosted model declares', () => {
  // A vLLM endpoint serving Qwen3.8, whose chat template refuses every level but low/medium/xhigh:
  // dispatch holds the session to what the row declares (apiserver effortWithinDeclaredLevels).
  const vllm: ConfiguredProvider = {
    slug: 'local-vllm',
    label: 'Local vLLM',
    runtime: 'claude',
    presetSlug: null,
    models: [
      { value: 'qwen3.8-27b-fp8', label: 'Qwen3.8 27B FP8', reasoningLevels: ['xhigh', 'low', 'medium'] },
      { value: 'qwen3.8-9b', label: 'Qwen3.8 9B', reasoningLevels: ['low', 'medium', 'high'] },
      { value: 'qwen3.8-mini', label: 'Qwen3.8 Mini', reasoningLevels: [] },
      { value: 'qwen3.8-plain', label: 'Qwen3.8 Plain' },
    ],
  };
  const configured = [vllm];
  const shown = (model: string, effort: string) =>
    normalizeEffortFor(CLAUDE, 'local-vllm', effort, model, null, configured);

  it('offers only the declared levels, lowest first, with Ultra where xhigh is one of them', () => {
    expect(effortOptionsFor(CLAUDE, 'local-vllm', 'qwen3.8-27b-fp8', null, configured)).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'xhigh', label: 'xHigh' },
      { value: 'ultra', label: 'Ultra' },
    ]);
    expect(effortOptionsFor(CLAUDE, 'local-vllm', 'qwen3.8-9b', null, configured)).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ]);
    // `[]` is a model that takes no effort at all.
    expect(effortOptionsFor(CLAUDE, 'local-vllm', 'qwen3.8-mini', null, configured)).toEqual([
      { value: '', label: 'Default' },
    ]);
    // No declaration leaves Claude's list, as before.
    expect(effortOptionsFor(CLAUDE, 'local-vllm', 'qwen3.8-plain', null, configured)).toEqual(
      CLAUDE_EFFORT_OPTIONS,
    );
    // Without the provider list the model cannot be looked up, so nothing is withheld.
    expect(effortOptionsFor(CLAUDE, 'local-vllm', 'qwen3.8-27b-fp8')).toEqual(CLAUDE_EFFORT_OPTIONS);
  });

  it('names the level dispatch runs a stored effort at: the nearest declared one, ties going up', () => {
    // The case that was painted "Max": the session runs at xhigh.
    expect(shown('qwen3.8-27b-fp8', 'max')).toBe('xhigh');
    expect(shown('qwen3.8-27b-fp8', 'high')).toBe('xhigh');
    expect(shown('qwen3.8-27b-fp8', 'medium')).toBe('medium');
    expect(shown('qwen3.8-27b-fp8', 'ultra')).toBe('ultra');
    expect(shown('qwen3.8-9b', 'ultra')).toBe('high');
    expect(shown('qwen3.8-9b', 'max')).toBe('high');
    // Default stays Default (dispatch resolves it), and so does a level outside Claude's vocabulary.
    expect(shown('qwen3.8-27b-fp8', '')).toBe('');
    expect(shown('qwen3.8-27b-fp8', 'minimal')).toBe('');
    expect(shown('qwen3.8-mini', 'high')).toBe('');
    expect(shown('qwen3.8-plain', 'max')).toBe('max');
  });

  it('starts a new session at the declared level nearest the account default', () => {
    expect(
      newSessionEffortFor(CLAUDE, 'local-vllm', 'max', undefined, 'qwen3.8-27b-fp8', null, configured),
    ).toBe('xhigh');
  });

  it('reads a declaration only on Claude Code, the one engine dispatch honours it on', () => {
    const codexRow: ConfiguredProvider = { ...vllm, slug: 'gateway', runtime: 'codex' };
    expect(effortOptionsFor(CODEX, 'gateway', 'qwen3.8-27b-fp8', null, [codexRow])).toEqual(CODEX_EFFORT_OPTIONS);
    expect(normalizeEffortFor(CODEX, 'gateway', 'max', 'qwen3.8-27b-fp8', null, [codexRow])).toBe('max');
    // The same key under OpenCode is OpenCode's to describe.
    expect(effortOptionsFor(OPENCODE, 'local-vllm', 'qwen3.8-27b-fp8', null, configured)).toEqual(OPENCODE_EFFORT_OPTIONS);
  });
});

describe('Runtime-reported default models', () => {
  it('defers unknown provider model capabilities until the provider list is authoritative', () => {
    expect(providerIdentityResolved('claude', false)).toBe(true);
    expect(providerIdentityResolved('kimi', false)).toBe(true);
    expect(providerIdentityResolved('custom-codex', false)).toBe(false);
    expect(providerIdentityResolved('custom-codex', true)).toBe(true);
  });

  it('prefers the reported Runtime value over the first runner catalog model', () => {
    const catalog: RunnerModelCatalog = {
      claude: [{ value: 'claude-sonnet-5', label: 'Sonnet 5' }],
    };

    expect(
      defaultModelFor(CLAUDE, 'claude', catalog, undefined, {
        claude: 'claude-opus-5',
      }),
    ).toBe('claude-opus-5');
  });

  it('uses the catalog first item, then the static fallback, when no default is reported', () => {
    const catalog: RunnerModelCatalog = {
      codex: [{ value: 'gpt-catalog-first', label: 'Catalog First' }],
    };

    expect(defaultModelFor(CODEX, 'codex', catalog, undefined, {})).toBe('gpt-catalog-first');
    expect(defaultModelFor(CODEX, 'codex', null, undefined, {})).toBe('gpt-5.6-sol');
  });

  it('keeps a configured provider in its own model space', () => {
    const configured: ConfiguredProvider[] = [
      {
        slug: 'deepseek',
        label: 'DeepSeek',
        runtime: 'claude',
        models: [{ value: 'deepseek-v4', label: 'DeepSeek V4' }],
        defaultModel: 'deepseek-v4',
      },
    ];

    expect(
      defaultModelFor(CLAUDE, 'deepseek', null, configured, { claude: 'claude-sonnet-5' }),
    ).toBe('deepseek-v4');
  });

  it('reads a provider since removed in its session’s engine, never another engine’s', () => {
    const catalog: RunnerModelCatalog = {
      claude: [{ value: 'claude-catalog', label: 'Claude Catalog' }],
      codex: [{ value: 'gpt-catalog', label: 'GPT Catalog' }],
    };

    expect(
      defaultModelFor(CLAUDE, 'removed-provider', catalog, [], {
        claude: 'claude-runtime-default',
      }),
    ).toBe('claude-runtime-default');
    expect(defaultModelFor(CODEX, 'removed-provider', catalog, [], {})).toBe('gpt-catalog');
  });

  it('reads Auto availability from the engine a key runs on', () => {
    const configured: ConfiguredProvider[] = [
      { slug: 'moonshot', label: 'Kimi (Moonshot)', runtime: 'kimi', models: [] },
      { slug: 'local-codex', label: 'Local Codex', runtime: 'codex', models: [] },
      { slug: 'deepseek', label: 'DeepSeek', runtime: 'claude', models: [] },
      { slug: 'local-legacy', label: 'Legacy', runtime: 'nonsense', models: [] },
    ];

    // Kimi's Auto is an engine-wide mode, so it holds for this vendor's model ids too.
    expect(supportsAuto('kimi-k2.7-code', KIMI, 'moonshot', configured)).toBe(true);
    // So is Codex's — `on-request` is its name for letting the model decide when to ask.
    expect(supportsAuto('gpt-5.6-sol', CODEX, 'local-codex', configured)).toBe(true);
    // A key on Claude Code owns its model space: the static Claude allow-list can't cover vendor ids
    // (e.g. DeepSeek), so the CLI decides for itself.
    expect(supportsAuto('deepseek-v4', CLAUDE, 'deepseek', configured)).toBe(true);
    // A row with an unreadable protocol still follows the key rule, not the Claude model allow-list.
    expect(supportsAuto('claude-opus-5', CLAUDE, 'local-legacy', configured)).toBe(true);
    expect(supportsAuto('some-alias', CLAUDE, 'local-legacy', configured)).toBe(true);
  });

  it('does not leak Claude picker rows into an empty custom model space', () => {
    const configured: ConfiguredProvider[] = [
      { slug: 'custom-codex', label: 'Custom Codex', runtime: 'codex', models: [] },
    ];

    expect(modelOptionsFor(CODEX, 'custom-codex', null, configured)).toEqual([]);
    expect(defaultModelFor(CODEX, 'custom-codex', null, configured)).toBe('gpt-5.6-sol');
  });
});

describe('Retired models', () => {
  const catalog: RunnerModelCatalog = {
    claude: [
      { value: 'claude-opus-6', label: 'Opus 6' },
      { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    ],
  };
  const byok: ConfiguredProvider[] = [
    {
      slug: 'anthropic',
      label: 'Anthropic (Claude)',
      runtime: 'claude',
      models: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }],
      defaultModel: 'claude-opus-5',
      modelsFromRuntime: true,
    },
    {
      slug: 'deepseek',
      label: 'DeepSeek',
      runtime: 'claude',
      models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
      defaultModel: 'deepseek-v4-pro',
    },
  ];

  it('drops a pin the runtime no longer offers, on the engine and on its own vendor', () => {
    expect(livePinnedModel('claude-opus-5', CLAUDE, 'claude', catalog)).toBeUndefined();
    expect(livePinnedModel('claude-opus-6', CLAUDE, 'claude', catalog)).toBe('claude-opus-6');
    // A key on the CLI's own endpoint is judged against the same catalog.
    expect(livePinnedModel('claude-opus-5', CLAUDE, 'anthropic', catalog, byok)).toBeUndefined();
  });

  it('leaves alone every pin the catalog cannot speak for', () => {
    // No catalog reported → nothing can be retired.
    expect(livePinnedModel('claude-opus-5', CLAUDE, 'claude', undefined)).toBe('claude-opus-5');
    expect(livePinnedModel('claude-opus-5', CLAUDE, 'claude', {})).toBe('claude-opus-5');
    // The Runtime's own reported default (an alias, a gateway id) is current by definition.
    expect(livePinnedModel('opus', CLAUDE, 'claude', catalog, undefined, { claude: 'opus' })).toBe('opus');
    // A third-party vendor keeps its own list; the runner's Claude probe says nothing about it.
    expect(livePinnedModel('deepseek-v3', CLAUDE, 'deepseek', catalog, byok)).toBe('deepseek-v3');
    // OpenCode owns model selection — on its own configuration and on a key alike.
    expect(livePinnedModel('anthropic/claude-sonnet-4', OPENCODE, 'opencode', catalog)).toBe(
      'anthropic/claude-sonnet-4',
    );
    expect(livePinnedModel('claude-opus-5', OPENCODE, 'anthropic', catalog, byok)).toBe('claude-opus-5');
    // A blank model is OpenCode's "you pick" sentinel, not a stale id.
    expect(livePinnedModel('', OPENCODE, 'opencode', catalog)).toBe('');
  });

  it('falls through a retired session pin AND a retired workspace pin to the current default', () => {
    // The reported symptom: session and workspace both left on last generation's Opus.
    expect(
      effectiveSessionModel(CLAUDE, 'claude', 'claude-opus-5', 'claude-opus-5', catalog, undefined, {}),
    ).toBe('claude-opus-6');
    // A live workspace pin still wins over the provider default.
    expect(
      effectiveSessionModel(CLAUDE, 'claude', 'claude-opus-5', 'claude-sonnet-5', catalog, undefined, {}),
    ).toBe('claude-sonnet-5');
  });
});

describe('OpenCode defaults', () => {
  const catalog: RunnerModelCatalog = {
    opencode: [
      {
        value: 'anthropic/claude-sonnet-4',
        label: 'Claude Sonnet 4',
        contextWindow: 200_000,
        reasoningLevels: ['low', 'high', 'ultra'],
      },
    ],
  };

  it('is a distinct engine whose empty default never falls back to Claude', () => {
    expect(defaultModelFor(OPENCODE, 'opencode', catalog)).toBe('');
    expect(modelOptionsFor(OPENCODE, 'opencode')).toEqual([{ value: '', label: 'Managed by OpenCode' }]);
    expect(modelOptionsFor(OPENCODE, 'opencode', catalog)).toEqual([
      { value: '', label: 'Managed by OpenCode' },
      { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
    ]);
    expect(supportsAuto('', OPENCODE, 'opencode')).toBe(true);
    expect(supportsAuto('anthropic/claude-sonnet-4', OPENCODE, 'opencode')).toBe(true);
  });

  it('resolves a null session model through its workspace while preserving an explicit empty value', () => {
    expect(effectiveSessionModel(OPENCODE, 'opencode', null, 'anthropic/claude-sonnet-4', catalog)).toBe(
      'anthropic/claude-sonnet-4',
    );
    expect(effectiveSessionModel(OPENCODE, 'opencode', '', 'anthropic/claude-sonnet-4', catalog)).toBe('');
  });

  it('resolves a null session effort through its workspace while preserving an explicit empty value', () => {
    expect(effectiveSessionEffort(null, 'ultra')).toBe('ultra');
    expect(effectiveSessionEffort('', 'ultra')).toBe('');
  });

  it('uses the selected catalog model reasoning variants and rejects stale values', () => {
    expect(effortOptionsFor(OPENCODE, 'opencode', 'anthropic/claude-sonnet-4', catalog)).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'ultra', label: 'Ultra' },
    ]);
    expect(normalizeEffortFor(OPENCODE, 'opencode', 'ultra', 'anthropic/claude-sonnet-4', catalog)).toBe('ultra');
    expect(normalizeEffortFor(OPENCODE, 'opencode', 'max', 'anthropic/claude-sonnet-4', catalog)).toBe('');
  });

  it('offers every runner-supported fallback effort when a catalog model is unavailable', () => {
    expect(effortOptionsFor(OPENCODE, 'opencode', '', catalog)).toEqual(OPENCODE_EFFORT_OPTIONS);
    expect(normalizeEffortFor(OPENCODE, 'opencode', 'max', '', catalog)).toBe('max');
    expect(normalizeEffortFor(OPENCODE, 'opencode', 'project-custom', 'project/local-model', catalog)).toBe(
      'project-custom',
    );
  });

  it('treats an exact model with no variants as Default-only', () => {
    const noVariants: RunnerModelCatalog = {
      opencode: [
        {
          value: 'local/no-variants',
          label: 'No variants',
          reasoningLevels: [],
        },
      ],
    };
    expect(effortOptionsFor(OPENCODE, 'opencode', 'local/no-variants', noVariants)).toEqual([
      { value: '', label: 'Default' },
    ]);
    expect(normalizeEffortFor(OPENCODE, 'opencode', 'high', 'local/no-variants', noVariants)).toBe('');
  });

  it('does not leak an unknown dynamic OpenCode variant into another engine', () => {
    expect(normalizeEffortFor(CLAUDE, 'claude', 'project-custom', 'claude-opus-5', catalog)).toBe('');
    expect(normalizeEffortFor(CODEX, 'codex', 'project-custom', 'gpt-5.6-sol', catalog)).toBe('');
  });
});

describe('Antigravity defaults', () => {
  // What a runner reports from `agy models`: one row per model, its levels folded out of the slug.
  const catalog: RunnerModelCatalog = {
    antigravity: [
      {
        value: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        contextWindow: 1_048_576,
        reasoningLevels: ['low', 'medium', 'high'],
      },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', reasoningLevels: ['low', 'high'] },
    ],
  };

  it('is an engine of its own', () => {
    expect(providerIdentityResolved('antigravity')).toBe(true);
    // agy runs Auto as --dangerously-skip-permissions on any model, so it is not a per-model question.
    expect(supportsAuto('gemini-3.1-pro', ANTIGRAVITY, 'antigravity')).toBe(true);
  });

  it('offers the runner models and labels the no-catalogue fallback with Gemini’s preset default', () => {
    expect(modelOptionsFor(ANTIGRAVITY, 'antigravity', catalog)).toEqual([
      { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    ]);
    expect(modelOptionsFor(ANTIGRAVITY, 'antigravity')).toEqual(ANTIGRAVITY_MODEL_OPTIONS);
    expect(ANTIGRAVITY_MODEL_OPTIONS).toEqual([{ value: '', label: 'Gemini 3.8 Flash' }]);
    expect(modelOptionsFor(ANTIGRAVITY, 'antigravity', { claude: [{ value: 'claude-opus-5', label: 'Opus 5' }] }))
      .toEqual([{ value: '', label: 'Gemini 3.8 Flash' }]);
    expect(defaultModelFor(ANTIGRAVITY, 'antigravity')).toBe('');
  });

  it('defaults like the other engines, and never to a Claude model', () => {
    expect(defaultModelFor(ANTIGRAVITY, 'antigravity', catalog, null, { antigravity: 'gemini-3.1-pro' })).toBe(
      'gemini-3.1-pro',
    );
    expect(defaultModelFor(ANTIGRAVITY, 'antigravity', catalog)).toBe('gemini-3.8-flash');
    // No catalogue and no reported default: no `--model`, which is what dispatch sends too.
    expect(defaultModelFor(ANTIGRAVITY, 'antigravity')).toBe('');
    expect(defaultModelFor(ANTIGRAVITY, 'antigravity', { claude: [{ value: 'claude-opus-5', label: 'Opus 5' }] })).toBe('');
  });

  it('shows the model a session with none actually runs on', () => {
    // '' stood in for a catalogue not reported yet. Once there is one, a model-less session runs
    // its first row, so the pill says that rather than a choice nobody made.
    expect(livePinnedModel('', ANTIGRAVITY, 'antigravity', catalog)).toBeUndefined();
    expect(effectiveSessionModel(ANTIGRAVITY, 'antigravity', '', null, catalog)).toBe('gemini-3.8-flash');
    expect(effectiveSessionModel(ANTIGRAVITY, 'antigravity', '', null, null)).toBe('');
    expect(newSessionModelFor(ANTIGRAVITY, 'antigravity', { 'antigravity:antigravity': '' }, catalog)).toBe('gemini-3.8-flash');
    // A pin the runner still lists stays; one it no longer lists falls to the current default.
    expect(effectiveSessionModel(ANTIGRAVITY, 'antigravity', 'gemini-3.1-pro', null, catalog)).toBe('gemini-3.1-pro');
    expect(effectiveSessionModel(ANTIGRAVITY, 'antigravity', 'gemini-2.9-pro', null, catalog)).toBe('gemini-3.8-flash');
  });

  it('offers each model only the thinking levels it has', () => {
    expect(effortOptionsFor(ANTIGRAVITY, 'antigravity', 'gemini-3.1-pro', catalog)).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ]);
    expect(effortOptionsFor(ANTIGRAVITY, 'antigravity', 'gemini-3.8-flash', catalog)).toEqual(ANTIGRAVITY_EFFORT_OPTIONS);
    // A model the catalogue does not report gets agy's whole vocabulary, not Claude's.
    expect(effortOptionsFor(ANTIGRAVITY, 'antigravity', '', catalog)).toEqual(ANTIGRAVITY_EFFORT_OPTIONS);
    expect(effortOptionsFor(ANTIGRAVITY, 'antigravity', 'gemini-3.1-pro')).toEqual(ANTIGRAVITY_EFFORT_OPTIONS);
  });

  it('moves an effort picked on another engine onto agy’s levels, then the model’s own', () => {
    expect(normalizeEffortFor(ANTIGRAVITY, 'antigravity', 'max', 'gemini-3.8-flash', catalog)).toBe('high');
    expect(normalizeEffortFor(ANTIGRAVITY, 'antigravity', 'ultra', 'gemini-3.8-flash', catalog)).toBe('high');
    expect(normalizeEffortFor(ANTIGRAVITY, 'antigravity', 'minimal', 'gemini-3.8-flash', catalog)).toBe('low');
    // Gemini 3.1 Pro has no Medium: Default rather than a level agy would refuse.
    expect(normalizeEffortFor(ANTIGRAVITY, 'antigravity', 'medium', 'gemini-3.1-pro', catalog)).toBe('');
    expect(normalizeEffortFor(ANTIGRAVITY, 'antigravity', 'xhigh', 'gemini-3.1-pro', catalog)).toBe('high');
    // No row: agy's closed vocabulary still applies, so an OpenCode variant is dropped.
    expect(normalizeEffortFor(ANTIGRAVITY, 'antigravity', 'max', '', catalog)).toBe('high');
    expect(normalizeEffortFor(ANTIGRAVITY, 'antigravity', 'project-custom', '', catalog)).toBe('');
    expect(newSessionEffortFor(ANTIGRAVITY, 'antigravity', 'max', null, 'gemini-3.1-pro', catalog)).toBe('high');
  });

  it('takes its context window from the runner catalogue', () => {
    expect(contextWindowFor('gemini-3.8-flash', catalog)).toBe(1_048_576);
    expect(contextWindowFor('gemini-3.1-pro', catalog)).toBeUndefined();
  });
});

describe('A Gemini key on Antigravity', () => {
  // What GET /providers serves for a row connected from the Gemini preset: withPreset() puts agy's
  // fallback list and the modelsFromRuntime flag on it.
  const gemini: ConfiguredProvider = {
    slug: 'gemini',
    label: 'Gemini',
    runtime: 'antigravity',
    models: [
      { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_048_576 },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', contextWindow: 1_048_576 },
    ],
    defaultModel: 'gemini-3.8-flash',
    presetSlug: 'gemini',
    modelsFromRuntime: true,
  };
  const catalog: RunnerModelCatalog = {
    claude: [{ value: 'claude-opus-6', label: 'Opus 6' }],
    antigravity: [
      { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', reasoningLevels: ['low', 'medium', 'high'] },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', reasoningLevels: ['low', 'high'] },
    ],
  };

  it('runs on Antigravity by default', () => {
    expect(defaultEngineOf('gemini', [gemini])).toBe('antigravity');
  });

  it('offers the models agy reports, and the preset’s own only until it reports them', () => {
    expect(modelOptionsFor(ANTIGRAVITY, 'gemini', catalog, [gemini])).toEqual([
      { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    ]);
    expect(modelOptionsFor(ANTIGRAVITY, 'gemini', null, [gemini]).map((option) => option.value)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.1-pro',
    ]);
  });

  it('defaults to what agy reports, never to what Claude does', () => {
    expect(defaultModelFor(ANTIGRAVITY, 'gemini', catalog, [gemini])).toBe('gemini-3.7-flash');
    expect(
      defaultModelFor(ANTIGRAVITY, 'gemini', catalog, [gemini], { claude: 'claude-opus-6', antigravity: 'gemini-3.1-pro' }),
    ).toBe('gemini-3.1-pro');
    expect(defaultModelFor(ANTIGRAVITY, 'gemini', null, [gemini])).toBe('gemini-3.8-flash');
  });

  it('judges a pin against agy’s catalogue', () => {
    expect(livePinnedModel('gemini-3.1-pro', ANTIGRAVITY, 'gemini', catalog, [gemini])).toBe('gemini-3.1-pro');
    // A pin from when the row ran on Codex: agy has no such model and would refuse to start.
    expect(livePinnedModel('gemini-2.5-pro', ANTIGRAVITY, 'gemini', catalog, [gemini])).toBeUndefined();
  });
});

describe('contextWindowFor', () => {
  it('takes Codex windows from the runner catalog, not a built-in guess', () => {
    const catalog: RunnerModelCatalog = {
      codex: [{ value: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272_000 }],
    };

    expect(contextWindowFor('gpt-5.5', catalog)).toBe(272_000);
  });

  it('uses the built-in Claude windows, which no catalog reports', () => {
    const catalog: RunnerModelCatalog = {
      claude: [{ value: 'claude-opus-5', label: 'Opus 5' }],
    };

    expect(contextWindowFor('claude-opus-5', catalog)).toBe(1_000_000);
  });

  // "I don't know" is an answer the gauge can render (it shows the token count). A default was
  // not: 200k under a 1M model is the bug this whole chain was rebuilt around.
  it('says nothing rather than defaulting when no source knows the window', () => {
    expect(contextWindowFor('gpt-5.5', null)).toBeUndefined();
    expect(contextWindowFor(null, null)).toBeUndefined();
  });

  it('uses runner catalog windows for models unknown to the built-in table', () => {
    const catalog: RunnerModelCatalog = {
      codex: [{ value: 'gpt-new', label: 'GPT New', contextWindow: 512_000 }],
    };

    expect(contextWindowFor('gpt-new', catalog)).toBe(512_000);
  });

  it('uses a configured provider row for a vendor the runner cannot probe', () => {
    const configured: ConfiguredProvider[] = [
      {
        slug: 'custom-codex',
        label: 'Custom Codex',
        runtime: 'codex',
        models: [{ value: 'gpt-5.5', label: 'GPT-5.5 Custom', contextWindow: 128_000 }],
      },
    ];

    expect(contextWindowFor('gpt-5.5', null, configured)).toBe(128_000);
  });

  // The runner probes the CLI that will actually run the model; a provider row is a number
  // someone typed into the control plane. When they disagree, the measurement wins — the
  // inverse of this ordering is exactly how a stale 200k preset shadowed a 1M model.
  it('prefers the runner probe over a configured row that disagrees', () => {
    const catalog: RunnerModelCatalog = {
      claude: [{ value: 'claude-opus-5', label: 'Opus 5', contextWindow: 1_000_000 }],
    };
    const configured: ConfiguredProvider[] = [
      {
        slug: 'anthropic',
        label: 'Anthropic (Claude)',
        runtime: 'claude',
        models: [{ value: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 200_000 }],
      },
    ];

    expect(contextWindowFor('claude-opus-5', catalog, configured)).toBe(1_000_000);
  });

  // A provider row describes its own sessions. Left unscoped, any configured vendor could define
  // the window for a session it has nothing to do with, just by listing the same model id.
  it('only reads the configured row belonging to this session', () => {
    const configured: ConfiguredProvider[] = [
      {
        slug: 'other-gateway',
        label: 'Other Gateway',
        runtime: 'claude',
        models: [{ value: 'shared-model', label: 'Shared', contextWindow: 128_000 }],
      },
      {
        slug: 'mine',
        label: 'Mine',
        runtime: 'claude',
        models: [{ value: 'shared-model', label: 'Shared', contextWindow: 512_000 }],
      },
    ];

    expect(contextWindowFor('shared-model', null, configured, 'mine')).toBe(512_000);
    expect(contextWindowFor('shared-model', null, configured, 'unconfigured')).toBeUndefined();
  });
});

describe('one DeepSeek key on each engine that runs it (contract §2.2)', () => {
  const deepseekKey: ConfiguredProvider = {
    slug: 'deepseek',
    label: 'DeepSeek',
    runtime: 'claude',
    presetSlug: 'deepseek',
    models: [
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { value: 'deepseek-flash', label: 'DeepSeek Flash' },
    ],
    defaultModel: 'deepseek-v4-pro',
    runsOnOpenCode: true,
    engines: ['claude', 'opencode', 'dsh'],
  };
  const catalog: RunnerModelCatalog = {
    claude: [{ value: 'claude-opus-6', label: 'Opus 6' }],
    opencode: [{ value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' }],
    dsh: [
      { value: 'acp-pro', label: 'DeepSeek V4 Pro' },
      { value: 'acp-flash', label: 'DeepSeek V4 Flash' },
    ],
  };

  it('brings its own models to Claude Code and to OpenCode, bare — nothing names the key in a model any more', () => {
    const own = [
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { value: 'deepseek-flash', label: 'DeepSeek Flash' },
    ];
    expect(modelOptionsFor(CLAUDE, 'deepseek', catalog, [deepseekKey])).toEqual(own);
    expect(modelOptionsFor(OPENCODE, 'deepseek', catalog, [deepseekKey])).toEqual(own);
    expect(defaultModelFor(OPENCODE, 'deepseek', catalog, [deepseekKey])).toBe('deepseek-v4-pro');
    expect(modelOptionsFor(OPENCODE, 'deepseek', catalog, [deepseekKey]).some((option) => option.value.startsWith('orbit-'))).toBe(false);
  });

  it('runs DeepSeek Harness on the runner’s catalogue, whichever DeepSeek key it spends', () => {
    expect(modelOptionsFor(DSH, 'deepseek', catalog, [deepseekKey])).toEqual(catalog.dsh!.map(({ value, label }) => ({ value, label })));
    expect(defaultModelFor(DSH, 'deepseek', catalog, [deepseekKey])).toBe('acp-pro');
    expect(defaultModelFor(DSH, 'deepseek', catalog, [deepseekKey], { dsh: 'acp-flash' })).toBe('acp-flash');
    // Before the runner reports one, the runtime picks: no static fallback, and never the key's own.
    expect(modelOptionsFor(DSH, 'deepseek', null, [deepseekKey])).toEqual([]);
    expect(defaultModelFor(DSH, 'deepseek', null, [deepseekKey])).toBe('');
  });

  it('judges a Harness pin against the Harness catalogue, not the key’s table', () => {
    expect(livePinnedModel('acp-flash', DSH, 'deepseek', catalog, [deepseekKey])).toBe('acp-flash');
    expect(livePinnedModel('deepseek-v4-pro', DSH, 'deepseek', catalog, [deepseekKey])).toBeUndefined();
  });
});
