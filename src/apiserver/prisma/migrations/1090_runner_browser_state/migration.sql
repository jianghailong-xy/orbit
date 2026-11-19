-- 1090 — the managed runner browser's state and Clear saved logins (docs/runner-browser-design.md §5, §6).
--
-- WHAT IT ADDS
-- ============
--   * `runner.browser_state`: the browser as the runner's last heartbeat reported it (running, the lease holder,
--     open viewers, when it last cleared its profile), read by GET /api/runners/:id/browser. NULL: not reported.
--   * `runner.browser_clear_requested_at`: the owner's Clear saved logins, handed to the next heartbeat as
--     `clearBrowserProfile` and cleared there (the shape of `self_update_requested_at`).
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two nullable columns, no default, nothing backfilled: an older apiserver neither reads nor writes them.
ALTER TABLE "runner" ADD COLUMN "browser_state" JSONB;
ALTER TABLE "runner" ADD COLUMN "browser_clear_requested_at" TIMESTAMP(3);
