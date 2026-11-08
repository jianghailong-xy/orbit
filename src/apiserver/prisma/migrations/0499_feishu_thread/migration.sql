-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Feishu bot integration (project 34tJs8k23brO8Ie2WtMSk, task F2-3): message chains that belong to a session.
-- docs/feishu-bot-design.md sections 7.2, 7.3 and 7.5 are the authority.
--
-- WHAT IS ADDED
-- -------------
--   feishu_thread  one row per Feishu message chain that belongs to a session: the chain the owner started with a
--                  new direct message (the bot's `Started · …` receipt answers it), and each alert card the owner
--                  replied to. (app_id, chat_id, root_message_id) is unique. `last_spoken_at` is when someone last
--                  spoke in the chain, so a session's replies go back to the chain spoken in last (section 7.5, F2-4).
--
-- WHAT CHANGES
-- ------------
--   activity_credential_chk  `credential_kind` may also be FEISHU: a session opened, or a turn sent, from Feishu is
--                  recorded as an activity row with the app, the open_id and the message_id (section 7.2). FEISHU
--                  carries no credential_id, as LOGIN carries none.
--
-- WHO WRITES IT. feishu/feishu-direct.service.ts alone; src/apiserver/src/common/db-write-inventory.ts names it.
--
-- TENANCY
-- -------
-- owner_id references "user" (id) ON DELETE CASCADE, and app_id references feishu_app (app_id) ON DELETE CASCADE
-- ON UPDATE CASCADE: removing or replacing the app removes its chains. session_id carries no foreign key, as
-- feishu_message.session_id carries none: a chain's write never waits on a session's row, and every reader scopes it
-- by owner_id.
--
-- LOCKS
-- -----
-- The foreign keys take "user"'s and feishu_app's SHARE ROW EXCLUSIVE lock for the moment the table is made. The
-- activity CHECK is dropped and added NOT VALID under activity's ACCESS EXCLUSIVE lock for a moment, without a scan,
-- then validated under SHARE UPDATE EXCLUSIVE, which lets reads and writes go on; every existing row passes it, since
-- the new set holds the old one. No row is written. No function, trigger or type is created, replaced or dropped.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0499: the project line stood at 0498 (F1-5), 0496 is F3-1's (in flight), 0497 is held for project
-- 34tXXUHZEcGeWeB0hp5YU, and no branch or worktree held 0499 (2026-11-08). Every statement can run twice: CREATE
-- TABLE / INDEX IF NOT EXISTS with the constraints inside the CREATE, and DROP CONSTRAINT IF EXISTS before the ADD.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "feishu_thread" (
  "id"              UUID NOT NULL,
  "owner_id"        UUID NOT NULL,
  "app_id"          TEXT NOT NULL,
  -- The chat the chain is in, and the message it starts from (Feishu's root_id of a reply in it).
  "chat_id"         TEXT NOT NULL,
  "root_message_id" TEXT NOT NULL,
  "session_id"      UUID NOT NULL,
  -- When someone last spoke in the chain: its opening, or the owner's latest reply in it.
  "last_spoken_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feishu_thread_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feishu_thread_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_thread_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "feishu_app" ("app_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_thread_ids_chk" CHECK (btrim("chat_id") <> '' AND btrim("root_message_id") <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_thread_app_id_chat_id_root_message_id_key"
  ON "feishu_thread" ("app_id", "chat_id", "root_message_id");
-- A session's chains, the one spoken in last first (section 7.5).
CREATE INDEX IF NOT EXISTS "feishu_thread_session_id_last_spoken_at_idx" ON "feishu_thread" ("session_id", "last_spoken_at");
CREATE INDEX IF NOT EXISTS "feishu_thread_owner_id_idx" ON "feishu_thread" ("owner_id");

ALTER TABLE "activity" DROP CONSTRAINT IF EXISTS "activity_credential_chk";
ALTER TABLE "activity"
  ADD CONSTRAINT "activity_credential_chk"
  CHECK (("credential_kind" IS NULL OR "credential_kind" IN ('LOGIN', 'PAT', 'FEISHU'))
     AND (("credential_kind" IS NOT DISTINCT FROM 'PAT') = ("credential_id" IS NOT NULL)))
  NOT VALID;
ALTER TABLE "activity" VALIDATE CONSTRAINT "activity_credential_chk";
