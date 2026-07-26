-- Session search (⌘K) — trigram indexes backing GET /sessions/search.
--
-- Why pg_trgm and not full-text search: to_tsvector can't segment CJK with the parsers this
-- image ships (no zhparser available), so `to_tsvector('simple','支持搜索Session')` collapses the
-- whole run of Chinese into ONE token and a search for '搜索' can never match. Trigrams are
-- character-level, so they work for Chinese and English alike — at the cost of a 3-character
-- floor: a `%xx%` pattern shorter than 3 chars yields no mandatory trigram, the index degrades to
-- a full scan, and the query planner is better off without it. The service enforces that floor
-- (see normalizeSearchQuery): queries under 3 characters search metadata only, never message text.
--
-- Deliberately NOT `CONCURRENTLY`: Prisma wraps each migration file in a transaction and
-- CREATE INDEX CONCURRENTLY cannot run inside one. Measured build cost on the current data set
-- (1.3k sessions / 3.0M run_events, of which 36.6k are indexed here) is seconds — deploy off-peak.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Tier A — session metadata. One index over the concatenated searchable text of the row so a
-- single ILIKE against the same expression is index-accelerated; the service then re-tests the
-- individual columns on the (small) surviving set to report WHICH field matched.
-- `agent.name` / `task.title` are not here — they live on joined tables and are matched
-- separately against those (tiny: ~10 agents, ~500 tasks) rather than bloating this index.
CREATE INDEX "session_search_trgm" ON "session" USING gin (
  (
    coalesce("title", '') || ' ' ||
    coalesce("prompt", '') || ' ' ||
    coalesce("last_assistant_text", '') || ' ' ||
    coalesce("branch", '')
  ) gin_trgm_ops
);

-- Tier B — conversation text. A PARTIAL index: `user` + `assistant` events are 1.2% of run_event
-- (36.6k of 3.0M rows, 14 MB of 1468 MB) — the 92% that are `system` events never enter it. That
-- ratio is what makes indexing an append-only, high-volume log affordable at all; without the
-- WHERE clause this would be an unaffordable write-path tax on event ingestion.
CREATE INDEX "run_event_text_trgm" ON "run_event" USING gin (
  ((payload->>'text')) gin_trgm_ops
) WHERE "type" IN ('user', 'assistant');
