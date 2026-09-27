-- Session orchestration is one switch per account now: `user.preferences.enableOrchestration`,
-- on unless the owner turned it off (common/orchestration-switch.ts). Nothing reads the
-- per-workspace grant any more, so its column goes.
ALTER TABLE "workspace" DROP COLUMN "enable_orchestration";
