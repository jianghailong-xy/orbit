-- Why a session ended, orthogonal to `status` (which collapses every graceful end to
-- CANCELLED). Lets the UI tell "recycled after inactivity" (resumable) apart from a
-- genuine cancel. Set by the path that requests the end; left untouched by the runner's
-- async /complete. NULL = a natural agent finish (read `status`) or a pre-migration row.
-- Values: see SessionEndReason in @orbit/shared.
ALTER TABLE "session" ADD COLUMN "end_reason" TEXT;
