-- 0347 — the four lifetime token sums leave `session`: one of them overflowed and wedged a session's
-- whole queue.
--
-- WHY
-- ===
-- `sum_input_tokens`, `sum_output_tokens`, `sum_cache_read` and `sum_cache_write` were int4 accruals
-- that turnComplete incremented in the same write that parks the session and acknowledges the turn.
-- On 2026-10-01 a project coordinator (session 347dTTFhqArDGevJtEUkl: 2236 turns, ~780K context per
-- call) stood at `sum_cache_read` = 2,143,815,812. Its next turn added 3,871,488, the increment
-- overflowed (22003 integer out of range), the whole completion rolled back, and the runner retried
-- the 5xx for 7.5 hours (12,960 refusals) while every later message sat PENDING behind a turn the
-- engine had finished long before.
--
-- Nothing reads them: no code in the control plane, the web or native clients or the runner, and no
-- view, function, trigger, constraint or index. Per-turn, per-model token counts stay in `usage`,
-- which is where a total is summed when somebody needs one; `cost_usd` and `num_turns` stay on the
-- row.
--
-- Dropped rather than widened to bigint: that rewrites the table under an exclusive lock, and Prisma
-- maps it to a JS bigint that JSON.stringify refuses on any path that returns a whole session row.
--
-- Catalog-only: DROP COLUMN does not rewrite the heap. A view or a trigger naming one of these
-- columns would refuse the DROP by itself; a plpgsql body is the one reader pg_depend does not
-- track, so the gate below looks for one before the columns go.

DO $$
DECLARE
  stale TEXT;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO stale
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~ 'sum_(input_tokens|output_tokens|cache_read|cache_write)';
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_TOKEN_SUMS_REMOVAL_LEFT_READERS: %', stale
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

ALTER TABLE "session"
  DROP COLUMN IF EXISTS "sum_input_tokens",
  DROP COLUMN IF EXISTS "sum_output_tokens",
  DROP COLUMN IF EXISTS "sum_cache_read",
  DROP COLUMN IF EXISTS "sum_cache_write";
