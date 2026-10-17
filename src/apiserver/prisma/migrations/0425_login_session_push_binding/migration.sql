-- 0425 — a push registration ends with the login session that made it
-- (docs/push-login-session-design.md).
--
-- A device stayed registered until its client unregistered it, so a sign-out made offline, or one
-- forced because the login had already ended, left the server pushing to a signed-out device.
--
--   1. `refresh_token.login_session_id`: the login session, minted at sign-in and written on every
--      token rotated from it. The access JWT carries it as `sid`. A session is live while one of
--      its tokens is unrevoked and unexpired. NULL on the tokens issued before this migration; the
--      next rotation of a live one starts a session.
--   2. `refresh_token_login_session_id_idx`: the read every push makes, the live tokens of the
--      sessions its registrations name.
--   3. `device_token.login_session_id`: the session that registered the device, from the caller's
--      `sid`. PushService sends nothing to a row whose session has ended. NULL is a row registered
--      before this migration, which is pushed to as before until the device registers again.
--
-- 0425: free on main and on every branch of origin (2026-10-15). Additive only: two nullable
-- columns with no default (catalog-only, no row rewritten) and one index on a small table (155 rows
-- in production on 2026-10-15). No foreign key: a session is no row of its own, and the
-- `device_token` rows still cascade with their user.

ALTER TABLE "refresh_token" ADD COLUMN "login_session_id" UUID;

CREATE INDEX "refresh_token_login_session_id_idx" ON "refresh_token"("login_session_id");

ALTER TABLE "device_token" ADD COLUMN "login_session_id" UUID;
