import { describe, expect, it } from 'vitest';
import {
  brandForProvider,
  currentProviderChoice,
  defaultModelLabel,
  providerChoices,
} from './sessionProviderChoices';
import type { ConfiguredProvider } from './agentDefaults';
import { PROVIDER_GLYPHS } from './providerGlyphs';

const deepseek: ConfiguredProvider = {
  slug: 'deepseek',
  label: 'DeepSeek',
  runtime: 'claude',
  models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
  defaultModel: 'deepseek-v4-pro',
  presetSlug: 'deepseek',
};

const custom: ConfiguredProvider = {
  slug: 'my-endpoint',
  label: 'my endpoint',
  runtime: 'claude',
  models: [{ value: 'x-1', label: 'X 1' }],
  defaultModel: 'x-1',
  presetSlug: null,
};

const catalog = {
  claude: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }],
  codex: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
} as never;

describe('providerChoices', () => {
  it('always offers the three engines, even with nothing configured', () => {
    const choices = providerChoices([], catalog);
    expect(choices.map((c) => c.slug)).toEqual(['claude', 'codex', 'kimi']);
    expect(choices.every((c) => c.kind === 'engine')).toBe(true);
  });

  it('appends configured providers after the engines', () => {
    const choices = providerChoices([deepseek, custom], catalog);
    expect(choices.map((c) => c.slug)).toEqual([
      'claude',
      'codex',
      'kimi',
      'deepseek',
      'my-endpoint',
    ]);
    expect(choices.slice(3).every((c) => c.kind === 'byok')).toBe(true);
  });

  it('never offers opencode as a choice — it is not a login engine', () => {
    expect(providerChoices([], catalog).some((c) => c.slug === 'opencode')).toBe(false);
  });

  it('drops a configured row that shadows a built-in engine slug', () => {
    const shadow: ConfiguredProvider = { ...deepseek, slug: 'kimi', label: 'Kimi (custom)' };
    const choices = providerChoices([shadow], catalog);
    expect(choices.filter((c) => c.slug === 'kimi')).toHaveLength(1);
    expect(choices.find((c) => c.slug === 'kimi')?.kind).toBe('engine');
  });

  it('carries each choice’s resolved default model, so a switch previews its model', () => {
    const choices = providerChoices([deepseek], catalog);
    expect(choices.find((c) => c.slug === 'claude')?.modelLabel).toBe('Claude Opus 5');
    expect(choices.find((c) => c.slug === 'deepseek')?.modelLabel).toBe('DeepSeek V4 Pro');
  });

  it('keeps an engine the runner does not have installed, with the reason', () => {
    const choices = providerChoices([deepseek], catalog, undefined, [
      { engine: 'claude', installed: true, auth: 'yes' },
      { engine: 'codex', installed: false, auth: 'unknown' },
      { engine: 'kimi', installed: false, auth: 'unknown' },
    ]);
    expect(choices.map((c) => c.slug)).toEqual(['claude', 'codex', 'kimi', 'deepseek']);
    // Hiding it would leave "why is Kimi missing?" with no answer anywhere in the product.
    expect(choices.find((c) => c.slug === 'kimi')?.unavailable).toBe('Not installed');
    expect(choices.find((c) => c.slug === 'codex')?.unavailable).toBe('Not installed');
    expect(choices.find((c) => c.slug === 'claude')?.unavailable).toBeUndefined();
  });

  it('says not installed, not signed out, for a missing CLI that never answered', () => {
    // Both are true of the report; only one of them has a fix the user can act on first.
    const choices = providerChoices([], catalog, undefined, [
      { engine: 'kimi', installed: false, auth: 'no' },
    ]);
    expect(choices.find((c) => c.slug === 'kimi')?.unavailable).toBe('Not installed');
  });

  it('keeps an installed-but-signed-out engine, disabled with the reason', () => {
    const choices = providerChoices([], catalog, undefined, [
      { engine: 'claude', installed: true, auth: 'yes' },
      { engine: 'codex', installed: true, auth: 'no' },
      { engine: 'kimi', installed: true, auth: 'unknown' },
    ]);
    expect(choices.map((c) => c.slug)).toEqual(['claude', 'codex', 'kimi']);
    expect(choices.find((c) => c.slug === 'codex')?.unavailable).toBe('Not signed in');
    // `unknown` is a CLI that wouldn't answer, not a "no" — it stays pickable.
    expect(choices.find((c) => c.slug === 'kimi')?.unavailable).toBeUndefined();
    expect(choices.find((c) => c.slug === 'claude')?.unavailable).toBeUndefined();
  });

  it('offers every engine a runner has claimed nothing about', () => {
    // Never reported (older runner / first heartbeat still pending), and a partial report.
    expect(providerChoices([], catalog, undefined, null).map((c) => c.slug)).toEqual([
      'claude',
      'codex',
      'kimi',
    ]);
    const partial = providerChoices([], catalog, undefined, [
      { engine: 'claude', installed: false, auth: 'no' },
    ]);
    expect(partial.map((c) => c.slug)).toEqual(['claude', 'codex', 'kimi']);
    // Only the engine the runner actually spoke about carries a reason.
    expect(partial.find((c) => c.slug === 'claude')?.unavailable).toBe('Not installed');
    expect(partial.filter((c) => c.unavailable)).toHaveLength(1);
  });
});

describe('brandForProvider', () => {
  it('gives a built-in engine the same mark as its vendor', () => {
    expect(brandForProvider('claude', 'Claude').glyphKey).toBe('anthropic');
    expect(brandForProvider('codex', 'Codex').glyphKey).toBe('openai');
    expect(brandForProvider('kimi', 'Kimi').glyphKey).toBe('moonshot');
  });

  it('resolves every glyph key it hands out to actual artwork', () => {
    // A key with no entry silently degrades to a blank tile, which reads as a rendering bug.
    for (const choice of providerChoices([deepseek, custom], catalog)) {
      if (choice.glyphKey) expect(PROVIDER_GLYPHS[choice.glyphKey]).toBeTruthy();
    }
  });

  it('takes a configured provider’s mark from its preset', () => {
    expect(brandForProvider('deepseek', 'DeepSeek', 'deepseek').glyphKey).toBe('deepseek');
  });

  it('falls back to a neutral monogram for a self-maintained endpoint', () => {
    const { brand, glyphKey } = brandForProvider('my-endpoint', 'my endpoint', null);
    expect(glyphKey).toBeUndefined();
    expect(brand.mono).toBe('M');
  });
});

describe('currentProviderChoice', () => {
  it('resolves the pick from the offered choices', () => {
    const choices = providerChoices([deepseek], catalog);
    expect(currentProviderChoice('deepseek', choices, catalog, [deepseek]).label).toBe('DeepSeek');
  });

  it('synthesizes an entry for opencode rather than reading as Claude', () => {
    const choices = providerChoices([], catalog);
    const current = currentProviderChoice('opencode', choices, catalog, []);
    expect(current.slug).toBe('opencode');
    expect(current.label).toBe('OpenCode');
    expect(current.kind).toBe('engine');
  });

  it('synthesizes an entry for a provider that has since been removed', () => {
    const choices = providerChoices([], catalog);
    const current = currentProviderChoice('gone-away', choices, catalog, []);
    expect(current.slug).toBe('gone-away');
    expect(current.kind).toBe('byok');
    expect(current.brand.mono).toBe('G');
  });
});

describe('defaultModelLabel', () => {
  it('says who picks when the provider manages the model itself', () => {
    expect(defaultModelLabel('opencode', catalog, [])).toBe('Managed by the provider');
  });

  it('falls back to the raw id when the catalogue does not name it', () => {
    expect(defaultModelLabel('kimi', catalog, [])).toBe('Kimi for Coding');
  });
});
