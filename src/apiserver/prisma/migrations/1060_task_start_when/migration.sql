-- 1060 — a task's startWhen (docs/condition-triggers-design.md §3, §5.2, §6.2; C4 of §11).
--
-- WHAT IT ADDS
-- ============
--   * `task.start_when_condition_id`: the condition that starts this task, a peer of `run_at`. A task has at most
--     one of the two (`task_run_at_or_start_when_chk`). The due scans read it (tasks.service.ts SCHEDULED_DUE_SQL and
--     the two ready predicates); the start that keeps it clears it, as a start clears `run_at`. ON DELETE SET NULL:
--     the condition row goes only with its task (condition_task_id_fkey cascades), so this never fires in practice.
--   * `condition.keep_waiting_since`: when the owner last answered Keep waiting on the 30-day question (§6.2). The
--     next question is due 30 days after it, or after the condition was created when it is NULL.
--   * the kind CONDITION_STILL_WAITING: that question, in Waiting on you. `owner_request_kind_chk` (1030) is widened
--     again, never narrowed.
--   * `condition_ended_with_task`: a task that is cancelled, done or failed ends its condition, whichever door wrote
--     the status (§6.2: "Cancelling or deleting the task ends the condition"; deleting the task deletes the row).
--   * `condition_probe_changed`: a condition created, ended or deleted wakes the runner of its workspace at COMMIT
--     with the runner-wake payload `notifyRunnerWakeOnCommit` writes (realtime/runner-wake.ts), which every replica
--     turns into markRunnerChanged. So the heartbeat hands the probe out, or withdraws it, at once instead of at the
--     runner's next full reconcile.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two nullable columns with no default, a kind check widened, a CHECK every stored row passes (no task has a
-- start_when_condition_id yet) and two triggers. No stored row is rewritten.
--
-- 1060: the highest number in use on origin/main, every origin/project/* and origin/orbit/* was 1030 on 2026-11-17;
-- 1040 and 1050 are left for the other condition-trigger phases.

ALTER TABLE "task" ADD COLUMN "start_when_condition_id" UUID;
CREATE UNIQUE INDEX "task_start_when_condition_id_key" ON "task" ("start_when_condition_id");
ALTER TABLE "task" ADD CONSTRAINT "task_start_when_condition_id_fkey"
  FOREIGN KEY ("start_when_condition_id") REFERENCES "condition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task" ADD CONSTRAINT "task_run_at_or_start_when_chk"
  CHECK ("run_at" IS NULL OR "start_when_condition_id" IS NULL);

ALTER TABLE "condition" ADD COLUMN "keep_waiting_since" TIMESTAMPTZ(3);

ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_kind_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_kind_chk"
  CHECK ("kind" IN ('DECISION', 'SECRET', 'MANUAL_STEP', 'CONFIRM', 'WIKI_CREATE',
                    'SCHEDULE_FAILED', 'SCHEDULE_HELD', 'SCHEDULE_APPROVAL', 'SCHEDULE_WIDEN',
                    'CONDITION_UNKNOWN', 'CONDITION_STILL_WAITING'));

-- A task that leaves OPEN for good ends its condition. Row-level and narrow: only a status change into a terminal
-- status, and only a task that has a condition, does any work.
CREATE OR REPLACE FUNCTION "condition_ended_with_task"() RETURNS trigger AS $$
BEGIN
  UPDATE "condition"
     SET "state" = 'ENDED', "ended_at" = now(), "updated_at" = now()
   WHERE "task_id" = NEW."id" AND "state" <> 'ENDED';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "condition_ended_with_task"
  AFTER UPDATE OF "status" ON "task"
  FOR EACH ROW
  WHEN (NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" IN ('CANCELLED', 'DONE', 'FAILED'))
  EXECUTE FUNCTION "condition_ended_with_task"();

-- What a runner probes changed: wake it at commit (pg_notify is transactional), as notifyRunnerWakeOnCommit does.
CREATE OR REPLACE FUNCTION "condition_probe_changed"() RETURNS trigger AS $$
DECLARE
  row_ "condition";
  runner UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN row_ := OLD; ELSE row_ := NEW; END IF;
  IF TG_OP = 'UPDATE' AND NOT (NEW."state" = 'ENDED' AND OLD."state" <> 'ENDED') THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' AND OLD."state" = 'ENDED' THEN RETURN NULL; END IF;
  SELECT w."runner_id" INTO runner FROM "workspace" w WHERE w."id" = row_."workspace_id";
  IF runner IS NOT NULL THEN
    PERFORM pg_notify('orbit_runner_wake', json_build_object('r', runner, 'c', true)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "condition_probe_changed"
  AFTER INSERT OR UPDATE OF "state" OR DELETE ON "condition"
  FOR EACH ROW EXECUTE FUNCTION "condition_probe_changed"();
