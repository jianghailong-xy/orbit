-- Orbit Wiki, phase 1: the two-week readings (docs/wiki-design.md §14, task T11). READ-ONLY.
--
--   docker exec -i orbit-postgres psql -U orbit -d orbit -X -v ON_ERROR_STOP=1 \
--     -v launch=2026-09-26T03:00:00Z [-v as_of=2026-10-10T03:00:00Z] [-v owner=<account uuid>] \
--     -f - < scripts/wiki-phase1-metrics.sql
--
-- WHAT IT READS
--   1. Review: how long the owner took to answer what agents proposed — the distribution, and the share
--      answered within 72 hours (the bar is 80%).
--   2. Per-op acceptance: of the ops the owner answered, the share kept — accepted as proposed, or
--      accepted with the owner's edit (the bar is 50%).
--   3. Harm, before against after: task runs' test execution rate, EXECUTABLE reruns, and
--      acceptance-command rewrites, counted from tool_call. After the launch must not be more than
--      10% worse than before it.
--   4. Usage, for context: what was pushed, searched and read, and what was proposed.
--
-- THE WINDOWS
--   launch  when the wiki went live for the accounts measured. Omitted: the first push the wiki ever
--           made (wiki_exposure channel 'push'), and failing that, now.
--   before  [launch - days, launch). Task runs are assigned by when their session was created.
--   after   [launch, launch + days), cut at as_of (default now). A task run counts only once it is
--           settle_hours old (default 12): a run still under way has not finished running its tests.
--   placebo [launch - 2*days, launch - days): the same metrics two weeks earlier still, against
--           `before` — how much they move with no wiki at all, which is what a change after the
--           launch has to be read against.
--   days    default 14. owner: one account's rows only, as a uuid; default every account.
--   workspaces  which task runs the harm metrics compare, as comma-separated uuids. Default: the
--           workspaces bound to a wiki space — the only ones the wiki pushes to — and, before any
--           is bound, every workspace with a repository (a space binds one on first use). Comparing
--           across every workspace would compare the week's mix of work: a data pipeline's runs,
--           which run no tests, can outnumber a codebase's.
--
-- DEFINITIONS
--   A proposal is in Review when its op was recorded pending — any origin but the owner's own, and not
--   auto-applied (a reinforce or a challenge). The owner has answered it when its decision is
--   accepted, edited, rejected or conflict (an accept whose base had moved); its time is the op's
--   decided_at minus its changeset's created_at. Withdrawn ops were closed by the system, not the
--   owner, and are left out of the 72-hour denominator; so is anything younger than 72 hours.
--   A task run is a session that starts task work, and is not a verifier's, a foreman's or a
--   judgment session — none of which the wiki ever pushes to.
--   It ran tests when any command it ran (Bash, Monitor, bg_run) starts a test runner (npm/pnpm/yarn
--   test, vitest, node --test, go test, swift test, run-pg-spec.sh, pytest, cargo test, jest,
--   playwright test, xcodebuild test) — see the pattern in section 3.
--   An EXECUTABLE rerun is every acceptance run past the first: the platform's own runs of the task's
--   acceptance command, which reach tool_call as `shell-<turn>` rows whose turn is a
--   `system:task-acceptance:` turn.
--
-- Read-only: one READ ONLY transaction, rolled back; no locks beyond an ordinary MVCC snapshot.

\set QUIET on
\if :{?launch}
\else
  \set launch ''
\endif
\if :{?as_of}
\else
  \set as_of ''
\endif
\if :{?owner}
\else
  \set owner ''
\endif
\if :{?workspaces}
\else
  \set workspaces ''
\endif
\if :{?days}
\else
  \set days 14
\endif
\if :{?settle_hours}
\else
  \set settle_hours 12
\endif
\pset null '—'
\pset footer off

SET default_transaction_read_only = on;
SET TIME ZONE 'UTC';
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '180s';

SELECT coalesce(nullif(:'launch', '')::timestamptz,
                (SELECT min(e."at") FROM "wiki_exposure" e WHERE e."channel" = 'push'),
                now()) AS launch_at,
       coalesce(nullif(:'as_of', '')::timestamptz, now()) AS as_of_at
\gset p_

SELECT :'p_launch_at'::timestamptz - make_interval(days => 2 * :days) AS placebo_lo,
       :'p_launch_at'::timestamptz - make_interval(days => :days) AS pre_lo,
       :'p_launch_at'::timestamptz AS pre_hi,
       least(:'p_launch_at'::timestamptz + make_interval(days => :days), :'p_as_of_at'::timestamptz) AS post_hi,
       least(:'p_launch_at'::timestamptz + make_interval(days => :days),
             :'p_as_of_at'::timestamptz - make_interval(hours => :settle_hours)) AS post_settled_hi
\gset w_

SELECT coalesce(
         nullif(:'workspaces', ''),
         (SELECT string_agg(DISTINCT sw."workspace_id"::text, ',') FROM "wiki_space_workspace" sw
           WHERE nullif(:'owner', '') IS NULL OR sw."owner_id" = nullif(:'owner', '')::uuid),
         (SELECT string_agg(w."id"::text, ',') FROM "workspace" w
           WHERE coalesce(w."repo_url", '') <> ''
             AND (nullif(:'owner', '') IS NULL OR w."owner_id" = nullif(:'owner', '')::uuid)),
         '') AS workspaces,
       CASE WHEN nullif(:'workspaces', '') IS NOT NULL THEN 'as given'
            WHEN EXISTS (SELECT 1 FROM "wiki_space_workspace" sw
                          WHERE nullif(:'owner', '') IS NULL OR sw."owner_id" = nullif(:'owner', '')::uuid)
              THEN 'bound to a wiki space'
            ELSE 'none bound yet: every workspace with a repository' END AS workspaces_source
\gset r_

\echo
\echo '== 0. Windows =='
SELECT :'p_launch_at'::timestamptz AS launch,
       :'w_pre_lo'::timestamptz AS before_from,
       :'w_post_hi'::timestamptz AS after_until,
       :'w_post_settled_hi'::timestamptz AS task_runs_counted_until,
       :'p_as_of_at'::timestamptz AS as_of,
       coalesce(nullif(:'owner', ''), 'every account') AS accounts;
SELECT w."id" AS harm_workspace, w."name", coalesce(w."repo_url", '') AS repo_url, :'r_workspaces_source' AS chosen
  FROM "workspace" w
 WHERE w."id"::text = ANY (string_to_array(nullif(:'r_workspaces', ''), ','))
 ORDER BY w."name";

\echo
\echo '== 1. Review: how long the owner took, and the share answered within 72 hours (bar: >= 80%) =='
WITH ops AS (
  SELECT o."decision",
         c."created_at" AS submitted_at,
         extract(epoch FROM (o."decided_at" - c."created_at")) / 3600.0 AS hours,
         o."decision" IN ('accepted', 'edited', 'rejected', 'conflict') AS answered
    FROM "wiki_changeset_op" o
    JOIN "wiki_changeset" c ON c."id" = o."changeset_id"
   WHERE c."origin" <> 'owner'
     AND o."decision" <> 'auto_applied'
     AND c."created_at" >= :'p_launch_at'::timestamptz
     AND c."created_at" < :'w_post_hi'::timestamptz
     AND (nullif(:'owner', '') IS NULL OR c."owner_id" = nullif(:'owner', '')::uuid)
), eligible AS (
  SELECT * FROM ops
   WHERE submitted_at <= :'p_as_of_at'::timestamptz - interval '72 hours'
     AND "decision" <> 'withdrawn'
)
SELECT (SELECT count(*) FROM ops) AS entered_review,
       (SELECT count(*) FROM ops WHERE answered) AS answered,
       (SELECT count(*) FROM ops WHERE "decision" = 'pending') AS still_pending,
       (SELECT count(*) FROM ops WHERE "decision" IN ('withdrawn', 'expired')) AS withdrawn_or_expired,
       (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 1) FROM ops WHERE answered) AS p50_hours,
       (SELECT round(percentile_cont(0.9) WITHIN GROUP (ORDER BY hours)::numeric, 1) FROM ops WHERE answered) AS p90_hours,
       (SELECT round(max(hours)::numeric, 1) FROM ops WHERE answered) AS max_hours,
       (SELECT count(*) FROM eligible) AS eligible_72h,
       (SELECT count(*) FROM eligible WHERE answered AND hours <= 72) AS answered_within_72h,
       (SELECT round(100.0 * count(*) FILTER (WHERE answered AND hours <= 72) / nullif(count(*), 0), 1) FROM eligible)
         AS within_72h_pct,
       (SELECT CASE WHEN count(*) = 0 THEN 'no data yet'
                    WHEN count(*) FILTER (WHERE answered AND hours <= 72) >= 0.8 * count(*) THEN 'meets >= 80%'
                    ELSE 'BELOW 80%' END FROM eligible) AS verdict;

WITH ops AS (
  SELECT o."decision",
         extract(epoch FROM (coalesce(o."decided_at", :'p_as_of_at'::timestamptz) - c."created_at")) / 3600.0 AS hours
    FROM "wiki_changeset_op" o
    JOIN "wiki_changeset" c ON c."id" = o."changeset_id"
   WHERE c."origin" <> 'owner'
     AND o."decision" <> 'auto_applied'
     AND c."created_at" >= :'p_launch_at'::timestamptz
     AND c."created_at" < :'w_post_hi'::timestamptz
     AND (nullif(:'owner', '') IS NULL OR c."owner_id" = nullif(:'owner', '')::uuid)
), bucketed AS (
  SELECT CASE WHEN "decision" = 'pending' THEN 'still waiting'
              WHEN "decision" IN ('withdrawn', 'expired') THEN 'closed without the owner (' || "decision" || ')'
              WHEN hours < 1 THEN 'answered < 1h'
              WHEN hours < 6 THEN 'answered 1-6h'
              WHEN hours < 24 THEN 'answered 6-24h'
              WHEN hours <= 72 THEN 'answered 24-72h'
              ELSE 'answered > 72h' END AS bucket,
         hours
    FROM ops
)
SELECT bucket, count(*) AS ops, round(max(hours)::numeric, 1) AS longest_hours
  FROM bucketed
 GROUP BY bucket
 ORDER BY min(CASE bucket WHEN 'answered < 1h' THEN 1 WHEN 'answered 1-6h' THEN 2 WHEN 'answered 6-24h' THEN 3
                          WHEN 'answered 24-72h' THEN 4 WHEN 'answered > 72h' THEN 5 WHEN 'still waiting' THEN 6 ELSE 7 END);

\echo
\echo '== 2. Per-op acceptance: of the ops the owner answered, the share kept (bar: >= 50%) =='
WITH ops AS (
  SELECT o."op", o."decision", o."decision_reason"
    FROM "wiki_changeset_op" o
    JOIN "wiki_changeset" c ON c."id" = o."changeset_id"
   WHERE c."origin" <> 'owner'
     AND o."decision" IN ('accepted', 'edited', 'rejected')
     AND c."created_at" >= :'p_launch_at'::timestamptz
     AND c."created_at" < :'w_post_hi'::timestamptz
     AND (nullif(:'owner', '') IS NULL OR c."owner_id" = nullif(:'owner', '')::uuid)
)
SELECT coalesce("op", 'every op') AS op,
       count(*) AS answered,
       count(*) FILTER (WHERE "decision" = 'accepted') AS accepted,
       count(*) FILTER (WHERE "decision" = 'edited') AS edited,
       count(*) FILTER (WHERE "decision" = 'rejected') AS rejected,
       round(100.0 * count(*) FILTER (WHERE "decision" IN ('accepted', 'edited')) / nullif(count(*), 0), 1) AS kept_pct,
       round(100.0 * count(*) FILTER (WHERE "decision" = 'accepted') / nullif(count(*), 0), 1) AS accepted_as_proposed_pct,
       CASE WHEN "op" IS NOT NULL THEN ''
            WHEN count(*) = 0 THEN 'no data yet'
            WHEN count(*) FILTER (WHERE "decision" IN ('accepted', 'edited')) >= 0.5 * count(*) THEN 'meets >= 50%'
            ELSE 'BELOW 50%' END AS verdict
  FROM ops
 GROUP BY ROLLUP ("op")
 ORDER BY "op" NULLS FIRST;

WITH ops AS (
  SELECT o."decision_reason"
    FROM "wiki_changeset_op" o
    JOIN "wiki_changeset" c ON c."id" = o."changeset_id"
   WHERE c."origin" <> 'owner'
     AND o."decision" = 'rejected'
     AND c."created_at" >= :'p_launch_at'::timestamptz
     AND c."created_at" < :'w_post_hi'::timestamptz
     AND (nullif(:'owner', '') IS NULL OR c."owner_id" = nullif(:'owner', '')::uuid)
)
SELECT coalesce("decision_reason", '(none given)') AS rejected_because, count(*) AS ops
  FROM ops GROUP BY 1 ORDER BY 2 DESC;

\echo
\echo '== 3. Harm: task runs before the launch against after it (bar: no metric more than 10% worse) =='
WITH runs AS (
  SELECT s."id",
         CASE WHEN s."created_at" < :'w_pre_lo'::timestamptz THEN 'placebo'
              WHEN s."created_at" < :'w_pre_hi'::timestamptz THEN 'before'
              ELSE 'after' END AS win,
         t."completion_criterion"::text = 'EXECUTABLE' AS executable,
         EXISTS (SELECT 1 FROM "wiki_exposure" e WHERE e."session_id" = s."id" AND e."channel" = 'push') AS pushed
    FROM "session" s
    JOIN "task" t ON t."id" = s."task_id"
   WHERE s."starts_task_work"
     AND s."dispatch_origin"::text <> 'PROJECT_COORDINATOR'
     AND t."verifies_task_id" IS NULL
     AND NOT t."is_foreman"
     AND (nullif(:'owner', '') IS NULL OR s."owner_id" = nullif(:'owner', '')::uuid)
     AND s."workspace_id"::text = ANY (string_to_array(nullif(:'r_workspaces', ''), ','))
     AND ((s."created_at" >= :'w_placebo_lo'::timestamptz AND s."created_at" < :'w_pre_hi'::timestamptz)
       OR (s."created_at" >= :'p_launch_at'::timestamptz AND s."created_at" < :'w_post_settled_hi'::timestamptz))
), per_run AS (
  SELECT r.*,
         (SELECT count(*) FROM "tool_call" tc
           WHERE tc."session_id" = r."id"
             AND tc."name" IN ('Bash', 'Monitor', 'mcp__orbit__bg_run', 'orbit__bg_run')
             AND coalesce(tc."tool_use_id", '') NOT LIKE 'shell-%'
             -- A test runner in COMMAND position: the command is cut at newlines, `;`, `&`, `&&`, `|`,
             -- `||`, `$(` and backticks, and a piece counts when, past env assignments, `timeout N`,
             -- `env -u X` and the like, it starts with one (a path in front of it is fine). A grep for
             -- `vitest` or a heredoc that edits a spec is not a run.
             AND EXISTS (
               SELECT 1 FROM regexp_split_to_table(tc."input"->>'command', '\n|;|&&?|\|\|?|\$\(|`') AS piece
                WHERE piece ~* ('^\s*[({]?\s*((\w+=\S*|timeout(\s+-\S+)*\s+\S+|time|env(\s+(-u\s+\S+|-\S+|\$\S+|\w+=\S*))*|exec|nohup|setsid(\s+--wait)?)\s+)*'
                                || '(npx\s+)?(\S*/)?((npm|pnpm|yarn)\s+(run\s+)?test\y|vitest\y|node\s.*--test\y|go\s+test\y|swift\s+test\y'
                                || '|(bash\s+)?\S*run-pg-spec\.sh|pytest\y|cargo\s+test\y|jest\y|playwright\s+test\y|xcodebuild\y.*\ytest\y)')
             )) AS test_commands,
         (SELECT count(*) FROM "tool_call" tc
            JOIN "conversation_turn" ct ON ct."session_id" = tc."session_id"
                                       AND ct."id"::text = substr(tc."tool_use_id", 7)
           WHERE tc."session_id" = r."id"
             AND tc."tool_use_id" LIKE 'shell-%'
             AND ct."client_turn_id" LIKE 'system:task-acceptance:%') AS acceptance_runs,
         (SELECT count(*) FROM "tool_call" tc
           WHERE tc."session_id" = r."id"
             AND ((tc."name" IN ('mcp__orbit__task_update', 'orbit__task_update') AND tc."input" ? 'acceptanceCommand')
               OR (tc."name" = 'Bash' AND tc."input"->>'command' ~* 'orbit\s+task\s+update[^\n]*--acceptance'))) AS rewrites
    FROM runs r
), populations AS (
  SELECT d.population, d.ord, p.*
    FROM (VALUES ('placebo: the two weeks before that', 0), ('before', 1), ('after: every task run', 2),
                 ('after: task runs the wiki pushed to', 3)) d(population, ord)
    LEFT JOIN per_run p
      ON (d.ord = 0 AND p.win = 'placebo') OR (d.ord = 1 AND p.win = 'before') OR (d.ord = 2 AND p.win = 'after')
      OR (d.ord = 3 AND p.win = 'after' AND p.pushed)
), metrics AS (
  SELECT population, ord, m.metric, m.mord, m.worse_if,
         CASE m.mord
           WHEN 1 THEN count(id) FILTER (WHERE test_commands > 0)
           WHEN 2 THEN sum(greatest(acceptance_runs - 1, 0)) FILTER (WHERE executable)
           ELSE sum(rewrites) END AS numerator,
         CASE m.mord WHEN 2 THEN count(id) FILTER (WHERE executable) ELSE count(id) END AS runs
    FROM populations
   CROSS JOIN (VALUES ('test execution rate, % of task runs that ran tests', 1, 'lower'),
                      ('EXECUTABLE reruns per EXECUTABLE task run', 2, 'higher'),
                      ('acceptance-command rewrites per task run', 3, 'higher')) m(metric, mord, worse_if)
   GROUP BY population, ord, m.metric, m.mord, m.worse_if
), valued AS (
  SELECT *, CASE WHEN runs = 0 THEN NULL
                 WHEN mord = 1 THEN 100.0 * numerator / runs
                 ELSE 1.0 * numerator / runs END AS value
    FROM metrics
)
SELECT v.metric, v.population, v.runs, coalesce(v.numerator, 0) AS count, round(v.value, 3) AS value,
       round(100 * (v.value / nullif(b.value, 0) - 1), 1) AS change_vs_before_pct,
       CASE WHEN v.ord = 1 THEN '(baseline)'
            WHEN v.ord = 0 THEN '(natural variation)'
            WHEN v.value IS NULL THEN 'no data yet'
            WHEN b.value IS NULL THEN 'no baseline'
            WHEN v.worse_if = 'lower' AND v.value < 0.9 * b.value THEN 'WORSE by more than 10%'
            WHEN v.worse_if = 'higher' AND v.value > 1.1 * b.value AND v.value > 0 THEN 'WORSE by more than 10%'
            ELSE 'within 10%' END AS verdict
  FROM valued v
  JOIN valued b ON b.mord = v.mord AND b.ord = 1
 ORDER BY v.mord, v.ord;

\echo
\echo '== 4. Usage after the launch, for context =='
SELECT e."channel", count(*) AS exposures, count(DISTINCT e."session_id") AS sessions, count(DISTINCT e."entry_id") AS entries
  FROM "wiki_exposure" e
 WHERE e."at" >= :'p_launch_at'::timestamptz
   AND e."at" < :'w_post_hi'::timestamptz
   AND (nullif(:'owner', '') IS NULL OR e."owner_id" = nullif(:'owner', '')::uuid)
 GROUP BY e."channel"
 ORDER BY e."channel";

SELECT c."origin", count(DISTINCT c."id") AS changesets, count(o."id") AS ops,
       count(o."id") FILTER (WHERE o."decision" = 'auto_applied') AS applied_at_once,
       count(o."id") FILTER (WHERE o."decision" <> 'auto_applied') AS went_to_review
  FROM "wiki_changeset" c
  LEFT JOIN "wiki_changeset_op" o ON o."changeset_id" = c."id"
 WHERE c."created_at" >= :'p_launch_at'::timestamptz
   AND c."created_at" < :'w_post_hi'::timestamptz
   AND (nullif(:'owner', '') IS NULL OR c."owner_id" = nullif(:'owner', '')::uuid)
 GROUP BY c."origin"
 ORDER BY c."origin";

SELECT w."status", w."trust", count(*) AS entries_now
  FROM "wiki_entry" w
 WHERE (nullif(:'owner', '') IS NULL OR w."owner_id" = nullif(:'owner', '')::uuid)
 GROUP BY w."status", w."trust"
 ORDER BY w."status", w."trust";

ROLLBACK;
