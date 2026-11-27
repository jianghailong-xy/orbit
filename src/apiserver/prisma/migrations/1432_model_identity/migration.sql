-- 1432: which model ids name the same model (Settings → Model routing).
--
-- Engines and vendors spell one model differently (`kimi-code/k3` and `kimi-k3`). What the id rules cannot
-- settle is asked of DeepSeek once and kept here, so a model's rows on different engines show one name and
-- share one Quality figure. Not an owner's row: a model id says the same thing on every account. Display only;
-- routing never reads it.
CREATE TABLE "model_identity" (
  "rule_key" TEXT NOT NULL,
  "canonical_key" TEXT NOT NULL,
  "name" TEXT,
  "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "model_identity_pkey" PRIMARY KEY ("rule_key")
);
