/**
 * Query normalization for session search (GET /sessions/search).
 *
 * Split out as a pure function because two things here are easy to get subtly wrong and both are
 * worth pinning down in tests: the LIKE-wildcard escaping (a user typing `%` or `_` must match
 * those characters literally, not turn their query into a match-everything pattern) and the
 * content-search floor.
 */

/**
 * Minimum query length before the long text bodies — prompts, replies, and conversation
 * messages — are searched at all.
 *
 * The floor starts as a property of the trigram index, not a product preference. A `%xx%` pattern
 * with fewer than 3 characters contains no trigram that MUST appear in a match, so the GIN index
 * returns every indexed row and Postgres rechecks them all: measured at 533ms for a 2-character
 * Chinese query against 36.6k messages, versus 4.7ms for a 4-character one.
 *
 * Below the floor the search narrows to the short "name" columns (title, branch, agent, task) and
 * skips the multi-KB bodies entirely — 4.4ms instead of 128ms on the same data. That turned out
 * to be the better product answer too, not just the faster one: one or two characters matched
 * inside a 7 KB prompt is noise (512 hits versus 51), and a query that short is nearly always a
 * name the user is still typing. Clients are told via `contentSearched: false`.
 */
export const CONTENT_MIN_CHARS = 3;

/** Upper bound on a query, so a pasted wall of text can't become a pathological LIKE pattern. */
const MAX_QUERY_CHARS = 200;

export interface NormalizedSearchQuery {
  /** The trimmed, length-capped query, unescaped — for `strpos` when locating the match. */
  raw: string;
  /** `%…%`, with LIKE metacharacters escaped, for the ILIKE comparison. */
  pattern: string;
  /** Whether this query clears the trigram floor, and so may search the long text bodies
   *  (prompts, replies, conversation messages) rather than just the short name columns. */
  searchContent: boolean;
}

/** Escape the three characters LIKE treats specially (default escape char is `\`). */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Drop the markdown marks that sit between what's stored and what the user actually read: a reply
 * persisted as "the **merge** button" renders as "the merge button", and searching the phrase they
 * saw has to find it. Applied to the in-session search's corpus (in SQL) and to its query here, so
 * the two always agree.
 *
 * `*` and backticks only. `_` is a character in half the identifiers anyone would search for
 * (snake_case, `file_path`), not decoration, so stripping it would do more harm than good.
 */
export const stripEmphasis = (s: string): string => s.replace(/[*`]/g, '');

/**
 * Normalize a raw `q`. Returns null for an empty/whitespace-only query — the caller answers that
 * with recents rather than running a search that would match every row.
 */
export function normalizeSearchQuery(q: string | undefined | null): NormalizedSearchQuery | null {
  const raw = (q ?? '').trim().slice(0, MAX_QUERY_CHARS);
  if (raw.length === 0) return null;
  return {
    raw,
    pattern: `%${escapeLike(raw)}%`,
    // Count by code points, not UTF-16 units: an emoji is one character to the user and one
    // "character" to pg_trgm, but `.length` would count it as two and wrongly clear the floor.
    searchContent: [...raw].length >= CONTENT_MIN_CHARS,
  };
}
