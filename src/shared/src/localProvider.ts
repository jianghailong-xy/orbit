// A runner-scoped provider: a model server that lives on one runner's machine, reached by that runner
// alone (docs/ollama-local-provider-contract.md). Ollama is the first one. It is a ModelProvider row on an
// engine Orbit already runs (Claude Code, on Ollama's own Anthropic Messages endpoint), never an engine of
// its own: `AgentProvider` has no OLLAMA.
//
// Three facts travel together on such a row, and the database holds them together
// (migration 0642 model_provider_runner_scope):
//   * scope `runner`: the row names the one runner whose machine serves it (`runnerId`), and a session on it
//     runs on that runner or not at all;
//   * authMode `none`: the server asks for no key, so none is stored (`apiKeyEnc` is the empty string);
//   * the vendor preset is a local one (`ollama`).
// Every other row is scope `account` + authMode `bearer` + a stored key, exactly as before.

/** Where a provider can be dispatched from: anywhere its owner runs sessions, or one runner only. */
export const PROVIDER_SCOPES = ['account', 'runner'] as const;
export type ProviderScope = (typeof PROVIDER_SCOPES)[number];

/** How the engine authenticates to the endpoint: with the row's stored key, or not at all. */
export const PROVIDER_AUTH_MODES = ['bearer', 'none'] as const;
export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODES)[number];

/** The vendor preset of a local Ollama server. */
export const OLLAMA_PRESET_SLUG = 'ollama';

/** Ollama's own address on the runner's machine: "localhost" means the runner, never the control plane. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/**
 * What a runner declares in its heartbeat capabilities once it can probe a local Ollama (phase 2): version,
 * health and the instance's models. A runner that does not declare it is not "unhealthy" — it is a runner
 * too old to say, and its local providers read as UNKNOWN.
 */
export const OLLAMA_PROBE_CAPABILITY = 'ollama-probe/v1';

/**
 * What a runner declares once it runs a local provider's Claude Code session isolated from every other route
 * (runner-go/claude_local_provider.go): no inherited cloud routing, and every routing variable pinned in the
 * session's flag settings layer over the user's and the checkout's settings files. A runner that probes but does
 * not declare this is refused as LOCAL_PROVIDER_RUNNER_OUTDATED.
 */
export const LOCAL_PROVIDER_RUN_CAPABILITY = 'ollama-run/v1';

/** The job variable that marks a local provider's session for the runner; the runner never passes it on. */
export const LOCAL_PROVIDER_MARKER_VAR = 'ORBIT_LOCAL_PROVIDER';

/**
 * Whether a variable decides where Claude Code sends its model requests, or with which credential — the same rule
 * as the runner's claudeRoutingKey: Anthropic's endpoint, key and models, every cloud platform switch
 * (CLAUDE_CODE_USE_*) with its CLAUDE_CODE_SKIP_*_AUTH sibling, base URLs, regions and credentials, and the OAuth
 * token. A local session takes none of these from its workspace.
 */
export function isClaudeRoutingVar(name: string): boolean {
  const key = name.toUpperCase();
  if (['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLOUD_ML_REGION', 'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'VERTEX_REGION_CLAUDE_CODE'].includes(key)) return true;
  if (['ANTHROPIC_', 'CLAUDE_CODE_USE_', 'AWS_', 'VERTEX_REGION_'].some((prefix) => key.startsWith(prefix))) return true;
  return key.startsWith('CLAUDE_CODE_SKIP_') && key.endsWith('_AUTH');
}

/**
 * The routing variables a local session's job names as empty, so that whatever the runner's own environment holds
 * for them is overridden even on the way to the runner's own filter. Not the whole rule (isClaudeRoutingVar is):
 * the ones known to send a request somewhere else.
 */
export const LOCAL_CLAUDE_CLEARED_ENV = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

/**
 * The token handed to an engine whose CLI insists on one when the provider takes none. Built into the
 * engine's environment at dispatch, and persisted in no control-plane or task data; on the runner it exists only in
 * the session's runtime configuration (its environment and temporary --settings file): it is not a secret, and it is what keeps
 * Claude Code from sending the runner's own Claude sign-in to the local endpoint instead.
 */
export const LOCAL_AUTH_PLACEHOLDER = 'ollama';

/**
 * What the runner's last probe of the instance found (written by the runner, phase 2):
 *   READY               the server answered, and every model the row names is served with tool calling and enough context;
 *   UNREACHABLE         no answer: connection refused, a timeout, or an HTTP error;
 *   MALFORMED           an answer that is not Ollama's: bad JSON, a redirect, a body over its cap, a wrong content type;
 *   CLOUD_ENABLED       reserved: the instance would forward the row's model to ollama.com;
 *   NO_MODELS           the server answered and serves no local model at all;
 *   MODEL_MISSING       a model the row names is not on the server (never pulled, or removed since);
 *   CAPABILITY_MISSING  a model the row names lacks tool calling, or its context is under LOCAL_MIN_CONTEXT_WINDOW;
 *   REFUSED             the runner would not probe the endpoint: not loopback, and its own configuration allows no other.
 */
export const LOCAL_PROBE_STATES = [
  'READY',
  'UNREACHABLE',
  'MALFORMED',
  'CLOUD_ENABLED',
  'NO_MODELS',
  'MODEL_MISSING',
  'CAPABILITY_MISSING',
  'REFUSED',
] as const;
export type LocalProbeState = (typeof LOCAL_PROBE_STATES)[number];

/**
 * The smallest context a model may serve Claude Code with (docs/ollama-local-provider-phase0.md: 64K tokens). A
 * model the row names that reports less is CAPABILITY_MISSING.
 */
export const LOCAL_MIN_CONTEXT_WINDOW = 65_536;

/** How often a runner re-probes each instance it is bound to. */
export const LOCAL_PROBE_INTERVAL_MS = 60_000;

/**
 * A probe older than this reads as STALE: the runner stopped reporting (offline, or its probe loop is stuck), so
 * what it last said is no longer an answer about now. Five probe intervals.
 */
export const LOCAL_PROBE_STALE_MS = 5 * LOCAL_PROBE_INTERVAL_MS;

/**
 * Where a runner-scoped provider stands, as a client shows it. UNKNOWN is its own answer, never a stand-in
 * for health: no probe yet, or a runner that cannot probe. STALE is a probe older than LOCAL_PROBE_STALE_MS. DISABLED and NO_RUNNER are the row's own
 * reasons not to run (the owner switched it off; its runner was removed or is no longer theirs).
 */
export type LocalProviderState = LocalProbeState | 'UNKNOWN' | 'STALE' | 'DISABLED' | 'NO_RUNNER';

/** Whether the bound runner can probe the instance at all: SUPPORTED, or UNKNOWN for an older runner. */
export type LocalProbeCapability = 'SUPPORTED' | 'UNKNOWN';

/** One model the instance serves, as the runner discovered it. */
export interface LocalInstanceModel {
  value: string;
  label?: string;
  contextWindow?: number;
  /** Whether the model advertises tool calling; absent when the runner could not tell. */
  tools?: boolean;
  /** The model's size as Ollama states it (e.g. "27.3B"). */
  parameterSize?: string;
  /** The model's quantization as Ollama states it (e.g. "Q4_K_M"). */
  quantization?: string;
}

/** A runner-scoped provider's status block on a provider read. Never an endpoint or a key. */
export interface LocalProviderStatus {
  state: LocalProviderState;
  capability: LocalProbeCapability;
  probedAt: string | null;
  /** The server's version, as it reported it (e.g. Ollama 0.40.16). */
  version: string | null;
  /** How long the probe's readiness call (/api/version) took, in milliseconds; null when it got no answer. */
  latencyMs: number | null;
  /** The instance's own model catalogue; null until a runner has reported one. */
  models: LocalInstanceModel[] | null;
}

/** The provider fields every read carries beside the ones it always had. Old clients ignore them. */
export interface ProviderScopeFields {
  scope: ProviderScope;
  authMode: ProviderAuthMode;
  /** The runner a runner-scoped row runs on — only when that runner is still the row owner's; else null. */
  runnerId: string | null;
  /** Present on a runner-scoped row only. */
  local?: LocalProviderStatus;
}

export function isProviderScope(value: unknown): value is ProviderScope {
  return (PROVIDER_SCOPES as readonly unknown[]).includes(value);
}

export function isProviderAuthMode(value: unknown): value is ProviderAuthMode {
  return (PROVIDER_AUTH_MODES as readonly unknown[]).includes(value);
}

/**
 * A model id Ollama forwards to ollama.com rather than serving itself (`gpt-oss:20b-cloud`, `…:cloud`). A
 * local provider must not name one: a local-looking endpoint is not enough to keep a request on the machine
 * (docs/ollama-local-provider-phase0.md §6.3).
 */
export function isCloudModelId(id: string): boolean {
  const value = id.trim().toLowerCase();
  return value.endsWith('-cloud') || value.endsWith(':cloud');
}

/** Whether a runner's declared capabilities include the local probe. */
export function declaresLocalProbe(capabilities: readonly string[] | null | undefined): boolean {
  return (capabilities ?? []).some((value) => value.trim().toLowerCase() === OLLAMA_PROBE_CAPABILITY);
}

/**
 * A runner-scoped row's status, from the row and its bound runner as the server read them. The runner is
 * passed only when it is still the row owner's: anyone else's runner is no runner here. A probe older than
 * LOCAL_PROBE_STALE_MS (as of `now`) is STALE, whatever it said.
 */
export function localProviderStatus(
  row: {
    enabled: boolean;
    probeState: string | null;
    probedAt: Date | string | null;
    probeVersion: string | null;
    probeLatencyMs?: number | null;
    instanceModels: unknown;
  },
  runner: { capabilities: readonly string[] | null; capabilitiesReportedAt: Date | string | null } | null,
  now: number = Date.now(),
): LocalProviderStatus {
  const capability: LocalProbeCapability =
    runner && runner.capabilitiesReportedAt != null && declaresLocalProbe(runner.capabilities) ? 'SUPPORTED' : 'UNKNOWN';
  const probed = (LOCAL_PROBE_STATES as readonly string[]).includes(row.probeState ?? '')
    ? (row.probeState as LocalProbeState)
    : null;
  const probedAtMs = row.probedAt == null ? NaN : new Date(row.probedAt).getTime();
  const stale = !Number.isFinite(probedAtMs) || now - probedAtMs > LOCAL_PROBE_STALE_MS;
  const state: LocalProviderState = !row.enabled
    ? 'DISABLED'
    : !runner
      ? 'NO_RUNNER'
      : capability === 'UNKNOWN' || !probed
        ? 'UNKNOWN'
        : stale
          ? 'STALE'
          : probed;
  const probedAt = Number.isFinite(probedAtMs) ? new Date(probedAtMs).toISOString() : null;
  return {
    state,
    capability,
    probedAt,
    version: row.probeVersion ?? null,
    latencyMs: typeof row.probeLatencyMs === 'number' ? row.probeLatencyMs : null,
    models: Array.isArray(row.instanceModels) ? (row.instanceModels as LocalInstanceModel[]) : null,
  };
}

// ── The runner's probe, on the heartbeat (phase 2) ──────────────────────────────────────────────────────

/**
 * A runner-scoped provider the control plane hands its runner to probe (RunnerHeartbeatResponse.localProviders).
 * Only rows bound to that runner, and only what a probe needs: the endpoint and the models the row names.
 */
export interface LocalProviderTarget {
  providerId: string;
  baseUrl: string;
  /** The models the row names (its list and its default): each must be served, with tools and enough context. */
  models: string[];
}

/**
 * What the runner found at one target (RunnerHeartbeatRequest.localProviderProbes). It carries no prompt, no key
 * and no response body: a state, the server's version, a short reason code, timings and the sanitized catalogue.
 */
export interface LocalProviderProbe {
  providerId: string;
  /** The endpoint probed, exactly as the target named it: a report about an endpoint the row has since left is dropped. */
  baseUrl: string;
  state: LocalProbeState;
  version?: string;
  /** RFC 3339: when the probe ran, by the runner's clock. */
  checkedAt: string;
  latencyMs?: number;
  /** A short machine reason (e.g. "connection_refused", "missing:qwen3:8b"); never the server's own words. */
  reason?: string;
  /** The instance's own catalogue; absent when the server did not answer it. */
  models?: LocalInstanceModel[];
}

/** At most this many targets a beat hands a runner, and this many probes a beat reports. */
export const LOCAL_PROBE_MAX_TARGETS = 16;
/** At most this many models a probe reports of one instance. */
export const LOCAL_PROBE_MAX_MODELS = 200;

const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const SHORT_TEXT_RE = /^[\x20-\x7e]+$/;

function shortText(value: unknown, max = 64): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length <= max && SHORT_TEXT_RE.test(text) ? text : undefined;
}

/**
 * A runner's catalogue as the server keeps it: well-formed model names only, no Ollama cloud model, each field
 * typed and bounded, at most LOCAL_PROBE_MAX_MODELS, duplicates dropped. Anything else in an entry is left out,
 * so nothing the instance said beyond these fields reaches a client. Null when it is not a list.
 */
export function sanitizeInstanceModels(value: unknown): LocalInstanceModel[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: LocalInstanceModel[] = [];
  for (const entry of value) {
    if (out.length >= LOCAL_PROBE_MAX_MODELS) break;
    const e = (entry ?? {}) as Record<string, unknown>;
    const name = typeof e.value === 'string' ? e.value.trim() : '';
    if (!MODEL_NAME_RE.test(name) || isCloudModelId(name) || seen.has(name)) continue;
    seen.add(name);
    const model: LocalInstanceModel = { value: name };
    const label = typeof e.label === 'string' && MODEL_NAME_RE.test(e.label.trim()) ? e.label.trim() : undefined;
    if (label && label !== name) model.label = label;
    if (typeof e.contextWindow === 'number' && Number.isInteger(e.contextWindow) && e.contextWindow > 0 && e.contextWindow <= 100_000_000) {
      model.contextWindow = e.contextWindow;
    }
    if (typeof e.tools === 'boolean') model.tools = e.tools;
    const parameterSize = shortText(e.parameterSize, 32);
    if (parameterSize) model.parameterSize = parameterSize;
    const quantization = shortText(e.quantization, 32);
    if (quantization) model.quantization = quantization;
    out.push(model);
  }
  return out;
}

/** A probe as the server stores it, or null when it is not one: the state known, the id and endpoint present. */
export function sanitizeLocalProviderProbe(value: unknown): {
  providerId: string;
  baseUrl: string;
  state: LocalProbeState;
  version: string | null;
  checkedAt: Date | null;
  latencyMs: number | null;
  reason: string | null;
  models: LocalInstanceModel[] | null;
} | null {
  const p = (value ?? {}) as Record<string, unknown>;
  if (typeof p.providerId !== 'string' || !p.providerId) return null;
  if (typeof p.baseUrl !== 'string' || !p.baseUrl || p.baseUrl.length > 2048) return null;
  if (!(LOCAL_PROBE_STATES as readonly unknown[]).includes(p.state)) return null;
  const checked = typeof p.checkedAt === 'string' ? new Date(p.checkedAt) : null;
  const latency = typeof p.latencyMs === 'number' && Number.isFinite(p.latencyMs) && p.latencyMs >= 0
    ? Math.min(Math.round(p.latencyMs), 600_000)
    : null;
  return {
    providerId: p.providerId,
    baseUrl: p.baseUrl,
    state: p.state as LocalProbeState,
    version: shortText(p.version, 64) ?? null,
    checkedAt: checked && Number.isFinite(checked.getTime()) ? checked : null,
    latencyMs: latency,
    reason: shortText(p.reason, 240) ?? null,
    models: sanitizeInstanceModels(p.models),
  };
}

// ── Dispatch readiness (phase 3) ───────────────────────────────────────────────────────────────────────

/**
 * Every refusal a door gives a session on a runner-scoped provider. Each one says the session will not run
 * there, and none of them moves it onto another runner or a cloud engine's own sign-in.
 *
 *   DISABLED            the owner turned the provider off. A backstop: every door answers a disabled row first with
 *                       the refusals every disabled provider meets ("provider not available", "provider is
 *                       disabled"), so no door returns this code.
 *   NO_RUNNER           its runner was removed, or no longer belongs to the provider's owner.
 *   ELSEWHERE           the session is on another runner, or the door named none.
 *   RUNNER_OUTDATED     the runner does not declare OLLAMA_PROBE_CAPABILITY and LOCAL_PROVIDER_RUN_CAPABILITY: too old
 *                       to say whether Ollama is up, or to keep the run off every other route.
 *   UNPROBED            the runner has not probed the instance yet.
 *   STALE               the last probe is older than LOCAL_PROBE_STALE_MS.
 *   UNREACHABLE         the last probe got no answer: Ollama is stopped, still starting, or busy.
 *   MISCONFIGURED       the endpoint is not Ollama, the runner refuses to reach it, or it forwards to the cloud.
 *   NO_MODELS           the instance serves no local model.
 *   MODEL_MISSING       the model the session would run is not on the instance, or nothing names one.
 *   CAPABILITY_MISSING  that model lacks tool calling, or serves less than LOCAL_MIN_CONTEXT_WINDOW.
 */
export const LOCAL_PROVIDER_REFUSAL_CODES = [
  'LOCAL_PROVIDER_DISABLED',
  'LOCAL_PROVIDER_NO_RUNNER',
  'LOCAL_PROVIDER_ELSEWHERE',
  'LOCAL_PROVIDER_RUNNER_OUTDATED',
  'LOCAL_PROVIDER_UNPROBED',
  'LOCAL_PROVIDER_STALE',
  'LOCAL_PROVIDER_UNREACHABLE',
  'LOCAL_PROVIDER_MISCONFIGURED',
  'LOCAL_PROVIDER_NO_MODELS',
  'LOCAL_PROVIDER_MODEL_MISSING',
  'LOCAL_PROVIDER_CAPABILITY_MISSING',
] as const;
export type LocalProviderRefusalCode = (typeof LOCAL_PROVIDER_REFUSAL_CODES)[number];

/**
 * The refusals that clear on their own: the runner's next probe answers them (a cold Ollama finishing its
 * start, a busy one freeing up, a runner coming back online). Every other refusal waits for a person: a
 * removed model, a model without tools, a wrong endpoint, an old runner. A session held on either kind
 * waits PENDING with the reason; nothing re-sends it on a timer.
 */
export const LOCAL_PROVIDER_TRANSIENT_REFUSALS: ReadonlySet<LocalProviderRefusalCode> = new Set([
  'LOCAL_PROVIDER_UNPROBED',
  'LOCAL_PROVIDER_STALE',
  'LOCAL_PROVIDER_UNREACHABLE',
]);

/** Every refusal sentence begins with this, so a hold that has cleared is recognised by its words. */
export const LOCAL_PROVIDER_ERROR_PREFIX = 'Local provider ';

export interface LocalProviderRefusal {
  code: LocalProviderRefusalCode;
  /** Whether it clears without anybody acting (LOCAL_PROVIDER_TRANSIENT_REFUSALS). */
  transient: boolean;
  /** The sentence the session waits with. It names the provider and the model, never the endpoint. */
  message: string;
}

export function isLocalProviderRefusalCode(code: unknown): code is LocalProviderRefusalCode {
  return (LOCAL_PROVIDER_REFUSAL_CODES as readonly unknown[]).includes(code);
}

/**
 * The instance's entry for `model`: Ollama serves `llama3` as `llama3:latest`, so a name without a tag
 * matches its `:latest`. Any other tag is part of the name.
 */
export function localInstanceModel(
  catalogue: readonly LocalInstanceModel[] | null | undefined,
  model: string,
): LocalInstanceModel | undefined {
  const name = model.trim();
  const tagged = name.includes(':') ? name : `${name}:latest`;
  return catalogue?.find((entry) => entry.value === name || entry.value === tagged);
}

/**
 * The model a session on a local provider would run: its own, else the row's default, else the first the row
 * lists. Null when nothing names one — a local provider has no catalogue default to fall back to, and the
 * built-in Claude default is not a model Ollama serves.
 */
export function localTargetModel(
  row: { defaultModel?: string | null; models?: unknown },
  sessionModel: string | null | undefined,
): string | null {
  const own = typeof sessionModel === 'string' ? sessionModel.trim() : '';
  if (own) return own;
  const fallback = typeof row.defaultModel === 'string' ? row.defaultModel.trim() : '';
  if (fallback) return fallback;
  const listed = Array.isArray(row.models) ? (row.models[0] as { value?: unknown } | undefined)?.value : undefined;
  return typeof listed === 'string' && listed.trim() ? listed.trim() : null;
}

/**
 * Whether a session may run on a runner-scoped provider now, and the refusal when it may not. The one rule
 * every door applies: session create, task create and start, the claim and the reclaim, a provider switch and
 * the reload that respawns on one.
 *
 * `runnerId` is the runner the session is (or would be) on, `runner` that runner's capability report, and
 * `model` the model it would run. Fails closed: a missing runner report, a missing probe and a missing
 * catalogue entry all refuse, and none of them is read as healthy.
 */
export function localProviderReadiness(
  row: {
    slug?: string | null;
    enabled: boolean;
    runnerId: string | null;
    probeState?: string | null;
    probedAt?: Date | string | null;
    instanceModels?: unknown;
  },
  target: {
    runnerId: string | null | undefined;
    runner: { capabilities?: readonly string[] | null; capabilitiesReportedAt?: Date | string | null } | null | undefined;
    model: string | null | undefined;
  },
  now: number = Date.now(),
): LocalProviderRefusal | null {
  const name = `"${row.slug ?? ''}"`;
  const refuse = (code: LocalProviderRefusalCode, rest: string): LocalProviderRefusal => ({
    code,
    transient: LOCAL_PROVIDER_TRANSIENT_REFUSALS.has(code),
    message: `${LOCAL_PROVIDER_ERROR_PREFIX}${name} ${rest}`,
  });
  if (!row.enabled) return refuse('LOCAL_PROVIDER_DISABLED', 'is disabled; enable it, or switch this session to another provider');
  if (!row.runnerId) {
    return refuse('LOCAL_PROVIDER_NO_RUNNER', 'runs only on its own runner, and it has none; bind it to one of your runners');
  }
  if (target.runnerId !== row.runnerId) {
    return refuse('LOCAL_PROVIDER_ELSEWHERE', 'runs only on the runner it is bound to; start this session on that runner');
  }
  const runner = target.runner;
  const runs = (runner?.capabilities ?? []).some((value) => value.trim().toLowerCase() === LOCAL_PROVIDER_RUN_CAPABILITY);
  if (!runner || runner.capabilitiesReportedAt == null || !declaresLocalProbe(runner.capabilities) || !runs) {
    return refuse('LOCAL_PROVIDER_RUNNER_OUTDATED', 'needs a newer runner: update the runner it is bound to');
  }
  const state = (LOCAL_PROBE_STATES as readonly string[]).includes(row.probeState ?? '') ? (row.probeState as LocalProbeState) : null;
  const probedAtMs = row.probedAt == null ? NaN : new Date(row.probedAt).getTime();
  if (!state || !Number.isFinite(probedAtMs)) {
    return refuse('LOCAL_PROVIDER_UNPROBED', 'has not been checked by its runner yet; this session starts once it is');
  }
  if (now - probedAtMs > LOCAL_PROBE_STALE_MS) {
    return refuse('LOCAL_PROVIDER_STALE', 'has not been checked recently; its runner may be offline. This session starts once it reports again');
  }
  if (state === 'UNREACHABLE') {
    return refuse('LOCAL_PROVIDER_UNREACHABLE', 'is not answering on its runner (stopped, still loading, or busy); this session starts once it answers');
  }
  if (state === 'MALFORMED' || state === 'REFUSED' || state === 'CLOUD_ENABLED') {
    return refuse('LOCAL_PROVIDER_MISCONFIGURED', 'is not an endpoint its runner can use; check its address on that runner');
  }
  if (state === 'NO_MODELS') return refuse('LOCAL_PROVIDER_NO_MODELS', 'serves no local model; pull one on its runner');
  // READY, MODEL_MISSING and CAPABILITY_MISSING describe the models the row names. The session runs one model,
  // and that model's own entry decides.
  const model = typeof target.model === 'string' ? target.model.trim() : '';
  if (!model) return refuse('LOCAL_PROVIDER_MODEL_MISSING', 'names no model; choose one of the models it serves');
  if (isCloudModelId(model)) {
    return refuse('LOCAL_PROVIDER_MISCONFIGURED', `would forward model "${model}" to Ollama's cloud; choose a local model`);
  }
  const catalogue = Array.isArray(row.instanceModels) ? (row.instanceModels as LocalInstanceModel[]) : null;
  const entry = localInstanceModel(catalogue, model);
  if (!entry) return refuse('LOCAL_PROVIDER_MODEL_MISSING', `does not serve model "${model}"; pull it on its runner or choose another`);
  if (entry.tools !== true) {
    return refuse('LOCAL_PROVIDER_CAPABILITY_MISSING', `serves model "${model}" without tool calling; choose a model with tools`);
  }
  if (typeof entry.contextWindow !== 'number' || entry.contextWindow < LOCAL_MIN_CONTEXT_WINDOW) {
    return refuse(
      'LOCAL_PROVIDER_CAPABILITY_MISSING',
      `serves model "${model}" with less than ${LOCAL_MIN_CONTEXT_WINDOW} tokens of context; choose a larger model`,
    );
  }
  return null;
}
