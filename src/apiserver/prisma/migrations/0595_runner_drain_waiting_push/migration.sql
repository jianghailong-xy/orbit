-- 0595 — one push per drain while the owner's work waits on it (docs/runner-update-drain-design.md §3.4, D3).
--
-- `drain_waiting_pushed_at` is when the runner's owner was told that something of theirs waits on this
-- runner's drain for a self-update. The heartbeat that finds the runner draining (`heartbeat_draining`)
-- with one of the owner's sessions PENDING on it sets it in one conditional UPDATE, and only the beat
-- whose UPDATE matched sends the push: at the drain's start when work is already waiting, or at the
-- first beat after work queues behind it. A beat that is not draining clears it, so the next drain
-- pushes once more. NULL = not pushed during the current drain (or not draining).
--
-- One nullable column with no default, so the ADD is catalog-only. No index (the only readers go by
-- primary key), no trigger, no constraint, no DML. Not in the UPDATE OF list of 0118's runner
-- availability trigger.

ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "drain_waiting_pushed_at" TIMESTAMP(3);
