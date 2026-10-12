-- 0391 — signing in with Google: the flow in flight and the identity it signs in
-- (docs/google-sign-in-design.md §4, §5.1).
--
-- `oauth_login_flow`: one row per sign-in started at GET /api/auth/google/start, from the start to
-- the exchange of its ticket. It is PENDING for at most ten minutes, until the callback has verified
-- Google's answer, then AUTHENTICATED with the verified claims and a ticket for two more. It ends
-- deleted: by the exchange, which takes it with one DELETE … RETURNING (§4.3); by a callback that
-- refused it; or by the sweep every start makes of the rows past `expires_at`. Of the secrets the flow
-- hands out it keeps only their sha256: `state_hash` (the `state` sent to Google), `binding_hash`
-- (the `orbit_oauth_flow` cookie that ties the flow to the browser that started it) and
-- `ticket_hash` (the one-time ticket the callback hands the client). `nonce` and
-- `provider_code_verifier` are kept as they are, because they are used as they are: the nonce is
-- compared with the ID token's, and the verifier is Google's side of PKCE, sent with the code.
-- `client_challenge` is the client's side: the S256 challenge its verifier must answer at the
-- exchange. No Google token is ever stored.
--
-- `user_identity`: the Google account an Orbit account signs in with, by Google's `sub` — stable and
-- never reused, unlike the email, which is kept only to show. One per (provider, subject), and in v1
-- one per (user, provider). It goes with its user, as a LINK flow goes with the user it would link.
--
-- 0391: the project coordinator's number (2026-10-06). main holds 0387_antigravity_account and
-- 0388_pat_device_login, an unlanded branch holds 0389, and sign_in_provider moved from 0387 to 0390
-- beside this. Every statement can run twice: IF NOT EXISTS, and constraints inside a
-- `duplicate_object` guard. Nothing existing is altered and no row is written.

CREATE TABLE IF NOT EXISTS "user_identity" (
  "id"              UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "provider"        TEXT NOT NULL,
  "subject"         TEXT NOT NULL,
  "email"           TEXT NOT NULL,
  "hosted_domain"   TEXT,
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_sign_in_at" TIMESTAMPTZ(3),
  CONSTRAINT "user_identity_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "user_identity"
    ADD CONSTRAINT "user_identity_provider_chk"
    CHECK ("provider" IN ('google'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An empty subject would be one identity that every token without a `sub` matches.
DO $$ BEGIN
  ALTER TABLE "user_identity"
    ADD CONSTRAINT "user_identity_subject_chk"
    CHECK ("subject" <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An identity belongs to one user and goes with them.
DO $$ BEGIN
  ALTER TABLE "user_identity"
    ADD CONSTRAINT "user_identity_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Sign-in: (provider, sub) → the one Orbit account.
CREATE UNIQUE INDEX IF NOT EXISTS "user_identity_provider_subject_key"
  ON "user_identity" ("provider", "subject");

-- v1: one Google account per Orbit account. It also serves the user delete's cascade.
CREATE UNIQUE INDEX IF NOT EXISTS "user_identity_user_id_provider_key"
  ON "user_identity" ("user_id", "provider");

CREATE TABLE IF NOT EXISTS "oauth_login_flow" (
  "id"                     UUID NOT NULL,
  "provider"               TEXT NOT NULL,
  "intent"                 TEXT NOT NULL,
  "client"                 TEXT NOT NULL,
  "state_hash"             TEXT NOT NULL,
  "binding_hash"           TEXT NOT NULL,
  "nonce"                  TEXT NOT NULL,
  "provider_code_verifier" TEXT NOT NULL,
  "client_challenge"       TEXT NOT NULL,
  "client_state"           TEXT,
  "link_user_id"           UUID,
  "status"                 TEXT NOT NULL DEFAULT 'PENDING',
  "claims"                 JSONB,
  "ticket_hash"            TEXT,
  "ticket_expires_at"      TIMESTAMPTZ(3),
  "expires_at"             TIMESTAMPTZ(3) NOT NULL,
  "created_at"             TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "oauth_login_flow_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "oauth_login_flow"
    ADD CONSTRAINT "oauth_login_flow_provider_chk"
    CHECK ("provider" IN ('google'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "oauth_login_flow"
    ADD CONSTRAINT "oauth_login_flow_client_chk"
    CHECK ("client" IN ('WEB', 'NATIVE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A LINK flow names the signed-in user it links to (§5.3), and a LOGIN flow names nobody. Spelled so
-- that no operand can be NULL, as 0383 spells personal_access_token's: a CHECK passes when its
-- expression is NULL.
DO $$ BEGIN
  ALTER TABLE "oauth_login_flow"
    ADD CONSTRAINT "oauth_login_flow_intent_chk"
    CHECK ("intent" IN ('LOGIN', 'LINK')
       AND ("intent" = 'LINK') = ("link_user_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AUTHENTICATED, and only AUTHENTICATED, has the verified claims and a ticket with its expiry.
DO $$ BEGIN
  ALTER TABLE "oauth_login_flow"
    ADD CONSTRAINT "oauth_login_flow_status_chk"
    CHECK ("status" IN ('PENDING', 'AUTHENTICATED')
       AND ("status" = 'AUTHENTICATED') = ("claims" IS NOT NULL)
       AND ("status" = 'AUTHENTICATED') = ("ticket_hash" IS NOT NULL)
       AND ("ticket_hash" IS NULL) = ("ticket_expires_at" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The user a LINK flow would link goes, and the flow with them.
DO $$ BEGIN
  ALTER TABLE "oauth_login_flow"
    ADD CONSTRAINT "oauth_login_flow_link_user_id_fkey"
    FOREIGN KEY ("link_user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The callback: state → flow.
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_login_flow_state_hash_key"
  ON "oauth_login_flow" ("state_hash");

-- The exchange: ticket → flow.
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_login_flow_ticket_hash_key"
  ON "oauth_login_flow" ("ticket_hash");

-- The sweep each start makes of the rows past their end.
CREATE INDEX IF NOT EXISTS "oauth_login_flow_expires_at_idx"
  ON "oauth_login_flow" ("expires_at");

-- The user delete's cascade.
CREATE INDEX IF NOT EXISTS "oauth_login_flow_link_user_id_idx"
  ON "oauth_login_flow" ("link_user_id");
