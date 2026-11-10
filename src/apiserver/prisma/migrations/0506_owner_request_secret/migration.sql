-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 0506: owner request secrets — the value an owner enters on a SECRET request, delivered to one runner
-- (project 34uP1vOyTgWZRZimQ0NU2, task "Implement secret delivery for SECRET owner requests";
-- design docs/design/owner-request-secrets.md §3).
--
-- WHAT IT ADDS
-- ------------
-- `owner_request_secret`, the grant (§3.2): one per owner request. The ciphertext lives in value_enc until the grant
-- leaves ACTIVE; from REMOVING on it is NULL. runner_id is a composite key with owner_id, so a grant cannot name
-- another account's runner; deleting the runner nulls runner_id only, and the sweep then ends the grant
-- RUNNER_DELETED rather than losing the record of it.
-- `account_secret`, the owner's saved secrets (§3.4): a label and a ciphertext, write-only.
--
-- No length, prefix or hash of a value is stored anywhere. No function, trigger or type is created, replaced or
-- dropped. No INSERT, UPDATE or DELETE: both tables start empty. Every statement can run twice.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "owner_request_secret" (
  "id"           UUID NOT NULL,
  "owner_id"     UUID NOT NULL,
  "request_id"   UUID NOT NULL,
  "runner_id"    UUID,
  "session_id"   UUID NOT NULL,
  "task_id"      UUID,
  -- The task's lifecycle epoch (task_progress.lifecycle_epoch) when the owner submitted: a task reopened since is a new
  -- epoch, and does not get the secret back (§6.1).
  "task_epoch"   INTEGER,
  "name"         TEXT,
  "exposure"     TEXT NOT NULL,
  "file_path"    TEXT,
  "value_enc"    TEXT,
  "state"        TEXT NOT NULL DEFAULT 'PENDING_DELIVERY',
  "end_reason"   TEXT,
  "expires_at"   TIMESTAMPTZ(3) NOT NULL,
  "delivered_at" TIMESTAMPTZ(3),
  "removed_at"   TIMESTAMPTZ(3),
  "removal_note" TEXT,
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "owner_request_secret_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "owner_request_secret_request_key" UNIQUE ("request_id"),
  CONSTRAINT "owner_request_secret_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "owner_request_secret_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "owner_request" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "owner_request_secret_runner_fkey"
    FOREIGN KEY ("runner_id", "owner_id") REFERENCES "runner" ("id", "owner_id") ON DELETE SET NULL ("runner_id"),
  CONSTRAINT "owner_request_secret_exposure_chk" CHECK (
    ("exposure" = 'ENV' AND "name" IS NOT NULL AND "file_path" IS NULL)
    OR ("exposure" = 'FILE' AND "file_path" IS NOT NULL)),
  CONSTRAINT "owner_request_secret_name_chk" CHECK ("name" IS NULL OR "name" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT "owner_request_secret_state_chk"
    CHECK ("state" IN ('PENDING_DELIVERY', 'ACTIVE', 'REMOVING', 'REMOVED')),
  -- The ciphertext exists only while the grant may still be delivered or held.
  CONSTRAINT "owner_request_secret_value_chk"
    CHECK (("state" IN ('PENDING_DELIVERY', 'ACTIVE')) = ("value_enc" IS NOT NULL)),
  CONSTRAINT "owner_request_secret_end_reason_chk" CHECK (
    ("state" IN ('PENDING_DELIVERY', 'ACTIVE')) = ("end_reason" IS NULL)
    AND ("end_reason" IS NULL OR "end_reason" IN ('TASK_ENDED', 'SESSION_ENDED', 'EXPIRED', 'WITHDRAWN', 'REVOKED',
      'MOVED', 'RUNNER_DELETED', 'KEY_UNREADABLE', 'DELIVERY_FAILED')))
);

-- The heartbeat and the fetch read a runner's live grants; the sweep reads every grant not yet REMOVED.
CREATE INDEX IF NOT EXISTS "owner_request_secret_runner_state_idx"
  ON "owner_request_secret" ("runner_id", "state");
CREATE INDEX IF NOT EXISTS "owner_request_secret_open_idx"
  ON "owner_request_secret" ("state") WHERE "state" <> 'REMOVED';

CREATE TABLE IF NOT EXISTS "account_secret" (
  "id"         UUID NOT NULL,
  "owner_id"   UUID NOT NULL,
  "label"      TEXT NOT NULL,
  "value_enc"  TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_secret_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "account_secret_owner_label_key" UNIQUE ("owner_id", "label"),
  CONSTRAINT "account_secret_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "account_secret_label_chk" CHECK (char_length("label") BETWEEN 1 AND 100)
);
