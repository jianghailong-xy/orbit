import {
  AgentProvider,
  type RunnerModelCatalog,
  type RuntimeDefaultModels,
} from '@orbit/shared';

export const PROVIDER_OPTIONS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'kimi', label: 'Kimi' },
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

/** Resolve a configured provider by slug — built-in slugs never match. */
const configuredProvider = (
  provider?: string | null,
  configured?: ConfiguredProvider[] | null,
): ConfiguredProvider | undefined =>
  provider ? (configured ?? []).find((p) => p.slug === provider) : undefined;

/** Resolve a persisted provider identity to the built-in runtime that actually executes it. */
export const runtimeForProvider = (
  provider?: string | null,
  configured?: ConfiguredProvider[] | null,
): AgentProvider => {
  const custom = configuredProvider(provider, configured);
  // Configured providers currently borrow only Claude or Codex; invalid/legacy runtime values use
  // the same safe Claude fallback as the backend. First-class Kimi is the literal built-in slug.
  if (custom) {
    return custom.runtime === AgentProvider.CODEX ? AgentProvider.CODEX : AgentProvider.CLAUDE;
  }
  const value = provider;
  if (value === AgentProvider.CODEX) return AgentProvider.CODEX;
  if (value === AgentProvider.KIMI) return AgentProvider.KIMI;
  return AgentProvider.CLAUDE;
};

/** Whether the client can safely derive model capabilities for a persisted provider identity.
 * Built-ins are always known; a custom/removed slug is known only after the provider request has
 * completed successfully (an authoritative empty list then means the backend's Claude fallback). */
export const providerIdentityResolved = (
  provider?: string | null,
  configuredProvidersLoaded = false,
): boolean =>
  !provider ||
  provider === AgentProvider.CLAUDE ||
  provider === AgentProvider.CODEX ||
  provider === AgentProvider.KIMI ||
  configuredProvidersLoaded;

/** Provider dropdown options: built-in runtimes followed by the configured providers. */
export const mergedProviderOptions = (
  configured?: ConfiguredProvider[] | null,
): { value: string; label: string }[] => [
  ...PROVIDER_OPTIONS,
  ...(configured ?? []).map((p) => ({ value: p.slug, label: p.label })),
];

// Model options are sourced exclusively from the runner's live model catalog (Codex:
// `codex debug models`; Claude: `claude -p "/model <alias>"`). There are no static
// fallback lists — when no runner catalog is available the picker is empty.
// Mirrors Claude Code's `/model` picker (Opus 5 default / Fable 5 / Sonnet 5 / Haiku 4.5).
// Previous models (Opus 4.8, …) stay reachable by pinning the id directly and render as
// their raw id, same as any other non-current model.
// Kimi is the one exception: the runner catalog only reports claude/codex, and managed Kimi
// runs a single fixed model, so its lone option stays static.
export const KIMI_MODEL_OPTIONS = [
  { value: 'kimi-code/kimi-for-coding', label: 'Kimi for Coding' },
];

// Per-model context-window size (max input tokens), for the composer's context-usage gauge.
// Claude only: these are the models' true windows (Opus 5 / Fable 5 / Sonnet 5 = 1M,
// Haiku 4.5 = 200K), and the Claude CLI has no way to report them, so they have to live here.
// Codex models are absent on purpose — the runner catalog carries their real `context_window`
// from `codex debug models`, so it stays right as Codex ships new models. Keep in sync with
// Swift's knownContextWindow(for:).
export const CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
  'claude-opus-5': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'kimi-code/kimi-for-coding': 262_144,
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
  claude: 'claude-opus-5',
  codex: 'gpt-5.6-sol',
  kimi: 'kimi-code/kimi-for-coding',
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
    // An empty custom model space must not fall through to Claude's catalog. The composer inserts
    // the provider's effective fallback as its sole row, keeping a custom Codex picker out of the
    // Claude model namespace.
    return options;
  }
  return (
    catalogOptionsForProvider(provider, modelCatalog) ??
    (provider === AgentProvider.KIMI ? KIMI_MODEL_OPTIONS : [])
  );
};

export const defaultModelForProvider = (
  provider?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
): string => {
  const custom = configuredProvider(provider, configured);
  // A configured provider owns a separate model space even though it borrows a built-in runtime
  // for execution. Never let the underlying Runtime's Claude/Codex default leak into that space.
  if (custom) {
    const customRuntime =
      custom.runtime === AgentProvider.CODEX ? AgentProvider.CODEX : AgentProvider.CLAUDE;
    return (
      custom.defaultModel ||
      custom.models.find((model) => model.value && model.label)?.value ||
      DEFAULT_MODEL_BY_PROVIDER[customRuntime] ||
      DEFAULT_MODEL
    );
  }
  // A removed/disabled configured-provider slug is executed by the backend's historical Claude
  // fallback. Normalize it here too, otherwise the composer can explicitly persist a static
  // model while silently skipping the runner's reported Claude default.
  const runtime = runtimeForProvider(provider, configured);
  return (
    runtimeDefaultModels?.[runtime] ||
    modelOptionsForProvider(runtime, modelCatalog, configured)[0]?.value ||
    DEFAULT_MODEL_BY_PROVIDER[runtime] ||
    DEFAULT_MODEL
  );
};

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

export const KIMI_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

export const effortOptionsForProvider = (provider?: string | null) =>
  provider === 'codex'
    ? CODEX_EFFORT_OPTIONS
    : provider === 'kimi'
      ? KIMI_EFFORT_OPTIONS
      : CLAUDE_EFFORT_OPTIONS;

export const normalizeEffortForProvider = (provider: string | null | undefined, effort: string): string => {
  if (provider === 'codex' && effort === 'max') return 'xhigh';
  if (provider === 'kimi') {
    if (effort === 'minimal') return 'low';
    if (effort === 'medium') return 'high';
    if (effort === 'xhigh') return 'max';
  }
  return effort;
};

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
export const AUTO_CAPABLE_MODELS = new Set([
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-5',
  'kimi-code/kimi-for-coding',
]);
export const supportsAuto = (
  model: string,
  provider?: string | null,
  configured?: ConfiguredProvider[] | null,
): boolean => {
  const runtime = runtimeForProvider(provider, configured);
  // Kimi exposes Auto as a runtime-wide mode, so locally configured model aliases support it too.
  // Codex has no Auto mode; Claude exposes it only for the known capable model families.
  if (runtime === 'kimi') return true;
  if (runtime === 'codex') return false;
  return AUTO_CAPABLE_MODELS.has(model);
};
export const clampPermissionModeForModel = (
  mode: string,
  model: string,
  provider?: string | null,
  configured?: ConfiguredProvider[] | null,
): string => (mode === 'auto' && !supportsAuto(model, provider, configured) ? 'default' : mode);

// App defaults used when the user has set no preference of their own.
export const DEFAULT_MODEL = 'claude-opus-5';
export const DEFAULT_PERMISSION_MODE = 'auto';
