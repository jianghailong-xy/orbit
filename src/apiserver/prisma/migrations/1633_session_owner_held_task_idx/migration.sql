-- 1633: session_owner_held_task_idx (docs/session-status-retirement-plan.md §4.5; project 353SgnUjvamRr06Sho0EZ, task T5).
--
-- Task occupancy by owner (batch stop, delete, reach) and the task carrier. Replaces session_owner_status_task_idx's access
-- path.
-- The old index on status stays until D4: D1 code still reads it. Measured by scripts/session-status-query-plans.sql.
--
-- Built as 1426 is: only SET, DROP INDEX IF EXISTS, CREATE INDEX CONCURRENTLY and RESET, so prisma migrate deploy sends
-- it statement by statement (a DO block would make the file one transaction, which CONCURRENTLY cannot run in). The drop
-- is asked for 2 s at most and takes no lock on a first run; on a re-run it removes the INVALID index an interrupted
-- build left (then: prisma migrate resolve --rolled-back 1633_session_owner_held_task_idx, and deploy again). The build takes SHARE UPDATE
-- EXCLUSIVE: reads and writes go on. IF NOT EXISTS is not used: it would take an INVALID index for a built one.

SET lock_timeout = '2s';

DROP INDEX IF EXISTS "session_owner_held_task_idx";

SET lock_timeout = 0;

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY "session_owner_held_task_idx" ON "session" ("owner_id", "task_id")
  WHERE "finished_at" IS NULL;

RESET statement_timeout;

RESET lock_timeout;
