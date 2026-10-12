-- 0383 — personal access tokens (docs/personal-access-token-design.md §3).
--
-- A credential a user issues to act as themselves from a script or the `orbit` CLI. The token is
-- `orbit_pat_` and 43 base64url characters (256 random bits) and is never stored: `token_hash` is
-- its sha256, and `token_hint` its last four characters so a list can tell tokens apart.
-- JwtAuthGuard resolves `Authorization: Bearer orbit_pat_…` through this table on every request,
-- so a token that is revoked or past `expires_at` stops working at once. `expires_at` NULL is a
-- token that never expires (§11.1).
--
-- `workspace_ids` empty means the token is not confined to any workspace (§6.3). It is NOT NULL
-- rather than "NULL = not confined" because Prisma types a scalar list as never null, and a
-- nullable list column would let a raw-SQL writer store a value that type says cannot exist
-- (agent-schema.spec.ts, 02A.4). The same holds for `scopes`.
--
-- 0383: the highest number on main and on every branch of origin was 0382 when this was written
-- (2026-10-06). Every statement can run twice: IF NOT EXISTS, and constraints inside a
-- `duplicate_object` guard. Nothing existing is altered and no row is written.

CREATE TABLE IF NOT EXISTS "personal_access_token" (
  "id"                   UUID NOT NULL,
  "owner_id"             UUID NOT NULL,
  "name"                 TEXT NOT NULL,
  "token_hash"           TEXT NOT NULL,
  "token_hint"           TEXT NOT NULL,
  "scopes"               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "workspace_ids"        UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "expires_at"           TIMESTAMPTZ(3),
  "created_via"          TEXT NOT NULL,
  "last_used_at"         TIMESTAMPTZ(3),
  "last_used_ip"         TEXT,
  "last_used_user_agent" TEXT,
  "revoked_at"           TIMESTAMPTZ(3),
  "revoked_reason"       TEXT,
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "personal_access_token_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "personal_access_token"
    ADD CONSTRAINT "personal_access_token_created_via_chk"
    CHECK ("created_via" IN ('WEB', 'CLI_DEVICE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A revoked token says why, and only a revoked token does. Spelled so that no operand can be NULL,
-- as 0306 spells share_link's: a CHECK passes when its expression is NULL.
DO $$ BEGIN
  ALTER TABLE "personal_access_token"
    ADD CONSTRAINT "personal_access_token_revoked_chk"
    CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL)
       AND ("revoked_reason" IS NULL
            OR "revoked_reason" IN ('USER', 'EXPIRED', 'PASSWORD_CHANGED', 'USER_DELETED', 'ADMIN')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A token belongs to one user and goes with them.
DO $$ BEGIN
  ALTER TABLE "personal_access_token"
    ADD CONSTRAINT "personal_access_token_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The guard's only read: token → row, live or revoked.
CREATE UNIQUE INDEX IF NOT EXISTS "personal_access_token_token_hash_key"
  ON "personal_access_token" ("token_hash");

-- A name is unique among one user's tokens that are not revoked, so revoking a token frees its name.
-- Partial, so it lives here: schema.prisma cannot express a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS "personal_access_token_owner_id_name_active_key"
  ON "personal_access_token" ("owner_id", "name") WHERE "revoked_at" IS NULL;

-- A user's list, and the user delete's cascade.
CREATE INDEX IF NOT EXISTS "personal_access_token_owner_id_idx"
  ON "personal_access_token" ("owner_id");
