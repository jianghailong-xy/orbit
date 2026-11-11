-- 0528 — a SubAgent's approval cards (docs/subagent-design.md §5.3).
--
-- A SubAgent asks under its parent's session, and the process reading the answer is the SubAgent's own
-- child engine: it outlives the parent's turn and the parent's calls, so the card names its run and is
-- collected when that run ends (sessions/abandoned-approvals.ts). Nullable, no FK and no backfill: every
-- existing row was asked by a session itself.
ALTER TABLE "approval" ADD COLUMN "subagent_run_id" UUID;
