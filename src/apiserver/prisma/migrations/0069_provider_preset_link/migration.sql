-- Link a configured provider back to the vendor preset it was created from.
--
-- Until now "connect Anthropic" COPIED the preset's model list into the row, so the catalogue in
-- @orbit/shared was only ever a create-time template: shipping a new model reached nobody who had
-- already configured that vendor. With this link the server resolves a following row's models and
-- default model from the preset on every read, and the copy in `models` becomes a fallback for a
-- preset that later disappears.
-- Two facts, deliberately not one column: which vendor a row IS (fixed for life — it draws the
-- logo, and survives the row's slug being suffixed to "anthropic-2"), and whether that vendor's
-- catalogue still OWNS its model list (given up the moment someone edits the list by hand, and
-- reclaimable from the same spot).
ALTER TABLE "model_provider" ADD COLUMN "preset_slug" TEXT;
ALTER TABLE "model_provider" ADD COLUMN "follows_preset" BOOLEAN NOT NULL DEFAULT false;

-- Adopt the rows that came from a preset. Pre-migration the only link was the slug itself (the web
-- form looked the preset up by it), so that heuristic is exactly what existed before — this just
-- makes it explicit and lets later rows deviate. A hand-edited model list on one of these now
-- yields to the preset; re-editing it hands ownership back.
UPDATE "model_provider"
   SET "preset_slug" = "slug", "follows_preset" = true
 WHERE "slug" IN ('anthropic', 'openai', 'gemini', 'deepseek', 'kimi', 'glm', 'minimax', 'qwen');
