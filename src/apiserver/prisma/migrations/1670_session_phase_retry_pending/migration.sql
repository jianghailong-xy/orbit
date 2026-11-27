-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1670: a session an armed retry will re-send is PENDING, held or released (the owner's ruling of 2026-11-26, which
-- replaces that day's earlier one that 1667 stored: waiting for a retry is PENDING, not RUNNING;
-- docs/session-three-state-design.md §4.2, amended).
--
-- WHAT IT CHANGES
-- ---------------
--   session_phase_of(finished_at, turn_state, engine_turn_active, running_subagents, running_bg_jobs, retry_at)
--                       1667's six-argument form, restated: released reads PENDING while retry_at is set, IDLE
--                       otherwise; a held row that executes nothing and has no turn queued reads PENDING while retry_at
--                       is set (it read IDLE). Executing still outranks it: RUNNING.
--   session_phase_from_facts(), trigger session_zz_phase
--                       unchanged: 1667's already call the six-argument form and fire on UPDATE OF retry_at.
--   the rows            every row the new rule reads differently, written as phase alone: released RUNNING rows with
--                       retry_at set, and held IDLE rows with retry_at set that execute nothing. A write naming retry_at
--                       would fire 1641's session_request_* AFTER triggers (see 1667); naming phase fires no row trigger,
--                       only 0484's statement-level open-list epoch bump, which refreshes the lists. Expected: a few rows
--                       at most, the retries armed at deploy time.
--
-- The published phase is deriveSessionPhase (src/apiserver/src/sessions/session-phase.ts), which reads the same rule;
-- sessions/session-turn-state-phase.pg.spec.ts holds the trigger to it.
--
-- WHICH RELEASE IT MAY SHIP IN, ROLLBACK
-- --------------------------------------
-- The release whose deriveSessionPhase reads the same rule. An older replica during the hand-over publishes its own
-- derivation (no reader acts on the stored column). Rollback: re-run 1667's CREATE FUNCTION session_phase_of, then
-- `UPDATE "session" SET "phase" = session_phase_of("finished_at", "turn_state", "engine_turn_active",
-- "running_subagents", "running_bg_jobs", "retry_at") WHERE "retry_at" IS NOT NULL`.
--
-- LOCKS
-- -----
-- No DDL on the table: CREATE OR REPLACE FUNCTION locks no table, and the UPDATE takes row locks on the armed rows only.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1670: main holds up to 1669 (1669_codex_reset_operation_account_slot); unpushed branches hold 1671 and 1672, none
-- 1670 (checked 2026-11-26). Can run twice: CREATE OR REPLACE for the function, and a second UPDATE finds nothing left.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION session_phase_of(
  finished_at timestamp, turn_state text, engine_turn_active boolean, running_subagents text[], running_bg_jobs text[],
  retry_at timestamp
) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN finished_at IS NOT NULL THEN CASE WHEN retry_at IS NOT NULL THEN 'PENDING' ELSE 'IDLE' END
           WHEN turn_state = 'IN_FLIGHT' THEN 'RUNNING'
           WHEN COALESCE(engine_turn_active, false)
             OR COALESCE(cardinality(running_subagents), 0) > 0
             OR COALESCE(cardinality(running_bg_jobs), 0) > 0 THEN 'RUNNING'
           WHEN turn_state = 'QUEUED' OR retry_at IS NOT NULL THEN 'PENDING'
           ELSE 'IDLE'
         END
$$;

UPDATE "session"
   SET "phase" = session_phase_of("finished_at", "turn_state", "engine_turn_active", "running_subagents",
                                  "running_bg_jobs", "retry_at")
 WHERE "retry_at" IS NOT NULL
   AND "phase" IS DISTINCT FROM session_phase_of("finished_at", "turn_state", "engine_turn_active", "running_subagents",
                                                 "running_bg_jobs", "retry_at");
