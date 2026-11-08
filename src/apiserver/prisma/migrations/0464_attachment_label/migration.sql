-- 0464 — What an uploaded file is (docs/orbit-files-design.md §2.3): the optional `label` `file_upload` takes for a
-- file or a folder bundle, in the caller's own words, beside `file_name`, which only says what it was called.
--
-- Nullable with no default, so the ADD is catalog-only: no row is rewritten and every existing row reads as before.
--
-- 0464: the next number free on main and on every ref of this repository (2026-11-02; main ends at 0463, and no other
-- worktree holds a later one).

ALTER TABLE "attachment" ADD COLUMN "label" TEXT;
