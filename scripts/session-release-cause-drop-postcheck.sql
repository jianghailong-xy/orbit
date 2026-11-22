-- After deploy 3: migrations 1433, 1434 and 1435 ran (docs/session-three-state-design.md §12.6, removal steps R6 to
-- R8). The counts of the project's criterion 4J7dG9NLThZlZlSlaoUg3p, read-only.
--
--   psql "$DATABASE_URL" -X -f scripts/session-release-cause-drop-postcheck.sql
--
-- Expected:
--   release_cause_columns           0: information_schema lists no session.release_cause.
--   release_cause_constraints       0: pg_constraint holds none naming it.
--   failed_without_failed_outcome   0: released, status FAILED, no end reason, last turn outcome other than FAILED, not in
--                                   Trash (the criterion's count; 1433 wrote every such row).
--   trashed_without_failed_outcome  the precheck's trashed_unbridged, or more by the failed imports since: the same rows
--                                   in Trash, which 1433 does not write and nothing reads as failures.
--   residual_a2_rows                0: released, not FAILED, no end reason, last turn outcome FAILED.
--   terminal_status_triggers        0: no trigger on session names SUCCEEDED, FAILED or CANCELLED as a run status.
SELECT
  (SELECT count(*) FROM "information_schema"."columns"
    WHERE "table_name" = 'session' AND "column_name" = 'release_cause') AS release_cause_columns,
  (SELECT count(*) FROM "pg_constraint"
    WHERE "conname" LIKE '%release_cause%' OR pg_get_constraintdef("oid") LIKE '%release_cause%')
    AS release_cause_constraints,
  (SELECT count(*) FROM "session"
    WHERE "finished_at" IS NOT NULL AND "end_reason" IS NULL AND "status"::text = 'FAILED'
      AND "last_turn_outcome" IS DISTINCT FROM 'FAILED' AND "deleted_at" IS NULL) AS failed_without_failed_outcome,
  (SELECT count(*) FROM "session"
    WHERE "finished_at" IS NOT NULL AND "end_reason" IS NULL AND "status"::text = 'FAILED'
      AND "last_turn_outcome" IS DISTINCT FROM 'FAILED' AND "deleted_at" IS NOT NULL) AS trashed_without_failed_outcome,
  (SELECT count(*) FROM "session"
    WHERE "finished_at" IS NOT NULL AND "end_reason" IS NULL AND "status"::text <> 'FAILED'
      AND "last_turn_outcome" = 'FAILED') AS residual_a2_rows,
  (SELECT count(*) FROM "pg_trigger"
    WHERE "tgrelid" = '"session"'::regclass AND NOT "tgisinternal"
      AND pg_get_triggerdef("oid") ~ '''(SUCCEEDED|FAILED|CANCELLED)''::run_status') AS terminal_status_triggers;
