-- Unit L4 — the user's answer about one crossing, and the one task it may be spent on.
--
-- `docs/project-coordinator-scope-contract.md` §10 leaves this unit "§6 的 HANDOFF_* 三态落地":
-- `HANDOFF_REQUESTED`, `HANDOFF_APPROVED` and the `APPLY` that turns the second into `FILED`. L1
-- froze R9–R14 over an approval it could not produce, so today every cross-project write an agent
-- attempts dies at R7 and the only crossings that happen are the undeclared ones this whole unit
-- exists to stop.
--
-- WHY A TABLE, GIVEN §8 CM3 ("不新增业务实体")
-- ============================================
-- CM3 is obeyed everywhere it can be: `DISCOVERED`, `FILED`, `UNMAPPED` and `ABANDONED` stay
-- derived from `task` columns, and nothing here stores them. What cannot be derived is the middle
-- of §6's own transition table — it says in as many words that `APPROVE` and `APPLY` are two
-- events, "or there is no state in which the approved move can wait for its own transaction". A
-- yes that has been given and not yet spent must therefore survive BETWEEN transactions, and no
-- existing relation can hold it:
--
--   * `approval` is keyed on the session and cascades with it, while §6 makes `SCOPE_LOST` a fixed
--     point of `HANDOFF_REQUESTED` — a question outlives the rotation of whoever asked it;
--   * `project_blocker.detail` is display-only by §11.1 BL7 ("never an input to any decision"), and
--     an authorization input read out of a display field is the exact mistake this unit exists to
--     stop;
--   * `project_action` has one `project_id`, and a crossing is a fact about two.
--
-- So this table stores exactly one thing — the ANSWER, plus the single task it was spent on. It
-- owns no work, appears in no plan, is filed under no goal, and adds no vocabulary to the product:
-- Project and Task remain the only entities that carry goals and work. It is the same category of
-- row as `project_blocker` and `session_merge_receipt`.
--
-- WHAT THE COLUMNS ARE FOR
-- ========================
-- `crossing_key` is the identity of one crossing: owner, both ends, kind, subject and payload
-- digest. Everything that could make this a DIFFERENT question for the user is in it, and nothing
-- else — not the session that asked, not the turn, not the clock. The unique index over
-- (owner_id, crossing_key) is what makes duplicate, concurrent, out-of-order and timed-out retries
-- collapse onto ONE row and one answer, at the database, rather than by a de-duplication somebody
-- has to remember to run (AC3).
--
-- `applied_task_id` is the other half of exactly-once. The partial unique index over it (for
-- FILE_TASK, the kind that CREATES a task) states the invariant directly: one approval never
-- produced two tasks, and one task was never produced by two approvals. MOVE_TASK and
-- DEPEND_ON_TASK are excluded from that index deliberately — a task may legitimately be moved
-- twice, or wait on two projects, and each of those is its own crossing with its own answer.
--
-- `expires_at` bounds a yes rather than a question. The risk is not that the user forgets; it is
-- that the world moves — an approval names two goals, and a week later either can have been
-- re-scoped, accepted or reopened. R13 (`APPROVAL_EXPIRED`) is already in L1's frozen table for
-- this, and its required action is to ask again. A PENDING request has no expiry: §6 keeps a
-- question standing across a takeover, and a queue that silently drops what nobody answered is a
-- queue people learn not to read.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- ===============================
--   * No backfill, and no behaviour change for anything already in the database. Before this unit
--     there was no way to declare a crossing, so there is nothing to interpret: the table starts
--     empty and every existing write keeps meeting exactly the rules it met yesterday (AC11).
--   * No new blocker kind and no new refusal code. §5 EC6's four are L3's and are already
--     classified; a crossing that is refused here is refused with one of them.
--   * It does not reopen anything. R8 keeps refusing a settled project, approved or not; the door
--     out of that state is L5's.
--
-- NUMBERING
-- =========
-- 0155, not 0152–0154: `main` carries 0154 (H2G), the sibling K6 unit has reserved 0152 and 0153
-- was left unused when L3 turned out to need no schema. Taking the next free number above every
-- claim is what keeps two units from arriving with one prefix — this repo has paid for that once.
--
-- RE-RUNNABILITY AND ROLLBACK
-- ===========================
-- Every statement is re-runnable: the table and indexes are `IF NOT EXISTS`, constraints are added
-- inside a `duplicate_object` guard, the function is `CREATE OR REPLACE` and the trigger is dropped
-- by name first. An interrupted apply that is retried reaches the same state as one that was not.
-- `down.sql` beside this file reverses it in the opposite order and is re-runnable the same way; it
-- is not read by Prisma and exists so a rollback is a reviewed script rather than an improvised one.

CREATE TABLE IF NOT EXISTS "project_handoff_approval" (
  "id"                      UUID PRIMARY KEY,
  "owner_id"                UUID NOT NULL,
  "from_project_id"         UUID NOT NULL,
  "to_project_id"           UUID NOT NULL,
  "kind"                    TEXT NOT NULL,
  -- MOVE_TASK: the task being moved. DEPEND_ON_TASK: the prerequisite being waited on.
  -- FILE_TASK: null, because the task it authorises does not exist yet.
  "subject_task_id"         UUID,
  "payload_digest"          CHAR(64) NOT NULL,
  "crossing_key"            CHAR(64) NOT NULL,
  "state"                   TEXT NOT NULL,
  -- Display, never a gate: what the user is looking at when they answer.
  "title"                   TEXT NOT NULL,
  "reason"                  TEXT,
  -- Historical attribution, deliberately without foreign keys (cf. project_decision): rotating or
  -- deleting the session that asked must not rewrite who asked, and must not delete the answer.
  "requested_by_session_id" UUID NOT NULL,
  "requested_at"            TIMESTAMP(3) NOT NULL,
  "decided_by"              TEXT,
  "decided_by_user_id"      UUID,
  "decided_at"              TIMESTAMP(3),
  "expires_at"              TIMESTAMP(3),
  "applied_task_id"         UUID,
  "applied_at"              TIMESTAMP(3),
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
  ALTER TABLE "project_handoff_approval"
    ADD CONSTRAINT "project_handoff_approval_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "project_handoff_approval"
    ADD CONSTRAINT "project_handoff_approval_from_project_id_fkey"
    FOREIGN KEY ("from_project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "project_handoff_approval"
    ADD CONSTRAINT "project_handoff_approval_to_project_id_fkey"
    FOREIGN KEY ("to_project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "project_handoff_approval" ADD CONSTRAINT "project_handoff_approval_kind_chk"
    CHECK ("kind" IN ('FILE_TASK', 'MOVE_TASK', 'DEPEND_ON_TASK'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "project_handoff_approval" ADD CONSTRAINT "project_handoff_approval_state_chk"
    CHECK ("state" IN ('PENDING', 'APPROVED', 'DENIED', 'APPLIED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A crossing has two ends. One project handing work to itself is not a handoff, and a row saying it
-- is would be an approval that authorises an ordinary in-scope write.
DO $$ BEGIN
  ALTER TABLE "project_handoff_approval" ADD CONSTRAINT "project_handoff_approval_ends_chk"
    CHECK ("from_project_id" <> "to_project_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- FILE_TASK authorises a task that does not exist yet, so it names no subject; the other two are
-- ABOUT an existing task and are meaningless without one.
DO $$ BEGIN
  ALTER TABLE "project_handoff_approval" ADD CONSTRAINT "project_handoff_approval_subject_chk"
    CHECK (("kind" = 'FILE_TASK' AND "subject_task_id" IS NULL)
           OR ("kind" <> 'FILE_TASK' AND "subject_task_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An answer that names nobody and no moment is not an answer. PENDING is the only state that has
-- not been decided, and the only one where these are null.
DO $$ BEGIN
  ALTER TABLE "project_handoff_approval" ADD CONSTRAINT "project_handoff_approval_decided_chk"
    CHECK (("state" = 'PENDING' AND "decided_by" IS NULL AND "decided_at" IS NULL
            AND "decided_by_user_id" IS NULL)
           OR ("state" <> 'PENDING' AND "decided_by" IN ('USER', 'POLICY') AND "decided_at" IS NOT NULL
               AND (("decided_by" = 'USER' AND "decided_by_user_id" IS NOT NULL)
                    OR ("decided_by" = 'POLICY' AND "decided_by_user_id" IS NULL))));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Spent and unspent are the same fact told two ways, so they are constrained as one: APPLIED means
-- there is a task and a moment, and a task or a moment means APPLIED.
DO $$ BEGIN
  ALTER TABLE "project_handoff_approval" ADD CONSTRAINT "project_handoff_approval_applied_chk"
    CHECK (("state" = 'APPLIED' AND "applied_task_id" IS NOT NULL AND "applied_at" IS NOT NULL)
           OR ("state" <> 'APPLIED' AND "applied_task_id" IS NULL AND "applied_at" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A yes has an expiry and must have one: an APPROVED row with no `expires_at` would be a yes that
-- never stops being spendable, which is the one shape R13 exists to prevent. APPLIED keeps the
-- value it was approved under rather than clearing it — the record of what was authorised includes
-- how long the authority was good for, and a spend that erased it would leave an audit that cannot
-- answer whether the yes was live when it was spent.
DO $$ BEGIN
  ALTER TABLE "project_handoff_approval" ADD CONSTRAINT "project_handoff_approval_expiry_chk"
    CHECK (("state" IN ('APPROVED', 'APPLIED') AND "expires_at" IS NOT NULL)
           OR ("state" IN ('PENDING', 'DENIED') AND "expires_at" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One question per crossing, ever. This is AC3 at the database: a duplicate declaration, two
-- concurrent ones, one that arrives out of order and one retried after a timeout all reach the same
-- row and therefore the same answer.
CREATE UNIQUE INDEX IF NOT EXISTS "project_handoff_approval_crossing_idx"
  ON "project_handoff_approval"("owner_id", "crossing_key");

-- One approval never produced two tasks, and one task was never produced by two approvals. Only for
-- the kind that CREATES a task: a task may legitimately be moved twice or made to wait on two
-- projects, and each of those is its own crossing with its own answer.
CREATE UNIQUE INDEX IF NOT EXISTS "project_handoff_approval_applied_task_idx"
  ON "project_handoff_approval"("applied_task_id")
  WHERE "applied_task_id" IS NOT NULL AND "kind" = 'FILE_TASK';

-- The two reads this table has: what is waiting for a person in this project, and what has been
-- decided about work leaving it.
CREATE INDEX IF NOT EXISTS "project_handoff_approval_to_state_idx"
  ON "project_handoff_approval"("to_project_id", "state", "requested_at");
CREATE INDEX IF NOT EXISTS "project_handoff_approval_from_state_idx"
  ON "project_handoff_approval"("from_project_id", "state", "requested_at");

-- APPEND-ONLY AUTHORITY: the guard, and why it is written per transition rather than per column.
--
-- An approval is not a record that describes an authorization; it IS the authorization. So the only
-- questions it may ever answer differently are the ones a legal transition asks, and every other
-- byte is frozen — including the ones a CHECK constraint is happy with. Without the per-transition
-- arms below, all of these pass every constraint on this table:
--
--   * `UPDATE … SET decided_by = 'POLICY', decided_by_user_id = NULL` on an APPROVED row — a yes a
--     person gave becomes a yes the policy gave, and the audit no longer names anybody;
--   * `UPDATE … SET expires_at = now() + interval '10 years'` — an expiry that never arrives, which
--     is R13 deleted from the running system without a migration;
--   * `UPDATE … SET title = …, reason = …` — the question the user answered is rewritten under the
--     answer, so the record shows them approving something they never read;
--   * `UPDATE … SET state = 'APPLIED', decided_by_user_id = <someone else>` — the spend rewrites
--     who approved it.
--
-- None of those is reachable from the service. All of them are reachable from psql, a repair
-- script, a mixed-version binary and a future call site, which is the entire reason this lives in
-- the database. The service enforces the same rules; that is not duplication for its own sake.
--
-- The shape: identity and attribution are frozen in EVERY arm; a same-state write must be an exact
-- no-op; each legal transition names precisely which fields may move and what they must become.
CREATE OR REPLACE FUNCTION "project_handoff_approval_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."state" = 'APPLIED' THEN
    RAISE EXCEPTION 'PROJECT_HANDOFF_SPENT: handoff approval % was already spent on task %; a yes '
                    'authorises one crossing and cannot be re-answered, re-spent or edited',
      OLD."id", OLD."applied_task_id"
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The crossing this answer is about, and who asked it. Frozen in every arm: re-aiming an answer
  -- at another crossing, or at another asker, is the one move that would make an approval mean
  -- something nobody was shown.
  -- The row's own name, first and on its own line, because nothing else on this table would notice.
  -- A raw `UPDATE … SET id = <new uuid>` changes no state, no decision and no payload, so every
  -- CHECK is satisfied and every branch below reads it as a no-op — and every reference anybody
  -- holds to this answer (the refusal that named it, the client polling it, the audit trail) points
  -- at a row that no longer exists, while the yes lives on under a name nobody was given. An
  -- append-only fact whose primary key can move is not append-only.
  IF NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION 'PROJECT_HANDOFF_IMMUTABLE: handoff approval % cannot be renamed; the answer '
                    'and the name it was given out under are one fact', OLD."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
     OR NEW."from_project_id" IS DISTINCT FROM OLD."from_project_id"
     OR NEW."to_project_id" IS DISTINCT FROM OLD."to_project_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."subject_task_id" IS DISTINCT FROM OLD."subject_task_id"
     OR NEW."payload_digest" IS DISTINCT FROM OLD."payload_digest"
     OR NEW."crossing_key" IS DISTINCT FROM OLD."crossing_key"
     OR NEW."requested_by_session_id" IS DISTINCT FROM OLD."requested_by_session_id"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'PROJECT_HANDOFF_IMMUTABLE: handoff approval % names one crossing asked by one '
                    'session; re-aiming it would make one answer authorise a move nobody was asked '
                    'about', OLD."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The question the user reads. It may never change after it is asked: an answer is about the
  -- words that were in front of the person who gave it.
  IF NEW."title" IS DISTINCT FROM OLD."title" OR NEW."reason" IS DISTINCT FROM OLD."reason" THEN
    RAISE EXCEPTION 'PROJECT_HANDOFF_IMMUTABLE: handoff approval % cannot be reworded; the answer '
                    'is about the question that was asked', OLD."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW."state" IS NOT DISTINCT FROM OLD."state" THEN
    -- A same-state write is a no-op or it is tampering. `updated_at` is bookkeeping and is set
    -- below; everything else must be byte-identical, so "answer it again with a different decider"
    -- and "extend the deadline in place" have no spelling at all.
    IF NEW."decided_by" IS DISTINCT FROM OLD."decided_by"
       OR NEW."decided_by_user_id" IS DISTINCT FROM OLD."decided_by_user_id"
       OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
       OR NEW."applied_task_id" IS DISTINCT FROM OLD."applied_task_id"
       OR NEW."applied_at" IS DISTINCT FROM OLD."applied_at" THEN
      RAISE EXCEPTION 'PROJECT_HANDOFF_IMMUTABLE: handoff approval % is % and an answer is not '
                      'edited in place; the only writes it accepts are the transitions in §6',
        OLD."id", OLD."state"
        USING ERRCODE = 'raise_exception';
    END IF;

  ELSIF OLD."state" = 'PENDING' AND NEW."state" IN ('APPROVED', 'DENIED') THEN
    -- The answer arrives. It names a decider and a moment; a yes also names how long it is good
    -- for, and a no has nothing to expire.
    IF NEW."decided_at" IS NULL
       OR (NEW."decided_by" = 'USER' AND NEW."decided_by_user_id" IS NULL)
       OR (NEW."decided_by" = 'POLICY' AND NEW."decided_by_user_id" IS NOT NULL)
       OR NEW."decided_by" NOT IN ('USER', 'POLICY')
       OR (NEW."state" = 'APPROVED' AND NEW."expires_at" IS NULL)
       OR (NEW."state" = 'DENIED' AND NEW."expires_at" IS NOT NULL)
       OR NEW."applied_task_id" IS NOT NULL OR NEW."applied_at" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_HANDOFF_DECISION: handoff approval % must be answered by a named '
                      'decider at a named moment, and answering it applies nothing', OLD."id"
        USING ERRCODE = 'raise_exception';
    END IF;

  ELSIF OLD."state" = 'APPROVED' AND NEW."state" = 'DENIED' THEN
    -- Revocation. A genuinely new decision, so the decider and the moment move — but only a PERSON
    -- may take a yes back. A policy that could revoke its own grant would be a policy able to
    -- rewrite history whenever it was reconfigured.
    IF NEW."decided_by" <> 'USER' OR NEW."decided_by_user_id" IS NULL OR NEW."decided_at" IS NULL
       OR NEW."expires_at" IS NOT NULL
       OR NEW."applied_task_id" IS NOT NULL OR NEW."applied_at" IS NOT NULL THEN
      RAISE EXCEPTION 'PROJECT_HANDOFF_DECISION: only a person revokes an approval, and revoking '
                      'it applies nothing (handoff approval %)', OLD."id"
        USING ERRCODE = 'raise_exception';
    END IF;

  ELSIF OLD."state" = 'APPROVED' AND NEW."state" = 'APPLIED' THEN
    -- The spend APPENDS. Who approved it, when, and how long the authority was good for are the
    -- facts that make the applied task legitimate, so they travel into the record unchanged.
    IF NEW."decided_by" IS DISTINCT FROM OLD."decided_by"
       OR NEW."decided_by_user_id" IS DISTINCT FROM OLD."decided_by_user_id"
       OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
      RAISE EXCEPTION 'PROJECT_HANDOFF_IMMUTABLE: spending handoff approval % must keep who '
                      'approved it, when, and what it was good for', OLD."id"
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NEW."applied_task_id" IS NULL OR NEW."applied_at" IS NULL THEN
      RAISE EXCEPTION 'PROJECT_HANDOFF_APPLY: handoff approval % can only be spent on a named task '
                      'at a named moment', OLD."id"
        USING ERRCODE = 'raise_exception';
    END IF;

  ELSE
    -- §6 has no other edge. DENIED in particular has none: reviving a refused request would turn
    -- the row the coordinator was told no to into a yes, keeping the requester, the moment and the
    -- audit of a question that was answered "no". §6 gives ABANDONED exactly one exit and it is the
    -- user filing the work themselves (R1) — a new act with a new identity, not this row.
    RAISE EXCEPTION 'PROJECT_HANDOFF_TRANSITION: handoff approval % cannot go % -> %',
      OLD."id", OLD."state", NEW."state"
      USING ERRCODE = 'raise_exception';
  END IF;

  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "project_handoff_approval_guard" ON "project_handoff_approval";
CREATE TRIGGER "project_handoff_approval_guard"
  BEFORE UPDATE ON "project_handoff_approval"
  FOR EACH ROW EXECUTE FUNCTION "project_handoff_approval_guard"();
