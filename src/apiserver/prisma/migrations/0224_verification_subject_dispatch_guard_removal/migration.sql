-- Verification-subject dispatch guard removal.
--
-- 0207 installed three BEFORE triggers so that a task whose own completion criterion is
-- independent VERIFICATION could not acquire task-work in either transition order: two on
-- `session` (a task-work INSERT, and the UPDATE that revives one) and one on `task` (the shape
-- change that turns a task into such a subject while work is already live).
--
-- The rule they defended is not theirs. `taskStartOwnedByCompletion`
-- (`projects/task-aggregation.ts`) is the shared service door behind manual Run, batch Run,
-- session creation and retry; it reads `completion_criterion` and `verifies_task_id` under
-- `FOR SHARE OF t` in the same transaction that inserts the Session, which is the lock 0207's own
-- comment relied on. `manualRunnableTaskSql` carries the identical clause into every Ready
-- surface. 0207's header says what the triggers added on top of that: they "preserve it across
-- rolling deploys and raw writers" -- a second copy of an enforced rule, not the only copy.
--
-- Nothing else reads either function: no view, no other trigger body and no `$queryRaw` names
-- them, and the two error strings they raised (`TASK_VERIFICATION_SUBJECT` and
-- `TASK_VERIFICATION_SUBJECT_LIVE_SESSION`) had exactly one reader, the service translation table
-- that turned them into 409s. Those two entries go with this migration.
--
-- Deliberately NOT touched: `task_verification_subject_guard` (0130), which polices where a
-- `verifies_task_id` may point. It has a similar name and a different job, and it stays.
BEGIN;

DROP TRIGGER session_verification_subject_guard_insert ON session;
DROP TRIGGER session_verification_subject_guard_update ON session;
DROP TRIGGER task_verification_subject_live_session_guard ON task;

DROP FUNCTION session_verification_subject_guard();
DROP FUNCTION task_verification_subject_live_session_guard();

COMMIT;
