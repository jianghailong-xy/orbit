-- Denormalized set of a session's still-running background shells (Bash run_in_background).
-- Holds the tool_use ids of launches that haven't reported a terminal `<task-notification>`
-- yet: added on launch, removed on completion, cleared on (re)spawn/complete. Lets the
-- session list + header show "Background running" without scanning run_event. No backfill —
-- empty for existing sessions (only meaningful while a session is live anyway).
ALTER TABLE "session" ADD COLUMN "running_bg_shells" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
