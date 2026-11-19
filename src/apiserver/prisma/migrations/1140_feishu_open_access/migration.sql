-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Feishu bot integration (project 34tJs8k23brO8Ie2WtMSk, task O1): the bot opened to the people the app is available
-- to in Feishu ("Who can use the bot"). docs/feishu-bot-design.md section 14 is the authority for everything below.
--
-- WHAT CHANGES
-- ------------
--   feishu_app gains who can use the bot, and the settings of the sessions other people start:
--     access_mode                        OWNER_ONLY (the default: what every app did before) | AVAILABILITY_SCOPE;
--     open_workspace_id                  where those sessions open; ON DELETE SET NULL;
--     open_permission_mode               the PermissionMode they run in, 'auto' by default;
--     open_max_running_per_person        1   } the four limits (section 14.4): sessions one person has PENDING or
--     open_sessions_per_day_per_person   10  } RUNNING at a time, and started since midnight UTC; and the same
--     open_max_running_total             3   } for everyone together.
--     open_sessions_per_day_total        50  }
--
--   feishu_chat_route gains where the row came from and who used the group first:
--     source                             CONNECT (the owner's `@<bot> connect`, every row before) | OPEN_ACCESS (an
--                                        implicit route: an unconnected internal group someone mentioned the bot in
--                                        while the app was open; it uses the app's settings above);
--     first_used_by_open_id / _name      who that was, and the name Feishu gave;
--     first_used_at                      and when.
--   Its enabled CHECK is widened: an OPEN_ACCESS row is switched on without being confirmed.
--
--   feishu_thread gains open_access_open_id: the non-owner whose request, under AVAILABILITY_SCOPE, opened this chain's
--   session (a direct message, or a mention in an implicit route's group). NULL for every other chain. The four limits
--   count these rows (section 14.4), the reservation written before the session is.
--
-- WHO WRITES IT. feishu/feishu-app.service.ts (the access settings), feishu/feishu-chat-route.service.ts (the route
-- columns), feishu/feishu-open-limits.ts (open_access_open_id); src/apiserver/src/common/db-write-inventory.ts names
-- each writer.
--
-- LOCKS
-- -----
-- Each ADD COLUMN has no default or a constant one: catalog-only, ACCESS EXCLUSIVE for that instant, no rewrite. The
-- CHECKs are added NOT VALID and then validated (SHARE UPDATE EXCLUSIVE, a scan of a small table that writes nothing).
-- The open_workspace_id foreign key takes SHARE ROW EXCLUSIVE on "workspace" for a moment and is validated the same
-- way. No function, trigger or type is created, replaced or dropped; no row is written.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1140: the highest on main, every project line and every orbit/* branch was 1120 when this was written
-- (2026-11-18); claimed in task O1's comments. Every statement can run twice: ADD COLUMN IF NOT EXISTS, CREATE INDEX
-- IF NOT EXISTS, and DROP CONSTRAINT IF EXISTS before each ADD CONSTRAINT.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "feishu_app" ADD COLUMN IF NOT EXISTS "access_mode" TEXT NOT NULL DEFAULT 'OWNER_ONLY';
ALTER TABLE "feishu_app" ADD COLUMN IF NOT EXISTS "open_workspace_id" UUID;
ALTER TABLE "feishu_app" ADD COLUMN IF NOT EXISTS "open_permission_mode" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "feishu_app" ADD COLUMN IF NOT EXISTS "open_max_running_per_person" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "feishu_app" ADD COLUMN IF NOT EXISTS "open_sessions_per_day_per_person" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "feishu_app" ADD COLUMN IF NOT EXISTS "open_max_running_total" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "feishu_app" ADD COLUMN IF NOT EXISTS "open_sessions_per_day_total" INTEGER NOT NULL DEFAULT 50;

ALTER TABLE "feishu_app" DROP CONSTRAINT IF EXISTS "feishu_app_open_workspace_id_fkey";
ALTER TABLE "feishu_app"
  ADD CONSTRAINT "feishu_app_open_workspace_id_fkey"
  FOREIGN KEY ("open_workspace_id") REFERENCES "workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;
ALTER TABLE "feishu_app" VALIDATE CONSTRAINT "feishu_app_open_workspace_id_fkey";
CREATE INDEX IF NOT EXISTS "feishu_app_open_workspace_id_idx" ON "feishu_app" ("open_workspace_id");

ALTER TABLE "feishu_app" DROP CONSTRAINT IF EXISTS "feishu_app_access_mode_chk";
ALTER TABLE "feishu_app"
  ADD CONSTRAINT "feishu_app_access_mode_chk" CHECK ("access_mode" IN ('OWNER_ONLY', 'AVAILABILITY_SCOPE')) NOT VALID;
ALTER TABLE "feishu_app" VALIDATE CONSTRAINT "feishu_app_access_mode_chk";

ALTER TABLE "feishu_app" DROP CONSTRAINT IF EXISTS "feishu_app_open_permission_mode_chk";
ALTER TABLE "feishu_app"
  ADD CONSTRAINT "feishu_app_open_permission_mode_chk"
  CHECK ("open_permission_mode" IN ('default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions')) NOT VALID;
ALTER TABLE "feishu_app" VALIDATE CONSTRAINT "feishu_app_open_permission_mode_chk";

-- The same bounds a connected group's limits take (0496).
ALTER TABLE "feishu_app" DROP CONSTRAINT IF EXISTS "feishu_app_open_limits_chk";
ALTER TABLE "feishu_app"
  ADD CONSTRAINT "feishu_app_open_limits_chk"
  CHECK ("open_max_running_per_person" BETWEEN 1 AND 100 AND "open_max_running_total" BETWEEN 1 AND 100
     AND "open_sessions_per_day_per_person" BETWEEN 1 AND 10000 AND "open_sessions_per_day_total" BETWEEN 1 AND 10000)
  NOT VALID;
ALTER TABLE "feishu_app" VALIDATE CONSTRAINT "feishu_app_open_limits_chk";

ALTER TABLE "feishu_chat_route" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'CONNECT';
ALTER TABLE "feishu_chat_route" ADD COLUMN IF NOT EXISTS "first_used_by_open_id" TEXT;
ALTER TABLE "feishu_chat_route" ADD COLUMN IF NOT EXISTS "first_used_by_name" TEXT;
ALTER TABLE "feishu_chat_route" ADD COLUMN IF NOT EXISTS "first_used_at" TIMESTAMPTZ(3);

ALTER TABLE "feishu_chat_route" DROP CONSTRAINT IF EXISTS "feishu_chat_route_source_chk";
ALTER TABLE "feishu_chat_route"
  ADD CONSTRAINT "feishu_chat_route_source_chk" CHECK ("source" IN ('CONNECT', 'OPEN_ACCESS')) NOT VALID;
ALTER TABLE "feishu_chat_route" VALIDATE CONSTRAINT "feishu_chat_route_source_chk";

-- Only a confirmed route runs anything, or an implicit one, which runs with the app's settings (section 14.2).
ALTER TABLE "feishu_chat_route" DROP CONSTRAINT IF EXISTS "feishu_chat_route_enabled_chk";
ALTER TABLE "feishu_chat_route"
  ADD CONSTRAINT "feishu_chat_route_enabled_chk"
  CHECK (NOT "enabled" OR "confirmed_at" IS NOT NULL OR "source" = 'OPEN_ACCESS') NOT VALID;
ALTER TABLE "feishu_chat_route" VALIDATE CONSTRAINT "feishu_chat_route_enabled_chk";

ALTER TABLE "feishu_thread" ADD COLUMN IF NOT EXISTS "open_access_open_id" TEXT;
-- The four limits count an app's open-access chains, one person's or everyone's (section 14.4).
CREATE INDEX IF NOT EXISTS "feishu_thread_app_id_open_access_open_id_idx"
  ON "feishu_thread" ("app_id", "open_access_open_id", "created_at") WHERE "open_access_open_id" IS NOT NULL;
