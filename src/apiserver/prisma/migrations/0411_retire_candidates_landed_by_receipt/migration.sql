-- The merge candidates a recorded merge had already answered, retired once, by the deploy that stops
-- leaving them standing (contract §3.3 M-T13).
--
-- WHY THIS EXISTS
-- ===============
-- A MAIN-line task's branch is offered to the owner as a TASK_BRANCH candidate when the task goes DONE
-- (M-F2). When the work reaches main another way — the coordinator fast-forwards main to the branch's
-- commit and records the merge receipt — nothing ended that candidate: only a newer candidate, the
-- owner's decline or the platform's own merge did. Its check then could not fetch a branch that had
-- never been pushed (`SOURCE_BRANCH_MISSING`), the candidate went BLOCKED, and the project's sessions
-- page said "Can't merge into main yet", with "Coordinator is resolving it" under it, about work that
-- was already on main, in a project already DONE (2026-10-09, project 34b78EQPNkVF8kM3ki7Ch). Every
-- BLOCKED TASK_BRANCH candidate in production had this shape: five rows across two projects, the
-- oldest from 2026-09-24, each with its exception already closed by the coordinator.
--
-- `retireCandidatesLandedByReceipt` (src/apiserver/src/projects/project-promotion.service.ts) now
-- retires such a candidate in the transaction that records the receipt. This file is the other half,
-- for the candidates already standing beside their receipt when that rule shipped. Historical-row
-- repair, the shape 0394_close_refused_running_shells has.
--
-- ONE ROW SET, THREE WRITES, ONE PREDICATE
-- ========================================
-- The live rule's predicate, in SQL: a TASK_BRANCH candidate still CHECKING, READY or BLOCKED, for
-- which a receipt of the same task says the same branch landed (MERGED or ALREADY_MERGED) on the
-- candidate's upstream, recorded no earlier than the candidate was made. Branches are compared by
-- their short names, as the rule compares them. The writes run in the rule's order — the check job,
-- then the items, then the candidate — because the last is the only write that changes what the
-- predicate sees; once it has run the predicate matches nothing, so re-applying this file is a no-op.
--
-- `session_merge_receipt.created_at` is a `timestamp` holding UTC (Prisma's default) and
-- `project_promotion.created_at` a `timestamptz`, so the candidate's is read in UTC to compare them.

-- ---------------------------------------------------------------------------------------------
-- 1. Their check jobs, as J-T8 stops one: a QUEUED job is cancelled, a RUNNING one is asked to stop.
-- ---------------------------------------------------------------------------------------------
UPDATE "project_integration_job" AS j
   SET "state" = CASE WHEN j."state" = 'QUEUED' THEN 'CANCELLED' ELSE j."state" END,
       "finished_at" = CASE WHEN j."state" = 'QUEUED' THEN now() ELSE j."finished_at" END,
       "cancel_requested_at" = CASE WHEN j."state" = 'RUNNING' THEN now() ELSE j."cancel_requested_at" END,
       "updated_at" = now()
  FROM "project_promotion" AS p
 WHERE j."id" = p."check_job_id"
   AND (j."state" = 'QUEUED' OR (j."state" = 'RUNNING' AND j."cancel_requested_at" IS NULL))
   AND p."source_kind" = 'TASK_BRANCH'
   AND p."state" IN ('CHECKING', 'READY', 'BLOCKED')
   AND EXISTS (
     SELECT 1
       FROM "session_merge_receipt" AS r
      WHERE r."task_id" = p."task_id"
        AND r."result" IN ('MERGED', 'ALREADY_MERGED')
        AND regexp_replace(r."source_branch", '^refs/heads/', '') = regexp_replace(p."source_ref", '^refs/heads/', '')
        AND regexp_replace(r."target_branch", '^refs/heads/', '') = regexp_replace(p."upstream_ref", '^refs/heads/', '')
        AND r."created_at" >= (p."created_at" AT TIME ZONE 'UTC'));

-- ---------------------------------------------------------------------------------------------
-- 2. The owner's card and the failures about them that are still OPEN: closed by the platform,
--    PROMOTION_MOVED_ON (§4.2), as `closePromotionItems` and the card's own close write it.
-- ---------------------------------------------------------------------------------------------
UPDATE "project_open_item" AS i
   SET "state" = 'RESOLVED',
       "resolution" = 'PROMOTION_MOVED_ON',
       "resolved_by" = 'PLATFORM',
       "resolved_at" = now(),
       "updated_at" = now()
  FROM "project_promotion" AS p
 WHERE i."promotion_id" = p."id"
   AND i."state" = 'OPEN'
   AND i."kind" IN ('PROMOTION_APPROVAL', 'INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR')
   AND p."source_kind" = 'TASK_BRANCH'
   AND p."state" IN ('CHECKING', 'READY', 'BLOCKED')
   AND EXISTS (
     SELECT 1
       FROM "session_merge_receipt" AS r
      WHERE r."task_id" = p."task_id"
        AND r."result" IN ('MERGED', 'ALREADY_MERGED')
        AND regexp_replace(r."source_branch", '^refs/heads/', '') = regexp_replace(p."source_ref", '^refs/heads/', '')
        AND regexp_replace(r."target_branch", '^refs/heads/', '') = regexp_replace(p."upstream_ref", '^refs/heads/', '')
        AND r."created_at" >= (p."created_at" AT TIME ZONE 'UTC'));

-- ---------------------------------------------------------------------------------------------
-- 3. The candidates themselves: SUPERSEDED, as the rule writes it — a merge somewhere else took
--    their place.
-- ---------------------------------------------------------------------------------------------
UPDATE "project_promotion" AS p
   SET "state" = 'SUPERSEDED',
       "decided_at" = now(),
       "updated_at" = now()
 WHERE p."source_kind" = 'TASK_BRANCH'
   AND p."state" IN ('CHECKING', 'READY', 'BLOCKED')
   AND EXISTS (
     SELECT 1
       FROM "session_merge_receipt" AS r
      WHERE r."task_id" = p."task_id"
        AND r."result" IN ('MERGED', 'ALREADY_MERGED')
        AND regexp_replace(r."source_branch", '^refs/heads/', '') = regexp_replace(p."source_ref", '^refs/heads/', '')
        AND regexp_replace(r."target_branch", '^refs/heads/', '') = regexp_replace(p."upstream_ref", '^refs/heads/', '')
        AND r."created_at" >= (p."created_at" AT TIME ZONE 'UTC'));
