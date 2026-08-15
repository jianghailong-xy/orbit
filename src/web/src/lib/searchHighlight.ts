/**
 * Splitting a search snippet into matched / unmatched runs — for the ⌘K palette's rows and for
 * in-session find's.
 *
 * The server sends the snippet with its whitespace already collapsed, so it can't also send a
 * match offset — collapsing shifts every position. The match is therefore located client-side,
 * which is what this does. Pure, and separated from the component because the interesting cases
 * (repeats, adjacent matches, a query that survives collapsing on one side only) are all
 * off-by-one territory.
 */

import { queryWords } from './findMatches';

export interface HighlightSegment {
  text: string;
  match: boolean;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Split `text` into consecutive segments, marking the phrase and each word of `query` — the same
 * pair the server matched on, since which of the two admitted a given row isn't reported (see
 * `queryWords`). Returns a single unmatched segment when the query is empty or absent: the caller
 * renders the snippet either way, so a miss degrades to plain text rather than dropping the row.
 */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  if (!text) return [];
  const needles = queryWords(query);
  if (!needles.length) return [{ text, match: false }];
  // One alternation, longest needle first, so the phrase wins over its own words where it is
  // present and a long word wins over a short one it contains.
  //
  // Case-insensitivity through the regex engine rather than toLowerCase(): lowercasing can change
  // a string's length (İ → i̇), which would shift every offset after it.
  const re = new RegExp(needles.map(escapeRegExp).join('|'), 'gi');
  const out: HighlightSegment[] = [];
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) break; // defensive: a zero-width match would never advance
    if (m.index > at) out.push({ text: text.slice(at, m.index), match: false });
    out.push({ text: m[0], match: true });
    at = m.index + m[0].length;
  }
  if (out.length === 0) return [{ text, match: false }];
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out;
}
