-- Settle, once, the approvals filed before 0252 that nothing is asking any more.
--
-- WHY THESE ROWS NEED A PASS OF THEIR OWN
-- =======================================
-- `sessions/abandoned-approvals.ts` collects an approval on one committed fact: the turn that raised
-- it has ended. It reads that fact from `approval.turn_id` (0252), and treats a null there as "opener
-- unknown", which it declines to guess about. Every row filed before 0252 is null for another reason:
-- the column did not exist yet. So the PENDING ones among them could never be collected by anything.
-- On 2026-09-11 production held 27 of them on 12 sessions, the newest from 2026-09-09, and they kept
-- the session list's `pendingApprovals`, the workspace "needs you" count and iOS's amber bar lit on
-- conversations where nobody was waiting.
--
-- WHY A MIGRATION AND NOT A REAPER RULE
-- =====================================
-- The population is closed: nothing written after 0252 landed can join it. And the reaper runs only
-- at the turn-end boundaries of the row's own session. 11 of those 12 sessions had ended long before
-- and will never reach one again, so a rule there would never visit the rows it exists for.
--
-- WHICH ROWS, ON WHICH FACTS
-- ==========================
-- Three conditions, none of them a duration:
--
--   * PENDING with a null `turn_id`: nobody decided it, and the reaper cannot place it.
--   * Created before 0252 was applied TO THIS DATABASE. The moment is read from Prisma's own
--     migration history rather than written in as a date, because it differs per deployment and only
--     the history knows it. A null opener after that moment means "raised outside a turn", and that
--     stays the reaper's to leave alone.
--   * No longer being asked, on the two facts `SessionsService.listApprovals` already uses to take a
--     PENDING row out of the answerable ones. Either the session is not generating: a permission
--     prompt blocks inside a generating turn, so a session that is not generating holds no live
--     prompt. Or the tool call the approval was raised for already has a result, which is what an
--     engine that gave up on the call leaves behind.
--
-- The last condition is load-bearing. `permissionPrompt` (src/runner-go/mcp.go) returns only on
-- ALLOWED or DENIED, and the server answers a non-PENDING row at once. Marking a live row ABANDONED
-- would therefore leave its poll re-asking without pause, and take the card away from the one person
-- who could still answer it. A deployment whose upgrade applies 0252 and this migration in the same
-- boot has exactly such rows.
--
-- WHAT IS WRITTEN
-- ===============
-- `ABANDONED` and a reason, the way the reaper writes them. The row stays, so the question that was
-- asked stays in the record. `decided_at` and `decided_by_id` stay null, because nobody decided
-- anything. The reason differs from the reaper's on purpose: it names the fact this pass used, so a
-- reader can tell the two apart.
--
-- Running it again changes nothing: every row it wrote is no longer PENDING, and it wrote nothing
-- else.
--
-- THE HISTORY-TABLE GUARD
-- =======================
-- Prisma replays migrations into a shadow database (`prisma migrate dev`, `migrate diff
-- --from-migrations`) without creating `_prisma_migrations` there, so a plain reference to it fails
-- that replay with P3006. A database with no history table has no approvals from before 0252
-- either, so there is nothing to settle.
DO $$
DECLARE
  landed timestamp;
BEGIN
  IF to_regclass('_prisma_migrations') IS NULL THEN
    RETURN;
  END IF;

  -- `finished_at` is timestamptz; `approval.created_at` is a UTC wall-clock timestamp.
  SELECT min(m."finished_at" AT TIME ZONE 'UTC') INTO landed
    FROM "_prisma_migrations" m
   WHERE m."migration_name" = '0252_approval_opening_turn'
     AND m."rolled_back_at" IS NULL;

  -- No such history row leaves `landed` null, and `created_at < null` holds for no row.
  UPDATE "approval" a
     SET "status" = 'ABANDONED',
         "message" = 'raised before approvals recorded their turn, and no longer being asked when this was written (its session was not generating, or the call already had a result), so nothing is left to receive an answer'
   WHERE a."status" = 'PENDING'
     AND a."turn_id" IS NULL
     AND a."created_at" < landed
     AND (
       NOT EXISTS (
         SELECT 1
           FROM "session" s
          WHERE s."id" = a."session_id"
            AND (s."status" = 'RUNNING' OR (s."status" = 'AWAITING_INPUT' AND s."engine_turn_active"))
       )
       OR EXISTS (
         SELECT 1
           FROM "tool_call" c
          WHERE c."session_id" = a."session_id"
            AND c."tool_use_id" = a."tool_use_id"
            AND c."finished_at" IS NOT NULL
       )
     );
END
$$;
