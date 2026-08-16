-- The second grouping axis for tasks. See Task.labels for why it is an array column and not a
-- tag table, and why it carries no authority over how a task runs.

ALTER TABLE "task" ADD COLUMN "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Lift the labels agents were already writing, for lack of anywhere else to put them.
--
-- This deployment's pipeline titles look like `[FineWeb][CC-MAIN-2017-34] 002_00030.parquet`.
-- The first bracket is the stage, which is exactly what its list already says (each of the four
-- stage lists holds 27,468 tasks, all of one stage) — copying it here would store the same fact
-- twice and let the two disagree. The second is the Common Crawl snapshot, and that one has no
-- home: all 110 distinct values span all four lists, so no single-parent column can express it,
-- and it survived in the title only because a string is the one field nobody validates.
--
-- Narrow on purpose. This is a one-time lift of one deployment's existing convention, not a
-- general title parser: a task whose title merely mentions a snapshot in prose is not thereby
-- labelled with it, and every task filed after this migration carries the labels its creator
-- passed. 109,873 of 110,421 rows match.
UPDATE "task"
SET "labels" = ARRAY[substring("title" from '\[(CC-MAIN-[0-9]{4}-[0-9]{2})\]')]
WHERE "title" ~ '\[CC-MAIN-[0-9]{4}-[0-9]{2}\]';

-- Containment (`labels @> ARRAY[...]`) is the only shape the filter uses, which is the default
-- array_ops GIN operator class. Empty arrays index no entries, so the tasks that carry no label
-- cost the index nothing — it stays sized to the labelled subset rather than to the table.
CREATE INDEX "task_labels_gin" ON "task" USING gin ("labels");

-- The backfill above rewrites ~110k rows, which clears the visibility map that 0105 exists to
-- keep intact. Left to autovacuum deliberately: 0105 set the scale factor to 2% (~2.2k rows), so
-- the next pass is due almost immediately, and VACUUM cannot run inside a migration's transaction
-- anyway. The window where per-list counts do extra heap fetches is one autovacuum cycle long.
