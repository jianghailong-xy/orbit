-- 1449: session_merge_projection_checkpoint_authority (0152) reads NULL as a claim.
--
-- The trigger fires BEFORE UPDATE OF merge_status, merged_source_sha, branch_merged on every session of a
-- convergence-managed task, and asks whether the update newly CLAIMS a landing: merge_status becoming 'merged',
-- or a new non-NULL merged_source_sha. 0152 wrote that as
--
--     claimed := (NEW."merge_status" = 'merged' AND OLD."merge_status" IS DISTINCT FROM 'merged')
--                OR (NEW."merged_source_sha" IS NOT NULL AND NEW."merged_source_sha" IS DISTINCT FROM OLD."merged_source_sha");
--
-- With NEW.merge_status NULL the first comparison is NULL, the second disjunct is false for a NULL sha, and
-- NULL OR false is NULL. `IF NOT claimed` is then `IF NULL`, which does not return, and the trigger raised
-- CHECKPOINT_AUTHORITY_REQUIRED for an update that claims nothing at all. Every revive writes merge_status
-- NULL (SessionsService.resume clears a finished session's merge state), so no session of a convergence-managed
-- task could be resumed — among them the task_done work session a failed landing revives for its
-- landing-fix:v1 turn (docs/project-integration-line-contract.md §12.5 W6, revision 42).
--
-- The meaning is kept: a session that newly claims merged, or a new non-NULL merged_source_sha, still needs an
-- accepted checkpoint at that sha. Each comparison is made NULL-safe, so an update that clears the merge state
-- is not a claim. A function body only: no table, column, constraint or trigger changes, and no row is written.
CREATE OR REPLACE FUNCTION "session_merge_projection_checkpoint_authority"() RETURNS TRIGGER AS $$
DECLARE
  claimed BOOLEAN;
BEGIN
  IF NOT "task_is_convergence_managed"(NEW."task_id") THEN
    RETURN NEW;
  END IF;

  claimed :=
    (coalesce(NEW."merge_status" = 'merged', false) AND OLD."merge_status" IS DISTINCT FROM 'merged')
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
