-- 0478 — what a Claude session's engine last reported as running totals, so a turn books its own
-- cost and tokens and not the process's whole count again.
--
-- WHY
-- ===
-- Claude Code's `total_cost_usd` and `modelUsage` count everything its process has spent, and a
-- process started with `--resume` restores the totals its transcript last saved and goes on
-- counting. turn-complete added that total to `session.cost_usd` on every turn and wrote it as a
-- new `usage` row: one long coordinator showed $258k that way (task 34sjn2yQvNJg1JhQIARvd).
-- A turn's own share is the difference from the totals booked before, and this column holds
-- them: `{process, costUsd, modelUsage}`, the engine process they belong to beside its totals.
--
-- WHAT IT ADDS
-- ============
-- One nullable column, written by turn-complete in the same update that books the turn. Nothing is
-- backfilled and no existing row is rewritten (the owner's decision of 2026-11-05: new data only).
-- Null reads as "nothing booked yet", which is what every existing session is.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A nullable column with no default is a catalog change only: no table rewrite, no lock beyond
-- the ALTER's own. Rolling the code back leaves it in place, unread.
--
-- TAKING THE LOCK IN SHORT TRIES
-- ==============================
-- The ALTER holds ACCESS EXCLUSIVE on `session` for an instant once it has it. Waiting for it is
-- the danger. `session` is the table every runner call reads, and a waiting ALTER queues each later
-- reader and writer behind it. With production's lock_timeout of 30 s (docker-compose.yml), a long
-- wait would also fail the migration, and a failed migration stops the apiserver from starting,
-- the image before it too (P3009). So the lock is asked for 2 s at a time, with 1 s between tries
-- in which everything else runs, up to 60 tries: 3 minutes, inside statement_timeout's 300 s. One DO
-- statement, because `migrate deploy` sends each statement on its own and a lock taken there would
-- end with it. IF NOT EXISTS keeps a retried apply harmless.

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "engine_usage_totals" JSONB;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 60 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
