-- The rollback of 0259, in the reverse order. Prisma does not read this file (it only reads
-- `migration.sql`); it is here so the rollback is a script somebody reviewed rather than a
-- sentence in a runbook. Like `migration.sql` it carries its own transaction and is re-runnable.
--
-- WHAT IS LOST: every Watch, every target in its frozen snapshot, every Match it recorded and
-- every Delivery of one. None of it is rebuildable — a Match is a statement about a moment that
-- has passed, and re-evaluating afterwards answers a different question about a different world.
-- So decide before running this whether what is being withdrawn is the CODE that writes these
-- rows, or the rows as well. Withdrawing only the code needs nothing from this file: 0259 adds no
-- column to any existing table, so a build that knows nothing about Watch runs unchanged against
-- a database that still has these four tables.
--
-- WHAT IS NOT LOST: nothing outside these four tables. 0259 created no trigger, no function and
-- no enum type, and altered no existing relation, so there is nothing here to restore and no
-- other table can notice this ran. `user` and `session` are referenced BY the dropped tables —
-- being pointed at is not being written, and dropping the pointer leaves the target untouched.
--
-- Indexes and constraints are not dropped by name: they belong to these tables and go with them.

BEGIN;

-- Children first, though CASCADE-free DROPs in this order need no help: `watch_delivery`
-- references `watch_match`, which references `watch`, and `watch_target` references `watch`.
DROP TABLE IF EXISTS "watch_delivery";
DROP TABLE IF EXISTS "watch_match";
DROP TABLE IF EXISTS "watch_target";
DROP TABLE IF EXISTS "watch";

COMMIT;
