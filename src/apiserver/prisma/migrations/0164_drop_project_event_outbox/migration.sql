-- The control loop's signal path, removed. `project_event` was its inbox: eleven triggers across
-- seven tables enqueued into it and the loop drained it. The loop is gone, so every one of those
-- writes has been landing in a table with no reader — on every task, session and approval write.
--
-- Also removed: five guards over `dispatch_origin = 'PROJECT_COORDINATOR'` sessions. Those rows
-- are a closed set now (202 of them, newest from before the loop was removed), because opening a
-- coordinator conversation goes through `sessions.create({ source: 'user' })` and is USER-origin.
-- Guarding a set nothing adds to only blocks ordinary work — deleting a task hit exactly this.
--
-- Deliberately KEPT, because they are not the loop:
--   * `project_coordinator_pointer_guard` — validates that `project.coordinator_session_id` names
--     a live session of the same owner in the right workspace. The Open-coordinator path writes
--     that pointer, so this guard protects a feature that is still very much in use.
--   * `project_coordinator_reconcile` (three triggers) and `_identity_window_repair` — they
--     maintain `project_runtime`, which `ProjectsService.get` still reads for
--     `coordinatorGeneration`.
--   * `project_action`'s two triggers — that table is still read by `verification-dependency.ts`.

-- 1. The producers.
DROP TRIGGER IF EXISTS "project_workspace_availability_event_source" ON "workspace";
DROP TRIGGER IF EXISTS "project_approval_event_source" ON "approval";
DROP TRIGGER IF EXISTS "project_model_provider_availability_event_source" ON "model_provider";
DROP TRIGGER IF EXISTS "project_runner_availability_event_source" ON "runner";
DROP TRIGGER IF EXISTS "project_session_event_source" ON "session";
DROP TRIGGER IF EXISTS "project_session_event_source_update" ON "session";
DROP TRIGGER IF EXISTS "project_task_event_source" ON "task";
DROP TRIGGER IF EXISTS "project_task_dependency_event_source" ON "task_dependency";
DROP TRIGGER IF EXISTS "project_coordinator_session_event_source" ON "project";
DROP TRIGGER IF EXISTS "project_user_edit_event_source" ON "project";

-- 2. The guards over a set that no longer grows.
DROP TRIGGER IF EXISTS "session_coordinator_snapshot_guard" ON "session";
DROP TRIGGER IF EXISTS "session_coordinator_snapshot_immutable" ON "session";
DROP TRIGGER IF EXISTS "session_dispatch_attribution_check" ON "session";
DROP TRIGGER IF EXISTS "session_dispatch_authority_guard" ON "session";
DROP TRIGGER IF EXISTS "session_dispatch_dependency_check" ON "session";

DROP FUNCTION IF EXISTS "session_coordinator_snapshot_guard"();
DROP FUNCTION IF EXISTS "session_coordinator_snapshot_immutable"();
DROP FUNCTION IF EXISTS "session_dispatch_attribution_check"();
DROP FUNCTION IF EXISTS "session_dispatch_authority_guard"();
DROP FUNCTION IF EXISTS "session_dispatch_dependency_check"();

-- 3. The table, and the marker that existed only to deduplicate its signals.
--    `task_run_manual_trigger` was written by `recordManualProjectTriggers` and read by nobody;
--    that method goes with this change. `project_event_notify_pending` rides on the table.
-- Explicit, though DROP TABLE would cascade to it: the write-inventory contract test reads
-- these migrations statically and only counts a trigger as gone when a DROP names it.
DROP TRIGGER IF EXISTS "project_event_notify_pending" ON "project_event";
DROP TABLE IF EXISTS "project_event";
DROP TABLE IF EXISTS "task_run_manual_trigger";

-- 4. The producer functions, after both their triggers and their table.
DROP FUNCTION IF EXISTS "project_workspace_availability_event_source"();
DROP FUNCTION IF EXISTS "project_approval_event_source"();
DROP FUNCTION IF EXISTS "project_model_provider_availability_event_source"();
DROP FUNCTION IF EXISTS "project_runner_availability_event_source"();
DROP FUNCTION IF EXISTS "project_session_event_source"();
DROP FUNCTION IF EXISTS "project_task_event_source"();
DROP FUNCTION IF EXISTS "project_task_dependency_event_source"();
DROP FUNCTION IF EXISTS "project_coordinator_session_event_source"();
DROP FUNCTION IF EXISTS "project_user_edit_event_source"();
DROP FUNCTION IF EXISTS "project_event_notify_pending"();

-- 5. `project_acceptance_reopen` enqueued a dirty signal after reopening acceptance. Five live
--    trigger functions call it — project_acceptance_criteria_fact, _task_fact, _merge_fact,
--    task_supersession_project_lock_order and task_aggregate_parent_shape_guard — so leaving the
--    INSERT in would make every task write and every acceptance fact change fail once the table is
--    gone. Replayed from the CURRENT definition with only that INSERT removed; the audit row it
--    writes just above is untouched, and that is the part anything reads.
CREATE OR REPLACE FUNCTION "project_acceptance_reopen"(p_project uuid, p_fact text, p_detail jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $$
DECLARE
  current_status  TEXT;
  current_run     UUID;
  current_legacy  TIMESTAMP(3);
BEGIN
  IF p_project IS NULL THEN RETURN; END IF;

  -- AE6-a's lock, taken by whoever got here first. `FOR NO KEY UPDATE` and not `FOR SHARE`: AE8
  -- may have to UPDATE this very row, and §8.6 LO3 forbids the upgrade that would deadlock.
  SELECT p."status"::text, p."accepted_run_id", p."legacy_accepted_at"
    INTO current_status, current_run, current_legacy
    FROM "project" p WHERE p."id" = p_project FOR NO KEY UPDATE;
  IF NOT FOUND OR current_status <> 'DONE' THEN RETURN; END IF;
  IF current_run IS NULL THEN RETURN; END IF;   -- legacy DONE: see the comment above

  -- Every run that could still be used is retired by this fact change, not only the bound one:
  -- otherwise a superseded-then-unsuperseded ordering could hand the next DONE an older PASS.
  UPDATE "project_acceptance_run"
     SET "superseded_at" = CURRENT_TIMESTAMP,
         "superseded_reason" = 'reopened_by_fact_change:' || p_fact
   WHERE "project_id" = p_project AND "superseded_at" IS NULL;

  UPDATE "project"
     SET "status" = 'OPEN', "accepted_run_id" = NULL, "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" = p_project;

  INSERT INTO "project_acceptance_audit" ("id", "project_id", "kind", "run_id", "reason", "detail")
  VALUES (gen_random_uuid(), p_project, 'reopened_by_fact_change', current_run,
          p_fact, COALESCE(p_detail, '{}'::jsonb));

END;
$$;

-- 6. The orphan producer chain: nine functions that only ever wrote to the outbox, none of them
--    reachable from any trigger or from any function that is.
DROP FUNCTION IF EXISTS "project_event_engine_unavailable"(p_engines jsonb, p_provider text);
DROP FUNCTION IF EXISTS "project_event_fanout_provider"(p_source_id uuid, p_provider text, p_runner_id uuid, p_owner_id uuid, p_kind text, p_payload jsonb);
DROP FUNCTION IF EXISTS "project_event_fanout_runner"(p_runner_id uuid, p_kind text, p_payload jsonb, p_dedupe_key text);
DROP FUNCTION IF EXISTS "project_event_fanout_runner_capability"(p_runner_id uuid, p_provider text, p_payload jsonb);
DROP FUNCTION IF EXISTS "project_event_fanout_workspace"(p_workspace_id uuid, p_runner_id uuid, p_payload jsonb);
DROP FUNCTION IF EXISTS "project_event_quota_exhausted"(p_usage jsonb, p_provider text, p_at timestamp with time zone);
DROP FUNCTION IF EXISTS "project_event_manual_trigger"(p_project_id uuid, p_user_id uuid, p_request_id uuid);
DROP FUNCTION IF EXISTS "project_event_enqueue_signal"(p_project_id uuid, p_kind text, p_source_type text, p_source_id uuid, p_payload jsonb, p_dedupe_key text);
