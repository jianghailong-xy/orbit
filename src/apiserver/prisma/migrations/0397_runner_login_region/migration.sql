-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `runner.login_region`: which of Kimi Code's two sites the browser-less sign-in relay signs in on.
--
-- kimi.com ('mainland-cn') and kimi.ai ('global') keep accounts, sign-in pages and APIs of their
-- own, and a bare `kimi login` picks one itself — the site its last login was on, else the one its
-- installer came from, which for an install Orbit made is kimi.com. So a kimi.ai account could not
-- be signed in from Orbit at all. `POST /runners/:id/login` now names the site, and the heartbeat
-- hands it to the runner with the relay's `start` (`kimi login --region …`), redelivered until the
-- runner's first report. The site has to sit on the row between the POST and the heartbeat, next to
-- the relay state it belongs to, as `login_account` does for a Codex account (0296).
--
-- NULLABLE, and NULL is the old behaviour rather than a gap: a sign-in naming no site is the bare
-- `kimi login` every row written before this migration ever was, and what every other engine's is.
--
-- ADD COLUMN only: no default, no NOT NULL, so the ALTER is catalog-only and no stored row is
-- rewritten.

ALTER TABLE "runner" ADD COLUMN "login_region" TEXT;
