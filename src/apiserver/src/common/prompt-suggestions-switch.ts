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
 * Whether a claim (or reclaim) spawns Claude Code with `--prompt-suggestions` (design §3.1): the
 * owner wants them, the engine is Claude talking to an endpoint the suggestion was measured on, a
 * person converses in the session, and it is not a Wiki maintenance run. The suggestion is one
 * more request on the session's own account or key, so any other configured provider's endpoint
 * (the ANTHROPIC_BASE_URL its env injects) leaves it off.
 */
export function claimPromptSuggestions(claim: {
  /** Optional like resolvePermissionMode's: the claim reads it beside that, from the same row. */
  owner: { preferences?: unknown } | null | undefined;
  provider: string;
  runSource: string;
  /** How many sessions sit above this one; 0 for a session a person opened. */
  spawnDepth: number;
  /** The session's Wiki maintenance run, null for every other session. */
  maintenance: unknown;
  env: Record<string, string> | null | undefined;
}): boolean {
  return (
    claim.provider === AgentProvider.CLAUDE &&
    CONVERSED_RUN_SOURCES.has(claim.runSource) &&
    !(claim.spawnDepth > 0) &&
    claim.maintenance == null &&
    talksToMeasuredEndpoint(claim.env) &&
    promptSuggestionsEnabled({ preferences: claim.owner?.preferences })
  );
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
