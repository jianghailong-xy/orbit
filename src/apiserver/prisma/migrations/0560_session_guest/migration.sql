-- 0560: session guests (docs/session-guests-design.md §5, §7; project 34w3R8RqLVGZuT9prKihV, task G1).
--
-- The owner of a session invites another registered account by email; the guest's messages are turns of the owner's
-- own session, recorded with the 0502 external-sender columns under a second source.
--
--   session_guest   one row per invitation. A live one (removed_at IS NULL) is what lets the guest read the session
--                   and send turns into it; removing or leaving stamps removed_at and removed_reason (REMOVED | LEFT),
--                   and inviting again afterwards is a new row. owner_id is the session's owner when the guest was
--                   added (no FK: the session's cascade already takes the row). opened_at is the first time the guest
--                   opened the session, which the owner's People list shows.
--                   Partial unique (session_id, user_id) WHERE removed_at IS NULL: one live invitation per person.
--                   (user_id) WHERE removed_at IS NULL: the guest's Shared with me list.
--   conversation_turn_external_sender_chk   the source may also be ORBIT_GUEST (external_sender_id is then the
--                   guest's user id, never shown to a client or the runner).
--   session_last_user_from_external_chk     the same widening for the session row's preview.
--   activity_credential_chk                 credential_kind may also be GUEST: the activity row of a guest turn.
--
-- New table, plus constraint swaps added NOT VALID then validated, so the scan of existing rows (all pass) runs under
-- SHARE UPDATE EXCLUSIVE. The swaps on session and conversation_turn ask for their lock 2 s at a time, as 0502 did.
-- No row is written; no trigger or function is created. Every statement can run twice.

CREATE TABLE IF NOT EXISTS "session_guest" (
  "id"             UUID NOT NULL,
  "session_id"     UUID NOT NULL,
  "owner_id"       UUID NOT NULL,
  "user_id"        UUID NOT NULL,
  "added_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "opened_at"      TIMESTAMPTZ(3),
  "removed_at"     TIMESTAMPTZ(3),
  "removed_reason" TEXT,
  CONSTRAINT "session_guest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "session_guest_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "session_guest_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "session_guest_removed_chk" CHECK (
    ("removed_at" IS NULL AND "removed_reason" IS NULL)
    OR ("removed_at" IS NOT NULL AND "removed_reason" IN ('REMOVED', 'LEFT'))
  ),
  CONSTRAINT "session_guest_not_owner_chk" CHECK ("user_id" <> "owner_id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_guest_live_key" ON "session_guest" ("session_id", "user_id") WHERE "removed_at" IS NULL;
CREATE INDEX IF NOT EXISTS "session_guest_live_user_idx" ON "session_guest" ("user_id") WHERE "removed_at" IS NULL;

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "conversation_turn" DROP CONSTRAINT IF EXISTS "conversation_turn_external_sender_chk";
      ALTER TABLE "conversation_turn"
        ADD CONSTRAINT "conversation_turn_external_sender_chk" CHECK (
          ("external_sender_source" IS NULL AND "external_sender_id" IS NULL AND "external_sender_name" IS NULL)
          OR ("external_sender_source" IN ('FEISHU', 'ORBIT_GUEST') AND "external_sender_id" IS NOT NULL)
        ) NOT VALID;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_last_user_from_external_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_last_user_from_external_chk" CHECK (
          ("last_user_from_external_source" IS NULL AND "last_user_from_external_name" IS NULL)
          OR "last_user_from_external_source" IN ('FEISHU', 'ORBIT_GUEST')
        ) NOT VALID;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 60 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
-- Prisma sends a file with a DO in it as one query, so one implicit transaction: end it here, or the VALIDATEs below
-- would scan under the DO's ACCESS EXCLUSIVE locks. (The server warns "there is no transaction in progress" when the
-- file is sent statement by statement instead; harmless.)
COMMIT;

ALTER TABLE "conversation_turn" VALIDATE CONSTRAINT "conversation_turn_external_sender_chk";
ALTER TABLE "session" VALIDATE CONSTRAINT "session_last_user_from_external_chk";

ALTER TABLE "activity" DROP CONSTRAINT IF EXISTS "activity_credential_chk";
ALTER TABLE "activity"
  ADD CONSTRAINT "activity_credential_chk"
  CHECK (("credential_kind" IS NULL OR "credential_kind" IN ('LOGIN', 'PAT', 'FEISHU', 'GUEST'))
     AND (("credential_kind" IS NOT DISTINCT FROM 'PAT') = ("credential_id" IS NOT NULL)))
  NOT VALID;
ALTER TABLE "activity" VALIDATE CONSTRAINT "activity_credential_chk";
