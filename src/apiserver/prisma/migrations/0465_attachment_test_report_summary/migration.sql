-- 0465 — What a test report said (docs/orbit-files-design.md §2.5): the counts, duration and failed and skipped names
-- `file_upload --as test-report` reads out of the file (files/test-report.ts). Metadata beside the file's name and size,
-- so it stays when the retention rules expire the bytes (§2.8), which keep the row.
--
-- Nullable with no default, so the ADD is catalog-only: no row is rewritten and every existing row reads as before.
--
-- 0465: the next number free on main and on every ref of this repository (2026-11-02; main and the Orbit Files project
-- line end at 0464, and no other worktree holds a later one).

ALTER TABLE "attachment" ADD COLUMN "test_report_summary" JSONB;
