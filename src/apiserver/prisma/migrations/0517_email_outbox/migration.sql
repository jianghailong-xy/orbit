-- 0517 — the email outbox (docs/welcome-email-design.md §3.3, decisions D3 and D4).
--
-- One row per email to send, written in the same transaction that creates the account it is for:
-- a Google sign-up (`google-login.service.ts` link(), SIGNUP) or an administrator's
-- `POST /api/admin/users`. The first administrator `/setup` creates gets none, and accounts that
-- existed before this table get none: nothing is backfilled.
--
--   * `kind` — only `WELCOME`. `UNIQUE (kind, user_id)`: an account has at most one welcome email, so
--     two first sign-ins at once, or a double click, still make one.
--   * `to_address` — the account's email when the row was written: Google's verified address or the
--     one an administrator typed.
--   * `created_by_id` — the administrator who created the account, null for a Google sign-up: what
--     picks the "{admin} added you" line. An id rather than a foreign key, so deleting that
--     administrator writes nothing here.
--   * `status` — PENDING (to send), SENT, FAILED (gave up), SKIPPED (the channel or the welcome toggle
--     was off when the account was created; never sent later on its own).
--   * `attempts` — failed attempts so far; the 4th failure (1 min, 10 min, 1 h after the first) is
--     FAILED, and so is a 422 at once.
--   * `generation` — bumped by an administrator's Send welcome email, which also resets `attempts`;
--     `key_attempt` — bumped after a failure Resend answered. Together with the user id they make the
--     Idempotency-Key, so a retry after an unanswered attempt reuses its key and Resend sends at most once.
--   * `next_attempt_at` — when the worker may next try it.
--   * `last_error`, `last_attempt_at`, `provider_message_id`, `sent_at` — what the last attempt came to.
-- No body and no secret is stored: the email is rendered when it is sent.
--
-- The row goes with its account (ON DELETE CASCADE).
--
-- 0517: after 0516_email_settings (written as 0515 and renumbered with it, see 0516's header), both free
-- on main, on every branch of origin and in every worktree on this host (2026-11-11). Every statement can run twice: IF NOT EXISTS, and constraints inside a
-- `duplicate_object` guard. Nothing that exists is altered and no row is written.

CREATE TABLE IF NOT EXISTS "email_outbox" (
  "id"                  UUID NOT NULL,
  "kind"                TEXT NOT NULL,
  "user_id"             UUID NOT NULL,
  "to_address"          TEXT NOT NULL,
  "created_by_id"       UUID,
  "status"              TEXT NOT NULL,
  "attempts"            INTEGER NOT NULL DEFAULT 0,
  "generation"          INTEGER NOT NULL DEFAULT 0,
  "key_attempt"         INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error"          TEXT,
  "last_attempt_at"     TIMESTAMPTZ(3),
  "provider_message_id" TEXT,
  "sent_at"             TIMESTAMPTZ(3),
  "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_outbox_kind_user_id_key" ON "email_outbox" ("kind", "user_id");

-- What the worker claims: due PENDING rows.
CREATE INDEX IF NOT EXISTS "email_outbox_pending_due_idx" ON "email_outbox" ("next_attempt_at") WHERE "status" = 'PENDING';

DO $$ BEGIN
  ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_kind_chk" CHECK ("kind" IN ('WELCOME'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_status_chk" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
