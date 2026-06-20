-- A genuine run failure (e.g. an API/content-filter error the agent couldn't recover
-- from) parks the task here so it surfaces for a human, instead of silently sitting at
-- IN_PROGRESS with nothing running. Distinct from OPEN, which the reclaim backstop keeps
-- using for retryable infra hiccups / user cancels.
ALTER TYPE "task_status" ADD VALUE IF NOT EXISTS 'FAILED';
