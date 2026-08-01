import { describe, expect, it } from 'vitest';
import type { RunnerModelCatalog } from '@orbit/shared';
import {
  CLAUDE_MODEL_OPTIONS,
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW,
  defaultModelForProvider,
  effortOptionsForProvider,
  KIMI_MODEL_OPTIONS,
  mergedProviderOptions,
  modelOptionsForProvider,
  normalizeEffortForProvider,
  supportsAuto,
  type ConfiguredProvider,
} from './agentDefaults';

describe('Claude model options', () => {
  it('matches the current Claude Code picker, including Fable 5', () => {
    expect(CLAUDE_MODEL_OPTIONS).toEqual([
      { value: 'claude-opus-5', label: 'Opus 5' },
      { value: 'claude-fable-5', label: 'Fable 5' },
      { value: 'claude-sonnet-5', label: 'Sonnet 5' },
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    ]);
    expect(contextWindowFor('claude-fable-5')).toBe(1_000_000);
    expect(supportsAuto('claude-fable-5')).toBe(true);
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
    expect(supportsAuto('kimi-code/kimi-for-coding')).toBe(true);
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
