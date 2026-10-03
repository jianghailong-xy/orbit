import { describe, expect, it } from 'vitest';
import {
  brandForProvider,
  currentProviderChoice,
  defaultModelLabel,
  providerChoices,
  sameRuntimeChoices,
} from './sessionProviderChoices';
import type { ConfiguredProvider } from './workspaceDefaults';
import { PROVIDER_GLYPHS } from './providerGlyphs';
import { encodeId } from './idCodec';
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
    expect(choices.map((c) => c.slug)).toEqual(['claude', 'codex', 'kimi', 'team-codex', 'deepseek']);
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
  // and as WorkspaceView hands it in: its keys as members (sharedPoolAsProviderPool), and a Codex entry in
  // the catalogue (poolsAsProviders). His ChatGPT accounts only ever run his own sessions, so hers run on
  // its API keys alone.
  const POOL_ID = '0195c0de-0000-7000-8000-000000000800';
  const NAMES: Record<string, string> = { jiang: 'jianghailong', zhang: 'Zhang Min', lin: 'Lin Wei' };
  const spend = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
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
  const codexPool = (viewer: string, keys: SharedPoolKey[] = [], over: Partial<SharedPool> = {}): SharedPool => ({
    id: POOL_ID,
    slug: 'codex-pool',
    label: 'Codex Pool',
    engine: 'codex',
    shared: false,
    ownerHasChatGPT: true,
    membersCanAdd: true,
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

  it('greys it out while it has no API key, saying "No key you can run on", and sends the pick to its page', () => {
    const tile = tileOf(codexPool('zhang'));
    // Still listed, as the pool it is — but `unavailable` is what the picker greys a row out by
    // (NewSessionProviderHero's np-unavailable): it shows these words where the model would be, and a
    // press goes to the pool's own page instead of picking it.
    expect(tile).toMatchObject({
      kind: 'pool',
      label: 'Codex Pool',
      poolSize: 0,
      poolUnit: 'key',
      unavailable: 'No key you can run on',
      fixHref: `/providers/pools/${encodeId(POOL_ID)}`,
    });
    expect(tile.fixEngine).toBeUndefined();
  });

  it('says the same while every key it has is switched off or refused by OpenAI', () => {
    const keys = [
      key('orbit-org-1', 'jiang', 'zhang', { state: 'INVALID' }),
      key('zm-proj', 'zhang', 'zhang', { enabled: false }),
    ];
    expect(tileOf(codexPool('zhang', keys)).unavailable).toBe('No key you can run on');
    // Nor is it Zhang Min's word alone: Lin Wei, whom he added too, reads the same.
    expect(tileOf(codexPool('lin')).unavailable).toBe('No key you can run on');
  });

  it('offers it for a pick once a key of it can run', () => {
    const tile = tileOf(codexPool('zhang', [key('orbit-org-1', 'jiang', 'zhang')]));
    expect(tile.unavailable).toBeUndefined();
    expect(tile.fixHref).toBeUndefined();
    expect(tile.poolSize).toBe(1);
  });

  it('keeps the words of a shared pool’s own maker, whom nobody added', () => {
    // A pool made on the shared pools page, read by the person who made it: "No keys", as before.
    expect(tileOf(codexPool('jiang', [], { shared: true, ownerHasChatGPT: false })).unavailable).toBe('No keys');
  });

  it('still says first that this runner has no Codex CLI to run it on', () => {
    expect(tileOf(codexPool('zhang'), [{ engine: 'codex', installed: false, auth: 'unknown' }])).toMatchObject({
      unavailable: 'Not installed',
      fixEngine: 'codex',
    });
  });
});
