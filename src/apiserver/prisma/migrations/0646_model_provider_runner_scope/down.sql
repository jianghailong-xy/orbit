-- Reverses 0646, in the opposite order. Not read by Prisma; re-runnable like the forward script.
-- Refuses while a runner-scoped row exists: an older schema has no way to say that row takes no key and runs on
-- one runner only, so it would read as an ordinary key with an empty secret. Delete those rows first, and only
-- where they are no longer wanted. Every other row comes back exactly as it was before 0646.

-- The row check is dynamic SQL: PL/pgSQL parses a static query naming "scope" even when the column test
-- before it is false, so a second run (the columns already gone) would fail instead of doing nothing.
DO $$
DECLARE
  stranded boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'model_provider' AND column_name = 'scope') THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "model_provider" WHERE "scope" <> ''account'' OR "auth_mode" <> ''bearer'')'
      INTO stranded;
  END IF;
  IF stranded THEN
    RAISE EXCEPTION '0646 down: runner-scoped model_provider rows exist; delete them before rolling back';
  END IF;
END $$;

DROP INDEX IF EXISTS "model_provider_runner_id_idx";
ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_runner_scope_chk";
ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_auth_key_chk";
ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_scope_auth_chk";
ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_auth_mode_chk";
ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_scope_chk";
ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_runner_id_fkey";

ALTER TABLE "model_provider" DROP COLUMN IF EXISTS "instance_models";
ALTER TABLE "model_provider" DROP COLUMN IF EXISTS "probed_at";
ALTER TABLE "model_provider" DROP COLUMN IF EXISTS "probe_message";
ALTER TABLE "model_provider" DROP COLUMN IF EXISTS "probe_version";
ALTER TABLE "model_provider" DROP COLUMN IF EXISTS "probe_state";
ALTER TABLE "model_provider" DROP COLUMN IF EXISTS "auth_mode";
ALTER TABLE "model_provider" DROP COLUMN IF EXISTS "runner_id";
ALTER TABLE "model_provider" DROP COLUMN IF EXISTS "scope";
