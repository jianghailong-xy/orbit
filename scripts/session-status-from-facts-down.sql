-- Undo migration 1671 (deploy D3 of docs/session-status-retirement-plan.md §4.1): the stored word follows the facts
-- again only through the D1 trigger, session_held_turn_state reads the stored word for a held row with no turn_state,
-- session_legacy_status's nine-argument form reads the word it is handed, and the nine trigger column lists lose the
-- turn_state / finished_at 1671 gave them. What a database migrated through 1667 held.
--
-- Only for a rollback to deploy-2 code (it writes both spellings, and reads the facts): D3 code writes turn_state
-- alone, and against the D1 trigger a write of turn_state alone keeps the word it had, which the agreement CHECK
-- refuses. The PG specs of deploys D1 and D2 run on a database rolled back with this file, because what they hold to
-- account is the database those deploys left.
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/session-status-from-facts-down.sql
--
-- After it, delete 1671's row of _prisma_migrations, or the next `prisma migrate deploy` will not put it back:
--   DELETE FROM _prisma_migrations WHERE migration_name = '1671_session_status_from_facts';
--
-- session_legacy_status's eight-argument form stays: it reads no column, deploy-2 code does not call it, and D3 code
-- reading a database rolled back with this file still can. The definitions are 1611's, 1621's and 1641's (pg_get_triggerdef of a database migrated through 1667 for the
-- column lists). The locks are asked for as 1671 asks for them: one DO statement, 2 s at a time, 1 s apart, up to 45
-- tries. No row is written. Can run twice: CREATE OR REPLACE and IF EXISTS throughout.

CREATE OR REPLACE FUNCTION session_turn_state_from_status() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."turn_state" := session_turn_state_of_status(NEW."status");
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION session_held_turn_state(s "session") RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN s."finished_at" IS NULL
              THEN COALESCE(s."turn_state", session_turn_state_of_status(s."status")) END
$$;

CREATE OR REPLACE FUNCTION session_legacy_status(
  finished_at timestamp, turn_state text, end_reason text, last_turn_outcome text, started_at timestamp,
  import_source_cwd text, kind text, landing_settled_as text, stored_status text
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN finished_at IS NULL THEN
             CASE turn_state
               WHEN 'QUEUED' THEN 'PENDING'
               WHEN 'IN_FLIGHT' THEN 'RUNNING'
               WHEN 'ABANDONED' THEN 'INTERRUPTED'
               ELSE
                 CASE WHEN turn_state IS NULL AND stored_status IN ('PENDING', 'RUNNING', 'INTERRUPTED') THEN stored_status
                      ELSE 'AWAITING_INPUT' END
             END
           WHEN end_reason IS NULL AND last_turn_outcome IS NOT DISTINCT FROM 'FAILED' THEN 'FAILED'
           WHEN end_reason IS NULL AND last_turn_outcome IS NULL AND import_source_cwd IS NOT NULL THEN 'FAILED'
           WHEN end_reason IS NULL AND kind IS NOT DISTINCT FROM 'LANDING' THEN
             CASE WHEN landing_settled_as IN ('LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'MERGED') THEN 'SUCCEEDED'
                  ELSE 'CANCELLED' END
           WHEN end_reason IS NOT DISTINCT FROM 'task_done' AND started_at IS NOT NULL THEN 'SUCCEEDED'
           ELSE 'CANCELLED'
         END
$$;

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      DROP TRIGGER IF EXISTS "session_aa_status_from_facts" ON "session";
      DROP TRIGGER IF EXISTS "session_aa_turn_state_from_status" ON "session";
      CREATE TRIGGER "session_aa_turn_state_from_status"
        BEFORE INSERT OR UPDATE OF "status" ON "session"
        FOR EACH ROW EXECUTE FUNCTION session_turn_state_from_status();

      CREATE OR REPLACE TRIGGER "session_acquisition_engine_guard"
        BEFORE UPDATE OF "status", "inbox_lease_owner", "inbox_lease_generation" ON "session"
        FOR EACH ROW EXECUTE FUNCTION guard_session_engine_acquisition();
      CREATE OR REPLACE TRIGGER "session_opencode_runner_claim_guard"
        BEFORE UPDATE OF "status" ON "session"
        FOR EACH ROW EXECUTE FUNCTION guard_opencode_runner_claim();
      CREATE OR REPLACE TRIGGER "session_antigravity_runner_claim_guard"
        BEFORE UPDATE OF "status" ON "session"
        FOR EACH ROW EXECUTE FUNCTION guard_antigravity_runner_claim();
      CREATE OR REPLACE TRIGGER "session_cursor_runner_acquisition_guard"
        BEFORE UPDATE OF "status", "inbox_lease_owner", "inbox_lease_generation" ON "session"
        FOR EACH ROW EXECUTE FUNCTION guard_cursor_runner_acquisition();
      CREATE OR REPLACE TRIGGER "session_dsh_runner_acquisition_guard"
        BEFORE UPDATE OF "status", "inbox_lease_owner", "inbox_lease_generation" ON "session"
        FOR EACH ROW EXECUTE FUNCTION guard_dsh_runner_acquisition();

      CREATE OR REPLACE TRIGGER "session_listed_at_settle"
        BEFORE UPDATE OF "status", "completed_at" ON "session"
        FOR EACH ROW EXECUTE FUNCTION session_listed_at_on_settle();

      CREATE OR REPLACE TRIGGER "session_request_recipient_ended"
        AFTER UPDATE OF "status", "end_reason", "retry_at", "retry_attempts", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL
              AND (NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED')
                   OR (NEW."retry_at" IS NULL
                       AND NOT (OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" > OLD."retry_attempts"))))
          OR (session_held_turn_state(NEW) = 'ABANDONED' AND COALESCE(NEW."end_reason", '') <> '')
        )
        EXECUTE FUNCTION "session_request_recipient_ended"();

      CREATE OR REPLACE TRIGGER "session_request_asker_stopped"
        AFTER UPDATE OF "status", "end_reason", "retry_at", "retry_attempts", "retry_claimed_at", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL
              AND (NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED')
                   OR (NEW."retry_at" IS NULL
                       AND NOT (OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" > OLD."retry_attempts"))))
          OR (session_held_turn_state(NEW) = 'ABANDONED' AND COALESCE(NEW."end_reason", '') <> '')
          OR (NEW."finished_at" IS NULL AND session_held_turn_state(NEW) IS NULL AND NEW."retry_at" IS NULL
              AND ((OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" <= OLD."retry_attempts")
                   OR NEW."retry_attempts" < OLD."retry_attempts"
                   OR (OLD."retry_claimed_at" IS NOT NULL AND NEW."retry_claimed_at" IS NULL)))
        )
        EXECUTE FUNCTION "session_request_asker_stopped"();

      CREATE OR REPLACE TRIGGER "task_owner_confirmation_review_reviewer_ended"
        AFTER UPDATE OF "status", "end_reason", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
        ON "session"
        FOR EACH ROW
        WHEN (
          NEW."deleted_at" IS NOT NULL
          OR NEW."completed_at" IS NOT NULL
          OR NEW."archived_at" IS NOT NULL
          OR (NEW."finished_at" IS NOT NULL AND NOT (NEW."finished_at" IS NOT NULL AND NEW."end_reason" IS NULL AND NEW."last_turn_outcome" IS NOT DISTINCT FROM 'FAILED'))
          OR (session_held_turn_state(NEW) = 'ABANDONED' AND COALESCE(NEW."end_reason", '') <> '')
        )
        EXECUTE FUNCTION "task_owner_confirmation_review_reviewer_ended"();
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS session_status_from_facts();
