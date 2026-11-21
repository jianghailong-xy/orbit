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
-- HOW PRISMA RUNS IT, LOCKS
-- --------------------------
-- As 1202 (whose header has the test): `prisma migrate deploy` sends a file with a DO block or a CREATE PROCEDURE
-- whole, as one transaction, and any other file statement by statement, each statement committing on its own. The
-- earlier version of this file, believing it was sent statement by statement, backfilled through a procedure that
-- COMMITted per batch; the CREATE PROCEDURE made Prisma send it whole, and the COMMIT is refused there (2D000) on
-- any database holding a terminal row. This version has no procedure and no COMMIT and is correct either way: one
-- UPDATE, bracketed by a SET and a RESET.
--
-- What it holds, for how long, as Prisma sends it. The VALIDATE holds SHARE UPDATE EXCLUSIVE on session while it
-- scans and commits: it blocks no reader or writer, only schema changes and VACUUM of session, and it does not run
-- under 1261's ACCESS EXCLUSIVE lock (1261 is a file of its own, committed before this one starts). The UPDATE holds
-- ROW EXCLUSIVE on session, which blocks no reader or writer, and a row lock on each terminal row it writes until it
-- commits, so a write to one of those rows waits for it. Measured with 100,000 sessions, at load 15-20 on the build
-- host: the VALIDATE under 50 ms, the UPDATE 0.8 s (the whole file 4.1 s during heavier load). Production holds about
-- 12,000 sessions. A wait of that length once per deploy is acceptable: the rows it writes are released sessions,
-- which few writers touch, and it is well inside the 30 s lock_timeout (docker-compose.yml) of anyone waiting.
-- statement_timeout (300 s there) is lifted for the UPDATE only; lock_timeout is 0 for the VALIDATE and the
-- server's for the UPDATE. No status is written, so no UPDATE OF status trigger fires.
--
-- A much larger session table: as 1202, an operator runs the same UPDATE before deploying, outside Prisma, in
-- autocommitted batches by id range; this file's UPDATE then finds nothing to write.
--
-- RE-RUNNABILITY
-- --------------
-- Can run twice: VALIDATE on a valid constraint is a no-op, and the UPDATE writes null columns only. If a statement
-- fails (a timeout, a deadlock with a live writer, a crash), the statements before it stay committed, Prisma records
-- 1262 as failed, and `prisma migrate deploy` stops with P3009 until `prisma migrate resolve --rolled-back
-- 1262_session_release_backfill`, after which deploy runs the whole file again. Where the earlier version is
-- recorded as applied (on every database migrated while its tables were empty), deploy does not run this again.
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
