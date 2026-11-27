-- 1430 — Run now (docs/mocks/queued-run-now/01-run-now.png): a person starts one queued turn over its runner's limit.
--
-- runner.burst_concurrent: Extra sessions on demand, how many turns past max_concurrent Run now may start on this
-- runner at once. Default 2; 0 turns Run now off.
-- session.over_capacity_turn_id: the one queued conversation_turn of this session its owner let start over the limit.
-- The claim takes such a session past the runner, run and batch caps while the runner's turns plus the slots its
-- background jobs hold stay under max_concurrent + burst_concurrent; it is cleared when that turn ends.
--
-- Additive only: existing runners take the default 2, existing sessions NULL. Every statement can run twice.

ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "burst_concurrent" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "over_capacity_turn_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runner_burst_concurrent_check') THEN
    ALTER TABLE "runner" ADD CONSTRAINT "runner_burst_concurrent_check" CHECK ("burst_concurrent" >= 0);
  END IF;
END $$;

-- The overflow claim asks whether a runner has a passed session waiting before it runs at all: a handful of rows.
CREATE INDEX IF NOT EXISTS "session_over_capacity_pending_idx" ON "session" ("assigned_runner_id")
  WHERE "over_capacity_turn_id" IS NOT NULL AND "status" = 'PENDING';
