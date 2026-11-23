-- 1547 — the owner is told once that a pull request Orbit opened waits for a review
-- (docs/design/protected-branch-landing.md §4.5 "Review required", §11.3).
--
-- `github_pull_request.review_announced_at`: written by the pull request door's compare-and-set on the first read that
-- finds the pull request waiting for a review; the push notification is sent only by the read that wrote it. NULL on
-- every existing row, which is a pull request whose wait nobody was told about yet.
--
-- BACKWARD COMPATIBLE: one nullable column with no default on a table only the door writes, so the ALTER is a catalog
-- change. Rolling the code back leaves it unread.
--
-- 1547: the highest number on main, project/* and orbit/* branches was 1540 when this was written.

ALTER TABLE "github_pull_request" ADD COLUMN IF NOT EXISTS "review_announced_at" TIMESTAMPTZ(3);
