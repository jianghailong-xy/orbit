-- D2-era: this reads or writes session.status, which deploy D4 (migration 1711) dropped. It runs on a database of
-- deploy D1 or D2 only, and is kept for the record of those deploys.
--
-- A production-shaped data set for scripts/session-status-query-plans.sql (docs/session-status-retirement-plan.md
-- §4.5): one busy runner with 44,000 released sessions and 73 held ones (the shape measured in the earlier plan's
-- step 4.3), nineteen quieter runners, tasks, task lists, batches, spawn trees, turns and runner presence.
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/session-status-query-plans-seed.sql
--
-- For a THROWAWAY database that every migration up to at least 1612 has been applied to: it refuses one that holds a
-- session. The rows are written the way D1 code writes them (the word only); the triggers derive turn_state and phase.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "session") THEN
    RAISE EXCEPTION 'this database holds sessions: seed only an empty, throwaway one';
  END IF;
END $$;

BEGIN;

-- Users 1..4; user 1 owns the busy runner and most of the work.
INSERT INTO "user" ("id", "email", "name")
SELECT md5('user' || u)::uuid, 'plans-' || u || '@seed.invalid', 'plans ' || u FROM generate_series(1, 4) u;

-- Runners 1..20, two workspaces each. Runners 1..8 are user 1's.
INSERT INTO "runner" ("id", "name", "owner_id", "token_hash", "max_concurrent")
SELECT md5('runner' || r)::uuid, 'runner ' || r,
       md5('user' || CASE WHEN r <= 8 THEN 1 ELSE 2 + r % 3 END)::uuid, 'seed-hash-' || r, 8
  FROM generate_series(1, 20) r;

INSERT INTO "workspace" ("id", "name", "owner_id", "runner_id")
SELECT md5('workspace' || r || '-' || w)::uuid, 'ws ' || r || '-' || w, x."owner_id", x."id"
  FROM generate_series(1, 20) r CROSS JOIN generate_series(1, 2) w
  JOIN "runner" x ON x."id" = md5('runner' || r)::uuid;

INSERT INTO "task_list" ("id", "title", "owner_id", "max_concurrent", "updated_at")
SELECT md5('list' || u || '-' || l)::uuid, 'list ' || l, md5('user' || u)::uuid, CASE WHEN l <= 5 THEN 3 END, now()
  FROM generate_series(1, 4) u CROSS JOIN generate_series(1, 10) l;

-- 40,000 tasks, 10,000 a user, in the lists.
INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id", "updated_at", "completion_criterion",
                    "list_id", "status")
SELECT md5('task' || u || '-' || t)::uuid, 'task ' || t, md5('user' || u)::uuid, 'USER', md5('user' || u)::uuid, now(),
       'EVIDENCE_JUDGMENT', md5('list' || u || '-' || (1 + t % 10))::uuid,
       (CASE WHEN t % 7 = 0 THEN 'OPEN' ELSE 'DONE' END)::task_status
  FROM generate_series(1, 4) u CROSS JOIN generate_series(1, 10000) t;

-- The shape of every session: (runner, n). n <= released: a released one; above it: a held one. A released session's
-- word is scattered over the heap in production-like shares: 1 in 100 FAILED, 25 CANCELLED, the rest SUCCEEDED.
CREATE TEMP TABLE plan_seed ON COMMIT DROP AS
SELECT r, n, released, held,
       CASE WHEN n <= released THEN
         CASE WHEN abs(hashtext(r || ':' || n)::bigint) % 100 < 1 THEN 'FAILED'
              WHEN abs(hashtext(r || ':' || n)::bigint) % 100 < 26 THEN 'CANCELLED'
              ELSE 'SUCCEEDED' END
       END AS ended,
       md5('session' || r || '-' || n)::uuid AS id,
       x."owner_id", x."id" AS runner_id,
       CASE WHEN n <= released THEN NULL ELSE n - released END AS h
  FROM (SELECT r, CASE WHEN r = 1 THEN 44000 ELSE 3000 END AS released, CASE WHEN r = 1 THEN 73 ELSE 15 END AS held
          FROM generate_series(1, 20) r) shape
 CROSS JOIN LATERAL generate_series(1, released + held) n
  JOIN "runner" x ON x."id" = md5('runner' || r)::uuid;

-- The held word of the h-th held session. Busy runner: 4 running, 6 queued, 61 awaiting, 2 interrupted. The others:
-- 1 running, 2 queued, 12 awaiting.
CREATE FUNCTION pg_temp.held_word(r int, h int) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN r = 1 THEN CASE WHEN h <= 4 THEN 'RUNNING' WHEN h <= 10 THEN 'PENDING' WHEN h <= 71 THEN 'AWAITING_INPUT'
                         ELSE 'INTERRUPTED' END
    ELSE CASE WHEN h <= 1 THEN 'RUNNING' WHEN h <= 3 THEN 'PENDING' ELSE 'AWAITING_INPUT' END
  END
$$;

INSERT INTO "session" (
  "id", "title", "prompt", "owner_id", "creator_id", "updated_at", "created_at", "last_turn_at", "started_at",
  "workspace_id", "assigned_runner_id", "status", "finished_at", "end_reason", "last_turn_outcome",
  "task_id", "starts_task_work", "batch_id", "batch_max_concurrent", "root_session_id", "claim_request_id",
  "engine_turn_active", "running_subagents", "running_bg_jobs", "running_bg_shells"
)
SELECT p.id, 'session ' || p.r || '-' || p.n, 'seeded', p.owner_id, p.owner_id, at.created, at.created, at.created,
       at.created,
       md5('workspace' || p.r || '-' || (1 + p.n % 2))::uuid, p.runner_id,
       COALESCE(p.ended, pg_temp.held_word(p.r, p.h))::run_status,
       CASE WHEN p.h IS NULL THEN at.created + interval '1 hour' END,
       -- The release facts each word's writer leaves: a finished task, a failure with no end asked, a stop.
       CASE p.ended WHEN 'SUCCEEDED' THEN 'task_done' WHEN 'CANCELLED' THEN CASE WHEN p.n % 2 = 0 THEN 'user' END END,
       CASE WHEN p.ended = 'FAILED' THEN 'FAILED' WHEN p.h IS NULL THEN 'ANSWERED' END,
       -- A third of the released sessions ran a task (several runs a task); each held session works its own.
       CASE WHEN p.h IS NOT NULL AND p.n % 2 = 0
              THEN md5('task' || u.u || '-' || (p.r * 200 + p.h))::uuid
            WHEN p.h IS NULL AND p.n % 3 = 0
              THEN md5('task' || u.u || '-' || (1 + (p.r * 7919 + p.n) % 10000))::uuid END,
       true,
       -- One in twenty ran in a capped list's batch run.
       CASE WHEN p.n % 20 = 3 OR (p.h IS NOT NULL AND p.n % 5 = 0) THEN md5('list' || u.u || '-' || (1 + p.r % 5))::uuid END,
       CASE WHEN p.n % 20 = 3 OR (p.h IS NOT NULL AND p.n % 5 = 0) THEN 3 END,
       -- One in ten in one of 500 spawn trees; the held ones of a runner share its tree.
       CASE WHEN p.h IS NOT NULL AND p.n % 3 = 0 THEN md5('root' || p.r)::uuid
            WHEN p.h IS NULL AND p.n % 10 = 1 THEN md5('root' || (p.n % 500))::uuid END,
       CASE WHEN p.h IS NOT NULL AND pg_temp.held_word(p.r, p.h) = 'RUNNING' THEN 'claim-' || p.r || '-' || p.h END,
       COALESCE(p.h IS NOT NULL AND pg_temp.held_word(p.r, p.h) = 'AWAITING_INPUT' AND p.h % 9 = 0, false),
       CASE WHEN p.h IS NOT NULL AND pg_temp.held_word(p.r, p.h) = 'AWAITING_INPUT' AND p.h % 11 = 0
            THEN ARRAY['agent-1'] ELSE '{}'::text[] END,
       CASE WHEN p.h IS NOT NULL AND pg_temp.held_word(p.r, p.h) = 'AWAITING_INPUT' AND p.h % 7 = 0
            THEN ARRAY['bgj_1'] ELSE '{}'::text[] END,
       CASE WHEN p.h IS NOT NULL AND pg_temp.held_word(p.r, p.h) = 'AWAITING_INPUT' AND p.h % 7 = 0
            THEN ARRAY['bgj_1'] ELSE '{}'::text[] END
  FROM plan_seed p
 CROSS JOIN LATERAL (SELECT CASE WHEN p.r <= 8 THEN 1 ELSE 2 + p.r % 3 END AS u) u
 CROSS JOIN LATERAL (
   SELECT (now() AT TIME ZONE 'utc') - make_interval(secs => (p.released + p.held - p.n) * 150) AS created
 ) at
 ORDER BY at.created;

-- Turns: one a held session (delivered, queued or answered), two answered ones a released session.
INSERT INTO "conversation_turn" ("id", "session_id", "seq", "client_turn_id", "kind", "status", "delivered_at")
SELECT md5('turn' || p.r || '-' || p.n || '-' || q)::uuid, p.id, q, 'seed-' || q, 'message',
       CASE WHEN p.h IS NULL THEN 'ANSWERED'
            WHEN pg_temp.held_word(p.r, p.h) = 'RUNNING' THEN 'IN_FLIGHT'
            WHEN pg_temp.held_word(p.r, p.h) = 'PENDING' THEN 'PENDING'
            ELSE 'ANSWERED' END,
       CASE WHEN p.h IS NULL OR pg_temp.held_word(p.r, p.h) <> 'PENDING' THEN now() AT TIME ZONE 'utc' END
  FROM plan_seed p
 CROSS JOIN LATERAL generate_series(1, CASE WHEN p.h IS NULL THEN 2 ELSE 1 END) q;

-- The planner has no statistics for the rows written so far: without them the joins below are nested loops.
ANALYZE plan_seed, "session", "conversation_turn";

-- Run now passes: the first two queued sessions of each runner.
UPDATE "session" s SET "over_capacity_turn_id" = t."id"
  FROM plan_seed p JOIN "conversation_turn" t ON t."session_id" = p.id AND t."seq" = 1
 WHERE s."id" = p.id AND p.h IS NOT NULL AND pg_temp.held_word(p.r, p.h) = 'PENDING'
   AND p.h <= CASE WHEN p.r = 1 THEN 6 ELSE 3 END;

-- A decided approval waiting to be read, on every running turn and on each parked session with a background shell.
INSERT INTO "approval" ("id", "session_id", "tool_name", "input", "status", "turn_id", "background_job_id")
SELECT md5('approval' || s."id")::uuid, s."id", 'Bash', '{}', 'ALLOWED',
       CASE WHEN s."status" = 'RUNNING' THEN t."id" END,
       CASE WHEN s."status" <> 'RUNNING' THEN s."running_bg_shells"[1] END
  FROM plan_seed p JOIN "session" s ON s."id" = p.id JOIN "conversation_turn" t ON t."session_id" = s."id" AND t."seq" = 1
 WHERE p.h IS NOT NULL AND (s."status" = 'RUNNING' OR cardinality(s."running_bg_shells") > 0);

-- What each runner's last beat named as holding a slot through a background job.
INSERT INTO "runner_presence" ("runner_id", "last_beat_at", "link_state", "background_job_session_ids")
SELECT x."id", now(), 'LINK',
       COALESCE(ARRAY(SELECT s."id" FROM "session" s
                       WHERE s."assigned_runner_id" = x."id" AND cardinality(s."running_bg_jobs") > 0), '{}')
  FROM "runner" x;

COMMIT;

VACUUM (ANALYZE) "session", "conversation_turn", "task", "task_list", "runner", "runner_presence", "workspace", "approval";

SELECT "status"::text AS status, count(*) AS sessions, count(*) FILTER (WHERE "assigned_runner_id" = md5('runner1')::uuid) AS on_busy_runner
  FROM "session" GROUP BY 1 ORDER BY 1;
