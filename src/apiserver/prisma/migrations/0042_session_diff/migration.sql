-- SessionDiff: on-demand per-file unified diffs of a session's worktree changes, kept in a
-- side table (1:1 with session) so the potentially large patch text never rides the session
-- detail/list payload — fetched only when a file's diff is opened (GET /sessions/:id/diff).
-- The runner upserts it each turn (live) and at completion (committed). `patches` is a
-- FilePatch[] ({ path, patch?, truncated? }). Cascades cleanup when its session is deleted.
CREATE TABLE "session_diff" (
    "session_id" UUID NOT NULL,
    "patches" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_diff_pkey" PRIMARY KEY ("session_id")
);

ALTER TABLE "session_diff" ADD CONSTRAINT "session_diff_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
