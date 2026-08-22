-- A comment that @-mentions an agent is a message somebody sent. Deliver it exactly once, and be
-- able to say what happened to it.
--
-- WHAT WAS WRONG
-- ==============
-- `addComment` committed the comment and then, outside that transaction, looped over the mentioned
-- workspaces calling a best-effort trigger whose failures were caught and logged. Three ways that
-- loses a message with no trace:
--
--   * the process dies after the comment commits — nothing retries, and the comment sits in the
--     thread looking delivered;
--   * a runner is offline or a provider is down — one `logger.warn`, an API that answered 201, and
--     an agent that never replies;
--   * two workspaces are mentioned and the first succeeds — the second's failure is invisible, and
--     the caller cannot tell a partial delivery from a complete one.
--
-- Worse, the second workspace could not succeed at all: a mention opened a session bound to the
-- task, so the FIRST one took the task's execution claim and the second collided with it.
--
-- TWO THINGS, AND THEY ARE SEPARATE
-- =================================
-- 1. A conversation about a task is not a run of it. `session.context_task_id` says which task a
--    session is ABOUT while `task_id` keeps meaning "this session is executing that task". A
--    communication session carries the second as NULL, so it takes no execution claim, occupies no
--    §9.4 slot, does not follow the task's lifecycle — and, decisively, is invisible as a task
--    session to the 0.1.130 binary still running during a rolling deploy, which would otherwise
--    read it as the task already running and report a start that never happened.
--
-- 2. Delivery is a LEDGER, not a loop. One row per (comment, workspace), written in the same
--    transaction as the comment, worked off by a sweep that retries with backoff and records why
--    it is stuck. "The comment exists" and "the mention was delivered" become two facts that can
--    be compared, which is the whole difference between at-least-once and hope.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. What a session is ABOUT, as distinct from what it EXECUTES.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "session" ADD COLUMN "context_task_id" UUID;

-- SET NULL rather than CASCADE: a conversation about a deleted task is still a conversation
-- somebody had, and its transcript is not the task's to take with it. The same choice
-- `superseded_by_task_id` makes, for the same reason.
ALTER TABLE "session"
  ADD CONSTRAINT "session_context_task_id_fkey"
  FOREIGN KEY ("context_task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The two are mutually exclusive by construction. A session that executes a task is already about
-- it, and a row carrying both would make every reader choose which one it meant — including the
-- 0.1.130 reader, which only knows one of them.
ALTER TABLE "session"
  ADD CONSTRAINT "session_task_context_exclusive_check"
  CHECK ("task_id" IS NULL OR "context_task_id" IS NULL);

CREATE INDEX "session_context_task_id_idx" ON "session" ("context_task_id")
  WHERE "context_task_id" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. Which delivery contract a comment was written under.
-- ---------------------------------------------------------------------------------------------
--
-- The rolling-deploy problem in one column. During the window both binaries write comments:
--
--   0.1.130 does not know the ledger exists and delivers inline. Its comments must NOT get ledger
--     rows, or the new sweep would deliver them a second time.
--   This release writes `1`, delivers nothing inline, and lets the trigger below file the ledger.
--
-- DEFAULT 0 is what makes the old binary's silence mean the old contract. A reader showing delivery
-- state renders version 0 as LEGACY_UNTRACKED — not "delivered", which nobody recorded, and not
-- "failed" either.
ALTER TABLE "task_comment"
  ADD COLUMN "mention_delivery_version" SMALLINT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------------------------
-- 3. The ledger.
-- ---------------------------------------------------------------------------------------------

CREATE TYPE "task_comment_mention_delivery_status" AS ENUM (
  -- Filed, nobody has taken it yet.
  'PENDING',
  -- Leased by a worker. A lease expires so a worker that died does not strand the row.
  'DELIVERING',
  -- The conversation exists and carries the prompt, but no `conversation_turn` does yet — the
  -- runner has not claimed the session. Not DELIVERED, because nothing has been handed to anybody;
  -- not BLOCKED, because nothing is wrong. The sweep revisits it until the turn appears.
  'SESSION_CREATED',
  -- The turn EXISTS and is still PENDING: durably queued, not yet handed to the engine.
  --
  -- The distinction matters because a queued turn can still be lost. A work session with the task
  -- prompt at seq 1 and this mention at seq 2 fails on seq 1: the mention's row is right there in
  -- the table, and the agent never saw a word of it. Calling that DELIVERED — which "the row
  -- exists" would — retires the ledger on a message nobody read, and no sweep ever looks again.
  'QUEUED',
  -- A turn exists in a session for this exact (comment, workspace). Terminal and the only success.
  'DELIVERED',
  -- Cannot be delivered right now for a reason outside this system's control — no runner, provider
  -- down, the task's project mid-reconcile. Retried; it is a state, not a failure.
  'BLOCKED',
  -- The attempt budget is spent. Terminal, and deliberately loud: somebody has to look.
  'DEAD'
);

CREATE TABLE "task_comment_mention_delivery" (
  "id"                UUID PRIMARY KEY,
  "comment_id"        UUID NOT NULL REFERENCES "task_comment"("id") ON DELETE CASCADE,
  "task_id"           UUID NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
  -- WHO was mentioned, as an immutable snapshot: NOT NULL and with NO foreign key.
  --
  -- A cascade here was the bug: deleting a runner cascades to its workspaces, which would have
  -- cascaded to these rows — so the comment survives, the mention it made does not, and the reason
  -- the agent never replied is gone with it. The ledger is an audit of what was ASKED FOR, and what
  -- was asked for does not change because the target was later deleted.
  --
  -- Tenancy comes from `owner_id` and from the worker resolving this id under that owner; a target
  -- that no longer resolves ends the delivery at WORKSPACE_GONE rather than vanishing.
  "workspace_id"      UUID NOT NULL,
  "owner_id"          UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "status"            "task_comment_mention_delivery_status" NOT NULL DEFAULT 'PENDING',
  -- TWO counters, because two different things are being bounded.
  --
  -- `attempts` is the DELIVERY BUDGET: tries that failed for a reason belonging to this delivery.
  -- It is what reaches `DEAD`, and availability — no runner, a provider down — must not spend it,
  -- or a message is abandoned because a machine was rebooting.
  --
  -- `claims` counts every lease ever taken, including by workers that died before deciding
  -- anything. It bounds the OTHER failure mode: a delivery that crashes the worker every time
  -- would otherwise be re-leased for ever, spending no budget and never reaching a terminal state.
  -- THREE counters, because three different things are bounded and collapsing any two of them
  -- either loses a message or abandons one.
  --
  -- `attempts` — the DELIVERY BUDGET: tries that failed for a reason belonging to this delivery.
  --   This is what reaches DEAD.
  -- `claims`   — CONSECUTIVE CRASH RECOVERIES: leases that expired while still DELIVERING, meaning
  --   a worker died mid-flight. Bounds the loop that spends no budget and would otherwise be
  --   re-leased for ever. Deliberately NOT advanced by an ordinary poll, and RESET to zero by any
  --   worker that reaches a decision — sixty-four ordinary waits for a runner must not be
  --   indistinguishable from sixty-four dying workers.
  -- `waits`    — availability and polling generations: no runner yet, no turn seeded yet. Drives
  --   the backoff and nothing else. No cap, because "the machine is still down" is not a reason to
  --   throw away a message somebody sent.
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "claims"            INTEGER NOT NULL DEFAULT 0,
  "waits"             INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_holder"      TEXT,
  "lease_expires_at"  TIMESTAMP(3),
  -- WHY it is BLOCKED or DEAD, in three parts, because a UI cannot act on a sentence.
  --
  --   `error_code`      — the closed name of the condition (NO_RUNNER, PROVIDER_UNAVAILABLE …),
  --                       which is what a client switches on and an operator greps for;
  --   `required_action` — what would clear it, addressed to whoever can do it;
  --   `last_error`      — the underlying message, for the case nobody anticipated.
  --
  -- Free text alone is what the old inline loop produced — a `logger.warn` — and the whole reason
  -- nobody could tell a stuck mention from a delivered one.
  "error_code"        TEXT,
  "required_action"   TEXT,
  "last_error"        TEXT,
  -- WHERE THIS IS GOING, decided before it goes there.
  --
  -- Two columns, and the split is forced by the ordering the delivery needs. A worker binds its
  -- intended session id BEFORE creating that session, so a crash between the two retries with the
  -- SAME id instead of opening a second conversation. That id therefore names a row which does not
  -- exist yet — which an immediate FK would refuse, making the fresh-mention path unreachable.
  --
  --   `desired_session_id` — no FK. The intent, written first.
  --   `target_session_id`  — FK. Where it actually landed, written once the row exists.
  --
  -- A retry reads `desired_session_id`, finds no session with that id, and creates it again with
  -- that id; the insert is idempotent on the primary key.
  "desired_session_id" UUID,
  "target_session_id" UUID REFERENCES "session"("id") ON DELETE SET NULL,
  -- The turn that carried it. A fresh conversation's opening prompt IS the delivery, and its first
  -- turn is seeded by the runner when it claims the session — so this is NULL until that exists,
  -- and the row sits at SESSION_CREATED rather than claiming DELIVERED. A column that names a turn
  -- must name one that exists; filling it with the session id to look complete is how a receipt
  -- starts lying.
  "turn_id"           UUID,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- THE key. One mention, one delivery, whatever retries or duplicate sweeps happen — and the reason
-- a re-run of the trigger below writes nothing rather than a second row.
CREATE UNIQUE INDEX "task_comment_mention_delivery_comment_workspace_key"
  ON "task_comment_mention_delivery" ("comment_id", "workspace_id");

-- The sweep's own read: due work, oldest first. Partial, because DELIVERED and DEAD are terminal
-- and are the overwhelming majority of the table once it has been running a while.
CREATE INDEX "task_comment_mention_delivery_due_idx"
  ON "task_comment_mention_delivery" ("next_attempt_at", "created_at")
  WHERE "status" IN ('PENDING', 'DELIVERING', 'SESSION_CREATED', 'QUEUED', 'BLOCKED');

-- DELIVERED means a turn carried it. The two columns cannot disagree, whoever writes them.
ALTER TABLE "task_comment_mention_delivery"
  ADD CONSTRAINT "task_comment_mention_delivery_turn_check"
  CHECK ("status" <> 'DELIVERED' OR "turn_id" IS NOT NULL);

CREATE INDEX "task_comment_mention_delivery_task_idx"
  ON "task_comment_mention_delivery" ("task_id", "created_at");

-- ---------------------------------------------------------------------------------------------
-- 4. Filing the ledger IS the comment write.
-- ---------------------------------------------------------------------------------------------
--
-- A trigger rather than a second service statement, for the reason §2.4 gives about every other
-- guard here: the atomicity has to hold for whoever writes the row, and "the comment committed but
-- its deliveries did not" is exactly the failure this table exists to remove. One statement, one
-- transaction, no window.
--
-- `mentions` is deduplicated and NULLs dropped before the insert: the column is user input, and a
-- comment naming one agent twice is one mention.
CREATE OR REPLACE FUNCTION "task_comment_mention_delivery_file"() RETURNS trigger AS $$
BEGIN
  IF NEW."mention_delivery_version" <> 1 THEN
    RETURN NEW;
  END IF;

  -- One row per DISTINCT mentioned id, joined only to the task — for the owner. Deliberately NOT
  -- joined to `workspace`: an inner join there silently files ZERO deliveries when the target was
  -- deleted between the caller resolving it and this statement, which is a mention that never
  -- happened as far as any reader is concerned. The worker resolves the target and records
  -- WORKSPACE_GONE when it cannot, which is a fact somebody can read.
  INSERT INTO "task_comment_mention_delivery" (
    "id", "comment_id", "task_id", "workspace_id", "owner_id"
  )
  SELECT gen_random_uuid(), NEW."id", NEW."task_id", mentioned.id, t."owner_id"
    FROM "task" t
    CROSS JOIN LATERAL (SELECT DISTINCT unnest(NEW."mentions") AS id) AS mentioned
   WHERE t."id" = NEW."task_id" AND mentioned.id IS NOT NULL
  ON CONFLICT ("comment_id", "workspace_id") DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_comment_mention_delivery_file"
  AFTER INSERT ON "task_comment"
  FOR EACH ROW EXECUTE FUNCTION "task_comment_mention_delivery_file"();

COMMIT;
