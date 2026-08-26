-- One wake opens at most one judgment session, and the database is what says so.
--
-- WHAT UNIT T3 ADDS TO 0174
-- =========================
-- 0174 made a fact wake a coordinator once. This makes that one wake open one SESSION — a fresh
-- conversation that reads the project out of the database, acts, and ends. It is not the
-- conversation a person opens with `POST /projects/:id/coordinator`; that one is long-lived, is
-- pointed at by `project.coordinator_session_id`, and is untouched by everything here. The two
-- share the database and share no context, and `session.dispatch_origin` is what tells them apart
-- (USER for the person's, PROJECT_COORDINATOR for a judgment).
--
-- 'SESSION_OPENED' IS INSIDE THE KEY'S INDEX, WHICH IS THE POINT
-- =============================================================
-- 0174's unique index is `UNIQUE ("idempotency_key") WHERE "status" <> 'REFUSED'`, and its comment
-- named this migration as the reason the predicate is written negatively: a status added later
-- must go on HOLDING the key rather than releasing it. 'SESSION_OPENED' does, so the fact that
-- opened a judgment session cannot open a second one — not because anything checked, but because
-- the second INSERT of that key still loses.
--
-- WHY THE SESSION POINTER IS ALSO UNIQUE
-- ======================================
-- The claim above stops one FACT opening two sessions. This stops two WAKES naming one session,
-- which is the other direction and is not implied by it. In PostgreSQL a unique index treats NULLs
-- as distinct, so the unbound rows — every CLAIMED and every REFUSED one — are unconstrained by it
-- without needing a predicate.
--
-- ON DELETE SET NULL, AND NO CHECK IN THE OTHER DIRECTION
-- =======================================================
-- The FK clears the pointer rather than blocking the delete. A FK that refuses is how deleting a
-- task failed 36 times against 0122's coordinator guards (see 0164) and how deleting a project is
-- still held up by the sessions pointing at its actions; a wake ledger must never be the reason a
-- person cannot delete a session.
--
-- Which is also why the CHECK is one-directional. `session_id IS NULL OR status = 'SESSION_OPENED'`
-- says only a wake that opened a session may name one. The converse — "a SESSION_OPENED row must
-- name a session" — would be violated by the SET NULL above, turning every hard delete of a
-- judgment session into a constraint failure. What the row still says after its session is gone is
-- "this wake opened one", which is the fact worth keeping.
--
-- ROLLING DEPLOY. Additive: one nullable column, one FK, one index, and a CHECK widened rather
-- than narrowed. A replica on the previous build writes 'CLAIMED' and 'REFUSED' as before, and
-- both still satisfy the new constraint.

ALTER TABLE "project_coordinator_wake" ADD COLUMN IF NOT EXISTS "session_id" UUID;

-- Widened, not replaced: 'CLAIMED' and 'REFUSED' mean exactly what 0174 said they mean.
ALTER TABLE "project_coordinator_wake"
  DROP CONSTRAINT IF EXISTS "project_coordinator_wake_status_chk";
ALTER TABLE "project_coordinator_wake"
  ADD CONSTRAINT "project_coordinator_wake_status_chk"
  CHECK ("status" IN ('CLAIMED', 'SESSION_OPENED', 'REFUSED'));

DO $$ BEGIN
  ALTER TABLE "project_coordinator_wake"
    ADD CONSTRAINT "project_coordinator_wake_session_chk"
    CHECK ("session_id" IS NULL OR "status" = 'SESSION_OPENED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "project_coordinator_wake"
    ADD CONSTRAINT "project_coordinator_wake_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "project_coordinator_wake_session_id_key"
  ON "project_coordinator_wake" ("session_id");
