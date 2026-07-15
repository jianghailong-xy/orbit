import type { RunnerModelCatalog } from '@orbit/shared';

export const PROVIDER_OPTIONS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
];

type ModelOption = { value: string; label: string };

/**
 * A control-plane–configured provider (from GET /api/providers): a custom identity (its own
 * slug/label + model list) that borrows a built-in runtime. Its slug lands in an agent/session's
 * `provider` field just like a built-in, so it's merged into the pickers alongside claude/codex.
 */
export interface ConfiguredProvider {
  slug: string;
  label: string;
  runtime: string;
  models: { value: string; label: string; contextWindow?: number }[];
  defaultModel?: string | null;
}

/** Resolve a configured provider by slug — a built-in slug (claude/codex) never matches. */
const configuredProvider = (
  provider?: string | null,
  configured?: ConfiguredProvider[] | null,
): ConfiguredProvider | undefined =>
  provider ? (configured ?? []).find((p) => p.slug === provider) : undefined;

/** Provider dropdown options: built-in (claude/codex) followed by the configured providers. */
export const mergedProviderOptions = (
  configured?: ConfiguredProvider[] | null,
): { value: string; label: string }[] => [
  ...PROVIDER_OPTIONS,
  ...(configured ?? []).map((p) => ({ value: p.slug, label: p.label })),
];

// Model options shared across the app. `value` is the local runtime's model id;
// `label` is the friendly display name shown in every picker.
export const CLAUDE_MODEL_OPTIONS = [
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export const CODEX_MODEL_OPTIONS = [
  { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
];

export const MODEL_OPTIONS_BY_PROVIDER: Record<string, ModelOption[]> = {
  claude: CLAUDE_MODEL_OPTIONS,
  codex: CODEX_MODEL_OPTIONS,
};

export const MODEL_OPTIONS = [...CLAUDE_MODEL_OPTIONS, ...CODEX_MODEL_OPTIONS];

// Per-model context-window size (max input tokens), for the composer's context-usage
// gauge. Claude values are the models' true windows (Opus 4.8 / Sonnet 5 / Fable 5 = 1M,
// Haiku 4.5 = 200K); Codex is a best-effort default. Keep in sync with Swift's
// AgentDefaults.contextWindow(for:).
export const CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
  'claude-fable-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'gpt-5.6-sol': 372_000,
  'gpt-5.6-terra': 372_000,
  'gpt-5.6-luna': 372_000,
  'gpt-5.5': 400_000,
  'gpt-5.4': 400_000,
  'gpt-5.4-mini': 400_000,
};
export const DEFAULT_CONTEXT_WINDOW = 200_000;
const catalogOptionsForProvider = (
  provider?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
): ModelOption[] | undefined => {
  const key = (provider ?? 'claude') as keyof RunnerModelCatalog;
  const rows = modelCatalog?.[key];
  const options = rows
    ?.filter((m) => m.value && m.label)
    .map((m) => ({ value: m.value, label: m.label }));
  return options?.length ? options : undefined;
};

export const contextWindowFor = (
  model?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
): number => {
  if (model && configured) {
    for (const p of configured) {
      const found = p.models.find((m) => m.value === model && typeof m.contextWindow === 'number');
      if (found?.contextWindow) return found.contextWindow;
    }
  }
  if (model && CONTEXT_WINDOW_BY_MODEL[model]) return CONTEXT_WINDOW_BY_MODEL[model];
  if (model && modelCatalog) {
    for (const rows of Object.values(modelCatalog)) {
      const found = rows?.find((m) => m.value === model && typeof m.contextWindow === 'number');
      if (found?.contextWindow) return found.contextWindow;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
};

export const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  claude: 'claude-opus-4-8',
  codex: 'gpt-5.6-sol',
};

export const modelOptionsForProvider = (
  provider?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
): ModelOption[] => {
  // A configured provider carries its own model list (from the API), which wins for its slug.
  const custom = configuredProvider(provider, configured);
  if (custom) {
    const options = custom.models
      .filter((m) => m.value && m.label)
      .map((m) => ({ value: m.value, label: m.label }));
    if (options.length) return options;
  }
  return (
    catalogOptionsForProvider(provider, modelCatalog) ??
    MODEL_OPTIONS_BY_PROVIDER[provider ?? 'claude'] ??
    CLAUDE_MODEL_OPTIONS
  );
};

export const defaultModelForProvider = (
  provider?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
): string =>
  configuredProvider(provider, configured)?.defaultModel ||
  modelOptionsForProvider(provider, modelCatalog, configured)[0]?.value ||
  DEFAULT_MODEL_BY_PROVIDER[provider ?? 'claude'] ||
  DEFAULT_MODEL;

// Reasoning effort is provider-specific. Claude supports "max"; Codex's
// Responses API effort values top out at "xhigh", with "minimal" also available.
export const CLAUDE_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
  { value: 'max', label: 'Max' },
];

export const CODEX_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
];

export const effortOptionsForProvider = (provider?: string | null) =>
  provider === 'codex' ? CODEX_EFFORT_OPTIONS : CLAUDE_EFFORT_OPTIONS;

export const normalizeEffortForProvider = (provider: string | null | undefined, effort: string): string =>
  provider === 'codex' && effort === 'max' ? 'xhigh' : effort;

// The permission mode a new session of the agent starts in.
export const MODE_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan' },
  { value: 'acceptEdits', label: 'Accept Edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'dontAsk', label: "Don't Ask" },
  { value: 'bypassPermissions', label: 'Bypass' },
];

// Auto mode needs a recent model; claude rejects --permission-mode auto on Haiku.
export const AUTO_CAPABLE_MODELS = new Set(['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5']);
export const supportsAuto = (m: string): boolean => AUTO_CAPABLE_MODELS.has(m);

// App defaults used when the user has set no preference of their own.
export const DEFAULT_MODEL = 'claude-opus-4-8';
export const DEFAULT_PERMISSION_MODE = 'auto';
