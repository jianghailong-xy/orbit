-- 1631: session_root_in_flight_idx (docs/session-status-retirement-plan.md §4.5; project 353SgnUjvamRr06Sho0EZ, task T5).
--
-- The spawn-tree cap and the claim order (treeActiveTurns). Replaces session_root_session_id_status_idx's access path.
-- The old index on status stays until D4: D1 code still reads it. Measured by scripts/session-status-query-plans.sql.
--
-- Built as 1426 is: only SET, DROP INDEX IF EXISTS, CREATE INDEX CONCURRENTLY and RESET, so prisma migrate deploy sends
-- it statement by statement (a DO block would make the file one transaction, which CONCURRENTLY cannot run in). The drop
-- is asked for 2 s at most and takes no lock on a first run; on a re-run it removes the INVALID index an interrupted
-- build left (then: prisma migrate resolve --rolled-back 1631_session_root_in_flight_idx, and deploy again). The build takes SHARE UPDATE
-- EXCLUSIVE: reads and writes go on. IF NOT EXISTS is not used: it would take an INVALID index for a built one.

SET lock_timeout = '2s';

DROP INDEX IF EXISTS "session_root_in_flight_idx";

SET lock_timeout = 0;

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY "session_root_in_flight_idx" ON "session" ("root_session_id")
  WHERE "turn_state" = 'IN_FLIGHT';

RESET statement_timeout;

RESET lock_timeout;
