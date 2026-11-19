-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1242: validate 1241's CHECK, and backfill the release fact on every terminal session
-- (docs/session-three-state-plan.md §6 step 3.3).
--
-- THE BACKFILL
-- ------------
-- Only terminal rows (SUCCEEDED, FAILED, CANCELLED) are written, and only the column that is still null, so a
-- value a writer recorded after 1241 is never overwritten.
--
-- finished_at, where null: completed_at, else deleted_at, else updated_at. The three writers that did not set it
-- were the LANDING container (its completed_at is the moment its landing settled) and the failed transcript
-- import (its deleted_at is the moment it failed); updated_at is the last write for anything else.
--
-- release_cause, the first rule that matches, mirroring what each writer now records:
--   kind = LANDING                                         landing_settled  (landing-session.ts)
--   end_reason is one of the causes                        end_reason       (an end was asked for: endLive,
--                                                                             the finalize and the reaper keep it)
--   FAILED, import_source_cwd still set                    import_failed    (runner-api importResult leaves it)
--   FAILED, source_state = REFUSED                         setup_failed     (session-source.ts)
--   FAILED, error = 'runner offline'                       runner_lost      (reaper)
--   FAILED, error ends ' runtime not initialized'          setup_failed     (reaper)
--   FAILED, error = 'cancel not honored'                   cancelled        (reaper, an end with no reason)
--   FAILED, cancel_requested_at set                        turn_failed      (turn-complete, and the reaper's
--                                                                             API-error backstop, both stamp it)
--   CANCELLED, cancel_requested_at set                     cancelled        (an end with no reason)
--   anything else                                          engine_exited    (the runner finalized with no end
--                                                                             requested)
-- So an old SUCCEEDED row without an end_reason reads engine_exited: the runner reports SUCCEEDED only when the
-- engine returned on an inbox `end` turn (design §9 D2), and with no end requested on the server that is the
-- engine exiting by itself. A plain conversation is never stored SUCCEEDED by current code.
--
-- BATCHES, LOCKS
-- --------------
-- As 1202: no DO block in this file, so Prisma sends it statement by statement. The VALIDATE takes SHARE UPDATE
-- EXCLUSIVE, which blocks no reader or writer. The backfill is a procedure that walks session by id, 5000 rows at
-- a time, and COMMITs after each batch; it is dropped after its CALL. statement_timeout is lifted around the CALL
-- only. No status is written, so no UPDATE OF status trigger fires.
--
-- RE-RUNNABILITY
-- --------------
-- Can run twice: VALIDATE on a valid constraint is a no-op, CREATE OR REPLACE, the backfill writes null columns
-- only, DROP PROCEDURE IF EXISTS. If a statement_timeout or a crash stops it halfway, the batches already
-- committed stay: `prisma migrate resolve --rolled-back 1242_session_release_backfill`, then deploy again.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_release_cause_chk";

RESET lock_timeout;

CREATE OR REPLACE PROCEDURE "orbit_1242_backfill_session_release"()
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
       SET "finished_at" = COALESCE(s."finished_at", s."completed_at", s."deleted_at", s."updated_at"),
           "release_cause" = COALESCE(s."release_cause", CASE
             WHEN s."kind" = 'LANDING' THEN 'landing_settled'
             WHEN s."end_reason" IN (
               'task_done', 'task_cancelled', 'ended', 'completed', 'deleted', 'cancelled', 'idle', 'orphaned'
             ) THEN s."end_reason"
             WHEN s."status"::text = 'FAILED' AND s."import_source_cwd" IS NOT NULL THEN 'import_failed'
             WHEN s."status"::text = 'FAILED' AND s."source_state" = 'REFUSED' THEN 'setup_failed'
             WHEN s."status"::text = 'FAILED' AND s."error" = 'runner offline' THEN 'runner_lost'
             WHEN s."status"::text = 'FAILED' AND s."error" LIKE '% runtime not initialized' THEN 'setup_failed'
             WHEN s."status"::text = 'FAILED' AND s."error" = 'cancel not honored' THEN 'cancelled'
             WHEN s."status"::text = 'FAILED' AND s."cancel_requested_at" IS NOT NULL THEN 'turn_failed'
             WHEN s."status"::text = 'CANCELLED' AND s."cancel_requested_at" IS NOT NULL THEN 'cancelled'
             ELSE 'engine_exited'
           END)
     WHERE s."id" > after_id
       AND s."id" <= batch_last
       AND s."status"::text IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
       AND (s."finished_at" IS NULL OR s."release_cause" IS NULL);
    COMMIT;
    after_id := batch_last;
  END LOOP;
END;
$$;

SET statement_timeout = 0;

CALL "orbit_1242_backfill_session_release"();

RESET statement_timeout;

DROP PROCEDURE IF EXISTS "orbit_1242_backfill_session_release"();
