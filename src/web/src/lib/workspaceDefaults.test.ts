import { describe, expect, it } from 'vitest';
import type { RunnerModelCatalog } from '@orbit/shared';
import {
  clampPermissionModeForModel,
  CODEX_EFFORT_OPTIONS,
  contextWindowFor,
  defaultModelForProvider,
  effectiveSessionEffort,
  effectiveSessionModel,
  effortOptionsForProvider,
  KIMI_MODEL_OPTIONS,
  livePinnedModel,
  mergedProviderOptions,
  modelOptionsForProvider,
  newSessionEffortForProvider,
  normalizeEffortForProvider,
  OPENCODE_EFFORT_OPTIONS,
  providerIdentityResolved,
  PROVIDER_OPTIONS,
  supportsAuto,
  type ConfiguredProvider,
} from './workspaceDefaults';

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
    // Claude is the only runtime that gates Auto per model; built-in Codex has it for any model.
    expect(supportsAuto('gpt-5.6-sol', 'codex')).toBe(true);
  });

  it('clamps Auto when the effective Runtime default cannot run it', () => {
    expect(clampPermissionModeForModel('auto', 'claude-haiku-4-5', 'claude')).toBe('default');
    expect(clampPermissionModeForModel('auto', 'claude-opus-5', 'claude')).toBe('auto');
    expect(clampPermissionModeForModel('plan', 'claude-haiku-4-5', 'claude')).toBe('plan');
  });
});

describe('Codex model efforts', () => {
  const catalog: RunnerModelCatalog = {
    codex: [
      {
        value: 'gpt-5.6-sol',
        label: 'GPT-5.6-Sol',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
    ],
  };

  it('uses the selected model catalog, including max and Ultra', () => {
    expect(effortOptionsForProvider('codex', 'gpt-5.6-sol', catalog)).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'xHigh' },
      { value: 'max', label: 'Max' },
      { value: 'ultra', label: 'Ultra' },
    ]);
    expect(normalizeEffortForProvider('codex', 'ultra', 'gpt-5.6-sol', catalog)).toBe('ultra');
    expect(normalizeEffortForProvider('codex', 'max', 'gpt-5.6-sol', catalog)).toBe('max');
    expect(normalizeEffortForProvider('codex', 'minimal', 'gpt-5.6-sol', catalog)).toBe('');
  });

  it('keeps a closed fallback vocabulary when no catalog row is available', () => {
    expect(effortOptionsForProvider('codex')).toEqual(CODEX_EFFORT_OPTIONS);
    expect(normalizeEffortForProvider('codex', 'ultra')).toBe('ultra');
    expect(normalizeEffortForProvider('codex', 'project-custom')).toBe('');
  });

  it('keeps the account last-picked Ultra over a stale workspace Max', () => {
    expect(
      newSessionEffortForProvider('codex', 'ultra', 'max', 'gpt-5.6-sol', catalog),
    ).toBe('ultra');
    expect(newSessionEffortForProvider('codex', '', 'max', 'gpt-5.6-sol', catalog)).toBe('');
    expect(
      newSessionEffortForProvider('codex', undefined, 'max', 'gpt-5.6-sol', catalog),
    ).toBe('max');
  });
});

describe('Kimi runtime defaults', () => {
  // What `kimi provider list --json` reports on a signed-in runner: the two K2.7 aliases
  // declare no thinking levels at all, while K3 declares low/high/max.
  const kimiCatalog = {
    kimi: [
      { value: 'kimi-code/kimi-for-coding', label: 'K2.7 Coding', contextWindow: 262_144 },
      { value: 'kimi-code/k3', label: 'K3', contextWindow: 1_048_576,
        reasoningLevels: ['low', 'high', 'max'] },
    ],
  };

  it('falls back to the managed Kimi coding model when no runner catalog is available', () => {
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

  it('lists every model the runner reports, with its own context window', () => {
    expect(modelOptionsForProvider('kimi', kimiCatalog)).toEqual([
      { value: 'kimi-code/kimi-for-coding', label: 'K2.7 Coding' },
      { value: 'kimi-code/k3', label: 'K3' },
    ]);
    expect(contextWindowFor('kimi-code/k3', kimiCatalog)).toBe(1_048_576);
  });

  it('offers Kimi efforts without Codex-only minimal when the model is unknown', () => {
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

  it("offers each Kimi model only the thinking levels it declares", () => {
    // K2.7 Coding rejects every level with invalid_params, so Default is the whole picker.
    expect(effortOptionsForProvider('kimi', 'kimi-code/kimi-for-coding', kimiCatalog)).toEqual([
      { value: '', label: 'Default' },
    ]);
    expect(effortOptionsForProvider('kimi', 'kimi-code/k3', kimiCatalog)).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ]);

    expect(normalizeEffortForProvider('kimi', 'max', 'kimi-code/kimi-for-coding', kimiCatalog))
      .toBe('');
    expect(normalizeEffortForProvider('kimi', 'max', 'kimi-code/k3', kimiCatalog)).toBe('max');
    // Vocabulary mapping still runs before the model's own list is consulted.
    expect(normalizeEffortForProvider('kimi', 'xhigh', 'kimi-code/k3', kimiCatalog)).toBe('max');
    expect(normalizeEffortForProvider('kimi', 'medium', 'kimi-code/k3', kimiCatalog)).toBe('high');
    // A model the catalog does not report (KIMI_MODEL_* alias) keeps its value.
    expect(normalizeEffortForProvider('kimi', 'max', 'local-kimi-alias', kimiCatalog)).toBe('max');
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

  it('reads Auto availability from the runtime a configured provider borrows', () => {
    const configured: ConfiguredProvider[] = [
      { slug: 'moonshot', label: 'Kimi (Moonshot)', runtime: 'kimi', models: [] },
      { slug: 'local-codex', label: 'Local Codex', runtime: 'codex', models: [] },
      { slug: 'deepseek', label: 'DeepSeek', runtime: 'claude', models: [] },
      { slug: 'local-legacy', label: 'Legacy', runtime: 'nonsense', models: [] },
    ];

    // Kimi's Auto is a runtime-wide mode, so it holds for this vendor's model ids too.
    expect(supportsAuto('kimi-k2.7-code', 'moonshot', configured)).toBe(true);
    // So is Codex's — `on-request` is its name for letting the model decide when to ask.
    expect(supportsAuto('gpt-5.6-sol', 'local-codex', configured)).toBe(true);
    // A configured provider on the Claude runtime owns its model space: the static Claude
    // allow-list can't cover vendor ids (e.g. DeepSeek), so the CLI decides for itself.
    expect(supportsAuto('deepseek-v4', 'deepseek', configured)).toBe(true);
    // An unreadable runtime keeps the backend's Claude fallback — but Auto still follows the
    // configured-provider rule, not the Claude model allow-list.
    expect(supportsAuto('claude-opus-5', 'local-legacy', configured)).toBe(true);
    expect(supportsAuto('some-alias', 'local-legacy', configured)).toBe(true);
  });

  it('does not leak Claude picker rows into an empty custom model space', () => {
    const configured: ConfiguredProvider[] = [
      { slug: 'custom-codex', label: 'Custom Codex', runtime: 'codex', models: [] },
    ];

    expect(modelOptionsForProvider('custom-codex', null, configured)).toEqual([]);
    expect(defaultModelForProvider('custom-codex', null, configured)).toBe('gpt-5.6-sol');
  });
});

describe('Retired models', () => {
  const catalog: RunnerModelCatalog = {
    claude: [
      { value: 'claude-opus-6', label: 'Opus 6' },
      { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    ],
  };
  const byok: ConfiguredProvider[] = [
    {
      slug: 'anthropic',
      label: 'Anthropic (Claude)',
      runtime: 'claude',
      models: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }],
      defaultModel: 'claude-opus-5',
      modelsFromRuntime: true,
    },
    {
      slug: 'deepseek',
      label: 'DeepSeek',
      runtime: 'claude',
      models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
      defaultModel: 'deepseek-v4-pro',
    },
  ];

  it('drops a pin the runtime no longer offers, on the engine and on its own vendor', () => {
    expect(livePinnedModel('claude-opus-5', 'claude', catalog)).toBeUndefined();
    expect(livePinnedModel('claude-opus-6', 'claude', catalog)).toBe('claude-opus-6');
    // A BYOK vendor on the CLI's own endpoint is judged against the same catalog.
    expect(livePinnedModel('claude-opus-5', 'anthropic', catalog, byok)).toBeUndefined();
  });

  it('leaves alone every pin the catalog cannot speak for', () => {
    // No catalog reported → nothing can be retired.
    expect(livePinnedModel('claude-opus-5', 'claude', undefined)).toBe('claude-opus-5');
    expect(livePinnedModel('claude-opus-5', 'claude', {})).toBe('claude-opus-5');
    // The Runtime's own reported default (an alias, a gateway id) is current by definition.
    expect(livePinnedModel('opus', 'claude', catalog, undefined, { claude: 'opus' })).toBe('opus');
    // A third-party vendor keeps its own list; the runner's Claude probe says nothing about it.
    expect(livePinnedModel('deepseek-v3', 'deepseek', catalog, byok)).toBe('deepseek-v3');
    // OpenCode owns model selection.
    expect(livePinnedModel('anthropic/claude-sonnet-4', 'opencode', catalog)).toBe(
      'anthropic/claude-sonnet-4',
    );
    // A blank model is OpenCode's "you pick" sentinel, not a stale id.
    expect(livePinnedModel('', 'opencode', catalog)).toBe('');
  });

  it('falls through a retired session pin AND a retired workspace pin to the current default', () => {
    // The reported symptom: session and workspace both left on last generation's Opus.
    expect(
      effectiveSessionModel('claude', 'claude-opus-5', 'claude-opus-5', catalog, undefined, {}),
    ).toBe('claude-opus-6');
    // A live workspace pin still wins over the provider default.
    expect(
      effectiveSessionModel('claude', 'claude-opus-5', 'claude-sonnet-5', catalog, undefined, {}),
    ).toBe('claude-sonnet-5');
  });
});

describe('OpenCode defaults', () => {
  const catalog: RunnerModelCatalog = {
    opencode: [
      {
        value: 'anthropic/claude-sonnet-4',
        label: 'Claude Sonnet 4',
        contextWindow: 200_000,
        reasoningLevels: ['low', 'high', 'ultra'],
      },
    ],
  };

  it('is a distinct runtime whose empty default never falls back to Claude', () => {
    expect(PROVIDER_OPTIONS).toContainEqual({
      value: 'opencode',
      label: 'OpenCode',
    });
    expect(defaultModelForProvider('opencode', catalog)).toBe('');
    expect(modelOptionsForProvider('opencode')).toEqual([{ value: '', label: 'Managed by OpenCode' }]);
    expect(modelOptionsForProvider('opencode', catalog)).toEqual([
      { value: '', label: 'Managed by OpenCode' },
      { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
    ]);
    expect(supportsAuto('', 'opencode')).toBe(true);
    expect(supportsAuto('anthropic/claude-sonnet-4', 'opencode')).toBe(true);
  });

  it('resolves a null session model through its workspace while preserving an explicit empty value', () => {
    expect(effectiveSessionModel('opencode', null, 'anthropic/claude-sonnet-4', catalog)).toBe(
      'anthropic/claude-sonnet-4',
    );
    expect(effectiveSessionModel('opencode', '', 'anthropic/claude-sonnet-4', catalog)).toBe('');
  });

  it('resolves a null session effort through its workspace while preserving an explicit empty value', () => {
    expect(effectiveSessionEffort(null, 'ultra')).toBe('ultra');
    expect(effectiveSessionEffort('', 'ultra')).toBe('');
  });

  it('uses the selected catalog model reasoning variants and rejects stale values', () => {
    expect(effortOptionsForProvider('opencode', 'anthropic/claude-sonnet-4', catalog)).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'ultra', label: 'Ultra' },
    ]);
    expect(normalizeEffortForProvider('opencode', 'ultra', 'anthropic/claude-sonnet-4', catalog)).toBe('ultra');
    expect(normalizeEffortForProvider('opencode', 'max', 'anthropic/claude-sonnet-4', catalog)).toBe('');
  });

  it('offers every runner-supported fallback effort when a catalog model is unavailable', () => {
    expect(effortOptionsForProvider('opencode', '', catalog)).toEqual(OPENCODE_EFFORT_OPTIONS);
    expect(normalizeEffortForProvider('opencode', 'max', '', catalog)).toBe('max');
    expect(normalizeEffortForProvider('opencode', 'project-custom', 'project/local-model', catalog)).toBe(
      'project-custom',
    );
  });

  it('treats an exact model with no variants as Default-only', () => {
    const noVariants: RunnerModelCatalog = {
      opencode: [
        {
          value: 'local/no-variants',
          label: 'No variants',
          reasoningLevels: [],
        },
      ],
    };
    expect(effortOptionsForProvider('opencode', 'local/no-variants', noVariants)).toEqual([
      { value: '', label: 'Default' },
    ]);
    expect(normalizeEffortForProvider('opencode', 'high', 'local/no-variants', noVariants)).toBe('');
  });

  it('does not leak an unknown dynamic OpenCode variant into another runtime', () => {
    expect(normalizeEffortForProvider('claude', 'ultra', 'claude-opus-5', catalog)).toBe('');
    expect(normalizeEffortForProvider('codex', 'project-custom', 'gpt-5.6-sol', catalog)).toBe('');
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

  // "I don't know" is an answer the gauge can render (it shows the token count). A default was
  // not: 200k under a 1M model is the bug this whole chain was rebuilt around.
  it('says nothing rather than defaulting when no source knows the window', () => {
    expect(contextWindowFor('gpt-5.5', null)).toBeUndefined();
    expect(contextWindowFor(null, null)).toBeUndefined();
  });

  it('uses runner catalog windows for models unknown to the built-in table', () => {
    const catalog: RunnerModelCatalog = {
      codex: [{ value: 'gpt-new', label: 'GPT New', contextWindow: 512_000 }],
    };

    expect(contextWindowFor('gpt-new', catalog)).toBe(512_000);
  });

  it('uses a configured provider row for a vendor the runner cannot probe', () => {
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

  // The runner probes the CLI that will actually run the model; a provider row is a number
  // someone typed into the control plane. When they disagree, the measurement wins — the
  // inverse of this ordering is exactly how a stale 200k preset shadowed a 1M model.
  it('prefers the runner probe over a configured row that disagrees', () => {
    const catalog: RunnerModelCatalog = {
      claude: [{ value: 'claude-opus-5', label: 'Opus 5', contextWindow: 1_000_000 }],
    };
    const configured: ConfiguredProvider[] = [
      {
        slug: 'anthropic',
        label: 'Anthropic (Claude)',
        runtime: 'claude',
        models: [{ value: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 200_000 }],
      },
    ];

    expect(contextWindowFor('claude-opus-5', catalog, configured)).toBe(1_000_000);
  });

  // A provider row describes its own sessions. Left unscoped, any configured vendor could define
  // the window for a session it has nothing to do with, just by listing the same model id.
  it('only reads the configured row belonging to this session', () => {
    const configured: ConfiguredProvider[] = [
      {
        slug: 'other-gateway',
        label: 'Other Gateway',
        runtime: 'claude',
        models: [{ value: 'shared-model', label: 'Shared', contextWindow: 128_000 }],
      },
      {
        slug: 'mine',
        label: 'Mine',
        runtime: 'claude',
        models: [{ value: 'shared-model', label: 'Shared', contextWindow: 512_000 }],
      },
    ];

    expect(contextWindowFor('shared-model', null, configured, 'mine')).toBe(512_000);
    expect(contextWindowFor('shared-model', null, configured, 'unconfigured')).toBeUndefined();
  });
});
