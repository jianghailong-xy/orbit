-- SubAgent tiers the owner sets on the Providers page (docs/subagent-design.md §4.2, §7): model id -> S/M/L/XL
-- for a key's models the catalogue gives no tier. Kept beside `models`, not in it, so editing the model list
-- (or a runner's provider_update) neither sets nor wipes them. No existing row, trigger or DONE fence is touched.
ALTER TABLE "model_provider" ADD COLUMN IF NOT EXISTS "model_tiers" JSONB NOT NULL DEFAULT '{}';
