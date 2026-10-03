-- 0354 — a retry the sweep has CLAIMED but not yet re-sent is still a retry in flight
-- (docs/session-request-reply-contract.md §8 criterion 20).
--
-- WHAT IT ADDS
-- ============
--   * `session.retry_claimed_at`: the instant the auto-retry sweep claimed this retry and began
--     writing the turn that fulfils it. NULL when no claim is in flight.
--
-- WHY
-- ===
-- The sweep's claim clears `retry_at` and spends an attempt in one statement, and the next one
-- writes the re-sent turn (auto-retry.service.ts). Between the two — the length of a resume
-- transaction, which can copy attachments — the session is parked (FAILED, or idle after a quota)
-- with `retry_at` NULL: exactly the shape of a retry that was GIVEN UP. A reader that treats the
-- second as the first is wrong for that moment: `awaitsAutoRetry` (sessions/session-request.ts)
-- decides whether a session an outcome is being handed to has ended (§4.3) or is on its way to
-- another turn (§8 criterion 17), and reading the claim window as "ended" writes a task comment
-- saying so AND holds the outcome for the retry's turn — the asker is told twice, and once wrongly.
--
-- So the claim leaves the fact behind it. `retry_claimed_at` is written by the claim itself, and
-- cleared by everything that resolves the claim: the turn the resume writes (`createTurn` /
-- `resume` clear `retry_at` in the statement that enqueues, and this with it), a re-arm, a disarm,
-- the attempt a give-up hands back, the owner's switch either way. Readers also bound it: a claim
-- whose writer died before its turn would otherwise leave a session that never comes back reading
-- as "on its way" forever (`RETRY_CLAIM_WINDOW_MS`).
--
-- BACKWARD COMPATIBLE
-- ===================
-- One nullable column with no default. No existing row is read or rewritten, and nothing that does
-- not write it changes behaviour: NULL reads as "no claim in flight", which is what every row that
-- predates the sweep's claim carrying this fact already means.

BEGIN;

ALTER TABLE "session" ADD COLUMN "retry_claimed_at" TIMESTAMPTZ(3);

COMMIT;
