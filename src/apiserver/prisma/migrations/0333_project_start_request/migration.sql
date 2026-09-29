-- 0333 — a coordinator's request to start its project is an open item of its own.
--
-- WHAT IT ADDS
-- ============
--   * `START_REQUEST` joins `project_open_item_kind_chk`: the request `project_request_start` files
--     once the plan passes its readiness check, holding the settings the coordinator suggests, why,
--     and the digests of the criteria and the plan it was made about. It is what the owner's "Start
--     this project?" card is drawn from, and the start door resolves it (APPROVED).
--   * `START_REQUEST` joins `project_open_item_owner_only_chk`: it is asked OF the owner and never
--     worked by the coordinator, like a merge approval, a question or a pause.
--
-- Nothing else moves. A superseded request uses the state 0278 already defined (`SUPERSEDED`, with
-- `superseded_by_item_id` when a newer request replaced it), and a start ends one with the
-- resolution `APPROVED` the set already holds.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two CHECK constraints are replaced by wider ones that every stored row satisfies — no row holds the
-- new kind yet — so no row is rewritten or refused. Validating them reads `project_open_item` once
-- under the ACCESS EXCLUSIVE lock the ALTER takes; the table holds one row per exception ever
-- opened, which is small.

BEGIN;

ALTER TABLE "project_open_item"
  DROP CONSTRAINT "project_open_item_kind_chk",
  ADD CONSTRAINT "project_open_item_kind_chk" CHECK ("kind" IN (
    'INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR', 'TASK_FAILED',
    'PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST')),
  DROP CONSTRAINT "project_open_item_owner_only_chk",
  ADD CONSTRAINT "project_open_item_owner_only_chk" CHECK (
    "kind" NOT IN ('PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST')
    OR "assignee" = 'OWNER');

COMMIT;
