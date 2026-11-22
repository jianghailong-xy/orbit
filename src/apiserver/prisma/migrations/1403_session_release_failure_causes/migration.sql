-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1403: two release causes that are failures only (docs/session-three-state-design.md §4.2 and §6.3, decision D1;
-- project 3508bDBDE5xPH43TYuiqP). Since 1261 one cause could mean a failed and a clean end: `engine_exited` was
-- written for SUCCEEDED, CANCELLED and FAILED finalizes, and the end's own cause (cancelled, completed, deleted, ...)
-- for a CANCELLED end and for the reaper's FAILED "cancel not honored". This adds the two causes that split them:
--
--   engine_failed     the runner finalized with no end requested and reported FAILED (engine_exited stays for
--                     SUCCEEDED and CANCELLED)
--   end_not_honored   an end was asked for and the runner never honoured it: the reaper releases it FAILED once
--                     the cancel grace runs out (end_reason still records which end was asked for)
--
-- So "this release was a failure" is "release_cause is one of turn_failed, runner_lost, setup_failed,
-- engine_failed, end_not_honored, import_failed" (common/session-release.ts FAILURE_RELEASE_CAUSES).
--
-- WHAT IT CHANGES
-- ---------------
-- session_release_cause_chk (1261) is dropped and added again with the two new values, NOT VALID. 1404 validates
-- it. Nothing else: the old values all stay allowed, no row is written. 1405 backfills, 1406/1407 add the CHECK
-- that the status is FAILED exactly when the cause is a failure.
--
-- WHICH RELEASE IT MAY SHIP IN
-- ----------------------------
-- 1403 and 1404 only widen the values a cause may take, so a replica running an older release (which writes the
-- old causes) is never refused by them. They may ship in the release that carries the release-fact work (1261,
-- 1262) or any later one, together with this task's writers (common/session-release.ts finalizeReleaseCause, the
-- reaper's cancel-grace branch), which write the new values and so need this CHECK in place first. 1405-1407 may
-- NOT ship in the same release as these writers: see 1406.
--
-- LOCKS
-- -----
-- As 1261: the lock is asked for in one DO statement, 2 s at a time, 1 s apart, up to 45 tries. The CHECK is
-- added NOT VALID here and validated by 1404, a file with no DO, so the validating scan does not run inside the
-- transaction holding this ACCESS EXCLUSIVE lock. No function, trigger or type. No INSERT, UPDATE or DELETE.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1403: main, origin/orbit/* and origin/project/* use up to 1402 (rescanned 2026-11-21). Not a multiple of 10.
-- Can run twice: DROP CONSTRAINT IF EXISTS first.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_release_cause_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_release_cause_chk" CHECK (
          "release_cause" IS NULL
          OR "release_cause" IN (
            'task_done', 'task_cancelled', 'ended', 'completed', 'deleted', 'cancelled', 'idle', 'orphaned',
            'turn_failed', 'runner_lost', 'setup_failed', 'engine_exited', 'engine_failed', 'end_not_honored',
            'import_failed', 'landing_settled'
          )
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
