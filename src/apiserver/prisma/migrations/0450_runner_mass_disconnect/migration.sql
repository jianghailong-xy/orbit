-- 0450 — what a mass disconnection of runners leaves behind, so that the reaper holds its runners however few of them
-- are still silent when one crosses the offline line (realtime/reaper.service.ts; docs/runner-link-design.md §6.5).
--
-- The reaper calls a runner offline after 90 s without a beat, and does not reap for that while a fifth of the cell has
-- lost contact together: then a link gateway, the network or this control plane cut them off, not their machines. It
-- used to count the runners silent at the moment it swept. Runners that come back fast are silent at no such moment — a
-- gateway node of three stops and its runners connect through the other two within seconds; a gateway restarts and
-- nine in ten are back within 30 s — and the few still waiting out their reconnection backoff were reaped as runners
-- gone (task C2b, 2026-10-28: 975 runs in one load test run, 194 in another). So when each runner lost contact is kept
-- after it is back, and each mass disconnection a sweep reads off those instants is kept for as long as it holds:
--
--   runner_presence.lost_at   the last beat the runner was heard with before it last lost contact: copied from
--                             last_beat_at when the link gateway opens a new connection for it (the welcome route), and
--                             when a link beat comes more than RUNNER_SILENT_AFTER_MS (45 s) after the one before it.
--                             NULL until either happens. TIMESTAMP(3), the type of last_beat_at, and gone with the rest of
--                             the UNLOGGED table in a crash, when a reaper that has just started holds anyway.
--   runner_mass_disconnect    each mass disconnection a sweep has seen: the span of the last beats its runners were heard
--                             with before they lost contact, lost_from to lost_to, both included. A silent runner whose
--                             last beat falls in a span is not reaped for its silence until it has been silent for
--                             RUNNER_SILENT_AFTER_MS + MASS_SILENCE_WINDOW_MS (10 min 45 s). runners and heard: how many
--                             runners lost contact in it, of how many the cell had heard from, as the sweep that last
--                             widened it counted them; seen_at when a sweep first saw it, updated_at when one last widened
--                             it. Written by the reaper alone, which runs on one apiserver process at a time (0449), and
--                             read by whichever process runs it next; rows past every hold go in its hourly pass.
--
-- 0450: the next number free on main, on every branch of origin, in every commit of `git log --all` and in every
-- worktree on this host (2026-10-28). Nothing is backfilled: lost_at starts NULL and the table empty. No trigger, no
-- foreign key: a span names no runner. Every statement can run twice.

ALTER TABLE "runner_presence" ADD COLUMN IF NOT EXISTS "lost_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "runner_mass_disconnect" (
    "id" BIGSERIAL NOT NULL,
    "lost_from" TIMESTAMP(3) NOT NULL,
    "lost_to" TIMESTAMP(3) NOT NULL,
    "runners" INTEGER NOT NULL,
    "heard" INTEGER NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runner_mass_disconnect_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "runner_mass_disconnect_lost_to_idx" ON "runner_mass_disconnect" ("lost_to");
