-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1202: validate 1201's two CHECKs, and backfill session.last_turn_outcome from status and end_reason
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
-- Only rows still null are written, so a value turn-complete wrote after 1201 is never overwritten.
-- conversation_turn rows are not backfilled: old turns stay null.
--
-- HOW PRISMA RUNS IT, LOCKS
-- --------------------------
-- How `prisma migrate deploy` (7.10, this repository's) sends a file was tested on PostgreSQL 16 for this fix: a
-- file containing a DO block or a CREATE PROCEDURE is sent whole and runs as ONE transaction; a file with neither,
-- like this one, is sent statement by statement, and each statement commits on its own. The earlier version of this
-- file created a procedure that COMMITted after each 5000-row batch and CALLed it, believing it would be sent
-- statement by statement because it had no DO block; its CREATE PROCEDURE made Prisma send it whole, the CALL ran
-- inside that transaction, and its first COMMIT failed (2D000 invalid transaction termination) on any database
-- with a row to backfill: production's deploy of af55a2fb38 on 2026-11-21. An empty table never reached the COMMIT.
-- This version has no procedure and no COMMIT and is correct either way a file is sent: one UPDATE, bracketed by a
-- SET and a RESET (not SET LOCAL, which does nothing to a statement sent on its own; SET ... RESET also holds inside
-- one transaction).
--
-- What it holds, for how long, as Prisma sends it. Each VALIDATE holds SHARE UPDATE EXCLUSIVE on its table while it
-- scans and commits: it blocks no reader or writer, only schema changes and VACUUM of that table. Neither runs under
-- 1201's ACCESS EXCLUSIVE locks: 1201 is a file of its own, committed before this one starts. The UPDATE holds ROW
-- EXCLUSIVE on session, which blocks no reader or writer, and a row lock on each row it writes until it commits, so
-- a write to one of those rows waits for it. Measured with 100,000 sessions and 100,000 turns, at load 15-20 on the
-- build host: each VALIDATE under 50 ms, the UPDATE 1.1 s (the whole file 9.7 s during heavier load). Production
-- holds about 12,000 sessions. A wait of that length once per deploy is acceptable, and well inside the 30 s
-- lock_timeout (docker-compose.yml) of anyone waiting on a row. statement_timeout (300 s there) is lifted for the
-- UPDATE only; lock_timeout is 0 for the VALIDATEs and the server's for the UPDATE. If a later Prisma sent this file
-- whole, the same statements would be one transaction holding all of this for the file's duration: still acceptable.
--
-- A much larger session table. If the UPDATE would hold its row locks longer than the installation tolerates, an
-- operator runs the same UPDATE before deploying, outside Prisma, in autocommitted batches by id range (`psql`, each
-- batch a statement of its own); this file's UPDATE then finds no null row, writes nothing and only scans.
--
-- RE-RUNNABILITY
-- --------------
-- Can run twice: VALIDATE on a valid constraint is a no-op, and the UPDATE writes null rows only. If a statement
-- fails (a timeout, a deadlock with a live writer, a crash), the statements before it stay committed, Prisma records
-- 1202 as failed, and `prisma migrate deploy` stops with P3009 until `prisma migrate resolve --rolled-back
-- 1202_turn_outcome_backfill`, after which deploy runs the whole file again. That is also production's state on
-- 2026-11-21: the earlier version failed as one transaction, so nothing of it stayed, and once resolved this
-- version writes the value per row the earlier one meant to. Where the earlier version is recorded as applied (it
-- was, on every database migrated while its tables were empty), `migrate deploy` does not run this file again.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET lock_timeout = 0;

ALTER TABLE "conversation_turn" VALIDATE CONSTRAINT "conversation_turn_outcome_chk";

ALTER TABLE "session" VALIDATE CONSTRAINT "session_last_turn_outcome_chk";

RESET lock_timeout;

SET statement_timeout = 0;

UPDATE "session" s
   SET "last_turn_outcome" = CASE
         WHEN s."status"::text = 'AWAITING_INPUT' THEN 'ANSWERED'
         WHEN s."status"::text = 'INTERRUPTED' AND s."end_reason" IS NULL THEN 'INTERRUPTED'
         WHEN s."status"::text = 'FAILED' THEN 'FAILED'
         WHEN s."status"::text = 'SUCCEEDED' AND s."end_reason" = 'task_done' THEN 'ANSWERED'
       END
 WHERE s."last_turn_outcome" IS NULL
   AND (
     s."status"::text IN ('AWAITING_INPUT', 'FAILED')
     OR (s."status"::text = 'INTERRUPTED' AND s."end_reason" IS NULL)
     OR (s."status"::text = 'SUCCEEDED' AND s."end_reason" = 'task_done')
   );

RESET statement_timeout;
