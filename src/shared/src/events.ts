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
