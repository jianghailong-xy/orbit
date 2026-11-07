import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WIKI_CLAIM_HIDDEN_STATES,
  WIKI_LIMITS,
  WIKI_VOUCHED_TRUST,
  type WikiAnchorState,
  type WikiSearchHit,
  type WikiSearchMatch,
  type WikiSearchRow,
  type WikiTrust,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  broaden,
  CONTENT_MIN_CHARS,
  escapeLike,
  normalizeSearchQuery,
  stripEmphasis,
  type NormalizedSearchQuery,
} from '../sessions/search-query';

/**
 * Orbit Wiki's retrieval (design §6, contract `searchMatches`).
 *
 * THREE LEGS, TWO OF THEM REAL TODAY, FUSED BY RANK. The keyword leg is pg_trgm over the very
 * expression migration 0307 built `wiki_entry_search_trgm` on, normalized and broadened exactly as
 * session search is, with a last pass of its own when no entry holds every word (`anyWordLeg`); the
 * path leg is a prefix match against an entry's anchor paths and its pitfall trigger paths, ranked
 * exact file first and weighted by how many entries share what it matched (`pathLeg`); the semantic
 * leg (design §6.3) is phase 2 and off. The legs' ranked lists are fused with reciprocal rank fusion
 * (k=60) and the answer is entries — never a page, never a slice.
 *
 * WHAT IS RETURNED IS AN ENTRY. `match` says which legs found it and `score` how strongly they
 * agreed; the rest is the entry's own public shape, small enough to render a ⌘K row or hand a
 * model: no fields, no sources, no history. A caller that wants the whole thing asks for it by id,
 * which is also what keeps the read boundary in one place instead of two.
 *
 * THE FLOOR IS CONTENT_MIN_CHARS, AND IT DECIDES THE CORPUS rather than whether to search at all.
 * Above it the leg searches title, summary, aliases and every string inside `fields` — the indexed
 * expression. Below it (a two-character Chinese word, a name still being typed) it searches the
 * short columns only: a sub-trigram pattern makes the GIN index recheck every row, and the field
 * text a pitfall carries runs to 4 KB, so a two-character query would pay that per entry to look
 * for a word that is nearly always a name. That is the session-search floor's own reasoning,
 * applied to a corpus that has a short tier worth falling back to.
 *
 * THE READER'S ROLE IS PART OF THE FILTER, NOT A CALLER'S PARAMETER. On the owner door the statuses
 * are what the owner asks for, active by default; on the runner door they are `active`, plus the
 * entries the calling session ITSELF proposed and that still wait in Review (contract
 * `readBoundary`: a pending proposal is visible only to the session that made it). So there is no
 * `status` parameter on the runner door at all — one that could widen the set would be a session
 * reading another's unaccepted claims.
 *
 * WHAT IS NOT HERE: the semantic leg (§6.3, phase 2 — the parameter is accepted and the answer
 * says `semantic: false`, which is the whole of the placeholder), the `search` exposure row (a
 * write, and it is the runner door's: a person's search is not an exposure, `exposureRules.people`),
 * and the aggregation into `stats.searchHits`/`gets`, which is what the usage tiebreak reads: a
 * column 0307 gives an entry and no phase-1 writer fills yet, so the tiebreak is in place and every
 * entry is level on it today.
 */

/** Reciprocal rank fusion's constant (design §6.1): a leg's first hit is worth 1/(RRF_K + 1). */
const RRF_K = 60;

/**
 * How many hits one leg contributes before fusion. RRF is defined over ranked lists, so a leg has
 * to be bounded somewhere; the bound sits well above the answer's own limit (`searchLimitMax`, 10)
 * because a hit that is second in one leg and first in the other has to survive both lists to be
 * ranked where it belongs.
 */
const LEG_CAP = 50;

/** What a caller asks for, from either door. */
export interface WikiSearchRequest {
  ownerId: string;
  /** The space in scope. Null searches every space this owner has (§2.1's isolation is the owner's). */
  spaceId?: string | null;
  q?: string;
  /** One or more of the contract's kinds. Empty searches every kind. */
  kinds?: readonly string[];
  /** A topic's slug. */
  topic?: string;
  trust?: readonly string[];
  /** The statuses the OWNER asked for. Ignored for a session reader, whose set the role decides. */
  statuses?: readonly string[];
  /** Paths the caller is working on, which the path leg matches in place of a path-shaped `q`. */
  paths?: readonly string[];
  limit?: number;
  /** Which of the fields a hit does not carry by default the caller asked for — the API's own
   *  `?include=` convention. `space` and `topics` are the two names (`WikiSearchRowAdditions`);
   *  anything else is not a field and is ignored, `anchor` included now that every hit carries it. */
  include?: readonly string[];
  /** Phase 2's leg. Accepted, reported, and off (see the module header). */
  semantic?: boolean;
  /** The calling session: it reads active entries, plus the ones IT proposed and that still wait. */
  sessionId?: string | null;
}

/** The answer: the query as it was understood, whether the semantic leg ran, and the entries. */
export interface WikiSearchOutcome {
  q: string;
  semantic: false;
  hits: WikiSearchHit[];
}

/** One entry, as the fusion ranked it. */
export interface RankedHit {
  id: string;
  score: number;
  match: WikiSearchMatch[];
}

/** One entry the path leg found, and what its match is worth in the fusion (`pathWeight`). */
export interface PathHit {
  id: string;
  weight: number;
}

/** The path leg's row: an entry, whether its best match was exact, and what `pathSpecificity` reads. */
interface PathRow {
  id: string;
  exact: boolean;
  covered: number;
  span: number;
  entries: number;
}

// ── Query shape (pure) ──────────────────────────────────────────────────────────────────────────

/**
 * Whether a query is asking about a path rather than about words.
 *
 * A separator is the whole test: `src/apiserver/src/wiki` is a path, and `wiki-retrieval.ts` alone
 * is a name that goes to the keyword leg — a name with no directory in it cannot say which of two
 * same-named files was meant, which is why the path leg only reads a path the CALLER passed rather
 * than guessing one from a word. Whitespace means words: prose that happens to contain a slash
 * ("and/or") is not a path.
 */
export function looksLikePath(q: string): boolean {
  const trimmed = q.trim();
  return trimmed.includes('/') && !/\s/u.test(trimmed) && trimmed !== '/';
}

/** A caller's path, spelled the way entries anchor one: repo-relative, no leading `./` or `/`. */
function normalizePath(raw: string): string {
  return raw.trim().replace(/^\.?\//u, '');
}

/** Every path the leg should match on: what the caller named, plus a path-shaped query. */
export function pathQueries(q: string | undefined, paths: readonly string[] | undefined): string[] {
  const named = (paths ?? []).map(normalizePath).filter((path) => path.length > 0);
  if (named.length > 0) return [...new Set(named)];
  return looksLikePath(q ?? '') ? [normalizePath(q!)].filter((path) => path.length > 0) : [];
}

/** A word of exactly two CJK characters, which is an ordinary word in those languages. */
const CJK_PAIR = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2}$/u;

/**
 * Whether a word takes part in the last pass: it clears session search's floor, or it is a CJK pair.
 *
 * The floor is there to keep a word with no trigram away from a table too large to read row by row, and
 * here it would also cost a Chinese query most of its words, leaving one generic word to answer for it
 * (`会话 curl` asking only about curl). wiki_entry is small enough to pay for them, and the replay holds that
 * to a number (docs/wiki-memory-claims-design.md §6.3). `to` and `5m` stay out: they say nothing about an entry.
 */
function usableInLastPass(word: string): boolean {
  return [...word].length >= CONTENT_MIN_CHARS || CJK_PAIR.test(word);
}

/**
 * The last pass's question (contract `searchMatches.keyword`): the groups of patterns of which any one found
 * is enough, or null when there is no such question to ask. A group keeps the readings that take part, and goes
 * when none does.
 *
 * At least two groups, because one is not a question about the query at all: it finds every entry that holds
 * a generic word, and in the replay those answers were on topic 6 times in 21 against 26 in 39 with two or more.
 */
export function anyWordPatterns(norm: NormalizedSearchQuery): string[][] | null {
  const groups = norm.terms
    .map((term) => term.filter(usableInLastPass).map((word) => `%${escapeLike(word)}%`))
    .filter((group) => group.length > 0);
  return groups.length >= 2 ? groups : null;
}

// ── Fusion and ordering (pure) ──────────────────────────────────────────────────────────────────

/**
 * Reciprocal rank fusion over the legs' ranked lists: each hit scores 1/(k + its rank), and an
 * entry found by two legs is worth both — which is the point of fusing by rank rather than by any
 * leg's own score, since a trigram ratio and a path prefix have no common scale.
 *
 * A leg may weigh its hits: `weights[i]` scales the i-th hit's term, and a hit without one counts
 * whole. Only the path leg does (`pathWeight`), so a search with no paths is fused exactly as an
 * unweighted RRF would fuse it.
 *
 * `match` carries the legs that found it, in the order the legs are handed over (keyword first,
 * then path), which is the contract's own order in `searchMatches`.
 */
export function rrfFuse(
  legs: ReadonlyArray<{ match: WikiSearchMatch; ids: readonly string[]; weights?: readonly number[] }>,
): RankedHit[] {
  const score = new Map<string, number>();
  const match = new Map<string, WikiSearchMatch[]>();
  for (const leg of legs) {
    leg.ids.forEach((id, index) => {
      score.set(id, (score.get(id) ?? 0) + (leg.weights?.[index] ?? 1) / (RRF_K + index + 1));
      const found = match.get(id) ?? [];
      if (!found.includes(leg.match)) found.push(leg.match);
      match.set(id, found);
    });
  }
  return [...score].map(([id, value]) => ({ id, score: value, match: match.get(id)! }));
}

/**
 * How specific a path match is, from 0 to 1: an IDF over the entries it covers.
 *
 * `covered` is how many entries name a path in the region the match is about — the asked file
 * itself for an exact match, the asked directory for an entry under it, the entry's own directory
 * for an asked path under that — and `span` how many paths the entry names itself. A file only one
 * entry names is 1; a file thirty entries name, or a directory hundreds of entries live under, or an
 * entry anchored on a dozen files, says much less about why the caller asked, which is what the
 * review of 2026-11-06 found the path leg's noise to be. `entries` is how many entries in reach name
 * any path at all, the corpus the frequency is read against.
 */
export function pathSpecificity(covered: number, span: number, entries: number): number {
  const corpus = Math.log(Math.max(entries, 1) + 1);
  const value = Math.log((Math.max(entries, 1) + 1) / Math.max(covered * span, 1)) / corpus;
  return Math.min(1, Math.max(0, value));
}

/**
 * What a path match is worth in the fusion, as a share of a keyword hit at the same rank: an exact
 * match (the asked file is the entry's anchor or trigger path) between 3/4 and all of it, a match
 * by directory prefix between 1/2 and 3/4, by its specificity within each band. So an exact match
 * always counts for more than a prefix one, a file only one entry names still ties the keyword leg's
 * first hit, and a hub file's or a wide directory's entries land below what the words found.
 */
export function pathWeight(exact: boolean, specificity: number): number {
  return exact ? 0.75 + 0.25 * specificity : 0.5 + 0.25 * specificity;
}

/** Trust, strongest first (design §6.1's first tiebreak). `external` is last: it is Web-derived. */
const TRUST_RANK: Readonly<Record<WikiTrust, number>> = {
  owner: 6,
  confirmed: 5,
  auto: 4,
  unreviewed: 3,
  proposed: 2,
  external: 1,
};

/** How much an anchor is worth as a tiebreak: a checked one beats an unchecked one, and a broken
 *  one is the weakest thing an entry can carry. */
const ANCHOR_RANK: Readonly<Record<WikiAnchorState, number>> = {
  verified: 4,
  unchecked: 3,
  changed: 2,
  missing: 1,
};

/** What an entry has been used for, as 0307's `stats` aggregates it. Level at 0 until a writer. */
export function usageOf(stats: unknown): number {
  const row = (stats ?? {}) as Record<string, unknown>;
  const count = (key: string): number => {
    const value = row[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return count('searchHits') + count('gets');
}

/** Everything the ordering compares, beside the fused score. */
export interface RankableEntry {
  trust: WikiTrust;
  anchorState: WikiAnchorState;
  stats: unknown;
  /** When the entry's current revision was written. Null only if the entry outran its revisions. */
  changedAt: Date | null;
}

/**
 * The design's tiebreak, in its order: trust, then anchor state, then how much the entry has been
 * used, then how recently it changed — and the id last, which is not a preference but a promise
 * that two runs over unchanged rows answer in the same order.
 *
 * Only entries whose fused scores are equal ever reach past the first comparison, so this is the
 * order of a tie and nothing else.
 */
export function compareRanked(a: RankedHit & RankableEntry, b: RankedHit & RankableEntry): number {
  if (a.score !== b.score) return b.score - a.score;
  if (TRUST_RANK[a.trust] !== TRUST_RANK[b.trust]) return TRUST_RANK[b.trust] - TRUST_RANK[a.trust];
  if (ANCHOR_RANK[a.anchorState] !== ANCHOR_RANK[b.anchorState]) {
    return ANCHOR_RANK[b.anchorState] - ANCHOR_RANK[a.anchorState];
  }
  if (usageOf(a.stats) !== usageOf(b.stats)) return usageOf(b.stats) - usageOf(a.stats);
  const changed = (b.changedAt?.getTime() ?? 0) - (a.changedAt?.getTime() ?? 0);
  if (changed !== 0) return changed;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ── The corpus, spelled the way the index spells it ─────────────────────────────────────────────

/**
 * The expression 0307 built `wiki_entry_search_trgm` on, called rather than re-derived — which is
 * why the migration declares `wiki_entry_search_text` as a function at all. A trigram index over an
 * expression is used only by a query that repeats that expression exactly, and
 * `wiki-schema.pg.spec.ts` holds the function and the index together.
 */
const SEARCH_TEXT = Prisma.sql`wiki_entry_search_text(e."title", e."summary", e."aliases", e."fields")`;

/**
 * The corpus half of `stripEmphasis`, in SQL; the query half is `stripEmphasis` itself, and the two
 * are applied together (search-query.ts). The same two replaces the index expression performs,
 * repeated here for the below-the-floor tier, which must not touch that expression: a
 * two-character query against it would make Postgres rebuild every entry's multi-KB field text to
 * match on a name.
 */
const stripMarks = (col: Prisma.Sql): Prisma.Sql => Prisma.sql`replace(replace(${col}, '*', ''), '\`', '')`;

/** The short tier: the columns that hold names rather than prose. */
const SHORT_TEXT = Prisma.sql`${stripMarks(Prisma.sql`e."title"`)} || ' ' || ${stripMarks(
  Prisma.sql`e."summary"`,
)} || ' ' || ${stripMarks(Prisma.sql`array_to_string(e."aliases", ' ')`)}`;

/** A text list as a parameter. `IN ()` is a syntax error, so an empty list has its own spelling. */
const textArray = (values: readonly string[]): Prisma.Sql =>
  values.length === 0 ? Prisma.sql`ARRAY[]::text[]` : Prisma.sql`ARRAY[${Prisma.join([...values])}]::text[]`;

/**
 * "This text matches the query": every term ANDed, each term's alternatives ORed — the shape
 * `SessionsService.searchRows` builds, and for the same reason: each ILIKE stays its own indexable
 * condition against the trigram index, so the planner can BitmapAnd them rather than fall back to
 * sequential scans.
 */
function matchSql(norm: NormalizedSearchQuery, col: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(
    norm.patterns.map(
      (term) => Prisma.sql`(${Prisma.join(term.map((pattern) => Prisma.sql`${col} ILIKE ${pattern}`), ' OR ')})`,
    ),
    ' AND ',
  )})`;
}

/**
 * The visibility half of the hard filter: who this reader may see at all.
 *
 * A session's set is `active` plus what IT proposed and that still waits — the op row it wrote,
 * still `pending`, pointing at the entry it created. That is a session reading its own unaccepted
 * claim back, which is what `readBoundary` allows; another session's proposal is invisible here, and
 * the owner reads those in Review. And a live entry that rests on a web-derived record reaches a
 * session only once a person has vouched for it (`reviewModes.floors.taintedWaits`): tainted, with a
 * trust that is not the owner's or confirmed, it is the owner's to read and never an agent's. Nor does an
 * entry two answers of the claim recheck found fixed or obsolete (`maintenance.job.server.recheck.effect.search`):
 * it waits for the owner's answer to its challenge, and an agent reading it by id still gets it, marked.
 */
function visibilitySql(request: WikiSearchRequest): Prisma.Sql {
  const sessionId = request.sessionId ?? null;
  const statuses = sessionId ? ['active'] : [...(request.statuses?.length ? request.statuses : ['active'])];
  const live = Prisma.sql`e."status" = ANY(${textArray(statuses)})`;
  if (!sessionId) return live;
  const vouched = Prisma.sql`(NOT e."tainted" OR e."trust" = ANY(${textArray(WIKI_VOUCHED_TRUST)}))`;
  const current = Prisma.sql`NOT (e."claim_state" = ANY(${textArray([...WIKI_CLAIM_HIDDEN_STATES])}))`;
  return Prisma.sql`((${live} AND ${vouched} AND ${current}) OR (e."status" = 'proposed' AND EXISTS (
      SELECT 1
        FROM "wiki_changeset_op" o
        JOIN "wiki_changeset" c ON c."id" = o."changeset_id" AND c."owner_id" = o."owner_id"
       WHERE o."result_entry_id" = e."id"
         AND o."owner_id" = e."owner_id"
         AND o."decision" = 'pending'
         AND c."session_id" = ${sessionId}::uuid
    )))`;
}

/** Everything that decides which entries a request may see, in one parenthesized predicate. */
function hardFilterSql(request: WikiSearchRequest): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`e."owner_id" = ${request.ownerId}::uuid`, visibilitySql(request)];
  if (request.spaceId) parts.push(Prisma.sql`e."space_id" = ${request.spaceId}::uuid`);
  if (request.kinds?.length) parts.push(Prisma.sql`e."kind" = ANY(${textArray(request.kinds)})`);
  if (request.topic) parts.push(Prisma.sql`e."topics" @> ARRAY[${request.topic}]::text[]`);
  if (request.trust?.length) parts.push(Prisma.sql`e."trust" = ANY(${textArray(request.trust)})`);
  return Prisma.sql`(${Prisma.join(parts, ' AND ')})`;
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

@Injectable()
export class WikiRetrieval {
  constructor(private readonly prisma: PrismaService) {}

  /** The whole pipeline: hard filter, two legs, fusion, tiebreak, top N. */
  async search(request: WikiSearchRequest): Promise<WikiSearchOutcome> {
    // A limit that is not a positive number — absent, `?limit=`, a word — is the default rather than
    // a silent empty answer: `Math.trunc(NaN)` would otherwise reach the slice.
    const asked = request.limit !== undefined && Number.isFinite(request.limit) && request.limit >= 1;
    const take = asked ? Math.min(Math.trunc(request.limit!), WIKI_LIMITS.searchLimitMax) : WIKI_LIMITS.searchLimitMax;
    const norm = normalizeSearchQuery(stripEmphasis(request.q ?? ''));
    const paths = pathQueries(request.q, request.paths);
    // Nothing asked for: no words and no path. An empty query is not answered with the newest
    // entries — a browse is the space's entry list, and a search that quietly returns one is a
    // caller that never learns its query said nothing.
    if (!norm && paths.length === 0) return { q: '', semantic: false, hits: [] };

    const where = hardFilterSql(request);
    const keyword = norm ? await this.keywordLeg(where, norm) : [];
    // The phrase found nothing: ask the broader question, exactly as session search does — see
    // `broaden` for why that is a second query rather than a second predicate. The path leg needs
    // nothing from it, so it runs either way.
    const widened = norm && keyword.length === 0 ? broaden(norm) : null;
    const everyWord = keyword.length === 0 && widened ? await this.keywordLeg(where, widened) : keyword;
    // No entry holds every word either: which holds the most of them. Measured over the multi-word
    // searches agents really made, two thirds found nothing, because a question names more words than
    // the entry that answers it (docs/wiki-memory-claims-design.md §6.3). Only here, and only in this
    // file: session search's palette has no use for a row that mentions one word of three.
    const anyWord = norm && everyWord.length === 0 ? anyWordPatterns(norm) : null;
    const keywords = anyWord ? await this.anyWordLeg(where, norm!, anyWord) : everyWord;
    const byPath = paths.length > 0 ? await this.pathLeg(where, paths) : [];

    const fused = rrfFuse([
      { match: 'keyword', ids: keywords },
      { match: 'path', ids: byPath.map((hit) => hit.id), weights: byPath.map((hit) => hit.weight) },
    ]);
    const hits = await this.rank(request.ownerId, fused, take, request.include ?? []);
    return { q: norm?.raw ?? '', semantic: false, hits };
  }

  /**
   * One pass of the keyword leg: the ids that match, best-ranked first.
   *
   * Membership is the ILIKE predicate against the indexed expression — that is the leg's recall,
   * and the trigram index is what makes it affordable. The ORDER is pg_trgm's own similarity, which
   * is the ranking half of what design §6.1 asks this leg for. `word_similarity` rather than
   * `similarity`: it measures the query against the best-matching window of the entry instead of
   * against the whole of it, and `fields` alone can run to 4 KB — dividing by the whole document's
   * trigram set ranks a terse entry that says the thing below a verbose one that mentions it.
   */
  private async keywordLeg(where: Prisma.Sql, norm: NormalizedSearchQuery): Promise<string[]> {
    const col = norm.searchContent ? SEARCH_TEXT : SHORT_TEXT;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT e."id" AS "id"
        FROM "wiki_entry" e
       WHERE ${where} AND ${matchSql(norm, col)}
       ORDER BY word_similarity(${norm.raw}, ${col}) DESC, e."id"
       LIMIT ${LEG_CAP}::int
    `);
    return rows.map((row) => row.id);
  }

  /**
   * The keyword leg's last pass: the entries holding any of the words, those holding the most first,
   * and pg_trgm's similarity to the whole query among those holding as many.
   *
   * Always over the indexed expression. A word of three characters or more is a condition the trigram index
   * can answer; a CJK pair has no trigram, so a query holding one reads the space's entries, which is what the
   * replay's latency gate is for. The inner query reads each entry's text once and hands it up, because the
   * count asks of the text once per word and `wiki_entry_search_text` costs about 0.1 ms a call (0313);
   * `OFFSET 0` is what keeps the planner from folding the call back into every one of them.
   */
  private async anyWordLeg(where: Prisma.Sql, norm: NormalizedSearchQuery, groups: string[][]): Promise<string[]> {
    const holds = (col: Prisma.Sql, group: string[]): Prisma.Sql =>
      Prisma.sql`(${Prisma.join(group.map((pattern) => Prisma.sql`${col} ILIKE ${pattern}`), ' OR ')})`;
    const text = Prisma.sql`m."text"`;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT m."id" AS "id"
        FROM (
          SELECT e."id" AS "id", ${SEARCH_TEXT} AS "text"
            FROM "wiki_entry" e
           WHERE ${where} AND (${Prisma.join(groups.map((group) => holds(SEARCH_TEXT, group)), ' OR ')})
          OFFSET 0
        ) m
       ORDER BY (${Prisma.join(groups.map((group) => Prisma.sql`${holds(text, group)}::int`), ' + ')}) DESC,
                word_similarity(${norm.raw}, ${text}) DESC,
                m."id"
       LIMIT ${LEG_CAP}::int
    `);
    return rows.map((row) => row.id);
  }

  /**
   * One pass of the path leg: every entry whose anchor paths or pitfall trigger paths are
   * prefix-related to one of the paths asked about.
   *
   * THREE RELATIONS, and each is a different question asked of the same pair of paths:
   *
   *  - the entry's path starts with the query: `docs/` asks for what is anchored under it;
   *  - the query starts with the entry's path: a query of `src/apiserver/src/wiki/wiki-retrieval.ts`
   *    asks what bites there, and a pitfall whose trigger path is `src/apiserver/src/` applies to it;
   *  - the entry's last segment starts with the query: the one relation with no direction to it,
   *    and the reason a file can be named out loud without its directory.
   *
   * Those decide which entries the leg finds, and nothing below changes that. The comparison happens
   * in SQL, literally (`starts_with`, and `split_part` for the last segment) rather than through a
   * pattern, so a path carrying `%` or `_` matches itself and not the world.
   *
   * THE ORDER is what the review of 2026-11-06 found wrong: ranked by the length of the entry's own
   * path, an entry anchored on a big file or a whole directory came back for anything near it, and
   * one file's many entries filled the answer to a search that named five. So each match, both paths
   * read without a trailing `/`, is first one of these, best first (`rel`):
   *
   *  0. exact — the entry names the asked file itself, or, for a bare name, a file of that name;
   *  1. the entry's path is under the asked directory;
   *  2. it starts with the asked string at no `/`: `pages/Wiki` naming `pages/WikiPage.tsx`;
   *  3. the asked path is under the entry's directory;
   *  4. the asked path starts with the entry's at no `/`: `wiki` beside `wiki-worker/`, kept for
   *     the recall above and last for it.
   *
   * and then as specific as the entries in its region allow (`pathSpecificity`): `covered` counts the
   * entries naming that file for an exact match, those under the asked path for 1 and 2, and those
   * under the entry's own path for 3 and 4. The leg lists every exact match before any other, and
   * within each of the two it takes the asked paths in turn — each one's best, then each one's next —
   * the more specific first within a turn. The weight each hit takes into the fusion is
   * `pathWeight`'s.
   */
  private async pathLeg(where: Prisma.Sql, paths: readonly string[]): Promise<PathHit[]> {
    const relation = Prisma.sql`(starts_with(p."path", a."q")
          OR starts_with(a."q", p."path")
          OR starts_with(split_part(p."path", '/', -1), a."q"))`;
    const rows = await this.prisma.$queryRaw<PathRow[]>(Prisma.sql`
      WITH entry_path AS (
        SELECT e."id" AS "id", a."value"->>'path' AS "path"
          FROM "wiki_entry" e, jsonb_array_elements(e."anchors") AS a("value")
         WHERE ${where}
           AND jsonb_typeof(a."value") = 'object'
           AND a."value"->>'type' IN ('path', 'symbol')
           AND a."value"->>'path' IS NOT NULL
        UNION ALL
        -- A pitfall's trigger paths are where it bites, which is what a caller working under one of
        -- them is asking about. Guarded by a type check: only a pitfall has a trigger, and
        -- jsonb_array_elements_text refuses anything that is not an array.
        SELECT e."id", t."value"
          FROM "wiki_entry" e,
               jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(e."fields" #> '{trigger,paths}') = 'array'
                      THEN e."fields" #> '{trigger,paths}' ELSE '[]'::jsonb END
               ) AS t("value")
         WHERE ${where}
      ),
      ep AS MATERIALIZED (
        SELECT "id", "path", rtrim("path", '/') AS "np" FROM entry_path
      ),
      asked AS (
        SELECT a."q", rtrim(a."q", '/') AS "nq", a."qi"
          FROM unnest(${textArray(paths)}) WITH ORDINALITY AS a("q", "qi")
      ),
      hit AS (
        SELECT p."id", p."np", a."nq", a."qi",
               CASE
                 WHEN p."np" = a."nq" THEN 0
                 WHEN strpos(a."nq", '/') = 0 AND split_part(p."np", '/', -1) = a."nq" THEN 0
                 WHEN starts_with(p."np", a."nq" || '/') THEN 1
                 WHEN starts_with(p."np", a."nq") THEN 2
                 WHEN strpos(a."nq", '/') = 0 AND starts_with(split_part(p."np", '/', -1), a."nq") THEN 2
                 WHEN starts_with(a."nq", p."np" || '/') THEN 3
                 ELSE 4
               END AS "rel"
          FROM ep p JOIN asked a ON ${relation}
      ),
      -- The region a prefix match is about, whose entries are counted below; an exact match, or a
      -- bare name's, is about the one path and counts the entries naming it.
      measured AS (
        SELECT h.*,
               CASE WHEN h."rel" IN (1, 2) AND starts_with(h."np", h."nq") THEN h."nq"
                    WHEN h."rel" IN (3, 4) THEN h."np" END AS "region"
          FROM hit h
      ),
      under AS (
        SELECT r."region", count(DISTINCT p."id")::int AS "n"
          FROM (SELECT DISTINCT "region" FROM measured WHERE "region" IS NOT NULL) r
          JOIN ep p ON starts_with(p."np", r."region")
         GROUP BY r."region"
      ),
      named AS (
        SELECT "np", count(DISTINCT "id")::int AS "n" FROM ep WHERE "np" IN (SELECT "np" FROM hit) GROUP BY "np"
      ),
      span AS (
        SELECT "id", count(DISTINCT "np")::int AS "m" FROM ep WHERE "id" IN (SELECT "id" FROM hit) GROUP BY "id"
      ),
      scored AS (
        SELECT m."id", m."qi", m."rel", COALESCE(u."n", n."n") AS "covered", s."m" AS "span"
          FROM measured m
          JOIN named n ON n."np" = m."np"
          JOIN span s ON s."id" = m."id"
          LEFT JOIN under u ON u."region" = m."region"
      ),
      -- Each entry's best match to each asked path, then its turn among that path's entries.
      best AS (
        SELECT DISTINCT ON ("id", "qi") "id", "qi", "rel", "covered", "span"
          FROM scored
         ORDER BY "id", "qi", "rel", "covered"::bigint * "span"
      ),
      turned AS (
        SELECT "id", "rel" > 0 AS "prefix", "covered", "span",
               row_number() OVER (PARTITION BY "qi", "rel" > 0 ORDER BY "rel", "covered"::bigint * "span", "id") AS "turn"
          FROM best
      ),
      chosen AS (
        SELECT DISTINCT ON ("id") "id", "prefix", "turn", "covered", "span"
          FROM turned
         ORDER BY "id", "prefix", "turn", "covered"::bigint * "span"
      )
      SELECT c."id", NOT c."prefix" AS "exact", c."covered", c."span",
             (SELECT count(DISTINCT "id")::int FROM ep) AS "entries"
        FROM chosen c
       ORDER BY c."prefix", c."turn", c."covered"::bigint * c."span", c."id"
       LIMIT ${LEG_CAP}::int
    `);
    return rows.map((row) => ({
      id: row.id,
      weight: pathWeight(row.exact, pathSpecificity(row.covered, row.span, row.entries)),
    }));
  }

  /**
   * The fused ranking, ordered by the design's tiebreak and cut to the answer's size.
   *
   * The candidates are hydrated with the columns a hit carries and nothing else — the legs read a
   * moment ago, and a candidate deleted since has no row and drops out, which beats answering with
   * an entry that no longer exists.
   */
  private async rank(
    ownerId: string,
    fused: RankedHit[],
    take: number,
    include: readonly string[],
  ): Promise<WikiSearchRow[]> {
    if (fused.length === 0) return [];
    const ids = fused.map((hit) => hit.id);
    const entries = await this.prisma.wikiEntry.findMany({
      where: { id: { in: ids }, ownerId },
      select: {
        id: true,
        kind: true,
        title: true,
        summary: true,
        trust: true,
        anchorState: true,
        stats: true,
        // How old the entry is, which every hit says (contract `agentSurface.toolSpecs.wiki_search.age`).
        recordedAt: true,
        anchorCheckedRef: true,
        anchorCheckedAt: true,
        // Two columns of a row this query is already reading. What the caller ASKED for decides
        // what comes back, not what is read: the projection below is where `include` bites, so a
        // column nothing asked for cannot reach an agent's tool output by being selected here.
        topics: true,
        space: { select: { slug: true } },
      },
    });
    const changedTimes = await this.changedAt(ownerId, ids);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    return fused
      .flatMap((hit) => {
        const entry = byId.get(hit.id);
        if (!entry) return [];
        return [
          {
            ...hit,
            kind: entry.kind,
            title: entry.title,
            summary: entry.summary,
            trust: entry.trust as WikiTrust,
            anchorState: entry.anchorState as WikiAnchorState,
            stats: entry.stats,
            changedAt: changedTimes.get(entry.id) ?? null,
            // Carried through the ranking, not read off it: `compareRanked` orders by score, trust,
            // anchor state, usage and the changed time, and none of these five is a term in it.
            recordedAt: entry.recordedAt,
            anchorCheckedRef: entry.anchorCheckedRef,
            anchorCheckedAt: entry.anchorCheckedAt,
            spaceSlug: entry.space.slug,
            topics: entry.topics,
          },
        ];
      })
      .sort(compareRanked)
      .slice(0, take)
      .map((hit) => ({
        id: hit.id,
        kind: hit.kind as WikiSearchRow['kind'],
        title: hit.title,
        summary: hit.summary,
        trust: hit.trust,
        anchorState: hit.anchorState,
        match: hit.match,
        // A fused score is a sum of at most two terms of about 1/61: rounded so two runs of the
        // same search answer with the same number rather than with float noise.
        score: Number(hit.score.toFixed(6)),
        // How old the entry is, for the reader to judge (contract `age`); a time is ISO 8601 in UTC.
        recordedAt: hit.recordedAt.toISOString(),
        changedAt: hit.changedAt?.toISOString() ?? null,
        anchorCheckedRef: hit.anchorCheckedRef,
        anchorCheckedAt: hit.anchorCheckedAt?.toISOString() ?? null,
        // Each of the two only when it was named, so a hit answered without `include` is exactly
        // the contract's list of fields (`hit`) — which `wiki-search.pg.spec.ts` pins key by key.
        ...(include.includes('space') ? { spaceSlug: hit.spaceSlug } : {}),
        ...(include.includes('topics') ? { topics: hit.topics } : {}),
      }));
  }

  /**
   * When each entry last changed: the time its current revision was written. Not `recorded_at`,
   * which is when the lineage was born and never moves — an entry amended this morning is the newer
   * answer, and the revision is where that is recorded. The join runs over the unique index on
   * `(entry_id, revision)`, one row per entry.
   */
  private async changedAt(ownerId: string, ids: readonly string[]): Promise<Map<string, Date>> {
    const rows = await this.prisma.$queryRaw<Array<{ entryId: string; changedAt: Date }>>(Prisma.sql`
      SELECT r."entry_id" AS "entryId", r."created_at" AS "changedAt"
        FROM "wiki_entry_revision" r
        JOIN "wiki_entry" e
          ON e."id" = r."entry_id" AND e."owner_id" = r."owner_id" AND e."current_revision" = r."revision"
       WHERE r."owner_id" = ${ownerId}::uuid AND r."entry_id" = ANY(${[...ids]}::uuid[])
    `);
    return new Map(rows.map((row) => [row.entryId, row.changedAt]));
  }
}

/**
 * A query parameter that is a list: `?kind=pitfall,convention`, or the same parameter repeated.
 * Both spellings reach the same array, so a CLI holding a list joins it and a client holding one
 * value per request repeats it, with nothing in the answer saying which was used.
 */
export function listParam(value: string | string[] | undefined): string[] | undefined {
  const parts = (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .flatMap((part) => part.split(','))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/** A boolean query parameter, spelled the way the rest of the API spells one. */
export const flagParam = (value: string | undefined): boolean => value === 'true' || value === '1';
