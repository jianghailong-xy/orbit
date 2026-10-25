-- 0441 — the project list classifies only the tasks whose lane their status may not decide.
--
-- `GET /projects` (project-list-rollup.ts) counts every task of every project into seven lanes with
-- the shared classifier (project-task-work-state.ts). 0395 made the scan of those tasks index-only,
-- and the statement still cost 400–480 ms on production (2026-10-19), because the classifier ran on
-- every one of the owner's 112,026 project tasks. Measured read-only on production 2026-10-25, at a
-- load of 9 on 8 cores:
--
--   the statement as it was                           1178 / 821 / 826 ms
--   the same with the READY guard replaced by FALSE    111 / 117 ms
--   the same with the whole CASE replaced by status    112 / 130 ms
--
-- so about 85% of it was the READY lane's guard (`everyPrerequisiteDoneOrRetiredSql`): a hashed
-- anti-join over all 111,963 dependency edges, probed by 109,664 OPEN rows. Every shape that still
-- visits each OPEN row once (hash, parallel hash, merge anti-join) measured 151–444 ms on that host.
--
-- Most of those rows are decided by their stored status alone. Read against the CASE:
--
--   CANCELLED   -> CANCELLED, FAILED -> FAILED      always
--   DONE        -> DONE                             unless it is a verification gate row
--   IN_PROGRESS -> RUNNING                          unless it is a verification gate row
--   OPEN        -> BLOCKED                          unless it is a gate row, a work session carries
--                                                   it, or every prerequisite is DONE or retired
--                                                   (the READY guard)
--
-- So the read now takes those defaults off `project_task_status_count` (0282) and asks the
-- classifier only about the rows that can leave them: the ones this table names, and the tasks a
-- work session carries, which it reads from `session` each time. On production that is 249 OPEN
-- rows past the guard, 3 live gate rows and 7 carried tasks, out of 112,026.
--
-- WHAT THIS TABLE HOLDS
-- =====================
-- A SUPERSET of the project tasks that are OPEN and pass the READY guard, or are live gate rows
-- (`completion_policy = 'VERIFICATION_PASSED' AND verifies_task_id IS NULL`, and not CANCELLED or
-- FAILED). A superset, not the set: a row it names that no longer qualifies is classified like any
-- other and lands in its real lane, so a stale row costs one classification and changes no count.
-- A row it MISSES would be counted in its status's default lane, so the triggers below follow the
-- one rule that makes missing impossible — every write that can turn the condition true for a task
-- appends that task:
--
--   - a task inserted or updated into OPEN or a live gate shape (or moved to another owner or
--     project while in one) — its own row;
--   - a task that stops holding its dependents, by becoming DONE or being retired (`terminal_reason`
--     or `superseded_by_task_id` set) — the OPEN project tasks that depend on it;
--   - a dependency edge deleted or rewritten, a cascade from either end included — the task that
--     depended through it, if it is OPEN and in a project.
--
-- Nothing else turns the condition true: an edge INSERTED only adds a prerequisite to wait for, and a
-- prerequisite that stops being DONE or retired only adds one more that is unfinished.
--
-- APPEND-ONLY, ON PURPOSE
-- =======================
-- The triggers never remove a row. One that dropped a task on seeing a new unfinished prerequisite
-- would race the transaction finishing that prerequisite: each reads the other's write as not yet
-- committed, and the task drops out for good — a READY task counted as BLOCKED. Appending has no
-- such interleaving, and it takes no lock another transaction waits for: every row is new, there is
-- no unique key to collide on, and no foreign key reaches a parent (docs/postgres-lock-order.md §4).
-- Duplicates are allowed for the same reason; the read folds them.
--
-- The table is tightened by `rebuildProjectRollupCandidates` (project-rollup-candidate.ts) at boot
-- and every ten minutes, sooner once an import has appended a thousand rows: one statement that
-- deletes the rows its snapshot sees and inserts the exact set computed in that same snapshot. A row it deletes was written by a transaction committed before
-- the snapshot, so what that write changed is in the set it inserts; a row the snapshot does not see
-- is not deleted. The seed at the bottom is that statement's INSERT, spelled out in SQL because a
-- migration cannot splice the TypeScript predicates it mirrors; the rebuild at boot replaces it,
-- and `project-rollup-candidate.pg.spec.ts` holds the triggers to those predicates.

CREATE TABLE "project_rollup_candidate" (
  "id" BIGSERIAL NOT NULL,
  "owner_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,

  CONSTRAINT "project_rollup_candidate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_rollup_candidate_owner_task_idx" ON "project_rollup_candidate"("owner_id", "task_id");

CREATE FUNCTION "project_rollup_candidate_note_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "project_rollup_candidate" ("owner_id", "task_id")
  SELECT n."owner_id", n."id"
    FROM "inserted_tasks" n
   WHERE n."project_id" IS NOT NULL
     AND (n."status" = 'OPEN'
          OR (n."completion_policy" = 'VERIFICATION_PASSED' AND n."verifies_task_id" IS NULL
              AND n."status" NOT IN ('CANCELLED', 'FAILED')));
  RETURN NULL;
END;
$$;

CREATE FUNCTION "project_rollup_candidate_note_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "project_rollup_candidate" ("owner_id", "task_id")
  SELECT n."owner_id", n."id"
    FROM "new_tasks" n
    JOIN "old_tasks" o ON o."id" = n."id"
   WHERE n."project_id" IS NOT NULL
     AND (n."status" = 'OPEN'
          OR (n."completion_policy" = 'VERIFICATION_PASSED' AND n."verifies_task_id" IS NULL
              AND n."status" NOT IN ('CANCELLED', 'FAILED')))
     AND (n."status" IS DISTINCT FROM o."status"
          OR n."owner_id" IS DISTINCT FROM o."owner_id"
          OR n."project_id" IS DISTINCT FROM o."project_id"
          OR n."completion_policy" IS DISTINCT FROM o."completion_policy"
          OR n."verifies_task_id" IS DISTINCT FROM o."verifies_task_id")
  UNION ALL
  SELECT dependent."owner_id", dependent."id"
    FROM "new_tasks" n
    JOIN "old_tasks" o ON o."id" = n."id"
    JOIN "task_dependency" edge ON edge."depends_on_task_id" = n."id"
    JOIN "task" dependent ON dependent."id" = edge."task_id"
   WHERE (n."status" = 'DONE' OR n."terminal_reason" IS NOT NULL OR n."superseded_by_task_id" IS NOT NULL)
     AND NOT (o."status" = 'DONE' OR o."terminal_reason" IS NOT NULL OR o."superseded_by_task_id" IS NOT NULL)
     AND dependent."project_id" IS NOT NULL
     AND dependent."status" = 'OPEN';
  RETURN NULL;
END;
$$;

CREATE FUNCTION "project_rollup_candidate_note_edges"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "project_rollup_candidate" ("owner_id", "task_id")
  SELECT dependent."owner_id", dependent."id"
    FROM "old_edges" edge
    JOIN "task" dependent ON dependent."id" = edge."task_id"
   WHERE dependent."project_id" IS NOT NULL
     AND dependent."status" = 'OPEN';
  RETURN NULL;
END;
$$;

CREATE TRIGGER "project_rollup_candidate_task_insert"
  AFTER INSERT ON "task" REFERENCING NEW TABLE AS "inserted_tasks"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_rollup_candidate_note_insert"();

CREATE TRIGGER "project_rollup_candidate_task_update"
  AFTER UPDATE ON "task" REFERENCING OLD TABLE AS "old_tasks" NEW TABLE AS "new_tasks"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_rollup_candidate_note_update"();

CREATE TRIGGER "project_rollup_candidate_edge_delete"
  AFTER DELETE ON "task_dependency" REFERENCING OLD TABLE AS "old_edges"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_rollup_candidate_note_edges"();

CREATE TRIGGER "project_rollup_candidate_edge_update"
  AFTER UPDATE ON "task_dependency" REFERENCING OLD TABLE AS "old_edges"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_rollup_candidate_note_edges"();

-- The seed: `rebuildProjectRollupCandidates`'s INSERT, with `everyPrerequisiteDoneOrRetiredSql` and
-- `verificationSubjectSql` spelled out as they read today.
INSERT INTO "project_rollup_candidate" ("owner_id", "task_id")
SELECT t."owner_id", t."id"
  FROM "task" t
 WHERE t."project_id" IS NOT NULL
   AND t."status" = 'OPEN'
   AND NOT EXISTS (
     SELECT 1 FROM "task_dependency" open_edge
      WHERE open_edge."task_id" = t."id"
        AND NOT EXISTS (
          SELECT 1 FROM "task" settled
           WHERE settled."id" = open_edge."depends_on_task_id"
             AND (settled."status" = 'DONE'
                  OR NOT (settled."terminal_reason" IS NULL AND settled."superseded_by_task_id" IS NULL))
        )
   )
UNION
SELECT t."owner_id", t."id"
  FROM "task" t
 WHERE t."project_id" IS NOT NULL
   AND t."completion_policy" = 'VERIFICATION_PASSED'
   AND t."verifies_task_id" IS NULL
   AND t."status" NOT IN ('CANCELLED', 'FAILED');

COMMENT ON TABLE "project_rollup_candidate" IS
  'A superset of the project tasks whose GET /projects lane their stored status may not decide (OPEN past the READY guard, or a live verification gate row). Appended by the project_rollup_candidate_* triggers, tightened by rebuildProjectRollupCandidates.';
