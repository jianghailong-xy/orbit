import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WIKI_LIMITS,
  type WikiAnchorState,
  type WikiSearchHit,
  type WikiSearchMatch,
  type WikiTrust,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { broaden, normalizeSearchQuery, stripEmphasis, type NormalizedSearchQuery } from '../sessions/search-query';

/**
 * Orbit Wiki's retrieval (design §6, contract `searchMatches`).
 *
 * THREE LEGS, TWO OF THEM REAL TODAY, FUSED BY RANK. The keyword leg is pg_trgm over the very
 * expression migration 0307 built `wiki_entry_search_trgm` on, normalized and broadened exactly as
 * session search is; the path leg is a prefix match against an entry's anchor paths and its
 * pitfall trigger paths; the semantic leg (design §6.3) is phase 2 and off. The legs' ranked lists
 * are fused with reciprocal rank fusion (k=60) and the answer is entries — never a page, never a
 * slice.
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
 * says `semantic: false`, which is the whole of the placeholder), the `search` exposure row
 * (`exposureChannels` — a write, and T6 owns the first reader of exposures), and the aggregation
 * into `stats.searchHits`/`gets`, which is what the usage tiebreak reads: a column 0307 gives an
 * entry and no phase-1 writer fills yet, so the tiebreak is in place and every entry is level on it
 * today.
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

// ── Fusion and ordering (pure) ──────────────────────────────────────────────────────────────────

/**
 * Reciprocal rank fusion over the legs' ranked lists: each hit scores 1/(k + its rank), and an
 * entry found by two legs is worth both — which is the point of fusing by rank rather than by any
 * leg's own score, since a trigram ratio and a path prefix have no common scale.
 *
 * `match` carries the legs that found it, in the order the legs are handed over (keyword first,
 * then path), which is the contract's own order in `searchMatches`.
 */
export function rrfFuse(legs: ReadonlyArray<{ match: WikiSearchMatch; ids: readonly string[] }>): RankedHit[] {
  const score = new Map<string, number>();
  const match = new Map<string, WikiSearchMatch[]>();
  for (const leg of legs) {
    leg.ids.forEach((id, index) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + index + 1));
      const found = match.get(id) ?? [];
      if (!found.includes(leg.match)) found.push(leg.match);
      match.set(id, found);
    });
  }
  return [...score].map(([id, value]) => ({ id, score: value, match: match.get(id)! }));
}

/** Trust, strongest first (design §6.1's first tiebreak). `external` is last: it is Web-derived. */
const TRUST_RANK: Readonly<Record<WikiTrust, number>> = { owner: 4, confirmed: 3, proposed: 2, external: 1 };

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
 * the owner reads those in Review.
 */
function visibilitySql(request: WikiSearchRequest): Prisma.Sql {
  const sessionId = request.sessionId ?? null;
  const statuses = sessionId ? ['active'] : [...(request.statuses?.length ? request.statuses : ['active'])];
  const live = Prisma.sql`e."status" = ANY(${textArray(statuses)})`;
  if (!sessionId) return live;
  return Prisma.sql`(${live} OR (e."status" = 'proposed' AND EXISTS (
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
    const keywords = keyword.length === 0 && widened ? await this.keywordLeg(where, widened) : keyword;
    const byPath = paths.length > 0 ? await this.pathLeg(where, paths) : [];

    const fused = rrfFuse([
      { match: 'keyword', ids: keywords },
      { match: 'path', ids: byPath },
    ]);
    return { q: norm?.raw ?? '', semantic: false, hits: await this.rank(request.ownerId, fused, take) };
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
   * Deepest match first, because the deeper path is the more specific statement: an entry anchored
   * to the very file being worked on comes before one anchored to the directory above it. The
   * comparison happens in SQL, literally (`starts_with`, and `split_part` for the last segment)
   * rather than through a pattern, so a path carrying `%` or `_` matches itself and not the world.
   */
  private async pathLeg(where: Prisma.Sql, paths: readonly string[]): Promise<string[]> {
    const relation = Prisma.join(
      paths.map(
        (path) => Prisma.sql`(starts_with(p."path", ${path})
          OR starts_with(${path}, p."path")
          OR starts_with(split_part(p."path", '/', -1), ${path}))`,
      ),
      ' OR ',
    );
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
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
      )
      SELECT id
        FROM entry_path p
       WHERE ${relation}
       GROUP BY id
       ORDER BY max(length(p."path")) DESC, id
       LIMIT ${LEG_CAP}::int
    `);
    return rows.map((row) => row.id);
  }

  /**
   * The fused ranking, ordered by the design's tiebreak and cut to the answer's size.
   *
   * The candidates are hydrated with the columns a hit carries and nothing else — the legs read a
   * moment ago, and a candidate deleted since has no row and drops out, which beats answering with
   * an entry that no longer exists.
   */
  private async rank(ownerId: string, fused: RankedHit[], take: number): Promise<WikiSearchHit[]> {
    if (fused.length === 0) return [];
    const ids = fused.map((hit) => hit.id);
    const entries = await this.prisma.wikiEntry.findMany({
      where: { id: { in: ids }, ownerId },
      select: { id: true, kind: true, title: true, summary: true, trust: true, anchorState: true, stats: true },
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
          },
        ];
      })
      .sort(compareRanked)
      .slice(0, take)
      .map((hit) => ({
        id: hit.id,
        kind: hit.kind as WikiSearchHit['kind'],
        title: hit.title,
        summary: hit.summary,
        trust: hit.trust,
        anchorState: hit.anchorState,
        match: hit.match,
        // A fused score is a sum of at most two terms of about 1/61: rounded so two runs of the
        // same search answer with the same number rather than with float noise.
        score: Number(hit.score.toFixed(6)),
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
