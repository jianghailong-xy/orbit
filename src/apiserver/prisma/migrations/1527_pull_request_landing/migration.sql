-- 1527 — landing on a protected GitHub branch through a pull request (docs/design/protected-branch-landing.md §7).
--
-- WHY
-- ===
-- On Orbit Cloud a landing pushes its tested commit to the target with the GitHub App's installation token, and
-- GitHub refuses that push on a branch whose rules require a pull request (GH006, GH013). From then on a landing
-- whose direct push is refused that way pushes the same commit to a branch of Orbit's own, `orbit/land/<id>`, and
-- lands through a pull request Orbit opens and merges once GitHub's rules pass. The wait is one new state of the
-- integration job that already runs every landing, `PULL_REQUEST`; the pull request itself is a row of its own.
--
-- WHAT IT ADDS
-- ============
--   * `workspace.landing_mode` (NULL is PULL_REQUEST) and `workspace.push_as_me_refusal`: the per-workspace setting
--     and the last refusal GitHub gave a Push as me landing (§5, §11.1). Both NULL on every existing row.
--   * `project_integration_job`:
--       - state `PULL_REQUEST` (not final: the terminal guard and J3's one-landing-per-task index include it);
--       - `land_via` (PUSH | PULL_REQUEST | PUSH_AS_ME, fixed when the attempt is handed out; NULL is PUSH),
--         `landing_ref`, `pull_request_id` (a history reference, no foreign key, as `session_id` is since 0424),
--         `owner_token_generation` (§5.2: the claim generation the owner's token was answered for);
--       - J2 (`project_integration_job_landed_tree_chk`) gains §4.4's one exception, recorded rather than hidden:
--         a pull request GitHub merged while the target moved in the second after Orbit read it lands a tree that is
--         not the tested one. Only a row that names its pull request may say so, and the same transaction opens the
--         INTEGRATION_ERROR item that asks for the project's check on the target.
--     `error_code` has no CHECK (0453): PUSH_PROTECTED, PULL_REQUEST_CLOSED and PULL_REQUEST_HEAD_CHANGED are
--     additions to `INTEGRATION_ERROR_CODES`.
--   * `session.merge_pull_request_id`, `session.merge_owner_token_for`: a session's own Merge through a pull request
--     (§4.6). `merge_status` is free text and gains `pull_request` in its readers only.
--   * `session_merge_receipt.recorded_by` admits `SERVER`: the server wrote the receipt from GitHub's answer.
--   * `github_app_config.webhook_secret_enc`, write-only like the client secret; '' is none saved.
--   * `github_pull_request`: one pull request Orbit opened to land work; exactly one of `landing_id` and `session_id`.
--   * `project_integration_job_event.kind` admits PULL_REQUEST: the landing timeline's pull request rows.
--   * `github_webhook_delivery`: GitHub's deliveries by their id, to de-duplicate them. No payload is stored.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Nullable columns with no default and two new tables; nothing existing is rewritten. Every constraint that is
-- widened admits all it admitted before. Rolling the code back leaves the columns unread and the state unwritten.
--
-- TAKING THE LOCKS IN SHORT TRIES
-- ===============================
-- `session`, `workspace` and `project_integration_job` are read on every runner call. A waiting ALTER queues every
-- later reader and writer behind it, and production's lock_timeout of 30 s would fail the migration and keep the
-- apiserver from starting (P3009). The file holds a DO statement, so `migrate deploy` sends it whole as one implicit
-- transaction: the DO below takes every lock the file needs together, 1 s per lock with 1 s between tries in which
-- everything else runs, up to 40 tries (inside statement_timeout's 300 s), and the statements after it find the
-- locks already held. A deadlock with a running transaction is retried the same way.
--
-- 1527: the highest number on main, project/* and the local orbit/* branches was 1495 when this was written; the
-- number is not a multiple of 10, which every session tends to take next.

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  LOOP
    BEGIN
      LOCK TABLE "workspace" IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE "project_integration_job" IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE "session_merge_receipt" IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE "github_app_config" IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE "project_integration_job_event" IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 40 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
END $$;

-- ── workspace ───────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "workspace"
  ADD COLUMN IF NOT EXISTS "landing_mode" TEXT,
  ADD COLUMN IF NOT EXISTS "push_as_me_refusal" JSONB;
ALTER TABLE "workspace" DROP CONSTRAINT IF EXISTS "workspace_landing_mode_chk";
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_landing_mode_chk"
  CHECK ("landing_mode" IS NULL OR "landing_mode" IN ('PULL_REQUEST', 'PUSH_AS_ME'));

-- ── project_integration_job ─────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "project_integration_job"
  ADD COLUMN IF NOT EXISTS "land_via" TEXT,
  ADD COLUMN IF NOT EXISTS "landing_ref" TEXT,
  ADD COLUMN IF NOT EXISTS "pull_request_id" UUID,
  ADD COLUMN IF NOT EXISTS "owner_token_generation" BIGINT;
ALTER TABLE "project_integration_job"
  DROP CONSTRAINT IF EXISTS "project_integration_job_land_via_chk",
  ADD CONSTRAINT "project_integration_job_land_via_chk"
    CHECK ("land_via" IS NULL OR "land_via" IN ('PUSH', 'PULL_REQUEST', 'PUSH_AS_ME')),
  -- 0453's list plus the new value.
  DROP CONSTRAINT IF EXISTS "project_integration_job_state_chk",
  ADD CONSTRAINT "project_integration_job_state_chk" CHECK ("state" IN (
    'QUEUED', 'RUNNING', 'LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'READY',
    'CONFLICT', 'CHECK_FAILED', 'ERROR', 'CANCELLED', 'SUPERSEDED', 'OBSERVED', 'PULL_REQUEST')),
  -- A job waits on a pull request only after its runner pushed the landing branch: it names the branch and the row.
  DROP CONSTRAINT IF EXISTS "project_integration_job_pull_request_chk",
  ADD CONSTRAINT "project_integration_job_pull_request_chk" CHECK (
    "state" <> 'PULL_REQUEST' OR (
      "land_via" IN ('PULL_REQUEST', 'PUSH_AS_ME') AND "landing_ref" IS NOT NULL AND "pull_request_id" IS NOT NULL
      AND "tested_sha" IS NOT NULL AND "tested_tree_sha" IS NOT NULL)),
  -- J2, with §4.4's recorded exception: what landed is what was tested, unless GitHub merged the job's pull request
  -- onto a target that moved in between, which only a row naming its pull request can say. Otherwise 0281's
  -- expression, so every row it admitted is admitted still.
  DROP CONSTRAINT IF EXISTS "project_integration_job_landed_tree_chk",
  ADD CONSTRAINT "project_integration_job_landed_tree_chk" CHECK (
    "state" <> 'LANDED' OR (
      "landed_sha" IS NOT NULL AND "tested_tree_sha" IS NOT NULL
      AND ("landed_tree_sha" = "tested_tree_sha" OR "pull_request_id" IS NOT NULL)));

-- J3: one in-flight landing per task, a landing waiting on its pull request included.
DROP INDEX IF EXISTS "project_integration_job_task_inflight_key";
CREATE UNIQUE INDEX "project_integration_job_task_inflight_key"
  ON "project_integration_job" ("task_id")
  WHERE "kind" = 'LAND_TASK' AND "state" IN ('QUEUED', 'RUNNING', 'PULL_REQUEST');

-- J4: a finished job is final; a job waiting on its pull request is not finished.
CREATE OR REPLACE FUNCTION "project_integration_job_terminal_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" NOT IN ('QUEUED', 'RUNNING', 'PULL_REQUEST') THEN
    RAISE EXCEPTION 'PROJECT_INTEGRATION_JOB_TERMINAL'
      USING ERRCODE = 'P0001',
            DETAIL = 'a finished integration job is final; a retry is a new generation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── project_integration_job_event ───────────────────────────────────────────────────────────────────────────────
-- 0438's list plus PULL_REQUEST: the landing timeline's rows about the pull request (§14: pushed, opened, merged),
-- each with the server's English text and its step in `data`.
ALTER TABLE "project_integration_job_event"
  DROP CONSTRAINT IF EXISTS "project_integration_job_event_kind_chk",
  ADD CONSTRAINT "project_integration_job_event_kind_chk" CHECK ("kind" IN (
    'ENQUEUED', 'STEP', 'ROUND', 'CHECK_STARTED', 'CHECK_FINISHED', 'CLAIMED', 'TAKEN_OVER', 'RELEASED',
    'PUSH_REFUSED', 'RECHECK_ON_MOVED_MAIN', 'NEXT_GENERATION', 'RESULT', 'REQUEUED', 'HANDED_TO',
    'STOP_REQUESTED', 'CANCELLED', 'ABANDONED', 'TIMED_OUT', 'PULL_REQUEST'));

-- ── session ─────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "session"
  ADD COLUMN IF NOT EXISTS "merge_pull_request_id" UUID,
  ADD COLUMN IF NOT EXISTS "merge_owner_token_for" TEXT;

-- ── session_merge_receipt ───────────────────────────────────────────────────────────────────────────────────────
-- 0128's list plus SERVER: a receipt the server wrote from GitHub's answer about a pull request it merged.
ALTER TABLE "session_merge_receipt"
  DROP CONSTRAINT IF EXISTS "session_merge_receipt_recorded_by_check",
  ADD CONSTRAINT "session_merge_receipt_recorded_by_check"
    CHECK ("recorded_by" IN ('RUNNER', 'AGENT', 'USER', 'SERVER'));

-- ── github_app_config ───────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "github_app_config" ADD COLUMN IF NOT EXISTS "webhook_secret_enc" TEXT NOT NULL DEFAULT '';

-- ── github_pull_request ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "github_pull_request" (
  "id"              UUID NOT NULL,
  "owner_id"        UUID NOT NULL,
  "workspace_id"    UUID NOT NULL,
  "github_repo_id"  BIGINT NOT NULL,
  "installation_id" BIGINT NOT NULL,
  -- The landing subject (`project_landing`: a task segment or a promotion round), or a session's own Merge.
  -- History references, as `project_integration_job.session_id` is: no foreign key.
  "landing_id"      UUID,
  "session_id"      UUID,
  "base_ref"        TEXT NOT NULL,
  "head_ref"        TEXT NOT NULL,
  "number"          INTEGER,
  "url"             TEXT,
  "state"           TEXT NOT NULL,
  "head_sha"        CHAR(40),
  "base_sha"        CHAR(40),
  -- The source commit the head was built from: what the receipt names when the pull request merges.
  "source_sha"      CHAR(40),
  "tested_tree_sha" CHAR(40),
  "merge_method"    TEXT,
  "condition"       TEXT,
  "checks"          JSONB NOT NULL DEFAULT '[]',
  "refusal"         JSONB,
  "merged_sha"      CHAR(40),
  "merged_by"       TEXT,
  "closed_by"       TEXT,
  "observed_at"     TIMESTAMPTZ(3),
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(3) NOT NULL,
  "merged_at"       TIMESTAMPTZ(3),
  "closed_at"       TIMESTAMPTZ(3),
  CONSTRAINT "github_pull_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "github_pull_request_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE CASCADE,
  CONSTRAINT "github_pull_request_state_chk" CHECK ("state" IN ('OPENING', 'OPEN', 'MERGED', 'CLOSED')),
  CONSTRAINT "github_pull_request_subject_chk" CHECK (("landing_id" IS NULL) <> ("session_id" IS NULL)),
  -- GitHub numbers a pull request when it opens it; one closed before it was ever opened has none.
  CONSTRAINT "github_pull_request_number_chk" CHECK ("state" IN ('OPENING', 'CLOSED') OR "number" IS NOT NULL),
  CONSTRAINT "github_pull_request_merged_chk" CHECK ("state" <> 'MERGED' OR "merged_sha" IS NOT NULL),
  CONSTRAINT "github_pull_request_merge_method_chk"
    CHECK ("merge_method" IS NULL OR "merge_method" IN ('merge', 'rebase', 'squash')),
  CONSTRAINT "github_pull_request_condition_chk" CHECK ("condition" IS NULL OR "condition" IN (
    'CHECKS_PENDING', 'CHECK_FAILED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED', 'BEHIND', 'CONFLICTING',
    'MERGEABLE', 'MERGE_QUEUE', 'UNKNOWN'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "github_pull_request_repo_number_key"
  ON "github_pull_request" ("github_repo_id", "number");
-- One open pull request per landing subject, per session, and per head branch.
CREATE UNIQUE INDEX IF NOT EXISTS "github_pull_request_open_landing_key"
  ON "github_pull_request" ("landing_id") WHERE "state" IN ('OPENING', 'OPEN') AND "landing_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "github_pull_request_open_session_key"
  ON "github_pull_request" ("session_id") WHERE "state" IN ('OPENING', 'OPEN') AND "session_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "github_pull_request_open_head_key"
  ON "github_pull_request" ("github_repo_id", "head_ref") WHERE "state" IN ('OPENING', 'OPEN');
-- What the re-read reads (§4.7): the open ones, the longest unread first.
CREATE INDEX IF NOT EXISTS "github_pull_request_open_observed_idx"
  ON "github_pull_request" ("observed_at") WHERE "state" IN ('OPENING', 'OPEN');
CREATE INDEX IF NOT EXISTS "github_pull_request_owner_idx" ON "github_pull_request" ("owner_id", "created_at");

-- ── github_webhook_delivery ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "github_webhook_delivery" (
  -- X-GitHub-Delivery.
  "id"              TEXT NOT NULL,
  "event"           TEXT NOT NULL,
  "action"          TEXT,
  "installation_id" BIGINT,
  "github_repo_id"  BIGINT,
  "pull_number"     INTEGER,
  "received_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "applied_at"      TIMESTAMPTZ(3),
  CONSTRAINT "github_webhook_delivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "github_webhook_delivery_id_chk" CHECK (length("id") BETWEEN 1 AND 100)
);
CREATE INDEX IF NOT EXISTS "github_webhook_delivery_received_idx" ON "github_webhook_delivery" ("received_at");
