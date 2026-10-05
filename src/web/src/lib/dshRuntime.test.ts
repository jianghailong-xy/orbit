import { describe, expect, it } from 'vitest';
import { derivePermissionSemantics, DSH_PERMISSION_MODES, type RunnerEngineHealth } from '@orbit/shared';
import { DSH_CONNECT_HREF, dshRepair, dshRunnerState } from './dshRuntime';
import { providerChoices, runtimeSummary, sameRuntimeChoices } from './sessionProviderChoices';
import { supportsRunnerSlashAssets, slashAssetMatchesProvider } from './slashCommands';
import {
  clampPermissionModeForModel,
  defaultModelForProvider,
  effortOptionsForProvider,
  MODE_OPTIONS,
  modelOptionsForProvider,
  normalizeEffortForProvider,
  permissionModeSupported,
  runtimeForProvider,
  type ConfiguredProvider,
} from './workspaceDefaults';

// A Harness key as GET /providers serves it: runtime dsh, no static models (P1a).
const harness: ConfiguredProvider = {
  slug: 'deepseek-harness',
  label: 'DeepSeek Harness',
  runtime: 'dsh',
  models: [],
  defaultModel: null,
  presetSlug: 'deepseek-harness',
  modelsFromRuntime: true,
};
// The existing DeepSeek preset, which keeps borrowing Claude Code.
const deepseek: ConfiguredProvider = {
  slug: 'deepseek',
  label: 'DeepSeek',
  runtime: 'claude',
  models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
  defaultModel: 'deepseek-v4-pro',
  presetSlug: 'deepseek',
};
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
    expect(dshRepair('DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key for this session')).toBe('needsKey');
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

describe('DeepSeek Harness identity in the pickers', () => {
  it('resolves a Harness key to the dsh runtime and keeps the DeepSeek preset on Claude', () => {
    expect(runtimeForProvider('deepseek-harness', [harness, deepseek])).toBe('dsh');
    expect(runtimeForProvider('dsh', [])).toBe('dsh');
    expect(runtimeForProvider('deepseek', [harness, deepseek])).toBe('claude');
    expect(runtimeSummary('dsh', 'deepseek-harness')).toBe('Runs on DeepSeek Harness');
    expect(runtimeSummary(undefined, 'deepseek')).toBe('Runs on Claude Code');
    expect(runtimeSummary(undefined, 'anthropic')).toBe('Anthropic-compatible');
  });

  it('lists models from the runner catalogue and never falls back to a Claude model', () => {
    expect(modelOptionsForProvider('deepseek-harness', catalog, [harness]).map((o) => o.value)).toEqual([
      token,
      '["deepseek", "deepseek-v4-flash"]',
    ]);
    expect(defaultModelForProvider('deepseek-harness', catalog, [harness])).toBe(token);
    expect(modelOptionsForProvider('deepseek-harness', null, [harness])).toEqual([]);
    expect(defaultModelForProvider('deepseek-harness', null, [harness])).toBe('');
  });

  it("offers the model's own reasoning levels, Default only for an unreported model", () => {
    expect(effortOptionsForProvider('deepseek-harness', token, catalog, [harness])).toEqual([
      { value: '', label: 'Default' },
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ]);
    expect(effortOptionsForProvider('deepseek-harness', '["deepseek", "deepseek-v4-flash"]', catalog, [harness])).toEqual([
      { value: '', label: 'Default' },
    ]);
    expect(normalizeEffortForProvider('deepseek-harness', 'off', token, catalog, [harness])).toBe('off');
    expect(normalizeEffortForProvider('deepseek-harness', 'medium', token, catalog, [harness])).toBe('');
    expect(normalizeEffortForProvider('deepseek-harness', 'max', 'unknown', catalog, [harness])).toBe('');
  });

  it('offers exactly the permission modes the shared table honors, and clamps the rest to Default', () => {
    const offered = MODE_OPTIONS.map((m) => m.value).filter((mode) => permissionModeSupported(mode, 'deepseek-harness', [harness]));
    expect(offered).toEqual(['default', 'auto', 'dontAsk']);
    expect([...offered].sort()).toEqual([...DSH_PERMISSION_MODES].sort());
    for (const mode of MODE_OPTIONS.map((m) => m.value)) {
      expect(permissionModeSupported(mode, 'deepseek-harness', [harness])).toBe(
        derivePermissionSemantics('dsh', mode, token).honored,
      );
      // Every other runtime keeps every mode.
      expect(permissionModeSupported(mode, 'deepseek', [harness, deepseek])).toBe(true);
    }
    expect(clampPermissionModeForModel('plan', token, 'deepseek-harness', [harness], catalog)).toBe('default');
    expect(clampPermissionModeForModel('bypassPermissions', token, 'deepseek-harness', [harness], catalog)).toBe('default');
    expect(clampPermissionModeForModel('acceptEdits', token, 'deepseek-harness', [harness], catalog)).toBe('default');
    expect(clampPermissionModeForModel('auto', token, 'deepseek-harness', [harness], catalog)).toBe('auto');
    expect(clampPermissionModeForModel('dontAsk', token, 'deepseek-harness', [harness], catalog)).toBe('dontAsk');
    expect(clampPermissionModeForModel('plan', 'deepseek-v4-pro', 'deepseek', [deepseek], catalog)).toBe('plan');
  });

  it('withholds runner slash commands from Harness sessions', () => {
    expect(supportsRunnerSlashAssets('dsh')).toBe(false);
    expect(slashAssetMatchesProvider(undefined, 'dsh')).toBe(false);
    expect(slashAssetMatchesProvider('claude', 'dsh')).toBe(false);
  });
});

describe('providerChoices for DeepSeek Harness', () => {
  const choicesOn = (runner: Parameters<typeof dshRunnerState>[0], configured = [harness, deepseek]) =>
    providerChoices(configured, catalog, undefined, runner?.engines ?? null, [], null, undefined, false, runner);

  it('labels both DeepSeek rows by the agent that runs them and offers a ready Harness key', () => {
    const choices = choicesOn(capable([health()]));
    const dsh = choices.find((c) => c.slug === 'deepseek-harness')!;
    expect(dsh).toMatchObject({ label: 'DeepSeek Harness', kind: 'byok', labelDetail: 'Harness', modelLabel: 'DeepSeek V4 Pro' });
    expect(dsh.unavailable).toBeUndefined();
    expect(dsh.glyphKey).toBe('deepseek-harness');
    expect(choices.find((c) => c.slug === 'deepseek')).toMatchObject({ labelDetail: 'Claude Code' });
    expect(choices.some((c) => c.setup)).toBe(false);
  });

  it('keeps an unrunnable Harness key listed with the reason and the Providers row that fixes it', () => {
    for (const [runner, reason] of [
      [{ capabilities: [], engines: [health()] }, 'Update runner'],
      [capable([health({ installed: false, version: undefined })]), 'Not installed'],
      [capable([health({ installed: false, installationError: 'DSH_PLATFORM_UNSUPPORTED: darwin' })]), 'Not supported here'],
      [capable([health({ dsh: { ...health().dsh!, versionCompatible: false } })]), 'Unsupported version'],
    ] as const) {
      const dsh = choicesOn(runner).find((c) => c.slug === 'deepseek-harness')!;
      expect(dsh.unavailable).toBe(reason);
      expect(dsh.fixEngine).toBe('dsh');
    }
    // Only Harness depends on the dsh report: the Claude-borrowing DeepSeek row is unaffected.
    expect(choicesOn({ capabilities: [], engines: [health()] }).find((c) => c.slug === 'deepseek')!.unavailable).toBeUndefined();
  });

  it('offers to connect a key when none is configured on a runner that can run Harness', () => {
    const setup = choicesOn(capable([health()]), [deepseek]).find((c) => c.setup)!;
    expect(setup).toMatchObject({ label: 'DeepSeek Harness', unavailable: 'Add API key', fixHref: DSH_CONNECT_HREF });
    // Not on an old runner (the key could not run there either), and never in a runtime's switch menu.
    expect(choicesOn({ capabilities: [], engines: null }, [deepseek]).some((c) => c.setup)).toBe(false);
    const all = choicesOn(capable([health()]), [deepseek]);
    expect(sameRuntimeChoices('claude', all, [deepseek]).some((c) => c.setup)).toBe(false);
  });

  it('lets a running Harness session move only between Harness keys', () => {
    const second = { ...harness, slug: 'deepseek-harness-2', label: 'Work key' };
    const configured = [harness, second, deepseek];
    const choices = choicesOn(capable([health()]), configured);
    expect(sameRuntimeChoices('deepseek-harness', choices, configured).map((c) => c.slug)).toEqual([
      'deepseek-harness',
      'deepseek-harness-2',
    ]);
  });
});
