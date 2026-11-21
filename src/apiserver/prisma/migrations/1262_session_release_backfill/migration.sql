-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1262: validate 1261's CHECK, and backfill the release fact on every terminal session
-- (docs/session-three-state-plan.md §6 step 3.3).
--
-- THE BACKFILL
-- ------------
-- Only terminal rows (SUCCEEDED, FAILED, CANCELLED) are written, and only the column that is still null, so a
-- value a writer recorded after 1261 is never overwritten.
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
-- HOW IT RUNS, LOCKS
-- ------------------
-- As 1202: `prisma migrate deploy` sends this whole file as one query string, so it runs in ONE transaction. An
-- earlier version assumed Prisma sends it statement by statement and backfilled through a procedure that
-- COMMITted per batch, which that transaction refuses (2D000) on any table holding a terminal row. So there is no
-- procedure and no COMMIT here; the SETs are SET LOCAL, which last until this file's transaction ends.
--
-- What it holds, for how long. The VALIDATE takes SHARE UPDATE EXCLUSIVE on session; the UPDATE takes ROW
-- EXCLUSIVE on session and a row lock on every terminal row it writes. All of it is held until this file's
-- transaction commits. None of it blocks a reader, nor a writer of a row the UPDATE does not write; it blocks other
-- schema changes and VACUUM of session, and a write to a row the UPDATE wrote waits for the commit. 1261's ACCESS
-- EXCLUSIVE lock is not among them: 1261 is a separate file and so a separate transaction, committed before this
-- one starts. Measured with 100,000 sessions (on an idle PostgreSQL 16; see the task's evidence), the whole file
-- runs in about a second, so that is how long a write to a backfilled session can wait: acceptable for a
-- migration that runs once at deploy, and the rows it writes are released sessions, which few writers touch.
-- statement_timeout (300 s in docker-compose.yml) is lifted for the UPDATE only, by SET LOCAL; lock_timeout is 0
-- for the VALIDATE, as before, and back to the server's (30 s there) for the UPDATE. No status is written, so no
-- UPDATE OF status trigger fires.
--
-- A much larger session table: as 1202, an operator runs the same UPDATE before deploying, outside Prisma, in
-- autocommitted batches by id range; this file's UPDATE then finds nothing to write.
--
-- RE-RUNNABILITY
-- --------------
-- Can run twice: VALIDATE on a valid constraint is a no-op, and the UPDATE writes null columns only. If any
-- statement fails (a timeout, a deadlock with a live writer, a crash), the whole file rolls back and Prisma records
-- 1262 as failed, after which `prisma migrate deploy` stops with P3009: `prisma migrate resolve --rolled-back
-- 1262_session_release_backfill`, then deploy again. Where the earlier version is recorded as applied, `migrate
-- deploy` does not run it again.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_release_cause_chk";

RESET lock_timeout;

SET statement_timeout = 0;

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
 WHERE s."status"::text IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
   AND (s."finished_at" IS NULL OR s."release_cause" IS NULL);

RESET statement_timeout;
