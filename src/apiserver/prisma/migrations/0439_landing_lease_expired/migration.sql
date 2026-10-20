-- 0439 — the owner's item about a landing attempt whose runner stopped reporting (X-E5).
--
-- The escalation clock (§4.6) gains one statement: a RUNNING integration job whose current claim has
-- been LEASE_EXPIRED for more than fifteen minutes opens ONE item for the account owner — the runner
-- is not coming back within any window the platform can wait, and abandoning the attempt is the only
-- remaining door. The item is one per claim (`dedupe_key = LE:<jobId>:<claimGeneration>`), so a new
-- claim after a takeover opens its own and the old one is closed by the generations that follow.
--
-- Three closed sets grow, all of them CHECKs on `project_open_item` (rank 60):
--   * `project_open_item_kind_chk` admits `LANDING_LEASE_EXPIRED` (0375's text plus the new value);
--   * `project_open_item_resolution_chk` admits `JOB_MOVED_ON`, the ending every edge of the lease
--     writes when the claim it was about moves on (0278's text plus the new value);
--   * `project_open_item_owner_only_chk` lists the kind among the owner-only ones (0345's text plus
--     the new value): the clock opens it WITH the owner, and nothing delivers it to a coordinator.
--
-- Only `project_open_item` is named. No function, trigger or type is created, replaced or dropped,
-- and no row is inserted, updated or deleted: the three constraints are catalog-only, re-checked
-- against rows that all satisfy them (every stored row's kind and resolution are already in the
-- sets this widens). The one index is the lookup every accepted progress report makes to close the
-- item of the claim that just reported — `resolveLeaseExpiredItems` filters exactly these three
-- columns — and it builds over the OPEN lease items that exist, which is a handful at most, since
-- the kind is new and each claim has one. Every statement can run twice.

BEGIN;

ALTER TABLE "project_open_item"
  DROP CONSTRAINT "project_open_item_kind_chk",
  ADD CONSTRAINT "project_open_item_kind_chk" CHECK ("kind" IN (
    'INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR', 'TASK_FAILED',
    'PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST', 'DONE_REQUEST',
    'DELIVERY_REVIEW', 'LANDING_LEASE_EXPIRED')),
  DROP CONSTRAINT "project_open_item_resolution_chk",
  ADD CONSTRAINT "project_open_item_resolution_chk" CHECK ("resolution" IS NULL OR "resolution" IN (
    'LANDED', 'RETRIED', 'TASK_DONE', 'TASK_CLOSED', 'SUCCESSOR_FILED', 'PROMOTION_MOVED_ON',
    'HANDLED', 'APPROVED', 'DECLINED', 'ANSWERED', 'WITHDRAWN', 'RESUMED', 'JOB_MOVED_ON')),
  DROP CONSTRAINT "project_open_item_owner_only_chk",
  ADD CONSTRAINT "project_open_item_owner_only_chk" CHECK (
    "kind" NOT IN ('PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST',
                   'DONE_REQUEST', 'LANDING_LEASE_EXPIRED')
    OR "assignee" = 'OWNER');

-- The edge's own lookup: one UPDATE per accepted progress report, release and result, by the job it
-- is about. Partial on the open lease items, so it stays the size of the cards in front of owners.
CREATE INDEX IF NOT EXISTS "project_open_item_lease_job_open_idx"
  ON "project_open_item" ("integration_job_id")
  WHERE "state" = 'OPEN' AND "kind" = 'LANDING_LEASE_EXPIRED';

COMMIT;
