-- Before deploy 2: can migration 1426 build session_task_execution_claim_idx_finished_at on this database?
-- (docs/session-three-state-plan.md §7 step 4.5, release A; the migration's header says why each count matters.)
--
-- One read-only SELECT, safe on production as it stands today (deploy 1: no session_release_fact_chk yet). It takes
-- no lock beyond what any read takes and writes nothing; each subquery is one scan of `session`.
--
--   psql "$DATABASE_URL" -X -f scripts/session-claim-index-precheck.sql
--
-- Expected, and what a different answer means:
--   parked_rows                  0. Not 0: a PARKED row in a task, not in the Trash, counts as that task's live run
--                                under the new index (the CHECK keeps its finished_at NULL). If its task holds another
--                                live row, the build fails (INVALID index, P3009); otherwise the build succeeds and the
--                                row refuses every new run of its task. Move such rows to CANCELLED first, as 0071 did.
--   tasks_doubled_after_1402     0. The duplicates the build would meet once 1402 has made the release column agree with
--                                the status. The old index refuses all of them but those PARKED adds, so not 0 means
--                                PARKED rows (above) or an old index that is not valid.
--   tasks_doubled_as_stored      0, or any number when tasks_doubled_after_1402 is 0: the same count read from
--                                finished_at as stored today. Rows a hand-over window left terminal with finished_at NULL
--                                are counted here, and 1402 (which runs before 1426) sets their finished_at.
--   terminal_rows_unreleased     0 or a handful: terminal rows with finished_at NULL, which 1402 writes.
--   held_rows_released           0 or a handful: held rows with finished_at set, which 1402 clears.
--   old_index_valid              true.
SELECT
  (SELECT count(*) FROM "session" WHERE "status"::text = 'PARKED') AS parked_rows,
  (SELECT count(*) FROM (
     SELECT "task_id" FROM "session"
      WHERE "task_id" IS NOT NULL AND "deleted_at" IS NULL
        AND "status"::text IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED', 'PARKED')
      GROUP BY "task_id" HAVING count(*) > 1) d) AS tasks_doubled_after_1402,
  (SELECT count(*) FROM (
     SELECT "task_id" FROM "session"
      WHERE "task_id" IS NOT NULL AND "deleted_at" IS NULL AND "finished_at" IS NULL
      GROUP BY "task_id" HAVING count(*) > 1) d) AS tasks_doubled_as_stored,
  (SELECT count(*) FROM "session"
    WHERE "status"::text IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND "finished_at" IS NULL) AS terminal_rows_unreleased,
  (SELECT count(*) FROM "session"
    WHERE "status"::text IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
      AND "finished_at" IS NOT NULL) AS held_rows_released,
  (SELECT bool_and(i."indisvalid") FROM "pg_index" i
    WHERE i."indexrelid" = 'session_task_execution_claim_idx'::regclass) AS old_index_valid;
