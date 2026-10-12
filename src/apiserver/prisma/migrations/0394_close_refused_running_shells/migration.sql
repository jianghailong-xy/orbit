-- The runs a SOURCE refusal left RUNNING, closed once, by the deploy that stops producing them.
--
-- WHY THIS EXISTS
-- ===============
-- §6.3 step 3's refusal door (POST /runner/sessions/:id/source/pin) froze `source_state = 'REFUSED'`
-- onto the session and said nothing else. The run it refused was left RUNNING with `num_turns` 0 and
-- its claim still held (`run_claimed_at`, `inbox_lease_owner`), so the row read "Starting" forever,
-- `task_start` answered 409 TASK_ALREADY_RUNNING, and nothing that watches for a sick row saw it:
-- session 2PLgNAQaH00wZ56CN8J03M (2026-10-07) sat that way from 07:45 until a person went looking.
-- `freezeSessionSourcePin` (src/apiserver/src/projects/session-source.ts) now closes the run in the
-- transaction that freezes the refusal; this file is the other half, for the rows that already
-- crossed that moment and can never cross it again — REFUSED is terminal and nothing re-resolves it
-- (SR34). Historical-row repair, the shape 0077_task_done_sessions_completed has.
--
-- ONE ROW SET, THREE WRITES, ONE PREDICATE
-- ========================================
-- All three statements below are scoped to the same set: a session that is `source_state =
-- 'REFUSED' AND status = 'RUNNING'` with `run_claimed_at` still set — the shell exactly as the old
-- code left it, and the only thing that made it read as a live run. That predicate matches NOTHING
-- once this file has run, which is what makes re-applying it (a re-deploy, a hand re-run) a no-op
-- rather than a second repair; the blocker insert is additionally fenced by 0125's partial unique
-- index on open rows. The order is: retire the tombstone, raise the project's item, then close the
-- session — the last one is the only write that changes what the predicate sees, so the other two
-- have to be stated against the shell rather than against the row this file leaves behind.
-- (A session already FAILED by another path — a reaper that found the runner gone — is NOT in this
-- set: its project was told nothing then either, but it is not the shell this repair is for, and
-- raising stale items for months-old rows is somebody else's decision to make.)
--
-- WHAT EACH WRITE IS, AND WHY THOSE COLUMNS
-- =========================================
--   * `status` FAILED, `finished_at`, and `error` as `<code>: <reason>` — the runner's own words,
--     with the precedence `refusalReason` reads (`stderr`, then `reason`, then its own sentence), so
--     the row reads exactly like a run the runner refused at its checkout;
--   * the claim released: `run_claimed_at` and `inbox_lease_owner` cleared, the dead run's work
--     cleared (CLEARED_RUNNING_WORK), and the inbox lease generation retired rather than unset — the
--     session keeps pointing at its tombstone, so a later revive can still prove the prior engine is
--     gone;
--   * the project's SOURCE_UNRESOLVED exception item (SR50 / docs/project-source-contract.md §10.3),
--     for every shell whose task is in a project, one row per (project, ref, code).
--
-- TWO SENTENCES ARE SPELLED HERE, AND WHY
-- =======================================
-- A migration cannot call `refusalReason` or `dispatchRefusalNextStep` (projects/session-source.ts,
-- tasks/task-dispatch-refusal.ts), so the one fallback reason and the item's one executable sentence
-- are written in SQL. They use the same vocabulary the live path does — the refusal code, and the
-- `fixAction` the session's own `source_refusal_detail` froze at refusal time, which travel in the
-- item's `detail`. The sentence is deliberately SHORT: a second long copy of the live prose is a
-- second copy free to drift, and the task's own timeline, written when the refusal happened, still
-- carries the full next step.

-- ---------------------------------------------------------------------------------------------
-- 1. The lease generations those runs held. `retireSessionInboxGeneration`'s own predicate (the
--    session must be terminal) is what the live path uses to be sure it is looking at a finished
--    run; here the session IS the shell this file is about, identified by the one predicate above,
--    and `COALESCE` keeps the FIRST retirement if anything ever wrote one.
-- ---------------------------------------------------------------------------------------------
UPDATE "inbox_lease_generation" AS g
   SET "retired_at" = COALESCE(g."retired_at", timezone('UTC', now()))
  FROM "session" AS s
 WHERE s."id" = g."session_id"
   AND g."generation" = s."inbox_lease_generation"
   AND s."source_state" = 'REFUSED'
   AND s."status" = 'RUNNING'
   AND s."run_claimed_at" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. The projects those runs stopped — SR50's kind, at the landing place 0231 declared for it
--    (`project_blocker_kind_chk`). One row per (project, ref, code): the two facts a person has to
--    change. `detail.taskIds` names the task this row was opened for, and `dedupe_key` is the key
--    the live path builds, so a later refusal on the same line finds this row already open instead
--    of raising a second one.
-- ---------------------------------------------------------------------------------------------
WITH shells AS (
  SELECT s."task_id", s."source_ref", s."source_refusal_code", s."source_refusal_detail",
         t."project_id",
         -- The key and the payload, computed once: the insert needs the payload twice (the column
         -- and the digest over it), and two spellings of one jsonb is one place for them to differ.
         'SOURCE_UNRESOLVED:' || s."source_refusal_code" || ':' || COALESCE(s."source_ref", '') AS dedupe_key,
         jsonb_build_object(
           'code', s."source_refusal_code",
           'fixAction', s."source_refusal_detail" ->> 'fixAction',
           'ref', s."source_ref",
           'taskIds', jsonb_build_array(s."task_id"::text)
         ) AS detail
    FROM "session" AS s
    JOIN "task" AS t ON t."id" = s."task_id"
   WHERE s."source_state" = 'REFUSED'
     AND s."status" = 'RUNNING'
     AND s."run_claimed_at" IS NOT NULL
     AND s."source_refusal_code" IS NOT NULL
     AND t."project_id" IS NOT NULL
)
INSERT INTO "project_blocker" (
  "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
  "next_check_at", "subject_type", "subject_id", "detail", "dedupe_key",
  "lifecycle_generation", "condition_version", "first_seen_at", "last_seen_at", "updated_at"
)
SELECT gen_random_uuid(), shell."project_id", 'SOURCE_UNRESOLVED',
       'USER'::"project_blocker_owner", 'HUMAN'::"project_blocker_recovery",
       'CRITICAL'::"project_blocker_severity",
       '这次开工在解析它起跑用的线时被拒（拒绝码 ' || shell."source_refusal_code" || '）：'
         || '先按 detail.fixAction 修好项目绑定，或者把那条 ref 建出来，再重新开工。'
         || '在那之前重新开工只会得到同一个拒绝。',
       timezone('UTC', now() + interval '30 minutes'),
       'PROJECT', shell."project_id"::text, shell."detail", shell."dedupe_key",
       (SELECT COALESCE(MAX(b."lifecycle_generation"), 0) + 1
          FROM "project_blocker" AS b
         WHERE b."project_id" = shell."project_id"
           AND b."dedupe_key" = shell."dedupe_key"),
       encode(digest(shell."detail"::text, 'sha256'), 'hex'),
       timezone('UTC', now()), timezone('UTC', now()), timezone('UTC', now())
  FROM shells AS shell
ON CONFLICT ("project_id", "dedupe_key") WHERE "resolved_at" IS NULL DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 3. The sessions themselves.
-- ---------------------------------------------------------------------------------------------
UPDATE "session" AS s
   SET "status" = 'FAILED',
       -- `<code>: <reason>`: the shape `readDispatchRefusal` reads back out of a run's last words.
       "error" = s."source_refusal_code" || ': ' || COALESCE(
         NULLIF(BTRIM(s."source_refusal_detail" ->> 'stderr'), ''),
         NULLIF(BTRIM(s."source_refusal_detail" ->> 'reason'), ''),
         'runner 没有给出原话（只报了拒绝码）。'
       ),
       "finished_at" = timezone('UTC', now()),
       "run_claimed_at" = NULL,
       "inbox_lease_owner" = NULL,
       "running_bg_shells" = '{}',
       "running_bg_jobs" = '{}',
       "running_bg_job_activity" = '{}',
       "running_subagents" = '{}',
       "updated_at" = timezone('UTC', now())
 WHERE s."source_state" = 'REFUSED'
   AND s."status" = 'RUNNING'
   AND s."run_claimed_at" IS NOT NULL;
