-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1667: a released session an armed retry will re-send is RUNNING, not IDLE (the owner's ruling of 2026-11-26:
-- "waiting for retry counts as the running state"; docs/session-three-state-design.md §4.2, amended).
--
-- WHAT IT CHANGES
-- ---------------
--   session_phase_of(finished_at, turn_state, engine_turn_active, running_subagents, running_bg_jobs, retry_at)
--                       a six-argument form of 1611's rule: released reads RUNNING while retry_at is set, IDLE otherwise;
--                       a held row reads as before (a held session's armed retry, a quota parked at AWAITING_INPUT, stays
--                       IDLE). 1611's five-argument form is left in place, unused by the trigger, so 1651's one-off
--                       assertion still reads what it read.
--   session_phase_from_facts()   calls the six-argument form.
--   trigger session_zz_phase     also fires on UPDATE OF retry_at, so arming and clearing a retry moves the phase.
--   the rows                     every released row with retry_at set gets phase RUNNING, written as phase alone: a
--                       write naming retry_at would fire 1641's session_request_* AFTER triggers, which on a release
--                       that is not a failure announce the end again. Naming phase fires no row trigger (session_zz_phase
--                       does not list it); only 0484's statement-level open-list epoch bump, which refreshes the lists.
--                       Expected: a few rows at most, the retries armed at deploy time.
--
-- The published phase is deriveSessionPhase (src/apiserver/src/sessions/session-phase.ts), which reads the same rule;
-- sessions/session-turn-state-phase.pg.spec.ts holds the trigger to it. No CHECK ties phase to the release.
--
-- WHICH RELEASE IT MAY SHIP IN, ROLLBACK
-- --------------------------------------
-- Any. An older replica during the hand-over publishes IDLE for these rows from its own derivation (no reader acts on
-- the stored column). Rollback: re-run 1611's CREATE FUNCTION session_phase_from_facts and CREATE TRIGGER
-- session_zz_phase, then `UPDATE "session" SET "phase" = 'IDLE' WHERE "finished_at" IS NOT NULL AND "phase" = 'RUNNING'`.
--
-- LOCKS
-- -----
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE; asked for 2 s at a time, 1 s apart, up to 45 tries, as 1611 does. The
-- functions are created before it and lock no table. The UPDATE runs after it, in the same transaction, and touches
-- only the armed released rows. The file holds a DO block, so prisma migrate deploy sends it whole, as one transaction.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1667: main holds up to 1656 (1656_device_token_web_keys); no pushed branch or local worktree holds 1657 or above
-- (checked 2026-11-26). Can run twice: CREATE OR REPLACE for the functions, DROP TRIGGER IF EXISTS before CREATE, and a
-- second UPDATE finds nothing left.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION session_phase_of(
  finished_at timestamp, turn_state text, engine_turn_active boolean, running_subagents text[], running_bg_jobs text[],
  retry_at timestamp
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN finished_at IS NOT NULL THEN CASE WHEN retry_at IS NOT NULL THEN 'RUNNING' ELSE 'IDLE' END
           WHEN turn_state = 'IN_FLIGHT' THEN 'RUNNING'
           WHEN COALESCE(engine_turn_active, false)
             OR COALESCE(cardinality(running_subagents), 0) > 0
             OR COALESCE(cardinality(running_bg_jobs), 0) > 0 THEN 'RUNNING'
           WHEN turn_state = 'QUEUED' THEN 'PENDING'
           ELSE 'IDLE'
         END
$$;

CREATE OR REPLACE FUNCTION session_phase_from_facts() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."phase" := session_phase_of(NEW."finished_at", NEW."turn_state", NEW."engine_turn_active",
                                  NEW."running_subagents", NEW."running_bg_jobs", NEW."retry_at");
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
      DROP TRIGGER IF EXISTS "session_zz_phase" ON "session";
      CREATE TRIGGER "session_zz_phase"
        BEFORE INSERT OR UPDATE OF "status", "turn_state", "finished_at", "engine_turn_active", "running_subagents",
          "running_bg_jobs", "retry_at" ON "session"
        FOR EACH ROW EXECUTE FUNCTION session_phase_from_facts();
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  UPDATE "session" SET "phase" = 'RUNNING'
   WHERE "finished_at" IS NOT NULL AND "retry_at" IS NOT NULL AND "phase" IS DISTINCT FROM 'RUNNING';
END $$;
