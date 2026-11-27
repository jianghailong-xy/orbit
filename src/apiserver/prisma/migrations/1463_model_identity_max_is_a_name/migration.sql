-- 1463: a trailing `-max` is part of a model's name, not an effort level (model-identity.ts modelRuleKey).
--
-- The id rule used to drop a level suffix from every id, so `qwen3.7-max` was keyed `qwen3-7` and could have been
-- taken for a plain Qwen3.7. Only Antigravity's ids carry a level, and its caller now folds those itself. The three
-- keys 1433 seeded from such ids are keyed by the whole id again, with what they point at; their names are unchanged.
-- Rows already under the new key are left as they are. Runs twice safely: the second pass finds no old key.
UPDATE "model_identity" SET "canonical_key" = v."to"
  FROM (VALUES ('qwen3-7', 'qwen3-7-max'), ('qwen3-8', 'qwen3-8-max'), ('qwen4', 'qwen4-max')) AS v("from", "to")
 WHERE "canonical_key" = v."from";
UPDATE "model_identity" m SET "rule_key" = v."to"
  FROM (VALUES ('qwen3-7', 'qwen3-7-max'), ('qwen3-8', 'qwen3-8-max'), ('qwen4', 'qwen4-max')) AS v("from", "to")
 WHERE m."rule_key" = v."from"
   AND NOT EXISTS (SELECT 1 FROM "model_identity" n WHERE n."rule_key" = v."to");
