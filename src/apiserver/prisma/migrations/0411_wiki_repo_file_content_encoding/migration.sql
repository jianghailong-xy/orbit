-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, server execution: the read cache keeps a file byte for byte, a NUL in it included.
-- contracts/wiki.contract.json `repoOps.storedText` is the authority for everything below,
-- docs/wiki-server-execution-design.md §7 is the design, and
-- src/apiserver/src/wiki-worker/wiki-repo-op-nul.pg.spec.ts holds it to the contract.
--
-- WHY (2026-10-09)
-- ----------------
-- Postgres keeps no U+0000 in `text` or `jsonb`, and a source file can have one: three files on main
-- carry a raw NUL in a literal. In the canary on 2026-10-09 the read of one was refused with 22P05
-- ("unsupported Unicode escape sequence") and answered 500; the runner gave up after five tries and the
-- operation stayed running. A file's text that has a NUL is now kept as its UTF-8 bytes in base64, and
-- the cache reads it back to the text `git show` printed — so the column has to say which a row is.
--
-- WHAT IS ADDED
-- -------------
--   wiki_repo_file.content_encoding   `text` (the content is the text as it is — every row there is,
--                                     and every file without a NUL) or `base64` (the content is the
--                                     text's UTF-8 bytes in base64). NOT NULL DEFAULT 'text', a
--                                     constant default, so adding it rewrites no row and every row
--                                     already held reads exactly as before. A CHECK holds it to the
--                                     two, and `base64` to a row that has a text (found or cut).
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- No row is written, backfilled or deleted, and no other table or column is altered. No function,
-- trigger, type or index is created, replaced or dropped; `task`, `session` and `task_list` are named
-- nowhere below.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0411: main and this project's line stood at 0408_kimi_account when this was written (2026-10-09),
-- no origin branch held a later number, and one worktree on this host held 0409 and 0410 (a branch not
-- yet pushed), so 0409 and 0410 are left to it. Every statement can run twice: ADD COLUMN IF NOT EXISTS,
-- and the constraint added only when absent.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_repo_file" ADD COLUMN IF NOT EXISTS "content_encoding" TEXT NOT NULL DEFAULT 'text';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_repo_file_content_encoding_chk') THEN
    -- How the content is read back: as it is, or decoded from base64 to the bytes it was. Only a row
    -- that has a text has one to encode.
    ALTER TABLE "wiki_repo_file" ADD CONSTRAINT "wiki_repo_file_content_encoding_chk" CHECK (
      "content_encoding" = 'text' OR ("content_encoding" = 'base64' AND "state" IN ('found', 'cut')));
  END IF;
END $$;
