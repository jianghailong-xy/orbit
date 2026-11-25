-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1621: session_legacy_status, the SQL twin of the projector of the legacy status words
-- (src/apiserver/src/sessions/session-legacy-words.ts legacySessionStatus;
-- docs/session-status-retirement-plan.md §3.1; project 353SgnUjvamRr06Sho0EZ, task T4).
--
-- It gives the word a session reads on the wire from its facts, for the database functions that need one (plan §4.2,
-- restated in T6) and for the trigger that keeps the column during deploy 3 (T14). landing_settled_as is the
-- settled_as of a LANDING container's project_landing row (null for every other session). stored_status is the stored
-- word, read for one thing: a held row with no turn_state, which a row not written since 1611 has until the backfill
-- (T3) fills it, keeps its stored word. T14 removes that argument with the column's writers. It returns text, not
-- run_status, so that dropping the type in deploy 4 does not depend on it. An end_reason of '' is an end reason,
-- as the TypeScript `endReason == null` reads it.
--
-- Held to the TypeScript over every combination of the facts by sessions/session-legacy-words.pg.spec.ts.
--
-- Nothing calls it yet. Creating a function locks no table and writes no row; CREATE OR REPLACE can run twice, and
-- rolling back is DROP FUNCTION. 1621: above 1612, the highest on main, every project/*, orbit/* and probe/* branch
-- on 2026-11-25. Not a multiple of 10.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

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
