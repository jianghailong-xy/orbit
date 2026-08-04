import { RunEventType } from './enums';

/** Token usage as reported by Claude Code (`result.usage`). */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Per-model cost/token breakdown (`result.modelUsage`). */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
}

/**
 * One normalized event in a run's stream. The runner translates Claude Code SDK
 * messages (or `claude -p --output-format stream-json` events) into this shape,
 * the control plane persists it (run_events), and the UI replays it over SSE.
 */
export interface NormalizedRunEvent {
  /** Monotonic per-run sequence, assigned by the runner. */
  seq: number;
  type: RunEventType;
  /** ISO-8601 timestamp from the runner. */
  ts: string;
  /** conversation_turn.id that produced this event; absent for session-level events. */
  turnId?: string;
  /** Event-type-specific data (text delta, tool name+input, result summary, ...). */
  payload: Record<string, unknown>;
}

export const emptyUsage = (): TokenUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

/**
 * Does an assistant message / result text carry a Claude Code API error (e.g. content
 * filtering, a 4xx/5xx)? Such errors surface as an `assistant` text block followed by a
 * `result` with subtype `success` and no `is_error` flag — so failure detection that only
 * trusts `is_error`/`subtype` misses them. We key on the stable `API Error:` prefix Claude
 * Code uses. Heuristic, intentionally narrow; keep in sync with the runner's Go check.
 */
export function isApiErrorText(text: string | null | undefined): boolean {
  return !!text && text.trimStart().startsWith('API Error');
}

/**
 * Does an assistant message / result text carry a *sign-in* failure — the runtime's stored
 * credentials being gone, expired or rejected ("Failed to authenticate: OAuth session expired
 * and could not be refreshed")? Like an API error this arrives as plain `assistant` text with a
 * `success` result, so nothing upstream treats the turn as failed; unlike one it is not
 * retryable by the model, and the remedy is a human action on the runner (or in Providers).
 * Kept separate from `isApiErrorText` precisely because the remedy differs — the UI shows
 * sign-in guidance rather than a bare error line.
 *
 * Keys on the runtime's stable `Failed to authenticate` prefix. Heuristic, intentionally
 * narrow; keep in sync with the runner's Go check (isAuthError in claude.go).
 */
export function isAuthErrorText(text: string | null | undefined): boolean {
  return !!text && text.trimStart().startsWith('Failed to authenticate');
}

/**
 * Wording, in the provider's own words, that marks a run as killed by an exhausted account
 * quota rather than by anything about the run itself. Only messages actually observed in the
 * wild are listed (`session.error` on a FAILED run); add one when a new runtime's message
 * shows up rather than guessing at its phrasing.
 *
 * Also used as a SQL `contains` filter, so keep every entry a plain lowercase substring.
 */
export const USAGE_LIMIT_ERROR_MARKERS = [
  // Codex app-server: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/
  // usage to purchase more credits or try again at Aug 9th, 2026 1:26 PM."
  'hit your usage limit',
  // Claude Code, rolling 5-hour window: "You've hit your session limit · resets 6:20pm
  // (Europe/Berlin)". Arrives as plain `assistant` text with a `success` result — same path
  // as an API error, so nothing upstream treats the turn as failed.
  'hit your session limit',
  // Claude Code, 7-day window: "You've hit your weekly limit · resets 1pm (Europe/Berlin)".
  // The date is present only when the reset is not today ("resets Aug 3, 1pm (…)").
  'hit your weekly limit',
];

/**
 * Was this run killed by the account's provider quota running out? Such a failure says
 * nothing about the task — every retry fails identically until the quota window resets — so
 * schedulers must not hold it against the task. Classifies a failure *after* the fact; the
 * authoritative answer to "when can work resume" is the runner's own quota snapshot
 * (`planUsageBlockedUntil`), which reports a machine-readable reset time.
 */
export function isUsageLimitErrorText(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return USAGE_LIMIT_ERROR_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Does an engine's stderr line say nothing about this session? Claude Code prints
 * "⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is
 * set …" on every start when an auth token is in its environment — which is exactly how a
 * configured ModelProvider (DeepSeek, …) borrows the claude runtime: the control plane injects
 * ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL so the CLI talks to the provider's endpoint
 * (custom-provider.ts). Its advice — unset the key — would break the very provider the user
 * picked, and stderr renders as an error line, so every DeepSeek session opened on what looked
 * like a failed turn.
 *
 * Deliberately one known line rather than a "warnings aren't errors" rule: the reason stderr is
 * surfaced at all is that a runtime's only account of why it failed to come up arrives there.
 */
export function isBenignEngineStderr(line: string | null | undefined): boolean {
  return !!line && line.includes('claude.ai connectors are disabled');
}

/**
 * A tool_result payload's text, flattened. Claude Code delivers `content` as either a plain
 * string or an array of `{ type, text }` blocks; both collapse to one string here.
 */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === 'object' ? String((b as { text?: unknown }).text ?? '') : ''))
      .join('');
  return '';
}

/**
 * Does a top-level tool_result mark the *launch* of an async sub-agent (a Task/Agent run in the
 * background) rather than a real completion? Claude Code returns "Async agent launched
 * successfully. …" as internal metadata the instant a background agent starts; that agent runs on
 * and reports completion later via a <task-notification> (a background_task event). A synchronous
 * sub-agent has no such ack — its only top-level tool_result IS the completion. This tells the two
 * apart when deciding whether a tracked sub-agent is still in flight.
 */
export function isAsyncAgentLaunchAck(content: unknown): boolean {
  return toolResultText(content).includes('Async agent launched');
}
