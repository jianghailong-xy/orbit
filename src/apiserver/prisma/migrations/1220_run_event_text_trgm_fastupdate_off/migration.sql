-- 1220 — run_event's trigram index takes each new entry as it is written, instead of queuing them.
--
-- `run_event_text_trgm` (the GIN index over user and assistant text) was built with GIN's default fastupdate = on:
-- new entries go to a pending list, and the insert that finds that list past gin_pending_list_limit (4 MB) merges all
-- of it into the index itself, inside its own statement. On production that index is 500 MB, and the run_event
-- inserts that paid for a merge took up to 4-5 s (2026-11-19: mean 0.6 ms, max 4.2 s, 4.7 s and 5.0 s across the
-- insert's three shapes), while the ingest that writes them holds the session row (rank 30), so other requests for
-- that session waited behind it.
--
-- Only ~8,300 of the ~95,000 events written a day are user or assistant text and reach this index, so paying for
-- each entry as it is written costs little. Measured on PostgreSQL 16 against a 169 MB copy of the index shape, with
-- production's mix of text lengths: indexed inserts averaged 3.3 ms with a 214 ms worst case (a merge) before, and
-- 6.1 ms with a 33 ms worst case after. Inserts that do not reach the index were unchanged (about 1.5 ms).
--
-- gin_clean_pending_list then merges what is already queued (at most 4 MB), so that it does not wait for a vacuum:
-- run_event is appended to and almost never vacuumed. No row is written. Every statement can run twice.

ALTER INDEX "run_event_text_trgm" SET (fastupdate = off);

SELECT gin_clean_pending_list('run_event_text_trgm');
