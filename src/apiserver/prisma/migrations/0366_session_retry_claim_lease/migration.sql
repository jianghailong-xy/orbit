-- 0366 — a retry claim taken back without its turn is a retry given up
-- (docs/session-request-reply-contract.md §8 criteria 24 and 25).
--
-- WHAT IT CHANGES
-- ===============
--   * `session_request_asker_stopped` (0352) is re-created to fire on `retry_claimed_at` as well, and
--     to read a claim cleared from a session parked idle — no turn written, no retry armed — as the
--     asker stopping, the way it already reads a disarm. The function it runs is unchanged.
--   * `session_retry_claimed_at_idx`: the claims in flight, for the auto-retry sweep's read of the ones
--     whose lease has run out.
--
-- WHY
-- ===
-- An outcome handed to an asker whose retry the sweep has CLAIMED is held for the retry's turn (0354,
-- §8 criterion 20). The claim can end without that turn in three ways, and each must say the outcome
-- somewhere, once:
--
--   * the owner turns the retry off — or arms it for later, or sends a message of their own — while
--     the claim is in flight. The re-send is now written only under the claim it was claimed for
--     (`AutoRetryService.whileClaimHeld`), so it does not go out; for a FAILED asker 0352 already reads
--     the statement that cleared the claim as a retry given up, but for one parked idle (a spent quota)
--     it did not: that statement leaves `retry_at` NULL as the claim had, and the attempt count as the
--     claim wrote it, which is neither of the two shapes 0352's idle branch knows. The outcome stayed
--     held, unmarked, for a turn that was never written. The new branch is that shape.
--   * the claim outlives its lease (`RETRY_CLAIM_WINDOW_MS`): the process stopped between the claim
--     and the re-send, or the backoff after a failed re-send could not be written. The sweep gives such
--     a claim up (`AutoRetryService.releaseExpiredClaims`) by handing back the attempt it spent, which
--     both triggers already read as a retry given up; the index is that sweep's read.
--
-- WHEN A CLAIM TAKEN BACK IS THE ASKER STOPPING
-- =============================================
-- Only when the session is left parked idle with no retry armed. The turn the claim was for clears the
-- claim in the statement that moves the session out of AWAITING_INPUT (createTurn, resume), and a
-- re-arm clears it in the statement that sets `retry_at` again: neither matches. A FAILED session is
-- the existing FAILED branch, unchanged — `retry_claimed_at` in the column list only lets a statement
-- that writes nothing else reach it.
--
-- LOCK ORDER
-- ==========
-- As 0352: the trigger runs inside a session UPDATE that holds that session's row (rank 30) and writes
-- only `session_request` rows (rank 60) naming it as the asker.
--
-- BACKWARD COMPATIBLE
-- ===================
-- One trigger re-created over the same function, and one partial index. No column, constraint, type or
-- function is added or changed, and no row is read or rewritten. The index holds only claims in flight
-- — a handful at any moment; NULL is every other row.

BEGIN;

DROP TRIGGER "session_request_asker_stopped" ON "session";

CREATE TRIGGER "session_request_asker_stopped"
  AFTER UPDATE OF "status", "end_reason", "retry_at", "retry_attempts", "retry_claimed_at", "completed_at", "archived_at", "deleted_at"
  ON "session"
  FOR EACH ROW
  WHEN (
    NEW."deleted_at" IS NOT NULL
    OR NEW."completed_at" IS NOT NULL
    OR NEW."archived_at" IS NOT NULL
    OR NEW."status" IN ('SUCCEEDED', 'CANCELLED')
    OR (NEW."status" = 'FAILED' AND NEW."retry_at" IS NULL
        AND NOT (OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" > OLD."retry_attempts"))
    OR (NEW."status" = 'INTERRUPTED' AND COALESCE(NEW."end_reason", '') <> '')
    OR (NEW."status" = 'AWAITING_INPUT' AND NEW."retry_at" IS NULL
        AND ((OLD."retry_at" IS NOT NULL AND NEW."retry_attempts" <= OLD."retry_attempts")
             OR NEW."retry_attempts" < OLD."retry_attempts"
             OR (OLD."retry_claimed_at" IS NOT NULL AND NEW."retry_claimed_at" IS NULL)))
  )
  EXECUTE FUNCTION "session_request_asker_stopped"();

-- The sweep's read: claims older than their lease, oldest first. Partial, as `session_retry_at_idx`
-- (0081) is: a claim lives for the length of one resume, so the index carries next to nothing.
CREATE INDEX "session_retry_claimed_at_idx" ON "session" ("retry_claimed_at")
  WHERE "retry_claimed_at" IS NOT NULL;

COMMIT;
