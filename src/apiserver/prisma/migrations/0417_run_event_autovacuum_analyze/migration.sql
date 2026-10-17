-- Keep `run_event`'s statistics fresh: an append-only table can go weeks without an ANALYZE.
--
-- `run_event` is effectively append-only — rows are inserted and almost never updated or
-- deleted — so dead tuples stay near zero (6,857 of ~5.7M rows, 2026-10-09) and the default
-- autovacuum_vacuum_scale_factor of 0.2 (≈1.13M dead rows) is never reached. That vacuum
-- idleness is expected behavior and harmless: a heap that never accumulates dead tuples needs
-- no vacuuming, so the vacuum side keeps its defaults.
--
-- What does go stale is the planner's statistics. The default autovacuum_analyze_scale_factor
-- of 0.1 waits for 10% of the table to change before an autoanalyze — ≈565k inserts on this
-- deployment. The table sat 17 days between autoanalyzes (2026-09-22 → 2026-10-09), so its
-- n_distinct and most-common-value estimates drifted away from the live distribution while
-- the high-water-mark reads (max(seq) per session) and event fan-outs kept planning against
-- them.
--
-- 1% brings the threshold to ≈56k changes, so the statistics track the live distribution
-- again. The explicit threshold keeps an outlier first-insert from triggering an analyze on
-- a table too small for one to matter.
ALTER TABLE "run_event" SET (
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 1000
);
