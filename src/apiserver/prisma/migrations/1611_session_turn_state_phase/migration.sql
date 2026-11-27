-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1611: session.turn_state and session.phase, kept from the stored word by triggers (docs/session-status-retirement-plan.md
-- §1.2, §1.3, §4.1 deploy D1; project 353SgnUjvamRr06Sho0EZ, task T2).
--
-- WHAT IT ADDS
-- ------------
--   session.turn_state  text, nullable: QUEUED, IN_FLIGHT, ABANDONED or null. Where the session's turn stands for the
--                       runner. One for one with today's held words: PENDING = QUEUED (waits for a claim), RUNNING =
--                       IN_FLIGHT (a dispatched turn holds a runner slot), INTERRUPTED = ABANDONED (its runner was
--                       stopped under it), AWAITING_INPUT and every released word = null.
--   session.phase       text, nullable until deploy 2 sets NOT NULL: PENDING, RUNNING or IDLE. deriveSessionPhase
--                       (src/apiserver/src/sessions/session-phase.ts), stored.
--   session_turn_state_chk, session_phase_chk   value CHECKs, NOT VALID here; 1612 validates them in a file with no DO.
--   session_turn_state_of_status(run_status)    the word's turn state, as above.
--   session_phase_of(finished_at, turn_state, engine_turn_active, running_subagents, running_bg_jobs)   the phase rule:
--                       released reads IDLE; a dispatched turn, or on a held session the engine's own turn, a sub-agent
--                       or a background job, reads RUNNING; a queued turn with nothing executing reads PENDING; else
--                       IDLE. It reads nothing outside the row.
--   trigger session_aa_turn_state_from_status   BEFORE INSERT OR UPDATE OF status: turn_state follows the word.
--   trigger session_zz_phase                    BEFORE INSERT OR UPDATE OF status, turn_state, finished_at and the
--                       three execution columns: phase follows the facts.
--
-- The names order the two among the BEFORE row triggers on session, which PostgreSQL fires by name: `aa` before every
-- other one (`session_ac…` and on), `zz` after all of them, so phase reads the turn_state the first one wrote. No other
-- BEFORE trigger on session assigns status, finished_at, engine_turn_active, running_subagents, running_bg_jobs,
-- turn_state or phase (sessions/session-turn-state-phase.pg.spec.ts reads the catalog for it), so a statement that
-- changes any of them names one of the columns these triggers fire on. An engine guard that skips the claim (it
-- returns NULL) skips the whole row, the two new columns with it.
--
-- WHAT IT DOES NOT DO
-- -------------------
-- No row is written: existing rows keep null in both columns until scripts/session-turn-state-backfill.sql (task T3,
-- with the owner's go) has run; scripts/session-turn-state-census.sql counts what disagrees. The Prisma model does
-- not declare the two columns (task T4 adds them, for deploy 2), so no payload carries them and no code reads or
-- writes them: the stored word still decides everything. The old label PARKED (0071 rewrote every such row to
-- CANCELLED; nothing writes it) has turn_state null; the census counts PARKED rows, expected 0.
--
-- WHICH RELEASE IT MAY SHIP IN, ROLLBACK
-- --------------------------------------
-- Any. Both replicas of a hand-over write the word only, and the triggers keep the facts from it: the NOT VALID CHECKs
-- check every new write, and the functions give only allowed values. Rollback is free, the columns being unused;
-- scripts/session-turn-state-phase-down.sql drops what this file and 1612 add.
--
-- LOCKS
-- -----
-- ADD COLUMN with no default and ADD CONSTRAINT … NOT VALID are catalog changes (no row rewritten, none checked) under
-- ACCESS EXCLUSIVE; CREATE TRIGGER takes SHARE ROW EXCLUSIVE. All are asked for in one DO statement, 2 s at a time,
-- 1 s apart, up to 45 tries, as 1261, 1401 and 1443 do. The functions are created before it and lock no table. The
-- file holds a DO block, so prisma migrate deploy (7.10) sends it whole, as one transaction; nothing in it COMMITs.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1611: main, every project/* and every pushed orbit/* and probe/* branch use up to 1600 (all 987 remote heads
-- scanned 2026-11-25), and no local worktree has more. Not a multiple of 10. Can run twice: CREATE OR REPLACE for the
-- functions, IF NOT EXISTS for the columns, IF EXISTS drops before the CHECKs and the triggers.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION session_turn_state_of_status(word run_status) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE word::text
           WHEN 'PENDING' THEN 'QUEUED'
           WHEN 'RUNNING' THEN 'IN_FLIGHT'
           WHEN 'INTERRUPTED' THEN 'ABANDONED'
         END
$$;

CREATE OR REPLACE FUNCTION session_phase_of(
  finished_at timestamp, turn_state text, engine_turn_active boolean, running_subagents text[], running_bg_jobs text[]
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN finished_at IS NOT NULL THEN 'IDLE'
           WHEN turn_state = 'IN_FLIGHT' THEN 'RUNNING'
           WHEN COALESCE(engine_turn_active, false)
             OR COALESCE(cardinality(running_subagents), 0) > 0
             OR COALESCE(cardinality(running_bg_jobs), 0) > 0 THEN 'RUNNING'
           WHEN turn_state = 'QUEUED' THEN 'PENDING'
           ELSE 'IDLE'
         END
$$;

CREATE OR REPLACE FUNCTION session_turn_state_from_status() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."turn_state" := session_turn_state_of_status(NEW."status");
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION session_phase_from_facts() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."phase" := session_phase_of(NEW."finished_at", NEW."turn_state", NEW."engine_turn_active",
                                  NEW."running_subagents", NEW."running_bg_jobs");
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
      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "turn_state" text;
      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "phase" text;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_turn_state_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_turn_state_chk"
        CHECK ("turn_state" IS NULL OR "turn_state" IN ('QUEUED', 'IN_FLIGHT', 'ABANDONED')) NOT VALID;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_phase_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_phase_chk"
        CHECK ("phase" IN ('PENDING', 'RUNNING', 'IDLE')) NOT VALID;
      DROP TRIGGER IF EXISTS "session_aa_turn_state_from_status" ON "session";
      CREATE TRIGGER "session_aa_turn_state_from_status"
        BEFORE INSERT OR UPDATE OF "status" ON "session"
        FOR EACH ROW EXECUTE FUNCTION session_turn_state_from_status();
      DROP TRIGGER IF EXISTS "session_zz_phase" ON "session";
      CREATE TRIGGER "session_zz_phase"
        BEFORE INSERT OR UPDATE OF "status", "turn_state", "finished_at", "engine_turn_active", "running_subagents",
          "running_bg_jobs" ON "session"
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
END $$;
