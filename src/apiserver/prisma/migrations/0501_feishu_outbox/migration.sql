-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Feishu bot integration (project 34tJs8k23brO8Ie2WtMSk, task F2-4): a session's replies go back to Feishu.
-- docs/feishu-bot-design.md sections 1.3 (item 6) and 7.5 are the authority.
--
-- WHAT IS ADDED
-- -------------
--   feishu_outbox  one row per finished turn of a session that has a Feishu message chain (feishu_thread): the turn's
--                  last assistant text, and the chain spoken in last, where it goes. turn-complete writes it after its
--                  own transaction committed, in a statement of its own, and only logs a failure; a worker on any
--                  replica claims due rows (FOR UPDATE SKIP LOCKED, `due_at` as the lease) and replies into the
--                  chain. `turn_id` is unique, so a re-posted completion writes nothing more. A failure Feishu may
--                  recover from is retried a bounded number of times, then given up on (GAVE_UP); a Feishu refusal is
--                  given up on at once.
--
-- WHO WRITES IT. feishu/feishu-outbox.ts alone; src/apiserver/src/common/db-write-inventory.ts names it.
--
-- TENANCY
-- -------
-- owner_id references "user" (id) ON DELETE CASCADE, and app_id references feishu_app (app_id) ON DELETE CASCADE ON
-- UPDATE CASCADE: removing or replacing the app removes what it had not sent. session_id and turn_id carry no foreign
-- key, as feishu_thread.session_id carries none: the row is written beside turn-complete and must never wait on, or
-- be refused for, a session's or a turn's row. Every reader scopes it by owner_id and app_id.
--
-- LOCKS
-- -----
-- The foreign keys take "user"'s and feishu_app's SHARE ROW EXCLUSIVE lock for the moment the table is made. No row is
-- written. No function, trigger or type is created, replaced or dropped.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0501: the project line stood at 0499 (F2-3), 0500 is held for F2-1's renumber, and no branch or worktree held 0501
-- (2026-11-08). Every statement can run twice: CREATE TABLE / INDEX IF NOT EXISTS with the constraints inside the CREATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "feishu_outbox" (
  "id"              UUID NOT NULL,
  "owner_id"        UUID NOT NULL,
  "app_id"          TEXT NOT NULL,
  "session_id"      UUID NOT NULL,
  "turn_id"         UUID NOT NULL,
  -- The chain it goes to: feishu_thread's chat and root message, as they were when the turn ended.
  "chat_id"         TEXT NOT NULL,
  "root_message_id" TEXT NOT NULL,
  -- The turn's last assistant text, as the engine wrote it.
  "text"            TEXT NOT NULL,
  -- PENDING (not tried yet) | FAILED (the last attempt failed and it is tried again at due_at) | SENT | GAVE_UP.
  "status"          TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  -- When it is next due: now for a new row, a claim's lease while a worker sends it, the backoff after a failure.
  "due_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The message Feishu delivered, once SENT.
  "message_id"      TEXT,
  -- Feishu's code and message of the last failure, never a credential or the text.
  "last_error"      TEXT,
  "sent_at"         TIMESTAMPTZ(3),
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feishu_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feishu_outbox_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_outbox_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "feishu_app" ("app_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_outbox_status_chk" CHECK ("status" IN ('PENDING', 'FAILED', 'SENT', 'GAVE_UP')),
  CONSTRAINT "feishu_outbox_attempts_chk" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_outbox_turn_id_key" ON "feishu_outbox" ("turn_id");
-- The worker's claim: rows still to send, the most overdue first.
CREATE INDEX IF NOT EXISTS "feishu_outbox_due_idx" ON "feishu_outbox" ("due_at") WHERE "status" IN ('PENDING', 'FAILED');
-- A session's rows in order: a later reply waits for an earlier one still to send.
CREATE INDEX IF NOT EXISTS "feishu_outbox_session_id_created_at_idx" ON "feishu_outbox" ("session_id", "created_at");
CREATE INDEX IF NOT EXISTS "feishu_outbox_owner_id_idx" ON "feishu_outbox" ("owner_id");
CREATE INDEX IF NOT EXISTS "feishu_outbox_app_id_idx" ON "feishu_outbox" ("app_id");
