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
  /** Event-type-specific data (text delta, tool name+input, result summary, ...). */
  payload: Record<string, unknown>;
}

export const emptyUsage = (): TokenUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});
