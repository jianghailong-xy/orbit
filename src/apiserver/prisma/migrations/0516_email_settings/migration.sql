-- 0516 — outgoing email settings, in one row (docs/welcome-email-design.md §3.1, decision D2).
--
-- What an administrator saves on Admin → Email: whether this deployment sends email, the Resend API
-- key it sends with, the From and Reply-To addresses, and whether new accounts get a welcome email.
-- Kept in the database rather than in environment variables, so saving takes effect without a
-- restart: the outbox worker reads the row on every pass.
--
-- `resend_api_key_enc` is the key encrypted as a model provider's API key is
-- (providers/provider-crypto.ts `encryptSecret`, a key derived from PROVIDER_SECRET_KEY); the key
-- itself is never stored, and no response carries it in either form. The empty string, in it and in
-- `from_address`, is "none saved"; an empty `reply_to` means the earliest administrator's address.
-- `welcome_enabled` defaults to true: it only takes effect while `enabled` is on and the key and From
-- are saved. No row is the same as a row that is off.
--
-- `updated_by_id` is the administrator who saved last: an id without a foreign key, so deleting that
-- account writes nothing here.
--
-- 0516: written as 0514, and renumbered before landing because the pushed task branch
-- orbit/task-p1-2ded6e took 0514 (0514_wiki_maintenance_run_repo_tier) and 0515 was kept clear of it;
-- 0516 and 0517 were free on main, on every branch of origin and in every worktree on this host
-- (2026-11-11). No database applied it as 0514: the branch was never deployed. Every statement can run
-- twice — IF NOT EXISTS, and the CHECK inside a `duplicate_object` guard. Nothing that exists is altered and no row is written.

CREATE TABLE IF NOT EXISTS "email_settings" (
  "id"                 SMALLINT NOT NULL DEFAULT 1,
  "enabled"            BOOLEAN NOT NULL DEFAULT false,
  "resend_api_key_enc" TEXT NOT NULL DEFAULT '',
  "from_address"       TEXT NOT NULL DEFAULT '',
  "reply_to"           TEXT NOT NULL DEFAULT '',
  "welcome_enabled"    BOOLEAN NOT NULL DEFAULT true,
  "updated_by_id"      UUID,
  "updated_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_settings_pkey" PRIMARY KEY ("id")
);

-- One row: the deployment has one outgoing email setting.
DO $$ BEGIN
  ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_one_row_chk" CHECK ("id" = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
