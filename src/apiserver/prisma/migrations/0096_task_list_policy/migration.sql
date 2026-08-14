-- Per-list dispatch policy: an emergency stop and a concurrency cap.
--
-- A task list had no policy of its own — only a title. Everything that governs how its tasks
-- reach a runner lived either on the individual task (auto_run_when_ready) or as a compile-time
-- constant in the reconciler. That left two gaps a real campaign hits immediately:
--
-- 1. No stop. When a 500-task list dispatches wrongly there was no way to halt it short of
--    editing the reconciler and redeploying — which is literally how the last incident was
--    stopped. `paused` makes that one write.
--
-- 2. No fairness. The claim transaction caps concurrency per runner and per *batch*, and the
--    auto-run path sets no batch at all, so a list with hundreds of ready tasks takes every
--    free slot on its runner and starves every other list behind it for as long as it runs.
--    `max_concurrent` lets a list act as its own concurrency domain, reusing that same batch
--    gate rather than introducing a second scheduler.
--
-- Both default to the pre-existing behaviour: not paused, uncapped. Nothing changes for an
-- existing list until someone sets a value, so this is a pure add — no backfill, no cutover.
ALTER TABLE "task_list" ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "task_list" ADD COLUMN "max_concurrent" INTEGER;
