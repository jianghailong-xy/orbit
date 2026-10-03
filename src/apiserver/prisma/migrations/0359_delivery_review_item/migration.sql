-- 0359 — a finished delivery whose landing somebody has to decide is an exception item.
--
-- Files a delivery changed outside its own declaration, and a branch git refused to merge, used to
-- raise a CRITICAL blocker addressed to the account owner. Both are questions about what happens to
-- the task's landing (`DECIDE_TASK_LANDING`, COORDINATOR_BOUNDED), so in an Automatic project they
-- now go to the project's coordinator conversation first as a `DELIVERY_REVIEW` item, and reach the
-- owner only through the item's own escalation. It is not an owner-only kind, so only the kind CHECK
-- widens; `project_open_item_owner_only_chk` is unchanged. No row is rewritten and nothing is
-- backfilled: blockers already open stay as they are and end the way they always did.
--
-- The set below is the one 0345 left in force (verified against the deployed database's
-- `pg_get_constraintdef` on 2026-10-03: the same nine kinds) plus `DELIVERY_REVIEW`, so every stored
-- row satisfies it. The number follows main's 0358 and every sibling branch's migrations.

BEGIN;

ALTER TABLE "project_open_item"
  DROP CONSTRAINT "project_open_item_kind_chk",
  ADD CONSTRAINT "project_open_item_kind_chk" CHECK ("kind" IN (
    'INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR', 'TASK_FAILED',
    'PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST', 'DONE_REQUEST',
    'DELIVERY_REVIEW'));

COMMIT;
