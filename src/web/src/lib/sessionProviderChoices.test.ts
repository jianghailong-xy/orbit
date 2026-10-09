import { describe, expect, it } from 'vitest';
import {
  brandForProvider,
  currentProviderChoice,
  defaultModelLabel,
  engineChoices,
  engineTitleFor,
  providerChoices,
  runtimeSummary,
  sameRuntimeChoices,
} from './sessionProviderChoices';
import { runtimeForProvider, type ConfiguredProvider } from './workspaceDefaults';
import { PROVIDER_GLYPHS } from './providerGlyphs';
import { encodeId } from './idCodec';
import type { CodexLogin } from './codexLogin';
import { sharedPoolAsProviderPool, type SharedPool, type SharedPoolKey, type SharedPoolPerson } from './sharedPools';

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

// A key connected from the Gemini preset, as GET /providers serves it.
const gemini: ConfiguredProvider = {
  slug: 'gemini',
  label: 'Gemini',
  runtime: 'antigravity',
  models: [{ value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }],
  defaultModel: 'gemini-3.8-flash',
  presetSlug: 'gemini',
  modelsFromRuntime: true,
};

const catalog = {
  claude: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }],
  codex: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
} as never;

describe('providerChoices', () => {
  it('offers the engines and hides Antigravity without a server-confirmed environment key', () => {
    const choices = providerChoices([], catalog);
    expect(choices.map((c) => c.slug)).toEqual(['claude', 'codex', 'kimi', 'opencode']);
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
      'opencode',
    ]);
    expect(choices.filter((c) => c.kind === 'byok').map((c) => c.slug)).toEqual(['deepseek', 'my-endpoint']);
  });

  it('keeps opencode listed, with its reason, until the runner reports it installed', () => {
    // Orbit installs it, so a machine without it is a row the picker can send somewhere — the same
    // rule DSH and the login engines are listed under. It has no sign-in to relay, so the row is
    // never a pick before the CLI is there, and it must not read as one.
    for (const engines of [null, [{ engine: 'opencode' as const, installed: false, auth: 'unknown' as const }]]) {
      const choices = providerChoices([], catalog, undefined, engines);
      const row = choices.find((c) => c.slug === 'opencode');
      expect(row).toMatchObject({ kind: 'engine', label: 'OpenCode', unavailable: 'Not installed', fixEngine: 'opencode' });
      // An engine board row for it too, landing on that choice.
      const board = engineChoices(choices, []).find((e) => e.slug === 'opencode');
      expect(board).toMatchObject({ label: 'OpenCode', unavailable: 'Not installed', fixEngine: 'opencode' });
    }
  });

  it('offers Antigravity as an engine, with the model the runner reports first', () => {
    const withAgy = {
      ...(catalog as object),
      antigravity: [
        { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', reasoningLevels: ['low', 'medium', 'high'] },
        { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', reasoningLevels: ['low', 'high'] },
      ],
    } as never;
    const choices = providerChoices([], withAgy, undefined, undefined, [], undefined, undefined, true);
    expect(choices.map((choice) => choice.slug)).toEqual(['claude', 'codex', 'antigravity', 'kimi', 'opencode']);
    const row = choices.find((c) => c.slug === 'antigravity');
    expect(row).toMatchObject({ kind: 'engine', label: 'Antigravity', labelDetail: 'env key', glyphKey: 'antigravity' });
    expect(row?.modelLabel).toBe('Gemini 3.8 Flash');
    expect(defaultModelLabel('antigravity', catalog)).toBe('Gemini 3.8 Flash');
    expect(defaultModelLabel('opencode', catalog)).toBe('Managed by the provider');
  });

  it('uses the server key boolean instead of inferring availability from runner auth', () => {
    const ready = { supported: true, installed: true, version: 'agy 1.2.16', envKeyAvailable: true };
    const health = [{ engine: 'antigravity' as const, installed: true, auth: 'yes' as const }];
    expect(providerChoices([gemini], catalog, undefined, health).map((c) => c.slug)).toEqual(['claude', 'codex', 'gemini', 'kimi', 'opencode']);
    expect(providerChoices([gemini], catalog, undefined, health, [], undefined, ready, false).some((c) => c.slug === 'antigravity')).toBe(false);
    expect(providerChoices([gemini], catalog, undefined, undefined, [], undefined, ready, true).find((c) => c.slug === 'antigravity')).toMatchObject({ labelDetail: 'env key' });
    // A Gemini key keeps its own name and Google Gemini's mark, whichever engine runs it.
    expect(providerChoices([gemini], catalog).find((c) => c.slug === 'gemini')).toMatchObject({
      label: 'Gemini', labelDetail: 'API key', glyphKey: 'gemini', modelLabel: 'Gemini 3.8 Flash',
    });
    expect(providerChoices([{ ...gemini, label: 'Work Gemini' }], catalog).find((c) => c.slug === 'gemini')?.label).toBe('Work Gemini');
  });

  it('allows a workspace key to run Antigravity after the runner Google sign-in expires', () => {
    const expired = {
      supported: true, installed: true, version: 'agy 1.2.16', envKeyAvailable: false,
      authSource: 'google' as const, googleLogin: 'available' as const,
    };
    const health = [{ engine: 'antigravity' as const, installed: true, auth: 'no' as const, authSource: 'google' as const }];
    const choice = (keyAvailable?: boolean) => providerChoices([gemini], catalog, undefined, health, [], undefined, expired, keyAvailable)
      .find((c) => c.slug === 'antigravity');
    expect(choice()).toMatchObject({ labelDetail: 'Google account', unavailable: 'Not signed in', fixEngine: 'antigravity' });
    expect(choice(true)).toMatchObject({ kind: 'engine', labelDetail: 'env key' });
    expect(choice(true)?.unavailable).toBeUndefined();
    expect(choice(true)?.fixEngine).toBeUndefined();
    const withoutCli = providerChoices([], catalog, undefined, health, [], undefined, { ...expired, installed: false }, true)
      .find((c) => c.slug === 'antigravity');
    expect(withoutCli).toMatchObject({ unavailable: 'Not installed', fixEngine: 'antigravity' });
  });

  it.each([
    [{ supported: false, installed: true, version: '1.2.16', envKeyAvailable: true }, 'Update runner'],
    [{ supported: true, installed: false, version: null, envKeyAvailable: true }, 'Not installed'],
  ] as const)('blocks both Gemini entrances with the server readiness %j', (state, unavailable) => {
    const rows = providerChoices([gemini], catalog, undefined, undefined, [], undefined, state);
    for (const slug of ['antigravity', 'gemini']) {
      expect(rows.find((c) => c.slug === slug)).toMatchObject({ unavailable, fixEngine: 'antigravity' });
    }
    const hiddenCurrent = currentProviderChoice('antigravity', providerChoices([gemini], catalog), catalog, [gemini], undefined, state);
    expect(hiddenCurrent).toMatchObject({ labelDetail: 'env key', modelLabel: 'Gemini 3.8 Flash', unavailable, fixEngine: 'antigravity' });
    expect(sameRuntimeChoices('antigravity', providerChoices([gemini], catalog), [gemini], catalog, undefined, state)[0]).toEqual(hiddenCurrent);
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
    expect(choices.map((c) => c.slug)).toEqual(['claude', 'codex', 'kimi', 'deepseek', 'opencode']);
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
    expect(choices.map((c) => c.slug)).toEqual(['claude', 'codex', 'kimi', 'opencode']);
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
    // OpenCode is the one exception: Orbit installs it, so a runner that has said nothing about it
    // is a runner that hasn't got it, and the row says so.
    expect(providerChoices([], catalog, undefined, null).map((c) => c.slug)).toEqual([
      'claude',
      'codex',
      'kimi',
      'opencode',
    ]);
    const partial = providerChoices([], catalog, undefined, [
      { engine: 'claude', installed: false, auth: 'no' },
    ]);
    expect(partial.map((c) => c.slug)).toEqual(['claude', 'codex', 'kimi', 'opencode']);
    // The engine the runner actually spoke about, and OpenCode, which it didn't and hasn't got.
    expect(partial.filter((c) => c.unavailable).map((c) => c.slug)).toEqual(['claude', 'opencode']);
  });
});

describe('the runner’s Codex accounts, under the Codex choice', () => {
  const home = (id: string) => `/root/.orbit/codex-accounts/${id}`;
  const codex = (accounts: Array<{ id: string; name?: string; auth: 'yes' | 'no' | 'unknown' }>) => [
    { engine: 'claude' as const, installed: true, auth: 'yes' as const },
    {
      engine: 'codex' as const,
      installed: true,
      auth: 'yes' as const,
      accounts: accounts.map((account) => ({ ...account, home: home(account.id), codexHome: home(account.id) })),
    },
  ];
  const usage = {
    codex: {
      provider: 'codex',
      primary: { utilization: 100, windowDurationMins: 300 },
      accounts: {
        '3fa91c2e': { provider: 'codex', primary: { utilization: 0, windowDurationMins: 10080 } },
      },
    },
  } as never;
  const accountsOf = (choices: ReturnType<typeof providerChoices>, slug = 'codex') =>
    choices.find((choice) => choice.slug === slug)?.accounts;

  it('lists each account with its own quota once the runner has signed in two', () => {
    const choices = providerChoices(
      [],
      catalog,
      undefined,
      codex([{ id: 'default', auth: 'yes' }, { id: '3fa91c2e', name: 'Work', auth: 'yes' }, { id: 'c0ffee42', auth: 'no' }]),
      [],
      usage,
    );
    expect(accountsOf(choices)).toEqual([
      { id: 'default', label: 'Default', quota: '5h 100%', nearLimit: true },
      { id: '3fa91c2e', label: 'Work', quota: 'Weekly 0%' },
      // Unnamed, unread, and signed out: it is listed, and says why it can't take a session.
      { id: 'c0ffee42', label: 'Account c0ffee42', unavailable: 'Not signed in' },
    ]);
    expect(accountsOf(choices, 'claude')).toBeUndefined();
  });

  it('lists an account by what it was renamed to in Orbit, Default included', () => {
    const choices = providerChoices(
      [],
      catalog,
      undefined,
      codex([{ id: 'default', name: 'jianghailong.main', auth: 'yes' }, { id: '3fa91c2e', name: 'Research', auth: 'yes' }]),
      [],
      usage,
    );
    expect(accountsOf(choices)?.map((account) => account.label)).toEqual(['jianghailong.main', 'Research']);
  });

  it('lists none for a single account, or for an engine that cannot run', () => {
    expect(accountsOf(providerChoices([], catalog, undefined, codex([{ id: 'default', auth: 'yes' }]), [], usage)))
      .toBeUndefined();
    const signedOut = codex([{ id: 'default', auth: 'no' }, { id: '3fa91c2e', auth: 'yes' }]);
    signedOut[1].auth = 'no' as never;
    const blocked = providerChoices([], catalog, undefined, signedOut, [], usage);
    expect(blocked.find((choice) => choice.slug === 'codex')?.unavailable).toBe('Not signed in');
    expect(accountsOf(blocked)).toBeUndefined();
  });

  it("lists a Claude login's accounts under Claude too, each by the window that stops it", () => {
    const claudeHome = (id: string) => `/root/.orbit/claude-accounts/${id}`;
    const engines = [
      {
        engine: 'claude' as const,
        installed: true,
        auth: 'yes' as const,
        accounts: [
          { id: 'default', home: '/root/.claude', auth: 'yes' as const },
          { id: 'fad98727', name: 'jianghailong.rd', home: claudeHome('fad98727'), auth: 'yes' as const },
        ],
      },
    ];
    const claudeUsage = {
      claude: {
        provider: 'claude',
        fiveHour: { utilization: 0 },
        sevenDay: { utilization: 100 },
        accounts: { fad98727: { provider: 'claude', fiveHour: { utilization: 19 }, sevenDay: { utilization: 28 } } },
      },
    } as never;
    expect(accountsOf(providerChoices([], catalog, undefined, engines, [], claudeUsage), 'claude')).toEqual([
      // Its 5-hour window reads 0% but its weekly one is spent: the row says what stops it.
      { id: 'default', label: 'Default', quota: 'Weekly 100%', nearLimit: true },
      { id: 'fad98727', label: 'jianghailong.rd', quota: 'Weekly 28%' },
    ]);
  });
});

describe('the runner’s Antigravity (Google) accounts, under the Antigravity choice', () => {
  const google = {
    supported: true,
    installed: true,
    version: 'agy 1.3.0',
    envKeyAvailable: true,
    authSource: 'google' as const,
    googleLogin: 'available' as const,
  };
  const home = (id: string) => (id === 'default' ? '/root/.orbit/antigravity/google' : `/root/.orbit/antigravity-accounts/${id}`);
  const bucket = (id: string, window: string, remainingFraction: number) => ({ id, window, remainingFraction });
  // Antigravity's quota is never in the heartbeat's planUsage: it is on the engine's own health,
  // Default's buckets beside every other account's.
  const engines = (
    accounts: Array<{ id: string; name?: string; auth: 'yes' | 'no' | 'unknown' }>,
    over: Record<string, unknown> = {},
  ) => [
    { engine: 'claude' as const, installed: true, auth: 'yes' as const },
    {
      engine: 'antigravity' as const,
      installed: true,
      auth: 'yes' as const,
      authSource: 'google' as const,
      accounts: accounts.map((account) => ({ ...account, home: home(account.id) })),
      planUsage: {
        provider: 'antigravity',
        buckets: [bucket('gemini-weekly', 'weekly', 1), bucket('3p-weekly', 'weekly', 0.98), bucket('gemini-5h', '5h', 1)],
        accounts: {
          '5c2e91a0': {
            provider: 'antigravity',
            buckets: [bucket('gemini-weekly', 'weekly', 0.61), bucket('gemini-5h', '5h', 0.04)],
          },
        },
      },
      ...over,
    },
  ];
  const accountsOf = (choices: ReturnType<typeof providerChoices>) =>
    choices.find((choice) => choice.slug === 'antigravity')?.accounts;

  it('lists each account by the bucket with the least left, in what is left, read from the engine’s health', () => {
    const choices = providerChoices(
      [],
      catalog,
      undefined,
      engines([{ id: 'default', auth: 'yes' }, { id: '5c2e91a0', name: 'Work', auth: 'yes' }, { id: 'c0ffee42', auth: 'no' }]),
      [],
      // The heartbeat's own report holds nothing of Antigravity's.
      { claude: { provider: 'claude', fiveHour: { utilization: 3 } } } as never,
      google,
    );
    expect(accountsOf(choices)).toEqual([
      { id: 'default', label: 'Default', quota: '3p-weekly 98% left' },
      { id: '5c2e91a0', label: 'Work', quota: 'gemini-5h 4% left', nearLimit: true },
      { id: 'c0ffee42', label: 'Account c0ffee42', unavailable: 'Not signed in' },
    ]);
    // The Provider menu may still say how the engine signs in.
    expect(choices.find((choice) => choice.slug === 'antigravity')?.labelDetail).toBe('Google account');
  });

  it('lists none for one account, or for an engine that cannot run', () => {
    expect(accountsOf(providerChoices([], catalog, undefined, engines([{ id: 'default', auth: 'yes' }]), [], null, google))).toBeUndefined();
    const lapsed = { ...google, envKeyAvailable: false };
    const blocked = providerChoices(
      [],
      catalog,
      undefined,
      engines([{ id: 'default', auth: 'no' }, { id: '5c2e91a0', auth: 'no' }], { auth: 'no' }),
      [],
      null,
      lapsed,
    );
    expect(blocked.find((choice) => choice.slug === 'antigravity')?.unavailable).toBe('Not signed in');
    expect(accountsOf(blocked)).toBeUndefined();
  });

  it('offers Default on the runner’s Gemini key as the key it runs on, never as signed out', () => {
    const onKey = { ...google, authSource: 'env_key' as const };
    const choices = providerChoices(
      [],
      catalog,
      undefined,
      engines([{ id: 'default', auth: 'no' }, { id: '5c2e91a0', name: 'Work', auth: 'yes' }], { authSource: 'env_key' }),
      [],
      null,
      onKey,
    );
    expect(accountsOf(choices)).toEqual([
      { id: 'default', label: 'Default', quota: 'env key' },
      { id: '5c2e91a0', label: 'Work', quota: 'gemini-5h 4% left', nearLimit: true },
    ]);
  });
});

describe('the runner’s Kimi Code accounts, under the Kimi choice', () => {
  const home = (id: string) => (id === 'default' ? '/root/.kimi-code' : `/root/.orbit/kimi-accounts/${id}`);
  const kimi = (accounts: Array<{ id: string; name?: string; auth: 'yes' | 'no' | 'unknown' }>, auth: 'yes' | 'no' = 'yes') => [
    { engine: 'claude' as const, installed: true, auth: 'yes' as const },
    {
      engine: 'kimi' as const,
      installed: true,
      auth,
      kimiRegion: 'global' as const,
      accounts: accounts.map((account) => ({ ...account, home: home(account.id) })),
    },
  ];
  // Kimi's windows in the heartbeat's planUsage.kimi: Default's own, Work's under `accounts`. Default's
  // coding share is above its month, which Kimi never reports (the share is part of the month), so that a
  // row still weighing it would name it.
  const usage = {
    kimi: {
      provider: 'kimi',
      fiveHour: { utilization: 12 },
      sevenDay: { utilization: 34 },
      month: { utilization: 41 },
      monthCode: { utilization: 88 },
      accounts: {
        '5c2e91a0': { provider: 'kimi', fiveHour: { utilization: 97 }, sevenDay: { utilization: 20 }, month: { utilization: 10 } },
      },
    },
  } as never;
  const accountsOf = (choices: ReturnType<typeof providerChoices>) => choices.find((choice) => choice.slug === 'kimi')?.accounts;

  it('lists each account by the window that stops it, the month by its total', () => {
    const choices = providerChoices(
      [],
      catalog,
      undefined,
      kimi([{ id: 'default', auth: 'yes' }, { id: '5c2e91a0', name: 'Work', auth: 'yes' }, { id: 'c0ffee42', auth: 'no' }]),
      [],
      usage,
    );
    expect(accountsOf(choices)).toEqual([
      // Its month is the fullest of the windows drawn, though its 5-hour one has room; its coding share
      // is never one of them.
      { id: 'default', label: 'Default', quota: 'Monthly 41%' },
      { id: '5c2e91a0', label: 'Work', quota: '5h 97%', nearLimit: true },
      { id: 'c0ffee42', label: 'Account c0ffee42', unavailable: 'Not signed in' },
    ]);
  });

  it('lists none for one account, or for an engine that cannot run', () => {
    expect(accountsOf(providerChoices([], catalog, undefined, kimi([{ id: 'default', auth: 'yes' }]), [], usage))).toBeUndefined();
    const blocked = providerChoices([], catalog, undefined, kimi([{ id: 'default', auth: 'no' }, { id: '5c2e91a0', auth: 'no' }], 'no'), [], usage);
    expect(blocked.find((choice) => choice.slug === 'kimi')?.unavailable).toBe('Not signed in');
    expect(accountsOf(blocked)).toBeUndefined();
  });
});

describe('brandForProvider', () => {
  it('gives a built-in engine the same mark as its vendor', () => {
    expect(brandForProvider('claude', 'Claude').glyphKey).toBe('anthropic');
    expect(brandForProvider('codex', 'Codex').glyphKey).toBe('openai');
    expect(brandForProvider('kimi', 'Kimi').glyphKey).toBe('moonshot');
  });

  it('gives the Antigravity engine its own mark, and a Gemini key Google Gemini’s', () => {
    const { brand, glyphKey } = brandForProvider('antigravity', 'Antigravity');
    expect(glyphKey).toBe('antigravity');
    expect(brand).toEqual({ mono: 'A', from: '#3186ff', to: '#00b95c' });
    expect(PROVIDER_GLYPHS.antigravity).toBeTruthy();
    const gemini = { brand: { mono: 'G', from: '#4285f4', to: '#9b72cb' }, glyphKey: 'gemini' };
    expect(PROVIDER_GLYPHS.gemini).toBeTruthy();
    expect(brandForProvider('gemini', 'Gemini', 'gemini')).toEqual(gemini);
    expect(brandForProvider('gemini-2', 'Work Gemini', 'gemini')).toEqual(gemini);
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

  it('puts a Gemini key with the Antigravity engine it runs on, and nowhere else', () => {
    const rows = [gemini, deepseek];
    const all = providerChoices(rows, catalog);
    expect(sameRuntimeChoices('antigravity', all, rows).map((c) => c.slug)).toEqual(['antigravity', 'gemini']);
    expect(sameRuntimeChoices('gemini', all, rows).map((c) => c.slug)).toEqual(['gemini']);
    expect(sameRuntimeChoices('claude', all, rows).map((c) => c.slug)).not.toContain('gemini');
  });

  it('blocks a Gemini key where agy is missing, and points the fix at the Antigravity engine', () => {
    const health = [{ engine: 'antigravity' as const, installed: false, auth: 'unknown' as const }];
    const row = providerChoices([gemini], catalog, undefined, health).find((c) => c.slug === 'gemini');
    expect(row?.unavailable).toBe('Not installed');
    expect(row?.fixEngine).toBe('antigravity');
    // Installed is all it needs: the key it carries is the whole sign-in.
    const ready = providerChoices([gemini], catalog, undefined, [
      { engine: 'antigravity', installed: true, auth: 'no' },
    ]).find((c) => c.slug === 'gemini');
    expect(ready?.unavailable).toBeUndefined();
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

describe('account pools among the choices', () => {
  const work: ConfiguredProvider = {
    slug: 'anthropic',
    label: 'Work',
    runtime: 'claude',
    models: [],
    presetSlug: 'anthropic',
    modelsFromRuntime: true,
  };
  const home: ConfiguredProvider = { ...work, slug: 'anthropic-2', label: 'Home' };
  const pool = { slug: 'claude-accounts', label: 'Claude accounts', members: [{ slug: 'anthropic' }, { slug: 'anthropic-2' }] };
  // What WorkspaceView hands in: the catalogue with the pools appended (poolsAsProviders).
  const configured: ConfiguredProvider[] = [
    work,
    home,
    deepseek,
    { slug: pool.slug, label: pool.label, runtime: 'claude', models: [], presetSlug: 'anthropic', modelsFromRuntime: true },
  ];

  it('offers a pool once, after the engines, as its own kind with its account count', () => {
    const choices = providerChoices(configured, catalog, undefined, undefined, [pool]);
    expect(choices.map((c) => c.slug)).toEqual([
      'claude',
      'codex',
      'kimi',
      'claude-accounts',
      'anthropic',
      'anthropic-2',
      'deepseek',
      'opencode',
    ]);
    const tile = choices.find((c) => c.slug === 'claude-accounts')!;
    expect(tile).toMatchObject({ kind: 'pool', label: 'Claude accounts', poolSize: 2, glyphKey: 'anthropic' });
    // Its model is the Claude CLI's own, named as the catalogue names it.
    expect(tile.modelLabel).toBe('Claude Opus 5');
  });

  it("keeps the pool's accounts pickable on their own, marked for the picker to fold away", () => {
    const choices = providerChoices(configured, catalog, undefined, undefined, [pool]);
    const inPool = choices.filter((c) => c.inPool).map((c) => c.slug);
    expect(inPool).toEqual(['anthropic', 'anthropic-2']);
    expect(choices.find((c) => c.slug === 'deepseek')?.inPool).toBeUndefined();
  });

  it('holds a pool to the Claude CLI being there, as a configured provider is', () => {
    const choices = providerChoices(configured, catalog, undefined, [{ engine: 'claude', installed: false, auth: 'unknown' }], [pool]);
    expect(choices.find((c) => c.slug === 'claude-accounts')).toMatchObject({ unavailable: 'Not installed', fixEngine: 'claude' });
  });

  it('lets a claude session move onto the pool and back, since it runs on the same CLI', () => {
    const choices = providerChoices(configured, catalog, undefined, undefined, [pool]);
    const moves = sameRuntimeChoices('claude-accounts', choices, configured, catalog).map((c) => c.slug);
    expect(moves).toEqual(['claude', 'claude-accounts', 'anthropic', 'anthropic-2', 'deepseek']);
  });
});

describe('shared pools among the choices', () => {
  // A shared pool of OpenAI keys as WorkspaceView hands it in: its keys as members
  // (sharedPoolAsProviderPool), and a Codex entry in the catalogue (poolsAsProviders).
  const team = {
    id: 'team',
    slug: 'team-codex',
    label: 'Team Codex',
    members: [{ slug: 'k1' }, { slug: 'k2' }, { slug: 'k3' }],
    shared: {},
  };
  const configured: ConfiguredProvider[] = [
    deepseek,
    { slug: team.slug, label: team.label, runtime: 'codex', models: [], presetSlug: 'openai', modelsFromRuntime: true },
  ];

  it('offers one after the engines, wearing the Codex mark and counting its keys', () => {
    const choices = providerChoices(configured, catalog, undefined, undefined, [team]);
    expect(choices.map((c) => c.slug)).toEqual(['claude', 'codex', 'kimi', 'team-codex', 'deepseek', 'opencode']);
    const tile = choices.find((c) => c.slug === 'team-codex')!;
    expect(tile).toMatchObject({ kind: 'pool', label: 'Team Codex', poolSize: 3, poolUnit: 'key', glyphKey: 'openai' });
    // Its model is the Codex CLI's own.
    expect(tile.modelLabel).toBe('GPT-5.6 Sol');
  });

  it('holds it to the Codex CLI being there, not the Claude one', () => {
    const noCodex = providerChoices(configured, catalog, undefined, [{ engine: 'codex', installed: false, auth: 'unknown' }], [team]);
    expect(noCodex.find((c) => c.slug === 'team-codex')).toMatchObject({ unavailable: 'Not installed', fixEngine: 'codex' });
    const noClaude = providerChoices(configured, catalog, undefined, [{ engine: 'claude', installed: false, auth: 'unknown' }], [team]);
    expect(noClaude.find((c) => c.slug === 'team-codex')?.unavailable).toBeUndefined();
  });

  it('lets a codex session move onto it, and not a claude one', () => {
    const choices = providerChoices(configured, catalog, undefined, undefined, [team]);
    expect(sameRuntimeChoices('codex', choices, configured, catalog).map((c) => c.slug)).toEqual(['codex', 'team-codex']);
    expect(sameRuntimeChoices('claude', choices, configured, catalog).map((c) => c.slug)).not.toContain('team-codex');
  });
});

describe('a Codex pool somebody was added to, in their picker', () => {
  // jianghailong's Codex Pool (docs/mocks/account-pool-access/02), as Zhang Min, whom he added, reads it —
  // and as WorkspaceView hands it in: its ChatGPT accounts and its keys as members
  // (sharedPoolAsProviderPool), and a Codex entry in the catalogue (poolsAsProviders). His accounts run
  // her sessions too (2026-10-03), so the pool is pickable while one of them can run, keys or no keys.
  const POOL_ID = '0195c0de-0000-7000-8000-000000000800';
  const NAMES: Record<string, string> = { jiang: 'jianghailong', zhang: 'Zhang Min', lin: 'Lin Wei' };
  const spend = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  /** One of his ChatGPT accounts as the pool carries it — the first one the next session's. */
  const account = (email: string, over: Partial<CodexLogin> = {}): CodexLogin => ({
    // His: jianghailong, the pool's owner, signs them in again (migration 0371).
    userId: 'jiang',
    state: 'ACTIVE',
    email,
    plan: 'plus',
    fingerprint: `…${email.slice(0, 4)}`,
    lastError: null,
    expiresAt: '2026-10-06T00:00:00.000Z',
    linkedAt: '2026-09-28T00:00:00.000Z',
    usage: null,
    usageUnavailable: null,
    ...over,
  });
  const ACCOUNTS: CodexLogin[] = [account('jianghailong.rd@gmail.com'), account('hl.work@gmail.com')];
  const key = (label: string, contributor: string, viewer: string, over: Partial<SharedPoolKey> = {}): SharedPoolKey => ({
    id: `${label}-id`,
    label,
    fingerprint: 'sk-…AB12',
    state: 'ACTIVE',
    enabled: true,
    shareCap: null,
    spentUntil: null,
    contributor: { userId: contributor, name: NAMES[contributor], you: contributor === viewer },
    usage: { ...spend, othersCostUsd: 0 },
    running: false,
    next: false,
    ...over,
  });
  const codexPool = (
    viewer: string,
    keys: SharedPoolKey[] = [],
    over: Partial<SharedPool> = {},
    logins: CodexLogin[] = ACCOUNTS,
  ): SharedPool => ({
    id: POOL_ID,
    slug: 'codex-pool',
    label: 'Codex Pool',
    engine: 'codex',
    shared: false,
    logins: logins.map((login, index) => ({ ...login, next: index === 0 })),
    membersCanAdd: true,
    membersCanAddAccounts: true,
    ownKeyFirst: true,
    viewerRole: viewer === 'jiang' ? 'ADMIN' : 'MEMBER',
    window: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    people: ['jiang', 'zhang', 'lin'].map(
      (userId): SharedPoolPerson => ({
        userId,
        name: NAMES[userId],
        role: userId === 'jiang' ? 'ADMIN' : 'MEMBER',
        creator: userId === 'jiang',
        you: userId === viewer,
        keys: keys.filter((row) => row.contributor.userId === userId).length,
        sessions: 0,
        usage: spend,
      }),
    ),
    keys,
    ...over,
  });
  const configured: ConfiguredProvider[] = [
    { slug: 'codex-pool', label: 'Codex Pool', runtime: 'codex', models: [], presetSlug: 'openai', modelsFromRuntime: true },
  ];
  const tileOf = (pool: SharedPool, engineHealth?: Parameters<typeof providerChoices>[3]) =>
    providerChoices(configured, catalog, undefined, engineHealth, [sharedPoolAsProviderPool(pool)]).find(
      (c) => c.slug === 'codex-pool',
    )!;

  it('offers it for a pick on his ChatGPT accounts while the pool has no API key at all', () => {
    const tile = tileOf(codexPool('zhang'));
    // Still listed, as the pool it is — and pickable: his accounts run her sessions, and one of them is
    // marked next. The tile counts credentials, and they are not keys alone any more.
    expect(tile).toMatchObject({
      kind: 'pool',
      label: 'Codex Pool',
      poolSize: 2,
    });
    expect(tile.poolUnit).toBeUndefined();
    expect(tile.unavailable).toBeUndefined();
    expect(tile.fixHref).toBeUndefined();
  });

  it('says the same while every key it has is switched off or refused by OpenAI — the accounts still run', () => {
    const keys = [
      key('orbit-org-1', 'jiang', 'zhang', { state: 'INVALID' }),
      key('zm-proj', 'zhang', 'zhang', { enabled: false }),
    ];
    expect(tileOf(codexPool('zhang', keys)).unavailable).toBeUndefined();
    expect(tileOf(codexPool('lin')).unavailable).toBeUndefined();
  });

  it('greys it out with "Signed out" when its accounts are signed out and its keys refused or off too', () => {
    const keys = [key('orbit-org-1', 'jiang', 'zhang', { state: 'INVALID' })];
    const logins = ACCOUNTS.map((login) => account(login.email!, { state: 'SIGNED_OUT' }));
    const tile = tileOf(codexPool('zhang', keys, {}, logins));
    expect(tile.unavailable).toBe('Signed out');
    expect(tile.fixHref).toBe(`/providers/pools/${encodeId(POOL_ID)}`);
    expect(tile.fixEngine).toBeUndefined();
  });

  it('counts accounts with the keys once a key of it can run', () => {
    const tile = tileOf(codexPool('zhang', [key('orbit-org-1', 'jiang', 'zhang')]));
    expect(tile.unavailable).toBeUndefined();
    expect(tile.fixHref).toBeUndefined();
    expect(tile.poolSize).toBe(3);
    expect(tile.poolUnit).toBeUndefined();
  });

  it('keeps the words of a shared pool’s own maker, whom nobody added', () => {
    // A pool made on the shared pools page, read by the person who made it: no accounts, so "No keys", as
    // before — and its unit is the key.
    const tile = tileOf(codexPool('jiang', [], { shared: true }, []));
    expect(tile.unavailable).toBe('No keys');
    expect(tile.poolUnit).toBe('key');
  });

  it('still says first that this runner has no Codex CLI to run it on', () => {
    expect(tileOf(codexPool('zhang'), [{ engine: 'codex', installed: false, auth: 'unknown' }])).toMatchObject({
      unavailable: 'Not installed',
      fixEngine: 'codex',
    });
  });
});

describe('runtimeSummary', () => {
  it('names the protocol a key’s endpoint speaks, never an engine — a key runs on several', () => {
    expect(runtimeSummary('antigravity')).toBe('Gemini API');
    expect(runtimeSummary('kimi')).toBe('Moonshot API');
    expect(runtimeSummary('codex')).toBe('OpenAI-compatible');
    expect(runtimeSummary('claude')).toBe('Anthropic-compatible');
    expect(runtimeSummary('dsh')).toBe('Anthropic-compatible');
  });
});

describe('engineChoices', () => {
  const configured = [deepseek, moonshot, gemini];
  const all = providerChoices(configured, catalog, undefined, undefined, [], undefined, undefined, true);

  it('lists each engine once, its keys folded into the engine that runs them', () => {
    expect(engineChoices(all, configured).map((engine) => engine.slug)).toEqual(['claude', 'codex', 'antigravity', 'kimi', 'opencode']);
  });

  it("lands on the engine's own sign-in, unless a preferred provider of it can run", () => {
    const landing = (preferred: string[]) =>
      engineChoices(all, configured, preferred).map((engine) => engine.provider.slug);
    expect(landing([])).toEqual(['claude', 'codex', 'antigravity', 'kimi', 'opencode']);
    // The draft's pick first, then what the workspace last ran: each only where it runs.
    expect(landing(['deepseek', 'moonshot'])).toEqual(['deepseek', 'codex', 'antigravity', 'moonshot', 'opencode']);
  });

  it('skips a preferred provider that cannot run, and a signed-out engine, for one that can', () => {
    const choices = providerChoices(configured, catalog, undefined, [{ engine: 'claude', installed: true, auth: 'no' }]);
    const claude = engineChoices(choices, configured, [])[0];
    expect(claude.provider.slug).toBe('deepseek');
    expect(claude.unavailable).toBeUndefined();
  });

  it('carries the reason when no provider of the engine can run', () => {
    const choices = providerChoices(configured, catalog, undefined, [{ engine: 'kimi', installed: false, auth: 'unknown' }]);
    const kimi = engineChoices(choices, configured, ['moonshot']).find((engine) => engine.slug === 'kimi')!;
    expect(kimi.provider.slug).toBe('kimi');
    expect(kimi.unavailable).toBe('Not installed');
    expect(kimi.provider.fixEngine).toBe('kimi');
  });

});

describe('OpenCode and the keys it may spend', () => {
  const anthropicKey: ConfiguredProvider = {
    slug: 'anthropic',
    label: 'Anthropic (Claude)',
    runtime: 'claude',
    models: [],
    defaultModel: 'claude-opus-5',
    presetSlug: 'anthropic',
    modelsFromRuntime: true,
    runsOnOpenCode: true,
  };
  const configured: ConfiguredProvider[] = [
    { ...deepseek, runsOnOpenCode: true },
    { ...moonshot, runsOnOpenCode: true },
    anthropicKey,
    // A Claude subscription token: the server says no.
    { ...anthropicKey, slug: 'anthropic-sub', label: 'Subscription', runsOnOpenCode: false },
  ];
  const installed = [{ engine: 'opencode' as const, installed: true, auth: 'unknown' as const }];

  it('offers its own row without the keys until the runner reports it installed', () => {
    // The engine row is there either way — Orbit installs it — while the keys it would spend are
    // each a session that would run on a CLI this machine hasn't got.
    for (const engines of [null, [{ engine: 'opencode' as const, installed: false, auth: 'unknown' as const }]]) {
      const rows = providerChoices(configured, catalog, undefined, engines)
        .filter((c) => runtimeForProvider(c.slug, configured) === 'opencode');
      expect(rows.map((c) => c.slug)).toEqual(['opencode']);
      expect(rows[0]).toMatchObject({ unavailable: 'Not installed', fixEngine: 'opencode' });
    }
  });

  it('lists its own config, then every key it may spend — each key under its own engine as well', () => {
    const choices = providerChoices(configured, catalog, undefined, installed);
    const openCode = choices.filter((c) => runtimeForProvider(c.slug, configured) === 'opencode');
    expect(openCode.map((c) => c.slug)).toEqual(['opencode', 'opencode/deepseek', 'opencode/moonshot', 'opencode/anthropic']);
    expect(openCode.map((c) => c.label)).toEqual(['OpenCode', 'DeepSeek', 'Kimi (Moonshot)', 'Anthropic (Claude)']);
    expect(openCode[1].modelLabel).toBe('DeepSeek V4 Pro');
    expect(choices.some((c) => c.slug === 'deepseek')).toBe(true);
  });

  it('picks OpenCode engine by engine, and says which key it would spend', () => {
    const choices = providerChoices(configured, catalog, undefined, installed);
    const openCode = engineChoices(choices, configured, ['opencode/deepseek']).find((e) => e.slug === 'opencode')!;
    expect(openCode.label).toBe('OpenCode');
    expect(openCode.provider.slug).toBe('opencode/deepseek');
    expect(sameRuntimeChoices('opencode/deepseek', choices, configured).map((c) => c.slug)).toEqual([
      'opencode',
      'opencode/deepseek',
      'opencode/moonshot',
      'opencode/anthropic',
    ]);
  });
});

describe('engineTitleFor', () => {
  it('names the CLI that executes, not the vendor whose models it writes', () => {
    // The composer menu's title answers "which engine runs this session". A BYOK provider writes
    // its own models while Claude Code executes them, so the name is the CLI's.
    expect(engineTitleFor('claude', [])).toMatchObject({ slug: 'claude', name: 'Claude Code', glyphKey: 'anthropic' });
    expect(engineTitleFor('deepseek', [deepseek])).toMatchObject({
      slug: 'claude',
      name: 'Claude Code',
      glyphKey: 'anthropic',
    });
    expect(engineTitleFor('my-endpoint', [custom]).name).toBe('Claude Code');
  });

  it('gives every other engine its own product name and mark', () => {
    expect(engineTitleFor('codex', [])).toMatchObject({ name: 'Codex', glyphKey: 'openai' });
    expect(engineTitleFor('kimi', [])).toMatchObject({ name: 'Kimi Code', glyphKey: 'moonshot' });
    expect(engineTitleFor('opencode', []).name).toBe('OpenCode');
    expect(engineTitleFor('antigravity', [])).toMatchObject({ name: 'Antigravity CLI', glyphKey: 'antigravity' });
    expect(engineTitleFor('dsh', []).name).toBe('DeepSeek Harness');
  });

  it('takes the safe Claude fallback for a provider it cannot place', () => {
    expect(engineTitleFor('nonsense', []).name).toBe('Claude Code');
    expect(engineTitleFor(null, []).name).toBe('Claude Code');
  });

  it('says where a standing pick goes only when it changes the engine', () => {
    // A pick that crosses CLIs is a transition worth printing.
    expect(engineTitleFor('claude', [], 'codex')).toMatchObject({ name: 'Claude Code', nextName: 'Codex' });
    expect(engineTitleFor('opencode', [], 'claude')).toMatchObject({ name: 'OpenCode', nextName: 'Claude Code' });
    // Two providers of one CLI are the same engine — the title stays one name, and the Provider
    // row below is where that pick is read.
    expect(engineTitleFor('deepseek', [deepseek], 'claude').nextName).toBeNull();
    expect(engineTitleFor('claude', [], 'deepseek').nextName).toBeNull();
    expect(engineTitleFor('claude', [], null).nextName).toBeNull();
  });
});
