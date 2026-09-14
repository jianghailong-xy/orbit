-- A project blocker can be ended with a reason, and the reason is as final as the resolution.
--
-- Until this migration nothing in production wrote `project_blocker.resolved_at`. Two writers do
-- now, and both say why: the account owner, through `POST /projects/:id/blockers/:blockerId/resolve`
-- (`project-blocker-resolution.ts`), and the unit that raises a delivery's blocker, once the work it
-- was holding back has landed (`WakeDispositionService.resolveLandedBlockers`). A resolution by a
-- person also says who, because "resolved by USER" names nobody on its own.
--
--   1. `resolution_note`: why the episode ended. Nullable, because every row resolved before this
--      migration was resolved without one, and they stay exactly as they are.
--   2. `resolved_by_user_id`: the account owner who resolved it. No foreign key, for the reason
--      `project_handoff.decided_by_user_id` has none: attribution is history, and a project's
--      blockers are deleted with the project anyway.
--   3. `project_blocker_resolution_final` (0125), restated with the two new columns among the ones a
--      resolved row may not change. Everything else in it is carried over unchanged.
--
-- The door requires the reason and records the owner; the columns themselves are not constrained,
-- because other writers of a resolution already exist (fixtures and repairs that mark a row
-- resolved) and none of them knows these columns.

ALTER TABLE "project_blocker"
  ADD COLUMN "resolution_note" TEXT,
  ADD COLUMN "resolved_by_user_id" UUID;

CREATE OR REPLACE FUNCTION "project_blocker_resolution_final"() RETURNS trigger AS $$
BEGIN
  IF OLD."resolved_at" IS NULL THEN RETURN NEW; END IF;
  IF NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at"
     OR NEW."resolved_by" IS DISTINCT FROM OLD."resolved_by"
     OR NEW."resolution_note" IS DISTINCT FROM OLD."resolution_note"
     OR NEW."resolved_by_user_id" IS DISTINCT FROM OLD."resolved_by_user_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."dedupe_key" IS DISTINCT FROM OLD."dedupe_key"
     OR NEW."lifecycle_generation" IS DISTINCT FROM OLD."lifecycle_generation"
     OR NEW."first_seen_at" IS DISTINCT FROM OLD."first_seen_at" THEN
    RAISE EXCEPTION 'BLOCKER_RESOLVED_IMMUTABLE: blocker % is resolved and may not be rewritten',
      OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
