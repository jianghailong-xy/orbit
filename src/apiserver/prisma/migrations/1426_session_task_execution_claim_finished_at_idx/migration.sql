-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1426: the one-live-run-per-task index, read from the release column. Release A of two
-- (docs/session-three-state-plan.md §7 step 4.5; project 3508bDBDE5xPH43TYuiqP).
--
-- WHAT IT ADDS
-- ------------
-- session_task_execution_claim_idx_finished_at: UNIQUE on session(task_id)
--   WHERE task_id IS NOT NULL AND deleted_at IS NULL AND finished_at IS NULL
-- beside 0130's session_task_execution_claim_idx (same column, `status IN ('PENDING', 'RUNNING', 'AWAITING_INPUT',
-- 'INTERRUPTED')`), which STAYS. While both exist, both are enforced. Release B, a later task and a later deploy, drops
-- the old one.
--
-- WHY THE TWO ADMIT THE SAME ROWS
-- -------------------------------
-- session_release_fact_chk (1401, validated by 1402) holds every row to: the status is SUCCEEDED, FAILED or CANCELLED
-- exactly when finished_at is set. The status type has one label beyond those seven: PARKED, which no row holds (0071
-- moved every PARKED row to CANCELLED; nothing writes it since, and the Prisma enum omits it). So for every row that
-- exists, "finished_at IS NULL" and "the status is one of the four held values" are the same test, and the two
-- indexes refuse and admit the same rows. PARKED with finished_at NULL is the one row the CHECK admits that only the
-- new index covers. Were there one (task set, not in the Trash): the build fails, leaving an INVALID index (below), if
-- its task holds another live row as well; otherwise it succeeds, and that row then counts as its task's live run and
-- refuses every new run of the task until it is moved to CANCELLED. scripts/session-claim-index-precheck.sql counts
-- such rows. 1426 runs after 1402 in the same deploy or a later one (migrations apply in order), so the CHECK is
-- already validated when this build scans, and the build cannot meet any other duplicate the old index did not
-- already refuse.
--
-- THE NAME
-- --------
-- No statement states this predicate in `ON CONFLICT ... WHERE` since 2133b988ed: every session insert and revive is a
-- Prisma create or update, and a lost claim is told apart by the index NAME in the P2002 it raises
-- (tasks/task-supersession.ts#isExecutionClaimConflict, tasks/tasks.service.ts#isTaskRunClaimConflict). The servers of
-- deploy 1 match that name with `includes('session_task_execution_claim_idx')`. The new name begins with the old one,
-- so they recognise a refusal from either index, whichever one PostgreSQL reports when a row breaks both, and after
-- release B too.
--
-- WHICH DEPLOY IT MAY RIDE IN, AND WHAT A SERVER ONE RELEASE OLDER DOES
-- --------------------------------------------------------------------
-- Deploy 2 or later, after 1401/1402 (above). A deploy-1 server against this database: its inserts and revives are
-- refused by both indexes exactly as by the old one alone; its P2002 classifiers recognise either name (above); its
-- reads state the old status set and keep the old index as their access path, which is unchanged. A deploy-2 server
-- (release A) states the new predicate: `finished_at IS NULL` in the reads whose access path is the claim index
-- (sessions/task-work-carrier.ts#sessionCarriesTaskSql, the two holder reads) and both names in its classifiers. It
-- applies this migration at boot, before it serves, so the index exists before any such server serves; if the build
-- fails the server does not start and the deploy-1 servers go on serving. A deploy-2 server would also be correct
-- without the index (the old one still enforces the claim; the reads lose an access path, not a row).
--
-- HOW PRISMA RUNS IT
-- ------------------
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, an implicit one included. Prisma 7.10 sends a file
-- statement by statement, each on its own, only while it can read every statement in it; a DO block, a CREATE
-- PROCEDURE, or a DROP / REINDEX CONCURRENTLY makes it send the whole file as one statement, which PostgreSQL runs as
-- one transaction, and the build would then fail with 25001. This file holds only SET, DROP INDEX IF EXISTS, CREATE
-- INDEX CONCURRENTLY and RESET (as 0479). Proven with the real `prisma migrate deploy` on a populated database in
-- sessions/session-claim-index.pg.spec.ts.
--
-- WHAT EACH STATEMENT LOCKS
-- -------------------------
--   - DROP INDEX IF EXISTS, under lock_timeout 2 s: on a first run there is nothing to drop and it takes no lock. On a
--     re-run it drops what an interrupted build left (below): ACCESS EXCLUSIVE on session for an instant, asked for 2 s
--     at most, so a re-run that cannot have it fails at once and is run again; nobody queues behind it for longer.
--   - CREATE UNIQUE INDEX CONCURRENTLY: SHARE UPDATE EXCLUSIVE on session through both scans. Reads and writes go on;
--     it conflicts with schema changes and VACUUM only. It waits for every transaction that holds a write lock on
--     session when it starts, which holds up nobody. lock_timeout and statement_timeout are lifted for it: a timeout
--     there does not shorten anyone's wait, it only leaves an INVALID index (docker-compose.yml's statement_timeout
--     comment: a migration that needs more sets it to 0 itself).
--   - RESET gives the connection back the server's settings.
--
-- IF IT IS INTERRUPTED
-- --------------------
-- A concurrent build that is cancelled, times out or loses its connection after its catalog entry was written leaves
-- the index in place and INVALID (pg_index.indisvalid = false). The planner never reads it, and whether writes still
-- maintain it depends on how far the build got (indisready), so it does not count as built; 0130's index goes on
-- enforcing the claim either way. Prisma records the migration as failed, and every later deploy stops on P3009 until
-- an operator runs
--   prisma migrate resolve --rolled-back 1426_session_task_execution_claim_finished_at_idx
-- and deploys again. The re-run's DROP INDEX IF EXISTS removes the INVALID index and the build makes it again, valid
-- (drilled in the spec: a build held behind an open writer, cancelled, P3009, resolve, deploy, valid). By hand, the
-- same two statements do it. To find one:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid AND indrelid = 'session'::regclass;
-- IF NOT EXISTS is deliberately not used: it would take an INVALID index for a built one and record success.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1426: after 1425, the last of the six; main uses up to 1411 (rescanned 2026-11-21). Not a multiple of 10.
-- Can run twice: the drop, then the build.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET lock_timeout = '2s';

DROP INDEX IF EXISTS "session_task_execution_claim_idx_finished_at";

SET lock_timeout = 0;

SET statement_timeout = 0;

CREATE UNIQUE INDEX CONCURRENTLY "session_task_execution_claim_idx_finished_at" ON "session" ("task_id")
  WHERE "task_id" IS NOT NULL AND "deleted_at" IS NULL AND "finished_at" IS NULL;

RESET statement_timeout;

RESET lock_timeout;
