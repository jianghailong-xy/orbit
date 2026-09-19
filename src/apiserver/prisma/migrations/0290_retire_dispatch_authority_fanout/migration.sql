-- `project_dispatch_authority_fanout`, retired: it maintained a column nothing reads.
--
-- 0122 hung this trigger on `project` so that flipping `coordinator_enabled` reached the authority
-- of the work it had already authorized: one `UPDATE "task" SET "dispatch_authority" = … WHERE
-- "project_id" = NEW."id"`, in the caller's transaction, over every task of that project.
--
-- THE COST, MEASURED
-- ==================
-- Nothing bounds that statement, and the row it is fired from is the one an ordinary
-- `PATCH /api/projects/:id` already holds. On 2026-09-19 01:36 UTC the production deployment ran it
-- against project 01a02d83 (109,874 tasks): the `UPDATE "project"` statement sat `active` with
-- `wait_event = (none)` for 648 s while holding that project row plus 109,874 task row locks, ten
-- writes queued behind it in `pg_stat_activity`, and the apiserver's Prisma pool starved — Reaper
-- and WatchEvaluator spent ~11 minutes failing with `Unable to start a transaction in the given
-- time` and four `POST /api/runner/sessions/:id/merge-receipts` calls timed out client-side. The
-- cost is linear in the project's task count and it is paid inside somebody else's transaction.
--
-- WHY REMOVING IT CHANGES NO ANSWER
-- =================================
-- `task.dispatch_authority` has no reader left. Its one reader was 0122's
-- `session_dispatch_authority_guard` — the insert-time brake that refused a Coordinator dispatch on
-- a LEGACY task and a legacy sweep on a COORDINATOR one — and 0272 dropped that trigger with
-- `project_action`, whose table the brake's `EXISTS` clause read. `tasks/tasks.service.ts` says the
-- same thing from the other side: `dispatch_authority` "is deliberately NOT read here, nor in
-- SCHEDULED_DUE_SQL, nor at execute()'s automatic door", because the dispatch pass it named was
-- removed with the control loop, and the column "started naming none at all".
--
-- This migration's closing gate asserts that premise on the deployment it runs against rather than
-- trusting the prose: after the drop, no function in `public` may name the column.
--
-- WHAT IT DOES NOT DO
-- ===================
-- It does not drop the column. `task.dispatch_authority` and 0122's `task_dispatch_authority_derive`
-- stay as they are — the BEFORE trigger still stamps a task at birth, which is one index lookup for
-- one row and touched none of the cost above. Retiring the column itself is a destructive change
-- that would discard 109,875 stored values, and by 0272's precedent (a table, two columns and two
-- enums, "dropped by account-owner decision") that is the account owner's call, not this one's.
--
-- This migration carries no DML of any kind: dropping a trigger and a function is catalog-only, so
-- no task row is read, locked, rewritten or removed by it.

-- 1. The trigger, named exactly, as 0272 named the two it removed — so it can be seen going.
DROP TRIGGER IF EXISTS "project_dispatch_authority_fanout" ON "project";

-- 2. Its function. `pg_proc` held exactly one trigger for it, and nothing else calls it.
DROP FUNCTION IF EXISTS "project_dispatch_authority_fanout"();

-- 3. The premise, enforced. If anything in `public` still names the column — a reader this change
--    did not find, or a trigger that re-creates the fanout — the deployment keeps the trigger and
--    this migration fails loudly instead of leaving dispatch to a body nobody checked.
--    `task_dispatch_authority_derive` is the one expected name: it writes the column at birth.
DO $$
DECLARE "others" TEXT;
BEGIN
  SELECT string_agg(p."proname", ', ' ORDER BY p."proname") INTO "others"
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n."oid" = p."pronamespace"
   WHERE n."nspname" = 'public'
     AND p."prosrc" LIKE '%dispatch_authority%'
     AND p."proname" <> 'task_dispatch_authority_derive';
  IF "others" IS NOT NULL THEN
    RAISE EXCEPTION
      'REFUSED: dispatch_authority_fanout removed, but these functions still name dispatch_authority: %',
      "others";
  END IF;
END $$;
