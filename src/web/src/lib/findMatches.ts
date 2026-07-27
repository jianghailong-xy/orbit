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
   * splits a sentence across `<strong>`/`<code>`/`<a>` nodes and "the **bold** bit" still has to
   * match — but never across two, so the tail of one message can't match into the head of the next.
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
 * Every case-insensitive occurrence of `query`, in document order.
 *
 * `limit` caps the work one keystroke can cause: a single-character query against a long
 * transcript matches thousands of times, and past the first few hundred the extra Ranges only cost
 * paint time to produce a count nobody reads.
 */
export function findMatches(segments: FindSegment[], query: string, limit = 500): FindMatch[] {
  if (!query) return [];
  const out: FindMatch[] = [];
  // Case-insensitivity through the regex engine rather than toLowerCase(): lowercasing can change
  // a string's length (İ → i̇), which would silently shift every offset after it.
  const re = new RegExp(escapeRegExp(query), 'gi');
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
