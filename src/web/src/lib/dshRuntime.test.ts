import { describe, expect, it } from 'vitest';
import { AgentProvider, derivePermissionSemantics, DSH_PERMISSION_MODES, type RunnerEngineHealth } from '@orbit/shared';
import { DSH_CONNECT_HREF, dshRepair, dshRunnerState } from './dshRuntime';
import { engineChoices, engineProviders, type ChoiceSources } from './sessionProviderChoices';
import { supportsRunnerSlashAssets, slashAssetMatchesEngine } from './slashCommands';
import {
  clampPermissionModeForModel,
  defaultEngineOf,
  defaultModelFor,
  effortOptionsFor,
  MODE_OPTIONS,
  modelOptionsFor,
  normalizeEffortFor,
  permissionModeSupported,
  providerEngines,
  type ConfiguredProvider,
} from './workspaceDefaults';

const { CLAUDE, OPENCODE, DSH } = AgentProvider;

// A row from the retired DeepSeek Harness preset, as GET /providers serves it until the migration folds
// it into a DeepSeek key: runtime dsh, no static models (P1a).
const harness: ConfiguredProvider = {
  slug: 'deepseek-harness',
  label: 'DeepSeek Harness',
  runtime: 'dsh',
  models: [],
  defaultModel: null,
  presetSlug: 'deepseek-harness',
  modelsFromRuntime: true,
  engines: ['dsh', 'claude', 'opencode'],
};
// A DeepSeek key: Claude Code by default, and DeepSeek Harness and OpenCode on the same key.
const deepseek: ConfiguredProvider = {
  slug: 'deepseek',
  label: 'DeepSeek',
  runtime: 'claude',
  models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
  defaultModel: 'deepseek-v4-pro',
  presetSlug: 'deepseek',
  engines: ['claude', 'opencode', 'dsh'],
};
const deepseek2: ConfiguredProvider = { ...deepseek, slug: 'deepseek-2', label: 'DeepSeek 2' };
// Opaque ACP tokens, the shape P1a's catalogue preserves.
const token = '["deepseek", "deepseek-v4-pro"]';
const catalog = {
  claude: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }],
  dsh: [
    { value: token, label: 'DeepSeek V4 Pro', reasoningLevels: ['off', 'low', 'high', 'max'] },
    { value: '["deepseek", "deepseek-v4-flash"]', label: 'DeepSeek V4 Flash' },
  ],
} as never;

const health = (over: Partial<RunnerEngineHealth> = {}): RunnerEngineHealth => ({
  engine: 'dsh',
  installed: true,
  version: '0.2.0-rc.2',
  auth: 'unknown',
  dsh: {
    versionCompatible: true,
    credentialPresent: false,
    modelCatalogReadable: true,
    requestValidation: 'unknown',
    sandboxEnforcement: 'unknown',
  },
  ...over,
});
const capable = (engines?: RunnerEngineHealth[] | null) => ({ capabilities: ['provider:dsh'], engines });

describe('dshRunnerState', () => {
  it('reads an old runner, a missing CLI, an unsupported platform and version, and a ready one', () => {
    expect(dshRunnerState({ capabilities: ['provider:antigravity'], engines: [health()] })).toBe('updateRunner');
    expect(dshRunnerState({ capabilities: undefined })).toBe('updateRunner');
    expect(dshRunnerState(null)).toBe('updateRunner');
    expect(dshRunnerState(capable([health({ installed: false, version: undefined })]))).toBe('notInstalled');
    expect(
      dshRunnerState(capable([health({ installed: false, installationError: 'DSH_PLATFORM_UNSUPPORTED: darwin/arm64' })])),
    ).toBe('unsupportedPlatform');
    expect(dshRunnerState(capable([health({ installed: false, installationError: 'DSH_NODE_UNSUPPORTED: node 22' })]))).toBe(
      'unsupportedPlatform',
    );
    expect(
      dshRunnerState(capable([health({ dsh: { ...health().dsh!, versionCompatible: false } })])),
    ).toBe('unsupportedVersion');
    expect(dshRunnerState(capable([health()]))).toBe('ready');
    // Declared, but no engine report yet: claims nothing, so it does not block.
    expect(dshRunnerState(capable(null))).toBe('ready');
  });
});

describe('dshRepair', () => {
  it('maps the runner codes and key-rejection evidence, and nothing vaguer', () => {
    // The runner's own wording, as an older runner still writes it.
    expect(dshRepair('DSH_CREDENTIAL_MISSING: DeepSeek Harness runs on a DeepSeek API key, and this session has none; connect one in Orbit')).toBe('needsKey');
    expect(dshRepair('dsh session/prompt (-32603): Invalid API key provided')).toBe('invalidKey');
    expect(dshRepair('dsh session/prompt (-32603): authentication_error status 401')).toBe('invalidKey');
    expect(dshRepair('DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first')).toBe(
      'updateRunner',
    );
    expect(dshRepair('DSH_NOT_INSTALLED: DeepSeek Harness 0.2.0-rc.2 is not installed')).toBe('notInstalled');
    expect(dshRepair('DSH_PLATFORM_UNSUPPORTED: windows')).toBe('unsupportedPlatform');
    // A rate limit or server error is not a bad key.
    expect(dshRepair('dsh session/prompt (-32603): rate limit exceeded (429)')).toBeNull();
    expect(dshRepair('Invalid API key')).toBeNull();
    expect(dshRepair(undefined)).toBeNull();
  });
});

describe('dshRepair failure semantics (D2)', () => {
  // What the runner reports for the real DeepSeek 401 (P6), and the same text from an older runner.
  const real = 'dsh session/prompt (-32603): Internal error: turn failed: Authentication Fails, Your api key: ****0000 is invalid (request_id: 64d2f58d-15e2-4744-aafd-d463abb21741) ';

  it('D2 the real DeepSeek 401 wording reads as an invalid key', () => {
    expect(dshRepair(`DSH_CREDENTIAL_INVALID: ${real}`)).toBe('invalidKey');
    expect(dshRepair(real)).toBe('invalidKey');
    expect(dshRepair('dsh session/prompt (-32603): Internal error: turn failed: Your API key: sk-****abcd is invalid')).toBe('invalidKey');
  });

  it('D2 rate limits server errors and dropped connections are not an invalid key', () => {
    for (const message of [
      'dsh session/prompt (-32603): Internal error: turn failed: Rate Limit Reached',
      'dsh session/prompt (-32603): Internal error: turn failed: synthetic-429',
      'dsh session/prompt (-32603): Internal error: turn failed: 503 Service Unavailable',
      'dsh session/prompt (-32603): Internal error: turn failed: Insufficient Balance',
      'dsh session/prompt (-32603): Internal error: turn failed: fetch failed: socket hang up (ECONNRESET)',
      'dsh ACP transport closed: EOF',
    ]) {
      expect(dshRepair(message)).toBeNull();
    }
  });

  it("D2 the runner's status verdict wins over key-like wording", () => {
    expect(
      dshRepair('DSH_REQUEST_FAILED: dsh session/prompt (-32603): Internal error: turn failed: invalid api key? {"error":{"statusCode":503}}'),
    ).toBeNull();
  });
});

describe('DeepSeek Harness in the pickers, by the engine', () => {
  it('runs on every DeepSeek key, a row from the retired preset by default', () => {
    expect(providerEngines('deepseek-harness', [harness, deepseek])).toEqual(['dsh', 'claude', 'opencode']);
    expect(providerEngines('deepseek', [harness, deepseek])).toEqual(['claude', 'opencode', 'dsh']);
    expect(defaultEngineOf('deepseek', [harness, deepseek])).toBe('claude');
    // The legacy built-in `dsh`: DeepSeek Harness on the key its workspace's environment holds.
    expect(providerEngines('dsh', [])).toEqual(['dsh']);
  });

  it('lists models from the runner catalogue on whichever DeepSeek key, and never falls back to a Claude model', () => {
    for (const [slug, configured] of [['deepseek-harness', [harness]], ['deepseek', [deepseek]]] as const) {
      expect(modelOptionsFor(DSH, slug, catalog, [...configured]).map((o) => o.value)).toEqual([token, '["deepseek", "deepseek-v4-flash"]']);
      expect(defaultModelFor(DSH, slug, catalog, [...configured])).toBe(token);
      expect(modelOptionsFor(DSH, slug, null, [...configured])).toEqual([]);
      expect(defaultModelFor(DSH, slug, null, [...configured])).toBe('');
    }
    // The same DeepSeek key on Claude Code lists the key's own models.
    expect(modelOptionsFor(CLAUDE, 'deepseek', catalog, [deepseek]).map((o) => o.value)).toEqual(['deepseek-v4-pro']);
  });

  it("offers the model's own reasoning levels, Default only for an unreported model", () => {
    expect(effortOptionsFor(DSH, 'deepseek-2', token, catalog, [deepseek2])).toEqual([
      { value: '', label: 'Default' },
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ]);
    expect(effortOptionsFor(DSH, 'deepseek-2', '["deepseek", "deepseek-v4-flash"]', catalog, [deepseek2])).toEqual([
      { value: '', label: 'Default' },
    ]);
    expect(normalizeEffortFor(DSH, 'deepseek-2', 'off', token, catalog, [deepseek2])).toBe('off');
    expect(normalizeEffortFor(DSH, 'deepseek-2', 'medium', token, catalog, [deepseek2])).toBe('');
    expect(normalizeEffortFor(DSH, 'deepseek-2', 'max', 'unknown', catalog, [deepseek2])).toBe('');
  });

  it('offers exactly the permission modes the shared table honors, and clamps the rest to Default', () => {
    const offered = MODE_OPTIONS.map((m) => m.value).filter((mode) => permissionModeSupported(mode, DSH));
    expect(offered).toEqual(['default', 'auto', 'dontAsk']);
    expect([...offered].sort()).toEqual([...DSH_PERMISSION_MODES].sort());
    for (const mode of MODE_OPTIONS.map((m) => m.value)) {
      expect(permissionModeSupported(mode, DSH)).toBe(derivePermissionSemantics('dsh', mode, token).honored);
      // Every other engine keeps every mode — the same DeepSeek key on Claude Code included.
      expect(permissionModeSupported(mode, CLAUDE)).toBe(true);
    }
    expect(clampPermissionModeForModel('plan', token, DSH, 'deepseek', [deepseek], catalog)).toBe('default');
    expect(clampPermissionModeForModel('bypassPermissions', token, DSH, 'deepseek', [deepseek], catalog)).toBe('default');
    expect(clampPermissionModeForModel('acceptEdits', token, DSH, 'deepseek', [deepseek], catalog)).toBe('default');
    expect(clampPermissionModeForModel('auto', token, DSH, 'deepseek', [deepseek], catalog)).toBe('auto');
    expect(clampPermissionModeForModel('dontAsk', token, DSH, 'deepseek', [deepseek], catalog)).toBe('dontAsk');
    expect(clampPermissionModeForModel('plan', 'deepseek-v4-pro', CLAUDE, 'deepseek', [deepseek], catalog)).toBe('plan');
  });

  it('withholds runner slash commands from Harness sessions', () => {
    expect(supportsRunnerSlashAssets('dsh')).toBe(false);
    expect(slashAssetMatchesEngine(undefined, 'dsh')).toBe(false);
    expect(slashAssetMatchesEngine('claude', 'dsh')).toBe(false);
  });
});

describe('the engine and credentials of DeepSeek Harness', () => {
  const sourcesOn = (runner: Parameters<typeof dshRunnerState>[0], configured = [harness, deepseek]): ChoiceSources => ({
    configured,
    modelCatalog: catalog,
    engineHealth: runner?.engines ?? null,
    dshRunner: runner,
  });

  it('lists every key it runs on by the key’s own name, ready on a capable runner', () => {
    const rows = engineProviders(DSH, sourcesOn(capable([health()])));
    expect(rows.map((row) => [row.slug, row.label, row.kind])).toEqual([
      ['deepseek-harness', 'DeepSeek Harness', 'key'],
      ['deepseek', 'DeepSeek', 'key'],
    ]);
    expect(rows.every((row) => !row.unavailable && !row.labelDetail)).toBe(true);
    expect(rows[1].modelLabel).toBe('DeepSeek V4 Pro');
    expect(rows[0].glyphKey).toBe('deepseek-harness');
  });

  it('keeps a key listed where Harness cannot run, with the reason and the engine row that fixes it', () => {
    for (const [runner, reason] of [
      [{ capabilities: [], engines: [health()] }, 'Update runner'],
      [capable([health({ installed: false, version: undefined })]), 'Not installed'],
      [capable([health({ installed: false, installationError: 'DSH_PLATFORM_UNSUPPORTED: darwin' })]), 'Not supported here'],
      [capable([health({ dsh: { ...health().dsh!, versionCompatible: false } })]), 'Unsupported version'],
    ] as const) {
      const row = engineProviders(DSH, sourcesOn(runner)).find((c) => c.slug === 'deepseek')!;
      expect(row.unavailable).toBe(reason);
      expect(row.fixEngine).toBe('dsh');
    }
    // Only Harness depends on the dsh report: the same key on Claude Code is unaffected.
    expect(engineProviders(CLAUDE, sourcesOn({ capabilities: [], engines: [health()] })).find((c) => c.slug === 'deepseek')!.unavailable).toBeUndefined();
  });

  it('offers to connect a DeepSeek key when there is none, on a runner that can run Harness', () => {
    const connect = engineChoices(sourcesOn(capable([health()]), [])).find((e) => e.slug === 'dsh')!;
    expect(connect).toMatchObject({ label: 'DeepSeek Harness', provider: null, unavailable: 'Connect a DeepSeek key', fixHref: DSH_CONNECT_HREF });
    expect(DSH_CONNECT_HREF).toBe('/providers/new/deepseek');
    // Not on an old runner (no key could run there either), and never among another engine's credentials.
    expect(engineChoices(sourcesOn({ capabilities: [], engines: null }, [])).some((e) => e.slug === 'dsh')).toBe(false);
    expect(engineProviders(CLAUDE, sourcesOn(capable([health()]), [])).every((row) => row.kind === 'login')).toBe(true);
  });

  it('lets a running Harness session move between every DeepSeek key', () => {
    const rows = engineProviders(DSH, sourcesOn(capable([health()]), [harness, deepseek2, deepseek]));
    expect(rows.map((row) => row.slug)).toEqual(['deepseek-harness', 'deepseek-2', 'deepseek']);
  });

  it('lands on the first DeepSeek key, while the same key under Claude Code is a pick of Claude Code’s', () => {
    const engines = engineChoices(sourcesOn(capable([health()])));
    const dsh = engines.find((e) => e.slug === 'dsh')!;
    expect(dsh).toMatchObject({ label: 'DeepSeek Harness', glyphKey: 'deepseek-harness' });
    expect(dsh.provider?.slug).toBe('deepseek-harness');
    expect(engines.find((e) => e.slug === 'claude')!.provider?.slug).toBe('claude');
    const picked = engineChoices(sourcesOn(capable([health()])), [{ engine: 'claude', provider: 'deepseek' }]);
    expect(picked.find((e) => e.slug === 'claude')!.provider?.slug).toBe('deepseek');
    expect(picked.find((e) => e.slug === 'dsh')!.provider?.slug).toBe('deepseek-harness');
    expect(engines.find((e) => e.slug === OPENCODE)!.providers.map((row) => row.slug)).toEqual(['opencode', 'deepseek-harness', 'deepseek']);
  });
});
