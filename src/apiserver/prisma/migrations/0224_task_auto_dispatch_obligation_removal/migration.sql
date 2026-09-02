-- Remove the automatic-dispatch OBLIGATION framework installed by
-- 0205_task_auto_dispatch_obligation.
--
-- What 0205 built was not automatic dispatch. It was the durable, typed EXPLANATION of why an
-- automatic dispatch had not happened yet: five relations, an atomic recorder and a persistent
-- retry clock, whose product was an `AUTO_DISPATCH_BLOCKED` fact carrying a reason code, an owner,
-- a next action and a wake instant. Dispatch itself is elsewhere and is untouched by this
-- migration: the auto-run sweep's candidate SQL, `execute()`, the `task_dispatch_epoch` fence and
-- the `task_run_request` idempotency claim all remain exactly as they were. A task whose
-- prerequisites are DONE still starts by itself; a held task is still held; a manual start still
-- works. What no longer exists is the record of the attempt that did not.
--
-- The reason that framework existed to carry -- OWNER_RATIFICATION_REQUIRED, a task stopped for a
-- day until the account owner ratified it -- went with 0218. The two functions that read these
-- relations went with it (`project_owner_ratification_blockers`, 0218) and with 0223
-- (`project_owner_decide_criteria_proposal`), so nothing in the standing schema reads them.
--
-- WHAT IS LOST, STATED RATHER THAN ARCHIVED
-- 273 rows across the five relations disappear with them: the first observation of each dispatch
-- watermark, the immutable reason/binding revisions, the current per-watermark projection, the
-- append-only transition trace and the pending wakeups. They are operational observations about
-- dispatch attempts that have already resolved, not account records -- no task, session, project
-- or acceptance row is reachable from here, every foreign key points outward, and `dispatch_attempt`
-- on `task` (0122) keeps the only count anything else reads. Copying them into an archive relation
-- would preserve a vocabulary nothing can interpret once the recorder is gone, so they are dropped.
--
-- Order is dependency order rather than CASCADE, so the drop asserts the shape it expects: the
-- wakeup and the state both point at the obligation revision, and every one of the five points at
-- `task`, `user`, `project` or `session`, none of which is touched here.

BEGIN;

DROP FUNCTION IF EXISTS task_auto_dispatch_reconcile_sessions();
DROP FUNCTION IF EXISTS task_auto_dispatch_record(UUID, UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, UUID, TIMESTAMPTZ);

DROP TABLE IF EXISTS "task_auto_dispatch_event";
DROP TABLE IF EXISTS "task_auto_dispatch_wakeup";
DROP TABLE IF EXISTS "task_auto_dispatch_state";
DROP TABLE IF EXISTS "task_auto_dispatch_obligation_revision";
DROP TABLE IF EXISTS "task_auto_dispatch_attempt";

COMMIT;
