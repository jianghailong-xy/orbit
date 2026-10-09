-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, server execution: a text Postgres cannot hold as it is — one with a NUL in it — is kept as
-- its bytes, and read back byte for byte: a file the read cache holds, and a model's answer to a call.
-- contracts/wiki.contract.json `repoOps.storedText` and `modelQueue.answerEncoding` are the authority for
-- everything below, docs/wiki-server-execution-design.md §5.2 and §7 the design, and
-- src/apiserver/src/wiki-worker/wiki-repo-op-nul.pg.spec.ts holds it to the contract.
--
-- WHY (2026-10-09)
-- ----------------
-- Postgres keeps no U+0000 in `text` or `jsonb`, and a source file can have one: three files on main
-- carry a raw NUL in a literal. In the canary on 2026-10-09 the read of one was refused with 22P05
-- ("unsupported Unicode escape sequence") and answered 500; the runner gave up after five tries and the
-- operation stayed running. A file's text that has a NUL is now kept as its UTF-8 bytes in base64, and
-- the cache reads it back to the text `git show` printed. The code a model is then shown carries the NUL,
-- and a model may copy it into its answer: the answer, and the partial a running call writes back, are
-- kept the same way, so a pipeline parses exactly what the model sent — as the runner path's does.
--
-- WHAT IS ADDED
-- -------------
--   wiki_repo_file.content_encoding       `text` (the content is the text as it is — every row there is,
--                                         and every file without a NUL) or `base64` (the text's UTF-8
--                                         bytes in base64). A CHECK holds it to the two, and `base64` to a
--                                         row that has a text (found or cut).
--   wiki_model_request.answer_encoding    the same two words for `answer`,
--   wiki_model_request.partial_encoding   and for `partial`, each held to the two by a CHECK.
--
-- Each is TEXT NOT NULL DEFAULT 'text', a constant default, so adding it rewrites no row and every row
-- already held reads exactly as before.
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- No row is written, backfilled or deleted, and no other column is altered. No function, trigger, type
-- or index is created, replaced or dropped; `task`, `session` and `task_list` are named nowhere below.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0412: main and this project's line stood at 0408_kimi_account when this was first written (2026-10-09)
-- and it took 0411, leaving 0409 and 0410 to a worktree on this host that held them; main then took
-- 0409 to 0411 (0411_retire_candidates_landed_by_receipt) before this landed, so it is 0412 — no origin
-- branch or worktree held a later number. Every statement can run twice: ADD COLUMN IF NOT EXISTS,
-- and each constraint added only when absent.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_repo_file" ADD COLUMN IF NOT EXISTS "content_encoding" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "wiki_model_request" ADD COLUMN IF NOT EXISTS "answer_encoding" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "wiki_model_request" ADD COLUMN IF NOT EXISTS "partial_encoding" TEXT NOT NULL DEFAULT 'text';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_repo_file_content_encoding_chk') THEN
    -- How the content is read back: as it is, or decoded from base64 to the bytes it was. Only a row
    -- that has a text has one to encode.
    ALTER TABLE "wiki_repo_file" ADD CONSTRAINT "wiki_repo_file_content_encoding_chk" CHECK (
      "content_encoding" = 'text' OR ("content_encoding" = 'base64' AND "state" IN ('found', 'cut')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_model_request_text_encoding_chk') THEN
    -- How the answer and the partial are read back: as they are, or decoded from base64.
    ALTER TABLE "wiki_model_request" ADD CONSTRAINT "wiki_model_request_text_encoding_chk" CHECK (
      "answer_encoding" IN ('text', 'base64') AND "partial_encoding" IN ('text', 'base64'));
  END IF;
END $$;
