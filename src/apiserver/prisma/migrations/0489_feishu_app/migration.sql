-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Feishu bot integration (project 34tJs8k23brO8Ie2WtMSk, task F0-1): each account's own Feishu (Lark)
-- self-built app, and the administrators' switch for them. docs/feishu-bot-design.md section 4.1 is the
-- authority for everything below.
--
-- WHAT IS ADDED
-- -------------
--   feishu_app                 at most one row per account (owner_id unique): the platform (FEISHU or LARK),
--                              the App ID, unique across the deployment because an app's long connection has
--                              one consumer (design section 3.2), and the App Secret encrypted as a model
--                              provider's API key is (providers/provider-crypto.ts); the app's own switch, what
--                              an alert card carries (message_detail, TITLES_ONLY by default), whether approvals
--                              can be answered on cards, the workspace a direct-message session opens in; the
--                              owner's open_id and name once bound (section 5); and the connection's status:
--                              the bot's name, when it last connected and last received an event, and the last
--                              failure as Feishu worded it, never a credential.
--   feishu_deployment_setting  at most one row (id = 1): whether accounts may connect Feishu bots at all. No
--                              row is the same as a row that allows it, so a deployment that never switched it
--                              reads as on, the default the design gives.
--
-- WHO WRITES THEM. feishu/feishu-app.service.ts: the account's PUT, PATCH and DELETE /api/integrations/feishu,
-- an administrator's DELETE /api/admin/users/:id/feishu, and PUT /api/admin/integrations/feishu for the switch.
-- src/apiserver/src/common/db-write-inventory.ts names each writer. A PUT writes only after Feishu traded the
-- credentials for a tenant_access_token, and nothing it was given is kept in the clear.
--
-- TENANCY
-- -------
-- owner_id references "user" ON DELETE CASCADE: an account's deletion takes its app. default_workspace_id
-- references "workspace" ON DELETE SET NULL, so a deleted workspace leaves no dangling choice; nothing writes it
-- yet, and the service that will checks that the workspace is the owner's own.
--
-- LOCKS
-- -----
-- The two foreign keys take "user"'s and "workspace"'s SHARE ROW EXCLUSIVE locks for the moment the table is
-- made; no row of an existing table is written, read or locked, and no existing table gains a column. No
-- function, trigger or type is created, replaced or dropped.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0489: main stood at 0487 (0481 and 0486 are held by other branches) and 0488 was held by an uncommitted
-- migration in another session's worktree (0488_session_last_user_from_orbit) when this was written
-- (2026-11-07). Every statement can run twice: CREATE TABLE / INDEX IF NOT EXISTS with the constraints inside
-- the CREATE, and the one-row CHECK inside a `duplicate_object` guard.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "feishu_app" (
  "id"                   UUID NOT NULL,
  "owner_id"             UUID NOT NULL,
  -- FEISHU (open.feishu.cn) or LARK (open.larksuite.com): which open platform the app lives on.
  "platform"             TEXT NOT NULL,
  -- The App ID (cli_…).
  "app_id"               TEXT NOT NULL,
  -- AES-256-GCM ciphertext of the App Secret, "iv:tag:ct" with each part base64.
  "app_secret_enc"       TEXT NOT NULL,
  "enabled"              BOOLEAN NOT NULL DEFAULT true,
  "message_detail"       TEXT NOT NULL DEFAULT 'TITLES_ONLY',
  "approvals_in_feishu"  BOOLEAN NOT NULL DEFAULT true,
  "default_workspace_id" UUID,
  "owner_open_id"        TEXT,
  "owner_name"           TEXT,
  "bot_name"             TEXT,
  "last_connected_at"    TIMESTAMPTZ(3),
  "last_event_at"        TIMESTAMPTZ(3),
  "last_error"           TEXT,
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feishu_app_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feishu_app_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_app_default_workspace_id_fkey"
    FOREIGN KEY ("default_workspace_id") REFERENCES "workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "feishu_app_platform_chk" CHECK ("platform" IN ('FEISHU', 'LARK')),
  CONSTRAINT "feishu_app_message_detail_chk" CHECK ("message_detail" IN ('TITLES_ONLY', 'FULL')),
  CONSTRAINT "feishu_app_app_id_chk" CHECK (btrim("app_id") <> '' AND char_length("app_id") <= 128),
  CONSTRAINT "feishu_app_app_secret_enc_chk" CHECK ("app_secret_enc" <> '')
);
-- One app per account (v1), and an app on one account only (section 3.2).
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_app_owner_id_key" ON "feishu_app" ("owner_id");
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_app_app_id_key" ON "feishu_app" ("app_id");

CREATE TABLE IF NOT EXISTS "feishu_deployment_setting" (
  "id"            SMALLINT NOT NULL DEFAULT 1,
  "allowed"       BOOLEAN NOT NULL,
  "updated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The administrator who switched it. An id rather than a foreign key, so deleting that account writes
  -- nothing here.
  "updated_by_id" UUID,
  CONSTRAINT "feishu_deployment_setting_pkey" PRIMARY KEY ("id")
);

-- One row: the deployment has one switch.
DO $$ BEGIN
  ALTER TABLE "feishu_deployment_setting" ADD CONSTRAINT "feishu_deployment_setting_one_row_chk" CHECK ("id" = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
