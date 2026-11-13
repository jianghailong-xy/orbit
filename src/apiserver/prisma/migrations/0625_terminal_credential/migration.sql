-- 0625 — the TERMINAL credential (docs/terminal-session-design.md, "The terminal credential").
--
--   terminal_login       one row per sign-in a terminal asks for: started with the machine's runner credential, so
--                        bound to that runner and its owner from the start; PENDING until the owner approves or denies
--                        it in the app, DELIVERED once the CLI's poll collected the credential. `device_code_hash` is the
--                        sha256 of the CLI's secret; `user_code` the short code the terminal and the card both show.
--                        No credential is ever kept here.
--   terminal_credential  one row per credential an approval minted: its sha256 only, the account and runner it is
--                        bound to, the machine's name, and its end, 30 days after the approval. Revoked rows stay.
--
-- Both go with their user and with their runner. 0625: main's highest is 0610 (2026-11-13); the ledger allows holes,
-- never a number twice. Every statement can run twice. Nothing existing is altered and no row is written.

CREATE TABLE IF NOT EXISTS "terminal_login" (
  "id"               UUID NOT NULL,
  "device_code_hash" TEXT NOT NULL,
  "user_code"        TEXT NOT NULL,
  "owner_id"         UUID NOT NULL,
  "runner_id"        UUID NOT NULL,
  "machine_name"     TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'PENDING',
  "decided_at"       TIMESTAMPTZ(3),
  "expires_at"       TIMESTAMPTZ(3) NOT NULL,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "terminal_login_pkey" PRIMARY KEY ("id")
);

-- Decided says when, and only a decided request does.
DO $$ BEGIN
  ALTER TABLE "terminal_login"
    ADD CONSTRAINT "terminal_login_status_chk"
    CHECK ("status" IN ('PENDING', 'APPROVED', 'DENIED', 'DELIVERED')
       AND ("status" = 'PENDING') = ("decided_at" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "terminal_login"
    ADD CONSTRAINT "terminal_login_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "terminal_login"
    ADD CONSTRAINT "terminal_login_runner_id_fkey"
    FOREIGN KEY ("runner_id") REFERENCES "runner" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The CLI's poll: device code → row. The card's read: the owner's pending requests.
CREATE UNIQUE INDEX IF NOT EXISTS "terminal_login_device_code_hash_key" ON "terminal_login" ("device_code_hash");
CREATE INDEX IF NOT EXISTS "terminal_login_owner_id_status_idx" ON "terminal_login" ("owner_id", "status");
CREATE INDEX IF NOT EXISTS "terminal_login_runner_id_idx" ON "terminal_login" ("runner_id");

CREATE TABLE IF NOT EXISTS "terminal_credential" (
  "id"           UUID NOT NULL,
  "token_hash"   TEXT NOT NULL,
  "owner_id"     UUID NOT NULL,
  "runner_id"    UUID NOT NULL,
  "machine_name" TEXT NOT NULL,
  "approved_at"  TIMESTAMPTZ(3) NOT NULL,
  "expires_at"   TIMESTAMPTZ(3) NOT NULL,
  "last_used_at" TIMESTAMPTZ(3),
  "revoked_at"   TIMESTAMPTZ(3),
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "terminal_credential_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "terminal_credential"
    ADD CONSTRAINT "terminal_credential_expires_at_chk" CHECK ("expires_at" > "approved_at");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "terminal_credential"
    ADD CONSTRAINT "terminal_credential_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "terminal_credential"
    ADD CONSTRAINT "terminal_credential_runner_id_fkey"
    FOREIGN KEY ("runner_id") REFERENCES "runner" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "terminal_credential_token_hash_key" ON "terminal_credential" ("token_hash");
CREATE INDEX IF NOT EXISTS "terminal_credential_owner_id_idx" ON "terminal_credential" ("owner_id");
CREATE INDEX IF NOT EXISTS "terminal_credential_runner_id_idx" ON "terminal_credential" ("runner_id");
