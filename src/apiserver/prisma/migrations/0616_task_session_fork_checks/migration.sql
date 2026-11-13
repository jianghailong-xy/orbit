-- 0616 — the rest of 0615 (task session fork): the five CHECKs it added NOT VALID, validated.
--
-- A file of its own for the reason 0479 gives: each VALIDATE scans its table, and inside 0615's single
-- transaction it would scan under the ACCESS EXCLUSIVE lock that file holds to its end. Here, with no DO
-- block, Prisma sends the statements one at a time, outside any transaction, and VALIDATE CONSTRAINT takes
-- SHARE UPDATE EXCLUSIVE, which conflicts with DDL and VACUUM alone: neither holding it nor waiting for it
-- holds up a reader or a writer, so lock_timeout is lifted for them. statement_timeout still bounds each.
-- Every statement is safe to run twice.
--
-- IF IT FAILS: `prisma migrate resolve --rolled-back 0616_task_session_fork_checks`, then deploy again.

SET lock_timeout = 0;

ALTER TABLE "task" VALIDATE CONSTRAINT "task_fork_shape_chk";

ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_kind_chk";

ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_kind_selector_chk";

ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_snapshot_chk";

ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_refusal_code_chk";

RESET lock_timeout;
