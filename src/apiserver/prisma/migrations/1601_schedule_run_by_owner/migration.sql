-- Whether a MANUAL run was the owner's own Run now (docs/scheduled-tasks-design.md §4, §8.4). The weekly budget now
-- counts automatic runs and the Run now presses of sessions and tokens apart, and counts the owner's presses toward
-- neither, so a run records who pressed it. Rows written before this read as false: an earlier press counts as an
-- agent's, which only narrows what an agent may start for the next 7 days. Additive: a NOT NULL boolean with a
-- constant default, a catalog change with no rewrite, which the running release neither reads nor writes.
ALTER TABLE "schedule_run" ADD COLUMN "by_owner" BOOLEAN NOT NULL DEFAULT false;
