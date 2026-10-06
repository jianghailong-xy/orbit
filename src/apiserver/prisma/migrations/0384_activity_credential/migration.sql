-- 0384 — which credential an activity row was written through (docs/personal-access-token-design.md §6.4).
--
-- A write through a personal access token is still the user's own: the task it creates says
-- creator_type USER and the user's id, exactly as a write from the Web does. What tells the two
-- apart is recorded here instead. `credential_kind` is the door the request came in through —
-- LOGIN, the JWT the Web and App sign in for, or PAT — and `credential_id` is the token's id when
-- it was a PAT, and only then. Both are NULL on a row no user credential wrote.
--
-- `credential_id` has no foreign key, as `actor_id` has none: the record of what a token did has to
-- outlive the token, and a deleted user's tokens cascade away with them (0383).
--
-- 0384: the highest number on main and on every branch of origin was 0383 when this was written
-- (2026-10-06). Every statement can run twice: IF NOT EXISTS, and the constraint inside a
-- `duplicate_object` guard. No row is written, and every existing row has both columns NULL, which
-- the constraint accepts.

ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "credential_kind" TEXT;
ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "credential_id" UUID;

-- A kind is one of the two doors, and a token id is present exactly when the door was a token.
-- Spelled so that no operand can be NULL, as 0383 spells its own: a CHECK passes when its
-- expression is NULL.
DO $$ BEGIN
  ALTER TABLE "activity"
    ADD CONSTRAINT "activity_credential_chk"
    CHECK (("credential_kind" IS NULL OR "credential_kind" IN ('LOGIN', 'PAT'))
       AND (("credential_kind" IS NOT DISTINCT FROM 'PAT') = ("credential_id" IS NOT NULL)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
