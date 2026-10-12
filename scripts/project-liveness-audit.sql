-- Contract §10.3 — the decidable liveness condition, as one query you can run on a production
-- snapshot.
--
--   psql "$DATABASE_URL" -f scripts/project-liveness-audit.sql
--
-- It returns ONE ROW PER VIOLATION, and nothing at all when the control loop is healthy. A row
-- here is AC3's silent-idling defect: a project that is OPEN, switched on, not waiting on a person
-- and not settled, for which none of §10.3's four clauses holds —
--
--   (a) a LIVE session of one of its tasks that a person started (`dispatch_origin = 'USER'`). A
--       user's explicit action is evidence the project is moving, not a hole (PC-CX-14). The other
--       attributable session, the `result_session` of an APPLIED `DISPATCH_TASK`, went with the
--       `project_action` ledger in 0272;
--   (b) a coordinator turn in flight — a CLAIMED `OPEN_COORDINATOR_TURN` that has not published.
--       That ledger is gone too, and nothing had written a turn to it since the control loop was
--       removed (6418a1e5), so the clause is constant false; it stays so the output keeps its shape;
--   (c) at least one open blocker with all five of §11.1's fields present, so somebody can act;
--   (d) a `next_wake_at` in the future with a reason.
--
-- `violated_clauses` is always `abcd` — the four are a disjunction, so a violation fails all of
-- them; the per-clause booleans are kept so a reader can see WHICH near miss it was (a blocker
-- missing `next_check_at` reads differently from no blocker at all).
--
-- Read-only: no writes, no locks beyond an ordinary MVCC snapshot. Safe on a live primary.
--
-- A second query follows the first, in the same shape: §4.2's open items that nobody owes any more,
-- one row per project and kind, and nothing at all when every open item still waits on somebody.

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
              AND s."dispatch_origin"::text = 'USER'
         ) AS clause_a_live_session,
         false AS clause_b_turn_in_flight,
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

-- §4.2 — open items that nobody owes any more, counted per project and kind.
--
-- An item is closed by the transaction that moves what it is about: a candidate leaving the live
-- states, a task cancelled or replaced, a delivery under review whose task is no longer DONE
-- (0375's `DELIVERY_REVIEW`). A door that misses that edge leaves the item open about
-- something that is gone — in front of the owner, on their badge, and (for an integration item)
-- holding off the project's Automatic merges. The escalation tick's backstop
-- (`ProjectOpenItemEscalationService.reconcile`) closes such an item within a minute, with a
-- `resolution_note` that starts `backstop:`. So a deployment that runs the backstop returns nothing
-- here but the minute between a missed edge and the next tick; one that predates it returns every
-- zombie it has, which is what to read before and after deploying it.
--
-- `open_not_owed` is how many; `with_owner` how many of those are in front of the account owner;
-- `oldest_opened_at` how long the oldest has been there.
--
-- The predicate is `openItemOwed('item')` in src/apiserver/src/projects/project-open-item.ts, written
-- out because this file has no TypeScript to call; open-item-owed.pg.spec.ts holds the two to the
-- same text and runs this query against the rows the backstop closes.
--
-- Read-only, like the query above.

SELECT item."project_id"                                       AS project_id,
       proj."title",
       item."kind",
       count(*)::int                                           AS open_not_owed,
       (count(*) FILTER (WHERE item."assignee" = 'OWNER'))::int AS with_owner,
       min(item."created_at")                                  AS oldest_opened_at
  FROM "project_open_item" item
  JOIN "project" proj ON proj."id" = item."project_id"
 WHERE item."state" = 'OPEN'
   AND NOT (CASE
      WHEN "item"."promotion_id" IS NOT NULL AND "item"."kind" = 'PROMOTION_APPROVAL' THEN EXISTS (
        SELECT 1 FROM "project_promotion" owed_promotion
         WHERE owed_promotion."id" = "item"."promotion_id"
           AND owed_promotion."state" = 'READY')
      WHEN "item"."promotion_id" IS NOT NULL
       AND "item"."kind" IN ('INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR')
      THEN EXISTS (
        SELECT 1 FROM "project_promotion" owed_promotion
         WHERE owed_promotion."id" = "item"."promotion_id"
           AND owed_promotion."state" IN ('CHECKING', 'READY', 'CONFIRMED', 'RECHECKING', 'BLOCKED'))
      WHEN "item"."task_id" IS NOT NULL
       AND "item"."kind" IN ('INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR')
      THEN EXISTS (
        SELECT 1 FROM "task" owed_task
         WHERE owed_task."id" = "item"."task_id"
           AND owed_task."status" <> 'CANCELLED'
           AND owed_task."superseded_by_task_id" IS NULL)
      WHEN "item"."task_id" IS NOT NULL AND "item"."kind" = 'DELIVERY_REVIEW' THEN EXISTS (
        SELECT 1 FROM "task" owed_task
         WHERE owed_task."id" = "item"."task_id"
           AND owed_task."status" = 'DONE'
           AND owed_task."superseded_by_task_id" IS NULL)
      ELSE true
    END)
 GROUP BY item."project_id", proj."title", item."kind"
 ORDER BY item."project_id", item."kind";
