-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Feishu bot integration (project 34tJs8k23brO8Ie2WtMSk, task F3-1): connecting a group to Orbit.
-- docs/feishu-bot-design.md sections 8.1 and 8.3 are the authority for everything below.
--
-- WHAT IS ADDED
-- -------------
--   feishu_chat_route  one group chat of an app, as the account's owner connected it: the workspace sessions started
--                      in the group open in, the permission mode they run with, who in the group may start them
--                      (allowed_open_ids, empty = everyone in the group), and two limits. Unique on (app_id, chat_id).
--
--   A row is made when the owner sends `@<bot> connect` in the group: it then holds only the one-time ticket the card's
--   button carries (ticket_hash, its SHA-256; ticket_open_id, who sent connect; ticket_expires_at) and confirmed_at is
--   NULL. Confirming on Orbit's page (an owner-channel route) writes the choices, sets confirmed_at and enabled, and
--   clears the ticket, so a ticket works once. ticket_event_id is the event that issued the ticket: the same event
--   processed again issues the same ticket and the same card. The bot removed from the group
--   (im.chat.member.bot.deleted_v1) switches the row off with disabled_reason BOT_REMOVED; the owner switches it off
--   with OWNER.
--
-- WHO WRITES IT. feishu/feishu-chat-route.service.ts alone; src/apiserver/src/common/db-write-inventory.ts names each
-- writer.
--
-- TENANCY
-- -------
-- owner_id references "user" (id) ON DELETE CASCADE; app_id references "feishu_app" (app_id) ON DELETE CASCADE, so
-- removing the app removes its groups; workspace_id references "workspace" (id) ON DELETE CASCADE (workspaces are
-- soft-deleted, so this fires only when a row is really dropped). Every route reads and writes by owner_id.
--
-- LOCKS
-- -----
-- The foreign keys take SHARE ROW EXCLUSIVE on "user", "feishu_app" and "workspace" for the moment the table is made;
-- no row of an existing table is written, read or locked, and no existing table gains a column. No function, trigger or
-- type is created, replaced or dropped.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0496: the project line stood at 0494; 0495 was held by another branch of the project when this was written
-- (2026-11-08). Every statement can run twice: CREATE TABLE / INDEX IF NOT EXISTS with the constraints inside the
-- CREATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "feishu_chat_route" (
  "id"                      UUID NOT NULL,
  "owner_id"                UUID NOT NULL,
  "app_id"                  TEXT NOT NULL,
  "chat_id"                 TEXT NOT NULL,
  "chat_name"               TEXT,
  "workspace_id"            UUID,
  "permission_mode"         TEXT,
  "allowed_open_ids"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "max_concurrent_sessions" INTEGER NOT NULL DEFAULT 2,
  "sessions_per_day"        INTEGER NOT NULL DEFAULT 20,
  "enabled"                 BOOLEAN NOT NULL DEFAULT false,
  "confirmed_at"            TIMESTAMPTZ(3),
  "disabled_reason"         TEXT,
  "ticket_hash"             TEXT,
  "ticket_open_id"          TEXT,
  "ticket_event_id"         TEXT,
  "ticket_expires_at"       TIMESTAMPTZ(3),
  "created_at"              TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feishu_chat_route_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feishu_chat_route_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_chat_route_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "feishu_app" ("app_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_chat_route_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- A confirmed route has what its sessions need.
  CONSTRAINT "feishu_chat_route_confirmed_chk"
    CHECK ("confirmed_at" IS NULL OR ("workspace_id" IS NOT NULL AND "permission_mode" IS NOT NULL)),
  -- Only a confirmed route runs anything.
  CONSTRAINT "feishu_chat_route_enabled_chk" CHECK (NOT "enabled" OR "confirmed_at" IS NOT NULL),
  CONSTRAINT "feishu_chat_route_disabled_reason_chk"
    CHECK ("disabled_reason" IS NULL OR "disabled_reason" IN ('BOT_REMOVED', 'OWNER')),
  CONSTRAINT "feishu_chat_route_limits_chk"
    CHECK ("max_concurrent_sessions" BETWEEN 1 AND 100 AND "sessions_per_day" BETWEEN 1 AND 10000),
  CONSTRAINT "feishu_chat_route_ticket_hash_chk" CHECK ("ticket_hash" IS NULL OR "ticket_hash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_chat_route_app_id_chat_id_key" ON "feishu_chat_route" ("app_id", "chat_id");
-- The confirm page finds the ticket's row by its hash.
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_chat_route_ticket_hash_key" ON "feishu_chat_route" ("ticket_hash");
-- Settings lists the account's routes.
CREATE INDEX IF NOT EXISTS "feishu_chat_route_owner_id_idx" ON "feishu_chat_route" ("owner_id");
CREATE INDEX IF NOT EXISTS "feishu_chat_route_workspace_id_idx" ON "feishu_chat_route" ("workspace_id");
