-- Keep `task`'s visibility map fresh enough that counting a list stays an index-only scan.
--
-- Every per-list count (the sidebar's list index, the task page's aggregates) reads the whole
-- owner's tasks through an index and never touches the row bodies — but only while the heap pages
-- are marked all-visible. Any insert or update clears that bit, and Postgres then has to visit the
-- heap for each entry whose page it can't vouch for. Measured on this deployment at 110k tasks:
-- 56,581 heap fetches over a 194MB heap against 128MB of shared_buffers, which took a 50ms
-- aggregate to 194-407ms. Straight after a VACUUM the same query does 315 heap fetches and 366
-- buffer reads.
--
-- The defaults can't hold that here. autovacuum_vacuum_scale_factor of 0.2 waits for 20% of the
-- table (22k rows) to go dead, and a busy list PATCHes tasks faster than that threshold arrives,
-- so the map spends most of its life stale. 2% brings it to ~2k rows; with the map mostly intact
-- each pass only reads what changed since the last one, so the extra passes are cheap. The insert
-- variant matters for the same reason on the other side: a DAG lands tens of thousands of rows at
-- once and nothing about them is dead, so only the insert threshold will come clean up after it.
ALTER TABLE "task" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.02
);
