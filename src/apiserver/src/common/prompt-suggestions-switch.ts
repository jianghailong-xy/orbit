import { AgentProvider } from '@orbit/shared';

/**
 * Whether an account wants the engine's guess at its next message after each turn (Settings →
 * Suggested replies; docs/prompt-suggestions-design.md). On unless the owner turned it off: only
 * opting out is ever written, like the notification switches.
 *
 * `owner` is required rather than optional so a read that forgot to select it fails to compile
 * instead of quietly answering "on".
 */
export function promptSuggestionsEnabled(owner: { preferences: unknown }): boolean {
  const prefs = (owner.preferences ?? {}) as { promptSuggestions?: unknown };
  return prefs.promptSuggestions !== false;
}

/** The run sources a person converses in: sessions they opened, and a project's coordinator. A
 *  task list's automatic run is read by nobody while it works, so a guess at their next message
 *  there is a request paid for and never seen — as is one in a session another session spawned
 *  (`spawnDepth` above 0), whose messages come from the agent that drives it. */
const CONVERSED_RUN_SOURCES: ReadonlySet<string> = new Set(['MANUAL', 'PROJECT_COORDINATOR']);

/**
 * Whether a claim (or reclaim) asks for a next-message guess after each turn (design §3.1): the
 * owner wants them, and a person converses in the session. What the flag means depends on the engine. Claude Code is spawned with `--prompt-suggestions`, and
 * the suggestion is one more request on the session's own account or key, so only an endpoint the
 * suggestion was measured on qualifies — any other configured provider's endpoint (the
 * ANTHROPIC_BASE_URL its env injects) leaves it off. Every other engine has no such flag
 * (design §1.2): the runner asks the server to generate the guess with DeepSeek instead
 * (design §8 P2), which only a server holding a DeepSeek key can answer.
 */
export function claimPromptSuggestions(claim: {
  /** Optional like resolvePermissionMode's: the claim reads it beside that, from the same row. */
  owner: { preferences?: unknown } | null | undefined;
  provider: string;
  runSource: string;
  /** How many sessions sit above this one; 0 for a session a person opened. */
  spawnDepth: number;
  env: Record<string, string> | null | undefined;
}): boolean {
  if (
    !CONVERSED_RUN_SOURCES.has(claim.runSource) ||
    claim.spawnDepth > 0 ||
    !promptSuggestionsEnabled({ preferences: claim.owner?.preferences })
  ) {
    return false;
  }
  if (claim.provider === AgentProvider.CLAUDE) {
    return talksToMeasuredEndpoint(claim.env);
  }
  return !!process.env.DEEPSEEK_API_KEY?.trim();
}

/** The endpoints the suggestion request has been measured on (design §1.3): Anthropic's own, which
 *  an unset ANTHROPIC_BASE_URL means, and DeepSeek's Anthropic-compatible one. */
const MEASURED_ENDPOINTS: ReadonlySet<string> = new Set([
  '',
  'https://api.anthropic.com',
  'https://api.deepseek.com/anthropic',
]);

function talksToMeasuredEndpoint(env: Record<string, string> | null | undefined): boolean {
  const base = (env?.ANTHROPIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return MEASURED_ENDPOINTS.has(base);
}
