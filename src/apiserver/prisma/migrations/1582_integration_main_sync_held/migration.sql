-- docs/design/project-line-upstream-sync.md §5: a landing held behind the line-sync item is queued
-- again with cause MAIN_SYNC_HELD, the twin of K5's BASELINE_HELD (0518, widened by 1101).
ALTER TABLE "project_integration_job_event"
  DROP CONSTRAINT "project_integration_job_event_enqueue_cause_chk",
  ADD CONSTRAINT "project_integration_job_event_enqueue_cause_chk" CHECK (
    "kind" <> 'ENQUEUED' OR "data"->>'cause' IS NULL OR
    "data"->>'cause' IN ('DONE', 'RETRY', 'SKIP_CHECK', 'BACKFILL', 'BEHIND_WORK', 'BASELINE_HELD', 'MAIN_SYNC_HELD',
                         'DECISION', 'AUTOMATIC')),
  ADD CONSTRAINT "project_integration_job_event_main_sync_held_chk" CHECK (
    "kind" <> 'ENQUEUED' OR "data"->>'cause' IS DISTINCT FROM 'MAIN_SYNC_HELD' OR
    "data"->>'kind' IS NOT DISTINCT FROM 'LAND_TASK');
