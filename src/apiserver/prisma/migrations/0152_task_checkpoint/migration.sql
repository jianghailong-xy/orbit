-- `[K6]` §7: the checkpoint table, and the two guards that make §7's first row a property of the
-- database rather than of whoever is holding the lease.
--
-- `[K1]` froze §7's two kinds and its five refusal codes. `[K3]` gave `task_attempt` the POINTER
-- half — a sha, a kind, an evidence digest — and said in its own comment that the table and the
-- merge gate were a later unit. Nothing has been able to record WHAT a checkpoint is: the tree it
-- names, the base it is a delta from, the evidence that makes it known-good, or where known-RED
-- work lives when the machine that produced it is gone. §0's incident lost work exactly there — a
-- `git stash` on one runner, neither lost nor reachable, so the next generation resumed from a
-- baseline missing it and re-derived the same failure.
--
-- Three additions and no rewrites:
--
--   1. `task_checkpoint`: append-only, content-keyed, immutable by trigger (CP1).
--   2. `session_merge_receipt.checkpoint_id` plus a trigger refusing a LANDED receipt that names a
--      `WIP_RED` checkpoint — §7's "可否进入依赖分支/main = 否", enforced where it can be enforced.
--   3. Nothing else. `task.known_good_sha` keeps its meaning and its writer (`[K3]`'s attempt
--      close); this table is what that pointer now points INTO.
--
-- DEPLOYMENT ORDER — this migration goes FIRST, and both halves are safe in a rolling window. The
-- table is one an old replica never reads or writes. The receipt column is nullable, so an old
-- replica keeps inserting receipts with no checkpoint and the trigger has nothing to judge; what it
-- cannot do is record a landed receipt AGAINST a red checkpoint, which requires writing a column it
-- does not know exists.

-- ---------------------------------------------------------------------------------------------
-- 1. The checkpoint.
-- ---------------------------------------------------------------------------------------------
-- Subordinate to Task, like `[K2]`'s ledger, `[K3]`'s attempt and `[K5]`'s finding, and for RL4's
-- reason: the business layer stays Project and Task, and a checkpoint is an internal fact about
-- one of them.
--
-- `(task_id, scope_revision, scope_hash)` is the same composite foreign key the decision ledger,
-- the attempt and the finding all carry. It is here for §6 FD4's reason rather than for tidiness:
-- a checkpoint names the revision it was verified against, HASH included, so it can never be
-- re-pointed at a scope that did not have that content. "This was verified" is a claim about a
-- specific question, and §0's incident is what happens when the question is allowed to change
-- underneath an answer that keeps being cited.
CREATE TABLE "task_checkpoint" (
  "id"              UUID PRIMARY KEY,
  "task_id"         UUID NOT NULL,
  "owner_id"        UUID NOT NULL,
  -- Denormalised from the task on purpose: the dedup key is project-scoped, and a checkpoint has
  -- to keep answering for the project it was recorded in after the task is re-filed elsewhere.
  "project_id"      UUID,
  -- Monotonic within a task, allocated MAX + 1 under the task row lock — a replay ORDER that does
  -- not depend on `created_at`, which two writers can tie on. "The LATEST accepted checkpoint" is
  -- the whole baseline rule, so it may not rest on a clock.
  "seq"             BIGINT NOT NULL,

  "scope_revision"  INTEGER NOT NULL,
  "scope_hash"      CHAR(64) NOT NULL,

  -- §7's first column. Derived from the evidence by `planCheckpoint`, never supplied: a caller that
  -- could name its own kind could call a red tree `ACCEPTED`, and every property below it rests on
  -- that word.
  "kind"            TEXT NOT NULL,

  -- WHAT it is, spelled so a second machine can rebuild it. `tree_sha` is not redundant with
  -- `commit_sha`: two runners replaying the same work produce two commits and one tree, and it is
  -- the TREE that answers "is this the same state". `base_sha` is what the commit is a delta FROM,
  -- which is what makes the artifact applicable anywhere at all.
  "branch"          TEXT NOT NULL,
  "commit_sha"      CHAR(40) NOT NULL,
  "tree_sha"        CHAR(40) NOT NULL,
  "base_sha"        CHAR(40) NOT NULL,

  -- §7's "有测试证据", as a row rather than an adjective. Both NULL for a red point.
  "evidence_digest" CHAR(64),
  "test_evidence"   JSONB,

  -- CP2: how this is recovered on a machine that has never seen it. NOT a place on one host — the
  -- CHECK below refuses every kind that does not travel, which is the whole of "不得只依赖某台机器
  -- 上的 stash" said mechanically.
  "artifact_kind"   TEXT,
  "artifact_ref"    TEXT,
  "artifact_digest" CHAR(64),

  -- CP1's identity: every field above, hashed. "改一个字段等于新建一个 checkpoint" is a rule about
  -- identity, so identity is spelled over the whole content — recording the same thing twice
  -- collides and writes nothing, and recording anything different is a different checkpoint.
  "content_digest"  CHAR(64) NOT NULL,
  "dedup_key"       TEXT NOT NULL,

  -- WHO recorded it, and from where. Provenance, never an input to a decision. No foreign keys on
  -- the two ids, on migration 0120's rule: deleting a session must not rewrite who recorded an
  -- earlier checkpoint.
  "recorded_by"     TEXT NOT NULL,
  "session_id"      UUID,
  -- `[K3]`'s attempt this came out of, when it came out of one. SET NULL rather than CASCADE: the
  -- attempt row is a fact about a RUN, and purging the run must not destroy the known-good point
  -- the next generation is standing on.
  "attempt_id"      UUID REFERENCES "task_attempt"("id") ON DELETE SET NULL,

  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_checkpoint_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id") ON DELETE CASCADE,
  CONSTRAINT "task_checkpoint_scope_revision_fkey"
    FOREIGN KEY ("task_id", "scope_revision", "scope_hash")
    REFERENCES "task_scope_revision"("task_id", "revision", "scope_hash") ON DELETE CASCADE,

  CONSTRAINT "task_checkpoint_kind_chk" CHECK ("kind" IN ('ACCEPTED', 'WIP_RED')),
  CONSTRAINT "task_checkpoint_recorded_by_chk"
    CHECK ("recorded_by" IN ('USER', 'COORDINATOR', 'WORKER', 'VERIFIER')),

  -- Full, lowercase, 40-hex. An abbreviated object name is ambiguous by construction: it resolves
  -- against a repository that has since gained objects, so the value that verified today can name a
  -- different commit later, silently. This row's whole purpose is to still be checkable then.
  CONSTRAINT "task_checkpoint_sha_chk" CHECK (
    "commit_sha" ~ '^[0-9a-f]{40}$' AND
    "tree_sha"   ~ '^[0-9a-f]{40}$' AND
    "base_sha"   ~ '^[0-9a-f]{40}$'
  ),

  -- §7's first row: an `ACCEPTED` point is one with test evidence. There is no other kind of it.
  CONSTRAINT "task_checkpoint_accepted_evidence_chk" CHECK (
    "kind" <> 'ACCEPTED' OR ("evidence_digest" IS NOT NULL AND "test_evidence" IS NOT NULL)
  ),

  -- CP2. Red work with nowhere to be recovered from is work that is about to be lost, and this is
  -- the constraint that says so before it is.
  CONSTRAINT "task_checkpoint_red_artifact_chk" CHECK (
    "kind" <> 'WIP_RED' OR (
      "artifact_kind" IS NOT NULL AND "artifact_ref" IS NOT NULL AND "artifact_digest" IS NOT NULL
    )
  ),

  -- CP2, said precisely. `LOCAL_STASH` is a nameable kind in the code so that naming one produces a
  -- refusal that says what is wrong; here it is simply not storable. A stash is a place, not an
  -- artifact: it names no bytes anybody else can fetch.
  CONSTRAINT "task_checkpoint_artifact_portable_chk" CHECK (
    "artifact_kind" IS NULL OR "artifact_kind" = 'GIT_BUNDLE'
  ),
  CONSTRAINT "task_checkpoint_artifact_digest_chk" CHECK (
    "artifact_digest" IS NULL OR "artifact_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "task_checkpoint_content_digest_chk" CHECK ("content_digest" ~ '^[0-9a-f]{64}$')
);

-- CP1's identity, as an index. Two writers racing on the same content — a redelivered event, a
-- takeover, a retry after a lost response — leave ONE row, and the loser reads the winner's back.
CREATE UNIQUE INDEX "task_checkpoint_dedup_key" ON "task_checkpoint" ("dedup_key");
CREATE UNIQUE INDEX "task_checkpoint_seq_key" ON "task_checkpoint" ("task_id", "seq");
-- "The latest ACCEPTED checkpoint of this task" — the baseline rule, in one indexed read.
CREATE INDEX "task_checkpoint_task_kind_seq_idx"
  ON "task_checkpoint" ("task_id", "kind", "seq" DESC);
CREATE INDEX "task_checkpoint_owner_created_idx"
  ON "task_checkpoint" ("owner_id", "created_at" DESC);
CREATE INDEX "task_checkpoint_commit_idx" ON "task_checkpoint" ("commit_sha");

-- CP1, mechanically: an accepted checkpoint is immutable, and so is a red one.
--
-- Append-only rather than "immutable once accepted", because the alternative is a row that can be
-- edited right up until the moment somebody relies on it. A checkpoint is cited by the merge gate,
-- by the next generation's baseline and by an audit reading months later; every one of those reads
-- a value that must still mean what it meant when it was written. Changing a field is a new
-- checkpoint, which is exactly what the content-keyed unique index above makes cheap.
CREATE OR REPLACE FUNCTION "task_checkpoint_immutable"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'CHECKPOINT_IMMUTABLE: checkpoint % may not be modified; record a new one',
    OLD."id"
    USING ERRCODE = '23514', DETAIL = 'task_checkpoint is append-only (§7 CP1)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_checkpoint_immutable_trg"
  BEFORE UPDATE ON "task_checkpoint"
  FOR EACH ROW EXECUTE FUNCTION "task_checkpoint_immutable"();

-- ---------------------------------------------------------------------------------------------
-- 2. The merge receipt names the checkpoint it landed.
-- ---------------------------------------------------------------------------------------------
-- Nullable, because most merges are not under convergence management and project AC11 says they
-- keep behaving exactly as they did. What the column buys where it IS set is CP4: the receipt's own
-- key (§13.7 MR4) is `(session, sourceSha, target, result)`, which makes a redelivery from the SAME
-- session a no-op — and mints a second receipt when the same landing is reported by a second
-- session, which is precisely the takeover, the cross-runner recovery and the retry-after-a-lost-
-- response. A checkpoint outlives the session that produced it, so keying on it makes those one
-- fact.
ALTER TABLE "session_merge_receipt"
  ADD COLUMN "checkpoint_id" UUID REFERENCES "task_checkpoint"("id") ON DELETE SET NULL;

CREATE INDEX "session_merge_receipt_checkpoint_idx"
  ON "session_merge_receipt" ("checkpoint_id", "created_at" DESC);

-- CP4, as an index rather than as an intention. The receipt's existing unique key is
-- `(session_id, idempotency_key)`, which makes a redelivery from the SAME session a no-op — and
-- mints a second row when one landing is reported by a second session, which is the takeover, the
-- recovery on another runner, and the retry of a request whose response was lost. A checkpoint
-- outlives the session that produced it, so where one is named the identity is the checkpoint's.
-- PARTIAL, so the many receipts with no checkpoint keep colliding only within their own session.
CREATE UNIQUE INDEX "session_merge_receipt_checkpoint_key"
  ON "session_merge_receipt" ("checkpoint_id", "idempotency_key")
  WHERE "checkpoint_id" IS NOT NULL;

-- §7's second row, in the one place a database can hold it: a LANDED receipt may not name a
-- `WIP_RED` checkpoint.
--
-- The table cannot stop a `git merge`; what it can stop is the control plane recording that
-- known-red work landed, which is what every downstream reader — the baseline, the project's
-- acceptance evidence, the dependent task's dispatch — actually consults. A red checkpoint that
-- reached main is an incident; a red checkpoint the control plane BELIEVES reached main is the same
-- incident with the audit agreeing with it.
CREATE OR REPLACE FUNCTION "session_merge_receipt_checkpoint_accepted"() RETURNS TRIGGER AS $$
DECLARE
  cp_kind TEXT;
BEGIN
  IF NEW."checkpoint_id" IS NULL OR NEW."result" NOT IN ('MERGED', 'ALREADY_MERGED') THEN
    RETURN NEW;
  END IF;
  SELECT "kind" INTO cp_kind FROM "task_checkpoint" WHERE "id" = NEW."checkpoint_id";
  IF cp_kind IS NOT NULL AND cp_kind <> 'ACCEPTED' THEN
    RAISE EXCEPTION
      'CHECKPOINT_NOT_ACCEPTED: checkpoint % is %, which may not be recorded as landed',
      NEW."checkpoint_id", cp_kind
      USING ERRCODE = '23514', DETAIL = 'known-red work is saved, not merged (§7)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_merge_receipt_checkpoint_accepted_trg"
  BEFORE INSERT OR UPDATE ON "session_merge_receipt"
  FOR EACH ROW EXECUTE FUNCTION "session_merge_receipt_checkpoint_accepted"();
