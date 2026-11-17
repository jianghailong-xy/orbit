-- 0990 — a new runner keeps 10 GB free by default.
--
-- Keep Free (runner.min_free_disk_mb) used to start Off (NULL) on every runner, so a fresh machine took work until
-- its disk was full. A newly registered runner now starts at 10 GB, the smallest tier the runner page offers. Rows
-- that exist are left as they are: NULL there may be an owner's choice of Off, which this cannot tell from never set.
-- A managed runner is still created with NULL on purpose: its floor then defaults to a share of its volume.
ALTER TABLE "runner" ALTER COLUMN "min_free_disk_mb" SET DEFAULT 10240;
