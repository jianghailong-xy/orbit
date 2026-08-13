import { AgentProvider } from './enums';

/** The model each provider falls back to when neither the session nor its Runtime supplies one.
 *  Mirrors the clients' defaults (web `lib/agentDefaults` DEFAULT_MODEL_BY_PROVIDER, Swift
 *  `AgentDefaults.defaultModel(for:)`). Kept here so the server has a single source of truth. */
export const DEFAULT_MODEL_BY_PROVIDER: Record<AgentProvider, string> = {
  [AgentProvider.CLAUDE]: 'claude-opus-5',
  [AgentProvider.CODEX]: 'gpt-5.6-sol',
  [AgentProvider.KIMI]: 'kimi-code/kimi-for-coding',
  // OpenCode is a multi-provider runtime. An empty model deliberately omits `--model`,
  // leaving selection to OpenCode (configured/default for a new session, current model
  // for an existing runtime session).
  [AgentProvider.OPENCODE]: '',
};

/**
 * Whether a stored model id has been retired — the provider still runs, but no longer offers this
 * model, so keeping it pinned means a session quietly stays a generation behind forever. A retired
 * id yields to the provider's current default everywhere: the pickers show that default rather than
 * a dead id nobody can act on, and dispatch runs it, so the two can never disagree.
 *
 * `offered` is the same list the picker draws (the runner's live catalogue for a built-in runtime
 * or a vendor on its own endpoint; a configured third-party's own models otherwise) — callers pass
 * the list for the model's own space, never another provider's.
 *
 * Three deliberate escapes, each protecting an id that is legitimately absent from that list:
 *  - a blank model — OpenCode's "you pick" sentinel is a choice, not a stale value;
 *  - an unknown/empty list — a runner that hasn't reported a catalogue yet can't retire anything,
 *    and treating silence as "offers nothing" would wipe every pin the moment one goes offline;
 *  - the Runtime's own reported default — `claude`'s settings.json may name an alias (`opus`,
 *    `opusplan`, `best`) or a gateway id that the quick-pick catalogue never lists. The runtime
 *    vouching for it is exactly what makes it current.
 */
export function isRetiredModel(
  model: string | null | undefined,
  offered: ReadonlyArray<{ value?: unknown }> | null | undefined,
  runtimeDefault?: string | null,
): boolean {
  const id = model?.trim();
  if (!id) return false;
  if (!offered || offered.length === 0) return false;
  if (id === runtimeDefault?.trim()) return false;
  return !offered.some((row) => row && row.value === id);
}

/** Resolve the model to run for a provider, guarding against a cross-provider mismatch.
 *
 *  A per-session or Runtime-derived value normally wins, but a model whose id clearly belongs to a
 *  *different* provider is coerced to the provider's default. A `claude-*` id on a Codex session
 *  used to reach the runner verbatim, which then ran `codex -m claude-opus-4-8` — the ChatGPT
 *  backend rejects that with a 400 ("model is not supported when using Codex with a ChatGPT
 *  account"). This is the server-side backstop, so no client version or stale row can produce that
 *  mismatch at dispatch.
 *
 *  Only unambiguous built-in prefixes are policed; unknown/custom ids (e.g. an
 *  `ANTHROPIC_MODEL` endpoint override) pass through untouched. */
export function modelForProvider(provider: AgentProvider, override?: string | null): string {
  const fallback = DEFAULT_MODEL_BY_PROVIDER[provider];
  // `||` (not `??`) so a blank override ('' from a degenerate row) also falls back to the default
  // rather than reaching the runner as `-m ''`.
  const model = override || fallback;
  // OpenCode's selector is always `provider/model`. A provider-only API patch from an older
  // client can leave the prior runtime's model on the agent; omit that invalid bare id instead
  // of passing it to the CLI. A namespaced id is opaque here — it may legitimately name any
  // upstream provider (`anthropic/…`, `kimi-code/…`), so the prefix guards below must not
  // police it.
  if (provider === AgentProvider.OPENCODE) return model.includes('/') ? model : fallback;
  const isClaudeModel = model.startsWith('claude-');
  const isCodexModel = model.startsWith('gpt-');
  const isKimiModel = model.startsWith('kimi-') || model.startsWith('kimi-code/');
  if (provider !== AgentProvider.CLAUDE && isClaudeModel) return fallback;
  if (provider !== AgentProvider.CODEX && isCodexModel) return fallback;
  if (provider !== AgentProvider.KIMI && isKimiModel) return fallback;
  return model;
}
