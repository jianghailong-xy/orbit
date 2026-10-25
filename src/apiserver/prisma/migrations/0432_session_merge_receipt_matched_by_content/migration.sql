-- 0432 — the owner's Done on a merge recovery whose check found the session already on origin.
--
-- WHAT CHANGES
-- ============
--   session_merge_receipt_result_check   0128 froze four results: MERGED (the target moved and contains the
--                                        source), ALREADY_MERGED (it already contained it — by ancestry),
--                                        CONFLICT and ERROR. A check that answers ALREADY_LANDED found every one
--                                        of the session's commits on origin/<target> as OTHER commits with the
--                                        same patch-id (a rebase copy, a cherry-pick), and the owner's Done
--                                        records that as a fifth result: MATCHED_BY_CONTENT. Restated with it.
--
-- Not a landed result. Its source sha is not an ancestor of the target, so every reader that takes MERGED and
-- ALREADY_MERGED as landed — dependency closures, a criterion's landing, promotion retirement, 0152's checkpoint
-- trigger — keeps naming those two and does not read it. Only the merge dispatch gate does, for a merge of the
-- same source into the same target (S3 of the merge-recovery repair loop, project 34hIv3wbdtsxpc5RzDlOk;
-- src/apiserver/src/sessions/merge-recovery-done.pg.spec.ts holds it).
--
-- WHAT IS NOT TOUCHED
-- ===================
-- No row is written, backfilled or locked beyond what the CHECK's validation reads: every stored receipt holds
-- one of 0128's four results, which the restated CHECK admits as 0128's did. No table, column, index, trigger,
-- function or type is created, replaced or dropped; `session_merge_receipt` is the only table named, and `task`,
-- `session`, `project` and the DONE fence are named nowhere below.
--
-- NUMBERING, RE-RUNNABILITY
-- =========================
-- 0432: the highest number on main was 0430 (0430_managed_runner_backend), and 0431 was held by this project's
-- branch (0431_session_merge_repair_turn_ended_at), with no pushed origin/orbit/* branch or session worktree
-- holding 0432, when this was written (2026-10-19). The statement can run twice: the CHECK is replaced only
-- while it does not read MATCHED_BY_CONTENT yet.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'session_merge_receipt_result_check' AND pg_get_constraintdef(oid) LIKE '%MATCHED_BY_CONTENT%'
  ) THEN
    ALTER TABLE "session_merge_receipt" DROP CONSTRAINT IF EXISTS "session_merge_receipt_result_check";
    -- What happened: 0128's four, and the owner's confirmation that the target carries the work by content.
    ALTER TABLE "session_merge_receipt" ADD CONSTRAINT "session_merge_receipt_result_check"
      CHECK ("result" IN ('MERGED', 'ALREADY_MERGED', 'CONFLICT', 'ERROR', 'MATCHED_BY_CONTENT'));
  END IF;
END $$;
