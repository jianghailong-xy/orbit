import { searchTerms } from '@orbit/shared';

/**
 * The matching half of in-session find (⌘F).
 *
 * Deliberately DOM-free, so it can be tested in vitest's node environment: the caller flattens the
 * transcript's text nodes into segments, this maps a query onto them, and the caller turns the
 * segment offsets it returns back into DOM Ranges.
 */

export interface FindSegment {
  /** The segment's text, in document order. */
  text: string;
  /**
   * Which block the segment sits in. A match may span segments *within* one block — markdown
   * splits words across `<strong>`/`<code>`/`<a>` nodes and "**mer**ge" still has to match — but
   * never across two, so the tail of one message can't match into the head of the next.
   */
  block: number;
}

/** One occurrence, as a half-open range over the segments: [start, end). */
export interface FindMatch {
  startSeg: number;
  startOffset: number;
  endSeg: number;
  endOffset: number;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What to paint for `query`: the phrase, and the words it broadens to.
 *
 * The server matches the phrase first and falls back to every word (see `broaden`), and which of
 * the two produced a given hit isn't reported — so the client paints both. That is also the right
 * answer visually: on a phrase hit the words tile back into one continuous highlight, and on a
 * word hit each word lights up where it actually is.
 *
 * Marks are dropped for the same reason the server drops them from both corpus and query: the
 * transcript renders "the **merge** button" as plain text, so a query pasted back with its
 * asterisks would find the event server-side and then light up nothing on screen.
 *
 * Sorted longest first because the caller alternates them in one regex, where the leftmost branch
 * that matches at a position wins — "the" ahead of "there" would mark half a word, and the phrase
 * ahead of its own words is what keeps a phrase hit painted as one run.
 */
export function queryWords(query: string): string[] {
  // Whitespace is collapsed in the phrase for the palette's sake: the server collapses a snippet
  // before sending it, so a query typed with a double space would never be found in one.
  const phrase = query.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
  if (!phrase) return [];
  // A term's alternatives are flattened in: only the ones actually present can match anything,
  // and painting is not where the AND/OR distinction has to be honoured.
  return [...new Set([phrase, ...searchTerms(phrase).flat()])].sort((a, b) => b.length - a.length);
}

/**
 * Every case-insensitive occurrence of any word of `query`, in document order.
 *
 * `limit` caps the work one keystroke can cause: a single-character query against a long
 * transcript matches thousands of times, and past the first few hundred the extra Ranges only cost
 * paint time to produce a count nobody reads.
 */
export function findMatches(segments: FindSegment[], query: string, limit = 500): FindMatch[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const out: FindMatch[] = [];
  // Case-insensitivity through the regex engine rather than toLowerCase(): lowercasing can change
  // a string's length (İ → i̇), which would silently shift every offset after it.
  const re = new RegExp(words.map(escapeRegExp).join('|'), 'gi');
  let i = 0;
  while (i < segments.length && out.length < limit) {
    // Gather one block's run of consecutive segments, and match inside it — so offsets can never
    // cross a block boundary and no separator sentinel is needed to keep them apart.
    const from = i;
    const block = segments[i].block;
    const starts: number[] = [];
    let text = '';
    while (i < segments.length && segments[i].block === block) {
      starts.push(text.length);
      text += segments[i].text;
      i++;
    }
    re.lastIndex = 0;
    for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
      if (m[0].length === 0) break; // defensive: a zero-width match would never advance
      const end = m.index + m[0].length;
      const st = locate(starts, m.index);
      // end - 1, so a match ending exactly on a boundary closes at the end of the segment that
      // holds its last character instead of at offset 0 of whatever text node comes next.
      const en = locate(starts, end - 1);
      out.push({
        startSeg: from + st,
        startOffset: m.index - starts[st],
        endSeg: from + en,
        endOffset: end - starts[en],
      });
    }
  }
  return out;
}

/** Flat offset within a block's text → the index of the segment that holds it. */
function locate(starts: number[], offset: number): number {
  // Segments per block are few, so scanning back from the end beats a binary search's ceremony.
  let s = starts.length - 1;
  while (s > 0 && starts[s] > offset) s--;
  return s;
}
