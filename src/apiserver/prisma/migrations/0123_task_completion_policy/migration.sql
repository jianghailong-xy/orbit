-- Parent task aggregation (contract AC7 / §13.1).
--
-- Two columns and one CHECK. Both columns are added with a default that reproduces the behaviour
-- every existing row already has, because the one outcome this migration must not have is a task
-- completing itself the moment it is applied: MANUAL never aggregates, and a NULL verdict is
-- read fail-closed by VERIFICATION_PASSED. There is no backfill for the same reason — inferring a
-- policy from a shape ("this one has children, it probably meant ALL_CHILDREN_DONE") would decide
-- on the user's behalf that a roll-up node is now allowed to close itself.

CREATE TYPE "task_completion_policy" AS ENUM ('MANUAL', 'ALL_CHILDREN_DONE', 'VERIFICATION_PASSED');
CREATE TYPE "task_verdict" AS ENUM ('PASS', 'FAIL', 'INCONCLUSIVE');

ALTER TABLE "task"
  ADD COLUMN "completion_policy" "task_completion_policy" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "verdict" "task_verdict";

-- A verdict is a claim ABOUT another task, so a row that names no subject cannot hold one. Spelled
-- as a constraint rather than as service-layer validation because the write paths that can reach
-- this column are not all in one service, and a verdict on a non-verification row would be read by
-- aggregation as evidence that does not belong to anything.
ALTER TABLE "task"
  ADD CONSTRAINT "task_verdict_requires_subject"
  CHECK ("verdict" IS NULL OR "verifies_task_id" IS NOT NULL);
