-- A partial index over the run_events a client can actually render, backing the transcript's
-- tail page (GET /sessions/:id/events/page) and its SSE replay.
--
-- Those two paths now filter out the `system` progress pings nothing renders (see
-- src/apiserver/src/common/system-noise.ts — `notNoiseSql`). The events are still stored in
-- full; they simply don't ride the wire. But because they're ~92% of the table, filtering them
-- at READ time makes the tail scan wade through them: measured on the heaviest session
-- (30k events, 98.7% pings), `ORDER BY seq DESC LIMIT 201` discarded 15,093 rows by filter and
-- took 104 ms. With this index the planner walks only renderable rows: 0.8 ms, a 129x cut.
--
-- The WHERE clause must stay character-identical to `notNoiseSql`. Postgres only uses a partial
-- index when it can prove the query's predicate implies the index's, and the queries pass that
-- same expression through verbatim — so a drift here doesn't corrupt anything, it silently stops
-- using the index and the 104 ms comes back.
--
-- Cheap because it's partial, for the same reason 0068's tier-B index is: it holds ~230k of
-- 3.0M rows — 9 MB, against 207 MB for the full (session_id, seq) index it shadows. That one
-- stays: it's the unique-constraint/ingest path and serves lookups by exact seq
-- (GET /sessions/:id/events/:seq/full), which must still find a filtered-out event.
--
-- Deliberately NOT `CONCURRENTLY`: Prisma wraps each migration file in a transaction, which
-- CREATE INDEX CONCURRENTLY cannot run inside. Measured build cost on the current data set
-- (3.0M run_events) is ~8 s — it takes a write lock on run_event for that long, so deploy
-- off-peak, or pre-create it CONCURRENTLY by hand (this statement is IF NOT EXISTS, so a
-- hand-built index makes the migration a no-op).
CREATE INDEX IF NOT EXISTS "run_event_renderable_idx" ON "run_event" ("session_id", "seq")
WHERE NOT (
  type = 'system'
  AND COALESCE(payload->>'subtype', '') NOT IN ('init', 'resumed')
  AND (payload - 'model' - 'subtype' - 'sessionId') = '{}'::jsonb
);
