-- 0437 — check output: one table for the chunks a v2 runner uploads while a check runs
-- (docs/project-integration-line-contract.md §2.2 J-T4's output route, §2.9 LS2; design
-- docs/landing-session-design.md §8 phase 3).
--
-- WHAT IT ADDS
-- ============
-- `project_integration_job_log`, one row per uploaded chunk of one check's output. A chunk is keyed
-- by the attempt it belongs to — job, claim generation, round, check (name and position) and the
-- chunk's own seq — so a resent chunk is the chunk already stored and never a second copy. The
-- runner uploads while the check runs; the control plane keeps a bounded head and tail per check
-- (see `INTEGRATION_LOG_HEAD_BYTES` / `INTEGRATION_LOG_TAIL_BYTES` in
-- `src/apiserver/src/runner-api/integration-job-relay.ts`) and records the dropped middle as
-- `truncated_bytes` on the first retained tail row.
--
-- NOT `run_event`
-- ===============
-- The output deliberately has a table of its own. `run_event` is the hot transcript table, and
-- check output there would be the 868 MB/day lesson the design records; nothing here is a session
-- event and nothing joins it to a transcript.
--
-- CHECKS
-- ======
-- The closed set of check names, and positive/index/byte bounds, are CHECKs rather than comments:
-- a chunk is written by a runner, and a malformed one must not become a row a reader has to
-- interpret. `octet_length(text) <= 65536` is the hard cap on one chunk; the runner sends 16 KiB.
--
-- LOCKS
-- =====
-- Rank 60, a child of `project_integration_job`: the output gate takes the job row (60) first and
-- then writes here, so it never waits on a `session` lock (contract §2.9 LS2). The foreign key
-- cascades with its job; a job row is already never rewritten once terminal (0281's guard) and a
-- project delete takes its own jobs with it.

BEGIN;

CREATE TABLE "project_integration_job_log" (
  "id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  "claim_generation" bigint NOT NULL,
  "round" integer NOT NULL,
  "check_name" text NOT NULL,
  "check_index" integer NOT NULL,
  "seq" integer NOT NULL,
  "text" text NOT NULL,
  -- Bytes of this check's output dropped from the middle BEFORE this chunk. Non-zero only on the
  -- first retained tail row, where a reader draws the "N bytes omitted" line.
  "truncated_bytes" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "project_integration_job_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_integration_job_log_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "project_integration_job"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_integration_job_log_check_name_chk"
    CHECK ("check_name" IN ('TASK_ACCEPTANCE', 'MERGE_CHECK')),
  CONSTRAINT "project_integration_job_log_claim_generation_chk" CHECK ("claim_generation" >= 1),
  CONSTRAINT "project_integration_job_log_round_chk" CHECK ("round" >= 1),
  CONSTRAINT "project_integration_job_log_check_index_chk" CHECK ("check_index" >= 1),
  CONSTRAINT "project_integration_job_log_seq_chk" CHECK ("seq" >= 0),
  CONSTRAINT "project_integration_job_log_truncated_bytes_chk" CHECK ("truncated_bytes" >= 0),
  CONSTRAINT "project_integration_job_log_text_bytes_chk" CHECK (octet_length("text") <= 65536)
);

-- The idempotency key: a retried upload of seq N is the chunk already stored.
CREATE UNIQUE INDEX "project_integration_job_log_key"
    ON "project_integration_job_log" ("job_id", "claim_generation", "round", "check_name", "check_index", "seq");

-- The page read: one check's chunks in the order they were produced, and the whole job's chunks in
-- (claim, round, check, seq) order when the reader does not narrow to one check.
CREATE INDEX "project_integration_job_log_page_idx"
    ON "project_integration_job_log" ("job_id", "claim_generation", "round", "check_index", "seq");

COMMIT;
