-- 0762 — GitHub-backed workspaces, P0: the deployment's GitHub App, each account's connection to it,
-- and the workspace columns a clone will fill (docs/github-workspace-design.md §4).
--
-- `github_app_config`: one row (`id` = 'github'), saved by an administrator in Admin → Integrations.
-- `client_secret_enc` and `private_key_enc` are encrypted as a model provider's API key is
-- (providers/provider-crypto.ts `encryptSecret`); the empty string is "none saved", and no response
-- carries either in any form. `slug` is what GitHub's GET /app answered when the row was saved.
--
-- `github_connection`: the GitHub account an Orbit account connected, at most one each way — one per
-- owner, and one Orbit account per GitHub account. Both tokens are encrypted as above. A connection made
-- while the App's user tokens do not expire keeps an empty refresh token.
--
-- `github_oauth_flow`: a connection in flight, from GET /integrations/github/start to its callback. One
-- use and ten minutes: the callback takes the row by its state's hash with one DELETE … RETURNING. Of
-- the secrets it hands out it keeps only sha256 (`state_hash`, and `binding_hash` for the cookie that
-- ties it to the browser that started it); `code_verifier` is kept as it is, because it is sent to
-- GitHub with the code.
--
-- `workspace`: seven nullable columns, all NULL for a workspace that does not come from GitHub. Nothing
-- writes them yet (P1 does); `clone_state` is held to its four states by a CHECK.
--
-- Every statement can run twice: IF NOT EXISTS, and constraints inside a `duplicate_object` guard. No
-- existing row is written.

CREATE TABLE IF NOT EXISTS "github_app_config" (
  "id"                TEXT NOT NULL DEFAULT 'github',
  "enabled"           BOOLEAN NOT NULL DEFAULT false,
  "app_id"            BIGINT NOT NULL,
  "slug"              TEXT NOT NULL,
  "client_id"         TEXT NOT NULL,
  "client_secret_enc" TEXT NOT NULL,
  "private_key_enc"   TEXT NOT NULL,
  "updated_by_id"     UUID,
  "updated_at"        TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "github_app_config_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "github_app_config" ADD CONSTRAINT "github_app_config_id_chk" CHECK ("id" = 'github');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "github_connection" (
  "id"                 UUID NOT NULL,
  "owner_id"           UUID NOT NULL,
  "github_user_id"     BIGINT NOT NULL,
  "login"              TEXT NOT NULL,
  "access_token_enc"   TEXT NOT NULL,
  "refresh_token_enc"  TEXT NOT NULL,
  "access_expires_at"  TIMESTAMPTZ(3) NOT NULL,
  "refresh_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "github_connection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "github_connection_owner_id_key" ON "github_connection" ("owner_id");
CREATE UNIQUE INDEX IF NOT EXISTS "github_connection_github_user_id_key" ON "github_connection" ("github_user_id");

DO $$ BEGIN
  ALTER TABLE "github_connection"
    ADD CONSTRAINT "github_connection_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "github_oauth_flow" (
  "id"            UUID NOT NULL,
  "owner_id"      UUID NOT NULL,
  "state_hash"    TEXT NOT NULL,
  "binding_hash"  TEXT NOT NULL,
  "code_verifier" TEXT NOT NULL,
  "return_path"   TEXT NOT NULL,
  "expires_at"    TIMESTAMPTZ(3) NOT NULL,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "github_oauth_flow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "github_oauth_flow_state_hash_key" ON "github_oauth_flow" ("state_hash");
CREATE INDEX IF NOT EXISTS "github_oauth_flow_expires_at_idx" ON "github_oauth_flow" ("expires_at");
CREATE INDEX IF NOT EXISTS "github_oauth_flow_owner_id_idx" ON "github_oauth_flow" ("owner_id");

DO $$ BEGIN
  ALTER TABLE "github_oauth_flow"
    ADD CONSTRAINT "github_oauth_flow_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "github_repo_id" BIGINT;
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "github_installation_id" BIGINT;
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "clone_ref" TEXT;
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "clone_state" TEXT;
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "clone_error" TEXT;
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "clone_started_at" TIMESTAMPTZ(3);
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "clone_finished_at" TIMESTAMPTZ(3);

DO $$ BEGIN
  ALTER TABLE "workspace"
    ADD CONSTRAINT "workspace_clone_state_chk"
    CHECK ("clone_state" IS NULL OR "clone_state" IN ('PENDING', 'CLONING', 'READY', 'FAILED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
