-- 0479 — the rest of the wiki chat's session (task C5): the three SOURCE CHECKs 0476 swapped NOT VALID,
-- validated, and `session_wiki_chat_space_idx` over (wiki_chat_space_id, created_at), which the chats read
-- of a space walks newest first. Partial, so the sessions that are no chat (all of them before 0476) are
-- not in it. schema.prisma cannot spell a partial index, so it lives here alone, as 0231's
-- `session_source_codebase_idx` does.
--
-- WHY A FILE OF ITS OWN
-- =====================
-- Both need a scan of `session`, the table every runner call reads. In 0476 they would scan under the
-- ACCESS EXCLUSIVE lock it takes, which `migrate deploy` keeps until that file ends: it sends a file
-- holding an anonymous PL/pgSQL block as one statement, one transaction. It sends a file without one, like
-- this, a statement at a time, each outside any transaction (drilled with this repo's Prisma 7.10 and the
-- server's statement log, task C5, 2026-11-06). That is what a concurrent index build needs, and it keeps
-- each lock to its own statement.
--
-- WHAT EACH STATEMENT LOCKS
-- =========================
--   - The three VALIDATE CONSTRAINTs scan `session` under SHARE UPDATE EXCLUSIVE. That mode conflicts with
--     DDL and VACUUM alone, so neither holding it nor waiting for it holds up a reader or a writer. Waiting
--     is therefore safe, and lock_timeout is lifted for this file. A wait behind an autovacuum or another
--     DDL is not what fails the migration. A retry loop would need a PL/pgSQL block, which would put the
--     index build below inside a transaction it cannot run in.
--   - DROP INDEX CONCURRENTLY IF EXISTS finds nothing on a first run. On a second run (after a concurrent
--     build that failed and left an INVALID index, or by hand) it drops what is there, so the build makes
--     it whole again. SHARE UPDATE EXCLUSIVE on `session`: reads and writes go on.
--   - The index is built CONCURRENTLY: SHARE UPDATE EXCLUSIVE on `session` through both of its scans, so
--     reads and writes go on, and SHARE, which would stop every write for the whole scan, is never taken.
--     It waits for transactions older than it to end, which blocks nobody, and a lock timeout there would
--     leave an INVALID index behind: one more reason lock_timeout is lifted.
--   - RESET lock_timeout gives the connection back the server's for what runs next.
-- statement_timeout (300 s) still bounds each statement. Every statement is safe to run twice.
--
-- IF IT FAILS
-- ===========
-- A statement here that passes statement_timeout in production (the concurrent build waiting on an old
-- snapshot, say) gets the migration recorded as failed, and every later deploy then stops on P3009 until an
-- operator acts:
--   prisma migrate resolve --rolled-back 0479_wiki_chat_session_checks_index
-- and then deploy again. That is safe: the VALIDATEs pass again, and the file drops the half-built INVALID
-- index before it builds it again (drilled: fail, resolve, deploy, and the index is valid).

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_kind_chk";

ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_kind_selector_chk";

ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_snapshot_chk";

DROP INDEX CONCURRENTLY IF EXISTS "session_wiki_chat_space_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_wiki_chat_space_idx"
  ON "session" ("wiki_chat_space_id", "created_at") WHERE "wiki_chat_space_id" IS NOT NULL;

RESET lock_timeout;
