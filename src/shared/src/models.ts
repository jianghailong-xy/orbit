import { AgentProvider } from './enums';

/** The model each provider falls back to when neither the session nor its agent pins one.
 *  Mirrors the clients' defaults (web `lib/agentDefaults` DEFAULT_MODEL_BY_PROVIDER, Swift
 *  `AgentDefaults.defaultModel(for:)`). Kept here so the server has a single source of truth. */
export const DEFAULT_MODEL_BY_PROVIDER: Record<AgentProvider, string> = {
  [AgentProvider.CLAUDE]: 'claude-opus-4-8',
  [AgentProvider.CODEX]: 'gpt-5.5',
};

/** Resolve the model to run for a provider, guarding against a cross-provider mismatch.
 *
 *  A per-session or per-agent override normally wins, but a model whose id clearly belongs to a
 *  *different* provider is coerced to the provider's default. A `claude-*` id on a Codex session
 *  used to reach the runner verbatim, which then ran `codex -m claude-opus-4-8` — the ChatGPT
 *  backend rejects that with a 400 ("model is not supported when using Codex with a ChatGPT
 *  account"). This is the server-side backstop, so no client version or stale row can produce that
 *  mismatch at dispatch.
 *
 *  Only the unambiguous `claude-*` / `gpt-*` prefixes are policed; unknown/custom ids (e.g. an
 *  `ANTHROPIC_MODEL` endpoint override) pass through untouched. */
export function modelForProvider(provider: AgentProvider, override?: string | null): string {
  const fallback = DEFAULT_MODEL_BY_PROVIDER[provider];
  // `||` (not `??`) so a blank override ('' from a degenerate row) also falls back to the default
  // rather than reaching the runner as `-m ''`.
  const model = override || fallback;
  if (provider === AgentProvider.CODEX && model.startsWith('claude-')) return fallback;
  if (provider === AgentProvider.CLAUDE && model.startsWith('gpt-')) return fallback;
  return model;
}
