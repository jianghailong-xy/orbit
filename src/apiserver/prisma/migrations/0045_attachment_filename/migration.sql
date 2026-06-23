-- Original upload filename, so the runner can write a non-image/-PDF upload to the
-- worktree under its real name and tell claude where to read it. Nullable: legacy rows
-- and pasted screenshots (handled as inline image blocks) carry no name.
ALTER TABLE "attachment" ADD COLUMN "file_name" TEXT;
