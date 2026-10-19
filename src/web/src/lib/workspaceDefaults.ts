import {
  AgentProvider,
  autoAvailable,
  DSH_PERMISSION_MODES,
  isEngine,
  isRetiredModel,
  keyDialect,
  openCodeKeyOf,
  type PlanUsageSnapshot,
  type RunnerModelCatalog,
  type RuntimeDefaultModels,
} from '@orbit/shared';

type ModelOption = { value: string; label: string };

/**
 * A control-plane–configured provider (from GET /api/providers): a key — its own slug/label and
 * model list — that one or more engines run on (docs/provider-engine-contract.md §2.1). Its slug
 * lands in a session's `provider` beside the engine that runs it, as an engine's own sign-in does.
 * The account pools ride the same shape (poolsAsProviders), each running on its own engine alone.
 */
export interface ConfiguredProvider {
  slug: string;
  label: string;
  /** The protocol the key's endpoint speaks, named by the engine that speaks it natively. Which
   *  engines run the key is `engines`. */
  runtime: string;
  /** `reasoningLevels`: the efforts a self-hosted Claude-runtime model declares it accepts, which
   *  dispatch holds the session to (see declaredEffortLevels). */
  models: { value: string; label: string; contextWindow?: number; reasoningLevels?: string[] }[];
  defaultModel?: string | null;
  /** The vendor preset this provider was configured from — its brand identity, and where the
   *  New Session picker gets its logo. NULL for a self-maintained custom endpoint. Served by
   *  GET /providers (providers.service listPublic), which selects it and passes it through
   *  withPreset(). */
  presetSlug?: string | null;
  /** True when this vendor's endpoint is the runtime CLI's own (Anthropic for claude, OpenAI for
   *  codex, Gemini for antigravity), so the runner's live catalogue describes it and `models` is
   *  only a fallback. */
  modelsFromRuntime?: boolean;
  /** Subscription quota for *this row's credential*, when it has one to report (an Anthropic
   *  endpoint reached with a subscription token). Null for a metered API key or a third-party
   *  endpoint, neither of which has a 5-hour/weekly window at all. Served by GET /providers. */
  planUsage?: PlanUsageSnapshot | null;
  /** Whether an OpenCode session may spend this key too (shared `openCodeKeys`), as GET /providers
   *  decides it: absent from an older server, which reads as no. */
  runsOnOpenCode?: boolean;
  /** Every engine this key runs on, the one a session naming only the key gets first — the
   *  server's answer (docs/provider-engine-contract.md §6.3), since only the server, holding the
   *  key, can tell a Claude subscription token, which runs on Claude Code alone. Absent on a pool
   *  read as a provider, which runs on its own engine (`runtime`) and nowhere else. */
  engines?: string[];
}

/** The engines whose own sign-in on the runner is a credential: the provider slug is the engine's
 *  name, and only that engine runs it. */
const LOGIN_ENGINES: readonly string[] = [
  AgentProvider.CLAUDE,
  AgentProvider.CODEX,
  AgentProvider.KIMI,
  AgentProvider.ANTIGRAVITY,
];

/** Whether `provider` is an engine's own sign-in on the runner (its slug is the engine's name). */
export const isLoginProvider = (provider?: string | null): boolean =>
  !!provider && LOGIN_ENGINES.includes(provider);

/** The configured key (or pool) `provider` names. An engine's own sign-in and OpenCode's own config
 *  never match one: dispatch reads those slugs as built-ins first. */
const configuredRow = (
  provider?: string | null,
  configured?: ConfiguredProvider[] | null,
): ConfiguredProvider | undefined =>
  provider && !isLoginProvider(provider) && provider !== AgentProvider.OPENCODE
    ? (configured ?? []).find((p) => p.slug === provider)
    : undefined;

/** The engine whose own protocol a row's endpoint speaks — its model table's home. A row still on
 *  the retired `dsh` runtime holds DeepSeek's Anthropic-compatible endpoint; an unreadable runtime
 *  keeps the backend's Claude fallback. */
const nativeEngine = (runtime?: string | null): AgentProvider =>
  runtime === AgentProvider.CODEX
    ? AgentProvider.CODEX
    : runtime === AgentProvider.KIMI
      ? AgentProvider.KIMI
      : runtime === AgentProvider.ANTIGRAVITY
        ? AgentProvider.ANTIGRAVITY
        : AgentProvider.CLAUDE;

/**
 * The engines `provider` runs on, the one a session naming only it gets first (the compatibility
 * table, docs/provider-engine-contract.md §2.1): an engine's own sign-in its engine, OpenCode's own
 * config OpenCode, a key what GET /providers says, a pool its own engine. The legacy built-in `dsh`
 * is DeepSeek Harness on the key its workspace's environment holds. Empty for a provider this
 * account does not have (removed, turned off, not loaded yet).
 */
export function providerEngines(
  provider?: string | null,
  configured?: ConfiguredProvider[] | null,
): AgentProvider[] {
  if (!provider) return [];
  if (isLoginProvider(provider)) return [provider as AgentProvider];
  if (provider === AgentProvider.OPENCODE) return [AgentProvider.OPENCODE];
  const row = configuredRow(provider, configured);
  if (row) {
    if (row.engines) return row.engines.filter(isEngine);
    // A row from a payload that predates `engines`: its protocol's engine, and OpenCode where the
    // server said so; a protocol no engine speaks, none (contract §2.1). A pool is read this way too.
    if (!keyDialect(row.runtime)) return [];
    const native = row.runtime === AgentProvider.DSH ? AgentProvider.DSH : nativeEngine(row.runtime);
    return row.runsOnOpenCode ? [native, AgentProvider.OPENCODE] : [native];
  }
  return provider === AgentProvider.DSH ? [AgentProvider.DSH] : [];
}

/** The engine a session naming only `provider` runs on, or null when nothing here can say. */
export const defaultEngineOf = (
  provider?: string | null,
  configured?: ConfiguredProvider[] | null,
): AgentProvider | null => providerEngines(provider, configured)[0] ?? null;

/** The engine a session runs on: the one it recorded, which never changes — else, for a row an older
 *  replica wrote, the engine its provider ran on before engines were recorded (contract §1.1), and
 *  Claude Code when even that provider is gone, as dispatch used to read it. */
export const sessionEngineOf = (
  engine: string | null | undefined,
  provider?: string | null,
  configured?: ConfiguredProvider[] | null,
): AgentProvider => (isEngine(engine) ? engine : (defaultEngineOf(provider, configured) ?? AgentProvider.CLAUDE));

/**
 * A session's (engine, provider, model) with OpenCode's old encoding read the new way: a session an
 * older client started on a key under OpenCode stored `opencode` and named the key in its model,
 * `orbit-<slug>/<model>` (contract §3.3). That is the key `<slug>`, with `<model>`.
 */
export function sessionPick(
  engine: AgentProvider,
  provider: string,
  model?: string | null,
): { provider: string; model: string | null | undefined } {
  const key = engine === AgentProvider.OPENCODE && provider === AgentProvider.OPENCODE ? openCodeKeyOf(model) : null;
  return key ? { provider: key.slug, model: key.model } : { provider, model };
}

/** Whether the client can safely derive model capabilities for a persisted provider identity.
 * An engine's own sign-in and OpenCode's own config are always known; a key or pool slug is known
 * only after the provider request has completed successfully (an authoritative empty list then
 * means the key is gone). */
export const providerIdentityResolved = (
  provider?: string | null,
  configuredProvidersLoaded = false,
): boolean =>
  !provider ||
  isLoginProvider(provider) ||
  provider === AgentProvider.OPENCODE ||
  configuredProvidersLoaded;

// Model options are sourced exclusively from the runner's live model catalog (Codex:
// `codex debug models`; Claude: `claude -p "/model <alias>"`). There are no static
// fallback lists — when no runner catalog is available the picker is empty.
// Mirrors Claude Code's `/model` picker (Opus 5 default / Fable 5 / Sonnet 5 / Haiku 4.5).
// Previous models (Opus 4.8, …) stay reachable by pinning the id directly and render as
// their raw id, same as any other non-current model.
// Kimi's list comes from the runner too (`kimi provider list --json`, which also carries each
// model's context window and thinking levels). Its managed default is the one static fallback,
// for a runner whose CLI predates that probe.
export const KIMI_MODEL_OPTIONS = [
  { value: 'kimi-code/kimi-for-coding', label: 'Kimi for Coding' },
];

// OpenCode owns model selection when no model is supplied: a new session resolves its
// configured/default model, while a resumed session retains its current OpenCode model.
// Concrete ids are runner-discovered because they include the underlying provider. Keep an
// explicit empty option ahead of that catalog rather than guessing or borrowing Claude defaults.
export const OPENCODE_MODEL_OPTIONS = [{ value: '', label: 'Managed by OpenCode' }];

// Antigravity's models ship inside the agy binary and come from the runner (`agy models`, one row
// per model with its thinking levels). Until a runner reports them, the one choice that is true on
// every agy is passing no `--model` and letting agy pick its own. Only a fallback, unlike OpenCode's
// sentinel: once a catalogue is reported, dispatch runs a session that names no model on its first
// row, so offering '' beside it would name a choice nothing makes. The fallback names Gemini's
// preset default while preserving the empty dispatch value.
export const ANTIGRAVITY_MODEL_OPTIONS = [{ value: '', label: 'Gemini 3.8 Flash' }];

// Last-resort context windows for the composer's gauge, for a runner too old to report one of its
// own. Not the source of truth and not maintained as if it were: the window belongs to the engine
// that runs the model, and a table keyed on a model id cannot express it — Claude Code offers
// `opus` and `opus[1m]` as one model with two windows, and the answer also moves with CLI version,
// account and gateway. The runner probes its CLIs and ships the real number with each occupancy
// reading (see the runner's model_window.go); this is what the gauge falls back to in the gap
// before it arrives. Keep in sync with Swift's knownContextWindow(for:).
export const CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
  'claude-opus-5': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'kimi-code/kimi-for-coding': 262_144,
};
const catalogOptions = (
  engine: AgentProvider,
  modelCatalog?: RunnerModelCatalog | null,
): ModelOption[] | undefined => {
  const rows = modelCatalog?.[engine as keyof RunnerModelCatalog];
  const options = rows
    ?.filter((m) => m.value && m.label)
    .map((m) => ({ value: m.value, label: m.label }));
  return options?.length ? options : undefined;
};

/**
 * The window to divide a session's context tokens by, when the session hasn't reported one.
 *
 * A live session ships its own — the runner reads it off the CLI that produced the tokens and
 * sends the pair together, which is the only way the two halves are guaranteed to describe the
 * same model at the same moment. This resolves the rest, in order of who actually knows:
 *
 *  1. the runner's catalogue — probed from the installed CLIs, so it follows new releases;
 *  2. the row that configured *this* session's provider — control-plane data for a vendor whose
 *     endpoint the runner can't probe (a BYOK gateway serving its own models);
 *  3. the shipped table, which is a build-time guess.
 *
 * Returns undefined rather than a default when none of them knows. A gauge with no denominator
 * shows the token count; a gauge with a fabricated one shows a percentage of nothing, which is
 * how "Opus 5 at 83%" survived — every layer had an opinion and none of them had measured.
 *
 * `provider` scopes step 2 to the session's own row. Without it any configured provider could
 * define the window for a session it has nothing to do with, purely by naming the same model.
 */
export const contextWindowFor = (
  model?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
  provider?: string | null,
): number | undefined => {
  if (!model) return undefined;
  if (modelCatalog) {
    for (const rows of Object.values(modelCatalog)) {
      const found = rows?.find((m) => m.value === model && typeof m.contextWindow === 'number');
      if (found?.contextWindow) return found.contextWindow;
    }
  }
  for (const p of configured ?? []) {
    if (provider && p.slug !== provider) continue;
    const found = p.models.find((m) => m.value === model && typeof m.contextWindow === 'number');
    if (found?.contextWindow) return found.contextWindow;
  }
  return CONTEXT_WINDOW_BY_MODEL[model];
};

export const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  claude: 'claude-opus-5',
  codex: 'gpt-5.6-sol',
  kimi: 'kimi-code/kimi-for-coding',
  opencode: '',
  antigravity: '',
  // Harness's model values are opaque ACP tokens from the runner's catalogue; none is shipped.
  dsh: '',
};

/** A key's (or pool's) own model table, the same on every engine that runs it: what the runner's CLI
 *  reports for a vendor whose endpoint is that CLI's own (`modelsFromRuntime` — read under the CLI's
 *  engine, never the slug, so an OpenAI key reads Codex's models and a Gemini key agy's), else the
 *  row's own list. An empty list stays empty rather than borrowing Claude's: the composer then shows
 *  the effective fallback as its sole row. A row on the retired `dsh` runtime has no table outside
 *  DeepSeek Harness. */
const rowModelOptions = (row: ConfiguredProvider, modelCatalog?: RunnerModelCatalog | null): ModelOption[] => {
  if (row.modelsFromRuntime && row.runtime !== AgentProvider.DSH) {
    const live = catalogOptions(nativeEngine(row.runtime), modelCatalog);
    if (live) return live;
  }
  return row.models.filter((m) => m.value && m.label).map((m) => ({ value: m.value, label: m.label }));
};

/**
 * The models a session on `engine` with `provider` can pick: the model space is the pair's
 * (docs/provider-engine-contract.md §2.2). DeepSeek Harness takes the runner's ACP catalogue whichever
 * DeepSeek key it spends; a key brings its own table to every engine that runs it, OpenCode included
 * (stored bare — dispatch names the key for OpenCode); an engine's own sign-in, and OpenCode's own
 * config, the runner's catalogue of that CLI.
 */
export const modelOptionsFor = (
  engine: AgentProvider,
  provider?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
): ModelOption[] => {
  if (engine === AgentProvider.DSH) return catalogOptions(AgentProvider.DSH, modelCatalog) ?? [];
  const row = configuredRow(provider, configured);
  if (row) return rowModelOptions(row, modelCatalog);
  if (engine === AgentProvider.OPENCODE) {
    return [...OPENCODE_MODEL_OPTIONS, ...(catalogOptions(AgentProvider.OPENCODE, modelCatalog) ?? [])];
  }
  // The engine's own sign-in — and a provider since removed, whose own table went with it.
  return (
    catalogOptions(engine, modelCatalog) ??
    (engine === AgentProvider.KIMI
      ? KIMI_MODEL_OPTIONS
      : engine === AgentProvider.ANTIGRAVITY
        ? ANTIGRAVITY_MODEL_OPTIONS
        : [])
  );
};

/** A key's (or pool's) default on any engine that runs it: what the CLI of its own endpoint reports
 *  for a vendor it speaks to natively, beating the id shipped in the preset, else the row's own. Never
 *  the Claude default for a key on Codex's protocol: a key owns its model space. */
const rowDefaultModel = (
  row: ConfiguredProvider,
  modelCatalog?: RunnerModelCatalog | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
): string => {
  // A row on the retired `dsh` runtime names no model outside DeepSeek Harness; the runtime picks.
  if (row.runtime === AgentProvider.DSH) return '';
  const native = nativeEngine(row.runtime);
  if (row.modelsFromRuntime) {
    const live = runtimeDefaultModels?.[native] || catalogOptions(native, modelCatalog)?.[0]?.value;
    if (live) return live;
  }
  return (
    row.defaultModel ||
    row.models.find((model) => model.value && model.label)?.value ||
    DEFAULT_MODEL_BY_PROVIDER[native] ||
    DEFAULT_MODEL
  );
};

/** The model a session on `engine` with `provider` runs when nothing names one — the same pair-wise
 *  model space as `modelOptionsFor`. */
export const defaultModelFor = (
  engine: AgentProvider,
  provider?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
): string => {
  // Harness has no static model space: until a runner reports its catalogue the runtime picks.
  if (engine === AgentProvider.DSH) {
    return runtimeDefaultModels?.[AgentProvider.DSH] || catalogOptions(AgentProvider.DSH, modelCatalog)?.[0]?.value || '';
  }
  const row = configuredRow(provider, configured);
  if (row) return rowDefaultModel(row, modelCatalog, runtimeDefaultModels);
  // OpenCode picks the model itself when none is passed; '' is the choice, not a missing value.
  if (engine === AgentProvider.OPENCODE) return runtimeDefaultModels?.[AgentProvider.OPENCODE] ?? '';
  // Antigravity resolves like the other engines — the runner's reported default, then its
  // catalogue's first row — except that with neither the answer is agy's own pick (''), which is
  // what dispatch sends too. The generic chain below would read '' as missing and land on Claude.
  if (engine === AgentProvider.ANTIGRAVITY) {
    return (
      runtimeDefaultModels?.[AgentProvider.ANTIGRAVITY] ||
      catalogOptions(AgentProvider.ANTIGRAVITY, modelCatalog)?.[0]?.value ||
      ''
    );
  }
  return (
    runtimeDefaultModels?.[engine] ||
    modelOptionsFor(engine, engine, modelCatalog)[0]?.value ||
    DEFAULT_MODEL_BY_PROVIDER[engine] ||
    DEFAULT_MODEL
  );
};

/**
 * A stored model the pair still offers, or undefined once the runtime has retired it — the picker
 * then falls through to the current default instead of rendering a dead id nobody can select back.
 * Mirrors the server's `livePin` (apiserver providers/custom-provider.ts) so what the pill shows is
 * what dispatch runs, including which pins are left alone: OpenCode owns its own selection, a
 * third-party key's list is a document rather than a live probe, and an id the Runtime itself
 * reports (`opus`, `opusplan`, a gateway id) is current by definition. Judged against the catalogue
 * of the engine that runs it — DeepSeek Harness's own, whichever key it spends.
 */
export const livePinnedModel = (
  model: string | null | undefined,
  engine: AgentProvider,
  provider?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
): string | null | undefined => {
  if (engine === AgentProvider.OPENCODE) return model;
  const row = configuredRow(provider, configured);
  // Antigravity's '' is the stand-in for a catalogue not reported yet, not a pick that outlives
  // one: dispatch runs a model-less session on the reported default, so that is what to show.
  if (!model) return !row && engine === AgentProvider.ANTIGRAVITY ? undefined : model;
  if (engine !== AgentProvider.DSH && row && !row.modelsFromRuntime) return model;
  const judge = engine === AgentProvider.DSH || !row ? engine : nativeEngine(row.runtime);
  return isRetiredModel(model, catalogOptions(judge, modelCatalog), runtimeDefaultModels?.[judge])
    ? undefined
    : model;
};

/** The key a model picked for `engine` on `provider` is remembered under in
 *  `User.preferences.defaultModels` (docs/provider-engine-contract.md §6.5). */
export const defaultModelKey = (engine: string, provider: string): string => `${engine}:${provider}`;

/**
 * The model last picked for `engine` on `provider`, read in §6.5's order: the pair's own key, then
 * what an older client remembered under the old keys — `opencode/<slug>` (whose value names the key,
 * `orbit-<slug>/<model>`) and `opencode` for OpenCode, the bare slug for the engine a provider runs
 * on by default. Undefined when nothing was picked for it.
 */
export function rememberedModel(
  engine: AgentProvider,
  provider: string,
  accountModels?: Record<string, string> | null,
  configured?: ConfiguredProvider[] | null,
): string | undefined {
  if (!accountModels) return undefined;
  const own = accountModels[defaultModelKey(engine, provider)];
  if (own !== undefined) return own;
  if (engine === AgentProvider.OPENCODE) {
    if (provider === AgentProvider.OPENCODE) {
      const old = accountModels[AgentProvider.OPENCODE];
      return old !== undefined && !openCodeKeyOf(old) ? old : undefined;
    }
    const named = openCodeKeyOf(accountModels[`${AgentProvider.OPENCODE}/${provider}`]);
    return named && named.slug === provider ? named.model : undefined;
  }
  return defaultEngineOf(provider, configured) === engine ? accountModels[provider] : undefined;
}

/** A new interactive session remembers the last explicit model pick for this engine and provider. */
export const newSessionModelFor = (
  engine: AgentProvider,
  provider: string,
  accountModels?: Record<string, string> | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
): string =>
  livePinnedModel(
    rememberedModel(engine, provider, accountModels, configured),
    engine,
    provider,
    modelCatalog,
    configured,
    runtimeDefaultModels,
  ) ?? defaultModelFor(engine, provider, modelCatalog, configured, runtimeDefaultModels);

/** Match the server's session dispatch precedence without treating OpenCode's empty sentinel as
 * missing: a session override wins, then its owning workspace, then the pair's default. A retired
 * pin on either drops out, exactly as it does at dispatch. */
export const effectiveSessionModel = (
  engine: AgentProvider,
  provider: string,
  sessionModel?: string | null,
  workspaceModel?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
  runtimeDefaultModels?: RuntimeDefaultModels,
): string => {
  const live = (model?: string | null) =>
    livePinnedModel(model, engine, provider, modelCatalog, configured, runtimeDefaultModels);
  return (
    live(sessionModel) ??
    live(workspaceModel) ??
    defaultModelFor(engine, provider, modelCatalog, configured, runtimeDefaultModels)
  );
};

/** Match the server's session dispatch precedence for reasoning effort. Empty is explicit. */
export const effectiveSessionEffort = (
  sessionEffort?: string | null,
  workspaceEffort?: string | null,
): string => sessionEffort ?? workspaceEffort ?? '';

// Reasoning effort is provider- and model-specific. Codex's live runner catalog is authoritative;
// these lists are the fallback when the selected model has not been reported yet.
// Claude's Ultra is Claude Code's ultracode: xhigh plus standing workflow orchestration.
export const CLAUDE_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' },
];

export const CODEX_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' },
];

// Kimi's vocabulary is closed, but which of these levels a model accepts is declared per model
// (`supportEfforts`): K2.7 Coding declares none and rejects every level, while K3 takes low/high/
// max. The runner catalog carries each model's own list, so this is only the fallback for a model
// it does not report — an env-injected KIMI_MODEL_* alias, or a runner too old to probe its CLI.
export const KIMI_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

// agy's thinking levels (`--effort`, contract §9.2). Which of them a model has is per model — Gemini
// 3.1 Pro has Low and High only — and the runner catalog carries each model's own list, so this is
// the fallback for a model it does not report.
export const ANTIGRAVITY_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

// OpenCode variants are model-defined, so its picker follows the runner catalog. This generic
// list is only the fallback for a model the runner-wide catalog does not report.
export const OPENCODE_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
  { value: 'max', label: 'Max' },
];

const effortLabel = (level: string): string =>
  level === 'xhigh' ? 'xHigh' : level.charAt(0).toUpperCase() + level.slice(1);

/** The runner catalog row for an engine whose reasoning levels are model-defined (call sites gate
 *  on that), or undefined when the runner-wide catalog does not report the model. "No row" means
 *  "unknown", never "unsupported": an OpenCode model may be project-scoped — or a key's, which
 *  OpenCode's own catalogue never lists — and an older runner reports no Kimi models at all. */
const modelDefinedEffortRow = (
  engine: AgentProvider,
  model?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
) => modelCatalog?.[engine as keyof RunnerModelCatalog]?.find((entry) => entry.value === model);

// Kimi has no `minimal`/`medium` and calls Codex's top level `max`, so a value carried in from
// another runtime maps onto its vocabulary before the model's own list is consulted.
const KIMI_EFFORT_ALIASES: Record<string, string> = {
  minimal: 'low',
  medium: 'high',
  xhigh: 'max',
};

// agy tops out at `high` and starts at `low`, so the levels above and below its range collapse
// onto its ends. Mirrors normalizeEffortForProvider in apiserver common/runtime-provider.ts.
const ANTIGRAVITY_EFFORT_ALIASES: Record<string, string> = {
  none: 'low',
  minimal: 'low',
  xhigh: 'high',
  max: 'high',
  ultra: 'high',
};

// Claude Code's effort levels, lowest first: the scale a declared list is read against. Mirrors
// CLAUDE_EFFORT_ORDER in apiserver common/runtime-provider.ts.
const CLAUDE_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The efforts a key's model declares it accepts on Claude Code (`reasoningLevels` on its row),
 *  lowest first, or undefined when it declares nothing. Dispatch holds the session to exactly this
 *  list (apiserver declaredReasoningLevels) — a self-hosted model refuses the rest — so the picker
 *  offers this list rather than Claude's. Only Claude Code honours a declaration: on any other engine
 *  the same key's model is that engine's to describe (contract §2.3). */
const declaredEffortLevels = (
  engine: AgentProvider,
  provider?: string | null,
  model?: string | null,
  configured?: ConfiguredProvider[] | null,
): string[] | undefined => {
  const row = configuredRow(provider, configured);
  if (!row || engine !== AgentProvider.CLAUDE) return undefined;
  const levels = row.models.find((entry) => entry.value === model)?.reasoningLevels;
  return Array.isArray(levels) ? CLAUDE_EFFORT_ORDER.filter((level) => levels.includes(level)) : undefined;
};

/** The level dispatch runs `effort` at on a model that declares `levels`: the nearest one, the
 *  higher of two equally near, with Ultra (ultracode, which runs at xhigh) kept wherever xhigh is.
 *  Mirrors effortWithinDeclaredLevels (apiserver common/runtime-provider.ts), except that Default
 *  stays Default: the picker offers it, and dispatch resolves it. */
const effortWithinDeclaredLevels = (effort: string, levels: string[]): string => {
  if (!effort || levels.length === 0) return '';
  const asked = effort === 'ultra' ? 'xhigh' : effort;
  if (levels.includes(asked)) return effort;
  const rank = CLAUDE_EFFORT_ORDER.indexOf(asked);
  const distance = (level: string) => Math.abs(CLAUDE_EFFORT_ORDER.indexOf(level) - rank);
  // `levels` runs lowest first, so `<=` leaves the higher of two equally near levels standing.
  return levels.reduce((nearest, level) => (distance(level) <= distance(nearest) ? level : nearest));
};

/** Harness's thinking levels are its catalogue row's `reasoningLevels` (ACP `reasoning_effort`),
 *  opaque like its model values. A model the runner hasn't reported offers Default only: there is
 *  no static list to fall back on, and a guessed level would be refused at dispatch. */
const dshEffortOptions = (model?: string | null, modelCatalog?: RunnerModelCatalog | null) => {
  const row = modelCatalog?.[AgentProvider.DSH]?.find((entry) => entry.value === model);
  const levels = [...new Set((row?.reasoningLevels ?? []).filter(Boolean))];
  return [{ value: '', label: 'Default' }, ...levels.map((level) => ({ value: level, label: effortLabel(level) }))];
};

/** The efforts a session on `engine` can pick for `model`. The engine decides the vocabulary, never
 *  the provider's slug: a key on Codex's protocol offers Codex's levels, a key under OpenCode
 *  OpenCode's variants (contract §2.3). `provider` matters only for a key's declared levels on Claude
 *  Code. */
export const effortOptionsFor = (
  engine: AgentProvider,
  provider?: string | null,
  model?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
) => {
  if (engine === AgentProvider.DSH) return dshEffortOptions(model, modelCatalog);
  const declared = declaredEffortLevels(engine, provider, model, configured);
  if (declared) {
    return CLAUDE_EFFORT_OPTIONS.filter(
      ({ value }) =>
        value === '' || declared.includes(value) || (value === 'ultra' && declared.includes('xhigh')),
    );
  }
  if (engine === AgentProvider.CLAUDE) return CLAUDE_EFFORT_OPTIONS;

  const exactModel = modelDefinedEffortRow(engine, model, modelCatalog);
  // A model the runner-wide catalog does not report keeps the generic fallback. An exact row with
  // no levels is authoritative: that model supports Default only.
  if (!exactModel) {
    if (engine === AgentProvider.CODEX) return CODEX_EFFORT_OPTIONS;
    if (engine === AgentProvider.ANTIGRAVITY) return ANTIGRAVITY_EFFORT_OPTIONS;
    return engine === AgentProvider.KIMI ? KIMI_EFFORT_OPTIONS : OPENCODE_EFFORT_OPTIONS;
  }
  const unique = [...new Set((exactModel.reasoningLevels ?? []).filter(Boolean))];
  return [
    { value: '', label: 'Default' },
    ...unique.map((level) => ({ value: level, label: effortLabel(level) })),
  ];
};

/** The level a session on `engine` actually runs `effort` at, as dispatch normalizes it by the same
 *  engine — so the pill never names a level the session would not get. */
export const normalizeEffortFor = (
  engine: AgentProvider,
  provider: string | null | undefined,
  effort: string,
  model?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
): string => {
  if (engine === AgentProvider.DSH) {
    return dshEffortOptions(model, modelCatalog).some((option) => option.value === effort) ? effort : '';
  }
  // A level the declaring model lacks is not dropped but moved, exactly as dispatch moves it, so
  // the pill names the level the session actually runs at.
  const declared = declaredEffortLevels(engine, provider, model, configured);
  if (declared) {
    const claudeEffort = CLAUDE_EFFORT_OPTIONS.some((option) => option.value === effort) ? effort : '';
    return effortWithinDeclaredLevels(claudeEffort, declared);
  }
  if (engine === AgentProvider.CLAUDE) {
    return CLAUDE_EFFORT_OPTIONS.some((option) => option.value === effort) ? effort : '';
  }
  // Kimi's and Antigravity's closed vocabularies map first; the model's own list below has the
  // last word.
  const normalized =
    engine === AgentProvider.KIMI
      ? (KIMI_EFFORT_ALIASES[effort] ?? effort)
      : engine === AgentProvider.ANTIGRAVITY
        ? (ANTIGRAVITY_EFFORT_ALIASES[effort] ?? effort)
        : effort;
  const exactModel = modelDefinedEffortRow(engine, model, modelCatalog);
  // The heartbeat catalog is deliberately global, so a project-only model may be absent. Preserve
  // its variant only in that case; an exact row (including one with an empty variants object) is
  // authoritative.
  if (!exactModel) {
    if (engine === AgentProvider.ANTIGRAVITY) {
      return ANTIGRAVITY_EFFORT_OPTIONS.some((option) => option.value === normalized) ? normalized : '';
    }
    if (engine !== AgentProvider.CODEX) return normalized;
    return CODEX_EFFORT_OPTIONS.some((option) => option.value === normalized) ? normalized : '';
  }
  const levels = exactModel.reasoningLevels ?? [];
  return normalized === '' || levels.includes(normalized) ? normalized : '';
};

/** Resolve the effort shown by an interactive new-session composer.
 *
 * Picking an effort in any session writes the account preference as a last-picked default. Some
 * older workspaces still carry the per-workspace default that predated that preference; keep it as
 * a compatibility fallback only. Letting that stale value win would make a freshly picked effort
 * appear to revert the next time the composer opens. An explicit account Default ('') still wins. */
export const newSessionEffortFor = (
  engine: AgentProvider,
  provider: string | null | undefined,
  accountEffort?: string | null,
  workspaceEffort?: string | null,
  model?: string | null,
  modelCatalog?: RunnerModelCatalog | null,
  configured?: ConfiguredProvider[] | null,
): string =>
  normalizeEffortFor(engine, provider, accountEffort ?? workspaceEffort ?? '', model, modelCatalog, configured);

// The permission mode a new session of the workspace starts in.
export const MODE_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan' },
  { value: 'acceptEdits', label: 'Accept Edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'dontAsk', label: "Don't Ask" },
  { value: 'bypassPermissions', label: 'Bypass' },
];

/** Whether Auto exists for `model` on `engine`. Defers to the same shared answer the server
 *  normalizes with, so the picker and dispatch cannot disagree about which sessions can have it; a
 *  key (or pool) on Claude Code owns its model space, which Claude's allow-list cannot speak for.
 *
 *  `modelCatalog` is the ASSIGNED runner's, and is where the answer now comes from: Claude gates
 *  Auto per model, and which models have it is a property of the CLI installed on that machine.
 *  Pass it wherever the runner is in view — exactly as the model list, the context window and the
 *  effort levels already do. Omitting it falls back to a list in the repo, which is how Opus 5.5
 *  came to be offered Default-only on runners whose CLI would have honored Auto. */
export const supportsAuto = (
  model: string,
  engine: AgentProvider,
  provider?: string | null,
  configured?: ConfiguredProvider[] | null,
  modelCatalog?: RunnerModelCatalog | null,
): boolean => autoAvailable(engine, model, !!configuredRow(provider, configured), modelCatalog);

/** Whether `engine` accepts this permission mode at all. Only DeepSeek Harness refuses modes
 *  outright (DSH_PERMISSION_MODES, which the server enforces at admission): those are not offered
 *  rather than caveated, since the session would be rejected. */
export const permissionModeSupported = (mode: string, engine: AgentProvider): boolean =>
  engine !== AgentProvider.DSH || (DSH_PERMISSION_MODES as readonly string[]).includes(mode);

export const clampPermissionModeForModel = (
  mode: string,
  model: string,
  engine: AgentProvider,
  provider?: string | null,
  configured?: ConfiguredProvider[] | null,
  modelCatalog?: RunnerModelCatalog | null,
): string =>
  !permissionModeSupported(mode, engine)
    ? 'default'
    : mode === 'auto' && !supportsAuto(model, engine, provider, configured, modelCatalog)
      ? 'default'
      : mode;

// App defaults used when the user has set no preference of their own.
export const DEFAULT_MODEL = 'claude-opus-5';
export const DEFAULT_PERMISSION_MODE = 'auto';
