-- 1237 — browser_open and `orbit browser open [--url]` (board docs/mocks/runner-browser/03-agent-tools.html ②).
--
-- WHAT IT ADDS
-- ============
--   * `runner.browser_open_requested_at`: a session's browser_open, handed to the next heartbeat as `openBrowser` and
--     cleared there (the shape of `browser_clear_requested_at`). The runner starts the browser if it is not running.
--   * `runner.browser_open_request`: what that open asks for, `{"sessionId": …, "url"?: …}`: the asking session, and the
--     page the remote Chrome is to open, if any. Cleared with the timestamp; the page itself is never stored.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two nullable columns, no default, nothing backfilled: an older apiserver neither reads nor writes them.
ALTER TABLE "runner" ADD COLUMN "browser_open_requested_at" TIMESTAMP(3);
ALTER TABLE "runner" ADD COLUMN "browser_open_request" JSONB;
