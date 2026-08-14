-- Verification runs: a second opinion on a task's own claim that it is done.
--
-- Nothing currently checks that claim, and the gap is not theoretical. Measured on this
-- deployment: of 620 DONE tasks, 21 have a last run that FAILED or was CANCELLED, and 16 have no
-- successful run at all. One of them, `[W 189/250] 003_00038.parquet → WARC`, carries a comment
-- reading "执行完成并通过验收" — execution complete, acceptance passed — while all 18 of its
-- sessions failed with `runner offline` and `num_turns = 0`. Not one of them executed a single
-- turn. The claim of completion and the evidence for it had nothing to do with each other, and
-- no part of the system noticed.
--
-- The 110 hand-written `[CHECK]` tasks were supposed to cover this. Every one of them is still
-- OPEN: they were made prerequisites of work that never finished, so the verification layer this
-- deployment already has has never run once.
--
-- `verifies_task_id` rather than an `is_verification` boolean. A boolean would say what the task
-- is; this says what it is *about*, which is what the dispatcher actually needs: whether a
-- subject already has a check in flight, and how many it has had. Cascade on delete because a
-- verification of a task that no longer exists cannot be read or acted on.
ALTER TABLE "task" ADD COLUMN "verifies_task_id" UUID;

ALTER TABLE "task" ADD CONSTRAINT "task_verifies_task_id_fkey"
    FOREIGN KEY ("verifies_task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Serves both dispatcher questions — "is one already in flight for this subject" and "how many
-- has it had" — and is the FK's own lookup index.
CREATE INDEX "task_verifies_task_id_idx" ON "task"("verifies_task_id");

-- Opt-in per list. Verification doubles a list's runs, and a false "done" is not equally
-- expensive everywhere; the campaign that spent 21 hours re-dispatching a task nobody could tell
-- had never started is exactly the one that would turn this on.
ALTER TABLE "task_list" ADD COLUMN "verify_on_done" BOOLEAN NOT NULL DEFAULT false;

-- Versioned with the rest of the list's dispatch policy, for the same reason the foreman settings
-- are: a revision table that restored some policy and silently not other policy would have no
-- principle a reader could use to tell which. Defaulted rather than backfilled — every existing
-- revision was taken when this setting did not exist, and false is what it behaved as.
ALTER TABLE "task_list_revision" ADD COLUMN "verify_on_done" BOOLEAN NOT NULL DEFAULT false;
