-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1405: every FAILED session's release cause is a failure cause (docs/session-three-state-design.md §4.2 and §6.3;
-- project 3508bDBDE5xPH43TYuiqP). Runs before 1406 adds the CHECK that holds it.
--
-- THE BACKFILL
-- ------------
-- Only FAILED rows whose release_cause is not a failure cause are written, and only release_cause. Before this
-- task those are the two causes that meant both a clean and a failed end:
--   engine_exited                         the runner's FAILED finalize with no end requested, and 1262's ELSE
--   an end reason (task_done ... orphaned)  the reaper's "cancel not honored" release, and 1262's end_reason rule,
--                                         which came first and so also took FAILED rows whose end_reason was
--                                         written after they failed (a person completing or deleting a failed
--                                         session records the end reason on the released row)
-- (landing_settled is never written with FAILED; a FAILED LANDING row, if one exists, takes the rules below.)
--
-- The new cause is read off the row's own facts, by 1262's FAILED rules in 1262's order with its end_reason rule
-- left out, and the not-honoured end named for itself:
--   import_source_cwd still set                             import_failed   (runner-api importResult)
--   source_state = REFUSED                                  setup_failed    (session-source.ts)
--   error = 'runner offline'                                runner_lost     (reaper)
--   error ends ' runtime not initialized'                   setup_failed    (reaper)
--   error = 'cancel not honored' or ends ' end not honored'  end_not_honored (reaper's cancel grace)
--   cancel_requested_at set                                 turn_failed     (turn-complete and the reaper's
--                                                                            API-error backstop stamp it)
--   anything else                                           engine_failed   (the runner finalized FAILED with
--                                                                            no end requested)
-- end_reason, status and every other column stay as they are. SUCCEEDED and CANCELLED rows are not touched: no
-- writer and no backfill ever gave one a failure cause (turn_failed, runner_lost, setup_failed and import_failed
-- were only ever written with FAILED, and engine_failed and end_not_honored are new), so their causes already read
-- as no failure. 1407's VALIDATE would name any that did.
--
-- BATCHES, LOCKS
-- --------------
-- As 1262: no DO block in this file, so Prisma sends it statement by statement. The backfill is a procedure that
-- walks session by id, 5000 rows at a time, and COMMITs after each batch; it is dropped after its CALL.
-- statement_timeout is lifted around the CALL only. No status is written, so no UPDATE OF status trigger fires.
--
-- WHICH RELEASE IT MAY SHIP IN
-- ----------------------------
-- With 1406 and 1407, never in the release that carries this task's writers and 1403: see 1406. A replica of an
-- older release still writes FAILED rows with the old causes after this has run, and 1407 would refuse them.
--
-- RE-RUNNABILITY
-- --------------
-- Can run twice: it writes only FAILED rows whose cause is not a failure, and each write makes it one.
-- CREATE OR REPLACE, DROP PROCEDURE IF EXISTS. If a statement_timeout or a crash stops it halfway, the batches
-- already committed stay: `prisma migrate resolve --rolled-back 1405_session_release_failure_backfill`, then
-- deploy again.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE PROCEDURE "orbit_1405_backfill_session_release_failure"()
LANGUAGE plpgsql
AS $$
DECLARE
  after_id uuid := '00000000-0000-0000-0000-000000000000';
  batch_last uuid;
BEGIN
  LOOP
    -- The last id of the next 5000 (uuid has no max()).
    SELECT b."id" INTO batch_last
      FROM (
        SELECT "id" FROM "session" WHERE "id" > after_id ORDER BY "id" LIMIT 5000
      ) b
     ORDER BY b."id" DESC
     LIMIT 1;
    EXIT WHEN batch_last IS NULL;
    UPDATE "session" s
       SET "release_cause" = CASE
             WHEN s."import_source_cwd" IS NOT NULL THEN 'import_failed'
             WHEN s."source_state" = 'REFUSED' THEN 'setup_failed'
             WHEN s."error" = 'runner offline' THEN 'runner_lost'
             WHEN s."error" LIKE '% runtime not initialized' THEN 'setup_failed'
             WHEN s."error" = 'cancel not honored' OR s."error" LIKE '% end not honored' THEN 'end_not_honored'
             WHEN s."cancel_requested_at" IS NOT NULL THEN 'turn_failed'
             ELSE 'engine_failed'
           END
     WHERE s."id" > after_id
       AND s."id" <= batch_last
       AND s."status"::text = 'FAILED'
       AND s."release_cause" NOT IN (
         'turn_failed', 'runner_lost', 'setup_failed', 'engine_failed', 'end_not_honored', 'import_failed'
       );
    COMMIT;
    after_id := batch_last;
  END LOOP;
END;
$$;

SET statement_timeout = 0;

CALL "orbit_1405_backfill_session_release_failure"();

RESET statement_timeout;

DROP PROCEDURE IF EXISTS "orbit_1405_backfill_session_release_failure"();
