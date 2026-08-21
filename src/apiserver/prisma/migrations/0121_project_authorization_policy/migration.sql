-- Agent-owned Project authorization inputs. All defaults are inert: the migration neither enables
-- a Project nor invents a Provider fallback for an existing Agent.
ALTER TABLE "workspace"
  ADD COLUMN "provider_fallbacks" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "can_create_tasks" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "can_delegate" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "max_concurrent_tasks" INTEGER;

ALTER TABLE "workspace"
  ADD CONSTRAINT "workspace_provider_fallbacks_array"
    CHECK (jsonb_typeof("provider_fallbacks") = 'array'),
  ADD CONSTRAINT "workspace_max_concurrent_tasks_positive"
    CHECK ("max_concurrent_tasks" IS NULL OR "max_concurrent_tasks" > 0);

COMMENT ON COLUMN "workspace"."provider_fallbacks" IS
  'Explicit ordered Project-dispatch fallback [{provider,model?}]; empty forbids fallback.';
COMMENT ON COLUMN "workspace"."max_concurrent_tasks" IS
  'Optional admission cap for this Agent''s Project task sessions; NULL means no Agent cap.';
