-- Keep K5's enqueue constraint while admitting the owner's unchecked landing generation.
ALTER TABLE "project_integration_job_event"
  DROP CONSTRAINT "project_integration_job_event_enqueue_cause_chk",
  ADD CONSTRAINT "project_integration_job_event_enqueue_cause_chk" CHECK (
    "kind" <> 'ENQUEUED' OR "data"->>'cause' IS NULL OR
    "data"->>'cause' IN ('DONE', 'RETRY', 'SKIP_CHECK', 'BACKFILL', 'BEHIND_WORK', 'BASELINE_HELD', 'DECISION', 'AUTOMATIC'));
