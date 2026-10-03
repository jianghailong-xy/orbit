-- `task.dispatch_authority`, the trigger that wrote it and the enum it was typed with: retired.
--
-- 0122_project_dispatch_boundary introduced all three for a mixed-version dispatch boundary. The
-- column carried the authority a task's dispatcher was expected to hold: `task_dispatch_authority_
-- derive` (BEFORE INSERT OR UPDATE OF project_id, dispatch_authority) stamped it at birth from the
-- filed project's `coordinator_enabled`, and `project_dispatch_authority_fanout` (AFTER UPDATE OF
-- coordinator_enabled ON project) rewrote it across every task of a project whose switch had just
-- flipped. Its one reader was 0122's `session_dispatch_authority_guard`, the insert-time brake that
-- refused a Coordinator dispatch onto a LEGACY task and a legacy sweep onto a COORDINATOR one.
--
-- 0164 dropped that guard, one of the five `PROJECT_COORDINATOR` session guards it removed; the
-- `project_action` table its `EXISTS` clause read stayed until 0272 dropped it.
-- 0290 retired the fanout, after it held a project's row for 648 s on 2026-09-19 01:36 UTC and
-- starved the apiserver's connection pool. What is left is the trigger and column below, which no
-- longer feed any decision: the derive trigger still stamps each task at birth, but with the guard
-- gone nothing reads what it stamps. The values are neither fresh (the fanout that used to keep a
-- task in step with its project is gone) nor load-bearing.
--
-- WHY THE COLUMN GOES TOO
-- =======================
-- Nothing in the repository reads it, and the premise was re-checked against the deployment before
-- this migration was written, not inherited from 0290's note:
--
--   select p.proname from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.prosrc like '%dispatch_authority%';
--   -- task_dispatch_authority_derive   (this migration's own function; 0290's fanout still present
--   --                                   on a deployment that has not run 0290 yet)
--
-- `pg_index`, `pg_constraint`, `pg_view` and `pg_matview` name it in no row; the column is
-- `public.task`'s alone; and the repository's only remaining references are the Prisma schema, the
-- write inventory and fixtures, all updated in the same change.
--
-- ARCHIVED FIRST
-- ==============
-- The drop was decided by the account owner, as 0272's was ("dropped by account-owner decision"),
-- and taken on task 34RNERPaIu0ZzyhbQuOJ0, which is OWNER_CONFIRMED: the confirmation is the
-- account owner's, in the Orbit app, and no agent can give it. Before this file was written, the
-- column's stored values, its column definition, the enum and the derive trigger's body were
-- dumped off the host's git tree to
--
--   /root/orbit/data/archive/task_dispatch_authority-2026-09-19/
--
-- (task.dispatch_authority.csv — all 111,774 values by id; dispatch_authority-definitions.sql; a
-- README.txt with the restore order and the fingerprints). Restoring was verified, not assumed:
-- the csv loads back as 111,774 rows and recomputes the source fingerprint
-- md5(string_agg(id::text || ':' || dispatch_authority::text, '|' ORDER BY id)) =
-- 31576cce100473b8017545090484fadd. The 111,774 is the whole column; the 109,875 quoted in the
-- work that ordered this retirement is project 01a02d83's task count, the row count 0290's fanout
-- used to rewrite, not the number of stored values.
--
-- WHAT IT DOES NOT TOUCH
-- ======================
-- Every object below is named exactly, as 0272 named the six it removed; nothing is removed by
-- pattern. `DROP TYPE "task_dispatch_authority"` drops an enum whose name merely shares a prefix
-- with `task_completion_criterion` — that type, its three labels, `task.completion_criterion`,
-- `task.acceptance_command`, `task.acceptance_expected_exit_code`, the 0177 pair, every
-- `project_acceptance_*` object and the DONE fence are untouched. This migration carries no
-- INSERT, UPDATE or DELETE: dropping a column is catalog-only and rewrites no heap tuple (the dead
-- values stay in place until vacuum reclaims them). The closing gate below re-asserts the premise
-- on the deployment this runs against, the way 0290's did, so a reader that reappears in a
-- function body fails the deployment loudly instead of being left to fail at runtime — a plpgsql
-- body is text, and PostgreSQL would not have refused the drop over it.
--
-- LOCKS
-- =====
-- `DROP TRIGGER` and `ALTER TABLE … DROP COLUMN` each take ACCESS EXCLUSIVE on `task`, held for the
-- catalog work only — no table rewrite, so seconds even on the production table (254 MB heap,
-- 628 MB TOAST). It is worth knowing the shape anyway: while the exclusive lock waits for a
-- running reader, every later reader queues behind it, so a migration run should not be started
-- with a long query in flight against `task`.

-- 1. The trigger, named exactly, as 0272 named the two it removed — so it can be seen going.
DROP TRIGGER IF EXISTS "task_dispatch_authority_derive" ON "task";

-- 2. Its function. `pg_proc` held exactly one trigger for it, and nothing else calls it.
DROP FUNCTION IF EXISTS "task_dispatch_authority_derive"();

-- 3. The column, with its NOT NULL and its `'LEGACY'` default. No index, constraint or view names
--    it, so this takes nothing else with it.
ALTER TABLE "task" DROP COLUMN IF EXISTS "dispatch_authority";

-- 4. The enum, and its array type with it. Nothing else is typed with it.
DROP TYPE IF EXISTS "task_dispatch_authority";

-- 5. The post-conditions, enforced on the deployment rather than asserted in prose.
--    (a) No function in `public` may still name the column: a plpgsql body is text, so a reader
--        that came back would compile fine and fail only when it ran.
--    (b) `task` must not still carry a column of that name. `IF EXISTS` above is silent when the
--        object is absent, so without this a renamed column would let the migration "succeed"
--        while leaving one behind. `attisdropped` is excluded on purpose: the attribute row of the
--        column just dropped is still there, marked dropped, and is not a column.
DO $$
DECLARE "others" TEXT;
DECLARE "leftover" INT;
BEGIN
  SELECT string_agg(p."proname", ', ' ORDER BY p."proname") INTO "others"
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n."oid" = p."pronamespace"
   WHERE n."nspname" = 'public'
     AND p."prosrc" LIKE '%dispatch_authority%';
  IF "others" IS NOT NULL THEN
    RAISE EXCEPTION
      'REFUSED: the column is gone, but these functions still name dispatch_authority: %', "others";
  END IF;

  SELECT count(*) INTO "leftover"
    FROM pg_catalog.pg_attribute a
   WHERE a."attrelid" = 'public.task'::regclass
     AND a."attname" = 'dispatch_authority'
     AND a."attnum" > 0
     AND NOT a."attisdropped";
  IF "leftover" > 0 THEN
    RAISE EXCEPTION 'REFUSED: task still carries a dispatch_authority column';
  END IF;
END $$;
