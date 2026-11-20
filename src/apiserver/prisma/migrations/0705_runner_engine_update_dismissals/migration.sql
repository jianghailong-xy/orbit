-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `runner.engine_update_dismissals`: the engine update warnings the owner dismissed on this runner,
-- each until the next release of that engine.
--
--   engine_update_dismissals   { "<engine>": "<latest>" }: the release the failed update was
--                              against when someone pressed Dismiss, e.g. { "codex": "0.169.0" }.
--
-- Written by POST /runners/:id/engines/:engine/update-warning/dismiss
-- (RunnersService.dismissEngineUpdateWarning) with the engine's `update.latest` as it then stood,
-- and never by the runner. Every client hides that engine's update warning — the Needs Attention
-- card and the orange panel in its row — while the stored version equals the engine's current
-- `update.latest`; a newer release brings it back. Stored on the runner, so it holds for everyone
-- on the account.
--
-- ADD COLUMN only, nullable with no default: catalog-only, no stored row rewritten. NULL is nothing
-- dismissed, the old behaviour. No trigger on "runner" names it.

ALTER TABLE "runner" ADD COLUMN "engine_update_dismissals" JSONB;
