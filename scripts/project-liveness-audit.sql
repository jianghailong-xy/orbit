-- Contract §10.3 — the decidable liveness condition, as one query you can run on a production
-- snapshot.
--
--   psql "$DATABASE_URL" -f scripts/project-liveness-audit.sql
--
-- It returns ONE ROW PER VIOLATION, and nothing at all when the control loop is healthy. A row
-- here is AC3's silent-idling defect: a project that is OPEN, switched on, not waiting on a person
-- and not settled, for which none of §10.3's four clauses holds —
--
--   (a) a LIVE session of one of its tasks that is attributable: either the `result_session` of an
--       APPLIED `DISPATCH_TASK`, or one a person started (`dispatch_origin = 'USER'`). A user's
--       explicit action is evidence the project is moving, not a hole (PC-CX-14);
--   (b) a coordinator turn in flight — a CLAIMED `OPEN_COORDINATOR_TURN` that has not published;
--   (c) at least one open blocker with all five of §11.1's fields present, so somebody can act;
--   (d) a `next_wake_at` in the future with a reason.
--
-- `violated_clauses` is always `abcd` — the four are a disjunction, so a violation fails all of
-- them; the per-clause booleans are kept so a reader can see WHICH near miss it was (a blocker
-- missing `next_check_at` reads differently from no blocker at all).
--
-- Read-only: no writes, no locks beyond an ordinary MVCC snapshot. Safe on a live primary.

WITH in_loop AS (
  SELECT p."id",
         p."owner_id",
         p."title",
         r."run_state"::text  AS run_state,
         r."next_wake_at",
         r."next_wake_reason"
    FROM "project" p
    JOIN "project_runtime" r ON r."project_id" = p."id"
   WHERE p."status" = 'OPEN'
     AND p."coordinator_enabled"
     -- §10.3's own scope. AWAITING_HUMAN is excluded because §10.4 N-null lets exactly that state
     -- stop its own clock; it stays visible through clause (c), which its blocker satisfies.
     AND r."run_state"::text NOT IN ('AWAITING_HUMAN', 'SETTLED')
), clauses AS (
  SELECT l.*,
         EXISTS (
           SELECT 1
             FROM "session" s
             JOIN "task" t ON t."id" = s."task_id"
            WHERE t."project_id" = l."id"
              AND s."deleted_at" IS NULL
              AND s."status"::text IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
              AND (
                s."dispatch_origin"::text = 'USER'
                OR EXISTS (
                  SELECT 1 FROM "project_action" a
                   WHERE a."project_id" = l."id"
                     AND a."type" = 'DISPATCH_TASK'
                     AND a."status" = 'APPLIED'
                     AND a."result_session_id" = s."id"
                )
              )
         ) AS clause_a_live_session,
         EXISTS (
           SELECT 1 FROM "project_action" a
            WHERE a."project_id" = l."id"
              AND a."type" = 'OPEN_COORDINATOR_TURN'
              AND a."status" = 'CLAIMED'
         ) AS clause_b_turn_in_flight,
         EXISTS (
           SELECT 1 FROM "project_blocker" b
            WHERE b."project_id" = l."id"
              AND b."resolved_at" IS NULL
              -- §11.1's five questions. A blocker missing one of them is not a blocker a person
              -- can act on, so it does not keep the project out of violation.
              AND b."kind" IS NOT NULL AND b."kind" <> ''
              AND b."owner" IS NOT NULL
              AND b."recovery" IS NOT NULL
              AND b."required_action" IS NOT NULL AND b."required_action" <> ''
              AND b."next_check_at" IS NOT NULL
         ) AS clause_c_actionable_blocker,
         (l."next_wake_at" IS NOT NULL
          AND l."next_wake_at" > now()
          AND l."next_wake_reason" IS NOT NULL
          AND l."next_wake_reason" <> '') AS clause_d_future_wake
    FROM in_loop l
)
SELECT "id"                      AS project_id,
       "owner_id",
       "title",
       run_state,
       "next_wake_at",
       "next_wake_reason",
       clause_a_live_session,
       clause_b_turn_in_flight,
       clause_c_actionable_blocker,
       clause_d_future_wake,
       'abcd'                    AS violated_clauses
  FROM clauses
 WHERE NOT clause_a_live_session
   AND NOT clause_b_turn_in_flight
   AND NOT clause_c_actionable_blocker
   AND NOT clause_d_future_wake
 ORDER BY "next_wake_at" NULLS FIRST, "id";
