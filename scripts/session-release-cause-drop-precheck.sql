-- Before deploy 3: what migrations 1433 (turn outcome backfill), 1434 (the triggers lose the status bridge) and 1435
-- (DROP COLUMN release_cause) will meet on this database (docs/session-three-state-design.md §12.6, removal steps R6 to
-- R8; each migration's header says why). Run it while deploy 2 serves, after every deploy-1 server has gone.
--
-- One read-only SELECT. It takes no lock beyond what any read takes and writes nothing. It names release_cause, so it
-- runs only before 1435; after the deploy, run scripts/session-release-cause-drop-postcheck.sql instead.
--
--   psql "$DATABASE_URL" -X -f scripts/session-release-cause-drop-precheck.sql
--
-- <bridged> below is the row 1433 writes last_turn_outcome = 'FAILED' on: released, status FAILED, no end reason, no
-- FAILED turn outcome, not in Trash. Deploy 2 reads these as failures only through the status bridge.
--
-- Expected, and what a different answer means:
--   bridged_rows                    any number: the rows the bridge carries today. 1433 writes FAILED on each; the
--                                   postcheck's bridged_rows is 0 after it.
--   bridged_by_cause                the same rows by the cause deploy 1 wrote, as JSON: the hand-over shapes are
--                                   runner_lost (H2), setup_failed (H4), engine_failed (H6); older rows say what wrote
--                                   them. null keys are rows released with no cause (before 1261, or by deploy 2: deploy
--                                   2 records the turn outcome, so it should leave none of these).
--   bridged_since_deploy2           bridged rows released after deploy 2 was live on every server (2026-11-22 04:09:45
--                                   UTC): 0. Not 0: a deploy-2 writer released a failure without its turn outcome, and
--                                   deploy 3 would read the next such row as a stop; stop and report it.
--   bridged_without_failed_turn     bridged rows none of whose turns has outcome FAILED: as many as bridged_rows, or a
--                                   few fewer. The turn outcome a session copies is its latest turn's, so a row whose
--                                   failed turn was followed by another can differ; either way 1433 writes the session.
--   carrying_turns                  the turns 1433 writes outcome FAILED on (§12.1's rule: the work turn IN_FLIGHT, else
--                                   the oldest PENDING one, with no outcome yet): a handful, from refused sources (H4).
--   residual_a2_rows                0 (0 on 2026-11-21 and 2026-11-22). Released, not FAILED, no end reason, a FAILED
--                                   copy kept: 1433 writes CANCELLED on each, so they read as stops.
--   stale_copy_rows                 any number. Released, not FAILED, an end reason, last_turn_outcome FAILED (N2: a
--                                   turn failed while its session was being ended): an end was asked, so a stop with or
--                                   without the bridge, and 1433 does not write them; listed so nothing is assumed.
--   trashed_unbridged               any number: FAILED, released, no end reason, no FAILED turn outcome, in Trash. 1433
--                                   writes none of them; after deploy 3 they read as stops. failed_imports is how many of
--                                   them are failed transcript imports (W5).
--   failed_imports                  any number, at most trashed_unbridged.
--   requests_closed_by_backfill     0. OPEN session requests to a bridged row with no retry armed: 1433's write fires
--                                   session_request_recipient_ended, which closes them RECIPIENT_ENDED (as the release
--                                   should have). Not 0: name them before the deploy.
--   replies_due_by_backfill         0. Held replies whose asker is a bridged row that session_request_asker_stopped
--                                   would mark due.
--   reviews_ended_by_backfill       0. Unanswered reviews whose reviewer is an A2 row (reviewer_ended fires for it once it
--                                   reads as a stop).
--   causes_after_deploy2            0. Rows released after 2026-11-22 04:09:45 UTC with a release_cause: deploy 2 writes
--                                   none. Not 0: either a deploy-1 server still serves (stop the deploy) or the row was
--                                   released by deploy 1, revived and released again by deploy 2, which leaves the old
--                                   value alone (latest_cause_release says when).
--   latest_cause_release            the newest finished_at of a row with a release_cause: before 04:09:45 on 2026-11-22.
--   other_dependents                0. pg_depend rows on session.release_cause other than session_release_cause_chk's:
--                                   1435 refuses to drop anything if this is not 0.
--   release_cause_chk_valid         true.
WITH bridged AS (
  SELECT s."id", s."release_cause", s."finished_at", s."retry_at"
    FROM "session" s
   WHERE s."finished_at" IS NOT NULL AND s."end_reason" IS NULL AND s."status"::text = 'FAILED'
     AND s."last_turn_outcome" IS DISTINCT FROM 'FAILED' AND s."deleted_at" IS NULL
), a2 AS (
  SELECT s."id"
    FROM "session" s
   WHERE s."finished_at" IS NOT NULL AND s."end_reason" IS NULL AND s."status"::text <> 'FAILED'
     AND s."last_turn_outcome" = 'FAILED'
), trashed AS (
  SELECT s."id", s."import_source_cwd"
    FROM "session" s
   WHERE s."finished_at" IS NOT NULL AND s."end_reason" IS NULL AND s."status"::text = 'FAILED'
     AND s."last_turn_outcome" IS DISTINCT FROM 'FAILED' AND s."deleted_at" IS NOT NULL
)
SELECT
  (SELECT count(*) FROM bridged) AS bridged_rows,
  (SELECT json_object_agg(COALESCE(cause, 'null'), n) FROM (
     SELECT "release_cause" AS cause, count(*) AS n FROM bridged GROUP BY "release_cause") c) AS bridged_by_cause,
  (SELECT count(*) FROM bridged WHERE "finished_at" >= TIMESTAMP '2026-11-22 04:09:45') AS bridged_since_deploy2,
  (SELECT count(*) FROM bridged b WHERE NOT EXISTS (
     SELECT 1 FROM "conversation_turn" t WHERE t."session_id" = b."id" AND t."outcome" = 'FAILED'))
    AS bridged_without_failed_turn,
  (SELECT count(*) FROM bridged b WHERE EXISTS (
     SELECT 1 FROM "conversation_turn" t
      WHERE t."session_id" = b."id" AND t."outcome" IS NULL
        AND t."id" = (SELECT c."id" FROM "conversation_turn" c
                       WHERE c."session_id" = b."id" AND c."kind" IN ('message', 'shell')
                         AND c."status" IN ('IN_FLIGHT', 'PENDING')
                       ORDER BY (c."status" = 'IN_FLIGHT') DESC, c."seq" ASC LIMIT 1))) AS carrying_turns,
  (SELECT count(*) FROM a2) AS residual_a2_rows,
  (SELECT count(*) FROM "session" s
    WHERE s."finished_at" IS NOT NULL AND s."end_reason" IS NOT NULL AND s."status"::text <> 'FAILED'
      AND s."last_turn_outcome" = 'FAILED') AS stale_copy_rows,
  (SELECT count(*) FROM trashed) AS trashed_unbridged,
  (SELECT count(*) FROM trashed WHERE "import_source_cwd" IS NOT NULL) AS failed_imports,
  (SELECT count(*) FROM "session_request" r JOIN bridged b ON b."id" = r."to_session_id"
    WHERE r."state" = 'OPEN' AND b."retry_at" IS NULL) AS requests_closed_by_backfill,
  (SELECT count(*) FROM "session_request" r JOIN bridged b ON b."id" = r."from_session_id"
    WHERE r."state" <> 'OPEN' AND r."reply_client_turn_id" IS NULL AND r."reply_held_at" IS NOT NULL
      AND r."reply_comment_due_at" IS NULL) AS replies_due_by_backfill,
  (SELECT count(*) FROM "task_owner_confirmation_review" v JOIN a2 ON a2."id" = v."reviewer_session_id"
    WHERE v."reviewer_ended_at" IS NULL) AS reviews_ended_by_backfill,
  (SELECT count(*) FROM "session"
    WHERE "release_cause" IS NOT NULL AND "finished_at" >= TIMESTAMP '2026-11-22 04:09:45') AS causes_after_deploy2,
  (SELECT max("finished_at") FROM "session" WHERE "release_cause" IS NOT NULL) AS latest_cause_release,
  (SELECT count(*) FROM "pg_depend" d
     JOIN "pg_attribute" a ON a."attrelid" = d."refobjid" AND a."attnum" = d."refobjsubid"
    WHERE d."refclassid" = 'pg_class'::regclass AND d."refobjid" = '"session"'::regclass
      AND a."attname" = 'release_cause'
      AND NOT (d."classid" = 'pg_constraint'::regclass
               AND d."objid" = (SELECT "oid" FROM "pg_constraint"
                                 WHERE "conrelid" = '"session"'::regclass
                                   AND "conname" = 'session_release_cause_chk'))) AS other_dependents,
  (SELECT "convalidated" FROM "pg_constraint"
    WHERE "conrelid" = '"session"'::regclass AND "conname" = 'session_release_cause_chk') AS release_cause_chk_valid;
