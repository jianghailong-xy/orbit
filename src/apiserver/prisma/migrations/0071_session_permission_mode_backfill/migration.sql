-- Sessions created without an explicit permission mode (MCP spawns, task runs) stored NULL.
-- The claim already resolves session ?? agent ?? 'dontAsk', so these rows really run with
-- their agent's mode — but every client's Mode pill reads NULL as "Don't Ask" and writes that
-- back on the next resume, silently downgrading the session. Materialize the mode the runner
-- is already using so the row matches reality. Sessions with no agent keep NULL (still
-- 'dontAsk' at claim time).
UPDATE "session" s
SET "permission_mode" = a."permission_mode"
FROM "agent" a
WHERE s."agent_id" = a."id" AND s."permission_mode" IS NULL;
