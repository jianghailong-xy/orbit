-- 1634: session_released_failed_idx (docs/session-status-retirement-plan.md §4.5 item 7, §6; project
-- 353SgnUjvamRr06Sho0EZ, task T5).
--
-- `?status=FAILED` on the facts (plan §6: released by a failure, P1 or P2 of §3.1). Not one of §4.5's six candidates:
-- measured by scripts/session-status-query-plans.sql, it read the whole table where today's
-- session_owner_status_task_idx reads the failed rows alone (6,121 buffers against 643 on the seeded database), and
-- §4.5 asks for an index that answers such a plan. Failures are few (85 of 12,201 sessions measured), so the index is
-- small. Its predicate is the one statusWordFilter('FAILED') states (sessions/session-legacy-words.ts, task T4), which
-- is what lets the planner read it.
--
-- Built as 1426 is: only SET, DROP INDEX IF EXISTS, CREATE INDEX CONCURRENTLY and RESET, so prisma migrate deploy sends
-- it statement by statement. The drop is asked for 2 s at most and takes no lock on a first run; on a re-run it removes
-- the INVALID index an interrupted build left (then: prisma migrate resolve --rolled-back
-- 1634_session_released_failed_idx, and deploy again). The build takes SHARE UPDATE EXCLUSIVE: reads and writes go on.

SET lock_timeout = '2s';

DROP INDEX IF EXISTS "session_released_failed_idx";

SET lock_timeout = 0;

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY "session_released_failed_idx" ON "session" ("owner_id")
  WHERE "finished_at" IS NOT NULL AND "end_reason" IS NULL
    AND ("last_turn_outcome" = 'FAILED' OR ("last_turn_outcome" IS NULL AND "import_source_cwd" IS NOT NULL));

RESET statement_timeout;

RESET lock_timeout;
