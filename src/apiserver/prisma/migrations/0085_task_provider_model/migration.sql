-- A task's runs inherited their provider and model from the assignee agent, so pointing one task
-- at a different model meant either editing the agent (which moves every other task with it) or
-- keeping a duplicate agent per model. These two columns pin the choice on the task itself.
--
-- Nullable with no default, so nothing changes for existing rows and an older replica that never
-- writes them keeps dispatching exactly as before: NULL means "inherit from the assignee".
ALTER TABLE "task" ADD COLUMN "provider" TEXT;
ALTER TABLE "task" ADD COLUMN "model" TEXT;
