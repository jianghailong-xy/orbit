-- 0590 — the owner's Update Now for a runner update (docs/runner-update-drain-design.md §4, D4).
--
-- `self_update_now_requested_at` is when the owner asked, on POST /runners/:id/self-update/now
-- {interruptTurns: true}, for the waiting release to be installed now, interrupting the turns in
-- flight. A one-slot request like `self_update_requested_at` (0385) and `self_update_postpone_until`
-- (0571): the next heartbeat hands it to the runner as `selfUpdateNow` and clears it; the runner's
-- `self_update` report (phase `restarting` with `interruptedTurns`) is the answer. NULL = nobody asked.
--
-- One nullable column with no default, so the ADD is catalog-only. No index (the only readers go by
-- primary key), no trigger, no constraint, no DML. Not in the UPDATE OF list of 0118's runner
-- availability trigger.

ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "self_update_now_requested_at" TIMESTAMP(3);
