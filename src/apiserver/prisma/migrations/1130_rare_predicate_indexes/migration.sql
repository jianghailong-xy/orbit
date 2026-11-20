-- 1130 — three reads that look for a handful of rows and read the whole table to find them.
--
-- Each is scoped by `owner_id`, which is not selective here: on 2026-11-19 one owner held 114k of production's 115k
-- tasks (109k of them one pipeline's OPEN backlog) and 10k of its 16k sessions. So an index that starts with the
-- owner is a full scan for that owner, and what the read is really asking for, a rare fact about the row, had no
-- index of its own. These index that fact, and only the rows that have it.
--
--   * `task_fork_snapshot_idx`: the snapshots a runner's open forked tasks start from
--     (RunnerApiController.forkSnapshotsOpen), read on every runner beat: `fork_sha IS NOT NULL AND
--     fork_runner_id = $runner`. Production: a sequential scan of all 32,829 pages of `task`, 175 ms, 90k calls in
--     5.7 days. It has never returned a row: no task has a `fork_sha` yet, so this index is empty until one does.
--
--   * `session_bg_jobs_live_idx`, `session_bg_shells_live_idx`: the sessions with a background job or shell up
--     (SessionsService's workspace tallies, `runningBgJobs` / `runningBgShells: { isEmpty: false }`). Production:
--     18 rows, found by a sequential scan of all 4,231 pages of `session`, about 266k calls in 2.7 days.
--     0484's `session_open_list_bg_jobs_idx` indexes the same rows but spells the test `cardinality(...) > 0`,
--     which is not what Prisma sends: it sends `"running_bg_jobs" <> $n` with `$n` = '{}'. The predicate here is
--     Prisma's own, so the planner can prove it. That proof needs the value, which it has because the adapter
--     sends every statement unnamed and so plans each one with its parameters (a custom plan). A statement
--     marked PREPARED_STATEMENT would be planned generically after five runs and could not use these.
--
-- Not CONCURRENTLY, as with 0283, 0305, 0353, 0361, 0417 and 0420: Prisma runs the migration in a transaction.
-- Each build is one pass over a small table (`task` is 256 MB of heap, `session` 33 MB) and holds a SHARE lock
-- that long. No row is written. Every statement can run twice.

CREATE INDEX IF NOT EXISTS "task_fork_snapshot_idx"
  ON "task" ("fork_runner_id")
  WHERE "fork_sha" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "session_bg_jobs_live_idx"
  ON "session" ("owner_id")
  WHERE "running_bg_jobs" <> '{}'::text[];

CREATE INDEX IF NOT EXISTS "session_bg_shells_live_idx"
  ON "session" ("owner_id")
  WHERE "running_bg_shells" <> '{}'::text[];
