-- 0618 — the session invitation email (owner decision D7 = A, 2026-11-13): the email outbox (0517) gets a second kind.
--
-- When a session owner invites someone as a guest (session-guests.service.ts invite()), one SESSION_INVITE row is
-- written in the transaction that writes the new live invitation, and the outbox worker sends it.
--
--   * `session_id` — the session the person was invited to; null for a WELCOME row, set for a SESSION_INVITE row
--     (`email_outbox_session_id_chk`). The row goes with its session (ON DELETE CASCADE), as it goes with its account.
--   * `kind` — WELCOME or SESSION_INVITE.
--   * `email_outbox_kind_user_session_key` replaces 0517's `email_outbox_kind_user_id_key`: UNIQUE NULLS NOT
--     DISTINCT (kind, user_id, session_id), so an account still has at most one WELCOME row (its session_id is null,
--     and nulls compare equal here), and at most one SESSION_INVITE row per session. Inviting the same person to the
--     same session again — after a Remove too — writes no second row, so sends no second email.
--   * `email_outbox_session_id_idx` — the foreign key's index, for a session's delete and the owner's People list.
--
-- 0618: 0614 is free on main but 0615–0617 are taken on the pushed orbit/task-p3-codeless-runs-* branches with 0614
-- skipped, and 0618 is free on main, on every branch of origin and in every worktree on this host (2026-11-13). Every
-- statement can run twice: IF [NOT] EXISTS, and constraints inside a `duplicate_object` guard or dropped first.
-- No row is written or changed: every existing row is a WELCOME row, with session_id null.

ALTER TABLE "email_outbox" ADD COLUMN IF NOT EXISTS "session_id" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "email_outbox_kind_user_session_key"
  ON "email_outbox" ("kind", "user_id", "session_id") NULLS NOT DISTINCT;
DROP INDEX IF EXISTS "email_outbox_kind_user_id_key";

CREATE INDEX IF NOT EXISTS "email_outbox_session_id_idx" ON "email_outbox" ("session_id");

ALTER TABLE "email_outbox" DROP CONSTRAINT IF EXISTS "email_outbox_kind_chk";
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_kind_chk" CHECK ("kind" IN ('WELCOME', 'SESSION_INVITE'));

DO $$ BEGIN
  ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_session_id_chk"
    CHECK (("session_id" IS NULL) = ("kind" = 'WELCOME'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
