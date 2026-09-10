-- Two clocks for the waiting notices, each written by exactly one kind of event.
--
-- WHY last_turn_at COULD NOT BE THE CLOCK
-- ======================================
-- The notices that explain a silent run show how long it has been waiting, and they counted from
-- `last_turn_at`. The claim writes that column, but so does event ingest: for any non-system event,
-- and for any system event that carries a turn id. The runner stamps a turn id on everything once a
-- message is fed, and while Claude Code compacts it re-sends its status every 30 seconds. Each
-- re-send moved `last_turn_at`, the web picked the new value up on its next 5-second detail poll,
-- and the notice's timer went back to zero while its reveal started over. On the long compactions
-- the timer exists for, it never showed more than about thirty seconds.
--
-- WHY TWO
-- =======
-- `run_claimed_at` is the start of a run's wait: written by the claim and by nothing else. It is the
-- clock for "Getting the session ready", and the reveal scope for a whole run.
-- `engine_phase_since` is the start of the phase `engine_phase` names: written when the phase
-- changes, never when a keepalive re-announces it, and cleared with it. It is the clock for
-- "Compacting the conversation", which can begin two hours into a turn, where a claim-based clock
-- would report the whole turn as compaction.
--
-- Nullable with no default: NULL means "not measured", which is what every existing row is, and a
-- nullable column without a default is a catalog-only change.
ALTER TABLE "session" ADD COLUMN "run_claimed_at" TIMESTAMP(3);
ALTER TABLE "session" ADD COLUMN "engine_phase_since" TIMESTAMP(3);

COMMENT ON COLUMN "session"."run_claimed_at" IS
  'When the current run was claimed. Written only by the claim, so a wait can be measured from it; last_turn_at moves with activity.';
COMMENT ON COLUMN "session"."engine_phase_since" IS
  'When engine_phase entered the phase it holds. Written only on a phase change, never by a keepalive re-announcing the same phase; NULL whenever engine_phase is.';
