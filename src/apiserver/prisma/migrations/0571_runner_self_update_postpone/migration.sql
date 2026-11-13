-- 0571 — the owner's Later for a runner update (docs/runner-update-drain-design.md §4).
-- (Written as 0535; renumbered before landing because another branch took 0535.)
--
-- `self_update_postpone_until` is the time the owner put the waiting release off until, asked on
-- POST /runners/:id/self-update/postpone. A one-slot request like `self_update_requested_at` (0385):
-- the next heartbeat hands it to the runner as `postponeSelfUpdateUntil` and clears it; the runner's
-- `self_update` report (phase `postponed`, `postponedUntil`) is the answer. NULL = nobody asked.
--
-- One nullable column with no default, so the ADD is catalog-only. No index (the only readers go by
-- primary key), no trigger, no constraint, no DML. Not in the UPDATE OF list of 0118's runner
-- availability trigger.

ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "self_update_postpone_until" TIMESTAMP(3);
