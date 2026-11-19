-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1151: validate 1150's two CHECKs, and backfill session.last_turn_outcome from status and end_reason
-- (docs/session-three-state-plan.md §5 step 2.3, the table in design §4.3).
--
-- THE BACKFILL
-- ------------
--   status          end_reason      last_turn_outcome
--   AWAITING_INPUT  any             ANSWERED
--   INTERRUPTED     null            INTERRUPTED
--   FAILED          any             FAILED       (design: "failed or none"; status and end_reason cannot tell a
--                                                 runner lost or a setup failure that ran no turn from a failed
--                                                 turn, so every FAILED row reads failed)
--   SUCCEEDED       task_done       ANSWERED
--   everything else                 null         (PENDING and RUNNING have no settled turn yet; CANCELLED,
--                                                 INTERRUPTED with an end_reason and SUCCEEDED without task_done
--                                                 are "as it was", which these two columns do not record)
-- Only rows still null are written, so a value turn-complete wrote after 1150 is never overwritten.
-- conversation_turn rows are not backfilled: old turns stay null.
--
-- BATCHES, LOCKS
-- --------------
-- No DO block in this file, so Prisma sends it statement by statement and none runs inside another's
-- transaction. The VALIDATEs take SHARE UPDATE EXCLUSIVE, which blocks no reader or writer. The backfill is a
-- procedure that walks session by id, 5000 rows at a time, and COMMITs after each batch, so it holds the row
-- locks of one batch at a time; it is dropped after its CALL. statement_timeout is lifted around the CALL only:
-- the CALL is one statement however many batches it commits.
--
-- RE-RUNNABILITY
-- --------------
-- Can run twice: VALIDATE on a valid constraint is a no-op, CREATE OR REPLACE, the backfill writes null rows
-- only, DROP PROCEDURE IF EXISTS. If a statement_timeout or a crash stops it halfway, the batches already
-- committed stay: `prisma migrate resolve --rolled-back 1151_turn_outcome_backfill`, then deploy again.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET lock_timeout = 0;

ALTER TABLE "conversation_turn" VALIDATE CONSTRAINT "conversation_turn_outcome_chk";

ALTER TABLE "session" VALIDATE CONSTRAINT "session_last_turn_outcome_chk";

RESET lock_timeout;

CREATE OR REPLACE PROCEDURE "orbit_1151_backfill_last_turn_outcome"()
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
       SET "last_turn_outcome" = CASE
             WHEN s."status"::text = 'AWAITING_INPUT' THEN 'ANSWERED'
             WHEN s."status"::text = 'INTERRUPTED' AND s."end_reason" IS NULL THEN 'INTERRUPTED'
             WHEN s."status"::text = 'FAILED' THEN 'FAILED'
             WHEN s."status"::text = 'SUCCEEDED' AND s."end_reason" = 'task_done' THEN 'ANSWERED'
           END
     WHERE s."id" > after_id
       AND s."id" <= batch_last
       AND s."last_turn_outcome" IS NULL
       AND (
         s."status"::text IN ('AWAITING_INPUT', 'FAILED')
         OR (s."status"::text = 'INTERRUPTED' AND s."end_reason" IS NULL)
         OR (s."status"::text = 'SUCCEEDED' AND s."end_reason" = 'task_done')
       );
    COMMIT;
    after_id := batch_last;
  END LOOP;
END;
$$;

SET statement_timeout = 0;

CALL "orbit_1151_backfill_last_turn_outcome"();

RESET statement_timeout;

DROP PROCEDURE IF EXISTS "orbit_1151_backfill_last_turn_outcome"();
