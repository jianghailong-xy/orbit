-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Feishu bot integration (project 34tJs8k23brO8Ie2WtMSk, task F1-4): the register of alert cards.
-- docs/feishu-bot-design.md sections 6.1 and 6.2 are the authority for everything below.
--
-- WHAT IS ADDED
-- -------------
--   feishu_message  one row per card the bot sent (or is sending) to the owner of an account's app: Feishu's
--                   message_id once Feishu answered, the chat, the account, the kind, the session / approval /
--                   open item it is about, its state and when it was sent. Cards are merged rather than stacked, at
--                   the grain of the APNs collapse id (section 6.2): (app_id, collapse_key) is unique, so a stretch of
--                   one session's pending approvals, one owner item and one settlement each have one row, and a
--                   repeated announcement bumps `revision` instead of adding a row. Whoever holds the row's lease
--                   (lease_token / lease_until) sends or updates the card and records `rendered_revision`; a bump made
--                   meanwhile is picked up by that holder before it lets go, so two apiservers send one card between
--                   them. Later tasks update a card to its outcome (F1-5) and route a reply to it (F2-3).
--
-- WHO WRITES IT. push/feishu-transport.ts alone; src/apiserver/src/common/db-write-inventory.ts names each writer.
--
-- TENANCY
-- -------
-- owner_id references "user" (id) ON DELETE CASCADE, and app_id references feishu_app (app_id) ON DELETE CASCADE
-- ON UPDATE CASCADE: removing or replacing the app removes its cards (section 4.1). session_id, approval_id and
-- open_item_id carry no foreign key, as approval.turn_id carries none: a card write must never wait on, or block, a
-- session's or an approval's row, and every reader scopes them by owner_id.
--
-- LOCKS
-- -----
-- The foreign keys take "user"'s and feishu_app's SHARE ROW EXCLUSIVE lock for the moment the table is made; no row
-- of an existing table is written, read or locked, and no existing table gains a column. No function, trigger or
-- type is created, replaced or dropped.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0495: main stood at 0488 and the project line at 0494; 0490, 0491 and 0493 are held by other branches, and 0494
-- by two (this line's feishu_connect_code and another branch's), when this was written (2026-11-08). Every statement
-- can run twice: CREATE TABLE / INDEX IF NOT EXISTS with the constraints inside the CREATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "feishu_message" (
  "id"                UUID NOT NULL,
  "owner_id"          UUID NOT NULL,
  "app_id"            TEXT NOT NULL,
  -- What the card is merged on: `approval-<first approval of the stretch>`, `settled-<session>-<turn seq>`,
  -- `owner-item-<item>`, or another alert's own collapse id; a one-off alert's is unique to it.
  "collapse_key"      TEXT NOT NULL,
  -- approval | finished | failed | agent-message | owner-item | other (section 6.1).
  "kind"              TEXT NOT NULL,
  -- The owner's open_id the card was sent to, and the chat Feishu put it in.
  "receive_id"        TEXT NOT NULL,
  "chat_id"           TEXT,
  -- Feishu's message_id, once Feishu accepted the card.
  "message_id"        TEXT,
  "session_id"        UUID,
  "approval_id"       UUID,
  "open_item_id"      UUID,
  -- PENDING (not sent yet) | SENT | FAILED (given up before Feishu accepted it).
  "status"            TEXT NOT NULL DEFAULT 'PENDING',
  -- The alert the card was last drawn from (feishu/cards/feishu-cards.ts FeishuAlert).
  "alert"             JSONB,
  "revision"          INTEGER NOT NULL DEFAULT 1,
  "rendered_revision" INTEGER NOT NULL DEFAULT 0,
  "lease_token"       UUID,
  "lease_until"       TIMESTAMPTZ(3),
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  -- Feishu's code and message for the last failure, never a credential.
  "last_error"        TEXT,
  "sent_at"           TIMESTAMPTZ(3),
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feishu_message_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feishu_message_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_message_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "feishu_app" ("app_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_message_kind_chk"
    CHECK ("kind" IN ('approval', 'finished', 'failed', 'agent-message', 'owner-item', 'other')),
  CONSTRAINT "feishu_message_status_chk" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED')),
  CONSTRAINT "feishu_message_collapse_key_chk" CHECK (btrim("collapse_key") <> '' AND char_length("collapse_key") <= 200),
  CONSTRAINT "feishu_message_revision_chk" CHECK ("revision" >= 1 AND "rendered_revision" >= 0 AND "attempts" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_message_app_id_collapse_key_key" ON "feishu_message" ("app_id", "collapse_key");
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_message_message_id_key" ON "feishu_message" ("message_id");
-- A session's cards (reply routing, F2-3; outcome updates, F1-5), and an owner item's.
CREATE INDEX IF NOT EXISTS "feishu_message_session_id_idx" ON "feishu_message" ("session_id");
CREATE INDEX IF NOT EXISTS "feishu_message_open_item_id_idx" ON "feishu_message" ("open_item_id");
CREATE INDEX IF NOT EXISTS "feishu_message_owner_id_idx" ON "feishu_message" ("owner_id");
