-- 0770 — the session's Agent Tools report: what its engine was given from Orbit and took
-- (docs/orbit-agent-contract.md §2.7, task P1-03).
--
-- WHY
-- ===
-- A person could not see whether a session's agent actually had Orbit's tools: whether its engine
-- started Orbit's MCP server, which families of tools it lists and why one is missing, which
-- contract, catalogue and primer it runs under, and how Orbit's instructions reached it. The runner
-- learns it from the engine's own word (Claude Code's system/init frame, Codex's
-- mcpServer/startupStatus/updated) and sends it as a system event, subtype `agent_tools`, whenever
-- it changes. The ingest keeps the newest report here, so the session's Agent tools drawer reads it
-- with the session instead of paging run_event for it.
--
-- WHAT IT ADDS
-- ============
-- One nullable JSONB column, written by the event ingest in the same update that writes the
-- session's other event-derived columns. Nothing is backfilled and no existing row is rewritten:
-- null reads as "no report yet", which is what every session started before a runner that sends
-- one is, and what a session on an engine that reports no MCP connection stays.
--
-- BACKWARD COMPATIBLE
-- ===================
-- A nullable column with no default is a catalog change only: no table rewrite. Rolling the code
-- back leaves it in place, unread.
--
-- TAKING THE LOCK IN SHORT TRIES
-- ==============================
-- As 0478 does, for the same reason: `session` is the table every runner call reads, and an ALTER
-- waiting for its ACCESS EXCLUSIVE lock queues every later reader and writer behind it. The lock
-- is asked for 2 s at a time, with 1 s between tries in which everything else runs, up to 60
-- tries, in one DO statement. IF NOT EXISTS keeps a retried apply harmless.

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "agent_tools" JSONB;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 60 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
