/**
 * Splitting a search snippet into matched / unmatched runs, for the ⌘K palette's highlight.
 *
 * The server sends the snippet with its whitespace already collapsed, so it can't also send a
 * match offset — collapsing shifts every position. The match is therefore located client-side,
 * which is what this does. Pure, and separated from the component because the interesting cases
 * (repeats, adjacent matches, a query that survives collapsing on one side only) are all
 * off-by-one territory.
 */

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split `text` into consecutive segments, marking every case-insensitive occurrence of `query`.
 * Returns a single unmatched segment when the query is empty or absent — the caller renders the
 * snippet either way, so a miss degrades to plain text rather than dropping the row.
 */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  // Collapse the query the same way the server collapsed the snippet, or a query typed with a
  // double space would never be found in a snippet that now has one.
  const needle = query.trim().replace(/\s+/g, ' ');
  if (!text) return [];
  if (!needle) return [{ text, match: false }];

  const hay = text.toLowerCase();
  const lower = needle.toLowerCase();
  const out: HighlightSegment[] = [];
  let at = 0;
  for (;;) {
    const found = hay.indexOf(lower, at);
    if (found === -1) break;
    if (found > at) out.push({ text: text.slice(at, found), match: false });
    out.push({ text: text.slice(found, found + needle.length), match: true });
    at = found + needle.length;
  }
  if (out.length === 0) return [{ text, match: false }];
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out;
}
