import { describe, expect, it } from 'vitest';
import { AgentProvider, derivePermissionSemantics, type PlanUsage, type RunnerEngineHealth } from '@orbit/shared';
import {
  CURSOR_CONNECT_HREF,
  cursorConversationStarted,
  cursorRunnerState,
  cursorStateHint,
  runnerKnowsCursor,
} from './cursorRuntime';
import { cursorUsageLimit, currentPlanUsageRows, planUsageSnapshotForProvider } from './planUsage';
import { brandForProvider, engineChoices, engineProviders, runtimeSummary, type ChoiceSources } from './sessionProviderChoices';
import { slashAssetMatchesEngine } from './slashCommands';
import {
  clampPermissionModeForModel,
  defaultModelFor,
  effortOptionsFor,
  MODE_OPTIONS,
  modelOptionsFor,
  normalizeEffortFor,
  permissionModeSupported,
  providerEngines,
  type ConfiguredProvider,
} from './workspaceDefaults';

const { CURSOR, CLAUDE } = AgentProvider;
const PINNED = '2026.10.14-941492e';

const cursorHealth = (over: Partial<RunnerEngineHealth> = {}): RunnerEngineHealth => ({
  engine: 'cursor',
  installed: true,
  version: PINNED,
  auth: 'yes',
  ...over,
});

// A runner on the pinned build, which declares Cursor CLI (P1, P3).
const ready = { capabilities: ['provider:cursor'], engines: [cursorHealth()] };

describe('whether a runner can start Cursor CLI', () => {
  it('reads the board’s order: a runner that predates it, an unmeasured platform, another build, none at all', () => {
    // No report of Cursor CLI at all: the runner predates it.
    expect(cursorRunnerState({ capabilities: ['provider:dsh'], engines: [] })).toBe('updateRunner');
    expect(cursorRunnerState(null)).toBe('updateRunner');
    expect(
      cursorRunnerState({
        engines: [cursorHealth({ installed: false, version: undefined, installationError: 'CURSOR_PLATFORM_UNSUPPORTED: Orbit runs Cursor CLI 2026.10.14-941492e only on linux/amd64 runners; this runner is darwin/arm64' })],
      }),
    ).toBe('unsupportedPlatform');
    expect(
      cursorRunnerState({
        engines: [cursorHealth({ version: '2026.10.16-e3cb207', installationError: 'CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly 2026.10.14-941492e' })],
      }),
    ).toBe('unsupportedVersion');
    expect(cursorRunnerState({ engines: [cursorHealth({ installed: false, installationError: 'CURSOR_NOT_INSTALLED: …' })] })).toBe('notInstalled');
    // The pinned build is ready but undeclared: a runner built before the session driver (P5a).
    expect(cursorRunnerState({ capabilities: [], engines: [cursorHealth()] })).toBe('updateRunner');
    expect(cursorRunnerState(ready)).toBe('ready');
    // Signed out is the credential's question, not the runner's.
    expect(cursorRunnerState({ ...ready, engines: [cursorHealth({ auth: 'no' })] })).toBe('ready');
  });

  it('knows Cursor CLI once the runner reports it, installed or not, or declares it', () => {
    expect(runnerKnowsCursor({ capabilities: ['provider:dsh'], engines: [] })).toBe(false);
    expect(runnerKnowsCursor({ engines: [cursorHealth({ installed: false })] })).toBe(true);
    expect(runnerKnowsCursor({ capabilities: ['provider:cursor'] })).toBe(true);
  });

  it('says under the row what each blocking state means, a platform in the runner’s own words', () => {
    expect(cursorStateHint('updateRunner')).toBe('This runner predates Cursor CLI. It updates itself when no session is running on it.');
    expect(cursorStateHint('unsupportedVersion')).toBe(
      'Orbit runs Cursor CLI 2026.10.14-941492e. Reinstall puts that version back on this runner; sessions here can’t start until then.',
    );
    expect(
      cursorStateHint('unsupportedPlatform', {
        installationError: 'CURSOR_PLATFORM_UNSUPPORTED: Orbit runs Cursor CLI 2026.10.14-941492e only on linux/amd64 runners; this runner is darwin/arm64',
      }),
    ).toBe('Orbit runs Cursor CLI 2026.10.14-941492e only on linux/amd64 runners; this runner is darwin/arm64.');
    expect(cursorStateHint('notInstalled')).toBeNull();
    expect(CURSOR_CONNECT_HREF).toBe('/providers/new/cursor-api');
  });

  it('counts a session as having talked the way the server does before it moves one (P6b)', () => {
    expect(cursorConversationStarted({ numTurns: 0, runtimeSessionId: null, status: 'AWAITING_INPUT' })).toBe(false);
    expect(cursorConversationStarted({ numTurns: 1, runtimeSessionId: null, status: 'AWAITING_INPUT' })).toBe(true);
    expect(cursorConversationStarted({ numTurns: 0, runtimeSessionId: 'acp-1', status: 'COMPLETED' })).toBe(true);
    expect(cursorConversationStarted({ numTurns: 0, runtimeSessionId: null, status: 'RUNNING' })).toBe(true);
    expect(cursorConversationStarted({ numTurns: 0, runtimeSessionId: null, status: 'AWAITING_INPUT', engineTurnActive: true })).toBe(true);
    expect(cursorConversationStarted(null)).toBe(false);
  });
});

// Cursor CLI's ACP catalogue as the runner reports it (cursor_models.go): Auto is `default`, with no
// parameters; a model with an effort carries its own levels.
const catalog = {
  claude: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }],
  cursor: [
    { value: 'default', label: 'Auto' },
    { value: 'claude-opus-5-5', label: 'Claude Opus 5.5', reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningLevel: 'high' },
    { value: 'composer-2.5', label: 'Composer 2.5' },
  ],
} as never;

// A Cursor User API Key (P2's preset), as GET /providers serves it: Cursor CLI alone.
const cursorKey: ConfiguredProvider = {
  slug: 'cursor-api',
  label: 'Cursor',
  runtime: 'cursor',
  models: [],
  defaultModel: null,
  presetSlug: 'cursor-api',
  modelsFromRuntime: true,
  engines: ['cursor'],
};

describe('Cursor CLI’s models, efforts and modes', () => {
  it('offers its catalogue on its own sign-in and on a Cursor key alike, Auto first and the default', () => {
    for (const provider of [CURSOR, cursorKey.slug]) {
      expect(modelOptionsFor(CURSOR, provider, catalog, [cursorKey]).map((m) => m.label)).toEqual(['Auto', 'Claude Opus 5.5', 'Composer 2.5']);
      expect(defaultModelFor(CURSOR, provider, catalog, [cursorKey])).toBe('default');
    }
    // Before a runner reports a catalogue: naming no model, which runs as Auto — never a Claude model.
    expect(modelOptionsFor(CURSOR, CURSOR, null, [])).toEqual([{ value: '', label: 'Auto' }]);
    expect(defaultModelFor(CURSOR, CURSOR, null, [])).toBe('');
    expect(providerEngines(cursorKey.slug, [cursorKey])).toEqual([CURSOR]);
  });

  it('offers a model’s own efforts by their values, and none but Default on Auto', () => {
    expect(effortOptionsFor(CURSOR, CURSOR, 'claude-opus-5-5', catalog).map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortOptionsFor(CURSOR, CURSOR, 'default', catalog)).toEqual([{ value: '', label: 'Default' }]);
    expect(effortOptionsFor(CURSOR, CURSOR, 'unknown-model', catalog)).toEqual([{ value: '', label: 'Default' }]);
    expect(normalizeEffortFor(CURSOR, CURSOR, 'high', 'claude-opus-5-5', catalog)).toBe('high');
    expect(normalizeEffortFor(CURSOR, CURSOR, 'high', 'default', catalog)).toBe('');
  });

  it('refuses Default and falls back to Accept Edits (D6), and keeps every mode Cursor CLI can be held to', () => {
    const offered = MODE_OPTIONS.filter((m) => permissionModeSupported(m.value, CURSOR)).map((m) => m.value);
    expect(offered).toEqual(['plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
    expect(clampPermissionModeForModel('default', 'default', CURSOR, CURSOR, [], catalog)).toBe('acceptEdits');
    expect(clampPermissionModeForModel('auto', 'default', CURSOR, CURSOR, [], catalog)).toBe('auto');
    // Every other engine falls back as before.
    expect(clampPermissionModeForModel('default', 'claude-opus-5', CLAUDE, CLAUDE, [], catalog)).toBe('default');
    // The picker's caveat is the shared table's, not the web's own words.
    expect(derivePermissionSemantics(CURSOR, 'default').shortNote).toBe('unsupported on Cursor CLI; session configuration is rejected');
  });

  it('lists only Cursor CLI’s own slash commands on a Cursor CLI session, and leaves Claude’s to Claude Code', () => {
    expect(slashAssetMatchesEngine('cursor', 'cursor')).toBe(true);
    expect(slashAssetMatchesEngine('claude', 'cursor')).toBe(false);
    expect(slashAssetMatchesEngine(undefined, 'cursor')).toBe(false);
    expect(slashAssetMatchesEngine('cursor', 'claude')).toBe(false);
    expect(slashAssetMatchesEngine(undefined, 'claude')).toBe(true);
  });
});

describe('a Cursor CLI account’s quota', () => {
  const now = Date.parse('2026-10-17T07:00:00Z');
  // Default on the Free plan (no reading Cursor reports: its 0% is none), Team on a paid plan at 34%.
  const usage: PlanUsage = {
    cursor: {
      provider: CURSOR,
      account: 'default',
      planName: 'Free',
      includedUsage: { startsAt: '2026-10-03T00:00:00Z', resetsAt: '2026-11-03T00:00:00Z' },
      accounts: {
        '5c2e91a0': {
          provider: CURSOR,
          account: '5c2e91a0',
          planName: 'Pro',
          includedUsage: { period: 'weekly', startsAt: '2026-10-12T00:00:00Z', resetsAt: '2026-10-19T00:00:00Z', percentUsed: 34 },
        },
      },
    },
  };

  it('reads a share only above 0, as its period’s window, and none at all otherwise', () => {
    const cursor = planUsageSnapshotForProvider(usage, CURSOR)!;
    expect(currentPlanUsageRows(cursor, now)).toEqual([]);
    const team = cursor.accounts!['5c2e91a0'];
    expect(currentPlanUsageRows(team, now).map((row) => [row.label, row.percent, row.window.resetsAt])).toEqual([
      ['Weekly limit', 34, '2026-10-19T00:00:00Z'],
    ]);
    // A Claude snapshot elsewhere in the report is not Cursor's.
    expect(planUsageSnapshotForProvider({ claude: { fiveHour: { utilization: 5 } } }, CURSOR)).toBeNull();
  });

  it('is spent from a turn that met the limit until its usage comes back, and not before or after', () => {
    const spent = { provider: CURSOR, includedUsage: { startsAt: '2026-10-03T00:00:00Z', resetsAt: '2026-11-03T00:00:00Z', limitReachedAt: '2026-10-16T09:00:00Z' } };
    expect(cursorUsageLimit(spent, now)).toEqual({ resetsAt: '2026-11-03T00:00:00Z' });
    // No reset named: spent, with nothing to wait for.
    expect(cursorUsageLimit({ provider: CURSOR, includedUsage: { limitReachedAt: '2026-10-16T09:00:00Z' } }, now)).toEqual({});
    // A limit met last period, and a period that has rolled over since.
    expect(cursorUsageLimit({ provider: CURSOR, includedUsage: { startsAt: '2026-10-17T00:00:00Z', limitReachedAt: '2026-10-16T09:00:00Z' } }, now)).toBeNull();
    expect(cursorUsageLimit({ provider: CURSOR, includedUsage: { resetsAt: '2026-10-17T06:00:00Z', limitReachedAt: '2026-10-16T09:00:00Z' } }, now)).toBeNull();
    expect(cursorUsageLimit({ provider: CURSOR, planName: 'Free' }, now)).toBeNull();
  });
});

describe('Cursor CLI in the New Session hero and the Provider menu', () => {
  const runner = (over: Partial<RunnerEngineHealth> = {}, capabilities = ['provider:cursor']) => ({
    capabilities,
    engines: [{ engine: 'claude', installed: true, auth: 'yes' } as RunnerEngineHealth, cursorHealth(over)],
  });
  const sources = (facts: ReturnType<typeof runner>, configured: ConfiguredProvider[] = [], fleet?: ChoiceSources['fleet']): ChoiceSources => ({
    configured,
    modelCatalog: catalog,
    engineHealth: facts.engines,
    dshRunner: facts,
    fleet,
  });

  it('is offered seventh, on its own sign-in, with Auto — and only once a runner of the account knows it', () => {
    // Engines this runner reports nothing about claim nothing, and stay listed (DeepSeek Harness as
    // "Update runner", this runner lacking it); Cursor CLI comes last.
    const engines = engineChoices(sources(runner()));
    expect(engines.map((e) => e.label)).toEqual(['Claude Code', 'Codex', 'Kimi Code', 'OpenCode', 'DeepSeek Harness', 'Cursor CLI']);
    const cursor = engines.find((e) => e.slug === CURSOR)!;
    expect(cursor.provider).toMatchObject({ slug: CURSOR, kind: 'login', modelLabel: 'Auto' });
    expect(cursor.unavailable).toBeUndefined();
    expect(cursor.glyphKey).toBe('cursor-api');
    // A runner of the account that has never heard of Cursor CLI: the hero is as it was.
    const older = { capabilities: [], engines: [{ engine: 'claude', installed: true, auth: 'yes' } as RunnerEngineHealth] };
    expect(engineChoices({ configured: [], engineHealth: older.engines, dshRunner: older }).map((e) => e.label)).toEqual([
      'Claude Code',
      'Codex',
      'Kimi Code',
      'OpenCode',
      'DeepSeek Harness',
    ]);
    // …but another runner that knows it makes this one say why it can't run it.
    const here = engineChoices({ configured: [], engineHealth: older.engines, dshRunner: older, fleet: [older, runner()] });
    expect(here.find((e) => e.slug === CURSOR)?.unavailable).toBe('Update runner');
  });

  it('greys out with the reason that matters most, and lands on a Cursor key instead of a signed-out sign-in', () => {
    const blocked = (facts: ReturnType<typeof runner>) => engineChoices(sources(facts)).find((e) => e.slug === CURSOR)?.unavailable;
    expect(blocked(runner({ installed: false, version: undefined, installationError: 'CURSOR_NOT_INSTALLED: …' }, []))).toBe('Not installed');
    expect(blocked(runner({ version: '2026.10.16-e3cb207', installationError: 'CURSOR_VERSION_INCOMPATIBLE: …' }, []))).toBe('Unsupported version');
    expect(blocked(runner({}, []))).toBe('Update runner');
    expect(blocked(runner({ auth: 'no' }))).toBe('Not signed in');
    // A Cursor key is a credential of its own: the engine lands on it, and is not signed out.
    const withKey = engineChoices(sources(runner({ auth: 'no' }), [cursorKey])).find((e) => e.slug === CURSOR)!;
    expect(withKey.unavailable).toBeUndefined();
    expect(withKey.provider).toMatchObject({ slug: 'cursor-api', kind: 'key', label: 'Cursor' });
    // A key needs the runner to run Cursor CLI all the same.
    const keyOnOld = engineProviders(CURSOR, sources(runner({}, []), [cursorKey])).find((c) => c.kind === 'key');
    expect(keyOnOld?.unavailable).toBe('Update runner');
  });

  it('lists the runner’s accounts with what Cursor reported: a reading, Spent, or nothing for no reading', () => {
    const facts = runner({
      accounts: [
        { id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' },
        { id: '5c2e91a0', name: 'Team', home: '/root/.orbit/cursor-accounts/5c2e91a0', auth: 'yes' },
        { id: '7d1e0b42', name: 'Work', home: '/root/.orbit/cursor-accounts/7d1e0b42', auth: 'yes' },
      ],
    });
    const planUsage: PlanUsage = {
      cursor: {
        provider: CURSOR,
        account: 'default',
        planName: 'Free',
        accounts: {
          '5c2e91a0': { provider: CURSOR, planName: 'Pro', includedUsage: { resetsAt: '2099-01-01T00:00:00Z', percentUsed: 34 } },
          '7d1e0b42': { provider: CURSOR, planName: 'Pro', includedUsage: { resetsAt: '2099-01-01T00:00:00Z', limitReachedAt: '2026-10-16T09:00:00Z' } },
        },
      },
    };
    const own = engineProviders(CURSOR, { ...sources(facts), planUsage }).find((c) => c.kind === 'login')!;
    expect(own.accounts?.map((a) => [a.label, a.quota ?? null])).toEqual([
      ['Default', null],
      ['Team', 'Monthly 34%'],
      ['Work', 'Spent'],
    ]);
  });

  it('names a Cursor key’s protocol and brand by Cursor’s own', () => {
    expect(runtimeSummary('cursor')).toBe('Cursor API');
    expect(brandForProvider(CURSOR, 'Cursor CLI').glyphKey).toBe('cursor-api');
  });
});
