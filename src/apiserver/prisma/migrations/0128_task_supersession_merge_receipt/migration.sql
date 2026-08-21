-- Task supersession and the Orbit merge receipt (contract §13.6, §13.7).
--
-- Two facts this database could not hold, both discovered the same way: by looking at what the
-- control plane says about work that really happened and finding it says nothing.
--
-- 1. SUPERSESSION. A review that gets re-run from scratch leaves its earlier attempts CANCELLED,
--    with "superseded by the fresh review" written in a comment. `status` cannot tell that apart
--    from a task somebody simply dropped, so the only record of "this is being done again, over
--    there" was prose — invisible to every query, every list, and to acceptance. Three columns and
--    one guard make it a relation: the successor, when it took over, and why this one stopped.
--    Nothing here writes `status`: the original CANCELLED/FAILED is the fact being preserved.
--
-- 2. THE MERGE RECEIPT. `session.merge_status` is live UI state for the Merge button — written when
--    a merge is queued, deliberately CLEARED when the session resumes. It is also written by
--    exactly one path, Orbit's own merge. A branch merged the way these branches are actually
--    merged (an agent running `git merge --ff-only` in its own worktree) left `merge_status` NULL
--    and `branch_merged` false permanently, and "did this task's work land" had no answer at all.
--    `session_merge_receipt` is the durable half: append-only, one row per merge, naming the
--    session, the task, the project, and every SHA the claim can be re-checked against.
--
-- Both guards are triggers rather than service checks, for the reason §2.4 gives about D5/D6: a
-- service check exists only in the binary that has it, and a hand-typed UPDATE has to hit the same
-- wall as the API does.

-- ---------------------------------------------------------------------------------------------
-- 1. Task supersession columns.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "task"
  ADD COLUMN "superseded_by_task_id" UUID,
  ADD COLUMN "superseded_at"         TIMESTAMP(3),
  ADD COLUMN "terminal_reason"       TEXT;

-- SET NULL, like `parent_task_id` and for the same reason: deleting the successor must neither
-- refuse the delete nor destroy the row pointing at it. What survives is
-- `terminal_reason = 'SUPERSEDED'` with nothing to name — which the API reads back as
-- `supersededByTaskIdAbsentReason = 'SUCCESSOR_DELETED'`, not as "never superseded".
ALTER TABLE "task"
  ADD CONSTRAINT "task_superseded_by_task_id_fkey"
  FOREIGN KEY ("superseded_by_task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The closed set. Two values, not four: `FAILED` and `CANCELLED` are already `status`, and a column
-- that restates its neighbour is a column that can disagree with it.
ALTER TABLE "task"
  ADD CONSTRAINT "task_terminal_reason_check"
  CHECK ("terminal_reason" IS NULL OR "terminal_reason" IN ('SUPERSEDED', 'ABANDONED'));

-- One-way, deliberately. A successor implies SUPERSEDED and an instant; SUPERSEDED does not imply a
-- live successor, because ON DELETE SET NULL is allowed to take the pointer away.
ALTER TABLE "task"
  ADD CONSTRAINT "task_superseded_link_check"
  CHECK ("superseded_by_task_id" IS NULL
         OR ("terminal_reason" = 'SUPERSEDED' AND "superseded_at" IS NOT NULL));

ALTER TABLE "task"
  ADD CONSTRAINT "task_superseded_at_check"
  CHECK ("superseded_at" IS NULL OR "terminal_reason" IS NOT NULL);

CREATE INDEX "task_superseded_by_task_id_idx" ON "task" ("superseded_by_task_id");

-- ---------------------------------------------------------------------------------------------
-- 2. The supersession guard: same tenant, same project, already stopped, and acyclic.
-- ---------------------------------------------------------------------------------------------
--
-- Same trigger for all four because they are not four strengths of one claim — a supersession that
-- crosses a tenant, or names a task in another project, or closes a loop, or quietly reopens a
-- failure, is a different claim each time, and each of them is wrong.
CREATE OR REPLACE FUNCTION task_supersession_guard() RETURNS TRIGGER AS $$
DECLARE
  successor  RECORD;
  cursor_id  UUID;
  hops       INT := 0;
BEGIN
  IF NEW."superseded_by_task_id" IS NULL THEN
    RETURN NEW;
  END IF;

  -- SU4: the original outcome is the fact being preserved. A superseded task may not be walked
  -- back to OPEN or promoted to DONE while it still names a successor; clear the link first.
  IF NEW."status" NOT IN ('CANCELLED', 'FAILED') THEN
    RAISE EXCEPTION
      'TASK_SUPERSESSION_NOT_TERMINAL: task % is %, and only a CANCELLED or FAILED task may name a successor',
      NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT t."id", t."owner_id", t."project_id" INTO successor
    FROM "task" t WHERE t."id" = NEW."superseded_by_task_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TASK_SUPERSESSION_UNKNOWN_SUCCESSOR: task % does not exist',
      NEW."superseded_by_task_id" USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- SU2, tenant safety. The FK alone would happily point one user's task at another's.
  IF successor."owner_id" <> NEW."owner_id" THEN
    RAISE EXCEPTION 'TASK_SUPERSESSION_CROSS_TENANT: task % and its successor % have different owners',
      NEW."id", successor."id" USING ERRCODE = 'check_violation';
  END IF;

  -- SU3, same project — including "both in no project". A successor in another project is work
  -- towards a different goal, and no acceptance read could count it.
  IF successor."project_id" IS DISTINCT FROM NEW."project_id" THEN
    RAISE EXCEPTION 'TASK_SUPERSESSION_CROSS_PROJECT: task % is in project %, successor % is in project %',
      NEW."id", COALESCE(NEW."project_id"::text, 'none'),
      successor."id", COALESCE(successor."project_id"::text, 'none')
      USING ERRCODE = 'check_violation';
  END IF;

  -- SU5, acyclicity. Walk forward from the successor; reaching this row closes a loop in which
  -- every attempt is waiting on another attempt and none of them is the live one. The hop cap is a
  -- backstop for a cycle that already exists in data this trigger did not write.
  -- Starting AT the successor rather than after it is what makes a self-link a zero-hop cycle,
  -- and why there is no separate `superseded_by_task_id <> id` CHECK: a BEFORE trigger runs before
  -- table constraints, so that CHECK could never be the thing that refused, and two spellings of
  -- one rule is how the two come to disagree.
  cursor_id := successor."id";
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW."id" THEN
      RAISE EXCEPTION 'TASK_SUPERSESSION_CYCLE: making % the successor of % closes a supersession cycle',
        successor."id", NEW."id" USING ERRCODE = 'check_violation';
    END IF;
    hops := hops + 1;
    IF hops > 256 THEN
      RAISE EXCEPTION 'TASK_SUPERSESSION_CHAIN_TOO_LONG: supersession chain from % exceeds 256 hops',
        NEW."id" USING ERRCODE = 'check_violation';
    END IF;
    SELECT t."superseded_by_task_id" INTO cursor_id FROM "task" t WHERE t."id" = cursor_id;
    IF NOT FOUND THEN
      cursor_id := NULL;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_supersession_guard_insert
  BEFORE INSERT ON "task"
  FOR EACH ROW EXECUTE FUNCTION task_supersession_guard();

-- `status` is in the column list on purpose: reopening a superseded task is the other way the
-- invariant breaks, and it changes no supersession column at all.
CREATE TRIGGER task_supersession_guard_update
  BEFORE UPDATE OF "superseded_by_task_id", "status", "owner_id", "project_id" ON "task"
  FOR EACH ROW EXECUTE FUNCTION task_supersession_guard();

-- ---------------------------------------------------------------------------------------------
-- 3. The merge receipt.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "session_merge_receipt" (
  "id"                UUID PRIMARY KEY,
  "owner_id"          UUID NOT NULL,
  "session_id"        UUID NOT NULL,
  "task_id"           UUID,
  "project_id"        UUID,

  "result"            TEXT NOT NULL,

  "source_branch"     TEXT NOT NULL,
  "source_sha"        CHAR(40) NOT NULL,
  "target_branch"     TEXT NOT NULL,
  "target_sha_before" CHAR(40),
  "target_sha_after"  CHAR(40),
  "rebase_base_sha"   CHAR(40),

  "conflicts"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "recorded_by"       TEXT NOT NULL,
  "detail"            JSONB NOT NULL DEFAULT '{}'::jsonb,
  "idempotency_key"   TEXT NOT NULL,

  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "session_merge_receipt_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "session_merge_receipt_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "session_merge_receipt_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "session_merge_receipt_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE,

  -- `ALREADY_MERGED` is a RESULT, not a no-op: it is the answer in the external-ff-only case and
  -- in every re-run, and collapsing it into `MERGED` would lose the only thing that tells the two
  -- apart afterwards.
  CONSTRAINT "session_merge_receipt_result_check"
    CHECK ("result" IN ('MERGED', 'ALREADY_MERGED', 'CONFLICT', 'ERROR')),
  CONSTRAINT "session_merge_receipt_recorded_by_check"
    CHECK ("recorded_by" IN ('RUNNER', 'AGENT', 'USER')),

  -- Full 40-hex, lowercase. An abbreviated SHA is ambiguous by construction, and this row's entire
  -- purpose is to still be checkable a month later.
  CONSTRAINT "session_merge_receipt_source_sha_check"
    CHECK ("source_sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "session_merge_receipt_target_sha_before_check"
    CHECK ("target_sha_before" IS NULL OR "target_sha_before" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "session_merge_receipt_target_sha_after_check"
    CHECK ("target_sha_after" IS NULL OR "target_sha_after" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "session_merge_receipt_rebase_base_sha_check"
    CHECK ("rebase_base_sha" IS NULL OR "rebase_base_sha" ~ '^[0-9a-f]{40}$'),

  -- A merge that cannot say where the target ended up is a claim, not a receipt.
  CONSTRAINT "session_merge_receipt_merged_target_check"
    CHECK ("result" <> 'MERGED' OR "target_sha_after" IS NOT NULL),
  CONSTRAINT "session_merge_receipt_conflicts_check"
    CHECK ("result" = 'CONFLICT' OR COALESCE(array_length("conflicts", 1), 0) = 0),

  CONSTRAINT "session_merge_receipt_branches_check"
    CHECK (length(btrim("source_branch")) > 0 AND length(btrim("target_branch")) > 0),
  CONSTRAINT "session_merge_receipt_idempotency_key_check"
    CHECK (length(btrim("idempotency_key")) > 0)
);

-- Unique WITHIN a session, not globally: two sessions merging the same commit into the same branch
-- is two merges and deserves two receipts.
CREATE UNIQUE INDEX "session_merge_receipt_session_id_idempotency_key_key"
  ON "session_merge_receipt" ("session_id", "idempotency_key");
CREATE INDEX "session_merge_receipt_session_id_created_at_idx"
  ON "session_merge_receipt" ("session_id", "created_at");
CREATE INDEX "session_merge_receipt_task_id_created_at_idx"
  ON "session_merge_receipt" ("task_id", "created_at");
CREATE INDEX "session_merge_receipt_project_id_created_at_idx"
  ON "session_merge_receipt" ("project_id", "created_at");
CREATE INDEX "session_merge_receipt_owner_id_created_at_idx"
  ON "session_merge_receipt" ("owner_id", "created_at");

-- Append-only. A receipt is a statement about a moment: the target moves afterwards, and a receipt
-- kept current would stop being evidence of anything. DELETE is left alone — the session and
-- project cascades have to keep working.
CREATE OR REPLACE FUNCTION session_merge_receipt_immutable() RETURNS TRIGGER AS $$
BEGIN
  -- Exactly one UPDATE is allowed through, and it is the row's OWN foreign key acting: `task_id`
  -- going to NULL because the task was deleted (ON DELETE SET NULL). Refusing it would not make
  -- the receipt more immutable, it would make deleting a task impossible — a guard that turns into
  -- a referential deadlock is the failure mode this branch exists to avoid. Every other column has
  -- to be identical, so the exemption cannot be borrowed to rewrite anything.
  IF TG_OP = 'UPDATE'
     AND OLD."task_id" IS NOT NULL AND NEW."task_id" IS NULL
     AND NEW."id"              =                OLD."id"
     AND NEW."owner_id"        =                OLD."owner_id"
     AND NEW."session_id"      =                OLD."session_id"
     AND NEW."project_id"      IS NOT DISTINCT FROM OLD."project_id"
     AND NEW."result"          =                OLD."result"
     AND NEW."source_branch"   =                OLD."source_branch"
     AND NEW."source_sha"      =                OLD."source_sha"
     AND NEW."target_branch"   =                OLD."target_branch"
     AND NEW."target_sha_before" IS NOT DISTINCT FROM OLD."target_sha_before"
     AND NEW."target_sha_after"  IS NOT DISTINCT FROM OLD."target_sha_after"
     AND NEW."rebase_base_sha"   IS NOT DISTINCT FROM OLD."rebase_base_sha"
     AND NEW."conflicts"       =                OLD."conflicts"
     AND NEW."recorded_by"     =                OLD."recorded_by"
     AND NEW."detail"          =                OLD."detail"
     AND NEW."idempotency_key" =                OLD."idempotency_key"
     AND NEW."created_at"      =                OLD."created_at" THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'MERGE_RECEIPT_IMMUTABLE: receipt % records a merge that already happened; record a new receipt instead',
    OLD."id" USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_merge_receipt_immutable_guard
  BEFORE UPDATE ON "session_merge_receipt"
  FOR EACH ROW EXECUTE FUNCTION session_merge_receipt_immutable();

-- ---------------------------------------------------------------------------------------------
-- 4. Backfill: the fresh-review attempts that were replaced rather than dropped.
-- ---------------------------------------------------------------------------------------------
--
-- Scoped by SHAPE, not by id. A CANCELLED task qualifies only when all of these hold: it carries
-- the `fresh-review` label, it sits under a parent inside a project, and a LATER sibling under the
-- same parent, in the same project, with the same owner and the same label, reached DONE. That is
-- exactly the "attempt N was cancelled because attempt N+k was run instead" shape, and it is the
-- only shape this statement can see. A deployment without it gets zero rows; nothing is written to
-- `status`, to any session, or to any row that already carries a supersession.
--
-- The guard above validates every row this writes, which is the point: the backfill is proved by
-- the same trigger that will police every future link, rather than by being trusted.
DO $$
DECLARE
  linked INT;
BEGIN
  WITH candidate AS (
    SELECT c."id" AS cancelled_id, s."id" AS successor_id, s."created_at" AS successor_created_at
      FROM "task" c
      JOIN "task" s
        ON s."project_id"     = c."project_id"
       AND s."parent_task_id" = c."parent_task_id"
       AND s."owner_id"       = c."owner_id"
       AND s."created_at"     > c."created_at"
       AND s."status"         = 'DONE'
       AND s."labels" @> ARRAY['fresh-review']::TEXT[]
     WHERE c."status"                = 'CANCELLED'
       AND c."superseded_by_task_id" IS NULL
       AND c."terminal_reason"       IS NULL
       AND c."project_id"            IS NOT NULL
       AND c."parent_task_id"        IS NOT NULL
       AND c."labels" @> ARRAY['fresh-review']::TEXT[]
  ), pick AS (
    SELECT DISTINCT ON (cancelled_id) cancelled_id, successor_id
      FROM candidate
     ORDER BY cancelled_id, successor_created_at ASC, successor_id ASC
  ), applied AS (
    UPDATE "task" t
       SET "superseded_by_task_id" = p.successor_id,
           -- The instant it stopped, which is when the replacement took over. Read from the row
           -- rather than from now(): this migration is recording history, not making it.
           "superseded_at"         = t."updated_at",
           "terminal_reason"       = 'SUPERSEDED'
      FROM pick p
     WHERE t."id" = p.cancelled_id
     RETURNING t."id"
  )
  SELECT count(*) INTO linked FROM applied;

  RAISE NOTICE '0128 supersession backfill: % cancelled fresh-review attempt(s) linked to their successor', linked;
END $$;
