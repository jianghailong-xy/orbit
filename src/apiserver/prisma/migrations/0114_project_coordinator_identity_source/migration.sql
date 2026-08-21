-- Where a project's coordinator identity CAME FROM, recorded so that the next writer cannot
-- silently disagree with the owner.
--
-- 0113 made the reconciliation read the row that actually commits, which closed 04R: a 0110 binary
-- relocating `coordinator_workspace_id` from A to B no longer leaves an identity naming A. It did
-- that by treating every `landing` event as permission to re-derive the identity from the
-- workspace — and independent validation 04R2 found the state that reading destroys:
--
--   * a 0110 writer creates a project landing on A, so the database derives the identity A;
--   * the owner then chooses a DIFFERENT agent C explicitly (`PATCH /projects/:id` with
--     `coordinatorAgentId`, which writes `project_member` and does not touch the landing);
--   * a 0110 binary still serving requests during the rolling deploy relocates the landing A → B
--     and rotates the session. It knows neither `project_member` nor `coordinatorAgentId`;
--   * 0113's landing reconciliation deletes C and seats B. The transaction commits. The owner's
--     authorized choice of WHO is gone, with no error, no refusal and no audit.
--
-- Both 04R's state and 04R2's state look identical to 0113, because the row it reads cannot say
-- which of the two it is: "the identity is A and the landing is B" is a STALE DERIVATION when the
-- database derived A, and an OWNER'S CHOICE when a person wrote it. PAC R3 keeps WHO and WHERE as
-- two independent chains precisely so one cannot be re-inferred from the other; the missing fact
-- is not in either row, so this migration writes it down.
--
-- Two columns on `project_runtime` — the control loop's own row, which is where 0113 already keeps
-- the baseline the generation is counted from. No new business entity, and nothing added to
-- `project_member`: provenance has to outlive the membership row itself, because "the owner
-- cleared the coordinator" is also a choice, and a landing event must not undo it by seating one.
--
--   * `coordinator_identity_source` — DERIVED (the database worked this identity out from the
--     landing, and may work it out again) or EXPLICIT (somebody chose it, or chose to have none).
--     It is written by the current service in the same transaction as the membership.
--   * `coordinator_identity_landing_id` — the landing a DERIVED identity was derived FROM, exactly
--     as `coordinator_session_id` is the session the generation was counted from. It is what lets
--     the database recognise a choice made by a writer that has never heard of the column above:
--     the seat it derived names this workspace, so a seat that names anything else was moved by
--     somebody, and a seat that has vanished was removed by somebody.
--
-- That second column is not belt-and-braces, it is the rollback protocol. A 0113-era binary rolled
-- back onto this schema (forward schema, older app — the deployment this whole series is written
-- for) writes `project_member.agent_id` directly and cannot write the source column. Its explicit
-- writes are still recognised, because the structural test above needs nothing from the writer.
--
-- Every statement here can be run twice, on the same terms as 0111–0113: the type is created
-- inside an exception block, the columns are added IF NOT EXISTS, the backfill only touches rows
-- still in their pristine default state, and the function is replaced by name.

-- ── The vocabulary ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "project_identity_source" AS ENUM ('DERIVED', 'EXPLICIT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- DERIVED is the default for the same reason `coordinator_enabled` defaults to false in 0111: it
-- is what every row that already exists has to keep, and it is the answer that keeps the database
-- ABLE to correct itself. Defaulting to EXPLICIT would freeze every stale derivation 04R found.
--
-- A default rather than a NOT NULL with no default, deliberately: a 0113-era binary inserts
-- `project_runtime` rows (`ProjectsService.create`) without naming this column, and a rollback
-- that cannot insert a project is a worse outcome than one that inserts a derivable one.
ALTER TABLE "project_runtime"
  ADD COLUMN IF NOT EXISTS "coordinator_identity_source" "project_identity_source" NOT NULL DEFAULT 'DERIVED';

-- No foreign key, for the reason `coordinator_session_id` has none (contract §7.7 D19-b): this is
-- a historical marker, not a reference. SET NULL would make a stale derivation look like a choice
-- the moment an agent row was purged, and RESTRICT would make deleting an agent fail against a
-- marker rather than against the membership that actually holds it (0111's RESTRICT already does).
ALTER TABLE "project_runtime"
  ADD COLUMN IF NOT EXISTS "coordinator_identity_landing_id" UUID;

-- ── The rows that already exist ────────────────────────────────────────────────────────────────
--
-- Every coordinator membership written before this migration came from one of exactly two places,
-- and the committed rows still say which:
--
--   * a mechanical derivation (0112's backfill, 0112's or 0113's trigger, or `ProjectsService.
--     create`, which seats the recording session's own workspace). All four seat the LANDING, so
--     the identity equals `coordinator_workspace_id` — or the landing has since moved, which is
--     the stale derivation 04R closed and which must stay correctable.
--   * an owner's explicit `coordinatorAgentId`. That is the only writer that can produce an
--     identity naming something the project has never landed on.
--
-- So a seat that differs from the landing is a choice, provably, and a seat that equals it is a
-- derivation as far as anything can tell. The ambiguous case — an owner who explicitly chose the
-- agent the project was already landing on — is backfilled as DERIVED, because pre-0114 data
-- contains no evidence to the contrary and because DERIVED is the answer that changes nothing
-- about where the identity already points. Going forward that case is recorded as EXPLICIT by the
-- service, in the same transaction as the membership.
--
-- Guarded to rows still in their pristine default state, so that re-running an interrupted apply
-- cannot demote an EXPLICIT row that the same file already promoted.
UPDATE "project_runtime" r
   SET "coordinator_identity_source" =
         CASE WHEN m."agent_id" IS NOT NULL AND m."agent_id" IS DISTINCT FROM p."coordinator_workspace_id"
              THEN 'EXPLICIT'::"project_identity_source"
              ELSE 'DERIVED'::"project_identity_source" END,
       "coordinator_identity_landing_id" =
         CASE WHEN m."agent_id" IS NOT NULL AND m."agent_id" = p."coordinator_workspace_id"
              THEN p."coordinator_workspace_id" ELSE NULL END,
       "updated_at" = CURRENT_TIMESTAMP
  FROM "project" p
  LEFT JOIN "project_member" m ON m."project_id" = p."id" AND m."role" = 'COORDINATOR'
 WHERE p."id" = r."project_id"
   AND r."coordinator_identity_source" = 'DERIVED'
   AND r."coordinator_identity_landing_id" IS NULL;

-- ── The one rule, now told where the identity came from ────────────────────────────────────────
--
-- 0113's function, with one question inserted before it decides what a `landing` event may do:
-- is the seat this project has the seat the DATABASE put there? Everything else about it —
-- the final-row read, the lock, the runtime row, the generation baseline, the tenant and
-- soft-delete conditions, the rotation split, the delete-then-insert — is unchanged, because all
-- of it was right.
CREATE OR REPLACE FUNCTION project_coordinator_reconcile() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  final        "project"%ROWTYPE;
  baseline     UUID;
  landing      UUID;
  held         UUID;
  seated_id    UUID;
  seated_agent UUID;
  source       "project_identity_source";
  derived_from UUID;
BEGIN
  -- Unchanged from 0113: the row that is about to be committed, not the one that triggered the
  -- event, under the weakest lock that turns two concurrent reconciliations into two orderings.
  SELECT * INTO final FROM "project" WHERE "id" = NEW."id" FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO "project_runtime" ("project_id", "coordinator_generation", "coordinator_session_id",
                                   "created_at", "updated_at")
    VALUES (final."id", 0, NEW."coordinator_session_id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("project_id") DO UPDATE
       SET "coordinator_session_id" = EXCLUDED."coordinator_session_id"
     WHERE "project_runtime"."coordinator_session_id" IS NULL
       AND "project_runtime"."coordinator_generation" = 0;
  ELSE
    INSERT INTO "project_runtime" ("project_id", "coordinator_generation", "coordinator_session_id",
                                   "created_at", "updated_at")
    VALUES (final."id", 0, final."coordinator_session_id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("project_id") DO NOTHING;
  END IF;

  SELECT "coordinator_session_id", "coordinator_identity_source", "coordinator_identity_landing_id"
    INTO baseline, source, derived_from
    FROM "project_runtime" WHERE "project_id" = final."id";

  IF final."coordinator_session_id" IS NOT NULL AND baseline IS NOT NULL
     AND final."coordinator_session_id" <> baseline THEN
    UPDATE "project_runtime"
       SET "coordinator_generation" = "coordinator_generation" + 1,
           "coordinator_session_id" = final."coordinator_session_id",
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "project_id" = final."id";
  ELSIF baseline IS DISTINCT FROM final."coordinator_session_id" THEN
    UPDATE "project_runtime"
       SET "coordinator_session_id" = final."coordinator_session_id",
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "project_id" = final."id";
  END IF;

  landing := final."coordinator_workspace_id";

  SELECT m."id", m."agent_id" INTO seated_id, seated_agent
    FROM "project_member" m
   WHERE m."project_id" = final."id" AND m."role" = 'COORDINATOR';

  -- ── Whose seat is this? ──────────────────────────────────────────────────────────────────────
  --
  -- The database records the landing it derived a seat from. So a DERIVED project whose seat no
  -- longer matches that record was changed by somebody who is not this function — the owner API,
  -- or a binary that predates the column above and writes `project_member` directly. Either way
  -- it is a choice, and it is written down HERE rather than merely acted on, so that it survives
  -- every later writer that does not know to make it.
  --
  -- Two shapes of evidence, and nothing else counts:
  --
  --   * the seat names an agent that is neither the recorded derivation nor the project's current
  --     landing. A seat equal to the CURRENT landing is excluded deliberately: a rolled-back
  --     binary creating a project seats its own workspace and records no derivation, and reading
  --     that as a choice would freeze exactly the stale identities 04R closed. It is also the
  --     ambiguous case the backfill above resolves the same way, for the same reason;
  --   * the seat is gone while a derivation was on record. Nothing but a deliberate removal can
  --     do that — when THIS function drops a seat it clears the record in the same statement.
  IF source <> 'EXPLICIT'
     AND ((seated_id IS NOT NULL
           AND seated_agent IS DISTINCT FROM derived_from
           AND seated_agent IS DISTINCT FROM landing)
          OR (seated_id IS NULL AND derived_from IS NOT NULL)) THEN
    source := 'EXPLICIT';
    UPDATE "project_runtime"
       SET "coordinator_identity_source" = 'EXPLICIT',
           "coordinator_identity_landing_id" = NULL,
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "project_id" = final."id";
  END IF;

  -- A project that names no coordination workspace has nothing to derive an identity FROM, and an
  -- absent landing is not an instruction to disband a team.
  IF landing IS NULL THEN RETURN NULL; END IF;

  -- Already exactly what the committed row says. Nothing to write, whichever event this is and
  -- however many times it fires — including when the landing has gone soft-deleted underneath the
  -- project, where the identity still names it and there is no contradiction to resolve.
  --
  -- The one thing that may still be missing is the record of WHERE that derivation came from: a
  -- seat written by a 0112/0113-era trigger, or by a rolled-back binary, is a derivation nobody
  -- wrote down. Adopting it here is safe precisely because the seat and the landing agree, which
  -- is the state the clause above already refuses to read as a choice.
  IF seated_agent = landing THEN
    IF source = 'DERIVED' AND derived_from IS DISTINCT FROM landing THEN
      UPDATE "project_runtime"
         SET "coordinator_identity_landing_id" = landing, "updated_at" = CURRENT_TIMESTAMP
       WHERE "project_id" = final."id";
    END IF;
    RETURN NULL;
  END IF;

  -- ── A seat somebody chose ────────────────────────────────────────────────────────────────────
  --
  -- WHO was decided by a person, so WHERE moving does not re-decide it — that is PAC R3, and it is
  -- the whole of P1-04R2-01. This branch is reached by every event, not just by `landing`: a
  -- rotation was already forbidden from replacing an identity by §7.5, and saying it once here
  -- makes the guarantee one rule rather than two.
  IF source = 'EXPLICIT' THEN
    -- An owner who cleared the coordinator chose to have none. A landing event may not answer that
    -- by seating one; the way back is another explicit write.
    IF seated_id IS NULL THEN RETURN NULL; END IF;

    -- Keeping a chosen identity is only safe while it is still a legal one. The two conditions are
    -- the two every derivation applies (same account, not soft-deleted), asked of the SEAT rather
    -- than of the landing, and under the same `FOR SHARE` for the same reason (validation 04,
    -- P1-03): a soft delete is an UPDATE, so the membership's own foreign key does not conflict
    -- with it.
    --
    -- `WorkspacesService.remove` refuses to delete an agent that coordinates a project, so this
    -- state is not reachable through the product. If it is reached anyway, the transaction FAILS,
    -- visibly and with a code a caller can match on: the two things this function must never do
    -- are seat an agent PAC M2 excludes, and quietly replace a choice the owner made. Failing
    -- closed is the only answer left that does neither.
    IF NOT EXISTS (
      SELECT 1 FROM "workspace" w
       WHERE w."id" = seated_agent AND w."owner_id" = final."owner_id" AND w."deleted_at" IS NULL
       FOR SHARE
    ) THEN
      RAISE EXCEPTION 'project % has an explicitly chosen coordinator agent % that is no longer a live agent of this account; refusing to rewrite it', final."id", seated_agent
        USING ERRCODE = 'ORB01',
              HINT = 'set coordinatorAgentId to a live agent of this account, or clear it';
    END IF;
    RETURN NULL;
  END IF;

  -- ── A seat the database derived ──────────────────────────────────────────────────────────────
  --
  -- Unchanged from 0113, apart from recording what it derived the seat from — including the order
  -- of the two clauses below: §7.5 lets a rotation FILL IN an identity a project never had and
  -- never replace one, so it stops here before anything is derived, deleted or re-seated.

  IF TG_ARGV[0] = 'rotation' AND seated_id IS NOT NULL THEN RETURN NULL; END IF;

  SELECT w."id" INTO held
    FROM "workspace" w
   WHERE w."id" = landing AND w."owner_id" = final."owner_id" AND w."deleted_at" IS NULL
   FOR SHARE;

  IF held IS NULL THEN
    -- A landing nothing may be derived from, and an identity that names a DIFFERENT workspace: the
    -- project keeps its landing and loses the identity it no longer supports — no identity rather
    -- than a wrong one. The record goes with it, in the same statement, so that the absence is not
    -- mistaken for a removal somebody performed.
    IF seated_id IS NOT NULL THEN DELETE FROM "project_member" WHERE "id" = seated_id; END IF;
    UPDATE "project_runtime"
       SET "coordinator_identity_landing_id" = NULL, "updated_at" = CURRENT_TIMESTAMP
     WHERE "project_id" = final."id" AND "coordinator_identity_landing_id" IS NOT NULL;
    RETURN NULL;
  END IF;

  IF seated_id IS NOT NULL THEN DELETE FROM "project_member" WHERE "id" = seated_id; END IF;
  INSERT INTO "project_member" ("id", "project_id", "agent_id", "role", "added_at")
  VALUES (gen_random_uuid(), final."id", landing, 'COORDINATOR', CURRENT_TIMESTAMP)
  ON CONFLICT ("project_id", "agent_id") DO UPDATE SET "role" = 'COORDINATOR';
  UPDATE "project_runtime"
     SET "coordinator_identity_landing_id" = landing, "updated_at" = CURRENT_TIMESTAMP
   WHERE "project_id" = final."id" AND "coordinator_identity_landing_id" IS DISTINCT FROM landing;
  RETURN NULL;
END;
$$;
