-- A task whose own completion criterion is independent VERIFICATION has no task_start work.
-- Service gates and readiness use the same rule; these triggers preserve it across rolling
-- deploys and raw writers, in both transition orders.
BEGIN;

-- Block concurrent writers while preserving ordinary read traffic. ACCESS EXCLUSIVE here would
-- deadlock with an in-flight Session admission that already owns its Session table intent lock and
-- is about to read Task; SHARE ROW EXCLUSIVE gives this transaction the write quiescence it needs
-- without blocking that read.
LOCK TABLE "task" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "session" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE conflicting text;
BEGIN
  SELECT string_agg(format('task %s session %s (%s)', t."id", s."id", s."status"), E'\n')
    INTO conflicting
    FROM "task" t
    JOIN "session" s ON s."task_id" = t."id"
                         AND s."deleted_at" IS NULL
                         AND s."starts_task_work"
                         AND s."status"::text IN (
                           'PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'
                         )
   WHERE t."completion_criterion"::text = 'VERIFICATION'
     AND t."verifies_task_id" IS NULL;
  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION E'TASK_VERIFICATION_SUBJECT_LIVE_SESSION: independent-verification subjects already hold live task-work sessions:\n%', conflicting;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "session_verification_subject_guard"() RETURNS trigger AS $$
DECLARE criterion text; subject_id uuid;
BEGIN
  IF NEW."task_id" IS NULL
     OR NEW."deleted_at" IS NOT NULL
     OR NOT NEW."starts_task_work"
     OR NEW."status"::text NOT IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED') THEN
    RETURN NEW;
  END IF;

  -- session_admission_lock_order sorts before this trigger and already holds the task FOR SHARE.
  -- A concurrent criterion/verifier-role update therefore cannot move after this answer.
  SELECT t."completion_criterion"::text, t."verifies_task_id"
    INTO criterion, subject_id
    FROM "task" t
   WHERE t."id" = NEW."task_id";
  IF FOUND AND criterion = 'VERIFICATION' AND subject_id IS NULL THEN
    RAISE EXCEPTION
      'TASK_VERIFICATION_SUBJECT: task % is completed by its independent verifier, so it has no work of its own to run.',
      NEW."task_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "session_verification_subject_guard_insert" ON "session";
CREATE TRIGGER "session_verification_subject_guard_insert"
  BEFORE INSERT ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_verification_subject_guard"();

DROP TRIGGER IF EXISTS "session_verification_subject_guard_update" ON "session";
CREATE TRIGGER "session_verification_subject_guard_update"
  BEFORE UPDATE OF "status", "task_id", "deleted_at", "starts_task_work" ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_verification_subject_guard"();

CREATE OR REPLACE FUNCTION "task_verification_subject_live_session_guard"() RETURNS trigger AS $$
DECLARE live_session uuid;
BEGIN
  IF NEW."completion_criterion"::text <> 'VERIFICATION' OR NEW."verifies_task_id" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- This task row is already write-locked. A concurrent Session admission must take FOR SHARE on
  -- it first, so either this transition observes that session or the later admission observes the
  -- verification-subject shape; neither order can commit both facts.
  SELECT s."id" INTO live_session
    FROM "session" s
   WHERE s."task_id" = NEW."id"
     AND s."deleted_at" IS NULL
     AND s."starts_task_work"
     AND s."status"::text IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
   LIMIT 1;
  IF live_session IS NOT NULL THEN
    RAISE EXCEPTION
      'TASK_VERIFICATION_SUBJECT_LIVE_SESSION: task % cannot become an independent-verification subject while task-work session % is live.',
      NEW."id", live_session
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "task_verification_subject_live_session_guard" ON "task";
CREATE TRIGGER "task_verification_subject_live_session_guard"
  BEFORE UPDATE OF "completion_criterion", "verifies_task_id" ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_verification_subject_live_session_guard"();

COMMIT;
