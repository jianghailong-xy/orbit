import { describe, expect, it } from 'vitest';
import { AgentProvider } from '@orbit/shared';
import {
  brandForProvider,
  currentEngineChoice,
  currentProviderChoice,
  defaultModelLabel,
  engineChoices,
  engineProviders,
  engineTitleFor,
  engineVia,
  keyName,
  providerNameOn,
  runtimeSummary,
  type ChoiceSources,
  type EngineChoice,
  type ProviderChoice,
} from './sessionProviderChoices';
import type { ConfiguredProvider } from './workspaceDefaults';
import { PROVIDER_GLYPHS } from './providerGlyphs';
import { encodeId } from './idCodec';
import type { CodexLogin } from './codexLogin';
import { sharedPoolAsProviderPool, type SharedPool, type SharedPoolKey, type SharedPoolPerson } from './sharedPools';

const { CLAUDE, CODEX, KIMI, ANTIGRAVITY, OPENCODE, DSH } = AgentProvider;

// Keys as GET /providers serves them: each with the engines it runs on, its default first (§6.3).
const deepseek: ConfiguredProvider = {
  slug: 'deepseek',
  label: 'DeepSeek',
  runtime: 'claude',
  models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
  defaultModel: 'deepseek-v4-pro',
  presetSlug: 'deepseek',
  runsOnOpenCode: true,
  engines: ['claude', 'opencode', 'dsh'],
};
const deepseek2: ConfiguredProvider = { ...deepseek, slug: 'deepseek-2', label: 'DeepSeek 2' };

const custom: ConfiguredProvider = {
  slug: 'my-endpoint',
  label: 'my endpoint',
  runtime: 'claude',
  models: [{ value: 'x-1', label: 'X 1' }],
  defaultModel: 'x-1',
  presetSlug: null,
  runsOnOpenCode: true,
  engines: ['claude', 'opencode'],
};

const moonshot: ConfiguredProvider = {
  slug: 'moonshot',
  label: 'Kimi (Moonshot)',
  runtime: 'kimi',
  models: [{ value: 'kimi-k3', label: 'Kimi K3' }],
  defaultModel: 'kimi-k3',
  presetSlug: 'moonshot',
  runsOnOpenCode: true,
  engines: ['kimi', 'opencode'],
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
  runsOnOpenCode: true,
  engines: ['antigravity', 'opencode'],
};

// A Claude subscription token: the server says it runs on Claude Code alone.
const claudeMax: ConfiguredProvider = {
  slug: 'claude-max',
  label: 'Claude Max',
  runtime: 'claude',
  models: [],
  presetSlug: 'anthropic',
  modelsFromRuntime: true,
  engines: ['claude'],
};

const catalog = {
  claude: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }],
  codex: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
} as never;

/** A runner that can run DeepSeek Harness: it declares the capability and reports the CLI. */
const dshReady = { capabilities: ['provider:dsh'], engines: [{ engine: 'dsh' as const, installed: true, auth: 'unknown' as const, version: '0.2.0-rc.2', platformSupported: true }] };

const sources = (over: Partial<ChoiceSources> = {}): ChoiceSources => ({ configured: [], modelCatalog: catalog, ...over });
const slugs = (rows: readonly { slug: string }[]) => rows.map((row) => row.slug);
const engineOf = (engines: EngineChoice[], engine: AgentProvider) => engines.find((row) => row.slug === engine);
const loginOf = (rows: ProviderChoice[]) => rows.find((row) => row.kind === 'login');

describe('engineChoices: the engines a new session can pick', () => {
  it('lists the engines by their CLI names, in ALL_ENGINES order', () => {
    const engines = engineChoices(sources({ configured: [deepseek, moonshot, gemini] }));
    expect(slugs(engines)).toEqual(['claude', 'codex', 'kimi', 'antigravity', 'opencode', 'dsh']);
    expect(engines.map((engine) => engine.label)).toEqual([
      'Claude Code',
      'Codex',
      'Kimi Code',
      'Antigravity CLI',
      'OpenCode',
      'DeepSeek Harness',
    ]);
    // A DeepSeek key lists DeepSeek Harness; on a runner that has said nothing of it, it waits for one.
    expect(engineOf(engines, DSH)).toMatchObject({ unavailable: 'Update runner', fixEngine: 'dsh' });
  });

  it('lists an engine once, with every credential it runs on — one key under several engines', () => {
    const engines = engineChoices(sources({ configured: [deepseek, moonshot, gemini] }));
    expect(slugs(engineOf(engines, CLAUDE)!.providers)).toEqual(['claude', 'deepseek']);
    expect(slugs(engineOf(engines, KIMI)!.providers)).toEqual(['kimi', 'moonshot']);
    expect(slugs(engineOf(engines, ANTIGRAVITY)!.providers)).toEqual(['gemini']);
    // OpenCode: its own configuration, and every key it runs.
    expect(slugs(engineOf(engines, OPENCODE)!.providers)).toEqual(['opencode', 'deepseek', 'moonshot', 'gemini']);
  });

  it('leaves out Antigravity with neither a confirmed environment key, a Google account nor a Gemini key', () => {
    expect(slugs(engineChoices(sources()))).toEqual(['claude', 'codex', 'kimi', 'opencode']);
    expect(slugs(engineChoices(sources({ antigravityKeyAvailable: true })))).toContain('antigravity');
  });

  it("lands on the engine's own sign-in, unless a preferred provider of it can run", () => {
    const configured = [deepseek, moonshot, gemini];
    const landing = (preferred: { engine: string; provider: string }[]) =>
      engineChoices(sources({ configured, antigravityKeyAvailable: true }), preferred).map((engine) => engine.provider?.slug);
    expect(landing([])).toEqual(['claude', 'codex', 'kimi', 'antigravity', 'opencode', 'deepseek']);
    // The draft's pick first, then what the workspace last ran: each only on its own engine.
    expect(landing([{ engine: 'claude', provider: 'deepseek' }, { engine: 'kimi', provider: 'moonshot' }])).toEqual([
      'deepseek',
      'codex',
      'moonshot',
      'antigravity',
      'opencode',
      'deepseek',
    ]);
    expect(landing([{ engine: 'opencode', provider: 'deepseek' }])).toEqual(['claude', 'codex', 'kimi', 'antigravity', 'deepseek', 'deepseek']);
  });

  it('skips a preferred provider that cannot run, and a signed-out sign-in, for one that can', () => {
    const engines = engineChoices(
      sources({ configured: [deepseek], engineHealth: [{ engine: 'claude', installed: true, auth: 'no' }] }),
    );
    const claude = engineOf(engines, CLAUDE)!;
    expect(claude.provider?.slug).toBe('deepseek');
    expect(claude.unavailable).toBeUndefined();
  });

  it('carries the reason when no credential of the engine can run', () => {
    const engines = engineChoices(
      sources({ configured: [moonshot], engineHealth: [{ engine: 'kimi', installed: false, auth: 'unknown' }] }),
      [{ engine: 'kimi', provider: 'moonshot' }],
    );
    const kimi = engineOf(engines, KIMI)!;
    expect(kimi.provider?.slug).toBe('kimi');
    expect(kimi).toMatchObject({ unavailable: 'Not installed', fixEngine: 'kimi' });
  });

  it('keeps OpenCode listed, with its reason, until the runner reports it installed', () => {
    // Orbit installs it, so a machine without it is a row the picker can send somewhere. It has no
    // sign-in to relay, so the row is never a pick before the CLI is there.
    const engines = engineChoices(sources({ engineHealth: [{ engine: 'opencode', installed: false, auth: 'unknown' }] }));
    expect(engineOf(engines, OPENCODE)).toMatchObject({ label: 'OpenCode', unavailable: 'Not installed', fixEngine: 'opencode' });
    // A runner that reports its engines but not OpenCode has not got it either.
    expect(engineOf(engineChoices(sources({ engineHealth: [{ engine: 'claude', installed: true, auth: 'yes' }] })), OPENCODE)?.unavailable).toBe(
      'Not installed',
    );
    // A runner that has reported nothing claims nothing.
    expect(engineOf(engineChoices(sources()), OPENCODE)?.unavailable).toBeUndefined();
  });

  it('previews each engine’s model by where it lands', () => {
    const engines = engineChoices(sources({ configured: [deepseek] }), [{ engine: 'claude', provider: 'deepseek' }]);
    expect(engineOf(engines, CLAUDE)?.provider?.modelLabel).toBe('DeepSeek V4 Pro');
    expect(engineOf(engines, CODEX)?.provider?.modelLabel).toBe('GPT-5.6 Sol');
    expect(engineOf(engines, OPENCODE)?.provider?.modelLabel).toBe('Managed by OpenCode');
  });
});

describe('DeepSeek Harness, on the DeepSeek keys', () => {
  const dshCatalog = { ...(catalog as object), dsh: [{ value: 'acp-pro', label: 'DeepSeek V4 Pro' }] } as never;

  it('lists every DeepSeek key under it, and lands on the first', () => {
    const engines = engineChoices(sources({ configured: [deepseek, deepseek2, moonshot], modelCatalog: dshCatalog, dshRunner: dshReady }));
    const dsh = engineOf(engines, DSH)!;
    expect(dsh.label).toBe('DeepSeek Harness');
    expect(slugs(dsh.providers)).toEqual(['deepseek', 'deepseek-2']);
    expect(dsh.providers.every((row) => row.kind === 'key')).toBe(true);
    expect(dsh.provider?.slug).toBe('deepseek');
    expect(dsh.provider?.modelLabel).toBe('DeepSeek V4 Pro');
    // A key with no DeepSeek Harness among its engines is not one of them.
    expect(slugs(dsh.providers)).not.toContain('moonshot');
  });

  it('offers to connect a DeepSeek key when there is none, at the DeepSeek connect page', () => {
    const dsh = engineOf(engineChoices(sources({ configured: [moonshot], dshRunner: dshReady })), DSH)!;
    expect(dsh).toMatchObject({ slug: 'dsh', label: 'DeepSeek Harness', provider: null, unavailable: 'Connect a DeepSeek key' });
    expect(dsh.fixHref).toBe('/providers/new/deepseek');
    expect(dsh.providers).toEqual([]);
  });

  it('offers no connection on a runner too old for it, and none at all where there is a key', () => {
    expect(engineOf(engineChoices(sources({ dshRunner: { capabilities: [], engines: [] } })), DSH)).toBeUndefined();
    expect(engineOf(engineChoices(sources({ configured: [deepseek], dshRunner: dshReady })), DSH)?.unavailable).toBeUndefined();
  });

  it('keeps its keys listed where Harness cannot run, with the reason and the engine row that fixes it', () => {
    for (const [runner, reason] of [
      [{ capabilities: [], engines: dshReady.engines }, 'Update runner'],
      [{ capabilities: ['provider:dsh'], engines: [{ ...dshReady.engines[0], installed: false }] }, 'Not installed'],
    ] as const) {
      const rows = engineProviders(DSH, sources({ configured: [deepseek], dshRunner: runner as never }));
      expect(rows[0]).toMatchObject({ slug: 'deepseek', unavailable: reason, fixEngine: 'dsh' });
    }
  });

  it('runs the same key on Claude Code and OpenCode too, never naming the engine on the key', () => {
    const engines = engineChoices(sources({ configured: [deepseek], dshRunner: dshReady }));
    for (const engine of [CLAUDE, OPENCODE, DSH]) {
      const row = engineOf(engines, engine)!.providers.find((choice) => choice.slug === 'deepseek')!;
      expect(row).toMatchObject({ label: 'DeepSeek', kind: 'key' });
      expect(row.labelDetail).toBeUndefined();
    }
  });
});

describe('engineProviders: the credentials an engine runs on, in the Provider menu’s order', () => {
  it('lists the sign-in, then the pools, then the keys — only those the engine runs', () => {
    const pool = { id: 'pool', slug: 'claude-accounts', label: 'Claude accounts', members: [{ slug: 'claude-max' }] };
    const configured = [
      deepseek,
      claudeMax,
      moonshot,
      { slug: pool.slug, label: pool.label, runtime: 'claude', models: [], presetSlug: 'anthropic', modelsFromRuntime: true },
    ];
    const rows = engineProviders(CLAUDE, sources({ configured, pools: [pool] }));
    expect(rows.map((row) => [row.slug, row.kind])).toEqual([
      ['claude', 'login'],
      ['claude-accounts', 'pool'],
      ['deepseek', 'key'],
      ['claude-max', 'key'],
    ]);
  });

  it('keeps a subscription token, which Anthropic serves to Claude Code alone, off OpenCode', () => {
    const configured = [deepseek, claudeMax];
    expect(slugs(engineProviders(OPENCODE, sources({ configured })))).toEqual(['opencode', 'deepseek']);
    expect(slugs(engineProviders(CLAUDE, sources({ configured })))).toContain('claude-max');
  });

  it('reads a row from a payload without `engines` by its protocol, and OpenCode where it says so', () => {
    const older = { slug: 'gw', label: 'Gateway', runtime: 'codex', models: [] };
    expect(slugs(engineProviders(CODEX, sources({ configured: [older] })))).toEqual(['codex', 'gw']);
    expect(slugs(engineProviders(OPENCODE, sources({ configured: [older] })))).toEqual(['opencode']);
    expect(slugs(engineProviders(OPENCODE, sources({ configured: [{ ...older, runsOnOpenCode: true }] })))).toEqual(['opencode', 'gw']);
  });

  it('drops a configured row that shadows a built-in engine slug', () => {
    const shadow: ConfiguredProvider = { ...deepseek, slug: 'kimi', label: 'Kimi (custom)', engines: ['kimi'] };
    const rows = engineProviders(KIMI, sources({ configured: [shadow] }));
    expect(rows.filter((row) => row.slug === 'kimi')).toHaveLength(1);
    expect(rows[0].kind).toBe('login');
  });

  it('carries each credential’s resolved default model on this engine, so a switch previews its model', () => {
    expect(loginOf(engineProviders(CLAUDE, sources({ configured: [deepseek] })))?.modelLabel).toBe('Claude Opus 5');
    expect(engineProviders(CLAUDE, sources({ configured: [deepseek] })).find((row) => row.slug === 'deepseek')?.modelLabel).toBe(
      'DeepSeek V4 Pro',
    );
  });

  it('keeps a sign-in the runner does not have installed, with the reason, fixed on its own engine row', () => {
    const health = [
      { engine: 'claude' as const, installed: true, auth: 'yes' as const },
      { engine: 'codex' as const, installed: false, auth: 'unknown' as const },
      { engine: 'kimi' as const, installed: false, auth: 'unknown' as const },
    ];
    // Hiding it would leave "why is Kimi missing?" with no answer anywhere in the product.
    expect(loginOf(engineProviders(KIMI, sources({ engineHealth: health })))).toMatchObject({ unavailable: 'Not installed', fixEngine: 'kimi' });
    expect(loginOf(engineProviders(CODEX, sources({ engineHealth: health })))?.unavailable).toBe('Not installed');
    expect(loginOf(engineProviders(CLAUDE, sources({ engineHealth: health })))?.unavailable).toBeUndefined();
  });

  it('says not installed, not signed out, for a missing CLI that never answered', () => {
    expect(loginOf(engineProviders(KIMI, sources({ engineHealth: [{ engine: 'kimi', installed: false, auth: 'no' }] })))?.unavailable).toBe(
      'Not installed',
    );
  });

  it('keeps an installed-but-signed-out sign-in, with the reason — and `unknown` pickable', () => {
    const health = [
      { engine: 'codex' as const, installed: true, auth: 'no' as const },
      { engine: 'kimi' as const, installed: true, auth: 'unknown' as const },
    ];
    expect(loginOf(engineProviders(CODEX, sources({ engineHealth: health })))?.unavailable).toBe('Not signed in');
    expect(loginOf(engineProviders(KIMI, sources({ engineHealth: health })))?.unavailable).toBeUndefined();
  });

  it('blocks a key whose engine’s CLI is not installed, and keeps it on a signed-out one — the key is the credential', () => {
    const missing = engineProviders(KIMI, sources({ configured: [moonshot], engineHealth: [{ engine: 'kimi', installed: false, auth: 'unknown' }] }));
    expect(missing.find((row) => row.slug === 'moonshot')).toMatchObject({ unavailable: 'Not installed', fixEngine: 'kimi' });
    const signedOut = engineProviders(KIMI, sources({ configured: [moonshot], engineHealth: [{ engine: 'kimi', installed: true, auth: 'no' }] }));
    expect(loginOf(signedOut)?.unavailable).toBe('Not signed in');
    expect(signedOut.find((row) => row.slug === 'moonshot')?.unavailable).toBeUndefined();
    // Nothing reported about the CLI: nothing claimed.
    expect(engineProviders(KIMI, sources({ configured: [moonshot], engineHealth: null })).find((row) => row.slug === 'moonshot')?.unavailable).toBeUndefined();
  });
});

describe('Antigravity’s sign-in and Gemini keys', () => {
  it('offers the sign-in with the model the runner reports first, and says how it signs in', () => {
    const withAgy = {
      ...(catalog as object),
      antigravity: [
        { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', reasoningLevels: ['low', 'medium', 'high'] },
        { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', reasoningLevels: ['low', 'high'] },
      ],
    } as never;
    const row = loginOf(engineProviders(ANTIGRAVITY, sources({ modelCatalog: withAgy, antigravityKeyAvailable: true })));
    expect(row).toMatchObject({ kind: 'login', labelDetail: 'env key', glyphKey: 'antigravity', modelLabel: 'Gemini 3.8 Flash' });
    expect(defaultModelLabel(ANTIGRAVITY, 'antigravity', catalog)).toBe('Gemini 3.8 Flash');
  });

  it('uses the server key boolean instead of inferring availability from runner auth', () => {
    const ready = { supported: true, installed: true, version: 'agy 1.2.16', envKeyAvailable: true };
    const health = [{ engine: 'antigravity' as const, installed: true, auth: 'yes' as const }];
    expect(slugs(engineProviders(ANTIGRAVITY, sources({ configured: [gemini], engineHealth: health })))).toEqual(['gemini']);
    expect(slugs(engineProviders(ANTIGRAVITY, sources({ configured: [gemini], antigravity: ready, antigravityKeyAvailable: false })))).toEqual([
      'gemini',
    ]);
    expect(loginOf(engineProviders(ANTIGRAVITY, sources({ antigravity: ready, antigravityKeyAvailable: true })))).toMatchObject({
      labelDetail: 'env key',
    });
    // A Gemini key keeps the name its owner gave it.
    expect(engineProviders(ANTIGRAVITY, sources({ configured: [{ ...gemini, label: 'Work Gemini' }] }))[0].label).toBe('Work Gemini');
  });

  it('allows a workspace key to run Antigravity after the runner Google sign-in expires', () => {
    const expired = {
      supported: true, installed: true, version: 'agy 1.2.16', envKeyAvailable: false,
      authSource: 'google' as const, googleLogin: 'available' as const,
    };
    const health = [{ engine: 'antigravity' as const, installed: true, auth: 'no' as const, authSource: 'google' as const }];
    const login = (keyAvailable?: boolean) =>
      loginOf(engineProviders(ANTIGRAVITY, sources({ configured: [gemini], engineHealth: health, antigravity: expired, antigravityKeyAvailable: keyAvailable })));
    expect(login()).toMatchObject({ labelDetail: 'Google account', unavailable: 'Not signed in', fixEngine: 'antigravity' });
    expect(login(true)).toMatchObject({ kind: 'login', labelDetail: 'env key' });
    expect(login(true)?.unavailable).toBeUndefined();
    const withoutCli = loginOf(engineProviders(ANTIGRAVITY, sources({ engineHealth: health, antigravity: { ...expired, installed: false }, antigravityKeyAvailable: true })));
    expect(withoutCli).toMatchObject({ unavailable: 'Not installed', fixEngine: 'antigravity' });
  });

  it.each([
    [{ supported: false, installed: true, version: '1.2.16', envKeyAvailable: true }, 'Update runner'],
    [{ supported: true, installed: false, version: null, envKeyAvailable: true }, 'Not installed'],
  ] as const)('blocks both Gemini entrances with the server readiness %j', (state, unavailable) => {
    const rows = engineProviders(ANTIGRAVITY, sources({ configured: [gemini], antigravity: state }));
    for (const slug of ['antigravity', 'gemini']) {
      expect(rows.find((row) => row.slug === slug)).toMatchObject({ unavailable, fixEngine: 'antigravity' });
    }
  });

  it('blocks a Gemini key where agy is missing, and keeps it where agy is signed out — the key is the sign-in', () => {
    const missing = engineProviders(ANTIGRAVITY, sources({ configured: [gemini], engineHealth: [{ engine: 'antigravity', installed: false, auth: 'unknown' }] }));
    expect(missing.find((row) => row.slug === 'gemini')).toMatchObject({ unavailable: 'Not installed', fixEngine: 'antigravity' });
    const ready = engineProviders(ANTIGRAVITY, sources({ configured: [gemini], engineHealth: [{ engine: 'antigravity', installed: true, auth: 'no' }] }));
    expect(ready.find((row) => row.slug === 'gemini')?.unavailable).toBeUndefined();
  });
});

describe('the runner’s Codex accounts, on Codex’s own sign-in', () => {
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
  const accountsOf = (engineHealth: ChoiceSources['engineHealth'], engine: AgentProvider = CODEX, planUsage = usage) =>
    loginOf(engineProviders(engine, sources({ engineHealth, planUsage })))?.accounts;

  it('lists each account with its own quota once the runner has signed in two', () => {
    expect(
      accountsOf(codex([{ id: 'default', auth: 'yes' }, { id: '3fa91c2e', name: 'Work', auth: 'yes' }, { id: 'c0ffee42', auth: 'no' }])),
    ).toEqual([
      { id: 'default', label: 'Default', quota: '5h 100%', nearLimit: true },
      { id: '3fa91c2e', label: 'Work', quota: 'Weekly 0%' },
      // Unnamed, unread, and signed out: it is listed, and says why it can't take a session.
      { id: 'c0ffee42', label: 'Account c0ffee42', unavailable: 'Not signed in' },
    ]);
    expect(accountsOf(codex([{ id: 'default', auth: 'yes' }, { id: '3fa91c2e', auth: 'yes' }]), CLAUDE)).toBeUndefined();
  });

  it('lists an account by what it was renamed to in Orbit, Default included', () => {
    expect(
      accountsOf(codex([{ id: 'default', name: 'jianghailong.main', auth: 'yes' }, { id: '3fa91c2e', name: 'Research', auth: 'yes' }]))?.map(
        (account) => account.label,
      ),
    ).toEqual(['jianghailong.main', 'Research']);
  });

  it('lists none for a single account — which names the sign-in instead — or for a sign-in that cannot run', () => {
    expect(accountsOf(codex([{ id: 'default', auth: 'yes' }]))).toBeUndefined();
    expect(loginOf(engineProviders(CODEX, sources({ engineHealth: codex([{ id: 'default', name: 'Personal', auth: 'yes' }]) })))?.label).toBe('Personal');
    expect(loginOf(engineProviders(CODEX, sources()))?.label).toBe('Default');
    const signedOut = codex([{ id: 'default', auth: 'no' }, { id: '3fa91c2e', auth: 'yes' }]);
    signedOut[1].auth = 'no' as never;
    expect(loginOf(engineProviders(CODEX, sources({ engineHealth: signedOut, planUsage: usage })))?.unavailable).toBe('Not signed in');
    expect(accountsOf(signedOut)).toBeUndefined();
  });

  it("lists a Claude login's accounts on Claude Code's sign-in, each by the window that stops it", () => {
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
    expect(accountsOf(engines, CLAUDE, claudeUsage)).toEqual([
      // Its 5-hour window reads 0% but its weekly one is spent: the row says what stops it.
      { id: 'default', label: 'Default', quota: 'Weekly 100%', nearLimit: true },
      { id: 'fad98727', label: 'jianghailong.rd', quota: 'Weekly 28%' },
    ]);
  });

  it('gives a key no accounts: accounts are the sign-in’s alone', () => {
    const rows = engineProviders(CODEX, sources({ configured: [{ slug: 'gw', label: 'Gateway', runtime: 'codex', models: [], engines: ['codex'] }], engineHealth: codex([{ id: 'default', auth: 'yes' }, { id: '3fa91c2e', auth: 'yes' }]), planUsage: usage }));
    expect(rows.find((row) => row.slug === 'gw')?.accounts).toBeUndefined();
  });
});

describe('the runner’s Antigravity (Google) accounts, on Antigravity’s own sign-in', () => {
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
  const login = (engineHealth: ChoiceSources['engineHealth'], antigravity: ChoiceSources['antigravity'], planUsage: ChoiceSources['planUsage'] = null) =>
    loginOf(engineProviders(ANTIGRAVITY, sources({ engineHealth, antigravity, planUsage })));

  it('lists each account by the bucket with the least left, in what is left, read from the engine’s health', () => {
    const row = login(
      engines([{ id: 'default', auth: 'yes' }, { id: '5c2e91a0', name: 'Work', auth: 'yes' }, { id: 'c0ffee42', auth: 'no' }]),
      google,
      // The heartbeat's own report holds nothing of Antigravity's.
      { claude: { provider: 'claude', fiveHour: { utilization: 3 } } } as never,
    );
    expect(row?.accounts).toEqual([
      { id: 'default', label: 'Default', quota: '3p-weekly 98% left' },
      { id: '5c2e91a0', label: 'Work', quota: 'gemini-5h 4% left', nearLimit: true },
      { id: 'c0ffee42', label: 'Account c0ffee42', unavailable: 'Not signed in' },
    ]);
    // The Provider menu may still say how the engine signs in.
    expect(row?.labelDetail).toBe('Google account');
  });

  it('lists none for one account, or for a sign-in that cannot run', () => {
    expect(login(engines([{ id: 'default', auth: 'yes' }]), google)?.accounts).toBeUndefined();
    const blocked = login(engines([{ id: 'default', auth: 'no' }, { id: '5c2e91a0', auth: 'no' }], { auth: 'no' }), { ...google, envKeyAvailable: false });
    expect(blocked?.unavailable).toBe('Not signed in');
    expect(blocked?.accounts).toBeUndefined();
  });

  it('offers Default on the runner’s Gemini key as the key it runs on, never as signed out', () => {
    const row = login(
      engines([{ id: 'default', auth: 'no' }, { id: '5c2e91a0', name: 'Work', auth: 'yes' }], { authSource: 'env_key' }),
      { ...google, authSource: 'env_key' as const },
    );
    expect(row?.accounts).toEqual([
      { id: 'default', label: 'Default', quota: 'env key' },
      { id: '5c2e91a0', label: 'Work', quota: 'gemini-5h 4% left', nearLimit: true },
    ]);
  });
});

describe('the runner’s Kimi Code accounts, on Kimi Code’s own sign-in', () => {
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
  const login = (engineHealth: ChoiceSources['engineHealth']) => loginOf(engineProviders(KIMI, sources({ engineHealth, planUsage: usage })));

  it('lists each account by the window that stops it, the month by its total', () => {
    expect(login(kimi([{ id: 'default', auth: 'yes' }, { id: '5c2e91a0', name: 'Work', auth: 'yes' }, { id: 'c0ffee42', auth: 'no' }]))?.accounts).toEqual([
      // Its month is the fullest of the windows drawn, though its 5-hour one has room; its coding share
      // is never one of them.
      { id: 'default', label: 'Default', quota: 'Monthly 41%' },
      { id: '5c2e91a0', label: 'Work', quota: '5h 97%', nearLimit: true },
      { id: 'c0ffee42', label: 'Account c0ffee42', unavailable: 'Not signed in' },
    ]);
  });

  it('lists none for one account, or for a sign-in that cannot run', () => {
    expect(login(kimi([{ id: 'default', auth: 'yes' }]))?.accounts).toBeUndefined();
    const blocked = login(kimi([{ id: 'default', auth: 'no' }, { id: '5c2e91a0', auth: 'no' }], 'no'));
    expect(blocked?.unavailable).toBe('Not signed in');
    expect(blocked?.accounts).toBeUndefined();
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
    for (const engine of engineChoices(sources({ configured: [deepseek, custom], dshRunner: dshReady }))) {
      if (engine.glyphKey) expect(PROVIDER_GLYPHS[engine.glyphKey]).toBeTruthy();
      for (const choice of engine.providers) if (choice.glyphKey) expect(PROVIDER_GLYPHS[choice.glyphKey]).toBeTruthy();
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

describe('currentProviderChoice: a session’s provider its engine’s menu does not list', () => {
  it('resolves the pick from the listed credentials', () => {
    const rows = engineProviders(CLAUDE, sources({ configured: [deepseek] }));
    expect(currentProviderChoice(CLAUDE, 'deepseek', rows, sources({ configured: [deepseek] })).label).toBe('DeepSeek');
  });

  it('names OpenCode’s own configuration as itself', () => {
    const current = currentProviderChoice(OPENCODE, 'opencode', [], sources());
    expect(current).toMatchObject({ slug: 'opencode', kind: 'opencode', label: "OpenCode's own sign-in" });
  });

  it('synthesizes an entry for a key that has since been removed, by its slug, without moving the engine', () => {
    const current = currentProviderChoice(DSH, 'gone-away', [], sources());
    expect(current).toMatchObject({ slug: 'gone-away', label: 'gone-away', kind: 'key' });
    expect(current.brand.mono).toBe('G');
  });

  it('keeps a configured key’s own name where its engine does not list it', () => {
    expect(currentProviderChoice(DSH, 'moonshot', [], sources({ configured: [moonshot] })).label).toBe('Kimi (Moonshot)');
  });

  it('names the legacy built-in `dsh` as the key its workspace’s environment holds', () => {
    expect(currentProviderChoice(DSH, 'dsh', [], sources())).toMatchObject({ slug: 'dsh', label: 'Workspace key', labelDetail: 'ORBIT_DSH_API_KEY' });
  });

  it('lands the hero’s current engine on the pick even where its engine does not list it', () => {
    const engines = engineChoices(sources({ configured: [deepseek] }));
    const current = currentEngineChoice(CLAUDE, 'gone-away', engines, sources({ configured: [deepseek] }));
    expect(current).toMatchObject({ slug: 'claude', label: 'Claude Code' });
    expect(current.provider?.slug).toBe('gone-away');
    expect(slugs(current.providers)).toEqual(['claude', 'deepseek']);
  });
});

describe('defaultModelLabel', () => {
  it('says who picks when the engine manages the model itself', () => {
    expect(defaultModelLabel(OPENCODE, 'opencode', catalog, [])).toBe('Managed by OpenCode');
    expect(defaultModelLabel(DSH, 'deepseek', catalog, [deepseek])).toBe('Managed by the provider');
  });

  it('names a model by its catalogue label, per engine and credential', () => {
    expect(defaultModelLabel(KIMI, 'kimi', catalog, [])).toBe('Kimi for Coding');
    expect(defaultModelLabel(CLAUDE, 'deepseek', catalog, [deepseek])).toBe('DeepSeek V4 Pro');
    expect(defaultModelLabel(OPENCODE, 'deepseek', catalog, [deepseek])).toBe('DeepSeek V4 Pro');
  });
});

describe('the Provider menu of a session, by its engine (board 5)', () => {
  const anthropic: ConfiguredProvider = {
    slug: 'anthropic',
    label: 'Anthropic (Claude)',
    runtime: 'claude',
    models: [],
    defaultModel: 'claude-opus-5',
    presetSlug: 'anthropic',
    modelsFromRuntime: true,
    engines: ['claude', 'opencode'],
  };
  const anthropic2: ConfiguredProvider = { ...anthropic, slug: 'anthropic-2', label: 'Work account' };
  const configured = [anthropic, anthropic2, deepseek, moonshot];

  it('offers the engine’s own sign-in and every key it runs, in one order whichever is running', () => {
    expect(slugs(engineProviders(CLAUDE, sources({ configured })))).toEqual(['claude', 'anthropic', 'anthropic-2', 'deepseek']);
  });

  it('never offers another engine’s credentials — Codex and Kimi are a different session', () => {
    const rows = slugs(engineProviders(CLAUDE, sources({ configured })));
    expect(rows).not.toContain('codex');
    expect(rows).not.toContain('kimi');
    expect(rows).not.toContain('moonshot');
  });

  it('leaves a lone credential alone, so the composer can leave the Provider row out', () => {
    expect(engineProviders(KIMI, sources())).toHaveLength(1);
    expect(engineProviders(CODEX, sources())).toHaveLength(1);
  });

  it('keeps a target this machine cannot run, with its reason — the keys stay pickable', () => {
    const rows = engineProviders(CLAUDE, sources({ configured: [anthropic, anthropic2], engineHealth: [{ engine: 'claude', installed: true, auth: 'no' }] }));
    expect(slugs(rows)).toEqual(['claude', 'anthropic', 'anthropic-2']);
    expect(rows[0]).toMatchObject({ unavailable: 'Not signed in', fixEngine: 'claude' });
    expect(rows.find((row) => row.slug === 'anthropic-2')?.unavailable).toBeUndefined();
  });

  it('still names every option when nothing on that CLI can run', () => {
    const rows = engineProviders(CLAUDE, sources({ configured: [anthropic, anthropic2], engineHealth: [{ engine: 'claude', installed: false, auth: 'unknown' }] }));
    expect(rows.every((row) => row.unavailable === 'Not installed')).toBe(true);
  });

  it('names an engine’s own sign-in by the engine where its engine is not beside it', () => {
    const [login, key] = engineProviders(CLAUDE, sources({ configured: [deepseek] }));
    expect(providerNameOn(CLAUDE, login)).toBe('Claude Code');
    expect(providerNameOn(CLAUDE, key)).toBe('DeepSeek');
  });
});

describe('account pools among the credentials', () => {
  const work: ConfiguredProvider = {
    slug: 'anthropic',
    label: 'Work',
    runtime: 'claude',
    models: [],
    presetSlug: 'anthropic',
    modelsFromRuntime: true,
    engines: ['claude', 'opencode'],
  };
  const home: ConfiguredProvider = { ...work, slug: 'anthropic-2', label: 'Home' };
  const pool = { id: 'p1', slug: 'claude-accounts', label: 'Claude accounts', members: [{ slug: 'anthropic' }, { slug: 'anthropic-2' }] };
  // What WorkspaceView hands in: the catalogue with the pools appended (poolsAsProviders).
  const configured: ConfiguredProvider[] = [
    work,
    home,
    deepseek,
    { slug: pool.slug, label: pool.label, runtime: 'claude', models: [], presetSlug: 'anthropic', modelsFromRuntime: true },
  ];

  it('offers a pool once, after the sign-in, as its own kind with its account count', () => {
    const rows = engineProviders(CLAUDE, sources({ configured, pools: [pool] }));
    expect(slugs(rows)).toEqual(['claude', 'claude-accounts', 'anthropic', 'anthropic-2', 'deepseek']);
    const tile = rows.find((row) => row.slug === 'claude-accounts')!;
    expect(tile).toMatchObject({ kind: 'pool', label: 'Claude accounts', poolSize: 2, glyphKey: 'anthropic' });
    // Its model is the Claude CLI's own, named as the catalogue names it.
    expect(tile.modelLabel).toBe('Claude Opus 5');
    // A pool runs on its own engine alone: not under OpenCode.
    expect(slugs(engineProviders(OPENCODE, sources({ configured, pools: [pool] })))).not.toContain('claude-accounts');
  });

  it("keeps the pool's accounts pickable on their own, marked for a pick to land on the pool first", () => {
    const rows = engineProviders(CLAUDE, sources({ configured, pools: [pool] }));
    expect(rows.filter((row) => row.inPool).map((row) => row.slug)).toEqual(['anthropic', 'anthropic-2']);
    expect(rows.find((row) => row.slug === 'deepseek')?.inPool).toBeUndefined();
  });

  it('holds a pool to the Claude CLI being there, as a key is', () => {
    const rows = engineProviders(CLAUDE, sources({ configured, pools: [pool], engineHealth: [{ engine: 'claude', installed: false, auth: 'unknown' }] }));
    expect(rows.find((row) => row.slug === 'claude-accounts')).toMatchObject({ unavailable: 'Not installed', fixEngine: 'claude' });
  });
});

describe('shared pools among the credentials', () => {
  // A shared pool of OpenAI keys as WorkspaceView hands it in: its keys as members
  // (sharedPoolAsProviderPool), and a Codex entry in the catalogue (poolsAsProviders).
  const team = {
    id: 'team',
    slug: 'team-codex',
    label: 'Team Codex',
    members: [{ slug: 'k1' }, { slug: 'k2' }, { slug: 'k3' }],
    shared: {} as never,
  };
  const configured: ConfiguredProvider[] = [
    deepseek,
    { slug: team.slug, label: team.label, runtime: 'codex', models: [], presetSlug: 'openai', modelsFromRuntime: true },
  ];

  it('offers one under Codex, wearing the Codex mark and counting its keys', () => {
    const rows = engineProviders(CODEX, sources({ configured, pools: [team] }));
    expect(slugs(rows)).toEqual(['codex', 'team-codex']);
    expect(rows[1]).toMatchObject({ kind: 'pool', label: 'Team Codex', poolSize: 3, poolUnit: 'key', glyphKey: 'openai' });
    // Its model is the Codex CLI's own.
    expect(rows[1].modelLabel).toBe('GPT-5.6 Sol');
    expect(slugs(engineProviders(CLAUDE, sources({ configured, pools: [team] })))).not.toContain('team-codex');
  });

  it('holds it to the Codex CLI being there, not the Claude one', () => {
    const noCodex = engineProviders(CODEX, sources({ configured, pools: [team], engineHealth: [{ engine: 'codex', installed: false, auth: 'unknown' }] }));
    expect(noCodex.find((row) => row.slug === 'team-codex')).toMatchObject({ unavailable: 'Not installed', fixEngine: 'codex' });
    const noClaude = engineProviders(CODEX, sources({ configured, pools: [team], engineHealth: [{ engine: 'claude', installed: false, auth: 'unknown' }] }));
    expect(noClaude.find((row) => row.slug === 'team-codex')?.unavailable).toBeUndefined();
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
  const tileOf = (pool: SharedPool, engineHealth?: ChoiceSources['engineHealth']) =>
    engineProviders(CODEX, { configured, modelCatalog: catalog, engineHealth, pools: [sharedPoolAsProviderPool(pool)] }).find(
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
  it('says which CLI a vendor on its own API runs on, and the dialect of the rest', () => {
    expect(runtimeSummary('antigravity')).toBe('Runs on the Antigravity CLI');
    expect(runtimeSummary('kimi')).toBe('Runs on the Kimi CLI');
    expect(runtimeSummary('codex')).toBe('OpenAI-compatible');
    expect(runtimeSummary('claude')).toBe('Anthropic-compatible');
  });
});

describe('engineTitleFor', () => {
  it('names the CLI that executes — the session’s own engine — not the vendor whose models it writes', () => {
    expect(engineTitleFor(CLAUDE)).toMatchObject({ slug: 'claude', name: 'Claude Code', glyphKey: 'anthropic' });
    expect(engineTitleFor(CODEX)).toMatchObject({ name: 'Codex', glyphKey: 'openai' });
    expect(engineTitleFor(KIMI)).toMatchObject({ name: 'Kimi Code', glyphKey: 'moonshot' });
    expect(engineTitleFor(OPENCODE).name).toBe('OpenCode');
    expect(engineTitleFor(ANTIGRAVITY)).toMatchObject({ name: 'Antigravity CLI', glyphKey: 'antigravity' });
    // DeepSeek Harness is DeepSeek's own agent, and wears DeepSeek's mark.
    expect(engineTitleFor(DSH)).toMatchObject({ name: 'DeepSeek Harness', glyphKey: 'deepseek-harness' });
  });
});

describe('what the cards and settings call a key and an engine', () => {
  it('names a key by its vendor and its own name, never its slug or an engine (board 8)', () => {
    expect(keyName(deepseek2)).toBe('the DeepSeek key “DeepSeek 2”');
    expect(keyName(moonshot)).toBe('the Moonshot key “Kimi (Moonshot)”');
    expect(keyName({ label: 'DeepSeek Harness', presetSlug: 'deepseek-harness' })).toBe('the DeepSeek key “DeepSeek Harness”');
    // A custom endpoint is DeepSeek's when DeepSeek Harness runs it — the server's answer, not a guess.
    expect(keyName({ label: 'Proxy', presetSlug: null, engines: ['claude', 'opencode', 'dsh'] })).toBe('the DeepSeek key “Proxy”');
    expect(keyName(custom)).toBe('the key “my endpoint”');
  });

  it('says a workspace’s next session as its engine, via its credential (board 7)', () => {
    expect(engineVia(CLAUDE, 'deepseek', [deepseek])).toBe('Claude Code via DeepSeek');
    expect(engineVia(DSH, 'deepseek-2', [deepseek2])).toBe('DeepSeek Harness via DeepSeek 2');
    expect(engineVia(CLAUDE, 'claude')).toBe('Claude Code');
    expect(engineVia(OPENCODE, 'opencode')).toBe('OpenCode');
    expect(engineVia(CODEX, 'gone', [])).toBe('Codex via gone');
  });
});
