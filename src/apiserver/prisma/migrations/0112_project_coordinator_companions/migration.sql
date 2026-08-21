-- The two things 0111 left to the writer, made the database's: a project that names a coordination
-- workspace HAS a coordinator, and a project row HAS its runtime row — whichever binary wrote it.
--
-- 0111 recorded the coordinator identity going forward and backfilled `project_runtime`, and both
-- of those turned out to hold only while the new service is the only writer. Independent validation
-- (docs/project-coordinator-validation-04.md, P1-01 and P1-06) found the two gaps this migration
-- closes:
--
--   * every project that was already bound to a coordination workspace before 0111 came out of it
--     with no `project_member` row at all — its coordinator was a conversation with no identity
--     behind it, and nothing self-heals it, because a live coordinator session is returned without
--     ever reaching the write that would;
--   * a 0110 binary still serving requests after this schema lands (rolling deploy, or an app
--     rollback that correctly leaves the schema forward) inserts projects in the old shape: no
--     runtime row, no membership. The columns default safely; the companion ROWS have no default.
--
-- Both are the same statement, once as a backfill of the rows that exist and once as a trigger for
-- the rows any writer makes next. The trigger is what makes the guarantee mechanical rather than a
-- promise about deployment order — see §6 of docs/project-coordinator-repair-03a.md.
--
-- Every statement below can be run twice: the two backfills absorb their own conflicts, and each
-- trigger is dropped by name before it is created (a constraint trigger has no OR REPLACE form).
-- That is what lets a deploy that was interrupted part-way through this file be re-run rather than
-- reasoned about, and it is the same property 0111's INSERT was written for.

-- ── The rows any writer makes next ─────────────────────────────────────────────────────────────
--
-- First, so that nothing can be inserted between this and the backfill below.

-- What a project row must be accompanied by, established at the end of whatever transaction wrote
-- it and by whichever binary wrote it.
--
-- Deliberately NOT an immediate AFTER trigger. The current service writes the membership itself, in
-- the same insert as the project (`ProjectsService.create`); an immediate trigger would get there
-- first and turn every create-in-session into a unique-index violation. A deferred CONSTRAINT
-- trigger runs at COMMIT, by which time the writer's own row is visible to it, so the new writer's
-- explicit write stays authoritative and this only fills what nobody wrote. Two writers, one rule,
-- no double insert.
--
-- The cost of deferring is that a transaction which inserts a project and then reads its companion
-- rows BEFORE committing sees nothing. That is not a case anything reaches: the service writes its
-- own runtime row and membership in the insert itself, and a writer old enough not to write them
-- does not read them either.
CREATE OR REPLACE FUNCTION project_coordinator_companions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Running at COMMIT means the row this fires for may have been deleted since — a project created
  -- and dropped again inside one transaction is the ordinary case. Companions for a project that
  -- no longer exists are not merely pointless: the foreign key would refuse them and take the whole
  -- transaction down with them, turning a legal pair of statements into an error.
  IF NOT EXISTS (SELECT 1 FROM "project" WHERE "id" = NEW."id") THEN RETURN NULL; END IF;

  INSERT INTO "project_runtime" ("project_id", "coordinator_generation", "created_at", "updated_at")
  VALUES (NEW."id", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("project_id") DO NOTHING;

  IF NEW."coordinator_workspace_id" IS NOT NULL THEN
    -- The same derivation, the same two safety conditions and the same "never overwrite an
    -- existing coordinator" as the backfill above.
    INSERT INTO "project_member" ("id", "project_id", "agent_id", "role", "added_at")
    SELECT gen_random_uuid(), NEW."id", w."id", 'COORDINATOR', CURRENT_TIMESTAMP
      FROM "workspace" w
     WHERE w."id" = NEW."coordinator_workspace_id"
       AND w."owner_id" = NEW."owner_id"
       AND w."deleted_at" IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM "project_member" m
          WHERE m."project_id" = NEW."id" AND m."role" = 'COORDINATOR'
       )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS project_coordinator_companions_insert ON "project";
CREATE CONSTRAINT TRIGGER project_coordinator_companions_insert
AFTER INSERT ON "project"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION project_coordinator_companions();

-- A project that gets its coordination workspace LATER — an old writer opening the first
-- coordinator of a project that had none — is the same event arriving as an update. Only
-- NULL → set: a project that already names a workspace already has (or has deliberately been left
-- without) an identity, and §7.5 freezes rotation as "the session changes, the agent does not".
DROP TRIGGER IF EXISTS project_coordinator_companions_bind ON "project";
CREATE CONSTRAINT TRIGGER project_coordinator_companions_bind
AFTER UPDATE OF "coordinator_workspace_id" ON "project"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."coordinator_workspace_id" IS NULL AND NEW."coordinator_workspace_id" IS NOT NULL)
EXECUTE FUNCTION project_coordinator_companions();

-- Counting rotations is the database's too, for the same reason: an old writer replacing a
-- coordinator session advances no counter, and a generation that stands still while the
-- conversation changes makes two runs look like one to everything that later derives a key from it.
--
-- Exactly the condition the service used to apply in its own transaction: a REPLACEMENT, meaning
-- one session pointer swapped for a different one. Binding a first coordinator (NULL → set) is
-- generation 0 — "the coordinator this project has always had" — and losing one to a deleted
-- session (set → NULL) is not a rotation either; it is a project waiting for its next one.
CREATE OR REPLACE FUNCTION project_coordinator_rotation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Same reason as the companion trigger: at COMMIT, the project this rotation belonged to may
  -- already be gone.
  IF NOT EXISTS (SELECT 1 FROM "project" WHERE "id" = NEW."id") THEN RETURN NULL; END IF;

  INSERT INTO "project_runtime" ("project_id", "coordinator_generation", "created_at", "updated_at")
  VALUES (NEW."id", 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("project_id") DO UPDATE
     SET "coordinator_generation" = "project_runtime"."coordinator_generation" + 1,
         "updated_at" = CURRENT_TIMESTAMP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS project_coordinator_rotation_count ON "project";
CREATE CONSTRAINT TRIGGER project_coordinator_rotation_count
AFTER UPDATE OF "coordinator_session_id" ON "project"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."coordinator_session_id" IS NOT NULL
      AND NEW."coordinator_session_id" IS NOT NULL
      AND OLD."coordinator_session_id" <> NEW."coordinator_session_id")
EXECUTE FUNCTION project_coordinator_rotation();

-- ── The rows that already exist ────────────────────────────────────────────────────────────────
--
-- Second, and that order is load-bearing. `CREATE TRIGGER` takes SHARE ROW EXCLUSIVE on
-- `project`, which conflicts with the lock an INSERT takes, so from the statement above until
-- this migration commits no other transaction can insert a project at all. Backfilling FIRST
-- would leave the gap between the two statements open: a project inserted by an old writer in
-- that instant would be too late for the backfill and too early for the trigger, and would be
-- the one row nothing gave companions to.

-- PAC §11.2 steps 4 and 5: a project's coordination workspace IS its coordinator's agent, so a
-- project already bound to one is a project whose coordinator identity is already decided and
-- merely unrecorded. Backfilling it invents nothing — it writes down the agent the next
-- coordinator session was always going to open in.
--
-- Ownership is the safety condition, not an optimisation: a workspace belonging to somebody else
-- would make one account's agent the coordinator of another account's project, and `coordinator_
-- workspace_id` carries no tenant check of its own (it is nullable and set by writers). Soft-
-- deleted workspaces are skipped for the reason PAC M2 skips them — a deleted agent must not
-- reappear in a team — and their projects are left with no identity rather than a wrong one.
--
-- Idempotent three times over: NOT EXISTS skips a project that already has a coordinator (never
-- overwriting one somebody chose), ON CONFLICT DO NOTHING absorbs the partial unique index, and
-- re-running the statement selects nothing.
INSERT INTO "project_member" ("id", "project_id", "agent_id", "role", "added_at")
SELECT
    -- A v4 rather than the v7 the application generates for this column. Nothing orders or decodes
    -- a membership id — it is a row identity — and a migration has no clock-ordered generator.
    gen_random_uuid(),
    p."id",
    w."id",
    'COORDINATOR',
    CURRENT_TIMESTAMP
  FROM "project" p
  JOIN "workspace" w
    ON w."id" = p."coordinator_workspace_id"
   AND w."owner_id" = p."owner_id"
   AND w."deleted_at" IS NULL
 WHERE p."coordinator_workspace_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "project_member" m
      WHERE m."project_id" = p."id" AND m."role" = 'COORDINATOR'
   )
ON CONFLICT DO NOTHING;

-- 0111 wrote one of these per project that existed WHEN IT RAN. A project inserted by an old writer
-- between that moment and this one has none, so the same statement runs again. (New projects get
-- theirs from `ProjectsService.create`, and from the trigger below when they do not.)
INSERT INTO "project_runtime" ("project_id", "coordinator_generation", "created_at", "updated_at")
SELECT "id", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "project"
ON CONFLICT ("project_id") DO NOTHING;
