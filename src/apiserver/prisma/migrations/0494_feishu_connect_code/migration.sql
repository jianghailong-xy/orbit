-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Feishu bot integration (project 34tJs8k23brO8Ie2WtMSk, task F1-1): the owner-identity code.
-- docs/feishu-bot-design.md section 5 is the authority for everything below.
--
-- WHAT IS ADDED
-- -------------
--   feishu_connect_code  a one-time code an account generates in Settings -> Feishu and sends to its bot in a
--                        direct message, which makes the sender the app's owner. 8 characters, valid for 10 minutes,
--                        one use. Only the code's SHA-256 is stored (code_hash, unique); expires_at is indexed. The
--                        row is deleted when the code is used, when it is posted in a group, or when the account
--                        generates another, so the table holds at most a handful of live rows.
--
-- WHO WRITES IT. feishu/feishu-owner.service.ts alone; src/apiserver/src/common/db-write-inventory.ts names each writer.
--
-- TENANCY
-- -------
-- owner_id references "user" (id) ON DELETE CASCADE. A code is honoured only on the app of the account that
-- generated it: the router compares owner_id with the app's owner_id before using it.
--
-- LOCKS
-- -----
-- The foreign key takes "user"'s SHARE ROW EXCLUSIVE lock for the moment the table is made; no row of an existing
-- table is written, read or locked, and no existing table gains a column. No function, trigger or type is created,
-- replaced or dropped.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0494: main stood at 0488 and the project line at 0492; 0490, 0491 and 0493 were held by other branches when this
-- was written (2026-11-08). Every statement can run twice: CREATE TABLE / INDEX IF NOT EXISTS with the constraints
-- inside the CREATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "feishu_connect_code" (
  "id"         UUID NOT NULL,
  "owner_id"   UUID NOT NULL,
  "code_hash"  TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feishu_connect_code_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feishu_connect_code_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_connect_code_code_hash_chk" CHECK ("code_hash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_connect_code_code_hash_key" ON "feishu_connect_code" ("code_hash");
-- A new code replaces the account's earlier ones.
CREATE INDEX IF NOT EXISTS "feishu_connect_code_owner_id_idx" ON "feishu_connect_code" ("owner_id");
-- Expired codes are swept by expiry.
CREATE INDEX IF NOT EXISTS "feishu_connect_code_expires_at_idx" ON "feishu_connect_code" ("expires_at");
