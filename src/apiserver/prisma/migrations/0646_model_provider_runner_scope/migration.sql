-- 0646 — a runner-scoped provider (docs/ollama-local-provider-contract.md): a model server on one runner's own
-- machine, Ollama first, kept as an ordinary model_provider row on an engine Orbit already runs.
--
--   * `scope` — 'account' (every row so far: dispatched wherever its owner's sessions run) or 'runner' (only on
--     `runner_id`).
--   * `runner_id` — the runner a runner-scoped row runs on. ON DELETE SET NULL: removing the runner leaves the row
--     and its model list for the owner to bind again, and a row with no runner dispatches nowhere.
--   * `auth_mode` — 'bearer' (the stored key) or 'none' (the server takes no key; none is stored).
--   * `probe_state`, `probe_version`, `probe_message`, `probed_at` — what the bound runner's last probe of the
--     instance found (written by the runner, phase 2). NULL until then: unknown, never healthy.
--   * `instance_models` — the instance's own model catalogue as that runner discovered it; NULL until reported.
--
-- The three facts travel together, and the constraints hold them so:
--   * `model_provider_scope_chk`, `model_provider_auth_mode_chk` — the two vocabularies.
--   * `model_provider_scope_auth_chk` — scope 'runner' exactly when auth_mode 'none'. The no-key mode exists for
--     the local server and for nothing else.
--   * `model_provider_auth_key_chk` — auth_mode 'none' holds the empty string in `api_key_enc`, and 'bearer' a key.
--     The empty string, not NULL: an older API replica reads the column as a non-null string, and on dispatch
--     fails to decrypt '' and refuses the session — which is the fail-closed answer an older replica, unaware of
--     scope, must give for a runner-scoped row. Added NOT VALID: it holds every row written from now on and
--     reads no existing one, so no existing row can stop this migration.
--   * `model_provider_runner_scope_chk` — only a runner-scoped row names a runner, and only a personal one is
--     runner-scoped (a shared, admin-owned row has no runner of its own to be bound to).
--
-- Every existing row becomes scope 'account', auth_mode 'bearer', with no runner and no probe: exactly what it was.
-- No row is written or changed beyond the column defaults. down.sql reverses it, refusing while any runner-scoped
-- row exists. Every statement can run twice.

ALTER TABLE "model_provider" ADD COLUMN IF NOT EXISTS "scope" TEXT NOT NULL DEFAULT 'account';
ALTER TABLE "model_provider" ADD COLUMN IF NOT EXISTS "runner_id" UUID;
ALTER TABLE "model_provider" ADD COLUMN IF NOT EXISTS "auth_mode" TEXT NOT NULL DEFAULT 'bearer';
ALTER TABLE "model_provider" ADD COLUMN IF NOT EXISTS "probe_state" TEXT;
ALTER TABLE "model_provider" ADD COLUMN IF NOT EXISTS "probe_version" TEXT;
ALTER TABLE "model_provider" ADD COLUMN IF NOT EXISTS "probe_message" TEXT;
ALTER TABLE "model_provider" ADD COLUMN IF NOT EXISTS "probed_at" TIMESTAMPTZ(3);
ALTER TABLE "model_provider" ADD COLUMN IF NOT EXISTS "instance_models" JSONB;

ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_runner_id_fkey";
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_runner_id_fkey"
  FOREIGN KEY ("runner_id") REFERENCES "runner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_scope_chk";
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_scope_chk" CHECK ("scope" IN ('account', 'runner'));

ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_auth_mode_chk";
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_auth_mode_chk" CHECK ("auth_mode" IN ('bearer', 'none'));

ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_scope_auth_chk";
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_scope_auth_chk"
  CHECK (("scope" = 'runner') = ("auth_mode" = 'none'));

ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_auth_key_chk";
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_auth_key_chk"
  CHECK (("auth_mode" = 'none') = ("api_key_enc" = '')) NOT VALID;

ALTER TABLE "model_provider" DROP CONSTRAINT IF EXISTS "model_provider_runner_scope_chk";
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_runner_scope_chk"
  CHECK (("scope" = 'runner' AND "owner_id" IS NOT NULL) OR ("scope" = 'account' AND "runner_id" IS NULL));

CREATE INDEX IF NOT EXISTS "model_provider_runner_id_idx" ON "model_provider" ("runner_id");
