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
-- HOW IT RUNS, LOCKS
-- ------------------
-- `prisma migrate deploy` sends this whole file to PostgreSQL as one query string, so every statement in it runs
-- in ONE transaction, which commits only after the last statement (and rolls back whole if any statement fails).
-- An earlier version of this file assumed that, with no DO block, Prisma sends it statement by statement, and
-- backfilled through a procedure that COMMITted after each batch: a COMMIT is refused inside that transaction
-- (2D000 invalid transaction termination), which an empty table never reached and production's did. So there is
-- no procedure and no COMMIT here; the SETs are SET LOCAL, which last until this file's transaction ends.
--
-- What it holds, for how long. The VALIDATEs take SHARE UPDATE EXCLUSIVE on conversation_turn and session; the
-- UPDATE takes ROW EXCLUSIVE on session and a row lock on every row it writes. All of it is held until this
-- file's transaction commits. None of it blocks a reader, nor a writer of a row the UPDATE does not write; it
-- blocks other schema changes and VACUUM of the two tables, and a write to a row the UPDATE wrote waits for the
-- commit. 1201's ACCESS EXCLUSIVE locks are not among them: 1201 is a separate file and so a separate
-- transaction, committed before this one starts. Measured with 100,000 sessions and 100,000 turns (on an idle
-- PostgreSQL 16; see the task's evidence), the whole file runs in about a second, so that is how long a write
-- to one of the backfilled sessions can wait: acceptable for a migration that runs once at deploy, well inside
-- lock_timeout (30 s in docker-compose.yml) for anyone waiting on it.
-- statement_timeout (300 s there) is lifted for the UPDATE only, by SET LOCAL; lock_timeout is 0 for the
-- VALIDATEs, as before, and back to the server's for the UPDATE.
--
-- A much larger session table. If this would hold its row locks for longer than the installation tolerates,
-- an operator runs the same UPDATE before deploying, outside Prisma, in autocommitted batches by id range
-- (`psql` with each batch a statement of its own); this file's UPDATE then finds no null row and writes nothing,
-- and only its scan remains.
--
-- RE-RUNNABILITY
-- --------------
-- Can run twice: VALIDATE on a valid constraint is a no-op, and the UPDATE writes null rows only. If any statement
-- fails (a timeout, a deadlock with a live writer, a crash), the whole file rolls back and Prisma records 1202 as
-- failed, after which `prisma migrate deploy` stops with P3009: `prisma migrate resolve --rolled-back
-- 1202_turn_outcome_backfill`, then deploy again. This version also applies where the earlier one is recorded as
-- failed (production on 2026-11-21: nothing of it stayed) and, once resolved, writes the value per row the earlier
-- version meant to. Where the earlier version is recorded as applied, `migrate deploy` does not run it again.
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
