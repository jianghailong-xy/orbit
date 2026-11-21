-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1406: a release is a failure exactly when its session is FAILED (docs/session-three-state-design.md §4.2;
-- project 3508bDBDE5xPH43TYuiqP).
--
-- WHAT IT ADDS
-- ------------
-- session_release_failure_chk, NOT VALID: the status is FAILED exactly when release_cause is a failure cause
-- (turn_failed, runner_lost, setup_failed, engine_failed, end_not_honored, import_failed; common/session-release.ts
-- FAILURE_RELEASE_CAUSES). A held session has no cause (session_release_fact_chk, 1401) and is never FAILED, so it
-- passes. With it, "did the run fail" read off the release cause and read off the terminal status value are
-- provably the same, and phase 4 can move that decision onto the cause. 1407 validates it, in a file with no DO, so
-- the validating scan does not run under this ACCESS EXCLUSIVE lock.
--
-- WHICH RELEASE IT MAY SHIP IN
-- ----------------------------
-- NOT VALID still checks every new write. A replica running a release before this task's writers (1403 and
-- common/session-release.ts finalizeReleaseCause, the reaper's cancel-grace branch) writes engine_exited for a FAILED
-- finalize and the end's own cause (cancelled, completed, deleted) for the reaper's FAILED "cancel not honored", and
-- would be refused. 1405, 1406 and 1407 may therefore ship only in a release after the one that carried 1403, 1404
-- and those writers, and only once every replica runs that release: the rolling deploy of that release has
-- finished, and nothing older can be started again (no rollback target below it).
-- Relative to the release-fact work: 1403 and the writers may ride in the release with 1261/1262 or any later one;
-- 1405-1407 then go in the release with 1401/1402 at the earliest (which has the same rule against 1261's release),
-- or any later one. If 1403 and the writers ride with 1401/1402 instead, 1405-1407 go one release after that.
--
-- LOCKS
-- -----
-- As 1401: the lock is asked for in one DO statement, 2 s at a time, 1 s apart, up to 45 tries. No INSERT, UPDATE
-- or DELETE, no function, trigger or type.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1406: see 1403. Can run twice: DROP CONSTRAINT IF EXISTS first.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_release_failure_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_release_failure_chk" CHECK (
          ("status"::text = 'FAILED') = COALESCE("release_cause" IN (
            'turn_failed', 'runner_lost', 'setup_failed', 'engine_failed', 'end_not_honored', 'import_failed'
          ), false)
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
