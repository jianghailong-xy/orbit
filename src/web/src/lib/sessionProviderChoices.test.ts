import { describe, expect, it } from 'vitest';
import {
  brandForProvider,
  currentProviderChoice,
  defaultModelLabel,
  providerChoices,
  sameRuntimeChoices,
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

const moonshot: ConfiguredProvider = {
  slug: 'moonshot',
  label: 'Kimi (Moonshot)',
  runtime: 'kimi',
  models: [{ value: 'kimi-k3', label: 'Kimi K3' }],
  defaultModel: 'kimi-k3',
  presetSlug: 'moonshot',
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
    // An engine is fixed on its own row.
    expect(choices.find((c) => c.slug === 'kimi')?.fixEngine).toBe('kimi');
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

  it('blocks a configured provider whose borrowed CLI is not installed', () => {
    // The Moonshot row spawns the Kimi CLI with its key in the environment: no CLI, no session.
    const choices = providerChoices([moonshot, deepseek], catalog, undefined, [
      { engine: 'claude', installed: true, auth: 'yes' },
      { engine: 'kimi', installed: false, auth: 'unknown' },
    ]);
    const row = choices.find((c) => c.slug === 'moonshot');
    expect(row?.unavailable).toBe('Not installed');
    // Its own slug has no row on the Providers page; the install lives on the engine it borrows.
    expect(row?.fixEngine).toBe('kimi');
    // A provider on a CLI that is there stays pickable.
    expect(choices.find((c) => c.slug === 'deepseek')?.unavailable).toBeUndefined();
  });

  it('keeps a configured provider on a signed-out CLI pickable — its key is the credential', () => {
    const choices = providerChoices([moonshot], catalog, undefined, [
      { engine: 'kimi', installed: true, auth: 'no' },
    ]);
    expect(choices.find((c) => c.slug === 'kimi')?.unavailable).toBe('Not signed in');
    expect(choices.find((c) => c.slug === 'moonshot')?.unavailable).toBeUndefined();
  });

  it('offers a configured provider whose CLI the runner has claimed nothing about', () => {
    expect(
      providerChoices([moonshot], catalog, undefined, [
        { engine: 'claude', installed: false, auth: 'no' },
      ]).find((c) => c.slug === 'moonshot')?.unavailable,
    ).toBeUndefined();
    expect(
      providerChoices([moonshot], catalog, undefined, null).find((c) => c.slug === 'moonshot')
        ?.unavailable,
    ).toBeUndefined();
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

describe('sameRuntimeChoices', () => {
  const anthropic: ConfiguredProvider = {
    slug: 'anthropic',
    label: 'Anthropic (Claude)',
    runtime: 'claude',
    models: [],
    defaultModel: 'claude-opus-5',
    presetSlug: 'anthropic',
    modelsFromRuntime: true,
  };
  const anthropic2: ConfiguredProvider = { ...anthropic, slug: 'anthropic-2', label: 'Work account' };
  const configured = [anthropic, anthropic2, deepseek, moonshot];

  it('offers the second Anthropic account, and the engine, to a claude session', () => {
    const choices = sameRuntimeChoices(
      'anthropic',
      providerChoices(configured, catalog),
      configured,
    );
    expect(choices.map((c) => c.slug)).toEqual(['claude', 'anthropic', 'anthropic-2', 'deepseek']);
  });

  it('orders the same way whichever provider is running', () => {
    // The menu is the same short list every time it opens; rotating the running one to the top
    // moved every other row under the cursor depending on which session you were in.
    const all = providerChoices(configured, catalog);
    const order = ['claude', 'anthropic', 'anthropic-2', 'deepseek'];
    for (const from of order) {
      expect(sameRuntimeChoices(from, all, configured).map((c) => c.slug)).toEqual(order);
    }
  });

  it('never offers another runtime — codex and kimi are a different session', () => {
    const choices = sameRuntimeChoices('claude', providerChoices(configured, catalog), configured);
    expect(choices.map((c) => c.slug)).not.toContain('codex');
    expect(choices.map((c) => c.slug)).not.toContain('kimi');
    expect(choices.map((c) => c.slug)).not.toContain('moonshot');
  });

  it('leaves a lone provider alone, so the composer can hide the pill', () => {
    expect(sameRuntimeChoices('kimi', providerChoices([], catalog), [])).toHaveLength(1);
    expect(sameRuntimeChoices('opencode', providerChoices([], catalog), [])).toHaveLength(1);
  });

  it('keeps a target this machine cannot run, with its reason', () => {
    // The engine is installed but signed out, so it cannot host a session; the BYOK rows on the
    // same CLI can, because the key they carry is the credential. Every runner in production
    // reports exactly this pair, and hiding the engine read as "Orbit lost my Claude".
    const rows = [anthropic, anthropic2];
    const choices = sameRuntimeChoices(
      'anthropic',
      providerChoices(rows, catalog, undefined, [{ engine: 'claude', installed: true, auth: 'no' }]),
      rows,
    );
    expect(choices.map((c) => c.slug)).toEqual(['claude', 'anthropic', 'anthropic-2']);
    expect(choices.find((c) => c.slug === 'claude')?.unavailable).toBe('Not signed in');
    expect(choices.find((c) => c.slug === 'anthropic-2')?.unavailable).toBeUndefined();
    // The composer links this row at the engine that fixes it, so the slug has to survive.
    expect(choices.find((c) => c.slug === 'claude')?.fixEngine).toBe('claude');
  });

  it('still names every same-runtime option when nothing on that CLI can run', () => {
    const rows = [anthropic, anthropic2];
    const choices = sameRuntimeChoices(
      'anthropic',
      providerChoices(rows, catalog, undefined, [
        { engine: 'claude', installed: false, auth: 'unknown' },
      ]),
      rows,
    );
    expect(choices.map((c) => c.slug)).toEqual(['claude', 'anthropic', 'anthropic-2']);
    expect(choices.every((c) => c.unavailable === 'Not installed')).toBe(true);
  });

  it('still shows a session whose provider was removed as its current entry', () => {
    const choices = sameRuntimeChoices(
      'gone-away',
      providerChoices([anthropic], catalog),
      [anthropic],
    );
    expect(choices[0].slug).toBe('gone-away');
    expect(choices.map((c) => c.slug)).toContain('anthropic');
  });
});
