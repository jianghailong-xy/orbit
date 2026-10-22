-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, server execution: the documents of a plan's version in force asked for again, by its owner
-- or — for support — by an administrator. contracts/wiki.contract.json `plan.jobs.rebuild` is the authority,
-- docs/wiki-server-execution-design.md §5.6 the design (owner's call 2026-10-17), and
-- src/apiserver/src/wiki/wiki-plan-rebuild.pg.spec.ts holds it.
--
-- WHAT CHANGES
-- ------------
--   wiki_plan_job_trigger_chk   0338 wrote the facts that ask for a job as two: the space was created
--                               (`space_created`) or its owner asked (`owner`). An administrator asking for a
--                               space's build again (POST /api/admin/wiki/spaces/:id/plan/build) is neither,
--                               and the job records who asked as what it is: `support`, beside the
--                               administrator in requested_by_user_id (already a history reference with no
--                               foreign key, 0338) and the reason in their Activity row. Restated with the
--                               third value.
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- No row is written, backfilled or locked beyond what the CHECK's validation reads: every stored row is
-- `space_created` or `owner`, which the restated CHECK admits as 0338's did. No table, column, index, trigger,
-- function or type is created, replaced or dropped; `wiki_plan_job` is the only table named, and `task`,
-- `session`, `project` and the DONE fence are named nowhere below.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0429: the highest number on main, every project/* and pushed orbit/* branch and every session worktree was
-- 0428 (0428_model_provider_key_check) when this was written (2026-10-17). The statement can run twice: the
-- CHECK is replaced only while it does not read `support` yet.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wiki_plan_job_trigger_chk' AND pg_get_constraintdef(oid) LIKE '%support%'
  ) THEN
    ALTER TABLE "wiki_plan_job" DROP CONSTRAINT IF EXISTS "wiki_plan_job_trigger_chk";
    -- What asked for a job: the space's creation, its owner, or an administrator for support.
    ALTER TABLE "wiki_plan_job" ADD CONSTRAINT "wiki_plan_job_trigger_chk" CHECK ("trigger" IN ('space_created', 'owner', 'support'));
  END IF;
END $$;
