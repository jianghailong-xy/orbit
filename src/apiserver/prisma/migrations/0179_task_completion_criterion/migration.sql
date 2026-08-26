-- A task always names exactly one ordinary completion criterion. The constant PostgreSQL default
-- gives every existing row HUMAN_SIGNOFF through attmissingval without rewriting the table; no
-- status is changed and no historical task is treated as an executable/verification escalation.
CREATE TYPE "task_completion_criterion" AS ENUM (
  'EXECUTABLE',
  'VERIFICATION',
  'HUMAN_SIGNOFF'
);

ALTER TABLE "task"
  ADD COLUMN "completion_criterion" "task_completion_criterion"
  NOT NULL DEFAULT 'HUMAN_SIGNOFF';
