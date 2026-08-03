import { describe, expect, it } from 'vitest';
import type { RunnerModelCatalog } from '@orbit/shared';
import {
  clampPermissionModeForModel,
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW,
  defaultModelForProvider,
  effortOptionsForProvider,
  KIMI_MODEL_OPTIONS,
  mergedProviderOptions,
  modelOptionsForProvider,
  normalizeEffortForProvider,
  providerIdentityResolved,
  supportsAuto,
  type ConfiguredProvider,
} from './agentDefaults';

describe('Claude model capabilities', () => {
  it('knows the current tiers without a static picker list', () => {
    // Claude/Codex options come from the runner catalog only, so there is no list to assert —
    // what still lives here are the per-model traits the CLI cannot report.
    expect(modelOptionsForProvider('claude')).toEqual([]);
    expect(contextWindowFor('claude-fable-5')).toBe(1_000_000);
    expect(supportsAuto('claude-opus-5', 'claude')).toBe(true);
    expect(supportsAuto('claude-fable-5', 'claude')).toBe(true);
    expect(supportsAuto('claude-sonnet-5', 'claude')).toBe(true);
    expect(supportsAuto('claude-haiku-4-5', 'claude')).toBe(false);
  });

  it('clamps Auto when the effective Runtime default cannot run it', () => {
    expect(clampPermissionModeForModel('auto', 'claude-haiku-4-5', 'claude')).toBe('default');
    expect(clampPermissionModeForModel('auto', 'claude-opus-5', 'claude')).toBe('auto');
    expect(clampPermissionModeForModel('plan', 'claude-haiku-4-5', 'claude')).toBe('plan');
  });
});

describe('Kimi runtime defaults', () => {
  it('offers the managed Kimi coding model as its only default model', () => {
    expect(mergedProviderOptions()).toContainEqual({ value: 'kimi', label: 'Kimi' });
    expect(KIMI_MODEL_OPTIONS).toEqual([
      { value: 'kimi-code/kimi-for-coding', label: 'Kimi for Coding' },
    ]);
    expect(modelOptionsForProvider('kimi')).toEqual(KIMI_MODEL_OPTIONS);
    expect(defaultModelForProvider('kimi')).toBe('kimi-code/kimi-for-coding');
    expect(contextWindowFor('kimi-code/kimi-for-coding')).toBe(262_144);
    expect(supportsAuto('kimi-code/kimi-for-coding', 'kimi')).toBe(true);
    expect(supportsAuto('local-kimi-alias', 'kimi')).toBe(true);
  });

  it('offers Kimi efforts without Codex-only minimal', () => {
    expect(effortOptionsForProvider('kimi')).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ]);

    expect(normalizeEffortForProvider('kimi', 'minimal')).toBe('low');
    expect(normalizeEffortForProvider('kimi', 'medium')).toBe('high');
    expect(normalizeEffortForProvider('kimi', 'xhigh')).toBe('max');
    expect(normalizeEffortForProvider('kimi', 'high')).toBe('high');
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
      defaultModelForProvider('claude', catalog, undefined, {
        claude: 'claude-opus-5',
      }),
    ).toBe('claude-opus-5');
  });

  it('uses the catalog first item, then the static fallback, when no default is reported', () => {
    const catalog: RunnerModelCatalog = {
      codex: [{ value: 'gpt-catalog-first', label: 'Catalog First' }],
    };

    expect(defaultModelForProvider('codex', catalog, undefined, {})).toBe('gpt-catalog-first');
    expect(defaultModelForProvider('codex', null, undefined, {})).toBe('gpt-5.6-sol');
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
      defaultModelForProvider('deepseek', null, configured, { claude: 'claude-sonnet-5' }),
    ).toBe('deepseek-v4');
  });

  it('normalizes a removed provider to the Claude Runtime before reading its default', () => {
    const catalog: RunnerModelCatalog = {
      claude: [{ value: 'claude-catalog', label: 'Claude Catalog' }],
    };

    expect(
      defaultModelForProvider('removed-provider', catalog, [], {
        claude: 'claude-runtime-default',
      }),
    ).toBe('claude-runtime-default');
  });

  it('uses only supported configured runtimes when deciding whether Auto is available', () => {
    const configured: ConfiguredProvider[] = [
      { slug: 'local-kimi', label: 'Local Kimi', runtime: 'kimi', models: [] },
      { slug: 'local-codex', label: 'Local Codex', runtime: 'codex', models: [] },
    ];

    expect(supportsAuto('any-local-alias', 'local-kimi', configured)).toBe(false);
    expect(supportsAuto('claude-opus-5', 'local-codex', configured)).toBe(false);
  });

  it('does not leak Claude picker rows into an empty custom model space', () => {
    const configured: ConfiguredProvider[] = [
      { slug: 'custom-codex', label: 'Custom Codex', runtime: 'codex', models: [] },
    ];

    expect(modelOptionsForProvider('custom-codex', null, configured)).toEqual([]);
    expect(defaultModelForProvider('custom-codex', null, configured)).toBe('gpt-5.6-sol');
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

  it('falls back to the default window when the catalog is missing', () => {
    expect(contextWindowFor('gpt-5.5', null)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('uses runner catalog windows for models unknown to the built-in table', () => {
    const catalog: RunnerModelCatalog = {
      codex: [{ value: 'gpt-new', label: 'GPT New', contextWindow: 512_000 }],
    };

    expect(contextWindowFor('gpt-new', catalog)).toBe(512_000);
  });

  it('keeps configured provider model windows highest priority', () => {
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
});
