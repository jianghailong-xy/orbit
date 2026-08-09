-- The quota retry generalizes. A transient provider error ("API Error: 529 … overloaded_error")
-- is the same shape of failure as an exhausted quota — it says nothing about the work, and the
-- same message succeeds on a re-send — so one armed retry per session now serves both, and the
-- columns lose the `quota_` in their names.
--
-- A rename rather than add + backfill + drop: a deployment runs one apiserver (compose recreates
-- it), so there is no window in which an older replica writes the old names. Existing data
-- carries over untouched — an armed quota retry keeps both its moment and its attempt count.
ALTER TABLE "session" RENAME COLUMN "quota_retry_at" TO "retry_at";
ALTER TABLE "session" RENAME COLUMN "quota_retry_attempts" TO "retry_attempts";

-- Still the partial index created with the columns (armed rows only); only its name follows.
ALTER INDEX "session_quota_retry_at_idx" RENAME TO "session_retry_at_idx";
