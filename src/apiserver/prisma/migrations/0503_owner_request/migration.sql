-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 0503: owner requests — an agent session asking the account owner to act (project 34uP1vOyTgWZRZimQ0NU2,
-- task "apiserver: owner request model and lifecycle").
--
-- WHY
-- ---
-- A session that needs the owner (a decision, a secret, a step only a person can do, a yes/no) had one door, ask_owner,
-- and only a project's coordinator could use it. owner_request is the one model for all four kinds, and any session of
-- the account may file one. Existing ask_owner questions stay on project_open_item as they are.
--
-- WHAT IT ADDS
-- ------------
-- One table, `owner_request`:
--   kind                DECISION | SECRET | MANUAL_STEP | CONFIRM.
--   state               PENDING, then exactly one of DONE | DECLINED | EXPIRED | WITHDRAWN, which is final.
--   asked_by_session_id the session that filed it. History, no foreign key: purging the session keeps the request.
--   project_id          the project it is filed under, if any. History, no foreign key, for the same reason.
--   options / recommended_option (DECISION), steps (MANUAL_STEP), secret_spec (SECRET: name, runner, env var or file
--                       path — never the value).
--   client_request_id   the caller's idempotency key, unique per asking session.
--   resolution_note     why it was declined or withdrawn; answer: what the owner chose or said when marking it done.
-- CHECKs keep kind and state in their vocabularies, a terminal row carries resolved_at, and a DECLINED row its reason.
-- A partial index on expires_at serves the expiry sweep.
--
-- No function, trigger or type is created, replaced or dropped. No INSERT, UPDATE or DELETE: the table starts empty.
-- Every statement can run twice: CREATE TABLE / INDEX IF NOT EXISTS with the constraints inside the CREATE.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "owner_request" (
  "id"                     UUID NOT NULL,
  "owner_id"               UUID NOT NULL,
  "asked_by_session_id"    UUID NOT NULL,
  "project_id"             UUID,
  "kind"                   TEXT NOT NULL,
  "state"                  TEXT NOT NULL DEFAULT 'PENDING',
  "title"                  TEXT NOT NULL,
  "why"                    TEXT NOT NULL,
  "blocks_task_ids"        UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "if_unanswered"          TEXT,
  "options"                JSONB,
  "recommended_option"     INTEGER,
  "steps"                  JSONB,
  "secret_spec"            JSONB,
  "verify_hint"            TEXT,
  "expires_at"             TIMESTAMPTZ(3),
  "client_request_id"      TEXT,
  "resolved_at"            TIMESTAMPTZ(3),
  "resolved_by_user_id"    UUID,
  "resolved_by_session_id" UUID,
  "resolution_note"        TEXT,
  "answer"                 JSONB,
  "created_at"             TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "owner_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "owner_request_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "owner_request_kind_chk" CHECK ("kind" IN ('DECISION', 'SECRET', 'MANUAL_STEP', 'CONFIRM')),
  CONSTRAINT "owner_request_state_chk" CHECK ("state" IN ('PENDING', 'DONE', 'DECLINED', 'EXPIRED', 'WITHDRAWN')),
  CONSTRAINT "owner_request_resolved_chk" CHECK (("state" = 'PENDING') = ("resolved_at" IS NULL)),
  CONSTRAINT "owner_request_declined_reason_chk" CHECK ("state" <> 'DECLINED' OR "resolution_note" IS NOT NULL)
);
-- One request per (asking session, caller key): a retried filing finds the row it already made. NULL keys never collide.
CREATE UNIQUE INDEX IF NOT EXISTS "owner_request_session_client_key"
  ON "owner_request" ("asked_by_session_id", "client_request_id");
-- The owner's lists: one state, newest first.
CREATE INDEX IF NOT EXISTS "owner_request_owner_state_idx" ON "owner_request" ("owner_id", "state", "created_at");
-- The expiry sweep: pending requests with a deadline.
CREATE INDEX IF NOT EXISTS "owner_request_pending_expiry_idx"
  ON "owner_request" ("expires_at") WHERE "state" = 'PENDING' AND "expires_at" IS NOT NULL;
