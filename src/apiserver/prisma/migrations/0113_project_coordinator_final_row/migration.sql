-- 0112's guarantee, made about the row that actually commits.
--
-- 0112 turned "a project row HAS its companion rows" into three DEFERRABLE INITIALLY DEFERRED
-- constraint triggers, so that the rule holds for whichever binary did the writing. Deferring them
-- to COMMIT is what makes the new service's own explicit write authoritative — but a deferred
-- trigger is still handed `NEW` as the row looked WHEN THE EVENT HAPPENED, not as it looks at the
-- commit point it runs at. 0112 derived the coordinator identity from that image, and independent
-- validation 04R found the two states where the image and the committed row disagree:
--
--   * one transaction that INSERTs a project naming workspace A and then UPDATEs it to workspace B
--     commits with `coordinator_workspace_id = B` and a COORDINATOR membership naming A. The bind
--     trigger cannot correct it either: its `WHEN` clause only admitted NULL → set;
--   * a 0110 binary that relocates an already-bound project from A to B (§6.3 of
--     docs/project-coordinator-repair-03a.md records that it still can) advances the generation
--     correctly and leaves the identity on A. The new reader then does not fail closed — it
--     observes a fixed Agent and a fixed Workspace that contradict each other.
--
-- Both are the same defect: a rule about the committed state was evaluated against an earlier one.
-- So the three triggers keep their names, their timing and their events, and every one of them now
-- runs ONE function that begins by LOCKING THE PROJECT BY ID AND READING IT BACK. Nothing below
-- reads `NEW` for a value it can read from the final row; what `NEW` is still used for — and only
-- on INSERT — is the one thing the final row cannot state: which session the project was BORN
-- naming, which is the baseline the rotation count is measured from.
--
-- Every statement here can be run twice, on the same terms as 0111 and 0112: the column is added
-- IF NOT EXISTS, the backfill re-selects nothing, and each trigger is dropped by name before it is
-- created (a constraint trigger has no OR REPLACE form).

-- ── What the generation is counted from ────────────────────────────────────────────────────────
--
-- The rotation count cannot be derived from the final row alone: "how many times has this pointer
-- been replaced" is a statement about the pointer's history, and the row only holds its present.
-- 0112 read that history out of the event's own OLD image, which is exactly the thing that makes
-- the answer depend on how many statements a writer split its change across.
--
-- Recorded instead, next to the count it belongs to: the coordinator session the current
-- generation was minted for. The count then becomes a pure function of two committed facts — this
-- column and the final row — so it is the same whether one transaction moved the pointer once or
-- five times, whichever order the deferred events happen to fire in, and however often a replay
-- re-runs the whole reconciliation.
--
-- No foreign key, deliberately, and for the reason `project_decision.coordinator_session_id` has
-- none (contract §7.7 D19-b): this is a historical id, not a reference. ON DELETE SET NULL would
-- quietly reset the baseline when a rotated-away session is purged — and a baseline that resets is
-- a rotation that goes uncounted; RESTRICT would make deleting a session fail against a counter.
ALTER TABLE "project_runtime" ADD COLUMN IF NOT EXISTS "coordinator_session_id" UUID;

-- Every runtime row that already exists is already counted, as of the session its project names
-- now. Writing that down is what stops the first reconciliation after this migration from reading
-- a NULL baseline as "this project has never had a coordinator" and either counting a rotation
-- that already happened or, worse, missing the next one.
UPDATE "project_runtime" r
   SET "coordinator_session_id" = p."coordinator_session_id"
  FROM "project" p
 WHERE p."id" = r."project_id"
   AND r."coordinator_session_id" IS NULL
   AND p."coordinator_session_id" IS NOT NULL;

-- ── The one rule, evaluated on the committed row ───────────────────────────────────────────────
--
-- `TG_ARGV[0]` says what this event is allowed to do to the IDENTITY, and it is the only thing the
-- three triggers do differently:
--
--   * 'landing' — the project's coordination workspace was written (INSERT) or moved (UPDATE), so
--     the identity the database derives is re-derived from it. This is what closes 04R.
--   * 'rotation' — only the conversation changed. Contract §7.5 is verbatim: "轮换只换 Session,
--     Coordinator Agent 不变". A rotation may FILL IN an identity a project never had; it may
--     never replace one. Without this split, rotating the session of a project whose coordinator
--     agent was set explicitly (`PATCH /projects/:id` with `coordinatorAgentId`, which does not
--     touch `coordinator_workspace_id`) would snap that choice back to the landing.
--
-- Everything else — the runtime row, the generation, the tenant and soft-delete conditions — is
-- identical for all three, because all three are answering the same question about the same
-- committed row.
CREATE OR REPLACE FUNCTION project_coordinator_reconcile() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  final        "project"%ROWTYPE;
  baseline     UUID;
  landing      UUID;
  held         UUID;
  seated_id    UUID;
  seated_agent UUID;
BEGIN
  -- The whole fix, in one statement. Running at COMMIT means every other statement this
  -- transaction made has already happened, so this reads the row that is about to be committed
  -- rather than the one that triggered the event — and it is also why the row may be GONE: a
  -- project created and dropped again inside one transaction is the ordinary case, and writing
  -- companions for it would be refused by the foreign key and take a legal pair of statements
  -- down with it.
  --
  -- `FOR NO KEY UPDATE` rather than a plain SELECT: two transactions reconciling the same project
  -- become two orderings instead of an interleaving, and the second one re-reads what the first
  -- committed. It is the weakest lock that does that — it does not conflict with the FOR KEY SHARE
  -- an inserted task takes on this row, so filing work into a project never waits on a
  -- reconciliation. Lock order is project → workspace, the same order `ProjectsService.update`
  -- takes and the reverse of nothing: `WorkspacesService.remove` never locks a project row.
  SELECT * INTO final FROM "project" WHERE "id" = NEW."id" FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- The control loop's row, and the baseline the count is measured from.
  --
  -- On INSERT that baseline is the session the project was BORN naming — the one value the final
  -- row cannot supply, and the reason `NEW` is read here and nowhere else. A project inserted
  -- naming session S and moved to T before the same transaction commits has rotated once, exactly
  -- as it would have if the two statements had been two transactions.
  --
  -- The conditional DO UPDATE is what makes that true of BOTH writers: the current service writes
  -- its own runtime row inside the project insert (`ProjectsService.create`), so the row is
  -- already there by the time this runs, with no baseline on it. A row that has recorded no
  -- baseline and counted no rotation is a row that was created by this very transaction; adopting
  -- the birth session onto it cannot overwrite anything anybody else established.
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "project_runtime" ("project_id", "coordinator_generation", "coordinator_session_id",
                                   "created_at", "updated_at")
    VALUES (final."id", 0, NEW."coordinator_session_id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("project_id") DO UPDATE
       SET "coordinator_session_id" = EXCLUDED."coordinator_session_id"
     WHERE "project_runtime"."coordinator_session_id" IS NULL
       AND "project_runtime"."coordinator_generation" = 0;
  ELSE
    -- An update to a project that has no runtime row at all: 0111's backfill ran before it
    -- existed and 0112's trigger was not there to give it one. It gets one now, already counted
    -- as of where it stands — there is no earlier generation for this update to be a rotation of.
    INSERT INTO "project_runtime" ("project_id", "coordinator_generation", "coordinator_session_id",
                                   "created_at", "updated_at")
    VALUES (final."id", 0, final."coordinator_session_id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("project_id") DO NOTHING;
  END IF;

  SELECT "coordinator_session_id" INTO baseline
    FROM "project_runtime" WHERE "project_id" = final."id";

  -- Exactly 0112's condition — a REPLACEMENT, one non-null pointer swapped for a different
  -- non-null one — asked of the baseline and the committed row instead of of one event's OLD and
  -- NEW. So the semantics it was written for are unchanged: binding a first coordinator is
  -- generation 0 ("the coordinator this project has always had"), losing one to a deleted session
  -- is a project waiting for its next rather than a rotation, and writing the same pointer again
  -- is not a replacement however often it happens.
  --
  -- What DOES change is that the answer no longer depends on how the change was spelled. Five
  -- updates in one transaction that end where they started count nothing; A → B → C counts one;
  -- a duplicate deferred event finds the baseline already moved and counts nothing again.
  IF final."coordinator_session_id" IS NOT NULL AND baseline IS NOT NULL
     AND final."coordinator_session_id" <> baseline THEN
    UPDATE "project_runtime"
       SET "coordinator_generation" = "coordinator_generation" + 1,
           "coordinator_session_id" = final."coordinator_session_id",
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "project_id" = final."id";
  ELSIF baseline IS DISTINCT FROM final."coordinator_session_id" THEN
    -- Not a rotation, but the baseline moved: a first coordinator, or a project that lost one.
    UPDATE "project_runtime"
       SET "coordinator_session_id" = final."coordinator_session_id",
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "project_id" = final."id";
  END IF;

  -- A project that names no coordination workspace has nothing to derive an identity FROM, and an
  -- absent landing is not an instruction to disband a team: whatever membership it has is left
  -- exactly as it is.
  landing := final."coordinator_workspace_id";
  IF landing IS NULL THEN RETURN NULL; END IF;

  SELECT m."id", m."agent_id" INTO seated_id, seated_agent
    FROM "project_member" m
   WHERE m."project_id" = final."id" AND m."role" = 'COORDINATOR';

  -- Already exactly what the committed row says. Nothing to write, whichever event this is and
  -- however many times it fires — and this is also the case that keeps §7.5 true when a landing
  -- goes soft-deleted UNDERNEATH a project: the identity still names it, so there is no
  -- contradiction to resolve and no reason to touch the row.
  IF seated_agent = landing THEN RETURN NULL; END IF;

  -- Only the conversation changed. §7.5 freezes the agent across a rotation, so this event may
  -- fill in an identity the project never had and may not replace one it has.
  IF TG_ARGV[0] = 'rotation' AND seated_id IS NOT NULL THEN RETURN NULL; END IF;

  -- Can this landing carry an identity at all? The same two conditions 0111's backfill and 0112's
  -- trigger applied, for the same two reasons: `coordinator_workspace_id` carries no tenant check
  -- of its own, so a workspace belonging to somebody else would make one account's agent the
  -- coordinator of another account's project; and a soft-deleted agent must not reappear on a team
  -- (PAC M2).
  --
  -- `FOR SHARE` rather than a plain read, for the reason `ProjectsService.lockLiveAgent` takes it
  -- (validation 04, P1-03): a soft delete is an UPDATE, so the foreign key's own FOR KEY SHARE
  -- does not conflict with it and the check and the write would otherwise straddle it. Under the
  -- lock the two are orderings — either the delete waits and then finds the membership, or this
  -- re-evaluates its qualifier against the committed row and finds none.
  SELECT w."id" INTO held
    FROM "workspace" w
   WHERE w."id" = landing AND w."owner_id" = final."owner_id" AND w."deleted_at" IS NULL
   FOR SHARE;

  IF held IS NULL THEN
    -- A landing nothing may be derived from, and an identity that names a DIFFERENT workspace:
    -- the state 04R reported, in its other form. Left alone it is a fixed Agent and a fixed
    -- Workspace that contradict each other, and a reader that believes either one is wrong. The
    -- project keeps its landing and loses the identity it no longer supports — no identity rather
    -- than a wrong one, which is the same answer the backfill gives a project it cannot derive an
    -- identity for at all.
    IF seated_id IS NOT NULL THEN DELETE FROM "project_member" WHERE "id" = seated_id; END IF;
    RETURN NULL;
  END IF;

  -- Seat the landing. Delete-then-insert rather than an UPDATE of `agent_id` because the agent
  -- being seated may already hold a NON-coordinator membership of this project, which
  -- `project_member_project_id_agent_id_key` would refuse — at COMMIT, where the error lands on a
  -- transaction that did nothing wrong. Nothing observes the gap between the two statements: they
  -- are the last thing this transaction does.
  IF seated_id IS NOT NULL THEN DELETE FROM "project_member" WHERE "id" = seated_id; END IF;
  INSERT INTO "project_member" ("id", "project_id", "agent_id", "role", "added_at")
  VALUES (gen_random_uuid(), final."id", landing, 'COORDINATOR', CURRENT_TIMESTAMP)
  ON CONFLICT ("project_id", "agent_id") DO UPDATE SET "role" = 'COORDINATOR';
  RETURN NULL;
END;
$$;

-- The same three events 0112 declared, under the same three names, so this replaces them rather
-- than adding a second set that fires alongside the first.

DROP TRIGGER IF EXISTS project_coordinator_companions_insert ON "project";
CREATE CONSTRAINT TRIGGER project_coordinator_companions_insert
AFTER INSERT ON "project"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION project_coordinator_reconcile('landing');

-- 0112 admitted only NULL → set here, on the reading that a project which already names a
-- workspace has already decided. That reading is right about what the SERVICE may do — §7.5 makes
-- naming a different workspace a 409, not a silent migration — and wrong about what the DATABASE
-- must then be able to say: a 0110 binary relocates the column anyway (repair-03a §6.3), and the
-- trigger that was supposed to keep the identity true of the row is the one that declined to look.
DROP TRIGGER IF EXISTS project_coordinator_companions_bind ON "project";
CREATE CONSTRAINT TRIGGER project_coordinator_companions_bind
AFTER UPDATE OF "coordinator_workspace_id" ON "project"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."coordinator_workspace_id" IS DISTINCT FROM NEW."coordinator_workspace_id")
EXECUTE FUNCTION project_coordinator_reconcile('landing');

-- Broadened from "one non-null pointer replaced by another" to "the pointer changed at all", and
-- the count is unaffected by that: it is decided against the recorded baseline inside the
-- function, not by this clause. What the wider clause buys is that the baseline is MAINTAINED on
-- the events that are not rotations — binding a first coordinator, and losing one — so that the
-- next replacement is measured from where the project actually stands.
DROP TRIGGER IF EXISTS project_coordinator_rotation_count ON "project";
CREATE CONSTRAINT TRIGGER project_coordinator_rotation_count
AFTER UPDATE OF "coordinator_session_id" ON "project"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."coordinator_session_id" IS DISTINCT FROM NEW."coordinator_session_id")
EXECUTE FUNCTION project_coordinator_reconcile('rotation');

-- 0112's two functions, now that no trigger names either. Left behind they would be two more
-- definitions of a rule that has exactly one, and the next reader would have to work out which of
-- the three is live.
DROP FUNCTION IF EXISTS project_coordinator_companions();
DROP FUNCTION IF EXISTS project_coordinator_rotation();
