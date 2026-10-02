-- 0353 — a promotion candidate's open items, found by the candidate.
--
-- WHY
-- ===
-- A candidate that leaves the live states — superseded, declined, cancelled or merged — now closes
-- the INTEGRATION_* items its check or its landing opened, in the transaction that moves it
-- (`closePromotionItems` in projects/project-promotion.service.ts; contract §4.2,
-- PROMOTION_MOVED_ON). Before this, only the owner's approval card was closed, and a failure about a
-- candidate that no longer existed stayed open: escalated to the owner on the clock, and counted by
-- M-T11 against every later candidate of its project, which kept Automatic from merging anything.
-- The close is
--
--   UPDATE "project_open_item" SET ...
--    WHERE "project_id" = $1 AND "promotion_id" = $2 AND "state" = 'OPEN' AND "kind" IN (...)
--
-- on every supersession, decline, cancel and merge, and nothing indexes `promotion_id`.
--
-- PARTIAL, over OPEN rows only, because OPEN is the only state a candidate's items are looked up in:
-- a closed item is final (`project_open_item_terminal_guard`) and nothing finds it by its candidate
-- again. Open items are a handful at any moment (3 of this deployment's 252 on 2026-10-02), so the
-- index stays that size however long the table grows. `project_open_item_open_dedupe_key` and
-- `project_open_item_task_idx` (0278) are partial for the same kind of reason, and like them this
-- one cannot be spelled in schema.prisma.
--
-- Deliberately not CONCURRENTLY because Prisma runs the migration in a transaction, as with 0283 and
-- 0305: the table is small and the build is one pass over it. A deployment that pre-creates the
-- identical index CONCURRENTLY makes this a no-op through IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS "project_open_item_promotion_open_idx"
  ON "project_open_item" ("promotion_id")
  WHERE "state" = 'OPEN';
