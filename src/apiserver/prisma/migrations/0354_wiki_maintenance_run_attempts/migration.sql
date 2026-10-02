-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, phase 2, criterion 3: a maintenance task that died on the platform no longer holds the
-- maintenance list, and a run row says how many times its run started and whose its failure was.
-- contracts/wiki.contract.json `maintenance.job.recovery` is the authority for everything below, and
-- src/apiserver/src/wiki/wiki-maintenance.pg.spec.ts holds it to it.
--
-- WHY (2026-10-01 and 10-02, the owner's orbit space)
-- ---------------------------------------------------
--   * A task whose session was reaped `runner offline` stayed OPEN with nothing working it, and the
--     trigger, which reads any OPEN task of the list as a run under way, made no run for four hours.
--   * A run whose verify and finish both got 500 on a full disk left its row with no outcome after its
--     task had FAILED: nothing ever says how such a run ended.
--   * A session's retry of its run overwrote started_at, so the row said it ended (00:30:11) before it
--     started (00:30:29).
--
-- WHAT IS ADDED, on wiki_maintenance_run
-- --------------------------------------
--   attempts          how many times a session started the run (GET …/maintenance/run): a session's retry
--                     and a platform rerun are one more each. started_at stays the first start.
--   last_started_at   the latest start.
--   failure_kind      whose a failed or truncated run's failure was: 'infra' (the platform: runner offline,
--                     5xx, disk full, an engine that never came up) or 'content' (the run's own). Set exactly
--                     when outcome is failed or truncated.
--   reruns, rerun_at  how many times the platform started a task that died of an infra failure again, and
--                     when the last of them was due.
--
-- WHAT IS WRITTEN, once, before the CHECKs
-- ----------------------------------------
--   1. Every row that started started once at least: attempts 1, last_started_at its started_at.
--   2. A row whose ended_at is before its started_at kept two attempts on one row: its started_at was the
--      second start. It becomes the latest start, attempts 2, and started_at the first session of its task
--      created no later than the end it reported — its first start was after that session was made.
--   3. A failure a run reported before runners said whose it was is read off its error, as the trigger reads a
--      session's end (wikiMaintenanceFailureKindOf): a 5xx (`-> 500`), a lost connection, a full disk, a runner
--      offline, an overloaded provider is 'infra'; anything else is 'content'.
--   4. The orphans: a row with no outcome whose task has ended (DONE, FAILED or CANCELLED) gets outcome
--      'failed', failure_kind 'infra' and error 'The run did not report its end.', ended_at no earlier than
--      its last start. Only those rows: one whose outcome is set, or whose task has not ended, is not touched.
-- task and session are only READ here (their status, a session's created_at); no row of either is written
-- or locked beyond the read.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0354: origin/main stood at 0350 and other projects' unpushed worktrees spelled 0351, 0352 and 0353 when
-- this was written (2026-10-02). Every statement can run twice: ADD COLUMN IF NOT EXISTS, constraints added only when
-- absent, and each UPDATE matches no row the second time.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_maintenance_run"
  ADD COLUMN IF NOT EXISTS "attempts"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_started_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "failure_kind"    TEXT,
  ADD COLUMN IF NOT EXISTS "reruns"          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rerun_at"        TIMESTAMPTZ(3);

-- 1. A run that started started once.
UPDATE "wiki_maintenance_run"
   SET "attempts" = 1, "last_started_at" = "started_at"
 WHERE "started_at" IS NOT NULL AND "attempts" = 0;

-- 2. Two attempts on one row: the second start had overwritten the first.
UPDATE "wiki_maintenance_run" r
   SET "attempts" = 2,
       "last_started_at" = r."started_at",
       "started_at" = COALESCE(
         (SELECT min(s."created_at" AT TIME ZONE 'UTC') FROM "session" s
           WHERE s."task_id" = r."task_id" AND s."created_at" AT TIME ZONE 'UTC' <= r."ended_at"),
         LEAST(r."created_at", r."ended_at"))
 WHERE r."ended_at" IS NOT NULL AND r."started_at" IS NOT NULL AND r."ended_at" < r."started_at"
   AND r."attempts" <= 1;

-- 3. A failure the run reported, read off its error: the words of wiki-maintenance-run.ts INFRA_WORDS.
UPDATE "wiki_maintenance_run"
   SET "failure_kind" = CASE
         WHEN coalesce("error", '') ~* '(->\s*5\d\d\y|\y(status|http|answered|returned|api error:?)\s*5\d\d\y|\yrunner offline\y|\yruntime not initialized\y|\yno space left on device\y|\yenospc\y|\ydisk (is )?full\y|\y(internal server error|bad gateway|service unavailable|gateway timeout)\y|\y(econnrefused|econnreset|etimedout|ehostunreach|enetunreach|epipe)\y|\y(socket hang up|fetch failed|connection (refused|reset|closed)|could not be reached|server (is )?unavailable)\y|\yoverloaded\y)'
           THEN 'infra'
         ELSE 'content'
       END
 WHERE "outcome" IN ('failed', 'truncated') AND "failure_kind" IS NULL;

-- 4. The orphans: the task ended, and the run never said how.
UPDATE "wiki_maintenance_run" r
   SET "outcome" = 'failed',
       "failure_kind" = 'infra',
       "error" = 'The run did not report its end.',
       "ended_at" = GREATEST(t."updated_at" AT TIME ZONE 'UTC', COALESCE(r."last_started_at", r."started_at", r."created_at")),
       "updated_at" = now()
  FROM "task" t
 WHERE t."id" = r."task_id" AND r."outcome" IS NULL
   AND t."status"::text IN ('DONE', 'FAILED', 'CANCELLED');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_maintenance_run_attempts_check') THEN
    ALTER TABLE "wiki_maintenance_run" ADD CONSTRAINT "wiki_maintenance_run_attempts_check"
      CHECK ("attempts" >= 0 AND "reruns" >= 0 AND ("last_started_at" IS NOT NULL) = ("attempts" > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_maintenance_run_failure_kind_check') THEN
    ALTER TABLE "wiki_maintenance_run" ADD CONSTRAINT "wiki_maintenance_run_failure_kind_check"
      CHECK (("failure_kind" IS NULL OR "failure_kind" IN ('infra', 'content'))
         AND ("failure_kind" IS NOT NULL) = ("outcome" IS NOT NULL AND "outcome" <> 'succeeded'));
  END IF;
END $$;
