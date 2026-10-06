-- 0387 — sign-in providers (docs/google-sign-in-design.md §7.1).
--
-- What an administrator saves in the admin area's Sign-in settings, one row per provider; only
-- `google` exists. The configuration is kept here rather than in environment variables, so a
-- deployment turns Google sign-in on without editing its compose file or restarting.
--
-- `client_secret_enc` is the OAuth client secret encrypted as a model provider's API key is
-- (providers/provider-crypto.ts `encryptSecret`, a key derived from PROVIDER_SECRET_KEY); the
-- secret itself is never stored, and no response carries it in either form. The empty string, in
-- it and in `client_id`, is "none saved". Google sign-in is on only when `enabled` is true and both
-- are present; otherwise every Google route refuses, as when there is no row at all.
--
-- `signup_policy` defaults to EXISTING_ACCOUNTS: only an account that already exists may sign in
-- with Google. OPEN, which lets a Google account create one, is only ever an administrator's save.
-- `updated_by_id` is the administrator who saved last: an id without a foreign key, so deleting
-- that user writes nothing here.
--
-- 0387: the next number on main when this was written (2026-10-06), whose highest was
-- 0386_project_handoff_move_request, and spelled by no branch of origin. Every statement can run
-- twice: IF NOT EXISTS, and constraints inside a `duplicate_object` guard. Nothing existing is
-- altered and no row is written.

CREATE TABLE IF NOT EXISTS "sign_in_provider" (
  "provider"          TEXT NOT NULL,
  "enabled"           BOOLEAN NOT NULL DEFAULT false,
  "client_id"         TEXT NOT NULL,
  "client_secret_enc" TEXT NOT NULL,
  "signup_policy"     TEXT NOT NULL DEFAULT 'EXISTING_ACCOUNTS',
  "updated_by_id"     UUID,
  "updated_at"        TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "sign_in_provider_pkey" PRIMARY KEY ("provider")
);

DO $$ BEGIN
  ALTER TABLE "sign_in_provider"
    ADD CONSTRAINT "sign_in_provider_provider_chk"
    CHECK ("provider" IN ('google'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "sign_in_provider"
    ADD CONSTRAINT "sign_in_provider_signup_policy_chk"
    CHECK ("signup_policy" IN ('EXISTING_ACCOUNTS', 'OPEN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
