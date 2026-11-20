-- 0950 — a schedule's read-back describes it as it is now.
--
-- `schedule.read_back`: the agent's one-sentence read-back ("Every day at 10:00 Beijing time I check …"). Until now
-- the inspector read it from the CREATE card's proposal forever, so a schedule moved from 09:30 to 23:46 still said
-- 09:30. A schedule_update may carry a new one; a change of the rule or the time zone without one clears it, and the
-- inspector then derives the When part from the current rule.
--
-- Backfill: the creation card's read-back, for every schedule whose rule and time zone have not changed since its
-- creation (a later revision naming either leaves it NULL, so the read derives it).
--
-- BACKWARD COMPATIBLE: a new nullable column; an older apiserver neither reads nor writes it.
ALTER TABLE "schedule" ADD COLUMN IF NOT EXISTS "read_back" TEXT;

UPDATE "schedule" s
   SET "read_back" = NULLIF(BTRIM(cr."proposed"->>'readBack'), '')
  FROM "schedule_change_request" cr
 WHERE cr."schedule_id" = s."id"
   AND cr."kind" = 'CREATE'
   AND cr."state" = 'ALLOWED'
   AND s."read_back" IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM "schedule_revision" r
      WHERE r."schedule_id" = s."id"
        AND r."revision" > 1
        AND (r."fields"->'after' ? 'rule' OR r."fields"->'after' ? 'timezone')
   );
