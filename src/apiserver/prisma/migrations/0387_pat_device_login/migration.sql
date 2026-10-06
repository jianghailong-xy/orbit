-- 0387 — `orbit login` through the browser (docs/personal-access-token-design.md §7.3).
--
-- One row per `orbit login` the CLI starts: what it asks for — the token's name, scopes and
-- lifetime, and the host it runs on — until a person signed in to Orbit approves or denies it at
-- /cli-login?code=… and the CLI, polling with its device code, collects the token. The shape is the
-- runner's device flow (device_enrollment), with one difference that is the reason for a table of
-- its own: no token is ever kept here. Approving records who approved; the token is issued to them
-- when the CLI next polls, in that answer and nowhere else, so `personal_access_token` keeps holding
-- the only trace of it — its sha256 (§3). `device_code_hash` is the sha256 of the CLI's secret,
-- `user_code` the short code the browser and the terminal both show.
--
-- `status`: PENDING until decided; APPROVED once approved; DENIED once denied; DELIVERED once a poll
-- has collected the token. `expires_in_days` NULL is a token that never expires (§11.1).
-- `decided_by_id` is the user who approved or denied it — the token's owner — and goes with them.
--
-- 0387: main's highest is 0385, and 0386 is held by another branch in flight (2026-10-06); the
-- ledger allows holes, never a number twice. Every statement can run twice: IF NOT EXISTS, and
-- constraints inside a `duplicate_object` guard. Nothing existing is altered and no row is written.

CREATE TABLE IF NOT EXISTS "pat_device_login" (
  "id"               UUID NOT NULL,
  "device_code_hash" TEXT NOT NULL,
  "user_code"        TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "scopes"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expires_in_days"  INTEGER,
  "hostname"         TEXT,
  "status"           TEXT NOT NULL DEFAULT 'PENDING',
  "decided_by_id"    UUID,
  "decided_at"       TIMESTAMPTZ(3),
  "expires_at"       TIMESTAMPTZ(3) NOT NULL,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pat_device_login_pkey" PRIMARY KEY ("id")
);

-- Decided says by whom and when, and only a decided request does. Spelled so that no operand can be
-- NULL, as 0383 spells personal_access_token's: a CHECK passes when its expression is NULL.
DO $$ BEGIN
  ALTER TABLE "pat_device_login"
    ADD CONSTRAINT "pat_device_login_status_chk"
    CHECK ("status" IN ('PENDING', 'APPROVED', 'DENIED', 'DELIVERED')
       AND ("status" = 'PENDING') = ("decided_by_id" IS NULL)
       AND ("decided_by_id" IS NULL) = ("decided_at" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The lifetimes a token is issued with (§6.5, §11.1); NULL is the fourth, never.
DO $$ BEGIN
  ALTER TABLE "pat_device_login"
    ADD CONSTRAINT "pat_device_login_expires_in_days_chk"
    CHECK ("expires_in_days" IS NULL OR "expires_in_days" IN (30, 90, 365));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The user who decided goes, and their requests with them.
DO $$ BEGIN
  ALTER TABLE "pat_device_login"
    ADD CONSTRAINT "pat_device_login_decided_by_id_fkey"
    FOREIGN KEY ("decided_by_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The CLI's poll: device code → row.
CREATE UNIQUE INDEX IF NOT EXISTS "pat_device_login_device_code_hash_key"
  ON "pat_device_login" ("device_code_hash");

-- The browser's lookup: user code → row.
CREATE UNIQUE INDEX IF NOT EXISTS "pat_device_login_user_code_key"
  ON "pat_device_login" ("user_code");

-- The user delete's cascade.
CREATE INDEX IF NOT EXISTS "pat_device_login_decided_by_id_idx"
  ON "pat_device_login" ("decided_by_id");
