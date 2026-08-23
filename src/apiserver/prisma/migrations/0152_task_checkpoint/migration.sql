-- `[K6]` §7: the checkpoint table, and the guards that make §7 a property of the database rather
-- than of whichever build happens to be holding the lease.
--
-- `[K1]` froze §7's two kinds and its five refusal codes. `[K3]` gave `task_attempt` the POINTER
-- half — a sha, a kind, an evidence digest — and said in its own comment that the table and the
-- merge gate were a later unit. Nothing has been able to record WHAT a checkpoint is: the tree it
-- names, the base it is a delta from, the evidence that makes it known-good, or where known-RED
-- work lives when the machine that produced it is gone. §0's incident lost work exactly there — a
-- `git stash` on one runner, neither lost nor reachable, so the next generation resumed from a
-- baseline missing it and re-derived the same failure.
--
-- Five additions and no rewrites:
--
--   1. `task_checkpoint`: append-only, content-keyed, immutable by trigger (CP1).
--   2. `session_merge_receipt.checkpoint_id` plus a trigger refusing a LANDED receipt that names a
--      `WIP_RED` checkpoint — §7's "可否进入依赖分支/main = 否", enforced where it can be enforced.
--   3. `session.merge_checkpoint_id`: which checkpoint a QUEUED merge was authorised for, so the
--      server judges the result it gets back against a fact it persisted rather than one the
--      runner chose to send.
--   4. Two triggers that hold §7 against a process that does not know it exists — the mixed-version
--      case, where the previous build is writing to the same database. See section 4.
--   5. Nothing else. `task.known_good_sha` keeps its meaning and its writer (`[K3]`'s attempt
--      close); this table is what that pointer now points INTO.
--
-- DEPLOYMENT ORDER — this migration goes FIRST, and the rolling window is safe in the direction
-- that matters. The table is one an old replica never reads or writes, and the new columns are
-- nullable, so every merge an old replica handles for an UNMANAGED task behaves exactly as it
-- always did — which is every merge that exists today.
--
-- What an old replica loses is the ability to record a landing for a task that IS
-- checkpoint-managed without naming the verified commit. That is deliberate, and it is the whole
-- point of putting the rule here: an old replica has no legal use for that write, and a window in
-- which one of the two processes can still perform it is a window in which §7 is advisory. The
-- refusal surfaces as a failed transaction on the old replica — the merge stays pending and is
-- retried by whichever process picks it up next, which on a rolling deploy is the new one.

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

-- ---------------------------------------------------------------------------------------------
-- 3. The merge operation remembers which checkpoint it was authorised for.
-- ---------------------------------------------------------------------------------------------
-- Written when the merge is QUEUED, read when its result comes back — so the server decides whether
-- a reported landing is the verified one from a fact it persisted itself, not from a field the
-- runner chose to send.
--
-- That distinction is the whole column. `requiredSourceSha` travels on the command as a courtesy to
-- the runner, which is the only party that can compare it against a working tree; but a runner that
-- IGNORES it — an older build, or a broken one — would otherwise report a merge of any commit at
-- all and the control plane would write `branch_merged` and a receipt for it, because nothing on
-- the server side had an expectation to check against. A gate that only holds when the client
-- cooperates is not a gate.
--
-- Nullable and SET NULL: most merges are not under convergence management and are unaffected, and
-- deleting a checkpoint must not delete the merge request that pointed at it.
ALTER TABLE "session"
  ADD COLUMN "merge_checkpoint_id" UUID REFERENCES "task_checkpoint"("id") ON DELETE SET NULL;

-- ---------------------------------------------------------------------------------------------
-- 4. The authority no control plane can route around.
-- ---------------------------------------------------------------------------------------------
-- §7's second row, in the one place that holds it against a process that does not know the rule:
-- once a task is CHECKPOINT-MANAGED, nothing may record that its work landed except the verified
-- commit itself.
--
-- WHY THIS IS A TRIGGER AND NOT A SERVICE CHECK
--
-- The service checks exist and are the ones that produce a readable refusal. They are also the ones
-- an OLD replica does not have. A mixed-version deployment runs both builds against one database,
-- and the previous build's merge-result path writes the landed projection and then a receipt whose
-- `checkpoint_id` is NULL — not maliciously, but because the column did not exist when it was
-- compiled. Project AC9 says a mixed-version deployment must not act beyond its authority, and a
-- rule that holds only while every process is new is not a rule; it is a release note. So the
-- database decides, and an old replica's whole transaction — projection AND receipt — rolls back
-- together, which is the only outcome that leaves no half-recorded landing behind.
--
-- WHAT "MANAGED" MEANS, AND WHY LEGACY IS SAFE
--
-- A task is checkpoint-managed exactly when it has at least one `task_checkpoint` row. Every task
-- that existed before this migration has none and is completely unaffected — no merge Orbit has
-- ever recorded changes behaviour. Management begins the moment somebody records a checkpoint,
-- which is also the moment §7 starts making claims about that task, and from then on the two halves
-- agree: the service refuses first with a reason, and the database refuses regardless of who asked.
--
-- A task holding only `WIP_RED` checkpoints is managed and has nothing accepted, so every landed
-- claim about it fails — which is the correct reading of "known-red work is saved, not merged".

CREATE OR REPLACE FUNCTION "task_is_checkpoint_managed"(p_task_id UUID) RETURNS BOOLEAN AS $$
  SELECT p_task_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM "task_checkpoint" WHERE "task_id" = p_task_id);
$$ LANGUAGE sql STABLE;

/* Is this commit one this task actually verified? Membership, not "the latest": a receipt for an
   earlier accepted checkpoint, re-reported after a newer one was recorded, is still a true
   statement about a landing that happened. */
CREATE OR REPLACE FUNCTION "task_has_accepted_checkpoint_at"(p_task_id UUID, p_sha TEXT)
RETURNS BOOLEAN AS $$
  SELECT p_task_id IS NOT NULL AND p_sha IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM "task_checkpoint"
        WHERE "task_id" = p_task_id AND "kind" = 'ACCEPTED' AND "commit_sha" = lower(btrim(p_sha))
     );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "session_merge_receipt_checkpoint_accepted"() RETURNS TRIGGER AS $$
DECLARE
  cp_kind TEXT;
  cp_sha  TEXT;
BEGIN
  IF NEW."result" NOT IN ('MERGED', 'ALREADY_MERGED') THEN
    RETURN NEW;
  END IF;

  IF NEW."checkpoint_id" IS NULL THEN
    -- The old-replica shape. Allowed for a task nobody has checkpointed — that is every merge in
    -- the system's history — and refused the moment §7 governs the task, because a landing with no
    -- verified point behind it is the exact claim this unit exists to stop.
    IF "task_is_checkpoint_managed"(NEW."task_id") THEN
      RAISE EXCEPTION
        'CHECKPOINT_AUTHORITY_REQUIRED: task % is checkpoint-managed, so a landed receipt must name the checkpoint it landed',
        NEW."task_id"
        USING ERRCODE = '23514',
              DETAIL = 'a landed claim with no verified point behind it (§7 CP3)';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "kind", "commit_sha" INTO cp_kind, cp_sha
    FROM "task_checkpoint" WHERE "id" = NEW."checkpoint_id";
  IF cp_kind IS NULL THEN
    RETURN NEW; -- the checkpoint was deleted; the FK's SET NULL will have taken the id with it
  END IF;
  IF cp_kind <> 'ACCEPTED' THEN
    RAISE EXCEPTION
      'CHECKPOINT_NOT_ACCEPTED: checkpoint % is %, which may not be recorded as landed',
      NEW."checkpoint_id", cp_kind
      USING ERRCODE = '23514', DETAIL = 'known-red work is saved, not merged (§7)';
  END IF;
  IF lower(btrim(NEW."source_sha")) <> cp_sha THEN
    RAISE EXCEPTION
      'BRANCH_TIP_MISMATCH: receipt lands % but checkpoint % verified %',
      lower(btrim(NEW."source_sha")), NEW."checkpoint_id", cp_sha
      USING ERRCODE = '23514',
            DETAIL = 'the commits after a verified one carry no test evidence (§7 CP3)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_merge_receipt_checkpoint_accepted_trg"
  BEFORE INSERT OR UPDATE ON "session_merge_receipt"
  FOR EACH ROW EXECUTE FUNCTION "session_merge_receipt_checkpoint_accepted"();

-- ---------------------------------------------------------------------------------------------
-- 5. The same rule on the PROJECTION, because a receipt is not the only way to claim a landing.
-- ---------------------------------------------------------------------------------------------
-- The previous build writes `merge_status`, `branch_merged` and `merged_source_sha` BEFORE it
-- writes any receipt, and it skips the receipt entirely when the runner named no source commit —
-- so the receipt trigger above never sees that case, and the session is left saying the branch
-- landed. Every reader of "did this task's work land" reads these columns.
--
-- Narrow on purpose. It fires when a writer moves a managed session INTO `merge_status='merged'`,
-- or names a merged source commit — the two shapes that assert a specific landing. It does NOT
-- fire on `branch_merged` alone, which is the turn-end heartbeat's conservative ancestry
-- observation: that one carries no commit, is recomputed every turn, and gating it would fail a
-- heartbeat over a claim it never made.
CREATE OR REPLACE FUNCTION "session_merge_projection_checkpoint_authority"() RETURNS TRIGGER AS $$
DECLARE
  claimed BOOLEAN;
BEGIN
  IF NOT "task_is_checkpoint_managed"(NEW."task_id") THEN
    RETURN NEW;
  END IF;

  claimed :=
    (NEW."merge_status" = 'merged' AND OLD."merge_status" IS DISTINCT FROM 'merged')
    OR (NEW."merged_source_sha" IS NOT NULL
        AND NEW."merged_source_sha" IS DISTINCT FROM OLD."merged_source_sha");
  IF NOT claimed THEN
    RETURN NEW;
  END IF;

  IF NOT "task_has_accepted_checkpoint_at"(NEW."task_id", NEW."merged_source_sha") THEN
    RAISE EXCEPTION
      'CHECKPOINT_AUTHORITY_REQUIRED: session % may not record a landing at % — task % has no accepted checkpoint there',
      NEW."id", coalesce(lower(btrim(NEW."merged_source_sha")), '<none>'), NEW."task_id"
      USING ERRCODE = '23514',
            DETAIL = 'an unverified or unnamed commit cannot be projected as landed (§7 CP3)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_merge_projection_checkpoint_authority_trg"
  BEFORE UPDATE OF "merge_status", "merged_source_sha", "branch_merged" ON "session"
  FOR EACH ROW EXECUTE FUNCTION "session_merge_projection_checkpoint_authority"();
