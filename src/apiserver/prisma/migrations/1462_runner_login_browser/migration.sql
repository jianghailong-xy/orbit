-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `runner.login_browser`: the owner's Use the runner's browser on a sign-in waiting on its link
-- (docs/runner-browser-engine-sign-in-design.md), and what the runner did with it.
--
--   runner.login_browser   TEXT: 'requested' from the press until the runner answers, then its answer:
--                          'opened', 'failed' or 'code-taken' (Claude Code's code taken from that
--                          browser). NULL when nobody asked, and with every new sign-in.
--
-- Every stored row reads NULL, which is what every sign-in was until now. ADD COLUMN with no default
-- is catalog-only: no stored row is rewritten.
--
-- 1462: the highest number on main, every project/* and pushed orbit/* branch and every session
-- worktree was 1461 (1461_default_permission_mode_audit) when this was written (2026-11-23).

ALTER TABLE "runner" ADD COLUMN "login_browser" TEXT;
