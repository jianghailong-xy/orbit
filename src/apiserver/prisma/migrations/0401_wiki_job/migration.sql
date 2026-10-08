-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, server execution P1b: the job table and the model request queue.
-- contracts/wiki.contract.json `jobs` and `modelQueue` are the authority for everything below,
-- docs/wiki-server-execution-design.md §5 is the design, and
-- src/apiserver/src/wiki-worker/wiki-jobs.pg.spec.ts and …/wiki-model-queue.pg.spec.ts hold them to it.
--
-- WHAT IS ADDED
-- -------------
--   wiki_job             one row per unit of wiki work the server runs for a space (design §5.1): its kind,
--                        input, priority, state (queued | running | waiting | succeeded | failed |
--                        cancelled), the lease a worker holds while running it, its retries and backoff
--                        (attempts, next_attempt_at), and what it reported (progress, report, error,
--                        failure_kind). Claimed the way watch_delivery is: an UPDATE … FROM (SELECT … FOR
--                        UPDATE SKIP LOCKED) that gives each row a new lease generation, with every later
--                        write a compare-and-set on that generation.
--   wiki_model_request   one row per model call a job makes (design §5.2): (job_id, step, unit, attempt) is
--                        the request's identity, so replaying a pipeline reuses the answer a succeeded row
--                        already holds, or waits for the row still in flight. The queue's global
--                        concurrency is kept by one claim transaction per scheduler: an advisory lock, a
--                        count of running rows whose lease has not expired, and at most
--                        ORBIT_WIKI_MODEL_CONCURRENCY minus that count taken by priority DESC, enqueued_at
--                        ASC, SKIP LOCKED.
--   wiki_maintenance_run.job_id, wiki_plan_job.job_id
--                        a run or a plan job records the wiki_job that ran it, and task_id becomes nullable:
--                        a run is made by a task (the path until P8/P10) or by a job (the server path), never
--                        both, so the CHECKs require exactly one maker per started run. A plan job is exempt
--                        while it is queued or held — it has made neither yet.
--
-- LEASES
-- ------
-- A running row holds lease_owner, lease_generation and lease_deadline_at together, and the CHECK keeps the
-- three tied to the state: only 'running' carries them, and every settle clears them. A lease that runs out
-- is not lost work: reclaim puts the row back to queued (a request with its partial kept, its attempts one
-- higher; a job with attempts one higher and its next attempt on the backoff), and the takeover's
-- generation means the old holder's late write settles nothing.
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- No row is written, backfilled or locked. `wiki_maintenance_run.task_id` keeps its unique index and loses
-- only NOT NULL, which rewrites no row; the two `*_maker_chk` constraints hold for every stored row as it
-- stands (every existing run names its task, every plan job in made/ended names one, and neither names a
-- job). No trigger, function or type is created, replaced or dropped; `task`, `session` and `task_list` are
-- named nowhere below.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0401: origin/main stood at 0399 and this project's line at 0400_wiki_model_status when this was written
-- (2026-10-08), and no other branch or worktree on this host held 0400 or above. Every statement can run
-- twice: CREATE TABLE / INDEX IF NOT EXISTS with the constraints inside the CREATE TABLE, ADD COLUMN IF
-- NOT EXISTS, DROP NOT NULL on an already-nullable column, and each constraint added only when absent.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "wiki_job" (
  "id"                UUID NOT NULL,
  "owner_id"          UUID NOT NULL,
  "space_id"          UUID NOT NULL,
  "kind"              TEXT NOT NULL,
  -- The job's own material: what to verify, draft, build — never the model's address or key.
  "input"             JSONB NOT NULL DEFAULT '{}',
  -- Owner-initiated work (a plan draft, a build) sorts above background maintenance.
  "priority"          INTEGER NOT NULL DEFAULT 0,
  "state"             TEXT NOT NULL DEFAULT 'queued',
  -- Set exactly while waiting; a waiting job holds no lease.
  "waiting_for"       TEXT,
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at"   TIMESTAMPTZ(3),
  "lease_owner"       UUID,
  "lease_generation"  UUID,
  "lease_deadline_at" TIMESTAMPTZ(3),
  "progress"          JSONB,
  "report"            JSONB,
  "error"             TEXT,
  "failure_kind"      TEXT,
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at"        TIMESTAMPTZ(3),
  "ended_at"          TIMESTAMPTZ(3),
  CONSTRAINT "wiki_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_job_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- The kinds the server runs: P1b adds smoke, the end-to-end probe of the queue itself.
  CONSTRAINT "wiki_job_kind_chk" CHECK ("kind" IN
    ('verify', 'articles', 'import', 'plan_draft', 'plan_revise', 'docs_build', 'maintain', 'smoke')),
  CONSTRAINT "wiki_job_state_chk" CHECK ("state" IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT "wiki_job_waiting_chk" CHECK ("waiting_for" IS NULL OR ("state" = 'waiting' AND "waiting_for" IN ('repo', 'model'))),
  -- A lease is a running row's, whole or not at all: the three columns and the state imply each other.
  CONSTRAINT "wiki_job_lease_chk" CHECK (("state" = 'running') = ("lease_owner" IS NOT NULL
    AND "lease_generation" IS NOT NULL AND "lease_deadline_at" IS NOT NULL)),
  CONSTRAINT "wiki_job_failure_chk" CHECK ("failure_kind" IS NULL OR "failure_kind" IN ('infra', 'content')),
  -- Only an ended state carries an end; a reason is a failure's or a cancellation's, kept through an
  -- infra retry so the health line has something to show while the job waits to run again.
  CONSTRAINT "wiki_job_ended_chk" CHECK (("ended_at" IS NULL) OR "state" IN ('succeeded', 'failed', 'cancelled')),
  CONSTRAINT "wiki_job_error_chk" CHECK ("error" IS NULL OR "state" <> 'succeeded'),
  CONSTRAINT "wiki_job_counts_chk" CHECK ("attempts" >= 0 AND "priority" >= 0),
  CONSTRAINT "wiki_job_report_chk" CHECK ("report" IS NULL OR jsonb_typeof("report") = 'object'),
  CONSTRAINT "wiki_job_progress_chk" CHECK ("progress" IS NULL OR jsonb_typeof("progress") = 'object')
);
-- The claim: due queued jobs, the owner's first, then longest-waiting.
CREATE INDEX IF NOT EXISTS "wiki_job_claim_idx" ON "wiki_job" ("priority" DESC, "created_at", "id") WHERE "state" = 'queued';
-- The lease-expiry sweep.
CREATE INDEX IF NOT EXISTS "wiki_job_lease_expiry_idx" ON "wiki_job" ("lease_deadline_at") WHERE "state" = 'running';
-- One running job per space, whatever a scheduler's reading of the table says: the claim skips a space whose
-- job is running, and this index is what makes the rule hold even when two schedulers read at once.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_job_space_running_key" ON "wiki_job" ("space_id") WHERE "state" = 'running';
-- A space's jobs as health and Activity read them.
CREATE INDEX IF NOT EXISTS "wiki_job_space_created_idx" ON "wiki_job" ("space_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "wiki_model_request" (
  "id"                UUID NOT NULL,
  "job_id"            UUID NOT NULL,
  "owner_id"          UUID NOT NULL,
  "space_id"          UUID NOT NULL,
  -- Where in the job's pipeline this call sits: the step's name and the unit it is about.
  "step"              TEXT NOT NULL,
  "unit"              TEXT NOT NULL,
  -- Which attempt of that unit this row is (the identity a redo moves to), and how many times this row
  -- itself has been tried — a lease that ran out and a retryable failure each count one.
  "attempt"           INTEGER NOT NULL DEFAULT 1,
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "priority"          INTEGER NOT NULL DEFAULT 0,
  -- { system, prompt, maxTokens }: the call, and its sha256 so a replay proves it is the same call.
  "request"           JSONB NOT NULL,
  "request_sha256"    CHAR(64) NOT NULL,
  "state"             TEXT NOT NULL DEFAULT 'queued',
  "lease_owner"       UUID,
  "lease_generation"  UUID,
  "lease_deadline_at" TIMESTAMPTZ(3),
  "enqueued_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The backoff: not due before this, whatever the queue's order would say.
  "not_before"        TIMESTAMPTZ(3),
  "started_at"        TIMESTAMPTZ(3),
  "ended_at"          TIMESTAMPTZ(3),
  "answer"            TEXT,
  -- What had arrived when the call was interrupted: kept across a requeue, never cleared by one.
  "partial"           TEXT,
  "input_tokens"      INTEGER,
  "output_tokens"     INTEGER,
  "http_status"       INTEGER,
  "error"             TEXT,
  -- The class the client gave the failure (retryable | unauthorized | other), for the metrics and the job.
  "error_kind"        TEXT,
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_model_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wiki_model_request_job_fkey" FOREIGN KEY ("job_id") REFERENCES "wiki_job" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wiki_model_request_space_fkey"
    FOREIGN KEY ("space_id", "owner_id") REFERENCES "wiki_space" ("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- The request IS its identity: enqueuing the same call of the same unit again meets the row it already has.
  CONSTRAINT "wiki_model_request_unit_key" UNIQUE ("job_id", "step", "unit", "attempt"),
  CONSTRAINT "wiki_model_request_state_chk" CHECK ("state" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT "wiki_model_request_lease_chk" CHECK (("state" = 'running') = ("lease_owner" IS NOT NULL
    AND "lease_generation" IS NOT NULL AND "lease_deadline_at" IS NOT NULL)),
  -- An answer is a success's, and a success has one (an empty one is still an answer).
  CONSTRAINT "wiki_model_request_ended_chk" CHECK (("state" = 'succeeded') = ("answer" IS NOT NULL AND "ended_at" IS NOT NULL)),
  CONSTRAINT "wiki_model_request_error_chk" CHECK ("error" IS NULL OR ("state" = 'failed' OR "state" = 'queued' OR "state" = 'running')),
  CONSTRAINT "wiki_model_request_error_kind_chk" CHECK ("error_kind" IS NULL OR "error_kind" IN ('retryable', 'unauthorized', 'other')),
  CONSTRAINT "wiki_model_request_counts_chk" CHECK ("attempt" >= 1 AND "attempts" >= 0 AND "priority" >= 0
    AND ("input_tokens" IS NULL OR "input_tokens" >= 0) AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
    AND ("http_status" IS NULL OR ("http_status" >= 100 AND "http_status" <= 599))),
  CONSTRAINT "wiki_model_request_partial_chk" CHECK ("partial" IS NULL OR "state" IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT "wiki_model_request_request_chk" CHECK (jsonb_typeof("request") = 'object')
);
-- The claim: due queued requests by the queue's order.
CREATE INDEX IF NOT EXISTS "wiki_model_request_claim_idx"
  ON "wiki_model_request" ("priority" DESC, "enqueued_at", "id") WHERE "state" = 'queued';
-- The lease-expiry sweep.
CREATE INDEX IF NOT EXISTS "wiki_model_request_lease_expiry_idx" ON "wiki_model_request" ("lease_deadline_at") WHERE "state" = 'running';
-- A job's requests, as its pipeline and its replay read them.
CREATE INDEX IF NOT EXISTS "wiki_model_request_job_idx" ON "wiki_model_request" ("job_id", "step", "unit");
-- The metrics' aggregate and a job's own answer lookup.
CREATE INDEX IF NOT EXISTS "wiki_model_request_state_idx" ON "wiki_model_request" ("state", "ended_at");

ALTER TABLE "wiki_maintenance_run" ALTER COLUMN "task_id" DROP NOT NULL;
ALTER TABLE "wiki_maintenance_run" ADD COLUMN IF NOT EXISTS "job_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_maintenance_run_maker_chk') THEN
    ALTER TABLE "wiki_maintenance_run" ADD CONSTRAINT "wiki_maintenance_run_maker_chk"
      CHECK (("task_id" IS NOT NULL) <> ("job_id" IS NOT NULL));
  END IF;
END $$;

ALTER TABLE "wiki_plan_job" ADD COLUMN IF NOT EXISTS "job_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_plan_job_maker_chk') THEN
    ALTER TABLE "wiki_plan_job" ADD CONSTRAINT "wiki_plan_job_maker_chk"
      CHECK (("task_id" IS NOT NULL) <> ("job_id" IS NOT NULL) OR "state" IN ('queued', 'held'));
  END IF;
END $$;
