-- 0375 — a finished delivery whose landing somebody has to decide is an exception item.
--
-- OUTSIDE_DECLARED_SCOPE and MERGE_REFUSED_BY_GIT are delivery questions, not owner-only ruler
-- changes. Automatic projects therefore file them as DELIVERY_REVIEW items for the coordinator;
-- owner escalation remains the existing exception-item path. Existing rows are untouched.

BEGIN;

ALTER TABLE "project_open_item"
  DROP CONSTRAINT "project_open_item_kind_chk",
  ADD CONSTRAINT "project_open_item_kind_chk" CHECK ("kind" IN (
    'INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR', 'TASK_FAILED',
    'PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST', 'DONE_REQUEST',
    'DELIVERY_REVIEW'));

COMMIT;
