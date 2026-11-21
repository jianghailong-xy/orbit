-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1405: every FAILED session's release cause is a failure cause (docs/session-three-state-design.md §4.2 and §6.3;
-- project 3508bDBDE5xPH43TYuiqP). Runs before 1406 adds the CHECK that holds it.
--
-- THE BACKFILL
-- ------------
-- Only FAILED rows whose release_cause is not a failure cause are written, and only release_cause. Before this
-- task those are the two causes that meant both a clean and a failed end:
--   engine_exited                         the runner's FAILED finalize with no end requested, and 1262's ELSE
--   an end reason (task_done ... orphaned)  the reaper's "cancel not honored" release, and 1262's end_reason rule,
--                                         which came first and so also took FAILED rows whose end_reason was
--                                         written after they failed (a person completing or deleting a failed
--                                         session records the end reason on the released row)
-- (landing_settled is never written with FAILED; a FAILED LANDING row, if one exists, takes the rules below.)
--
-- The new cause is read off the row's own facts, by 1262's FAILED rules in 1262's order with its end_reason rule
-- left out, and the not-honoured end named for itself:
--   import_source_cwd still set                             import_failed   (runner-api importResult)
--   source_state = REFUSED                                  setup_failed    (session-source.ts)
--   error = 'runner offline'                                runner_lost     (reaper)
--   error ends ' runtime not initialized'                   setup_failed    (reaper)
--   error = 'cancel not honored' or ends ' end not honored'  end_not_honored (reaper's cancel grace)
--   cancel_requested_at set                                 turn_failed     (turn-complete and the reaper's
--                                                                            API-error backstop stamp it)
--   anything else                                           engine_failed   (the runner finalized FAILED with
--                                                                            no end requested)
-- end_reason, status and every other column stay as they are. SUCCEEDED and CANCELLED rows are not touched: no
-- writer and no backfill ever gave one a failure cause (turn_failed, runner_lost, setup_failed and import_failed
-- were only ever written with FAILED, and engine_failed and end_not_honored are new), so their causes already read
-- as no failure. 1407's VALIDATE would name any that did.
--
-- HOW PRISMA RUNS IT, LOCKS
-- --------------------------
-- As 1202 (whose header has the test): `prisma migrate deploy` sends a file with a DO block or a CREATE PROCEDURE
-- whole, as one transaction, and any other file statement by statement, each statement committing on its own. The
-- earlier version of this file, believing it was sent statement by statement, backfilled through a procedure that
-- COMMITted per batch; the CREATE PROCEDURE made Prisma send it whole, and the COMMIT is refused there (2D000) on
-- any database holding a FAILED row to rewrite. This version has no procedure and no COMMIT and is correct either
-- way: one UPDATE, bracketed by a SET and a RESET.
--
-- What it holds, for how long, as Prisma sends it: the UPDATE holds ROW EXCLUSIVE on session, which blocks no reader
-- or writer, and a row lock on each FAILED row it rewrites until it commits, so a write to one of those rows waits
-- for it. It runs under no ACCESS EXCLUSIVE lock: 1403 and 1406 are files of their own. It writes fewer rows than
-- 1262 (FAILED rows whose cause is not a failure only), so it holds them no longer than 1262's UPDATE, measured at
-- 0.8 s with 100,000 sessions; production holds about 12,000. A wait of that length once per deploy is acceptable:
-- the rows are released sessions, which few writers touch, and it is well inside the 30 s lock_timeout
-- (docker-compose.yml) of anyone waiting. statement_timeout (300 s there) is lifted for the UPDATE only. No status
-- is written, so no UPDATE OF status trigger fires. A much larger session table: as 1202, an operator runs the same
-- UPDATE before deploying, outside Prisma, in autocommitted batches by id range; this file then writes nothing.
--
-- WHICH RELEASE IT MAY SHIP IN
-- ----------------------------
-- With 1406 and 1407, never in the release that carries this task's writers and 1403: see 1406. A replica of an
-- older release still writes FAILED rows with the old causes after this has run, and 1407 would refuse them.
--
-- RE-RUNNABILITY
-- --------------
-- Can run twice: it writes only FAILED rows whose cause is not a failure, and each write makes it one. If the
-- UPDATE fails (a timeout, a deadlock with a live writer, a crash), Prisma records 1405 as failed and `prisma
-- migrate deploy` stops with P3009 until `prisma migrate resolve --rolled-back
-- 1405_session_release_failure_backfill`, after which deploy runs it again. Where the earlier version is recorded
-- as applied (on every database migrated while its tables were empty), deploy does not run this again.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET statement_timeout = 0;

UPDATE "session" s
   SET "release_cause" = CASE
         WHEN s."import_source_cwd" IS NOT NULL THEN 'import_failed'
         WHEN s."source_state" = 'REFUSED' THEN 'setup_failed'
         WHEN s."error" = 'runner offline' THEN 'runner_lost'
         WHEN s."error" LIKE '% runtime not initialized' THEN 'setup_failed'
         WHEN s."error" = 'cancel not honored' OR s."error" LIKE '% end not honored' THEN 'end_not_honored'
         WHEN s."cancel_requested_at" IS NOT NULL THEN 'turn_failed'
         ELSE 'engine_failed'
       END
 WHERE s."status"::text = 'FAILED'
   AND s."release_cause" NOT IN (
     'turn_failed', 'runner_lost', 'setup_failed', 'engine_failed', 'end_not_honored', 'import_failed'
   );

RESET statement_timeout;
