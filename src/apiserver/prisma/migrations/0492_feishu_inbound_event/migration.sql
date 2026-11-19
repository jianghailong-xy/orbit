-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Feishu bot integration (project 34tJs8k23brO8Ie2WtMSk, task F0-2): the inbound inbox, and each replica's long
-- connection of each app. docs/feishu-bot-design.md sections 4.4 and 7.1 are the authority for everything below.
--
-- WHAT IS ADDED
-- -------------
--   feishu_inbound_event  every event an app's long connection delivered, inserted before it is acknowledged.
--                         (app_id, event_id) is unique: Feishu redelivers an event it did not see acknowledged
--                         within 3 seconds, to any replica's connection, and the redelivery finds the row and is
--                         acknowledged without being processed again. A worker on any replica claims unprocessed
--                         rows with FOR UPDATE SKIP LOCKED and a lease (lease_until), counts the attempt, and
--                         stamps processed_at; a failure keeps its error and is retried a bounded number of times.
--                         Rows go 7 days after they were processed or given up on.
--   feishu_link           one row per (app, replica): that replica's connection state (CONNECTING, CONNECTED,
--                         BACKOFF, STOPPED), failures in a row, when it tries next, its last error, and a heartbeat
--                         the replica renews. The settings page counts the CONNECTED rows with a fresh heartbeat.
--
-- WHO WRITES THEM. feishu/feishu-inbox.service.ts writes feishu_inbound_event; feishu/feishu-link.service.ts writes
-- feishu_link, each replica only its own rows. src/apiserver/src/common/db-write-inventory.ts names each writer.
--
-- TENANCY
-- -------
-- Both reference feishu_app (app_id) ON DELETE CASCADE ON UPDATE CASCADE: removing an app, or replacing it with
-- another, takes its pending events and connection rows with it. An event acts only in the account its app belongs
-- to (feishu/feishu-router.ts reads the owner from feishu_app when it routes the event).
--
-- LOCKS
-- -----
-- The two foreign keys take feishu_app's SHARE ROW EXCLUSIVE lock for the moment the tables are made; no row of an
-- existing table is written, read or locked, and no existing table gains a column. No function, trigger or type is
-- created, replaced or dropped.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0492: main stood at 0489, and 0490 (open_list_integration_job_renewal_silent) and 0491
-- (session_last_user_from_orbit) were held by other branches when this was written (2026-11-07). Every statement
-- can run twice: CREATE TABLE / INDEX IF NOT EXISTS with the constraints inside the CREATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "feishu_inbound_event" (
  "id"           UUID NOT NULL,
  "app_id"       TEXT NOT NULL,
  "event_id"     TEXT NOT NULL,
  "event_type"   TEXT NOT NULL,
  -- The envelope exactly as Feishu sent it.
  "payload"      JSONB NOT NULL,
  "received_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The replica whose connection delivered it.
  "received_by"  TEXT NOT NULL,
  "processed_at" TIMESTAMPTZ(3),
  "processed_by" TEXT,
  "attempts"     INTEGER NOT NULL DEFAULT 0,
  "lease_until"  TIMESTAMPTZ(3),
  "error"        TEXT,
  CONSTRAINT "feishu_inbound_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feishu_inbound_event_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "feishu_app" ("app_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_inbound_event_event_id_chk" CHECK (btrim("event_id") <> '' AND char_length("event_id") <= 256),
  CONSTRAINT "feishu_inbound_event_attempts_chk" CHECK ("attempts" >= 0)
);
-- One row per event of an app, however often and wherever it is delivered (section 4.4).
CREATE UNIQUE INDEX IF NOT EXISTS "feishu_inbound_event_app_id_event_id_key" ON "feishu_inbound_event" ("app_id", "event_id");
-- The worker's claim reads only what is still to be done, oldest first.
CREATE INDEX IF NOT EXISTS "feishu_inbound_event_pending_idx" ON "feishu_inbound_event" ("received_at") WHERE "processed_at" IS NULL;

CREATE TABLE IF NOT EXISTS "feishu_link" (
  "app_id"          TEXT NOT NULL,
  "replica_id"      TEXT NOT NULL,
  "state"           TEXT NOT NULL,
  "connected_at"    TIMESTAMPTZ(3),
  "failures"        INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(3),
  "last_error"      TEXT,
  "heartbeat_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feishu_link_pkey" PRIMARY KEY ("app_id", "replica_id"),
  CONSTRAINT "feishu_link_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "feishu_app" ("app_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feishu_link_state_chk" CHECK ("state" IN ('CONNECTING', 'CONNECTED', 'BACKOFF', 'STOPPED'))
);
