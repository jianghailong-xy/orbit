-- 0438 — the landing timeline: one append-only row per fact an integration job recorded
-- (docs/project-integration-line-contract.md §2.9 LS2/LS4; design docs/landing-session-design.md
-- §2.9 and §6 phase 3; mockups docs/mocks/landing-session/v4/05-landing-session-page.html).
--
-- WHAT IT ADDS
-- ============
-- `project_integration_job_event`, the ledger the landing page's timeline is drawn from. A row is
-- one fact about one attempt: it was enqueued, a step started, a round began, a check started or
-- finished, a claim was made or taken over, the push was refused, the job was handed to somebody,
-- a stop was asked, it was abandoned, released, ended, timed out, or a moved main was answered by
-- checking again / queueing the next generation.
--
-- A ROW IS WRITTEN BY THE DOOR THAT DECIDED THE FACT, in the same transaction as the job-gate write
-- it describes (LS2). The two exceptions are the claim and the takeover: `claimOne` is one
-- auto-commit statement, so those are backfilled from the committed claim in an independent
-- transaction immediately after it. Nothing here is written by a session, and nothing here is a
-- `run_event`: a landing is platform work, has no agent transcript, and the timeline must not put
-- rows in the hot table.
--
-- IDENTITY
-- ========
-- `(job_id, key)`: every writer names the fact it records, and the same fact replayed — a resent
-- result, a repeated progress report, a second stop press — is the row already stored. The writers
-- use `ON CONFLICT ("job_id", "key") DO NOTHING`, so a replay is not an error.
--
-- THE ENGLISH TEXT
-- ================
-- `text` is the sentence a client draws, written once by the server (mockup v4 §05's sentences);
-- `data` carries the structured fields the same line is drawn with (the moved commits and their
-- `outsideQueue`/`landedBy`, the item an attempt was handed to, a timeout's limit, …). Clients
-- lay out; they never build a sentence from the fields.
--
-- LOCKS
-- =====
-- Rank 60, a child of `project_integration_job`: every writer that records a fact already holds the
-- job row (rank 60) or takes it in the same statement, and inserts here after it. The table takes no
-- other lock and no writer of it reads or writes a `session` row — a job gate must not wait on a
-- session lock (LS2). The foreign key cascades with its job; the append-only trigger admits that
-- cascade and refuses every other UPDATE or DELETE.

BEGIN;

CREATE TABLE "project_integration_job_event" (
  "id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  -- The ledger's own order. `at` is when the fact happened, which is not always when it was
  -- written (a check's start reconstructed from its result carries the start instant) and can be
  -- the same instant for every fact one transaction writes; this sequence is what orders those.
  "seq" bigserial NOT NULL,
  -- The fact's identity within its attempt: `enqueued`, `claim:2`, `result`, `stop-requested`, …
  -- Replaying a fact inserts nothing.
  "key" text NOT NULL,
  -- The closed set of facts, a CHECK rather than a comment: a writer is a door, and a typo must not
  -- become a row a reader has to interpret.
  "kind" text NOT NULL,
  -- Which claim the fact happened under; 0 for facts from before the first claim (the enqueue).
  "claim_generation" bigint NOT NULL DEFAULT 0,
  -- The round inside that claim, when the fact names one (a v2 report's round, a check's result).
  "round" integer,
  "check_name" text,
  "check_index" integer,
  "phase" text,
  "step" text,
  -- Who caused the fact, when a person or a conversation did: the owner, the project's
  -- coordinator, the platform itself, the runner, or the Automatic setting.
  "actor_type" text,
  "actor_session_id" uuid,
  "actor_user_id" uuid,
  -- The reason a person gave (a stop, an abandon, a rerun), never a decision copied from another
  -- row: LS4's retry / handling / confirmation facts are derived at read time from their own rows.
  "reason" text,
  -- The structured fields the line is drawn with.
  "data" jsonb,
  -- The sentence a client draws, written by the server in English.
  "text" text NOT NULL,
  -- When the fact happened, which is not always when it was written: a check's start reconstructed
  -- from its result carries the start instant.
  "at" timestamptz(3) NOT NULL DEFAULT now(),
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT "project_integration_job_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_integration_job_event_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "project_integration_job"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_integration_job_event_kind_chk" CHECK ("kind" IN (
    'ENQUEUED',
    'STEP',
    'ROUND',
    'CHECK_STARTED',
    'CHECK_FINISHED',
    'CLAIMED',
    'TAKEN_OVER',
    'RELEASED',
    'PUSH_REFUSED',
    'RECHECK_ON_MOVED_MAIN',
    'NEXT_GENERATION',
    'RESULT',
    'HANDED_TO',
    'STOP_REQUESTED',
    'CANCELLED',
    'ABANDONED',
    'TIMED_OUT'
  )),
  CONSTRAINT "project_integration_job_event_actor_type_chk" CHECK (
    "actor_type" IS NULL OR "actor_type" IN ('OWNER', 'COORDINATOR', 'PLATFORM', 'RUNNER', 'AUTOMATIC')),
  CONSTRAINT "project_integration_job_event_claim_generation_chk" CHECK ("claim_generation" >= 0),
  CONSTRAINT "project_integration_job_event_round_chk" CHECK ("round" IS NULL OR "round" >= 1),
  CONSTRAINT "project_integration_job_event_check_name_chk" CHECK (
    "check_name" IS NULL OR "check_name" IN ('TASK_ACCEPTANCE', 'MERGE_CHECK')),
  CONSTRAINT "project_integration_job_event_check_index_chk" CHECK (
    "check_index" IS NULL OR "check_index" >= 1),
  CONSTRAINT "project_integration_job_event_check_pair_chk" CHECK (
    ("check_name" IS NULL) = ("check_index" IS NULL))
);

-- The idempotency key: a replayed fact is the row already stored.
CREATE UNIQUE INDEX "project_integration_job_event_key"
    ON "project_integration_job_event" ("job_id", "key");

-- The timeline read: one attempt's facts in production order — the claim, then the round, then the
-- ledger's own sequence, with `at` (the fact's instant) beside it — and the page a claim or round
-- narrows.
CREATE INDEX "project_integration_job_event_page_idx"
    ON "project_integration_job_event" ("job_id", "claim_generation", "round", "at", "seq");

-- Append-only, enforced where rows live. The cascade from a deleted job is the one DELETE that is
-- not a rewrite of history: by the time it fires the job row is already gone.
CREATE OR REPLACE FUNCTION "project_integration_job_event_append_only"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM "project_integration_job" WHERE "id" = OLD."job_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'INTEGRATION_JOB_EVENT_APPEND_ONLY: event % cannot be rewritten', OLD."id"
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_integration_job_event_append_only"
  BEFORE UPDATE OR DELETE ON "project_integration_job_event"
  FOR EACH ROW EXECUTE FUNCTION "project_integration_job_event_append_only"();

COMMIT;
