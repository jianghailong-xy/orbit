-- Link a configured provider back to the vendor preset it was created from.
--
-- Until now "connect Anthropic" COPIED the preset's model list into the row, so the catalogue in
-- @orbit/shared was only ever a create-time template: shipping a new model reached nobody who had
-- already configured that vendor. With this link the server resolves a following row's models and
-- default model from the preset on every read, and the copy in `models` becomes a fallback for a
-- preset that later disappears.
ALTER TABLE "model_provider" ADD COLUMN "preset_slug" TEXT;

-- Adopt the rows that came from a preset. Pre-migration the only link was the slug itself (the web
-- form looked the preset up by it), so that heuristic is exactly what existed before — this just
-- makes it explicit and lets later rows deviate (a second Anthropic key lands on "anthropic-2" and
-- still follows the preset). A hand-edited model list on one of these now yields to the preset;
-- re-editing it detaches the row again.
UPDATE "model_provider"
   SET "preset_slug" = "slug"
 WHERE "slug" IN ('anthropic', 'openai', 'gemini', 'deepseek', 'kimi', 'glm', 'minimax', 'qwen');
