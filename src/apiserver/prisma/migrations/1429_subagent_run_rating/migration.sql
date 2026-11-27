-- 1429 — the parent's rating of a SubAgent run (docs/subagent-design.md §7.1): subagent_rate writes it, the Model tiers
-- view reads it beside each model, and routing never does.
--
-- subagent_run.rating_score: 1 to 5, as the parent session that started the run rated its result; NULL until it does.
-- subagent_run.rating_note: the parent's short reason, optional.
-- subagent_run.rated_at: when it rated (a later rating replaces the earlier one, and this time with it).
-- subagent_run.rater_engine / rater_provider / rater_model: the rating parent's own engine, provider and model when it
-- rated, so the view can say who rated.
--
-- Additive only: existing rows keep NULL in all six. No UPDATE or DELETE. Every statement can run twice.

ALTER TABLE "subagent_run" ADD COLUMN IF NOT EXISTS "rating_score" INTEGER;
ALTER TABLE "subagent_run" ADD COLUMN IF NOT EXISTS "rating_note" TEXT;
ALTER TABLE "subagent_run" ADD COLUMN IF NOT EXISTS "rated_at" TIMESTAMPTZ(3);
ALTER TABLE "subagent_run" ADD COLUMN IF NOT EXISTS "rater_engine" TEXT;
ALTER TABLE "subagent_run" ADD COLUMN IF NOT EXISTS "rater_provider" TEXT;
ALTER TABLE "subagent_run" ADD COLUMN IF NOT EXISTS "rater_model" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subagent_run_rating_score_check') THEN
    ALTER TABLE "subagent_run" ADD CONSTRAINT "subagent_run_rating_score_check"
      CHECK ("rating_score" IS NULL OR "rating_score" BETWEEN 1 AND 5);
  END IF;
END $$;

-- The Model tiers view reads one owner's runs of the last 90 days.
CREATE INDEX IF NOT EXISTS "subagent_run_owner_id_created_at_idx" ON "subagent_run" ("owner_id", "created_at");
