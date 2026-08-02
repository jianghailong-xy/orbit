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
