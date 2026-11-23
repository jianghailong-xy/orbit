-- A session's runner reports that Codex's sandbox cannot start there (an Orbit Cloud runner whose
-- probe failed). Additive: every existing session keeps false, and its semantics stay as they are.
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "codex_sandbox_unavailable" BOOLEAN NOT NULL DEFAULT false;
