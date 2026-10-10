/**
 * Which of an account's quota windows a usage-limit failure says ran out, in the runtime's own
 * terms. Keyed on the whole phrase the runtime uses ("hit your weekly limit"), not on "weekly limit"
 * loose in the text: naming the wrong window tells the reader to wait days for a quota that comes
 * back in hours. Codex names no window at all, and is `OTHER`.
 *
 * One judgment for both places that name the window: the transcript's quota notice
 * (`Transcript.tsx`) and the pause line of an evidence version waiting for its coordinator
 * (`EvidenceDecisionCard.tsx`), so the card can never name another window than the notice above it.
 * Whether a failure is a usage limit at all is `isUsageLimitErrorText`'s answer, not this one's.
 */
export type QuotaWindowKind = 'FIVE_HOUR' | 'WEEKLY' | 'OTHER';

export function quotaWindowKind(message: string): QuotaWindowKind {
  const m = message.toLowerCase();
  if (m.includes('hit your session limit')) return 'FIVE_HOUR';
  if (m.includes('hit your weekly limit')) return 'WEEKLY';
  return 'OTHER';
}
