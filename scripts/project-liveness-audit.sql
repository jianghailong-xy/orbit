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
              AND s."finished_at" IS NULL
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
-- (0375's `DELIVERY_REVIEW`), a task's failure whose task is done, cancelled, replaced or being
-- attempted again; a finished task's work not seen on its line (0453's `LANDING_UNOBSERVED`) whose
-- task landed, left DONE, was declared codeless or was replaced, and the owner's question about work
-- that reached main unconfirmed (`LANDED_WITHOUT_CONFIRMATION`) whose task was cancelled or replaced.
-- A door that misses that edge leaves the item open about
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
      WHEN "item"."kind" = 'INTEGRATION_CHECK_FAILED' AND "item"."dedupe_key" LIKE 'ICB:%' THEN true
      WHEN "item"."kind" = 'LANDING_UNOBSERVED' THEN EXISTS (
        SELECT 1 FROM "task" owed_task
         WHERE owed_task."id" = "item"."task_id"
           AND owed_task."status" = 'DONE'
           AND owed_task."superseded_by_task_id" IS NULL
           AND owed_task."codeless" = false
           AND (CASE
             WHEN EXISTS (
               SELECT 1 FROM "session_merge_receipt" upstream_receipt
                 JOIN "project_codebase" upstream_line
                   ON upstream_line."project_id" = owed_task."project_id"
                  AND upstream_line."slot" = 'primary'
                 LEFT JOIN LATERAL (
                   SELECT newest_line."source_sha", newest_line."created_at"
                     FROM "session_merge_receipt" newest_line
                    WHERE newest_line."task_id" = owed_task."id"
                      AND newest_line."result" IN ('MERGED', 'ALREADY_MERGED')
                      AND newest_line."target_branch" = regexp_replace(upstream_line."integration_ref", '^refs/heads/', '')
                      AND regexp_replace(upstream_line."integration_ref", '^refs/heads/', '') <> regexp_replace(upstream_line."upstream_ref", '^refs/heads/', '')
                    ORDER BY newest_line."created_at" DESC, newest_line."id" DESC
                    LIMIT 1
                 ) line_receipt ON true
                WHERE upstream_receipt."task_id" = owed_task."id"
                  AND upstream_receipt."result" IN ('MERGED', 'ALREADY_MERGED')
                  AND upstream_receipt."target_branch" = regexp_replace(upstream_line."upstream_ref", '^refs/heads/', '')
                  AND (line_receipt."source_sha" IS NULL
                    OR upstream_receipt."source_sha" = line_receipt."source_sha"
                    OR (upstream_receipt."detail" -> 'observed' IS DISTINCT FROM 'true'::jsonb
                      AND NOT EXISTS (
                        SELECT 1 FROM "session_merge_receipt" named_line
                          JOIN "session_merge_receipt" later_line
                            ON later_line."task_id" = named_line."task_id"
                           AND later_line."target_branch" = named_line."target_branch"
                           AND later_line."result" = 'MERGED'
                           AND later_line."target_sha_after" <> upstream_receipt."source_sha"
                           AND later_line."created_at" > named_line."created_at"
                         WHERE named_line."task_id" = owed_task."id"
                           AND named_line."result" IN ('MERGED', 'ALREADY_MERGED')
                           AND named_line."target_branch" = regexp_replace(upstream_line."integration_ref", '^refs/heads/', '')
                           AND named_line."target_sha_after" = upstream_receipt."source_sha")
                      AND upstream_receipt."created_at" > line_receipt."created_at"))
             ) THEN 'ON_UPSTREAM'
             WHEN EXISTS (
               SELECT 1 FROM "session_merge_receipt" landing_receipt
                 JOIN "project_codebase" receipt_line
                   ON receipt_line."project_id" = owed_task."project_id"
                  AND receipt_line."slot" = 'primary'
                WHERE landing_receipt."task_id" = owed_task."id"
                  AND landing_receipt."result" IN ('MERGED', 'ALREADY_MERGED')
                  AND landing_receipt."target_branch" = regexp_replace(receipt_line."integration_ref", '^refs/heads/', '')
             ) THEN 'ON_INTEGRATION_LINE'
             ELSE 'NOT_KNOWN'
           END) = 'NOT_KNOWN')
      WHEN "item"."kind" = 'LANDED_WITHOUT_CONFIRMATION' THEN ("item"."task_id" IS NULL OR EXISTS (
        SELECT 1 FROM "task" owed_task
         WHERE owed_task."id" = "item"."task_id"
           AND owed_task."status" <> 'CANCELLED'
           AND owed_task."superseded_by_task_id" IS NULL))
      WHEN "item"."kind" = 'EVIDENCE_UNDECIDED' THEN EXISTS (
        SELECT 1 FROM "task_completion_evidence" owed_evidence
          JOIN "task" owed_task ON owed_task."id" = owed_evidence."task_id"
         WHERE owed_evidence."id" = ("item"."payload"->>'evidenceId')::uuid
           AND owed_task."id" = "item"."task_id"
           AND owed_task."project_id" = "item"."project_id"
           AND owed_task."completion_criterion" = 'EVIDENCE_JUDGMENT'
           AND owed_task."status" IN ('OPEN', 'IN_PROGRESS')
           AND NOT EXISTS (
             SELECT 1 FROM "task_evidence_decision" owed_decision
              WHERE owed_decision."evidence_id" = owed_evidence."id")
           AND NOT EXISTS (
             SELECT 1 FROM "task_completion_evidence" owed_newer
              WHERE owed_newer."task_id" = owed_evidence."task_id"
                AND owed_newer."revision" > owed_evidence."revision"))
      WHEN "item"."kind" = 'LANDING_LEASE_EXPIRED' THEN EXISTS (
        SELECT 1 FROM "project_integration_job" owed_job
         WHERE owed_job."id" = "item"."integration_job_id"
           AND owed_job."state" = 'RUNNING'
           AND "item"."dedupe_key" = 'LE:' || owed_job."id"::text || ':' || owed_job."claim_generation"::text)
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
      WHEN "item"."task_id" IS NOT NULL AND "item"."kind" = 'TASK_FAILED' THEN EXISTS (
        SELECT 1 FROM "task" owed_task
         WHERE owed_task."id" = "item"."task_id"
           AND owed_task."status" NOT IN ('DONE', 'CANCELLED')
           AND owed_task."superseded_by_task_id" IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM "session" owed_session
              WHERE owed_session."task_id" = owed_task."id"
                AND owed_session."starts_task_work"
                AND owed_session."finished_at" IS NULL
                AND (owed_session."id" IS DISTINCT FROM "item"."session_id"
                     OR EXISTS (
                       SELECT 1 FROM "conversation_turn" resumed_turn
                        WHERE resumed_turn."session_id" = owed_session."id"
                          AND resumed_turn."kind" = 'message'
                          AND resumed_turn."created_at" > ("item"."waiting_since" AT TIME ZONE 'UTC')))))
      ELSE true
    END)
 GROUP BY item."project_id", proj."title", item."kind"
 ORDER BY item."project_id", item."kind";
