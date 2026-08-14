-- Session search (⌘K) — index the searchable text with its markdown marks removed.
--
-- What is stored is markdown source; what the user searches for is the line they read. A reply
-- persisted as "**`tool_call`** 历史行结果永远是 NULL" renders as "tool_call 历史行结果永远是 NULL",
-- and pasting that phrase into the palette matched nothing at all. In-session find (⌘F) already
-- stripped both its corpus and its query (see stripEmphasis); this brings the cross-session
-- palette in line with it.
--
-- The strip has to happen in the INDEX, not just in the query. A trigram index over an expression
-- is only used by a query that repeats that expression exactly, so against these indexes as 0068
-- built them the stripped predicate would degrade to scanning every row of the owner: measured
-- 450ms versus 5ms for the session tier on this deployment (3.4k sessions, 74k indexed events).
--
-- `_` is deliberately NOT stripped — it is a character in half the identifiers anyone would
-- search for (file_path, snake_case), not decoration around them.
--
-- Nested replace() rather than the regexp_replace(…, '[*`]', …) that reads more obviously: the
-- same result for a class of plain characters, at ~5x the speed (125ms against 356ms over 20k
-- message bodies), because replace() returns the source unchanged when there is nothing to
-- remove. That matters at query time, not build time — a trigram match is approximate, so every
-- row the index admits is rechecked by re-evaluating this expression. Keep it identical to
-- stripMarks in sessions.service.ts, or the recheck stops matching the index and the search
-- silently degrades to a full scan.
--
-- Deliberately NOT `CONCURRENTLY`, for the same reason as 0068: Prisma wraps each migration file
-- in a transaction, which CREATE INDEX CONCURRENTLY cannot run inside. Measured rebuild cost on
-- the current data set is 4s for the session index and 26s for the event one (and that 26s is the
-- CONCURRENTLY figure, which pays for two passes — a plain build is faster). Each holds an
-- exclusive lock on its table for that time, taken while the apiserver is still booting.

DROP INDEX IF EXISTS "session_search_trgm";
CREATE INDEX "session_search_trgm" ON "session" USING gin (
  (replace(replace(
    coalesce("title", '') || ' ' ||
    coalesce("prompt", '') || ' ' ||
    coalesce("last_assistant_text", '') || ' ' ||
    coalesce("branch", ''),
    '*', ''), '`', '')) gin_trgm_ops
);

DROP INDEX IF EXISTS "run_event_text_trgm";
CREATE INDEX "run_event_text_trgm" ON "run_event" USING gin (
  (replace(replace(("payload"->>'text'), '*', ''), '`', '')) gin_trgm_ops
) WHERE "type" IN ('user', 'assistant');
