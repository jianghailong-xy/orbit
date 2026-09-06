-- A wake gains a fourth end: it was HANDED TO the project's standing coordinator conversation.
--
-- WHY A FOURTH TERMINAL RATHER THAN A FLAVOUR OF 'SESSION_OPENED'
-- ==============================================================
-- 0175 gave a wake one way to reach a session: open a NEW one. `wake-disposition.ts` §2.1 sends
-- the one event that reports a criterion's finished work being off the default branch to a
-- session, and what such a fact needs is not a fresh conversation — it is a merge, performed by
-- whoever is already coordinating this project. The project has a row for that conversation
-- (`project.coordinator_session_id`), and telling it is one message rather than one session.
--
-- 'SESSION_OPENED' could not be stretched to cover it, in either direction. The column would be
-- true and its meaning false: the reader of this ledger asking "how many judgment sessions did
-- this project's coordinator wake spend" would count conversations nobody opened, and the reader
-- asking "was anything actually delivered" could not tell a session that was created from one that
-- was merely written to. So the vocabulary gains a member instead:
--
--   CLAIMED         — this delivery holds the fact and has not finished with it.
--   SESSION_OPENED  — a NEW judgment session was created for it (0175).
--   DELIVERED       — it was handed to the coordinator conversation that already exists.
--   CONSUMED        — recorded against a named non-session consumer (0183).
--   REFUSED         — not permitted; the key goes back so the fact may be delivered again (0174).
--
-- 'DELIVERED' IS INSIDE 0174'S PARTIAL UNIQUE INDEX, WHICH IS THE POINT
-- ====================================================================
-- 0174's index is `UNIQUE ("idempotency_key") WHERE "status" <> 'REFUSED'`, and its comment said
-- why the predicate is written negatively: a status added later is inside the index by default and
-- therefore goes on HOLDING the key. 'DELIVERED' does, so the fact that was handed to the standing
-- conversation cannot be handed to it a second time — not because anything checked, but because
-- the second INSERT of that key still loses. That is the whole of "the same fact does not send the
-- same message twice"; the deterministic `client_turn_id` the delivery uses is the belt to it.
--
-- THE SESSION POINTER'S UNIQUE INDEX BECOMES PARTIAL
-- ==================================================
-- 0175 made `session_id` unique so that two WAKES could not name one session. That is exactly
-- right for the thing it was about — two facts must not claim one judgment conversation, because a
-- judgment conversation is opened FOR one fact — and it is exactly wrong for this new end, where
-- naming one long-lived conversation over and over is the entire idea.
--
-- So the index keeps its old claim over the rows it was written about and makes none over the new
-- one: `WHERE "status" = 'SESSION_OPENED'`. This is a POSITIVE predicate, unlike 0174's, and the
-- difference is deliberate — that one guards a key and must fail closed onto statuses nobody has
-- invented yet; this one states a property of judgment sessions specifically, and a future status
-- silently inheriting "at most one wake may name this session" would be the wrong default for the
-- same reason 'DELIVERED' needs relief from it now.
--
-- `session_chk` is widened rather than replaced: "only a wake that reached a session may name one"
-- is still the rule, and there are now two ways to reach one. It stays one-directional for 0175's
-- reason — the FK is ON DELETE SET NULL, so requiring a terminal row to NAME a session would turn
-- every hard delete of a coordinator conversation into a constraint failure.
--
-- `delivery`: WHAT WAS HANDED OVER, WRITTEN WHERE `detail` CANNOT BE
-- ==================================================================
-- `detail` is written by the INSERT that claims the key, which happens BEFORE authorization
-- (0174's ordering rule) — so nothing that only exists once a delivery is permitted can go in it.
-- What a delivery handed to the conversation is exactly that kind of thing: it does not exist
-- until the wake is authorized and the message is on the row. It is a separate nullable column,
-- written by the same compare-and-set that writes 'DELIVERED', and constrained to that status: a
-- delivery record on a row that delivered nothing would be the one shape it must not have.
--
-- JSONB rather than a `delivered_turn_id` column, because "what this delivery carried" is not one
-- field for long. Today it carries the `client_turn_id` of the message, which is what makes "it
-- was not silently dropped" a fact a reader can check against `conversation_turn` rather than a
-- claim. An action computed from the fact — merge this, release that — is the same shape of thing,
-- decided at the same moment, and belongs here rather than in a second column beside it.
--
-- ROLLING DEPLOY. Additive: one nullable column, two CHECKs widened rather than narrowed, one
-- unique index made WEAKER. A replica still running the previous build writes 'CLAIMED',
-- 'SESSION_OPENED', 'CONSUMED' and 'REFUSED' and leaves `delivery` null — all still satisfied —
-- and it cannot violate an index that constrains strictly fewer rows than the one it knew about.
-- No row is read or written: 'DELIVERED' has never been stored, so widening needs no backfill.

ALTER TABLE "project_coordinator_wake" ADD COLUMN IF NOT EXISTS "delivery" JSONB;

ALTER TABLE "project_coordinator_wake"
  DROP CONSTRAINT IF EXISTS "project_coordinator_wake_status_chk";
ALTER TABLE "project_coordinator_wake"
  ADD CONSTRAINT "project_coordinator_wake_status_chk"
  CHECK ("status" IN ('CLAIMED', 'SESSION_OPENED', 'DELIVERED', 'CONSUMED', 'REFUSED'));

ALTER TABLE "project_coordinator_wake"
  DROP CONSTRAINT IF EXISTS "project_coordinator_wake_session_chk";
ALTER TABLE "project_coordinator_wake"
  ADD CONSTRAINT "project_coordinator_wake_session_chk"
  CHECK ("session_id" IS NULL OR "status" IN ('SESSION_OPENED', 'DELIVERED'));

ALTER TABLE "project_coordinator_wake"
  DROP CONSTRAINT IF EXISTS "project_coordinator_wake_delivery_chk";
ALTER TABLE "project_coordinator_wake"
  ADD CONSTRAINT "project_coordinator_wake_delivery_chk"
  CHECK ("delivery" IS NULL OR "status" = 'DELIVERED');

-- Same name, same column, narrower scope: what 0175 asserted about judgment sessions is still
-- asserted about judgment sessions, and nothing is asserted about the rows it never saw.
DROP INDEX IF EXISTS "project_coordinator_wake_session_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "project_coordinator_wake_session_id_key"
  ON "project_coordinator_wake" ("session_id")
  WHERE "status" = 'SESSION_OPENED';
