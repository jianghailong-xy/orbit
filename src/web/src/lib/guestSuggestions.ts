import type { SessionGuestSuggestion } from '@orbit/shared';

/** How many people the email field of People who can reply suggests at once (board share-links/14). */
export const GUEST_SUGGESTIONS_SHOWN = 5;

/** The part of a name or email that matched what was typed, to draw bold: [start, end). */
export type MatchRange = readonly [number, number];

export interface GuestSuggestionMatch {
  person: SessionGuestSuggestion;
  name: MatchRange | null;
  email: MatchRange | null;
}

/** Where `query` starts one of the words of `text` split by `separators`, or the whole of it. */
function prefixMatch(text: string, query: string, separators: RegExp): MatchRange | null {
  const lower = text.toLowerCase();
  if (lower.startsWith(query)) return [0, query.length];
  for (const m of lower.matchAll(separators)) {
    const start = m.index + m[0].length;
    if (lower.startsWith(query, start)) return [start, start + query.length];
  }
  return null;
}

/**
 * The suggestions for what the email field holds. Empty: the newest five. Typed: the people whose name or email has
 * a word starting with it (name words split on spaces, email words on @ . _ + -), newest first, five at most. None once
 * the field holds one of their emails exactly, so a picked suggestion closes the list.
 */
export function matchGuestSuggestions(people: readonly SessionGuestSuggestion[], typed: string): GuestSuggestionMatch[] {
  const query = typed.trim().toLowerCase();
  if (query === '') {
    return people.slice(0, GUEST_SUGGESTIONS_SHOWN).map((person) => ({ person, name: null, email: null }));
  }
  if (people.some((p) => p.email.toLowerCase() === query)) return [];
  const matches: GuestSuggestionMatch[] = [];
  for (const person of people) {
    const name = prefixMatch(person.name, query, /\s+/g);
    const email = prefixMatch(person.email, query, /[@._+-]/g);
    if (name || email) matches.push({ person, name, email });
    if (matches.length === GUEST_SUGGESTIONS_SHOWN) break;
  }
  return matches;
}

/** When the owner last invited them, as the row's end says it: Today, or the month and day. */
export function lastInvitedLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (at.toDateString() === now.toDateString()) return 'Today';
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
