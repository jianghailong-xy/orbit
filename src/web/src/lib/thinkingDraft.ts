/**
 * What to keep from a stretch of reasoning when its durable `thinking` event lands.
 *
 * The reasoning itself only ever arrives as `thinking_delta` — broadcast, never persisted. The
 * durable event that closes the block is supposed to carry the same text in full, and for codex,
 * kimi and opencode it does. Claude's does not: its block is `{"thinking":"","signature":"CAIS…"}`,
 * so the authoritative text is an empty string, and DeepSeek (an Anthropic-compatible endpoint
 * driving the same CLI) lands empty for about a third of its blocks. Measured on this deployment:
 * 105,315 of 124,524 durable `thinking` rows carry no text at all.
 *
 * Clearing the live draft on such an event is what made a block's reasoning vanish at the exact
 * moment it finished — the draft went, and the node that should have replaced it was skipped for
 * having no text. So the client keeps what it streamed: the draft is written into the event's
 * payload as it enters the local transcript, which is a client-side copy and never sent back. A
 * reload still reads the server's empty text and still renders nothing, which is deliberate —
 * historical rows would otherwise turn into a wall of blank "Thinking" rows (claude averages 23.8
 * blocks per turn). Making it survive a reload is the runner's job, not this one's.
 *
 * `thinkingMs` is likewise client-side only: how long the block took is knowable while it streams
 * and nowhere afterwards, since the deltas carry no clock into the log.
 */
export interface ThinkingPatch {
  text?: string;
  thinkingMs?: number;
}

export function settleThinking(
  durableText: unknown,
  draft: string,
  startedAt: number | null,
  now: number,
): ThinkingPatch {
  const patch: ThinkingPatch = {};
  // Only when the provider left it empty — a provider that reported its reasoning is the
  // authority on it, and the draft may already hold the NEXT block's first chunks.
  if (!durableText && draft) patch.text = draft;
  // A stretch that began before this page was open (a reload mid-turn) has no start to measure
  // from, so it reports no duration rather than a wrong one.
  if (startedAt !== null && now > startedAt) patch.thinkingMs = now - startedAt;
  return patch;
}

/** How a settled block's duration reads on its folded row: whole seconds under a minute. */
export function formatThinkingDuration(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rest = secs % 60;
  return rest ? `${mins}m ${rest}s` : `${mins}m`;
}

/**
 * The size of a block, as the folded row states it — what tells a reader whether opening it is
 * worth it. Characters rather than words: the reasoning is as often CJK as English, and a word
 * count reads as 1 for a whole Chinese paragraph.
 */
export function formatThinkingSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(1).replace(/\.0$/, '')}k chars`;
}
