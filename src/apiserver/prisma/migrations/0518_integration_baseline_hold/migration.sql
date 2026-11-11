-- K5's enqueue cause lives in the immutable ENQUEUED event, as the existing causes do.
-- Historical observations and early events may omit cause; a supplied cause is a closed set.
ALTER TABLE "project_integration_job_event"
  ADD CONSTRAINT "project_integration_job_event_enqueue_cause_chk" CHECK (
    "kind" <> 'ENQUEUED' OR "data"->>'cause' IS NULL OR
    "data"->>'cause' IN ('DONE', 'RETRY', 'BACKFILL', 'BEHIND_WORK', 'BASELINE_HELD', 'DECISION', 'AUTOMATIC')),
  ADD CONSTRAINT "project_integration_job_event_baseline_held_chk" CHECK (
    "kind" <> 'ENQUEUED' OR "data"->>'cause' IS DISTINCT FROM 'BASELINE_HELD' OR
    "data"->>'kind' IS NOT DISTINCT FROM 'LAND_TASK');
