// The official vendor catalogue. Connecting a provider picks one of these: the endpoint and the
// model list come from here, so the user only enters an API key. A configured provider keeps a
// link back to its preset (ModelProvider.presetSlug), and the server resolves that row's models
// and default model from this file on every read — which is what makes an entry added here reach
// providers that were configured months ago. Shared so the apiserver (the resolver) and the web
// form (the gallery) can never disagree; the native clients read the resolved rows off the API.
//
// Endpoints and model ids verified against vendor docs 2026-07. `brand`/`keyUrl` are for the web
// gallery only — they're here so adding a vendor stays a single-file edit.
//
// The model lists below are a floor, not the whole truth: a vendor the runtime CLI speaks to
// natively takes its list from that CLI (modelsFromRuntime), and every third-party vendor refreshes
// its own from models.dev (catalog). Both mean a model that ships after this build still reaches
// the pickers; what's written here is what a deployment falls back to.
export interface ProviderPresetModel {
  value: string;
  label: string;
  contextWindow?: number;
}

/**
 * Where a third-party vendor's model list refreshes itself from, so it stops going stale between
 * Orbit releases: models.dev (https://models.dev/api.json), a continuously updated third-party
 * mapping of provider → models that carries the id, display name and context window of each.
 *
 * The apiserver refreshes from it on boot and every few hours, and merges what it finds *over* the
 * preset's own `models` — which stay the floor: a shipped model is never dropped by a refresh, and
 * is all there is until one succeeds (or on a deployment that can't reach models.dev).
 */
export interface ProviderCatalogSource {
  /** This vendor's provider id in that catalogue, e.g. `moonshotai` for Kimi. */
  source: string;
  /** Which of its ids to keep — a vendor's full catalogue also carries translation, embedding and
   *  image models that a coding agent can't drive. */
  match: RegExp;
}

/** Brand mark for the vendor tile: a monogram over a two-stop gradient. */
export interface ProviderBrand {
  mono: string;
  from: string;
  to: string;
}

export interface ProviderPreset {
  slug: string;
  label: string;
  baseUrl: string;
  models: ProviderPresetModel[];
  defaultModel: string;
  /**
   * Runtime the provider borrows: `claude` for Anthropic-compatible endpoints (default),
   * `codex` for endpoints that serve the OpenAI Responses API (OpenAI itself) — codex has no other
   * dialect since it dropped Chat Completions in February 2026 — `kimi` for Moonshot's own API,
   * which the Kimi CLI speaks natively, so a Kimi key runs on Kimi, and `antigravity` for Google's
   * Gemini API, which the Antigravity CLI (agy) speaks natively, so a Gemini key runs on agy.
   * `dsh` explicitly selects DeepSeek Harness; the existing `deepseek` preset still borrows Claude.
   */
  runtime?: 'claude' | 'codex' | 'kimi' | 'antigravity' | 'dsh';
  /**
   * True when this vendor's endpoint IS the runtime CLI's own — Anthropic for `claude`, OpenAI
   * for `codex`, Gemini for `antigravity`. The runner probes those CLIs for their live model list
   * (see the runner's claude_models.go / codex_models.go / antigravity_models.go), so the picker
   * follows the installed CLI and nobody has to maintain a list that goes stale the day a model
   * ships. `models` below stays as the fallback for a runner whose probe hasn't landed yet, but it
   * is not editable in the UI. DeepSeek Harness has no static fallback: its opaque ACP values
   * and unknown context windows must come from the runtime.
   *
   * A third-party Anthropic-compatible endpoint (DeepSeek, Moonshot, GLM…) is NOT this: the
   * runner's probe reports what its own CLI offers, which says nothing about what that vendor
   * serves. Those keep a maintained list.
   */
  modelsFromRuntime?: boolean;
  /**
   * Keeps a maintained list current on its own: the vendor's entry in the models.dev catalogue.
   * Set on every third-party vendor — they are exactly the ones the runner's CLI probe can say
   * nothing about, so without this their list only changes when somebody edits this file.
   */
  catalog?: ProviderCatalogSource;
  /** Caveat shown under the Base URL (e.g. regional endpoint variants). */
  note?: string;
  /** Logo tile shown in the provider gallery and rows. */
  brand: ProviderBrand;
  /** Vendor console where the user mints an API key (rendered as a "Get your API key" link). */
  keyUrl?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    slug: 'anthropic',
    label: 'Anthropic (Claude)',
    runtime: 'claude',
    baseUrl: 'https://api.anthropic.com',
    // Fallback only (modelsFromRuntime below): the runner's probe of the installed CLI leads.
    // It still has to name the current generation — this is what a runner with no catalogue yet
    // dispatches with, and DEFAULT_MODEL_BY_PROVIDER already puts the built-in engine on Opus 5.
    // The windows are not fallback-only, though: the context gauge reads a configured provider's
    // row ahead of its own table, so a wrong number here is what every Claude session displays.
    // Keep in sync with web's CONTEXT_WINDOW_BY_MODEL and Swift's knownContextWindow(for:).
    models: [
      { value: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 1_000_000 },
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: 1_000_000 },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', contextWindow: 200_000 },
    ],
    defaultModel: 'claude-opus-5',
    modelsFromRuntime: true,
    brand: { mono: 'A', from: '#d97757', to: '#c15f3c' },
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    slug: 'openai',
    // Named for the CLI that drives it, matching "Anthropic (Claude)": what a user picks here is
    // which coding agent runs, and Codex is the one this vendor speaks to. The vendor keeps the
    // lead because the key, the billing and the console are all OpenAI's.
    label: 'OpenAI (Codex)',
    runtime: 'codex',
    baseUrl: 'https://api.openai.com/v1',
    // Without this the generic hint reads "OpenAI (Codex)'s OpenAI-compatible endpoint."
    note: "OpenAI's own API — the endpoint the Codex CLI talks to by default.",
    models: [
      { value: 'gpt-5.1', label: 'GPT-5.1' },
      { value: 'gpt-5.1-mini', label: 'GPT-5.1 mini' },
    ],
    defaultModel: 'gpt-5.1',
    modelsFromRuntime: true,
    brand: { mono: 'O', from: '#4b5158', to: '#1f2226' },
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    // `antigravity` is the built-in engine's slug, which this borrows: picking Gemini runs the
    // Antigravity CLI (agy) either way, on this key instead of one set on the runner. agy is given
    // the key and this endpoint as GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL and appends the
    // /v1beta/models/… path itself, so the base URL is the bare host.
    slug: 'gemini',
    label: 'Gemini',
    runtime: 'antigravity',
    baseUrl: 'https://generativelanguage.googleapis.com',
    // Fallback only (modelsFromRuntime below): the runner reports what `agy models` lists, one row
    // per model with its thinking levels folded out of the slug (`gemini-3.8-flash-high`), and
    // these are those rows as agy 1.2.16 lists them. agy refuses a model it doesn't list, so a
    // Gemini API id that agy doesn't know (gemini-2.5-pro) can't be offered here, and no models.dev
    // refresh is either. The default is the catalogue's first row, which is what a model-less
    // session runs once a runner has reported.
    models: [
      { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_048_576 },
      { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', contextWindow: 1_048_576 },
      { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', contextWindow: 1_048_576 },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', contextWindow: 1_048_576 },
    ],
    defaultModel: 'gemini-3.8-flash',
    modelsFromRuntime: true,
    brand: { mono: 'G', from: '#4285f4', to: '#9b72cb' },
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    slug: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: [
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindow: 1_000_000 },
    ],
    defaultModel: 'deepseek-v4-pro',
    catalog: { source: 'deepseek', match: /^deepseek-/ },
    brand: { mono: 'D', from: '#5b7cff', to: '#3a57e8' },
    keyUrl: 'https://platform.deepseek.com',
  },
  {
    slug: 'deepseek-harness',
    label: 'DeepSeek Harness',
    runtime: 'dsh',
    // The official API Key adapter speaks Messages, not Chat Completions (P0 contract §2).
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: [],
    defaultModel: '',
    modelsFromRuntime: true,
    brand: { mono: 'D', from: '#5b7cff', to: '#3a57e8' },
    keyUrl: 'https://platform.deepseek.com',
  },
  {
    // `kimi` is reserved for the first-class Kimi runtime, which is what this borrows: picking
    // Kimi runs the Kimi CLI either way, on this key instead of the runner's own sign-in. The
    // CLI's env-backed provider (KIMI_MODEL_*) takes Moonshot's native API, not the
    // Anthropic-compatible shim other CLIs use, so this endpoint is the platform's own /v1.
    slug: 'moonshot',
    label: 'Kimi (Moonshot)',
    runtime: 'kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: [
      { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', contextWindow: 256_000 },
      { value: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code Highspeed', contextWindow: 256_000 },
      { value: 'kimi-k2.6', label: 'Kimi K2.6', contextWindow: 256_000 },
    ],
    defaultModel: 'kimi-k2.7-code',
    catalog: { source: 'moonshotai', match: /^kimi-/ },
    note: 'Global endpoint; the CN platform uses https://api.moonshot.cn/v1.',
    brand: { mono: 'K', from: '#3a3a3a', to: '#111111' },
    keyUrl: 'https://platform.moonshot.ai',
  },
  {
    slug: 'glm',
    label: 'Z.AI (GLM)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    models: [
      { value: 'glm-5.2', label: 'GLM-5.2' },
      { value: 'glm-4.7', label: 'GLM-4.7' },
    ],
    defaultModel: 'glm-5.2',
    // Z.AI ships as `zai` there; `zhipuai` is the CN sibling platform, on a different endpoint.
    catalog: { source: 'zai', match: /^glm-/ },
    brand: { mono: 'Z', from: '#33b6b0', to: '#1e8e8e' },
    keyUrl: 'https://z.ai',
  },
  {
    slug: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    models: [
      { value: 'MiniMax-M3', label: 'MiniMax-M3', contextWindow: 1_000_000 },
      { value: 'MiniMax-M2.7', label: 'MiniMax-M2.7', contextWindow: 204_800 },
      { value: 'MiniMax-M2.7-highspeed', label: 'MiniMax-M2.7 Highspeed', contextWindow: 204_800 },
    ],
    defaultModel: 'MiniMax-M2.7',
    catalog: { source: 'minimax', match: /^MiniMax-/ },
    brand: { mono: 'M', from: '#ff5b76', to: '#e11d48' },
    keyUrl: 'https://www.minimax.io',
  },
  {
    slug: 'qwen',
    label: 'Qwen (Model Studio)',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    models: [
      { value: 'qwen3.7-max', label: 'Qwen3.7 Max' },
      { value: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
      { value: 'qwen3.6-flash', label: 'Qwen3.6 Flash' },
    ],
    defaultModel: 'qwen3.7-max',
    catalog: { source: 'alibaba', match: /^qwen\d/ },
    note: 'Beijing-region endpoint; Singapore/intl uses a workspace-specific URL (see Model Studio docs).',
    brand: { mono: 'Q', from: '#7a72ff', to: '#4f46e5' },
    keyUrl: 'https://bailian.console.aliyun.com',
  },
];

/** The preset a configured provider follows, or undefined for a self-maintained one. */
export function providerPreset(presetSlug?: string | null): ProviderPreset | undefined {
  return presetSlug ? PROVIDER_PRESETS.find((p) => p.slug === presetSlug) : undefined;
}
