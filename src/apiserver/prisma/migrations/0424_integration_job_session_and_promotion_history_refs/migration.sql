-- 0424 — a landing's source session, and a promotion's task and session, are HISTORY REFERENCES,
-- not foreign keys (docs/project-integration-line-contract.md §2.1 and §3.2, revision 12;
-- docs/landing-session-design.md §9 item 2). The rest of what 0423 did for `task_id`.
--
-- WHAT IT DOES
-- ============
-- Drops three keys, each `ON DELETE SET NULL`:
--   * `project_integration_job_session_fkey` (0281), `project_integration_job.session_id → session(id)`;
--   * `project_promotion_task_fkey` (0286), `project_promotion.task_id → task(id)`;
--   * `project_promotion_session_fkey` (0286), `project_promotion.session_id → session(id)`.
-- The three columns stay exactly as they are: nullable, written when the row is inserted, and now
-- nobody's foreign key.
--
-- WHY: THE CONTRADICTION 0423 TOOK OFF `task_id`, ON THREE MORE COLUMNS
-- =====================================================================
-- Both tables refuse any UPDATE of a row that has finished: `project_integration_job_terminal_guard`
-- (0281, J4) once a job is no longer QUEUED or RUNNING, `project_promotion_terminal_guard` (0286)
-- once a promotion is MERGED, DECLINED, CANCELLED or SUPERSEDED. Each of these keys is an UPDATE:
-- deleting a session or a task makes PostgreSQL write `session_id = NULL` / `task_id = NULL` on
-- every row that names it, the guard raises `P0001 PROJECT_INTEGRATION_JOB_TERMINAL` or
-- `P0001 PROJECT_PROMOTION_TERMINAL`, and the whole DELETE rolls back:
--   * purging a session from Trash (`SessionsService.purge`) answered 500 for any session a finished
--     landing, a finished promotion check or a finished promotion was about;
--   * the hourly Trash purge (`ReaperService.purgeTrash`) is one `deleteMany`, so ONE such session
--     past retention kept every other one in Trash with it, hour after hour;
--   * deleting a task a finished promotion was about answered 500. A live `TASK_BRANCH` candidate
--     refused the same delete through `project_promotion_task_branch_chk` (23514) instead, as a
--     queued LAND_TASK did through `land_task_chk` before 0423.
-- Reproduced from the services in `src/apiserver/src/sessions/session-delete-integration-job.pg.spec.ts`
-- and `src/apiserver/src/projects/promotion-delete-integration-job.pg.spec.ts`.
--
-- The guards and the CHECK are not the half to drop, for 0423's reason: a finished job is the audit
-- of what the platform pushed, a finished promotion the audit of what the owner decided, and the ids
-- they carry are part of that audit. So the rows keep their ids and nobody's delete rewrites them —
-- what `retry_of_job_id` (0344) and `project_open_item.session_id` (0278) already are.
--
-- WHAT IT BUYS AND WHAT IT COSTS
-- ==============================
--   * Deleting a session or a task writes nothing of these rows: state, shas, checks, conflicts,
--     `receipt_ids`, and the ids of the task and session they were about all survive it.
--   * A row can now name a session or a task that no longer exists, and PostgreSQL no longer refuses
--     an id that names nobody. Every reader asks for the row behind the id and reads "not found" as
--     the NULL the key used to write — which is what keeps the two writers that copy a session id
--     into a column that IS a foreign key (`session_merge_receipt.session_id`, from a landing's
--     result and from a promotion's merge) writing exactly what they wrote before: nothing for a
--     session that is gone.
--
-- CATALOG-ONLY, AND RE-RUNNABLE
-- =============================
-- Three DROP CONSTRAINTs, each `IF EXISTS`. No row is read, written or backfilled: dropping a foreign
-- key removes a rule rather than adding one, so every stored row satisfies what is left. No column,
-- index, CHECK, function or trigger is created, replaced or dropped — in particular both terminal
-- guards, `project_integration_job_land_task_chk` and `project_promotion_task_branch_chk` stand as
-- they are.
--
-- LOCK
-- ====
-- Dropping a foreign key takes ACCESS EXCLUSIVE on BOTH ends, because it drops the key's triggers on
-- the referenced table too: `project_integration_job`, `project_promotion`, `session` and `task`, for
-- the length of three catalog writes in one transaction. Nothing is scanned, so the window is the
-- wait for the lock and not the work done under it.

BEGIN;

ALTER TABLE "project_integration_job"
  DROP CONSTRAINT IF EXISTS "project_integration_job_session_fkey";

ALTER TABLE "project_promotion"
  DROP CONSTRAINT IF EXISTS "project_promotion_task_fkey",
  DROP CONSTRAINT IF EXISTS "project_promotion_session_fkey";

COMMIT;
