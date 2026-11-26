-- Undo migration 1691 (deploy D4 of docs/session-status-retirement-plan.md §4.1): session.status and the type
-- run_status are back, filled from the facts, and everything deploy D3 (migration 1671) left is as it was, so a
-- rollback to the D3 release works (its Run now gate, sessions/queued-gate.ts, reads the column: without this script
-- that release's session list answers 500 on a D4 database), and going further back can start from here with
-- scripts/session-status-from-facts-down.sql (D2 code reads the facts and writes both spellings). Run it BEFORE the
-- older release starts to serve.
--
-- THE WORDS. The column is filled with session_legacy_status of each row (the projector's SQL twin, with a landing
-- container's project_landing.settled_as), the word deploy D3's trigger stores. A released row that no write has
-- touched since deploy D2 held a word of its own: for the kinds of plan §3.4 (C1-C8), the owner-accepted ones, it
-- comes back as the facts' word. The words D2 or older code stored are gone with D4.
--
-- THE OBJECTS, from a database migrated through 1681 (pg_get_functiondef, pg_get_triggerdef, pg_get_indexdef):
--   run_status with its eight labels; session.status NOT NULL DEFAULT 'PENDING', its six indexes, the CHECKs
--   session_release_fact_chk and session_turn_state_agrees_chk (both validated); session_turn_state_of_status;
--   session_legacy_status's nine-argument form; the three functions calling it; the 13 trigger column lists with
--   status; session_status_from_facts() and trigger session_aa_status_from_facts. The column comes back at the end of
--   the table: PostgreSQL cannot put a dropped column back in its place, and no query reads columns by position.
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/session-status-drop-down.sql
--
-- After it, delete 1691's row of _prisma_migrations, or the next `prisma migrate deploy` will not drop them again:
--   DELETE FROM _prisma_migrations WHERE migration_name = '1691_session_status_drop';
--
-- LOCKS AND TIME. One transaction (one DO statement). It asks for ACCESS EXCLUSIVE on session, 2 s at a time, 1 s
-- apart, up to 45 tries, then rewrites every row (the fill) and builds the six indexes under that lock, so writers wait
-- until it commits: seconds on a table of 100,000 rows (the PG spec times it). Each owner gets one list-changed hint.
-- Can run twice: it does nothing to a database that has the column.

DO $down$
DECLARE
  tries integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = '"session"'::regclass AND attname = 'status' AND NOT attisdropped) THEN
    RAISE NOTICE 'session.status is here already: nothing to restore';
    RETURN;
  END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE;

      CREATE TYPE run_status AS ENUM
        ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING_INPUT', 'INTERRUPTED', 'PARKED');

      CREATE FUNCTION session_turn_state_of_status(word run_status) RETURNS text
        LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE word::text
           WHEN 'PENDING' THEN 'QUEUED'
           WHEN 'RUNNING' THEN 'IN_FLIGHT'
           WHEN 'INTERRUPTED' THEN 'ABANDONED'
         END
$$;

      CREATE OR REPLACE FUNCTION session_legacy_status(
        finished_at timestamp, turn_state text, end_reason text, last_turn_outcome text, started_at timestamp,
        import_source_cwd text, kind text, landing_settled_as text, stored_status text
      ) RETURNS text
        LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT session_legacy_status(finished_at, turn_state, end_reason, last_turn_outcome, started_at, import_source_cwd,
                               kind, landing_settled_as)
$$;

      -- Added empty, filled while the table is ours, then NOT NULL: no default that a row could keep by mistake.
      ALTER TABLE "session" ADD COLUMN "status" run_status;
      UPDATE "session" s SET "status" = session_legacy_status(
        s."finished_at", s."turn_state", s."end_reason", s."last_turn_outcome", s."started_at", s."import_source_cwd",
        s."kind",
        CASE WHEN s."kind" = 'LANDING' AND s."finished_at" IS NOT NULL AND s."end_reason" IS NULL THEN
          (SELECT pl."settled_as" FROM "project_landing" pl WHERE pl."session_id" = s."id") END
      )::run_status;
      ALTER TABLE "session" ALTER COLUMN "status" SET DEFAULT 'PENDING';
      ALTER TABLE "session" ALTER COLUMN "status" SET NOT NULL;

      CREATE INDEX "session_status_idx" ON "session" ("status");
      CREATE INDEX "session_assigned_runner_id_status_idx" ON "session" ("assigned_runner_id", "status");
      CREATE INDEX "session_batch_id_status_idx" ON "session" ("batch_id", "status");
      CREATE INDEX "session_owner_status_task_idx" ON "session" ("owner_id", "status", "task_id");
      CREATE INDEX "session_root_session_id_status_idx" ON "session" ("root_session_id", "status");
      CREATE INDEX "session_over_capacity_pending_idx" ON "session" ("assigned_runner_id")
        WHERE "over_capacity_turn_id" IS NOT NULL AND "status" = 'PENDING'::run_status;

      ALTER TABLE "session" ADD CONSTRAINT "session_release_fact_chk"
        CHECK (("status"::text = ANY (ARRAY['SUCCEEDED', 'FAILED', 'CANCELLED'])) = ("finished_at" IS NOT NULL));
      ALTER TABLE "session" ADD CONSTRAINT "session_turn_state_agrees_chk"
        CHECK ("turn_state" IS NOT DISTINCT FROM CASE "status"
                 WHEN 'PENDING' THEN 'QUEUED'
                 WHEN 'RUNNING' THEN 'IN_FLIGHT'
                 WHEN 'INTERRUPTED' THEN 'ABANDONED'
               END);

CREATE OR REPLACE FUNCTION public.session_listed_at_on_settle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW."finished_at" IS NOT NULL AND OLD."finished_at" IS NULL)
     OR (NEW."finished_at" IS NOT NULL AND OLD."finished_at" IS NOT NULL
         AND NEW."finished_at" IS DISTINCT FROM OLD."finished_at"
         AND session_legacy_status(OLD."finished_at", NULL, OLD."end_reason", OLD."last_turn_outcome", OLD."started_at",
                                   OLD."import_source_cwd", OLD."kind", NULL, NULL) <> 'FAILED')
     OR (NEW."completed_at" IS NOT NULL AND OLD."completed_at" IS NULL) THEN
    NEW."listed_at" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.session_request_recipient_ended()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "session_request"
     SET "state" = 'RECIPIENT_ENDED',
         "excerpt" = NEW."last_assistant_text",
         "close_reason" = CASE
             WHEN NEW."deleted_at" IS NOT NULL THEN 'TRASHED'
             WHEN NEW."completed_at" IS NOT NULL OR NEW."archived_at" IS NOT NULL THEN 'COMPLETED'
             ELSE session_legacy_status(NEW."finished_at", session_held_turn_state(NEW), NEW."end_reason",
                    NEW."last_turn_outcome", NEW."started_at", NEW."import_source_cwd", NEW."kind",
                    CASE WHEN NEW."kind" = 'LANDING' THEN
                      (SELECT pl."settled_as" FROM "project_landing" pl WHERE pl."session_id" = NEW."id") END,
                    NULL)
           END || COALESCE(':' || NULLIF(NEW."end_reason", ''), ''),
         "closed_at" = CURRENT_TIMESTAMP
   WHERE "to_session_id" = NEW."id" AND "state" = 'OPEN';
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.task_supersession_live_session_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  live_id     UUID;
  live_status TEXT;
BEGIN
  -- The boundary is the FIRST RETIREMENT TRANSITION and nothing else: not-retired → retired. Three
  -- other shapes reach this trigger and none of them is a task being taken away from a live run:
  --
  --   retired → retired    a successor deleted by `ON DELETE SET NULL` (pointer cleared, reason
  --                        kept), a link re-pointed at a later attempt, or the same link restated.
  --                        The task was ALREADY retired before any of these, so nothing is being
  --                        taken from anybody — and refusing them would be worse than useless,
  --                        because §1 deliberately lets a person open a USER session on a retired
  --                        attempt to read or salvage it, and that session would then permanently
  --                        block the FK from doing what a DELETE told it to do;
  --   not retired → not retired   an UPDATE touching some other column;
  --   retired → not retired       undoing a mistaken retirement, which must stay possible.
  --
  -- `terminal_reason IS NOT NULL OR superseded_by_task_id IS NOT NULL` is `taskRetirement()`, the
  -- same predicate the services read, spelled here so both sides answer one question one way.
  IF NOT (NEW."terminal_reason" IS NOT NULL OR NEW."superseded_by_task_id" IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (OLD."terminal_reason" IS NOT NULL OR OLD."superseded_by_task_id" IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  -- All four live statuses (§4.2 guard 5). A run paused at AWAITING_INPUT is a conversation
  -- somebody is in the middle of, and retiring its task out from under it is the same accident with
  -- a person watching.
  --
  -- ...on this task OR on any check pointed at it. The third order of the same race: a check is
  -- running, and its subject is retired underneath it. That leaves a live run verifying replaced
  -- work — the state §2c removes by refusing the repoint, and this removes by refusing the
  -- retirement while the check is in flight. Both directions, so no order of the two commits
  -- reaches it.
  -- Only WORK holds a task against retirement, on either side.
  --
  -- A salvage session is somebody reading a run that already happened; it is not executing the
  -- task, so retiring the task takes nothing from it — and letting it veto the retirement would
  -- mean that opening a window onto a replaced attempt permanently froze the record of the
  -- replacement. §1 permits exactly that window, so this has to permit the retirement beside it.
  --
  -- The verifier side is narrower still: a check of this task holds it only when the check is
  -- itself un-retired. A live salvage on an already-replaced check is history looking at history,
  -- and §13.6's whole point is that history does not block.
  SELECT s."id", session_legacy_status(s."finished_at", session_held_turn_state(s), s."end_reason", s."last_turn_outcome",
                                       s."started_at", s."import_source_cwd", s."kind", NULL, NULL)
    INTO live_id, live_status
    FROM "session" s
    JOIN "task" t ON t."id" = s."task_id"
   WHERE s."deleted_at" IS NULL
     -- Held is `finished_at` null: the four held statuses exactly (session_release_fact_chk, 1401/1402).
     AND s."finished_at" IS NULL
     AND s."starts_task_work"
     AND (
       t."id" = NEW."id"
       OR (t."verifies_task_id" = NEW."id"
           AND t."terminal_reason" IS NULL AND t."superseded_by_task_id" IS NULL)
     )
   ORDER BY s."id" LIMIT 1;

  IF live_id IS NOT NULL THEN
    -- Deliberately not "interrupt it": INTERRUPTED is one of the four statuses this guard counts
    -- as live, so that advice would name an action which leaves the same refusal in place. What
    -- releases the task is the run reaching a terminal status of its own.
    RAISE EXCEPTION
      'TASK_RETIRED_WHILE_RUNNING: task % still has a live session (% is %), so it cannot be recorded as replaced — wait for that run to reach SUCCEEDED, FAILED or CANCELLED first',
      NEW."id", live_id, live_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

      CREATE OR REPLACE FUNCTION session_status_from_facts() RETURNS trigger
        LANGUAGE plpgsql AS $$
BEGIN
  NEW."status" := session_legacy_status(
    NEW."finished_at", NEW."turn_state", NEW."end_reason", NEW."last_turn_outcome", NEW."started_at",
    NEW."import_source_cwd", NEW."kind",
    CASE WHEN NEW."kind" = 'LANDING' AND NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL THEN
      (SELECT pl."settled_as" FROM "project_landing" pl WHERE pl."session_id" = NEW."id") END
  )::run_status;
  RETURN NEW;
END;
$$;

      CREATE OR REPLACE TRIGGER "session_aa_status_from_facts"
        BEFORE INSERT OR UPDATE OF "turn_state", "finished_at", "end_reason", "last_turn_outcome", "started_at",
          "import_source_cwd", "kind"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION session_status_from_facts();

      CREATE OR REPLACE TRIGGER "session_acquisition_engine_guard"
        BEFORE UPDATE OF "status", "turn_state", "inbox_lease_owner", "inbox_lease_generation"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION guard_session_engine_acquisition();
      CREATE OR REPLACE TRIGGER "session_admission_lock_order_update"
        BEFORE UPDATE OF "status", "task_id", "deleted_at", "starts_task_work", "finished_at"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION session_admission_lock_order();
      CREATE OR REPLACE TRIGGER "session_antigravity_runner_claim_guard"
        BEFORE UPDATE OF "status", "turn_state"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION guard_antigravity_runner_claim();
      CREATE OR REPLACE TRIGGER "session_cursor_runner_acquisition_guard"
        BEFORE UPDATE OF "status", "turn_state", "inbox_lease_owner", "inbox_lease_generation"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION guard_cursor_runner_acquisition();
      CREATE OR REPLACE TRIGGER "session_dsh_runner_acquisition_guard"
        BEFORE UPDATE OF "status", "turn_state", "inbox_lease_owner", "inbox_lease_generation"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION guard_dsh_runner_acquisition();
      CREATE OR REPLACE TRIGGER "session_listed_at_settle"
        BEFORE UPDATE OF "status", "completed_at", "finished_at"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION session_listed_at_on_settle();
      CREATE OR REPLACE TRIGGER "session_opencode_runner_claim_guard"
        BEFORE UPDATE OF "status", "turn_state"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION guard_opencode_runner_claim();
      CREATE OR REPLACE TRIGGER "session_project_capacity_serialize_update"
        BEFORE UPDATE OF "status", "task_id", "deleted_at", "finished_at"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION session_project_capacity_serialize();
      CREATE OR REPLACE TRIGGER "session_request_asker_stopped"
        AFTER UPDATE OF "status", "turn_state", "end_reason", "retry_at", "retry_attempts", "retry_claimed_at", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (((new.deleted_at IS NOT NULL) OR (new.completed_at IS NOT NULL) OR (new.archived_at IS NOT NULL) OR ((new.finished_at IS NOT NULL) AND ((NOT ((new.finished_at IS NOT NULL) AND (new.end_reason IS NULL) AND (NOT (new.last_turn_outcome IS DISTINCT FROM 'FAILED'::text)))) OR ((new.retry_at IS NULL) AND (NOT ((old.retry_at IS NOT NULL) AND (new.retry_attempts > old.retry_attempts)))))) OR ((session_held_turn_state(new.*) = 'ABANDONED'::text) AND (COALESCE(new.end_reason, ''::text) <> ''::text)) OR ((new.finished_at IS NULL) AND (session_held_turn_state(new.*) IS NULL) AND (new.retry_at IS NULL) AND (((old.retry_at IS NOT NULL) AND (new.retry_attempts <= old.retry_attempts)) OR (new.retry_attempts < old.retry_attempts) OR ((old.retry_claimed_at IS NOT NULL) AND (new.retry_claimed_at IS NULL))))))
        EXECUTE FUNCTION session_request_asker_stopped();
      CREATE OR REPLACE TRIGGER "session_request_recipient_ended"
        AFTER UPDATE OF "status", "turn_state", "end_reason", "retry_at", "retry_attempts", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (((new.deleted_at IS NOT NULL) OR (new.completed_at IS NOT NULL) OR (new.archived_at IS NOT NULL) OR ((new.finished_at IS NOT NULL) AND ((NOT ((new.finished_at IS NOT NULL) AND (new.end_reason IS NULL) AND (NOT (new.last_turn_outcome IS DISTINCT FROM 'FAILED'::text)))) OR ((new.retry_at IS NULL) AND (NOT ((old.retry_at IS NOT NULL) AND (new.retry_attempts > old.retry_attempts)))))) OR ((session_held_turn_state(new.*) = 'ABANDONED'::text) AND (COALESCE(new.end_reason, ''::text) <> ''::text))))
        EXECUTE FUNCTION session_request_recipient_ended();
      CREATE OR REPLACE TRIGGER "session_superseded_task_revive_guard"
        BEFORE UPDATE OF "status", "task_id", "dispatch_origin", "deleted_at", "starts_task_work", "finished_at"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION session_superseded_task_guard();
      CREATE OR REPLACE TRIGGER "session_zz_phase"
        BEFORE INSERT OR UPDATE OF "status", "turn_state", "finished_at", "engine_turn_active", "running_subagents", "running_bg_jobs", "retry_at"
        ON "session"
        FOR EACH ROW
        EXECUTE FUNCTION session_phase_from_facts();
      CREATE OR REPLACE TRIGGER "task_owner_confirmation_review_reviewer_ended"
        AFTER UPDATE OF "status", "turn_state", "end_reason", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (((new.deleted_at IS NOT NULL) OR (new.completed_at IS NOT NULL) OR (new.archived_at IS NOT NULL) OR ((new.finished_at IS NOT NULL) AND (NOT ((new.finished_at IS NOT NULL) AND (new.end_reason IS NULL) AND (NOT (new.last_turn_outcome IS DISTINCT FROM 'FAILED'::text))))) OR ((session_held_turn_state(new.*) = 'ABANDONED'::text) AND (COALESCE(new.end_reason, ''::text) <> ''::text))))
        EXECUTE FUNCTION task_owner_confirmation_review_reviewer_ended();
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $down$;
