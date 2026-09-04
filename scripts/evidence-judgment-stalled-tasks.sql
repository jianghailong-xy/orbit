-- The stalled EVIDENCE_JUDGMENT inventory, as one query you can run on a production snapshot.
--
--   psql "$DATABASE_URL" -f scripts/evidence-judgment-stalled-tasks.sql
--
-- ONE ROW PER TASK that declares `EVIDENCE_JUDGMENT` and has not stopped — `status` OPEN or
-- IN_PROGRESS. Run against the production database on 2026-09-04 it returned 233 rows: 226 of them
-- MANUAL, 214 of them with no subtasks, and none of them declaring a project criterion.
--
-- Why they are worth listing. `evaluateTaskCompletion` answers UNSATISFIED for EVIDENCE_JUDGMENT
-- unconditionally (src/apiserver/src/tasks/task-completion-criterion.ts): migration
-- 0228_task_judgment_removal took the decision door away and nothing rebuilt it, so the criterion
-- these tasks declared cannot currently be met. Nothing here repairs that, and nothing here is
-- allowed to: rewriting them to VERIFICATION would conjure a verification task per row, and
-- CANCELLED would abandon their holders' work on their behalf. Both are the holder's decision.
-- This query exists so that decision can be made from a list instead of from a guess.
--
-- THE COLUMNS
-- ===========
--   task_id, title          — who this is.
--   completion_policy       — the only other route a task has to DONE, read together with the next
--                             column. AG4 (src/apiserver/src/projects/task-aggregation.ts): "A
--                             policy on a childless task is inert", and for these rows the second
--                             half of that condition — an explicit VERIFICATION criterion — is
--                             false by construction. So a row with no subtasks has no route at all,
--                             whatever its policy says, and MANUAL has none even with subtasks.
--                             `has_subtasks = false` is therefore the structurally stalled mark;
--                             on 2026-09-04 it held for 214 of the 233.
--   has_subtasks            — whether any task names this one as its parent.
--   declares_criterion      — whether `criterion_definition_id` is set: whether this work said
--                             which of its project's acceptance criteria it serves.
--   holds_up_criterion      — the criterion it said that about, resolved through the live foreign
--                             key rather than reprinted from the task row. Non-null exactly when
--                             `declares_criterion`, because migration 0232 made that edge ON DELETE
--                             SET NULL: a criterion that has since been deleted leaves the id null
--                             and the revision behind, which for this report reads the same as
--                             never having declared one.
--
-- The last column is what makes the count more than an inbox. The `criterionSatisfaction` fold
-- asks of every serving task "has it settled BY ITS OWN DECLARED CRITERION", and its
-- `servingTaskSettled` answers false for EVIDENCE_JUDGMENT for the same reason as above. Every row
-- here that names a criterion is therefore also, right now, one of that criterion's
-- `SERVING_WORK_UNSETTLED` blockers — a project-level clause that cannot come true until this
-- row's holder acts on it.
--
-- Those two are named by symbol and not by path on purpose, and the omission is load-bearing: that
-- module's own spec asserts, by scanning `src/` and `scripts/` for its file name, that it has
-- exactly one reader. Spelling the path here reads to that scan as a second consumer and turns it
-- red. Grep for the symbol.
--
-- On 2026-09-04 that column is empty for all 233, and the reason is worth knowing before reading
-- it as good news: `criterion_definition_id` arrived with migration 0232 the same day, which
-- backfilled nothing ("没有回填，也不可能有" — the key these tasks were filed under was never
-- stored, so there is nothing to reconstruct it from). Only 9 tasks on the whole database carry a
-- declaration and all 9 are EXECUTABLE. So today the stall is contained to the tasks themselves;
-- this column is what will show it spreading to a project's stated criteria as new
-- EVIDENCE_JUDGMENT work is filed with a `criterionKey`.
--
-- Read-only: no writes, no locks beyond an ordinary MVCC snapshot. Safe on a live primary.

SELECT t."id"                      AS task_id,
       t."title"                   AS title,
       t."completion_policy"::text AS completion_policy,
       EXISTS (
         SELECT 1 FROM "task" c WHERE c."parent_task_id" = t."id"
       )                           AS has_subtasks,
       t."criterion_definition_id" IS NOT NULL
                                   AS declares_criterion,
       CASE
         WHEN d."id" IS NULL THEN NULL
         ELSE format('%s ordinal=%s revision=%s', d."id", d."ordinal", d."revision")
       END                         AS holds_up_criterion
  FROM "task" t
  LEFT JOIN "project_acceptance_criterion_definition" d
    ON d."id" = t."criterion_definition_id"
 WHERE t."completion_criterion" = 'EVIDENCE_JUDGMENT'
   AND t."status" IN ('OPEN', 'IN_PROGRESS')
 ORDER BY t."created_at", t."id";
