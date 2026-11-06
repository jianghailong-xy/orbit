-- 0479 — the rest of the wiki chat session (task C5): the three SOURCE CHECKs that 0476 swapped NOT VALID,
-- validated, and the index session_wiki_chat_space_idx over (wiki_chat_space_id, created_at), which the
-- chats read of a space walks newest first. Partial, so the sessions that are no chat (all of them before
-- 0476) are not in it. schema.prisma cannot spell a partial index, so it lives here alone, as the index
-- session_source_codebase_idx of 0231 does.
--
-- WHY A FILE OF ITS OWN
-- =====================
-- Both need a scan of the session table, which every runner call reads. In 0476 they would scan under
-- the ACCESS EXCLUSIVE lock it takes, which migrate deploy keeps until that file ends. Prisma 7.10 of this
-- repo sends a migration a statement at a time, each outside any transaction, but only while it can read
-- every statement in the file. A file with one it cannot read goes to the server whole, as one statement
-- that PostgreSQL runs as one transaction: an anonymous PL/pgSQL block (0476), DROP INDEX CONCURRENTLY or
-- REINDEX CONCURRENTLY. It reads SET, RESET, VALIDATE CONSTRAINT, DROP INDEX and CREATE INDEX
-- CONCURRENTLY. All of that was drilled with the statement log of the server (task C5, 2026-11-06). One
-- statement at a time is what a concurrent index build needs, and it keeps each lock to its own
-- statement, so nothing in this file may be a statement the splitter cannot read.
--
-- WHAT EACH STATEMENT LOCKS
-- =========================
--   - DROP INDEX IF EXISTS, under a lock_timeout of 2 s, finds nothing on a first run and then takes no
--     lock. On a second run (after a concurrent build that failed and left an INVALID index, or by hand)
--     it drops what is there, so the build below makes it whole again. Dropping holds ACCESS EXCLUSIVE on
--     the table for an instant and asks for it for 2 s at most: a second run that cannot have it fails at
--     once with a lock timeout, queueing nobody for longer, and is simply run again. A loop of tries would
--     need a PL/pgSQL block, and the concurrent drop is a statement the splitter cannot read: either would
--     send the whole file as one transaction.
--   - The three VALIDATE CONSTRAINTs scan the table under SHARE UPDATE EXCLUSIVE. That mode conflicts
--     with DDL and VACUUM alone, so neither holding it nor waiting for it holds up a reader or a writer.
--     Waiting is therefore safe, and lock_timeout is lifted for them. A wait behind an autovacuum or
--     another DDL is not what fails the migration.
--   - The index is built CONCURRENTLY: SHARE UPDATE EXCLUSIVE on the table through both of its scans, so
--     reads and writes go on, and SHARE, which would stop every write for the whole scan, is never taken.
--     It waits for transactions older than it to end, which blocks nobody, and a lock timeout there would
--     leave an INVALID index behind: one more reason lock_timeout is lifted.
--   - RESET lock_timeout gives the connection back the setting of the server for what runs next.
-- statement_timeout (300 s) still bounds each statement. Every statement is safe to run twice.
--
-- IF IT FAILS
-- ===========
-- A statement here that passes statement_timeout in production (the concurrent build waiting on an old
-- snapshot, say) gets the migration recorded as failed, and every later deploy then stops on P3009 until
-- an operator acts:
--   prisma migrate resolve --rolled-back 0479_wiki_chat_session_checks_index
-- and then deploy again. That is safe: the VALIDATEs pass again, and the file drops the half-built
-- INVALID index before it builds it again (drilled: fail, resolve, deploy, and the index is valid).

SET lock_timeout = '2s';

DROP INDEX IF EXISTS "session_wiki_chat_space_idx";

SET lock_timeout = 0;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_kind_chk";

ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_kind_selector_chk";

ALTER TABLE "session" VALIDATE CONSTRAINT "session_source_snapshot_chk";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_wiki_chat_space_idx"
  ON "session" ("wiki_chat_space_id", "created_at") WHERE "wiki_chat_space_id" IS NOT NULL;

RESET lock_timeout;
