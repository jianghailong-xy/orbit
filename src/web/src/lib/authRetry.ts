interface RetryEvent {
  type: string;
  payload?: unknown;
}

/**
 * Recover the message offered by an authentication-error card.
 *
 * Usually the runner emitted a user event before credentials expired. A first-run auth preflight
 * fails earlier than that, so a zero-turn session has no user event; its stored opening prompt is
 * still the message the user expects to retry after signing in.
 */
export function authRetryText(
  events: RetryEvent[],
  openingPrompt?: string | null,
  numTurns?: number,
): string {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'user') continue;
    const text = (events[i].payload as { text?: unknown } | undefined)?.text;
    if (typeof text === 'string' && text.trim()) return text;
  }
  return numTurns === 0 && openingPrompt?.trim() ? openingPrompt : '';
}
