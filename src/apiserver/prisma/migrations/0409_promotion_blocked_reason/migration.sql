-- 0409 — why a promotion candidate is BLOCKED, as a stored fact rather than a guess.
--
-- WHAT IT ADDS
-- ============
-- `project_promotion.blocked_reason`: what the job that blocked the candidate answered, written by
-- the same UPDATE that writes BLOCKED (`blockPromotion` in project-promotion.service.ts):
--   * `ALREADY_LANDED` — the source is already an ancestor of the upstream, so there is nothing to
--     merge (M-S1);
--   * `CHECK_FAILED`   — a check on the combined tree did not pass;
--   * `CONFLICT`       — the merge did not reconcile;
--   * `ERROR`          — the job stopped before it could answer (FETCH_FAILED, CHECK_TREE_UNPREPARED,
--                        …), so no check verdict exists.
-- It is cleared when the candidate's check is queued again (§4.7 H1), because a candidate that is
-- asking again is no longer blocked by anything.
--
-- WHY IT EXISTS
-- =============
-- A BLOCKED row carried only `checks` and `conflicts`, so a client read the reason off those two
-- arrays: no conflicts meant "the checks on the combined tree did not pass". On 2026-10-09 (project
-- 34PBlWiEZytRLTcPufJht) a candidate whose source was already on main was blocked as ALREADY_LANDED
-- with `checks = []` and `conflicts = []`, and the card told the owner a check had failed. No check
-- had run. A job that errors before its checks leaves the same two empty arrays.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A catalog-only ADD COLUMN with no default, and a CHECK that every stored row satisfies because the
-- column reads NULL in it. No row is read, written or backfilled: a candidate blocked before this
-- reads NULL, and its readers keep deriving the reason from `checks` and `conflicts` as they always
-- did. No trigger, function or type is created, replaced or dropped.

ALTER TABLE "project_promotion"
  ADD COLUMN "blocked_reason" text,
  ADD CONSTRAINT "project_promotion_blocked_reason_chk" CHECK (
    "blocked_reason" IS NULL
    OR "blocked_reason" IN ('ALREADY_LANDED', 'CHECK_FAILED', 'CONFLICT', 'ERROR'));
