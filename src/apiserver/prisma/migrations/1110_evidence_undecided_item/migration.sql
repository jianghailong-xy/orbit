-- 1110 — the owner's item about evidence its coordinator has not decided (EVIDENCE_UNDECIDED).
--
-- A project task judged by EVIDENCE_JUDGMENT has its latest evidence revision decided by the project's
-- coordinator first. When nobody decides it, the task stays OPEN and nobody is told (production,
-- 2026-11-10 to 11-18: a revision sat undecided for 8 days). The escalation clock gains one statement:
-- in a project whose coordinator switch is on, a latest revision with no decision for longer than the
-- project's `exception_escalation_seconds` opens ONE item for the account owner, keyed by the revision
-- (`dedupe_key = EV:<evidenceId>`), OWNER / ESCALATED from birth. It ends by itself when the revision is
-- decided (`DECIDED`), a newer revision replaces it (`REVISED`), or its task settles or leaves (`TASK_CLOSED`).
--
-- Three closed sets grow, all CHECKs on `project_open_item` (rank 60), each restated in full (0300's
-- reason, as 0453 does):
--   * `project_open_item_kind_chk` admits EVIDENCE_UNDECIDED (0453's list plus the value);
--   * `project_open_item_resolution_chk` admits DECIDED and REVISED (0453's list plus the two);
--   * `project_open_item_owner_only_chk` lists EVIDENCE_UNDECIDED among the owner-only kinds (0453's list
--     plus the value): the coordinator was already asked through the evidence delivery, so the item is
--     never delivered to it.
--
-- Catalog-only: every stored row already satisfies the widened sets. No row is written. Every statement
-- can run twice.

BEGIN;

ALTER TABLE "project_open_item"
  DROP CONSTRAINT IF EXISTS "project_open_item_kind_chk",
  ADD CONSTRAINT "project_open_item_kind_chk" CHECK ("kind" IN (
    'INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR', 'TASK_FAILED',
    'PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST', 'DONE_REQUEST',
    'DELIVERY_REVIEW', 'LANDING_LEASE_EXPIRED', 'LANDING_UNOBSERVED', 'LANDED_WITHOUT_CONFIRMATION',
    'EVIDENCE_UNDECIDED')),
  DROP CONSTRAINT IF EXISTS "project_open_item_resolution_chk",
  ADD CONSTRAINT "project_open_item_resolution_chk" CHECK ("resolution" IS NULL OR "resolution" IN (
    'LANDED', 'RETRIED', 'TASK_DONE', 'TASK_CLOSED', 'SUCCESSOR_FILED', 'PROMOTION_MOVED_ON',
    'HANDLED', 'APPROVED', 'DECLINED', 'ANSWERED', 'WITHDRAWN', 'RESUMED', 'JOB_MOVED_ON',
    'ACCEPTED', 'CODELESS', 'DECIDED', 'REVISED')),
  DROP CONSTRAINT IF EXISTS "project_open_item_owner_only_chk",
  ADD CONSTRAINT "project_open_item_owner_only_chk" CHECK (
    "kind" NOT IN ('PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST',
                   'DONE_REQUEST', 'LANDING_LEASE_EXPIRED', 'LANDED_WITHOUT_CONFIRMATION',
                   'EVIDENCE_UNDECIDED')
    OR "assignee" = 'OWNER');

COMMIT;
