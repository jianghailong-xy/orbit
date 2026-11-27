-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1401: the release fact is one fact (docs/session-three-state-plan.md §6 step 3.4; project 3508bDBDE5xPH43TYuiqP).
--
-- WHAT IT ADDS
-- ------------
-- session_release_fact_chk, NOT VALID. One clause: a session's status is terminal (SUCCEEDED, FAILED, CANCELLED)
-- exactly when `finished_at` is set. A violation is one of two: terminal without finished_at, or open with it.
-- 1402 validates it, in a file with no DO, so the validating scan does not run under this ACCESS EXCLUSIVE lock.
--
-- No clause on release_cause (2026-11-21, design §12 decision D9): an earlier version of this file also required
-- release_cause to be set exactly when finished_at is. The owner decided the session keeps no failure fact and
-- release_cause goes (design §12.6, step R1 removed that clause before this file was deployed anywhere); the column
-- keeps only its value CHECK, session_release_cause_chk (1261, widened by 1403/1404), until it is dropped.
--
-- WHICH RELEASE IT MAY SHIP IN
-- ----------------------------
-- NOT VALID still checks every new write. A replica running a release before the release-fact work (1261, 1262,
-- common/session-release.ts) writes a terminal status with no finished_at from three of its writers, and the revive
-- without clearing it, so it would be refused. This migration may therefore ship only in a release after the one that
-- carried the release-fact work, and only once every replica runs that release: the rolling deploy of that release
-- has finished, and nothing older can be started again (no rollback target below it).
--
-- LOCKS
-- -----
-- As 1261: the lock is asked for in one DO statement, 2 s at a time, 1 s apart, up to 45 tries. No INSERT, UPDATE or
-- DELETE, no function, trigger or type.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1401: main, origin/orbit/* and origin/project/* use up to 1400 (rescanned 2026-11-20). Not a multiple of 10.
-- Can run twice: DROP CONSTRAINT IF EXISTS first. A database that recorded the earlier, two-clause version as applied
-- (a development or test database only: neither version was deployed) does not run this again with `migrate deploy`;
-- run this file by hand there (it drops and re-adds the CHECK), then 1402's VALIDATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_release_fact_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_release_fact_chk" CHECK (
          ("status"::text IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) = ("finished_at" IS NOT NULL)
        ) NOT VALID;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
