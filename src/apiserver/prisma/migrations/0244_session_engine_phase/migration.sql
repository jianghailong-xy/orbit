-- What the engine is doing in a stretch where it produces nothing else.
--
-- WHY A COLUMN AND NOT A DERIVED READ
-- ===================================
-- `engine_started_at` (0166) says whether the engine has spoken for the current run. It is an
-- ABSENCE, and every claim clears it, so one null covers three unrelated situations: a cold
-- checkout, a warm process that is simply between turns, and — the one this column exists for —
-- an engine compacting a conversation that no longer fits before it can read the message it was
-- sent. The first two are seconds. The third is minutes, it can retry, and while it runs the
-- runtime emits nothing at all. The clients had to describe that window with no information and
-- described it as a workspace still being checked out, which was false in two of the three cases
-- and actively misleading in the third.
--
-- Only the runner can tell them apart, exactly as only the server can name the gate holding a
-- queued session (`queued_reason`, computed in the session-list query). The difference is where
-- the fact lives: a queued gate is derivable from rows the list already joins, while an engine
-- phase is a fact about a process on another machine, reported in its event stream. Deriving it
-- per row would mean a lateral into `run_event` — the largest table here — for every session on
-- every page. So it is denormalized onto the session at ingest, alongside the neighbours already
-- maintained that way: `last_tool_use`, `context_tokens`, `engine_turn_active`.
--
-- WHY NULLABLE WITH NO DEFAULT
-- ============================
-- NULL is the answer for every existing row and for every row that has no named phase, so there
-- is nothing to backfill and no rewrite: PostgreSQL adds a nullable column with no default as a
-- catalog-only change. It is deliberately NOT an enum. The vocabulary is one member today
-- ('compacting'), it is set by runners that self-update on their own schedule, and a value a
-- reader does not recognise must degrade to "no named phase" rather than to a failed write.
--
-- WHO CLEARS IT
-- =============
-- Two writers, and they have to be both. The claim clears it with `engine_started_at`, because a
-- phase belongs to a run and a new claim is a new run. Ingest clears it whenever the engine
-- produces anything, because a phase names a stretch in which the engine produces nothing else —
-- so output is proof the stretch is over, including in the case the closing frame never arrives.
ALTER TABLE "session" ADD COLUMN "engine_phase" TEXT;

COMMENT ON COLUMN "session"."engine_phase" IS
  'Engine activity the clients cannot otherwise see during a run whose engine has not spoken yet (engine_started_at IS NULL). NULL = no named phase. Set from the runtime event stream; cleared by every claim and by any engine output.';
