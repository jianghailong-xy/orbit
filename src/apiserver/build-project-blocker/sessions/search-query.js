"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripEmphasis = exports.CONTENT_MIN_CHARS = void 0;
exports.broaden = broaden;
exports.normalizeSearchQuery = normalizeSearchQuery;
const shared_1 = require("@orbit/shared");
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
 * Below the floor the search narrows to the short "name" columns (title, branch, workspace, task) and
 * skips the multi-KB bodies entirely — 4.4ms instead of 128ms on the same data. That turned out
 * to be the better product answer too, not just the faster one: one or two characters matched
 * inside a 7 KB prompt is noise (512 hits versus 51), and a query that short is nearly always a
 * name the user is still typing. Clients are told via `contentSearched: false`.
 */
exports.CONTENT_MIN_CHARS = 3;
/** Upper bound on a query, so a pasted wall of text can't become a pathological LIKE pattern. */
const MAX_QUERY_CHARS = 200;
/** Escape the three characters LIKE treats specially (default escape char is `\`). */
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** Decode an exact raw/public id while treating every other query as normal search text. */
const decodeSessionId = (s) => {
    try {
        return (0, shared_1.toUuid)(s);
    }
    catch {
        return null;
    }
};
/**
 * Drop the markdown marks that sit between what's stored and what the user actually read: a reply
 * persisted as "the **merge** button" renders as "the merge button", and searching the phrase they
 * saw has to find it. Applied to the in-session search's corpus (in SQL) and to its query here, so
 * the two always agree.
 *
 * `*` and backticks only. `_` is a character in half the identifiers anyone would search for
 * (snake_case, `file_path`), not decoration, so stripping it would do more harm than good.
 */
const stripEmphasis = (s) => s.replace(/[*`]/g, '');
exports.stripEmphasis = stripEmphasis;
/** How many words of a query are actually matched on. Past a handful the AND has long since
 *  narrowed to one row, and each extra word is another ILIKE over every body it reaches — so a
 *  pasted paragraph costs a bounded number of passes rather than one per word. */
const MAX_WORDS = 8;
/**
 * The same query, matched word by word instead of as one phrase — what both searches fall back to
 * when the phrase itself is nowhere. Returns null when there is nothing broader to try.
 *
 * Phrase first, words second, rather than always matching by word. Two reasons, and they point the
 * same way:
 *
 *  - Precision. A row that contains the phrase is a better answer than one that merely mentions
 *    its words, and the palette has no paging — broadening unconditionally lets the second kind
 *    crowd out the first.
 *  - The trigram index. `%会话%` and `%列表%` carry no whole trigram, so a Chinese query broadened
 *    into two-character words can't use session_search_trgm at all: measured 866ms of parallel
 *    sequential scan against 19.7ms for the phrase. Paying that only when the phrase found nothing
 *    turns a permanent 44x regression into a one-off cost on a search that was about to come back
 *    empty anyway.
 */
function broaden(norm) {
    if (norm.byWord || norm.terms.length < 2)
        return null;
    return {
        ...norm,
        byWord: true,
        patterns: norm.terms.map((term) => term.map((w) => `%${escapeLike(w)}%`)),
        // The floor again, now per word rather than per query, and for exactly the reason it exists:
        // the long bodies are only reachable through a trigram index, and a word below the floor
        // can't drive one. Broadening "会话列表排序" into 2-character words and letting it reach
        // conversation text measured 1.9s of parallel sequential scan; against the short name columns
        // it stays interactive, and the phrase query above already searched the bodies properly.
        // English words clear the floor as a matter of course, so this only bites on CJK.
        searchContent: norm.searchContent &&
            norm.terms.every((term) => term.every((w) => [...w].length >= exports.CONTENT_MIN_CHARS)),
    };
}
/**
 * Normalize a raw `q`. Returns null for an empty/whitespace-only query — the caller answers that
 * with recents rather than running a search that would match every row.
 */
function normalizeSearchQuery(q) {
    const raw = (q ?? '').trim().slice(0, MAX_QUERY_CHARS);
    if (raw.length === 0)
        return null;
    const terms = (0, shared_1.searchTerms)(raw).slice(0, MAX_WORDS);
    // Only a term with no alternatives is certain to be in every admitted row, so only those can
    // anchor a snippet. Falls back to the query itself when there are none — as it also does for a
    // one-word query, where the phrase and the anchor are the same string and the snippet's
    // coalesce never reaches past the first.
    const solid = terms.filter((t) => t.length === 1).map((t) => t[0]);
    return {
        raw,
        pattern: `%${escapeLike(raw)}%`,
        patterns: [[`%${escapeLike(raw)}%`]],
        terms,
        anchor: solid.length ? solid.reduce((a, b) => (b.length > a.length ? b : a)) : raw,
        byWord: false,
        prefixPattern: `${escapeLike(raw)}%`,
        sessionId: decodeSessionId(raw),
        sessionIdPrefix: /^[0-9a-f]{8,12}$/i.test(raw) ? raw.toLowerCase() : null,
        // Count by code points, not UTF-16 units: an emoji is one character to the user and one
        // "character" to pg_trgm, but `.length` would count it as two and wrongly clear the floor.
        searchContent: [...raw].length >= exports.CONTENT_MIN_CHARS,
    };
}
//# sourceMappingURL=search-query.js.map