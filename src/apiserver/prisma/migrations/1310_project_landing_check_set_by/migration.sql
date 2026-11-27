-- 1310: who set a project's landing check, and the explicit "run none" (contract revision 42, section 12.14, P-C1).
--
--   project_codebase.landing_check_none              true: run no project landing check at all; only the task's own
--                                                    acceptance runs when a task lands. Distinct from a NULL command,
--                                                    which still falls back to the merge check (section 11 K1).
--   project_codebase.landing_check_set_by            who last wrote the landing check (command, budget or NONE):
--                                                    OWNER at their own door or as their own value on the start card,
--                                                    CARD through a merge-check card the owner answered, START when the
--                                                    owner's Start press confirmed the value the coordinator's start
--                                                    request proposed (section 12.12 P2), COORDINATOR with no card
--                                                    (P-C1). OWNER and CARD lock it; START and COORDINATOR leave it
--                                                    the coordinator's. NULL while nobody has written it.
--   project_codebase.landing_check_set_by_session_id the coordinator conversation a cardless write came from; cleared
--                                                    by every other writer.
--   project_codebase.landing_check_set_at            when the last write happened, whoever wrote it. NULL only where
--                                                    nobody has, or on a row marked OWNER below.
--
-- A binding whose landing check was already set before this migration is marked OWNER with no time: nobody can say any
-- more who set it or when, and an owner-set value is the one a coordinator may not change without a card. Fail closed.
-- Columns, two CHECKs and that one UPDATE of project_codebase, which is not a preserved relation; no trigger, function
-- or DONE fence is named. Every statement can run twice.
ALTER TABLE "project_codebase" ADD COLUMN IF NOT EXISTS "landing_check_none" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "project_codebase" ADD COLUMN IF NOT EXISTS "landing_check_set_by" TEXT;
ALTER TABLE "project_codebase" ADD COLUMN IF NOT EXISTS "landing_check_set_by_session_id" UUID;
ALTER TABLE "project_codebase" ADD COLUMN IF NOT EXISTS "landing_check_set_at" TIMESTAMPTZ(3);
ALTER TABLE "project_codebase" DROP CONSTRAINT IF EXISTS "project_codebase_landing_check_none_chk";
ALTER TABLE "project_codebase" ADD CONSTRAINT "project_codebase_landing_check_none_chk" CHECK (
  NOT "landing_check_none" OR "landing_check_command" IS NULL
);
ALTER TABLE "project_codebase" DROP CONSTRAINT IF EXISTS "project_codebase_landing_check_set_by_chk";
ALTER TABLE "project_codebase" ADD CONSTRAINT "project_codebase_landing_check_set_by_chk" CHECK (
  ("landing_check_set_by" IS NULL AND "landing_check_set_by_session_id" IS NULL AND "landing_check_set_at" IS NULL)
  OR ("landing_check_set_by" IN ('OWNER', 'CARD') AND "landing_check_set_by_session_id" IS NULL)
  OR ("landing_check_set_by" = 'START' AND "landing_check_set_by_session_id" IS NULL
      AND "landing_check_set_at" IS NOT NULL)
  OR ("landing_check_set_by" = 'COORDINATOR' AND "landing_check_set_by_session_id" IS NOT NULL
      AND "landing_check_set_at" IS NOT NULL)
);
UPDATE "project_codebase" SET "landing_check_set_by" = 'OWNER'
 WHERE "landing_check_set_by" IS NULL
   AND ("landing_check_command" IS NOT NULL OR "landing_check_timeout_seconds" IS NOT NULL);
