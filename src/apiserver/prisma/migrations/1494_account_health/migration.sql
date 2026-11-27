-- 1494 — account health (docs/routing-account-health-design.md §6, as amended in §11).
--
--   account_health  what Orbit has learned about an account from the runs it sent there
--
-- One live row (cleared_at IS NULL) per owner, subject and scope. The subject is the grain a run spends
-- (§6.1): `runner:<runnerId>:<engine>:<account>` for a sign-in on one runner, `provider:<providerId>` for a key or a
-- Claude pool member, `pool-login:<poolId>:<accountId>` for a Codex pool login. `scope_model` is '' for the whole
-- account and a model id for one model on it; the two are independent rows (§6.1, Q6).
--
-- `state` SUSPECT is the breaker's first strike; BLOCKED is a trip of either ladder (classified 1 h … 24 h, breaker
-- 30 min … 24 h, on one `trips` counter); COOLDOWN is a usage-limit or capacity cool-down, which is never a trip.
-- `blocked_until` is always set for BLOCKED and COOLDOWN: no block is open-ended (§6.2). `trial_session_id` is the
-- one run testing an expired block (§6.5), claimed by a single conditional UPDATE. A cleared row stays as the record
-- of how it ended (`cleared_by` SUCCESS, OWNER or EXPIRED) and the next failure inserts a new live row.
--
-- No foreign key to a session: `last_session_id` and `trial_session_id` are evidence, read by id, and a deleted
-- session must not take an account's history with it. The parts of the key that name rows cascade with them.
--
-- Additive only: a new table, read by nothing older. Every statement can run twice.
--
-- 1494: the highest number on every ref and session worktree was 1492 (1492_runner_account_sign_out) when this was
-- written; 1493 is left for the session columns of the same project's phase 1a (§10 Migration).

CREATE TABLE IF NOT EXISTS "account_health" (
  "id"               UUID           NOT NULL,
  "owner_id"         UUID           NOT NULL,
  "subject_key"      TEXT           NOT NULL,
  "scope_model"      TEXT           NOT NULL DEFAULT '',
  "runner_id"        UUID,
  "engine"           TEXT,
  "account"          TEXT,
  "provider_id"      UUID,
  "pool_id"          UUID,
  "state"            TEXT           NOT NULL,
  "kind"             TEXT           NOT NULL,
  "said"             TEXT,
  "strikes"          INTEGER        NOT NULL DEFAULT 0,
  "trips"            INTEGER        NOT NULL DEFAULT 0,
  "first_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "last_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "last_session_id"  UUID,
  "blocked_until"    TIMESTAMPTZ(3),
  "trial_session_id" UUID,
  "trial_claimed_at" TIMESTAMPTZ(3),
  "notified_at"      TIMESTAMPTZ(3),
  "notified_kind"    TEXT,
  "cleared_at"       TIMESTAMPTZ(3),
  "cleared_by"       TEXT,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "account_health_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "account_health_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "account_health_runner_id_fkey"
    FOREIGN KEY ("runner_id") REFERENCES "runner"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "account_health_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "model_provider"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "account_health_pool_id_fkey"
    FOREIGN KEY ("pool_id") REFERENCES "provider_pool"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "account_health_state_check" CHECK ("state" IN ('SUSPECT', 'BLOCKED', 'COOLDOWN')),
  CONSTRAINT "account_health_cleared_by_check"
    CHECK (("cleared_at" IS NULL AND "cleared_by" IS NULL)
        OR ("cleared_at" IS NOT NULL AND "cleared_by" IN ('SUCCESS', 'OWNER', 'EXPIRED'))),
  CONSTRAINT "account_health_blocked_until_check"
    CHECK ("state" = 'SUSPECT' OR "blocked_until" IS NOT NULL),
  CONSTRAINT "account_health_counts_check" CHECK ("strikes" >= 0 AND "trips" >= 0),
  CONSTRAINT "account_health_trial_check" CHECK (("trial_session_id" IS NULL) = ("trial_claimed_at" IS NULL))
);

-- One live row per subject and scope (§10 Migration).
CREATE UNIQUE INDEX IF NOT EXISTS "account_health_live_key"
  ON "account_health" ("owner_id", "subject_key", "scope_model") WHERE "cleared_at" IS NULL;

-- The router's batched read of an owner's live rows, and the per-session idempotency look-up of a cleared one.
CREATE INDEX IF NOT EXISTS "account_health_owner_subject_idx" ON "account_health" ("owner_id", "subject_key", "scope_model");

-- Foreign-key parents deleted with ON DELETE CASCADE find their rows by index.
CREATE INDEX IF NOT EXISTS "account_health_runner_id_idx" ON "account_health" ("runner_id");
CREATE INDEX IF NOT EXISTS "account_health_provider_id_idx" ON "account_health" ("provider_id");
CREATE INDEX IF NOT EXISTS "account_health_pool_id_idx" ON "account_health" ("pool_id");
