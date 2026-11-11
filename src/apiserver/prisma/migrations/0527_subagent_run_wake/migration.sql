-- Written as 0525; renumbered to 0527 before landing, 0525 and 0526 being taken on other branches.
-- SubAgent lifecycle (docs/subagent-design.md §2, §5.2): the wake for a run's end is held by the server.
-- `wake_owed` says the parent is to be woken when the run ends (a background run, or a foreground call that
-- stopped waiting), `wake_filed_at` when that wake was filed (or dropped, for a parent that had ended), and
-- `description` is the delegate call's own words for it, which the wake names. No existing row changes meaning.
ALTER TABLE "subagent_run"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "wake_owed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "wake_filed_at" TIMESTAMPTZ(3);

-- The ended runs whose wake is still to be filed, which the sweep reads.
CREATE INDEX "subagent_run_wake_unfiled_idx" ON "subagent_run"("ended_at")
  WHERE "wake_owed" AND "wake_filed_at" IS NULL AND "status" <> 'RUNNING';
