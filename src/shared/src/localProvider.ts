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
 * The token handed to an engine whose CLI insists on one when the provider takes none. Built into the
 * engine's environment at dispatch, in memory, and never stored: it is not a secret, and it is what keeps
 * Claude Code from sending the runner's own Claude sign-in to the local endpoint instead.
 */
export const LOCAL_AUTH_PLACEHOLDER = 'ollama';

/** What the runner's last probe of the instance found (written by the runner, phase 2). */
export const LOCAL_PROBE_STATES = ['READY', 'UNREACHABLE', 'MALFORMED', 'CLOUD_ENABLED'] as const;
export type LocalProbeState = (typeof LOCAL_PROBE_STATES)[number];

/**
 * Where a runner-scoped provider stands, as a client shows it. UNKNOWN is its own answer, never a stand-in
 * for health: no probe yet, or a runner that cannot probe. DISABLED and NO_RUNNER are the row's own
 * reasons not to run (the owner switched it off; its runner was removed or is no longer theirs).
 */
export type LocalProviderState = LocalProbeState | 'UNKNOWN' | 'DISABLED' | 'NO_RUNNER';

/** Whether the bound runner can probe the instance at all: SUPPORTED, or UNKNOWN for an older runner. */
export type LocalProbeCapability = 'SUPPORTED' | 'UNKNOWN';

/** One model the instance serves, as the runner discovered it. */
export interface LocalInstanceModel {
  value: string;
  label?: string;
  contextWindow?: number;
  /** Whether the model advertises tool calling; absent when the runner could not tell. */
  tools?: boolean;
}

/** A runner-scoped provider's status block on a provider read. Never an endpoint or a key. */
export interface LocalProviderStatus {
  state: LocalProviderState;
  capability: LocalProbeCapability;
  probedAt: string | null;
  /** The server's version, as it reported it (e.g. Ollama 0.40.16). */
  version: string | null;
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
 * passed only when it is still the row owner's: anyone else's runner is no runner here.
 */
export function localProviderStatus(
  row: {
    enabled: boolean;
    probeState: string | null;
    probedAt: Date | string | null;
    probeVersion: string | null;
    instanceModels: unknown;
  },
  runner: { capabilities: readonly string[] | null; capabilitiesReportedAt: Date | string | null } | null,
): LocalProviderStatus {
  const capability: LocalProbeCapability =
    runner && runner.capabilitiesReportedAt != null && declaresLocalProbe(runner.capabilities) ? 'SUPPORTED' : 'UNKNOWN';
  const probed = (LOCAL_PROBE_STATES as readonly string[]).includes(row.probeState ?? '')
    ? (row.probeState as LocalProbeState)
    : null;
  const state: LocalProviderState = !row.enabled
    ? 'DISABLED'
    : !runner
      ? 'NO_RUNNER'
      : capability === 'UNKNOWN' || !probed
        ? 'UNKNOWN'
        : probed;
  const probedAt = row.probedAt == null ? null : new Date(row.probedAt).toISOString();
  return {
    state,
    capability,
    probedAt,
    version: row.probeVersion ?? null,
    models: Array.isArray(row.instanceModels) ? (row.instanceModels as LocalInstanceModel[]) : null,
  };
}
