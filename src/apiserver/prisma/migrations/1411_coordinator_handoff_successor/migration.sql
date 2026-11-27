-- 1411 — what the successor of a coordinator handoff runs on (docs/coordinator-handoff.md, "The successor's model").
--
-- A replacement used to open the new coordinator on the previous one's engine, provider and model
-- (start-anchor.ts previousCoordinatorAnchor). When that model is the reason for handing over — its
-- provider's sign-in failed, its engine will not start — the successor would fail the same way. The owner
-- may now name what the successor runs on when they hand over or skip the note; it is kept on the row,
-- because a handoff with a note opens its successor only once the note turn has ended.
--
-- All three are NULL when nothing was named, which keeps the old behaviour. Existing rows keep NULL.
-- Every statement can run twice.

ALTER TABLE "coordinator_handoff" ADD COLUMN IF NOT EXISTS "successor_engine" TEXT;
ALTER TABLE "coordinator_handoff" ADD COLUMN IF NOT EXISTS "successor_provider" TEXT;
ALTER TABLE "coordinator_handoff" ADD COLUMN IF NOT EXISTS "successor_model" TEXT;
