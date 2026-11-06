-- 0473 — `usage`'s four token counts become bigint: one of them passed int4 and wedged a session's
-- whole queue, the way 0347's sums did.
--
-- WHY
-- ===
-- Claude's `modelUsage` is the session's running total, not the turn's, and it is stored as reported.
-- On 2026-11-05 a coordinator (4,858 turns in four days) reported `cache_read_input_tokens` =
-- 2,148,742,656. The insert failed (P2020, 22003 out of range), the whole completion rolled back, and
-- the runner re-posted the 5xx 5,958 times in over three hours while every later message and wakeup
-- waited behind a turn the engine had finished. Resuming did not help: the next process reports the
-- same running total. Another long session had stopped 216 thousand tokens short of the same line.
--
-- Widened rather than dropped, as 0347 did with the sums: nothing read those, and the routing report
-- reads these. Neither of 0347's objections to bigint applies here. No path returns a `usage` row
-- whole (the one reader is that report's raw SQL, which already casts each count to bigint), and the
-- rewrite takes an ACCESS EXCLUSIVE lock on this table alone: `session_id` keeps its type, so the
-- foreign key to `session` is not re-checked.
--
-- Migrations apply at apiserver boot, before it serves, and only the apiserver touches this table:
-- turn-complete writes it and that report reads it. One ALTER with all four columns, so one rewrite
-- and not four.

-- This rewrite takes as long as the table is big, and a migration that fails at boot is a crash loop
-- (docker-compose.yml, statement_timeout). SET and RESET rather than SET LOCAL: `migrate deploy` sends
-- each statement of this file on its own, outside any transaction block, where SET LOCAL does nothing
-- (drilled: 57014 with it, applied with these). The ALTER is one statement, so it is atomic by itself.
SET statement_timeout = 0;

ALTER TABLE "usage"
  ALTER COLUMN "input_tokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "output_tokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "cache_creation_input_tokens" SET DATA TYPE BIGINT,
  ALTER COLUMN "cache_read_input_tokens" SET DATA TYPE BIGINT;

RESET statement_timeout;
