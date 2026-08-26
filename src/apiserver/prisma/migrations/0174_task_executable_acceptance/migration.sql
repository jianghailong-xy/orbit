-- L0 executable acceptance lives on the Task it settles: exactly one command and one expected
-- exit code. NULL/NULL preserves every existing task's behaviour. A second command belongs in a
-- second task, so there is deliberately no child table, JSON shape, DSL, or branch operator here.
-- The pair is L0, so it cannot coexist with an aggregate L1 completion policy or make a verifier
-- judge itself; the service gives those constraint failures a readable API error.
ALTER TABLE "task"
  ADD COLUMN "acceptance_command" text,
  ADD COLUMN "acceptance_expected_exit_code" integer;

ALTER TABLE "task"
  ADD CONSTRAINT "task_executable_acceptance_pair"
  CHECK (
    ("acceptance_command" IS NULL AND "acceptance_expected_exit_code" IS NULL)
    OR
    ("acceptance_command" IS NOT NULL
      AND btrim("acceptance_command") <> ''
      AND "acceptance_expected_exit_code" IS NOT NULL
      AND "completion_policy" = 'MANUAL'
      AND "verifies_task_id" IS NULL)
  );

COMMENT ON COLUMN "task"."acceptance_command" IS
  'The one L0 acceptance command executed in the task session; NULL means no executable acceptance.';
COMMENT ON COLUMN "task"."acceptance_expected_exit_code" IS
  'The exit code that mechanically derives DONE; any other exit code derives FAILED.';
