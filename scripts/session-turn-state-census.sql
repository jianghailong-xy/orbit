-- The turn_state / phase census (docs/session-status-retirement-plan.md §4.4, §7.2): how far the stored facts of
-- migration 1611 agree with the stored word. Run it after scripts/session-turn-state-backfill.sh (task T3), and in
-- the rehearsal on a production-shaped copy (task T16).
--
--   psql "$DATABASE_URL" -X -f scripts/session-turn-state-census.sql
--
-- One read-only SELECT: it takes no lock beyond what any read takes and writes nothing. It reads the word, not the
-- functions 1611 added: its derivations are written out below, from today's TypeScript (deriveSessionPhase in
-- src/apiserver/src/sessions/session-phase.ts; the word-to-turn-state table of the plan §1.4), so it checks the
-- triggers instead of repeating them.
--
-- Expected, and what a different answer means:
--   rows                    every session row.
--   turn_state_disagrees    0 after the backfill. turn_state is not the word's (PENDING = QUEUED, RUNNING = IN_FLIGHT,
--                           INTERRUPTED = ABANDONED, any other word = null). Not 0: the backfill has not finished, or
--                           something wrote turn_state against the word; deploy 2 refuses to run on such a row.
--   phase_disagrees         0 after the backfill. phase is not deriveSessionPhase of the row: released = IDLE; RUNNING,
--                           or a held word with the engine's turn, a sub-agent or a background job = RUNNING; PENDING
--                           = PENDING; else IDLE.
--   phase_null              0 after the backfill (deploy 2 sets phase NOT NULL). Before it, the rows not yet written.
--   parked_rows             0. The dead label PARKED (0071 rewrote every such row); not 0: report it.
--   released_with_turn      0. A released row whose turn_state is set: the word's table gives none.
--   by_word                 the rows by (status, turn_state, phase) as stored, with how many disagree: one entry per
--                           combination found, so a kind no one expected shows up by name.
--   by_shape                the rows by (status, end_reason, last_turn_outcome, kind, import marker, trashed), the
--                           columns §7.2 groups the legacy-word census by; T16 adds the derived word beside them.

WITH s AS (
  SELECT x."status"::text AS word,
         x."turn_state",
         x."phase",
         x."finished_at" IS NOT NULL AS released,
         x."end_reason",
         x."last_turn_outcome",
         x."kind",
         x."import_source_cwd" IS NOT NULL AS imported,
         x."deleted_at" IS NOT NULL AS trashed,
         CASE x."status"::text
           WHEN 'PENDING' THEN 'QUEUED'
           WHEN 'RUNNING' THEN 'IN_FLIGHT'
           WHEN 'INTERRUPTED' THEN 'ABANDONED'
         END AS word_turn_state,
         CASE
           WHEN x."finished_at" IS NOT NULL THEN 'IDLE'
           WHEN x."status"::text = 'RUNNING' THEN 'RUNNING'
           WHEN x."status"::text IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
            AND (x."engine_turn_active" OR cardinality(x."running_subagents") > 0
                 OR cardinality(x."running_bg_jobs") > 0) THEN 'RUNNING'
           WHEN x."status"::text = 'PENDING' THEN 'PENDING'
           ELSE 'IDLE'
         END AS word_phase
    FROM "session" x
), judged AS (
  SELECT s.*,
         s."turn_state" IS DISTINCT FROM s.word_turn_state AS turn_state_off,
         s."phase" IS DISTINCT FROM s.word_phase AS phase_off
    FROM s
)
SELECT
  count(*)::int                                                    AS rows,
  count(*) FILTER (WHERE turn_state_off)::int                      AS turn_state_disagrees,
  count(*) FILTER (WHERE phase_off)::int                           AS phase_disagrees,
  count(*) FILTER (WHERE "phase" IS NULL)::int                     AS phase_null,
  count(*) FILTER (WHERE word = 'PARKED')::int                     AS parked_rows,
  count(*) FILTER (WHERE released AND "turn_state" IS NOT NULL)::int AS released_with_turn,
  (SELECT COALESCE(jsonb_agg(w ORDER BY w->>'status', w->>'turn_state', w->>'phase'), '[]'::jsonb) FROM (
     SELECT jsonb_build_object('status', word, 'turn_state', "turn_state", 'phase', "phase", 'rows', count(*),
                               'disagree', count(*) FILTER (WHERE turn_state_off OR phase_off)) AS w
       FROM judged GROUP BY word, "turn_state", "phase") b)          AS by_word,
  (SELECT COALESCE(jsonb_agg(k ORDER BY k->>'status', k->>'end_reason', k->>'last_turn_outcome', k->>'kind'), '[]'::jsonb) FROM (
     SELECT jsonb_build_object('status', word, 'end_reason', "end_reason", 'last_turn_outcome', "last_turn_outcome",
                               'kind', "kind", 'imported', imported, 'trashed', trashed, 'rows', count(*)) AS k
       FROM judged GROUP BY word, "end_reason", "last_turn_outcome", "kind", imported, trashed) c) AS by_shape
FROM judged;
