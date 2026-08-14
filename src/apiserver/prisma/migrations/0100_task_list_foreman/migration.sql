-- A foreman for a task list: coordination dispatched as an ordinary task when the list stalls.
--
-- The shape matters more than the feature. A foreman is NOT a resident session watching the
-- list. It is woken by a condition, does one bounded piece of work — read the state, decide,
-- write policy or file tasks — and ends. Being an ordinary task is what lets it inherit the
-- retry, reaping, slot accounting, quota gating and audit that every other run already has,
-- rather than needing a second set of guarantees built for it. A long-lived supervisor session
-- would be subject to precisely the failures it exists to notice: this deployment's own history
-- has a session that created 43 lists and ~21,500 tasks and then sat FAILED, and another that
-- has been RUNNING for eight days.
--
-- The condition is "nothing happened", not "something failed". Every incident this is built for
-- looks identical from the outside — a wedged session still holding its task, a livelocked
-- merge, a spent quota nobody was told about — and not one of them raises an error anywhere.
-- What they have in common is that work remained, nothing was running, and nothing had started
-- for a long time. That is what is detected here, and nothing detects it today.
ALTER TABLE "task_list" ADD COLUMN "foreman_workspace_id" UUID;
ALTER TABLE "task_list" ADD COLUMN "foreman_stall_minutes" INTEGER;

ALTER TABLE "task_list" ADD CONSTRAINT "task_list_foreman_workspace_id_fkey"
    FOREIGN KEY ("foreman_workspace_id") REFERENCES "workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Marks a task as coordination over its list rather than one of the list's units of work.
--
-- Two things read it. The run prompt skips the list's standing instructions for such a task —
-- those say how the work is done, and the foreman is not doing the work. And an unfinished
-- foreman suppresses further dispatch for that list, which is what stops a stall (a condition
-- that by definition persists) from minting a new coordinator every single sweep. That is the
-- same mistake the auto-run reconciler made before it was given a brake, and it is worth not
-- making twice.
ALTER TABLE "task" ADD COLUMN "is_foreman" BOOLEAN NOT NULL DEFAULT false;

-- Foreman configuration is dispatch policy, so it is versioned with the rest of it. Leaving it
-- out would mean the revision table restored some policy and silently not other policy, with no
-- principle a reader could use to tell which — and "when does coordination fire" is exactly the
-- kind of setting someone would want to undo.
--
-- No FK on the revision's copy: it is a historical value, and a workspace being deleted must not
-- rewrite what the policy was at the time. Restoring a revision that names a deleted workspace
-- fails at the live column's own FK, which is the right place for that to be caught.
ALTER TABLE "task_list_revision" ADD COLUMN "foreman_workspace_id" UUID;
ALTER TABLE "task_list_revision" ADD COLUMN "foreman_stall_minutes" INTEGER;
