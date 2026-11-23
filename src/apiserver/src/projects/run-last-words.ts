/** How much of what a run said last is copied into a message about it. */
const LAST_WORDS_LIMIT = 1_200;

/**
 * What a run said last (`session.last_assistant_text`), as a message about it quotes it: trimmed, cut at
 * {@link LAST_WORDS_LIMIT} characters with an ellipsis, null when it said nothing. Revision 32's
 * `TASK_RUN_STOPPED` takes it this way, and revision 42's hand-back (§12.5 W7, `workSession.lastMessage`) the same.
 */
export function runLastWords(text: string | null | undefined): string | null {
  const words = text?.trim() ?? '';
  if (!words) return null;
  return words.length > LAST_WORDS_LIMIT ? `${words.slice(0, LAST_WORDS_LIMIT)}…` : words;
}
