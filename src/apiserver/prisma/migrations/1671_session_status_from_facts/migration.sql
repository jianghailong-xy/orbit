-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1671: the stored word follows the facts (docs/session-status-retirement-plan.md §4.1 and §4.3, deploy D3; project
-- 353SgnUjvamRr06Sho0EZ, task T14).
--
-- From this deploy no server code reads or writes session.status: the writers write turn_state, finished_at and the
-- facts beside them, and the field has left the Prisma model. The column stays until deploy D4 (task T15) drops it,
-- and this file keeps it equal to the word the facts give, for one reader only: deploy-2 code, should the release be
-- rolled back to it (plan §4.1: "to D2 code only").
--
-- WHAT IT CHANGES
-- ---------------
--   session_legacy_status(finished_at, turn_state, end_reason, last_turn_outcome, started_at, import_source_cwd, kind,
--                         landing_settled_as)
--       NEW: the eight-argument form of 1621's projector twin, which reads no stored word: a held row with no turn
--       state is parked (AWAITING_INPUT). legacySessionStatusSql (sessions/session-legacy-words.ts) calls it.
--   session_legacy_status(…, stored_status)   1621's nine-argument form, restated to answer the eight-argument form and
--       ignore stored_status: what a deploy-2 replica calls during the hand-over, and what 1641's functions call (with
--       NULL). Its fallback is dead since 1652 validated session_turn_state_agrees_chk (no held row has a NULL
--       turn_state beside a word that names a turn). T15 drops it.
--   session_held_turn_state(session)   1641's: `CASE WHEN finished_at IS NULL THEN turn_state END`, no stored word.
--       Every caller (the five engine guards, open_list_bump_owner, the three ended-trigger WHEN clauses,
--       session_request_recipient_ended, task_supersession_live_session_guard) stays as it is.
--   session_status_from_facts()   NEW, and trigger session_aa_status_from_facts, BEFORE INSERT OR UPDATE OF turn_state,
--       finished_at, end_reason, last_turn_outcome, started_at, import_source_cwd, kind: the stored word is
--       session_legacy_status of the row, a LANDING container's settlement read from its project_landing row (P3).
--       It replaces 1611's session_aa_turn_state_from_status (the facts followed the word), which is dropped with its
--       function session_turn_state_from_status. Named `aa` as that one was, so it runs first of the BEFORE triggers;
--       no other BEFORE trigger writes a column it reads (session-turn-state-phase.pg.spec.ts reads the catalog for it).
--   column lists (plan §4.2; the two items T6 left to this task, comment 353j9PXw1D2Npfm9ZT4Hm):
--       + turn_state   session_acquisition_engine_guard, session_opencode_runner_claim_guard,
--                      session_antigravity_runner_claim_guard, session_cursor_runner_acquisition_guard,
--                      session_dsh_runner_acquisition_guard, session_request_recipient_ended,
--                      session_request_asker_stopped, task_owner_confirmation_review_reviewer_ended
--       + finished_at  session_listed_at_settle
--       Each is re-created with its definition as a database migrated through 1667 holds it (pg_get_triggerdef), the
--       column added and nothing else; `status` stays in every list until D4.
--
-- WHY THE TRIGGERS FIRE WHERE THEY FIRED
-- --------------------------------------
-- An UPDATE OF trigger fires on the columns a statement names. Deploy 2's writers named `status` exactly where they
-- named `turn_state` (the dual write the guard spec held them to, and session_turn_state_agrees_chk), so the writers of
-- this deploy, which name turn_state alone, fire every listed trigger on the statements that fired it before. Every
-- release writes finished_at in the statement that writes it (session_release_fact_chk), so session_listed_at_settle,
-- whose body reads finished_at, fires on every release as it did on the word.
--
-- WHY THE STORED WORD IS THE FACTS' WORD
-- --------------------------------------
-- Every writer of a fact the word is made from names that fact, so the trigger runs on every write that can change
-- the word, inserts included (a new row's default PENDING is overwritten). The one input outside the row, a LANDING
-- container's project_landing.settled_as, is written before the container's own row by both of its writers
-- (projects/landing-session.ts: the settle updates project_landing, then the session; the opening reads a landing
-- that exists). The CHECKs still hold: a held row's word is its turn state's (session_turn_state_agrees_chk), and a
-- released row's word is a released one (session_release_fact_chk). The word differs from the one deploy 2 stored
-- only for the released kinds of plan §3.4 (C1-C8), which the owner accepted. sessions/session-status-from-facts.pg.spec.ts
-- drives every writer path, and a deploy-2 write of both spellings, through it.
--
-- WHICH RELEASE IT MAY SHIP IN, ROLLBACK
-- --------------------------------------
-- With the code of deploy D3, after D2 is live everywhere (it is: 1651-1655 applied and validated on production,
-- 2026-11-26). During the hand-over the D2 replica writes the word and turn_state together, consistently; this trigger
-- runs on those statements too (they name turn_state) and stores the facts' word. A stray D2 write of the word alone
-- names no fact, so this trigger does not undo it: session_turn_state_agrees_chk refuses it loudly instead. Rollback
-- to D2 code is free: it reads only the facts and the projected word, and writes both. Rollback of this file is
-- scripts/session-status-from-facts-down.sql (1611's session_aa_turn_state_from_status, 1641's
-- session_held_turn_state, 1621's nine-argument function and the nine trigger definitions without the added column);
-- not to D1 code (plan §4.1).
--
-- LOCKS
-- -----
-- CREATE OR REPLACE FUNCTION takes no table lock. DROP TRIGGER, CREATE TRIGGER and CREATE OR REPLACE TRIGGER take
-- SHARE ROW EXCLUSIVE on session (DROP TRIGGER: ACCESS EXCLUSIVE): all are asked for in one DO statement, 2 s at a
-- time, 1 s apart, up to 45 tries (1261, 1401, 1611, 1641). The file holds a DO block, so prisma migrate deploy (7.10)
-- sends it whole, as one transaction: the functions and the triggers change together. Nothing in it COMMITs. No row
-- is written.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1671: main holds up to 1667 (1667_session_phase_retry_running); no project/*, pushed orbit/* or probe/* branch and
-- no local worktree holds 1668 or above (all 1,514 remote heads scanned 2026-11-26). Not a multiple of 10. Can run
-- twice: CREATE OR REPLACE for the functions and the restated triggers, DROP … IF EXISTS before CREATE TRIGGER.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION session_legacy_status(
  finished_at timestamp, turn_state text, end_reason text, last_turn_outcome text, started_at timestamp,
  import_source_cwd text, kind text, landing_settled_as text
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN finished_at IS NULL THEN
             CASE turn_state
               WHEN 'QUEUED' THEN 'PENDING'
               WHEN 'IN_FLIGHT' THEN 'RUNNING'
               WHEN 'ABANDONED' THEN 'INTERRUPTED'
               ELSE 'AWAITING_INPUT'
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

CREATE OR REPLACE FUNCTION session_legacy_status(
  finished_at timestamp, turn_state text, end_reason text, last_turn_outcome text, started_at timestamp,
  import_source_cwd text, kind text, landing_settled_as text, stored_status text
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT session_legacy_status(finished_at, turn_state, end_reason, last_turn_outcome, started_at, import_source_cwd,
                               kind, landing_settled_as)
$$;

CREATE OR REPLACE FUNCTION session_held_turn_state(s "session") RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN s."finished_at" IS NULL THEN s."turn_state" END
$$;

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

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      DROP TRIGGER IF EXISTS "session_aa_turn_state_from_status" ON "session";
      DROP TRIGGER IF EXISTS "session_aa_status_from_facts" ON "session";
      CREATE TRIGGER "session_aa_status_from_facts"
        BEFORE INSERT OR UPDATE OF "turn_state", "finished_at", "end_reason", "last_turn_outcome", "started_at",
          "import_source_cwd", "kind" ON "session"
        FOR EACH ROW EXECUTE FUNCTION session_status_from_facts();

      CREATE OR REPLACE TRIGGER "session_acquisition_engine_guard"
        BEFORE UPDATE OF "status", "turn_state", "inbox_lease_owner", "inbox_lease_generation" ON "session"
        FOR EACH ROW EXECUTE FUNCTION guard_session_engine_acquisition();
      CREATE OR REPLACE TRIGGER "session_opencode_runner_claim_guard"
        BEFORE UPDATE OF "status", "turn_state" ON "session"
        FOR EACH ROW EXECUTE FUNCTION guard_opencode_runner_claim();
      CREATE OR REPLACE TRIGGER "session_antigravity_runner_claim_guard"
        BEFORE UPDATE OF "status", "turn_state" ON "session"
        FOR EACH ROW EXECUTE FUNCTION guard_antigravity_runner_claim();
      CREATE OR REPLACE TRIGGER "session_cursor_runner_acquisition_guard"
        BEFORE UPDATE OF "status", "turn_state", "inbox_lease_owner", "inbox_lease_generation" ON "session"
        FOR EACH ROW EXECUTE FUNCTION guard_cursor_runner_acquisition();
      CREATE OR REPLACE TRIGGER "session_dsh_runner_acquisition_guard"
        BEFORE UPDATE OF "status", "turn_state", "inbox_lease_owner", "inbox_lease_generation" ON "session"
        FOR EACH ROW EXECUTE FUNCTION guard_dsh_runner_acquisition();

      CREATE OR REPLACE TRIGGER "session_listed_at_settle"
        BEFORE UPDATE OF "status", "completed_at", "finished_at" ON "session"
        FOR EACH ROW EXECUTE FUNCTION session_listed_at_on_settle();

      CREATE OR REPLACE TRIGGER "session_request_recipient_ended"
        AFTER UPDATE OF "status", "turn_state", "end_reason", "retry_at", "retry_attempts", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
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
        AFTER UPDATE OF "status", "turn_state", "end_reason", "retry_at", "retry_attempts", "retry_claimed_at", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
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
        AFTER UPDATE OF "status", "turn_state", "end_reason", "finished_at", "last_turn_outcome", "completed_at", "archived_at", "deleted_at"
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

DROP FUNCTION IF EXISTS session_turn_state_from_status();
